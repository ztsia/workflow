// Breakage checks (scripts/lib/mutants.mjs) against a temp dir as the worktree. Suites are injected
// (runSuite / runVerb) except one makeRunSuite test that spawns a real `node check.mjs` command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMutant,
  loadMutants,
  makeRunSuite,
  mutantsResult,
  restoreMutant,
  runMutants,
  selectMutants,
} from '../scripts/lib/mutants.mjs';

const PROFILE = {};
const PREFIX = /^qa\/mutants\.json: mutant \d+: /;

// A temp worktree with src/a.js holding 'ok 1' once, the text every mutant below replaces with 'ok 2'.
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-mut-'));
  write(dir, 'src/a.js', 'ok 1\n');
  return dir;
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const json = (root, rel, obj) => write(root, rel, JSON.stringify(obj, null, 2));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// A registry mutant. An undefined field is left out of the JSON, which is how the validation tests drop it.
const mutant = (id, over = {}) => ({
  id,
  breaks: `${id} breaks`,
  file: 'src/a.js',
  find: 'ok 1',
  replace: 'ok 2',
  suite: 'unit',
  ...over,
});

// The fields loadMutants must keep, so the origin and normalisation do not matter to these checks.
const pick = (m) => ({
  id: m.id,
  origin: m.origin,
  breaks: m.breaks,
  file: m.file,
  find: m.find,
  replace: m.replace,
  suite: m.suite,
});

// A registry at qa/mutants.json under a fresh root, loaded with no proposals.
async function loadRegistry(mutants, suites = { unit: 'node check.mjs' }) {
  const root = fresh();
  json(root, 'qa/mutants.json', { suites, mutants });
  return loadMutants({ root, profile: PROFILE, proposals: null });
}

// The mutant-run entry the tests below need: a registry mutant on src/a.js with a suite 'unit'.
const mut = (id, over = {}) => mutant(id, { origin: 'registry', ...over });

// --- loadMutants --------------------------------------------------------------------------------

test('loadMutants reads the registry at qa/mutants.json: suites, registry mutants, no errors', async () => {
  const root = fresh();
  json(root, 'qa/mutants.json', { suites: { unit: 'node check.mjs' }, mutants: [mutant('a-one')] });
  const got = await loadMutants({ root, profile: PROFILE, proposals: null });

  assert.equal(got.file, 'qa/mutants.json');
  assert.deepEqual(got.suites, { unit: 'node check.mjs' });
  assert.deepEqual(got.mutants.map(pick), [
    { id: 'a-one', origin: 'registry', breaks: 'a-one breaks', file: 'src/a.js', find: 'ok 1', replace: 'ok 2', suite: 'unit' },
  ]);
  assert.deepEqual(got.errors, []);
});

test('loadMutants reads the registry at qa/mutants.mjs, which exports SUITES and MUTANTS', async () => {
  const root = fresh();
  write(
    root,
    'qa/mutants.mjs',
    `export const SUITES = { unit: ['node', 'check.mjs'] };\nexport const MUTANTS = ${JSON.stringify([mutant('m-one')])};\n`,
  );
  const got = await loadMutants({ root, profile: PROFILE, proposals: null });

  assert.equal(got.file, 'qa/mutants.mjs');
  assert.deepEqual(got.suites, { unit: ['node', 'check.mjs'] });
  assert.deepEqual(got.mutants.map((m) => [m.id, m.origin]), [['m-one', 'registry']]);
  assert.deepEqual(got.errors, []);
});

test('loadMutants prefers qa/mutants.json over qa/mutants.mjs when both exist', async () => {
  const root = fresh();
  json(root, 'qa/mutants.json', { suites: { unit: 'node check.mjs' }, mutants: [mutant('from-json')] });
  write(
    root,
    'qa/mutants.mjs',
    `export const SUITES = { unit: ['node', 'check.mjs'] };\nexport const MUTANTS = ${JSON.stringify([mutant('from-mjs')])};\n`,
  );
  const got = await loadMutants({ root, profile: PROFILE, proposals: null });

  assert.equal(got.file, 'qa/mutants.json');
  assert.deepEqual(got.mutants.map((m) => m.id), ['from-json']);
});

test('loadMutants reads the registry named by profile.mutants.file, relative to the tree', async () => {
  const root = fresh();
  json(root, 'qa/mutants.json', { suites: { unit: 'node check.mjs' }, mutants: [mutant('default-one')] });
  json(root, 'tools/breakage.json', { suites: { unit: 'node check.mjs' }, mutants: [mutant('override-one')] });
  const got = await loadMutants({ root, profile: { mutants: { file: 'tools/breakage.json' } }, proposals: null });

  assert.equal(got.file, 'tools/breakage.json');
  assert.deepEqual(got.mutants.map((m) => m.id), ['override-one']);
  assert.deepEqual(got.errors, []);
});

test('loadMutants adds proposals with origin verify and drops a proposal whose id the registry holds', async () => {
  const root = fresh();
  json(root, 'qa/mutants.json', { suites: { unit: 'node check.mjs' }, mutants: [mutant('reg-one', { breaks: 'registry breaks' })] });
  const verif = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-verif-'));
  const proposals = path.join(verif, 'mutants.json');
  json(verif, 'mutants.json', {
    mutants: [mutant('verify-one', { breaks: 'verify breaks' }), mutant('reg-one', { breaks: 'proposal breaks' })],
  });
  const got = await loadMutants({ root, profile: PROFILE, proposals });

  const byId = Object.fromEntries(got.mutants.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId).sort(), ['reg-one', 'verify-one']);
  assert.equal(byId['verify-one'].origin, 'verify');
  assert.equal(byId['verify-one'].breaks, 'verify breaks');
  assert.equal(byId['reg-one'].origin, 'registry');
  assert.equal(byId['reg-one'].breaks, 'registry breaks');
  assert.deepEqual(got.errors, [`${proposals}: mutant reg-one: duplicate of the registry`]);
});

test('loadMutants with no registry: proposals only, file null, and each proposal suite is an unknown-suite error', async () => {
  const root = fresh();
  const verif = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-verif-'));
  const proposals = path.join(verif, 'mutants.json');
  json(verif, 'mutants.json', { mutants: [mutant('verify-one')] });
  const got = await loadMutants({ root, profile: PROFILE, proposals });

  assert.equal(got.file, null);
  assert.deepEqual(got.suites, {});
  assert.deepEqual(got.mutants, []);
  assert.equal(got.errors.length, 1);
  assert.ok(got.errors[0].startsWith(`${proposals}: mutant `), got.errors[0]);
  assert.match(got.errors[0], /suite/);
});

// Each row: the entry with one field broken, and the word its error must name.
const INVALID = [
  ['a bad id', mutant('Bad_One'), /id/],
  ['no breaks', mutant('bad-one', { breaks: undefined }), /breaks/],
  ['no file', mutant('bad-one', { file: undefined }), /file/],
  ['no find', mutant('bad-one', { find: undefined }), /find/],
  ['no replace', mutant('bad-one', { replace: undefined }), /replace/],
  ['an unknown suite', mutant('bad-one', { suite: 'nope' }), /suite/],
];

for (const [name, bad, word] of INVALID) {
  test(`loadMutants drops a mutant with ${name} and reports it as '<file>: mutant <n>: <problem>'`, async () => {
    const got = await loadRegistry([bad, mutant('good-one')]);

    assert.equal(got.errors.length, 1, JSON.stringify(got.errors));
    assert.match(got.errors[0], PREFIX);
    assert.match(got.errors[0], word);
    assert.deepEqual(got.mutants.map((m) => m.id), ['good-one']);
  });
}

test('loadMutants keeps one of two registry entries with the same id and reports the second', async () => {
  const got = await loadRegistry([mutant('dup-one'), mutant('dup-one', { breaks: 'second' })]);

  assert.deepEqual(got.mutants.map((m) => m.id), ['dup-one']);
  assert.equal(got.errors.length, 1, JSON.stringify(got.errors));
  assert.match(got.errors[0], PREFIX);
});

test('loadMutants on a registry that does not parse reports the parse error and loads nothing from it', async () => {
  const root = fresh();
  write(root, 'qa/mutants.json', '{ "suites": { "unit": ');
  const got = await loadMutants({ root, profile: PROFILE, proposals: null });

  assert.equal(got.file, 'qa/mutants.json');
  assert.deepEqual(got.suites, {});
  assert.deepEqual(got.mutants, []);
  assert.equal(got.errors.length, 1, JSON.stringify(got.errors));
  assert.ok(got.errors[0].startsWith('qa/mutants.json: '), got.errors[0]);
});

test('loadMutants on a registry module that throws on import reports its message and loads nothing from it', async () => {
  const root = fresh();
  write(root, 'qa/mutants.mjs', `export const SUITES = { unit: ['node', 'check.mjs'] };\nthrow new Error('boom');\n`);
  const got = await loadMutants({ root, profile: PROFILE, proposals: null });

  assert.equal(got.file, 'qa/mutants.mjs');
  assert.deepEqual(got.suites, {});
  assert.deepEqual(got.mutants, []);
  assert.equal(got.errors.length, 1, JSON.stringify(got.errors));
  assert.ok(got.errors[0].startsWith('qa/mutants.mjs: '), got.errors[0]);
  assert.match(got.errors[0], /boom/);
});

// --- selectMutants ------------------------------------------------------------------------------

const SELECT = [
  { id: 'a', origin: 'registry', file: 'src/a.js' },
  { id: 'b', origin: 'registry', file: 'src/b.js' },
  { id: 'c', origin: 'verify', file: 'src/c.js' },
  { id: 'd', origin: 'verify', file: 'src/a.js' },
];
const ids = (list) => list.map((m) => m.id);

test("selectMutants mode 'none' selects nothing, even with changed files", () => {
  assert.deepEqual(selectMutants(SELECT, { mode: 'none', changed: ['src/a.js'] }), []);
});

test("selectMutants mode 'all' selects every mutant in input order", () => {
  assert.deepEqual(ids(selectMutants(SELECT, { mode: 'all' })), ['a', 'b', 'c', 'd']);
});

test("selectMutants default mode is 'named': only the plan's mutants that name a kill test (rework: mutants are off otherwise)", () => {
  const kill = { suite: 'unit', grep: 'holds' };
  const list = [...SELECT, { id: 'e', origin: 'verify', file: 'src/e.js', kill }, { id: 'f', origin: 'registry', file: 'src/a.js', kill }];
  assert.deepEqual(ids(selectMutants(list)), ['e'], 'a registry mutant with a kill test is not the planner naming it');
  assert.deepEqual(ids(selectMutants(list, { mode: 'named', changed: ['src/a.js'] })), ['e'], 'changed files do not matter');
  assert.deepEqual(ids(selectMutants(SELECT)), [], 'no kill test named: nothing runs');
});

test("selectMutants 'affected' with no changes: origin verify is always in, nothing else", () => {
  assert.deepEqual(ids(selectMutants(SELECT, { mode: 'affected', changed: [] })), ['c', 'd']);
});

test("selectMutants 'affected' adds the mutants whose file is in changed, input order kept", () => {
  assert.deepEqual(ids(selectMutants(SELECT, { mode: 'affected', changed: ['src/a.js'] })), ['a', 'c', 'd']);
  assert.deepEqual(ids(selectMutants(SELECT, { mode: 'affected', changed: ['src/b.js'] })), ['b', 'c', 'd']);
});

// --- applyMutant / restoreMutant ----------------------------------------------------------------

test("applyMutant on a file that is missing says 'stale: <file> missing'", () => {
  const dir = fresh();
  assert.deepEqual(applyMutant(dir, mut('gone', { file: 'src/missing.js' })), {
    ok: false,
    why: 'stale: src/missing.js missing',
  });
});

test("applyMutant whose find text is absent says 'stale: found 0 times' and leaves the file alone", () => {
  const dir = fresh();
  assert.deepEqual(applyMutant(dir, mut('none', { find: 'absent text' })), { ok: false, why: 'stale: found 0 times' });
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});

test("applyMutant whose find text occurs twice says 'stale: found 2 times' and leaves the file alone", () => {
  const dir = fresh();
  write(dir, 'src/a.js', 'ok 1\nok 1\n');
  assert.deepEqual(applyMutant(dir, mut('twice')), { ok: false, why: 'stale: found 2 times' });
  assert.equal(read(dir, 'src/a.js'), 'ok 1\nok 1\n');
});

test('applyMutant with one occurrence writes the replacement and returns the original text', () => {
  const dir = fresh();
  assert.deepEqual(applyMutant(dir, mut('one')), { ok: true, original: 'ok 1\n' });
  assert.equal(read(dir, 'src/a.js'), 'ok 2\n');
});

test('restoreMutant writes the original back and returns true when the file reads back equal', () => {
  const dir = fresh();
  const m = mut('one');
  const applied = applyMutant(dir, m);
  assert.equal(applied.ok, true);
  assert.equal(restoreMutant(dir, m, applied.original), true);
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});

test('restoreMutant returns false when the file does not read back equal to the original', () => {
  const dir = fresh();
  const m = mut('one');
  const applied = applyMutant(dir, m);
  assert.equal(applied.ok, true);
  // The write is swallowed, so the file still holds the mutated text when it is read back.
  const noWrite = { ...fs, writeFileSync() {} };
  assert.equal(restoreMutant(dir, m, applied.original, noWrite), false);
  assert.equal(read(dir, 'src/a.js'), 'ok 2\n');
});

// --- runMutants ---------------------------------------------------------------------------------

test('runMutants runs each used suite unmutated first as clean-<suite>, and no unused suite', async () => {
  const dir = fresh();
  const calls = [];
  const runSuite = async (id, logName) => {
    calls.push(logName);
    return { passed: true, ms: 1 };
  };
  const mutants = [mut('a-one', { suite: 'unit' }), mut('a-two', { suite: 'db' }), mut('a-three', { suite: 'unit' })];
  await runMutants({ dir, mutants, suites: { unit: 'node check.mjs', db: 'test:integration', spare: 'true' }, runSuite });

  assert.deepEqual(calls.slice(0, 2).sort(), ['clean-db', 'clean-unit']);
  assert.equal(calls.filter((c) => c === 'clean-unit').length, 1);
  assert.equal(calls.includes('clean-spare'), false);
  assert.deepEqual(calls.slice(2), ['a-one', 'a-two', 'a-three']);
});

test("runMutants: a suite that passes with the mutant in place is 'SURVIVED', and the file is restored after", async () => {
  const dir = fresh();
  const seen = [];
  const runSuite = async (id, logName) => {
    if (logName !== 'clean-unit') seen.push(read(dir, 'src/a.js'));
    return { passed: true, ms: 2 };
  };
  const run = await runMutants({ dir, mutants: [mut('a-one')], suites: { unit: 'node check.mjs' }, runSuite });

  assert.deepEqual(seen, ['ok 2\n'], 'the suite must see the mutated file');
  assert.equal(run.mutants[0].verdict, 'SURVIVED');
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});

test("runMutants: a suite that fails with the mutant in place is 'killed'", async () => {
  const dir = fresh();
  const runSuite = async (id, logName) => ({ passed: logName !== 'a-one', ms: 2 });
  const run = await runMutants({ dir, mutants: [mut('a-one')], suites: { unit: 'node check.mjs' }, runSuite });

  assert.equal(run.mutants[0].verdict, 'killed');
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});

test("runMutants: a mutant whose find is absent is 'stale' with the applyMutant reason, and its suite does not run", async () => {
  const dir = fresh();
  const calls = [];
  const runSuite = async (id, logName) => {
    calls.push(logName);
    return { passed: true, ms: 1 };
  };
  const run = await runMutants({
    dir,
    mutants: [mut('no-text', { find: 'absent text' }), mut('no-file', { file: 'src/none.js' })],
    suites: { unit: 'node check.mjs' },
    runSuite,
  });

  assert.equal(run.mutants[0].verdict, 'stale');
  assert.equal(run.mutants[0].detail, 'stale: found 0 times');
  assert.equal(run.mutants[1].verdict, 'stale');
  assert.equal(run.mutants[1].detail, 'stale: src/none.js missing');
  assert.equal(calls.includes('no-text'), false);
  assert.equal(calls.includes('no-file'), false);
});

test("runMutants: a suite that fails unmutated makes its mutants 'not judged' with detail 'suite unit fails unmutated'", async () => {
  const dir = fresh();
  const calls = [];
  const runSuite = async (id, logName) => {
    calls.push(logName);
    return { passed: false, ms: 3 };
  };
  const run = await runMutants({ dir, mutants: [mut('a-one')], suites: { unit: 'node check.mjs' }, runSuite });

  assert.equal(run.mutants[0].verdict, 'not judged');
  assert.equal(run.mutants[0].detail, 'suite unit fails unmutated');
  assert.equal(calls.includes('a-one'), false);
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});

test("runMutants: a clean run that did not run gives 'not judged' with the clean run's notRun as detail", async () => {
  const dir = fresh();
  const runSuite = async () => ({ passed: false, ms: 3, notRun: 'no database container' });
  const run = await runMutants({ dir, mutants: [mut('a-one')], suites: { unit: 'node check.mjs' }, runSuite });

  assert.equal(run.mutants[0].verdict, 'not judged');
  assert.equal(run.mutants[0].detail, 'no database container');
});

test('runMutants restores the file after every mutant, even when runSuite throws', async () => {
  const dir = fresh();
  const seen = [];
  const runSuite = async (id, logName) => {
    if (logName === 'clean-unit') return { passed: true, ms: 1 };
    seen.push(read(dir, 'src/a.js'));
    throw new Error('runner exploded');
  };
  await runMutants({ dir, mutants: [mut('a-one')], suites: { unit: 'node check.mjs' }, runSuite }).catch(() => {});

  assert.deepEqual(seen, ['ok 2\n'], 'the suite must have run against the mutated file before it threw');
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});

test('runMutants returns a MutantRun: suites by id, and one entry per mutant with id mut:<id>', async () => {
  const dir = fresh();
  const runSuite = async (id, logName) => ({ passed: logName !== 'a-two', ms: 5 });
  const run = await runMutants({
    dir,
    mutants: [mut('a-one'), mut('a-two', { origin: 'verify', breaks: 'a person loses data' })],
    suites: { unit: 'node check.mjs' },
    runSuite,
  });

  assert.deepEqual(run.suites, { unit: { passed: true, ms: 5 } });
  assert.equal(run.mutants.length, 2);
  for (const entry of run.mutants) {
    assert.equal(typeof entry.ms, 'number');
    assert.ok('detail' in entry);
  }
  assert.deepEqual(
    run.mutants.map(({ id, mutant: name, origin, breaks, file, suite, verdict }) => ({ id, mutant: name, origin, breaks, file, suite, verdict })),
    [
      { id: 'mut:a-one', mutant: 'a-one', origin: 'registry', breaks: 'a-one breaks', file: 'src/a.js', suite: 'unit', verdict: 'SURVIVED' },
      { id: 'mut:a-two', mutant: 'a-two', origin: 'verify', breaks: 'a person loses data', file: 'src/a.js', suite: 'unit', verdict: 'killed' },
    ],
  );
});

// --- makeRunSuite -------------------------------------------------------------------------------

// check.mjs: exits 1 when src/a.js holds BROKEN, and says what it checked on stdout.
const CHECK = `import fs from 'node:fs';
const text = fs.readFileSync(new URL('./src/a.js', import.meta.url), 'utf8');
console.log('checked src/a.js');
process.exit(text.includes('BROKEN') ? 1 : 0);
`;

function runSuiteFor(dir, { suites, runVerb = async () => ({ passed: true, ms: 1 }), timeoutMs = 60000, vars = {}, logDir = null, mainRoot = dir }) {
  const log = logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-logs-'));
  return { log, runSuite: makeRunSuite({ dir, suites, profile: PROFILE, mainRoot, vars, logDir: log, runVerb, timeoutMs }) };
}

test("makeRunSuite string suite 'node check.mjs' passes clean and fails when src/a.js holds BROKEN", async () => {
  const dir = fresh();
  write(dir, 'check.mjs', CHECK);
  const { runSuite } = runSuiteFor(dir, { suites: { cmd: 'node check.mjs' } });

  assert.equal((await runSuite('cmd', 'clean-cmd')).passed, true);
  write(dir, 'src/a.js', 'BROKEN\n');
  assert.equal((await runSuite('cmd', 'cmd-mutant')).passed, false);
});

test("makeRunSuite argv suite ['node', 'check.mjs'] passes clean and fails when src/a.js holds BROKEN", async () => {
  const dir = fresh();
  write(dir, 'check.mjs', CHECK);
  const { runSuite } = runSuiteFor(dir, { suites: { argv: ['node', 'check.mjs'] } });

  assert.equal((await runSuite('argv', 'clean-argv')).passed, true);
  write(dir, 'src/a.js', 'BROKEN\n');
  assert.equal((await runSuite('argv', 'argv-mutant')).passed, false);
});

test('makeRunSuite command suites run in the worktree, log to mutant-<logName>.log, and get the QA_* env from vars', async () => {
  const dir = fresh();
  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-main-'));
  const env = "console.log([process.env.QA_ROOT, process.env.QA_MAIN_ROOT, process.env.QA_SLUG, process.env.QA_PORT].join('|'))";
  const { runSuite, log } = runSuiteFor(dir, {
    suites: { env: ['node', '-e', env] },
    vars: { port: 4123, slug: 'sbx' },
    mainRoot,
  });

  assert.equal((await runSuite('env', 'env-check')).passed, true);
  const text = fs.readFileSync(path.join(log, 'mutant-env-check.log'), 'utf8');
  assert.ok(text.includes(`${dir}|${mainRoot}|sbx|4123`), text);
});

test("makeRunSuite 'test:<level>' calls runVerb('test') with the level, the worktree and the log file", async () => {
  const dir = fresh();
  const profile = PROFILE;
  const calls = [];
  const runVerb = async (verb, opts) => {
    calls.push({ verb, opts });
    return { passed: true, ms: 7 };
  };
  const vars = { port: 4123, slug: 'sbx' };
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-logs-'));
  const runSuite = makeRunSuite({
    dir,
    suites: { db: 'test:integration' },
    profile,
    mainRoot: dir,
    vars,
    logDir,
    runVerb,
    timeoutMs: 60000,
  });
  const got = await runSuite('db', 'clean-db');

  assert.equal(got.passed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].verb, 'test');
  assert.deepEqual(calls[0].opts.args, ['integration']);
  assert.equal(calls[0].opts.cwd, dir);
  assert.equal(calls[0].opts.profile, profile);
  assert.equal(calls[0].opts.mainRoot, dir);
  assert.deepEqual(calls[0].opts.vars, vars);
  assert.equal(calls[0].opts.logFile, path.join(logDir, 'mutant-clean-db.log'));
  assert.equal(calls[0].opts.timeoutMs, 60000);
});

test("makeRunSuite passes a runVerb notRun through, and the suite is not passed", async () => {
  const dir = fresh();
  const runVerb = async () => ({ notRun: 'no database', ms: 9 });
  const runSuite = makeRunSuite({ dir, suites: { db: 'test:integration' }, profile: PROFILE, mainRoot: dir, vars: {}, logDir: dir, runVerb, timeoutMs: 60000 });
  const got = await runSuite('db', 'clean-db');

  assert.equal(got.notRun, 'no database');
  assert.equal(got.passed, false);
});

test('makeRunSuite kills a command that outlives timeoutMs and reports it as not passed', { timeout: 30000 }, async () => {
  const dir = fresh();
  const { runSuite } = runSuiteFor(dir, { suites: { slow: ['node', '-e', 'setTimeout(() => {}, 60000)'] }, timeoutMs: 500 });
  const started = Date.now();
  const got = await runSuite('slow', 'slow-mutant');

  assert.equal(got.passed, false);
  assert.ok(Date.now() - started < 20000, 'the timed-out command must be killed, not waited for');
});

// --- mutantsResult ------------------------------------------------------------------------------

test('mutantsResult counts killed and SURVIVED as run, and lists survived, stale and not-judged entries', () => {
  const run = {
    suites: { unit: { passed: true, ms: 5 } },
    mutants: [
      { id: 'mut:k', mutant: 'k', origin: 'registry', breaks: 'k breaks', file: 'src/a.js', suite: 'unit', verdict: 'killed', detail: '', ms: 1 },
      { id: 'mut:s', mutant: 's', origin: 'verify', breaks: 's breaks', file: 'src/b.js', suite: 'unit', verdict: 'SURVIVED', detail: '', ms: 1 },
      { id: 'mut:t', mutant: 't', origin: 'registry', breaks: 't breaks', file: 'src/a.js', suite: 'unit', verdict: 'stale', detail: 'stale: found 0 times', ms: 0 },
      { id: 'mut:n', mutant: 'n', origin: 'registry', breaks: 'n breaks', file: 'src/a.js', suite: 'unit', verdict: 'not judged', detail: 'suite unit fails unmutated', ms: 0 },
    ],
  };
  const got = mutantsResult(run, { mode: 'all', file: 'qa/mutants.json', errors: ['x: y'] });

  assert.equal(got.mode, 'all');
  assert.equal(got.file, 'qa/mutants.json');
  assert.equal(got.run, 2);
  assert.equal(got.killed, 1);
  assert.deepEqual(got.survived, [
    { id: 'mut:s', mutant: 's', origin: 'verify', breaks: 's breaks', file: 'src/b.js', suite: 'unit', detail: '' },
  ]);
  assert.deepEqual(got.stale, [
    { id: 'mut:t', mutant: 't', origin: 'registry', breaks: 't breaks', file: 'src/a.js', suite: 'unit', detail: 'stale: found 0 times' },
  ]);
  assert.deepEqual(got.notJudged, [
    { id: 'mut:n', mutant: 'n', origin: 'registry', breaks: 'n breaks', file: 'src/a.js', suite: 'unit', detail: 'suite unit fails unmutated' },
  ]);
  assert.deepEqual(got.suites, { unit: { passed: true, ms: 5 } });
  assert.deepEqual(got.errors, ['x: y']);
});

test('mutantsResult with a null run gives zero counts, empty lists and suites {}', () => {
  assert.deepEqual(mutantsResult(null, { mode: 'none', file: null, errors: [] }), {
    mode: 'none',
    file: null,
    run: 0,
    killed: 0,
    survived: [],
    stale: [],
    notJudged: [],
    suites: {},
    errors: [],
  });
});

test('step 6 pilot: an absolute profile.mutants.file is read as is, not joined onto the tree', async () => {
  const tree = fresh();
  const elsewhere = fresh();
  const reg = path.join(elsewhere, 'mutants.json');
  fs.writeFileSync(reg, JSON.stringify({ suites: { s: 'true' }, mutants: [{ id: 'm', breaks: 'b', file: 'a.js', find: 'x', replace: 'y', suite: 's' }] }));
  const out = await loadMutants({ root: tree, profile: { mutants: { file: reg } } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.mutants.map((m) => m.id), ['m']);
});

// --- red baseline (0.6.0) -------------------------------------------------------------------------

test('red baseline: a suite red unmutated that names its tests still judges mutants, on the tests that passed', async () => {
  const dir = fresh();
  const named = (failing) => [{ name: 'always red', status: 'failed' }, { name: 'holds ok', status: failing ? 'failed' : 'passed' }, { name: 'short', status: 'passed' }];
  const runSuite = async (id, logName) => {
    if (logName === 'clean-unit') return { passed: false, ms: 1, tests: named(false) };
    if (logName === 'a-kill') return { passed: false, ms: 1, tests: named(true) };
    if (logName === 'a-live') return { passed: false, ms: 1, tests: named(false) };
    if (logName === 'a-quiet') return { passed: false, ms: 1, tests: null };
    return { passed: false, ms: 1, notRun: 'no runner' };
  };
  const run = await runMutants({ dir, mutants: [mut('a-kill'), mut('a-live'), mut('a-quiet'), mut('a-gone')], suites: { unit: 'node --test' }, runSuite });

  assert.deepEqual(run.suites.unit, { passed: false, ms: 1, baseline: { failed: 1, names: ['always red'] } });
  assert.deepEqual(run.mutants.map((m) => [m.mutant, m.verdict, m.detail]), [
    ['a-kill', 'killed', 'judged on names: 1 test(s) that did not fail unmutated failed, first: holds ok'],
    ['a-live', 'SURVIVED', 'judged on names: no test that passed unmutated failed (1 failing unmutated excluded)'],
    ['a-quiet', 'not judged', 'suite unit fails unmutated and the mutant run names no test'],
    ['a-gone', 'not judged', 'no runner'],
  ]);
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});

test('red baseline: a clean run that names no test keeps the old rule, and a green clean run has no baseline key', async () => {
  const dir = fresh();
  const red = await runMutants({ dir, mutants: [mut('a-one')], suites: { unit: 'x' }, runSuite: async () => ({ passed: false, ms: 1, tests: null }) });
  assert.deepEqual([red.mutants[0].verdict, red.mutants[0].detail], ['not judged', 'suite unit fails unmutated']);
  assert.deepEqual(red.suites.unit, { passed: false, ms: 1 });
  const green = await runMutants({ dir, mutants: [mut('a-one')], suites: { unit: 'x' }, runSuite: async (id, n) => ({ passed: n === 'clean-unit', ms: 1, tests: [{ name: 't', status: 'passed' }] }) });
  assert.deepEqual(green.suites.unit, { passed: true, ms: 1 });
  assert.equal(green.mutants[0].verdict, 'killed', 'a green baseline is judged by the exit code, as before');
});

// A node --test suite with one test that always fails (as a sandbox run as root fails some), one that holds the guard.
const RED_SUITE = `import test from 'node:test';
import fs from 'node:fs';
const a = () => fs.readFileSync(new URL('./src/a.js', import.meta.url), 'utf8');
test('fails in this sandbox whatever the code', () => { throw new Error('not allowed as root'); });
test('src/a.js holds the guard', () => { if (!a().includes('ok 1')) throw new Error('guard gone'); });
`;

test('red baseline, a real node --test suite: makeRunSuite adds a reporter, names the tests, and the guard mutant is killed', async () => {
  const dir = fresh();
  write(dir, 'red.test.mjs', RED_SUITE);
  const { runSuite, log } = runSuiteFor(dir, { suites: { unit: 'node --test red.test.mjs' } });
  const clean = await runSuite('unit', 'clean-unit');
  assert.equal(clean.passed, false);
  assert.deepEqual(clean.tests.map((t) => [t.name, t.status]), [['fails in this sandbox whatever the code', 'failed'], ['src/a.js holds the guard', 'passed']]);
  assert.match(fs.readFileSync(path.join(log, 'mutant-clean-unit.log'), 'utf8'), /^not ok 1 - fails in this sandbox/m);

  const run = await runMutants({
    dir,
    mutants: [mut('guard-gone', { replace: 'ok 2' }), mut('guard-kept', { replace: 'ok 1 and more' })],
    suites: { unit: 'node --test red.test.mjs' },
    runSuite,
  });
  assert.deepEqual(run.mutants.map((m) => [m.mutant, m.verdict]), [['guard-gone', 'killed'], ['guard-kept', 'SURVIVED']]);
  assert.equal(run.suites.unit.baseline.failed, 1);
  assert.equal(read(dir, 'src/a.js'), 'ok 1\n');
});
