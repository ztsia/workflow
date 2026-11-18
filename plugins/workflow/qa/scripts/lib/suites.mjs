// The project's test suites (decision 7 of the rework, ZT 2026-11-12): the commands that run its tests, for test
// evidence (tests.mjs), mutants (mutants.mjs) and readiness (ready.mjs). They live in qa/suites.* of their own; they
// used to be the SUITES of the mutant registry (qa/mutants.*), which is still read, with a one-line note, while a
// project has no suites file. qa/mutants.* keeps the mutants only. Zero model calls.
//
// CONTRACT (tests: test/suites.test.mjs)
//
//   SUITES_FILES = ['qa/suites.json', 'qa/suites.ts', 'qa/suites.mjs']   (the first that exists is read)
//   REGISTRY_FILES = ['qa/mutants.json', 'qa/mutants.ts', 'qa/mutants.mjs'] (the old place)
//   JSON: { "suites": { id: suite } }; .ts/.mjs: `export const SUITES = { id: suite }` (Node strips the types).
//   A suite is one of:
//     'test:<level>'           the stack adapter's `test` verb with arg <level>
//     a string                 a shell command, run with bash -c in the worktree
//     an argv list             run directly, argv[0] the program
//     { cmd, timeoutMs?, covers? }  cmd one of the three above; timeoutMs (a whole number > 0) replaces the default
//                              limit of one run of this suite (qa.json mutants.timeoutMs ?? 900000); covers (rework U8): the
//                              globs of the source files this suite's tests exercise, so a re-verify re-runs a carried test
//                              row of this suite when the fix changes one of them (rounds.mjs); without it a test row is
//                              known only by its own file
//
//   cmdOf(suite) -> the command (string | argv) of any form, or null when it is none of them.
//   suiteProblem(suite) -> string | null   null for a usable suite; else 'not a command, an argv list,
//     'test:<level>' or { cmd, timeoutMs }' | 'timeoutMs must be a whole number of ms above 0' | 'covers must be a list
//     of globs' | '{ cmd, timeoutMs, covers } only, not <key>'.
//   timeoutOf(suite, profile) -> ms   suite.timeoutMs, else profile.mutants.timeoutMs, else DEFAULT_TIMEOUT.
//   commandText(suite) -> string   the command as one line (an argv joined by spaces), '' for none.
//
//   loadSuites({ root, profile }) -> Promise<{ file, suites, errors, legacy, note }>
//     root = the tree (a checkout or a sandbox worktree). file = the suites file read, relative to root (or as
//     profile.mutants.file gives it), or null. suites = { id: suite } as written (object forms kept), only the
//     usable ones. errors: '<file>: suite <id>: <suiteProblem>' per dropped suite; a file that does not parse or
//     import -> ['<file>: <message>'] and suites {}.
//     1. The first of SUITES_FILES that exists: its suites (JSON `suites`, module SUITES; missing -> {}). legacy false.
//     2. None: the mutant registry (profile.mutants.file, else the first of REGISTRY_FILES that exists), when it
//        holds suites (JSON `suites` / module SUITES): those, legacy true, note 'suites read from <file>, their old
//        place: move them to qa/suites.json (or SUITES in qa/suites.ts)'. A registry with no suites -> file null.
//     3. Neither: { file: null, suites: {}, errors: [], legacy: false, note: null }.
//
//   readQaModule(abs) -> Promise<module>   import of a .ts/.mjs file, fresh each time its mtime changes.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUITES_FILES = Object.freeze(['qa/suites.json', 'qa/suites.ts', 'qa/suites.mjs']);
export const REGISTRY_FILES = Object.freeze(['qa/mutants.json', 'qa/mutants.ts', 'qa/mutants.mjs']);
export const DEFAULT_TIMEOUT = 900000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const commandOk = (c) => (typeof c === 'string' ? c.trim().length > 0 : Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === 'string') && c[0].length > 0);

export function cmdOf(suite) {
  const c = isObject(suite) ? suite.cmd : suite;
  return commandOk(c) ? c : null;
}

export function suiteProblem(suite) {
  if (isObject(suite)) {
    const extra = Object.keys(suite).find((k) => !['cmd', 'timeoutMs', 'covers'].includes(k));
    if (extra) return `{ cmd, timeoutMs, covers } only, not ${extra}`;
    if (suite.timeoutMs !== undefined && !(Number.isInteger(suite.timeoutMs) && suite.timeoutMs > 0)) return 'timeoutMs must be a whole number of ms above 0';
    if (suite.covers !== undefined && !(Array.isArray(suite.covers) && suite.covers.every((g) => typeof g === 'string' && g))) return 'covers must be a list of globs';
  }
  return cmdOf(suite) ? null : "not a command, an argv list, 'test:<level>' or { cmd, timeoutMs }";
}

export function timeoutOf(suite, profile) {
  if (isObject(suite) && Number.isInteger(suite.timeoutMs) && suite.timeoutMs > 0) return suite.timeoutMs;
  return profile?.mutants?.timeoutMs ?? DEFAULT_TIMEOUT;
}

export function commandText(suite) {
  const c = cmdOf(suite);
  return c === null ? '' : Array.isArray(c) ? c.join(' ') : c;
}

export async function readQaModule(abs) {
  return import(`${pathToFileURL(abs).href}?v=${fs.statSync(abs).mtimeMs}`);
}

// The suites a file holds: JSON `suites`, a module's SUITES; undefined when it has none.
async function suitesIn(root, rel) {
  const abs = path.resolve(root, rel);
  if (rel.endsWith('.json')) {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (!isObject(data)) throw new Error('not an object with suites');
    return data.suites;
  }
  return (await readQaModule(abs)).SUITES;
}

export async function loadSuites({ root, profile } = {}) {
  const none = { file: null, suites: {}, errors: [], legacy: false, note: null };
  const own = SUITES_FILES.find((f) => fs.existsSync(path.join(root, f)));
  let file = own ?? null;
  let raw;
  let legacy = false;
  try {
    if (own) {
      raw = await suitesIn(root, own);
      if (raw === undefined && own.endsWith('.json')) throw new Error('no "suites" key: write { "suites": { "<id>": <suite> } }');
      raw ??= {};
    }
    else {
      const registry = profile?.mutants?.file ?? REGISTRY_FILES.find((f) => fs.existsSync(path.resolve(root, f)));
      if (!registry || !fs.existsSync(path.resolve(root, registry))) return none;
      file = registry;
      legacy = true;
      raw = await suitesIn(root, registry);
      if (raw === undefined) return none;
    }
    if (!isObject(raw)) throw new Error('suites is not an object');
  } catch (error) {
    return { ...none, file, legacy, errors: [`${file}: ${error.message}`] };
  }
  const suites = {};
  const errors = [];
  for (const [id, suite] of Object.entries(raw)) {
    const problem = suiteProblem(suite);
    if (problem) errors.push(`${file}: suite ${id}: ${problem}`);
    else suites[id] = suite;
  }
  const note = legacy ? `suites read from ${file}, their old place: move them to qa/suites.json (or SUITES in qa/suites.ts)` : null;
  return { file, suites, errors, legacy, note };
}
