// NEW ON HEAD: a screen the PR makes reachable for the first time has no before picture. It is judged on head
// alone (checks, tour, console, metrics against limits, expectations from head's tree), never a base gap, so a PR
// that first opens a screen can be accepted. A screen that fails on base and on head stays a gap.
// Contracts: compare.mjs, affected.mjs newMapEntries, run.mjs, summary.mjs, verdict.mjs and eyes.mjs, each 'NEW ON HEAD'.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { newMapEntries } from '../scripts/lib/affected.mjs';
import { compare, compareViewport, readSide } from '../scripts/lib/compare.mjs';
import { eyesTargets } from '../scripts/lib/eyes.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { buildResults, summaryMd } from '../scripts/lib/summary.mjs';
import { draftVerdict } from '../scripts/lib/verdict.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};

const profile = { palette: {}, ignoreErrors: [] };
const GREEN = { background: 'rgb(77, 169, 56)', color: 'rgb(255, 255, 255)', border: '1px solid rgb(77, 169, 56)' };
const el = (text, context = 'main') => ({ text, context, style: GREEN, shot: 'x.png', className: '' });
const tree = (...lines) => ['- heading "Systems" [level=1]', ...lines].join('\n');

// A step-3 capture record (tree, checks, tour) as capture.mjs writes it; override any field.
function writeRecord(dir, over = {}) {
  const o = { screen: 'systems', state: 'list', viewport: 'desktop', elements: [], tree: tree('- text: Health'), checks: [], tour: null, errors: [], ...over };
  const vp = path.join(dir, o.viewport);
  fs.mkdirSync(vp, { recursive: true });
  const key = `${o.screen}__${o.state}`;
  const rec = {
    screen: o.screen, capture: o.state, url: `http://x/${o.screen}`, takenAt: '2026-11-10T00:00:00.000Z', viewport: o.viewport,
    role: null, watch: '.tag', elements: o.elements, overflow: [], writes: [], errors: o.errors, ignoredErrors: [], overrides: [],
  };
  if (o.tree !== null) {
    rec.tree = `${key}.aria.yml`;
    fs.writeFileSync(path.join(vp, rec.tree), o.tree);
  }
  if (o.checks !== undefined) rec.checks = o.checks;
  if (o.tour !== undefined) rec.tour = o.tour;
  if (o.metrics !== undefined) rec.metrics = o.metrics;
  fs.writeFileSync(path.join(vp, `${key}.json`), JSON.stringify(rec));
  return dir;
}

// A walk that failed, as capture.mjs leaves it: <screen>__FAILED.json and nothing else for that screen.
function writeFailed(dir, screen, viewport = 'desktop') {
  const vp = path.join(dir, viewport);
  fs.mkdirSync(vp, { recursive: true });
  fs.writeFileSync(path.join(vp, `${screen}__FAILED.json`), JSON.stringify({ screen, step: { waitFor: 'role=heading' }, error: 'locator.waitFor: Timeout 20000ms exceeded.' }));
  return dir;
}

// An old screen both sides have, unchanged.
const OLD = { screen: 'home', state: 'default', tree: '- heading "Home" [level=1]' };

// base: the old screen, and a FAILED walk of `systems` (the base cannot reach it); head: both captured.
function sides({ head = {}, baseExtra = (dir) => dir, headExtra = (dir) => dir } = {}) {
  const beforeDir = baseExtra(writeFailed(writeRecord(tmp('mfqa-noh-before-'), OLD), 'systems'));
  const afterDir = headExtra(writeRecord(writeRecord(tmp('mfqa-noh-after-'), OLD), head));
  return { beforeDir, afterDir };
}
const viewportOf = ({ beforeDir, afterDir }, expectations = [], newScreens = {}) =>
  compareViewport({ before: readSide(beforeDir, 'desktop'), after: readSide(afterDir, 'desktop'), viewport: 'desktop', expectations, profile, newScreens });
const pairOf = (r, key = 'systems__list') => r.pairs.find((p) => p.key === key);

// ---- compareViewport ----------------------------------------------------------------------------------------------

test('a screen base cannot reach and head can is new on head: no inconclusive, its expectation met from head, exit 0', () => {
  const r = viewportOf(sides({ head: { tree: tree('- text: Health', '- text: Decided by the verb check') } }), [
    { name: 'health-column', screens: 'systems', text: 'Health' },
    { name: 'add-gone', screens: 'systems', text: 'Add system', after: 'absent' },
  ]);
  const p = pairOf(r);
  assert.equal(p.status, 'new');
  assert.equal(p.newOnHead, 'base could not reach it');
  assert.deepEqual(r.fresh, { systems: 'base could not reach it' });
  assert.equal(pairOf(r, 'home__default').newOnHead, null, 'an old screen is not new');
  assert.deepEqual(r.inconclusive, [], 'the base failure is why there is no before picture, not a doubt');
  assert.deepEqual(r.expectations.map((e) => [e.name, e.result]), [['health-column', 'met'], ['add-gone', 'met']]);
  assert.equal(r.expectations[0].detail, 'new on head: 1 right, 0 wrong colour');
  assert.equal(r.expectations[1].detail, 'new on head: 1 without it, 0 showing it');
  assert.equal(r.exit, 0);
  assert.ok(r.eyes.includes('systems__list'), 'a new screen still goes to eyes');
});

test('an expected text missing from a new screen is NOT MET, not "not observed"', () => {
  const r = viewportOf(sides(), [{ name: 'verb', screens: 'systems', text: 'Decided by the verb check' }]);
  assert.equal(r.expectations[0].result, 'NOT MET');
  assert.equal(r.expectations[0].detail, 'new on head: "Decided by the verb check" is not on it');
  assert.equal(r.exit, 1);
});

test('absent on a new screen: a head tree line or a head element with the text is NOT MET', () => {
  const byTree = viewportOf(sides({ head: { tree: tree('- button "Add system"') } }), [{ name: 'add-gone', screens: 'systems', text: 'Add system', after: 'absent' }]);
  assert.equal(byTree.expectations[0].result, 'NOT MET');
  assert.equal(byTree.expectations[0].detail, 'new on head: 0 without it, 1 showing it');
  const byElement = viewportOf(sides({ head: { elements: [el('Add system')] } }), [{ name: 'add-gone', screens: 'systems', text: 'Add system', after: 'absent' }]);
  assert.equal(byElement.expectations[0].result, 'NOT MET');
  assert.equal(pairOf(byElement).elements[0].verdict, 'expected absent, STILL THERE');
});

test('a rename on a new screen: the old text still on head is NOT MET; the new text alone is met', () => {
  const ex = [{ name: 'renamed', screens: 'systems', text: 'Last success', before: 'Last OK' }];
  const stale = viewportOf(sides({ head: { tree: tree('- text: Last OK', '- text: Last success') } }), ex);
  assert.equal(stale.expectations[0].result, 'NOT MET');
  const done = viewportOf(sides({ head: { tree: tree('- text: Last success') } }), ex);
  assert.equal(done.expectations[0].result, 'met');
});

test('a glob over old and new screens: the usual counts first, then the new-on-head ones', () => {
  const r = viewportOf(sides({ head: { tree: tree('- text: Health') } }), [{ name: 'health', screens: '*', text: 'Health' }]);
  assert.equal(r.expectations[0].result, 'met');
  assert.equal(r.expectations[0].detail, '0 element(s): 0 right, 0 wrong colour, 0 already so before; new on head: 1 right, 0 wrong colour');
});

test("a new screen's checks, tour problems and console lines are all new, and its metrics meet the human limits", () => {
  const tour = { opened: [{ control: 'button "More"', clipped: ['menu "More" runs past the right of the screen'], covered: [], stuck: false }], failed: [], hover: [{ changed: false }] };
  const r = viewportOf(sides({ head: {
    checks: [{ check: 'contrast', detail: 'span.muted contrast 2.8:1' }], tour, errors: ['Uncaught TypeError: x', 'HTTP 404 GET /x'],
    metrics: { readyMs: 1800, bytes: 400_000, requests: 5, longTaskMs: 10, heapBytes: 5_000_000, server: null },
  } }));
  const p = pairOf(r);
  assert.deepEqual(p.checks, { new: [{ check: 'contrast', detail: 'span.muted contrast 2.8:1' }], standing: [], fixed: [] });
  assert.deepEqual(p.tour, { opened: 1, failed: 0, hover: 1, hoverSilent: 1, new: ['menu "More" runs past the right of the screen'], standing: [], fixed: [] });
  assert.deepEqual(p.console, { new: ['Uncaught TypeError: x'], standing: [] });
  assert.deepEqual(p.metrics, { flags: [{ metric: 'screen.readyMs', kind: 'over', head: 1800, base: null, limit: 1000 }], standing: 0 });
  assert.equal(p.tree, null);
  assert.equal(p.pixel, null);
  assert.equal(r.exit, 1, 'new findings on a new screen are findings');
});

test('a screen the runner lists as a new map entry sets any base record and base failure of it aside', () => {
  const s = sides({ head: { tree: tree('- text: Health') }, baseExtra: (dir) => writeRecord(dir, { screen: 'audit', state: 'list', tree: '- text: Health' }), headExtra: (dir) => writeRecord(dir, { screen: 'audit', state: 'list', tree: '- text: Health' }) });
  const r = viewportOf(s, [{ name: 'health', screens: 'audit', text: 'Health' }], { audit: 'map entry new', systems: 'map entry new' });
  assert.equal(pairOf(r, 'audit__list').status, 'new');
  assert.equal(pairOf(r, 'audit__list').before, null);
  assert.equal(pairOf(r, 'audit__list').newOnHead, 'map entry new');
  assert.equal(pairOf(r).newOnHead, 'map entry new');
  assert.equal(r.expectations[0].result, 'met', 'not "already true before": judged on head alone');
  assert.deepEqual(r.inconclusive, []);
});

test('a screen not listed that base captured keeps its before/after diff: a regression on it is still UNEXPECTED', () => {
  const s = sides({ baseExtra: (dir) => writeRecord(dir, { screen: 'audit', state: 'list', tree: '- text: Health' }), headExtra: (dir) => writeRecord(dir, { screen: 'audit', state: 'list', tree: '- text: Health\n- text: Broken banner' }) });
  const r = viewportOf(s, [], { systems: 'map entry new' });
  const audit = pairOf(r, 'audit__list');
  assert.equal(audit.status, 'changed');
  assert.equal(audit.newOnHead, null);
  assert.ok(audit.before, 'the base picture is kept');
  assert.deepEqual(r.unexpected.map((u) => [u.key, u.kind, u.added]), [['audit__list', 'tree', ['- text: Broken banner']]]);
  assert.equal(r.exit, 1);
});

test('a screen that fails on base and on head is not new: it stays inconclusive, as before', () => {
  const s = sides({ head: OLD, headExtra: (dir) => writeFailed(dir, 'systems') });
  const r = viewportOf(s, [{ name: 'health', screens: 'systems', text: 'Health' }]);
  assert.equal(r.fresh.systems, undefined);
  assert.ok(r.inconclusive.some((x) => x.key === 'systems__FAILED'), JSON.stringify(r.inconclusive));
  assert.equal(r.expectations[0].result, 'not observed', 'nothing on head to judge it from');
  assert.equal(r.exit, 2);
});

test('compare() summary.md names the pair new on head with its reason', async () => {
  const s = sides();
  const out = tmp('mfqa-noh-out-');
  await compare({ ...s, out, profile });
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /- systems__list: new on head \(base could not reach it\) — /);
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /new on head \(base could not reach it\)/);
});

test('compare() with every screen new on head and an empty base side judges them new on head, never throws (1.0.3)', async () => {
  const before = tmp('mfqa-noh-emptybase-');
  fs.mkdirSync(path.join(before, 'desktop'), { recursive: true });
  const afterDir = writeRecord(tmp('mfqa-noh-head-'), { screen: 'channels', state: 'page' });
  const out = tmp('mfqa-noh-out-');
  const r = await compare({ beforeDir: before, afterDir, out, profile, newScreens: { channels: 'map entry new' } });
  assert.deepEqual(r.viewports.map((v) => v.viewport), ['desktop']);
  assert.notEqual(r.exit, 1);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /channels__page: new on head \(map entry new\)/);
});

test('compare() with nothing captured on head still throws', async () => {
  const before = tmp('mfqa-noh-b-');
  const afterDir = tmp('mfqa-noh-h-');
  await assert.rejects(compare({ beforeDir: before, afterDir, out: tmp('mfqa-noh-o-'), profile }), /no viewport was captured under/);
});

// ---- results, summary, verdict draft ------------------------------------------------------------------------------

// A diff Run around a real compare of two capture dirs: base failed `failedOnBase` (and head `failedOnHead`).
async function runOf({ head = {}, expect = [], failedOnHead = [], headExtra = (dir) => dir, newEntries = {} } = {}) {
  const s = sides({ head, headExtra });
  const out = tmp('mfqa-noh-cmp-');
  const cmp = await compare({ ...s, expect, out, profile, newScreens: newEntries });
  const side = (failed) => ({ viewports: [{ viewport: 'desktop', captured: [], failed, notRun: [], warnings: [] }], ms: 1000 });
  const fail = (screen) => ({ screen, step: '{"waitFor":"role=heading"}', error: 'locator.waitFor: Timeout 20000ms exceeded.' });
  return {
    exit: cmp.exit, mode: 'diff', slug: 'py-systems', head: { ref: 'HEAD', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40), cached: false },
    maps: { head: 'c'.repeat(64), base: 'c'.repeat(64) }, sandboxes: { base: { name: 'qa-b', state: 'up', ms: 1 }, head: { name: 'qa-a', state: 'up', ms: 1 } },
    steps: [], warnings: [], blocked: null, standing: null, routes: null, routeExpectations: [], mutants: null, affected: null, videos: [], sourcesWritten: [],
    sides: { base: side([fail('systems')]), head: side(failedOnHead.map(fail)) }, compare: cmp, newEntries, report: path.join(out, 'index.html'),
  };
}

test('the draft: a screen new on head with its expectation met has no unverifiable criterion and no gap; ACCEPT once eyes is done', async () => {
  const run = await runOf({ head: { tree: tree('- text: Health') }, expect: [{ name: 'health-column', screens: 'systems', text: 'Health' }, { name: 'add-gone', screens: 'systems', text: 'Add system', after: 'absent' }] });
  const results = buildResults(run);
  const d = draftVerdict(results);
  assert.deepEqual(d.criteria, { pass: 2, fail: 0, unverifiable: 0, blocked: 0, waived: 0 });
  assert.deepEqual(d.gaps, []);
  assert.deepEqual(d.findings.map((f) => [f.severity, f.id, f.text]), [['eyes', 'scr:desktop/systems__list', 'new on head (base could not reach it) → eyes']]);
  assert.equal(d.verdict, 'PENDING', 'only the eyes row is left for the judge');
  assert.match(d.md, /^- new on head: 1 screen\(s\) have no before picture \(base could not reach it\); their checks, tour, console, metrics and expectations are judged on head alone$/m);
  assert.equal(draftVerdict({ ...results, eyes: [] }).verdict, 'ACCEPT', 'nothing else is wrong');

  const f = results.failures.find((x) => x.id === 'fail:base/desktop/systems');
  assert.equal(f.newOnHead, 'base could not reach it');
  const md = summaryMd(results);
  assert.match(md, /^- \[fail:base\/desktop\/systems\] new on head \(base could not reach it\), no before picture — \{"waitFor":"role=heading"\}: locator\.waitFor/m);
  assert.match(md, /^- \[scr:desktop\/systems__list\] new on head \(base could not reach it\) → eyes$/m);
});

test('the draft: an expectation whose text is on no element of a screen new on head observed 0 elements: BLOCKED, never NOT MET (1.0.0)', async () => {
  const results = buildResults(await runOf({ expect: [{ name: 'verb', screens: 'systems', text: 'Decided by the verb check' }] }));
  assert.equal(results.expectations[0].result, 'NOT MET');
  assert.equal(results.expectations[0].observed, 0);
  const d = draftVerdict(results);
  assert.deepEqual(d.criteria, { pass: 0, fail: 0, unverifiable: 0, blocked: 1, waived: 0 });
  assert.equal(d.verdict, 'PENDING', 'the eyes row is left; the outcome is BLOCKED once eyes is done');
  assert.equal(draftVerdict({ ...results, eyes: [] }).verdict, 'BLOCKED');
});

test('the draft: an old screen that fails on base and on head is still a gap, and its criterion unverifiable', async () => {
  const run = await runOf({ head: OLD, headExtra: (dir) => writeFailed(dir, 'systems'), failedOnHead: ['systems'], expect: [{ name: 'health', screens: 'systems', text: 'Health' }] });
  const results = buildResults(run);
  const d = draftVerdict(results);
  assert.equal(results.failures.find((x) => x.id === 'fail:head/desktop/systems').onBase, true);
  assert.equal(results.failures.find((x) => x.id === 'fail:base/desktop/systems').newOnHead, undefined);
  assert.deepEqual(d.gaps.map((g) => g.id), ['fail:head/desktop/systems']);
  assert.match(d.gaps[0].text, /^unverifiable, failed on base too — /);
  assert.deepEqual(d.criteria, { pass: 0, fail: 0, unverifiable: 0, blocked: 1, waived: 0 }, 'not observed: the screen was never walked');
  assert.equal(d.verdict, 'BLOCKED');
  assert.doesNotMatch(d.md, /new on head/);
});

test('the draft: a new map entry that times out on head is a BLOCKED item even if base left a failure of that name', async () => {
  const run = await runOf({ head: OLD, headExtra: (dir) => writeFailed(dir, 'systems'), failedOnHead: ['systems'], newEntries: { systems: 'map entry new' } });
  const d = draftVerdict(buildResults(run));
  assert.deepEqual(d.findings.filter((f) => f.severity === 'Blocker').map((f) => f.id), []);
  assert.deepEqual(d.blocked.map((b) => b.id), ['fail:head/desktop/systems']);
  assert.deepEqual(d.gaps.map((g) => g.id), ['fail:head/desktop/systems', 'gap:criteria'], 'no failed-on-base gap');
});

// ---- eyes and report shots ----------------------------------------------------------------------------------------

test('eyesTargets gives a new screen no before picture, even when base left a file of that name', () => {
  const results = { eyes: ['scr:desktop/systems__list'], screens: [{ id: 'scr:desktop/systems__list', viewport: 'desktop', key: 'systems__list', screen: 'systems', status: 'new', pixel: null, tree: null }] };
  const [t] = eyesTargets(results, { work: '/w', cacheDir: '/c', exists: () => true });
  assert.equal(t.before, null);
  assert.equal(t.after, path.join('/w', 'compare', 'media', 'desktop', 'after', 'systems__list.png'));
});

// ---- the map: newMapEntries ---------------------------------------------------------------------------------------

test('newMapEntries names only the head entries base lacks, never a changed one; none without a base map', () => {
  const base = { screens: [{ name: 'home', steps: [{ goto: '/' }] }, { name: 'audit', steps: [{ goto: '/audit' }] }], flows: {} };
  const head = { screens: [{ name: 'home', steps: [{ goto: '/' }], area: 'x', file: 'y' }, { name: 'audit', steps: [{ goto: '/audit/health' }] }, { name: 'systems', steps: [{ goto: '/systems' }] }], flows: {} };
  assert.deepEqual(newMapEntries(head, base), { systems: 'map entry new' });
  assert.deepEqual(newMapEntries(head, null), {});
  assert.deepEqual(newMapEntries(head, head), {});
});

// ---- the runner hands the map's new entries to compare ------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

test('runQa passes compare the screens whose map entry is new between base and head, not the changed ones', async () => {
  const dir = tmp('mfqa-noh-run-');
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  fs.mkdirSync(path.join(dir, 'qa', 'map'), { recursive: true });
  const writeMap = (screens) => fs.writeFileSync(path.join(dir, 'qa', 'map', 'app.json'), JSON.stringify({ screens }) + '\n');
  writeMap([{ name: 'home', steps: [{ goto: '/' }] }, { name: 'audit', steps: [{ goto: '/audit' }] }]);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  git(['checkout', '-q', '-b', 'feat/admin'], dir);
  writeMap([{ name: 'home', steps: [{ goto: '/' }] }, { name: 'audit', steps: [{ goto: '/audit/health' }] }, { name: 'systems', steps: [{ goto: '/systems' }] }]);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'head'], dir);

  const calls = [];
  const side = () => ({ viewports: [{ viewport: 'desktop', captured: [], failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: '' }, mapErrors: [], ms: 1 });
  const run = await runQa({
    mainRoot: dir, repoRoot: dir, log: () => {}, routes: false, mutants: 'none', cache: false,
    profile: { map: 'qa/map', seedNames: 'qa/seed.json', base: 'sandbox', viewports: { desktop: [1440, 900] }, checks: { enabled: true }, tour: { enabled: true } },
  }, {
    up: async (req) => ({ name: `qa-${req.at.slice(0, 10)}`, slug: 'x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null }),
    down: async () => ({ warnings: [] }),
    captureSide: async (req) => {
      fs.mkdirSync(path.join(req.out, 'desktop'), { recursive: true });
      return side();
    },
    compare: async (req) => {
      calls.push(req);
      return { exit: 0, viewports: [] };
    },
  });
  assert.deepEqual(calls[0].newScreens, { systems: 'map entry new' });
  assert.deepEqual(run.newEntries, { systems: 'map entry new' });
});
