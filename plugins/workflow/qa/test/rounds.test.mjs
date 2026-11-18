// Contract tests for scripts/lib/rounds.mjs (rework U8, design 2026-11-12 §9): rounds, the incremental re-verify and
// the round cap. Pure: maps, verdicts and results are built by hand. The contract is the comment block at the top of
// rounds.mjs, and verdict.mjs 'ROUNDS' for the draft's side (carried rows, the cap). Every fixture is neutral: made-up
// screens, files and criteria, nothing of a real app.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  capHistory, carryInto, entryKeys, fixScreens, planRound, recordRound, roundLines, roundRecord,
} from '../scripts/lib/rounds.mjs';
import { ROUND_CAP, applyWaivers, decide, draftVerdict, parseCharter, parseVerdict, verdictOutcome } from '../scripts/lib/verdict.mjs';

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);
const BASE = 'b'.repeat(40);
const QA = { profile: 'p1', seed: 's1', routes: { 'qa/routes.table.json': 'r1' }, overlayRoutes: null };

const MAP = () => ({
  flows: { 'open:list': { steps: [{ goto: '/list' }] } },
  screens: [
    { name: 'alpha', sources: ['src/a/**'], steps: [{ goto: '/a' }] },
    { name: 'beta', sources: ['src/b/**'], steps: [{ goto: '/b' }] },
    { name: 'gamma', steps: [{ goto: '/g' }] },
    { name: 'delta', flow: 'open:list', record: true, steps: [{ click: 'role=button[name="Open"]' }] },
    { name: 'eps', flow: 'open:list', sources: ['src/e/**'], steps: [] },
  ],
});

const EXPECTATIONS = [
  { name: 'e-alpha', criterion: 'ch:1', screens: 'alpha', text: 'A' },
  { name: 'e-beta', criterion: 'ch:2', screens: 'beta', text: 'B' },
  { name: 'e-beta2', criterion: 'ch:9', screens: 'beta__*', text: 'B2' },
  { name: 't-unit', criterion: 'ch:3', test: { suite: 'unit', grep: 'holds', file: 'test/unit/x.test.ts' } },
  { name: 't-cov', criterion: 'ch:8', test: { suite: 'cov', grep: 'covers', file: 'test/cov/y.test.ts' } },
  { name: 'r-api', criterion: 'ch:4', route: 'GET /api/items', as: 'anon', status: 401 },
  { name: 'd-guide', criterion: 'ch:5', doc: { file: 'docs/guide.md', contains: 'Export' } },
];

const CHARTER = `# Charter — feat-x
security: no — none

- [ch:1] alpha shows A — by: expectation e-alpha
- [ch:2] beta shows B — by: expectation e-beta
- [ch:3] the rule holds — by: expectation t-unit
- [ch:4] items refuse anon — by: expectation r-api
- [ch:5] the guide says Export — by: expectation d-guide
- [ch:6] gamma reads well — by: screen gamma/default
- [ch:7] the provider answers — by: manual — ask: Did it arrive?
- [ch:8] coverage holds — by: expectation t-cov
- [ch:9] beta shows B2 — by: expectation e-beta2 — advisory
`;

const SUITES = { unit: 'npx vitest run', cov: { cmd: 'npx vitest run', covers: ['src/lib/**'] } };

const ROUTES = { file: 'qa/routes.table.json', rows: 1, probes: [], new: [], unlisted: [], stale: [], errors: [], notRun: null };

function prevResults(over = {}) {
  return {
    version: 1, mode: 'diff', slug: 'feat-x', head: { sha: SHA1, ref: 'HEAD' }, base: { sha: BASE, ref: 'main' }, blocked: null, compareError: null,
    expectations: [
      { id: 'exp:e-alpha', viewport: 'desktop', name: 'e-alpha', result: 'met', detail: '1 element(s): 1 right' },
      { id: 'exp:e-beta', viewport: 'desktop', name: 'e-beta', result: 'NOT MET', detail: '0 of 1 right' },
      { id: 'exp:e-beta2', viewport: 'desktop', name: 'e-beta2', result: 'met', detail: 'B2 shown' },
      { id: 'exp:r-api', viewport: null, name: 'r-api', result: 'met', detail: 'GET /api/items as anon: 401' },
      { id: 'exp:t-unit', viewport: null, name: 't-unit', result: 'met', detail: 'unit "holds": 1 passed' },
      { id: 'exp:t-cov', viewport: null, name: 't-cov', result: 'met', detail: 'cov "covers": 1 passed' },
      { id: 'exp:d-guide', viewport: null, name: 'd-guide', result: 'met', detail: 'docs/guide.md: 1 of 1 found' },
    ],
    tests: [
      { id: 'exp:t-unit', name: 't-unit', criterion: 'ch:3', result: 'met', detail: 'unit "holds": 1 passed' },
      { id: 'exp:t-cov', name: 't-cov', criterion: 'ch:8', result: 'met', detail: 'cov "covers": 1 passed' },
    ],
    docs: [{ id: 'exp:d-guide', name: 'd-guide', criterion: 'ch:5', result: 'met', detail: 'docs/guide.md: 1 of 1 found' }],
    routes: ROUTES, mutants: null,
    round: { n: 1, of: 'full', entries: entryKeys(MAP()), qa: QA },
    ...over,
  };
}

const PREV_MD = `# REJECT — feat-x
head: ${SHA1}
base: ${BASE}
maps: cccccccccccc
criteria: 13 pass · 2 fail · 1 unverifiable · 0 blocked · 0 waived

## Criteria
- [exp:e-alpha] PASS — e-alpha: 1 element(s): 1 right
- [exp:e-beta] FAIL — e-beta: 0 of 1 right
- [exp:e-beta2] PASS — e-beta2: B2 shown
- [exp:r-api] PASS — r-api: GET /api/items as anon: 401
- [exp:t-unit] PASS — t-unit: unit "holds": 1 passed
- [exp:t-cov] PASS — t-cov: cov "covers": 1 passed
- [exp:d-guide] PASS — d-guide: docs/guide.md: 1 of 1 found
- [ch:1] PASS — alpha shows A: exp:e-alpha met
- [ch:2] FAIL — beta shows B: exp:e-beta NOT MET
- [ch:3] PASS — the rule holds: t-unit met
- [ch:4] PASS — items refuse anon: r-api met
- [ch:5] PASS — the guide says Export: d-guide met
- [ch:6] PASS — gamma reads well: the gamma screen shows it
- [ch:7] UNVERIFIABLE — the provider answers: manual — ask: Did it arrive?
- [ch:8] PASS — coverage holds: t-cov met
- [ch:9] PASS — beta shows B2: e-beta2 met — advisory

## Expectations
- none

## Findings
- none

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 0 standing item(s), never gating

## Notes
- none

cost: plan $1 · eyes $1 · judge $1 · runner 0 · total $3
`;

const prevOf = (over = {}) => ({ round: 1, head: SHA1, base: BASE, spec: 'spec1', verdict: parseVerdict(PREV_MD), results: prevResults(), security: null, ...over });

function plan(over = {}) {
  return planRound({
    n: 2, head: SHA2, base: BASE, spec: 'spec1', prev: prevOf(), charterMd: CHARTER, expectations: EXPECTATIONS, mutants: [],
    headMap: MAP(), sources: { gamma: ['src/g/G.tsx'] }, changed: ['src/x/other.ts'], profile: {}, qa: QA, securityMd: null,
    suites: SUITES, history: {}, ...over,
  });
}

// ── map entries and the screens a fix touches ─────────────────────────────────

describe('entryKeys and fixScreens', () => {
  test('entryKeys: one key per screen name, equal for equal entries, different when a step changes', () => {
    const a = entryKeys(MAP());
    assert.deepEqual(Object.keys(a), ['alpha', 'beta', 'gamma', 'delta', 'eps']);
    assert.deepEqual(entryKeys(MAP()), a);
    const m = MAP();
    m.screens[2].steps = [{ goto: '/g?v=2' }];
    const b = entryKeys(m);
    assert.notEqual(b.gamma, a.gamma);
    assert.equal(b.alpha, a.alpha);
    m.flows['open:list'].steps = [{ goto: '/list?v=2' }];
    assert.notEqual(entryKeys(m).delta, a.delta, 'a flow the entry walks is part of its key');
    assert.deepEqual(entryKeys(null), {});
  });

  test('fixScreens: new entry, entry changed, a sources glob, a recorded source, and a journey through one of them', () => {
    const prevKeys = entryKeys(MAP());
    const head = MAP();
    head.screens[2].steps = [{ goto: '/g?v=2' }];
    head.screens.push({ name: 'zeta', steps: [{ goto: '/z' }] });
    const r = fixScreens({ head, prevKeys, changed: ['src/a/A.tsx', 'src/e/E.tsx'], sources: {} });
    assert.deepEqual(r.why, {
      alpha: 'sources: src/a/A.tsx', gamma: 'entry changed', delta: 'journey through eps', eps: 'sources: src/e/E.tsx', zeta: 'new entry',
    });
    assert.deepEqual(r.names, ['alpha', 'gamma', 'delta', 'eps', 'zeta']);
    assert.deepEqual(fixScreens({ head: MAP(), prevKeys, changed: ['src/g/G.tsx'], sources: { gamma: ['src/g/G.tsx'] } }).why, { gamma: 'source: src/g/G.tsx' });
    assert.deepEqual(fixScreens({ head: MAP(), prevKeys, changed: [], sources: {} }), { names: [], why: {} });
  });
});

// ── which rows re-run, which are carried ──────────────────────────────────────

describe('planRound: incremental', () => {
  test('a fix that touches nothing of the plan: only the failed row re-runs, with the rows on its screen; everything else is carried, pinned to its sha', () => {
    const p = plan();
    assert.equal(p.of, 'incremental');
    assert.equal(p.round, 2);
    assert.deepEqual(p.from, { round: 1, head: SHA1 });
    assert.deepEqual(p.screens, ['beta']);
    assert.deepEqual(p.expectations, ['e-beta', 'e-beta2']);
    assert.deepEqual(p.rerun, ['exp:e-beta', 'exp:e-beta2', 'ch:2', 'ch:9']);
    assert.deepEqual(p.carried, ['exp:e-alpha', 'exp:t-unit', 'exp:t-cov', 'exp:r-api', 'exp:d-guide', 'ch:1', 'ch:3', 'ch:4', 'ch:5', 'ch:6', 'ch:8']);
    assert.equal(p.reasons['exp:e-beta'], 'FAIL in round 1');
    assert.equal(p.reasons['exp:e-beta2'], 'its screen beta is walked anyway');
    assert.equal(p.reasons['ch:2'], 'FAIL in round 1');
    assert.equal(p.routes, false);
    assert.equal(p.mutants, false);
    assert.deepEqual(p.carry.criteria.map((c) => [c.id, c.status, c.sha, c.round]), [
      ['ch:1', 'PASS', SHA1, 1], ['ch:3', 'PASS', SHA1, 1], ['ch:4', 'PASS', SHA1, 1], ['ch:5', 'PASS', SHA1, 1], ['ch:6', 'PASS', SHA1, 1], ['ch:8', 'PASS', SHA1, 1],
    ]);
    assert.deepEqual(p.carry.criteria[0], { id: 'ch:1', status: 'PASS', name: 'alpha shows A', detail: 'exp:e-alpha met', sha: SHA1, round: 1 });
    assert.deepEqual(p.carry.expectations.map((e) => e.name), ['e-alpha', 'r-api', 't-unit', 't-cov', 'd-guide']);
    assert.deepEqual(p.carry.expectations[0].carried, { round: 1, sha: SHA1, detail: '1 element(s): 1 right' });
    assert.deepEqual(p.carry.tests.map((t) => t.name), ['t-unit', 't-cov']);
    assert.deepEqual(p.carry.docs.map((t) => t.name), ['d-guide']);
    assert.deepEqual(p.carry.routes, { ...ROUTES, carried: { round: 1, sha: SHA1 } });
    assert.equal(p.carry.mutants, null);
  });

  test('a changed source of a screen re-walks that screen and re-runs its rows', () => {
    const p = plan({ changed: ['src/a/A.tsx'] });
    assert.deepEqual(p.screens, ['alpha', 'beta']);
    assert.equal(p.screensWhy.alpha, 'sources: src/a/A.tsx');
    assert.ok(p.rerun.includes('exp:e-alpha') && p.rerun.includes('ch:1'));
    assert.equal(p.reasons['exp:e-alpha'], 'screen alpha: sources: src/a/A.tsx');
  });

  test('a recorded source, a changed entry and a new entry each re-walk their screen; a charter row on that screen re-runs', () => {
    const recorded = plan({ changed: ['src/g/G.tsx'] });
    assert.equal(recorded.screensWhy.gamma, 'source: src/g/G.tsx');
    assert.ok(recorded.rerun.includes('ch:6'));
    assert.equal(recorded.reasons['ch:6'], 'its screen gamma is walked');
    const head = MAP();
    head.screens[2].steps = [{ goto: '/g?v=2' }];
    head.screens.push({ name: 'zeta', steps: [{ goto: '/z' }] });
    const entries = plan({ headMap: head });
    assert.equal(entries.screensWhy.gamma, 'entry changed');
    assert.equal(entries.screensWhy.zeta, 'new entry');
  });

  test('with the PR\'s scope: the walk keeps only its screens; only the PR\'s own entries are compared with the last round', () => {
    const head = MAP();
    head.screens[0] = { ...head.screens[0], steps: [{ goto: '/a?v=2' }] };
    head.screens.push({ name: 'zeta', sources: ['src/z/**'], steps: [{ goto: '/z' }] });
    head.screens.push({ name: 'eta', sources: ['src/n/**'], steps: [{ goto: '/eta' }] });
    head.overlay = { dir: '/x/prs/feat-x/qa', screens: ['alpha'] };
    // alpha: the PR's own entry (its overlay), changed since round 1. zeta and eta joined the shared map from another PR's
    // merge; eta's sources match a file this PR changed against its base, so it is in scope, but it is not the PR's entry.
    const scope = { names: ['alpha', 'beta', 'eta'], why: { alpha: 'in overlay', beta: 'sources: src/b/B.tsx', eta: 'sources: src/n/N.tsx' } };
    const p = plan({ headMap: head, scope });
    assert.deepEqual(p.screens, ['alpha', 'beta']);
    assert.equal(p.screensWhy.alpha, 'entry changed');
    assert.ok(!Object.hasOwn(p.screensWhy, 'eta') && !Object.hasOwn(p.screensWhy, 'zeta'), JSON.stringify(p.screensWhy));
    // A screen out of scope is not walked, even where last round's verdict points at it.
    const md = PREV_MD.replace('## Gaps\n- none', '## Gaps\n- [fail:head/desktop/gamma] BLOCKED — capture timed out (timed out, retried once)');
    const q = plan({ prev: prevOf({ verdict: parseVerdict(md) }), scope: { names: ['beta'], why: { beta: 'sources: src/b/B.tsx' } } });
    assert.deepEqual(q.screens, ['beta']);
    // Without an overlay (the map is the branch's own) every entry in scope is the PR's: a new one there is new.
    const plainHead = MAP();
    plainHead.screens.push({ name: 'eta', sources: ['src/n/**'], steps: [{ goto: '/eta' }] });
    const r = plan({ headMap: plainHead, scope: { names: ['beta', 'eta'], why: {} } });
    assert.deepEqual(r.screens, ['beta', 'eta']);
    assert.equal(r.screensWhy.eta, 'new entry');
    // No scope known (the head map could not be read against the base): as before.
    assert.deepEqual(plan({ headMap: head }).screens, ['alpha', 'beta', 'zeta', 'eta']);
  });

  test('test rows: by their changed test file, by the files their suite covers, and all of them when the suites file changes', () => {
    const file = plan({ changed: ['test/unit/x.test.ts'] });
    assert.ok(file.rerun.includes('exp:t-unit') && file.rerun.includes('ch:3'));
    assert.equal(file.reasons['exp:t-unit'], 'its test file test/unit/x.test.ts changed');
    assert.ok(file.carried.includes('exp:t-cov'));
    const covers = plan({ changed: ['src/lib/util.ts'] });
    assert.ok(covers.rerun.includes('exp:t-cov') && covers.rerun.includes('ch:8'));
    assert.equal(covers.reasons['exp:t-cov'], 'its suite cov covers src/lib/util.ts');
    assert.ok(covers.carried.includes('exp:t-unit'), 'a suite with no covers is known only by its test file');
    const suites = plan({ changed: ['qa/suites.json'] });
    assert.ok(suites.rerun.includes('exp:t-unit') && suites.rerun.includes('exp:t-cov'));
    assert.equal(suites.reasons['exp:t-unit'], 'the suites file qa/suites.json changed');
  });

  test('route rows: route code or the route table changed turns the sweep on; otherwise the sweep and its rows are carried', () => {
    const code = plan({ changed: ['src/api/items.ts'] });
    assert.equal(code.routes, true);
    assert.ok(code.rerun.includes('exp:r-api') && code.rerun.includes('ch:4'));
    assert.equal(code.reasons['exp:r-api'], 'route code or table changed: src/api/items.ts');
    assert.equal(code.carry.routes, null);
    const table = plan({ changed: ['qa/routes.table.json'] });
    assert.equal(table.routes, true);
    const overlay = plan({ qa: { ...QA, overlayRoutes: 'o2' } });
    assert.equal(overlay.routes, true);
    assert.equal(overlay.reasons['exp:r-api'], 'route code or table changed: overlay routes.json');
  });

  test('doc rows re-run when their doc changed', () => {
    const p = plan({ changed: ['docs/guide.md'] });
    assert.ok(p.rerun.includes('exp:d-guide') && p.rerun.includes('ch:5'));
    assert.equal(p.reasons['exp:d-guide'], 'its doc docs/guide.md changed');
  });

  test('an open row (UNVERIFIABLE) re-runs; a manual row is neither re-run nor carried (the draft writes it from the charter)', () => {
    const md = PREV_MD.replace('- [exp:t-unit] PASS', '- [exp:t-unit] UNVERIFIABLE').replace('- [ch:3] PASS', '- [ch:3] UNVERIFIABLE');
    const p = plan({ prev: prevOf({ verdict: parseVerdict(md) }) });
    assert.ok(p.rerun.includes('exp:t-unit') && p.rerun.includes('ch:3'));
    assert.equal(p.reasons['exp:t-unit'], 'UNVERIFIABLE in round 1');
    assert.ok(!p.rerun.includes('ch:7') && !p.carried.includes('ch:7'));
  });

  test('a row carried before keeps the sha and round its evidence ran on', () => {
    const r2 = prevResults({ head: { sha: SHA2, ref: 'HEAD' } });
    r2.expectations[0] = { ...r2.expectations[0], detail: '1 element(s): 1 right — carried from 111111111111 (round 1)', carried: { round: 1, sha: SHA1, detail: '1 element(s): 1 right' } };
    r2.round = { ...r2.round, n: 2, criteria: [{ id: 'ch:1', status: 'PASS', name: 'alpha shows A', detail: 'exp:e-alpha met — carried from 111111111111 (round 1)', sha: SHA1, round: 1 }] };
    const md = PREV_MD.replace(`head: ${SHA1}`, `head: ${SHA2}`).replace('- [ch:1] PASS — alpha shows A: exp:e-alpha met', '- [ch:1] PASS — alpha shows A: exp:e-alpha met — carried from 111111111111 (round 1)');
    const p = plan({ n: 3, head: SHA3, prev: prevOf({ round: 2, head: SHA2, verdict: parseVerdict(md), results: r2 }) });
    assert.deepEqual(p.carry.expectations.find((e) => e.name === 'e-alpha').carried, { round: 1, sha: SHA1, detail: '1 element(s): 1 right' });
    assert.deepEqual(p.carry.criteria.find((c) => c.id === 'ch:1'), { id: 'ch:1', status: 'PASS', name: 'alpha shows A', detail: 'exp:e-alpha met', sha: SHA1, round: 1 });
    assert.deepEqual(p.carry.criteria.find((c) => c.id === 'ch:3'), { id: 'ch:3', status: 'PASS', name: 'the rule holds', detail: 't-unit met', sha: SHA2, round: 2 });
  });

  test('the screen of a finding that gated, or of a BLOCKED item, is walked again', () => {
    const md = PREV_MD.replace('## Findings\n- none', '## Findings\n- Major [chk:desktop/gamma__default/1] contrast: span 2.1:1 — gates: corroborated on a changed screen')
      .replace('## Gaps\n- none', '## Gaps\n- [fail:head/desktop/eps] BLOCKED — capture timed out (timed out, retried once)');
    const p = plan({ prev: prevOf({ verdict: parseVerdict(md) }) });
    assert.equal(p.screensWhy.gamma, 'chk:desktop/gamma__default/1 gated in round 1');
    assert.equal(p.screensWhy.eps, 'fail:head/desktop/eps was BLOCKED in round 1');
    assert.ok(p.rerun.includes('ch:6'));
  });

  test('security: carried when the fix touches nothing sensitive; re-run for a sensitive path or a High last time', () => {
    const carried = plan();
    assert.deepEqual(carried.security, { rerun: false, why: 'the fix touches no sensitive, auth, role, session, route or migration path', paths: [], from: { round: 1, head: SHA1 } });
    const older = plan({ prev: prevOf({ security: { rerun: false, from: { round: 1, head: 'f'.repeat(40) } } }) });
    assert.deepEqual(older.security.from, { round: 1, head: 'f'.repeat(40) }, 'carried along from the round that ran it');
    const auth = plan({ changed: ['src/auth/session.ts'] });
    assert.equal(auth.security.rerun, true);
    assert.deepEqual(auth.security.paths, [{ file: 'src/auth/session.ts', why: 'auth, role or session code' }]);
    assert.deepEqual(auth.security.from, { round: 2, head: SHA2 });
    const high = plan({ securityMd: '# Security — feat-x\n- High [sec:1] token in the log — src/x.ts:3\n' });
    assert.equal(high.security.rerun, true);
    assert.equal(high.security.why, 'round 1 found a High: sec:1');
  });

  test('mutants run again only when the fix touches a mutant\'s file or its killing test', () => {
    const mutants = [{ id: 'm1', file: 'src/a/guard.ts', kill: { suite: 'unit', grep: 'guard', file: 'test/unit/g.test.ts' } }];
    const prev = prevOf({ results: prevResults({ mutants: { mode: 'named', run: 1, killed: 1, survived: [], stale: [], notJudged: [], errors: [] } }) });
    assert.equal(plan({ mutants, prev, changed: ['src/a/guard.ts'] }).mutants, true);
    assert.equal(plan({ mutants, prev, changed: ['test/unit/g.test.ts'] }).mutants, true);
    const off = plan({ mutants, prev });
    assert.equal(off.mutants, false);
    assert.deepEqual(off.carry.mutants.carried, { round: 1, sha: SHA1 });
  });

  test('roundLines says what re-runs, what is carried, what is walked, routes, mutants and security', () => {
    const lines = roundLines(plan());
    assert.equal(lines[0], `round 2: incremental from round 1 (111111111111) — 1 file(s) changed`);
    assert.ok(lines.includes('re-run: exp:e-beta (FAIL in round 1), exp:e-beta2 (its screen beta is walked anyway), ch:2 (FAIL in round 1), ch:9 (its evidence re-runs)'), lines.join('\n'));
    assert.ok(lines.includes('carried: 11 row(s), each says carried from <sha>'), lines.join('\n'));
    assert.ok(lines.includes('walk: beta (for exp:e-beta)'), lines.join('\n'));
    assert.ok(lines.includes('routes: carried · mutants: carried'), lines.join('\n'));
    assert.ok(lines.includes('security: carried from round 1 (111111111111) — the fix touches no sensitive, auth, role, session, route or migration path'), lines.join('\n'));
  });
});

describe('planRound: full rounds', () => {
  const full = (over) => plan(over);
  test('round 1, --full, after an ACCEPT, no plan, no results, nothing checked: a full round', () => {
    assert.equal(full({ n: 1, prev: null }).why, 'round 1');
    assert.equal(full({ prev: null }).why, 'no earlier verdict to carry from');
    assert.equal(full({ full: true }).why, '--full');
    assert.equal(full({ prev: prevOf({ verdict: parseVerdict(PREV_MD.replace('# REJECT', '# ACCEPT')) }) }).why, 'round 1 was an ACCEPT: a new commit needs a new check');
    assert.equal(full({ charterMd: null }).why, 'no plan to carry: charter.md or expectations.json is missing');
    assert.equal(full({ expectations: null }).why, 'no plan to carry: charter.md or expectations.json is missing');
    assert.equal(full({ prev: prevOf({ results: null }) }).why, 'no results for round 1');
    assert.equal(full({ prev: prevOf({ results: prevResults({ blocked: 'BLOCKED ON INFRASTRUCTURE: head: no port\nmore' }) }) }).why, 'round 1 checked nothing: BLOCKED ON INFRASTRUCTURE: head: no port');
    assert.equal(full({ prev: prevOf({ results: prevResults({ round: { n: 1 } }) }) }).why, 'round 1 recorded no map entries');
    assert.equal(full({ changed: null }).why, 'the head of round 1 (111111111111) is not in this repo');
  });

  test('a changed spec, a moved base, qa.json or the seed names: a full round', () => {
    assert.equal(full({ spec: 'spec2' }).why, 'the spec changed since round 1');
    assert.equal(full({ base: 'c'.repeat(40) }).why, 'the base moved: bbbbbbbbbbbb → cccccccccccc');
    assert.equal(full({ changed: ['src/a/A.tsx', 'qa.json'] }).why, 'qa.json changed');
    assert.equal(full({ changed: ['qa/seed.json'] }).why, 'qa/seed.json changed');
    assert.equal(full({ changed: ['conf/seed.json'], profile: { seedNames: 'conf/seed.json' } }).why, 'conf/seed.json changed');
    assert.equal(full({ qa: { ...QA, profile: 'p2' } }).why, 'qa.json changed');
    assert.equal(full({ qa: { ...QA, seed: 's2' } }).why, 'qa/seed.json changed');
  });

  test('a full round re-runs everything: no screens list, no carry, security from this round', () => {
    const p = full({ n: 1, prev: null, history: { 'ch:2': 1 } });
    assert.deepEqual(p, {
      round: 1, head: SHA2, base: BASE, spec: 'spec1', of: 'full', why: 'round 1', from: null, changed: ['src/x/other.ts'],
      screens: null, screensWhy: {}, expectations: null, rerun: [], carried: [], reasons: {}, routes: true, mutants: true,
      security: { rerun: true, why: 'a full round', paths: [], from: { round: 1, head: SHA2 } }, history: { 'ch:2': 1 }, carry: null,
    });
    assert.deepEqual(roundLines(p), ['round 1: full — round 1', `history: ch:2 failed in 1 earlier round(s); at ${ROUND_CAP} the verdict is NEEDS YOU (round cap)`]);
  });
});

// ── carried rows into a run's results ─────────────────────────────────────────

describe('carryInto', () => {
  const ran = () => ({
    mode: 'diff', slug: 'feat-x', head: { sha: SHA2 }, routes: null, mutants: null,
    expectations: [{ id: 'exp:e-beta', viewport: 'desktop', name: 'e-beta', result: 'met', detail: '1 of 1 right' }], tests: [], docs: [],
  });

  test('an incremental round: the carried rows join the results, each saying carried from <sha12> (round n); the run\'s own rows are never doubled', () => {
    const p = plan();
    p.carry.expectations.push({ id: 'exp:e-beta', viewport: 'desktop', name: 'e-beta', result: 'NOT MET', detail: 'old', carried: { round: 1, sha: SHA1, detail: 'old' } });
    const r = carryInto(ran(), p, { entries: { beta: 'k' }, qa: QA });
    assert.deepEqual(r.expectations.map((e) => e.id), ['exp:e-beta', 'exp:e-alpha', 'exp:r-api', 'exp:t-unit', 'exp:t-cov', 'exp:d-guide']);
    assert.equal(r.expectations[0].detail, '1 of 1 right');
    assert.equal(r.expectations[1].detail, '1 element(s): 1 right — carried from 111111111111 (round 1)');
    assert.deepEqual(r.expectations[1].carried, { round: 1, sha: SHA1, detail: '1 element(s): 1 right' });
    assert.deepEqual(r.tests.map((t) => [t.name, t.carried.sha]), [['t-unit', SHA1], ['t-cov', SHA1]]);
    assert.deepEqual(r.docs.map((t) => t.name), ['d-guide']);
    assert.deepEqual(r.routes, { ...ROUTES, carried: { round: 1, sha: SHA1 } });
    assert.equal(r.round.n, 2);
    assert.equal(r.round.of, 'incremental');
    assert.deepEqual(r.round.entries, { beta: 'k' });
    assert.deepEqual(r.round.qa, QA);
    assert.deepEqual(r.round.screens, ['beta']);
    assert.equal(r.round.criteria[0].detail, 'exp:e-alpha met — carried from 111111111111 (round 1)');
    assert.equal(r.round.carry, undefined, 'the payload is merged, not kept');
  });

  test('a full round only adds the round to the results; no round plan leaves them as they are', () => {
    const p = plan({ n: 1, prev: null });
    const r = carryInto(ran(), p, { entries: { beta: 'k' }, qa: QA });
    assert.deepEqual(r.expectations, ran().expectations);
    assert.deepEqual(r.round, { n: 1, of: 'full', why: 'round 1', from: null, screens: null, rerun: [], carried: [], history: {}, security: p.security, criteria: [], entries: { beta: 'k' }, qa: QA });
    assert.deepEqual(carryInto(ran(), null, {}), ran());
  });
});

// ── the record of each round, and the cap ─────────────────────────────────────

describe('rounds.json and the cap history', () => {
  test('roundRecord: one row per Criteria row, pinned to the sha its evidence ran on', () => {
    const roundJson = { round: 2, head: SHA2, spec: 'spec1', of: 'incremental', security: { from: { round: 1, head: SHA1 } }, carry: { criteria: [{ id: 'ch:1', sha: SHA1, round: 1 }] } };
    const results = prevResults({ head: { sha: SHA2 } });
    results.expectations[0] = { ...results.expectations[0], carried: { round: 1, sha: SHA1, detail: 'x' } };
    const md = PREV_MD.replace(`head: ${SHA1}`, `head: ${SHA2}`);
    const rec = roundRecord({ verdict: parseVerdict(md), roundJson, results, last: 1, at: '2026-11-12T00:00:00.000Z' });
    assert.equal(rec.round, 2);
    assert.equal(rec.head, SHA2);
    assert.equal(rec.base, BASE);
    assert.equal(rec.spec, 'spec1');
    assert.equal(rec.of, 'incremental');
    assert.equal(rec.outcome, 'REJECT');
    assert.deepEqual(rec.security, { round: 1, head: SHA1 });
    assert.deepEqual(rec.rows.slice(0, 2), [{ id: 'exp:e-alpha', status: 'PASS', sha: SHA1, round: 1 }, { id: 'exp:e-beta', status: 'FAIL', sha: SHA2, round: 2 }]);
    assert.deepEqual(rec.rows.find((r) => r.id === 'ch:1'), { id: 'ch:1', status: 'PASS', sha: SHA1, round: 1 });
    assert.deepEqual(rec.rows.find((r) => r.id === 'ch:2'), { id: 'ch:2', status: 'FAIL', sha: SHA2, round: 2 });
    const bare = roundRecord({ verdict: parseVerdict(PREV_MD), roundJson: null, results: null, last: 4, at: 'x' });
    assert.equal(bare.round, 5);
    assert.equal(bare.spec, null);
    assert.equal(bare.of, 'full');
  });

  test('recordRound replaces the record of the same head, else appends, in round order', () => {
    const doc = recordRound({ rounds: [] }, { round: 1, head: SHA1, outcome: 'BLOCKED', rows: [] });
    const again = recordRound(doc, { round: 1, head: SHA1, outcome: 'REJECT', rows: [] });
    assert.deepEqual(again.rounds.map((r) => r.outcome), ['REJECT']);
    const two = recordRound(again, { round: 2, head: SHA2, outcome: 'REJECT', rows: [] });
    assert.deepEqual(two.rounds.map((r) => r.round), [1, 2]);
    assert.deepEqual(recordRound(null, { round: 1, head: SHA1, rows: [] }).rounds.length, 1);
  });

  test('capHistory counts the rounds a row FAILed in, under the same spec only', () => {
    const rounds = [
      { round: 1, spec: 'spec1', rows: [{ id: 'ch:2', status: 'FAIL' }, { id: 'ch:1', status: 'PASS' }] },
      { round: 2, spec: 'spec1', rows: [{ id: 'ch:2', status: 'FAIL' }, { id: 'ch:1', status: 'FAIL' }] },
      { round: 3, spec: 'spec0', rows: [{ id: 'ch:2', status: 'FAIL' }] },
      { round: 4, spec: null, rows: [{ id: 'ch:3', status: 'FAIL' }, { id: 'ch:2', status: 'WAIVED' }] },
    ];
    assert.deepEqual(capHistory(rounds, 'spec1'), { 'ch:2': 2, 'ch:1': 1, 'ch:3': 1 });
    assert.deepEqual(capHistory(rounds, 'spec9'), { 'ch:3': 1 }, 'a changed spec clears the count');
    assert.deepEqual(capHistory([], 'spec1'), {});
    assert.deepEqual(capHistory(rounds, 'spec1', new Set(['ch:2'])), { 'ch:2': 2 }, 'only the rows that decide, when named');
  });
});

// ── the draft and the gate: carried rows and the cap ──────────────────────────

function results(over = {}) {
  return {
    version: 1, mode: 'diff', slug: 'feat-x', exit: 0,
    head: { sha: SHA3, ref: 'HEAD' }, base: { sha: BASE, ref: 'main', cached: true },
    maps: { head: 'c'.repeat(64), base: 'd'.repeat(64) },
    sandboxes: { base: null, head: null }, steps: [], warnings: [], blocked: null, compareError: null, mapErrors: 0,
    failures: [], notRun: [], screens: [], expectations: [], unexpected: [],
    tour: { opened: 0, failed: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [], standing: 0 },
    checks: { new: [], standing: 0, fixed: 0 }, console: { new: [], standing: 0 },
    eyes: [], routes: null, mutants: null, tests: [], docs: [], livedIn: null, metrics: null,
    standing: { checks: 0, tour: 0, console: 0, file: null, added: 0 }, identical: null, report: null, compare: null,
    ...over,
  };
}
const ex = (name, result) => ({ id: `exp:${name}`, viewport: 'desktop', name, result, detail: `${name} detail` });
const CAP_CHARTER = `# Charter — feat-x
security: no — none

- [ch:1] one shows — by: expectation one
- [ch:2] two shows — by: expectation two
`;
const CAP_TEXT = `Round cap: ch:2 rejected ${ROUND_CAP} times — the user decides (fix differently, change the spec, or waive)`;

describe('the round cap', () => {
  test(`ROUND_CAP is ${3}; decide: a FAIL whose row failed in ROUND_CAP - 1 earlier rounds is capped, open, never a REJECT`, () => {
    assert.equal(ROUND_CAP, 3);
    const rows = [{ id: 'ch:1', status: 'PASS' }, { id: 'ch:2', status: 'FAIL' }];
    const charter = parseCharter(CAP_CHARTER);
    assert.equal(decide({ rows, charter, history: { 'ch:2': 1 } }).outcome, 'REJECT');
    const capped = decide({ rows, charter, history: { 'ch:2': 2 } });
    assert.equal(capped.outcome, 'NEEDS YOU');
    assert.deepEqual(capped.capped, ['ch:2']);
    assert.deepEqual(capped.fail, []);
    assert.deepEqual(capped.open, ['ch:2']);
    assert.deepEqual(decide({ rows, charter }).capped, []);
  });

  test('round 3 of a criterion REJECTed twice: the draft is NEEDS YOU with the Round cap gap row', () => {
    const r = results({ expectations: [ex('one', 'met'), ex('two', 'NOT MET')], round: { n: 3, history: { 'ch:2': 2 } } });
    const d = draftVerdict(r, { charterMd: CAP_CHARTER });
    assert.equal(d.verdict, 'NEEDS YOU');
    assert.match(d.md, new RegExp(`^## Gaps\\n- \\[gap:cap\\] ${CAP_TEXT.replace(/[()]/g, '\\$&')}$`, 'm'));
    assert.deepEqual(d.gaps[0], { id: 'gap:cap', text: CAP_TEXT });
  });

  test('the cap is per criterion: another criterion failing for the first time still REJECTs, and the gap names only the capped one', () => {
    const r = results({ expectations: [ex('one', 'NOT MET'), ex('two', 'NOT MET')], round: { n: 3, history: { 'ch:2': 2 } } });
    const d = draftVerdict(r, { charterMd: CAP_CHARTER });
    assert.equal(d.verdict, 'REJECT');
    assert.deepEqual(d.gaps.find((g) => g.id === 'gap:cap'), { id: 'gap:cap', text: CAP_TEXT });
  });

  test('round 2 (one earlier FAIL) is still a REJECT with no cap row; a waiver clears the cap', () => {
    const two = draftVerdict(results({ expectations: [ex('one', 'met'), ex('two', 'NOT MET')], round: { n: 2, history: { 'ch:2': 1 } } }), { charterMd: CAP_CHARTER });
    assert.equal(two.verdict, 'REJECT');
    assert.ok(!two.gaps.some((g) => g.id === 'gap:cap'));
    const waived = draftVerdict(results({ expectations: [ex('one', 'met'), ex('two', 'NOT MET')], round: { n: 3, history: { 'ch:2': 2 } } }), {
      charterMd: CAP_CHARTER, waiversMd: '- [ch:2] waived: the old wording stands (user, 2026-11-12)\n- [exp:two] waived: same (user, 2026-11-12)\n',
    });
    assert.equal(waived.verdict, 'ACCEPT');
    assert.ok(!waived.gaps.some((g) => g.id === 'gap:cap'));
  });

  test('verdictOutcome reads the cap from results.round; applyWaivers drops the cap row once a waiver clears it', () => {
    const r = results({ expectations: [ex('one', 'met'), ex('two', 'NOT MET')], round: { n: 3, history: { 'ch:2': 2 } } });
    const judge = draftVerdict(r, { charterMd: CAP_CHARTER }).md
      .replace(/^draft: .*\n/m, '')
      .replace('- [exp:two] FAIL — two: two detail', '- [exp:two] FAIL — two: two detail\n- [ch:1] PASS — one shows: exp:one met\n- [ch:2] FAIL — two shows: exp:two NOT MET');
    assert.equal(verdictOutcome({ verdictMd: judge, results: r, charterMd: CAP_CHARTER }).outcome, 'NEEDS YOU');
    const w = applyWaivers({ verdictMd: judge, results: r, charterMd: CAP_CHARTER, waiversMd: '- [ch:2] waived: fine as it is (user, 2026-11-12)\n' });
    assert.ok(!w.md.includes('[gap:cap]'), w.md);
    assert.equal(w.md.split('\n')[0], '# ACCEPT — feat-x');
  });

  test('carried charter rows from results.round are Criteria rows of the draft, verbatim, counted and deciding; a blocked run leaves them as they are', () => {
    const carried = [{ id: 'ch:1', status: 'PASS', name: 'one shows', detail: 'exp:one met — carried from 111111111111 (round 1)', sha: SHA1, round: 1 }];
    const r = results({ expectations: [ex('two', 'met'), { ...ex('one', 'met'), detail: 'one detail — carried from 111111111111 (round 1)' }], round: { n: 2, criteria: carried } });
    const d = draftVerdict(r, { charterMd: CAP_CHARTER });
    assert.match(d.md, /^- \[ch:1\] PASS — one shows: exp:one met — carried from 111111111111 \(round 1\)$/m);
    assert.match(d.md, /^- \[exp:one\] PASS — one: one detail — carried from 111111111111 \(round 1\)$/m);
    assert.equal(d.criteria.pass, 3);
    assert.equal(d.verdict, 'ACCEPT');
    const blocked = draftVerdict(results({ blocked: 'BLOCKED ON INFRASTRUCTURE: head: x', round: { n: 2, criteria: carried } }), { charterMd: CAP_CHARTER });
    assert.match(blocked.md, /^- \[ch:1\] PASS — one shows: exp:one met — carried from 111111111111 \(round 1\)$/m);
    assert.match(blocked.md, /^- \[ch:2\] BLOCKED — two shows: not checked: BLOCKED ON INFRASTRUCTURE: head: x$/m);
    assert.ok(!/^- \[ch:1\] BLOCKED/m.test(blocked.md));
  });

  test('Notes say which round this is and where the carried rows come from', () => {
    const r = results({ expectations: [ex('one', 'met')], round: { n: 2, of: 'incremental', from: { round: 1, head: SHA1 }, screens: ['beta'], rerun: ['exp:one'], carried: ['ch:1', 'exp:x'], security: { rerun: false, why: 'w', from: { round: 1, head: SHA1 } } } });
    const md = draftVerdict(r, { charterMd: CAP_CHARTER }).md;
    assert.match(md, /^- round 2: incremental from round 1 \(111111111111\): 1 row\(s\) re-run, 2 carried \(each says carried from <sha>\); 1 screen\(s\) walked$/m);
    assert.match(md, /^- security: carried from round 1 \(111111111111\): w$/m);
    const full = draftVerdict(results({ expectations: [ex('one', 'met')], round: { n: 1, of: 'full', why: 'round 1' } }), { charterMd: CAP_CHARTER }).md;
    assert.match(full, /^- round 1: full — round 1$/m);
  });
});
