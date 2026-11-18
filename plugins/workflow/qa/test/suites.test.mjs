// The rework's suites and evidence rules (scripts/lib/suites.mjs, tests.mjs, mutants.mjs, setup.mjs; their CONTRACT
// comments are the spec): suites in qa/suites.* with the old SUITES of qa/mutants.* as a fallback, shell-string
// suites, file-scoped test entries, per-suite timeouts, evidence that never runs a whole suite, and mutants judged
// by the one test the planner names. Real `node --test` files run in temp worktrees.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { cmdOf, loadSuites, suiteProblem, timeoutOf } from '../scripts/lib/suites.mjs';
import { commandFor, entryProblem, runTests } from '../scripts/lib/tests.mjs';
import { loadMutants, makeRunKill, mutantsResult, runMutants, selectMutants, unnamedNote } from '../scripts/lib/mutants.mjs';
import { detectSuites, writeSuites } from '../scripts/lib/setup.mjs';
import { readyInputs, suitesCheck } from '../scripts/lib/ready.mjs';
import { refreshQaFiles, seedQaFiles } from '../scripts/lib/sandbox.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix = 'mfqa-suites-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

const NOTE = 'suites read from qa/mutants.ts, their old place: move them to qa/suites.json (or SUITES in qa/suites.ts)';

// ── loading ───────────────────────────────────────────────────────────────────

describe('loadSuites: qa/suites.* first, the old SUITES of qa/mutants.* after', () => {
  test('qa/suites.json { suites } is read; object forms are kept as written', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.json', { suites: { unit: 'npx vitest run', e2e: { cmd: ['npx', 'playwright', 'test'], timeoutMs: 120000 } } });
    const r = await loadSuites({ root, profile: {} });
    assert.deepEqual(r, { file: 'qa/suites.json', suites: { unit: 'npx vitest run', e2e: { cmd: ['npx', 'playwright', 'test'], timeoutMs: 120000 } }, errors: [], legacy: false, note: null });
  });

  test('qa/suites.json without the suites key is an error naming the shape, never zero suites in silence', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.json', { unit: { cmd: ['node', '--test'] } });
    const r = await loadSuites({ root, profile: {} });
    assert.deepEqual(r.suites, {});
    assert.deepEqual(r.errors, ['qa/suites.json: no "suites" key: write { "suites": { "<id>": <suite> } }']);
  });

  test('qa/suites.ts exports SUITES, with TypeScript types stripped', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.ts', "export const SUITES: Record<string, string | string[]> = { unit: ['node', '--test'] } as const;\n");
    const r = await loadSuites({ root, profile: {} });
    assert.equal(r.file, 'qa/suites.ts');
    assert.deepEqual(r.suites, { unit: ['node', '--test'] });
  });

  test('no suites file: the SUITES of qa/mutants.ts are read, with the one-line note', async () => {
    const root = tmpDir();
    write(root, 'qa/mutants.ts', "export const SUITES = { unit: 'node --test' };\nexport const MUTANTS = [];\n");
    const r = await loadSuites({ root, profile: {} });
    assert.deepEqual(r, { file: 'qa/mutants.ts', suites: { unit: 'node --test' }, errors: [], legacy: true, note: NOTE });
  });

  test('a suites file wins over the old SUITES, which are then not read at all', async () => {
    const root = tmpDir();
    write(root, 'qa/mutants.json', { suites: { old: 'node --test' }, mutants: [] });
    write(root, 'qa/suites.json', { suites: { unit: 'node --test test/' } });
    const r = await loadSuites({ root, profile: {} });
    assert.equal(r.file, 'qa/suites.json');
    assert.deepEqual(Object.keys(r.suites), ['unit']);
    assert.equal(r.note, null);
  });

  test('a mutant registry with MUTANTS only and no suites file: no suites, no note', async () => {
    const root = tmpDir();
    write(root, 'qa/mutants.json', { mutants: [] });
    assert.deepEqual(await loadSuites({ root, profile: {} }), { file: null, suites: {}, errors: [], legacy: false, note: null });
  });

  test('a bad suite is dropped with its reason; a file that does not parse is one error and no suites', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.json', { suites: { a: '', b: { cmd: 'x', timeoutMs: -5 }, c: { cmd: 'x', command: 'y' }, d: 'ok' } });
    const r = await loadSuites({ root, profile: {} });
    assert.deepEqual(r.suites, { d: 'ok' });
    assert.deepEqual(r.errors, [
      "qa/suites.json: suite a: not a command, an argv list, 'test:<level>' or { cmd, timeoutMs }",
      'qa/suites.json: suite b: timeoutMs must be a whole number of ms above 0',
      'qa/suites.json: suite c: { cmd, timeoutMs, covers } only, not command',
    ]);
    const broken = tmpDir();
    write(broken, 'qa/suites.json', '{ "suites": ');
    const b = await loadSuites({ root: broken, profile: {} });
    assert.deepEqual(b.suites, {});
    assert.equal(b.errors.length, 1);
    assert.match(b.errors[0], /^qa\/suites\.json: /);
  });

  test('U8: covers, the globs of the files a suite\'s tests exercise, is kept; anything but a list of globs is a problem', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.json', { suites: { unit: { cmd: 'npx vitest run', covers: ['src/lib/**'] }, bad: { cmd: 'x', covers: 'src/**' } } });
    const r = await loadSuites({ root, profile: {} });
    assert.deepEqual(r.suites, { unit: { cmd: 'npx vitest run', covers: ['src/lib/**'] } });
    assert.deepEqual(r.errors, ['qa/suites.json: suite bad: covers must be a list of globs']);
    assert.equal(cmdOf({ cmd: 'x', covers: ['a/**'] }), 'x');
  });

  test('cmdOf, suiteProblem and timeoutOf read every form', () => {
    assert.equal(cmdOf('npx jest'), 'npx jest');
    assert.deepEqual(cmdOf({ cmd: ['pytest'] }), ['pytest']);
    assert.equal(cmdOf({ timeoutMs: 5 }), null);
    assert.equal(suiteProblem('test:unit'), null);
    assert.equal(timeoutOf({ cmd: 'x', timeoutMs: 1234 }, { mutants: { timeoutMs: 99 } }), 1234);
    assert.equal(timeoutOf('x', { mutants: { timeoutMs: 99 } }), 99);
    assert.equal(timeoutOf('x', {}), 900000);
  });

  test('loadMutants takes MUTANTS from qa/mutants.* and the suites from qa/suites.*', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.json', { suites: { unit: 'node --test' } });
    write(root, 'qa/mutants.json', { mutants: [{ id: 'guard-off', breaks: 'x', file: 'a.js', find: 'a', replace: 'b', suite: 'unit' }] });
    const r = await loadMutants({ root, profile: {} });
    assert.equal(r.file, 'qa/mutants.json');
    assert.equal(r.suitesFile, 'qa/suites.json');
    assert.deepEqual(r.suites, { unit: 'node --test' });
    assert.deepEqual(r.mutants.map((m) => [m.id, m.suite]), [['guard-off', 'unit']]);
    assert.deepEqual(r.errors, []);
  });
});

// ── setup and ready ───────────────────────────────────────────────────────────

describe('setup suites writes qa/suites.json; ready reads it', () => {
  test('writeSuites makes qa/suites.json, then merges: new ids added, ids already there kept as they are', async () => {
    const root = tmpDir();
    assert.deepEqual(await writeSuites(root, { unit: 'npx vitest run' }), { file: 'qa/suites.json', added: ['unit'], kept: [], moved: [] });
    assert.deepEqual(await writeSuites(root, { unit: 'npx jest', e2e: { cmd: 'npx playwright test', timeoutMs: 600000 } }), { file: 'qa/suites.json', added: ['e2e'], kept: ['unit'], moved: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'qa/suites.json'), 'utf8')), { suites: { unit: 'npx vitest run', e2e: { cmd: 'npx playwright test', timeoutMs: 600000 } } });
  });

  test('writeSuites moves the old SUITES of qa/mutants.* into qa/suites.json with the new ones', async () => {
    const root = tmpDir();
    write(root, 'qa/mutants.ts', "export const SUITES = { db: 'test:db' };\nexport const MUTANTS = [];\n");
    assert.deepEqual(await writeSuites(root, { unit: 'node --test' }), { file: 'qa/suites.json', added: ['unit'], kept: [], moved: ['db'] });
    const r = await loadSuites({ root, profile: {} });
    assert.deepEqual(r.suites, { db: 'test:db', unit: 'node --test' });
    assert.equal(r.note, null);
  });

  test('writeSuites never edits a qa/suites.ts and refuses a bad suite, writing nothing', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.ts', "export const SUITES = { unit: 'node --test' };\n");
    await assert.rejects(writeSuites(root, { e2e: 'npx playwright test' }), /^Error: qa\/suites\.ts is code, so qa does not edit it: add to its SUITES e2e: "npx playwright test"$/);
    await assert.rejects(writeSuites(tmpDir(), { bad: { cmd: 'x', timeoutMs: 0 } }), /suite bad: timeoutMs/);
  });

  test('detectSuites names the suites file and where a write goes; the old place gives its note', async () => {
    const root = tmpDir();
    write(root, 'qa/mutants.ts', "export const SUITES = { unit: 'npx vitest run' };\nexport const MUTANTS = [];\n");
    write(root, 'package.json', JSON.stringify({ devDependencies: { vitest: '1', '@playwright/test': '1' } }));
    const r = await detectSuites(root);
    assert.equal(r.registry, 'qa/mutants.ts');
    assert.equal(r.write, 'qa/suites.json');
    assert.equal(r.note, NOTE);
    assert.deepEqual(r.proposed.map((p) => p.id), ['e2e'], 'vitest is already registered by its command');
  });

  test('suitesCheck names qa/suites.json in its fixes, and carries the note of the old place', () => {
    const none = suitesCheck({ loaded: { file: null, suites: {}, errors: [] } });
    assert.match(none.items[0].fix, /qa\/suites\.json \{ "suites": \{ "unit": "npx vitest run" \} \}/);
    const old = suitesCheck({ loaded: { file: 'qa/mutants.ts', suites: { unit: 'x' }, errors: [], note: NOTE }, outcomes: { unit: { code: 0, output: 'ok 1 - a\n' } } });
    assert.equal(old.summary, `1 of 1 suite(s) name their tests and pass · ${NOTE}`);
    const slow = suitesCheck({ loaded: { file: 'qa/suites.json', suites: { e2e: 'x' }, errors: [] }, outcomes: { e2e: { code: 124, timedOut: true, output: 'ok 1 - a\n' } } });
    assert.match(slow.items[0].fix, /give suite e2e its own limit in qa\/suites\.json \(\{ "cmd": …, "timeoutMs": … \}\)/);
  });

  test('readyInputs hashes qa/suites.* (a change there makes qa/ready.json stale)', () => {
    const root = tmpDir();
    write(root, 'qa/mutants.json', { mutants: [] });
    const before = readyInputs({ repoRoot: root, mainRoot: root, profile: {} }).suites;
    write(root, 'qa/suites.json', { suites: { unit: 'node --test' } });
    const after = readyInputs({ repoRoot: root, mainRoot: root, profile: {} }).suites;
    assert.notEqual(after, before);
  });

  test('seedQaFiles: a commit with its own qa/ and no suites file gets the checkout\'s suites file alone', () => {
    const from = tmpDir();
    write(from, 'qa/suites.json', { suites: { unit: 'node --test' } });
    write(from, 'qa/map/app.json', '{}');
    const dir = tmpDir();
    write(dir, 'qa/map/own.json', '{}');
    assert.deepEqual(seedQaFiles({ from, dir }), ['qa/suites.json']);
    assert.equal(fs.existsSync(path.join(dir, 'qa/map/app.json')), false, 'the map is never mixed');
    assert.deepEqual(seedQaFiles({ from, dir }), [], 'a second seed copies nothing');
  });
});

describe('refreshQaFiles (1.0.4: a suite published after the sandbox came up)', () => {
  test('a seeded copy that differs from the checkout is replaced whole; an equal one and one never seeded are left', () => {
    const from = tmpDir();
    write(from, 'qa/suites.json', { suites: { mcp: 'x' } });
    write(from, 'qa.json', { a: 1 });
    const dir = tmpDir();
    assert.deepEqual(seedQaFiles({ from, dir }).sort(), ['qa', 'qa.json']);
    write(from, 'qa/suites.json', { suites: { mcp: 'x', unit: 'pytest "$QA_TEST_FILE"' } });
    write(dir, 'qa/extra.json', '{}');
    assert.deepEqual(refreshQaFiles({ from, dir, names: ['qa', 'qa.json'] }), ['qa']);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'qa/suites.json'), 'utf8')).suites), ['mcp', 'unit']);
    assert.equal(fs.existsSync(path.join(dir, 'qa/extra.json')), false, 'replaced whole, as the checkout has it');
    assert.deepEqual(refreshQaFiles({ from, dir, names: ['qa', 'qa.json'] }), [], 'nothing differs now');
    assert.deepEqual(refreshQaFiles({ from, dir, names: [] }), [], 'a file the commit carries (never seeded) is never touched');
  });
});

// ── commands: shell strings, files ────────────────────────────────────────────

describe('commandFor: shell strings like argv lists, and the test file', () => {
  const R = '/logs/x.report';
  test('a shell string of a known runner gets the filter and reporter appended at its end, as an argv list does', () => {
    const s = commandFor('pnpm exec playwright test --config e2e/pw.config.ts', { grep: 'a tap clears it', report: R });
    const a = commandFor(['pnpm', 'exec', 'playwright', 'test', '--config', 'e2e/pw.config.ts'], { grep: 'a tap clears it', report: R });
    assert.equal(s.shown, "pnpm exec playwright test --config e2e/pw.config.ts '--grep' 'a tap clears it' '--reporter' 'json'");
    assert.equal(a.shown, "pnpm exec playwright test --config e2e/pw.config.ts --grep 'a tap clears it' --reporter json");
    for (const c of [s, a]) assert.deepEqual([c.runner, c.filtered, c.narrowed], ['playwright', true, true]);
  });

  test('a string with ; & | < > ` or $( is never edited: no filter, no reporter, the env only', () => {
    for (const line of ['cd web && npx vitest run', 'npx vitest run | tee out', 'npx vitest run; true', 'npx vitest run > log', 'npx vitest $(echo run)']) {
      const c = commandFor(line, { grep: 'x', report: R, testFile: '/w/a.test.ts' });
      assert.equal(c.shown, line);
      assert.deepEqual([c.runner, c.filtered, c.scoped, c.narrowed], [null, false, false, false], line);
      assert.equal(c.env.QA_TEST_GREP, 'x');
      assert.equal(c.env.QA_TEST_FILE, '/w/a.test.ts');
    }
    assert.equal(commandFor('cd web && npx vitest run -t "$QA_TEST_GREP"', { grep: 'x', report: R }).narrowed, true, 'a line that reads $QA_TEST_GREP filters itself');
  });

  test('the test file goes last: the path itself, --runTestsByPath for jest, and after the options for node', () => {
    const F = '/w/src/a.test.ts';
    assert.equal(commandFor(['npx', 'vitest', 'run'], { grep: 'x', report: R, testFile: F }).shown, `npx vitest run -t x --reporter=json --outputFile=${R} ${F}`);
    assert.equal(commandFor('npx jest', { grep: 'x', report: R, testFile: F }).shown, `npx jest '-t' 'x' '--json' '--outputFile=${R}' '--runTestsByPath' '${F}'`);
    assert.equal(commandFor(['uv', 'run', '--directory', 'apps/server', 'pytest'], { grep: 'test_a', report: R, testFile: '/w/apps/server/tests/t.py' }).shown,
      `uv run --directory apps/server pytest --junitxml=${R} -k test_a /w/apps/server/tests/t.py`);
    assert.equal(commandFor(['node', '--test', '--import', 'tsx'], { grep: 'x', report: R, testFile: F }).shown, `node --test --test-reporter=tap --test-name-pattern=x --import tsx ${F}`);
  });

  test('a known runner that cannot take the grep is narrowed by a file alone; without one it is not', () => {
    const bare = commandFor(['pytest'], { grep: 'a sentence, not one word', report: R });
    assert.deepEqual([bare.filtered, bare.scoped, bare.narrowed], [false, false, false]);
    const filed = commandFor(['pytest'], { grep: 'a sentence, not one word', report: R, testFile: '/w/t.py' });
    assert.deepEqual([filed.filtered, filed.scoped, filed.narrowed], [false, true, true]);
    assert.equal(commandFor(['npx', 'playwright', 'test', '-g', '@smoke'], { grep: 'x', report: R }).narrowed, true, 'a suite with a filter of its own is a subset');
  });

  test('entryProblem: test.file must be relative to the repo root', () => {
    const e = (file) => ({ name: 'a', test: { suite: 'unit', grep: 'x', file } });
    assert.equal(entryProblem(e('test/a.test.mjs'), { unit: 'x' }), null);
    for (const bad of ['/abs/a.mjs', '../out.mjs', 'test/../../x.mjs', '']) assert.equal(entryProblem(e(bad), { unit: 'x' }), 'test.file must be a path relative to the repo root', bad);
  });
});

// ── runTests: named tests only ────────────────────────────────────────────────

const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

// Two node:test files: the one an entry names, and a slow one that must never run with it.
function evidenceTree() {
  const dir = tmpDir('mfqa-evidence-');
  write(dir, 'test/charts.test.mjs', `import test from 'node:test';
test('a tap on a bar lights only it', () => {});
test('a seventh series is refused', () => { throw new Error('accepted it'); });
`);
  write(dir, 'test/slow.test.mjs', `import test from 'node:test';
test('a slow one', async () => { await new Promise((r) => setTimeout(r, 30000)); });
`);
  return dir;
}

describe('runTests: only the named test, never the whole suite', () => {
  test('a file-scoped entry runs only that file (the slow file never starts), filtered by name', { timeout: 30000 }, async () => {
    const dir = evidenceTree();
    const [r] = await runTests({
      dir, suites: { unit: 'node --test' }, logDir: tmpDir('mfqa-logs-'),
      entries: [{ name: 'tap', criterion: 'ch:3', test: { suite: 'unit', grep: 'a tap on a bar lights only it', file: 'test/charts.test.mjs' } }],
      exec: async (req) => (await import('../scripts/lib/tests.mjs')).execCommand({ ...req, env: { ...req.env, ...childEnv() } }),
    });
    assert.equal(r.result, 'met', r.why);
    assert.equal(r.file, 'test/charts.test.mjs');
    assert.match(r.command, /test\/charts\.test\.mjs'?$/);
    assert.ok(r.ms < 20000, `took ${r.ms} ms: the slow file ran`);
    assert.equal(r.detail, 'ch:3 · unit "a tap on a bar lights only it": 1 of 1 matched passed (1 ran, tap)');
  });

  test('a file that is not in the head tree is unverifiable and nothing runs', async () => {
    let ran = 0;
    const [r] = await runTests({
      dir: evidenceTree(), suites: { unit: 'node --test' }, logDir: tmpDir('mfqa-logs-'), exec: async () => { ran += 1; return { code: 0, output: '' }; },
      entries: [{ name: 'gone', test: { suite: 'unit', grep: 'x', file: 'test/missing.test.mjs' } }],
    });
    assert.equal(ran, 0);
    assert.equal(r.why, 'not run: test.file test/missing.test.mjs is not in the head tree');
  });

  test('a registered suite that is test:<level> runs the stack verb with the grep and the file in its env', async () => {
    const dir = evidenceTree();
    const calls = [];
    const runVerb = async (verb, req) => { calls.push({ verb, ...req }); return { code: 0, stdout: 'ok 1 - a tap on a bar lights only it\n', stderr: '', ms: 1 }; };
    const [r] = await runTests({
      dir, suites: { db: 'test:db' }, logDir: tmpDir('mfqa-logs-'), runVerb,
      entries: [{ name: 'tap', test: { suite: 'db', grep: 'a tap on a bar', file: 'test/charts.test.mjs' } }],
    });
    assert.equal(r.result, 'met', r.why);
    assert.deepEqual([calls[0].verb, calls[0].args, calls[0].env.QA_TEST_GREP, calls[0].env.QA_TEST_FILE], ['test', ['db'], 'a tap on a bar', path.join(dir, 'test/charts.test.mjs')]);
  });

  test('a suite\'s own timeoutMs is the limit of its run; the profile default otherwise', async () => {
    const seen = [];
    const exec = async (req) => { seen.push(req.timeoutMs); return { code: 0, output: 'ok 1 - x\n', ms: 1 }; };
    await runTests({
      dir: evidenceTree(), suites: { fast: { cmd: 'node --test', timeoutMs: 4321 }, slow: 'node --test' }, profile: { mutants: { timeoutMs: 777 } }, logDir: tmpDir('mfqa-logs-'), exec,
      entries: [{ name: 'a', test: { suite: 'fast', grep: 'x' } }, { name: 'b', test: { suite: 'slow', grep: 'x' } }],
    });
    assert.deepEqual(seen, [4321, 777]);
  });

  test('suites null: read from the tree; the old place is logged with its note', async () => {
    const dir = evidenceTree();
    write(dir, 'qa/mutants.ts', "export const SUITES = { unit: 'node --test' };\nexport const MUTANTS = [];\n");
    const logged = [];
    await runTests({ dir, logDir: tmpDir('mfqa-logs-'), log: (l) => logged.push(l), exec: async () => ({ code: 0, output: '' }), entries: [{ name: 'a', test: { suite: 'unit', grep: 'x' } }] });
    assert.ok(logged.includes(`note: ${NOTE}`), logged.join('\n'));
  });
});

// ── mutants with a killing test ───────────────────────────────────────────────

// A guard and the test that holds it; another test that never looks at the guard.
function guardTree() {
  const dir = tmpDir('mfqa-guard-');
  write(dir, 'src/guard.mjs', "export const allowed = (who, owner) => who === owner;\n");
  write(dir, 'test/guard.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { allowed } from '../src/guard.mjs';
test('a peer cannot move my row', () => { assert.equal(allowed('peer', 'me'), false); });
test('the owner can', () => { assert.equal(allowed('me', 'me'), true); });
`);
  return dir;
}

const realExec = async (req) => (await import('../scripts/lib/tests.mjs')).execCommand({ ...req, env: { ...req.env, ...childEnv() } });
const guardMutant = (over = {}) => ({
  id: 'owner-check-dropped', origin: 'verify', breaks: 'a peer can move my row', file: 'src/guard.mjs',
  find: 'who === owner', replace: 'true', suite: 'unit', kill: { suite: 'unit', grep: 'a peer cannot move my row', file: 'test/guard.test.mjs' }, ...over,
});

describe('mutants: only with a named killing test, and only that test runs', () => {
  test('the kill test is green unmutated and red with the edit: killed; no whole suite ran; the file is restored', { timeout: 60000 }, async () => {
    const dir = guardTree();
    const suites = { unit: 'node --test' };
    const logDir = tmpDir('mfqa-logs-');
    let suiteRuns = 0;
    const runKill = makeRunKill({ dir, suites, profile: {}, logDir, exec: realExec });
    const run = await runMutants({ dir, mutants: [guardMutant()], suites, runSuite: async () => { suiteRuns += 1; return { passed: true }; }, runKill });
    assert.equal(suiteRuns, 0);
    const [m] = run.mutants;
    assert.equal(m.verdict, 'killed', m.detail);
    assert.match(m.detail, /^kill test unit "a peer cannot move my row" in test\/guard\.test\.mjs failed with the mutant: 1 of 1 matched failed/);
    assert.equal(fs.readFileSync(path.join(dir, 'src/guard.mjs'), 'utf8'), "export const allowed = (who, owner) => who === owner;\n");
    assert.deepEqual(run.suites, {});
  });

  test('a kill test that does not look at the guard: SURVIVED, with what still passed', { timeout: 60000 }, async () => {
    const dir = guardTree();
    const suites = { unit: 'node --test' };
    const runKill = makeRunKill({ dir, suites, profile: {}, logDir: tmpDir('mfqa-logs-'), exec: realExec });
    const run = await runMutants({ dir, mutants: [guardMutant({ kill: { suite: 'unit', grep: 'the owner can', file: 'test/guard.test.mjs' } })], suites, runSuite: async () => ({ passed: true }), runKill });
    assert.equal(run.mutants[0].verdict, 'SURVIVED');
    assert.equal(run.mutants[0].detail, 'kill test unit "the owner can" in test/guard.test.mjs still passes with the mutant');
    const r = mutantsResult(run, { mode: 'named', file: null, errors: [] });
    assert.deepEqual(r.survived[0].kill, { suite: 'unit', grep: 'the owner can', file: 'test/guard.test.mjs' });
  });

  test('a kill test not green unmutated: not judged, and the edit is never made; a stale find: nothing runs', async () => {
    const dir = guardTree();
    const asked = [];
    const runKill = async (m, label) => { asked.push(label); return { result: 'unverifiable', why: '0 of 2 test(s) match (tap)' }; };
    const run = await runMutants({ dir, mutants: [guardMutant(), guardMutant({ id: 'gone', find: 'nowhere' })], suites: {}, runSuite: async () => ({ passed: true }), runKill });
    assert.deepEqual(run.mutants.map((m) => [m.verdict, m.detail]), [
      ['not judged', 'kill test unit "a peer cannot move my row" in test/guard.test.mjs: not green unmutated: 0 of 2 test(s) match (tap)'],
      ['stale', 'stale: found 0 times'],
    ]);
    assert.deepEqual(asked, ['clean-owner-check-dropped']);
  });

  test('loadMutants takes kill; a proposal with a kill may leave out suite; a bad kill drops it', async () => {
    const root = tmpDir();
    write(root, 'qa/suites.json', { suites: { unit: 'node --test' } });
    const V = tmpDir('mfqa-v-');
    const { kill, suite, ...noSuite } = guardMutant();
    write(V, 'mutants.json', { mutants: [{ ...noSuite, kill }, { ...noSuite, id: 'bad-kill', kill: { suite: 'nope', grep: 'x' } }, { ...noSuite, id: 'no-kill', suite }] });
    const r = await loadMutants({ root, profile: {}, proposals: path.join(V, 'mutants.json') });
    assert.deepEqual(r.mutants.map((m) => [m.id, m.suite, m.kill?.grep ?? null]), [['owner-check-dropped', 'unit', 'a peer cannot move my row'], ['no-kill', 'unit', null]]);
    assert.deepEqual(r.errors, [`${path.join(V, 'mutants.json')}: mutant 2: kill: unknown suite "nope" (known: unit or test:<level>)`]);
    assert.deepEqual(selectMutants(r.mutants).map((m) => m.id), ['owner-check-dropped']);
    assert.deepEqual(unnamedNote(r.mutants, 'V/mutants.json'), ['V/mutants.json: mutant no-kill: no kill test (kill: { suite, grep }), so it is not run']);
  });
});

test('summary: a SURVIVED mutant judged by its kill test says which test still passed', async () => {
  const { mutantText } = await import('../scripts/lib/summary.mjs');
  const m = { breaks: 'a peer can move my row', file: 'src/guard.mjs', suite: 'unit', detail: 'kill test unit "the owner can" still passes with the mutant' };
  assert.equal(mutantText(m, 'survived'), 'SURVIVED: a peer can move my row (src/guard.mjs, suite unit) — kill test unit "the owner can" still passes with the mutant');
});
