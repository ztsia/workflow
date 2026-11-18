// Breakage checks (decisions 2, 3, 7): each dangerous edit is made in the head sandbox's worktree (never the
// user's checkout), and a test that must catch it is run. A mutant nothing catches SURVIVED: a guard no test
// holds, a finding. Zero model calls.
//
// Rework (2026-11-12, design §17 item 3): mutants are off unless the planner names a guard AND its killing test.
// `qa run` runs only the planner's mutants that carry `kill` (mode 'named'), and runs only that one test,
// unmutated and then mutated; the registry's mutants run only on an explicit `--mutants all|affected`.
//
// CONTRACT (tests: test/mutants.test.mjs — a temp dir as the worktree, runSuite injected; one test
// uses a real command suite: `node check.mjs` that exits 1 when a file holds a given text; the kill
// tests run a real `node --test` file)
//
//   SUITES: suites.mjs loadSuites (qa/suites.json|.ts|.mjs; the SUITES of the registry below while a project has
//   no suites file). A suite is 'test:<level>', a shell string, an argv list or { cmd, timeoutMs } (suites.mjs).
//   REGISTRY: profile.mutants.file (relative to the tree, or absolute), else the first that exists of
//   qa/mutants.json, qa/mutants.ts, qa/mutants.mjs. JSON: { mutants: [m] }; .ts/.mjs: exports MUTANTS ([m]).
//   (Its old `suites` / SUITES are read only as suites.mjs's fallback.) Mutant m:
//     { id (/^[a-z0-9][a-z0-9-]*$/), breaks: 'what a person or the data suffers', file (relative
//       path), find (must occur EXACTLY once in file), replace, suite (a key of suites),
//       kill? { suite, grep, file? } }
//     kill: the one test that must fail when the edit is made (a test expectation's `test` object, tests.mjs:
//       suite a key of suites or 'test:<level>', grep its title, file the spec file it is in). With kill, `suite`
//       may be left out (it is kill.suite). A bad kill drops the mutant: '<file>: mutant <n>: kill: <problem>'.
//   PROPOSALS: <verification>/mutants.json, the verifier's plan output: { mutants: [m] } using the
//   suites; each gets origin 'verify'. A registry mutant gets origin 'registry'.
//
//   loadMutants({ root, profile, proposals = null, suites = null }) -> Promise<{ file, suites, mutants, errors,
//                                                                             suitesFile, note }>
//     root = the tree (the sandbox worktree); proposals = an absolute path or null; suites null -> loadSuites
//     ({ root, profile }) (its errors come first in errors; suitesFile and note are its file and note). file =
//     the registry's path relative to root or null (no registry: mutants = the proposals only). Errors (entry
//     dropped): '<file>: mutant <n>: <problem>' for a bad id, missing breaks/file/find/replace, an unknown
//     suite, a bad kill, a duplicate id (registry wins over a proposal of the same id: the proposal is dropped
//     with '<proposals file>: mutant <id>: duplicate of the registry'). A file that does not parse or
//     import -> errors ['<file>: <message>'] and nothing from it (reported once when it is also the suites'
//     fallback).
//
//   selectMutants(mutants, { mode = 'named', changed = [] }) -> mutants
//     mode 'none' -> []; 'named' -> those with origin 'verify' and a kill; 'all' -> all; 'affected' -> those with
//     origin 'verify', plus those whose file is in changed (paths relative to the repo, '/'-separated). Input
//     order kept.
//   unnamedNote(mutants, proposals) -> [string]   mode 'named': one '<proposals>: mutant <id>: no kill test (kill:
//     { suite, grep }), so it is not run' per proposal without a kill.
//
//   applyMutant(dir, m, fsDeps = fs) -> { ok: true, original } | { ok: false, why }
//     Reads <dir>/<m.file>; missing -> why 'stale: <file> missing'; count of m.find ≠ 1 ->
//     why 'stale: found <count> times'; else writes the file with the one occurrence replaced and
//     returns the original text. restoreMutant(dir, m, original, fsDeps = fs) writes it back and
//     returns true when the file now equals original (read back), else false.
//     staleWhy(dir, m) -> null | why   applyMutant's answer without writing anything.
//   mutantProblem(m, suites) -> string | null   the first problem loadMutants would drop m for (without the
//     '<file>: mutant <n>: ' prefix).
//
//   runMutants({ dir, mutants, suites, runSuite, runKill = null, log = () => {} }) -> Promise<MutantRun>
//     runSuite(suiteId, logName) -> Promise<{ passed: boolean, ms, notRun?: string }>.
//     runKill(m, logName) -> Promise<TestRecord> (tests.mjs runTests of the one entry { test: m.kill }).
//     A mutant with a kill (and a runKill) is judged by its kill test alone:
//       stale (staleWhy) -> 'stale', nothing runs. The kill test runs unmutated once per distinct kill (logName
//       'clean-<m.id>'); not met -> 'not judged', 'kill test <label>: not green unmutated: <why>'. Else the edit
//       is made, the kill test runs (logName m.id) inside try/finally that always restores; NOT MET -> 'killed',
//       'kill test <label> failed with the mutant: <why>'; met -> 'SURVIVED', 'kill test <label> still passes
//       with the mutant'; unverifiable -> 'not judged', 'kill test <label>: <why>'. label = '<suite> "<grep>"[ in
//       <file>]'. No whole suite runs for it.
//     Every other mutant is judged by its whole suite, as before:
//     1. Each suite used by those mutants runs once unmutated (logName 'clean-<suite>').
//     2. Per mutant, in order: applyMutant; not ok -> verdict 'stale', detail = why. Suite clean
//        not passed -> verdict 'not judged', detail 'suite <id> fails unmutated' (or its notRun).
//        Else run the suite (logName = m.id) inside try/finally that always restoreMutant()s;
//        passed -> 'SURVIVED', failed -> 'killed'; a restore that does not read back equal throws
//        Error('restore failed: <file>') after recording the mutant (nothing else runs on a
//        corrupted tree).
//     MutantRun = { suites: { id: { passed, ms, notRun? } }, mutants: [{ id: 'mut:<m.id>', mutant:
//       m.id, origin, breaks, file, suite, kill (only when m has one), verdict: 'killed'|'SURVIVED'|'stale'|'not judged',
//       detail, ms }] }
//
//   makeRunSuite({ dir, suites, profile, mainRoot, vars, logDir, runVerb, timeoutMs }) -> runSuite
//     'test:<level>' -> runVerb('test', { profile, mainRoot, cwd: dir, args: [level], vars,
//     logFile: <logDir>/mutant-<logName>.log, timeoutMs }); notRun from runVerb passes through
//     (passed false). A string -> spawn 'bash', ['-c', s] in dir; an array -> spawn argv[0] with the
//     rest; env = process.env + QA_ROOT=dir, QA_MAIN_ROOT, QA_SLUG, QA_PORT (from vars); stdout and
//     stderr to the log file; the limit (timeoutMs, else the suite's own timeoutMs, else
//     profile.mutants.timeoutMs ?? 900000) kills the process group -> passed false. passed = exit code 0.
//   makeRunKill({ dir, suites, profile, mainRoot, vars, logDir, runVerb, exec }) -> runKill
//     runTests({ dir, entries: [{ name: 'mutant-<logName>', test: m.kill }], suites, profile, mainRoot, vars,
//     logDir, runVerb, side: 'head', exec }) and its one record.
//
//   mutantsResult(run, { mode, file, errors }) -> MutantsResult (results.json `mutants`)
//     { mode, file, run: count of killed + SURVIVED, killed: count, survived: [entry],
//       stale: [entry], notJudged: [entry], suites: run.suites, errors }
//     entry = { id, mutant, origin, breaks, file, suite, kill (only when it has one), detail }. run null (nothing selected) ->
//     the same with zero counts, empty lists, suites {}.
//
//   RED BASELINE (0.6.0; tests: test/mutants.test.mjs 'red baseline'): runSuite may also return tests: [{ name,
//   status }] | null (makeRunSuite parses the run with tests.mjs parseTests). When a suite fails unmutated and that
//   clean run names its tests, its mutants are still judged, on names: run.suites[id].baseline = { failed: <count of
//   failed tests>, names: [the first 20] }; the mutant is applied and the suite run as usual, then
//     the mutant run's notRun                  -> 'not judged', detail the notRun
//     the mutant run names no test             -> 'not judged', 'suite <id> fails unmutated and the mutant run
//                                                  names no test'
//     a failed test not failed unmutated      -> 'killed', 'judged on names: <k> test(s) that did not fail
//                                                  unmutated failed, first: <name>'
//     else                                     -> 'SURVIVED', 'judged on names: no test that passed unmutated
//                                                  failed (<n> failing unmutated excluded)'
//   A clean run that fails and names no test keeps the rule above ('suite <id> fails unmutated'). A suite that
//   passes unmutated is judged as before (the exit code), and its suites entry has no baseline key.
//   makeRunSuite: a command suite of a known runner gets that runner's machine-readable reporter and no name
//   filter (tests.mjs commandFor with grep null; env QA_TEST_GREP '' and QA_TEST_REPORT <logDir>/mutant-<logName>
//   .report); 'test:<level>' gets the same env. The report, else the log, is parsed: tests = the named tests, or
//   null when the output names none.
//
// Example. Suites { db: 'test:integration' }, registry { mutants: [{ id: 'rls-check-dropped',
// breaks: 'a person can move their row to someone else', file: 'supabase/migrations/0007.sql',
// find: 'WITH CHECK (owner = auth.uid())', replace: 'WITH CHECK (true)', suite: 'db' }] }, run with
// `--mutants affected`, the diff touches that file, the suite passes clean and still passes with the edit ->
// survived [{ id: 'mut:rls-check-dropped', mutant: 'rls-check-dropped', origin: 'registry', … }].
// A proposal { id: 'owner-check-dropped', …, kill: { suite: 'api', grep: 'a peer cannot move my row' } } (the
// default mode 'named') runs only that test: green unmutated, red with the edit -> killed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commandFor, entryProblem, parseTests, runTests } from './tests.mjs';
import { cmdOf, loadSuites, readQaModule, REGISTRY_FILES, suiteProblem, timeoutOf } from './suites.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

const suiteOk = (suite) => suite !== undefined && suiteProblem(suite) === null;

// The first problem with one raw mutant entry against the suites it may name, or null.
export function mutantProblem(m, suites) {
  if (!isObject(m)) return 'not an object';
  if (typeof m.id !== 'string' || !ID.test(m.id)) return 'bad id (lowercase letters, digits and hyphens)';
  if (!isText(m.breaks)) return 'missing breaks';
  if (!isText(m.file)) return 'missing file';
  if (!isText(m.find)) return 'missing find';
  if (typeof m.replace !== 'string') return 'missing replace';
  if (m.kill !== undefined) {
    const bad = entryProblem({ name: m.id, test: m.kill }, suites);
    return bad ? `kill: ${bad.replace(/^test\b\.?/, '').trim()}` : null;
  }
  if (typeof m.suite !== 'string' || !Object.hasOwn(suites, m.suite)) return `unknown suite ${JSON.stringify(m.suite ?? null)}`;
  return null;
}

// The registry's mutants: JSON `mutants`, a module's MUTANTS.
async function readRegistry(root, rel) {
  const abs = path.resolve(root, rel);
  if (rel.endsWith('.json')) {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (!isObject(data)) throw new Error('not an object with mutants');
    return data.mutants ?? [];
  }
  return (await readQaModule(abs)).MUTANTS ?? [];
}

const killOf = (k) => (isObject(k) ? { suite: k.suite, grep: k.grep, ...(k.file !== undefined ? { file: k.file } : {}) } : null);

export async function loadMutants({ root, profile, proposals = null, suites: given = null } = {}) {
  const loadedSuites = given ? { file: null, suites: given, errors: [], legacy: false, note: null } : await loadSuites({ root, profile });
  const suites = loadedSuites.suites;
  const errors = [...loadedSuites.errors];
  const mutants = [];
  const seen = new Set();
  const file = profile?.mutants?.file ?? REGISTRY_FILES.find((c) => fs.existsSync(path.join(root, c))) ?? null;

  const take = (list, label, origin) => {
    list.forEach((m, i) => {
      const bad = mutantProblem(m, suites);
      if (bad) return errors.push(`${label}: mutant ${i + 1}: ${bad}`);
      if (seen.has(m.id)) {
        return errors.push(
          origin === 'verify' ? `${label}: mutant ${m.id}: duplicate of the registry` : `${label}: mutant ${i + 1}: duplicate id ${m.id}`,
        );
      }
      seen.add(m.id);
      const kill = killOf(m.kill);
      mutants.push({ id: m.id, origin, breaks: m.breaks, file: m.file, find: m.find, replace: m.replace, suite: kill ? kill.suite : m.suite, ...(kill ? { kill } : {}) });
    });
  };

  if (file && fs.existsSync(path.resolve(root, file))) {
    // The registry is also the suites' old place: when it failed to load there, it is reported once.
    const reported = loadedSuites.legacy && loadedSuites.file === file && loadedSuites.errors.some((e) => e.startsWith(`${file}: `) && !/: suite /.test(e));
    try {
      const list = await readRegistry(root, file);
      if (!Array.isArray(list)) throw new Error('mutants is not a list');
      take(list, file, 'registry');
    } catch (error) {
      mutants.length = 0;
      seen.clear();
      if (!reported) errors.push(`${file}: ${error.message}`);
    }
  }

  if (proposals && fs.existsSync(proposals)) {
    try {
      const data = JSON.parse(fs.readFileSync(proposals, 'utf8'));
      if (!isObject(data) || !Array.isArray(data.mutants)) throw new Error('not an object with a mutants list');
      take(data.mutants, proposals, 'verify');
    } catch (error) {
      errors.push(`${proposals}: ${error.message}`);
    }
  }
  return { file: file ?? null, suites, mutants, errors, suitesFile: loadedSuites.file, note: loadedSuites.note };
}

export const MUTANT_MODES = Object.freeze(['named', 'affected', 'all', 'none']);

export function selectMutants(mutants, { mode = 'named', changed = [] } = {}) {
  if (mode === 'none') return [];
  if (mode === 'all') return [...mutants];
  if (mode === 'named') return mutants.filter((m) => m.origin === 'verify' && m.kill);
  const files = new Set(changed);
  return mutants.filter((m) => m.origin === 'verify' || files.has(m.file));
}

export function unnamedNote(mutants, proposals) {
  return mutants.filter((m) => m.origin === 'verify' && !m.kill).map((m) => `${proposals}: mutant ${m.id}: no kill test (kill: { suite, grep }), so it is not run`);
}

function locate(dir, m) {
  const abs = path.resolve(dir, m.file);
  const rel = path.relative(path.resolve(dir), abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

export function applyMutant(dir, m, fsDeps = fs) {
  const abs = locate(dir, m);
  let original;
  try {
    if (!abs) throw new Error('outside the tree');
    original = fsDeps.readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, why: `stale: ${m.file} missing` };
  }
  const count = m.find ? original.split(m.find).length - 1 : 0;
  if (count !== 1) return { ok: false, why: `stale: found ${count} times` };
  const at = original.indexOf(m.find);
  fsDeps.writeFileSync(abs, original.slice(0, at) + m.replace + original.slice(at + m.find.length));
  return { ok: true, original };
}

export function restoreMutant(dir, m, original, fsDeps = fs) {
  const abs = locate(dir, m);
  if (!abs) return false;
  try {
    fsDeps.writeFileSync(abs, original);
    return fsDeps.readFileSync(abs, 'utf8') === original;
  } catch {
    return false;
  }
}

export function staleWhy(dir, m) {
  const dry = { readFileSync: fs.readFileSync, writeFileSync: () => {} };
  const r = applyMutant(dir, m, dry);
  return r.ok ? null : r.why;
}

const killLabel = (k) => `${k.suite} "${k.grep}"${k.file ? ` in ${k.file}` : ''}`;
const killKey = (k) => JSON.stringify([k.suite, k.grep, k.file ?? null]);

export async function runMutants({ dir, mutants, suites, runSuite, runKill = null, log = () => {} } = {}) {
  const run = { suites: {}, mutants: [] };
  const byKill = (m) => Boolean(m.kill && runKill);
  const clean = (r) => ({ passed: r.passed === true, ms: r.ms ?? 0, ...(r.notRun ? { notRun: r.notRun } : {}) });
  // A red clean run that names its tests: the names that failed unmutated, so mutants are judged on the others.
  const failedBefore = {};
  for (const id of new Set(mutants.filter((m) => !byKill(m)).map((m) => m.suite))) {
    if (!Object.hasOwn(suites, id)) continue;
    log(`clean run of suite ${id}`);
    const r = await runSuite(id, `clean-${id}`);
    run.suites[id] = clean(r);
    if (!run.suites[id].passed && !r.notRun && Array.isArray(r.tests) && r.tests.length) {
      const names = r.tests.filter((t) => t.status === 'failed').map((t) => t.name);
      failedBefore[id] = new Set(names);
      run.suites[id].baseline = { failed: names.length, names: names.slice(0, 20) };
    }
  }
  // The kill tests' unmutated runs, once per distinct kill.
  const cleanKills = new Map();
  for (const m of mutants) {
    const started = Date.now();
    const entry = { id: `mut:${m.id}`, mutant: m.id, origin: m.origin, breaks: m.breaks, file: m.file, suite: m.suite, ...(m.kill ? { kill: m.kill } : {}), verdict: 'not judged', detail: '', ms: 0 };
    run.mutants.push(entry);
    const finish = (verdict, detail = '') => {
      Object.assign(entry, { verdict, detail, ms: Date.now() - started });
    };
    if (byKill(m)) {
      const label = killLabel(m.kill);
      const stale = staleWhy(dir, m);
      if (stale) {
        finish('stale', stale);
        continue;
      }
      const key = killKey(m.kill);
      if (!cleanKills.has(key)) {
        log(`mutant ${m.id}: kill test ${label} unmutated`);
        cleanKills.set(key, await runKill(m, `clean-${m.id}`));
      }
      const before = cleanKills.get(key);
      if (before?.result !== 'met') {
        finish('not judged', `kill test ${label}: not green unmutated: ${before?.why ?? 'not run'}`);
        continue;
      }
      const applied = applyMutant(dir, m);
      if (!applied.ok) {
        finish('stale', applied.why);
        continue;
      }
      log(`mutant ${m.id}: kill test ${label} with the edit`);
      let r;
      try {
        r = await runKill(m, m.id);
      } finally {
        restoreOrThrow(dir, m, applied.original, run, entry, started);
      }
      if (r?.result === 'NOT MET') finish('killed', `kill test ${label} failed with the mutant: ${r.why}`);
      else if (r?.result === 'met') finish('SURVIVED', `kill test ${label} still passes with the mutant`);
      else finish('not judged', `kill test ${label}: ${r?.why ?? 'not run'}`);
      continue;
    }
    const base = run.suites[m.suite];
    if (!base) {
      finish('not judged', `unknown suite ${m.suite}`);
      continue;
    }
    const applied = applyMutant(dir, m);
    if (!applied.ok) {
      finish('stale', applied.why);
      continue;
    }
    const byName = failedBefore[m.suite] ?? null;
    if (!base.passed && !byName) {
      restoreOrThrow(dir, m, applied.original, run, entry, started);
      finish('not judged', base.notRun ?? `suite ${m.suite} fails unmutated`);
      continue;
    }
    log(`mutant ${m.id}: running suite ${m.suite}`);
    let result;
    try {
      result = await runSuite(m.suite, m.id);
    } finally {
      restoreOrThrow(dir, m, applied.original, run, entry, started);
    }
    if (result.notRun) finish('not judged', result.notRun);
    else if (!byName) finish(result.passed ? 'SURVIVED' : 'killed');
    else if (!Array.isArray(result.tests) || !result.tests.length) finish('not judged', `suite ${m.suite} fails unmutated and the mutant run names no test`);
    else {
      const fresh = result.tests.filter((t) => t.status === 'failed' && !byName.has(t.name));
      if (fresh.length) finish('killed', `judged on names: ${fresh.length} test(s) that did not fail unmutated failed, first: ${fresh[0].name}`);
      else finish('SURVIVED', `judged on names: no test that passed unmutated failed (${byName.size} failing unmutated excluded)`);
    }
  }
  return run;
}

function restoreOrThrow(dir, m, original, run, entry, started) {
  if (restoreMutant(dir, m, original)) return;
  entry.verdict = 'not judged';
  entry.detail = `restore failed: ${m.file}`;
  entry.ms = Date.now() - started;
  const error = new Error(`restore failed: ${m.file}`);
  error.run = run;
  throw error;
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function spawnSuite(file, argv, { cwd, env, logFile, timeoutMs }) {
  const started = Date.now();
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w');
    let timer = null;
    let settled = false;
    const done = (passed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
      resolve({ passed, ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(file, argv, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    } catch (error) {
      fs.writeSync(fd, `${error.message}\n`);
      return done(false);
    }
    child.on('error', (error) => {
      try {
        fs.writeSync(fd, `${error.message}\n`);
      } catch {
        /* closed */
      }
      done(false);
    });
    child.on('close', (code) => done(code === 0));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killGroup(child.pid);
        done(false);
      }, timeoutMs);
    }
  });
}

// What a suite run's output says about its tests: the named tests, or null when it names none.
function testsIn(report, logFile, output = null) {
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };
  const parsed = parseTests({ report: read(report), output: output ?? read(logFile) ?? '' });
  return parsed.tests && parsed.tests.length ? parsed.tests.map((t) => ({ name: t.name, status: t.status })) : null;
}

export function makeRunSuite({ dir, suites, profile, mainRoot, vars = {}, logDir, runVerb, timeoutMs } = {}) {
  return async function runSuite(suiteId, logName) {
    const suite = suites[suiteId];
    const logFile = path.join(logDir, `mutant-${logName}.log`);
    const report = path.join(logDir, `mutant-${logName}.report`);
    if (!suiteOk(suite)) return { passed: false, ms: 0, notRun: `unknown suite ${suiteId}` };
    const limit = timeoutMs ?? timeoutOf(suite, profile);
    const cmd = cmdOf(suite);
    fs.rmSync(report, { force: true });
    if (typeof cmd === 'string' && cmd.startsWith('test:')) {
      const env = { QA_TEST_GREP: '', QA_TEST_FILE: '', QA_TEST_REPORT: report };
      const r = await runVerb('test', { profile, mainRoot, cwd: dir, args: [cmd.slice('test:'.length)], vars, env, logFile, timeoutMs: limit });
      if (r.notRun) return { passed: false, ms: r.ms ?? 0, notRun: r.notRun };
      const said = typeof r.stdout === 'string' || typeof r.stderr === 'string' ? `${r.stdout ?? ''}${r.stderr ?? ''}` : null;
      return { passed: r.passed ?? r.code === 0, ms: r.ms ?? 0, tests: testsIn(report, logFile, said || null) };
    }
    const plan = commandFor(cmd, { grep: null, report });
    const env = {
      ...process.env,
      QA_ROOT: String(dir),
      QA_MAIN_ROOT: String(mainRoot ?? ''),
      QA_SLUG: String(vars.slug ?? ''),
      QA_PORT: vars.port == null ? '' : String(vars.port),
      ...plan.env,
    };
    delete env.NODE_TEST_CONTEXT; // a node --test suite reports to its own output, never to a runner above qa
    const r = await spawnSuite(plan.file, plan.argv, { cwd: dir, env, logFile, timeoutMs: limit });
    return { ...r, tests: testsIn(report, logFile) };
  };
}

export function makeRunKill({ dir, suites, profile, mainRoot, vars = {}, logDir, runVerb, exec } = {}) {
  return async function runKill(m, logName) {
    const [record] = await runTests({
      dir, entries: [{ name: `mutant-${logName}`, test: m.kill }], suites, profile, mainRoot, vars, logDir, runVerb, side: 'head',
      ...(exec ? { exec } : {}),
    });
    return record;
  };
}

export function mutantsResult(run, { mode, file, errors } = {}) {
  const entry = (e) => ({ id: e.id, mutant: e.mutant, origin: e.origin, breaks: e.breaks, file: e.file, suite: e.suite, ...(e.kill ? { kill: e.kill } : {}), detail: e.detail });
  const list = run?.mutants ?? [];
  const by = (verdict) => list.filter((e) => e.verdict === verdict);
  const killed = by('killed').length;
  const survived = by('SURVIVED');
  return {
    mode,
    file: file ?? null,
    run: killed + survived.length,
    killed,
    survived: survived.map(entry),
    stale: by('stale').map(entry),
    notJudged: by('not judged').map(entry),
    suites: run?.suites ?? {},
    errors: errors ?? [],
  };
}
