// Red tests for scripts/lib/affected.mjs (CONTRACT: lines 1–60 of that file). Maps are built by hand in
// the shape loadMap returns; mapAt runs against a temp git repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UI_EXT, affectedScreens, chainOf, entryKey, mapAt, onlyGlob } from '../scripts/lib/affected.mjs';

const FILE = '/repo/qa/map/candidates.json';
const screen = (name, over = {}) => ({ name, area: 'candidates', file: FILE, ...over });
const flow = (steps) => ({ steps, file: FILE });
// The shape loadMap returns: screens carry area and file; flows are { name: { steps, file } }.
const loaded = (screens, flows = {}) => ({ screens, flows, seed: null, seedFile: '/repo/qa/seed.json', files: [FILE], errors: [] });
const openFlows = () => ({ 'open:candidates': flow([{ flow: 'login:staff' }, { goto: '/candidates' }]) });

// The brief's example: three screens, all in qa/map/candidates.json.
function example(flows = openFlows()) {
  return loaded(
    [
      screen('candidates-list', { flow: 'open:candidates', steps: [{ capture: 'list' }] }),
      screen('candidate-detail', { flow: 'open:candidates', steps: [{ click: 'role=link[name="Alice"]' }, { capture: 'detail' }] }),
      screen('jobs-list', { steps: [{ goto: '/jobs' }, { capture: 'list' }] }),
    ],
    flows,
  );
}

// A journey: two screens walking open:candidates, one recorded (record: true), plus an unrelated screen.
function journeyMap(recorded = true) {
  return loaded(
    [
      screen('candidate-detail', { flow: 'open:candidates', steps: [{ click: 'role=link[name="Alice"]' }, { capture: 'detail' }] }),
      screen('candidate-journey', { flow: 'open:candidates', record: recorded, steps: [{ capture: 'journey' }] }),
      screen('jobs-list', { steps: [{ goto: '/jobs' }, { capture: 'list' }] }),
    ],
    openFlows(),
  );
}

// ---------------------------------------------------------------- chainOf

test('chainOf: screen.flow first, then nested flow steps depth first, login skipped', () => {
  const flows = {
    'open:candidates': flow([{ flow: 'login:staff' }, { goto: '/candidates' }, { flow: 'filters' }]),
    filters: flow([{ flow: 'reset' }, { click: '#f' }]),
    reset: flow([{ click: '#r' }]),
    modal: flow([{ flow: 'login:staff' }, { flow: 'reset' }, { click: '#m' }]),
  };
  const s = screen('detail', { flow: 'open:candidates', steps: [{ flow: 'modal' }, { capture: 'detail' }] });
  assert.deepEqual(chainOf(s, flows), ['open:candidates', 'filters', 'reset', 'modal']);
});

test('chainOf: depth first, not breadth first', () => {
  const flows = {
    a: flow([{ flow: 'b' }, { flow: 'd' }]),
    b: flow([{ flow: 'c' }]),
    c: flow([{ click: '#c' }]),
    d: flow([{ click: '#d' }]),
  };
  assert.deepEqual(chainOf(screen('s', { flow: 'a' }), flows), ['a', 'b', 'c', 'd']);
});

test('chainOf: each name once, even when two flows call the same one', () => {
  const flows = {
    a: flow([{ flow: 'b' }, { flow: 'c' }]),
    b: flow([{ flow: 'c' }]),
    c: flow([{ click: '#c' }]),
  };
  assert.deepEqual(chainOf(screen('s', { flow: 'a', steps: [{ flow: 'c' }] }), flows), ['a', 'b', 'c']);
});

test("chainOf: login:<role> names are skipped wherever they appear", () => {
  const flows = { 'open:x': flow([{ flow: 'login:admin' }, { goto: '/x' }]) };
  const s = screen('s', { flow: 'open:x', steps: [{ flow: 'login:staff' }, { capture: 'y' }] });
  assert.deepEqual(chainOf(s, flows), ['open:x']);
});

test('chainOf: an unknown flow name is kept and not walked', () => {
  const flows = { 'open:x': flow([{ flow: 'gone' }, { flow: 'deeper' }]), deeper: flow([{ click: '#d' }]) };
  const s = screen('s', { flow: 'missing', steps: [{ flow: 'open:x' }] });
  assert.deepEqual(chainOf(s, flows), ['missing', 'open:x', 'gone', 'deeper']);
});

test('chainOf: a screen with no flow and no flow steps walks nothing', () => {
  assert.deepEqual(chainOf(screen('s', { steps: [{ goto: '/' }] }), {}), []);
});

// ---------------------------------------------------------------- entryKey

test('entryKey: area, file, origin and sources do not count', () => {
  const flows = openFlows();
  const a = screen('list', { flow: 'open:candidates', steps: [{ capture: 'list' }], origin: 'verify:1', sources: ['src/*.tsx'] });
  const b = screen('list', { area: 'other', file: '/elsewhere/x.json', flow: 'open:candidates', steps: [{ capture: 'list' }] });
  assert.equal(entryKey(a, flows), entryKey(b, flows));
});

test('entryKey: a changed step of the screen changes the key', () => {
  const flows = openFlows();
  const a = screen('list', { flow: 'open:candidates', steps: [{ capture: 'list' }] });
  const b = screen('list', { flow: 'open:candidates', steps: [{ capture: 'other' }] });
  assert.notEqual(entryKey(a, flows), entryKey(b, flows));
});

test('entryKey: a changed step of a flow the screen walks changes the key', () => {
  const s = screen('list', { flow: 'open:candidates', steps: [{ capture: 'list' }] });
  const changed = { 'open:candidates': flow([{ flow: 'login:staff' }, { goto: '/candidates/all' }]) };
  assert.notEqual(entryKey(s, openFlows()), entryKey(s, changed));
});

test('entryKey: a changed step in a nested flow changes the key', () => {
  const s = screen('list', { flow: 'open:c', steps: [{ capture: 'list' }] });
  const before = { 'open:c': flow([{ flow: 'filters' }]), filters: flow([{ click: '#a' }]) };
  const after = { 'open:c': flow([{ flow: 'filters' }]), filters: flow([{ click: '#b' }]) };
  assert.notEqual(entryKey(s, before), entryKey(s, after));
});

test('entryKey: a flow the screen does not walk does not change the key', () => {
  const s = screen('list', { flow: 'open:candidates', steps: [{ capture: 'list' }] });
  const more = { ...openFlows(), unrelated: flow([{ goto: '/elsewhere' }]) };
  assert.equal(entryKey(s, openFlows()), entryKey(s, more));
});

// ---------------------------------------------------------------- affectedScreens

test('affectedScreens: the brief example', () => {
  const sources = {
    'candidate-detail': ['src/features/candidates/Detail.tsx'],
    'jobs-list': ['src/features/jobs/List.tsx'],
  };
  const a = affectedScreens({ head: example(), base: example(), changed: ['src/features/candidates/Detail.tsx'], sources });
  // Rework U4: a screen with no known sources is out of scope (mapThese), never walked.
  assert.deepEqual(a.names, ['candidate-detail']);
  assert.deepEqual(a.why, { 'candidate-detail': 'source: src/features/candidates/Detail.tsx' });
  assert.equal(a.total, 3);
  assert.equal(a.unknown, 1);
  assert.deepEqual(a.mapThese, ['candidates-list']);
  assert.deepEqual(a.skipped, ['candidates-list', 'jobs-list']);
});

test('affectedScreens: changed qa.json marks every screen everything', () => {
  const a = affectedScreens({ head: example(), base: example(), changed: ['qa.json'] });
  assert.deepEqual(a.names, ['candidates-list', 'candidate-detail', 'jobs-list']);
  assert.deepEqual(a.why, {
    'candidates-list': 'everything: qa.json changed',
    'candidate-detail': 'everything: qa.json changed',
    'jobs-list': 'everything: qa.json changed',
  });
  assert.equal(a.unknown, 0);
  assert.deepEqual(a.skipped, []);
});

test('affectedScreens: a changed lockfile no longer marks every screen (rework U4)', () => {
  for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const a = affectedScreens({ head: example(), base: example(), changed: [file], sources: { 'candidates-list': ['src/a.ts'], 'candidate-detail': ['src/b.ts'], 'jobs-list': ['src/c.ts'] } });
    assert.deepEqual(a.names, [], file);
  }
});

test('affectedScreens: a changed qa/seed.json marks every screen everything by default', () => {
  const a = affectedScreens({ head: example(), base: example(), changed: ['qa/seed.json'] });
  assert.deepEqual(a.names, ['candidates-list', 'candidate-detail', 'jobs-list']);
  assert.equal(a.why['jobs-list'], 'everything: qa/seed.json changed');
});

test('affectedScreens: profile.seedNames replaces qa/seed.json as the seed file', () => {
  const profile = { seedNames: 'qa/names.json' };
  const sources = { 'candidates-list': ['src/a.ts'], 'candidate-detail': ['src/b.ts'], 'jobs-list': ['src/c.ts'] };
  const named = affectedScreens({ head: example(), base: example(), changed: ['qa/names.json'], profile });
  assert.deepEqual(named.names, ['candidates-list', 'candidate-detail', 'jobs-list']);
  assert.equal(named.why['jobs-list'], 'everything: qa/names.json changed');
  const old = affectedScreens({ head: example(), base: example(), changed: ['qa/seed.json'], profile, sources });
  assert.deepEqual(old.names, []);
});

test('affectedScreens: everything beats new entry', () => {
  const a = affectedScreens({ head: example(), base: null, changed: ['qa.json'] });
  assert.equal(a.why['jobs-list'], 'everything: qa.json changed');
});

test('affectedScreens: base null makes every head screen a new entry', () => {
  const a = affectedScreens({ head: example(), base: null, changed: [] });
  assert.deepEqual(a.names, ['candidates-list', 'candidate-detail', 'jobs-list']);
  assert.deepEqual(a.why, {
    'candidates-list': 'new entry',
    'candidate-detail': 'new entry',
    'jobs-list': 'new entry',
  });
  assert.equal(a.unknown, 0);
  assert.deepEqual(a.skipped, []);
});

test('affectedScreens: a screen the base lacks is a new entry, even when its recorded sources match', () => {
  const base = example();
  base.screens = base.screens.filter((s) => s.name !== 'jobs-list');
  const sources = {
    'candidates-list': ['src/features/candidates/List.tsx'],
    'candidate-detail': ['src/features/candidates/Detail.tsx'],
    'jobs-list': ['src/features/jobs/List.tsx'],
  };
  const a = affectedScreens({ head: example(), base, changed: ['src/features/jobs/List.tsx'], sources });
  assert.deepEqual(a.names, ['jobs-list']);
  assert.equal(a.why['jobs-list'], 'new entry');
});

test('affectedScreens: a changed flow step marks every screen walking it entry changed', () => {
  const base = example();
  base.flows['open:candidates'] = flow([{ flow: 'login:staff' }, { goto: '/candidates/all' }]);
  const a = affectedScreens({ head: example(), base, changed: [] });
  assert.deepEqual(a.names, ['candidates-list', 'candidate-detail']);
  assert.deepEqual(a.why, { 'candidates-list': 'entry changed', 'candidate-detail': 'entry changed' });
});

test('affectedScreens: entry changed beats sources:', () => {
  const base = example();
  base.screens[1] = screen('candidate-detail', { flow: 'open:candidates', steps: [{ click: 'role=link[name="Bob"]' }, { capture: 'detail' }] });
  const head = example();
  head.screens[1].sources = ['src/features/candidates/*.tsx'];
  const sources = { 'candidate-detail': ['src/features/candidates/Detail.tsx'], 'candidates-list': ['src/features/candidates/List.tsx'] };
  const a = affectedScreens({ head, base, changed: ['src/features/candidates/Detail.tsx'], sources });
  assert.equal(a.why['candidate-detail'], 'entry changed');
});

test('affectedScreens: with nothing changed only entry reasons apply', () => {
  const flows = () => ({ 'open:c': flow([{ goto: '/c' }]) });
  const head = loaded(
    [
      screen('a', { steps: [{ capture: 'a' }] }),
      screen('b', { steps: [{ capture: 'b' }] }),
      screen('c', { flow: 'open:c', record: true, steps: [{ capture: 'c' }] }),
      screen('d', { steps: [{ capture: 'd' }] }),
    ],
    flows(),
  );
  const base = loaded(
    [
      screen('a', { steps: [{ capture: 'a-old' }] }),
      screen('b', { steps: [{ capture: 'b' }] }),
      screen('c', { flow: 'open:c', record: true, steps: [{ capture: 'c' }] }),
    ],
    flows(),
  );
  const a = affectedScreens({ head, base, changed: [], sources: { a: ['src/a.ts'], c: ['src/c.ts'] } });
  assert.deepEqual(a.names, ['a', 'd']);
  assert.deepEqual(a.why, { a: 'entry changed', d: 'new entry' });
  assert.equal(a.total, 4);
  assert.equal(a.unknown, 1, 'b has no known sources: out of scope, listed to be mapped');
  assert.deepEqual(a.mapThese, ['b']);
  assert.deepEqual(a.skipped, ['b', 'c']);
});

test('affectedScreens: a screen glob matching a changed file gives sources:', () => {
  const head = loaded([
    screen('globbed', { steps: [{ capture: 'g' }], sources: ['src/features/candidates/*.tsx'] }),
    screen('other', { steps: [{ capture: 'o' }], sources: ['src/features/jobs/*.tsx'] }),
  ]);
  const a = affectedScreens({ head, base: head, changed: ['src/features/candidates/Detail.tsx'] });
  assert.deepEqual(a.names, ['globbed']);
  assert.deepEqual(a.why, { globbed: 'sources: src/features/candidates/Detail.tsx' });
  assert.deepEqual(a.skipped, ['other']);
  assert.equal(a.unknown, 0);
});

test('affectedScreens: sources: beats source:', () => {
  const head = example();
  head.screens[1].sources = ['src/features/candidates/*.tsx'];
  const sources = {
    'candidates-list': ['src/features/candidates/List.tsx'],
    'candidate-detail': ['src/features/candidates/Detail.tsx'],
  };
  const a = affectedScreens({ head, base: example(), changed: ['src/features/candidates/Detail.tsx'], sources });
  assert.equal(a.why['candidate-detail'], 'sources: src/features/candidates/Detail.tsx');
});

test('affectedScreens: source: names the first changed file, in changed order, the screen recorded', () => {
  const head = loaded([screen('s', { steps: [{ capture: 's' }] })]);
  const a = affectedScreens({ head, base: head, changed: ['src/b.ts', 'src/a.ts'], sources: { s: ['src/a.ts', 'src/b.ts'] } });
  assert.deepEqual(a.names, ['s']);
  assert.equal(a.why.s, 'source: src/b.ts');
});

test('affectedScreens: no recorded and no screen sources is out of scope (mapThese), whatever changed', () => {
  const head = loaded([
    screen('lonely', { steps: [{ capture: 'l' }] }),
    screen('known', { steps: [{ capture: 'k' }] }),
  ]);
  const a = affectedScreens({ head, base: head, changed: ['README.md'], sources: { known: ['src/k.ts'] } });
  assert.deepEqual(a.names, []);
  assert.deepEqual(a.why, {});
  assert.equal(a.total, 2);
  assert.equal(a.unknown, 1);
  assert.deepEqual(a.mapThese, ['lonely']);
  assert.deepEqual(a.skipped, ['lonely', 'known']);
});

test('affectedScreens: a journey through an affected screen is walked even with no sources known of its own', () => {
  const head = journeyMap();
  const sources = { 'candidate-detail': ['src/features/candidates/Detail.tsx'], 'jobs-list': ['src/features/jobs/List.tsx'] };
  const a = affectedScreens({ head, base: journeyMap(), changed: ['src/features/candidates/Detail.tsx'], sources });
  assert.equal(a.why['candidate-journey'], 'journey through candidate-detail');
});

test('affectedScreens: a record: true screen sharing a flow with an affected one is a journey through that screen', () => {
  const sources = {
    'candidate-detail': ['src/detail.tsx'],
    'candidate-journey': ['src/journey.tsx'],
    'jobs-list': ['src/list.tsx'],
  };
  const a = affectedScreens({ head: journeyMap(), base: journeyMap(), changed: ['src/detail.tsx'], sources });
  assert.deepEqual(a.names, ['candidate-detail', 'candidate-journey']);
  assert.deepEqual(a.why, {
    'candidate-detail': 'source: src/detail.tsx',
    'candidate-journey': 'journey through candidate-detail',
  });
  assert.deepEqual(a.skipped, ['jobs-list']);
});

test('affectedScreens: without record: true a shared flow does not pull a screen in', () => {
  const sources = {
    'candidate-detail': ['src/detail.tsx'],
    'candidate-journey': ['src/journey.tsx'],
    'jobs-list': ['src/list.tsx'],
  };
  const a = affectedScreens({ head: journeyMap(false), base: journeyMap(false), changed: ['src/detail.tsx'], sources });
  assert.deepEqual(a.names, ['candidate-detail']);
  assert.deepEqual(a.skipped, ['candidate-journey', 'jobs-list']);
});

test('affectedScreens: journeys do not pull in each other', () => {
  const head = loaded(
    [
      screen('journey-a', { flow: 'open:candidates', record: true, steps: [{ capture: 'a' }] }),
      screen('journey-b', { flow: 'open:candidates', record: true, steps: [{ capture: 'b' }] }),
    ],
    openFlows(),
  );
  const sources = { 'journey-a': ['src/a.ts'], 'journey-b': ['src/b.ts'] };
  const a = affectedScreens({ head, base: head, changed: ['src/unrelated.ts'], sources });
  assert.deepEqual(a.names, []);
  assert.deepEqual(a.skipped, ['journey-a', 'journey-b']);
});

test('affectedScreens: a screen whose base entry differs only in area, file, origin or sources is not entry changed', () => {
  const head = loaded([screen('x', { steps: [{ capture: 'x' }], origin: 'verify:1', sources: ['src/*.ts'] })]);
  const base = loaded([{ name: 'x', area: 'other', file: '/base/qa/map/other.json', steps: [{ capture: 'x' }] }]);
  const a = affectedScreens({ head, base, changed: [] });
  assert.deepEqual(a.names, []);
});

// ---------------------------------------------------------------- onlyGlob

test('onlyGlob: names joined with a comma; no names gives an empty string', () => {
  assert.equal(onlyGlob(['candidates-list', 'candidate-detail']), 'candidates-list,candidate-detail');
  assert.equal(onlyGlob(['candidates-list']), 'candidates-list');
  assert.equal(onlyGlob([]), '');
});

// ---------------------------------------------------------------- mapAt (temp git repo)

const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  }).trim();
}

function commit(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function write(repo, rel, text) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

function withRepo(fn) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-affected-'));
  try {
    git(repo, ['init', '-q']);
    return fn(repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const mapOpts = (repoRoot, sha) => ({ repoRoot, sha, mapDir: 'qa/map', seedNames: 'qa/seed.json', profile: {} });
const oldMap = JSON.stringify({ area: 'x', screens: [{ name: 'old-screen', steps: [{ goto: '/old' }, { capture: 'a' }] }] }, null, 2);
const newMap = JSON.stringify({ area: 'x', screens: [{ name: 'new-screen', steps: [{ goto: '/new' }, { capture: 'a' }] }] }, null, 2);

test('mapAt: the map and seed as they were at an earlier commit', () => {
  withRepo((repo) => {
    write(repo, 'README.md', '# app\n');
    const c1 = commit(repo, 'app');
    write(repo, 'qa/map/x.json', oldMap);
    write(repo, 'qa/seed.json', JSON.stringify({ candidate: { alice: { id: '7f3c', name: 'Alice Tan' } } }));
    const c2 = commit(repo, 'map');
    write(repo, 'qa/map/x.json', newMap);
    write(repo, 'qa/seed.json', JSON.stringify({ candidate: { alice: { id: '7f3c', name: 'Alice Lim' } } }));
    const c3 = commit(repo, 'map changed');

    const old = mapAt(mapOpts(repo, c2));
    assert.deepEqual(old.screens.map((s) => s.name), ['old-screen']);
    assert.deepEqual(old.seed, { candidate: { alice: { id: '7f3c', name: 'Alice Tan' } } });

    const now = mapAt(mapOpts(repo, c3));
    assert.deepEqual(now.screens.map((s) => s.name), ['new-screen']);
    assert.deepEqual(now.seed, { candidate: { alice: { id: '7f3c', name: 'Alice Lim' } } });

    assert.equal(mapAt(mapOpts(repo, c1)), null);
  });
});

test('mapAt: a map with no seed names file at that commit has seed null', () => {
  withRepo((repo) => {
    write(repo, 'qa/map/x.json', oldMap);
    const sha = commit(repo, 'map only');
    const map = mapAt(mapOpts(repo, sha));
    assert.deepEqual(map.screens.map((s) => s.name), ['old-screen']);
    assert.equal(map.seed, null);
  });
});

test('mapAt: a load error at that commit gives null', () => {
  withRepo((repo) => {
    write(repo, 'qa/map/x.json', '{ "screens": [');
    const sha = commit(repo, 'broken map');
    assert.equal(mapAt(mapOpts(repo, sha)), null);
  });
});

// ---------------------------------------------------------------- unmapped

const JOBS_UI = 'src/features/jobs/JobAdComposePage.tsx';
// jobs-list has recorded sources, so something is known; nothing in the map walks JOBS_UI.
const SOURCES = { 'candidate-detail': ['src/features/candidates/Detail.tsx'], 'jobs-list': ['src/features/jobs/List.tsx'] };
const unmappedOf = (changed, over = {}) => affectedScreens({ head: example(), base: example(), changed, sources: SOURCES, ...over }).unmapped;

test('unmapped: UI_EXT is the frozen list of UI extensions', () => {
  assert.deepEqual([...UI_EXT], ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.jinja', '.j2', '.erb', '.cshtml', '.jsp', '.hbs']);
  assert.ok(Object.isFrozen(UI_EXT));
});

test('unmapped: a changed UI file that no screen records or declares is unmapped', () => {
  assert.deepEqual(unmappedOf([JOBS_UI]), [JOBS_UI]);
});

test('unmapped: every UI extension counts, and a non-UI file does not', () => {
  const ui = ['a.tsx', 'a.jsx', 'a.vue', 'a.svelte', 'a.html', 'a.jinja', 'a.j2', 'a.erb', 'a.cshtml', 'a.jsp', 'a.hbs'];
  assert.deepEqual(unmappedOf([...ui, 'a.ts', 'a.css', 'a.json', 'README.md', 'a.java']), ui);
});

test('unmapped: a test file is not unmapped (TEST_RE), whatever its extension', () => {
  assert.deepEqual(unmappedOf(['src/features/jobs/JobAd.test.tsx', 'src/features/jobs/JobAd.spec.jsx', 'tests/Page.html', 'src/__tests__/Page.tsx', 'e2e/page.tsx']), []);
});

test('unmapped: a file in a recorded sources list is mapped, even a recorded file of another screen', () => {
  assert.deepEqual(unmappedOf(['src/features/candidates/Detail.tsx', 'src/features/jobs/List.tsx']), []);
});

test('unmapped: a file a declared screen sources glob covers is mapped', () => {
  const head = loaded([
    screen('candidates-list', { sources: ['src/features/candidates/**'] }),
    screen('jobs-list', { steps: [{ goto: '/jobs' }, { capture: 'list' }] }),
  ]);
  const a = affectedScreens({ head, base: head, changed: ['src/features/candidates/Detail.tsx', JOBS_UI], sources: {} });
  assert.deepEqual(a.unmapped, [JOBS_UI]);
});

test('unmapped: sources recorded for a screen that is not in the head map do not cover a file', () => {
  const a = affectedScreens({ head: example(), base: example(), changed: [JOBS_UI], sources: { 'jobs-list': ['x.ts'], 'gone-screen': [JOBS_UI] } });
  assert.deepEqual(a.unmapped, [JOBS_UI]);
});

test('unmapped: with no recorded and no declared sources anywhere nothing is known, so unmapped is []', () => {
  const a = affectedScreens({ head: example(), base: example(), changed: [JOBS_UI], sources: {} });
  assert.deepEqual(a.unmapped, []);
  assert.equal(a.unknown, 3, 'every screen is affected anyway');
  assert.deepEqual(affectedScreens({ head: example(), base: example(), changed: [JOBS_UI] }).unmapped, []);
});

test('unmapped: it lists the files in changed order, each once per changed entry', () => {
  assert.deepEqual(unmappedOf(['src/z/Last.tsx', 'src/a/First.tsx', 'src/features/jobs/List.tsx', 'src/m/Mid.vue']), ['src/z/Last.tsx', 'src/a/First.tsx', 'src/m/Mid.vue']);
});

test('unmapped: nothing changed gives []', () => {
  assert.deepEqual(unmappedOf([]), []);
});

test('unmapped: it does not change names, why or skipped', () => {
  const a = affectedScreens({ head: example(), base: example(), changed: [JOBS_UI], sources: SOURCES });
  assert.deepEqual(a.names, []);
  assert.deepEqual(a.why, {});
  assert.deepEqual(a.mapThese, ['candidates-list']);
  assert.deepEqual(a.skipped, ['candidates-list', 'candidate-detail', 'jobs-list']);
  assert.deepEqual(a.unmapped, [JOBS_UI]);
});

test('unmapped: profile.affected.ui replaces the extension list', () => {
  const profile = { affected: { ui: ['.xhtml'] } };
  assert.deepEqual(unmappedOf(['a.xhtml', JOBS_UI], { profile }), ['a.xhtml']);
});

test('unmapped: a profile.affected.ui that is not an array is ignored', () => {
  assert.deepEqual(unmappedOf([JOBS_UI], { profile: { affected: { ui: '.tsx' } } }), [JOBS_UI]);
  assert.deepEqual(unmappedOf([JOBS_UI], { profile: { affected: {} } }), [JOBS_UI]);
});

test('unmapped: an everything trigger still reports the unmapped UI file', () => {
  assert.deepEqual(unmappedOf(['package-lock.json', JOBS_UI]), [JOBS_UI]);
});
