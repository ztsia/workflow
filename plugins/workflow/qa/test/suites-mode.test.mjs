// Suites mode (scripts/lib/suitesmode.mjs, and runQa in run.mjs): a project with no map entries and no stack adapter
// that serves an app has its test suites run whole, on the head commit, in a git worktree of it. Each test builds its
// own temp git repo with a passing and a failing `node --test` suite. Nothing here needs a browser or a model.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { loadProfile } from '../scripts/lib/profile.mjs';
import { planCheck } from '../scripts/lib/plan.mjs';
import { prepareCheck, prepareExit, prepareMd } from '../scripts/lib/prepare.mjs';
import { readiness } from '../scripts/lib/ready.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { suiteRecord, suitesModeApplies, withHeadWorktree } from '../scripts/lib/suitesmode.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qa');
const made = [];

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

const PASSING = `import test from 'node:test';
import assert from 'node:assert/strict';
test('adds', () => assert.equal(1 + 1, 2));
test('subtracts', () => assert.equal(3 - 1, 2));
`;
const FAILING = `import test from 'node:test';
import assert from 'node:assert/strict';
test('keeps the title', () => assert.ok(true));
test('refuses an empty name', () => assert.equal(1, 2));
`;

// A repo on branch 'feat/lib' with a passing suite `unit` and, when `failing`, a failing suite `slow`.
function makeRepo({ failing = true, qaJson = true, suites, extra } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-suites-')));
  made.push(dir);
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  write(dir, 'README.md', 'a library\n');
  write(dir, 'src/ok.test.mjs', PASSING);
  write(dir, 'src/bad.test.mjs', FAILING);
  if (qaJson) write(dir, 'qa.json', '{}\n');
  write(dir, 'qa/suites.json', JSON.stringify(suites ?? { suites: { unit: 'node --test src/ok.test.mjs', ...(failing ? { slow: 'node --test src/bad.test.mjs' } : {}) } }, null, 2));
  for (const [rel, text] of Object.entries(extra ?? {})) write(dir, rel, text);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'one'], dir);
  git(['checkout', '-q', '-b', 'feat/lib'], dir);
  write(dir, 'README.md', 'a library, changed\n');
  git(['commit', '-q', '-am', 'two'], dir);
  return dir;
}

const run = (dir, deps = {}, opts = {}) => runQa({ mainRoot: dir, repoRoot: dir, profile: loadProfile(dir).profile, log: () => {}, ...opts }, deps);
const read = (dir, slug, name) => fs.readFileSync(path.join(dir, 'qa', slug, name), 'utf8');

test('applies with no map folder and no stack, not with a map entry or a stack command', () => {
  const dir = makeRepo();
  const profile = loadProfile(dir).profile;
  assert.equal(suitesModeApplies({ repoRoot: dir, mainRoot: dir, profile }).applies, true);
  fs.mkdirSync(path.join(dir, 'qa', 'map'), { recursive: true });
  assert.equal(suitesModeApplies({ repoRoot: dir, mainRoot: dir, profile }).applies, true, 'an empty map folder counts as no entries');
  write(dir, 'qa/map/app.json', '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
  const withMap = suitesModeApplies({ repoRoot: dir, mainRoot: dir, profile });
  assert.equal(withMap.applies, false);
  assert.match(withMap.why, /1 map entry/);
  fs.rmSync(path.join(dir, 'qa', 'map'), { recursive: true });
  const stacked = { ...profile, stack: { ...profile.stack, serve: 'node server.mjs' } };
  const r = suitesModeApplies({ repoRoot: dir, mainRoot: dir, profile: stacked });
  assert.equal(r.applies, false);
  assert.match(r.why, /stack serves the app/);
});

test('a map that does not load is the walk\'s to report, so suites mode does not apply', () => {
  const dir = makeRepo({ extra: { 'qa/map/app.json': '{ not json' } });
  assert.equal(suitesModeApplies({ repoRoot: dir, mainRoot: dir, profile: loadProfile(dir).profile }).applies, false);
});

test('a passing and a failing suite: rows suite:<id>, PASS and FAIL, the failing test named, REJECT', async () => {
  const dir = makeRepo();
  const r = await run(dir);
  assert.equal(r.mode, 'suites');
  assert.equal(r.exit, 1);
  const rows = Object.fromEntries(r.results.expectations.map((e) => [e.id, e]));
  assert.equal(rows['suite:unit'].result, 'met');
  assert.equal(rows['suite:slow'].result, 'NOT MET');
  assert.match(rows['suite:unit'].detail, /^exit 0 · /);
  assert.match(rows['suite:unit'].detail, /node --test .*src\/ok\.test\.mjs/);
  assert.match(rows['suite:slow'].detail, /^exit 1 · /);
  assert.match(rows['suite:slow'].detail, /1 failed/);
  assert.match(rows['suite:slow'].detail, /failing: refuses an empty name/);
  const slow = r.results.suites.find((s) => s.id === 'slow');
  assert.deepEqual(slow.failing, ['refuses an empty name']);
  assert.equal(slow.exit, 1);
  assert.equal(typeof slow.ms, 'number');

  const summary = read(dir, r.slug, 'summary.md');
  assert.match(summary, /^# qa run — feat-lib: a suite fails \(exit 1\)/);
  assert.match(summary, /suites mode/);
  assert.match(summary, /## Suites — 2 run · 1 PASS · 1 FAIL/);
  assert.match(summary, /- \[suite:unit\] PASS — suite unit: exit 0/);
  assert.match(summary, /- \[suite:slow\] FAIL — suite slow: exit 1 .*failing: refuses an empty name/);
  assert.match(read(dir, r.slug, 'verdict.draft.md'), /^# REJECT — feat-lib/);
  assert.match(read(dir, r.slug, 'verdict.draft.md'), /- \[suite:slow\] FAIL — suite slow:/);
  const results = JSON.parse(read(dir, r.slug, 'results.json'));
  assert.equal(results.mode, 'suites');
  assert.equal(results.base, null);
  assert.equal(JSON.parse(read(dir, r.slug, 'run.json')).mode, 'suites');
  assert.equal(fs.existsSync(path.join(dir, 'qa', r.slug, 'verdict.md')), false, 'no verdict.md: it is not BLOCKED');
});

test('all suites green: ACCEPT, exit 0; a missing qa/ready.json is a note, never BLOCKED', async () => {
  const dir = makeRepo({ failing: false });
  const r = await run(dir);
  assert.equal(r.exit, 0);
  assert.equal(r.blocked, null);
  assert.match(read(dir, r.slug, 'verdict.draft.md'), /^# ACCEPT — feat-lib/);
  assert.match(read(dir, r.slug, 'summary.md'), /note: project not proven ready/);
});

test('no sandbox and no capture: no steps but the suites, no sandbox, no base', async () => {
  const dir = makeRepo({ failing: false });
  let upCalls = 0;
  const r = await run(dir, { up: async () => { upCalls += 1; throw new Error('must not be called'); }, captureSide: async () => { throw new Error('must not be called'); } });
  assert.equal(upCalls, 0);
  assert.deepEqual(r.steps.map((s) => `${s.side}.${s.verb}`), ['head.suites']);
  assert.deepEqual(r.sandboxes, { base: null, head: null });
  assert.equal(r.base, null);
});

test('the suites run in a worktree of the head commit, which is removed afterwards', async () => {
  const dir = makeRepo({ failing: false, suites: { suites: { where: 'node -e "console.log(process.cwd()); require(\'fs\').writeFileSync(\'seen.txt\', require(\'fs\').readFileSync(\'README.md\', \'utf8\'))"' } } });
  write(dir, 'README.md', 'uncommitted change\n');
  const r = await run(dir);
  const log = fs.readdirSync(path.join(dir, 'qa', r.slug, 'logs')).filter((f) => f.includes('where'));
  assert.ok(log.length, 'the suite wrote a log');
  const text = fs.readFileSync(path.join(dir, 'qa', r.slug, 'logs', log[0]), 'utf8');
  assert.match(text, /qa-artifacts\/suites-feat-lib-[0-9a-f]{10}/);
  assert.equal(fs.existsSync(path.join(dir, 'seen.txt')), false, 'it did not run in the checkout');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'qa-artifacts')).filter((f) => f.startsWith('suites-')), []);
  assert.doesNotMatch(git(['worktree', 'list'], dir), /qa-artifacts\/suites-/);
  assert.ok(r.warnings.some((w) => /uncommitted/.test(w)), 'uncommitted changes are not in the run');
});

test('the worktree is removed even when a step throws', async () => {
  const dir = makeRepo({ failing: false });
  const head = git(['rev-parse', 'HEAD'], dir);
  await assert.rejects(withHeadWorktree({ repoRoot: dir, mainRoot: dir, headSha: head, slug: 'x' }, async (d) => {
    assert.ok(fs.existsSync(path.join(d, 'src', 'ok.test.mjs')));
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'qa-artifacts')).filter((f) => f.startsWith('suites-')), []);
  assert.doesNotMatch(git(['worktree', 'list'], dir), /qa-artifacts\/suites-/);
  // and a run whose runner throws is BLOCKED, with the worktree gone
  const r = await run(dir, { runSuite: async () => { throw new Error('the runner fell over'); } });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'qa-artifacts')).filter((f) => f.startsWith('suites-')), []);
  assert.equal(r.results.expectations.find((e) => e.id === 'suite:unit').result, 'unverifiable');
});

test('qa-artifacts keeps itself out of git and qa/<slug> writes its own .gitignore', async () => {
  const dir = makeRepo({ failing: false });
  const r = await run(dir);
  assert.equal(git(['status', '--porcelain', '--untracked-files=all'], dir).split('\n').filter((l) => l.includes('qa-artifacts')).length, 0);
  const ignored = read(dir, r.slug, '.gitignore').split('\n');
  for (const name of ['logs/', 'shots/', 'agents/', 'prev/', 'report.html', 'artifact-*.html', 'publish.json', 'published.json', 'verify.log']) assert.ok(ignored.includes(name), name);
});

test('no suites at all: BLOCKED, exit 4, verdict.md written', async () => {
  const dir = makeRepo({ failing: false });
  fs.rmSync(path.join(dir, 'qa', 'suites.json'));
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'no suites'], dir);
  const r = await run(dir);
  assert.equal(r.exit, 4);
  assert.match(r.blocked, /nothing to run/);
  assert.match(read(dir, r.slug, 'verdict.md'), /^# BLOCKED — feat-lib/);
});

test('a suites file with a bad suite: BLOCKED, naming it', async () => {
  const dir = makeRepo({ suites: { suites: { unit: 'node --test src/ok.test.mjs', broken: 42 } } });
  const r = await run(dir);
  assert.equal(r.exit, 4);
  assert.match(r.blocked, /qa\/suites\.json is wrong/);
  assert.match(r.blocked, /broken/);
  assert.match(read(dir, r.slug, 'verdict.draft.md'), /^# BLOCKED — /);
});

test('a suite that times out is a FAIL', async () => {
  const dir = makeRepo({ suites: { suites: { hang: { cmd: 'node -e "setTimeout(() => {}, 60000)"', timeoutMs: 700 } } } });
  const r = await run(dir);
  assert.equal(r.exit, 1);
  const row = r.results.expectations.find((e) => e.id === 'suite:hang');
  assert.equal(row.result, 'NOT MET');
  assert.match(row.detail, /timed out/);
});

test('named test and doc expectations run after the suites, in the worktree', async () => {
  const dir = makeRepo({
    failing: false,
    extra: {
      'docs/guide.md': 'The tool is called Tutti.\n',
      'qa/feat-lib/expectations.json': JSON.stringify([
        { name: 'adds-works', criterion: 'adding works', test: { suite: 'unit', grep: 'adds' } },
        { name: 'guide-names-tutti', criterion: 'the guide names Tutti', doc: { file: 'docs/guide.md', contains: ['Tutti'] } },
      ]),
    },
  });
  const r = await run(dir);
  const rows = Object.fromEntries(r.results.expectations.map((e) => [e.id, e]));
  assert.equal(rows['suite:unit'].result, 'met');
  assert.equal(rows['exp:adds-works'].result, 'met');
  assert.equal(rows['exp:guide-names-tutti'].result, 'met');
  assert.equal(r.exit, 0);
});

test('a test expectation that is not met makes it REJECT', async () => {
  const dir = makeRepo({
    failing: false,
    extra: { 'qa/feat-lib/expectations.json': JSON.stringify([{ name: 'nothing-like-this', test: { suite: 'unit', grep: 'there is no such test' } }]) },
  });
  const r = await run(dir);
  assert.notEqual(r.results.expectations.find((e) => e.id === 'exp:nothing-like-this').result, 'met');
  assert.ok(r.exit === 1 || r.exit === 2);
});

test('a second head rotates the first run into qa/<slug>/prev', async () => {
  const dir = makeRepo({ failing: false });
  const first = await run(dir);
  write(dir, 'README.md', 'again\n');
  git(['commit', '-q', '-am', 'three'], dir);
  await run(dir);
  assert.ok(fs.existsSync(path.join(dir, 'qa', first.slug, 'prev', 'results.json')));
});

test('suiteRecord: counts and the failing names come from the runner output; five on the line, then "and n more"', () => {
  const tap = [
    ...Array.from({ length: 7 }, (_, i) => `not ok ${i + 1} - broken ${i + 1}`),
    'ok 8 - fine',
    '1..8',
    '# tests 8', '# pass 1', '# fail 7',
  ].join('\n');
  const rec = suiteRecord({ id: 'unit', outcome: { command: 'node --test', code: 1, output: tap, timedOut: false }, ms: 1234 });
  assert.equal(rec.result, 'NOT MET');
  assert.equal(rec.failing.length, 7);
  assert.match(rec.detail, /^exit 1 · 1\.2 s · node --test · 1 passed, 7 failed · failing: broken 1; broken 2; broken 3; broken 4; broken 5 and 2 more$/);
  const none = suiteRecord({ id: 'x', outcome: { notRun: 'no test command', command: '' }, ms: 0 });
  assert.equal(none.result, 'unverifiable');
});

test('the real CLI: `qa run` prints the summary head and exits 1; the JSON mode says the same', () => {
  const dir = makeRepo();
  const out = spawnSync(CLI, ['run'], { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /# qa run — feat-lib: a suite fails \(exit 1\)/);
  assert.match(out.stdout, /verdict draft: /);
  const ci = spawnSync(CLI, ['run', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ci.status, 1, ci.stderr);
  const json = JSON.parse(ci.stdout);
  assert.equal(json.exit, 1);
  assert.equal(json.verdict, 'REJECT');
});

// ── prepare check and readiness in suites mode ───────────────────────────────

// The repo of makeRepo, whose branch also adds a test file (and an auth-looking file the check only has a concern about).
function repoWithNewTest(opts = {}) {
  const dir = makeRepo(opts);
  write(dir, 'src/new.test.mjs', "import test from 'node:test';\ntest('new', () => {});\n");
  write(dir, 'src/auth.mjs', 'export const login = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'three'], dir);
  return dir;
}
const prepare = (dir, deps = {}) => prepareCheck({
  mainRoot: dir, repoRoot: dir, profile: loadProfile(dir).profile, slug: 'feat-lib', V: path.join(dir, 'qa', 'feat-lib'),
  head: git(['rev-parse', 'HEAD'], dir), base: git(['rev-parse', 'main'], dir), log: () => {},
}, deps);

test('prepare check: nothing serves the app, so no sandbox is asked for and nothing is BLOCKED', async () => {
  const dir = repoWithNewTest();
  let upCalls = 0;
  const check = await prepare(dir, { up: async () => { upCalls += 1; throw new Error('serve: nothing serves the app'); } });
  assert.equal(upCalls, 0);
  assert.equal(check.blocked, null);
  assert.equal(check.sandbox, null);
  assert.equal(prepareExit(check), 0);
  assert.deepEqual(check.tests.map((t) => [t.file, t.state]), [['src/new.test.mjs', 'not checked']], 'node --test has no list mode: said, not a problem');
  assert.deepEqual(check.problems, []);
  assert.ok(check.concerns.some((c) => /^src\/auth\.mjs: looks like an auth, payment or migration path/.test(c)), 'the auth concern stays');
  const md = prepareMd(check);
  assert.match(md, /· no sandbox ·/);
  assert.doesNotMatch(md, /blocked:/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'qa-artifacts')).filter((f) => f.startsWith('suites-')), [], 'its worktree is gone');
});

test('prepare check: a new test file no suite is registered for is still a problem, in suites mode too', async () => {
  const dir = repoWithNewTest();
  fs.rmSync(path.join(dir, 'qa', 'suites.json'));
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'no suites'], dir);
  const check = await prepare(dir);
  assert.equal(check.blocked, null);
  assert.equal(prepareExit(check), 1);
  assert.match(check.problems[0].text, /no suite is registered in qa\/suites/);
});

test('prepare check: a project with a map entry still brings its sandbox up (not suites mode)', async () => {
  const dir = repoWithNewTest({ extra: { 'qa/map/app.json': '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n' } });
  const check = await prepare(dir, { up: async () => { throw new Error('serve: nothing serves the app'); } });
  assert.match(check.blocked, /nothing serves the app/);
  assert.equal(prepareExit(check), 4);
});

test('the real CLI: `qa prepare check --final` in suites mode exits 0 and writes no BLOCKED verdict', () => {
  const dir = repoWithNewTest();
  const out = spawnSync(CLI, ['prepare', 'check', '--slug', 'feat-lib', '--base', 'main', '--final'], { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  assert.equal(fs.existsSync(path.join(dir, 'qa', 'feat-lib', 'verdict.md')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'qa', 'feat-lib', 'prepare.md'), 'utf8'), /nothing serves the app/);
});

test('readiness: in suites mode the line says there are no screens yet; with screens it is the usual one', () => {
  const dir = makeRepo();
  const profile = loadProfile(dir).profile;
  const r = readiness({ repoRoot: dir, mainRoot: dir, profile });
  assert.equal(r.state, 'missing');
  assert.equal(r.line, 'project not proven ready: no screens yet — qa ready applies once the map has entries');
  write(dir, 'qa/map/app.json', '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
  assert.equal(readiness({ repoRoot: dir, mainRoot: dir, profile }).line, 'project not proven ready: no qa/ready.json — run qa ready (or the qa skill)');
});

test('readiness: the run and `qa ready status` carry the suites-mode line', async () => {
  const dir = makeRepo({ failing: false });
  const r = await run(dir);
  assert.match(read(dir, r.slug, 'summary.md'), /note: project not proven ready: no screens yet — qa ready applies once the map has entries/);
  const out = spawnSync(CLI, ['ready', 'status'], { cwd: dir, encoding: 'utf8' });
  assert.match(out.stdout, /^project not proven ready: no screens yet — qa ready applies once the map has entries$/m);
});

// ── plan check in suites mode ────────────────────────────────────────────────

function planned(dir, expectations, { mutants = null } = {}) {
  const V = path.join(dir, 'qa', 'feat-lib');
  write(dir, 'qa/feat-lib/charter.md', '# Charter — feat-lib\nsecurity: no — x\nstubs: none\n\n- [ch:1] adding works — by: expectation e1\n');
  write(dir, 'qa/feat-lib/expectations.json', JSON.stringify(expectations));
  if (mutants) write(dir, 'qa/feat-lib/mutants.json', JSON.stringify({ mutants }));
  return { V, check: (deps = {}) => planCheck({ mainRoot: dir, repoRoot: dir, profile: loadProfile(dir).profile, slug: 'feat-lib', V, head: git(['rev-parse', 'HEAD'], dir), log: () => {} }, deps) };
}
const noUp = (n) => ({ up: async () => { n.calls += 1; throw new Error('serve: nothing serves the app'); } });

test('plan check: a test expectation is resolved in a worktree of the head commit, no sandbox, not BLOCKED', async () => {
  const dir = makeRepo({ failing: false });
  const n = { calls: 0 };
  const { check } = planned(dir, [{ name: 'e1', criterion: 'ch:1', test: { suite: 'unit', grep: 'adds' } }]);
  const r = await check(noUp(n));
  assert.equal(n.calls, 0);
  assert.equal(r.blocked, null);
  assert.equal(r.sandbox, null);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'qa-artifacts')).filter((f) => f.startsWith('suites-')), [], 'its worktree is gone');
});

test('plan check: a test that matches nothing is a problem the planner can fix, not a block', async () => {
  const dir = makeRepo({ failing: false });
  const { check } = planned(dir, [{ name: 'e1', criterion: 'ch:1', test: { suite: 'unit', grep: 'there is no such test' } }]);
  const r = await check();
  assert.equal(r.blocked, null);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].problem, /0 of 1 test\(s\) match/);
});

test('plan check: a screen expectation has nothing to run on in suites mode: a problem saying so', async () => {
  const dir = makeRepo({ failing: false });
  const { check } = planned(dir, [{ name: 'e1', criterion: 'ch:1', text: 'Home' }]);
  const r = await check();
  assert.equal(r.blocked, null);
  assert.match(r.problems[0].problem, /suites mode: this project has no screens and nothing serves an app/);
});

test('plan check: with a map entry a sandbox is still needed, and one that does not come up BLOCKS', async () => {
  const dir = makeRepo({ failing: false, extra: { 'qa/map/app.json': '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n' } });
  const n = { calls: 0 };
  const { check } = planned(dir, [{ name: 'e1', criterion: 'ch:1', test: { suite: 'unit', grep: 'adds' } }]);
  const r = await check(noUp(n));
  assert.equal(n.calls, 1);
  assert.match(r.blocked, /nothing serves the app/);
});

test('the real CLI: `qa plan check` in suites mode exits 0 for a test that exists', () => {
  const dir = makeRepo({ failing: false });
  planned(dir, [{ name: 'e1', criterion: 'ch:1', test: { suite: 'unit', grep: 'adds' } }]);
  const out = spawnSync(CLI, ['plan', 'check', '--slug', 'feat-lib'], { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /no sandbox/);
});
