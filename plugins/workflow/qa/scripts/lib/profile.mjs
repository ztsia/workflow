// The project's QA profile: one committed `qa.json` at the repo root (design decision 21).
// Secrets never live in it: every credential is an environment variable NAME. The schema is
// schema/qa.schema.json; validation here is a small hand-written subset of JSON Schema
// (type, required, properties, additionalProperties, enum, items, pattern, minItems, maxItems),
// so the engine needs no dependency.
//
// CONTRACT (tests: test/profile.test.mjs)
//
//   PROFILE_FILE = 'qa.json'
//
//   DEFAULTS — merged under the file (objects deep-merged, arrays replaced):
//     { map: 'qa/map', seedNames: 'qa/seed.json', base: 'sandbox', viewports: { desktop: [1440, 900] }, modes: ['light'],
//       ports: { band: [8010, 8030], reserved: [], extra: [] }, sandbox: { max: 3, retryWaitMs: 15000 },
//       run: { cacheKeep: 5 }, workers: 1, browser: { channel: 'chrome' },
//       stack: { adapter: [], healthPath: '/', healthTimeoutMs: 120000, settings: {} },
//       settle: { timeoutMs: 10000, quietMs: 500, hidden: null }, stepTimeoutMs: 20000,
//       maxElementsPerCapture: 80, watch: null, palette: {}, writes: { scope: null, allow: [], block: false },
//       ignoreErrors: [], login: {}, sensitive: [], security: [], limits: {},
//       eyes: { questions: [] }, plan: { maxMatches: 20 }, stubs: {}, agents: AGENT_DEFAULTS }   (eyes.questions: the
//       project's own eyes-pass questions, step 5; plan.maxMatches: the bound of `qa plan check`, rework U6; stubs:
//       rung 3, below; agents: the headless sessions `qa verify` starts, rework U10, design §14)
//     AGENT_DEFAULTS = { mapper: { model: 'haiku', timeoutMs: 1200000 }, planner: { model: 'sonnet', timeoutMs: 1800000 },
//       security: { model: 'sonnet', timeoutMs: 1200000 }, eyes: { model: 'opus', timeoutMs: 1800000 },
//       judge: { model: 'sonnet', timeoutMs: 1200000 } }   (qa.json agents.<role>.model / .timeoutMs override key by key)
//     (1.0.0) ports.extra: offsets of the ports the app opens beside its own, reserved per sandbox (sandbox.mjs).
//
//   mainRoot(cwd = process.cwd()) -> string
//     The MAIN checkout's root (parent of `git rev-parse --git-common-dir`), so a linked worktree
//     (a sandbox) resolves to the tree that owns `qa-artifacts/`. Throws Error('not a git repository').
//
//   repoRoot(cwd = process.cwd()) -> string
//     `git rev-parse --show-toplevel` of cwd. Throws Error('not a git repository').
//
//   validateProfile(obj, schema = loadSchema()) -> { errors: string[], warnings: string[] }
//     errors: schema violations as '<json.path>: <what>' e.g. 'stack.adapter: must be string or array'.
//     Extra rules beyond the schema (errors, not warnings). ENV NAME = /^[A-Z][A-Z0-9_]*$/.
//       a. login.<role>.user and login.<role>.password, when present, must be ENV NAMEs:
//          user -> 'login.staff.user: must be an environment variable name like QA_HR_EMAIL';
//          password -> 'login.staff.password: secrets go in env names, never qa.json'.
//       b. anywhere else in the file, a key matching /password|token|secret/i holding a string
//          that is not an ENV NAME is an error 'stack.settings.token: secrets go in env names, never qa.json'.
//          Exempt: everything under login.<role>.fields (those are CSS selectors).
//       c. (rework, design §6.1 rung 3; tests: test/stubs.test.mjs) stubs: { <id>: { for, env: { NAME: value } } }.
//          An id that is not a plain name -> 'stubs.<id>: a stub id is a plain name (letters, digits, . _ -)'; an empty
//          env -> 'stubs.<id>.env: needs at least one switch ({ "NAME": "value" })'; an env key that is not an ENV
//          NAME -> 'stubs.<id>.env.<k>: must be an environment variable name like QA_LLM_MODE'; an env NAME for which
//          looksSecret is true -> "stubs.<id>.env.<NAME>: looks like a secret's name — a stub sets a switch, never a
//          credential (secrets never go in qa.json)", whatever its value.
//       d. (rework U10; tests: test/profile.test.mjs 'agents') agents.<role>.timeoutMs below 60000 ->
//          'agents.<role>.timeoutMs: at least 60000 (one minute): a headless agent needs minutes'.
//     So { login: { staff: { password: 'QA_HR_PASSWORD', fields: { password: 'input[type=password]' } } } }
//     has zero errors and { login: { staff: { password: 'hunter2' } } } has one.
//
//   looksSecret(name) -> boolean   the secret guard of rule b (a name matching /password|token|secret/i), widened for
//     env names: a '_'-separated word of the name is KEY, KEYS, APIKEY, PASS, PASSWD, PWD, CREDENTIAL(S), COOKIE,
//     BEARER or DSN (OPENAI_API_KEY, DB_PASS, SENTRY_DSN), case-insensitive. QA_LLM_MODE, FEATURE_KEYBOARD: false.
//
//   loadProfile(root = repoRoot()) -> { profile, path, errors, warnings }
//     Reads <root>/qa.json, merges DEFAULTS, normalises stack.adapter to an array of names
//     ('node-static' -> ['node-static']). Missing file: throws ProfileError code 'NO_PROFILE'.
//     Invalid JSON: ProfileError code 'BAD_JSON'. Schema errors are RETURNED, not thrown;
//     callers that need a valid profile call requireProfile().
//
//   requireProfile(root) -> profile   (throws ProfileError code 'INVALID' listing every error)
//
//   loadSchema() -> object            (schema/qa.schema.json, parsed)
//
//   schemaErrors(value, schema) -> string[]
//     The same JSON Schema subset, for any schema (map.mjs checks screens and steps with it).
//     Paths are relative to value: 'viewports: must be array', 'steps[2].wait: must be integer';
//     a wrong-typed root is '(root): must be object'.
//
//   class ProfileError extends Error { code }
//
// Example qa.json (a Supabase API, dist served statically):
//   { "stack": { "adapter": ["supabase-api", "node-static"], "build": "npm run build" },
//     "login": { "staff": { "mode": "form", "path": "/auth", "from": "adapter",
//                        "fields": { "email": "input[type=email]", "password": "input[type=password]" },
//                        "submit": "button[type=submit]", "done": { "urlNot": "/auth" } } },
//     "viewports": { "desktop": [1440, 900], "phone": [390, 844] },
//     "ports": { "band": [8010, 8030], "reserved": [8090] } }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitOne } from './util.mjs';

export const PROFILE_FILE = 'qa.json';

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SECRET_KEY = /password|token|secret/i;
const SECRET_WORDS = new Set(['KEY', 'KEYS', 'APIKEY', 'PASS', 'PASSWD', 'PWD', 'CREDENTIAL', 'CREDENTIALS', 'COOKIE', 'BEARER', 'DSN']);
const STUB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The name of something a secret lives in: the rule-b words, or a word of an env name that names a key or credential.
export function looksSecret(name) {
  const s = String(name ?? '');
  return SECRET_KEY.test(s) || s.split(/[_\W]+/).some((w) => SECRET_WORDS.has(w.toUpperCase()));
}
const SCHEMA_FILE = fileURLToPath(new URL('../../schema/qa.schema.json', import.meta.url));

export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The headless sessions of `qa verify` (design §14): the model of each role and how long one call may take.
export const AGENT_DEFAULTS = Object.freeze({
  mapper: Object.freeze({ model: 'haiku', timeoutMs: 1200000 }),
  planner: Object.freeze({ model: 'sonnet', timeoutMs: 1800000 }),
  security: Object.freeze({ model: 'sonnet', timeoutMs: 1200000 }),
  eyes: Object.freeze({ model: 'opus', timeoutMs: 1800000 }),
  judge: Object.freeze({ model: 'sonnet', timeoutMs: 1200000 }),
});
const AGENT_MIN_MS = 60000;

export const DEFAULTS = Object.freeze({
  map: 'qa/map',
  seedNames: 'qa/seed.json',
  base: 'sandbox',
  viewports: { desktop: [1440, 900] },
  modes: ['light'],
  ports: { band: [8010, 8030], reserved: [], extra: [] },
  sandbox: { max: 3, retryWaitMs: 15000 },
  run: { cacheKeep: 5 },
  workers: 1,
  browser: { channel: 'chrome' },
  stack: { adapter: [], healthPath: '/', healthTimeoutMs: 120000, settings: {} },
  settle: { timeoutMs: 10000, quietMs: 500, hidden: null },
  clock: 'seed',
  volatile: [],
  checks: { enabled: true, touchBelow: 768, keyboardHeight: 508 },
  tour: { enabled: true, max: 30, hover: true, maxHover: 40, open: [], skip: [] },
  stepTimeoutMs: 20000,
  maxElementsPerCapture: 80,
  watch: null,
  palette: {},
  writes: { scope: null, allow: [], block: false },
  ignoreErrors: [],
  login: {},
  sensitive: [],
  security: [],
  limits: {},
  eyes: { questions: [] },
  routes: { enabled: true, table: null, base: null, origin: false, headers: {}, timeoutMs: 15000 },
  mutants: { file: null, timeoutMs: 900000 },
  plan: { maxMatches: 20 },
  stubs: {},
  agents: AGENT_DEFAULTS,
});

// The MAIN checkout, so a sandbox (a linked worktree) reads the qa.json of the tree that owns it.
// --git-common-dir may print relative to cwd, hence the resolve.
export function mainRoot(cwd = process.cwd()) {
  const common = gitOne(['rev-parse', '--git-common-dir'], { cwd });
  if (!common) throw new Error('not a git repository');
  return path.dirname(path.resolve(cwd, common));
}

export function repoRoot(cwd = process.cwd()) {
  const top = gitOne(['rev-parse', '--show-toplevel'], { cwd });
  if (!top) throw new Error('not a git repository');
  return top;
}

export function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

// Schema errors first, then the secret rules. De-duplicated because rule a and rule b both
// flag login.<role>.password with the same text.
export function validateProfile(obj, schema = loadSchema()) {
  const errors = [];
  check(obj, schema, [], errors);
  checkSecrets(obj, [], errors);
  checkStubs(obj?.stubs, errors);
  checkAgents(obj?.agents, errors);
  return { errors: [...new Set(errors)], warnings: [] };
}

export function loadProfile(root = repoRoot()) {
  const file = path.join(root, PROFILE_FILE);
  if (!fs.existsSync(file)) throw new ProfileError('NO_PROFILE', `${file} not found: a project needs a ${PROFILE_FILE} at its root`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ProfileError('BAD_JSON', `${file}: ${err.message}`);
  }
  const { errors, warnings } = validateProfile(raw);
  // A file that is not an object is already reported by validateProfile; merge nothing from it.
  const profile = merge(DEFAULTS, isObject(raw) ? raw : {});
  // One adapter may be written as a bare name; everything downstream takes an array.
  if (isObject(profile.stack) && typeof profile.stack.adapter === 'string') profile.stack.adapter = [profile.stack.adapter];
  return { profile, path: file, errors, warnings };
}

export function requireProfile(root = repoRoot()) {
  const { profile, errors } = loadProfile(root);
  if (errors.length) throw new ProfileError('INVALID', `${PROFILE_FILE} is invalid:\n  ${errors.join('\n  ')}`);
  return profile;
}

export function schemaErrors(value, schema) {
  const errors = [];
  check(value, schema, [], errors);
  return errors;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Objects merge key by key; arrays, scalars and null in the file replace the default.
function merge(base, over) {
  if (over === undefined) return structuredClone(base);
  if (!isObject(base) || !isObject(over)) return structuredClone(over);
  const out = structuredClone(base);
  for (const key of Object.keys(over)) out[key] = merge(base[key], over[key]);
  return out;
}

// 'stack.adapter', 'viewports.phone', 'ports.band[0]'. Segments are keys (strings) or indexes (numbers).
function pathOf(segs) {
  const p = segs.reduce((acc, s) => (typeof s === 'number' ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), '');
  return p || '(root)';
}

function isType(v, t) {
  switch (t) {
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObject(v);
    case 'integer':
      return Number.isInteger(v);
    default:
      return typeof v === t; // string, number, boolean
  }
}

// The subset of JSON Schema this file reads. A type mismatch ends that branch, so the children
// of a wrong-typed value are not also reported.
function check(value, schema, segs, errors) {
  const at = pathOf(segs);
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some((t) => isType(value, t))) {
      errors.push(`${at}: must be ${types.join(' or ')}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: must match ${schema.pattern}`);
  if (Array.isArray(value)) checkArray(value, schema, segs, errors);
  else if (isObject(value)) checkObject(value, schema, segs, errors);
}

function checkArray(arr, schema, segs, errors) {
  const at = pathOf(segs);
  if (schema.minItems !== undefined && arr.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`);
  if (schema.maxItems !== undefined && arr.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`);
  if (schema.items) arr.forEach((item, i) => check(item, schema.items, [...segs, i], errors));
}

function checkObject(obj, schema, segs, errors) {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(obj, key)) errors.push(`${pathOf([...segs, key])}: missing required key`);
  }
  const props = schema.properties ?? {};
  for (const [key, value] of Object.entries(obj)) {
    const sub = [...segs, key];
    if (Object.hasOwn(props, key)) check(value, props[key], sub, errors);
    else if (schema.additionalProperties === false) errors.push(`${pathOf(sub)}: unknown key`);
    else if (isObject(schema.additionalProperties)) check(value, schema.additionalProperties, sub, errors);
  }
}

// Rule a: login.<role>.user is an env name. Rule b: any other string under a password, token or
// secret key is an env name too. login.<role>.fields holds CSS selectors, so it is not walked.
function checkSecrets(node, segs, errors) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => checkSecrets(item, [...segs, i], errors));
    return;
  }
  if (!isObject(node)) return;
  const inRole = segs.length === 2 && segs[0] === 'login';
  for (const [key, value] of Object.entries(node)) {
    if (inRole && key === 'fields') continue;
    const sub = [...segs, key];
    if (typeof value === 'string' && !ENV_NAME.test(value)) {
      if (inRole && key === 'user') errors.push(`${pathOf(sub)}: must be an environment variable name like QA_HR_EMAIL`);
      else if (SECRET_KEY.test(key)) errors.push(`${pathOf(sub)}: secrets go in env names, never qa.json`);
    }
    checkSecrets(value, sub, errors);
  }
}

// Rule c: a stub is a switch (its env names), never a credential. The schema checks the shape; this checks the names.
function checkStubs(stubs, errors) {
  if (!isObject(stubs)) return;
  for (const [id, stub] of Object.entries(stubs)) {
    if (!STUB_ID.test(id)) errors.push(`stubs.${id}: a stub id is a plain name (letters, digits, . _ -)`);
    if (!isObject(stub) || !isObject(stub.env)) continue;
    if (!Object.keys(stub.env).length) errors.push(`stubs.${id}.env: needs at least one switch ({ "NAME": "value" })`);
    for (const name of Object.keys(stub.env)) {
      if (!ENV_NAME.test(name)) errors.push(`stubs.${id}.env.${name}: must be an environment variable name like QA_LLM_MODE`);
      else if (looksSecret(name)) errors.push(`stubs.${id}.env.${name}: looks like a secret's name — a stub sets a switch, never a credential (secrets never go in qa.json)`);
    }
  }
}

// Rule d: a headless agent works for minutes; a timeout under one minute only ever kills it.
function checkAgents(agents, errors) {
  if (!isObject(agents)) return;
  for (const [role, a] of Object.entries(agents)) {
    if (isObject(a) && Number.isInteger(a.timeoutMs) && a.timeoutMs < AGENT_MIN_MS) {
      errors.push(`agents.${role}.timeoutMs: at least ${AGENT_MIN_MS} (one minute): a headless agent needs minutes`);
    }
  }
}
