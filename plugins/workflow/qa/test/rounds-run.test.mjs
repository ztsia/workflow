// Contract tests for runQa's side of rounds (rework U8; run.mjs 'ROUNDS'): with an incremental V/round.json for its head,
// the run walks only the round's screens, runs only its re-run rows, skips the sweep and the mutants the round carries,
// and writes the carried rows into results.json and the draft ('carried from <sha12> (round n)'). A round.json for
// another head is ignored. Fakes stand in for the sandbox, capture and compare (as test/scope.test.mjs does); the repo
// is a small neutral one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { loadMap, selectScreens } from '../scripts/lib/map.mjs';
import { runQa } from '../scripts/lib/run.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const tmpDir = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
const write = (dir, rel, value) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const SHA1 = '1'.repeat(40);
const PROFILE = { map: 'qa/map', seedNames: 'qa/seed.json', viewports: { desktop: [1280, 800] }, clock: 'off', run: { cacheKeep: 5 }, sandbox: { retryWaitMs: 1 } };

// main: the map (alpha on src/a, beta on src/b) and both sources; feat/x changes both, so both are affected against base.
function makeRepo() {
  const dir = tmpDir('mfqa-rounds-run-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(dir, '.gitignore', 'qa-artifacts/\n');
  write(dir, 'qa/map/app.json', { screens: [
    { name: 'alpha', sources: ['src/a.ts'], steps: [{ goto: '/alpha' }] },
    { name: 'beta', sources: ['src/b.ts'], steps: [{ goto: '/beta' }] },
  ] });
  write(dir, 'src/a.ts', 'a1\n');
  write(dir, 'src/b.ts', 'b1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'feat/x');
  write(dir, 'src/a.ts', 'a2\n');
  write(dir, 'src/b.ts', 'b2\n');
  git(dir, 'commit', '-qam', 'two');
  const head = git(dir, 'rev-parse', 'HEAD');
  const V = path.join(dir, 'qa', 'x');
  write(V, 'expectations.json', [
    { name: 'e-alpha', criterion: 'ch:1', screens: 'alpha', text: 'A' },
    { name: 'e-beta', criterion: 'ch:2', screens: 'beta', text: 'B' },
    { name: 't-unit', criterion: 'ch:3', test: { suite: 'unit', grep: 'holds', file: 'test/x.test.ts' } },
  ]);
  write(V, 'charter.md', '# Charter — x\nsecurity: no — none\n\n- [ch:1] alpha shows A — by: expectation e-alpha\n- [ch:2] beta shows B — by: expectation e-beta\n- [ch:3] the rule holds — by: expectation t-unit\n');
  return { dir, base, head, V };
}

function incremental(head) {
  return {
    round: 2, head, base: null, spec: null, of: 'incremental', why: 'after round 1', from: { round: 1, head: SHA1 }, changed: ['src/b.ts'],
    screens: ['beta'], screensWhy: { beta: 'for exp:e-beta' }, expectations: ['e-beta'], rerun: ['exp:e-beta', 'ch:2'],
    carried: ['exp:e-alpha', 'exp:t-unit', 'ch:1', 'ch:3'], reasons: {}, routes: false, mutants: false,
    security: { rerun: false, why: 'nothing sensitive', paths: [], from: { round: 1, head: SHA1 } }, history: { 'ch:2': 1 },
    carry: {
      criteria: [
        { id: 'ch:1', status: 'PASS', name: 'alpha shows A', detail: 'exp:e-alpha met', sha: SHA1, round: 1 },
        { id: 'ch:3', status: 'PASS', name: 'the rule holds', detail: 'exp:t-unit met', sha: SHA1, round: 1 },
      ],
      expectations: [
        { id: 'exp:e-alpha', viewport: 'desktop', name: 'e-alpha', result: 'met', detail: '1 of 1 right', carried: { round: 1, sha: SHA1, detail: '1 of 1 right' } },
        { id: 'exp:t-unit', viewport: null, name: 't-unit', result: 'met', detail: 'unit "holds": 1 passed', carried: { round: 1, sha: SHA1, detail: 'unit "holds": 1 passed' } },
      ],
      tests: [{ id: 'exp:t-unit', name: 't-unit', criterion: 'ch:3', result: 'met', detail: 'unit "holds": 1 passed', carried: { round: 1, sha: SHA1, detail: 'unit "holds": 1 passed' } }],
      docs: [], routes: null, mutants: null,
    },
  };
}

function fakes(dir) {
  const calls = { capture: [], expect: [], tests: 0, sweeps: 0, mutate: 0 };
  const deps = {
    up: async (req) => ({ name: `qa-${req.at.slice(0, 10)}`, slug: 'x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null }),
    down: async () => ({ warnings: [] }),
    captureSide: async (req) => {
      const map = loadMap({ root: req.cwd, profile: req.profile });
      const picked = selectScreens(map.screens, { only: req.screens });
      calls.capture.push({ base: req.out.includes(`${path.sep}.tmp-`) || req.out.endsWith(`${path.sep}base`), screens: picked.map((s) => s.name) });
      for (const s of picked) write(req.out, `desktop/${s.name}__default.json`, { screen: s.name });
      return { viewports: [{ viewport: 'desktop', captured: picked.map((s) => `${s.name}__default`), failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: 'off' }, mapErrors: [], ms: 1 };
    },
    compare: async (req) => {
      fs.mkdirSync(req.out, { recursive: true });
      const list = req.expect ? JSON.parse(fs.readFileSync(req.expect, 'utf8')) : [];
      calls.expect.push(list.map((e) => e.name));
      const expectations = list.filter((e) => e.screens).map((e) => ({ name: e.name, result: 'met', detail: '1 of 1 right' }));
      return { exit: 0, viewports: [{ viewport: 'desktop', exit: 0, pairs: [], expectations, unexpected: [], overflow: [], inconclusive: [], eyes: [], standing: { checks: 0, tour: 0, console: 0 } }] };
    },
    sweepSide: async () => { calls.sweeps += 1; return { file: null, rows: 0, registered: null, probes: [], unlisted: [], stale: [], errors: [], notRun: 'no route table', expectations: [] }; },
    runTests: async ({ entries }) => {
      calls.tests += 1;
      return entries.map((e) => ({ id: `exp:${e.name}`, name: e.name, criterion: e.criterion, result: 'met', detail: 'ran', counts: { total: 1, matched: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 } }));
    },
    runVerb: async () => ({ notRun: 'none' }),
    mutate: async () => { calls.mutate += 1; return { selected: 0, result: null }; },
    readiness: () => ({ state: 'ready', line: null }),
    sleep: async () => {},
  };
  return { deps, calls };
}

const opts = (r, over = {}) => ({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, base: r.base, slug: 'x', log: () => {}, mutants: 'named', ...over });

describe('runQa with a round plan', () => {
  test('an incremental round walks only its screens, runs only its re-run rows, and carries the rest into results and the draft', async () => {
    const r = makeRepo();
    const f = fakes(r.dir);
    const run = await runQa(opts(r, { round: incremental(r.head) }), f.deps);
    assert.deepEqual(f.calls.capture.filter((c) => !c.base).map((c) => c.screens), [['beta']], 'head walks beta only');
    assert.ok(f.calls.capture.filter((c) => c.base).every((c) => c.screens.every((s) => s === 'beta')), 'base walks beta only');
    assert.deepEqual(f.calls.expect, [['e-beta']], 'compare sees only the re-run expectations');
    assert.equal(f.calls.tests, 0, 'no test row re-runs');
    assert.equal(f.calls.sweeps, 0, 'the round carries the sweep');
    assert.equal(f.calls.mutate, 0, 'the round carries the mutants');
    assert.deepEqual(run.affected.names, ['beta']);
    const res = run.results;
    assert.deepEqual(res.expectations.map((e) => e.id), ['exp:e-beta', 'exp:e-alpha', 'exp:t-unit']);
    assert.equal(res.expectations[1].detail, '1 of 1 right — carried from 111111111111 (round 1)');
    assert.deepEqual(res.tests.map((t) => t.name), ['t-unit']);
    assert.equal(res.round.n, 2);
    assert.equal(res.round.of, 'incremental');
    assert.deepEqual(res.round.history, { 'ch:2': 1 });
    assert.deepEqual(Object.keys(res.round.entries), ['alpha', 'beta']);
    assert.ok(res.round.qa && typeof res.round.qa.profile === 'string');
    const saved = JSON.parse(fs.readFileSync(path.join(r.V, 'results.json'), 'utf8'));
    assert.equal(saved.round.n, 2);
    const draft = fs.readFileSync(path.join(r.V, 'verdict.draft.md'), 'utf8');
    assert.match(draft, /^- \[exp:e-alpha\] PASS — e-alpha: 1 of 1 right — carried from 111111111111 \(round 1\)$/m);
    assert.match(draft, /^- \[ch:1\] PASS — alpha shows A: exp:e-alpha met — carried from 111111111111 \(round 1\)$/m);
    assert.match(draft, /^- \[exp:e-beta\] PASS — e-beta: 1 of 1 right$/m);
    assert.match(draft, /^- round 2: incremental from round 1 \(111111111111\): 2 row\(s\) re-run, 4 carried/m);
  });

  test('an incremental round walks only screens in the PR\'s scope: a round screen the affected set does not hold is not walked', async () => {
    const r = makeRepo();
    // gamma: a shared entry no change of this PR touches (another PR's, promoted into the map on disk).
    write(r.dir, 'qa/map/other.json', { screens: [{ name: 'gamma', sources: ['src/g.ts'], steps: [{ goto: '/gamma' }] }] });
    const f = fakes(r.dir);
    const round = { ...incremental(r.head), screens: ['beta', 'gamma'], screensWhy: { beta: 'for exp:e-beta', gamma: 'new entry' } };
    const run = await runQa(opts(r, { round, map: path.join(r.dir, 'qa', 'map') }), f.deps);
    assert.deepEqual(f.calls.capture.filter((c) => !c.base).map((c) => c.screens), [['beta']]);
    assert.deepEqual(run.affected.names, ['beta']);
  });

  test('a full round whose review did not run moves an earlier security.md to prev/ (no earlier High drafts a Blocker); this round\'s, or an incremental round\'s, stays', async () => {
    const HIGH = '# Security — x\n- High [sec:1] the session token is written to the log — src/a.ts:1\n';
    const full = (head) => ({ round: 2, head, of: 'full', why: '--full', from: null, screens: null, rerun: [], carried: [], history: {}, security: { rerun: true, why: 'a full round', paths: [], from: { round: 2, head } }, carry: null });
    const aged = (file) => { const t = new Date(Date.now() - 3600_000); fs.utimesSync(file, t, t); };
    // An earlier round's review: older than this round's plan.
    let r = makeRepo();
    write(r.V, 'security.md', HIGH);
    aged(path.join(r.V, 'security.md'));
    write(r.V, 'round.json', full(r.head));
    await runQa(opts(r, { round: full(r.head) }), fakes(r.dir).deps);
    assert.ok(!fs.existsSync(path.join(r.V, 'security.md')), 'it left V');
    assert.equal(fs.readFileSync(path.join(r.V, 'prev', 'security.md'), 'utf8'), HIGH);
    assert.doesNotMatch(fs.readFileSync(path.join(r.V, 'verdict.draft.md'), 'utf8'), /\[sec:1\]/);
    // This round's review (written after the plan): it stays and its High is a Blocker.
    r = makeRepo();
    write(r.V, 'round.json', full(r.head));
    aged(path.join(r.V, 'round.json'));
    write(r.V, 'security.md', HIGH);
    await runQa(opts(r, { round: full(r.head) }), fakes(r.dir).deps);
    assert.ok(fs.existsSync(path.join(r.V, 'security.md')));
    assert.match(fs.readFileSync(path.join(r.V, 'verdict.draft.md'), 'utf8'), /^- Blocker \[sec:1\]/m);
    // An incremental round carries the last review.
    r = makeRepo();
    write(r.V, 'security.md', HIGH);
    aged(path.join(r.V, 'security.md'));
    write(r.V, 'round.json', incremental(r.head));
    await runQa(opts(r, { round: incremental(r.head) }), fakes(r.dir).deps);
    assert.ok(fs.existsSync(path.join(r.V, 'security.md')));
    assert.match(fs.readFileSync(path.join(r.V, 'verdict.draft.md'), 'utf8'), /^- Blocker \[sec:1\]/m);
  });

  test('a round plan for another head is ignored: the run walks the affected set and runs every row', async () => {
    const r = makeRepo();
    const f = fakes(r.dir);
    const run = await runQa(opts(r, { round: incremental('9'.repeat(40)) }), f.deps);
    assert.deepEqual(f.calls.capture.filter((c) => !c.base).map((c) => c.screens), [['alpha', 'beta']]);
    assert.deepEqual(f.calls.expect, [['e-alpha', 'e-beta', 't-unit']]);
    assert.equal(f.calls.tests, 1);
    assert.equal(run.results.round, undefined);
  });

  test('a full round for this head runs as before and records the round, its map entries and QA hashes', async () => {
    const r = makeRepo();
    const f = fakes(r.dir);
    const full = { round: 1, head: r.head, of: 'full', why: 'round 1', from: null, screens: null, rerun: [], carried: [], history: {}, security: { rerun: true, why: 'a full round', paths: [], from: { round: 1, head: r.head } }, carry: null };
    const run = await runQa(opts(r, { round: full }), f.deps);
    assert.deepEqual(f.calls.capture.filter((c) => !c.base).map((c) => c.screens), [['alpha', 'beta']]);
    assert.equal(f.calls.tests, 1);
    assert.equal(run.results.round.n, 1);
    assert.equal(run.results.round.of, 'full');
    assert.deepEqual(Object.keys(run.results.round.entries), ['alpha', 'beta']);
    assert.match(fs.readFileSync(path.join(r.V, 'verdict.draft.md'), 'utf8'), /^- round 1: full — round 1$/m);
  });
});
