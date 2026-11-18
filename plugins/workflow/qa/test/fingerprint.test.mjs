// Standing and shared-chrome fingerprints (rework U7, design 2026-11-12 §8). Every page-check and tour finding gets a
// fingerprint — check, role, accessible name, nearest landmark, never the screen — stored on the finding in
// results.json. A fingerprint in qa/standing.md is a Standing note on any screen; a fingerprint on 2 or more walked
// screens in one run is shared chrome: a Note, listed in summary.md as a standing candidate. Neither ever gates.
// Contracts: scripts/lib/fingerprint.mjs, standing.mjs 'U7', summary.mjs 'U7', verdict.mjs 'U7', run.mjs 'U7',
// checks.mjs and tour.mjs 'U7', qa.mjs 'standing add'. Every fixture is neutral: no real app, library or screen.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import { runChecks } from '../scripts/lib/checks.mjs';
import { FP_INSTALL, elementFingerprint, fingerprintId, fingerprintKey, fingerprintText, parseFingerprint } from '../scripts/lib/fingerprint.mjs';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { addFingerprints, mergeStanding, readStanding, rowFingerprint, standingId, standingItems, standingMatcher } from '../scripts/lib/standing.mjs';
import { buildResults, summaryMd } from '../scripts/lib/summary.mjs';
import { tourPage } from '../scripts/lib/tour.mjs';
import { draftVerdict } from '../scripts/lib/verdict.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const TEMPLATE = fs.readFileSync(new URL('../templates/standing.md', import.meta.url), 'utf8');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};

// ── fixtures: compare pairs whose after records carry fingerprints ─────────────

const LINK = { role: 'link', name: 'Support', landmark: 'navigation "Primary"' };
const LINK_FP = { check: 'contrast', ...LINK };
const LINK_TEXT = 'contrast on link "Support" in navigation "Primary"';
const MENU = { role: 'button', name: 'Account', landmark: 'banner' };
const CLIPPED = 'menu "Account" 200×300 runs past the bottom of the screen';
const contrast = (fp = LINK) => ({ check: 'contrast', detail: 'span "Support" 60×20 contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1', ...(fp ? { fp } : {}) });

function pair(key, status, { checksNew = [], checksStanding = [], newOnBase = null, tourNew = [], tourStanding = [], opened = [], pixel = null } = {}) {
  const screen = key.split('__')[0];
  return {
    key, status, before: status === 'new' ? null : { screen }, after: { screen, tour: { opened, failed: [], hover: [], skipped: 0 } },
    elements: [], tree: null, pixel,
    checks: { new: checksNew, standing: checksStanding, fixed: [], ...(newOnBase ? { newOnBase } : {}) },
    tour: { opened: opened.length, failed: 0, hover: 0, hoverSilent: 0, new: tourNew, standing: tourStanding, fixed: [] },
    console: { new: [], standing: [] },
  };
}
const vp = (viewport, pairs) => ({ viewport, exit: 1, pairs, expectations: [], unexpected: [], overflow: [], inconclusive: [], eyes: [], standing: { checks: 0, tour: 0, console: 0 } });
function runOf(viewports, { standingRows = [] } = {}) {
  return {
    mode: 'diff', slug: 'pr-x', exit: 1, head: { sha: SHA_A, ref: 'HEAD' }, base: { sha: SHA_B, ref: 'main' }, maps: {}, sandboxes: {}, steps: [], warnings: [],
    blocked: null, newEntries: {},
    sides: { head: { viewports: viewports.map((v) => ({ viewport: v.viewport, captured: v.pairs.map((p) => p.key), failed: [], notRun: [], warnings: [] })), ms: 1 }, base: null },
    compare: { exit: 1, viewports },
    standingRows,
  };
}
const ids = (list) => list.map((x) => x.id);

// ── the fingerprint text ───────────────────────────────────────────────────────

describe('fingerprint text', () => {
  test('fingerprintText reads as a sentence; parseFingerprint is its inverse, quotes and backslashes too', () => {
    assert.equal(fingerprintText(LINK_FP), LINK_TEXT);
    assert.deepEqual(parseFingerprint(LINK_TEXT), LINK_FP);
    const odd = { check: 'tour:clipped', role: 'button', name: 'Say "hi" \\ now', landmark: 'region "A \\"b\\""' };
    assert.equal(fingerprintText(odd), 'tour:clipped on button "Say \\"hi\\" \\\\ now" in region "A \\"b\\""');
    assert.deepEqual(parseFingerprint(fingerprintText(odd)), odd);
    assert.deepEqual(parseFingerprint('target on button "" in page'), { check: 'target', role: 'button', name: '', landmark: 'page' });
  });

  test('an old standing row text is no fingerprint', () => {
    assert.equal(parseFingerprint('contrast: span "Support" 60×20 contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1'), null);
    assert.equal(parseFingerprint('menu "Columns" 180×300 runs past the top of the screen'), null);
    assert.equal(parseFingerprint(''), null);
  });

  test('fingerprintKey ignores digits and spacing; fingerprintId is the st- id of that key', () => {
    assert.equal(fingerprintKey({ ...LINK_FP, name: 'Inbox 3' }), fingerprintKey({ ...LINK_FP, name: 'Inbox  12' }));
    assert.notEqual(fingerprintKey(LINK_FP), fingerprintKey({ ...LINK_FP, landmark: 'main' }));
    assert.match(fingerprintId(LINK_FP), /^st-[0-9a-f]{8}$/);
    assert.equal(fingerprintId({ ...LINK_FP, name: 'Inbox 3' }), fingerprintId({ ...LINK_FP, name: 'Inbox 4' }));
    assert.notEqual(fingerprintId(LINK_FP), fingerprintId({ ...LINK_FP, check: 'target' }));
  });
});

// ── in the browser ────────────────────────────────────────────────────────────

describe('elementFingerprint, checks and tour in a real browser', () => {
  let browser;
  let page;
  before(async () => {
    browser = await loadPlaywright(tmp('mfqa-fp-main-')).chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  });
  after(async () => {
    await browser?.close();
  });

  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fp</title></head><body>
<header><nav aria-label="Primary"><a href="/s"><span id="s1">Support</span></a></nav></header>
<main><header><button id="hb">Back</button></header>
<h2 id="h">Orders <span id="cnt">12</span></h2>
<table><tr><td><span id="cell">3 days</span></td></tr></table>
<div><span id="plain">Grey text</span></div>
<section aria-label="Notes"><button id="b">Save</button></section>
<section><button id="b2">Keep</button></section>
<input id="q" placeholder="Search orders"><label>Email <input id="e"></label>
<img id="i" alt="Logo" src="data:,">
</main>
<aside><p id="p">Help text</p></aside>
<footer><a id="f" href="/t">Terms</a></footer>
<div role="dialog" aria-labelledby="dt"><h3 id="dt">Filters</h3><button id="d">Apply</button></div>
<div id="nolm">Loose text</div>
<svg width="100" height="40"><text id="svgt" x="4" y="20">Revenue</text></svg>
</body></html>`;

  test('role, name and nearest landmark from the DOM: a span is about its link, a role-less text is text', async () => {
    await page.setContent(PAGE);
    const fp = (id) => page.$eval(`#${id}`, elementFingerprint);
    assert.deepEqual(await fp('s1'), LINK);
    assert.deepEqual(await fp('hb'), { role: 'button', name: 'Back', landmark: 'main' }, 'a header inside main is no banner');
    assert.deepEqual(await fp('cnt'), { role: 'heading', name: 'Orders 12', landmark: 'main' });
    assert.deepEqual(await fp('cell'), { role: 'cell', name: '3 days', landmark: 'main' });
    assert.deepEqual(await fp('plain'), { role: 'text', name: 'Grey text', landmark: 'main' });
    assert.deepEqual(await fp('b'), { role: 'button', name: 'Save', landmark: 'region "Notes"' });
    assert.deepEqual(await fp('b2'), { role: 'button', name: 'Keep', landmark: 'main' }, 'an unnamed section is no region');
    assert.deepEqual(await fp('q'), { role: 'textbox', name: 'Search orders', landmark: 'main' });
    assert.deepEqual(await fp('e'), { role: 'textbox', name: 'Email', landmark: 'main' });
    assert.deepEqual(await fp('i'), { role: 'img', name: 'Logo', landmark: 'main' });
    assert.deepEqual(await fp('p'), { role: 'paragraph', name: 'Help text', landmark: 'complementary' });
    assert.deepEqual(await fp('f'), { role: 'link', name: 'Terms', landmark: 'contentinfo' });
    assert.deepEqual(await fp('d'), { role: 'button', name: 'Apply', landmark: 'dialog "Filters"' });
    assert.deepEqual(await fp('nolm'), { role: 'text', name: 'Loose text', landmark: 'page' });
    assert.deepEqual(await fp('svgt'), { role: 'text', name: 'Revenue', landmark: 'page' });
  });

  test('FP_INSTALL puts the same function on window, for probes that cannot import', async () => {
    await page.setContent(PAGE);
    await page.evaluate(FP_INSTALL);
    assert.deepEqual(await page.evaluate(() => window.__mfqaFp(document.getElementById('s1'))), LINK);
  });

  test('runChecks: each element finding carries its fingerprint; the overflow line has none', async () => {
    const links = Array.from({ length: 3 }, (_, i) => `<a href="/x${i}" style="color:#bbbbbb">Help ${i}</a>`).join(' ');
    await page.setContent(`<!doctype html><html><body><nav aria-label="Primary">${links}</nav><main><p style="color:#aaaaaa">Muted</p></main></body></html>`);
    const found = await runChecks(page, { only: ['contrast'], maxPerCheck: 3 });
    assert.deepEqual(found.slice(0, 3).map((f) => f.fp), [
      { role: 'link', name: 'Help 0', landmark: 'navigation "Primary"' },
      { role: 'link', name: 'Help 1', landmark: 'navigation "Primary"' },
      { role: 'link', name: 'Help 2', landmark: 'navigation "Primary"' },
    ]);
    assert.deepEqual(found[3], { check: 'contrast', detail: '… 1 more' });
  });

  test('runChecks: an overlap is about the first element of the pair', async () => {
    await page.setContent(`<!doctype html><html><body><main style="position:relative;height:120px">
<button style="position:absolute;left:10px;top:10px;width:100px;height:48px">First</button>
<button style="position:absolute;left:40px;top:30px;width:100px;height:48px">Second</button></main></body></html>`);
    const found = await runChecks(page, { only: ['overlap'] });
    assert.deepEqual(found.map((f) => f.fp), [{ role: 'button', name: 'First', landmark: 'main' }]);
  });

  test('tourPage: an opened entry carries the fingerprint of the control that opened it', async () => {
    await page.setContent(`<!doctype html><html><body style="margin:0"><header style="height:40px">
<button aria-haspopup="menu" aria-controls="m" onclick="document.getElementById('m').hidden = false">Account</button></header>
<div id="m" role="menu" hidden style="position:fixed; top:780px; left:0; width:200px; height:300px; background:#fff">x</div></body></html>`);
    const r = await tourPage(page, { shot: async () => 'x.png', hover: false });
    assert.equal(r.opened.length, 1);
    assert.deepEqual(r.opened[0].fp, MENU);
    assert.ok(r.opened[0].clipped.some((c) => / runs past the bottom of the screen$/.test(c)), JSON.stringify(r.opened[0]));
  });
});

// ── results.json: fingerprints, standing matches, shared chrome ───────────────

describe('buildResults', () => {
  test('every new page-check and tour finding carries its fingerprint; one captured without has none', () => {
    const r = buildResults(runOf([vp('desktop', [
      pair('a__default', 'new', { checksNew: [contrast()], tourNew: [CLIPPED], opened: [{ control: 'button "Account"', shot: 's.png', popup: 'menu "Account" 200×300', clipped: [CLIPPED], covered: [], stuck: false, fp: MENU }] }),
      pair('b__default', 'new', { checksNew: [contrast(null)] }),
    ])]));
    assert.deepEqual(r.checks.new[0].fingerprint, LINK_FP);
    assert.deepEqual(r.tour.new[0].fingerprint, { check: 'tour:clipped', ...MENU });
    assert.equal('fingerprint' in r.checks.new[1], false);
    assert.deepEqual(r.chrome, []);
  });

  test('a fingerprint on two walked screens is shared chrome: results.chrome lists it, each new finding names it', () => {
    const r = buildResults(runOf([vp('desktop', [pair('a__default', 'new', { checksNew: [contrast()] }), pair('b__default', 'new', { checksNew: [contrast()] })])]));
    assert.deepEqual(r.chrome, [{
      id: 'chrome:1', fingerprint: LINK_FP, text: LINK_TEXT, screens: ['a', 'b'],
      findings: ['chk:desktop/a__default/1', 'chk:desktop/b__default/1'],
    }]);
    assert.deepEqual(r.checks.new.map((c) => c.chrome), ['chrome:1', 'chrome:1']);
  });

  test('a screen where the base had it too counts as walked; only the new findings are named', () => {
    const r = buildResults(runOf([vp('desktop', [pair('a__default', 'same', { checksStanding: [contrast()] }), pair('b__default', 'new', { checksNew: [contrast()] })])]));
    assert.deepEqual(r.chrome.map((c) => [c.screens, c.findings]), [[['a', 'b'], ['chk:desktop/b__default/1']]]);
  });

  test('one screen at two viewports, or two states of one screen, is one screen: no chrome', () => {
    const twoVps = buildResults(runOf([vp('desktop', [pair('a__default', 'new', { checksNew: [contrast()] })]), vp('phone', [pair('a__default', 'new', { checksNew: [contrast()] })])]));
    assert.deepEqual(twoVps.chrome, []);
    const twoStates = buildResults(runOf([vp('desktop', [pair('a__default', 'new', { checksNew: [contrast()] }), pair('a__open', 'new', { checksNew: [contrast()] })])]));
    assert.deepEqual(twoStates.chrome, []);
  });

  test('a fingerprint the PR regressed on a screen the base had (element on base) is no chrome: the page rule judges it', () => {
    const r = buildResults(runOf([vp('desktop', [
      pair('a__default', 'changed', { checksNew: [contrast()], newOnBase: [true] }), pair('b__default', 'new', { checksNew: [contrast()] }),
    ])]));
    assert.deepEqual(r.chrome, []);
    assert.equal(r.checks.new.some((c) => c.chrome), false);
  });

  test('a fingerprint row in qa/standing.md matches the finding on any screen; matched, it is no chrome candidate', () => {
    const rows = readStanding(addFingerprints(null, [LINK_FP], { slug: 'pr-0', date: '2026-11-01' }).text);
    const r = buildResults(runOf([vp('desktop', [pair('a__default', 'new', { checksNew: [contrast()] }), pair('b__default', 'new', { checksNew: [contrast()] })])], { standingRows: rows }));
    assert.deepEqual(r.checks.new.map((c) => c.standing), [fingerprintId(LINK_FP), fingerprintId(LINK_FP)]);
    assert.deepEqual(r.standing.matched, [{ id: fingerprintId(LINK_FP), text: LINK_TEXT, findings: ['chk:desktop/a__default/1', 'chk:desktop/b__default/1'] }]);
    assert.deepEqual(r.chrome, []);
  });

  test('an old row (one screen, no fingerprint) still matches its own finding on its own screen only', () => {
    const text = `contrast: ${contrast().detail}`;
    const id = standingId({ viewport: 'desktop', key: 'a__default', kind: 'check', text });
    const rows = [{ id, screen: 'desktop/a__default', kind: 'check', finding: text, firstSeen: '', lastSeen: '', owner: '', note: '' }];
    const r = buildResults(runOf([vp('desktop', [pair('a__default', 'new', { checksNew: [contrast(null)] }), pair('b__default', 'new', { checksNew: [contrast(null)] })])], { standingRows: rows }));
    assert.deepEqual(r.checks.new.map((c) => c.standing ?? null), [id, null]);
  });
});

// ── summary.md and the verdict draft ─────────────────────────────────────────

describe('summary.md and the draft', () => {
  const twoScreens = (over = {}) => runOf([vp('desktop', [
    pair('a__default', 'changed', { checksNew: [contrast()], newOnBase: [false], pixel: { ratio: 0.1, worstTile: 0.2, changed: true }, ...over }),
    pair('b__default', 'new', { checksNew: [contrast()] }),
  ])]);

  test('summary.md: the Standing section offers each chrome candidate; the checks lines say which finding is which', () => {
    const md = summaryMd(buildResults(twoScreens()));
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith('## Standing — '));
    assert.equal(lines[at + 1], `- [chrome:1] ${LINK_TEXT}: 2 screens — add to standing?`);
    assert.ok(lines.includes(`- [chk:desktop/a__default/1] contrast: ${contrast().detail} — shared chrome chrome:1`), md);
  });

  test('summary.md: a matched standing row is listed under Standing, its findings marked', () => {
    const rows = readStanding(addFingerprints(null, [LINK_FP], { slug: 'pr-0', date: '2026-11-01' }).text);
    const run = twoScreens();
    run.standingRows = rows;
    const md = summaryMd(buildResults(run));
    assert.ok(md.includes(`\n- [${fingerprintId(LINK_FP)}] standing: ${LINK_TEXT} — 2 finding(s) in this run, Notes, never gating\n`), md);
    assert.ok(md.includes(`- [chk:desktop/b__default/1] contrast: ${contrast().detail} — standing ${fingerprintId(LINK_FP)}`), md);
  });

  test('draft: shared chrome is a Note that never gates, even where eyes ruled the screen wrong; Standing offers it', () => {
    const results = { ...buildResults(twoScreens()), expectations: [{ id: 'exp:x', viewport: 'desktop', name: 'x', result: 'met', detail: 'ok' }] };
    const eyes = [{ id: 'scr:desktop/a__default', verdict: 'wrong', fix: 'grey link' }];
    const d = draftVerdict(results, { eyes });
    const row = d.findings.find((f) => f.id === 'chk:desktop/a__default/1');
    assert.equal(row.severity, 'Note');
    assert.match(row.text, / — shared chrome chrome:1: on 2 screens, never gating$/);
    assert.deepEqual(d.gates, []);
    assert.ok(d.md.includes(`## Standing\n- 0 standing item(s), never gating\n- [chrome:1] ${LINK_TEXT}: 2 screens — add to standing?\n`), d.md);
    assert.ok(d.md.includes('\n- standing and shared chrome: 0 finding(s) match qa/standing.md, 2 sit on 2 or more screens (shared chrome); Notes, never gating; the candidates are under Standing\n'), d.md);
  });

  test('draft: without the second screen the same finding is judged by the page rule as before (it gates)', () => {
    const results = { ...buildResults(runOf([vp('desktop', [pair('a__default', 'changed', { checksNew: [contrast()], newOnBase: [false], pixel: { ratio: 0.1, worstTile: 0.2, changed: true } })])])), expectations: [] };
    const d = draftVerdict(results, { eyes: [{ id: 'scr:desktop/a__default', verdict: 'wrong', fix: 'grey link' }] });
    assert.deepEqual(d.gates, ['chk:desktop/a__default/1']);
  });

  test('draft: a finding matched in qa/standing.md is a Note on any screen, a stuck tour control too', () => {
    const fps = [LINK_FP, { check: 'tour:stuck', ...MENU }];
    const rows = readStanding(addFingerprints(null, fps, { slug: 'pr-0', date: '2026-11-01' }).text);
    const stuck = 'button "Account" does not close on Escape';
    const run = runOf([vp('desktop', [pair('a__default', 'changed', {
      checksNew: [contrast()], newOnBase: [true], pixel: { ratio: 0.1, worstTile: 0.2, changed: true }, tourNew: [stuck],
      opened: [{ control: 'button "Account"', shot: 's.png', popup: 'menu "Account" 1×1', clipped: [], covered: [], stuck: true, fp: MENU }],
    })])], { standingRows: rows });
    const d = draftVerdict({ ...buildResults(run), expectations: [] });
    const sev = Object.fromEntries(d.findings.map((f) => [f.id, [f.severity, f.text.split(' — ').at(-1)]]));
    assert.deepEqual(sev['chk:desktop/a__default/1'], ['Note', `standing ${fingerprintId(LINK_FP)}: in qa/standing.md, never gating`]);
    assert.deepEqual(sev['tour:desktop/a__default/1'], ['Note', `standing ${fingerprintId(fps[1])}: in qa/standing.md, never gating`]);
    assert.deepEqual(d.gates, []);
  });
});

// ── qa/standing.md ───────────────────────────────────────────────────────────

describe('qa/standing.md fingerprint rows', () => {
  const ROW = `| ${fingerprintId(LINK_FP)} | * | check | ${LINK_TEXT} | 2026-11-12 pr-x | 2026-11-12 pr-x | the user | dismissed in review |`;

  test('addFingerprints: a row on screen * whose finding is the fingerprint text; twice adds nothing', () => {
    const out = addFingerprints(null, [LINK_FP], { slug: 'pr-x', date: '2026-11-12', owner: 'the user', note: 'dismissed in review' });
    assert.equal(out.text, `${TEMPLATE}${ROW}\n`);
    assert.deepEqual([out.added, out.existing], [[fingerprintId(LINK_FP)], []]);
    const again = addFingerprints(out.text, [LINK_FP], { slug: 'pr-y', date: '2026-11-13' });
    assert.equal(again.text, out.text);
    assert.deepEqual([again.added, again.existing], [[], [fingerprintId(LINK_FP)]]);
    const tour = addFingerprints(out.text, [{ check: 'tour:covered', ...MENU }], { slug: 'pr-x', date: '2026-11-12' });
    assert.equal(readStanding(tour.text)[1].kind, 'tour');
  });

  test('readStanding reads it like any row; rowFingerprint gives it back; an old row has none', () => {
    const text = `${TEMPLATE}| st-0000aaaa | desktop/a__default | check | contrast: x | d | d |  |  |\n${ROW}\n`;
    const rows = readStanding(text);
    assert.deepEqual(rows.map(rowFingerprint), [null, LINK_FP]);
    const match = standingMatcher(rows);
    assert.equal(match({ viewport: 'phone', key: 'z__default', kind: 'check', text: 'contrast: y', fingerprint: { ...LINK_FP } })?.id, fingerprintId(LINK_FP));
    assert.equal(match({ viewport: 'phone', key: 'z__default', kind: 'check', text: 'contrast: y', fingerprint: { ...LINK_FP, landmark: 'main' } }), null);
  });

  test('standingItems carries the fingerprint the record gave; mergeStanding bumps a fingerprint row instead of adding one per screen', () => {
    const p = pair('a__default', 'same', {
      checksStanding: [contrast()], tourStanding: [CLIPPED],
      opened: [{ control: 'button "Account"', shot: 's.png', popup: 'm', clipped: [CLIPPED], covered: [], stuck: false, fp: MENU }],
    });
    const items = standingItems({ viewports: [vp('desktop', [p])] });
    assert.deepEqual(items.map((i) => i.fingerprint), [LINK_FP, { check: 'tour:clipped', ...MENU }]);
    const start = `${TEMPLATE}${ROW}\n`;
    const merged = mergeStanding(start, items, { slug: 'pr-z', date: '2026-11-14' });
    assert.deepEqual([merged.added, merged.seen], [1, 1], 'the tour item has no fingerprint row: it gets its own row');
    const rows = readStanding(merged.text);
    assert.equal(rows[0].lastSeen, '2026-11-14 pr-z');
    assert.equal(rows[0].owner, 'the user');
    assert.equal(rows.length, 2);
  });

  test('mergeStanding touched: the rows a run matched get their last seen', () => {
    const merged = mergeStanding(`${TEMPLATE}${ROW}\n`, [], { slug: 'pr-z', date: '2026-11-14', touched: [fingerprintId(LINK_FP)] });
    assert.equal(readStanding(merged.text)[0].lastSeen, '2026-11-14 pr-z');
    assert.equal(merged.seen, 1);
  });
});

// ── the CLI and the run ──────────────────────────────────────────────────────

function gitRepo(prefix) {
  const dir = tmp(prefix);
  const g = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, g };
}

describe('qa standing add', () => {
  test('a chrome candidate, a finding or a fingerprint text becomes a fingerprint row; an unknown id writes nothing', () => {
    const { dir, g } = gitRepo('mfqa-fp-cli-');
    g(['init', '-q']);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'one']);
    const V = path.join(dir, 'qa', 'pr-x');
    fs.mkdirSync(V, { recursive: true });
    const results = buildResults(runOf([vp('desktop', [
      pair('a__default', 'new', { checksNew: [contrast()], tourNew: [CLIPPED], opened: [{ control: 'button "Account"', shot: 's.png', popup: 'm', clipped: [CLIPPED], covered: [], stuck: false, fp: MENU }] }),
      pair('b__default', 'new', { checksNew: [contrast(), contrast(null)] }),
    ])]));
    fs.writeFileSync(path.join(V, 'results.json'), JSON.stringify(results));
    const cli = (...args) => spawnSync(process.execPath, [CLI, 'standing', 'add', ...args], { cwd: dir, encoding: 'utf8' });
    const file = path.join(dir, 'qa', 'standing.md');

    const bad = cli('chk:desktop/b__default/2', '--slug', 'pr-x');
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /no fingerprint for chk:desktop\/b__default\/2/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(cli('nope:1', '--slug', 'pr-x').status, 1);

    const ok = cli('chrome:1,tour:desktop/a__default/1', '--slug', 'pr-x', '--note', 'shared header');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.deepEqual(ok.stdout.trim().split('\n'), [
      `- [${fingerprintId(LINK_FP)}] * check: ${LINK_TEXT}`,
      `- [${fingerprintId({ check: 'tour:clipped', ...MENU })}] * tour: tour:clipped on button "Account" in banner`,
    ]);
    assert.deepEqual(readStanding(fs.readFileSync(file, 'utf8')).map((r) => [r.screen, r.note]), [['*', 'shared header'], ['*', 'shared header']]);

    const same = cli('chk:desktop/a__default/1', '--slug', 'pr-x');
    assert.equal(same.status, 0);
    assert.equal(same.stdout.trim(), `- [${fingerprintId(LINK_FP)}] already standing: ${LINK_TEXT}`);
    const byText = cli('--fp', 'target on button "Delete" in main', '--slug', 'pr-x');
    assert.equal(byText.status, 0, byText.stderr);
    assert.equal(readStanding(fs.readFileSync(file, 'utf8')).length, 3);
    assert.equal(cli('--fp', 'not a fingerprint').status, 1);
    assert.equal(cli('chrome:1', '--slug', 'pr-none').status, 3);
  });
});

describe('runQa', () => {
  test('the run matches qa/standing.md: the finding is a standing Note in results and the draft, and the row gets its last seen', async () => {
    const { dir, g } = gitRepo('mfqa-fp-run-');
    g(['init', '-q']);
    g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.mkdirSync(path.join(dir, 'qa', 'map'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'qa', 'map', 'app.json'), '{"screens":[{"name":"a","sources":["b.txt"],"steps":[{"goto":"/"}]}]}\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'one']);
    g(['checkout', '-q', '-b', 'feat/x']);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'two']);
    fs.writeFileSync(path.join(dir, 'qa', 'standing.md'), addFingerprints(null, [LINK_FP], { slug: 'pr-0', date: '2026-11-01' }).text);
    const side = { viewports: [{ viewport: 'desktop', captured: ['a__default'], failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: 'off' }, mapErrors: [], ms: 1 };
    const deps = {
      up: async (req) => ({ name: `qa-${req.at.slice(0, 10)}`, slug: 'x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: '2026-11-06T00:00:00.000Z', sha: req.at }),
      down: async (req) => ({ name: req.name, warnings: [] }),
      captureSide: async (req) => {
        fs.mkdirSync(path.join(req.out, 'desktop'), { recursive: true });
        fs.writeFileSync(path.join(req.out, 'desktop', 'a__default.json'), '{}\n');
        return structuredClone(side);
      },
      compare: async (req) => {
        fs.mkdirSync(req.out, { recursive: true });
        fs.writeFileSync(path.join(req.out, 'results.json'), '{}\n');
        return { exit: 1, viewports: [vp('desktop', [pair('a__default', 'changed', { checksNew: [contrast()], newOnBase: [true], pixel: { ratio: 0.1, worstTile: 0.2, changed: true } })])] };
      },
      sleep: async () => {},
      now: () => new Date('2026-11-06T10:00:00Z'),
    };
    const profile = { map: 'qa/map', seedNames: 'qa/seed.json', base: 'sandbox', viewports: { desktop: [1440, 900] }, clock: 'seed', checks: { enabled: true }, tour: { enabled: true }, sandbox: { max: 3, retryWaitMs: 15000 }, run: { cacheKeep: 5 }, volatile: [] };
    const run = await runQa({ mainRoot: dir, repoRoot: dir, profile, log: () => {} }, deps);
    assert.equal(run.results.checks.new[0].standing, fingerprintId(LINK_FP));
    const draft = fs.readFileSync(path.join(dir, 'qa', 'feat-x', 'verdict.draft.md'), 'utf8');
    assert.match(draft, /^- Note \[chk:desktop\/a__default\/1\] .* — standing st-[0-9a-f]{8}: in qa\/standing\.md, never gating$/m);
    const row = readStanding(fs.readFileSync(path.join(dir, 'qa', 'standing.md'), 'utf8'))[0];
    assert.equal(row.lastSeen, '2026-11-06 feat-x');
    assert.equal(row.firstSeen, '2026-11-01 pr-0');
  });
});
