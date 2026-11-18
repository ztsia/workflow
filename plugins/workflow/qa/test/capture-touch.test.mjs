// Capture fixes (rework U11, design 2026-11-12 §10) and SVG text: a hover step on a touch screen becomes a tap where
// the element opens something on a tap, else it is skipped with a note (never a blank capture judged by eyes); a click
// that expands a row or panel keeps the scroll position of the container it started in; the crops of watched elements
// leave every scroll container where the steps put it; text inside an <svg> is read (textContent), never a crash.
// Real headless browser against a fixture server; every page is generated here and names no real app.
// Contracts: scripts/lib/capture.mjs 'U11' and 'SVG TEXT', compare.mjs 'U11'.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { capture, runStep, snapshot } from '../scripts/lib/capture.mjs';
import { compareViewport } from '../scripts/lib/compare.mjs';

const PAGES = {
  // A hover-only tooltip (CSS :hover), a disclosure that opens on a click only, a plain action, a link.
  '/hover': `<!doctype html><html><head><meta charset="utf-8"><title>Hover</title>
<style>body { font: 16px sans-serif; margin: 16px; }
.tip-host { position: relative; display: inline-block; padding: 8px; }
.bubble { display: none; position: absolute; top: 36px; left: 0; background: #222222; color: #ffffff; padding: 4px; }
.tip-host:hover .bubble { display: block; }</style></head>
<body><h1>Hover</h1>
<p><span class="tip-host" id="rate">Rate<span class="bubble" role="tooltip">Per hour</span></span></p>
<p><button id="disclose" aria-expanded="false" aria-controls="panel" onclick="const p = document.getElementById('panel'); p.hidden = !p.hidden; this.setAttribute('aria-expanded', String(!p.hidden))">Details</button></p>
<div id="panel" hidden>Panel body</div>
<p><button id="act" onclick="const c = document.getElementById('count'); c.textContent = String(Number(c.textContent) + 1)">Add</button> <span id="count">0</span></p>
<p><a id="away" href="/other">Elsewhere</a></p></body></html>`,
  '/other': '<!doctype html><html><head><meta charset="utf-8"><title>Other</title></head><body><h1>Other</h1></body></html>',
  // A scrolling table whose rows open a detail; the app's re-render jumps the table to its top on every toggle.
  '/table': `<!doctype html><html><head><meta charset="utf-8"><title>Table</title>
<style>body { margin: 0; font: 16px sans-serif; } #wrap { height: 240px; overflow-y: auto; border: 1px solid #333333; }
.row { height: 40px; display: flex; align-items: center; } .detail { height: 100px; background: #eeeeff; }</style></head>
<body><h1>Table</h1><button id="top" onclick="document.getElementById('wrap').scrollTop = 0">Top</button><div id="wrap"></div>
<script>
const wrap = document.getElementById('wrap');
for (let i = 1; i <= 20; i++) wrap.insertAdjacentHTML('beforeend', '<div class="row"><button class="toggle" id="t' + i + '" aria-expanded="false" aria-controls="d' + i + '">Row ' + i + '</button></div><div class="detail" id="d' + i + '" hidden>Detail ' + i + '</div>');
wrap.addEventListener('click', (e) => {
  const b = e.target.closest('.toggle');
  if (!b) return;
  const d = document.getElementById(b.getAttribute('aria-controls'));
  const open = b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', String(open));
  d.hidden = !open;
  wrap.scrollTop = 0;
});
</script></body></html>`,
  // A chart: text inside an <svg> (no innerText there), beside ordinary text.
  '/chart': `<!doctype html><html><head><meta charset="utf-8"><title>Chart</title></head>
<body><h1>Chart</h1><p class="note">Totals by month</p>
<svg width="240" height="120" role="img" aria-label="Revenue chart"><g class="axis"><text class="label" x="10" y="20">Revenue</text><text class="label" x="10" y="60">Costs</text></g><rect x="80" y="10" width="40" height="80" fill="#336699"></rect></svg>
</body></html>`,
};

const PROFILE = {
  viewports: { desktop: [1280, 800], phone: [390, 844] },
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
const made = [];

before(async () => {
  mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-touch-main-'));
  made.push(mainRoot);
  server = http.createServer((req, res) => {
    const page = PAGES[new URL(req.url, 'http://fixture').pathname];
    res.writeHead(page ? 200 : 404, { 'content-type': page ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(page ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  pw = loadPlaywright(mainRoot);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const outDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-touch-out-'));
  made.push(dir);
  return dir;
};

async function walk({ screens, viewport = 'phone', profile = PROFILE, ...extra }) {
  const out = outDir();
  const lines = [];
  const res = await capture({ profile, mainRoot, baseUrl, screens, out, viewport, headless: true, cwd: mainRoot, vars: {}, pw, log: (l) => lines.push(l), checks: false, tour: false, ...extra });
  const record = (file) => JSON.parse(fs.readFileSync(path.join(out, viewport, file), 'utf8'));
  return { res, lines, record };
}

// ── hover on a touch screen ─────────────────────────────────────────────────────

describe('a hover step on a touch screen', () => {
  const hoverThen = (sel, watch) => [{ name: 'hov', steps: [{ goto: '/hover' }, { hover: sel }, { capture: 'over', watch }] }];

  test('a disclosure no hover opens is tapped on a phone: the capture shows it open', { timeout: 60000 }, async () => {
    const { res, lines, record } = await walk({ screens: hoverThen('#disclose', '#panel') });
    assert.deepEqual(res.failed, []);
    const rec = record('hov__over.json');
    assert.deepEqual(rec.elements.map((e) => e.text), ['Panel body']);
    assert.equal(rec.skipped, undefined);
    assert.ok(lines.some((l) => /^hov: hover #disclose on a touch screen \(390 px\): nothing answered the hover; tapped/.test(l)), lines.join('\n'));
  });

  test('on a desktop screen the same hover stays a hover: nothing opens', { timeout: 60000 }, async () => {
    const { res, record } = await walk({ screens: hoverThen('#disclose', '#panel'), viewport: 'desktop' });
    assert.deepEqual(res.failed, []);
    assert.deepEqual(record('hov__over.json').elements, []);
  });

  test('a hover the page answers on a phone (a tooltip) is kept as it is: no tap, no note', { timeout: 60000 }, async () => {
    const { lines, record } = await walk({ screens: hoverThen('#rate', '[role="tooltip"]') });
    const rec = record('hov__over.json');
    assert.deepEqual(rec.elements.map((e) => e.text), ['Per hour']);
    assert.equal(rec.skipped, undefined);
    assert.ok(!lines.some((l) => /touch screen/.test(l)), lines.join('\n'));
  });

  test('an action nothing answers is skipped with a note: never clicked, and the capture carries the note', { timeout: 60000 }, async () => {
    const { res, lines, record } = await walk({ screens: hoverThen('#act', '#count') });
    assert.deepEqual(res.failed, []);
    const rec = record('hov__over.json');
    assert.deepEqual(rec.elements.map((e) => e.text), ['0'], 'the action did not run');
    assert.deepEqual(rec.skipped, [{ step: '{"hover":"#act"}', why: 'hover on a touch screen (390 px): nothing answered the hover and a tap opens nothing there, so it was skipped' }]);
    assert.ok(lines.some((l) => l === 'hov: hover #act on a touch screen (390 px): nothing answered the hover and a tap opens nothing there, so it was skipped'), lines.join('\n'));
  });

  test('a link is never tapped: skipped, the page stays where it was', { timeout: 60000 }, async () => {
    const { record } = await walk({ screens: hoverThen('#away', null) });
    const rec = record('hov__over.json');
    assert.match(rec.url, /\/hover$/);
    assert.equal(rec.skipped.length, 1);
  });

  test('a page that reports touch is a touch screen at any width (the context touch flag)', { timeout: 60000 }, async () => {
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/hover`);
      const notes = [];
      await runStep(page, { hover: '#act' }, { baseUrl, profile: PROFILE, root: mainRoot, recording: false, touch: false, note: (n) => notes.push(n) });
      assert.equal(notes.length, 1);
      assert.equal(notes[0].skipped, true);
      assert.match(notes[0].why, /^hover on a touch screen \(1280 px\): /);
      assert.equal(await page.textContent('#count'), '0');
    } finally {
      await browser.close();
    }
  });

  test('compare never sends a capture with a skipped step to eyes', () => {
    const rec = (over = {}) => ({ screen: 'hov', capture: 'over', url: 'http://x/', elements: [], overflow: [], writes: [], errors: [], tree: 'x.aria.yml', checks: [], tour: null, ...over });
    const side = (records) => ({ records, failed: {}, videos: {}, trees: {}, pngs: {} });
    const r = compareViewport({
      before: side({}), viewport: 'phone', profile: {},
      after: side({ hov__over: rec({ skipped: [{ step: '{"hover":"#act"}', why: 'skipped' }] }), hov__plain: rec({ capture: 'plain' }) }),
    });
    assert.deepEqual(r.eyes, ['hov__plain']);
  });
});

// ── scroll kept by an expand ────────────────────────────────────────────────────

describe('an expand keeps the scroll of the container it started in', () => {
  const open = async (fn) => {
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.goto(`${baseUrl}/table`);
      return await fn(page);
    } finally {
      await browser.close();
    }
  };
  const ctx = { profile: PROFILE, recording: false };
  const where = (page, id) => page.evaluate((id) => {
    const wrap = document.getElementById('wrap').getBoundingClientRect();
    const d = id ? document.getElementById(id).getBoundingClientRect() : null;
    return { top: document.getElementById('wrap').scrollTop, inView: d ? d.top >= wrap.top && d.top < wrap.bottom : null };
  }, id);

  test('a click that opens a row: the table stays where the click started, the opened row in view', { timeout: 60000 }, async () => {
    await open(async (page) => {
      await runStep(page, { click: '#t12' }, { baseUrl, root: mainRoot, ...ctx });
      assert.equal(await page.evaluate(() => document.getElementById('d12').hidden), false);
      const w = await where(page, 't12');
      assert.ok(w.top > 0, JSON.stringify(w));
      assert.equal(w.inView, true, JSON.stringify(w));
    });
  });

  test('clickAll that opens every row: the table is back where the step started', { timeout: 60000 }, async () => {
    await open(async (page) => {
      await page.evaluate(() => { document.getElementById('wrap').scrollTop = 200; });
      await runStep(page, { clickAll: '.toggle' }, { baseUrl, root: mainRoot, ...ctx });
      assert.equal(await page.evaluate(() => document.querySelectorAll('[aria-expanded="true"]').length), 20);
      assert.equal((await where(page)).top, 200);
    });
  });

  test('a click that opens nothing is left where the app put it', { timeout: 60000 }, async () => {
    await open(async (page) => {
      await page.evaluate(() => { document.getElementById('wrap').scrollTop = 300; });
      await runStep(page, { click: '#top' }, { baseUrl, root: mainRoot, ...ctx });
      assert.equal((await where(page)).top, 0);
    });
  });

  test('the crops of watched elements leave the table where the steps put it', { timeout: 60000 }, async () => {
    await open(async (page) => {
      await runStep(page, { click: '#t12' }, { baseUrl, root: mainRoot, ...ctx });
      const was = (await where(page)).top;
      const out = outDir();
      await snapshot(page, { screen: 'tbl', state: 'open', watch: '.toggle', viewport: 'desktop', profile: PROFILE, out });
      assert.equal(fs.readdirSync(out).filter((f) => /^tbl__open__\d+\.png$/.test(f)).length, 20, 'every watched row was cropped');
      assert.equal((await where(page)).top, was);
    });
  });
});

// ── SVG text ────────────────────────────────────────────────────────────────────

describe('text inside an svg', () => {
  test('an expectation text that is SVG text is collected with its context, never a crash', { timeout: 60000 }, async () => {
    const { res, record } = await walk({ screens: [{ name: 'chart', steps: [{ goto: '/chart' }, { capture: 'shown' }] }], viewport: 'desktop', expectTexts: ['Revenue'] });
    assert.deepEqual(res.failed, []);
    const rec = record('chart__shown.json');
    assert.deepEqual(rec.elements.map((e) => e.text), ['Revenue']);
    assert.equal(typeof rec.elements[0].context, 'string');
  });

  test('a watch that selects SVG text waits for it and collects it', { timeout: 60000 }, async () => {
    const { res, record } = await walk({ screens: [{ name: 'chart', steps: [{ goto: '/chart' }, { capture: 'shown' }] }], viewport: 'desktop', profile: { ...PROFILE, watch: 'svg text.label' } });
    assert.deepEqual(res.failed, []);
    assert.deepEqual(record('chart__shown.json').elements.map((e) => e.text), ['Revenue', 'Costs']);
  });
});
