// Metrics (scripts/lib/metrics.mjs): the pure judges, and collectMetrics against a real headless page
// served by a node:http fixture on an ephemeral port, the way test/capture.test.mjs does it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { openBrowser } from '../scripts/lib/capture.mjs';
import {
  FLOOR,
  METRICS,
  WORSE,
  collectMetrics,
  compareMetrics,
  flatten,
  judge,
  limitsFor,
  metricsLine,
} from '../scripts/lib/metrics.mjs';

// --- METRICS, WORSE, FLOOR ----------------------------------------------------------------------

test('METRICS is a frozen table of the eight names, units and human limits; WORSE and FLOOR are as the contract says', () => {
  assert.ok(Object.isFrozen(METRICS));
  assert.deepEqual(Object.keys(METRICS), [
    'screen.readyMs',
    'screen.bytes',
    'screen.requests',
    'screen.longTaskMs',
    'screen.heapBytes',
    'server.appMs',
    'server.dbMs',
    'server.queries',
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(METRICS).map(([name, m]) => [name, { unit: m.unit, human: m.human, says: m.says }])),
    {
      'screen.readyMs': { unit: 'ms', human: 1000, says: 'opened until ready (network quiet, nothing changing)' },
      'screen.bytes': { unit: 'bytes', human: 1_500_000, says: 'bytes over the network to open it' },
      'screen.requests': { unit: 'count', human: undefined, says: 'requests to open it' },
      'screen.longTaskMs': { unit: 'ms', human: 200, says: 'main thread blocked past 50 ms per task' },
      'screen.heapBytes': { unit: 'bytes', human: 100_000_000, says: 'JS heap once ready' },
      'server.appMs': { unit: 'ms', human: 1000, says: 'server time over the requests that opened it (Server-Timing app)' },
      'server.dbMs': { unit: 'ms', human: undefined, says: 'database time over those requests (Server-Timing db)' },
      'server.queries': { unit: 'count', human: undefined, says: 'database queries over those requests (Server-Timing db-queries)' },
    },
  );
  assert.equal(WORSE, 1.25);
  assert.deepEqual(FLOOR, { ms: 100, bytes: 20_000, count: 3 });
});

// --- limitsFor ----------------------------------------------------------------------------------

const DEFAULT_LIMITS = {
  'screen.readyMs': 1000,
  'screen.bytes': 1_500_000,
  'screen.requests': null,
  'screen.longTaskMs': 200,
  'screen.heapBytes': 100_000_000,
  'server.appMs': 1000,
  'server.dbMs': null,
  'server.queries': null,
};

test("limitsFor() gives each metric's human limit, null where there is none", () => {
  assert.deepEqual(limitsFor(), DEFAULT_LIMITS);
});

test('limitsFor: an override number replaces the default, including for a metric with no default', () => {
  assert.equal(limitsFor({ 'screen.readyMs': 2000 })['screen.readyMs'], 2000);
  assert.equal(limitsFor({ 'server.queries': 50 })['server.queries'], 50);
  assert.deepEqual(limitsFor({ 'screen.readyMs': 2000 }), { ...DEFAULT_LIMITS, 'screen.readyMs': 2000 });
});

test('limitsFor: an override null drops the limit, and an unknown override name is ignored', () => {
  assert.equal(limitsFor({ 'screen.bytes': null })['screen.bytes'], null);
  assert.deepEqual(limitsFor({ 'screen.bytes': null }), { ...DEFAULT_LIMITS, 'screen.bytes': null });
  assert.deepEqual(limitsFor({ 'made.up': 5 }), DEFAULT_LIMITS);
});

// --- judge --------------------------------------------------------------------------------------

test('judge: the four Example lines of the contract', () => {
  assert.deepEqual(judge('screen.readyMs', 1800, 900), { kind: 'over', limit: 1000 });
  assert.deepEqual(judge('screen.readyMs', 1800, 1500), { kind: 'standing', limit: 1000, base: 1500 });
  assert.deepEqual(judge('server.queries', 40, 4), { kind: 'worse', base: 4 });
});

test("judge: 'ok' when under the human limit with no base, or with a base and not worse", () => {
  assert.deepEqual(judge('screen.readyMs', 500), { kind: 'ok' });
  assert.deepEqual(judge('screen.readyMs', 1000, 900), { kind: 'ok' }, 'head equal to the limit is not over it');
  assert.deepEqual(judge('screen.readyMs', 500, 400), { kind: 'ok' });
});

test("judge: over the limit with no base, or a null base, gives 'over' with the limit and no base", () => {
  assert.deepEqual(judge('screen.readyMs', 1800), { kind: 'over', limit: 1000 });
  assert.deepEqual(judge('screen.readyMs', 1800, null), { kind: 'over', limit: 1000 });
});

test("judge: a base at or under the limit does not make an over head 'standing'", () => {
  assert.deepEqual(judge('screen.readyMs', 1800, 1000), { kind: 'over', limit: 1000 });
});

test("judge: an over head that is also worse than its base is 'over', not 'standing'", () => {
  assert.deepEqual(judge('screen.readyMs', 1800, 1200), { kind: 'over', limit: 1000 });
});

test("judge: a bytes head over its limit and its base is 'standing' when not worse", () => {
  assert.deepEqual(judge('screen.bytes', 1_600_000, 1_550_000), { kind: 'standing', limit: 1_500_000, base: 1_550_000 });
});

test("judge: 'worse' against the base when there is no human limit, past WORSE and past the FLOOR", () => {
  assert.deepEqual(judge('server.dbMs', 300, 100), { kind: 'worse', base: 100 });
  assert.deepEqual(judge('server.queries', 40, 30), { kind: 'worse', base: 30 });
});

test("judge: 'worse' needs head above base x WORSE and head - base above the FLOOR for the unit", () => {
  assert.deepEqual(judge('server.dbMs', 150, 100), { kind: 'ok' }, 'over WORSE but 50 ms is not above the 100 ms floor');
  assert.deepEqual(judge('server.appMs', 125, 100), { kind: 'ok' }, '125 is not above 100 x 1.25');
  assert.deepEqual(judge('server.queries', 6, 4), { kind: 'ok' }, '2 queries is not above the 3-count floor');
  assert.deepEqual(judge('screen.bytes', 50_000, 40_000), { kind: 'ok' }, '50 000 is not above 40 000 x 1.25');
  assert.deepEqual(judge('screen.bytes', 70_000, 40_000), { kind: 'worse', base: 40_000 });
});

test("judge: a null limit in limits drops the over branch, so a worse head is still 'worse'", () => {
  assert.deepEqual(judge('screen.readyMs', 1800, 900, limitsFor({ 'screen.readyMs': null })), { kind: 'worse', base: 900 });
});

test('judge: a raised limit in limits moves the over line', () => {
  assert.deepEqual(judge('screen.readyMs', 1800, 1500, limitsFor({ 'screen.readyMs': 2000 })), { kind: 'ok' });
});

// --- flatten ------------------------------------------------------------------------------------

test('flatten maps a record metrics object to the METRICS names', () => {
  assert.deepEqual(
    flatten({
      readyMs: 900,
      bytes: 1200,
      requests: 3,
      longTaskMs: 40,
      heapBytes: 5000,
      server: { appMs: 12, dbMs: 3, queries: 4 },
    }),
    {
      'screen.readyMs': 900,
      'screen.bytes': 1200,
      'screen.requests': 3,
      'screen.longTaskMs': 40,
      'screen.heapBytes': 5000,
      'server.appMs': 12,
      'server.dbMs': 3,
      'server.queries': 4,
    },
  );
});

test('flatten leaves out null and non-finite values, and keeps zero', () => {
  assert.deepEqual(
    flatten({ readyMs: 900, bytes: 1200, requests: NaN, longTaskMs: 0, heapBytes: null, server: { appMs: 12, dbMs: null, queries: Infinity } }),
    { 'screen.readyMs': 900, 'screen.bytes': 1200, 'screen.longTaskMs': 0, 'server.appMs': 12 },
  );
});

test('flatten leaves the server names out when the record has no server object', () => {
  assert.deepEqual(flatten({ readyMs: 900, bytes: 1200, requests: 3, longTaskMs: 0, heapBytes: null, server: null }), {
    'screen.readyMs': 900,
    'screen.bytes': 1200,
    'screen.requests': 3,
    'screen.longTaskMs': 0,
  });
});

// --- compareMetrics -----------------------------------------------------------------------------

test('compareMetrics is null when either side has no metrics object', () => {
  const some = { readyMs: 900, bytes: 900_000, requests: 3, longTaskMs: 10, heapBytes: 5_000_000, server: null };
  assert.equal(compareMetrics(null, some, limitsFor()), null);
  assert.equal(compareMetrics(some, null, limitsFor()), null);
});

test('compareMetrics flags in METRICS order, not record order, and carries limit null for worse', () => {
  // The after record lists server first; the flags must still come out readyMs, bytes, queries.
  const after = {
    server: { appMs: 12, dbMs: 3, queries: 40 },
    bytes: 2_400_000,
    readyMs: 1800,
    requests: 3,
    longTaskMs: 10,
    heapBytes: 5_000_000,
  };
  const before = { readyMs: 900, bytes: 900_000, requests: 3, longTaskMs: 10, heapBytes: 5_000_000, server: { appMs: 12, dbMs: 3, queries: 4 } };
  assert.deepEqual(compareMetrics(before, after, limitsFor()), {
    flags: [
      { metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 },
      { metric: 'screen.bytes', kind: 'over', head: 2_400_000, base: 900_000, limit: 1_500_000 },
      { metric: 'server.queries', kind: 'worse', head: 40, base: 4, limit: null },
    ],
    standing: 0,
  });
});

test('compareMetrics counts standing judgements and does not flag them', () => {
  const after = { readyMs: 1800, bytes: 1_600_000 };
  const before = { readyMs: 1500, bytes: 1_550_000 };
  assert.deepEqual(compareMetrics(before, after, limitsFor()), { flags: [], standing: 2 });
});

test('compareMetrics: a flag has base null when the before record lacks that metric', () => {
  const after = { readyMs: 1800 };
  const before = { bytes: 900_000 };
  assert.deepEqual(compareMetrics(before, after, limitsFor()), {
    flags: [{ metric: 'screen.readyMs', kind: 'over', head: 1800, base: null, limit: 1000 }],
    standing: 0,
  });
});

test('compareMetrics uses the limits it is given', () => {
  const before = { readyMs: 1500 };
  const after = { readyMs: 1800 };
  assert.deepEqual(compareMetrics(before, after, limitsFor()), { flags: [], standing: 1 });
  assert.deepEqual(compareMetrics(before, after, limitsFor({ 'screen.readyMs': 2000 })), { flags: [], standing: 0 });
});

// --- collectMetrics (real headless page) --------------------------------------------------------

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Metrics</title></head>
<body><h1>Metrics</h1><script>fetch('/api/data').then((r) => r.text());</script></body></html>`;

let server;
let baseUrl;
let mainRoot;

before(async () => {
  mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-metrics-'));
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture');
    if (pathname === '/api/data') {
      const body = JSON.stringify({ rows: [1, 2, 3] });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'server-timing': 'app;dur=12, db;dur=3, db-queries;dur=4',
      });
      res.end(body);
      return;
    }
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('collectMetrics on a real page counts requests and bytes, reads Server-Timing, and times the open', { timeout: 60000 }, async () => {
  const pw = loadPlaywright(mainRoot);
  const viewport = [1280, 800];
  const context = await openBrowser(pw, { profile: { browser: { channel: 'chromium' } }, headless: true, viewport });
  try {
    const page = await context.newPage();
    const collect = await collectMetrics(page);
    collect.start();
    await page.goto(`${baseUrl}/`);
    await page.waitForLoadState('networkidle');
    const m = await collect.read();

    assert.ok(m.requests >= 2, `requests ${m.requests}`);
    assert.ok(m.bytes > 0, `bytes ${m.bytes}`);
    assert.deepEqual(m.server, { appMs: 12, dbMs: 3, queries: 4 });
    assert.ok(m.readyMs >= 0, `readyMs ${m.readyMs}`);
    assert.ok(m.longTaskMs >= 0, `longTaskMs ${m.longTaskMs}`);
  } finally {
    await context.close();
  }
});

// --- metricsLine --------------------------------------------------------------------------------

test("metricsLine 'over' in ms, with the base when there is one", () => {
  assert.equal(
    metricsLine({ metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 }),
    'screen.readyMs 1800 ms over 1000 ms (base 900 ms)',
  );
});

test("metricsLine 'over' with no base leaves the base part out", () => {
  assert.equal(
    metricsLine({ metric: 'screen.readyMs', kind: 'over', head: 1800, base: null, limit: 1000 }),
    'screen.readyMs 1800 ms over 1000 ms',
  );
});

test('metricsLine shows bytes in KB, rounded to the nearest whole KB', () => {
  assert.equal(
    metricsLine({ metric: 'screen.bytes', kind: 'over', head: 2_400_600, base: 900_499, limit: 1_500_000 }),
    'screen.bytes 2401 KB over 1500 KB (base 900 KB)',
  );
});

test("metricsLine 'worse' gives head vs base with the percent rounded", () => {
  assert.equal(
    metricsLine({ metric: 'screen.readyMs', kind: 'worse', head: 1000, base: 300, limit: null }),
    'screen.readyMs 1000 ms vs base 300 ms (+233%)',
  );
  assert.equal(
    metricsLine({ metric: 'server.appMs', kind: 'worse', head: 300, base: 100, limit: null }),
    'server.appMs 300 ms vs base 100 ms (+200%)',
  );
});

test('metricsLine for a count has no unit suffix', () => {
  assert.equal(
    metricsLine({ metric: 'server.queries', kind: 'worse', head: 40, base: 4, limit: null }),
    'server.queries 40 vs base 4 (+900%)',
  );
});

test('metricsLine: the Example line of the contract for bytes', () => {
  assert.equal(
    metricsLine({ metric: 'screen.bytes', kind: 'over', head: 2_400_000, base: 900_000, limit: 1_500_000 }),
    'screen.bytes 2400 KB over 1500 KB (base 900 KB)',
  );
});

test('pilot (CRM): a worse flag from a base of 0 reads "from none", never +Infinity%', () => {
  assert.equal(metricsLine({ metric: 'screen.longTaskMs', kind: 'worse', head: 120, base: 0, limit: null }), 'screen.longTaskMs 120 ms vs base 0 ms (from none)');
});
