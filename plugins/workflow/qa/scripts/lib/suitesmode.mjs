// Suites mode: a project with no screen-map entries and no stack adapter that serves an app (a library, a CLI, a
// back end with no screens) has nothing for `qa run` to walk. The evidence is then its own test suites, run whole,
// on the head commit. No sandbox, no capture, no base side. Zero model calls.
//
// CONTRACT (tests: test/suites-mode.test.mjs)
//
//   suitesModeApplies({ repoRoot, mainRoot, profile, map = null }) -> { applies, why }
//     applies when the map folder (map, else profile.map) holds no screen entries (it may be missing or empty) AND no
//     stack adapter serves: resolveVerb('serve') and resolveVerb('up') both find neither a qa.json stack command nor
//     an adapter's executable. A map that does not load -> not applies (the walk reports it). why: the reason either
//     way, one line.
//
//   withHeadWorktree({ repoRoot, mainRoot, headSha, slug }, body) -> Promise<what body returns>
//     A detached git worktree of headSha at <mainRoot>/qa-artifacts/suites-<slug>-<sha10> (QA files the commit lacks
//     are copied in, sandbox.mjs seedQaFiles; qa-artifacts/ gets a .gitignore of its own), body(dir) run in it, and the
//     worktree removed at the end, always, even when body throws.
//
//   runSuites({ dir, mainRoot, profile, slug, V, log }, d) -> Promise<{ records, suitesFile, errors }>
//     Each suite of qa/suites.json | .ts | .mjs (suites.mjs loadSuites, read in the worktree) runs once, whole, in it,
//     in the file's order (ready.mjs runSuiteDefault; d.runSuite replaces it); logs in V/logs. Record per suite:
//       { id, command, exit, timedOut, notRun, ms, result, detail, counts: { passed, failed, skipped } | null,
//         failing: [test name] (up to 50), source, log }
//       result 'met' when the command exited 0, else 'NOT MET' (a timeout is a fail); 'unverifiable' only when the suite
//       could not start (no `test` verb for a 'test:<level>' suite: notRun).
//       detail 'exit <n> · <s> s · <command> · <p> passed, <f> failed[, <k> skipped][ · failing: <name>; …]'; failing
//       names come from the runner's report or output (tests.mjs parseTests: pytest JUnit XML, node --test TAP, jest,
//       vitest, playwright, spec output), the first five on the line, 'and <n> more' after them.
//     d: { runSuite, runVerb }.

import fs from 'node:fs';
import path from 'node:path';
import { resolveVerb, runVerb as adapterRunVerb } from './adapter.mjs';
import { loadMap } from './map.mjs';
import { runSuiteDefault } from './ready.mjs';
import { seedQaFiles } from './sandbox.mjs';
import { loadSuites } from './suites.mjs';
import { parseTests } from './tests.mjs';
import { git } from './util.mjs';

export function suitesModeApplies({ repoRoot, mainRoot = repoRoot, profile = {}, map = null }) {
  const mapDir = typeof map === 'string' ? map : path.resolve(repoRoot, profile.map ?? 'qa/map');
  let entries;
  try {
    entries = loadMap({ root: repoRoot, profile: { ...profile, map: mapDir, overlay: undefined } }).screens.length;
  } catch (e) {
    return { applies: false, why: `the map does not load: ${String(e?.message ?? e).split('\n')[0]}` };
  }
  if (entries > 0) return { applies: false, why: `${entries} map entr${entries === 1 ? 'y' : 'ies'}` };
  for (const verb of ['serve', 'up']) {
    const r = resolveVerb(verb, { profile, mainRoot });
    if (r.kind !== 'none') return { applies: false, why: `a stack serves the app (${verb}: ${r.kind === 'command' ? 'qa.json' : r.adapter})` };
  }
  return { applies: true, why: 'no map entries and no stack adapter serves an app' };
}

const MAX_FAILING = 50;
const secs = (ms) => `${Math.round((ms ?? 0) / 100) / 10} s`;

// One suite's outcome, as the row the verdict shows.
export function suiteRecord({ id, outcome, ms }) {
  // The flags the runner adds to read a report back (--junitxml=…, --test-reporter=tap) are not the suite's command.
  const command = (outcome.command ?? '').replace(/\s+'?--junitxml=[^\s']*'?/g, '').replace(/\s+--test-reporter=tap\b/g, '');
  if (outcome.notRun) {
    return {
      id, command, exit: null, timedOut: false, notRun: outcome.notRun, ms, result: 'unverifiable',
      detail: `not run: ${outcome.notRun}`, counts: null, failing: [], source: 'none', log: null,
    };
  }
  const parsed = parseTests({ report: outcome.report ?? null, output: outcome.output ?? '' });
  const failing = (parsed.tests ?? []).filter((t) => t.status === 'failed').map((t) => t.name);
  let counts = parsed.summary ?? null;
  if (parsed.tests) {
    const n = (s) => parsed.tests.filter((t) => t.status === s).length;
    counts = { passed: n('passed') + n('flaky'), failed: n('failed'), skipped: n('skipped') };
  }
  const passed = outcome.code === 0 && !outcome.timedOut;
  const parts = [`exit ${outcome.code ?? 'none'}${outcome.timedOut ? ' (timed out)' : ''}`, secs(ms), command];
  if (counts) parts.push(`${counts.passed} passed, ${counts.failed} failed${counts.skipped ? `, ${counts.skipped} skipped` : ''}`);
  if (failing.length) parts.push(`failing: ${failing.slice(0, 5).join('; ')}${failing.length > 5 ? ` and ${failing.length - 5} more` : ''}`);
  return {
    id, command, exit: outcome.code ?? null, timedOut: Boolean(outcome.timedOut), notRun: null, ms, result: passed ? 'met' : 'NOT MET',
    detail: parts.join(' · ').replace(/\s*\n\s*/g, ' '), counts, failing: failing.slice(0, MAX_FAILING), source: parsed.source, log: outcome.log ?? null,
  };
}

function removeWorktree(mainRoot, dir) {
  git(['worktree', 'remove', '--force', dir], { cwd: mainRoot });
  fs.rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'prune'], { cwd: mainRoot });
}

// A detached worktree of headSha under <mainRoot>/qa-artifacts, `body(dir)` run in it, and the worktree removed: always.
export async function withHeadWorktree({ repoRoot, mainRoot = repoRoot, headSha, slug }, body) {
  const state = path.join(mainRoot, 'qa-artifacts');
  const dir = path.join(state, `suites-${String(slug).replace(/[^A-Za-z0-9._-]/g, '-')}-${String(headSha).slice(0, 10)}`);
  fs.mkdirSync(state, { recursive: true });
  // The state folder keeps itself out of git, whatever the project's own .gitignore says.
  if (!fs.existsSync(path.join(state, '.gitignore'))) fs.writeFileSync(path.join(state, '.gitignore'), '*\n');
  fs.rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'prune'], { cwd: mainRoot });
  try {
    if (git(['worktree', 'add', '--detach', dir, headSha], { cwd: mainRoot }) === null) throw new Error(`could not make a worktree of ${String(headSha).slice(0, 12)} in ${state}`);
    seedQaFiles({ from: repoRoot, dir });
    return await body(dir);
  } finally {
    removeWorktree(mainRoot, dir);
  }
}

// Every suite of the worktree's qa/suites.*, once, whole, in order.
export async function runSuites({ dir, mainRoot, profile = {}, slug, V, log = () => {} }, deps = {}) {
  const d = { runSuite: runSuiteDefault, runVerb: adapterRunVerb, ...deps };
  const loaded = await loadSuites({ root: dir, profile });
  if (loaded.note) log(`note: ${loaded.note}`);
  const records = [];
  const logDir = path.join(V, 'logs');
  for (const [id, suite] of Object.entries(loaded.suites)) {
    log(`suite ${id}: running`);
    const started = Date.now();
    let outcome;
    try {
      outcome = await d.runSuite({ id, suite, dir, profile, mainRoot, vars: { dir, main: mainRoot, slug, port: '' }, logDir, runVerb: d.runVerb });
    } catch (e) {
      outcome = { command: '', code: null, output: '', report: null, timedOut: false, notRun: String(e?.message ?? e).split('\n')[0], log: null };
    }
    const rec = suiteRecord({ id, outcome, ms: Date.now() - started });
    log(`suite ${id}: ${rec.result === 'met' ? 'PASS' : rec.result === 'NOT MET' ? 'FAIL' : 'not run'} (${rec.detail})`);
    records.push(rec);
  }
  return { records, suitesFile: loaded.file, errors: loaded.errors };
}
