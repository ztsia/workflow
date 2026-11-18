// tourKind, buildResults and summaryMd on the step 4 brief's example Run (test/fixtures/run-example.mjs).
// Each test builds its own fixture, so a change in one test never reaches another.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResults, summaryMd, tourKind } from '../scripts/lib/summary.mjs';
import { blockedRun, exampleRun, pairDetail, pairList, selfRun, sideResult } from './fixtures/run-example.mjs';
// Namespace import: the step 6 texts are not exported yet, and a named import would fail the whole file to load.
import * as summaryLib from '../scripts/lib/summary.mjs';
import { exampleRun6 } from './fixtures/run-example6.mjs';

const SECTIONS = ['Failures', 'Screens', 'Expectations', 'Tour', 'Checks', 'Routes', 'Mutants', 'Metrics', 'Lived-in', 'Standing'];
const CLICK = '{"click":"x"}';
const FOUR_LINES = 'line1\nline2\nline3\nline4';

function linesOf(md) {
  return md.replace(/\n$/, '').split('\n');
}

function headingsOf(ls) {
  return ls.filter((l) => l.startsWith('## ')).map((l) => l.match(/^## ([A-Za-z-]+)/)?.[1]);
}

// The 'chk:' lines shown and the more:checks line must agree with the total.
function assertChecksCapped(ls, total) {
  const shown = ls.filter((l) => l.startsWith('- [chk:')).length;
  assert.ok(shown > 0, 'some check lines are shown');
  assert.ok(ls.includes(`- [more:checks] ${total - shown} more in results.json`),
    `expected "- [more:checks] ${total - shown} more in results.json", got: ${ls.filter((l) => l.includes('more:')).join(' | ')}`);
}

function manyChecks(n) {
  return Array.from({ length: n }, (_, i) => ({
    check: 'contrast', detail: `span.c${i} contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1`,
  }));
}

// S1 ---------------------------------------------------------------------------------------------

test('S1 tourKind: cut off and runs past are clipped, covered at is covered, stuck on Escape', () => {
  assert.equal(tourKind('X cut off by div.a'), 'clipped');
  assert.equal(tourKind('X runs past the top of the screen'), 'clipped');
  assert.equal(tourKind('X covered at centre by div.b'), 'covered');
  assert.equal(tourKind('button "M" does not close on Escape'), 'stuck');
});

// S2 ---------------------------------------------------------------------------------------------

test('S2 buildResults ids: scr, unx, tour, chk, con and exp for one viewport', () => {
  const r = buildResults(exampleRun());
  assert.equal(r.screens[0].id, 'scr:desktop/detail__default');
  assert.equal(r.unexpected[0].id, 'unx:desktop/detail__default/1');
  assert.equal(r.tour.new[0].id, 'tour:desktop/detail__default/1');
  assert.equal(r.checks.new[0].id, 'chk:desktop/detail__default/1');
  assert.equal(r.console.new[0].id, 'con:desktop/detail__default/1');
  assert.equal(r.expectations[0].id, 'exp:title-renamed');
});

test('S2 two viewports: expectation ids carry @viewport, and an n/a expectation is dropped', () => {
  const run = exampleRun();
  const desktop = run.compare.viewports[0];
  desktop.expectations.push({ name: 'ignored', describe: '…', result: 'n/a', detail: '' });
  run.compare.viewports.push({
    ...desktop, viewport: 'phone', unexpected: [], eyes: [],
    expectations: [{ name: 'title-renamed', describe: '…', result: 'met', detail: '1 element(s): 1 right' }],
  });
  run.sides.head.viewports.push({ viewport: 'phone', captured: ['detail__default', 'list__default'], failed: [], notRun: [], warnings: [] });
  run.sides.base.viewports.push({ viewport: 'phone', captured: ['detail__default', 'list__default'], failed: [], notRun: [], warnings: [] });
  const r = buildResults(run);
  assert.deepEqual(r.expectations.map((e) => e.id), ['exp:title-renamed@desktop', 'exp:title-renamed@phone']);
});

// S3 ---------------------------------------------------------------------------------------------

test('S3 a head failure the base also had: onBase, first 3 lines, id fail:head/desktop/detail', () => {
  const run = exampleRun();
  run.sides.head.viewports[0].failed = [{ screen: 'detail', step: CLICK, error: FOUR_LINES }];
  run.sides.base.viewports[0].failed = [{ screen: 'detail', step: CLICK, error: FOUR_LINES }];
  const r = buildResults(run);
  const f = r.failures.find((x) => x.id === 'fail:head/desktop/detail');
  assert.ok(f, 'a fail:head/desktop/detail entry exists');
  assert.equal(f.side, 'head');
  assert.equal(f.viewport, 'desktop');
  assert.equal(f.screen, 'detail');
  assert.equal(f.step, CLICK);
  assert.equal(f.onBase, true);
  assert.deepEqual(f.lines, ['line1', 'line2', 'line3']);
  assert.equal(r.mapErrors, 0);
});

test('S3 a head failure with mapError counts in mapErrors and makes a MAP ERROR screen when no pair', () => {
  const run = exampleRun();
  run.sides.head.viewports[0].failed = [{ screen: 'cart', step: CLICK, error: 'no element for cart', mapError: true }];
  const r = buildResults(run);
  assert.equal(r.mapErrors, 1);
  const s = r.screens.find((x) => x.id === 'scr:desktop/cart');
  assert.ok(s, 'a scr:desktop/cart entry exists');
  assert.equal(s.status, 'MAP ERROR');
  assert.equal(s.key, null);
  assert.equal(s.tree, null);
  assert.equal(s.pixel, null);
  assert.deepEqual(s.elements, { changed: 0, drift: 0 });
});

test('S3 a failed head screen with no pair and no mapError is a failed screen', () => {
  const run = exampleRun();
  run.sides.head.viewports[0].failed = [{ screen: 'cart', step: CLICK, error: 'boom' }];
  const r = buildResults(run);
  assert.equal(r.mapErrors, 0);
  const s = r.screens.find((x) => x.id === 'scr:desktop/cart');
  assert.ok(s, 'a scr:desktop/cart entry exists');
  assert.equal(s.status, 'failed');
  assert.equal(s.key, null);
  assert.equal(s.tree, null);
  assert.equal(s.pixel, null);
});

// S4 ---------------------------------------------------------------------------------------------

test('S4 the detail screen entry: tree, elements, pixel and eyes; the list entry is not in eyes', () => {
  const r = buildResults(exampleRun());
  const d = r.screens.find((s) => s.id === 'scr:desktop/detail__default');
  assert.ok(d, 'the detail entry exists');
  assert.equal(d.status, 'changed');
  assert.deepEqual(d.tree, { added: 2, removed: 1, unexplained: 2 });
  assert.deepEqual(d.elements, { changed: 1, drift: 0 });
  assert.deepEqual(d.pixel, { ratio: 0.024, worstTile: 0.031, changed: true });
  assert.equal(d.eyes, true);
  const l = r.screens.find((s) => s.id === 'scr:desktop/list__default');
  assert.ok(l, 'the list entry exists');
  assert.equal(l.eyes, false);
});

// S5 ---------------------------------------------------------------------------------------------

test('S5 tour totals: 4 opened, 2 clipped, 0 covered, 0 stuck, 12 of 14 hovers, one standing', () => {
  const t = buildResults(exampleRun()).tour;
  assert.equal(t.opened, 4);
  assert.equal(t.clipped, 2);
  assert.equal(t.covered, 0);
  assert.equal(t.stuck, 0);
  assert.equal(t.hoverAnswered, 12);
  assert.equal(t.hoverTotal, 14);
  assert.equal(t.new[0].kind, 'clipped');
  assert.equal(t.standing, 1);
});

// S6 ---------------------------------------------------------------------------------------------

test('S6 metrics: 2 captures at 16000 ms each', () => {
  assert.deepEqual(buildResults(exampleRun()).metrics, { captures: 2, msPerCapture: 16000, flags: [], standing: 0 });
});

test('S6 metrics is null when the head side captured nothing', () => {
  const run = exampleRun();
  run.sides.head = sideResult(32000, { captured: [] });
  assert.equal(buildResults(run).metrics, null);
});

// S7 ---------------------------------------------------------------------------------------------

test('S7 a blocked run builds: fail:sandbox/head, and screens, expectations, eyes and new checks empty', () => {
  const r = buildResults(blockedRun());
  assert.equal(r.blocked, 'BLOCKED ON INFRASTRUCTURE: head: supabase start failed');
  assert.ok(r.failures.some((f) => f.id === 'fail:sandbox/head'), 'a fail:sandbox/head failure exists');
  assert.deepEqual(r.screens, []);
  assert.deepEqual(r.expectations, []);
  assert.deepEqual(r.eyes, []);
  assert.deepEqual(r.checks.new, []);
});

// S8 ---------------------------------------------------------------------------------------------

test('S8 self mode: identical when compare exits 0 and every pair is same', () => {
  const r = buildResults(selfRun());
  assert.equal(r.identical, true);
  assert.deepEqual(r.eyes, []);
  assert.deepEqual(r.checks.new, []);
  assert.deepEqual(r.tour.new, []);
  assert.deepEqual(r.console.new, []);
});

test('S8 self mode: not identical when one pair changed', () => {
  const run = selfRun();
  run.exit = 1;
  run.compare.exit = 1;
  run.compare.viewports[0].exit = 1;
  run.compare.viewports[0].pairs[0] = pairDetail();
  assert.equal(buildResults(run).identical, false);
});

test('S8 identical is null in diff mode', () => {
  assert.equal(buildResults(exampleRun()).identical, null);
});

// S9 ---------------------------------------------------------------------------------------------

test('S9 summaryMd on the example: the brief lines in order, the ten headings, the item-line shape', () => {
  const ls = linesOf(summaryMd(buildResults(exampleRun())));
  const expected = [
    '# qa run — feat-x: findings (exit 1)',
    'head aaaaaaaaaaaa · base bbbbbbbbbbbb (cached) · maps cccccccccccc',
    'sandbox: base cached 0 s · head up 81 s · MAP ERROR 0',
    'steps: head.up ok 81 s · head.capture ok 32 s · head.down ok 4 s · run.compare ok 3 s',
    '## Failures (0)',
    '## Screens — 1 unchanged · 1 changed · 0 new · 0 removed · 0 MAP ERROR · 0 failed',
    '- [scr:desktop/detail__default] changed · tree +2 −1 (2 unexplained) · elements 1 changed · pixels 2.4% (tile 0.031) → eyes',
    '## Expectations — met 1 · NOT MET 0 · other 0 · UNEXPECTED 1',
    '- [exp:title-renamed] met — title-renamed: 1 element(s): 1 right',
    '- [unx:desktop/detail__default/1] UNEXPECTED tree: + heading "New title" [level=1] (+1 more)',
    '## Tour — 4 opened · 2 clipped · 0 covered · 0 stuck · 12/14 hovers answer',
    '- [tour:desktop/detail__default/1] new: listbox "Status" 200×240 cut off by div.card',
    '## Checks — 1 new · 1 standing · 0 fixed · console 1 new',
    '- [chk:desktop/detail__default/1] contrast: span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1',
    '- [con:desktop/detail__default/1] console: TypeError: x is undefined',
    '## Routes — not run',
    '## Mutants — not run',
    '## Metrics — 2 captures, 16 s each · 0 flag(s) · 0 standing',
    '## Lived-in — not run',
    '## Standing — 2 (1 checks · 1 tour · 0 console) → qa/standing.md (+2 new)',
  ];
  let at = -1;
  for (const want of expected) {
    const idx = ls.indexOf(want);
    assert.notEqual(idx, -1, `missing line: ${want}`);
    assert.ok(idx > at, `out of order: ${want}`);
    at = idx;
  }
  assert.deepEqual(headingsOf(ls), SECTIONS);
  for (const l of ls) {
    if (l.startsWith('- ')) assert.match(l, /^- \[[a-z]+:[^\]]+\] /, `item line shape: ${l}`);
  }
});

// S10 --------------------------------------------------------------------------------------------

function bigRun(n) {
  const run = exampleRun();
  run.compare.viewports[0].pairs[0].checks.new = manyChecks(n);
  return run;
}

test('S10 summaryMd caps at 150 lines, keeps every heading, and counts the dropped checks', () => {
  const ls = linesOf(summaryMd(buildResults(bigRun(400))));
  assert.ok(ls.length <= 150, `at most 150 lines, got ${ls.length}`);
  assert.deepEqual(headingsOf(ls), SECTIONS);
  assertChecksCapped(ls, 400);
});

test('S10 summaryMd with maxLines 40 stays within 40 lines and keeps every heading', () => {
  const ls = linesOf(summaryMd(buildResults(bigRun(400)), { maxLines: 40 }));
  assert.ok(ls.length <= 40, `at most 40 lines, got ${ls.length}`);
  assert.deepEqual(headingsOf(ls), SECTIONS);
  assertChecksCapped(ls, 400);
});

// S11 --------------------------------------------------------------------------------------------

test('S11 a 3-line failure prints its first line, then each further line indented four spaces', () => {
  const run = exampleRun();
  run.sides.head.viewports[0].failed = [{ screen: 'detail', step: CLICK, error: 'line1\nline2\nline3' }];
  const ls = linesOf(summaryMd(buildResults(run)));
  const at = ls.indexOf('- [fail:head/desktop/detail] {"click":"x"}: line1');
  assert.notEqual(at, -1, 'the failure line is printed');
  assert.equal(ls[at + 1], '    line2');
  assert.equal(ls[at + 2], '    line3');
});

// S12 --------------------------------------------------------------------------------------------

test('S12 self-test header and identity line', () => {
  const ls = linesOf(summaryMd(buildResults(selfRun())));
  assert.equal(ls[0], '# qa self-test — feat-x: identical (exit 0)');
  assert.equal(ls[1], 'head aaaaaaaaaaaa · self-test · maps cccccccccccc');
});

test('S12 self-test header says NOT DETERMINISTIC when the two captures differ', () => {
  const run = selfRun();
  run.exit = 1;
  run.compare.exit = 1;
  run.compare.viewports[0].exit = 1;
  run.compare.viewports[0].pairs[0] = pairDetail();
  const ls = linesOf(summaryMd(buildResults(run)));
  assert.equal(ls[0], '# qa self-test — feat-x: NOT DETERMINISTIC (exit 1)');
});

// S13 --------------------------------------------------------------------------------------------

test('S13 a blocked run renders BLOCKED with exit 4 and the sandbox failure line', () => {
  const ls = linesOf(summaryMd(buildResults(blockedRun())));
  assert.equal(ls[0], '# qa run — feat-x: BLOCKED (exit 4)');
  assert.ok(ls.includes('- [fail:sandbox/head] up: BLOCKED ON INFRASTRUCTURE: head: supabase start failed'),
    'the sandbox failure line is listed');
});

// step 6 -----------------------------------------------------------------------------------------

function assertMoreCounted(ls, prefix, section, total) {
  const shown = ls.filter((l) => l.startsWith(prefix)).length;
  assert.ok(shown > 0, `some ${prefix} lines are shown`);
  assert.ok(shown < total, `the list is cut: ${shown} of ${total} shown`);
  assert.ok(ls.includes(`- [more:${section}] ${total - shown} more in results.json`),
    `expected "- [more:${section}] ${total - shown} more in results.json", got: ${ls.filter((l) => l.includes('more:')).join(' | ')}`);
}

function metricPair(i) {
  return {
    ...pairList(), key: `p${i}__default`, before: { screen: `p${i}` }, after: { screen: `p${i}` },
    metrics: { flags: [{ metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 }], standing: 0 },
  };
}

test('step 6: buildResults keeps the run routes and mutants as they are', () => {
  const run = exampleRun6();
  const r = buildResults(run);
  assert.deepEqual(r.routes, run.routes);
  assert.deepEqual(r.mutants, run.mutants);
});

test('step 6: metrics.flags lists each pair flag with its met: id, viewport, key, metric and numbers', () => {
  assert.deepEqual(buildResults(exampleRun6()).metrics.flags, [{
    id: 'met:desktop/detail__default/screen.readyMs', viewport: 'desktop', key: 'detail__default',
    metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000,
  }]);
});

test('step 6: metrics.flags is [] and metrics.standing is 0 when no pair has a flag', () => {
  const m = buildResults(exampleRun()).metrics;
  assert.deepEqual(m.flags, []);
  assert.equal(m.standing, 0);
});

test('step 6: metrics.standing is the sum of the viewports metricsStanding', () => {
  const run = exampleRun6();
  run.compare.viewports[0].metricsStanding = 3;
  assert.equal(buildResults(run).metrics.standing, 3);
});

test('step 6: route expectations are appended after compare\'s, as exp:<name> with viewport null', () => {
  const r = buildResults(exampleRun6());
  assert.deepEqual(r.expectations.map((e) => e.id), ['exp:title-renamed', 'exp:notes-denied-to-viewer']);
  assert.deepEqual(r.expectations[1], {
    id: 'exp:notes-denied-to-viewer', viewport: null, name: 'notes-denied-to-viewer', result: 'met', detail: 'POST /api/notes as viewer: 403',
  });
});

test('step 6: a route expectation has no @viewport suffix with two viewports, and an n/a one is dropped', () => {
  const run = exampleRun6();
  run.routeExpectations.push({ name: 'skipped', result: 'n/a', detail: '' });
  run.compare.viewports.push({
    viewport: 'phone', exit: 1, pairs: [], expectations: [], unexpected: [], overflow: [], inconclusive: [], eyes: [],
    standing: { checks: 0, tour: 0, console: 0 },
  });
  assert.deepEqual(buildResults(run).expectations.map((e) => e.id), ['exp:title-renamed@desktop', 'exp:notes-denied-to-viewer']);
});

test('step 6: summaryMd prints the Routes, Mutants and Metrics items of the example in order', () => {
  const ls = linesOf(summaryMd(buildResults(exampleRun6())));
  const expected = [
    '## Routes — 30 probes · 2 new · 1 standing · 0 fixed · 1 unlisted · 0 stale',
    '- [rte:1] POST /api/notes deep (staff): 500 answered',
    '- [rte:2] POST /api/notes happy (staff): happy path answered 400',
    '- [rte:unlisted/1] unlisted: DELETE /api/notes/:id',
    '## Mutants — 1/2 killed · 1 survived · 0 stale · 0 not judged (affected)',
    '- [mut:rls-check-dropped] SURVIVED: a person can move their row to someone else (supabase/migrations/0007.sql, suite db)',
    '## Metrics — 2 captures, 16 s each · 1 flag(s) · 0 standing',
    '- [met:desktop/detail__default/screen.readyMs] screen.readyMs 1800 ms over 1000 ms (base 900 ms)',
    '## Lived-in — not run',
  ];
  let at = -1;
  for (const want of expected) {
    const idx = ls.indexOf(want);
    assert.notEqual(idx, -1, `missing line: ${want}`);
    assert.ok(idx > at, `out of order: ${want}`);
    at = idx;
  }
  assert.deepEqual(headingsOf(ls), SECTIONS);
});

test('step 6: the route expectation is an Expectations item, and the heading counts it as met', () => {
  const ls = linesOf(summaryMd(buildResults(exampleRun6())));
  assert.ok(ls.includes('## Expectations — met 2 · NOT MET 0 · other 0 · UNEXPECTED 1'), 'the heading counts two met');
  assert.ok(ls.includes('- [exp:notes-denied-to-viewer] met — notes-denied-to-viewer: POST /api/notes as viewer: 403'));
});

test('step 6: the Routes heading names the reason when the sweep did not run', () => {
  const run = exampleRun6();
  run.routes = {
    file: null, rows: 0, probes: 0, notRunProbes: 0, failed: 0, new: [], standing: 0, fixed: 0,
    unlisted: [], stale: [], errors: [], notRun: 'route table has errors', base: 'none',
  };
  const ls = linesOf(summaryMd(buildResults(run)));
  assert.ok(ls.includes('## Routes — not run: route table has errors'), `got: ${ls.filter((l) => l.startsWith('## Routes')).join(' | ')}`);
});

test('step 6: a long Routes list is capped with a more:routes line that counts the rest', () => {
  const run = exampleRun6();
  run.routes.new = Array.from({ length: 200 }, (_, i) => ({
    id: `rte:${i + 1}`, pid: `GET /api/x|deep|staff${i}`, route: 'GET /api/x', kind: 'deep', actor: 'staff', status: 500, problem: '500 answered',
  }));
  run.routes.unlisted = [];
  const ls = linesOf(summaryMd(buildResults(run)));
  assert.ok(ls.length <= 150, `at most 150 lines, got ${ls.length}`);
  assert.deepEqual(headingsOf(ls), SECTIONS);
  assertMoreCounted(ls, '- [rte:', 'routes', 200);
});

test('step 6: a long Mutants list is capped with a more:mutants line that counts the rest', () => {
  const run = exampleRun6();
  run.mutants = {
    ...run.mutants, run: 201, killed: 1,
    survived: Array.from({ length: 200 }, (_, i) => ({
      id: `mut:m${i}`, mutant: `m${i}`, origin: 'registry', breaks: 'a person can move their row to someone else',
      file: 'supabase/migrations/0007.sql', suite: 'db', detail: '',
    })),
  };
  const ls = linesOf(summaryMd(buildResults(run)));
  assert.ok(ls.length <= 150, `at most 150 lines, got ${ls.length}`);
  assert.deepEqual(headingsOf(ls), SECTIONS);
  assertMoreCounted(ls, '- [mut:', 'mutants', 200);
});

test('step 6: a long Metrics list is capped with a more:metrics line that counts the rest', () => {
  const run = exampleRun6();
  run.compare.viewports[0].pairs = Array.from({ length: 200 }, (_, i) => metricPair(i));
  const ls = linesOf(summaryMd(buildResults(run)));
  assert.ok(ls.length <= 150, `at most 150 lines, got ${ls.length}`);
  assert.deepEqual(headingsOf(ls), SECTIONS);
  assertMoreCounted(ls, '- [met:', 'metrics', 200);
});

test('step 6: routeText gives the new, unlisted and stale texts', () => {
  const { routeText } = summaryLib;
  assert.equal(routeText({ id: 'rte:1', pid: 'POST /api/notes|deep|staff', route: 'POST /api/notes', kind: 'deep', actor: 'staff', status: 500, problem: '500 answered' }),
    'POST /api/notes deep (staff): 500 answered');
  assert.equal(routeText({ id: 'rte:unlisted/1', method: 'DELETE', path: '/api/notes/:id' }), 'unlisted: DELETE /api/notes/:id');
  assert.equal(routeText({ id: 'rte:stale/1', method: 'GET', path: '/api/old' }), 'stale: GET /api/old');
});

test('step 6: mutantText gives the survived, stale and not judged texts from the list it is in', () => {
  const { mutantText } = summaryLib;
  const m = {
    id: 'mut:rls-check-dropped', mutant: 'rls-check-dropped', origin: 'registry', breaks: 'a person can move their row to someone else',
    file: 'supabase/migrations/0007.sql', suite: 'db', detail: 'found 2 times',
  };
  assert.equal(summaryLib.mutantText(m, 'survived'), 'SURVIVED: a person can move their row to someone else (supabase/migrations/0007.sql, suite db)');
  assert.equal(summaryLib.mutantText(m, 'stale'), 'stale: found 2 times');
  assert.equal(summaryLib.mutantText({ ...m, detail: 'suite db fails unmutated' }, 'notJudged'), 'not judged: suite db fails unmutated');
});

test('step 6: metricText is the metricsLine of the flag', () => {
  assert.equal(summaryLib.metricText({ metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 }),
    'screen.readyMs 1800 ms over 1000 ms (base 900 ms)');
});

// STEP 7 (affected set, coverage sources, videos) ----------------------------------------------

// The brief's example: three screens, two affected; candidates-list has no known sources.
const AFFECTED = {
  mode: 'affected', names: ['candidates-list', 'candidate-detail'],
  why: { 'candidates-list': 'no sources known', 'candidate-detail': 'source: src/features/candidates/Detail.tsx' },
  total: 3, unknown: 1, skipped: 1,
};
const FULL = { mode: 'full', names: ['candidates-list', 'candidate-detail', 'jobs-list'], why: {}, total: 3, unknown: 0, skipped: 0 };
const VIDEO = {
  id: 'vid:desktop/candidate-detail', viewport: 'desktop', screen: 'candidate-detail',
  file: '/w/head/desktop/candidate-detail.webm', checkpoints: [{ state: 'detail', atMs: 4210 }],
};
const videoFor = (screen) => ({ ...VIDEO, id: `vid:desktop/${screen}`, screen, file: `/w/head/desktop/${screen}.webm` });

// The line n lines after 'steps:' (the step 7 header lines sit there).
function lineAfterSteps(ls, n = 1) {
  const at = ls.findIndex((l) => l.startsWith('steps: '));
  assert.notEqual(at, -1, 'a steps line');
  return ls[at + n];
}

// checksRan: which page checks looked at each captured screen (capture.mjs records it; the summary says it).
const withRan = (listRan, detailRan) => {
  const run = exampleRun();
  const pairs = run.compare.viewports[0].pairs;
  pairs.find((p) => p.key === 'list__default').after = { screen: 'list', checksRan: listRan };
  pairs.find((p) => p.key === 'detail__default').after = { screen: 'detail', checksRan: detailRan };
  return run;
};
const ALL = ['contrast', 'target', 'clipped', 'overlap', 'covered', 'keyboard', 'focus'];

test('checksRan: buildResults copies each screen\'s list, null when the record has none', () => {
  const r = buildResults(withRan(ALL, ['contrast']));
  assert.deepEqual(r.screens.map((s) => [s.key, s.checksRan]), [['detail__default', ['contrast']], ['list__default', ALL]]);
  assert.deepEqual(buildResults(exampleRun()).screens.map((s) => s.checksRan), [null, null]);
});

test('checksRan: the summary says which checks ran on every screen, which only on some, and which never', () => {
  const ls = linesOf(summaryMd(buildResults(withRan(ALL.filter((id) => id !== 'keyboard'), ALL.filter((id) => !['keyboard', 'focus'].includes(id))))));
  const line = ls.find((l) => l.startsWith('checks ran'));
  assert.equal(line, 'checks ran (desktop): contrast, target, clipped, overlap, covered on every screen (2) · focus not on detail__default · not run: keyboard');
  assert.ok(ls.indexOf(line) < ls.findIndex((l) => l.startsWith('## Failures')), 'a header line, before the sections');
});

test('checksRan: no line when no screen carries the list', () => {
  assert.equal(linesOf(summaryMd(buildResults(exampleRun()))).some((l) => l.startsWith('checks ran')), false);
});

test('step 7: buildResults copies affected, videos and sourcesWritten, and each video keeps its vid: id', () => {
  const run = { ...exampleRun(), affected: AFFECTED, videos: [VIDEO], sourcesWritten: ['/w/qa/map/candidates.sources.json'] };
  const r = buildResults(run);
  assert.deepEqual(r.affected, AFFECTED);
  assert.deepEqual(r.videos, [VIDEO]);
  assert.equal(r.videos[0].id, 'vid:desktop/candidate-detail');
  assert.deepEqual(r.sourcesWritten, ['/w/qa/map/candidates.sources.json']);
});

test('step 7: buildResults defaults on a run without them: affected null, videos [], sourcesWritten []', () => {
  const r = buildResults(exampleRun());
  assert.equal(r.affected, null);
  assert.deepEqual(r.videos, []);
  assert.deepEqual(r.sourcesWritten, []);
});

test('step 7: summaryMd prints the affected line right after the steps line, with the unknown count', () => {
  const ls = linesOf(summaryMd(buildResults({ ...exampleRun(), affected: AFFECTED })));
  assert.equal(lineAfterSteps(ls), 'affected: 2 of 3 screens (1 without known sources)');
});

test('step 7: a full run with no sources written prints the full line with no sources part', () => {
  const ls = linesOf(summaryMd(buildResults({ ...exampleRun(), affected: FULL })));
  assert.equal(lineAfterSteps(ls), 'full: every screen');
});

test('step 7: a full run that wrote sources says how many files on the same line', () => {
  const run = { ...exampleRun(), affected: FULL, sourcesWritten: ['/w/qa/map/a.sources.json', '/w/qa/map/b.sources.json'] };
  const ls = linesOf(summaryMd(buildResults(run)));
  assert.equal(lineAfterSteps(ls), 'full: every screen · sources written: 2 file(s)');
});

test('step 7: a screens run (affected null) prints no affected or full line, and its videos line follows steps', () => {
  const ls = linesOf(summaryMd(buildResults({ ...exampleRun(), affected: null, videos: [VIDEO] })));
  assert.equal(ls.filter((l) => /^(affected|full): /.test(l)).length, 0);
  assert.equal(lineAfterSteps(ls), 'videos: 1 (report.html)');
});

test('step 7: the videos line comes right after the affected line', () => {
  const ls = linesOf(summaryMd(buildResults({ ...exampleRun(), affected: AFFECTED, videos: [VIDEO, videoFor('list')] })));
  assert.equal(lineAfterSteps(ls, 1), 'affected: 2 of 3 screens (1 without known sources)');
  assert.equal(lineAfterSteps(ls, 2), 'videos: 2 (report.html)');
});

test('step 7: no videos means no videos line, and the affected line still follows steps', () => {
  const ls = linesOf(summaryMd(buildResults({ ...exampleRun(), affected: AFFECTED, videos: [] })));
  assert.equal(ls.filter((l) => l.startsWith('videos:')).length, 0);
  assert.equal(lineAfterSteps(ls), 'affected: 2 of 3 screens (1 without known sources)');
});

function capped(maxLines) {
  const run = bigRun(400);
  run.affected = AFFECTED;
  run.videos = [VIDEO, videoFor('list'), videoFor('jobs')];
  const ls = linesOf(summaryMd(buildResults(run), { maxLines }));
  assert.ok(ls.length <= maxLines, `at most ${maxLines} lines, got ${ls.length}`);
  assert.deepEqual(headingsOf(ls), SECTIONS);
  assert.ok(ls.includes('affected: 2 of 3 screens (1 without known sources)'), 'the affected line is kept');
  assert.ok(ls.includes('videos: 3 (report.html)'), 'the videos line is kept');
  assertChecksCapped(ls, 400);
}

test('step 7: the 150-line cap holds with the affected and videos lines, and every heading stays', () => {
  capped(150);
});

test('step 7: with maxLines 40 the affected and videos lines fit, and every heading stays', () => {
  capped(40);
});

// unmapped ---------------------------------------------------------------------------------------

const UNMAPPED_FILES = ['src/features/jobs/JobAdComposePage.tsx', 'src/features/jobs/JobAdPreview.tsx'];
const withUnmapped = (files = UNMAPPED_FILES) => ({ ...exampleRun(), affected: { ...AFFECTED, unmapped: files } });

test('unmapped: buildResults lists results.unmapped as { id: unm:<n>, file }, in the order given', () => {
  const r = buildResults(withUnmapped());
  assert.deepEqual(r.unmapped, [
    { id: 'unm:1', file: 'src/features/jobs/JobAdComposePage.tsx' },
    { id: 'unm:2', file: 'src/features/jobs/JobAdPreview.tsx' },
  ]);
});

test('unmapped: results.unmapped is [] without run.affected, with a full run, or with no unmapped file', () => {
  assert.deepEqual(buildResults(exampleRun()).unmapped, []);
  assert.deepEqual(buildResults({ ...exampleRun(), affected: FULL }).unmapped, []);
  assert.deepEqual(buildResults({ ...exampleRun(), affected: AFFECTED }).unmapped, []);
  assert.deepEqual(buildResults({ ...exampleRun(), affected: null }).unmapped, []);
});

test('unmapped: unmappedText is "unmapped: <file> — no map entry walks it"', () => {
  assert.equal(typeof summaryLib.unmappedText, 'function');
  assert.equal(
    summaryLib.unmappedText({ id: 'unm:1', file: 'src/features/jobs/JobAdComposePage.tsx' }),
    'unmapped: src/features/jobs/JobAdComposePage.tsx — no map entry walks it',
  );
});

test('unmapped: summaryMd puts one item per file inside Screens, after the screen items and before Expectations', () => {
  const ls = linesOf(summaryMd(buildResults(withUnmapped())));
  const screens = ls.findIndex((l) => l.startsWith('## Screens'));
  const expectations = ls.findIndex((l) => l.startsWith('## Expectations'));
  const unm = ls.map((l, i) => [l, i]).filter(([l]) => l.startsWith('- [unm:'));
  assert.deepEqual(unm.map(([l]) => l), [
    '- [unm:1] unmapped: src/features/jobs/JobAdComposePage.tsx — no map entry walks it',
    '- [unm:2] unmapped: src/features/jobs/JobAdPreview.tsx — no map entry walks it',
  ]);
  for (const [, i] of unm) assert.ok(i > screens && i < expectations, 'inside Screens');
  const lastScreen = Math.max(...ls.map((l, i) => [l, i]).filter(([l]) => l.startsWith('- [scr:')).map(([, i]) => i));
  assert.ok(unm[0][1] > lastScreen, 'after the screen items');
});

test('unmapped: no unmapped file means no unm: line, and the ten headings stay', () => {
  const ls = linesOf(summaryMd(buildResults({ ...exampleRun(), affected: AFFECTED })));
  assert.equal(ls.filter((l) => l.includes('[unm:')).length, 0);
  assert.equal(ls.filter((l) => l.startsWith('## ')).length, 10);
});

test('unmapped: a long list is capped as part of the Screens section with a more:screens line that counts the rest', () => {
  const files = Array.from({ length: 400 }, (_, i) => `src/f${i}.tsx`);
  const results = buildResults(withUnmapped(files));
  const ls = linesOf(summaryMd(results));
  assert.ok(ls.length <= 150, `${ls.length} lines`);
  assert.equal(ls.filter((l) => l.startsWith('## ')).length, 10);
  const more = ls.find((l) => l.startsWith('- [more:screens]'));
  assert.ok(more, 'a more:screens line');
  const shown = ls.filter((l) => l.startsWith('- [unm:') || l.startsWith('- [scr:')).length;
  const all = results.screens.filter((s) => s.status !== 'same').length + 400;
  assert.equal(Number(more.match(/(\d+) more/)[1]), all - shown);
});

test('0.6.0: the Mutants heading says how many baseline failures were excluded, per suite; none -> as before', () => {
  const run = exampleRun6();
  run.mutants.suites = { server: { passed: false, ms: 9, baseline: { failed: 52, names: ['t1'] } }, web: { passed: true, ms: 1 } };
  const md = summaryMd(buildResults(run));
  assert.ok(md.includes('## Mutants — 1/2 killed · 1 survived · 0 stale · 0 not judged (affected) · 52 baseline failure(s) excluded (server 52)\n'), md);
  const plain = summaryMd(buildResults(exampleRun6()));
  assert.ok(plain.includes('## Mutants — 1/2 killed · 1 survived · 0 stale · 0 not judged (affected)\n'));
});

test('0.6.0: a mutant that SURVIVED a red baseline says it was judged on names', () => {
  const m = { breaks: 'a note may run past its cap', file: 'src/notes.py', suite: 'server', detail: 'judged on names: no test that passed unmutated failed (52 failing unmutated excluded)' };
  assert.equal(summaryLib.mutantText(m, 'survived'), 'SURVIVED: a note may run past its cap (src/notes.py, suite server) — judged on names: no test that passed unmutated failed (52 failing unmutated excluded)');
  assert.equal(summaryLib.mutantText({ ...m, detail: 'other' }, 'survived'), 'SURVIVED: a note may run past its cap (src/notes.py, suite server)');
});
