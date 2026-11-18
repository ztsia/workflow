// End-to-end `qa ready` (0.5.0): the real CLI, real sandboxes, a real headless browser, the shipped node-static
// adapter (npm ci, npm run build, serve dist/), a seed command and a `node --test` suite. The fixture is a temp git
// repo whose single-page app shows a home page stamped with the seed's time and a calls list read from the seed.
// R1: the seed writes no calls and stamps the time -> NOT READY, with the empty calls screen and the home screen
// that differs between two fresh seeds. R2: the seed is fixed on the integration branch -> READY, qa/ready.json
// written, `qa ready status` says ready. The tests share the repo and run in file order.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { down, list } from '../scripts/lib/sandbox.mjs';
import { loadProfile } from '../scripts/lib/profile.mjs';
import { browserSkip } from './fixtures/browser.mjs';

const skip = await browserSkip();
const t = (name, fn) => test(name, { timeout: 300000, skip }, fn);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'qa.mjs');
const BAND = [18470, 18490];

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Calls</title></head>
<body><nav><a href="/">Home</a> <a href="/calls">Calls</a></nav><main id="app"></main>
<script>
fetch('/data/calls.json').then((r) => r.json()).then((data) => {
  const app = document.getElementById('app');
  if (location.pathname === '/calls') {
    app.innerHTML = '<h1>Calls</h1>' + (data.calls.length
      ? '<ul>' + data.calls.map((c) => '<li>' + c.who + ' · ' + c.minutes + ' min</li>').join('') + '</ul>'
      : '<p>No calls yet</p>');
  } else {
    app.innerHTML = '<h1>Home</h1><p>' + (data.seededAt ? 'Seeded at ' + data.seededAt : 'Welcome back') + '</p>';
  }
});
</script></body></html>
`;
const BAD_SEED = `import fs from 'node:fs';
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/calls.json', JSON.stringify({ seededAt: new Date().toISOString(), calls: [] }));
`;
const GOOD_SEED = `import fs from 'node:fs';
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/calls.json', JSON.stringify({ calls: [{ who: 'Alice Tan', minutes: 3 }, { who: 'Ben Ong', minutes: 12 }] }));
`;
const BUILD = `import fs from 'node:fs';
fs.mkdirSync('dist/data', { recursive: true });
fs.copyFileSync('index.html', 'dist/index.html');
fs.copyFileSync('data/calls.json', 'dist/data/calls.json');
`;
const SUITE = `import test from 'node:test';
import assert from 'node:assert/strict';
test('lists calls', () => assert.equal(1 + 1, 2));
test('refuses a call with no person', () => assert.ok(true));
`;

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function cli(args, cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env, timeout: 280000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let base;
let repo;

before(() => {
  if (skip) return;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-ready-e2e-')));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q'], repo);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);
  write(repo, 'qa.json', JSON.stringify({
    stack: { adapter: ['node-static'], up: "echo 'skip: no backend'", seed: 'node seed.mjs', test: 'node --test', healthTimeoutMs: 20000 },
    viewports: { desktop: [800, 600] },
    ports: { band: BAND, reserved: [] },
    browser: { channel: 'chromium' },
  }, null, 2) + '\n');
  write(repo, 'package.json', JSON.stringify({ name: 'calls-fixture', version: '1.0.0', private: true, scripts: { build: 'node build.mjs' } }, null, 2) + '\n');
  write(repo, 'package-lock.json', JSON.stringify({ name: 'calls-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'calls-fixture', version: '1.0.0' } } }, null, 2) + '\n');
  write(repo, '.gitignore', 'qa-artifacts/\nnode_modules/\ndist/\ndata/\n');
  write(repo, 'index.html', PAGE);
  write(repo, 'build.mjs', BUILD);
  write(repo, 'seed.mjs', BAD_SEED);
  write(repo, 'test/app.test.mjs', SUITE);
  write(repo, 'qa/map/app.json', JSON.stringify({ area: 'app', screens: [
    { name: 'home', sources: ['index.html'], steps: [{ goto: '/' }, { waitFor: 'role=heading[name="Home"]' }, { capture: 'home' }] },
    { name: 'calls', sources: ['index.html'], steps: [{ goto: '/calls' }, { waitFor: 'role=heading[name="Calls"]' }, { capture: 'list' }] },
  ] }, null, 2) + '\n');
  write(repo, 'qa/routes.table.json', JSON.stringify({ routes: [], pages: [{ path: '/' }, { path: '/calls' }] }, null, 2) + '\n');
  write(repo, 'qa/suites.json', JSON.stringify({ suites: { unit: 'node --test' } }, null, 2) + '\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'calls app, a seed with no calls'], repo);
  assert.deepEqual(loadProfile(repo).errors, []);
});

t('R1 a seed with no calls that stamps its time: NOT READY, naming the empty screen and the screen two seeds disagree on', () => {
  const r = cli(['ready', '--json'], repo);
  assert.equal(r.code, 1, r.stderr.slice(-3000));
  const report = JSON.parse(r.stdout);
  assert.equal(report.ready, false);
  assert.deepEqual(report.open, ['empty:desktop/calls__list', 'det:desktop/home__home'], JSON.stringify(report.checks, null, 2));
  const walk = report.checks.find((c) => c.id === 'walk');
  assert.equal(walk.items.find((i) => i.id === 'empty:desktop/calls__list').reason, 'shows an empty state: "No calls yet"');
  for (const id of ['verbs', 'exec', 'map', 'seed', 'suites']) assert.equal(report.checks.find((c) => c.id === id).status, 'PASS', id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'qa', 'ready.json'), 'utf8')).ready, false);
  const status = cli(['ready', 'status'], repo);
  assert.equal(status.code, 1);
  assert.match(status.stdout, /^ready: not ready\nproject not proven ready: FAIL empty:desktop\/calls__list, det:desktop\/home__home\n$/);
});

t('R2 the seed fixed on the integration branch: READY, every check PASS, ready status says ready', async () => {
  write(repo, 'seed.mjs', GOOD_SEED);
  git(['add', 'seed.mjs'], repo);
  git(['commit', '-q', '-m', 'seed: fixed calls, no timestamp'], repo);
  const r = cli(['ready'], repo);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr.slice(-3000)}`);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], 'READY');
  for (const id of ['verbs', 'exec', 'map', 'seed', 'walk', 'determinism', 'suites']) assert.ok(lines.some((l) => l.startsWith(`PASS ${id} — `)), `${id}\n${r.stdout}`);
  assert.ok(lines.includes('PASS suites — 1 of 1 suite(s) name their tests and pass'), r.stdout);
  const file = JSON.parse(fs.readFileSync(path.join(repo, 'qa', 'ready.json'), 'utf8'));
  assert.equal(file.ready, true);
  assert.equal(file.commit, git(['rev-parse', 'main'], repo));
  const status = cli(['ready', 'status'], repo);
  assert.equal(status.code, 0, status.stdout);
  assert.equal(status.stdout, 'ready: ready\n');
  assert.deepEqual(await list({ mainRoot: repo }), [], 'no sandbox left up');
});

after(async () => {
  if (!base) return;
  try {
    const { profile } = loadProfile(repo);
    for (const d of await list({ mainRoot: repo })) {
      try { if (d.serverPid) process.kill(-d.serverPid, 'SIGKILL'); } catch { /* gone */ }
      try { await down({ mainRoot: repo, profile, name: d.name }); } catch { /* already down */ }
    }
  } catch { /* registry unreadable */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});
