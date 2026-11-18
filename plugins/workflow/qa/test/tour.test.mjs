// tourPage() in a real headless browser: inline fixtures via page.setContent, and one fixture server
// on an ephemeral port for the navigation case. The CONTRACT comment at the top of scripts/lib/tour.mjs
// is the spec; "contract line N" below means that comment's line N.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { POPUP_CONTROLS, tourPage } from '../scripts/lib/tour.mjs';

const VIEWPORT = { width: 1280, height: 800 };

// A fixture page: no margins, a body of the given size, every element placed with explicit px.
// box-sizing is border-box so a 200x240 element measures 200x240.
function doc(body, css = '', height = 800) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{position:relative;width:1280px;height:${height}px;font:14px sans-serif;background:#fff}
${css}
</style></head><body>${body}</body></html>`;
}

// A button that shows the hidden menu #m on click and hides it on Escape.
const MENU_SCRIPT = `<script>
document.getElementById('a').addEventListener('click', () => { document.getElementById('m').style.display = 'block'; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('m').style.display = 'none'; });
</script>`;

const MENU_BODY = `<button id="a" aria-haspopup="menu" aria-controls="m"
  style="position:absolute;left:20px;top:20px;width:120px;height:40px">Actions</button>
<div id="m" role="menu" style="display:none;position:absolute;left:20px;top:70px;width:160px;height:120px;background:#fff">Rename Delete</div>
${MENU_SCRIPT}`;

// A combobox that appends a listbox (aria-label Status, 200x240 at the card's top-left) to its card
// on click, and removes it on Escape. The card is 200x50 with overflow hidden.
const CARD_BODY = `<div class="card" style="position:absolute;left:100px;top:100px;width:200px;height:50px;overflow:hidden;background:#eee">
<div id="c" role="combobox" aria-label="Status" tabindex="0"
  style="position:absolute;left:10px;top:10px;width:180px;height:30px;background:#fff">Pick</div>
</div>
<script>
const card = document.querySelector('.card');
document.getElementById('c').addEventListener('click', () => {
  const l = document.createElement('div');
  l.id = 'lb';
  l.setAttribute('role', 'listbox');
  l.setAttribute('aria-label', 'Status');
  l.style.cssText = 'position:absolute;left:0;top:0;width:200px;height:240px;background:#fff';
  card.appendChild(l);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('lb')?.remove(); });
</script>`;

const TALL_CSS = '#low:hover{background:#f00}';
const TALL_BODY = `<button id="a" aria-haspopup="menu" aria-controls="m"
  style="position:absolute;left:20px;top:400px;width:120px;height:40px">Open</button>
<div id="m" role="menu" style="display:none;position:absolute;left:20px;top:450px;width:160px;height:100px;background:#fff">Items</div>
<button id="low" style="position:absolute;left:20px;top:2000px;width:120px;height:40px;background:#ddd">Low</button>
${MENU_SCRIPT}`;

const PAGES = {
  '/': doc(`<a id="go" href="/other" aria-haspopup="menu"
    style="position:absolute;left:20px;top:20px;width:120px;height:40px;display:block;background:#ddd">Go</a>`),
  '/other': doc('<h1 style="position:absolute;left:20px;top:20px;margin:0">Other</h1>'),
  '/tall': doc(TALL_BODY, TALL_CSS, 3000),
};

let browserLaunch;
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
  mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-tour-'));
  server = http.createServer(route);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  pw = loadPlaywright(mainRoot);
});

// One browser per file, launched on first use the way probe.test.mjs launches its own (no channel:
// capture.mjs maps the profile's 'chromium' channel to this same plain launch).
async function getBrowser() {
  browserLaunch ??= pw.chromium.launch({ headless: true });
  return browserLaunch;
}

after(async () => {
  if (browserLaunch) await browserLaunch.then((b) => b.close(), () => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(mainRoot, { recursive: true, force: true });
});

// One fresh page per test, at the 1280x800 viewport; always closed.
async function withPage(fn) {
  const page = await (await getBrowser()).newPage({ viewport: VIEWPORT });
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

// shot as capture.mjs supplies it: counts its calls and returns the PNG's basename.
function shotCounter() {
  const calls = { n: 0 };
  const shot = async () => `t-${calls.n++}.png`;
  return { shot, calls };
}

test('a menu opens: the entry has its control, shot, popup, and no findings', { timeout: 30000 }, async () => {
  const { shot, calls } = shotCounter();
  const r = await withPage(async (page) => {
    await page.setContent(doc(MENU_BODY));
    return tourPage(page, { shot, hover: false });
  });

  assert.equal(calls.n, 1, 'shot is called once per opened control');
  assert.equal(r.opened.length, 1, JSON.stringify(r));
  const e = r.opened[0];
  assert.equal(e.control, 'button "Actions"');
  assert.equal(e.shot, 't-0.png');
  assert.match(e.popup, /^menu/);
  assert.deepEqual(e.clipped, []);
  assert.deepEqual(e.covered, []);
  assert.equal(e.stuck, false);
  assert.deepEqual(r.failed, []);
});

test('a popup cut off by an overflow:hidden ancestor is reported as clipped', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const r = await withPage(async (page) => {
    await page.setContent(doc(CARD_BODY));
    return tourPage(page, { shot, hover: false });
  });

  assert.equal(r.opened.length, 1, JSON.stringify(r));
  const e = r.opened[0];
  assert.equal(e.control, 'combobox "Status"');
  assert.equal(e.popup, 'listbox "Status" 200×240');
  assert.equal(e.clipped.length, 1, JSON.stringify(e.clipped));
  assert.match(e.clipped[0], /cut off by div/);
  // The contract's example for this exact page (contract lines 59-63) has covered: [] — the points
  // the card hides are not counted as covered.
  assert.deepEqual(e.covered, []);
  assert.equal(e.stuck, false);
});

test('a popup that runs past the bottom of the viewport is reported as clipped', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const body = `<button id="a" aria-haspopup="menu" aria-controls="m"
    style="position:absolute;left:20px;top:20px;width:120px;height:40px">Open</button>
<div id="m" role="menu" style="display:none;position:absolute;left:20px;top:700px;width:200px;height:300px;background:#fff">Items</div>
${MENU_SCRIPT}`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });

  assert.equal(r.opened.length, 1, JSON.stringify(r));
  const e = r.opened[0];
  assert.ok(
    e.clipped.some((line) => line.includes('runs past the bottom of the screen')),
    JSON.stringify(e.clipped),
  );
});

test('a popup covered by a fixed header is reported at the corner it is covered at', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  // The header covers only the popup's top-left corner: x 0..260, y 0..220 against the popup's 200..400.
  const body = `<button id="a" aria-haspopup="menu" aria-controls="m"
    style="position:absolute;left:700px;top:100px;width:120px;height:40px">Open</button>
<div id="m" role="menu" style="display:none;position:absolute;left:200px;top:200px;width:200px;height:200px;background:#fff">Items</div>
<header style="position:fixed;left:0;top:0;width:260px;height:220px;z-index:10;background:#333"></header>
${MENU_SCRIPT}`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });

  assert.equal(r.opened.length, 1, JSON.stringify(r));
  const e = r.opened[0];
  assert.equal(e.covered.length, 1, JSON.stringify(e.covered));
  assert.ok(e.covered[0].includes('covered at top-left by header'), e.covered[0]);
});

test('a popup that ignores Escape is reported as stuck', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  // Same as the menu, without the Escape listener.
  const body = `<button id="a" aria-haspopup="menu" aria-controls="m"
    style="position:absolute;left:20px;top:20px;width:120px;height:40px">Sticky</button>
<div id="m" role="menu" style="display:none;position:absolute;left:20px;top:70px;width:160px;height:120px;background:#fff">Items</div>
<script>
document.getElementById('a').addEventListener('click', () => { document.getElementById('m').style.display = 'block'; });
</script>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });

  assert.equal(r.opened.length, 1, JSON.stringify(r));
  assert.equal(r.opened[0].control, 'button "Sticky"');
  assert.equal(r.opened[0].stuck, true);
});

test('a control whose click throws is listed in failed, not in opened', { timeout: 15000 }, async () => {
  const { shot } = shotCounter();
  // A full-page overlay intercepts the click, so Playwright's click times out at 3000 ms.
  const body = `<button id="a" aria-haspopup="menu" aria-controls="m"
    style="position:absolute;left:20px;top:20px;width:120px;height:40px">Broken</button>
<div id="m" role="menu" style="display:none;position:absolute;left:20px;top:70px;width:160px;height:120px;background:#fff">Items</div>
<div style="position:fixed;left:0;top:0;width:1280px;height:800px;z-index:100"></div>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });

  assert.equal(r.failed.length, 1, JSON.stringify(r));
  assert.equal(r.failed[0].control, 'button "Broken"');
  assert.equal(typeof r.failed[0].error, 'string');
  assert.ok(r.failed[0].error.length > 0, 'error is not empty');
  assert.ok(!r.failed[0].error.includes('\n'), 'error is the first line only');
  assert.equal(r.opened.some((e) => e.control === 'button "Broken"'), false);
});

test('a control that navigates is reported as navigated, and the page goes back to its URL', { timeout: 30000 }, async () => {
  const { shot, calls } = shotCounter();
  const start = `${baseUrl}/`;
  const r = await withPage(async (page) => {
    await page.goto(start);
    const result = await tourPage(page, { shot, hover: false });
    assert.equal(page.url(), start, 'the page is back at the remembered URL');
    return result;
  });

  assert.equal(r.opened.length, 1, JSON.stringify(r));
  const e = r.opened[0];
  assert.deepEqual(Object.keys(e).sort(), ['control', 'navigated']);
  assert.equal(e.control, 'a "Go"');
  assert.ok(e.navigated.endsWith('/other'), e.navigated);
  assert.equal(calls.n, 0, 'a navigated entry has no popup to shoot');
});

test('skip omits the matching controls from the tour', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const body = `<button id="a" aria-haspopup="menu" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Alpha</button>
<button id="b" aria-haspopup="menu" style="position:absolute;left:20px;top:80px;width:120px;height:40px">Beta</button>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, skip: ['#a'], hover: false });
  });

  assert.deepEqual(r.opened.map((e) => e.control), ['button "Beta"'], JSON.stringify(r));
  assert.deepEqual(r.failed, []);
});

test('open adds a plain control to the tour; without it the plain control is not toured', { timeout: 30000 }, async () => {
  const body = `<button id="plain" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Plain</button>`;

  const without = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot: shotCounter().shot, hover: false });
  });
  assert.deepEqual(without.opened, [], JSON.stringify(without));

  const withOpen = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot: shotCounter().shot, open: ['#plain'], hover: false });
  });
  assert.equal(withOpen.opened.length, 1, JSON.stringify(withOpen));
  assert.equal(withOpen.opened[0].control, 'button "Plain"');
  assert.equal(withOpen.opened[0].popup, null);
});

test('max caps the controls toured and counts the rest in skipped', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const button = (name, top) =>
    `<button aria-haspopup="menu" style="position:absolute;left:20px;top:${top}px;width:120px;height:40px">${name}</button>`;
  const body = button('One', 20) + button('Two', 80) + button('Three', 140);
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, max: 2, hover: false });
  });

  assert.deepEqual(
    [...r.opened, ...r.failed].map((x) => x.control).sort(),
    ['button "One"', 'button "Two"'],
    JSON.stringify(r),
  );
  assert.equal(r.skipped, 1);
});

test('a native select is never toured', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  // The select matches POPUP_CONTROLS through its aria-haspopup, so only the tour's <select> exclusion keeps it out.
  const body = `<select id="s" aria-haspopup="listbox" aria-label="Pick"
    style="position:absolute;left:20px;top:20px;width:160px;height:40px"><option>a</option><option>b</option></select>
<button aria-haspopup="menu" style="position:absolute;left:20px;top:80px;width:120px;height:40px">Other</button>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });

  assert.ok(r.opened.some((e) => e.control === 'button "Other"'), JSON.stringify(r));
  const selectSeen = [...r.opened, ...r.failed].some((x) => x.control.startsWith('select'));
  assert.equal(selectSeen, false, JSON.stringify(r));
});

test('controls with the same name are toured once, in the popup pass and in hover', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const button = (top) =>
    `<button aria-haspopup="menu" style="position:absolute;left:20px;top:${top}px;width:120px;height:40px">Actions</button>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(button(20) + button(80)));
    return tourPage(page, { shot });
  });

  assert.equal(r.opened.filter((e) => e.control === 'button "Actions"').length, 1, JSON.stringify(r));
  assert.equal(r.hover.filter((h) => h.control === 'button "Actions"').length, 1, JSON.stringify(r.hover));
});

test('hover reports changed when a hovered element changes its style', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const body = `<button id="h" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Lift</button>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body, '#h{background:#ddd} #h:hover{background:#f00}'));
    return tourPage(page, { shot });
  });

  assert.deepEqual(r.hover, [{ control: 'button "Lift"', changed: true }], JSON.stringify(r));
});

test('hover reports not changed for an element with no hover style', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const body = `<button id="s" style="position:absolute;left:20px;top:20px;width:160px;height:40px;background:#ddd">Still</button>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot });
  });

  assert.deepEqual(r.hover, [{ control: 'button "Still"', changed: false }], JSON.stringify(r));
});

test('hover:false skips the hover pass', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const body = `<button id="h" style="position:absolute;left:20px;top:20px;width:160px;height:40px;background:#ddd">Lift</button>`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body, '#h:hover{background:#f00}'));
    return tourPage(page, { shot, hover: false });
  });

  assert.deepEqual(r.hover, []);
});

test('the URL, viewport size and scroll are as they were after the tour, and nothing is focused', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const r = await withPage(async (page) => {
    await page.goto(`${baseUrl}/tall`);
    await page.evaluate(() => window.scrollTo(0, 300));
    const url = page.url();
    const viewport = page.viewportSize();
    assert.equal(await page.evaluate(() => window.scrollY), 300, 'scroll set before the tour');

    const result = await tourPage(page, { shot });

    assert.equal(page.url(), url);
    assert.deepEqual(page.viewportSize(), viewport);
    assert.equal(await page.evaluate(() => window.scrollY), 300);
    assert.equal(
      await page.evaluate(() => document.activeElement === null || document.activeElement === document.body),
      true,
      'nothing is focused after the tour',
    );
    return result;
  });

  // The fixture's menu is toured, so the tour did run on the scrolled page.
  assert.equal(r.opened.length, 1, JSON.stringify(r));
});

test('POPUP_CONTROLS is the selector in the contract', () => {
  assert.equal(
    POPUP_CONTROLS,
    '[aria-haspopup]:not([aria-haspopup="false"]), [role="combobox"], ' +
      'input[type="date"], input[type="datetime-local"], input[type="time"], input[type="month"], input[type="week"]',
  );
});

test('pilot: a recording overlay (click ring) appearing on click is never a popup', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const r = await withPage(async (page) => {
    await page.setContent(doc(`<button id="b" onclick="const d=document.createElement('div');d.setAttribute('data-mfqa-overlay','');d.style.cssText='position:fixed;left:10px;top:10px;width:36px;height:36px;border:3px solid red;pointer-events:none';document.body.appendChild(d)">Ring</button>`));
    return tourPage(page, { shot, hover: false, open: ['#b'] });
  });
  for (const e of r.opened) {
    assert.equal(e.popup, null, JSON.stringify(e));
    assert.equal(e.stuck, false);
  }
});

test('a rounded popup is not covered by the frame showing through its cut-away corners', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  // A 14 px-rounded listbox over a fixed frame: a point 2 px in from each box corner lies outside the curve and
  // hits the frame; the popup paints everywhere inside the curve.
  const frame = '<div class="frame" style="position:fixed;inset:0;background:#eee"></div>';
  const body = `${frame}<button id="a" aria-haspopup="menu" aria-controls="m"
    style="position:absolute;left:700px;top:100px;width:120px;height:40px;z-index:1">Open</button>
<div id="m" role="menu" style="display:none;position:absolute;left:200px;top:200px;width:200px;height:200px;background:#fff;border-radius:14px;z-index:1">Items</div>
${MENU_SCRIPT}`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });
  assert.equal(r.opened.length, 1, JSON.stringify(r));
  assert.deepEqual(r.opened[0].covered, []);
});

test('the radius of a rounded panel filling a square popup root moves the corner points in too', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const frame = '<div style="position:fixed;inset:0;background:#eee"></div>';
  const body = `${frame}<button id="a" aria-haspopup="menu" aria-controls="m"
    style="position:absolute;left:700px;top:100px;width:120px;height:40px;z-index:1">Open</button>
<div id="m" role="menu" style="display:none;position:absolute;left:200px;top:200px;width:200px;height:200px;z-index:1;pointer-events:auto">
  <div style="width:200px;height:200px;background:#fff;border-radius:16px">Items</div>
</div>
${MENU_SCRIPT}`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });
  assert.equal(r.opened.length, 1, JSON.stringify(r));
  assert.deepEqual(r.opened[0].covered, []);
});

test('a rounded popup under a fixed header is still reported covered at that corner', { timeout: 30000 }, async () => {
  const { shot } = shotCounter();
  const body = `<button id="a" aria-haspopup="menu" aria-controls="m"
    style="position:absolute;left:700px;top:100px;width:120px;height:40px">Open</button>
<div id="m" role="menu" style="display:none;position:absolute;left:200px;top:200px;width:200px;height:200px;background:#fff;border-radius:14px">Items</div>
<header style="position:fixed;left:0;top:0;width:260px;height:220px;z-index:10;background:#333"></header>
${MENU_SCRIPT}`;
  const r = await withPage(async (page) => {
    await page.setContent(doc(body));
    return tourPage(page, { shot, hover: false });
  });
  assert.equal(r.opened.length, 1, JSON.stringify(r));
  const e = r.opened[0];
  assert.equal(e.covered.length, 1, JSON.stringify(e.covered));
  assert.ok(e.covered[0].includes('covered at top-left by header'), e.covered[0]);
});
