// Test evidence (0.4.0): a criterion proven by a named automated test that qa runs itself, on the head
// sandbox's worktree (its own stack, pinned to the head commit), never the user's checkout. A claim that
// a test passes never counts: only the runner's own output, read here, decides. A test that is missing,
// skipped or matches nothing is not a pass: the criterion stays unverifiable, with the reason. Zero model calls.
//
// CONTRACT (tests: test/tests.test.mjs — parsers on fixture outputs; runTests with an injected exec and a
// real `node --test` suite in a temp worktree)
//
//   A test expectation is an expectations.json entry with a `test` key (the verifier's plan writes it):
//     { name, test: { suite, grep, file?, base? }, criterion? }
//     suite   a key of the project's suites (suites.mjs loadSuites: qa/suites.json|.ts|.mjs, else the old SUITES of
//             qa/mutants.*), or 'test:<level>' (the stack adapter's `test` verb with arg <level>).
//     grep    the test's title, or a part of its full title (case-sensitive substring), or '/re/flags'.
//     file    (rework, 2026-11-12) the spec or test file the test is in, relative to the repo root: only that file
//             runs. It must be in the head tree (else unverifiable 'not run: test.file <f> is not in the head tree').
//     base    true: also run it on the base sandbox when the run brings base up fresh (run.mjs).
//     criterion  the charter or acceptance-criterion id it proves; shown first in the detail.
//
//   testEntries(list) -> the entries of list that have a `test` key (list not an array -> []).
//   entryProblem(entry, suites) -> string | null   'no name' | 'test must be { suite, grep }' | 'test.suite
//     missing' | 'unknown suite "<s>" (known: <ids> or test:<level>)' | 'test.grep missing' | 'test.grep: <regex
//     error>' | 'test.file must be a path relative to the repo root'.
//   grepMatcher(grep) -> (test) => boolean   test = { name, names? }: true when grep (a substring, or /re/flags)
//     matches test.name or any of test.names.
//   runnerOf(text) -> 'playwright' | 'vitest' | 'jest' | 'pytest' | 'node' | null   from a command's text.
//   commandFor(suite, { grep, report, testFile = null }) -> { file, argv, shown, runner, filtered, scoped, narrowed, env }
//     suite: a string (bash -c), an argv list, or { cmd, timeoutMs } (suites.mjs). A simple command (no ; & | < > `
//     or $( in a string) of a known runner gets that runner's name filter and machine-readable report appended at
//     its end, a string exactly as an argv list (a string with those characters gets nothing appended: qa never
//     edits a shell line it cannot read; it passes the env below instead):
//       playwright  --grep <re> --reporter json, env PLAYWRIGHT_JSON_OUTPUT_NAME=<report>
//       vitest      -t <re> --reporter=json --outputFile=<report>
//       jest        -t <re> --json --outputFile=<report>
//       pytest      --junitxml=<report> [-k <grep> when grep is a plain word]
//       node        --test-reporter=tap --test-name-pattern=<re>, put right after `--test`
//     testFile (an absolute path; runTests resolves the entry's file against the worktree) is then appended last,
//     as `--runTestsByPath <file>` for jest and as the path itself for the others, so only that file runs (a suite
//     that names paths of its own still runs those too: register it without them).
//     A filter the command already has (-g/--grep, -t, -k, --test-name-pattern) is left alone and none is
//     added; a /re/i grep adds no filter (the runner's match would be narrower than ours). filtered = a name
//     filter was added, or the command text uses $QA_TEST_GREP. scoped = the file was appended, or the command
//     text uses $QA_TEST_FILE (with a testFile). narrowed = filtered or scoped or the command has a filter of its
//     own: the run is not the whole suite. env always has QA_TEST_GREP (the grep), QA_TEST_FILE (testFile or '')
//     and QA_TEST_REPORT (the report path), so an opaque command (npm run …) may apply them:
//     `${QA_TEST_GREP:+--grep "$QA_TEST_GREP"}` is empty when a mutant run uses the same suite.
//     grep null (0.5.0, `qa ready` runs each suite whole): no name filter, the reporter still added, and
//     QA_TEST_GREP is ''.
//   parseTests({ report, output }) -> { tests: [{ name, names, status }] | null, summary: { passed, failed,
//     skipped } | null, source }
//     status 'passed' | 'failed' | 'skipped' | 'flaky' (passed on a retry). The first that applies:
//       report text (the file the runner wrote): Playwright JSON ('playwright json'), Jest/Vitest JSON
//       ('jest json'), JUnit XML ('junit xml');
//       output: Playwright JSON printed on stdout ('playwright json'), TAP ('tap'; node's nesting: suites and
//       parents are not tests, their leaves are), node's spec reporter ('node spec');
//       else summary: the counts of the last summary line ('N passed', 'N failed', 'N skipped', jest/pytest/
//       playwright/vitest/mocha wording, or node's 'ℹ pass N') with tests null ('summary line');
//       else nothing: tests null, summary null, source 'none'.
//   judgeTest({ parsed, grep, code, filtered, timedOut, notRun }) -> { result, why, counts, names }
//     result 'met' | 'NOT MET' | 'unverifiable'. counts = { total, matched, passed, failed, skipped, flaky }.
//     With named tests: matched = the tests grep matches. 0 matched -> unverifiable; any matched failed ->
//     NOT MET; any matched skipped -> unverifiable (a skipped test proves nothing); else met. Only a summary
//     line: unverifiable unless the command was filtered (else nothing shows the named test ran); filtered:
//     nothing counted -> unverifiable, failed or a non-zero exit -> NOT MET, any skipped -> unverifiable,
//     passed > 0 -> met. Nothing parsed, notRun or a timeout with no parsed failure -> unverifiable.
//     names = up to 10 matched tests '<status> <name>'.
//   runTests({ dir, at, entries, suites = null, profile, mainRoot, vars, logDir, runVerb = adapter.mjs runVerb, side = 'head',
//              timeoutMs, exec, log }) -> Promise<[TestRecord]>
//     dir = the sandbox worktree, the cwd of every command. suites null -> loadSuites({ root: dir, profile })
//     .suites (its note, when it read the old place, is logged as 'note: <note>'). One record per entry, in order.
//     A suite that is 'test:<level>' (named so in the entry, or registered so) -> runVerb('test', { cwd: dir,
//     args: [level], vars, env, timeoutMs }) (notRun passes through; code 124 = timed out); env QA_TEST_GREP,
//     QA_TEST_FILE (the absolute file or ''), QA_TEST_REPORT: the verb is the project's own entry point and takes
//     them by contract. Anything else -> commandFor, then exec({ file, argv, cwd: dir, env: process.env +
//     QA_ROOT/QA_MAIN_ROOT/QA_SLUG/QA_PORT + the command's env, logFile, timeoutMs }) -> { code, output, ms,
//     timedOut }.
//     EVIDENCE RUNS NAMED TESTS ONLY (rework): a command that is not narrowed (commandFor) never runs; the record
//     is unverifiable 'not run: suite <id> cannot run one test (<why>), and evidence never runs the whole suite:
//     name the test's file, or …'. A command narrowed by its file alone (no name filter) is the same run for every
//     entry naming that suite and file: it runs once and serves them all. Output goes to
//     <logDir>/test-<name>.<side>.log (a shared run: test-suite-<suite>[-<file>].<side>.log), the runner's report
//     beside it (.report).
//     timeoutMs default: the suite's own timeoutMs (suites.mjs timeoutOf), else profile.mutants?.timeoutMs ??
//     900000. TestRecord = { id: 'exp:<name>', name, criterion, suite, grep, file, side, at, dir, result, why,
//       detail, command, filtered, source, exit, timedOut, ms, counts, names, tail: [last 15 output lines], log,
//       base: null, clears }
//     detail = '[<criterion> · ]<suite> "<grep>": <why>'.
//
//   LIST MODE (rework, `qa plan check`; tests: test/plan.test.mjs): what names a suite has, without running it.
//   listCommandFor(suite, { grep, report, testFile }) -> null | { file, argv, shown, runner, kind, env }
//     The evidence command's filter and file, in the runner's list mode; null for a runner with none (node --test,
//     a command of no known runner, a string qa does not edit).
//       pytest      --collect-only --verbosity=-1 [-k <word>] [<file>]                                kind 'names'
//       vitest      the `run` (or watch/dev/related) after vitest becomes `list`, [-t <re>] --json=<report> [<file>]
//                                                                                           kind 'names'
//       playwright  [--grep <re>] --list --reporter json [<file>], env PLAYWRIGHT_JSON_OUTPUT_NAME kind 'names'
//       jest        [--runTestsByPath <file>] --listTests: the files only                    kind 'files'
//   parseListed(runner, { output, report }) -> { tests: [{ name, names }] | null, files: [path] | null, source }
//     pytest: each '<path>.py::…' line -> name '<module.dotted[.Class]>::<function>' (as JUnit names it), names
//     [function, '<classname>.<function>', '<classname> › <function>', the node id]. vitest: the JSON list
//     ([{ name: 'a > b', file }]) from the report or the output, else 'file > a > b' lines -> titles after the
//     file, named as jest JSON names them. playwright: the JSON report (or JSON on the output) read as a run's
//     report, else the list reporter's '[project] › file:line:col › a › b' lines. jest: absolute paths, one a line
//     (files). Nothing readable -> tests null and files null.
//   withBase(head, base) -> head records with .base set from the base records of the same name, and the
//     detail ending ' · base: <note>': met 'already passing on base (proves it holds now, not that this PR
//     made it hold)'; NOT MET 'fails on base (this PR made it pass)'; 0 matched 'no such test on base (new
//     with this PR)'; other 'not judged on base: <why>'; { notRun } 'not run on base: <why>'. Never changes
//     the result.
//   testExpectations(records) -> [{ name, result, detail }]   what buildResults appends to expectations.
//
//   CLEARS (0.6.0; tests: test/noise.test.mjs): a test expectation may also carry `clears`, the page-check rows
//   its test proves wrong (a focus ring the test asserts, a control the test taps through):
//     { name, test: { … }, criterion?, clears: [clear] }
//     clear = a finding id 'chk:<viewport>/<key>/<n>' or 'tour:<viewport>/<key>/<n>' (exact), or a match
//             { check, screens?, viewports?, detail? }: check a page-check id (CHECK_IDS) or 'tour'; screens a glob
//             (or a list) of screen names or '<screen>__<state>' keys; viewports a list; detail a substring of the
//             finding's text or '/re/flags'.
//   clearsProblem(clears) -> string | null   null for undefined; else 'clears must be a list' | 'clears[<i>]: …'.
//     entryProblem reports it too, so a test with a bad clears list is not run (unverifiable, the reason named).
//   clearsFinding(clear, finding) -> boolean   finding = a results.checks.new entry ({ id, viewport, key, check,
//     detail }) or a results.tour.new entry ({ id, viewport, key, text, kind }, class 'tour').
//   A TestRecord carries clears ([] when none). verdict.mjs: a page-check row a MET test clears is a Note.
//
// Mutants (mutants.mjs) and test expectations use the same suites. A killed mutant shows a suite bites on a
// guard; a met test expectation shows a named test passes on head. Neither stands in for the other.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cmdOf, loadSuites, timeoutOf } from './suites.mjs';
import { resolveVerb, runVerb as adapterRunVerb } from './adapter.mjs';
import { CHECK_IDS } from './checks.mjs';
import { glob } from './util.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (s) => String(s ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n');
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '-');

export function testEntries(list) {
  return Array.isArray(list) ? list.filter((e) => isObject(e) && e.test !== undefined) : [];
}

function regexOf(grep) {
  const s = String(grep);
  const slash = s.lastIndexOf('/');
  if (s.startsWith('/') && slash > 0) return new RegExp(s.slice(1, slash), s.slice(slash + 1));
  return null;
}

const FINDING_ID = /^(chk|tour):[^/\s]+\/[^/\s]+\/\d+$/;
const listOf = (v) => (Array.isArray(v) ? v : [v]);

export function clearsProblem(clears) {
  if (clears === undefined) return null;
  if (!Array.isArray(clears)) return 'clears must be a list';
  for (const [i, c] of clears.entries()) {
    const at = `clears[${i}]`;
    if (typeof c === 'string') {
      if (!FINDING_ID.test(c)) return `${at}: "${c}" is not a chk:<viewport>/<key>/<n> or tour:… id`;
      continue;
    }
    if (!isObject(c)) return `${at}: a finding id or { check, screens?, viewports?, detail? }`;
    if (c.check !== 'tour' && !CHECK_IDS.includes(c.check)) return `${at}.check: one of ${CHECK_IDS.join(', ')} or tour`;
    if (c.screens !== undefined && !listOf(c.screens).every(isText)) return `${at}.screens: a glob or a list of them`;
    if (c.viewports !== undefined && !(Array.isArray(c.viewports) && c.viewports.every(isText))) return `${at}.viewports: a list of viewport names`;
    if (c.detail !== undefined) {
      if (!isText(c.detail)) return `${at}.detail: a text or /re/flags`;
      try {
        regexOf(c.detail);
      } catch (error) {
        return `${at}.detail: ${error.message}`;
      }
    }
  }
  return null;
}

export function clearsFinding(clear, f) {
  if (typeof clear === 'string') return clear === f?.id;
  if (!isObject(clear) || !f) return false;
  const tour = String(f.id ?? '').startsWith('tour:');
  if (clear.check !== (tour ? 'tour' : f.check)) return false;
  if (clear.viewports && !clear.viewports.includes(f.viewport)) return false;
  if (clear.screens !== undefined) {
    const key = String(f.key ?? '');
    const screen = key.split('__')[0];
    if (!listOf(clear.screens).some((p) => glob(p).test(screen) || glob(p).test(key))) return false;
  }
  if (clear.detail !== undefined) {
    const text = String((tour ? f.text : f.detail) ?? '');
    const re = regexOf(clear.detail);
    if (re ? !(re.lastIndex = 0, re.test(text)) : !text.includes(clear.detail)) return false;
  }
  return true;
}

// A path relative to the repo root: no leading '/', no '..' segment.
const relPath = (f) => isText(f) && !path.isAbsolute(f) && !/^[A-Za-z]:[\\/]/.test(f) && !String(f).split(/[\\/]/).includes('..');

export function entryProblem(entry, suites = {}) {
  if (!isText(entry?.name)) return 'no name';
  const t = entry.test;
  if (!isObject(t)) return 'test must be { suite, grep }';
  if (!isText(t.suite)) return 'test.suite missing';
  if (!/^test:\S+$/.test(t.suite) && !Object.hasOwn(suites ?? {}, t.suite)) {
    const known = Object.keys(suites ?? {});
    return `unknown suite "${t.suite}" (known: ${known.length ? known.join(', ') : 'none'} or test:<level>)`;
  }
  if (!isText(t.grep)) return 'test.grep missing';
  try {
    regexOf(t.grep);
  } catch (error) {
    return `test.grep: ${error.message}`;
  }
  if (t.file !== undefined && !relPath(t.file)) return 'test.file must be a path relative to the repo root';
  return clearsProblem(entry.clears);
}

export function grepMatcher(grep) {
  const re = regexOf(grep);
  const one = re ? (s) => { re.lastIndex = 0; return re.test(s); } : (s) => s.includes(String(grep));
  return (t) => [t.name, ...(t.names ?? [])].some((s) => typeof s === 'string' && one(s));
}

// ── commands ────────────────────────────────────────────────────────────────────

const RUNNERS = [
  ['playwright', /(^|[\s/])playwright\s+test\b/],
  ['vitest', /(^|[\s/])vitest(\s|$)/],
  ['jest', /(^|[\s/])jest(\s|$)/],
  ['pytest', /(^|[\s/])pytest(\s|$)/],
  ['node', /(^|[\s/])node(\s.*)?\s--test(\s|$)/],
];
const HAS_FILTER = {
  playwright: /(^|\s)(-g|--grep)(\s|=|$)/,
  vitest: /(^|\s)(-t|--testNamePattern)(\s|=|$)/,
  jest: /(^|\s)(-t|--testNamePattern)(\s|=|$)/,
  pytest: /(^|\s)-k(\s|$)/,
  node: /(^|\s)--test-name-pattern(\s|=|$)/,
};

export function runnerOf(text) {
  const s = String(text ?? '');
  return RUNNERS.find(([, re]) => re.test(s))?.[0] ?? null;
}

// What a runner is given: [args to append (or to put after --test for node), env].
function runnerArgs(runner, { grep, report, text }) {
  const re = grep == null ? null : regexOf(grep);
  const pattern = grep == null ? null : re ? (re.flags.includes('i') ? null : re.source) : reEscape(String(grep));
  const filter = pattern !== null && !HAS_FILTER[runner].test(text);
  switch (runner) {
    case 'playwright':
      return { args: [...(filter ? ['--grep', pattern] : []), '--reporter', 'json'], env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report }, filter };
    case 'vitest':
      return { args: [...(filter ? ['-t', pattern] : []), '--reporter=json', `--outputFile=${report}`], env: {}, filter };
    case 'jest':
      return { args: [...(filter ? ['-t', pattern] : []), '--json', `--outputFile=${report}`], env: {}, filter };
    case 'pytest': {
      const word = grep != null && !re && /^[A-Za-z0-9_]+$/.test(String(grep)) && filter;
      return { args: [`--junitxml=${report}`, ...(word ? ['-k', String(grep)] : [])], env: {}, filter: word };
    }
    case 'node': {
      const reporter = /--test-reporter(\s|=)/.test(text) ? [] : ['--test-reporter=tap'];
      return { args: [...reporter, ...(filter ? [`--test-name-pattern=${pattern}`] : [])], env: {}, filter };
    }
    default:
      return { args: [], env: {}, filter: false };
  }
}

const SHELL_META = /[;&|<>`]|\$\(/;
const showArgv = (argv) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a))).join(' ');

// The command of a suite with args added: a string gets them quoted at its end, or right after `--test` for
// node (`before`), the rest (`after`) at its very end; an argv list the same way.
function withArgs(cmd, runner, before, after) {
  if (typeof cmd === 'string') {
    let line = cmd;
    const q = (list) => list.map(shellQuote).join(' ');
    if (before.length && runner === 'node') line = line.replace(/(^|\s)--test(?=\s|$)/, `$1--test ${q(before)}`);
    else if (before.length) line = `${line} ${q(before)}`;
    if (after.length) line = `${line} ${q(after)}`;
    return { file: 'bash', argv: ['-c', line], shown: line };
  }
  const argv = [...cmd.slice(1)];
  if (runner === 'node') argv.splice(argv.indexOf('--test') + 1, 0, ...before);
  else argv.push(...before);
  argv.push(...after);
  return { file: cmd[0], argv, shown: showArgv([cmd[0], ...argv]) };
}

// The runner a suite's command is known to be, when qa may add to it (an argv list, or a string with no shell
// operators); null otherwise.
function runnerFor(cmd) {
  const isString = typeof cmd === 'string';
  const simple = !isString || !SHELL_META.test(cmd);
  return simple ? runnerOf(isString ? cmd : cmd.join(' ')) : null;
}

const fileArgs = (runner, testFile) => (testFile == null ? [] : runner === 'jest' ? ['--runTestsByPath', String(testFile)] : [String(testFile)]);

export function commandFor(suite, { grep, report, testFile = null }) {
  const cmd = cmdOf(suite) ?? suite;
  const env = { QA_TEST_GREP: grep == null ? '' : String(grep), QA_TEST_FILE: testFile == null ? '' : String(testFile), QA_TEST_REPORT: String(report) };
  const text = typeof cmd === 'string' ? cmd : cmd.join(' ');
  const usesGrep = /QA_TEST_GREP/.test(text);
  const usesFile = /QA_TEST_FILE/.test(text);
  const runner = runnerFor(cmd);
  const added = runner ? runnerArgs(runner, { grep, report, text }) : { args: [], env: {}, filter: false };
  const after = runner && !usesFile ? fileArgs(runner, testFile) : [];
  const built = withArgs(cmd, runner, added.args, after);
  const filtered = added.filter || usesGrep;
  const scoped = testFile != null && (after.length > 0 || usesFile);
  const ownFilter = Boolean(runner && HAS_FILTER[runner].test(text));
  return { ...built, runner, filtered, scoped, narrowed: filtered || scoped || ownFilter, env: { ...env, ...added.env } };
}

// ── list mode (plan check) ──────────────────────────────────────────────────────

const VITEST_SUB = /(^|[\s/])vitest(?:\s+(?:run|watch|dev|related))?(?=\s|$)/;

export function listCommandFor(suite, { grep, report, testFile = null }) {
  const cmd = cmdOf(suite) ?? suite;
  const runner = runnerFor(cmd);
  if (!runner || runner === 'node') return null;
  const text = typeof cmd === 'string' ? cmd : cmd.join(' ');
  const re = grep == null ? null : regexOf(grep);
  const pattern = grep == null ? null : re ? (re.flags.includes('i') ? null : re.source) : reEscape(String(grep));
  const filter = pattern !== null && !HAS_FILTER[runner].test(text);
  const file = testFile == null ? [] : [String(testFile)];
  const env = { QA_TEST_GREP: grep == null ? '' : String(grep), QA_TEST_FILE: testFile == null ? '' : String(testFile), QA_TEST_REPORT: String(report) };
  if (runner === 'jest') return { ...withArgs(cmd, runner, [], [...fileArgs('jest', testFile), '--listTests']), runner, kind: 'files', env };
  if (runner === 'pytest') {
    const word = grep != null && !re && /^[A-Za-z0-9_]+$/.test(String(grep)) && filter;
    return { ...withArgs(cmd, runner, [], ['--collect-only', '--verbosity=-1', ...(word ? ['-k', String(grep)] : []), ...file]), runner, kind: 'names', env };
  }
  if (runner === 'playwright') {
    const args = [...(filter ? ['--grep', pattern] : []), '--list', '--reporter', 'json', ...file];
    return { ...withArgs(cmd, runner, [], args), runner, kind: 'names', env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: String(report) } };
  }
  // vitest: its list subcommand in place of run.
  const listed = typeof cmd === 'string'
    ? (VITEST_SUB.test(cmd) ? cmd.replace(VITEST_SUB, '$1vitest list') : cmd)
    : (() => {
      const at = cmd.findIndex((a) => /(^|\/)vitest$/.test(a));
      if (at < 0) return cmd;
      const next = cmd[at + 1];
      return ['run', 'watch', 'dev', 'related'].includes(next) ? [...cmd.slice(0, at + 1), 'list', ...cmd.slice(at + 2)] : [...cmd.slice(0, at + 1), 'list', ...cmd.slice(at + 1)];
    })();
  const args = [...(filter ? ['-t', pattern] : []), `--json=${report}`, ...file];
  return { ...withArgs(listed, runner, [], args), runner, kind: 'names', env };
}

// A pytest node id ('tests/test_a.py::TestX::test_y[1]') named as its JUnit report names it.
function pytestNamed(nodeid) {
  const parts = nodeid.split('::');
  const fn = parts.at(-1);
  const module = parts[0].replace(/\.py$/, '').split(/[\\/]/).filter(Boolean).join('.');
  const cls = [module, ...parts.slice(1, -1)].join('.');
  return { name: `${cls}::${fn}`, names: [fn, `${cls}.${fn}`, `${cls} › ${fn}`, nodeid] };
}

// Vitest's titles ('a > b' or 'file > a > b' with the file) named as the jest JSON reporter names them.
const vitestNamed = (titles) => ({ name: titles.join(' '), names: [titles.join(' › '), titles.join(' '), titles.at(-1)] });

export function parseListed(runner, { output = '', report = null } = {}) {
  const text = plain(output);
  const none = { tests: null, files: null, source: 'none' };
  if (runner === 'pytest') {
    const ids = text.split('\n').map((l) => l.trim()).filter((l) => /^[^\s<]+\.py::\S/.test(l));
    return ids.length ? { tests: ids.map(pytestNamed), files: null, source: 'pytest --collect-only' } : none;
  }
  if (runner === 'jest') {
    const files = text.split('\n').map((l) => l.trim()).filter((l) => path.isAbsolute(l));
    return files.length ? { tests: null, files, source: 'jest --listTests' } : none;
  }
  if (runner === 'playwright') {
    for (const data of [jsonOf(report), jsonIn(text)]) {
      if (data && Array.isArray(data.suites)) return { tests: playwrightTests(data).map(({ name, names }) => ({ name, names })), files: null, source: 'playwright --list json' };
    }
    const tests = [];
    for (const line of text.split('\n')) {
      const m = /^\s*(\[[^\]]+\] › )?(\S+?):\d+:\d+ › (.+)$/.exec(line);
      if (!m) continue;
      const titles = [m[2], ...m[3].split(' › ')];
      tests.push({ name: `${m[1] ?? ''}${titles.join(' › ')}`, names: [titles.join(' › '), titles.join(' '), titles.at(-1)] });
    }
    return tests.length ? { tests, files: null, source: 'playwright --list' } : none;
  }
  if (runner === 'vitest') {
    for (const data of [jsonOf(report), jsonOfText(text)]) {
      if (Array.isArray(data) && data.every((t) => t && typeof t.name === 'string')) {
        return { tests: data.map((t) => vitestNamed(t.name.split(' > '))), files: null, source: 'vitest list json' };
      }
    }
    const tests = text.split('\n').map((l) => l.trim()).filter((l) => / > /.test(l) && /^\S+\.\w+ > /.test(l)).map((l) => vitestNamed(l.split(' > ').slice(1)));
    return tests.length ? { tests, files: null, source: 'vitest list' } : none;
  }
  return none;
}

function jsonOf(textOrNull) {
  if (textOrNull == null) return null;
  try {
    return JSON.parse(String(textOrNull));
  } catch {
    return null;
  }
}

// A JSON array or object printed alone on the output (the first line that starts one).
function jsonOfText(text) {
  const at = text.search(/^[[{]/m);
  return at < 0 ? null : jsonOf(text.slice(at).trim());
}

// ── parsers ─────────────────────────────────────────────────────────────────────

const leafStatus = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' };

function playwrightTests(data) {
  const out = [];
  const walk = (suite, chain) => {
    const here = suite.title ? [...chain, suite.title] : chain;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const status = t.expectedStatus === 'skipped' ? 'skipped' : leafStatus[t.status] ?? 'failed';
        const titles = [...here, spec.title];
        const project = t.projectName ? `[${t.projectName}] › ` : '';
        out.push({ name: `${project}${titles.join(' › ')}`, names: [titles.join(' › '), titles.join(' '), spec.title], status });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of data.suites ?? []) walk(s, []);
  return out;
}

function jestTests(data) {
  const map = { passed: 'passed', failed: 'failed', pending: 'skipped', skipped: 'skipped', todo: 'skipped', disabled: 'skipped' };
  return (data.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).map((a) => {
    const titles = [...(a.ancestorTitles ?? []), a.title];
    return { name: a.fullName ?? titles.join(' '), names: [titles.join(' › '), titles.join(' '), a.title], status: map[a.status] ?? 'failed' };
  }));
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return XML_ENTITIES[e.toLowerCase()];
});
const attr = (attrs, key) => unxml(new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1] ?? '');

function junitTests(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = attr(m[1], 'name');
    const cls = attr(m[1], 'classname');
    const body = m[2] ?? '';
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    out.push({ name: cls ? `${cls}::${name}` : name, names: [name, cls ? `${cls}.${name}` : name, cls ? `${cls} › ${name}` : name], status });
  }
  return out;
}

const TAP_LINE = /^(\s*)(not ok|ok)\b\s*\d*\s*(?:-\s*)?(.*?)\s*(?:#\s*(SKIP|TODO)\b.*)?$/i;

function tapTests(text) {
  const lines = plain(text).split('\n');
  if (!lines.some((l) => TAP_LINE.test(l) && /^\s*(not ok|ok) \d+/.test(l))) return null;
  const pending = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*(not ok|ok) \d+/.test(line)) continue;
    const m = TAP_LINE.exec(line);
    const depth = Math.floor(m[1].replace(/\t/g, '    ').length / 4);
    let suite = false;
    if (/^\s*---\s*$/.test(lines[i + 1] ?? '')) {
      for (let j = i + 2; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) {
        if (/^\s*type:\s*'?suite'?\s*$/.test(lines[j])) suite = true;
      }
    }
    const children = pending.get(depth + 1) ?? [];
    pending.delete(depth + 1);
    const status = m[4] ? 'skipped' : m[2].toLowerCase() === 'ok' ? 'passed' : 'failed';
    const node = { name: m[3].replace(/\\#/g, '#'), status, children, suite };
    pending.set(depth, [...(pending.get(depth) ?? []), node]);
  }
  const roots = [...pending.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, list]) => list);
  return leaves(roots);
}

function leaves(roots) {
  const out = [];
  const walk = (node, chain) => {
    const titles = [...chain, node.name];
    if (node.children.length) {
      for (const c of node.children) walk(c, titles);
      return;
    }
    if (node.suite) return;
    out.push({ name: titles.join(' › '), names: [titles.join(' '), node.name], status: node.status });
  };
  for (const r of roots) walk(r, []);
  return out;
}

const SPEC_LINE = /^(\s*)(✔|✖|﹣|▶)\s+(.*)$/;
// 'name (1.2ms) # reason' -> { name, directive }: the duration and what follows it are not the name.
function specName(rest) {
  const m = /^(.*?)\s+\(\d[\d.]*m?s\)(.*)$/.exec(rest);
  const [name, after] = m ? [m[1], m[2]] : [rest.replace(/\s+#\s*(SKIP|TODO)\b.*$/i, ''), (/\s+#\s*(SKIP|TODO)\b.*$/i.exec(rest) ?? [''])[0]];
  return { name: name.trim(), todo: /#\s*(SKIP|TODO)\b/i.test(after) };
}

function nodeSpecTests(text) {
  const lines = plain(text).split('\n');
  const end = lines.findIndex((l) => /^[ℹ#]\s*tests\s+\d+/.test(l.trim()));
  const body = end >= 0 ? lines.slice(0, end) : lines;
  if (!body.some((l) => /^\s*(✔|✖|﹣)\s/.test(l))) return null;
  const roots = [];
  const open = [];
  const add = (node, depth) => {
    while (open.length && open[open.length - 1].depth >= depth) open.pop();
    (open.length ? open[open.length - 1].node.children : roots).push(node);
  };
  for (const line of body) {
    const m = SPEC_LINE.exec(line);
    if (!m) continue;
    const depth = m[1].length;
    const { name, todo } = specName(m[3]);
    if (m[2] === '▶') {
      const node = { name, status: 'passed', children: [], suite: true };
      add(node, depth);
      open.push({ depth, node });
      continue;
    }
    // A suite's closing line has the indent of its ▶ line.
    const top = open[open.length - 1];
    if (top && top.depth === depth && top.node.name === name) {
      open.pop();
      continue;
    }
    const status = m[2] === '﹣' || (todo && m[2] === '✔') ? 'skipped' : m[2] === '✔' ? 'passed' : 'failed';
    add({ name, status, children: [], suite: false }, depth);
  }
  return leaves(roots);
}

function jsonIn(text) {
  const s = String(text ?? '');
  const starts = [];
  for (let at = s.indexOf('{'); at >= 0 && starts.length < 20; at = s.indexOf('{', at + 1)) {
    if (at === 0 || s[at - 1] === '\n') starts.push(at);
  }
  for (const at of starts) {
    try {
      return JSON.parse(s.slice(at).trim());
    } catch { /* not this one */ }
  }
  return null;
}

function summaryCounts(text) {
  const lines = plain(text).split('\n');
  const node = {};
  for (const l of lines) {
    const m = /^\s*[ℹ#]\s*(pass|fail|skipped|todo)\s+(\d+)\s*$/.exec(l);
    if (m) node[m[1]] = Number(m[2]);
  }
  if (Object.keys(node).length) return { passed: node.pass ?? 0, failed: node.fail ?? 0, skipped: (node.skipped ?? 0) + (node.todo ?? 0) };
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/\b\d+ (passed|failed|passing|failing)\b/.test(l)) continue;
    const n = (re) => [...l.matchAll(re)].reduce((sum, x) => sum + Number(x[1]), 0);
    return {
      passed: n(/\b(\d+) (?:passed|passing)\b/g) + n(/\b(\d+) flaky\b/g),
      failed: n(/\b(\d+) (?:failed|failing|errors?)\b/g),
      skipped: n(/\b(\d+) (?:skipped|pending|todo|deselected)\b/g),
    };
  }
  return null;
}

export function parseTests({ report = null, output = '' } = {}) {
  const r = String(report ?? '').trim();
  if (r.startsWith('{')) {
    try {
      const data = JSON.parse(r);
      if (Array.isArray(data.suites)) return { tests: playwrightTests(data), summary: null, source: 'playwright json' };
      if (Array.isArray(data.testResults)) return { tests: jestTests(data), summary: null, source: 'jest json' };
    } catch { /* not JSON after all: read the output */ }
  } else if (r.startsWith('<')) {
    return { tests: junitTests(r), summary: null, source: 'junit xml' };
  }
  const data = jsonIn(plain(output));
  if (data && Array.isArray(data.suites)) return { tests: playwrightTests(data), summary: null, source: 'playwright json' };
  if (data && Array.isArray(data.testResults)) return { tests: jestTests(data), summary: null, source: 'jest json' };
  const tap = tapTests(output);
  if (tap) return { tests: tap, summary: null, source: 'tap' };
  const spec = nodeSpecTests(output);
  if (spec) return { tests: spec, summary: null, source: 'node spec' };
  const summary = summaryCounts(output);
  return { tests: null, summary, source: summary ? 'summary line' : 'none' };
}

// ── judging ─────────────────────────────────────────────────────────────────────

export function judgeTest({ parsed, grep, code = null, filtered = false, timedOut = false, notRun = null }) {
  const counts = { total: 0, matched: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  const out = (result, why, names = []) => ({ result, why, counts, names });
  if (notRun) return out('unverifiable', `not run: ${notRun}`);
  const exitNote = code !== 0 && code !== null ? `, exit ${code}` : '';
  const tests = parsed?.tests ?? null;
  if (tests) {
    const match = grepMatcher(grep);
    const matched = tests.filter((t) => match(t));
    counts.total = tests.length;
    counts.matched = matched.length;
    for (const t of matched) {
      if (t.status === 'flaky') { counts.flaky += 1; counts.passed += 1; } else counts[t.status] += 1;
    }
    const names = matched.slice(0, 10).map((t) => `${t.status} ${t.name}`);
    const src = parsed.source;
    if (!matched.length) {
      const why = tests.length ? `0 of ${tests.length} test(s) match (${src}${exitNote})` : `no test ran (${src}${exitNote})`;
      return out('unverifiable', timedOut ? `${why}; timed out` : why, names);
    }
    const first = (status) => matched.find((t) => t.status === status)?.name;
    if (counts.failed) return out('NOT MET', `${counts.failed} of ${counts.matched} matched failed: ${first('failed')} (${src}${exitNote})`, names);
    if (counts.skipped) return out('unverifiable', `${counts.skipped} of ${counts.matched} matched skipped: ${first('skipped')}; a skipped test proves nothing (${src})`, names);
    if (timedOut) return out('unverifiable', `timed out; ${counts.passed} of ${counts.matched} matched passed before it (${src})`, names);
    const flaky = counts.flaky ? `, ${counts.flaky} flaky` : '';
    return out('met', `${counts.passed} of ${counts.matched} matched passed${flaky} (${tests.length} ran, ${src}${exitNote})`, names);
  }
  const s = parsed?.summary ?? null;
  if (timedOut) return out('unverifiable', 'timed out before the runner reported');
  if (!s) return out('unverifiable', `no test results in the output (exit ${code ?? 'none'})`);
  Object.assign(counts, { total: s.passed + s.failed + s.skipped, passed: s.passed, failed: s.failed, skipped: s.skipped });
  const said = `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`;
  if (!filtered) return out('unverifiable', `the output names no test (${said}) and the suite takes no name filter, so nothing shows this test ran`);
  counts.matched = counts.total;
  if (!counts.total) return out('unverifiable', `no test ran (summary line${exitNote})`);
  if (s.failed || (code !== 0 && code !== null)) return out('NOT MET', `${said} (summary line${exitNote}; names not listed)`);
  if (s.skipped) return out('unverifiable', `${said}: a skipped test proves nothing (summary line)`);
  return out('met', `${s.passed} passed (summary line; names not listed)`);
}

// ── running ─────────────────────────────────────────────────────────────────────

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// The default exec: one process in its own group, stdout and stderr into one text and the log file.
export function execCommand({ file, argv, cwd, env, logFile, timeoutMs }) {
  const started = Date.now();
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    let output = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fs.writeFileSync(logFile, output);
      resolve({ code: timedOut ? 124 : code, output, ms: Date.now() - started, timedOut });
    };
    let child;
    try {
      child = spawn(file, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      output += `${error.message}\n`;
      return done(127);
    }
    const take = (chunk) => { if (output.length < 8 << 20) output += chunk; };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => { output += `${error.message}\n`; done(error.code === 'ENOENT' ? 127 : 126); });
    child.on('close', (code) => done(code));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, timeoutMs);
    }
  });
}

const tailOf = (text, n = 15) => plain(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n).map((l) => (l.length > 300 ? `${l.slice(0, 297)}...` : l));

function readReport(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// How the 'test:<level>' verb is shown: the qa.json command or the adapter file it resolves to.
// usesEnv: it reads $QA_TEST_GREP, so it filters by name itself. narrows (1.0.4): it reads $QA_TEST_FILE or
// $QA_TEST_GREP, so it can run less than the whole suite. A verb that reads neither runs everything every time (CRM
// 11-13: `test unit` ran ~8,000 tests per plan-check entry for 3 h), so evidence never runs it. The text read is the
// qa.json command, else the adapter's verb file.
function verbShown(level, profile, mainRoot) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  try {
    const r = resolveVerb('test', { profile, mainRoot });
    let text = null;
    let shown = null;
    if (r.kind === 'command') { text = r.command; shown = `test:${level} → ${r.command} ${shellQuote(level)}`; }
    if (r.kind === 'exec') {
      text = read(r.file);
      shown = `test:${level} → ${r.adapter} adapter test ${level}`;
    }
    if (text !== null) return { shown, usesEnv: /QA_TEST_GREP/.test(text), narrows: /QA_TEST_(FILE|GREP)/.test(text) };
  } catch { /* shown plainly */ }
  // No test verb at all: nothing can run, and the verb call says NOT RUN at once.
  return { shown: `test:${level}`, usesEnv: false, narrows: true };
}

// How one entry's test runs: the verb level when its suite is 'test:<level>' (named so, or registered so), else the
// registered suite's command. null when the suite is unknown (entryProblem reports that first).
export function suiteRun(t, suites) {
  if (typeof t?.suite !== 'string') return null;
  if (/^test:\S+$/.test(t.suite) && !Object.hasOwn(suites ?? {}, t.suite)) return { level: t.suite.slice('test:'.length), suite: null };
  const suite = suites?.[t.suite];
  const cmd = cmdOf(suite);
  if (cmd === null) return null;
  if (typeof cmd === 'string' && /^test:\S+$/.test(cmd)) return { level: cmd.slice('test:'.length), suite };
  return { level: null, suite };
}

// Why a command cannot run one test, for the record and the plan check.
export function wholeSuiteWhy(suiteId, t, plan) {
  const why = plan.runner
    ? `${plan.runner} takes no name filter for "${t.grep}" (a /re/i, or for pytest anything but one word)`
    : 'its command is no known runner qa can add a filter to, and it does not read $QA_TEST_GREP or $QA_TEST_FILE';
  const verb = /^test:\S+$/.test(String(suiteId)) && !plan.runner
    ? `; the project's \`test\` verb reads neither, so register the runner's own command as a suite in qa/suites.* (\`qa setup suites\`) and name that suite, or make the verb read $QA_TEST_FILE`
    : '';
  return `suite ${suiteId} cannot run one test (${why}), and evidence never runs the whole suite: name the test's file ("file"), or a grep the runner can filter by${verb}`;
}

export async function runTests({
  dir, at = null, entries = [], suites = null, profile = {}, mainRoot = null, vars = {}, logDir, runVerb = adapterRunVerb, side = 'head',
  timeoutMs = null, exec = execCommand, log = () => {},
} = {}) {
  let known = suites;
  if (!known) {
    const loaded = await loadSuites({ root: dir, profile });
    if (loaded.note) log(`note: ${loaded.note}`);
    known = loaded.suites;
  }
  const ran = new Map();
  const records = [];
  const baseEnv = {
    QA_ROOT: String(dir),
    QA_MAIN_ROOT: String(mainRoot ?? ''),
    QA_SLUG: String(vars.slug ?? ''),
    QA_PORT: vars.port == null ? '' : String(vars.port),
  };
  for (const entry of entries) {
    const t = isObject(entry?.test) ? entry.test : {};
    const name = isText(entry?.name) ? entry.name : JSON.stringify(entry);
    const record = {
      id: `exp:${name}`, name, criterion: entry?.criterion ?? null, suite: t.suite ?? null, grep: t.grep ?? null, file: t.file ?? null, side, at, dir,
      result: 'unverifiable', why: '', detail: '', command: null, filtered: false, source: 'none', exit: null, timedOut: false, ms: 0,
      counts: { total: 0, matched: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 }, names: [], tail: [], log: null, base: null,
      clears: Array.isArray(entry?.clears) ? entry.clears : [],
    };
    records.push(record);
    const finish = (verdict) => {
      Object.assign(record, { result: verdict.result, why: verdict.why, counts: verdict.counts, names: verdict.names });
      const lead = record.criterion ? `${record.criterion} · ` : '';
      record.detail = `${lead}${record.suite ?? 'test'} "${record.grep ?? ''}": ${verdict.why}`.replace(/\s*\n\s*/g, ' ');
    };
    const problem = entryProblem(entry, known);
    if (problem) {
      finish(judgeTest({ notRun: problem }));
      continue;
    }
    const how = suiteRun(t, known);
    const testFile = t.file === undefined ? null : path.resolve(dir, t.file);
    if (testFile && !fs.existsSync(testFile)) {
      finish(judgeTest({ notRun: `test.file ${t.file} is not in the head tree` }));
      continue;
    }
    const limit = timeoutMs ?? timeoutOf(how.suite, profile);
    // A filtered command is this entry's own run; an unfiltered one (narrowed by its file) is shared (below).
    const planFor = (stem) => {
      const report = path.join(logDir, `${stem}.${side}.report`);
      const logFile = path.join(logDir, `${stem}.${side}.log`);
      if (how.level === null) return { ...commandFor(how.suite, { grep: t.grep, report, testFile }), report, logFile };
      const verb = verbShown(how.level, profile, mainRoot);
      return {
        verb: how.level, shown: `${verb.shown}${t.file ? ` · file ${t.file}` : ''}`, filtered: verb.usesEnv, narrowed: verb.narrows, report, logFile,
        env: { QA_TEST_GREP: String(t.grep), QA_TEST_FILE: testFile ?? '', QA_TEST_REPORT: report },
      };
    };
    let plan = planFor(`test-suite-${safeName(t.suite)}${t.file ? `-${safeName(t.file)}` : ''}`);
    if (plan.filtered) plan = planFor(`test-${safeName(name)}`);
    if (!plan.narrowed) {
      record.command = plan.shown;
      finish(judgeTest({ notRun: wholeSuiteWhy(t.suite, t, plan) }));
      continue;
    }
    const { report, logFile } = plan;
    // An unfiltered command is the same run for every entry that names it: run it once.
    const key = plan.filtered ? null : `${t.suite}\0${plan.shown}`;
    let outcome = key ? ran.get(key) : null;
    if (!outcome) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.rmSync(report, { force: true });
      log(`test ${name}: ${plan.shown} (${side})`);
      if (plan.verb !== undefined) {
        const r = await runVerb('test', { profile, mainRoot, cwd: dir, args: [plan.verb], vars, env: plan.env, timeoutMs: limit });
        const output = `${r?.stdout ?? ''}${r?.stderr ?? ''}`;
        if (!r?.notRun) fs.writeFileSync(logFile, output);
        outcome = { code: r?.notRun ? null : r?.code ?? null, output, ms: r?.ms ?? 0, timedOut: r?.code === 124, notRun: r?.notRun ?? null, log: r?.notRun ? null : logFile };
      } else {
        const env = { ...process.env, ...baseEnv, ...plan.env };
        delete env.NODE_TEST_CONTEXT; // a node --test suite reports to its own output, never to a runner above qa
        const r = await exec({ file: plan.file, argv: plan.argv, cwd: dir, env, logFile, timeoutMs: limit });
        outcome = { ...r, notRun: null, log: logFile };
      }
      outcome.parsed = parseTests({ report: readReport(report), output: outcome.output });
      if (key) ran.set(key, outcome);
    }
    Object.assign(record, {
      command: plan.shown, filtered: plan.filtered, source: outcome.parsed.source, exit: outcome.code, timedOut: Boolean(outcome.timedOut),
      ms: outcome.ms ?? 0, tail: tailOf(outcome.output), log: outcome.log,
    });
    finish(judgeTest({ parsed: outcome.parsed, grep: t.grep, code: outcome.code, filtered: plan.filtered, timedOut: outcome.timedOut, notRun: outcome.notRun }));
  }
  return records;
}

// ── base and results ───────────────────────────────────────────────────────────

function baseNote(b) {
  if (!b) return null;
  if (b.notRun) return `not run on base: ${b.notRun}`;
  if (b.result === 'met') return 'already passing on base (proves it holds now, not that this PR made it hold)';
  if (b.result === 'NOT MET') return 'fails on base (this PR made it pass)';
  if (b.counts?.matched === 0) return 'no such test on base (new with this PR)';
  return `not judged on base: ${b.why ?? b.detail ?? ''}`;
}

export function withBase(head, base) {
  const byName = new Map((base ?? []).map((b) => [b.name, b]));
  return head.map((r) => {
    if (!byName.has(r.name)) return r;
    const b = byName.get(r.name);
    const slim = b.notRun ? { notRun: b.notRun } : { result: b.result, why: b.why, counts: b.counts, exit: b.exit, command: b.command, at: b.at ?? null, log: b.log ?? null };
    return { ...r, base: slim, detail: `${r.detail} · base: ${baseNote(b)}` };
  });
}

export function testExpectations(records) {
  return (records ?? []).map((r) => ({ name: r.name, result: r.result, detail: r.detail }));
}
