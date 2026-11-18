// runChecks() in a real headless browser, on page.setContent (no server). The CONTRACT comment in
// scripts/lib/checks.mjs (lines 1-82) is the spec. Each check is shown to FIRE on a page built to break it and to
// stay QUIET on the same page fixed, as Sen's checks.spec.ts does (its axe test became our `contrast` check).
// Every page is plain HTML at the phone's 390x844, with explicit px sizes and colours, no web fonts, no timing.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { CHECK_IDS, TARGETS, checksRan, runChecks } from '../scripts/lib/checks.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHONE = { width: 390, height: 844 };

// A page that is clean in every check, with `style` and `body` added to it (Sen's html()).
const html = (body, style = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check fixture</title>
<style>
  body { margin: 0; font: 16px/24px sans-serif; color: #1a1a1a; background: #fff; }
  main { padding: 16px; }
  button { min-width: 48px; min-height: 48px; font: inherit; color: #1a1a1a; background: #e8e8e8; border: 0; border-radius: 8px; }
  input { box-sizing: border-box; height: 48px; width: 100%; font: inherit; color: #1a1a1a; background: #fff; border: 1px solid #767676; }
  button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid #0a3d91; outline-offset: 2px; }
  ${style}
</style>
</head>
<body>
${body}
</body>
</html>`;

// The nav bar fixed to the foot of the screen. Empty on purpose: its own text would add overlap findings.
const BAR = '<nav style="position: fixed; left: 0; right: 0; bottom: 0; height: 80px; background: #ddd"></nav>';

let browser;

before(async () => {
  const pw = loadPlaywright(PLUGIN_ROOT);
  browser = await pw.chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

// runChecks on a fresh phone-sized page with `content`; the page is closed afterwards.
async function run(content, opts = {}) {
  const page = await browser.newPage({ viewport: PHONE });
  try {
    await page.setContent(content);
    return await runChecks(page, opts);
  } finally {
    await page.close();
  }
}

// The findings of one check, from a run of that check alone.
async function findings(content, check, opts = {}) {
  return (await run(content, { ...opts, only: [check] })).filter((f) => f.check === check);
}

// A fixed page: no finding from that check.
async function quietFor(content, check, opts = {}) {
  assert.deepEqual(await run(content, { ...opts, only: [check] }), []);
}

const details = (list) => list.map((f) => f.detail);

describe('contract', () => {
  test('CHECK_IDS lists the seven checks in order', () => {
    assert.deepEqual(CHECK_IDS, ['contrast', 'target', 'clipped', 'overlap', 'covered', 'keyboard', 'focus']);
  });

  test('TARGETS is a non-empty selector string', () => {
    assert.equal(typeof TARGETS, 'string');
    assert.ok(TARGETS.length > 0);
  });

  test('a clean page reports nothing from any check, touch included', async () => {
    const clean = html('<main><h1>Title</h1><p>Plain text</p><button>Go</button></main>');
    assert.deepEqual(await run(clean, { touch: true }), []);
  });

  test('checksRan: every check on a touch screen, keyboard off it, nothing that threw or when the whole run failed', () => {
    assert.deepEqual(checksRan([], { touch: true }), CHECK_IDS);
    assert.deepEqual(checksRan([{ check: 'target', detail: 'button "x" 20×20 under 24 px' }], {}), CHECK_IDS.filter((id) => id !== 'keyboard'));
    assert.deepEqual(checksRan([{ check: 'focus', detail: 'check failed: boom' }], { touch: true }), CHECK_IDS.filter((id) => id !== 'focus'));
    assert.deepEqual(checksRan([], { touch: true, only: ['contrast', 'keyboard', 'nope'] }), ['contrast', 'keyboard']);
    assert.deepEqual(checksRan([{ check: 'checks', detail: 'check failed: boom' }], { touch: true }), []);
  });

  test('only runs the checks it names', async () => {
    const mixed = html(
      '<main><p style="width: 200px; height: 24px; margin: 0; color: #999999">Pale grey on white</p><button style="width: 30px; height: 30px; min-width: 0; min-height: 0; padding: 0">Go</button></main>',
    );
    const r = await run(mixed, { touch: true, only: ['target'] });
    assert.deepEqual(details(r), ['button "Go" 30×30 under 48 px']);
    assert.deepEqual(r.map((f) => f.check), ['target']);
  });
});

describe('contrast', () => {
  const para = (colour) =>
    html(`<main><p style="width: 200px; height: 24px; margin: 0; color: ${colour}">Pale grey on white</p></main>`);

  test('fires on text too pale to read on white', async () => {
    const f = await findings(para('#999999'), 'contrast');
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /^p "Pale grey on white" 200×24 contrast \d\.\d:1 \(#999999 on #ffffff\), needs 4\.5:1$/);
  });

  test('is quiet once the text is dark enough', async () => {
    await quietFor(para('#333333'), 'contrast');
  });

  test('its detail is exact: ratio to one decimal, the colours, the bar', async () => {
    // #979797 on white is 2.92:1, so it reads 2.9 whether the ratio is floored or rounded.
    assert.deepEqual(details(await findings(para('#979797'), 'contrast')), [
      'p "Pale grey on white" 200×24 contrast 2.9:1 (#979797 on #ffffff), needs 4.5:1',
    ]);
  });

  test('large text (24 px) is held to 3:1, not 4.5:1', async () => {
    const large = html(
      '<main><p style="width: 300px; height: 32px; margin: 0; color: #979797; font-size: 24px; line-height: 32px">Large grey text</p></main>',
    );
    assert.deepEqual(details(await findings(large, 'contrast')), [
      'p "Large grey text" 300×32 contrast 2.9:1 (#979797 on #ffffff), needs 3:1',
    ]);
    // #8a8a8a is 3.45:1: quiet as large text, but the same colour at 16 px needs 4.5:1 and fires.
    const bigGrey = html(
      '<main><p style="width: 300px; height: 32px; margin: 0; color: #8a8a8a; font-size: 24px; line-height: 32px">Large grey text</p></main>',
    );
    await quietFor(bigGrey, 'contrast');
    assert.equal((await findings(para('#8a8a8a'), 'contrast')).length, 1);
  });

  test('is quiet on a disabled control, and fires on the same control enabled', async () => {
    const enabled = html('<main><button style="color: #999999">Pale enabled</button></main>');
    const disabled = html('<main><button disabled style="color: #999999">Pale enabled</button></main>');
    assert.equal((await findings(enabled, 'contrast')).length, 1);
    await quietFor(disabled, 'contrast');
  });
});

describe('target', () => {
  const btn = (size) =>
    html(
      `<main><button style="width: ${size}px; height: ${size}px; min-width: 0; min-height: 0; padding: 0">Go</button></main>`,
    );

  test('fires on a 30 px button under touch (48 px)', async () => {
    assert.deepEqual(details(await findings(btn(30), 'target', { touch: true })), ['button "Go" 30×30 under 48 px']);
  });

  test('is quiet at 48 px under touch', async () => {
    await quietFor(btn(48), 'target', { touch: true });
  });

  test('a pointer needs 24 px: 30 px is quiet, 20 px fires as under 24 px, and touch still fires at 30 px', async () => {
    await quietFor(btn(30), 'target', { touch: false });
    assert.deepEqual(details(await findings(btn(20), 'target')), ['button "Go" 20×20 under 24 px']);
    assert.equal((await findings(btn(30), 'target', { touch: true })).length, 1);
  });

  test('caps at maxPerCheck: 60 small targets give 50, then "… 10 more"', async () => {
    const buttons = Array.from(
      { length: 60 },
      (_, i) =>
        `<button aria-label="Item ${i + 1}" style="width: 20px; height: 20px; min-width: 0; min-height: 0; padding: 0"></button>`,
    ).join('');
    const r = await run(html(`<main>${buttons}</main>`), { touch: true, maxPerCheck: 50, only: ['target'] });
    assert.equal(r.length, 51);
    assert.equal(r[0].detail, 'button "Item 1" 20×20 under 48 px');
    assert.equal(r[49].detail, 'button "Item 50" 20×20 under 48 px');
    assert.deepEqual(r[50], { check: 'target', detail: '… 10 more' });
  });

  // A link in a line of text: 17 px tall, so under both 24 px and 48 px. Pointer exempts it (WCAG 2.5.8); touch does not.
  const inLine = (linkStyle = '') =>
    html(
      `<main><p style="font:14px/17px sans-serif;width:400px">Read the <a href="#x"${linkStyle}>terms</a> before you sign.</p></main>`,
    );

  test('pointer exempts an inline link inside a line of text: no finding', async () => {
    await quietFor(inLine(), 'target', { touch: false });
  });

  test('touch does not exempt that same inline link: one finding, under 48 px', async () => {
    const list = details(await findings(inLine(), 'target', { touch: true }));
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.match(list[0], /^a "terms" .*under 48 px$/, JSON.stringify(list));
  });

  test('pointer still fires on a lone link with no text beside it: one finding, under 24 px', async () => {
    const lone = html('<main><div><a href="#y" style="font:14px/17px sans-serif">Edit</a></div></main>');
    const list = details(await findings(lone, 'target', { touch: false }));
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.match(list[0], /^a "Edit" .*under 24 px$/, JSON.stringify(list));
  });

  test('pointer still fires on an inline-block link inside a sentence: only computed display inline is exempt', async () => {
    const list = details(await findings(inLine(' style="display: inline-block"'), 'target', { touch: false }));
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.match(list[0], /^a "terms" .*under 24 px$/, JSON.stringify(list));
  });
});

describe('clipped', () => {
  test('fires on text cut off sideways by its own box', async () => {
    const cut = html(
      '<main><div style="width: 100px; height: 24px; overflow: hidden; white-space: nowrap">A caption longer than its box</div></main>',
    );
    const f = await findings(cut, 'clipped');
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /^div "A caption longer than its box" 100×24 text cut off sideways \(content \d+ px in 100 px\)$/);
  });

  test('is quiet when an ellipsis ends the text on purpose', async () => {
    await quietFor(
      html(
        '<main><div style="width: 100px; height: 24px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis">A caption longer than its box</div></main>',
      ),
      'clipped',
    );
  });

  test('fires on text cut off below its box', async () => {
    const f = await findings(
      html(
        '<main><p style="width: 120px; height: 24px; margin: 0; overflow: hidden">Caption that wraps onto lines</p></main>',
      ),
      'clipped',
    );
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /^p "Caption that wraps onto lines" 120×24 text cut off below \(content \d+ px in 24 px\)$/);
  });

  test('is quiet when a line clamp cuts the text on purpose', async () => {
    await quietFor(
      html(
        '<main><p style="width: 120px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden">One two three four five six seven eight nine ten eleven twelve thirteen</p></main>',
      ),
      'clipped',
    );
  });

  test('fires on text that runs past the right edge of the screen', async () => {
    const f = await findings(
      html(
        '<main><p style="margin-left: 260px; width: auto; white-space: nowrap">Past the right edge</p></main>',
      ),
      'clipped',
    );
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /^p "Past the right edge" \d+×\d+ text runs past the right edge \(x \d+ to \d+ of 390\)$/);
  });

  test('is quiet once the text fits the screen', async () => {
    await quietFor(html('<main><p>Inside the edge</p></main>'), 'clipped');
  });

  test('is quiet for a sideways strip whose far end is off screen by design', async () => {
    await quietFor(
      html(
        '<main><div tabindex="0" aria-label="Chips" style="display: flex; gap: 8px; align-items: center; height: 48px; overflow-x: auto"><span style="flex: none">A first chip</span><span style="flex: none">A second chip</span><span style="flex: none">A third chip</span><span style="flex: none">A fourth chip</span></div></main>',
      ),
      'clipped',
    );
  });
});

describe('overlap', () => {
  // Buttons carry aria-label only, so their own text cannot add a text-overlap finding.
  const targets = (top) =>
    html(
      `<main style="position: relative; height: 300px"><button aria-label="First" style="position: absolute; left: 20px; top: 20px; width: 100px; height: 48px"></button><button aria-label="Second" style="position: absolute; left: 50px; top: ${top}px; width: 100px; height: 48px"></button></main>`,
    );

  test('fires on two targets drawn over each other, with the overlap size', async () => {
    assert.deepEqual(details(await findings(targets(40), 'overlap')), [
      'target button "First" 100×48 overlaps button "Second" 100×48 by 70×28',
    ]);
  });

  test('is quiet once the targets are apart', async () => {
    await quietFor(targets(100), 'overlap');
  });

  const texts = (top) =>
    html(
      `<main style="position: relative; height: 100px"><span style="position: absolute; left: 20px; top: 20px">Overdue bills</span><span style="position: absolute; left: 40px; top: ${top}px">RM 1,284.00</span></main>`,
    );

  test('fires on two texts drawn over each other', async () => {
    const f = await findings(texts(24), 'overlap');
    assert.equal(f.length, 1);
    assert.match(f[0].detail, /^text span "Overdue bills" \d+×\d+ overlaps span "RM 1,284\.00" \d+×\d+ by \d+×\d+$/);
  });

  test('is quiet once the texts are apart', async () => {
    await quietFor(texts(60), 'overlap');
  });

  test('is quiet for a bar fixed over scrolling content: that is the covered check, not this one', async () => {
    await quietFor(
      html(`<main><div style="height: 1400px"><p style="margin-top: 770px">Under the bar</p></div></main>${BAR}`),
      'overlap',
    );
  });

  test('is quiet for tight line spacing, whose lines touch but whose letters do not', async () => {
    await quietFor(
      html(
        '<main><h2 style="margin: 0; font-size: 40px; line-height: 1">Big</h2><h2 style="margin: 0; font-size: 40px; line-height: 1">Bigger</h2></main>',
      ),
      'overlap',
    );
  });
});

describe('covered', () => {
  // the last control on a long page, with a bar fixed over the foot of the screen
  const longPage = (room) =>
    html(
      `<main style="padding-bottom: ${room}px"><div style="height: 1400px"></div><button style="width: 48px; height: 48px; padding: 0">Save</button></main>${BAR}`,
    );

  test('fires on a button the bar still hides at the foot of the page', async () => {
    assert.deepEqual(details(await findings(longPage(0), 'covered')), ['button "Save" 48×48 under nav']);
  });

  test('is quiet once the page has room to scroll it clear', async () => {
    await quietFor(longPage(96), 'covered');
  });

  test('is quiet for a button the bar hides only until it is scrolled to', async () => {
    await quietFor(
      html(
        `<main><div style="height: 760px"></div><button style="width: 48px; height: 48px; padding: 0">Save</button><div style="height: 1000px"></div></main>${BAR}`,
      ),
      'covered',
    );
  });

  // A page with a nav of links (aria-label only, so no text findings), behind a sheet over the whole screen.
  // `attrs` makes the sheet a modal (or not); `behind` goes on the page under it. Inside the sheet, a Delete
  // button with a lid over it: a real cover inside the modal. With `lid` off the sheet is clean.
  const NAV =
    '<nav><a href="#a" aria-label="Users" style="display: block; width: 200px; height: 48px"></a><a href="#b" aria-label="Systems" style="display: block; width: 200px; height: 48px"></a><button aria-label="Edit"></button></nav>';
  const sheet = ({ attrs = '', behind = '', lid = false } = {}) =>
    html(
      `<main ${behind}>${NAV}</main><div class="sheet-overlay" style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.1)"><div class="sheet" ${attrs} aria-label="Edit system" style="position: absolute; right: 0; top: 0; bottom: 0; width: 150px; background: #fff"><div style="position: relative; margin: 16px; height: 48px"><button aria-label="Delete"></button>${lid ? '<div class="lid" style="position: absolute; inset: 0; background: #eee"></div>' : ''}</div></div></div>`,
    );

  test('fires on everything an overlay hides when nothing says it is a modal', async () => {
    assert.deepEqual(details(await findings(sheet(), 'covered')), [
      'a "Users" 200×48 under div.sheet-overlay',
      'a "Systems" 200×48 under div.sheet-overlay',
      'button "Edit" 48×48 under div.sheet-overlay',
    ]);
  });

  test('is quiet for the page behind an open modal: role=dialog with aria-modal, alertdialog, inert behind it', async () => {
    for (const s of [
      { attrs: 'role="dialog" aria-modal="true"' },
      { attrs: 'role="alertdialog"' },
      { behind: 'inert' },
    ])
      await quietFor(sheet(s), 'covered');
  });

  test('is quiet for the page behind a <dialog> opened with showModal()', async () => {
    await quietFor(
      html(
        `<main>${NAV}</main><dialog aria-label="Edit system" style="width: 300px; height: 200px"><button aria-label="Close"></button></dialog><script>document.querySelector('dialog').showModal()</script>`,
      ),
      'covered',
    );
  });

  test('still fires on a real cover inside the open modal', async () => {
    assert.deepEqual(
      details(await findings(sheet({ attrs: 'role="dialog" aria-modal="true"', lid: true }), 'covered')),
      ['button "Delete" 48×48 under div.lid'],
    );
  });

  // a fixed header behind a sheet: its small button, and its pinned box over the sheet's pinned button
  const header = (attrs) =>
    html(
      `<header style="position: fixed; left: 0; right: 0; top: 0; height: 48px"><button aria-label="Menu" style="position: absolute; right: 8px; top: 0; width: 16px; height: 16px; min-width: 0; min-height: 0; padding: 0"></button></header><div class="sheet" ${attrs} aria-label="Edit system" style="position: fixed; right: 0; top: 0; width: 300px; height: 200px; background: #fff"><button aria-label="Close" style="position: absolute; right: 0; top: 0"></button></div>`,
    );

  test('target leaves the page behind an open modal alone too', async () => {
    assert.deepEqual(details(await findings(header(''), 'target')), ['button "Menu" 16×16 under 24 px']);
    await quietFor(header('role="dialog" aria-modal="true"'), 'target');
  });

  test('overlap leaves the page behind an open modal alone too', async () => {
    assert.equal((await findings(header(''), 'overlap')).length, 1);
    await quietFor(header('role="dialog" aria-modal="true"'), 'overlap');
  });

  // A nested donut, as recharts draws one: each ring a group (with a tab stop) of sector shapes, the middle of
  // every ring's box a hole. The outer ring is a stroked circle, the inner one a filled ring (evenodd).
  const ring = (cx, r1, r2) =>
    `M ${cx - r2} ${cx} A ${r2} ${r2} 0 1 1 ${cx + r2} ${cx} A ${r2} ${r2} 0 1 1 ${cx - r2} ${cx} Z M ${cx - r1} ${cx} A ${r1} ${r1} 0 1 0 ${cx + r1} ${cx} A ${r1} ${r1} 0 1 0 ${cx - r1} ${cx} Z`;
  const donut = (over = '') =>
    html(
      `<main style="position: relative"><svg width="200" height="200" viewBox="0 0 200 200"><g tabindex="0" aria-label="Outer"><circle cx="100" cy="100" r="80" fill="none" stroke="#3366cc" stroke-width="20"></circle></g><g tabindex="0" aria-label="Inner"><path fill-rule="evenodd" fill="#dc3912" d="${ring(100, 30, 55)}"></path><text x="100" y="105" text-anchor="middle" pointer-events="none" font-size="12">Total</text></g></svg>${over}</main>`,
      'g:focus-visible { outline: none }',
    );

  test('is quiet for svg groups whose shapes are free, though the middle of their box is a hole', async () => {
    await quietFor(donut(), 'covered');
  });

  test('fires on an svg shape that something really covers', async () => {
    const lid = '<div class="lid" style="position: absolute; left: 16px; top: 16px; width: 200px; height: 200px; background: #eee"></div>';
    assert.deepEqual(details(await findings(donut(lid), 'covered')), ['g "Outer" 160×160 under div.lid', 'g "Inner" 110×110 under div.lid']);
  });

  // A chart whose <svg> root takes the tab stop itself: its rings are stroked circles, an unused clip path sits in
  // its defs, and an HTML label is laid over the middle of the svg's box, where nothing of the svg paints (0.6.0).
  const ringChart = (over = '') =>
    html(
      `<main style="position: relative"><svg tabindex="0" aria-label="Rings" width="200" height="200" viewBox="0 0 200 200"><defs><clipPath id="plot"><rect x="0" y="0" width="200" height="200"></rect></clipPath></defs><g clip-path="url(#plot)"><circle cx="100" cy="100" r="85" fill="none" stroke="#3366cc" stroke-width="14"></circle><circle cx="100" cy="100" r="65" fill="none" stroke="#dc3912" stroke-width="14"></circle></g></svg><span class="total" style="position: absolute; left: 76px; top: 102px; width: 80px; line-height: 28px; text-align: center; background: #fff">Total 42</span>${over}</main>`,
      'svg:focus-visible { outline: 2px solid #0a3d91 }',
    );

  test('is quiet for a focusable <svg> chart with an HTML label over its middle: its rings are free', async () => {
    await quietFor(ringChart(), 'covered');
  });

  test('fires on a focusable <svg> chart that an opaque overlay really covers', async () => {
    const lid = '<div class="lid" style="position: absolute; left: 0; top: 0; width: 240px; height: 240px; background: #eee"></div>';
    assert.deepEqual(details(await findings(ringChart(lid), 'covered')), ['svg "Rings" 200×200 under div.lid']);
  });
});

describe('keyboard', () => {
  const KB = { touch: true };
  // A form whose column clips at the screen's height. With `clip`, a shrunk screen (the keyboard) leaves the
  // button below 508 px out of reach; without it the page scrolls to the button.
  const form = (clip) =>
    html(
      `<div style="${clip ? 'height: 100vh; overflow: clip' : ''}"><div style="height: 352px"></div><form onsubmit="return false"><label for="n" style="display: block; height: 24px; margin: 0">Name</label><input id="n" type="text" style="display: block; width: 200px; height: 48px; margin: 0"><div style="height: 100px"></div><button type="submit" style="display: block; width: 48px; height: 48px; padding: 0; margin: 0">Save</button></form></div>`,
    );

  test('fires on a submit button the keyboard leaves out of reach, with the reach in px', async () => {
    assert.deepEqual(details(await findings(form(true), 'keyboard', KB)), [
      'button "Save" 48×48 out of reach: 524 to 572 in a 508 px screen',
    ]);
  });

  test('is quiet when the page scrolls to the button', async () => {
    await quietFor(form(false), 'keyboard', KB);
  });

  test('fires on a field the shrunk screen leaves out of reach', async () => {
    const f = await findings(
      html(
        '<div style="height: 100vh; overflow: clip"><div style="height: 700px"></div><input aria-label="Amount" type="text" style="display: block; width: 200px; height: 48px; margin: 0"></div>',
      ),
      'keyboard',
      KB,
    );
    assert.deepEqual(details(f), ['input "Amount" 200×48 out of reach: 700 to 748 in a 508 px screen']);
  });

  test('does not run without touch, and fires with it', async () => {
    await quietFor(form(true), 'keyboard', { touch: false });
    assert.equal((await findings(form(true), 'keyboard', KB)).length, 1);
  });
});

describe('focus', () => {
  const field = (ring = '') =>
    html(
      '<main><input aria-label="Amount" type="text" style="width: 200px"><button style="width: 48px; height: 48px; padding: 0">Save</button></main>',
      ring,
    );

  test('fires on controls that take focus with no ring, exact details in tab order', async () => {
    const f = await findings(field('button:focus-visible, input:focus-visible { outline: none }'), 'focus');
    assert.deepEqual(details(f), [
      'input "Amount" 200×48 takes focus with no ring to see',
      'button "Save" 48×48 takes focus with no ring to see',
    ]);
  });

  test('fires when only a shadow the control always has is there', async () => {
    const shadowOnly = field(
      'button:focus-visible, input:focus-visible { outline: none } button, input { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3) }',
    );
    assert.equal((await findings(shadowOnly, 'focus')).length, 2);
  });

  test('fires on a ring the colour of its background', async () => {
    const whiteRing = field('button:focus-visible, input:focus-visible { outline: 2px solid #fff }');
    assert.equal((await findings(whiteRing, 'focus')).length, 2);
  });

  test('is quiet with an outline ring', async () => {
    await quietFor(field(''), 'focus');
  });

  test('is quiet with a box-shadow ring', async () => {
    await quietFor(
      field(
        'button:focus-visible, input:focus-visible { outline: none; box-shadow: 0 0 0 3px #0a3d91 } button, input { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3) }',
      ),
      'focus',
    );
  });

  test('is quiet with a ring drawn by ::after', async () => {
    await quietFor(
      html(
        '<main><button style="position: relative; width: 48px; height: 48px; padding: 0">Save</button></main>',
        'button { outline: none } button:focus-visible::after { content: ""; position: absolute; inset: -4px; border-radius: 12px; outline: 2px solid #0a3d91 }',
      ),
      'focus',
    );
  });

  // Two states on a map: an svg path and a small circle with role=button and a tab stop. `ring` is the CSS
  // of their focus look; outline is off, as an app that draws its own ring turns it off.
  const map = (ring = '', extra = '') =>
    html(
      `<main><svg width="240" height="120" viewBox="0 0 240 120"><path role="button" tabindex="0" aria-label="Selangor" d="M 10 10 L 110 10 L 90 100 L 20 90 Z" fill="#c6dbef" stroke="#dddddd" stroke-width="0.75"></path><circle role="button" tabindex="0" aria-label="Putrajaya" cx="180" cy="60" r="14" fill="transparent" stroke="none" stroke-width="1.5"></circle>${extra}</svg></main>`,
      `path, circle { outline: none } ${ring}`,
    );

  test('fires on svg shapes that take focus with no ring', async () => {
    assert.deepEqual(details(await findings(map(), 'focus')), [
      'path "Selangor" 100×90 takes focus with no ring to see',
      'circle "Putrajaya" 28×28 takes focus with no ring to see',
    ]);
  });

  test('is quiet for svg shapes whose ring is a stroke', async () => {
    await quietFor(map('path:focus-visible, circle:focus-visible { stroke: #0a3d91 } path:focus-visible { stroke-width: 2 }'), 'focus');
  });

  test('is quiet for an svg shape whose ring is drawn on a sibling', async () => {
    const page = html(
      '<main><svg width="240" height="120" viewBox="0 0 240 120"><path role="button" tabindex="0" aria-label="Selangor" d="M 10 10 L 110 10 L 90 100 L 20 90 Z" fill="#c6dbef"></path><rect class="ring" x="6" y="6" width="108" height="98" fill="none" stroke="#0a3d91" stroke-width="2"></rect></svg></main>',
      'path { outline: none } .ring { visibility: hidden } path:focus-visible + .ring { visibility: visible }',
    );
    await quietFor(page, 'focus');
  });

  test('is quiet for a field whose underline darkens on the wrapper that holds it', async () => {
    await quietFor(
      html(
        '<main><div class="wrap"><input aria-label="Amount" type="text" style="width: 200px"></div></main>',
        '.wrap { border-bottom: 2px solid #c8c8c8; width: 200px } .wrap:focus-within { border-bottom-color: #0a3d91 } input { border: 0; outline: none }',
      ),
      'focus',
    );
  });
});

describe('restoration', () => {
  test('after a full run, the viewport, the window scroll and an inner scroll are as they were, and nothing is focused', async () => {
    const page = await browser.newPage({ viewport: PHONE });
    try {
      await page.setContent(
        html(
          '<main><div style="height: 1400px"></div><input aria-label="Amount" type="text" style="width: 200px"><button style="width: 48px; height: 48px; padding: 0">Save</button><div id="list" style="height: 100px; overflow: auto"><div style="height: 600px"></div></div></main>',
        ),
      );
      await page.evaluate(() => {
        window.scrollTo(0, 300);
        document.getElementById('list').scrollTop = 50;
      });
      const viewportBefore = page.viewportSize();
      await runChecks(page, { touch: true });
      assert.deepEqual(page.viewportSize(), viewportBefore);
      assert.equal(await page.evaluate(() => window.scrollY), 300);
      assert.equal(await page.evaluate(() => document.getElementById('list').scrollTop), 50);
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    } finally {
      await page.close();
    }
  });
});
