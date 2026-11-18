// Contract tests for scripts/lib/sandbox.mjs. The contract is the comment block at the top of that
// file; each test pins one clause of it. The fixture is a temp git repo (two commits, so two SHAs)
// with qa.json and a project adapter at qa/adapters/fake: no Docker, no network, no real stack.
// The profile is a plain object literal, not loadProfile().
// The tests share the repo and run in file order: upAt() reuses a live sandbox, so each test can
// stand alone. after() downs every sandbox and kills any server left in the registry, even when a
// test fails. Until sandbox.mjs is built, every test fails with 'not built: …'.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { claimPort, down, list, nameFor, othersUsing, reap, status, up } from '../scripts/lib/sandbox.mjs';
import { running, under } from '../scripts/lib/procs.mjs';

const t = (name, fn) => test(name, { timeout: 90000 }, fn);
const BAND = [18410, 18430];
const quiet = () => {};

// Fake project adapter. Each verb appends "<verb> <slug> <port>" to the log named in QA_SETTINGS.
const logged = (verb, rest = []) => [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  `LOG=$(node -e 'process.stdout.write(JSON.parse(process.env.QA_SETTINGS).logFile)')`,
  `echo "${verb} \${QA_SLUG:-} \${QA_PORT:-}" >> "$LOG"`,
  ...rest,
].join('\n') + '\n';
const FAKE_STATE = '{"appUrl":null,"ports":{"db":1}}';
const SERVE_JS = "require('http').createServer((q, s) => s.end('ok')).listen(process.env.QA_PORT, '127.0.0.1')";
const FAKE = {
  setup: logged('setup'),
  // strayFile: a helper that leaves the stack's process group (setsid), the way a seed server or a test fake does.
  up: logged('up', [
    `STRAY=$(node -e 'process.stdout.write(JSON.parse(process.env.QA_SETTINGS).strayFile ?? "")')`,
    'if [ -n "$STRAY" ]; then setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "$STRAY"; fi',
    'echo "noise: booting the fake stack"', `echo '${FAKE_STATE}'`,
  ]),
  down: logged('down'),
  seed: logged('seed'),
  build: logged('build', [`node -e 'process.exit(JSON.parse(process.env.QA_SETTINGS).failBuild ? 1 : 0)'`]),
  serve: logged('serve', ['echo "serving $QA_PORT"', `exec node -e "${SERVE_JS}"`]),
};
const FAKE_JSON = { type: 'stack', verbs: Object.keys(FAKE), detect: ['fake.marker'], description: 'fixture: a fake stack' };

function writeExec(file, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

// The error a call throws. A stub's 'not built' error is rethrown as is, so it is the failure reported.
async function rejectionOf(fn) {
  try {
    await fn();
  } catch (error) {
    if (/^not built: /.test(error.message)) throw error;
    return error;
  }
  throw new Error('expected the call to throw, but it returned');
}

let base;
let mainRoot;
let logFile;
let SHA1;
let SHA2;

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-sandbox-')));
  mainRoot = path.join(base, 'repo');
  logFile = path.join(base, 'verbs.log');
  fs.mkdirSync(mainRoot);
  git(['init', '-q'], mainRoot);
  fs.writeFileSync(path.join(mainRoot, 'qa.json'), JSON.stringify({ stack: { adapter: ['fake'] } }, null, 2) + '\n');
  writeExec(path.join(mainRoot, 'qa', 'adapters', 'fake', 'adapter.json'), JSON.stringify(FAKE_JSON), 0o644);
  for (const [verb, body] of Object.entries(FAKE)) writeExec(path.join(mainRoot, 'qa', 'adapters', 'fake', verb), body);
  fs.writeFileSync(path.join(mainRoot, 'app.txt'), 'first\n');
  git(['add', '-A'], mainRoot);
  git(['commit', '-q', '-m', 'first'], mainRoot);
  SHA1 = git(['rev-parse', 'HEAD'], mainRoot);
  fs.writeFileSync(path.join(mainRoot, 'app.txt'), 'second\n');
  git(['commit', '-q', '-am', 'second'], mainRoot);
  SHA2 = git(['rev-parse', 'HEAD'], mainRoot);
});

after(async () => {
  if (!mainRoot) return;
  const dir = path.join(mainRoot, 'qa-artifacts', 'sandboxes');
  const registryFiles = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
  const names = new Set([nameFor(SHA1), nameFor(SHA2)]);
  const killLeftovers = () => {
    for (const file of registryFiles()) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        names.add(entry.name);
        if (entry.serverPid) killGroup(entry.serverPid);
      } catch { /* unreadable entry: nothing to kill */ }
    }
  };
  killLeftovers();
  for (const name of names) {
    try { await down({ mainRoot, profile: profileFor(), name }); } catch { /* not up, or already down */ }
  }
  killLeftovers();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

function profileFor(settings = {}) {
  return {
    map: 'qa/map',
    base: 'sandbox',
    viewports: { desktop: [1440, 900] },
    modes: ['light'],
    ports: { band: BAND, reserved: [] },
    workers: 1,
    browser: { channel: 'chrome' },
    stack: { adapter: ['fake'], healthPath: '/', healthTimeoutMs: 15000, settings: { logFile, ...settings } },
    settle: { timeoutMs: 10000, quietMs: 500, hidden: null },
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
  };
}

function upAt(at, { seed, profile } = {}) {
  return up({
    mainRoot,
    profile: profile ?? profileFor(),
    at,
    log: quiet,
    ...(seed === undefined ? {} : { seed }),
  });
}

const registryPath = (name) => path.join(mainRoot, 'qa-artifacts', 'sandboxes', `${name}.json`);
const gitIn = (dir, args) => git(args, dir);
const worktreeList = () => gitIn(mainRoot, ['worktree', 'list', '--porcelain']);

// Verb names logged for one slug, in the order they ran.
function logVerbs(slug) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    .map((line) => line.split(' '))
    .filter(([, s]) => s === slug)
    .map(([verb]) => verb);
}

t('up at the first SHA returns a descriptor with every contract field', async () => {
  const d = await upAt(SHA1);
  assert.equal(d.name, nameFor(SHA1));
  assert.match(d.name, /^qa-[0-9a-f]{10}$/);
  assert.equal(d.slug, d.name);
  assert.equal(d.mainRoot, mainRoot);
  assert.equal(d.at, SHA1);
  assert.equal(d.sha, SHA1);
  assert.ok(typeof d.shaShort === 'string' && d.shaShort.length >= 7 && SHA1.startsWith(d.shaShort));
  assert.ok(Number.isInteger(d.port) && d.port >= BAND[0] && d.port <= BAND[1], `port ${d.port}`);
  assert.equal(d.appUrl, `http://127.0.0.1:${d.port}`);
  assert.deepEqual(d.stack, { appUrl: null, ports: { db: 1 } });
  assert.ok(Number.isInteger(d.serverPid));
  assert.equal(new Date(d.bootedAt).toISOString(), d.bootedAt);
  assert.ok(Array.isArray(d.steps) && d.steps.every((s) => ['verb', 'code', 'ms', 'notRun'].every((k) => k in s)));
  assert.ok(Array.isArray(d.warnings));
  assert.notEqual(d.reused, true);
});

t('the worktree sits outside the repo under the .qa- prefix, and the registry file is mode 0600', async () => {
  const d = await upAt(SHA1);
  assert.equal(d.dir, path.join(path.dirname(mainRoot), `.qa-${path.basename(mainRoot)}-${d.name}`));
  assert.ok(path.basename(d.dir).startsWith('.qa-'));
  assert.ok(!d.dir.startsWith(mainRoot + path.sep));
  assert.equal(gitIn(d.dir, ['rev-parse', 'HEAD']), SHA1);
  const st = fs.statSync(registryPath(d.name));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(registryPath(d.name), 'utf8')).name, d.name);
});

t('the app URL answers ok', async () => {
  const d = await upAt(SHA1);
  const res = await fetch(d.appUrl);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

t('steps run in the order setup, up, seed, build, serve', async () => {
  const d = await upAt(SHA1);
  assert.deepEqual(d.steps.map((s) => s.verb), ['setup', 'up', 'seed', 'build', 'serve']);
  assert.deepEqual(logVerbs(d.slug).slice(0, 5), ['setup', 'up', 'seed', 'build', 'serve']);
});

t('up at the same SHA again returns reused: true and the same port', async () => {
  const first = await upAt(SHA1);
  const again = await upAt(SHA1);
  assert.equal(again.reused, true);
  assert.equal(again.port, first.port);
  assert.equal(again.name, first.name);
});

t('seed:false skips the seed step', async () => {
  const d = await upAt(SHA2, { seed: false });
  assert.ok(!d.steps.some((s) => s.verb === 'seed'), JSON.stringify(d.steps));
  assert.ok(!logVerbs(d.slug).includes('seed'));
  assert.deepEqual(d.steps.map((s) => s.verb), ['setup', 'up', 'build', 'serve']);
});

t('list() returns the registry sorted by bootedAt', async () => {
  const a = await upAt(SHA1);
  const b = await upAt(SHA2);
  const rows = list({ mainRoot });
  const names = rows.map((r) => r.name);
  assert.ok(names.includes(a.name) && names.includes(b.name), JSON.stringify(names));
  assert.ok(names.indexOf(a.name) < names.indexOf(b.name), 'the earlier sandbox comes first');
  const times = rows.map((r) => Date.parse(r.bootedAt));
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
});

t('an unknown ref throws a message that names it', async () => {
  const error = await rejectionOf(() => upAt('no-such-ref-for-qa'));
  assert.match(error.message, /unknown ref/);
});

t('a failing build is BLOCKED and leaves no worktree, no registry file and no listening server', async () => {
  const keep = await upAt(SHA1);
  if (list({ mainRoot }).some((r) => r.name === nameFor(SHA2))) {
    await down({ mainRoot, profile: profileFor(), name: nameFor(SHA2) });
  }
  const error = await rejectionOf(() => upAt(SHA2, { profile: profileFor({ failBuild: true }) }));
  assert.equal(error.code, 'BLOCKED');
  assert.match(error.message, /BLOCKED ON INFRASTRUCTURE: build/);
  // The main checkout sits at SHA2 too, so look for the failed sandbox's own worktree path, not the SHA.
  assert.ok(!worktreeList().includes(nameFor(SHA2)), 'the failed sandbox worktree was left behind');
  assert.ok(worktreeList().includes(nameFor(SHA1)), 'the kept sandbox is still listed');
  assert.equal(fs.existsSync(registryPath(nameFor(SHA2))), false);
  assert.ok(!list({ mainRoot }).some((r) => r.name === nameFor(SHA2)));
  for (let port = BAND[0]; port <= BAND[1]; port++) {
    if (port !== keep.port) assert.equal(await listening(port), false, `port ${port} is listening`);
  }
});

t('status is alive, then down removes the worktree and registry file and frees the port', async () => {
  const d = await upAt(SHA1);
  const st = await status({ mainRoot, name: d.name });
  assert.equal(st.alive, true);
  const r = await down({ mainRoot, profile: profileFor(), name: d.name });
  assert.equal(r.name, d.name);
  assert.ok(Array.isArray(r.warnings));
  assert.equal(fs.existsSync(d.dir), false, 'worktree dir still exists');
  assert.equal(fs.existsSync(registryPath(d.name)), false, 'registry file still exists');
  assert.ok(!worktreeList().includes(`worktree ${d.dir}`), 'git still lists the worktree');
  assert.equal(await listening(d.port), false, 'port still listening');
});

t('down of an unknown name throws "no sandbox"', async () => {
  const error = await rejectionOf(() => down({ mainRoot, profile: profileFor(), name: 'qa-0000000000' }));
  assert.match(error.message, /no sandbox/);
});

t('reap removes an entry whose dir was deleted by hand', async () => {
  const d = await upAt(SHA2);
  fs.rmSync(d.dir, { recursive: true, force: true });
  const names = await reap({ mainRoot, profile: profileFor() });
  assert.ok(names.includes(d.name), JSON.stringify(names));
  assert.equal(fs.existsSync(registryPath(d.name)), false, 'registry file still exists');
  assert.ok(!list({ mainRoot }).some((r) => r.name === d.name));
});

test('a port claim releases even while a client holds an idle connection to it', { timeout: 10000 }, async () => {
  // Something on the machine (a browser tab, a port prober) can connect to the claimed port and sit
  // there. Release must not wait for it: up() awaited it forever and Node exited 0 mid-run.
  const claim = await claimPort(18710, 18730, new Set());
  assert.ok(claim, 'no free port in 18710-18730');
  const client = net.connect(claim.port, '127.0.0.1');
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  client.on('error', () => {}); // the claim may reset it
  const released = await Promise.race([
    claim.release().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  client.destroy();
  assert.equal(released, true, 'release() did not resolve within 2 s');
});

// ---- step 3: seedStartedAt ----------------------------------------------------------------------------------------

// A fresh sandbox at this commit: a live one from an earlier test would be reused, with its old descriptor.
async function freshUp(sha, opts) {
  if (list({ mainRoot }).some((r) => r.name === nameFor(sha))) await down({ mainRoot, profile: profileFor(), name: nameFor(sha) });
  return up({ mainRoot, profile: profileFor(), at: sha, log: quiet, ...opts });
}

t('a seeded up records seedStartedAt: an ISO time between the call start and end, kept in the registry, status and list', async () => {
  const before = Date.now();
  const d = await freshUp(SHA1, { seed: true });
  const after = Date.now();
  assert.equal(typeof d.seedStartedAt, 'string', `seedStartedAt is ${d.seedStartedAt}`);
  assert.equal(new Date(d.seedStartedAt).toISOString(), d.seedStartedAt);
  const at = Date.parse(d.seedStartedAt);
  assert.ok(at >= before && at <= after, `${d.seedStartedAt} is outside ${before}..${after}`);
  assert.equal(JSON.parse(fs.readFileSync(registryPath(d.name), 'utf8')).seedStartedAt, d.seedStartedAt);
  assert.equal((await status({ mainRoot, name: d.name })).seedStartedAt, d.seedStartedAt);
  assert.equal(list({ mainRoot }).find((r) => r.name === d.name).seedStartedAt, d.seedStartedAt);
});

t('an up with seed: false records seedStartedAt null, in the descriptor and the registry', async () => {
  const d = await freshUp(SHA2, { seed: false });
  assert.equal(d.seedStartedAt, null, `seedStartedAt is ${d.seedStartedAt}`);
  assert.equal(JSON.parse(fs.readFileSync(registryPath(d.name), 'utf8')).seedStartedAt, null);
});

// ── leftovers (2026-11-12: servers outlived their verify) ──────────────────────

const pidAlive = running;

test('down stops a process the stack left running inside the sandbox, outside the server group, and says so', { timeout: 90000, skip: process.platform !== 'linux' && 'needs /proc' }, async () => {
  const strayFile = path.join(base, 'stray.pid');
  for (const sha of [SHA1, SHA2]) { try { await down({ mainRoot, profile: profileFor(), name: nameFor(sha) }); } catch { /* not up */ } }
  const d = await up({ mainRoot, profile: profileFor({ strayFile }), at: SHA1, seed: false, log: quiet });
  const stray = Number(fs.readFileSync(strayFile, 'utf8'));
  assert.ok(pidAlive(stray), 'the fixture helper runs');
  assert.ok(under(d.dir).some((p) => p.pid === stray), 'procs.under finds it by its working directory');
  const r = await down({ mainRoot, profile: profileFor(), name: d.name });
  const gone = !pidAlive(stray);
  if (!gone) killGroup(stray);
  assert.ok(gone, 'the helper outlived down');
  assert.ok(r.warnings.some((w) => w.includes(String(stray))), `no warning names it: ${r.warnings.join(' | ')}`);
});

t('up takes down a sandbox whose run has ended, and keeps one the prepare check handed off', async () => {
  const a = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: quiet });
  assert.equal(a.owner?.pid, process.pid, 'up records its owner');
  const dead = { pid: 2 ** 22 + 7, start: '1' };
  fs.writeFileSync(registryPath(a.name), JSON.stringify({ ...JSON.parse(fs.readFileSync(registryPath(a.name), 'utf8')), owner: dead }));
  const b = await up({ mainRoot, profile: profileFor(), at: SHA2, seed: false, log: quiet });
  assert.ok(!fs.existsSync(registryPath(a.name)), 'the orphan is still registered');
  assert.ok(!fs.existsSync(a.dir), 'the orphan worktree is still there');
  fs.writeFileSync(registryPath(b.name), JSON.stringify({ ...JSON.parse(fs.readFileSync(registryPath(b.name), 'utf8')), owner: dead, handOff: 'prepare' }));
  const again = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: quiet });
  assert.ok(fs.existsSync(registryPath(b.name)), 'a handed-off sandbox was reaped');
  await down({ mainRoot, profile: profileFor(), name: again.name });
  await down({ mainRoot, profile: profileFor(), name: b.name });
});

t('up takes down a handed-off sandbox at a commit no checkout is at any more (1.0.3)', async () => {
  for (const sha of [SHA1, SHA2]) { try { await down({ mainRoot, profile: profileFor(), name: nameFor(sha) }); } catch { /* not up */ } }
  // The main checkout is at SHA2, so a hand-off at SHA1 can never be claimed.
  const a = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: quiet });
  fs.writeFileSync(registryPath(a.name), JSON.stringify({ ...JSON.parse(fs.readFileSync(registryPath(a.name), 'utf8')), owner: undefined, handOff: 'prepare' }));
  const b = await up({ mainRoot, profile: profileFor(), at: SHA2, seed: false, log: quiet });
  assert.ok(!fs.existsSync(registryPath(a.name)), 'the stale hand-off is still registered');
  await down({ mainRoot, profile: profileFor(), name: b.name });
});


// ── one boot per commit, shared sandboxes (1.0.4: two verifies on one base) ─────────────

const bootPath = (name) => registryPath(name).replace(/\.json$/, '.boot');
const downAll = async () => { for (const sha of [SHA1, SHA2]) { try { await down({ mainRoot, profile: profileFor(), name: nameFor(sha) }); } catch { /* not up */ } } };

t('up at a commit another live run is still booting waits for it instead of taking its worktree, then goes on', async () => {
  await downAll();
  const name = nameFor(SHA1);
  fs.mkdirSync(path.dirname(bootPath(name)), { recursive: true });
  fs.writeFileSync(bootPath(name), JSON.stringify({ pid: process.ppid }));
  const said = [];
  setTimeout(() => fs.rmSync(bootPath(name), { force: true }), 1500);
  const d = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: (l) => said.push(l) });
  assert.ok(said.some((l) => /another run \(pid \d+\) is starting it; waiting/.test(l)), said.join(' | '));
  assert.ok(!fs.existsSync(bootPath(name)), 'up left its boot mark behind');
  await down({ mainRoot, profile: profileFor(), name: d.name });
});

t('a boot mark whose process has ended is taken over at once', async () => {
  await downAll();
  const name = nameFor(SHA1);
  fs.writeFileSync(bootPath(name), JSON.stringify({ pid: 2 ** 22 + 7, start: '1' }));
  const said = [];
  const d = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: (l) => said.push(l) });
  assert.ok(!said.some((l) => /is starting it/.test(l)), said.join(' | '));
  await down({ mainRoot, profile: profileFor(), name: d.name });
});

t('a sandbox another running run reuses is never reaped as an orphan, and othersUsing names that run', async () => {
  await downAll();
  const a = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: quiet });
  const reader = { pid: process.ppid };
  fs.writeFileSync(registryPath(a.name), JSON.stringify({ ...JSON.parse(fs.readFileSync(registryPath(a.name), 'utf8')), owner: { pid: 2 ** 22 + 7, start: '1' }, users: [reader] }));
  assert.deepEqual(othersUsing({ mainRoot, name: a.name }).map((o) => o.pid), [process.ppid]);
  const b = await up({ mainRoot, profile: profileFor(), at: SHA2, seed: false, log: quiet });
  assert.ok(fs.existsSync(registryPath(a.name)), 'a sandbox a running run reuses was reaped');
  await down({ mainRoot, profile: profileFor(), name: a.name });
  await down({ mainRoot, profile: profileFor(), name: b.name });
});

t('a reuse records the reusing process as a user', async () => {
  await downAll();
  const a = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: quiet });
  const again = await up({ mainRoot, profile: profileFor(), at: SHA1, seed: false, log: quiet });
  assert.equal(again.reused, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath(a.name), 'utf8')).users.map((u) => u.pid), [process.pid]);
  await down({ mainRoot, profile: profileFor(), name: a.name });
});
