import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from './util.mjs';
import { DEFAULTS, schemaErrors } from './profile.mjs';

// The screen map: how to reach each screen and what to capture there (design decisions 10, 11).
// Recipes of steps per screen (with `role`), named flows, `$seed.*`, `tour`, `modes`, `origin`,
// `sources`, and the JSON Schema schema/map.schema.json (readRepoLayer, validate, STEP_KEYS, STEP_ACTIONS).
//
// Files: <root>/<profile.map>/*.json, read in name order (STEP 7: *.sources.json, the recorded
//   coverage sources, are not map files and are skipped). Each file is either an array of screens
//   (step-1 form) or { "$schema"?, "area"?, "flows"?: { "<name>": [step] }, "screens"?: [screen] }.
//   A screen's `area` is the file's `area` or its basename. Flows are global across files.
// Seed names: <root>/<profile.seedNames> (default qa/seed.json; absolute paths allowed), a JSON
//   object naming seeded records so no id lives in the map:
//     { "candidate": { "alice": { "id": "7f3c…", "name": "Alice Tan" } } }
//
// Screen: { name, role?, flow?, steps?, viewports?, modes?, record?, watch?, tour?,
//           requestOverrides?: [{ url: regex, json }], origin?, sources?: [glob], expectData?, emptyOk? }
//   flow: a flow name walked before `steps`. A screen needs `flow`, non-empty `steps`, or both.
//   role: a key of qa.json `login`: the walk logs in as that role before any step.
//   modes: names from profile.modes (accepted now; walked from step 3).
//   tour: false, true or an options object (max, hover, maxHover, open, skip); capture.mjs runs it.
//   origin: who added it, e.g. "verify:<slug>" (prunable). sources: globs of the screen's source files.
//   expectData / emptyOk (0.5.0, `qa ready`): text or /re/ a seeded row shows on the screen, or true when the
//   empty state is the point of the entry. Read by ready.mjs only; the walk ignores them.
// Step: exactly one action key from STEP_ACTIONS plus modifiers:
//   goto, click, clickAll, fill (+ value), setFiles (+ files), clearStorage, hover, press,
//   waitFor, wait (ms), reload, back, forward, capture (state name; + watch, expandEach),
//   flow (call a flow by name, inline), tour (run the tour here); modifier optional (3 s, failure ignored).
//   Selectors: Playwright's, role + accessible name first (`role=button[name="Save"]`), CSS fallback.
// Built-in flows `login:<role>`: "log in as <role>". Valid only as the very first step after
//   expansion; expansion removes it and sets the screen's role. Flows may not be named `login:*`.
// $seed tokens: in every string inside a step (values, not keys; arrays included), each match of
//   /\$seed\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g is replaced by String(value at that path in
//   the seed names). The value must be a string or a number.
//
// Example (two files' worth; candidates.json):
//   { "area": "candidates",
//     "flows": { "open:candidates": [ { "flow": "login:staff" }, { "goto": "/candidates" },
//                                     { "waitFor": "role=heading[name=\"Candidates\"]" } ] },
//     "screens": [
//       { "name": "candidates-list", "flow": "open:candidates", "steps": [ { "capture": "list" } ] },
//       { "name": "candidate-detail", "flow": "open:candidates",
//         "steps": [ { "click": "role=link[name=\"$seed.candidate.alice.name\"]" }, { "capture": "detail" } ] } ] }
//   expandScreen(candidate-detail) -> { name: 'candidate-detail', role: 'staff', area, file, steps: [
//     { goto: '/candidates', via: 'open:candidates' },
//     { waitFor: 'role=heading[name="Candidates"]', via: 'open:candidates' },
//     { click: 'role=link[name="Alice Tan"]' }, { capture: 'detail' } ] }
//
// CONTRACT (tests: test/map.test.mjs)
//
//   STEP_ACTIONS  = ['goto','click','clickAll','fill','setFiles','clearStorage','hover','press',
//                    'waitFor','wait','reload','back','forward','capture','flow','tour']
//   STEP_KEYS     = STEP_ACTIONS + ['value','files','optional','watch','expandEach']
//   SCREEN_KEYS   = ['name','role','flow','steps','viewports','modes','record','watch','tour',
//                    'requestOverrides','origin','sources','expectData','emptyOk']
//   FILE_KEYS     = ['$schema','area','flows','screens']
//   schema/map.schema.json: $defs.step.properties has exactly STEP_KEYS, $defs.screen.properties
//     exactly SCREEN_KEYS, top-level properties exactly FILE_KEYS; additionalProperties false on all
//     three. Types: every selector/text/name key string (expandEach too: a selector); value string
//     or number; files and clearStorage string or array of strings; wait integer; reload, back,
//     forward, optional, record boolean; tour boolean or object; viewports, modes, sources arrays
//     of strings; requestOverrides array of { url: string, json }; screen requires name.
//
//   class MapError extends Error {}
//
//   loadMap({ root, profile }) -> { screens: [screen & { area, file }], flows: { name: { steps, file } },
//                                   seed: object | null, seedFile: string, files: string[], errors: string[] }
//     Missing map dir -> no screens, no flows, no errors. Bad JSON (map or seed file) ->
//     Error('<basename>: <parse message>'). A file whose `screens` is not an array, or that is
//     neither an array nor an object -> Error('<basename>: expected an array of screens or { "screens": [...] }').
//     Missing seed file -> seed null (seedFile is still the resolved path).
//     errors (file-level, returned not thrown):
//       '<basename>: unknown key "<k>"'                         (a top-level key not in FILE_KEYS)
//       '<basename>: "flows" must be an object of step lists'   (flows not an object, or a value not an array)
//       '<basename>: flow "<name>" is already defined in <other basename>'
//       '<basename>: flow "<name>": login:<role> names are built in'
//
//   OVERLAY (rework U4; tests: test/scope.test.mjs 'overlay'): profile.overlay (an absolute folder, set at run time,
//     overlay.mjs) adds <overlay>/map/*.json on top of the shared map: an overlay screen replaces every shared screen
//     of its name (in the place of the first one), a new name is appended in overlay file order; an overlay flow
//     replaces the shared flow of its name. Its file-level errors read 'overlay <basename>: …'. The result gains
//     overlay: { dir, screens: [names the overlay holds], flows: [names], files: [paths] }; without profile.overlay
//     there is no overlay key and nothing else changes.
//
//   expandScreen(screen, { flows = {}, seed = null, seedFile, profile }) -> screen
//     A deep copy; the input is never changed. Result: no `flow` key; `steps` = the flow chain of
//     screen.flow, then screen.steps, every `{ flow }` step replaced in place by that flow's steps
//     (recursively); every step that came from a flow carries `via: '<innermost flow name>'`;
//     $seed tokens resolved; a leading login:<role> removed and `role` set.
//     Throws MapError with exactly one of:
//       'flow "<name>" is not defined'
//       'flow cycle: a -> b -> a'                 (the names in call order, the repeated one last)
//       'login:<role> must be the first step'
//       'role "<r1>" conflicts with login:<r2>'
//       'login:<role>: no role "<role>" in qa.json login'
//       '$seed.<path>: not in <seedFile basename>'
//       '$seed.<path>: not a string or number'
//       '$seed.<path>: no seed names file (<seedFile basename>)'   (seed is null)
//     seedFile for messages: options.seedFile ?? 'seed.json'.
//
//   validateMap(map, profile) -> { errors: string[], warnings: string[] }
//     map: loadMap's return, or (step-1 form) a bare array of screens (= no flows, no seed).
//     errors = map.errors, then per flow (prefix '<basename> flow "<name>": ') and per screen
//     (prefix '<basename> <screen name>: '):
//       schema, via profile.mjs schemaErrors (it does not follow $ref): each screen minus area,
//         file and steps against $defs.screen -> 'viewports: must be array'; each step against
//         $defs.step -> 'step <n>: wait: must be integer'. Unknown keys are reported once, by the
//         rules below, not also by the schema.
//       unknown screen key "<k>"; unknown step key "<k>" in step <n>; step <n> has no action (…);
//       step <n> has two actions (a, b); step <n> fills with no "value"; invalid regex …;
//       (1.0.3) step <n>: unknown selector engine "<e>" in <key> "<selector>" … — a selector key (click, clickAll, fill,
//       setFiles, hover, waitFor, watch, expandEach) whose '>>' part starts '<e>=' with e not a Playwright engine;
//       needs "flow" or "steps"; unknown role …; unknown viewport …; unknown mode "<m>" (profile has …);
//       defined twice for <viewports> …; and expandScreen's MapError message, if it throws.
//     warnings: '<basename> <screen>: no capture step (captures once at the end)' judged on the
//       EXPANDED steps; '<basename> <screen>: modes are not walked yet' when modes is set;
//       '<basename> flow "<name>": never used'.
//     Step-1 rules and messages are otherwise unchanged.
//     SOURCES (the upgrade from 0.6, the mapper's sources phase; tests: test/upgrade.test.mjs 'map check'): opts =
//     { files = null }: the repo's files (repo-relative, '/'-separated). Given, each `sources` glob (util.glob) of a
//     screen that matches none of them is an error '<basename> <screen>: sources "<glob>" matches no file in the repo'
//     (a glob that matches nothing takes the screen out of every PR's scope as surely as no sources at all).
//     missingSources = 'error' (default) | 'warn' (1.0.4; `map check` without --sources): 'warn' turns that error into a
//     warning '<basename> <screen>: sources "<glob>" matches no file on this branch (…): not walked here' for a shared
//     screen; the overlay's screens (map.overlay.screens) and 'verify:' ones keep the error.
//
//   selectScreens(screens, { only = null, viewport }) -> screens
//     only: comma-separated globs on name (util.glob); viewport: drop screens whose `viewports`
//     excludes it.

// 'foo: unknown key' (a key of the screen or step itself), not 'tour.foo: unknown key'.
const topUnknown = (e) => /^[^.[\s]+: unknown key$/.test(e);

export const STEP_ACTIONS = Object.freeze(['goto', 'click', 'clickAll', 'fill', 'setFiles', 'clearStorage', 'hover', 'press', 'waitFor', 'wait', 'reload', 'back', 'forward', 'capture', 'flow', 'tour']);
export const STEP_KEYS = Object.freeze([...STEP_ACTIONS, 'value', 'files', 'optional', 'watch', 'expandEach']);
export const SCREEN_KEYS = Object.freeze(['name', 'role', 'flow', 'steps', 'viewports', 'modes', 'record', 'watch', 'tour', 'requestOverrides', 'origin', 'sources', 'expectData', 'emptyOk']);
export const FILE_KEYS = Object.freeze(['$schema', 'area', 'flows', 'screens']);

export class MapError extends Error {}

const SCHEMA = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../schema/map.schema.json', import.meta.url)), 'utf8'));
const SCREEN_SCHEMA = SCHEMA.$defs.screen;
const STEP_SCHEMA = SCHEMA.$defs.step;

const STEP_KEY_SET = new Set(STEP_KEYS);
// Selector-holding step keys, and the Playwright engines a 'name=' prefix may name (1.0.3: 'label=…' passed map check
// and failed only in the run). 'internal:…' engines are Playwright's own and pass.
const SELECTOR_KEYS = Object.freeze(['click', 'clickAll', 'fill', 'setFiles', 'hover', 'waitFor', 'watch', 'expandEach']);
const SELECTOR_ENGINES = new Set(['css', 'xpath', 'text', 'id', 'data-testid', 'data-test-id', 'data-test', 'role', 'nth', 'visible']);
const SCREEN_KEY_SET = new Set(SCREEN_KEYS);
const FILE_KEY_SET = new Set(FILE_KEYS);
// Added by loadMap; not screen keys in the file, so validateMap ignores them.
const LOADED_KEYS = new Set(['area', 'file']);
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];
const LOGIN = 'login:';
// Global, so every $seed token in a string is replaced.
const SEED_TOKEN = /\$seed\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g;

const isStep = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A flow is loadMap's { steps, file }, or a plain array of steps.
function flowSteps(flow) {
  if (Array.isArray(flow)) return flow;
  return Array.isArray(flow?.steps) ? flow.steps : null;
}

function seedText(p, { seed, seedName }) {
  if (seed === null || seed === undefined) throw new MapError(`$seed.${p}: no seed names file (${seedName})`);
  let cur = seed;
  for (const key of p.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) throw new MapError(`$seed.${p}: not in ${seedName}`);
    cur = cur[key];
  }
  if (typeof cur !== 'string' && typeof cur !== 'number') throw new MapError(`$seed.${p}: not a string or number`);
  return String(cur);
}

// Replaces $seed tokens in every string of a value; arrays are walked, objects are left alone.
function resolveSeeds(value, ctx) {
  if (typeof value === 'string') return value.replace(SEED_TOKEN, (_, p) => seedText(p, ctx));
  if (Array.isArray(value)) return value.map((v) => resolveSeeds(v, ctx));
  return value;
}

// STEP 6 (routes.mjs): $seed tokens in every string of a value, objects and arrays walked; the
// value is copied, never changed. Same errors as a map entry (MapError naming the token).
export function resolveSeedsDeep(value, { seed = null, seedName = 'qa/seed.json' } = {}) {
  const ctx = { seed, seedName };
  const walk = (v) => {
    if (typeof v === 'string' || Array.isArray(v)) return Array.isArray(v) ? v.map(walk) : resolveSeeds(v, ctx);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

export function expandScreen(screen, { flows = {}, seed = null, seedFile, profile } = {}) {
  const ctx = {
    flows: flows ?? {},
    seed: seed ?? null,
    seedName: path.basename(seedFile ?? 'seed.json'),
    roles: Object.keys(profile?.login ?? {}),
  };

  // A login:<role> step stays as a marker ({ flow: 'login:<role>' }) until the whole list is known,
  // because only the first step of the final list may be one.
  const expandList = (steps, stack) => {
    const out = [];
    for (const step of steps) {
      if (!isStep(step)) continue; // validateMap reports these
      if (step.flow !== undefined) {
        const name = String(step.flow);
        if (name.startsWith(LOGIN)) {
          const role = name.slice(LOGIN.length);
          if (!ctx.roles.includes(role)) throw new MapError(`${name}: no role "${role}" in qa.json login`);
          out.push({ flow: name });
          continue;
        }
        const body = Object.hasOwn(ctx.flows, name) ? flowSteps(ctx.flows[name]) : null;
        if (!body) throw new MapError(`flow "${name}" is not defined`);
        if (stack.includes(name)) throw new MapError(`flow cycle: ${[...stack, name].join(' -> ')}`);
        const inner = expandList(body, [...stack, name]);
        // A step that came from a nested flow keeps the inner name; only unlabelled steps take this one.
        for (const st of inner) if (st.flow === undefined && st.via === undefined) st.via = name;
        out.push(...inner);
        continue;
      }
      const copy = structuredClone(step);
      for (const key of Object.keys(copy)) copy[key] = resolveSeeds(copy[key], ctx);
      out.push(copy);
    }
    return out;
  };

  const top = [
    ...(screen.flow !== undefined ? [{ flow: screen.flow }] : []),
    ...(Array.isArray(screen.steps) ? screen.steps : []),
  ];
  const steps = expandList(top, []);
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].flow !== undefined) throw new MapError(`${steps[i].flow} must be the first step`);
  }

  let role = screen.role;
  if (steps[0]?.flow !== undefined) {
    const login = steps.shift().flow;
    if (role !== undefined && role !== login.slice(LOGIN.length)) throw new MapError(`role "${role}" conflicts with ${login}`);
    role = login.slice(LOGIN.length);
  }

  const out = structuredClone(screen);
  delete out.flow;
  out.steps = steps;
  if (role !== undefined) out.role = role;
  return out;
}

function readSeed(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${path.basename(file)}: ${err.message}`);
  }
}

export function loadMap({ root, profile }) {
  const dir = path.resolve(root, profile.map);
  const seedFile = path.resolve(root, profile.seedNames ?? DEFAULTS.seedNames);
  const seed = readSeed(seedFile);
  const shared = readMapDir(dir);
  const out = { screens: shared.screens, flows: shared.flows, seed, seedFile, files: shared.files, errors: shared.errors };
  if (typeof profile.overlay !== 'string' || !profile.overlay) return out;
  return withOverlay(out, readMapDir(path.join(profile.overlay, 'map'), 'overlay '), profile.overlay);
}

// Every map file of one directory: screens (with area and file), flows ({ steps, file }), files, errors. A missing
// directory is empty. `label` prefixes the file-level errors ('overlay ' for the PR's overlay).
function readMapDir(dir, label = '') {
  const flows = {};
  if (!fs.existsSync(dir)) return { screens: [], flows, files: [], errors: [] };
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json') && !d.name.endsWith('.sources.json'))
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(dir, name));
  const screens = [];
  const errors = [];
  for (const file of files) {
    const base = `${label}${path.basename(file)}`;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${base}: ${err.message}`);
    }
    const list = Array.isArray(data) ? data : data?.screens;
    if (!Array.isArray(list)) throw new Error(`${base}: expected an array of screens or { "screens": [...] }`);
    const obj = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const area = obj && typeof obj.area === 'string' ? obj.area : path.basename(file, '.json');
    if (obj) {
      for (const k of Object.keys(obj)) if (!FILE_KEY_SET.has(k)) errors.push(`${base}: unknown key "${k}"`);
      if (obj.flows !== undefined) {
        let malformed = obj.flows === null || typeof obj.flows !== 'object' || Array.isArray(obj.flows);
        for (const [name, steps] of malformed ? [] : Object.entries(obj.flows)) {
          if (!Array.isArray(steps)) malformed = true;
          else if (name.startsWith(LOGIN)) errors.push(`${base}: flow "${name}": login:<role> names are built in`);
          else if (Object.hasOwn(flows, name)) errors.push(`${base}: flow "${name}" is already defined in ${label}${path.basename(flows[name].file)}`);
          else Object.defineProperty(flows, name, { value: { steps, file }, enumerable: true, writable: true, configurable: true });
        }
        if (malformed) errors.push(`${base}: "flows" must be an object of step lists`);
      }
    }
    for (const s of list) screens.push({ ...(s !== null && typeof s === 'object' && !Array.isArray(s) ? s : {}), area, file });
  }
  return { screens, flows, files, errors };
}

// The shared map with the PR's overlay on top (OVERLAY): an overlay screen replaces every shared screen of its name
// (in the place of the first one), a new name is appended; an overlay flow replaces the shared flow of its name.
function withOverlay(shared, over, dir) {
  const names = [...new Set(over.screens.map((s) => s.name).filter((n) => typeof n === 'string'))];
  const byName = new Map(names.map((n) => [n, over.screens.filter((s) => s.name === n)]));
  const screens = [];
  const placed = new Set();
  for (const s of shared.screens) {
    if (!byName.has(s.name)) { screens.push(s); continue; }
    if (placed.has(s.name)) continue;
    placed.add(s.name);
    screens.push(...byName.get(s.name));
  }
  for (const n of names) if (!placed.has(n)) screens.push(...byName.get(n));
  screens.push(...over.screens.filter((s) => typeof s.name !== 'string'));
  const flows = { ...shared.flows };
  for (const [name, flow] of Object.entries(over.flows)) Object.defineProperty(flows, name, { value: flow, enumerable: true, writable: true, configurable: true });
  return {
    ...shared, screens, flows, files: [...shared.files, ...over.files], errors: [...shared.errors, ...over.errors],
    overlay: { dir, screens: names, flows: Object.keys(over.flows), files: over.files },
  };
}

export function validateMap(map, profile, { files = null, missingSources = 'error' } = {}) {
  const ownNames = new Set(Array.isArray(map?.overlay?.screens) ? map.overlay.screens : []);
  const m = Array.isArray(map) ? { screens: map, flows: {}, seed: null, errors: [] } : map;
  const screens = m.screens ?? [];
  const flows = m.flows ?? {};
  const errors = [...(m.errors ?? [])];
  const warnings = [];
  const viewports = Object.keys(profile?.viewports ?? {});
  const roles = Object.keys(profile?.login ?? {});
  const modes = profile?.modes ?? DEFAULTS.modes;
  const seen = new Map(); // name -> viewports of each earlier screen with that name
  const list = (v) => (Array.isArray(v) ? v : []);
  const regexError = (p) => {
    try {
      new RegExp(p);
      return null;
    } catch (e) {
      return e.message;
    }
  };

  // The step rules, shared by screens and flows. err(what) adds the owner's prefix.
  const selectorProblem = (sel) => {
    for (const part of String(sel).split('>>')) {
      const m = /^\s*([A-Za-z][\w-]*)=/.exec(part);
      if (m && !SELECTOR_ENGINES.has(m[1]) && !m[1].startsWith('internal')) return m[1];
    }
    return null;
  };
  const checkSteps = (steps, err) => {
    for (const [j, step] of steps.entries()) {
      const n = j + 1;
      if (!isStep(step)) {
        err(`step ${n} is not an object`);
        continue;
      }
      for (const e of schemaErrors(step, STEP_SCHEMA)) if (!topUnknown(e)) err(`step ${n}: ${e}`);
      for (const k of Object.keys(step)) if (!STEP_KEY_SET.has(k)) err(`unknown step key "${k}" in step ${n}`);
      const actions = STEP_ACTIONS.filter((a) => step[a] !== undefined);
      if (actions.length === 0) err(`step ${n} has no action (${STEP_ACTIONS.join(', ')})`);
      else if (actions.length > 1) err(`step ${n} has ${WORDS[actions.length] ?? actions.length} actions (${actions.join(', ')})`);
      if (step.fill !== undefined && step.value === undefined) err(`step ${n} fills with no "value"`);
      for (const k of SELECTOR_KEYS) {
        const engine = typeof step[k] === 'string' ? selectorProblem(step[k]) : null;
        if (engine) err(`step ${n}: unknown selector engine "${engine}" in ${k} "${step[k]}" — the browser has none; use role=<role>[name="…"] or a CSS attribute`);
      }
      // A string is a regex; an array holds exact key names, so only the string form is compiled.
      if (typeof step.clearStorage === 'string') {
        const bad = regexError(step.clearStorage);
        if (bad) err(`invalid regex "${step.clearStorage}" in step ${n} clearStorage: ${bad}`);
      }
    }
  };

  const flowWhere = (name, flow) => `${flow?.file ? path.basename(flow.file) : '?'} flow "${name}"`;
  for (const [name, flow] of Object.entries(flows)) {
    const steps = flowSteps(flow);
    if (steps) checkSteps(steps, (what) => errors.push(`${flowWhere(name, flow)}: ${what}`));
  }

  // A flow is used when a screen reaches it, directly or through another used flow.
  const flowRefs = (steps) =>
    steps.filter(isStep).map((st) => st.flow).filter((f) => typeof f === 'string' && !f.startsWith(LOGIN));
  const reached = new Set();
  const pending = screens.flatMap((s) => [...(typeof s.flow === 'string' ? [s.flow] : []), ...flowRefs(list(s.steps))]);
  while (pending.length) {
    const name = pending.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    const steps = Object.hasOwn(flows, name) ? flowSteps(flows[name]) : null;
    if (steps) pending.push(...flowRefs(steps));
  }
  for (const [name, flow] of Object.entries(flows)) {
    if (flowSteps(flow) && !reached.has(name)) warnings.push(`${flowWhere(name, flow)}: never used`);
  }

  for (const [i, s] of screens.entries()) {
    const name = typeof s.name === 'string' && s.name ? s.name : null;
    const where = `${s.file ? path.basename(s.file) : '?'} ${name ?? `screen #${i + 1}`}`;
    const err = (what) => errors.push(`${where}: ${what}`);

    if (!name) err('missing "name"');
    // area, file and steps are not checked against $defs.screen; the steps are checked one by one below.
    const body = { ...s };
    delete body.area;
    delete body.file;
    delete body.steps;
    // "name: missing required key" is the missing "name" rule above; unknown TOP-LEVEL keys are
    // reported below; a nested one (tour.bogus) only the schema sees.
    for (const e of schemaErrors(body, SCREEN_SCHEMA)) if (!topUnknown(e) && e !== 'name: missing required key') err(e);
    if (s.steps !== undefined && !Array.isArray(s.steps)) err('steps: must be array');
    if (s.flow === undefined && !list(s.steps).length) err('needs "flow" or "steps"');
    for (const k of Object.keys(s)) if (!SCREEN_KEY_SET.has(k) && !LOADED_KEYS.has(k)) err(`unknown screen key "${k}"`);
    if (s.role !== undefined && !roles.includes(s.role)) err(`unknown role "${s.role}" (profile login has ${roles.join(', ') || 'none'})`);
    for (const v of list(s.viewports)) if (!viewports.includes(v)) err(`unknown viewport "${v}" (profile has ${viewports.join(', ')})`);

    // The same name twice is fine only when the viewports do not overlap (a desktop and a phone variant).
    const mine = Array.isArray(s.viewports) ? s.viewports : viewports;
    if (name) {
      for (const other of seen.get(name) ?? []) {
        const overlap = mine.filter((v) => other.includes(v));
        if (overlap.length) err(`defined twice for ${overlap.join(', ')}: rename one, or limit each with "viewports"`);
      }
      seen.set(name, [...(seen.get(name) ?? []), mine]);
    }

    checkSteps(list(s.steps), err);

    for (const o of list(s.requestOverrides)) {
      if (typeof o?.url !== 'string') continue;
      const bad = regexError(o.url);
      if (bad) err(`invalid regex "${o.url}" in requestOverrides url: ${bad}`);
    }

    if (Array.isArray(files)) {
      for (const g of list(s.sources)) {
        if (typeof g !== 'string') continue;
        const re = glob(g);
        if (files.some((f) => re.test(f))) continue;
        // 1.0.4: a shared screen whose files live on another line of work (CRM: entries promoted from a PR on one
        // integration branch, read by a PR on another) is a warning outside the sources phase; the PR's own entries
        // (its overlay, the verifier's 'verify:' ones) and the sources phase keep it an error.
        const own = ownNames.has(s.name) || (typeof s.origin === 'string' && s.origin.startsWith('verify:'));
        if (missingSources === 'error' || own) err(`sources "${g}" matches no file in the repo`);
        else warnings.push(`${where}: sources "${g}" matches no file on this branch (a screen of another branch's work, or a stale glob): not walked here`);
      }
    }

    for (const mo of list(s.modes)) if (!modes.includes(mo)) err(`unknown mode "${mo}" (profile has ${modes.join(', ')})`);
    if (s.modes !== undefined) warnings.push(`${where}: modes are not walked yet`);

    try {
      const full = expandScreen(s, { flows, seed: m.seed ?? null, seedFile: m.seedFile, profile });
      if (full.steps.length && !full.steps.some((st) => st.capture !== undefined)) {
        warnings.push(`${where}: no capture step (captures once at the end)`);
      }
    } catch (e) {
      if (!(e instanceof MapError)) throw e;
      err(e.message);
    }
  }
  return { errors, warnings };
}

export function selectScreens(screens, { only = null, viewport } = {}) {
  const globs = only ? only.split(',').map((p) => p.trim()).filter(Boolean).map(glob) : [];
  return screens.filter((s) => {
    if (globs.length && !globs.some((re) => re.test(s.name ?? ''))) return false;
    if (viewport && Array.isArray(s.viewports) && !s.viewports.includes(viewport)) return false;
    return true;
  });
}
