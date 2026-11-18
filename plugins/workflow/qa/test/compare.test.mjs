// compareViewport and compare on hand-made capture records: the verdicts and exit codes the skill relies on.
// Profile is plain (no environments); records follow the
// record shape in scripts/lib/capture.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compare, compareViewport, readSide } from '../scripts/lib/compare.mjs';
import { encodePng } from '../scripts/lib/png.mjs';

const palette = { green: '#4DA938', blue: '#337CDB', grey: '#808080' };
const profile = { palette, ignoreErrors: [] };
const GREY = { background: 'rgb(128, 128, 128)', color: 'rgb(255, 255, 255)', border: '1px solid rgb(128, 128, 128)' };
const BLUE = { background: 'rgb(51, 124, 219)', color: 'rgb(255, 255, 255)', border: '1px solid rgb(51, 124, 219)' };
const GREEN = { background: 'rgb(77, 169, 56)', color: 'rgb(255, 255, 255)', border: '1px solid rgb(77, 169, 56)' };

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const el = (text, style, context = 'Report Status') => ({ text, context, style, shot: 'x.png', className: '' });

// Writes <dir>/<viewport>/<screen>__<state>.json in the capture record shape.
function writeRecord(dir, viewport, screen, state, elements, errors = []) {
  const vp = path.join(dir, viewport);
  fs.mkdirSync(vp, { recursive: true });
  const rec = {
    screen,
    capture: state,
    url: `http://x/${screen}`,
    takenAt: '2026-11-06T00:00:00.000Z',
    viewport,
    role: null,
    watch: '.tag',
    elements,
    overflow: [],
    writes: [],
    errors,
    ignoredErrors: [],
    overrides: [],
  };
  fs.writeFileSync(path.join(vp, `${screen}__${state}.json`), JSON.stringify(rec));
}

// One run's captures under a fresh directory; each entry is { viewport, screen, state, elements, errors }.
function side(records) {
  const dir = tmp('mfqa-side-');
  for (const r of records) writeRecord(dir, r.viewport ?? 'desktop', r.screen ?? 'summary', r.state ?? 'list', r.elements, r.errors ?? []);
  return dir;
}

// The one-viewport helper: before and after as readSide() results, the way compare() builds them.
function viewportRun({ before, after, expectations = [], profile: p = profile, beforeErrors = [], afterErrors = [] }) {
  return compareViewport({
    before: readSide(side([{ elements: before, errors: beforeErrors }]), 'desktop'),
    after: readSide(side([{ elements: after, errors: afterErrors }]), 'desktop'),
    viewport: 'desktop',
    expectations,
    profile: p,
  });
}

test('a text that is a role-less span\'s whole text: a new element carrying it is met, and one on both sides is already true before', () => {
  const badge = (context) => el('SALE', GREY, context);
  const fresh = viewportRun({ before: [], after: [badge('Yo-yo $3.50')], expectations: [{ name: 'sale-badge-text', screens: 'summary*', text: 'SALE' }] });
  assert.equal(fresh.expectations[0].result, 'met');
  assert.equal(fresh.exit, 0);
  const old = viewportRun({ before: [badge('Yo-yo')], after: [badge('Yo-yo')], expectations: [{ name: 'sale-badge-text', screens: 'summary*', text: 'SALE' }] });
  assert.equal(old.expectations[0].result, 'already true before');
  const none = viewportRun({ before: [], after: [], expectations: [{ name: 'sale-badge-text', screens: 'summary*', text: 'SALE' }] });
  assert.equal(none.expectations[0].result, 'not observed');
});

test('nothing changed and nothing expected: proof (exit 0)', () => {
  const r = viewportRun({ before: [el('Verified', GREEN)], after: [el('Verified', GREEN)] });
  assert.equal(r.exit, 0);
  assert.equal(r.unexpected.length, 0);
});

test('the expected colour change: met (exit 0)', () => {
  const r = viewportRun({
    before: [el('Pending Verification', GREY)],
    after: [el('Pending Verification', BLUE)],
    expectations: [{ name: 'pending turns blue', screens: 'summary', text: 'Pending Verification', context: 'Report Status', after: 'blue' }],
  });
  assert.equal(r.expectations[0].result, 'met');
  assert.equal(r.exit, 0);
});

test('a change no expectation covers: UNEXPECTED (exit 1)', () => {
  const r = viewportRun({ before: [el('Pending Verification', GREY)], after: [el('Pending Verification', BLUE)] });
  assert.equal(r.exit, 1);
  assert.equal(r.unexpected.length, 1);
  assert.equal(r.unexpected[0].key, 'summary__list');
});

test('wrong colour: NOT MET (exit 1)', () => {
  const r = viewportRun({
    before: [el('Pending Verification', GREY)],
    after: [el('Pending Verification', GREEN)],
    expectations: [{ screens: 'summary', text: 'Pending Verification', after: 'blue' }],
  });
  assert.equal(r.expectations[0].result, 'NOT MET');
  assert.equal(r.exit, 1);
});

test('already so before: proves nothing (exit 2)', () => {
  const r = viewportRun({
    before: [el('Verified', GREEN)],
    after: [el('Verified', GREEN)],
    expectations: [{ screens: 'summary', text: 'Verified', after: 'green' }],
  });
  assert.equal(r.expectations[0].result, 'already true before');
  assert.equal(r.exit, 2);
});

test('keep: an invariant already true before and still true is met (exit 0)', () => {
  const r = viewportRun({
    before: [el('Verified', GREEN)],
    after: [el('Verified', GREEN)],
    expectations: [{ screens: 'summary', text: 'Verified', after: 'green', keep: true }],
  });
  assert.equal(r.expectations[0].result, 'met');
  assert.equal(r.exit, 0);
});

test('keep: an invariant broken on head is NOT MET', () => {
  const r = viewportRun({
    before: [el('Verified', GREEN)],
    after: [el('Verified', GREY)],
    expectations: [{ screens: 'summary', text: 'Verified', after: 'green', keep: true }],
  });
  assert.equal(r.expectations[0].result, 'NOT MET');
});

test('a rename: old text gone, new text present', () => {
  const r = viewportRun({
    before: [el('Status', GREY, 'column header')],
    after: [el('Report Status', GREY, 'column header')],
    expectations: [{ screens: 'summary', before: 'Status', text: 'Report Status', context: 'column header' }],
  });
  assert.equal(r.expectations[0].result, 'met');
  assert.equal(r.exit, 0);
});

test('no element matches the expectation: not observed (exit 2)', () => {
  const r = viewportRun({
    before: [el('Verified', GREEN)],
    after: [el('Verified', GREEN)],
    expectations: [{ screens: 'summary', text: 'Rejected', after: 'blue' }],
  });
  assert.equal(r.expectations[0].result, 'not observed');
  assert.equal(r.exit, 2);
});

test('an API 403 in a capture makes it inconclusive (exit 2)', () => {
  const r = viewportRun({
    before: [el('Verified', GREEN)],
    after: [el('Verified', GREEN)],
    afterErrors: ['HTTP 403 GET /v1/org/cml/abc'],
  });
  assert.equal(r.exit, 2);
  assert.ok(r.inconclusive.some((x) => x.key === 'summary__list'), JSON.stringify(r.inconclusive));
});

test('profile.ignoreErrors drops a matching error line before it counts', () => {
  const run = (ignoreErrors) => viewportRun({
    before: [el('Verified', GREEN)],
    after: [el('Verified', GREEN)],
    afterErrors: ['HTTP 500 GET /favicon.ico'],
    profile: { palette, ignoreErrors },
  });
  const counted = run([]);
  assert.equal(counted.exit, 2, 'without the ignore the 500 makes the capture inconclusive');
  const dropped = run(['^HTTP 500 GET /favicon']);
  assert.equal(dropped.exit, 0);
  assert.equal(dropped.inconclusive.length, 0);
});

test('a FAILED record on one side makes its key inconclusive (exit 2)', () => {
  const before = side([{ screen: 'home', state: 'start', elements: [el('Open', GREEN, 'nav')] }]);
  const afterDir = tmp('mfqa-failed-');
  fs.mkdirSync(path.join(afterDir, 'desktop'), { recursive: true });
  fs.writeFileSync(
    path.join(afterDir, 'desktop', 'home__FAILED.json'),
    JSON.stringify({ screen: 'home', step: { click: '#missing' }, error: 'waiting for locator("#missing")', url: 'http://x/' }),
  );
  const after = readSide(afterDir, 'desktop');
  assert.ok(after.failed.home, 'readSide keeps the FAILED record under its screen name');
  const r = compareViewport({ before: readSide(before, 'desktop'), after, viewport: 'desktop', expectations: [], profile });
  assert.equal(r.exit, 2);
  assert.ok(r.inconclusive.some((x) => x.key.startsWith('home')), JSON.stringify(r.inconclusive));
});

test('a key present only after is a pair with status new', () => {
  const r = compareViewport({
    before: readSide(side([{ elements: [el('Verified', GREEN)] }]), 'desktop'),
    after: readSide(side([
      { elements: [el('Verified', GREEN)] },
      { screen: 'home', state: 'start', elements: [el('Open', GREEN, 'nav')] },
    ]), 'desktop'),
    viewport: 'desktop',
    expectations: [],
    profile,
  });
  const pair = r.pairs.find((p) => p.key === 'home__start');
  assert.ok(pair, JSON.stringify(r.pairs));
  assert.equal(pair.status, 'new');
});

test('compare() writes summary.md, index.html and results.json and returns the worst exit across viewports', async () => {
  const beforeDir = tmp('mfqa-cmp-before-');
  const afterDir = tmp('mfqa-cmp-after-');
  writeRecord(beforeDir, 'desktop', 'summary', 'list', [el('Pending Verification', GREY)]);
  writeRecord(afterDir, 'desktop', 'summary', 'list', [el('Pending Verification', GREY)]);
  writeRecord(beforeDir, 'mobile', 'summary', 'list', [el('Pending Verification', GREY)]);
  writeRecord(afterDir, 'mobile', 'summary', 'list', [el('Pending Verification', BLUE)]);
  const out = tmp('mfqa-cmp-out-');

  const result = await compare({ beforeDir, afterDir, expect: null, out, profile });

  assert.equal(result.exit, 1);
  const byViewport = Object.fromEntries(result.viewports.map((v) => [v.viewport, v.exit]));
  assert.deepEqual(byViewport, { desktop: 0, mobile: 1 });
  for (const f of ['summary.md', 'index.html', 'results.json']) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} written to out`);
  }
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /summary__list/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).exit, 1);
});

test('an emptied viewport folder is not a captured viewport', async () => {
  const beforeDir = tmp('mfqa-empty-before-');
  const afterDir = tmp('mfqa-empty-after-');
  for (const dir of [beforeDir, afterDir]) {
    writeRecord(dir, 'desktop', 'summary', 'list', [el('Verified', GREEN)]);
    fs.mkdirSync(path.join(dir, 'mobile'), { recursive: true });
  }
  assert.deepEqual(readSide(beforeDir, 'mobile').records, {}, 'an empty viewport folder has no records');

  const out = tmp('mfqa-empty-out-');
  const result = await compare({ beforeDir, afterDir, expect: null, out, profile });

  assert.deepEqual(result.viewports.map((v) => v.viewport), ['desktop']);
  assert.equal(result.exit, 0);
});

// ---- step 3: trees, pixels, checks, tour, console -----------------------------------------------------------------

const solid = (r, g, b) => {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) data.set([r, g, b, 255], i * 4);
  return encodePng({ width: 64, height: 64, data });
};
const GREY_PNG = solid(128, 128, 128);
const BLUE_PNG = solid(51, 124, 219);

const tree = (...lines) => ['- heading "Jobs" [level=1]', ...lines].join('\n');
const CLIP = 'menu "Actions" runs past the right of the screen';
const CONSOLE = 'Uncaught TypeError: x is not a function';
const TARGET_20 = { check: 'target', detail: 'button "Add" is 20×20 px, under the 24 px minimum' };
const TARGET_22 = { check: 'target', detail: 'button "Add" is 22×20 px, under the 24 px minimum' };
const tourOf = (clipped = []) => ({
  opened: [{ control: 'button "Actions"', shot: 'summary__tour-0.png', popup: 'menu "Actions" 120×80', clipped, covered: [], stuck: false }],
  failed: [],
  hover: [],
  skipped: 0,
});

// A step-3 capture by default; override any field. A null tree or png, or an undefined checks or tour, is left out
// of the written files, the way a step-2 capture has no such files.
const STEP3 = {
  screen: 'summary',
  state: 'list',
  viewport: 'desktop',
  elements: [el('Verified', GREEN, 'nav')],
  tree: tree('- text: Verified', '- button "Add"'),
  png: GREY_PNG,
  checks: [],
  tour: null,
  errors: [],
};

// Writes <dir>/<viewport>/<key>.json, <key>.aria.yml, <key>.png and the tour shots, as capture.mjs does.
function writeRun(dir, over = {}) {
  const o = { ...STEP3, ...over };
  const vp = path.join(dir, o.viewport);
  fs.mkdirSync(vp, { recursive: true });
  const key = `${o.screen}__${o.state}`;
  const rec = {
    screen: o.screen,
    capture: o.state,
    url: `http://x/${o.screen}`,
    takenAt: '2026-11-06T00:00:00.000Z',
    viewport: o.viewport,
    role: null,
    watch: '.tag',
    elements: o.elements,
    overflow: [],
    writes: [],
    errors: o.errors,
    ignoredErrors: [],
    overrides: [],
  };
  if (o.tree) {
    rec.tree = `${key}.aria.yml`;
    fs.writeFileSync(path.join(vp, rec.tree), o.tree);
  }
  if (o.png) fs.writeFileSync(path.join(vp, `${key}.png`), o.png);
  if (o.checks !== undefined) rec.checks = o.checks;
  if (o.tour !== undefined) rec.tour = o.tour;
  for (const entry of o.tour?.opened ?? []) if (entry.shot) fs.writeFileSync(path.join(vp, entry.shot), GREY_PNG);
  fs.writeFileSync(path.join(vp, `${key}.json`), JSON.stringify(rec));
  return dir;
}

// before and after: arrays of writeRun() overrides. Returns compare()'s exit, its desktop viewport result and summary.md.
async function runCompare({ before, after, expect = [], profile: p = profile }) {
  const beforeDir = tmp('mfqa-s3-before-');
  const afterDir = tmp('mfqa-s3-after-');
  for (const o of before) writeRun(beforeDir, o);
  for (const o of after) writeRun(afterDir, o);
  const out = tmp('mfqa-s3-out-');
  const result = await compare({ beforeDir, afterDir, expect, out, profile: p });
  return { exit: result.exit, r: result.viewports[0], md: fs.readFileSync(path.join(out, 'summary.md'), 'utf8') };
}
const pairOf = (r, key = 'summary__list') => r.pairs.find((p) => p.key === key);

test('readSide returns the tree text and the png path for each key that has them', () => {
  const dir = tmp('mfqa-s3-side-');
  writeRun(dir, {});
  writeRun(dir, { screen: 'bare', tree: null, png: null, checks: undefined, tour: undefined });
  const side = readSide(dir, 'desktop');

  assert.equal(side.trees['summary__list'], STEP3.tree);
  const png = side.pngs['summary__list'];
  assert.ok(path.isAbsolute(png) && fs.existsSync(png), JSON.stringify(side.pngs));
  assert.ok(!('bare__list' in side.trees), JSON.stringify(side.trees));
  assert.ok(!('bare__list' in side.pngs), JSON.stringify(side.pngs));
});

test('identical trees, pngs, checks, tour and errors on both sides: exit 0, tree same, no pixel change, no eyes', async () => {
  const same = { checks: [TARGET_20], tour: tourOf([CLIP]), errors: [CONSOLE] };
  const { exit, r } = await runCompare({ before: [same], after: [same] });

  assert.equal(exit, 0, JSON.stringify(r.unexpected));
  assert.equal(pairOf(r).tree.same, true);
  assert.equal(pairOf(r).pixel.changed, false);
  assert.deepEqual(r.eyes, []);
});

test('an added tree line no expectation explains: exit 1, unexpected names it, the pair is changed, summary says +1 -0', async () => {
  const { exit, r, md } = await runCompare({
    before: [{}],
    after: [{ tree: `${STEP3.tree}\n- button "Add job"` }],
  });

  assert.equal(exit, 1);
  const u = r.unexpected.find((x) => x.kind === 'tree');
  assert.ok(u, JSON.stringify(r.unexpected));
  assert.equal(u.key, 'summary__list');
  assert.deepEqual(u.added, ['- button "Add job"']);
  assert.deepEqual(u.removed, []);
  assert.equal(pairOf(r).status, 'changed');
  assert.ok(md.includes('summary__list tree: +1 -0'), md);
});

test('an added tree line an expectation names is met: nothing unexpected, exit 0', async () => {
  const { exit, r } = await runCompare({
    before: [{}],
    after: [{ tree: `${STEP3.tree}\n- button "Add job"` }],
    expect: [{ name: 'job button', screens: '*', text: 'Add job' }],
  });

  assert.equal(r.expectations[0].result, 'met', JSON.stringify(r.expectations));
  assert.equal(r.unexpected.length, 0, JSON.stringify(r.unexpected));
  assert.equal(exit, 0);
});

test('a rename the expectation gives before: met, and no tree line is unexpected', async () => {
  const { exit, r } = await runCompare({
    before: [{ tree: tree('- text: Verified', '- button "Add"') }],
    after: [{ tree: tree('- text: Verified', '- button "Add job"') }],
    expect: [{ name: 'rename', screens: '*', text: 'Add job', before: 'Add' }],
  });

  assert.equal(r.expectations[0].result, 'met', JSON.stringify(r.expectations));
  assert.equal(r.unexpected.filter((u) => u.kind === 'tree').length, 0, JSON.stringify(r.unexpected));
  assert.equal(exit, 0);
});

test('an absent expectation is met when the line is gone and NOT MET while it is still there', async () => {
  const before = { tree: tree('- text: Verified', '- button "Old"') };
  const expect = [{ name: 'old gone', screens: '*', text: 'Old', after: 'absent' }];

  const gone = await runCompare({ before: [before], after: [{ tree: tree('- text: Verified') }], expect });
  assert.equal(gone.r.expectations[0].result, 'met', JSON.stringify(gone.r.expectations));
  assert.equal(gone.exit, 0, JSON.stringify(gone.r.unexpected));

  const still = await runCompare({ before: [before], after: [before], expect });
  assert.equal(still.r.expectations[0].result, 'NOT MET', JSON.stringify(still.r.expectations));
  assert.equal(still.exit, 1);
});

test('a pixel-only change: exit 0, pixel changed, the key in eyes, summary says send to eyes', async () => {
  const { exit, r, md } = await runCompare({ before: [{ png: GREY_PNG }], after: [{ png: BLUE_PNG }] });

  assert.equal(exit, 0, JSON.stringify(r.unexpected));
  assert.equal(pairOf(r).pixel.changed, true);
  assert.ok(r.eyes.includes('summary__list'), JSON.stringify(r.eyes));
  assert.ok(md.includes('send to eyes'), md);
});

test('a check finding the before lacks is new: exit 1 and checks.new has it', async () => {
  const { exit, r } = await runCompare({ before: [{ checks: [] }], after: [{ checks: [TARGET_20] }] });

  assert.equal(exit, 1);
  assert.ok(pairOf(r).checks.new.some((f) => f.check === TARGET_20.check && f.detail === TARGET_20.detail), JSON.stringify(pairOf(r).checks));
});

test('the same check finding with a different size is standing: exit 0', async () => {
  const { exit, r } = await runCompare({ before: [{ checks: [TARGET_20] }], after: [{ checks: [TARGET_22] }] });

  assert.equal(exit, 0, JSON.stringify(r.unexpected));
  assert.equal(pairOf(r).checks.new.length, 0, JSON.stringify(pairOf(r).checks));
  assert.equal(pairOf(r).checks.standing.length, 1, JSON.stringify(pairOf(r).checks));
});

test('a new clipped tour line is a new tour problem: exit 1 and tour.new has it', async () => {
  const { exit, r } = await runCompare({ before: [{ tour: tourOf([]) }], after: [{ tour: tourOf([CLIP]) }] });

  assert.equal(exit, 1);
  assert.equal(pairOf(r).tour.new.length, 1, JSON.stringify(pairOf(r).tour));
  assert.match(JSON.stringify(pairOf(r).tour.new), /runs past the right/);
});

test('the same clipped tour line on both sides is standing: exit 0', async () => {
  const { exit, r } = await runCompare({ before: [{ tour: tourOf([CLIP]) }], after: [{ tour: tourOf([CLIP]) }] });

  assert.equal(exit, 0, JSON.stringify(r.unexpected));
  assert.equal(pairOf(r).tour.standing.length, 1, JSON.stringify(pairOf(r).tour));
});

test('a new non-HTTP error line is a new console line: exit 1 and console.new has it', async () => {
  const { exit, r } = await runCompare({ before: [{ errors: [] }], after: [{ errors: [CONSOLE] }] });

  assert.equal(exit, 1);
  assert.equal(pairOf(r).console.new.length, 1, JSON.stringify(pairOf(r).console));
  assert.match(JSON.stringify(pairOf(r).console.new), /x is not a function/);
});

test('the same console line on both sides is standing: exit 0', async () => {
  const { exit, r } = await runCompare({ before: [{ errors: [CONSOLE] }], after: [{ errors: [CONSOLE] }] });

  assert.equal(exit, 0, JSON.stringify(r.unexpected));
  assert.equal(pairOf(r).console.new.length, 0, JSON.stringify(pairOf(r).console));
  assert.equal(pairOf(r).console.standing.length, 1, JSON.stringify(pairOf(r).console));
});

test('an HTTP 404 line is not a console line: console.new stays empty and the exit is 0', async () => {
  const { exit, r } = await runCompare({ before: [{ errors: [] }], after: [{ errors: ['HTTP 404 GET /x'] }] });

  assert.equal(pairOf(r).console.new.length, 0, JSON.stringify(pairOf(r).console));
  assert.equal(exit, 0, JSON.stringify(r.unexpected));
});

test('records from before step 3 give null for the five pair fields, and the exit is decided as before', async () => {
  const step2 = { tree: null, png: null, checks: undefined, tour: undefined, errors: [] };
  const same = await runCompare({ before: [step2], after: [step2] });

  assert.equal(same.exit, 0, JSON.stringify(same.r.unexpected));
  for (const field of ['tree', 'pixel', 'checks', 'tour', 'console']) {
    assert.equal(pairOf(same.r)[field], null, `${field}: ${JSON.stringify(pairOf(same.r)[field])}`);
  }

  const changed = await runCompare({
    before: [{ ...step2, elements: [el('Pending', GREY)] }],
    after: [{ ...step2, elements: [el('Pending', BLUE)] }],
  });
  assert.equal(changed.exit, 1, JSON.stringify(changed.r.unexpected));
});

test('result.standing counts the standing checks, tour problems and console lines', async () => {
  const shared = { checks: [TARGET_20], tour: tourOf([CLIP]), errors: [CONSOLE] };
  const { exit, r } = await runCompare({ before: [shared], after: [shared] });

  assert.equal(exit, 0, JSON.stringify(r.unexpected));
  assert.deepEqual(r.standing, { checks: 1, tour: 1, console: 1 }, `standing: ${JSON.stringify(r.standing)}`);
});

// ---- step 3: volatile text ----------------------------------------------------------------------------------------

test('a volatile pattern masks a changed clock stamp in both trees: the trees read the same, one after-line masked, exit 0', async () => {
  const volatile = { ...profile, volatile: ['\\d{1,2}:\\d{2} [ap]m'] };
  const { exit, r } = await runCompare({
    before: [{ tree: tree('- text: Updated 06 Nov, 12:40 pm') }],
    after: [{ tree: tree('- text: Updated 06 Nov, 12:53 pm') }],
    profile: volatile,
  });

  assert.equal(exit, 0, JSON.stringify(r.unexpected));
  assert.equal(pairOf(r).tree.same, true);
  assert.equal(pairOf(r).tree.masked, 1, JSON.stringify(pairOf(r).tree));
});

test('the same two clock stamps with no volatile pattern: the tree changed and the exit is 1', async () => {
  const { exit, r } = await runCompare({
    before: [{ tree: tree('- text: Updated 06 Nov, 12:40 pm') }],
    after: [{ tree: tree('- text: Updated 06 Nov, 12:53 pm') }],
  });

  assert.equal(exit, 1, JSON.stringify(r.unexpected));
  assert.equal(pairOf(r).tree.same, false);
});

// ---- step 6: metrics, and expectations that are not compare's ----------------------------------------------------

const metricsOf = (over = {}) => ({ readyMs: 500, bytes: 400_000, requests: 5, longTaskMs: 10, heapBytes: 5_000_000, server: null, ...over });

// One capture per side, as step-3 records; `metrics` is written into each record (undefined leaves the key out).
async function runMetrics({ before, after, expect = [], profile: p = profile }) {
  const beforeDir = writeRun(tmp('mfqa-s6-before-'));
  const afterDir = writeRun(tmp('mfqa-s6-after-'));
  for (const [dir, metrics] of [[beforeDir, before], [afterDir, after]]) {
    const file = path.join(dir, 'desktop', 'summary__list.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (metrics !== undefined) rec.metrics = metrics;
    fs.writeFileSync(file, JSON.stringify(rec));
  }
  const out = tmp('mfqa-s6-out-');
  const result = await compare({ beforeDir, afterDir, expect, out, profile: p });
  return { exit: result.exit, r: result.viewports[0], md: fs.readFileSync(path.join(out, 'summary.md'), 'utf8') };
}

test('step 6: a pair over the human limit carries the flag, and the status and exit are untouched', async () => {
  const { exit, r } = await runMetrics({ before: metricsOf({ readyMs: 900 }), after: metricsOf({ readyMs: 1800 }) });

  assert.deepEqual(pairOf(r).metrics, {
    flags: [{ metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 }],
    standing: 0,
  });
  assert.equal(pairOf(r).status, 'same');
  assert.equal(exit, 0);
  assert.equal(r.metricsStanding, 0);
});

test('step 6: summary.md lists a pair\'s metric flags as "<key> metrics: <n> flag(s)" then one line per flag', async () => {
  const { md } = await runMetrics({ before: metricsOf({ readyMs: 900 }), after: metricsOf({ readyMs: 1800 }) });

  assert.ok(md.includes('- summary__list metrics: 1 flag(s)\n  screen.readyMs 1800 ms over 1000 ms (base 900 ms)'), md);
});

test('step 6: a pair with nothing to flag has no metrics lines', async () => {
  const { md, r } = await runMetrics({ before: metricsOf(), after: metricsOf() });

  assert.deepEqual(pairOf(r).metrics, { flags: [], standing: 0 });
  assert.ok(!md.includes('metrics:'), md);
});

test('step 6: profile.limits moves the line, and standing judgements add up in metricsStanding', async () => {
  const before = metricsOf({ readyMs: 1500 });
  const after = metricsOf({ readyMs: 1800 });

  const standing = await runMetrics({ before, after });
  assert.deepEqual(pairOf(standing.r).metrics, { flags: [], standing: 1 });
  assert.equal(standing.r.metricsStanding, 1);

  const raised = await runMetrics({ before, after, profile: { ...profile, limits: { 'screen.readyMs': 2000 } } });
  assert.deepEqual(pairOf(raised.r).metrics, { flags: [], standing: 0 });
  assert.equal(raised.r.metricsStanding, 0);
});

test('step 6: a record without metrics on either side gives pair.metrics null, and so does a new pair whose record has none', async () => {
  const old = await runMetrics({ before: undefined, after: metricsOf({ readyMs: 1800 }) });
  assert.equal(pairOf(old.r).metrics, null);
  assert.equal(old.r.metricsStanding, 0);
  assert.equal(old.exit, 0);

  const beforeDir = tmp('mfqa-s6-empty-before-');
  fs.mkdirSync(path.join(beforeDir, 'desktop'), { recursive: true });
  const afterDir = writeRun(tmp('mfqa-s6-new-after-'));
  const viewportResult = compareViewport({ before: readSide(beforeDir, 'desktop'), after: readSide(afterDir, 'desktop'), viewport: 'desktop', profile });
  assert.equal(viewportResult.pairs[0].status, 'new');
  assert.equal(viewportResult.pairs[0].metrics, null);
});

test("step 6: a route, db or mail expectation is 'n/a' and does not touch the pairs, the tree or the exit", async () => {
  const expect = [
    { name: 'notes-denied-to-viewer', route: 'POST /api/notes', as: 'viewer', status: 403 },
    { name: 'row-kept', db: 'select 1' },
    { name: 'mail-sent', mail: 'welcome' },
  ];
  const plain = await runCompare({ before: [{}], after: [{}] });
  const { exit, r } = await runCompare({ before: [{}], after: [{}], expect });

  assert.deepEqual(r.expectations.map((e) => [e.name, e.result]), expect.map((e) => [e.name, 'n/a']));
  assert.equal(exit, plain.exit);
  assert.equal(exit, 0);
  assert.deepEqual(r.unexpected, []);
  assert.deepEqual(pairOf(r).tree, pairOf(plain.r).tree);
  assert.deepEqual(r.inconclusive, []);
});
