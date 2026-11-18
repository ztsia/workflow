// Contract tests for scripts/lib/run.mjs. The contract is the comment block at the top of that file;
// each test pins one clause of it. Every expensive dependency (sandbox up and down, capture, compare,
// sleep, the clock) is an injected fake that records its calls. Each runQa test builds its own temp
// git repo, so the tests stand alone and run in any order. Until run.mjs is built, every test fails
// with 'not built: …'.
//
// The fixture branch is 'feat/x+y', not 'feat/x y': git refuses a space in a ref name. The slug rule
// turns '+' into '-', so the slug is still 'feat-x-y'.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { affectedScreens } from '../scripts/lib/affected.mjs';
import { PREV_FILES, RunError, mapHash, resolveClock, rotatePrev, routeActors, runQa } from '../scripts/lib/run.mjs';
import { SandboxError } from '../scripts/lib/sandbox.mjs';
import { standingId, standingItems } from '../scripts/lib/standing.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const SEED_AT = '2026-11-06T00:00:00.000Z';
const APP_URL = 'http://127.0.0.1:1';
// home's sources name a.txt, which every commit of the fixture changes: it is affected (rework U4: a screen with no
// known sources is out of scope and never walked).
const MAP_APP = '{"screens":[{"name":"home","sources":["a.txt"],"steps":[{"goto":"/"}]}]}\n';
const made = [];

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function tmpDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

// Commit 1 (main) adds the map and a.txt; commit 2 (main) changes a.txt; commit 3 is on 'feat/x+y'
// and changes a.txt. merge-base(head, main) = commit 2.
function makeRepo() {
  const dir = tmpDir('mfqa-run-');
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  fs.mkdirSync(path.join(dir, 'qa', 'map'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa', 'map', 'app.json'), MAP_APP);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  const sha1 = commitAll(dir, 'one');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const sha2 = commitAll(dir, 'two');
  git(['checkout', '-q', '-b', 'feat/x+y'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  const sha3 = commitAll(dir, 'three');
  return { dir, sha1, sha2, sha3 };
}

function profile(over = {}) {
  return {
    map: 'qa/map', seedNames: 'qa/seed.json', base: 'sandbox', viewports: { desktop: [1440, 900] },
    clock: 'seed', checks: { enabled: true }, tour: { enabled: true },
    sandbox: { max: 3, retryWaitMs: 15000 }, run: { cacheKeep: 5 }, volatile: [], ...over,
  };
}

function runOpts(repo, over = {}) {
  return { mainRoot: repo.dir, repoRoot: repo.dir, profile: profile(), log: () => {}, ...over };
}

const nameOf = (sha) => 'qa-' + sha.slice(0, 10);

function descriptor(at, dir, reused = false) {
  const d = { name: nameOf(at), slug: nameOf(at), dir, port: 1, appUrl: APP_URL, seedStartedAt: SEED_AT, sha: at };
  if (reused) d.reused = true;
  return d;
}

// A SideResult (the brief's shape) with configurable failed and notRun entries.
function sideResult({ failed = [], notRun = [] } = {}) {
  return {
    viewports: [{ viewport: 'desktop', captured: ['home__default'], failed, notRun, warnings: [] }],
    clock: { clock: null, why: 'real clock (off)' }, mapErrors: [], ms: 1,
  };
}
const FAILED = [{ screen: 'home', step: 0, error: 'boom' }];
const NOT_RUN = [{ screen: 'home', why: 'no route' }];

const pairDetail = {
  key: 'detail__default', status: 'changed',
  before: { screen: 'detail' }, after: { screen: 'detail' },
  elements: [{ k: 'Title#1', status: 'changed' }, { k: 'Badge#1', status: 'same' }],
  tree: { same: false, added: [{ n: 4, line: 'heading "New title" [level=1]' }, { n: 9, line: 'button "Archive"' }],
          removed: [{ n: 4, line: 'heading "Old title" [level=1]' }], truncated: false, explained: [], masked: 0 },
  pixel: { ratio: 0.024, worstTile: 0.031, sameSize: true, changed: true },
  checks: { new: [{ check: 'contrast', detail: 'span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1' }],
            standing: [{ check: 'target', detail: 'button "x" is 20×20 px, needs 24 px' }], fixed: [] },
  tour: { opened: 3, failed: 0, hover: 10, hoverSilent: 2,
          new: ['listbox "Status" 200×240 cut off by div.card'], standing: ['menu "Columns" 180×300 runs past the top of the screen'], fixed: [] },
  console: { new: ['TypeError: x is undefined'], standing: [] },
};
const pairList = {
  key: 'list__default', status: 'same', before: { screen: 'list' }, after: { screen: 'list' },
  elements: [], tree: { same: true, added: [], removed: [], truncated: false, explained: [], masked: 0 },
  pixel: { ratio: 0, worstTile: 0, sameSize: true, changed: false },
  checks: { new: [], standing: [], fixed: [] }, tour: { opened: 1, failed: 0, hover: 4, hoverSilent: 0, new: [], standing: [], fixed: [] },
  console: { new: [], standing: [] },
};
// compare()'s result with one new problem on each axis (exit 1).
const BRIEF_COMPARE = { exit: 1, viewports: [{
  viewport: 'desktop', exit: 1, pairs: [pairDetail, pairList],
  expectations: [{ name: 'title-renamed', describe: '…', result: 'met', detail: '1 element(s): 1 right' }],
  unexpected: [{ key: 'detail__default', kind: 'tree', added: ['heading "New title" [level=1]', 'button "Archive"'], removed: [] }],
  overflow: [], inconclusive: [], eyes: ['detail__default'], standing: { checks: 1, tour: 1, console: 0 } }] };
// compare()'s result with nothing new anywhere (a clean pass at exit 0).
const CLEAN_VIEWPORT = {
  viewport: 'desktop', exit: 0, pairs: [pairList], expectations: [], unexpected: [], overflow: [],
  inconclusive: [], eyes: [], standing: { checks: 0, tour: 0, console: 0 },
};
function compareWith(exit) {
  if (exit === 1) return structuredClone(BRIEF_COMPARE);
  return { exit, viewports: [{ ...CLEAN_VIEWPORT, exit }] };
}

// Fakes for every expensive dependency. Every call is recorded in calls.<name>.
//   upError(at, attempt) -> Error | null     the error an up() call throws (attempt counts per SHA)
//   reused(at) -> boolean                    whether up() returns a descriptor with reused: true
//   sideFor(req) -> SideResult               what captureSide() returns for a call
//   compareExit                              the exit of compare()'s result (default 1)
function fakes(repo, o = {}) {
  const calls = { up: [], down: [], captureSide: [], compare: [], sleep: [] };
  const attempts = {};
  const deps = {
    async up(req) {
      calls.up.push(req);
      attempts[req.at] = (attempts[req.at] ?? 0) + 1;
      const error = o.upError?.(req.at, attempts[req.at]);
      if (error) throw error;
      return descriptor(req.at, repo, o.reused?.(req.at) === true);
    },
    async down(req) {
      calls.down.push(req);
      return { name: req.name, warnings: [] };
    },
    async captureSide(req) {
      calls.captureSide.push(req);
      fs.mkdirSync(path.join(req.out, 'desktop'), { recursive: true });
      fs.writeFileSync(path.join(req.out, 'desktop', 'home__default.json'), '{}\n');
      if (req.log) req.log(`capture ${path.basename(req.out)}`);
      return structuredClone(o.sideFor ? o.sideFor(req) : sideResult());
    },
    async compare(req) {
      calls.compare.push(req);
      fs.mkdirSync(req.out, { recursive: true });
      fs.writeFileSync(path.join(req.out, 'results.json'), '{}\n');
      return compareWith(o.compareExit ?? 1);
    },
    sleep: async (ms) => { calls.sleep.push(ms); },
    now: () => new Date('2026-11-06T10:00:00Z'),
  };
  return { deps, calls };
}

const blocked = () => new SandboxError('BLOCKED', 'BLOCKED ON INFRASTRUCTURE: up: x');

async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to reject, but it resolved');
}

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw, but it returned');
}

function findNamed(dir, name) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findNamed(p, name));
    else if (entry.name === name) found.push(p);
  }
  return found;
}

// ── R1: resolveClock ──────────────────────────────────────────────────────────

test('R1a resolveClock: off is the real clock', () => {
  const r = resolveClock('off', SEED_AT);
  assert.equal(r.clock, null);
  assert.equal(r.why, 'real clock (off)');
});

test('R1b resolveClock: seed freezes at the seed start', () => {
  const r = resolveClock('seed', SEED_AT);
  assert.equal(r.clock, SEED_AT);
  assert.match(r.why, /seed start/);
});

test('R1c resolveClock: seed with no seed start known is the real clock', () => {
  assert.equal(resolveClock('seed', null).clock, null);
});

test('R1d resolveClock: no want behaves as seed', () => {
  assert.equal(resolveClock(null, SEED_AT).clock, SEED_AT);
});

test('R1e resolveClock: an ISO time freezes there', () => {
  const r = resolveClock('2026-01-01T00:00:00Z', null);
  assert.equal(r.clock, '2026-01-01T00:00:00Z');
  assert.equal(r.why, 'frozen at 2026-01-01T00:00:00Z');
});

test('R1f resolveClock: any other value is a USAGE RunError', () => {
  const error = thrownBy(() => resolveClock('soon', null));
  assert.ok(error instanceof RunError, `expected a RunError, got: ${error.message}`);
  assert.equal(error.code, 'USAGE');
  assert.match(error.message, /clock must be seed, off or an ISO time, not "soon"/);
});

// ── R2: mapHash ───────────────────────────────────────────────────────────────

test('R2a mapHash: 64 hex characters, and the same inputs give the same hash', () => {
  const repo = makeRepo();
  const args = { repoRoot: repo.dir, sha: repo.sha1, profile: profile() };
  const hash = mapHash(args);
  assert.match(hash, HEX64);
  assert.equal(mapHash({ ...args }), hash);
});

test('R2b mapHash: a commit that changes the map at head changes the hash', () => {
  const repo = makeRepo();
  git(['checkout', '-q', '-b', 'map-edit', repo.sha1], repo.dir);
  fs.writeFileSync(path.join(repo.dir, 'qa', 'map', 'app.json'), MAP_APP.replace('home', 'start'));
  const sha4 = commitAll(repo.dir, 'map edit');
  const before = mapHash({ repoRoot: repo.dir, sha: repo.sha1, profile: profile() });
  const after = mapHash({ repoRoot: repo.dir, sha: sha4, profile: profile() });
  assert.notEqual(after, before);
});

test('R2c mapHash: a commit that leaves the map and the seed alone leaves the hash alone', () => {
  // The contract hashes the map files, the seed file, the profile, the plugin and extra. a.txt is none of them.
  const repo = makeRepo();
  assert.equal(
    mapHash({ repoRoot: repo.dir, sha: repo.sha2, profile: profile() }),
    mapHash({ repoRoot: repo.dir, sha: repo.sha1, profile: profile() }),
  );
});

test('R2d mapHash: different extra (the run choices) gives a different hash', () => {
  const repo = makeRepo();
  const withDesktop = mapHash({ repoRoot: repo.dir, sha: repo.sha1, profile: profile(), extra: { viewports: ['desktop'] } });
  const withPhone = mapHash({ repoRoot: repo.dir, sha: repo.sha1, profile: profile(), extra: { viewports: ['phone'] } });
  assert.match(withDesktop, HEX64);
  assert.notEqual(withPhone, withDesktop);
});

test('R2e mapHash: a map directory given on disk is hashed from its bytes', () => {
  const repo = makeRepo();
  const map = tmpDir('mfqa-map-');
  fs.writeFileSync(path.join(map, 'app.json'), MAP_APP);
  const args = { repoRoot: repo.dir, sha: repo.sha1, profile: profile(), map };
  const hash = mapHash(args);
  assert.match(hash, HEX64);
  assert.equal(mapHash({ ...args }), hash);
  fs.writeFileSync(path.join(map, 'app.json'), MAP_APP.replace('home', 'homo'));
  assert.notEqual(mapHash({ ...args }), hash);
});

// ── R3: USAGE ─────────────────────────────────────────────────────────────────

test('R3a runQa: base equal to head is a USAGE RunError that names --self, and nothing starts', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo);
  const error = await errorOf(runQa(runOpts(repo, { base: repo.sha3 }), deps));
  assert.ok(error instanceof RunError, `expected a RunError, got: ${error.message}`);
  assert.equal(error.code, 'USAGE');
  assert.match(error.message, /--self/);
  assert.equal(calls.up.length, 0);
  assert.equal(calls.captureSide.length, 0);
});

test('R3b runQa: an unknown head is a USAGE RunError, and nothing starts', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo);
  const error = await errorOf(runQa(runOpts(repo, { head: 'nope' }), deps));
  assert.ok(error instanceof RunError, `expected a RunError, got: ${error.message}`);
  assert.equal(error.code, 'USAGE');
  assert.match(error.message, /unknown ref nope/);
  assert.equal(calls.up.length, 0);
  assert.equal(calls.captureSide.length, 0);
});

// ── R4: slug and default base ─────────────────────────────────────────────────

test('R4a runQa: the slug is the branch name with unsafe characters made dashes', async () => {
  const repo = makeRepo();
  const run = await runQa(runOpts(repo), fakes(repo).deps);
  assert.equal(run.slug, 'feat-x-y');
});

test('R4b runQa: with no base given, the base is the merge-base with main (commit 2)', async () => {
  const repo = makeRepo();
  const run = await runQa(runOpts(repo), fakes(repo).deps);
  assert.equal(run.base.sha, repo.sha2);
});

test('R4c runQa: the text expectations go to both sides\' capture, and a different text is a different base cache key', async () => {
  const repo = makeRepo();
  const V = path.join(repo.dir, 'qa', 'feat-x-y');
  fs.mkdirSync(V, { recursive: true });
  const write = (entries) => fs.writeFileSync(path.join(V, 'expectations.json'), JSON.stringify(entries));
  write([
    { name: 'badge', screens: 'home', text: 'SALE' },
    { name: 'again', screens: 'home', text: 'SALE' },
    { name: 're', screens: 'home', text: '/^hello@/' },
    { name: 'landing', url: '/cart' },
    { name: 'route', route: 'GET /api/x', as: 'anon', status: 200 },
  ]);
  const first = fakes(repo);
  const run = await runQa(runOpts(repo), first.deps);
  assert.deepEqual(first.calls.captureSide.map((c) => c.expectTexts), [['SALE', '/^hello@/'], ['SALE', '/^hello@/']]);

  write([{ name: 'badge', screens: 'home', text: 'ON SALE' }]);
  const second = fakes(repo);
  const again = await runQa(runOpts(repo), second.deps);
  assert.deepEqual(second.calls.captureSide.at(-1).expectTexts, ['ON SALE']);
  assert.notEqual(again.maps.head, run.maps.head);

  fs.rmSync(path.join(V, 'expectations.json'));
  const none = fakes(repo);
  await runQa(runOpts(repo), none.deps);
  assert.deepEqual(none.calls.captureSide.at(-1).expectTexts, []);
});

// ── R5: diff happy path ───────────────────────────────────────────────────────

test('0.2.0: standing false (run --no-standing) leaves qa/standing.md alone; each sandbox gets the checkout as qaFrom', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo);
  await runQa(runOpts(repo, { standing: false }), deps);
  assert.equal(calls.compare.length, 1, 'compare ran');
  assert.equal(fs.existsSync(path.join(repo.dir, 'qa', 'standing.md')), false, 'qa/standing.md written with standing: false');
  assert.deepEqual(calls.up.map((c) => c.qaFrom), [repo.dir, repo.dir]);
});

test('R5 diff run: base sandbox then head sandbox, compare, the four files, both downs, exit from compare', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo);
  const run = await runQa(runOpts(repo), deps);

  assert.deepEqual(calls.up.map((c) => c.at), [repo.sha2, repo.sha3]);
  assert.deepEqual(calls.captureSide.map((c) => c.baseUrl), [APP_URL, APP_URL]);
  assert.deepEqual(calls.captureSide.map((c) => c.seedStartedAt), [SEED_AT, SEED_AT]);
  assert.equal(calls.compare.length, 1);
  assert.equal(calls.compare[0].afterDir, path.join(repo.dir, 'qa-artifacts', 'runs', 'feat-x-y', 'head'));

  const verification = path.join(repo.dir, 'qa', 'feat-x-y');
  for (const file of ['results.json', 'summary.md', 'verdict.draft.md', 'run.json']) {
    assert.ok(fs.existsSync(path.join(verification, file)), `missing qa/feat-x-y/${file}`);
  }
  assert.ok(fs.existsSync(path.join(repo.dir, 'qa', 'standing.md')), 'missing qa/standing.md');

  assert.deepEqual(calls.down.map((c) => c.name).sort(), [nameOf(repo.sha2), nameOf(repo.sha3)].sort());
  assert.equal(run.exit, 1);
});

// ── R6: base cache ────────────────────────────────────────────────────────────

test('R6 cache: a clean base is cached; the next run reuses it and brings up only head', async () => {
  const repo = makeRepo();
  await runQa(runOpts(repo), fakes(repo).deps);

  const cacheRoot = path.join(repo.dir, 'qa-artifacts', 'cache');
  const pattern = new RegExp(`^base-${repo.sha2.slice(0, 10)}-[0-9a-f]{12}$`);
  const hits = fs.readdirSync(cacheRoot).filter((name) => pattern.test(name));
  assert.equal(hits.length, 1, `expected one base-${repo.sha2.slice(0, 10)}-* cache dir`);
  const cacheDir = path.join(cacheRoot, hits[0]);
  // Rework U4: the cache is kept per screen; the compare reads the run's view of it.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8')).screens.desktop.home.keys, ['home__default']);
  assert.ok(fs.existsSync(path.join(cacheDir, 'desktop', 'home__default.json')), 'the screen\'s files moved into the cache');

  const second = fakes(repo);
  const run = await runQa(runOpts(repo), second.deps);
  assert.deepEqual(second.calls.up.map((c) => c.at), [repo.sha3]);
  assert.equal(run.sandboxes.base.state, 'cached');
  assert.equal(run.base.cached, true);
  const view = path.join(repo.dir, 'qa-artifacts', 'runs', 'feat-x-y', 'base');
  assert.equal(second.calls.compare[0].beforeDir, view);
  assert.ok(fs.existsSync(path.join(view, 'desktop', 'home__default.json')), 'the view holds the cached screen');
});

// ── R7: not clean, not cached ─────────────────────────────────────────────────

test('R7 cache: a base screen that failed is never cached and is compared from the run dir', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo, {
    sideFor: (req) => (path.basename(req.out) === 'base' ? sideResult({ failed: FAILED }) : sideResult()),
  });
  await runQa(runOpts(repo), deps);
  const metas = findNamed(path.join(repo.dir, 'qa-artifacts', 'cache'), 'meta.json');
  assert.equal(metas.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(metas[0], 'utf8')).screens, {}, 'the failed screen has no cache entry');
  assert.equal(calls.compare[0].beforeDir, path.join(repo.dir, 'qa-artifacts', 'runs', 'feat-x-y', 'base'));
  const again = fakes(repo);
  await runQa(runOpts(repo), again.deps);
  assert.deepEqual(again.calls.up.map((c) => c.at), [repo.sha2, repo.sha3], 'a screen that failed on base is walked again');
});

// ── R8: retry and BLOCKED ─────────────────────────────────────────────────────

test('R8 retry: a BLOCKED base up is retried once after the retry wait, and the run goes on', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo, {
    upError: (at, attempt) => (at === repo.sha2 && attempt === 1 ? blocked() : null),
  });
  const run = await runQa(runOpts(repo), deps);
  assert.deepEqual(calls.sleep, [15000]);
  assert.ok(run.steps.some((s) => s.side === 'base' && s.verb === 'up' && s.note === 'retried'), 'no base up step noted retried');
  assert.equal(calls.compare.length, 1);
  assert.equal(run.blocked, null);
});

test('R8 retry: a second BLOCKED blocks the run (exit 4), skips head and compare, and still writes results and summary', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo, { upError: (at) => (at === repo.sha2 ? blocked() : null) });
  const run = await runQa(runOpts(repo), deps);

  assert.equal(run.exit, 4);
  assert.match(run.blocked, /^BLOCKED ON INFRASTRUCTURE: base/);
  assert.deepEqual(calls.sleep, [15000]);
  assert.equal(calls.up.filter((c) => c.at === repo.sha3).length, 0, 'head sandbox was brought up');
  assert.equal(calls.compare.length, 0);
  assert.equal(calls.down.some((c) => c.name === nameOf(repo.sha2)), false, 'base was downed');

  const verification = path.join(repo.dir, 'qa', 'feat-x-y');
  assert.ok(fs.existsSync(path.join(verification, 'results.json')), 'missing results.json');
  assert.ok(fs.existsSync(path.join(verification, 'summary.md')), 'missing summary.md');
});

// ── R9: reused sandboxes ──────────────────────────────────────────────────────

test('R9 reused: a sandbox that was up before the run is never downed by the runner', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo, { reused: (at) => at === repo.sha3 });
  await runQa(runOpts(repo), deps);
  assert.equal(calls.down.some((c) => c.name === nameOf(repo.sha3)), false, 'reused head was downed');
  assert.equal(calls.down.some((c) => c.name === nameOf(repo.sha2)), true, 'base (not reused) was not downed');
});

test('R9 shared (1.0.4): a sandbox the run started is left up, with a warning, while another running run uses it', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo);
  deps.othersUsing = ({ name }) => (name === nameOf(repo.sha2) ? [{ pid: 4242 }] : []);
  const run = await runQa(runOpts(repo), deps);
  assert.equal(calls.down.some((c) => c.name === nameOf(repo.sha2)), false, 'the shared base was downed under the other run');
  assert.equal(calls.down.some((c) => c.name === nameOf(repo.sha3)), true, 'the head nobody else uses was left up');
  assert.ok(run.warnings.some((w) => w.includes(`sandbox ${nameOf(repo.sha2)} (base) left up: another run (pid 4242) still uses it`)), run.warnings.join(' | '));
});

// ── R10: run.json merge ───────────────────────────────────────────────────────

test('R10 run.json: keys the runner does not write (the judge agent id) survive the run', async () => {
  const repo = makeRepo();
  const verification = path.join(repo.dir, 'qa', 'feat-x-y');
  fs.mkdirSync(verification, { recursive: true });
  fs.writeFileSync(path.join(verification, 'run.json'), JSON.stringify({ judgeAgentId: 'x' }));
  const run = await runQa(runOpts(repo), fakes(repo).deps);
  const json = JSON.parse(fs.readFileSync(path.join(verification, 'run.json'), 'utf8'));
  assert.equal(json.judgeAgentId, 'x');
  assert.equal(json.slug, 'feat-x-y');
  assert.equal(json.exit, run.exit);
});

// ── R11: self mode ────────────────────────────────────────────────────────────

test('R11 self mode: one head sandbox, two captures into a and b, compare a against b, no verdict, no standing', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo);
  const run = await runQa(runOpts(repo, { self: true }), deps);
  const work = path.join(repo.dir, 'qa-artifacts', 'runs', 'feat-x-y');

  assert.deepEqual(calls.up.map((c) => c.at), [repo.sha3]);
  assert.deepEqual(calls.captureSide.map((c) => c.out), [path.join(work, 'a'), path.join(work, 'b')]);
  assert.equal(calls.compare.length, 1);
  assert.equal(calls.compare[0].beforeDir, path.join(work, 'a'));
  assert.equal(calls.compare[0].afterDir, path.join(work, 'b'));
  assert.deepEqual(calls.down.map((c) => c.name), [nameOf(repo.sha3)]);
  assert.equal(fs.existsSync(path.join(repo.dir, 'qa', 'feat-x-y', 'verdict.draft.md')), false, 'verdict.draft.md written in self mode');
  assert.equal(fs.existsSync(path.join(repo.dir, 'qa', 'standing.md')), false, 'qa/standing.md written in self mode');
  assert.equal(run.mode, 'self');
});

// ── R12: exit precedence ──────────────────────────────────────────────────────

test('R12a exit: a head failure that did not fail on base is 1 even when compare exits 0', async () => {
  const repo = makeRepo();
  const { deps } = fakes(repo, {
    compareExit: 0,
    sideFor: (req) => (path.basename(req.out) === 'head' ? sideResult({ failed: FAILED }) : sideResult()),
  });
  const run = await runQa(runOpts(repo), deps);
  assert.equal(run.exit, 1);
});

test('R12b exit: a NOT RUN screen on head is 3 when compare exits 0', async () => {
  const repo = makeRepo();
  const { deps } = fakes(repo, {
    compareExit: 0,
    sideFor: (req) => (path.basename(req.out) === 'head' ? sideResult({ notRun: NOT_RUN }) : sideResult()),
  });
  const run = await runQa(runOpts(repo), deps);
  assert.equal(run.exit, 3);
});

test('R12c exit: compare exit 2 is 2', async () => {
  const repo = makeRepo();
  const run = await runQa(runOpts(repo), fakes(repo, { compareExit: 2 }).deps);
  assert.equal(run.exit, 2);
});

test('R12d exit: compare exit 0 with clean sides is 0', async () => {
  const repo = makeRepo();
  const run = await runQa(runOpts(repo), fakes(repo, { compareExit: 0 }).deps);
  assert.equal(run.exit, 0);
});

// ── R13: live base URL ────────────────────────────────────────────────────────

test('R13 live base: a base URL is captured as given, with no base sandbox', async () => {
  const repo = makeRepo();
  const { deps, calls } = fakes(repo);
  const run = await runQa(runOpts(repo, { profile: profile({ base: 'http://live.example' }) }), deps);
  assert.deepEqual(calls.up.map((c) => c.at), [repo.sha3]);
  assert.equal(calls.captureSide[0].baseUrl, 'http://live.example');
  assert.equal(calls.captureSide[0].clock, 'off');
  assert.equal(calls.captureSide[0].cwd, repo.dir);
  assert.equal(run.sandboxes.base.state, 'live');
});

// ── R14: logs ─────────────────────────────────────────────────────────────────

test('R14 logs: the head sandbox verb log and every capture line are copied into qa/<slug>/logs', async () => {
  const repo = makeRepo();
  const sandboxes = path.join(repo.dir, 'qa-artifacts', 'sandboxes');
  fs.mkdirSync(sandboxes, { recursive: true });
  fs.writeFileSync(path.join(sandboxes, `${nameOf(repo.sha3)}.up.log`), 'hello\n');
  await runQa(runOpts(repo), fakes(repo).deps);

  const logs = path.join(repo.dir, 'qa', 'feat-x-y', 'logs');
  assert.match(fs.readFileSync(path.join(logs, 'head.up.log'), 'utf8'), /hello/);
  assert.ok(fs.existsSync(path.join(logs, 'head.capture.log')), 'missing logs/head.capture.log');
  assert.match(fs.readFileSync(path.join(logs, 'head.capture.log'), 'utf8'), /capture head/);
});

// ── R15: dirty tree ───────────────────────────────────────────────────────────

test('R15 dirty tree: an untracked file adds the uncommitted-changes warning', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.dir, 'scratch.txt'), 'untracked\n');
  const run = await runQa(runOpts(repo), fakes(repo).deps);
  assert.ok(
    run.warnings.includes('uncommitted changes are not in the run: it captures commits'),
    `warnings: ${JSON.stringify(run.warnings)}`,
  );
});

// rotatePrev (STEP 5; contract: scripts/lib/run.mjs, PREV_FILES and rotatePrev). Real files in a temp
// dir that the file's after() removes.
describe('rotatePrev', () => {
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  const CARRIED = ['charter.md', 'run.json', 'security.md', 'spec.md', 'expectations.json'];

  // A verification dir after a run at `sha` (mode `mode`): every PREV_FILES entry except `missing`,
  // the files that must stay (CARRIED, logs/) and a results.json with head.sha `sha`.
  function runDir({ mode = 'diff', sha = OLD, missing = [] } = {}) {
    const V = tmpDir('mfqa-prev-');
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(V, rel)), { recursive: true });
      fs.writeFileSync(path.join(V, rel), text);
    };
    write('results.json', JSON.stringify({ version: 1, mode, head: { sha, ref: 'HEAD' } }));
    for (const name of PREV_FILES) {
      if (name === 'results.json' || missing.includes(name)) continue;
      if (name === 'shots') write('shots/detail__default.png', 'png');
      else write(name, `${name} of the run`);
    }
    for (const name of CARRIED) write(name, `${name} of the run`);
    write('logs/run.log', 'log');
    return V;
  }

  const exists = (V, rel) => fs.existsSync(path.join(V, rel));

  test('PREV_FILES is the frozen list the contract names', () => {
    assert.ok(Object.isFrozen(PREV_FILES));
    assert.deepEqual(PREV_FILES, ['results.json', 'summary.md', 'verdict.draft.md', 'verdict.md', 'eyes.md', 'eyes-prompt.md', 'report.html', 'shots']);
  });

  test('rotatePrev moves every PREV_FILES entry present into V/prev when the head differs, in PREV_FILES order', () => {
    const V = runDir({ missing: ['eyes-prompt.md'] });
    const moved = rotatePrev(V, NEW);
    assert.deepEqual(moved, PREV_FILES.filter((n) => n !== 'eyes-prompt.md'));
    for (const name of moved) {
      assert.ok(exists(V, `prev/${name}`), `prev/${name} is in V/prev`);
      assert.ok(!exists(V, name), `${name} has left V`);
    }
    assert.ok(exists(V, 'prev/shots/detail__default.png'), 'the shots dir moves with its files');
    assert.equal(JSON.parse(fs.readFileSync(path.join(V, 'prev/results.json'), 'utf8')).head.sha, OLD, 'the old results.json is the prev one');
    assert.ok(!exists(V, 'prev/eyes-prompt.md'), 'an absent entry is not invented');
  });

  test('rotatePrev keeps charter.md, expectations.json, security.md, spec.md, run.json and logs/ in V', () => {
    const V = runDir();
    rotatePrev(V, NEW);
    for (const name of CARRIED) {
      assert.ok(exists(V, name), `${name} stays in V`);
      assert.ok(!exists(V, `prev/${name}`), `${name} is not moved`);
    }
    assert.ok(exists(V, 'logs/run.log'), 'logs/ stays in V');
  });

  test('rotatePrev replaces an old V/prev: it is removed and remade, so stale files are gone', () => {
    const V = runDir();
    fs.mkdirSync(path.join(V, 'prev'));
    fs.writeFileSync(path.join(V, 'prev', 'stale.txt'), 'old');
    rotatePrev(V, NEW);
    assert.ok(!exists(V, 'prev/stale.txt'), 'the stale file is gone');
    assert.ok(exists(V, 'prev/results.json'), 'the new prev holds the moved results');
  });

  test('rotatePrev with the same head moves nothing and leaves V/prev alone', () => {
    const V = runDir({ sha: OLD });
    fs.mkdirSync(path.join(V, 'prev'));
    fs.writeFileSync(path.join(V, 'prev', 'keep.txt'), 'keep');
    assert.deepEqual(rotatePrev(V, OLD), []);
    for (const name of PREV_FILES) assert.ok(exists(V, name), `${name} stays in V`);
    assert.ok(exists(V, 'prev/keep.txt'), 'V/prev is left alone');
  });

  test('rotatePrev of self-mode results moves nothing', () => {
    const V = runDir({ mode: 'self' });
    assert.deepEqual(rotatePrev(V, NEW), []);
    assert.ok(exists(V, 'results.json') && exists(V, 'summary.md'), 'the run files stay in V');
    assert.ok(!exists(V, 'prev'), 'no prev is made');
  });

  test('rotatePrev without a results.json, or with one that does not parse, moves nothing', () => {
    const none = runDir();
    fs.rmSync(path.join(none, 'results.json'));
    assert.deepEqual(rotatePrev(none, NEW), []);
    assert.ok(exists(none, 'summary.md'), 'summary.md stays');

    const broken = runDir();
    fs.writeFileSync(path.join(broken, 'results.json'), '{ not json');
    assert.deepEqual(rotatePrev(broken, NEW), []);
    assert.ok(exists(broken, 'summary.md'), 'summary.md stays');
  });

  test('rotatePrev of a missing V returns []', () => {
    assert.deepEqual(rotatePrev(path.join(tmpDir('mfqa-prev-gone-'), 'nope'), NEW), []);
  });
});

// ══ STEP 6: route sweep, mutants, metrics ═════════════════════════════════════
// The contract is the 'STEP 6' block of scripts/lib/run.mjs. routeActors takes injected runVerb and
// credentials; runQa takes injected sweepSide, runVerb, credentials and mutate next to the step-4
// fakes. diffRoutes is the real one (routes.mjs): these tests read run.routes through it.

const ROUTE_TABLE = '[{"method":"GET","path":"/api/notes"}]\n';

function probe(over = {}) {
  return {
    pid: 'GET /api/notes|happy|staff', route: 'GET /api/notes', kind: 'happy', actor: 'staff', method: 'GET', path: '/api/notes',
    headers: {}, expect: 'ok', status: 200, ms: 3, problem: null, notRun: null, timing: null, ...over,
  };
}
const BAD_PROBE = { pid: 'POST /api/notes|deep|staff', route: 'POST /api/notes', kind: 'deep', actor: 'staff', method: 'POST', path: '/api/notes', expect: 'reject', status: 500, problem: '500 answered' };

function sweepOf(over = {}) {
  return { file: 'qa/routes.table.json', rows: 1, registered: null, probes: [probe()], unlisted: [], stale: [], errors: [], notRun: null, expectations: [], ...over };
}

function emptyMutants(mode = 'affected') {
  return { mode, file: null, run: 0, killed: 0, survived: [], stale: [], notJudged: [], suites: {}, errors: [] };
}
const SURVIVOR = { id: 'mut:rls-check-dropped', mutant: 'rls-check-dropped', origin: 'registry', breaks: 'a person can move their row', file: 'db/0007.sql', suite: 'db', detail: '' };

// fakes() plus the step-6 deps. sweepFor(req, n) -> SweepSide (n = 0 for the first call, base when it is swept);
// mutateFor(req) -> { selected, result } or throws; registered = what the `routes` verb answers.
function s6(repo, o = {}) {
  const f = fakes(repo, o);
  Object.assign(f.calls, { sweepSide: [], runVerb: [], credentials: [], mutate: [] });
  const up0 = f.deps.up;
  f.deps.up = async (req) => ({ ...(await up0(req)), dir: repo.dir }); // fakes() puts the repo object in dir
  f.deps.sweepSide = async (req) => {
    f.calls.sweepSide.push(req);
    return structuredClone(o.sweepFor ? o.sweepFor(req, f.calls.sweepSide.length - 1) : sweepOf());
  };
  f.deps.runVerb = async (verb, req) => {
    f.calls.runVerb.push({ verb, ...req });
    if (verb === 'routes') return { code: 0, json: o.registered ?? null, notRun: null };
    return { code: 0, json: { headers: { Authorization: `Bearer ${req.args?.[0]}` } }, notRun: null };
  };
  f.deps.credentials = async (role, req) => {
    f.calls.credentials.push({ role, ...req });
    return { user: `${role}@example.invalid`, password: 'pw' };
  };
  f.deps.mutate = async (req) => {
    f.calls.mutate.push(req);
    if (o.mutateFor) return o.mutateFor(req);
    return { selected: 0, result: emptyMutants(req.mode) };
  };
  return f;
}

const s6Profile = (over = {}) => profile({ login: { staff: { user: 'HR_USER', password: 'HR_PW' } }, ...over });
const stepsOf = (run, verb) => run.steps.filter((s) => s.verb === verb);

describe('step 6: routeActors', () => {
  const descriptorOf = { name: 'qa-x', dir: '/tmp/tree', appUrl: APP_URL, stack: { supabase: 'http://127.0.0.1:54321' } };
  const base = (over = {}) => ({
    profile: s6Profile(), mainRoot: '/tmp/main', descriptor: descriptorOf, vars: { dir: '/tmp/tree', main: '/tmp/main', slug: 'qa-x', port: '1' }, env: {}, ...over,
  });

  test('the headers verb answers for anon and then each login role; the first baseUrl seen wins', async () => {
    const calls = [];
    const runVerb = async (verb, req) => {
      calls.push({ verb, ...req });
      const role = req.args[0];
      return { code: 0, notRun: null, json: { headers: { Authorization: `Bearer ${role}` }, ...(role === 'anon' ? { baseUrl: 'http://gateway.test' } : { baseUrl: 'http://other.test' }) } };
    };
    const credentials = async (role) => ({ user: `${role}@example.invalid`, password: 'pw' });
    const r = await routeActors(base({ runVerb, credentials }));
    assert.deepEqual(r, { baseUrl: 'http://gateway.test', headers: { anon: { Authorization: 'Bearer anon' }, staff: { Authorization: 'Bearer staff' } } });
    assert.deepEqual(calls.map((c) => [c.verb, c.args]), [['headers', ['anon']], ['headers', ['staff']]]);
    assert.equal(calls[1].cwd, '/tmp/tree');
    assert.equal(calls[1].vars.slug, 'qa-x');
    assert.equal(calls[1].env.QA_USER, 'staff@example.invalid');
    assert.equal(calls[1].env.QA_PASSWORD, 'pw');
    assert.deepEqual(JSON.parse(calls[1].env.QA_STACK), descriptorOf.stack);
    assert.equal(calls[0].env.QA_USER, undefined, 'anon is given no user');
    assert.equal(calls[0].env.QA_PASSWORD, undefined);
  });

  test('a descriptor with no stack gives QA_STACK {}; with no login roles only anon is asked', async () => {
    const calls = [];
    const runVerb = async (verb, req) => { calls.push(req); return { code: 0, notRun: null, json: { headers: {} } }; };
    const r = await routeActors(base({ profile: profile(), descriptor: { dir: '/tmp/tree', appUrl: APP_URL }, runVerb, credentials: async () => ({ notRun: 'x' }) }));
    assert.deepEqual(r, { baseUrl: null, headers: { anon: {} } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.QA_STACK, '{}');
  });

  test('verb kind none: profile.routes.headers names the env vars that hold each header', async () => {
    const runVerb = async () => ({ code: null, stdout: '', json: null, notRun: 'NOT RUN: no adapter for headers (none named)' });
    const p = s6Profile({ routes: { headers: { staff: { Authorization: 'HR_TOKEN', apikey: 'ANON_KEY' } } } });
    const r = await routeActors(base({ profile: p, runVerb, credentials: async () => ({ user: 'u', password: 'p' }), env: { HR_TOKEN: 'Bearer abc', ANON_KEY: 'k' } }));
    assert.deepEqual(r.headers.staff, { Authorization: 'Bearer abc', apikey: 'k' });
    assert.deepEqual(r.headers.anon, {}, 'no routes.headers.anon: anon is empty');
    assert.equal(r.baseUrl, null);
  });

  test('verb kind none: routes.headers.anon is read from env like a role', async () => {
    const runVerb = async () => ({ code: null, json: null, notRun: 'NOT RUN: no adapter for headers (none named)' });
    const p = s6Profile({ routes: { headers: { anon: { apikey: 'ANON_KEY' } } } });
    const r = await routeActors(base({ profile: p, runVerb, credentials: async () => ({ user: 'u', password: 'p' }), env: { ANON_KEY: 'k' } }));
    assert.deepEqual(r.headers.anon, { apikey: 'k' });
  });

  test('verb kind none: an unset env var makes that role not run, naming the variable', async () => {
    const runVerb = async () => ({ code: null, json: null, notRun: 'NOT RUN: no adapter for headers (none named)' });
    const p = s6Profile({ routes: { headers: { staff: { Authorization: 'HR_TOKEN' } } } });
    const r = await routeActors(base({ profile: p, runVerb, credentials: async () => ({ user: 'u', password: 'p' }), env: {} }));
    assert.deepEqual(r.headers.staff, { notRun: 'env HR_TOKEN unset' });
  });

  test('verb kind none and no routes.headers entry: a role is not run, anon is empty', async () => {
    const runVerb = async () => ({ code: null, json: null, notRun: 'NOT RUN: no adapter for headers (none named)' });
    const r = await routeActors(base({ runVerb, credentials: async () => ({ user: 'u', password: 'p' }) }));
    assert.deepEqual(r.headers.anon, {});
    assert.deepEqual(r.headers.staff, { notRun: 'no headers for staff: no headers verb and no routes.headers' });
  });

  test('a credentials notRun makes that role { notRun } and the headers verb is not asked for it', async () => {
    const calls = [];
    const runVerb = async (verb, req) => { calls.push(req.args[0]); return { code: 0, json: { headers: { A: '1' } }, notRun: null }; };
    const r = await routeActors(base({ runVerb, credentials: async () => ({ notRun: 'NOT RUN: login staff: env HR_USER unset' }) }));
    assert.equal(r.headers.staff.notRun, 'NOT RUN: login staff: env HR_USER unset');
    assert.deepEqual(r.headers.anon, { A: '1' });
    assert.deepEqual(calls, ['anon']);
  });

  test('a headers verb that exits non-zero makes that role { notRun: "headers <role> exited <code>" }', async () => {
    const runVerb = async (verb, req) => (req.args[0] === 'staff' ? { code: 3, stdout: '', json: null, notRun: null } : { code: 0, json: { headers: {} }, notRun: null });
    const r = await routeActors(base({ runVerb, credentials: async () => ({ user: 'u', password: 'p' }) }));
    assert.deepEqual(r.headers.staff, { notRun: 'headers staff exited 3' });
    assert.deepEqual(r.headers.anon, {});
  });
});

describe('step 6: runQa route sweep', () => {
  test('the sweep runs on the fresh base sandbox and on head, in that order, each before its down', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(calls.sweepSide.length, 2);
    for (const req of calls.sweepSide) {
      assert.equal(req.root, repo.dir);
      assert.equal(req.baseUrl, APP_URL);
      assert.deepEqual(req.actors, { anon: { Authorization: 'Bearer anon' }, staff: { Authorization: 'Bearer staff' } });
    }
  });

  test('steps: one { side, verb: routes, ok, ms, note } per sweep, base then head, between capture and down', async () => {
    const repo = makeRepo();
    const { deps } = s6(repo);
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    const order = run.steps.map((s) => `${s.side}.${s.verb}`);
    assert.deepEqual(order.slice(0, 8), ['base.up', 'base.capture', 'base.routes', 'base.down', 'head.up', 'head.capture', 'head.routes', 'head.down']);
    const routes = stepsOf(run, 'routes');
    assert.deepEqual(routes.map((s) => [s.side, s.ok, s.note]), [['base', true, ''], ['head', true, '']]);
    assert.equal(typeof routes[0].ms, 'number');
  });

  test('a sweep that is notRun is a step with ok false and the reason as the note, and the run goes on', async () => {
    const repo = makeRepo();
    const { deps } = s6(repo, { sweepFor: () => sweepOf({ notRun: 'no route table', file: null, rows: 0, probes: [] }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.deepEqual(stepsOf(run, 'routes').map((s) => [s.ok, s.note]), [[true, 'no route table'], [true, 'no route table']]);
    assert.equal(run.routes.notRun, 'no route table');
    assert.equal(run.exit, 1, 'compare exit 1 stands');
  });

  test('a sweepSide that throws is a not-run step, never a crash of the run', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    deps.sweepSide = async () => { throw new Error('boom\nsecond line'); };
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.deepEqual(stepsOf(run, 'routes').map((s) => [s.ok, s.note]), [[false, 'boom'], [false, 'boom']]);
    assert.equal(calls.down.length, 2);
    assert.ok(fs.existsSync(path.join(repo.dir, 'qa', 'feat-x-y', 'results.json')));
  });

  test('expectations with a route key go to the head sweep only; base is given []', async () => {
    const repo = makeRepo();
    const V = path.join(repo.dir, 'qa', 'feat-x-y');
    fs.mkdirSync(V, { recursive: true });
    const entries = [
      { name: 'notes-denied-to-viewer', route: 'POST /api/notes', as: 'viewer', status: 403 },
      { name: 'title-renamed', text: 'New title' },
    ];
    fs.writeFileSync(path.join(V, 'expectations.json'), JSON.stringify(entries));
    const { deps, calls } = s6(repo);
    await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.deepEqual(calls.sweepSide[0].expectations, []);
    assert.deepEqual(calls.sweepSide[1].expectations, [entries[0]]);
  });

  test('an --expect file is read the same way, and with no expectations file the head gets []', async () => {
    const repo = makeRepo();
    const file = path.join(tmpDir('mfqa-exp-'), 'e.json');
    fs.writeFileSync(file, JSON.stringify([{ name: 'r', route: 'GET /api/notes', as: 'anon', status: 200 }]));
    const withFile = s6(repo);
    await runQa(runOpts(repo, { profile: s6Profile(), expect: file }), withFile.deps);
    assert.equal(withFile.calls.sweepSide[1].expectations.length, 1);
    const without = s6(repo);
    await runQa(runOpts(repo, { profile: s6Profile() }), without.deps);
    assert.deepEqual(without.calls.sweepSide.at(-1).expectations, []);
  });

  test('registered comes from the routes verb when its json is an array, else null; $seed names come from the tree', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo.dir, 'qa', 'seed.json'), '{"note":{"id":"n1"}}\n');
    const rows = [{ method: 'GET', path: '/api/notes' }];
    const yes = s6(repo, { registered: rows });
    await runQa(runOpts(repo, { profile: s6Profile() }), yes.deps);
    assert.deepEqual(yes.calls.sweepSide.map((r) => r.registered), [rows, rows]);
    const verbCalls = yes.calls.runVerb.filter((c) => c.verb === 'routes');
    assert.equal(verbCalls.length, 2);
    assert.equal(verbCalls[0].cwd, repo.dir);
    assert.equal(verbCalls[0].vars.dir, repo.dir);

    const no = s6(repo, { registered: { not: 'an array' } });
    await runQa(runOpts(repo, { profile: s6Profile(), cache: false }), no.deps);
    assert.deepEqual(no.calls.sweepSide.map((r) => r.registered), [null, null]);
    for (const req of no.calls.sweepSide) assert.ok(req.seedName === 'seed.json' || typeof req.seedName === 'string');
  });

  test('actors.baseUrl, when a headers verb gives one, replaces the sandbox app URL', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    const original = deps.runVerb;
    deps.runVerb = async (verb, req) => {
      const r = await original(verb, req);
      return verb === 'headers' ? { ...r, json: { ...r.json, baseUrl: 'http://gateway.test' } } : r;
    };
    await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.deepEqual(calls.sweepSide.map((r) => r.baseUrl), ['http://gateway.test', 'http://gateway.test']);
  });

  test('run.routes is diffRoutes(head, base): a problem only on head is new, one on both is standing', async () => {
    const repo = makeRepo();
    const head = sweepOf({ probes: [probe(), probe(BAD_PROBE), probe({ pid: 'GET /api/notes|signed-out|anon', kind: 'signed-out', actor: 'anon', status: 200, problem: 'answered 200 to signed-out (anon)' })] });
    const base = sweepOf({ probes: [probe(), probe({ ...BAD_PROBE, status: 200, problem: null }), probe({ pid: 'GET /api/notes|signed-out|anon', kind: 'signed-out', actor: 'anon', status: 200, problem: 'answered 200 to signed-out (anon)' })] });
    const { deps } = s6(repo, { sweepFor: (req, n) => (n === 0 ? base : head) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.deepEqual(run.routes.new.map((n) => [n.id, n.pid]), [['rte:1', BAD_PROBE.pid]]);
    assert.equal(run.routes.standing, 1);
    assert.equal(run.routes.base, 'swept');
    assert.equal(run.exit, 1);
    assert.deepEqual(run.results.routes, run.routes, 'buildResults passes the routes through');
  });

  test('route expectations of the head sweep are run.routeExpectations and reach results.expectations', async () => {
    const repo = makeRepo();
    const exps = [{ name: 'notes-denied-to-viewer', result: 'met', detail: 'POST /api/notes as viewer: 403' }];
    const { deps } = s6(repo, { sweepFor: (req, n) => sweepOf({ expectations: n === 0 ? [] : exps }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.deepEqual(run.routeExpectations, exps);
    assert.ok(run.results.expectations.some((e) => e.id === 'exp:notes-denied-to-viewer' && e.result === 'met'));
  });

  test('the fresh base sweep is written to routes.json in the cache dir', async () => {
    const repo = makeRepo();
    const base = sweepOf({ probes: [probe(BAD_PROBE)] });
    const { deps } = s6(repo, { sweepFor: (req, n) => (n === 0 ? base : sweepOf()) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    const file = path.join(run.dirs.cache, 'routes.json');
    assert.ok(fs.existsSync(file), 'missing routes.json in the cache dir');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).probes.map((p) => p.pid), [BAD_PROBE.pid]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run.dirs.cache, 'meta.json'), 'utf8')).sha, repo.sha2);
  });

  test('a base cache hit reads C/routes.json: only head is swept, and the base problem makes the head one standing', async () => {
    const repo = makeRepo();
    const bad = sweepOf({ probes: [probe(BAD_PROBE)] });
    await runQa(runOpts(repo, { profile: s6Profile() }), s6(repo, { sweepFor: () => bad }).deps);

    const second = s6(repo, { sweepFor: () => bad });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), second.deps);
    assert.equal(run.sandboxes.base.state, 'cached');
    assert.equal(second.calls.sweepSide.length, 1, 'base must not be swept again');
    assert.deepEqual(second.calls.up.map((c) => c.at), [repo.sha3]);
    assert.equal(run.routes.base, 'swept');
    assert.equal(run.routes.standing, 1);
    assert.deepEqual(run.routes.new, []);
    assert.deepEqual(stepsOf(run, 'routes').map((s) => s.side), ['head']);
  });

  test('a cache with every screen but no routes.json brings base up for the sweep alone (rework U4): no base capture', async () => {
    const repo = makeRepo();
    const first = await runQa(runOpts(repo, { profile: s6Profile() }), s6(repo).deps);
    fs.rmSync(path.join(first.dirs.cache, 'routes.json'));
    const f = s6(repo, { sweepFor: () => sweepOf({ probes: [probe(BAD_PROBE)] }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), f.deps);
    assert.equal(run.routes.base, 'swept');
    assert.deepEqual(f.calls.up.map((c) => c.at), [repo.sha2, repo.sha3]);
    assert.equal(f.calls.captureSide.length, 1, 'only head captures: every base screen came from the cache');
    assert.ok(fs.existsSync(path.join(first.dirs.cache, 'routes.json')), 'the new base sweep is cached');
  });

  test('a live base is not swept: base none', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo, { sweepFor: () => sweepOf({ probes: [probe(BAD_PROBE)] }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile({ base: 'http://live.example.invalid' }) }), deps);
    assert.equal(calls.sweepSide.length, 1);
    assert.equal(run.routes.base, 'none');
  });

  test('routes: false sweeps nothing: run.routes null, routeExpectations [], no routes steps, no routes verb', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    const run = await runQa(runOpts(repo, { profile: s6Profile(), routes: false }), deps);
    assert.equal(calls.sweepSide.length, 0);
    assert.equal(calls.runVerb.length, 0);
    assert.equal(run.routes, null);
    assert.deepEqual(run.routeExpectations, []);
    assert.deepEqual(stepsOf(run, 'routes'), []);
  });

  test('profile.routes.enabled false turns the sweep off the same way', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    const run = await runQa(runOpts(repo, { profile: s6Profile({ routes: { enabled: false } }) }), deps);
    assert.equal(calls.sweepSide.length, 0);
    assert.equal(run.routes, null);
  });

  test('exit: a new route problem is 1 even when compare exits 0', async () => {
    const repo = makeRepo();
    const { deps } = s6(repo, { compareExit: 0, sweepFor: (req, n) => sweepOf({ probes: n === 0 ? [probe()] : [probe(BAD_PROBE)] }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(run.routes.new.length, 1);
    assert.equal(run.exit, 1);
  });

  test('exit: an unlisted route is 1 even when compare exits 0', async () => {
    const repo = makeRepo();
    const { deps } = s6(repo, { compareExit: 0, sweepFor: (req, n) => sweepOf({ unlisted: n === 0 ? [] : [{ method: 'DELETE', path: '/api/notes/:id' }] }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(run.routes.unlisted.length, 1);
    assert.equal(run.exit, 1);
  });

  test('exit: a clean sweep and compare exit 0 is 0', async () => {
    const repo = makeRepo();
    const { deps } = s6(repo, { compareExit: 0 });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(run.exit, 0);
  });

  test('exit: a standing problem alone (on base too) leaves exit 0', async () => {
    const repo = makeRepo();
    const bad = sweepOf({ probes: [probe(BAD_PROBE)] });
    const { deps } = s6(repo, { compareExit: 0, sweepFor: () => bad });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(run.routes.standing, 1);
    assert.equal(run.exit, 0);
  });

  test('a blocked base up means no sweep, no routes and exit 4', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo, { upError: () => blocked() });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(run.exit, 4);
    assert.equal(calls.sweepSide.length, 0);
    assert.equal(run.routes, null);
  });

  test('self mode: no sweep and no mutants, routes and mutants null', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    const run = await runQa(runOpts(repo, { profile: s6Profile(), self: true }), deps);
    assert.equal(calls.sweepSide.length, 0);
    assert.equal(calls.mutate.length, 0);
    assert.equal(run.routes, null);
    assert.equal(run.mutants, null);
    assert.deepEqual(stepsOf(run, 'routes'), []);
    assert.deepEqual(stepsOf(run, 'mutants'), []);
  });
});

describe('step 6: runQa mutants', () => {
  test('mutants none: nothing runs and run.mutants is null', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    const run = await runQa(runOpts(repo, { profile: s6Profile(), mutants: 'none' }), deps);
    assert.equal(calls.mutate.length, 0);
    assert.equal(run.mutants, null);
    assert.deepEqual(stepsOf(run, 'mutants'), []);
  });

  test('the default mode is named: the head tree, the files changed from base to head, and no proposals', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(calls.mutate.length, 1);
    const req = calls.mutate[0];
    assert.equal(req.mode, 'named');
    assert.equal(req.dir, repo.dir);
    assert.deepEqual(req.changed, ['a.txt'], 'git diff --name-only <base> <head>: commit 3 changed a.txt');
    assert.equal(req.proposals, null);
    assert.equal(req.mainRoot, repo.dir);
    assert.equal(req.vars.dir, repo.dir);
    assert.equal(req.logDir, path.join(repo.dir, 'qa', 'feat-x-y', 'logs'));
    assert.equal(typeof req.runVerb, 'function');
  });

  test('mutants all passes mode all through', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    await runQa(runOpts(repo, { profile: s6Profile(), mutants: 'all' }), deps);
    assert.equal(calls.mutate[0].mode, 'all');
  });

  test('V/mutants.json, when it exists, is the proposals file', async () => {
    const repo = makeRepo();
    const V = path.join(repo.dir, 'qa', 'feat-x-y');
    fs.mkdirSync(V, { recursive: true });
    fs.writeFileSync(path.join(V, 'mutants.json'), '{"mutants":[]}\n');
    const { deps, calls } = s6(repo);
    await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(calls.mutate[0].proposals, path.join(V, 'mutants.json'));
  });

  test('mutants run on the head sandbox after the sweep and before its down; mutate sees no base sandbox', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo, { mutateFor: (req) => ({ selected: 2, result: { ...emptyMutants(req.mode), run: 2, killed: 2 } }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.equal(calls.mutate.length, 1);
    const order = run.steps.filter((s) => s.side === 'head').map((s) => s.verb);
    assert.deepEqual(order, ['up', 'capture', 'routes', 'mutants', 'down']);
  });

  test('a run of mutants is a head step { ok: true, note: "<killed>/<run> killed" } and run.mutants is the result', async () => {
    const repo = makeRepo();
    const result = { ...emptyMutants('affected'), run: 2, killed: 1, survived: [SURVIVOR], suites: { db: { passed: true, ms: 5 } } };
    const { deps } = s6(repo, { mutateFor: () => ({ selected: 2, result }) });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    const [s] = stepsOf(run, 'mutants');
    assert.equal(s.side, 'head');
    assert.equal(s.ok, true);
    assert.equal(s.note, '1/2 killed');
    assert.deepEqual(run.mutants, result);
    assert.deepEqual(run.results.mutants, result);
  });

  test('nothing selected: run.mutants is the empty result and there is no step', async () => {
    const repo = makeRepo();
    const { deps } = s6(repo, { compareExit: 0 });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    assert.deepEqual(run.mutants, emptyMutants('named'));
    assert.deepEqual(stepsOf(run, 'mutants'), []);
    assert.equal(run.exit, 0);
  });

  test('exit: a survived mutant is 1 even when compare exits 0', async () => {
    const repo = makeRepo();
    const { deps } = s6(repo, { compareExit: 0, mutateFor: () => ({ selected: 1, result: { ...emptyMutants(), run: 1, survived: [SURVIVOR] } }) });
    assert.equal((await runQa(runOpts(repo, { profile: s6Profile() }), deps)).exit, 1);
  });

  test('exit: a stale mutant is 1 even when compare exits 0', async () => {
    const repo = makeRepo();
    const stale = { ...SURVIVOR, detail: 'stale: found 0 times' };
    const { deps } = s6(repo, { compareExit: 0, mutateFor: () => ({ selected: 1, result: { ...emptyMutants(), stale: [stale] } }) });
    assert.equal((await runQa(runOpts(repo, { profile: s6Profile() }), deps)).exit, 1);
  });

  test('exit: all mutants killed leaves exit 0; a not-judged one alone does too', async () => {
    const repo = makeRepo();
    const killed = s6(repo, { compareExit: 0, mutateFor: () => ({ selected: 1, result: { ...emptyMutants(), run: 1, killed: 1 } }) });
    assert.equal((await runQa(runOpts(repo, { profile: s6Profile() }), killed.deps)).exit, 0);
    const judged = s6(repo, { compareExit: 0, mutateFor: () => ({ selected: 1, result: { ...emptyMutants(), notJudged: [{ ...SURVIVOR, detail: 'suite db fails unmutated' }] } }) });
    assert.equal((await runQa(runOpts(repo, { profile: s6Profile() }), judged.deps)).exit, 0);
  });

  test('restore failed: the step is ok false with the message, run.mutants is null, a warning is added, head is still downed', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo, { compareExit: 0, mutateFor: () => { throw new Error('restore failed: db/0007.sql'); } });
    const run = await runQa(runOpts(repo, { profile: s6Profile() }), deps);
    const [s] = stepsOf(run, 'mutants');
    assert.equal(s.ok, false);
    assert.equal(s.note, 'restore failed: db/0007.sql');
    assert.equal(run.mutants, null);
    assert.ok(run.warnings.some((w) => w.includes('restore failed: db/0007.sql')), `warnings: ${run.warnings.join(' | ')}`);
    assert.ok(calls.down.some((c) => c.name === nameOf(repo.sha3)), 'head sandbox must still be downed');
    assert.ok(fs.existsSync(path.join(repo.dir, 'qa', 'feat-x-y', 'results.json')));
  });

  test('an unknown mutants value is a USAGE RunError and nothing starts', async () => {
    const repo = makeRepo();
    const { deps, calls } = s6(repo);
    const e = await errorOf(runQa(runOpts(repo, { profile: s6Profile(), mutants: 'some' }), deps));
    assert.ok(e instanceof RunError);
    assert.equal(e.code, 'USAGE');
    assert.match(e.message, /mutants/);
    assert.equal(calls.up.length, 0);
  });
});

describe('step 6: mapHash and the route table', () => {
  function withTable(repo, rel, text) {
    fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, rel), text);
    return commitAll(repo.dir, `table ${rel}`);
  }
  const hashAt = (repo, sha, p = profile()) => mapHash({ repoRoot: repo.dir, sha, profile: p });

  test('adding qa/routes.table.json changes the hash; editing it changes it again; the same table is stable', () => {
    const repo = makeRepo();
    const before = hashAt(repo, repo.sha3);
    const sha4 = withTable(repo, 'qa/routes.table.json', ROUTE_TABLE);
    const withIt = hashAt(repo, sha4);
    assert.notEqual(withIt, before);
    const sha5 = withTable(repo, 'qa/routes.table.json', '[{"method":"GET","path":"/api/other"}]\n');
    assert.notEqual(hashAt(repo, sha5), withIt);
    git(['checkout', '-q', '-b', 'same', sha4], repo.dir);
    fs.writeFileSync(path.join(repo.dir, 'unrelated.txt'), 'x\n');
    const sha6 = commitAll(repo.dir, 'unrelated');
    assert.equal(hashAt(repo, sha6), withIt, 'a commit that leaves the table alone leaves the hash alone');
  });

  test('a .ts or .mjs table counts too', () => {
    const repo = makeRepo();
    const before = hashAt(repo, repo.sha3);
    const sha = withTable(repo, 'qa/routes.table.mjs', 'export const ROUTES = [];\n');
    assert.notEqual(hashAt(repo, sha), before);
  });

  test('profile.routes.table names the table to hash', () => {
    const repo = makeRepo();
    const p = profile({ routes: { table: 'api/routes.json' } });
    const before = hashAt(repo, repo.sha3, p);
    const sha = withTable(repo, 'api/routes.json', ROUTE_TABLE);
    assert.notEqual(hashAt(repo, sha, p), before);
    // The default location is not read when profile.routes.table names another file.
    const other = withTable(repo, 'qa/routes.table.json', '[{"method":"GET","path":"/x"}]\n');
    assert.equal(hashAt(repo, other, p), hashAt(repo, sha, p));
  });

  test('a repo with no table hashes as before: a second call with the same inputs is equal and 64 hex', () => {
    const repo = makeRepo();
    const h = hashAt(repo, repo.sha3);
    assert.match(h, HEX64);
    assert.equal(hashAt(repo, repo.sha3), h);
  });

  test('run.maps hash the route table at each side: a table added on head changes maps.head and leaves maps.base', async () => {
    const repo = makeRepo();
    const first = await runQa(runOpts(repo, { profile: s6Profile() }), s6(repo).deps);
    withTable(repo, 'qa/routes.table.json', ROUTE_TABLE);
    const second = await runQa(runOpts(repo, { profile: s6Profile() }), s6(repo).deps);
    assert.notEqual(second.maps.head, first.maps.head);
    assert.equal(second.maps.base, first.maps.base);
    assert.equal(second.maps.head, mapHash({ repoRoot: repo.dir, sha: second.head.sha, profile: s6Profile(), extra: { viewports: null, screens: ['home'], checks: true, tour: true, record: 'journeys' } }));
  });
});


// ── step 7: affected set, coverage sources, video ─────────────────────────────

const S7_STEPS = [{ goto: '/candidates' }, { capture: 'list' }];
const S7_HEAD_MAP = {
  screens: [
    { name: 'candidates-list', area: 'candidates', file: 'candidates.json', flow: 'open:candidates', steps: [{ capture: 'list' }] },
    { name: 'candidate-detail', area: 'candidates', file: 'candidates.json', flow: 'open:candidates', steps: [{ click: 'role=link[name="Alice"]' }, { capture: 'detail' }] },
    { name: 'jobs-list', area: 'jobs', file: 'jobs.json', steps: [{ goto: '/jobs' }, { capture: 'list' }] },
  ],
  flows: { 'open:candidates': { steps: [{ flow: 'login:staff' }, ...S7_STEPS], file: 'candidates.json' } },
  seed: null, seedFile: '', files: [], errors: [],
};
const S7_SOURCES = { 'candidate-detail': ['a.txt'], 'jobs-list': ['src/features/jobs/List.tsx'] };
const S7_TWO_VIEWPORTS = profile({ viewports: { desktop: [1440, 900], mobile: [390, 844] } });

// s6() plus the step-7 deps. maps[sha] is what mapAt answers (default S7_HEAD_MAP for every sha);
// sources is what readSources answers; onCapture(req) runs inside captureSide (to write sources, webm).
function s7(repo, o = {}) {
  const f = s6(repo, o);
  Object.assign(f.calls, { mapAt: [], readSources: [], writeSources: [], affected: [] });
  const capture0 = f.deps.captureSide;
  f.deps.captureSide = async (req) => {
    const side = await capture0(req);
    o.onCapture?.(req);
    return side;
  };
  f.deps.mapAt = (req) => {
    f.calls.mapAt.push(req);
    const m = Object.hasOwn(o.maps ?? {}, req.sha) ? o.maps[req.sha] : S7_HEAD_MAP;
    return m === null ? null : structuredClone(m);
  };
  f.deps.readSources = (dir) => {
    f.calls.readSources.push(dir);
    return structuredClone(o.sources ?? S7_SOURCES);
  };
  f.deps.writeSources = (dir, req) => {
    f.calls.writeSources.push({ dir, ...req });
    return path.join(dir, `${req.area}.sources.json`);
  };
  f.deps.affected = (req) => {
    f.calls.affected.push(req);
    return o.affectedFor ? o.affectedFor(req) : affectedScreens(req);
  };
  return f;
}

const writeAt = (out, vp, name, content) => {
  fs.mkdirSync(path.join(out, vp), { recursive: true });
  fs.writeFileSync(path.join(out, vp, name), typeof content === 'string' ? content : JSON.stringify(content));
};
const sidesOf = (calls) => ({ base: calls.captureSide.find((c) => c.out.endsWith(`${path.sep}base`) || c.out.includes(`${path.sep}.tmp-`)), head: calls.captureSide.find((c) => c.out.endsWith(`${path.sep}head`)) });

describe('step 7: runQa affected selection', () => {
  test('the affected screens are chosen from the changed files, the head map, the base map and the recorded sources', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    const run = await runQa(runOpts(repo), f.deps);
    assert.deepEqual(run.affected, {
      mode: 'affected', names: ['candidate-detail'],
      why: { 'candidate-detail': 'source: a.txt' }, total: 3, unknown: 1, mapThese: ['candidates-list'], skipped: 2, unmapped: [],
    });
    assert.equal(f.calls.affected.length, 1);
    assert.deepEqual(f.calls.affected[0].changed, ['a.txt']);
    assert.deepEqual(f.calls.affected[0].sources, S7_SOURCES);
    assert.deepEqual(f.calls.affected[0].head.screens.map((s) => s.name), ['candidates-list', 'candidate-detail', 'jobs-list']);
    assert.equal(run.results.affected.mode, 'affected');
  });

  test('mapAt is asked for the head sha and the base sha with the profile map directory; readSources reads that directory on disk', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    await runQa(runOpts(repo), f.deps);
    assert.deepEqual(f.calls.mapAt.map((c) => c.sha).sort(), [repo.sha2, repo.sha3].sort());
    for (const c of f.calls.mapAt) {
      assert.equal(c.repoRoot, repo.dir);
      assert.equal(c.mapDir, 'qa/map');
    }
    assert.deepEqual(f.calls.readSources, [path.join(repo.dir, 'qa', 'map')]);
  });

  test('a screen new on head and one whose entry changed are affected with those reasons; an untouched one is skipped', async () => {
    const repo = makeRepo();
    const base = structuredClone(S7_HEAD_MAP);
    base.screens = base.screens.filter((s) => s.name !== 'candidates-list');
    base.screens.find((s) => s.name === 'candidate-detail').steps = [{ click: 'role=link[name="Bob"]' }, { capture: 'detail' }];
    const sources = { 'candidates-list': ['src/x.tsx'], 'candidate-detail': ['src/y.tsx'], 'jobs-list': ['src/z.tsx'] };
    const f = s7(repo, { maps: { [repo.sha2]: base }, sources });
    const run = await runQa(runOpts(repo), f.deps);
    assert.deepEqual(run.affected.names, ['candidates-list', 'candidate-detail']);
    assert.deepEqual(run.affected.why, { 'candidates-list': 'new entry', 'candidate-detail': 'entry changed' });
    assert.equal(run.affected.unknown, 0);
    assert.equal(run.affected.skipped, 1);
  });

  test('both sides capture only the affected names, joined with commas (onlyGlob)', async () => {
    const repo = makeRepo();
    const f = s7(repo, { sources: { 'candidates-list': ['a.txt'], 'candidate-detail': ['a.txt'] } });
    await runQa(runOpts(repo), f.deps);
    assert.equal(f.calls.captureSide.length, 2);
    for (const c of f.calls.captureSide) assert.equal(c.screens, 'candidates-list,candidate-detail');
  });

  test('--screens given: those globs go to head, the base screens they name to base; affected is null', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    const run = await runQa(runOpts(repo, { screens: 'jobs-*' }), f.deps);
    assert.equal(run.affected, null);
    assert.equal(f.calls.captureSide.length, 2);
    const { base, head } = sidesOf(f.calls);
    assert.equal(head.screens, 'jobs-*');
    assert.equal(base.screens, 'jobs-list', 'base walks the base screens by name (its cache is per screen)');
    assert.equal(f.calls.affected.length, 0);
    assert.equal(f.calls.readSources.length, 0);
  });

  test('the run map directory given on disk is read for the head and used for the base too: mapAt is not asked', async () => {
    const repo = makeRepo();
    const mapDir = path.join(tmpDir('mfqa-planmap-'), 'map');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(path.join(mapDir, 'planned.json'), JSON.stringify({ screens: [{ name: 'planned-a', steps: [{ goto: '/' }, { capture: 'a' }] }, { name: 'planned-b', steps: [{ goto: '/b' }, { capture: 'b' }] }] }));
    const f = s7(repo, { sources: { 'planned-a': ['src/a.ts'], 'planned-b': ['a.txt'] } });
    const run = await runQa(runOpts(repo, { map: mapDir }), f.deps);
    assert.equal(f.calls.mapAt.length, 0);
    assert.deepEqual(f.calls.readSources, [mapDir]);
    assert.deepEqual(run.affected.names, ['planned-b']);
    assert.equal(run.affected.why['planned-b'], 'source: a.txt');
    for (const c of f.calls.captureSide) assert.equal(c.screens, 'planned-b');
  });

  test('a clean compare over the affected set exits 0', async () => {
    const repo = makeRepo();
    const run = await runQa(runOpts(repo), s7(repo, { compareExit: 0 }).deps);
    assert.equal(run.exit, 0);
  });
});

describe('unmapped: runQa passes the affected unmapped files through', () => {
  const UNMAPPED = ['src/features/jobs/JobAdComposePage.tsx'];
  const withUnmapped = (names, skipped) => () => ({ names, why: Object.fromEntries(names.map((n) => [n, 'new entry'])), total: 3, unknown: 0, skipped, unmapped: [...UNMAPPED] });

  test('unmapped: run.affected.unmapped is Affected.unmapped, and results.unmapped and summary.md show it', async () => {
    const repo = makeRepo();
    const f = s7(repo, { affectedFor: withUnmapped(['jobs-list'], ['candidates-list', 'candidate-detail']) });
    const run = await runQa(runOpts(repo), f.deps);
    assert.deepEqual(run.affected.unmapped, UNMAPPED);
    assert.deepEqual(run.results.unmapped, [{ id: 'unm:1', file: UNMAPPED[0] }]);
    assert.ok(fs.readFileSync(path.join(run.dirs.verification, 'summary.md'), 'utf8').includes('- [unm:1] unmapped: src/features/jobs/JobAdComposePage.tsx — no map entry walks it'));
  });

  test('unmapped: it is carried even when no screen is affected (the very case the pilot found)', async () => {
    const repo = makeRepo();
    const f = s7(repo, { affectedFor: withUnmapped([], ['candidates-list', 'candidate-detail', 'jobs-list']) });
    const run = await runQa(runOpts(repo), f.deps);
    assert.equal(f.calls.captureSide.length, 0);
    assert.deepEqual(run.affected.unmapped, UNMAPPED);
    assert.equal(run.results.unmapped.length, 1);
  });

  test('unmapped: an affected set without the field (a stub) gives [], and a full run has none', async () => {
    const repo = makeRepo();
    const stub = () => ({ names: ['jobs-list'], why: { 'jobs-list': 'new entry' }, total: 3, unknown: 0, skipped: [] });
    const run = await runQa(runOpts(repo), s7(repo, { affectedFor: stub }).deps);
    assert.deepEqual(run.affected.unmapped, []);
    const full = await runQa(runOpts(repo, { full: true }), s7(repo).deps);
    assert.deepEqual(full.results.unmapped, []);
  });
});

describe('step 7: runQa with no affected screen', () => {
  const none = () => ({ names: [], why: {}, total: 3, unknown: 0, skipped: ['candidates-list', 'candidate-detail', 'jobs-list'] });

  test('nothing is captured and nothing is compared, on either side', async () => {
    const repo = makeRepo();
    const f = s7(repo, { affectedFor: none });
    const run = await runQa(runOpts(repo), f.deps);
    assert.equal(f.calls.captureSide.length, 0);
    assert.equal(f.calls.compare.length, 0);
    assert.equal(run.compare, null);
    assert.deepEqual(run.affected, { mode: 'affected', names: [], why: {}, total: 3, unknown: 0, mapThese: [], skipped: 3, unmapped: [] });
  });

  test('the capture steps say why: note "no affected screen", ok true, on base and head', async () => {
    const repo = makeRepo();
    const run = await runQa(runOpts(repo), s7(repo, { affectedFor: none }).deps);
    const captures = stepsOf(run, 'capture');
    assert.deepEqual(captures.map((s) => s.side).sort(), ['base', 'head']);
    for (const s of captures) {
      assert.equal(s.ok, true);
      assert.equal(s.note, 'no affected screen');
    }
  });

  test('the route sweep and the mutants still run: both sandboxes come up, both sweeps, one mutate, both downs', async () => {
    const repo = makeRepo();
    const f = s7(repo, { affectedFor: none });
    await runQa(runOpts(repo), f.deps);
    assert.deepEqual(f.calls.up.map((c) => c.at), [repo.sha2, repo.sha3]);
    assert.equal(f.calls.sweepSide.length, 2);
    assert.equal(f.calls.mutate.length, 1);
    assert.equal(f.calls.down.length, 2);
  });

  test('results and summary are still written, and a clean sweep with no mutants exits 0', async () => {
    const repo = makeRepo();
    const run = await runQa(runOpts(repo), s7(repo, { affectedFor: none }).deps);
    assert.equal(run.exit, 0);
    const V = run.dirs.verification;
    assert.ok(fs.existsSync(path.join(V, 'results.json')));
    assert.ok(fs.existsSync(path.join(V, 'summary.md')));
    assert.deepEqual(run.results.screens, []);
    assert.deepEqual(run.results.failures, []);
  });
});

describe('step 7: runQa full mode', () => {
  test('--full captures every screen on both sides (head: screens null; base: every base screen by name) and sets affected mode full', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    const run = await runQa(runOpts(repo, { full: true }), f.deps);
    assert.equal(f.calls.captureSide.length, 2);
    const { base, head } = sidesOf(f.calls);
    assert.equal(head.screens, null);
    assert.equal(base.screens, 'candidates-list,candidate-detail,jobs-list');
    assert.equal(run.affected.mode, 'full');
    assert.equal(run.affected.total, 3);
    assert.equal(f.calls.affected.length, 0);
  });

  test('coverage is on for the head side only', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    await runQa(runOpts(repo, { full: true }), f.deps);
    const sides = sidesOf(f.calls);
    assert.ok(sides.base && sides.head, 'both sides captured');
    assert.ok(!sides.base.coverage, 'base must not collect coverage');
    assert.equal(sides.head.coverage, true);
  });

  test('an affected run collects no coverage on either side', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    await runQa(runOpts(repo), f.deps);
    for (const c of f.calls.captureSide) assert.ok(!c.coverage);
  });

  test('after the head capture, each area with recorded screens gets one writeSources call: the union over viewports, the head sha', async () => {
    const repo = makeRepo();
    const f = s7(repo, {
      onCapture: (req) => {
        if (!req.out.endsWith(`${path.sep}head`)) return;
        writeAt(req.out, 'desktop', 'candidate-detail__sources.json', ['src/features/candidates/Detail.tsx', 'src/shared/a.ts']);
        writeAt(req.out, 'mobile', 'candidate-detail__sources.json', ['src/shared/a.ts', 'src/shared/b.ts']);
        writeAt(req.out, 'desktop', 'candidates-list__sources.json', ['src/features/candidates/List.tsx']);
      },
    });
    const run = await runQa(runOpts(repo, { full: true, profile: S7_TWO_VIEWPORTS }), f.deps);
    assert.equal(f.calls.writeSources.length, 1, 'jobs has no recorded screen: no call for it');
    const call = f.calls.writeSources[0];
    assert.equal(call.dir, path.join(repo.dir, 'qa', 'map'));
    assert.equal(call.area, 'candidates');
    assert.equal(call.sha, repo.sha3);
    assert.deepEqual(Object.keys(call.screens).sort(), ['candidate-detail', 'candidates-list']);
    assert.deepEqual([...call.screens['candidate-detail']].sort(), ['src/features/candidates/Detail.tsx', 'src/shared/a.ts', 'src/shared/b.ts']);
    assert.deepEqual(call.screens['candidates-list'], ['src/features/candidates/List.tsx']);
    assert.deepEqual(run.sourcesWritten, [path.join(repo.dir, 'qa', 'map', 'candidates.sources.json')]);
    assert.deepEqual(run.results.sourcesWritten, run.sourcesWritten);
  });

  test('one call per area that has recorded screens, in head map order', async () => {
    const repo = makeRepo();
    const f = s7(repo, {
      onCapture: (req) => {
        if (!req.out.endsWith(`${path.sep}head`)) return;
        writeAt(req.out, 'desktop', 'jobs-list__sources.json', ['src/features/jobs/List.tsx']);
        writeAt(req.out, 'desktop', 'candidates-list__sources.json', ['src/features/candidates/List.tsx']);
      },
    });
    const run = await runQa(runOpts(repo, { full: true }), f.deps);
    assert.deepEqual(f.calls.writeSources.map((c) => c.area), ['candidates', 'jobs']);
    assert.equal(run.sourcesWritten.length, 2);
  });

  test('no sources file captured: nothing is written and sourcesWritten is []', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    const run = await runQa(runOpts(repo, { full: true }), f.deps);
    assert.equal(f.calls.writeSources.length, 0);
    assert.deepEqual(run.sourcesWritten, []);
  });

  test('an affected run writes no sources', async () => {
    const repo = makeRepo();
    const f = s7(repo, { onCapture: (req) => writeAt(req.out, 'desktop', 'candidate-detail__sources.json', ['x.ts']) });
    const run = await runQa(runOpts(repo), f.deps);
    assert.equal(f.calls.writeSources.length, 0);
    assert.deepEqual(run.sourcesWritten, []);
  });

  test('--full leaves mutants named (rework: the registry runs only on --mutants all); an explicit mode wins', async () => {
    const repo = makeRepo();
    const a = s7(repo);
    await runQa(runOpts(repo, { full: true }), a.deps);
    assert.equal(a.calls.mutate[0].mode, 'named');
    const b = s7(repo);
    await runQa(runOpts(repo, { full: true, mutants: 'affected' }), b.deps);
    assert.equal(b.calls.mutate[0].mode, 'affected');
    const c = s7(repo);
    await runQa(runOpts(repo, { full: true, mutants: 'none' }), c.deps);
    assert.equal(c.calls.mutate.length, 0);
  });

  test('without --full, mutants are named too', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    await runQa(runOpts(repo), f.deps);
    assert.equal(f.calls.mutate[0].mode, 'named');
  });

  test('--full with --screens is a USAGE RunError and nothing starts', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    const e = await errorOf(runQa(runOpts(repo, { full: true, screens: 'a*' }), f.deps));
    assert.ok(e instanceof RunError);
    assert.equal(e.code, 'USAGE');
    assert.match(e.message, /--full or --screens/);
    assert.equal(f.calls.up.length, 0);
  });
});

describe('step 7: runQa record mode', () => {
  const recordsOf = (f) => f.calls.captureSide.map((c) => c.record);

  test('affected mode defaults to journeys on both sides', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    await runQa(runOpts(repo), f.deps);
    assert.deepEqual(recordsOf(f), ['journeys', 'journeys']);
  });

  test('full mode defaults to none on both sides', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    await runQa(runOpts(repo, { full: true }), f.deps);
    assert.deepEqual(recordsOf(f), ['none', 'none']);
  });

  test('--screens mode defaults to none', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    await runQa(runOpts(repo, { screens: 'jobs-*' }), f.deps);
    assert.deepEqual(recordsOf(f), ['none', 'none']);
  });

  test('an explicit record wins in every mode', async () => {
    for (const [over, want] of [[{ record: 'all' }, 'all'], [{ record: 'none' }, 'none'], [{ record: 'journeys', full: true }, 'journeys'], [{ record: 'all', screens: 'jobs-*' }, 'all']]) {
      const repo = makeRepo();
      const f = s7(repo);
      await runQa(runOpts(repo, over), f.deps);
      assert.deepEqual(recordsOf(f), [want, want], JSON.stringify(over));
    }
  });

  test('a record value other than journeys, all or none is a USAGE RunError and nothing starts', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    const e = await errorOf(runQa(runOpts(repo, { record: 'sometimes' }), f.deps));
    assert.ok(e instanceof RunError);
    assert.equal(e.code, 'USAGE');
    assert.match(e.message, /record/);
    assert.equal(f.calls.up.length, 0);
  });
});

describe('step 7: runQa videos', () => {
  const VIDEO = 'candidate-detail.webm';
  const CHECKPOINTS = [{ state: 'detail', atMs: 4210 }];
  const writeVideo = (out, vp = 'desktop') => {
    writeAt(out, vp, VIDEO, 'webm bytes');
    writeAt(out, vp, 'candidate-detail.checkpoints.json', CHECKPOINTS);
  };

  test('a .webm in a head viewport directory is a video with its parsed checkpoints and absolute file', async () => {
    const repo = makeRepo();
    const f = s7(repo, { onCapture: (req) => req.out.endsWith(`${path.sep}head`) && writeVideo(req.out) });
    const run = await runQa(runOpts(repo), f.deps);
    const headDir = path.join(run.dirs.work, 'head');
    assert.deepEqual(run.videos, [{
      id: 'vid:desktop/candidate-detail', viewport: 'desktop', screen: 'candidate-detail',
      file: path.join(headDir, 'desktop', VIDEO), checkpoints: CHECKPOINTS,
    }]);
    assert.deepEqual(run.results.videos, run.videos);
  });

  test('a video with no checkpoints file has checkpoints []', async () => {
    const repo = makeRepo();
    const f = s7(repo, { onCapture: (req) => req.out.endsWith(`${path.sep}head`) && writeAt(req.out, 'desktop', VIDEO, 'x') });
    const run = await runQa(runOpts(repo), f.deps);
    assert.deepEqual(run.videos.map((v) => v.checkpoints), [[]]);
  });

  test('every viewport is scanned, in the profile viewport order', async () => {
    const repo = makeRepo();
    const f = s7(repo, { onCapture: (req) => req.out.endsWith(`${path.sep}head`) && (writeVideo(req.out, 'mobile'), writeVideo(req.out, 'desktop')) });
    const run = await runQa(runOpts(repo, { profile: S7_TWO_VIEWPORTS }), f.deps);
    assert.deepEqual(run.videos.map((v) => v.id), ['vid:desktop/candidate-detail', 'vid:mobile/candidate-detail']);
  });

  test('no video recorded: videos is []; a video on the base side is not listed', async () => {
    const repo = makeRepo();
    const none = await runQa(runOpts(repo), s7(repo).deps);
    assert.deepEqual(none.videos, []);
    const repo2 = makeRepo();
    const f = s7(repo2, { onCapture: (req) => !req.out.endsWith(`${path.sep}head`) && writeVideo(req.out) });
    const run = await runQa(runOpts(repo2), f.deps);
    assert.deepEqual(run.videos, []);
  });
});

describe('step 7: runQa self mode and the cache key', () => {
  test('self mode walks every screen: screens null, record none, no coverage, affected is not computed', async () => {
    const repo = makeRepo();
    const f = s7(repo);
    const run = await runQa(runOpts(repo, { self: true }), f.deps);
    assert.equal(f.calls.captureSide.length, 2);
    for (const c of f.calls.captureSide) {
      assert.equal(c.screens, null);
      assert.equal(c.record, 'none');
      assert.ok(!c.coverage);
    }
    assert.equal(f.calls.affected.length, 0);
    assert.equal(f.calls.readSources.length, 0);
    assert.equal(run.affected?.mode ?? 'full', 'full');
  });

  test('mapHash extra gains the affected names (sorted) and the record mode for head; the base key has only the walk settings', async () => {
    const repo = makeRepo();
    const f = s7(repo, { affectedFor: () => ({ names: ['b-screen', 'a-screen'], why: {}, total: 2, unknown: 0, skipped: [] }) });
    const run = await runQa(runOpts(repo), f.deps);
    const want = (sha, extra) => mapHash({ repoRoot: repo.dir, sha, profile: profile(), extra });
    const extra = { viewports: null, screens: ['a-screen', 'b-screen'], checks: true, tour: true, record: 'journeys' };
    assert.equal(run.maps.head, want(repo.sha3, extra));
    assert.equal(run.maps.base, want(repo.sha2, { checks: true, tour: true, record: 'journeys' }), 'rework U4: never the PR\'s screens');
    assert.equal(f.calls.captureSide[0].screens, 'b-screen,a-screen', 'capture keeps affected head order; only the key is sorted');
  });

  test('full mode keys with screens null; a different record mode is a different base cache entry', async () => {
    const repo = makeRepo();
    const full = await runQa(runOpts(repo, { full: true }), s7(repo).deps);
    const extra = { viewports: null, screens: null, checks: true, tour: true, record: 'none' };
    assert.equal(full.maps.head, mapHash({ repoRoot: repo.dir, sha: repo.sha3, profile: profile(), extra }));
    const all = await runQa(runOpts(repo, { full: true, record: 'all' }), s7(repo).deps);
    assert.notEqual(all.maps.base, full.maps.base);
  });

  test('a different affected set shares the base cache entry (rework U4): the cache is per screen, so it answers only for screens it holds', async () => {
    const repo = makeRepo();
    const a = await runQa(runOpts(repo), s7(repo).deps);
    const f = s7(repo, { affectedFor: () => ({ names: ['jobs-list'], why: {}, total: 3, unknown: 0, skipped: [] }) });
    const b = await runQa(runOpts(repo), f.deps);
    assert.equal(b.maps.base, a.maps.base);
    assert.equal(b.dirs.cache, a.dirs.cache);
    assert.equal(b.base.cached, false, 'jobs-list was never walked on this base');
    assert.equal(sidesOf(f.calls).base.screens, 'jobs-list');
  });
});

// ── step 8: the standing baseline in self mode ───────────────────────────────

describe('step 8: runQa --baseline', () => {
  const standingFile = (repo) => path.join(repo.dir, 'qa', 'standing.md');
  const idsOf = () => standingItems(compareWith(1)).map(standingId);

  test('self mode with baseline merges the compare standing items into <repoRoot>/qa/standing.md, as diff mode does', async () => {
    const repo = makeRepo();
    const run = await runQa(runOpts(repo, { self: true, baseline: true }), fakes(repo).deps);
    assert.ok(fs.existsSync(standingFile(repo)), 'missing qa/standing.md');
    const text = fs.readFileSync(standingFile(repo), 'utf8');
    assert.equal(idsOf().length, 2);
    for (const id of idsOf()) assert.ok(text.includes(`| ${id} | desktop/detail__default |`), `no row ${id}`);
    assert.ok(text.includes('| 2026-11-06 feat-x-y | 2026-11-06 feat-x-y |'), 'first/last seen is "<date> <slug>"');
    assert.deepEqual(run.standing, { file: 'qa/standing.md', added: 2, seen: 0 });
    assert.equal(run.mode, 'self');
  });

  test('a second self baseline run adds nothing and bumps last seen on the rows it sees again', async () => {
    const repo = makeRepo();
    await runQa(runOpts(repo, { self: true, baseline: true }), fakes(repo).deps);
    const before = fs.readFileSync(standingFile(repo), 'utf8');
    const run = await runQa(runOpts(repo, { self: true, baseline: true }), fakes(repo).deps);
    assert.deepEqual(run.standing, { file: 'qa/standing.md', added: 0, seen: 2 });
    assert.equal(fs.readFileSync(standingFile(repo), 'utf8'), before);
  });

  test('self mode without baseline writes no qa/standing.md and run.standing stays null', async () => {
    const repo = makeRepo();
    const run = await runQa(runOpts(repo, { self: true }), fakes(repo).deps);
    assert.equal(fs.existsSync(standingFile(repo)), false);
    assert.equal(run.standing, null);
  });

  test('self baseline still writes no verdict.draft.md', async () => {
    const repo = makeRepo();
    await runQa(runOpts(repo, { self: true, baseline: true }), fakes(repo).deps);
    assert.equal(fs.existsSync(path.join(repo.dir, 'qa', 'feat-x-y', 'verdict.draft.md')), false);
  });

  test('diff mode ignores baseline: the same standing file and counts with it as without it', async () => {
    const a = makeRepo();
    const b = makeRepo();
    const withFlag = await runQa(runOpts(a, { baseline: true }), fakes(a).deps);
    const without = await runQa(runOpts(b), fakes(b).deps);
    assert.deepEqual(withFlag.standing, without.standing);
    assert.equal(withFlag.standing.added, 2);
    assert.equal(fs.readFileSync(standingFile(a), 'utf8'), fs.readFileSync(standingFile(b), 'utf8'));
  });
});

test('slugOf: the branch with every character outside [A-Za-z0-9._-] made "-"; a detached HEAD is head-<sha10>', async () => {
  const { slugOf } = await import('../scripts/lib/run.mjs');
  assert.equal(slugOf('feat/sale-badge', 'abc'), 'feat-sale-badge');
  assert.equal(slugOf('B01/library', 'abc'), 'B01-library');
  assert.equal(slugOf('fix/a b+c', 'abc'), 'fix-a-b-c');
  assert.equal(slugOf('HEAD', '0123456789abcdef'), 'head-0123456789');
  assert.equal(slugOf(null, '0123456789abcdef'), 'head-0123456789');
});
