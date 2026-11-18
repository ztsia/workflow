// the qa skill (decision 21): qa.json from five answers, plus the qa/ files a project starts with.
// The skill asks the questions; this module turns answers into a profile and writes it. Pure apart
// from writeSetup.
//
// CONTRACT (tests: test/setup.test.mjs)
//
//   QUESTIONS (exported, frozen) — the five, in order, as { key, ask }:
//     stack     'How does the app start? (a Node app built to dist/, a ready-made adapter, or commands for build and serve)'
//     login     'Which roles log in, and how? (a form at a path with env names for user and password, a saved browser state, or by hand once)'
//     base      'What is the before side? (a sandbox of the base commit, or a live URL when there is no local backend)'
//     viewports 'Which screen sizes? (desktop; desktop and phone)'
//     sensitive 'Which paths are sensitive? (auth, payments, migrations… as globs; a fix there always gets a fresh plan)'
//
//   Answers = {
//     stack: { adapter: [name] } | { build: cmd, serve: cmd } | { adapter: [name], build?: cmd },
//     login: { <role>: { mode: 'form', path, user: ENV, password: ENV } | { mode: 'storage-state' }
//                      | { mode: 'manual' } | { mode: 'form', path, from: 'adapter' } },
//     base: 'sandbox' | 'https://…',
//     viewports: 'desktop' | 'desktop+phone',
//     sensitive: [glob] }
//
//   draftProfile(answers, { detected = [] } = {}) -> profile object (what qa.json will hold)
//     { map: 'qa/map', stack: …, login: …, base, viewports, sensitive } where
//       stack = answers.stack; when it has no adapter and detected is non-empty -> adapter = detected;
//       login role form -> { mode: 'form', path, user, password } (from 'env') or { mode: 'form',
//         path, from: 'adapter' }; storage-state/manual -> { mode }; fields/submit/done left to
//         profile defaults;
//       viewports 'desktop' -> { desktop: [1440, 900] }; 'desktop+phone' -> also phone: [390, 844];
//       sensitive = answers.sensitive ?? [].
//     Then validateProfile (profile.mjs) must return no errors, else Error('qa.json would not be
//     valid: <first error>'). An env name that is not /^[A-Z][A-Z0-9_]*$/ -> Error('login <role>:
//     <field> must be an env NAME, not a value') (secrets never go in qa.json).
//
//   writeSetup(root, profile, { force = false, today }) -> { written: [relPath], kept: [relPath] }
//     qa.json (2-space JSON + newline) — exists and !force -> kept, not written;
//     qa/map/ (made when missing) with qa/map/example.json = templates/map.example.json only when
//       qa/map has no .json file; qa/standing.md (templates/standing.md) and qa/escapes.md
//       (templates/escapes.md) only when missing; qa/seed.json = templates/seed.example.json only
//       when missing. Every path relative to root, in that order.
//
//   READY (0.5.0; tests: test/setup.test.mjs 'detectSuites'):
//   detectSuites(root) -> { registry: rel | null, existing: { id: suite }, proposed: [{ id, suite, runner, why }],
//                           note, write: rel }
//     The test suites a project already has, as suites (qa/suites.*) qa can add a reporter to (tests.mjs
//     commandFor). From package.json: a scripts.test that is a plain runner command (no ; & | < > ` or $(, and
//     runnerOf finds vitest, jest, playwright or node --test) is proposed as written, id 'unit' (or 'e2e' for
//     playwright); else each runner in dependencies/devDependencies: vitest -> unit 'npx vitest run', jest -> unit
//     'npx jest' ('jest' when unit is taken), @playwright/test -> e2e 'npx playwright test'. Python: pytest.ini,
//     conftest.py, a pyproject.toml with [tool.pytest or a requirements*.txt naming pytest -> py 'python -m pytest'.
//     A suite already registered (same id or same command) is not proposed again. registry/existing: the
//     project's suites file and its suites (suites.mjs loadSuites: qa/suites.json|.ts|.mjs, else the old SUITES of
//     qa/mutants.*, with its note; a .ts/.mjs is read by import). write = the file `writeSuites` writes:
//     the suites file when it is qa/suites.json, a .ts/.mjs one when the project has that, else 'qa/suites.json'.
//     The skill asks the user to confirm before anything is written.
//
//   writeSuites(root, chosen, { profile = {} } = {}) -> Promise<{ file, added: [id], kept: [id], moved: [id] }>
//     (rework, 2026-11-12; profile: whose mutants.file names the old place, as loadSuites reads it)
//     chosen = { id: suite } (any suites.mjs form; a bad one -> Error('suite <id>: <problem>'), nothing written).
//     Writes qa/suites.json ({ "suites": { … } }, 2-space JSON + newline): the suites already in it, then each
//     chosen id it lacks (added; an id it has is kept as it is). No suites file but SUITES in the old place
//     (qa/mutants.*): those go in too (moved), so the old SUITES can be deleted. A project with qa/suites.ts or
//     .mjs -> Error('<file> is code, so qa does not edit it: add to its SUITES <id>: <json>, …').

// Example: draftProfile({ stack: { adapter: ['supabase-api', 'node-static'], build: 'npm run build' },
//   login: { staff: { mode: 'form', path: '/auth', from: 'adapter' } }, base: 'sandbox',
//   viewports: 'desktop+phone', sensitive: ['supabase/migrations/**'] }) ->
//   { map: 'qa/map', stack: { adapter: ['supabase-api', 'node-static'], build: 'npm run build' },
//     login: { staff: { mode: 'form', path: '/auth', from: 'adapter' } }, base: 'sandbox',
//     viewports: { desktop: [1440, 900], phone: [390, 844] }, sensitive: ['supabase/migrations/**'] }

import fs from 'node:fs';
import path from 'node:path';
import { loadSuites, suiteProblem } from './suites.mjs';
import { validateProfile } from './profile.mjs';
import { runnerOf } from './tests.mjs';

const template = (name) => fs.readFileSync(new URL(`../../templates/${name}`, import.meta.url), 'utf8');
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ desktop: [1440, 900] }),
  'desktop+phone': Object.freeze({ desktop: [1440, 900], phone: [390, 844] }),
});

export const QUESTIONS = Object.freeze([
  Object.freeze({ key: 'stack', ask: 'How does the app start? (a Node app built to dist/, a ready-made adapter, or commands for build and serve)' }),
  Object.freeze({ key: 'login', ask: 'Which roles log in, and how? (a form at a path with env names for user and password, a saved browser state, or by hand once)' }),
  Object.freeze({ key: 'base', ask: 'What is the before side? (a sandbox of the base commit, or a live URL when there is no local backend)' }),
  Object.freeze({ key: 'viewports', ask: 'Which screen sizes? (desktop; desktop and phone)' }),
  Object.freeze({ key: 'sensitive', ask: 'Which paths are sensitive? (auth, payments, migrations… as globs; a fix there always gets a fresh plan)' }),
]);

// The defined keys of an object, so no key is written with an undefined value.
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// One role's login block. Env names are checked here, before validateProfile, so the message names the role.
function draftRole(role, cfg) {
  if (cfg.mode !== 'form') return { mode: cfg.mode };
  // login.mjs reads a form role with a user as 'env' and one without as 'adapter' (its default).
  const from = cfg.from ?? (cfg.user ? 'env' : 'adapter');
  if (from === 'adapter') return defined({ mode: 'form', path: cfg.path, from: 'adapter', account: cfg.account });
  for (const field of ['user', 'password']) {
    if (!ENV_NAME.test(String(cfg[field] ?? ''))) throw new Error(`login ${role}: ${field} must be an env NAME, not a value`);
  }
  return defined({ mode: 'form', path: cfg.path, user: cfg.user, password: cfg.password });
}

export function draftProfile(answers, { detected = [] } = {}) {
  const stack = { ...answers.stack };
  const named = [].concat(stack.adapter ?? []);
  if (named.length === 0 && detected.length > 0) stack.adapter = [...detected];
  const login = {};
  for (const [role, cfg] of Object.entries(answers.login ?? {})) login[role] = draftRole(role, cfg);
  const profile = {
    map: 'qa/map',
    stack,
    login,
    base: answers.base,
    viewports: VIEWPORTS[answers.viewports] ?? answers.viewports,
    sensitive: answers.sensitive ?? [],
  };
  const { errors } = validateProfile(profile);
  if (errors.length) throw new Error(`qa.json would not be valid: ${errors[0]}`);
  return profile;
}

export function writeSetup(root, profile, { force = false } = {}) {
  const written = [];
  const kept = [];
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const put = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    written.push(rel);
  };
  const keepOrPut = (rel, text) => {
    if (exists(rel)) kept.push(rel);
    else put(rel, text);
  };

  if (exists('qa.json') && !force) kept.push('qa.json');
  else put('qa.json', JSON.stringify(profile, null, 2) + '\n');

  // The map example goes in only when qa/map has no .json file of its own.
  const mapDir = path.join(root, 'qa/map');
  const mapHasJson = fs.existsSync(mapDir) && fs.readdirSync(mapDir).some((f) => f.endsWith('.json'));
  if (exists('qa/map/example.json')) kept.push('qa/map/example.json');
  else if (!mapHasJson) put('qa/map/example.json', template('map.example.json'));

  keepOrPut('qa/standing.md', template('standing.md'));
  keepOrPut('qa/escapes.md', template('escapes.md'));
  keepOrPut('qa/seed.json', template('seed.example.json'));
  return { written, kept };
}

const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

export async function detectSuites(root) {
  const loaded = await loadSuites({ root, profile: {} });
  const existing = loaded.file ? loaded.suites : {};
  const proposed = [];
  const taken = new Set(Object.keys(existing));
  const commands = new Set(Object.values(existing).map((s) => {
    const c = s && typeof s === 'object' && !Array.isArray(s) ? s.cmd : s;
    return Array.isArray(c) ? c.join(' ') : String(c);
  }));
  const add = (id, suite, runner, why) => {
    if (commands.has(suite)) return;
    let key = id;
    for (let n = 2; taken.has(key); n++) key = `${id}${n}`;
    taken.add(key);
    commands.add(suite);
    proposed.push({ id: key, suite, runner, why });
  };
  let pkg = null;
  try { pkg = JSON.parse(readText(path.join(root, 'package.json')) ?? 'null'); } catch { pkg = null; }
  if (pkg && typeof pkg === 'object') {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const script = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test.trim() : '';
    const plain = script && !/[;&|<>`]|\$\(/.test(script) ? runnerOf(script) : null;
    if (plain) add(plain === 'playwright' ? 'e2e' : 'unit', script, plain, 'package.json scripts.test');
    if (deps.vitest && plain !== 'vitest') add('unit', 'npx vitest run', 'vitest', 'vitest in package.json');
    if (deps.jest && plain !== 'jest') add(taken.has('unit') ? 'jest' : 'unit', 'npx jest', 'jest', 'jest in package.json');
    if (deps['@playwright/test'] && plain !== 'playwright') add('e2e', 'npx playwright test', 'playwright', '@playwright/test in package.json');
  }
  const pyproject = readText(path.join(root, 'pyproject.toml')) ?? '';
  const requirements = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /^requirements.*\.txt$/.test(f)).map((f) => readText(path.join(root, f)) ?? '').join('\n') : '';
  const py = fs.existsSync(path.join(root, 'pytest.ini')) ? 'pytest.ini'
    : fs.existsSync(path.join(root, 'conftest.py')) ? 'conftest.py'
      : /\[tool\.pytest/.test(pyproject) ? 'pyproject.toml [tool.pytest]'
        : /^pytest\b/m.test(requirements) ? 'pytest in requirements' : null;
  if (py) add('py', 'python -m pytest', 'pytest', py);
  const write = loaded.file && !loaded.legacy ? loaded.file : 'qa/suites.json';
  return { registry: loaded.file, existing, proposed, note: loaded.note, write };
}

export async function writeSuites(root, chosen, { profile = {} } = {}) {
  for (const [id, suite] of Object.entries(chosen ?? {})) {
    const problem = suiteProblem(suite);
    if (problem) throw new Error(`suite ${id}: ${problem}`);
  }
  const loaded = await loadSuites({ root, profile });
  if (loaded.errors.length && !loaded.legacy) throw new Error(loaded.errors[0]);
  if (loaded.file && !loaded.legacy && !loaded.file.endsWith('.json')) {
    const lines = Object.entries(chosen).filter(([id]) => !Object.hasOwn(loaded.suites, id)).map(([id, suite]) => `${id}: ${JSON.stringify(suite)}`);
    throw new Error(`${loaded.file} is code, so qa does not edit it: add to its SUITES ${lines.join(', ') || '(nothing new)'}`);
  }
  const file = 'qa/suites.json';
  const abs = path.join(root, file);
  let data = { suites: {} };
  if (loaded.file === file) data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  data.suites = { ...(data.suites ?? {}) };
  const moved = [];
  if (loaded.legacy) {
    for (const [id, suite] of Object.entries(loaded.suites)) {
      if (Object.hasOwn(data.suites, id)) continue;
      data.suites[id] = suite;
      moved.push(id);
    }
  }
  const added = [];
  const kept = [];
  for (const [id, suite] of Object.entries(chosen ?? {})) {
    if (Object.hasOwn(data.suites, id)) kept.push(id);
    else {
      data.suites[id] = suite;
      added.push(id);
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  return { file, added, kept, moved };
}
