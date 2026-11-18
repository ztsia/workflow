// Contract tests for scripts/lib/adapter.mjs. The contract is the CONTRACT comment block at the top
// of that file; each test pins one clause of it. Fixtures are generated in a temp dir: a git repo
// with qa.json and a project adapter (qa/adapters/fake), and a plugin dir with a second adapter.
// No Docker, no network, no real stack. The profile is a plain object literal, not loadProfile().
// Until adapter.mjs is built, every test fails with 'not built: …'.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { detectAdapters, listAdapters, resolveVerb, runVerb, validateAdapter } from '../scripts/lib/adapter.mjs';

const t = (name, fn) => test(name, { timeout: 60000 }, fn);

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
  up: logged('up', ['echo "noise: booting the fake stack"', `echo '${FAKE_STATE}'`]),
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

function writeAdapter(dir, adapterJson, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (adapterJson) fs.writeFileSync(path.join(dir, 'adapter.json'), JSON.stringify(adapterJson, null, 2));
  for (const [name, body] of Object.entries(files)) writeExec(path.join(dir, name), body);
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms} ms`);
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
let pluginDir;
let workDir;
let logFile;

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-adapter-')));
  mainRoot = path.join(base, 'main');
  pluginDir = path.join(base, 'plugin-adapters');
  workDir = path.join(base, 'work');
  logFile = path.join(base, 'verbs.log');
  fs.mkdirSync(mainRoot);
  fs.mkdirSync(workDir);
  git(['init', '-q'], mainRoot);
  fs.writeFileSync(path.join(mainRoot, 'qa.json'), JSON.stringify({ stack: { adapter: ['fake'] } }, null, 2) + '\n');
  writeAdapter(path.join(mainRoot, 'qa', 'adapters', 'fake'), FAKE_JSON, FAKE);
  git(['add', '-A'], mainRoot);
  git(['commit', '-q', '-m', 'fixture'], mainRoot);
  // Plugin dir: `shipped` (build only, no project copy), and a plugin `fake` that the project one shadows.
  writeAdapter(path.join(pluginDir, 'shipped'), { type: 'stack', verbs: ['build'], detect: ['shipped.marker'], description: 'fixture: shipped' }, {
    build: '#!/usr/bin/env bash\nset -euo pipefail\necho "skip: nothing"\n',
  });
  writeAdapter(path.join(pluginDir, 'fake'), { type: 'stack', verbs: ['up'], detect: [], description: 'fixture: plugin fake' }, {
    up: '#!/usr/bin/env bash\necho "plugin fake up"\n',
  });
});

after(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const profile = (stack = {}) => ({
  stack: { adapter: ['fake'], healthPath: '/', healthTimeoutMs: 15000, settings: { logFile }, ...stack },
});

const projectFake = (verb) => path.join(mainRoot, 'qa', 'adapters', 'fake', verb);

// resolveVerb

t('resolveVerb: a qa.json stack.<verb> string beats every adapter', () => {
  const r = resolveVerb('up', { profile: profile({ up: 'echo from-qa' }), mainRoot, pluginAdapters: pluginDir });
  assert.deepEqual(r, { kind: 'command', command: 'echo from-qa', source: 'qa.json' });
});

t('resolveVerb: the first adapter in stack.adapter that has the verb wins, and a verb it lacks falls through', () => {
  const plugin = resolveVerb('build', { profile: profile({ adapter: ['shipped', 'fake'] }), mainRoot, pluginAdapters: pluginDir });
  assert.deepEqual(plugin, { kind: 'exec', file: path.join(pluginDir, 'shipped', 'build'), adapter: 'shipped', source: 'plugin' });

  const project = resolveVerb('build', { profile: profile({ adapter: ['fake', 'shipped'] }), mainRoot, pluginAdapters: pluginDir });
  assert.deepEqual(project, { kind: 'exec', file: projectFake('build'), adapter: 'fake', source: 'project' });

  const fellThrough = resolveVerb('up', { profile: profile({ adapter: ['shipped', 'fake'] }), mainRoot, pluginAdapters: pluginDir });
  assert.deepEqual(fellThrough, { kind: 'exec', file: projectFake('up'), adapter: 'fake', source: 'project' });
});

t('resolveVerb: a project adapter is found before a plugin adapter of the same name', () => {
  const r = resolveVerb('up', { profile: profile(), mainRoot, pluginAdapters: pluginDir });
  assert.deepEqual(r, { kind: 'exec', file: projectFake('up'), adapter: 'fake', source: 'project' });
});

t('resolveVerb: no adapter named gives kind none, reason "none named"', () => {
  const r = resolveVerb('up', { profile: profile({ adapter: [] }), mainRoot, pluginAdapters: pluginDir });
  assert.deepEqual(r, { kind: 'none', reason: 'no adapter for up (none named)' });
});

t('resolveVerb: no adapter with a verb gives kind none, and the reason names the adapters', () => {
  const r = resolveVerb('up', { profile: profile({ adapter: ['shipped'] }), mainRoot, pluginAdapters: pluginDir });
  assert.equal(r.kind, 'none');
  assert.equal(r.reason, 'no adapter for up (shipped)');
});

t('resolveVerb: a verb outside VERBS throws "unknown verb"', async () => {
  const error = await rejectionOf(async () => resolveVerb('frobnicate', { profile: profile(), mainRoot, pluginAdapters: pluginDir }));
  assert.match(error.message, /unknown verb frobnicate/);
});

// runVerb

const vars = (extra = {}) => ({ port: 18411, slug: 'qa-abc123', dir: workDir, main: mainRoot, ...extra });

t('runVerb: {port} {slug} {dir} {main} fill a command string, and the same values reach the QA_* env', async () => {
  const r = await runVerb('up', {
    profile: profile({ up: 'echo "{port}|{slug}|{dir}|{main}|$QA_PORT|$QA_SLUG|$QA_ROOT|$QA_MAIN_ROOT"' }),
    mainRoot,
    cwd: workDir,
    vars: vars(),
    pluginAdapters: pluginDir,
  });
  assert.equal(r.code, 0);
  assert.equal(r.notRun, null);
  assert.equal(typeof r.ms, 'number');
  assert.equal(r.stdout.trim(), `18411|qa-abc123|${workDir}|${mainRoot}|18411|qa-abc123|${workDir}|${mainRoot}`);
});

t('runVerb: an exec verb gets QA_SLUG and QA_PORT from vars, and its last stdout line is the JSON state', async () => {
  const r = await runVerb('up', {
    profile: profile(),
    mainRoot,
    cwd: workDir,
    vars: vars({ port: 18412, slug: 'qa-exec01' }),
    pluginAdapters: pluginDir,
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { appUrl: null, ports: { db: 1 } });
  assert.match(r.stdout, /noise: booting the fake stack/);
  assert.ok(fs.readFileSync(logFile, 'utf8').split('\n').includes('up qa-exec01 18412'));
});

t('runVerb: a last stdout line that is not JSON gives json null', async () => {
  const r = await runVerb('up', {
    profile: profile({ up: `echo '{"a":1}'; echo done` }),
    mainRoot,
    cwd: workDir,
    vars: vars(),
    pluginAdapters: pluginDir,
  });
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
  assert.match(r.stdout, /done/);
});

t('runVerb: no adapter resolves NOT RUN with code null, never a pass', async () => {
  const r = await runVerb('up', {
    profile: profile({ adapter: [] }),
    mainRoot,
    cwd: workDir,
    vars: vars(),
    pluginAdapters: pluginDir,
  });
  assert.equal(r.code, null);
  assert.equal(r.json, null);
  assert.match(r.notRun, /^NOT RUN: no adapter for up \(none named\)/);
});

t('runVerb: timeoutMs kills the process group and resolves with code 124', async () => {
  const started = Date.now();
  const r = await runVerb('up', {
    profile: profile({ up: 'sleep 30' }),
    mainRoot,
    cwd: workDir,
    vars: vars(),
    timeoutMs: 500,
    pluginAdapters: pluginDir,
  });
  assert.equal(r.code, 124);
  assert.ok(Date.now() - started < 10000, 'the 30 s sleep was not killed');
});

t('runVerb: detached spawns its own group, appends output to logFile, and resolves at once with a pid', async () => {
  const port = await freePort();
  const serveLog = path.join(base, 'serve.log');
  const started = Date.now();
  const r = await runVerb('serve', {
    profile: profile(),
    mainRoot,
    cwd: workDir,
    vars: vars({ port, slug: 'qa-detach' }),
    detached: true,
    logFile: serveLog,
    pluginAdapters: pluginDir,
  });
  try {
    assert.ok(Date.now() - started < 5000, 'a detached run must not wait for the server');
    assert.equal(r.code, null);
    assert.equal(typeof r.pid, 'number');
    await waitFor(() => listening(port), 10000);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
    assert.match(fs.readFileSync(serveLog, 'utf8'), new RegExp(`serving ${port}`));
  } finally {
    if (typeof r?.pid === 'number') killGroup(r.pid);
  }
});

// listAdapters / detectAdapters

t('listAdapters: project adapters first, then plugin ones, and a project adapter shadows a plugin one of the same name', () => {
  const rows = listAdapters({ mainRoot, pluginAdapters: pluginDir });
  assert.deepEqual(rows.map((a) => [a.name, a.source]), [['fake', 'project'], ['shipped', 'plugin']]);
  const fake = rows[0];
  assert.equal(fake.dir, path.join(mainRoot, 'qa', 'adapters', 'fake'));
  assert.deepEqual([...fake.verbs].sort(), Object.keys(FAKE).sort());
  assert.deepEqual(fake.detect, ['fake.marker']);
  assert.equal(fake.description, 'fixture: a fake stack');
  assert.equal(rows[1].dir, path.join(pluginDir, 'shipped'));
  assert.deepEqual(rows[1].verbs, ['build']);
});

t('detectAdapters: names nothing when no detect file exists under root', () => {
  const root = path.join(base, 'empty-root');
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(detectAdapters({ root, mainRoot, pluginAdapters: pluginDir }), []);
});

t('detectAdapters: names an adapter whose detect file exists under root', () => {
  const root = path.join(base, 'marked-root');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'fake.marker'), '');
  assert.deepEqual(detectAdapters({ root, mainRoot, pluginAdapters: pluginDir }), ['fake']);
});

// validateAdapter

const mk = (name) => {
  const dir = path.join(base, 'validate', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

t('validateAdapter: a complete adapter (each listed verb an executable, nothing extra) has no problems', () => {
  assert.deepEqual(validateAdapter(path.join(mainRoot, 'qa', 'adapters', 'fake')), []);
});

t('validateAdapter: flags a missing adapter.json', () => {
  const dir = mk('no-json');
  writeExec(path.join(dir, 'up'), FAKE.up);
  const problems = validateAdapter(dir);
  assert.ok(problems.some((p) => /adapter\.json/.test(p)), JSON.stringify(problems));
});

t('validateAdapter: flags a verb listed in adapter.json with no executable', () => {
  const dir = mk('listed-no-file');
  writeAdapter(dir, { type: 'stack', verbs: ['up', 'seed'], detect: [], description: 'x' }, { up: FAKE.up });
  const problems = validateAdapter(dir);
  assert.ok(problems.some((p) => /seed/.test(p)), JSON.stringify(problems));
});

t('validateAdapter: flags an executable that adapter.json does not list', () => {
  const dir = mk('file-not-listed');
  writeAdapter(dir, { type: 'stack', verbs: ['up'], detect: [], description: 'x' }, { up: FAKE.up, seed: FAKE.seed });
  const problems = validateAdapter(dir);
  assert.ok(problems.some((p) => /seed/.test(p)), JSON.stringify(problems));
});

t('validateAdapter: flags a listed executable that lacks the execute bit', () => {
  const dir = mk('no-exec-bit');
  writeAdapter(dir, { type: 'stack', verbs: ['up'], detect: [], description: 'x' });
  writeExec(path.join(dir, 'up'), FAKE.up, 0o644);
  const problems = validateAdapter(dir);
  assert.ok(problems.some((p) => /up/.test(p) && /exec/i.test(p)), JSON.stringify(problems));
});

t('validateAdapter: flags a listed verb that is not a known verb', () => {
  const dir = mk('unknown-verb');
  writeAdapter(dir, { type: 'stack', verbs: ['up', 'frobnicate'], detect: [], description: 'x' }, { up: FAKE.up, frobnicate: FAKE.up });
  const problems = validateAdapter(dir);
  assert.ok(problems.some((p) => /frobnicate/.test(p) && /unknown/i.test(p)), JSON.stringify(problems));
});
