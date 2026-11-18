// probe() and probeScreen() in a real headless browser, against a fixture server on an ephemeral port.
// The CONTRACT comment in scripts/lib/probe.mjs is the spec.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { probe, probeScreen } from '../scripts/lib/probe.mjs';

const PAGES = {
  '/': `<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>
<body><h1>Home</h1><a href="/b">Go to b</a></body></html>`,
  '/b': `<!doctype html><html><head><meta charset="utf-8"><title>B</title></head>
<body><h1>B</h1><button id="reveal">Reveal</button></body></html>`,
};

const PROFILE = {
  viewports: { desktop: [1280, 800] },
  browser: { channel: 'chromium' },
  watch: null,
  settle: { timeoutMs: 3000, quietMs: 200, hidden: null },
  stepTimeoutMs: 5000,
  maxElementsPerCapture: 80,
  login: {},
  ignoreErrors: [],
  writes: { scope: null, allow: [], block: false },
};

let server;
let baseUrl;
let mainRoot;
let pw;

function route(req, res) {
  const { pathname } = new URL(req.url, 'http://fixture');
  const page = PAGES[pathname];
  if (!page) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
}

before(async () => {
  mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-probe-'));
  server = http.createServer(route);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  pw = loadPlaywright(mainRoot);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(mainRoot, { recursive: true, force: true });
});

const profileWith = (over = {}) => ({ ...PROFILE, ...over });

// Opens a browser, runs fn with a fresh page, and always closes the browser.
async function withPage(fn) {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test('probe on / reports the title, an ARIA snapshot with the heading and the link, and no truncation', { timeout: 30000 }, async () => {
  const r = await withPage(async (page) => {
    await page.goto(`${baseUrl}/`);
    return probe(page);
  });

  assert.equal(r.title, 'Home');
  assert.ok(r.aria.includes('heading "Home"'), r.aria);
  assert.ok(r.aria.includes('link "Go to b"'), r.aria);
  assert.equal(r.truncated, false);
  assert.ok(r.lines >= 2, String(r.lines));
});

test('probe with maxLines 1 is truncated, counts every line, and ends with the raise-lines note', { timeout: 30000 }, async () => {
  const r = await withPage(async (page) => {
    await page.goto(`${baseUrl}/`);
    return probe(page, { maxLines: 1 });
  });

  assert.equal(r.truncated, true);
  assert.ok(r.lines > 1, String(r.lines));
  const last = r.aria.split('\n').at(-1);
  assert.match(last, /^# … \d+ more lines \(raise --lines\)$/, last);
});

test('probeScreen on a path reports the URL and an ARIA snapshot of that page', { timeout: 30000 }, async () => {
  const r = await probeScreen({ profile: PROFILE, mainRoot, baseUrl, path: '/b', pw, cwd: mainRoot, vars: {} });

  assert.equal(typeof r.url, 'string', JSON.stringify(r));
  assert.ok(r.url.endsWith('/b'), r.url);
  assert.ok(r.aria.includes('button "Reveal"'), r.aria);
});

test('probeScreen with steps runs them instead of the goto and reports the page they reach', { timeout: 30000 }, async () => {
  const r = await probeScreen({
    profile: PROFILE,
    mainRoot,
    baseUrl,
    path: '/',
    steps: [{ goto: '/' }, { click: 'role=link[name="Go to b"]' }, { capture: 'x' }],
    pw,
    cwd: mainRoot,
    vars: {},
  });

  assert.equal(typeof r.url, 'string', JSON.stringify(r));
  assert.ok(r.url.endsWith('/b'), r.url);
});

test('probeScreen for a role whose storage-state file is missing returns notRun, not a snapshot', { timeout: 30000 }, async () => {
  const profile = profileWith({ login: { staff: { mode: 'storage-state', file: path.join(mainRoot, 'missing.json') } } });
  const r = await probeScreen({ profile, mainRoot, baseUrl, path: '/', role: 'staff', pw, cwd: mainRoot, vars: {} });

  assert.equal(typeof r.notRun, 'string', JSON.stringify(r));
});

test('probeScreen whose step fails returns error (a string) and the page url, within the step timeout', { timeout: 30000 }, async () => {
  const r = await probeScreen({
    profile: profileWith({ stepTimeoutMs: 1000 }),
    mainRoot,
    baseUrl,
    path: '/',
    steps: [{ goto: '/' }, { click: '#missing' }],
    pw,
    cwd: mainRoot,
    vars: {},
  });

  assert.equal(typeof r.error, 'string', JSON.stringify(r));
  assert.equal(typeof r.url, 'string', JSON.stringify(r));
});
