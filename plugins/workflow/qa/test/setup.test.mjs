// Contract tests for scripts/lib/setup.mjs (the CONTRACT comment at the top of that file is the spec).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { validateProfile } from '../scripts/lib/profile.mjs';
import { QUESTIONS, detectSuites, draftProfile, writeSetup } from '../scripts/lib/setup.mjs';

const template = (name) => fs.readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8');

// The contract's Example: the answers and the profile they draft to.
const EXAMPLE_ANSWERS = {
  stack: { adapter: ['supabase-api', 'node-static'], build: 'npm run build' },
  login: { staff: { mode: 'form', path: '/auth', from: 'adapter' } },
  base: 'sandbox',
  viewports: 'desktop+phone',
  sensitive: ['supabase/migrations/**'],
};
const EXAMPLE_PROFILE = {
  map: 'qa/map',
  stack: { adapter: ['supabase-api', 'node-static'], build: 'npm run build' },
  login: { staff: { mode: 'form', path: '/auth', from: 'adapter' } },
  base: 'sandbox',
  viewports: { desktop: [1440, 900], phone: [390, 844] },
  sensitive: ['supabase/migrations/**'],
};

// The five files a fresh project starts with, in the order writeSetup writes them.
const ALL = ['qa.json', 'qa/map/example.json', 'qa/standing.md', 'qa/escapes.md', 'qa/seed.json'];

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
function tempRoot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-setup-')));
  made.push(dir);
  return dir;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('setup: QUESTIONS', () => {
  it('the five questions, in order, as { key, ask } with the exact asks; the list is frozen', () => {
    assert.ok(Object.isFrozen(QUESTIONS));
    assert.deepEqual(QUESTIONS.map((q) => [q.key, q.ask]), [
      ['stack', 'How does the app start? (a Node app built to dist/, a ready-made adapter, or commands for build and serve)'],
      ['login', 'Which roles log in, and how? (a form at a path with env names for user and password, a saved browser state, or by hand once)'],
      ['base', 'What is the before side? (a sandbox of the base commit, or a live URL when there is no local backend)'],
      ['viewports', 'Which screen sizes? (desktop; desktop and phone)'],
      ['sensitive', 'Which paths are sensitive? (auth, payments, migrations… as globs; a fix there always gets a fresh plan)'],
    ]);
  });
});

describe('setup: draftProfile', () => {
  it('the contract Example: the answers draft to exactly the profile it shows', () => {
    assert.deepEqual(draftProfile(EXAMPLE_ANSWERS), EXAMPLE_PROFILE);
  });

  it('the Example profile passes validateProfile with no errors', () => {
    assert.deepEqual(validateProfile(draftProfile(EXAMPLE_ANSWERS)).errors, []);
  });

  it('a stack with no adapter takes the detected adapters', () => {
    const answers = { ...EXAMPLE_ANSWERS, stack: { build: 'npm run build', serve: 'npx serve dist' } };
    assert.deepEqual(draftProfile(answers, { detected: ['node-static'] }).stack,
      { build: 'npm run build', serve: 'npx serve dist', adapter: ['node-static'] });
  });

  it('a stack that names an adapter keeps it; detected adapters are not used', () => {
    assert.deepEqual(draftProfile(EXAMPLE_ANSWERS, { detected: ['other'] }).stack.adapter, ['supabase-api', 'node-static']);
  });

  it("viewports 'desktop' is { desktop: [1440, 900] }", () => {
    assert.deepEqual(draftProfile({ ...EXAMPLE_ANSWERS, viewports: 'desktop' }).viewports, { desktop: [1440, 900] });
  });

  it('storage-state and manual roles keep only their mode', () => {
    const login = { qa: { mode: 'storage-state' }, ops: { mode: 'manual' } };
    assert.deepEqual(draftProfile({ ...EXAMPLE_ANSWERS, login }).login, { qa: { mode: 'storage-state' }, ops: { mode: 'manual' } });
  });

  it('a form role with env names keeps its mode, path, user and password', () => {
    const login = { staff: { mode: 'form', path: '/auth', user: 'QA_HR_EMAIL', password: 'QA_HR_PASSWORD' } };
    const staff = draftProfile({ ...EXAMPLE_ANSWERS, login }).login.staff;
    assert.equal(staff.mode, 'form');
    assert.equal(staff.path, '/auth');
    assert.equal(staff.user, 'QA_HR_EMAIL');
    assert.equal(staff.password, 'QA_HR_PASSWORD');
  });

  it("a user that is a value, not an env name, is refused with 'login staff: user must be an env NAME, not a value'", () => {
    const login = { staff: { mode: 'form', path: '/auth', user: 'secret123', password: 'QA_HR_PASSWORD' } };
    assert.throws(() => draftProfile({ ...EXAMPLE_ANSWERS, login }),
      { name: 'Error', message: 'login staff: user must be an env NAME, not a value' });
  });

  it("a password that is a value, not an env name, is refused with 'login staff: password must be an env NAME, not a value'", () => {
    const login = { staff: { mode: 'form', path: '/auth', user: 'QA_HR_EMAIL', password: 'hunter2' } };
    assert.throws(() => draftProfile({ ...EXAMPLE_ANSWERS, login }),
      { name: 'Error', message: 'login staff: password must be an env NAME, not a value' });
  });

  it("an invalid profile is refused as 'qa.json would not be valid: <first error>'", () => {
    assert.throws(() => draftProfile({ ...EXAMPLE_ANSWERS, base: 42 }),
      (err) => err instanceof Error && /^qa\.json would not be valid: .+/.test(err.message));
  });
});

describe('setup: writeSetup', () => {
  it('a fresh directory gets qa.json, qa/map/example.json, qa/standing.md, qa/escapes.md, qa/seed.json in that order', () => {
    const root = tempRoot();
    const result = writeSetup(root, draftProfile(EXAMPLE_ANSWERS), { today: '2026-11-07' });
    assert.deepEqual(result, { written: ALL, kept: [] });
    for (const rel of ALL) assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists`);
  });

  it('the qa/ files hold the templates byte for byte', () => {
    const root = tempRoot();
    writeSetup(root, draftProfile(EXAMPLE_ANSWERS), { today: '2026-11-07' });
    assert.equal(read(root, 'qa/map/example.json'), template('map.example.json'));
    assert.equal(read(root, 'qa/standing.md'), template('standing.md'));
    assert.equal(read(root, 'qa/escapes.md'), template('escapes.md'));
    assert.equal(read(root, 'qa/seed.json'), template('seed.example.json'));
  });

  it('a second call keeps every file and writes nothing', () => {
    const root = tempRoot();
    writeSetup(root, draftProfile(EXAMPLE_ANSWERS), { today: '2026-11-07' });
    const again = writeSetup(root, draftProfile(EXAMPLE_ANSWERS), { today: '2026-11-07' });
    assert.deepEqual(again, { written: [], kept: ALL });
  });

  it('force rewrites qa.json only; the qa/ files it leaves are untouched', () => {
    const root = tempRoot();
    writeSetup(root, draftProfile(EXAMPLE_ANSWERS), { today: '2026-11-07' });
    fs.writeFileSync(path.join(root, 'qa/standing.md'), 'the team wrote this\n');
    const second = draftProfile({ ...EXAMPLE_ANSWERS, base: 'https://staging.example.test' });
    const result = writeSetup(root, second, { force: true, today: '2026-11-07' });
    assert.deepEqual(result.written, ['qa.json']);
    assert.equal(read(root, 'qa.json'), JSON.stringify(second, null, 2) + '\n');
    assert.equal(read(root, 'qa/standing.md'), 'the team wrote this\n');
  });

  it('an existing qa/map/x.json means no example.json; the other four are still written', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'qa/map'), { recursive: true });
    fs.writeFileSync(path.join(root, 'qa/map/x.json'), '{}\n');
    const result = writeSetup(root, draftProfile(EXAMPLE_ANSWERS), { today: '2026-11-07' });
    assert.ok(!result.written.includes('qa/map/example.json'), 'no example.json is written');
    assert.ok(!fs.existsSync(path.join(root, 'qa/map/example.json')));
    assert.deepEqual(result.written, ['qa.json', 'qa/standing.md', 'qa/escapes.md', 'qa/seed.json']);
  });

  it('qa.json is 2-space JSON with a final newline and reads back as the same profile', () => {
    const root = tempRoot();
    const profile = draftProfile(EXAMPLE_ANSWERS);
    writeSetup(root, profile, { today: '2026-11-07' });
    const text = read(root, 'qa.json');
    assert.equal(text, JSON.stringify(profile, null, 2) + '\n');
    assert.deepEqual(JSON.parse(text), profile);
  });
});

describe('detectSuites (0.5.0)', () => {
  const put = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  it('proposes each runner the project has (the bizassist case: tests but no registry)', async () => {
    const root = tempRoot();
    put(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run && eslint .' }, devDependencies: { vitest: '^2', '@playwright/test': '^1' } }));
    put(root, 'pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"\n');
    const r = await detectSuites(root);
    assert.equal(r.registry, null);
    assert.deepEqual(r.proposed.map((s) => [s.id, s.suite, s.runner]), [
      ['unit', 'npx vitest run', 'vitest'], ['e2e', 'npx playwright test', 'playwright'], ['py', 'python -m pytest', 'pytest'],
    ]);
  });

  it('a plain runner test script is proposed as written; jest beside it gets its own id', async () => {
    const root = tempRoot();
    put(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test test/' }, devDependencies: { jest: '^29' } }));
    assert.deepEqual((await detectSuites(root)).proposed.map((s) => [s.id, s.suite, s.why]), [
      ['unit', 'node --test test/', 'package.json scripts.test'], ['jest', 'npx jest', 'jest in package.json'],
    ]);
  });

  it('a suite the registry already has is not proposed again', async () => {
    const root = tempRoot();
    put(root, 'package.json', JSON.stringify({ devDependencies: { vitest: '^2' } }));
    put(root, 'qa/mutants.json', JSON.stringify({ suites: { unit: 'npx vitest run' }, mutants: [] }));
    const r = await detectSuites(root);
    assert.equal(r.registry, 'qa/mutants.json');
    assert.deepEqual(r.existing, { unit: 'npx vitest run' });
    assert.deepEqual(r.proposed, []);
  });
});
