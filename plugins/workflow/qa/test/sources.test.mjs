// Red tests for scripts/lib/sources.mjs (CONTRACT: lines 1–60 of that file). Source maps are built here by
// hand; the VLQ encoder below is written from the source map v3 spec, so decodeMappings is checked against
// input it did not produce. One test drives a real headless browser against a node:http fixture server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { coveredRanges, coveredSources, decodeMappings, readSources, repoFile, screenSources, startCoverage, stopCoverage, writeSources } from '../scripts/lib/sources.mjs';

// ---------------------------------------------------------------- test-side VLQ encoder

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

// lines: per generated line, its segments with ABSOLUTE values: [genCol] or [genCol, srcIdx, srcLine, srcCol].
// Generated columns restart each line; the source fields carry over between segments, as the spec says.
function encodeMappings(lines) {
  let prevSrc = 0;
  let prevLine = 0;
  let prevCol = 0;
  return lines
    .map((segments) => {
      let prevGen = 0;
      return segments
        .map((seg) => {
          let out = vlq(seg[0] - prevGen);
          prevGen = seg[0];
          if (seg.length > 1) {
            const [, src, line, col] = seg;
            out += vlq(src - prevSrc) + vlq(line - prevLine) + vlq(col - prevCol);
            prevSrc = src;
            prevLine = line;
            prevCol = col;
          }
          return out;
        })
        .join(',');
    })
    .join(';');
}

// ---------------------------------------------------------------- fixtures

// Two functions on two lines; line 0 is a's code (src/a.ts), line 1 is b's (src/b.ts).
const TWO = 'function a(){}\nfunction b(){}';
const TWO_MAPPINGS = [[[0, 0, 0, 0]], [[0, 1, 0, 0]]];
const twoMap = (extra = {}) => ({ version: 3, sources: ['../src/a.ts', '../src/b.ts'], names: [], mappings: encodeMappings(TWO_MAPPINGS), ...extra });
const mapJson = () => JSON.stringify(twoMap());

// A Playwright-style coverage entry for src: the top-level function (count 1) and a and b, of which only
// `called` ran.
function entryFor(url, src, called) {
  const span = (name) => {
    const start = src.indexOf(name);
    return [start, start + name.length];
  };
  const fns = ['a', 'b'].map((name) => {
    const [startOffset, endOffset] = span(`function ${name}(){}`);
    return { functionName: name, ranges: [{ startOffset, endOffset, count: name === called ? 1 : 0 }] };
  });
  return { url, source: src, functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] }, ...fns] };
}

// fetchText served from a { url: text } table; a url missing from the table rejects. Every url asked is recorded.
function serve(table, fetched = []) {
  return async (u) => {
    fetched.push(u);
    if (!(u in table)) throw new Error(`no ${u}`);
    return table[u];
  };
}

const onlySrc = (p) => p.startsWith('src/');
const byStart = (x, y) => x.start - y.start || x.end - y.end;

// ---------------------------------------------------------------- decodeMappings

test('decodeMappings: VLQ segments, relative fields, a 1-field segment, negative deltas, empty lines', () => {
  // The test's encoder must agree with the hand-worked values before decodeMappings is checked against them.
  assert.equal(vlq(0), 'A');
  assert.equal(vlq(1), 'C');
  assert.equal(vlq(-1), 'D');
  assert.equal(vlq(16), 'gB');
  assert.equal(vlq(-16), 'hB');
  const lines = [
    [[0, 0, 0, 0], [4, 0, 0, 3]],
    [[2, 1, 2, 0]],
    [[0]],
    [[1, 0, 0, 0]],
  ];
  const mappings = 'AAAA,IAAG;ECEH;A;CDFA';
  assert.equal(encodeMappings(lines), mappings);
  assert.deepEqual(decodeMappings(mappings), lines);
});

test('decodeMappings: an empty generated line gives an empty list', () => {
  assert.deepEqual(decodeMappings('AAAA;;AACA'), [[[0, 0, 0, 0]], [], [[0, 0, 1, 0]]]);
});

// ---------------------------------------------------------------- coveredSources

test('coveredSources: a range over line 1 only gives the file that line maps to', () => {
  const ranges = [{ start: TWO.indexOf('function b'), end: TWO.length }];
  assert.deepEqual(coveredSources({ source: TWO, map: twoMap(), ranges }), ['src/b.ts']);
});

test('coveredSources: the whole script gives every file, and a range over line 0 gives a', () => {
  assert.deepEqual(coveredSources({ source: TWO, map: twoMap(), ranges: [{ start: 0, end: TWO.length }] }), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(coveredSources({ source: TWO, map: twoMap(), ranges: [{ start: 0, end: 14 }] }), ['src/a.ts']);
});

test('coveredSources: no ranges gives no files', () => {
  assert.deepEqual(coveredSources({ source: TWO, map: twoMap(), ranges: [] }), []);
});

test('coveredSources: a segment counts by its offset; output is sorted and unique', () => {
  // Three lines, three sources; the first and last segments name the same file.
  const src = 'one\ntwo\nthree';
  const map = {
    version: 3,
    sources: ['../src/c.ts', '../src/a.ts', '../src/c.ts'],
    names: [],
    mappings: encodeMappings([[[0, 0, 0, 0]], [[0, 1, 0, 0]], [[0, 2, 0, 0]]]),
  };
  assert.deepEqual(coveredSources({ source: src, map, ranges: [{ start: 0, end: src.length }] }), ['src/a.ts', 'src/c.ts']);
  assert.deepEqual(coveredSources({ source: src, map, ranges: [{ start: 4, end: 7 }] }), ['src/a.ts']);
  assert.deepEqual(coveredSources({ source: src, map, ranges: [{ start: 8, end: 13 }] }), ['src/c.ts']);
});

test('coveredSources: sourceRoot is prepended, then webpack://, ../ and ./ runs are stripped', () => {
  const cases = [
    [{ sourceRoot: '../', sources: ['src/a.ts'] }, 'src/a.ts'],
    [{ sources: ['../src/b.ts'] }, 'src/b.ts'],
    [{ sources: ['webpack://src/c.ts'] }, 'src/c.ts'],
    [{ sources: ['./src/d.ts'] }, 'src/d.ts'],
  ];
  for (const [extra, want] of cases) {
    const map = { version: 3, names: [], mappings: 'AAAA', ...extra };
    assert.deepEqual(coveredSources({ source: 'x', map, ranges: [{ start: 0, end: 1 }] }), [want], JSON.stringify(extra));
  }
});

// ---------------------------------------------------------------- coveredRanges

test('coveredRanges: called functions minus nested count-0 ranges; top-level and uncalled functions left out', () => {
  const SRC = [
    'function a(){ if (q) { z(); } return 1; }',
    'function b(){ return 2; }',
    'var c = () => 3;',
    'var d = () => 4;',
  ].join('\n');
  const A = 'function a(){ if (q) { z(); } return 1; }';
  const A0 = SRC.indexOf(A);
  const N0 = SRC.indexOf('{ z(); }');
  const N1 = N0 + '{ z(); }'.length;
  const B0 = SRC.indexOf('function b');
  const B1 = B0 + 'function b(){ return 2; }'.length;
  const C0 = SRC.indexOf('() => 3');
  const C1 = C0 + '() => 3'.length;
  const D0 = SRC.indexOf('() => 4');
  const D1 = D0 + '() => 4'.length;
  const entry = {
    url: 'http://127.0.0.1:1/app.js',
    source: SRC,
    functions: [
      { functionName: '', ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }] },
      { functionName: 'a', ranges: [{ startOffset: A0, endOffset: A0 + A.length, count: 2 }, { startOffset: N0, endOffset: N1, count: 0 }] },
      { functionName: 'b', ranges: [{ startOffset: B0, endOffset: B1, count: 0 }] },
      { functionName: '', ranges: [{ startOffset: C0, endOffset: C1, count: 1 }] },
      { functionName: '', ranges: [{ startOffset: D0, endOffset: D1, count: 0 }, { startOffset: D0, endOffset: D1 - 1, count: 3 }] },
    ],
  };
  const got = coveredRanges(entry).slice().sort(byStart);
  assert.deepEqual(got, [
    { start: A0, end: N0 },
    { start: N1, end: A0 + A.length },
    { start: C0, end: C1 },
  ]);
});

// ---------------------------------------------------------------- repoFile

test('repoFile: node_modules, virtual, vite and \\0 paths are null, whatever exists says', () => {
  const exists = () => true;
  for (const p of ['packages/app/node_modules/react/index.js', '\0src/a.ts', 'vite/preload-helper.js', 'virtual:entry', 'commonjs-proxy:x']) {
    assert.equal(repoFile(p, { exists }), null, p);
  }
});

test('repoFile: a path that exists is itself, one that does not is null', () => {
  assert.equal(repoFile('src/a.ts', { exists: (f) => f === 'src/a.ts' }), 'src/a.ts');
  assert.equal(repoFile('src/gone.ts', { exists: () => false }), null);
});

// ---------------------------------------------------------------- screenSources

test('screenSources: an inline data: source map is decoded and gives the file of the called function', async () => {
  const origin = 'http://127.0.0.1:9';
  const dataUrl = `data:application/json;base64,${Buffer.from(mapJson()).toString('base64')}`;
  const src = `${TWO}\n//# sourceMappingURL=${dataUrl}`;
  const fetched = [];
  const files = await screenSources([entryFor(`${origin}/app.js`, src, 'b')], { origin, fetchText: serve({}, fetched), exists: onlySrc });
  assert.deepEqual(files, ['src/b.ts']);
  assert.deepEqual(fetched, [], 'a data: map is not fetched');
});

test('screenSources: a relative sourceMappingURL is fetched against the entry url; the last marker wins', async () => {
  const origin = 'http://127.0.0.1:9';
  const src = `${TWO}\n//# sourceMappingURL=old.js.map\n//# sourceMappingURL=app.js.map`;
  const fetched = [];
  const files = await screenSources([entryFor(`${origin}/dist/app.js`, src, 'b')], {
    origin,
    fetchText: serve({ [`${origin}/dist/app.js.map`]: mapJson() }, fetched),
    exists: onlySrc,
  });
  assert.deepEqual(fetched, [`${origin}/dist/app.js.map`]);
  assert.deepEqual(files, ['src/b.ts']);
});

test('screenSources: entries from another origin are ignored', async () => {
  const origin = 'http://127.0.0.1:9';
  const zzz = JSON.stringify({ version: 3, sources: ['../src/zzz.ts'], names: [], mappings: 'AAAA' });
  const src = `${TWO}\n//# sourceMappingURL=lib.js.map`;
  const fetched = [];
  const files = await screenSources([entryFor('https://cdn.example.test/lib.js', src, 'a')], {
    origin,
    fetchText: serve({ 'https://cdn.example.test/lib.js.map': zzz }, fetched),
    exists: onlySrc,
  });
  assert.deepEqual(files, []);
  assert.deepEqual(fetched, []);
});

test('screenSources: an entry with no sourceMappingURL is skipped', async () => {
  const origin = 'http://127.0.0.1:9';
  const fetched = [];
  const files = await screenSources([entryFor(`${origin}/plain.js`, TWO, 'a')], { origin, fetchText: serve({}, fetched), exists: onlySrc });
  assert.deepEqual(files, []);
  assert.deepEqual(fetched, []);
});

test('screenSources: a map that fails to load is skipped; the others still count; the union is sorted', async () => {
  const origin = 'http://127.0.0.1:9';
  const withMarker = (name) => `${TWO}\n//# sourceMappingURL=${name}.js.map`;
  const entries = [
    entryFor(`${origin}/b.js`, withMarker('b'), 'b'),
    entryFor(`${origin}/a.js`, withMarker('a'), 'a'),
    entryFor(`${origin}/broken.js`, withMarker('broken'), 'a'),
  ];
  const fetched = [];
  const files = await screenSources(entries, {
    origin,
    fetchText: serve({ [`${origin}/a.js.map`]: mapJson(), [`${origin}/b.js.map`]: mapJson() }, fetched),
    exists: onlySrc,
  });
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual([...fetched].sort(), [`${origin}/a.js.map`, `${origin}/b.js.map`, `${origin}/broken.js.map`]);
});

// ---------------------------------------------------------------- start/stopCoverage in a real browser

test('startCoverage, stopCoverage and screenSources: in Chromium, the file of the function that ran', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-sources-'));
  // used() runs on load and maps to src/used.ts; unused() never runs and maps to src/unused.ts.
  const app = [
    'function used(){ document.getElementById("out").textContent = "used"; }',
    'function unused(){ return "never"; }',
    'used();',
    '//# sourceMappingURL=app.js.map',
  ].join('\n');
  const map = {
    version: 3,
    sources: ['../src/used.ts', '../src/unused.ts'],
    names: [],
    mappings: encodeMappings([[[0, 0, 0, 0]], [[0, 1, 0, 0]], [[0, 0, 0, 0]], []]),
  };
  const pages = {
    '/': ['text/html; charset=utf-8', '<!doctype html><html><head><meta charset="utf-8"><title>Sources</title></head><body><h1 id="out">idle</h1><script src="app.js"></script></body></html>'],
    '/app.js': ['text/javascript; charset=utf-8', app],
    '/app.js.map': ['application/json', JSON.stringify(map)],
  };
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture');
    const hit = pages[pathname];
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': hit[0] });
    res.end(hit[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pw = loadPlaywright(root);
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await startCoverage(page);
    await page.goto(`${origin}/`);
    const entries = await stopCoverage(page);
    const files = await screenSources(entries, {
      origin,
      fetchText: async (u) => (await fetch(u)).text(),
      exists: onlySrc,
    });
    assert.deepEqual(files, ['src/used.ts']);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- readSources / writeSources

const made = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-srcmap-'));
  made.push(dir);
  return dir;
}

const put = (dir, name, text) => fs.writeFileSync(path.join(dir, name), typeof text === 'string' ? text : JSON.stringify(text));

test('readSources: a missing directory gives {}', () => {
  assert.deepEqual(readSources(path.join(tempDir(), 'nope')), {});
});

test('readSources: *.sources.json files merged in name order, a later file wins; bad JSON and other files skipped', () => {
  const dir = tempDir();
  put(dir, 'a.sources.json', { screens: { x: ['src/a.ts'], s: ['src/a2.ts'] } });
  put(dir, 'b.sources.json', { screens: { x: ['src/b.ts'] } });
  put(dir, 'broken.sources.json', '{ "screens": ');
  put(dir, 'candidates.json', [{ name: 'ghost', steps: [{ goto: '/' }] }]);
  assert.deepEqual(readSources(dir), { x: ['src/b.ts'], s: ['src/a2.ts'] });
});

test('writeSources: merges into the area file; screens keys sorted; 2-space JSON with a trailing newline; $comment', () => {
  const dir = tempDir();
  put(dir, 'candidates.sources.json', { sha: 'old', screens: { 'old-screen': ['src/old.ts'], 'candidate-detail': ['src/stale.tsx'] } });
  const file = writeSources(dir, { area: 'candidates', screens: { list: ['src/list.tsx'], 'candidate-detail': ['src/detail.tsx'] }, sha: 'abc123' });
  assert.equal(file, path.join(dir, 'candidates.sources.json'));
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  assert.equal(text, `${JSON.stringify(doc, null, 2)}\n`);
  assert.equal(
    doc.$comment,
    'written by qa run --full: the source files each screen ran; affected runs read it. Regenerated, never edited.',
  );
  assert.equal(doc.sha, 'abc123');
  assert.deepEqual(doc.screens, { 'candidate-detail': ['src/detail.tsx'], list: ['src/list.tsx'], 'old-screen': ['src/old.ts'] });
  const keys = Object.keys(doc.screens);
  assert.deepEqual(keys, [...keys].sort());
});

test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
