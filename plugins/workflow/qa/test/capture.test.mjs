// capture() and runStep() in a real headless browser, against a fixture server on an ephemeral port.
// Profile is plain (see BASE below); records and files follow the contract in scripts/lib/capture.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { capture, openBrowser, runStep } from '../scripts/lib/capture.mjs';

const PAGES = {
  '/': `<!doctype html><html><head><meta charset="utf-8"><title>Home</title>
<style>.tag { background: #4DA938; color: #ffffff; padding: 2px 6px; }</style></head>
<body><h1>Home</h1><span class="tag">Open</span> <a href="/b">Go to b</a></body></html>`,
  '/b': `<!doctype html><html><head><meta charset="utf-8"><title>B</title>
<style>.tag { background: #4DA938; color: #ffffff; padding: 2px 6px; } .tag.off { display: none; }</style></head>
<body><h1>B</h1>
<button id="reveal" onclick="document.querySelector('.tag').classList.remove('off')">Reveal</button>
<span class="tag off">Closed</span></body></html>`,
  '/err': `<!doctype html><html><head><meta charset="utf-8"><title>Err</title></head>
<body><h1>Err</h1><script>fetch('/api/x').catch(() => {});</script></body></html>`,
  '/menu': `<!doctype html><html><head><meta charset="utf-8"><title>Menu</title>
<style>#actions-menu { position: absolute; top: 60px; left: 20px; background: #ffffff; border: 1px solid #333; padding: 8px; }</style></head>
<body><h1>Menu</h1>
<button aria-haspopup="menu" aria-controls="actions-menu" onclick="document.getElementById('actions-menu').hidden = false">Actions</button>
<div id="actions-menu" role="menu" hidden><button role="menuitem">Rename</button></div></body></html>`,
  '/clock': `<!doctype html><html><head><meta charset="utf-8"><title>Clock</title></head>
<body><h1 id="stamp">waiting</h1><script>document.getElementById('stamp').textContent = new Date().toISOString();</script></body></html>`,
};

// step 7: a page that loads a bundle with a hand-made source map. `used` maps to src/b.ts, `unused` to src/a.ts
// ("ACAA;ADAA": line 0 -> source 1, line 1 -> source 0); only `used` ever runs.
const APP_JS = 'function used(){return 1}\nfunction unused(){return 2}\ndocument.getElementById("x").textContent="ran "+used();\n//# sourceMappingURL=app.js.map\n';
const APP_MAP = JSON.stringify({ version: 3, file: 'app.js', sources: ['src/a.ts', 'src/b.ts'], names: [], mappings: 'ACAA;ADAA' });
PAGES['/cov'] = `<!doctype html><html><head><meta charset="utf-8"><title>Cov</title></head>
<body><h1>Cov</h1><span id="x" class="tag">waiting</span><script src="/app.js"></script></body></html>`;

// An exact text that lives only in a role-less span, inside a list item (the accessibility tree shows it only as part
// of the item's line), plus a link whose text is also its whole text.
PAGES['/shop'] = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title>
<style>.badge { background: #c00; color: #ffffff; padding: 2px 6px; }</style></head>
<body><h1>Shop</h1><ul><li>Yo-yo <span class="price">$3.50</span><span class="badge">SALE</span></li><li>Kite <span class="price">$12.00</span></li></ul>
<footer><a href="mailto:hello@toyshop.test">hello@toyshop.test</a></footer></body></html>`;

const BASE = {
  viewports: { desktop: [1280, 800] },
  browser: { channel: 'chromium' },
  watch: '.tag',
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
  if (pathname === '/api/x') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
    return;
  }
  if (pathname === '/app.js' || pathname === '/app.js.map') {
    res.writeHead(200, { 'content-type': pathname === '/app.js' ? 'text/javascript' : 'application/json' });
    res.end(pathname === '/app.js' ? APP_JS : APP_MAP);
    return;
  }
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
  mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-main-'));
  server = http.createServer(route);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  pw = loadPlaywright(mainRoot);
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const profileWith = (over = {}) => ({ ...BASE, ...over });
// Tests that run the tour do not need hover; leaving it on only slows them down.
const NO_HOVER = profileWith({ tour: { hover: false } });
const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-out-'));

// extra: any other capture() option (checks, tour).
function run({ screens, out, record = false, profile = BASE, flows = {}, seed = null, seedFile = 'qa/seed.json', ...extra }) {
  return capture({ profile, mainRoot, baseUrl, screens, out, viewport: 'desktop', record, headless: true, cwd: mainRoot, vars: {}, pw, log: () => {}, flows, seed, seedFile, ...extra });
}

const readRecord = (out, file) => JSON.parse(fs.readFileSync(path.join(out, 'desktop', file), 'utf8'));

test('a two-step screen writes its png and json, and the watched element carries its text and colour', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'home', steps: [{ goto: '/' }, { capture: 'start' }] }], out });

  assert.ok(fs.existsSync(path.join(out, 'desktop', 'home__start.png')));
  const rec = readRecord(out, 'home__start.json');
  assert.equal(rec.screen, 'home');
  assert.equal(rec.capture, 'start');
  assert.equal(rec.elements[0].text, 'Open');
  assert.equal(typeof rec.elements[0].style.color, 'string');
  assert.notEqual(rec.elements[0].style.color, '');
});

test('a click before capture shows the element the click revealed', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'revealed', steps: [{ goto: '/b' }, { click: '#reveal' }, { capture: 'after-click' }] }], out });

  const rec = readRecord(out, 'revealed__after-click.json');
  assert.equal(rec.elements[0].text, 'Closed');
});

test('a screen with no capture step is captured once at the end as state default', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'nocap', steps: [{ goto: '/' }] }], out });

  assert.ok(fs.existsSync(path.join(out, 'desktop', 'nocap__default.png')));
  assert.equal(readRecord(out, 'nocap__default.json').capture, 'default');
});

test('a failing non-optional step writes <screen>__FAILED.json and lands in failed[]', { timeout: 30000 }, async () => {
  const out = outDir();
  const res = await run({ screens: [{ name: 'broken', steps: [{ goto: '/' }, { click: '#missing' }] }], out });

  assert.ok(res.failed.some((f) => f.screen === 'broken'), JSON.stringify(res.failed));
  const failed = JSON.parse(fs.readFileSync(path.join(out, 'desktop', 'broken__FAILED.json'), 'utf8'));
  assert.equal(failed.screen, 'broken');
  assert.equal(typeof failed.error, 'string');
});

test('the same failing step marked optional does not fail the screen', { timeout: 30000 }, async () => {
  const out = outDir();
  const res = await run({ screens: [{ name: 'soft', steps: [{ goto: '/' }, { click: '#missing', optional: true }, { capture: 'start' }] }], out });

  assert.ok(!res.failed.some((f) => f.screen === 'soft'), JSON.stringify(res.failed));
  assert.ok(fs.existsSync(path.join(out, 'desktop', 'soft__start.json')));
});

test('runStep throws on an unknown action', { timeout: 30000 }, async () => {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await assert.rejects(
      runStep(page, { frobnicate: '#x' }, { baseUrl, profile: BASE, root: mainRoot, recording: false }),
      /unknown step/,
    );
  } finally {
    await browser.close();
  }
});

test('record: true writes <screen>.webm', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'rec', steps: [{ goto: '/' }, { capture: 'start' }] }], out, record: true });

  assert.ok(fs.existsSync(path.join(out, 'desktop', 'rec.webm')));
});

test('a role whose storage-state file is missing is NOT RUN: no png, listed in notRun', { timeout: 30000 }, async () => {
  const out = outDir();
  const profile = profileWith({ login: { staff: { mode: 'storage-state', file: 'qa-artifacts/auth/staff.json' } } });
  const res = await run({ screens: [{ name: 'gated', role: 'staff', steps: [{ goto: '/' }, { capture: 'start' }] }], out, profile });

  assert.equal(res.notRun.length, 1, JSON.stringify(res.notRun));
  assert.equal(res.notRun[0].screen, 'gated');
  assert.match(res.notRun[0].why, /NOT RUN/);
  assert.ok(!fs.existsSync(path.join(out, 'desktop', 'gated__start.png')));
});

test('console errors from a failing request are recorded on the capture', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'errs', steps: [{ goto: '/err' }, { capture: 'start' }] }], out });

  const rec = readRecord(out, 'errs__start.json');
  assert.ok(rec.errors.some((e) => /500|\/api\/x/.test(e)), JSON.stringify(rec.errors));
});

test('a flow runs before the screen steps, and a capture after a click in them records what the click revealed',{ timeout: 30000 }, async () => {
  const out = outDir();
  const res = await run({
    screens: [{ name: 'flowed', flow: 'open:b', steps: [{ click: 'role=button[name="Reveal"]' }, { capture: 'shown' }] }],
    out,
    flows: { 'open:b': [{ goto: '/b' }] },
  });

  assert.ok(res.captured.includes('flowed__shown'), JSON.stringify(res.captured));
  const rec = readRecord(out, 'flowed__shown.json');
  assert.ok(rec.elements.some((e) => e.text === 'Closed'), JSON.stringify(rec.elements));
});

test('a screen whose flow is not defined opens no browser: failed gets a MAP ERROR, the FAILED.json says mapError, and a valid screen in the same call is captured', { timeout: 30000 }, async () => {
  const out = outDir();
  const res = await run({
    screens: [
      { name: 'bad', flow: 'nope', steps: [{ capture: 'x' }] },
      { name: 'good', steps: [{ goto: '/' }, { capture: 'start' }] },
    ],
    out,
  });

  assert.deepEqual(res.failed.find((f) => f.screen === 'bad'), {
    screen: 'bad',
    step: 'map',
    error: 'MAP ERROR: flow "nope" is not defined',
    mapError: true,
  }, JSON.stringify(res.failed));
  const failed = JSON.parse(fs.readFileSync(path.join(out, 'desktop', 'bad__FAILED.json'), 'utf8'));
  assert.equal(failed.mapError, true);
  assert.ok(res.captured.includes('good__start'), JSON.stringify(res.captured));
});

test('a failing step that came from a flow shows its via in failed[].step', { timeout: 30000 }, async () => {
  const out = outDir();
  const res = await run({
    // The flow's own step fails; the screen's steps never run.
    screens: [{ name: 'viaf', flow: 'open:b', steps: [{ capture: 'never' }] }],
    out,
    flows: { 'open:b': [{ goto: '/b' }, { click: '#missing' }] },
  });

  const failed = res.failed.find((f) => f.screen === 'viaf');
  assert.ok(failed, JSON.stringify(res.failed));
  assert.ok(failed.step.includes('"via":"open:b"'), failed.step);
});

test('two tour steps run: the screen is still captured and no tour-skipped warning appears', { timeout: 30000 }, async () => {
  const out = outDir();
  const res = await run({
    screens: [{ name: 'tours', steps: [{ goto: '/' }, { tour: true }, { tour: true }, { capture: 't' }] }],
    out,
    profile: NO_HOVER,
  });

  assert.ok(res.captured.includes('tours__t'), JSON.stringify(res.captured));
  assert.ok(!res.warnings.some((w) => /tour steps are skipped/.test(w)), JSON.stringify(res.warnings));
});

test('runStep rejects a flow step: flow steps are expanded before the walk', { timeout: 30000 }, async () => {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await assert.rejects(
      runStep(page, { flow: 'x' }, { baseUrl, profile: BASE, root: mainRoot, recording: false }),
      /flow steps are expanded before the walk/,
    );
  } finally {
    await browser.close();
  }
});

test('a role that comes from a login:<role> flow is NOT RUN when its storage-state file is missing: the flow set the role', { timeout: 30000 }, async () => {
  const out = outDir();
  const profile = profileWith({ login: { staff: { mode: 'storage-state', file: path.join(outDir(), 'missing.json') } } });
  const res = await run({
    screens: [{ name: 'gatedflow', flow: 'open:gated', steps: [{ capture: 'start' }] }],
    out,
    profile,
    flows: { 'open:gated': [{ flow: 'login:staff' }, { goto: '/' }] },
  });

  assert.ok(res.notRun.some((n) => n.screen === 'gatedflow'), JSON.stringify(res.notRun));
  assert.ok(!fs.existsSync(path.join(out, 'desktop', 'gatedflow__start.png')));
});

// ---- step 3: tree, checks, tour -----------------------------------------------------------------------------

test('every capture writes <screen>__<state>.aria.yml and record.tree names that file, which holds the heading', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({
    screens: [
      { name: 'treed', steps: [{ goto: '/' }, { capture: 'start' }] },
      { name: 'treedef', steps: [{ goto: '/' }] },
    ],
    out,
    profile: NO_HOVER,
  });

  for (const [file, yml] of [['treed__start.json', 'treed__start.aria.yml'], ['treedef__default.json', 'treedef__default.aria.yml']]) {
    const rec = readRecord(out, file);
    assert.equal(rec.tree, yml, JSON.stringify(rec));
    const text = fs.readFileSync(path.join(out, 'desktop', yml), 'utf8');
    assert.match(text, /heading "Home"/, text);
  }
});

test('record.checks is an array by default, and null with capture({ checks: false }) or profile.checks.enabled false', { timeout: 60000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'chk', steps: [{ goto: '/' }, { capture: 'on' }] }], out, profile: NO_HOVER });
  assert.ok(Array.isArray(readRecord(out, 'chk__on.json').checks), JSON.stringify(readRecord(out, 'chk__on.json').checks));

  await run({ screens: [{ name: 'chkoff', steps: [{ goto: '/' }, { capture: 'off' }] }], out, profile: NO_HOVER, checks: false });
  assert.equal(readRecord(out, 'chkoff__off.json').checks, null);

  await run({
    screens: [{ name: 'chkprof', steps: [{ goto: '/' }, { capture: 'off' }] }],
    out,
    profile: profileWith({ tour: { hover: false }, checks: { enabled: false } }),
  });
  assert.equal(readRecord(out, 'chkprof__off.json').checks, null);
});

test('the tour runs on the last capture of a screen only: the first record has tour null and the last has the tour object', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'twocap', steps: [{ goto: '/menu' }, { capture: 'a' }, { capture: 'b' }] }], out, profile: NO_HOVER });

  assert.equal(readRecord(out, 'twocap__a.json').tour, null);
  const tour = readRecord(out, 'twocap__b.json').tour;
  assert.ok(tour && typeof tour === 'object', JSON.stringify(tour));
  assert.ok(Array.isArray(tour.opened), JSON.stringify(tour));
  assert.ok(Array.isArray(tour.failed), JSON.stringify(tour));
  assert.ok(Array.isArray(tour.hover), JSON.stringify(tour));
  assert.equal(typeof tour.skipped, 'number', JSON.stringify(tour));
  assert.equal(tour.opened.length, 1, JSON.stringify(tour.opened));
});

test('screen.tour === false gives tour null on every record of the screen, default included', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({
    screens: [
      { name: 'notour', tour: false, steps: [{ goto: '/menu' }, { capture: 'a' }, { capture: 'b' }] },
      { name: 'notourdef', tour: false, steps: [{ goto: '/menu' }] },
    ],
    out,
    profile: NO_HOVER,
  });

  assert.equal(readRecord(out, 'notour__a.json').tour, null);
  assert.equal(readRecord(out, 'notour__b.json').tour, null);
  assert.equal(readRecord(out, 'notourdef__default.json').tour, null);
});

test('capture({ tour: false }) gives tour null on every record', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'offcap', steps: [{ goto: '/menu' }, { capture: 'a' }, { capture: 'b' }] }], out, profile: NO_HOVER, tour: false });

  assert.equal(readRecord(out, 'offcap__a.json').tour, null);
  assert.equal(readRecord(out, 'offcap__b.json').tour, null);
});

test('a { tour: true } step lands its result in the next record, and the automatic tour does not run again', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({
    screens: [{ name: 'midwalk', steps: [{ goto: '/menu' }, { tour: true }, { capture: 'x' }, { capture: 'y' }] }],
    out,
    profile: NO_HOVER,
  });

  const x = readRecord(out, 'midwalk__x.json').tour;
  assert.ok(x && typeof x === 'object', JSON.stringify(x));
  assert.equal(x.opened.length, 1, JSON.stringify(x.opened));
  assert.equal(readRecord(out, 'midwalk__y.json').tour, null);
});

test('a { tour: true } step after the last capture is not dropped: its result merges into that screen\'s last record on disk', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({
    // The step asks for hover, the profile does not: only the step's tour can produce hover entries.
    screens: [{ name: 'lastcap', steps: [{ goto: '/menu' }, { capture: 'list' }, { tour: { hover: true } }] }],
    out,
    profile: NO_HOVER,
  });

  const rec = readRecord(out, 'lastcap__list.json');
  // A screen with a tour step gets no automatic tour as well: one tour, one shot.
  assert.ok(rec.tour?.hover?.length > 0, `the step's tour is in the record: ${JSON.stringify(rec.tour)}`);
  assert.ok(!fs.existsSync(path.join(out, 'desktop', 'lastcap__tour-1.png')), 'the screen was toured once, not twice');
  assert.ok(rec.tour && typeof rec.tour === 'object', JSON.stringify(rec.tour));
  assert.equal(rec.tour.opened.length, 1, JSON.stringify(rec.tour.opened));
  assert.equal(rec.tour.opened[0].control, 'button "Actions"', JSON.stringify(rec.tour.opened[0]));
});

test('a { tour: true } step between two captures still lands in the next capture, and the earlier record keeps tour null', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({
    screens: [{ name: 'between', steps: [{ goto: '/menu' }, { capture: 'a' }, { tour: true }, { capture: 'b' }] }],
    out,
    profile: NO_HOVER,
  });

  assert.equal(readRecord(out, 'between__a.json').tour, null);
  const b = readRecord(out, 'between__b.json').tour;
  assert.ok(b && typeof b === 'object', JSON.stringify(b));
  assert.equal(b.opened.length, 1, JSON.stringify(b.opened));
});

test('a screen whose only tour step is the walk: the default record carries that result once, not twice', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'steponly', steps: [{ goto: '/menu' }, { tour: true }] }], out, profile: NO_HOVER });

  const tour = readRecord(out, 'steponly__default.json').tour;
  assert.ok(tour && typeof tour === 'object', JSON.stringify(tour));
  assert.equal(tour.opened.length, 1, JSON.stringify(tour.opened));
  assert.match(tour.opened[0].control, /Actions/, JSON.stringify(tour.opened[0]));
});

test('the tour shot is <screen>__tour-0.png and the opened entry names it', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'menushot', steps: [{ goto: '/menu' }, { capture: 'start' }] }], out, profile: NO_HOVER });

  assert.ok(fs.existsSync(path.join(out, 'desktop', 'menushot__tour-0.png')));
  assert.equal(readRecord(out, 'menushot__start.json').tour.opened[0].shot, 'menushot__tour-0.png');
});

test('no run emits the tour-skipped warning, with or without tour steps', { timeout: 30000 }, async () => {
  const out = outDir();
  const res = await run({
    screens: [
      { name: 'warna', steps: [{ goto: '/' }, { tour: true }, { capture: 'a' }] },
      { name: 'warnb', steps: [{ goto: '/menu' }, { capture: 'b' }] },
    ],
    out,
    profile: NO_HOVER,
  });

  assert.ok(!res.warnings.some((w) => /tour steps are skipped/.test(w)), JSON.stringify(res.warnings));
});

// ---- step 3: the clock ----------------------------------------------------------------------------------------------

const CLOCK_ISO = '2030-01-02T03:04:05.000Z';

test('openBrowser with a clock freezes Date.now in the pages, and it stays frozen after a 300 ms wait', { timeout: 30000 }, async () => {
  const context = await openBrowser(pw, { profile: BASE, viewport: [800, 600], clock: CLOCK_ISO });
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    assert.equal(await page.evaluate(() => Date.now()), Date.parse(CLOCK_ISO));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(await page.evaluate(() => Date.now()), Date.parse(CLOCK_ISO));
  } finally {
    await context.close();
  }
});

test('openBrowser without a clock leaves the real clock: a page Date.now is within 60 s of the test own', { timeout: 30000 }, async () => {
  const context = await openBrowser(pw, { profile: BASE, viewport: [800, 600] });
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    const testNow = Date.now();
    const pageNow = await page.evaluate(() => Date.now());
    assert.ok(Math.abs(pageNow - testNow) < 60000, `page ${pageNow} vs test ${testNow}`);
  } finally {
    await context.close();
  }
});

test('capture({ clock }) freezes the clock in each screen: a page heading that prints new Date() shows the clock', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'clocked', steps: [{ goto: '/clock' }, { capture: 'start' }] }], out, profile: NO_HOVER, clock: CLOCK_ISO });

  const rec = readRecord(out, 'clocked__start.json');
  const text = fs.readFileSync(path.join(out, 'desktop', rec.tree), 'utf8');
  assert.match(text, /2030-01-02T03:04:05/, text);
});

// --- step 6: metrics ----------------------------------------------------------------------------

test('step 6: a record carries metrics: numbers for ready time, bytes, requests and long tasks, server null without Server-Timing', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'timed', steps: [{ goto: '/' }, { capture: 'start' }] }], out });

  const m = readRecord(out, 'timed__start.json').metrics;
  assert.equal(typeof m, 'object');
  assert.notEqual(m, null);
  assert.equal(typeof m.readyMs, 'number');
  assert.ok(m.readyMs >= 0);
  assert.ok(m.bytes >= 0);
  assert.ok(m.requests >= 1, `requests ${m.requests}`);
  assert.ok(m.longTaskMs >= 0);
  assert.ok(m.heapBytes === null || typeof m.heapBytes === 'number');
  assert.equal(m.server, null);
});

test('step 6: metrics start right before the last goto, so the earlier goto is not counted', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'two-goto', steps: [{ goto: '/b' }, { goto: '/' }, { capture: 'start' }] }], out });

  const single = outDir();
  await run({ screens: [{ name: 'one-goto', steps: [{ goto: '/' }, { capture: 'start' }] }], out: single });
  assert.equal(readRecord(out, 'two-goto__start.json').metrics.requests, readRecord(single, 'one-goto__start.json').metrics.requests);
});

test('step 6: a collector that throws gives metrics null and the screen is still captured', { timeout: 30000 }, async () => {
  const out = outDir();
  // Every page opened through this pw refuses addInitScript, which is the first thing the collector does.
  const breaking = {
    ...pw,
    chromium: {
      launch: async (options) => {
        const browser = await pw.chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (o) => {
          const context = await newContext(o);
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            page.addInitScript = async () => {
              throw new Error('init refused');
            };
            return page;
          };
          return context;
        };
        return browser;
      },
    },
  };
  const result = await run({ screens: [{ name: 'broken', steps: [{ goto: '/' }, { capture: 'start' }] }], out, pw: breaking });

  assert.deepEqual(result.captured, ['broken__start']);
  assert.deepEqual(result.failed, []);
  const rec = readRecord(out, 'broken__start.json');
  assert.equal(rec.metrics, null);
  assert.equal(rec.elements[0].text, 'Open');
});

// --- step 7: record modes, checkpoints, coverage sources, overlay --------------------------------

const one = (name, extra = {}) => ({ name, steps: [{ goto: '/' }, { capture: 'start' }], ...extra });
const two = (name, extra = {}) => ({ name, steps: [{ goto: '/' }, { capture: 'first' }, { wait: 150 }, { capture: 'second' }], ...extra });
const webms = (out) => fs.readdirSync(path.join(out, 'desktop')).filter((f) => f.endsWith('.webm')).sort();
const NOISE = { checks: false, tour: false };

test('step 7: record "journeys" records a screen with two capture steps and a record: true screen, not a one-capture screen', { timeout: 90000 }, async () => {
  const out = outDir();
  await run({ screens: [two('j-two'), one('j-one'), one('j-flag', { record: true })], out, record: 'journeys', ...NOISE });

  assert.deepEqual(webms(out), ['j-flag.webm', 'j-two.webm']);
});

test('step 7: record "all" records every screen, one-capture screens included', { timeout: 90000 }, async () => {
  const out = outDir();
  await run({ screens: [two('a-two'), one('a-one')], out, record: 'all', ...NOISE });

  assert.deepEqual(webms(out), ['a-one.webm', 'a-two.webm']);
});

test('step 7: record "none" records no screen, even with record: true and a screen that sets record: true', { timeout: 90000 }, async () => {
  const out = outDir();
  const result = await run({ screens: [two('n-two'), one('n-flag', { record: true })], out, record: 'none', ...NOISE });

  assert.deepEqual(webms(out), []);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(path.join(out, 'desktop', 'n-flag.checkpoints.json')), false);

  const out2 = outDir();
  await run({ screens: [one('t-one')], out: out2, record: true, ...NOISE });
  assert.deepEqual(webms(out2), ['t-one.webm'], 'record: true still records a plain screen');
});

test('step 7: record false keeps the old behaviour: only a record: true screen records', { timeout: 90000 }, async () => {
  const out = outDir();
  await run({ screens: [two('f-two'), one('f-flag', { record: true })], out, record: false, ...NOISE });

  assert.deepEqual(webms(out), ['f-flag.webm']);
});

test('step 7: a recorded screen writes <screen>.checkpoints.json with one { state, atMs } per capture, atMs increasing; an unrecorded screen writes none', { timeout: 60000 }, async () => {
  const out = outDir();
  await run({ screens: [two('cp', { record: true }), two('cp-off')], out, ...NOISE });

  const points = JSON.parse(fs.readFileSync(path.join(out, 'desktop', 'cp.checkpoints.json'), 'utf8'));
  assert.deepEqual(points.map((p) => p.state), ['first', 'second']);
  for (const p of points) {
    assert.deepEqual(Object.keys(p).sort(), ['atMs', 'state']);
    assert.equal(typeof p.atMs, 'number');
    assert.ok(p.atMs > 0, `atMs ${p.atMs}`);
  }
  assert.ok(points[1].atMs > points[0].atMs, `increasing: ${JSON.stringify(points)}`);
  assert.equal(fs.existsSync(path.join(out, 'desktop', 'cp-off.checkpoints.json')), false);
});

test('step 7: coverage true writes <screen>__sources.json listing the repo files whose code ran, and none when coverage is off', { timeout: 60000 }, async () => {
  fs.mkdirSync(path.join(mainRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(mainRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(mainRoot, 'src', 'b.ts'), 'export const b = 1;\n');
  const out = outDir();
  const result = await run({ screens: [{ name: 'cov', steps: [{ goto: '/cov' }, { capture: 'start' }] }], out, coverage: true, ...NOISE });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'desktop', 'cov__sources.json'), 'utf8')), ['src/b.ts']);

  const off = outDir();
  await run({ screens: [{ name: 'cov', steps: [{ goto: '/cov' }, { capture: 'start' }] }], out: off, ...NOISE });
  assert.equal(fs.existsSync(path.join(off, 'desktop', 'cov__sources.json')), false);
});

test('step 7: a coverage failure writes [] and a warning, and the screen is still captured', { timeout: 60000 }, async () => {
  const out = outDir();
  const breaking = {
    ...pw,
    chromium: {
      launch: async (options) => {
        const browser = await pw.chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (o) => {
          const context = await newContext(o);
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            const refuse = async () => {
              throw new Error('coverage refused\nsecond line');
            };
            Object.defineProperty(page, 'coverage', { value: { startJSCoverage: refuse, stopJSCoverage: refuse }, configurable: true });
            return page;
          };
          return context;
        };
        return browser;
      },
    },
  };
  const result = await run({ screens: [one('cov-bad')], out, coverage: true, pw: breaking, ...NOISE });

  assert.deepEqual(result.captured, ['cov-bad__start']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'desktop', 'cov-bad__sources.json'), 'utf8')), []);
  assert.ok(result.warnings.includes('cov-bad: coverage failed: coverage refused'), JSON.stringify(result.warnings));
});

// The cursor dot is observed from inside the page at every full-page screenshot: a fixed element whose outer
// box is 14px square (display: none when hidden still has a computed size).
function cursorSpy() {
  const seen = [];
  const spied = {
    ...pw,
    chromium: {
      launch: async (options) => {
        const browser = await pw.chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (o) => {
          const context = await newContext(o);
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            const shoot = page.screenshot.bind(page);
            page.screenshot = async (opts) => {
              seen.push(
                await page
                  .evaluate(() =>
                    [...document.querySelectorAll('*')].some((el) => {
                      const cs = getComputedStyle(el);
                      const px = (v) => parseFloat(v) || 0;
                      const pad = cs.boxSizing === 'border-box' ? 0 : px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
                      return cs.position === 'fixed' && px(cs.width) + pad === 14;
                    })
                  )
                  .catch(() => null)
              );
              return shoot(opts);
            };
            return page;
          };
          return context;
        };
        return browser;
      },
    },
  };
  return { spied, seen };
}

test('step 7: a recorded screen has the 14px cursor dot in the page after a click, and an unrecorded screen does not', { timeout: 60000 }, async () => {
  const steps = [{ goto: '/b' }, { click: '#reveal' }, { capture: 'after-click' }];
  const on = cursorSpy();
  await run({ screens: [{ name: 'dot-on', steps }], out: outDir(), record: true, pw: on.spied, ...NOISE });
  assert.ok(on.seen.includes(true), `cursor dot seen in a recorded screen: ${JSON.stringify(on.seen)}`);

  const off = cursorSpy();
  await run({ screens: [{ name: 'dot-off', steps }], out: outDir(), pw: off.spied, ...NOISE });
  assert.ok(off.seen.length > 0 && !off.seen.includes(true), `no cursor dot without recording: ${JSON.stringify(off.seen)}`);
});

test('step 8: an expectation text that is a role-less span\'s whole text is collected, with no watch set', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'shop', steps: [{ goto: '/shop' }] }], out, profile: profileWith({ watch: null }), expectTexts: ['SALE', '/^hello@/', '/^\\$12/', 'Yo-yo'], checks: false, tour: false });

  const rec = readRecord(out, 'shop__default.json');
  const texts = rec.elements.map((e) => e.text);
  assert.deepEqual(texts.sort(), ['$12.00', 'SALE', 'hello@toyshop.test']);
  const sale = rec.elements.find((e) => e.text === 'SALE');
  assert.equal(sale.className, 'badge');
  assert.match(sale.style.background, /rgb\(204, 0, 0\)/);
  assert.ok(fs.existsSync(path.join(out, 'desktop', `shop__default__${sale.shot.match(/__(\d+)\.png$/)[1]}.png`)));
});

test('step 8: a record says which page checks ran: all but keyboard on a desktop screen, all of them on a phone-size one', { timeout: 60000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'a', steps: [{ goto: '/' }] }], out, profile: NO_HOVER, tour: false });
  assert.deepEqual(readRecord(out, 'a__default.json').checksRan, ['contrast', 'target', 'clipped', 'overlap', 'covered', 'focus']);

  const phone = outDir();
  await capture({ profile: { ...NO_HOVER, viewports: { phone: [390, 844] } }, mainRoot, baseUrl, screens: [{ name: 'a', steps: [{ goto: '/' }] }], out: phone, viewport: 'phone', headless: true, cwd: mainRoot, vars: {}, pw, log: () => {}, tour: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(phone, 'phone', 'a__default.json'), 'utf8')).checksRan, ['contrast', 'target', 'clipped', 'overlap', 'covered', 'keyboard', 'focus']);

  const off = outDir();
  await run({ screens: [{ name: 'a', steps: [{ goto: '/' }] }], out: off, profile: NO_HOVER, tour: false, checks: false });
  assert.equal(readRecord(off, 'a__default.json').checksRan, null);
});

test('step 8: no watch and no expectTexts collects nothing; expectTexts add to a watch without repeating an element', { timeout: 30000 }, async () => {
  const out = outDir();
  await run({ screens: [{ name: 'a', steps: [{ goto: '/' }] }], out, profile: profileWith({ watch: null }), checks: false, tour: false });
  assert.deepEqual(readRecord(out, 'a__default.json').elements, []);

  const out2 = outDir();
  await run({ screens: [{ name: 'a', steps: [{ goto: '/' }] }], out: out2, expectTexts: ['Open', 'Go to b'], checks: false, tour: false });
  assert.deepEqual(readRecord(out2, 'a__default.json').elements.map((e) => e.text).sort(), ['Go to b', 'Open']);
});
