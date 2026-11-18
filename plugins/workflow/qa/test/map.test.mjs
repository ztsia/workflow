// Contract tests for scripts/lib/map.mjs (the CONTRACT comment at the top of that file is the spec).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { expandScreen, FILE_KEYS, loadMap, MapError, SCREEN_KEYS, selectScreens, STEP_ACTIONS, STEP_KEYS, validateMap } from '../scripts/lib/map.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-map-'));
  made.push(dir);
  return dir;
}

// Writes qa/map/<name> under root; an object is serialised, a string is written as-is.
function writeMap(root, name, content) {
  const dir = path.join(root, 'qa', 'map');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
}

// Returns what fn threw. A stub's 'not built: …' error is rethrown so the failure names the missing function.
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    if (String(err.message).startsWith('not built')) throw err;
    return err;
  }
  assert.fail('expected a throw');
}

const profile = {
  map: 'qa/map',
  seedNames: 'qa/seed.json',
  viewports: { desktop: [1440, 900], phone: [390, 844] },
  login: { staff: { mode: 'form' } },
};

const FILE = 'a.json';
const AREA = 'a';
const S = [{ goto: '/' }, { capture: 'home' }];

describe('map: loadMap', () => {
  it('a root with no qa/map directory loads as no screens and no files', () => {
    const root = tempDir();
    assert.deepEqual(loadMap({ root, profile }), {
      screens: [],
      flows: {},
      seed: null,
      seedFile: path.join(root, 'qa', 'seed.json'),
      files: [],
      errors: [],
    });
  });

  it('files load in name order; screens carry area and file; a bare array takes its basename as area', () => {
    const root = tempDir();
    // b.json is written first, so the order must come from the names, not creation order.
    writeMap(root, 'b.json', [{ name: 'b-one', steps: [{ goto: '/b' }, { capture: 'b-one' }] }]);
    writeMap(root, 'a.json', {
      area: 'candidates',
      screens: [
        { name: 'a-one', steps: [{ goto: '/a' }, { capture: 'a-one' }] },
        { name: 'a-two', steps: [{ goto: '/a2' }, { capture: 'a-two' }] },
      ],
    });
    const r = loadMap({ root, profile });
    assert.deepEqual(r.files.map((f) => path.basename(f)), ['a.json', 'b.json']);
    assert.deepEqual(r.screens.map((s) => s.name), ['a-one', 'a-two', 'b-one']);
    assert.deepEqual(r.screens.map((s) => s.area), ['candidates', 'candidates', 'b']);
    assert.deepEqual(r.screens.map((s) => path.basename(s.file)), ['a.json', 'a.json', 'b.json']);
  });

  it('a map file that is not JSON throws an Error naming the file', () => {
    const root = tempDir();
    writeMap(root, 'bad.json', '{ "screens": [');
    const err = thrown(() => loadMap({ root, profile }));
    assert.match(err.message, /bad\.json: /);
  });
});

describe('map: validateMap', () => {
  it('step vocabulary: every STEP_ACTIONS entry alone is accepted; zero or two action keys are errors', () => {
    // Each action with a value of its schema type. `flow` needs a defined flow, so the flow cases cover it.
    const TYPED = { wait: 100, reload: true, back: true, forward: true, tour: true };
    const everyAction = STEP_ACTIONS.filter((a) => a !== 'flow').map((action) => ({ [action]: TYPED[action] ?? 'x', ...(action === 'fill' ? { value: 'x' } : {}) }));
    assert.deepEqual(validateMap([{ file: FILE, area: AREA, name: 'all-actions', steps: everyAction }], profile).errors, []);

    const bad = validateMap([{ file: FILE, area: AREA, name: 'bad', steps: [{ value: 'x' }, { click: '#a', goto: '/' }] }], profile);
    assert.ok(bad.errors.length >= 2 && bad.errors.every((e) => e.startsWith('a.json bad: ')), JSON.stringify(bad.errors));
  });

  it('step keys: a STEP_KEYS modifier is accepted; an unknown step key is an error; fill needs a value', () => {
    // Each modifier takes a value of its schema type (optional boolean, expandEach selector, files string, value string, watch selector).
    const MODIFIER_VALUES = { optional: true, expandEach: '.toggle', files: 'a.txt', value: 'x', watch: '.w' };
    const modifiers = Object.fromEntries(STEP_KEYS.filter((k) => !STEP_ACTIONS.includes(k)).map((k) => [k, MODIFIER_VALUES[k]]));
    assert.deepEqual(validateMap([{ file: FILE, area: AREA, name: 'mods', steps: [{ click: '#a', ...modifiers }, { capture: 'mods' }] }], profile).errors, []);

    const unknown = validateMap([{ file: FILE, area: AREA, name: 'unknown', steps: [{ goto: '/', bogus: 1 }, { capture: 'unknown' }] }], profile);
    assert.equal(unknown.errors.length, 1, JSON.stringify(unknown.errors));
    assert.match(unknown.errors[0], /^a\.json unknown: .*unknown step key/);

    const noValue = validateMap([{ file: FILE, area: AREA, name: 'nofill', steps: [{ fill: '#q' }, { capture: 'nofill' }] }], profile);
    assert.ok(noValue.errors.some((e) => e.startsWith('a.json nofill: ')), JSON.stringify(noValue.errors));
  });

  it('the same name twice is an error unless their viewports are disjoint', () => {
    const overlapping = validateMap(
      [
        { file: FILE, area: AREA, name: 'home', steps: S },
        { file: FILE, area: AREA, name: 'home', steps: S },
      ],
      profile,
    );
    assert.ok(overlapping.errors.length >= 1 && overlapping.errors.some((e) => e.startsWith('a.json home: ')), JSON.stringify(overlapping.errors));

    const disjoint = validateMap(
      [
        { file: FILE, area: AREA, name: 'home', viewports: ['desktop'], steps: S },
        { file: FILE, area: AREA, name: 'home', viewports: ['phone'], steps: S },
      ],
      profile,
    );
    assert.deepEqual(disjoint.errors, []);
  });

  it('a viewports entry or a role must exist in the profile', () => {
    const r = validateMap([{ file: FILE, area: AREA, name: 'x', viewports: ['tablet'], role: 'ghost', steps: S }], profile);
    assert.ok(r.errors.some((e) => e.startsWith('a.json x: ') && e.includes('tablet')), JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.startsWith('a.json x: ') && e.includes('ghost')), JSON.stringify(r.errors));
  });

  it('a regex in clearStorage or requestOverrides[].url that does not compile is an error; a valid one is not', () => {
    const r = validateMap(
      [
        { file: FILE, area: AREA, name: 'clear', steps: [{ goto: '/' }, { clearStorage: '(' }, { capture: 'clear' }] },
        { file: FILE, area: AREA, name: 'mock', steps: S, requestOverrides: [{ url: '(', json: {} }] },
        { file: FILE, area: AREA, name: 'ok', steps: [{ goto: '/' }, { clearStorage: '^sess' }, { capture: 'ok' }], requestOverrides: [{ url: '^/api', json: {} }] },
      ],
      profile,
    );
    assert.ok(r.errors.some((e) => e.startsWith('a.json clear: ')), JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.startsWith('a.json mock: ')), JSON.stringify(r.errors));
    assert.ok(!r.errors.some((e) => e.startsWith('a.json ok: ')), JSON.stringify(r.errors));
  });

  it('an unknown screen key is an error; every SCREEN_KEYS key is accepted', () => {
    const r = validateMap(
      [
        {
          file: FILE,
          area: AREA,
          name: 'full',
          role: 'staff',
          steps: S,
          viewports: ['desktop'],
          record: true,
          watch: '.x',
          requestOverrides: [{ url: '^/api', json: {} }],
          bogus: 1,
        },
      ],
      profile,
    );
    assert.ok(r.errors.some((e) => e.startsWith('a.json full: ') && e.includes('unknown screen key')), JSON.stringify(r.errors));
  });

  it("a screen with no capture step is a warning ('captures once at the end'), not an error", () => {
    const r = validateMap(
      [
        { file: FILE, area: AREA, name: 'nocap', steps: [{ goto: '/' }] },
        { file: FILE, area: AREA, name: 'withcap', steps: S },
      ],
      profile,
    );
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => w.includes('nocap')), JSON.stringify(r.warnings));
    assert.ok(!r.warnings.some((w) => w.includes('withcap')), JSON.stringify(r.warnings));
  });

  it('a screen tour of false, or an options object of max, hover, maxHover, open and skip, is valid', () => {
    const r = validateMap(
      [
        { file: FILE, area: AREA, name: 'off', steps: S, tour: false },
        { file: FILE, area: AREA, name: 'opts', steps: S, tour: { max: 5, open: ['#x'] } },
      ],
      profile,
    );
    assert.deepEqual(r.errors, []);
  });

  it("a screen tour with an unknown option is an error naming 'tour.bogus: unknown key'", () => {
    const r = validateMap([{ file: FILE, area: AREA, name: 'bogus', steps: S, tour: { bogus: 1 } }], profile);
    assert.ok(r.errors.some((e) => e.startsWith('a.json bogus: ') && e.includes('tour.bogus: unknown key')), JSON.stringify(r.errors));
  });

  it('a step tour with hover: false is valid', () => {
    const r = validateMap([{ file: FILE, area: AREA, name: 'steptour', steps: [{ goto: '/' }, { tour: { hover: false } }, { capture: 'steptour' }] }], profile);
    assert.deepEqual(r.errors, []);
  });
});

describe('map: selectScreens', () => {
  const screens = [{ name: 'home' }, { name: 'home-detail' }, { name: 'login' }, { name: 'settings' }];

  it('only takes comma-separated globs on the name; no only keeps everything', () => {
    assert.deepEqual(selectScreens(screens, { only: 'home*,login', viewport: 'desktop' }).map((s) => s.name), ['home', 'home-detail', 'login']);
    assert.deepEqual(selectScreens(screens, { only: null, viewport: 'desktop' }).map((s) => s.name), ['home', 'home-detail', 'login', 'settings']);
  });

  it("viewport drops screens whose viewports exclude it; screens without viewports are kept", () => {
    const sized = [
      { name: 'a', viewports: ['desktop'] },
      { name: 'b', viewports: ['phone'] },
      { name: 'c' },
    ];
    assert.deepEqual(selectScreens(sized, { viewport: 'phone' }).map((s) => s.name), ['b', 'c']);
    assert.deepEqual(selectScreens(sized, { viewport: 'desktop' }).map((s) => s.name), ['a', 'c']);
  });
});

// Step 2: flows, seed names, file-level rules, schema consistency. The profile adds a second role.
const LOAD_PROFILE = { ...profile, login: { staff: { mode: 'form' }, admin: { mode: 'form' } } };
const SEED_FILE = 'qa/seed.json';
const CONTRACT_SEED = { candidate: { alice: { id: '7f3c', name: 'Alice Tan' } } };
const CONTRACT_FLOWS = {
  'open:candidates': [{ flow: 'login:staff' }, { goto: '/candidates' }, { waitFor: 'role=heading[name="Candidates"]' }],
};

describe('map: loadMap flows, seed names and file-level errors', () => {
  it('flows from two files merge into one object; each flow names its file and carries its steps', () => {
    const root = tempDir();
    const openA = [{ goto: '/a' }];
    const openB = [{ goto: '/b' }, { waitFor: 'h1' }];
    writeMap(root, 'a.json', { flows: { 'open:a': openA }, screens: [] });
    writeMap(root, 'b.json', { flows: { 'open:b': openB }, screens: [] });
    const r = loadMap({ root, profile: LOAD_PROFILE });
    const dir = path.join(root, 'qa', 'map');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Object.keys(r.flows).sort(), ['open:a', 'open:b']);
    assert.equal(r.flows['open:a'].file, path.join(dir, 'a.json'));
    assert.equal(r.flows['open:b'].file, path.join(dir, 'b.json'));
    assert.deepEqual(r.flows['open:a'].steps, openA);
    assert.deepEqual(r.flows['open:b'].steps, openB);
  });

  it('the same flow name in a.json and b.json is an error naming b.json; the first definition is kept', () => {
    const root = tempDir();
    writeMap(root, 'a.json', { flows: { 'open:x': [{ goto: '/a' }] }, screens: [] });
    writeMap(root, 'b.json', { flows: { 'open:x': [{ goto: '/b' }] }, screens: [] });
    const r = loadMap({ root, profile: LOAD_PROFILE });
    assert.deepEqual(r.errors, ['b.json: flow "open:x" is already defined in a.json']);
    assert.ok(r.flows['open:x'].file.endsWith('a.json'), r.flows['open:x'].file);
  });

  it('a flow named login:<role> in a file is an error: those names are built in', () => {
    const root = tempDir();
    writeMap(root, 'a.json', { flows: { 'login:staff': [{ goto: '/x' }] }, screens: [] });
    const r = loadMap({ root, profile: LOAD_PROFILE });
    assert.deepEqual(r.errors, ['a.json: flow "login:staff": login:<role> names are built in']);
  });

  it('a top-level key outside $schema, area, flows and screens is an error naming it', () => {
    const root = tempDir();
    writeMap(root, 'a.json', { bogus: 1, screens: [] });
    assert.deepEqual(loadMap({ root, profile: LOAD_PROFILE }).errors, ['a.json: unknown key "bogus"']);
  });

  it('a $schema top-level key is allowed and gives no error', () => {
    const root = tempDir();
    writeMap(root, 'a.json', { $schema: './map.schema.json', screens: [] });
    assert.deepEqual(loadMap({ root, profile: LOAD_PROFILE }).errors, []);
  });

  it('flows that is an array is an error: "flows" must be an object of step lists', () => {
    const root = tempDir();
    writeMap(root, 'a.json', { flows: [], screens: [] });
    assert.deepEqual(loadMap({ root, profile: LOAD_PROFILE }).errors, ['a.json: "flows" must be an object of step lists']);
  });

  it('a flow whose value is not an array of steps is an error: "flows" must be an object of step lists', () => {
    const root = tempDir();
    writeMap(root, 'a.json', { flows: { x: {} }, screens: [] });
    assert.deepEqual(loadMap({ root, profile: LOAD_PROFILE }).errors, ['a.json: "flows" must be an object of step lists']);
  });

  it('qa/seed.json loads as the seed object; a missing one loads as null with seedFile still set', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(root, 'qa', 'seed.json'), JSON.stringify(CONTRACT_SEED));
    const r = loadMap({ root, profile: LOAD_PROFILE });
    assert.deepEqual(r.seed, CONTRACT_SEED);
    assert.equal(r.seedFile, path.join(root, 'qa', 'seed.json'));

    const empty = tempDir();
    const missing = loadMap({ root: empty, profile: LOAD_PROFILE });
    assert.equal(missing.seed, null);
    assert.equal(missing.seedFile, path.join(empty, 'qa', 'seed.json'));
  });

  it('an absolute profile.seedNames path is read as given, and seedFile is that path', () => {
    const root = tempDir();
    const elsewhere = tempDir();
    const file = path.join(elsewhere, 'names.json');
    fs.writeFileSync(file, JSON.stringify({ f: { a: 'x.png' } }));
    const r = loadMap({ root, profile: { ...LOAD_PROFILE, seedNames: file } });
    assert.deepEqual(r.seed, { f: { a: 'x.png' } });
    assert.equal(r.seedFile, file);
  });

  it('a seed file that is not JSON throws an Error naming seed.json', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(root, 'qa', 'seed.json'), '{ "candidate": ');
    const err = thrown(() => loadMap({ root, profile: LOAD_PROFILE }));
    assert.match(err.message, /seed\.json: /);
  });
});

describe('map: expandScreen', () => {
  // Returns the message of the MapError that expandScreen throws for these arguments.
  function mapErr(screen, options = {}) {
    const err = thrown(() => expandScreen(screen, { profile: LOAD_PROFILE, ...options }));
    assert.ok(err instanceof MapError, String(err));
    return err.message;
  }

  it('the contract example: the login and open flow fold into role and steps, and $seed names resolve', () => {
    const screen = {
      name: 'candidate-detail',
      flow: 'open:candidates',
      area: 'candidates',
      file: 'candidates.json',
      steps: [{ click: 'role=link[name="$seed.candidate.alice.name"]' }, { capture: 'detail' }],
    };
    const out = expandScreen(screen, { flows: CONTRACT_FLOWS, seed: CONTRACT_SEED, seedFile: SEED_FILE, profile: LOAD_PROFILE });
    assert.deepEqual(out, {
      name: 'candidate-detail',
      role: 'staff',
      area: 'candidates',
      file: 'candidates.json',
      steps: [
        { goto: '/candidates', via: 'open:candidates' },
        { waitFor: 'role=heading[name="Candidates"]', via: 'open:candidates' },
        { click: 'role=link[name="Alice Tan"]' },
        { capture: 'detail' },
      ],
    });
  });

  it('an inline { flow } step is replaced in place by that flow steps, each carrying via', () => {
    const flows = { mid: [{ click: '#a' }, { fill: '#q', value: 'v' }] };
    const out = expandScreen({ name: 's', steps: [{ goto: '/' }, { flow: 'mid' }, { capture: 'x' }] }, { flows, profile: LOAD_PROFILE });
    assert.deepEqual(out.steps, [
      { goto: '/' },
      { click: '#a', via: 'mid' },
      { fill: '#q', value: 'v', via: 'mid' },
      { capture: 'x' },
    ]);
  });

  it('steps from a nested flow carry via = the innermost flow that holds them', () => {
    const flows = { outer: [{ flow: 'inner' }, { goto: '/o' }], inner: [{ click: '#i' }] };
    const out = expandScreen({ name: 's', flow: 'outer', steps: [{ capture: 'x' }] }, { flows, profile: LOAD_PROFILE });
    assert.deepEqual(out.steps, [{ click: '#i', via: 'inner' }, { goto: '/o', via: 'outer' }, { capture: 'x' }]);
  });

  it('a flow that is not defined is a MapError', () => {
    assert.equal(mapErr({ name: 's', flow: 'nope', steps: [{ capture: 'x' }] }, { flows: {} }), 'flow "nope" is not defined');
  });

  it('a flow cycle is a MapError naming the calls in order, the repeated name last', () => {
    const flows = { a: [{ flow: 'b' }], b: [{ flow: 'a' }] };
    assert.equal(mapErr({ name: 's', flow: 'a', steps: [{ capture: 'x' }] }, { flows }), 'flow cycle: a -> b -> a');
  });

  it('login:<role> that is not the first step after expansion is a MapError', () => {
    assert.equal(mapErr({ name: 's', steps: [{ goto: '/' }, { flow: 'login:staff' }, { capture: 'x' }] }), 'login:staff must be the first step');
  });

  it('a screen role that differs from the login:<role> it starts with is a MapError', () => {
    assert.equal(mapErr({ name: 's', role: 'staff', flow: 'login:admin', steps: [{ capture: 'x' }] }), 'role "staff" conflicts with login:admin');
  });

  it('a screen role equal to its login:<role> is not an error, and role is set', () => {
    const out = expandScreen({ name: 's', role: 'staff', flow: 'login:staff', steps: [{ capture: 'x' }] }, { profile: LOAD_PROFILE });
    assert.equal(out.role, 'staff');
    assert.deepEqual(out.steps, [{ capture: 'x' }]);
  });

  it('login:<role> for a role that is not in qa.json login is a MapError', () => {
    assert.equal(mapErr({ name: 's', flow: 'login:ghost', steps: [{ capture: 'x' }] }), 'login:ghost: no role "ghost" in qa.json login');
  });

  it('$seed tokens inside a goto are replaced by the seed string', () => {
    const out = expandScreen({ name: 's', steps: [{ goto: '/c/$seed.candidate.alice.id/edit' }, { capture: 'x' }] }, { seed: CONTRACT_SEED, seedFile: SEED_FILE, profile: LOAD_PROFILE });
    assert.equal(out.steps[0].goto, '/c/7f3c/edit');
  });

  it('a seed number becomes a string', () => {
    const seed = { n: { count: 42 } };
    const out = expandScreen({ name: 's', steps: [{ goto: '/n/$seed.n.count' }, { capture: 'x' }] }, { seed, seedFile: SEED_FILE, profile: LOAD_PROFILE });
    assert.equal(out.steps[0].goto, '/n/42');
    assert.equal(typeof out.steps[0].goto, 'string');
  });

  it('$seed tokens are replaced inside arrays: files and clearStorage', () => {
    const seed = { f: { a: 'x.png' } };
    const steps = [{ setFiles: '#up', files: ['$seed.f.a'] }, { clearStorage: ['$seed.f.a'] }, { capture: 'x' }];
    const out = expandScreen({ name: 's', steps }, { seed, seedFile: SEED_FILE, profile: LOAD_PROFILE });
    assert.deepEqual(out.steps, [{ setFiles: '#up', files: ['x.png'] }, { clearStorage: ['x.png'] }, { capture: 'x' }]);
  });

  it('a $seed path missing from the seed is a MapError naming the token and the seed file basename', () => {
    const msg = mapErr({ name: 's', steps: [{ goto: '/c/$seed.candidate.bob.id/edit' }, { capture: 'x' }] }, { seed: CONTRACT_SEED, seedFile: SEED_FILE });
    assert.equal(msg, '$seed.candidate.bob.id: not in seed.json');
  });

  it('a $seed path that names an object is a MapError: not a string or number', () => {
    const msg = mapErr({ name: 's', steps: [{ goto: '/c/$seed.candidate.alice' }, { capture: 'x' }] }, { seed: CONTRACT_SEED, seedFile: SEED_FILE });
    assert.equal(msg, '$seed.candidate.alice: not a string or number');
  });

  it('a $seed token with no seed names file (seed null) is a MapError naming seed.json', () => {
    const msg = mapErr({ name: 's', steps: [{ goto: '/c/$seed.candidate.alice.id' }, { capture: 'x' }] }, { seed: null, seedFile: SEED_FILE });
    assert.equal(msg, '$seed.candidate.alice.id: no seed names file (seed.json)');
  });

  it('expandScreen changes neither the screen nor the flows it is given', () => {
    const screen = {
      name: 'candidate-detail',
      flow: 'open:candidates',
      steps: [{ click: 'role=link[name="$seed.candidate.alice.name"]' }, { capture: 'detail' }],
    };
    const flows = structuredClone(CONTRACT_FLOWS);
    const screenBefore = structuredClone(screen);
    const flowsBefore = structuredClone(CONTRACT_FLOWS);
    expandScreen(screen, { flows, seed: CONTRACT_SEED, seedFile: SEED_FILE, profile: LOAD_PROFILE });
    assert.deepEqual(screen, screenBefore);
    assert.deepEqual(flows, flowsBefore);
  });

  it('a screen with no flow expands to its own steps, with no via keys', () => {
    const steps = [{ goto: '/' }, { click: '#a' }, { capture: 'x' }];
    const out = expandScreen({ name: 's', steps }, { profile: LOAD_PROFILE });
    assert.deepEqual(out.steps, steps);
    assert.ok(out.steps.every((step) => !('via' in step)));
  });
});

describe('map: validateMap for flows, seed names and the schema', () => {
  // Writes one map file under a fresh root and loads it the way capture does.
  function loadOne(content, name = 'a.json') {
    const root = tempDir();
    writeMap(root, name, content);
    return loadMap({ root, profile: LOAD_PROFILE });
  }

  it('a screen with neither flow nor steps is an error ending needs "flow" or "steps"', () => {
    const r = validateMap(loadOne({ screens: [{ name: 'empty' }] }), LOAD_PROFILE);
    assert.ok(r.errors.some((e) => e.startsWith('a.json empty: ') && e.endsWith('needs "flow" or "steps"')), JSON.stringify(r.errors));
  });

  it('a flow step that fills with no value is an error prefixed with the flow name, and it mentions value', () => {
    const r = validateMap(
      loadOne({ flows: { f: [{ fill: '#q' }] }, screens: [{ name: 's', flow: 'f', steps: [{ capture: 's' }] }] }),
      LOAD_PROFILE,
    );
    assert.ok(r.errors.some((e) => e.startsWith('a.json flow "f": ') && e.includes('value')), JSON.stringify(r.errors));
  });

  it('a selector with an engine Playwright does not have (label=) is an error; role=, css and text= pass (1.0.3)', () => {
    const r = validateMap(loadOne({ screens: [{ name: 's', steps: [{ goto: '/' }, { fill: 'label=Connection key', value: 'k' }, { click: 'role=button[name="Save"]' }, { waitFor: '[aria-label=Key] >> text=Saved' }, { capture: 's' }] }] }), LOAD_PROFILE);
    const bad = r.errors.filter((e) => e.includes('selector engine'));
    assert.equal(bad.length, 1, JSON.stringify(r.errors));
    assert.match(bad[0], /step 2: unknown selector engine "label" in fill "label=Connection key"/);
  });

  it('a screen whose flow is not defined is an error naming the screen and the flow', () => {
    const r = validateMap(loadOne({ screens: [{ name: 's', flow: 'nope', steps: [{ capture: 's' }] }] }), LOAD_PROFILE);
    assert.ok(r.errors.includes('a.json s: flow "nope" is not defined'), JSON.stringify(r.errors));
  });

  it('the schema types a screen: viewports as a string is an error', () => {
    const r = validateMap(loadOne({ screens: [{ name: 's', viewports: 'desktop', steps: [{ goto: '/' }, { capture: 's' }] }] }), LOAD_PROFILE);
    assert.ok(r.errors.includes('a.json s: viewports: must be array'), JSON.stringify(r.errors));
  });

  it('the schema types a step: wait as a string is an error naming the step number', () => {
    const r = validateMap(loadOne({ screens: [{ name: 's', steps: [{ wait: '5' }, { capture: 's' }] }] }), LOAD_PROFILE);
    assert.ok(r.errors.includes('a.json s: step 1: wait: must be integer'), JSON.stringify(r.errors));
  });

  it('a screen mode the profile does not define is an error matching unknown mode', () => {
    const r = validateMap(loadOne({ screens: [{ name: 's', modes: ['dark'], steps: [{ goto: '/' }, { capture: 's' }] }] }), LOAD_PROFILE);
    assert.ok(r.errors.some((e) => /unknown mode "dark"/.test(e)), JSON.stringify(r.errors));
  });

  it('a screen mode the profile defines is a warning: modes are not walked yet', () => {
    const r = validateMap(loadOne({ screens: [{ name: 's', modes: ['light'], steps: [{ goto: '/' }, { capture: 's' }] }] }), LOAD_PROFILE);
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.includes('a.json s: modes are not walked yet'), JSON.stringify(r.warnings));
  });

  it('a flow no screen uses is a warning: never used', () => {
    const r = validateMap(
      loadOne({ flows: { f: [{ goto: '/' }] }, screens: [{ name: 's', steps: [{ goto: '/' }, { capture: 's' }] }] }),
      LOAD_PROFILE,
    );
    assert.ok(r.warnings.includes('a.json flow "f": never used'), JSON.stringify(r.warnings));
  });

  it('a screen whose capture step comes from its flow gets no no-capture warning', () => {
    const r = validateMap(loadOne({ flows: { f: [{ goto: '/' }, { capture: 'x' }] }, screens: [{ name: 's', flow: 'f' }] }), LOAD_PROFILE);
    assert.deepEqual(r.errors, []);
    assert.ok(!r.warnings.some((w) => w.includes('no capture step')), JSON.stringify(r.warnings));
  });

  it('tour: true on a screen and { tour: true } as a step are accepted with no errors', () => {
    const r = validateMap(
      loadOne({ screens: [{ name: 't', tour: true, steps: [{ goto: '/' }, { tour: true }, { capture: 't' }] }] }),
      LOAD_PROFILE,
    );
    assert.deepEqual(r.errors, []);
  });

  it('origin and sources are accepted with no errors', () => {
    const r = validateMap(loadOne({ screens: [{ name: 'o', origin: 'verify:x', sources: ['src/**'], steps: [{ goto: '/' }, { capture: 'o' }] }] }), LOAD_PROFILE);
    assert.deepEqual(r.errors, []);
  });
});

describe('map: schema/map.schema.json matches the key sets in map.mjs', () => {
  const SCHEMA = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'map.schema.json');
  const readSchema = () => JSON.parse(fs.readFileSync(SCHEMA(), 'utf8'));

  it('$defs.step.properties has exactly STEP_KEYS, and additionalProperties is false', () => {
    const schema = readSchema();
    assert.deepEqual(Object.keys(schema.$defs.step.properties).sort(), [...STEP_KEYS].sort());
    assert.equal(schema.$defs.step.additionalProperties, false);
  });

  it('$defs.screen.properties has exactly SCREEN_KEYS, and additionalProperties is false', () => {
    const schema = readSchema();
    assert.deepEqual(Object.keys(schema.$defs.screen.properties).sort(), [...SCREEN_KEYS].sort());
    assert.equal(schema.$defs.screen.additionalProperties, false);
  });

  it('the top-level properties are exactly FILE_KEYS, and additionalProperties is false', () => {
    const schema = readSchema();
    assert.deepEqual(Object.keys(schema.properties).sort(), [...FILE_KEYS].sort());
    assert.equal(schema.additionalProperties, false);
  });
});

describe('map: the shipped templates', () => {
  it('templates/map.example.json and templates/seed.example.json validate clean, and every screen expands', () => {
    const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'qa', 'map'), { recursive: true });
    fs.copyFileSync(path.join(plugin, 'templates', 'map.example.json'), path.join(root, 'qa', 'map', 'map.example.json'));
    fs.copyFileSync(path.join(plugin, 'templates', 'seed.example.json'), path.join(root, 'qa', 'seed.json'));

    const tplProfile = {
      map: 'qa/map',
      seedNames: 'qa/seed.json',
      viewports: { desktop: [1440, 900] },
      modes: ['light'],
      login: { staff: { mode: 'form' } },
    };
    const map = loadMap({ root, profile: tplProfile });
    assert.deepEqual(validateMap(map, tplProfile).errors, []);
    assert.ok(map.screens.length > 0, 'the template has screens');
    for (const screen of map.screens) {
      expandScreen(screen, { flows: map.flows, seed: map.seed, seedFile: map.seedFile, profile: tplProfile });
    }
  });
});

it('step 7: loadMap skips <area>.sources.json (recorded coverage sources are not map files)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-map7-'));
  fs.mkdirSync(path.join(root, 'qa/map'), { recursive: true });
  fs.writeFileSync(path.join(root, 'qa/map/a.json'), JSON.stringify({ area: 'a', screens: [{ name: 's', steps: [{ goto: '/' }] }] }));
  fs.writeFileSync(path.join(root, 'qa/map/a.sources.json'), JSON.stringify({ sha: 'x', screens: { s: ['src/a.ts'] } }));
  const map = loadMap({ root, profile: { map: 'qa/map' } });
  assert.deepEqual(map.screens.map((s) => s.name), ['s']);
  assert.equal(map.files.length, 1);
});
