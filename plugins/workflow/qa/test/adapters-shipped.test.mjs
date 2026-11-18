// Behaviour tests for the two shipped adapters, adapters/node-static and adapters/supabase-api, run through
// scripts/lib/adapter.mjs. Every fixture is a temp dir under os.tmpdir(). No Docker, no network: the node-static
// tests never run npm install, and the supabase-api sign-in tests post to a node:http server on 127.0.0.1 posing as
// Supabase's auth endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { PLUGIN_ADAPTERS, runVerb, validateAdapter } from '../scripts/lib/adapter.mjs';

const t = (name, fn) => test(name, { timeout: 60000 }, fn);

let base;

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-shipped-')));
});

after(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

function dir(...parts) {
  const d = path.join(base, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function file(p, body, mode = 0o644) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, mode);
  return p;
}

const prof = (adapter, settings = {}) => ({ stack: { adapter: [adapter], settings } });

const vars = (extra = {}) => ({ port: 18420, slug: 'qa-shipped', dir: base, main: base, ...extra });

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

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

// Raw GET: the path is sent as given, so '/../x' is not normalised by the client.
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
  });
}

// Starts node-static serve detached on a free port, runs fn(port), then kills the server group.
async function withServe(qaRoot, settings, fn) {
  const port = await freePort();
  const r = await runVerb('serve', {
    profile: prof('node-static', settings),
    mainRoot: base,
    cwd: qaRoot,
    vars: vars({ port, dir: qaRoot }),
    detached: true,
    logFile: path.join(base, `serve-${port}.log`),
  });
  try {
    assert.equal(typeof r.pid, 'number', 'a detached serve reports its pid');
    await waitFor(() => listening(port), 10000);
    return await fn(port);
  } finally {
    if (typeof r.pid === 'number') killGroup(r.pid);
  }
}

// validateAdapter on the shipped adapters

t('validateAdapter: the shipped node-static adapter has no problems', () => {
  assert.deepEqual(validateAdapter(path.join(PLUGIN_ADAPTERS, 'node-static')), []);
});

t('validateAdapter: the shipped supabase-api adapter has no problems', () => {
  assert.deepEqual(validateAdapter(path.join(PLUGIN_ADAPTERS, 'supabase-api')), []);
});

// node-static: setup and build (skip paths only, so no network and no npm install)

t('node-static setup: no package.json is a skip, exit 0', async () => {
  const qaRoot = dir('ns-setup-empty');
  const r = await runVerb('setup', { profile: prof('node-static'), mainRoot: base, cwd: qaRoot, vars: vars({ dir: qaRoot }) });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /skip: no package\.json/);
});

t('node-static build: a package.json with no build script is a skip, exit 0', async () => {
  const qaRoot = dir('ns-build-noscript');
  file(path.join(qaRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'echo t' } }));
  const r = await runVerb('build', { profile: prof('node-static'), mainRoot: base, cwd: qaRoot, vars: vars({ dir: qaRoot }) });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /skip: no build script/);
});

// node-static: serve

t('node-static serve: serves index.html at / and a real asset with its content type', async () => {
  const qaRoot = dir('ns-serve-basic');
  file(path.join(qaRoot, 'dist', 'index.html'), '<!doctype html><title>shell</title>');
  file(path.join(qaRoot, 'dist', 'assets', 'app.js'), 'console.log("app");');
  await withServe(qaRoot, { dist: 'dist' }, async (port) => {
    const root = await get(port, '/');
    assert.equal(root.status, 200);
    assert.match(root.type, /^text\/html/);
    assert.match(root.body, /shell/);
    const asset = await get(port, '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.type, /javascript/);
    assert.equal(asset.body, 'console.log("app");');
  });
});

t('node-static serve: an unknown path without a file extension falls back to index.html', async () => {
  const qaRoot = dir('ns-serve-fallback');
  file(path.join(qaRoot, 'dist', 'index.html'), '<!doctype html><title>shell</title>');
  await withServe(qaRoot, { dist: 'dist' }, async (port) => {
    const deep = await get(port, '/deep/route');
    assert.equal(deep.status, 200);
    assert.match(deep.body, /shell/);
  });
});

t('node-static serve: a traversal path is refused with 403', async () => {
  const qaRoot = dir('ns-serve-traversal');
  file(path.join(qaRoot, 'dist', 'index.html'), '<!doctype html><title>shell</title>');
  file(path.join(qaRoot, 'x'), 'secret outside dist');
  await withServe(qaRoot, { dist: 'dist' }, async (port) => {
    const r = await get(port, '/../x');
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /secret outside dist/);
  });
});

t('node-static serve: no dist folder exits 1 with "run build first"', async () => {
  const qaRoot = dir('ns-serve-nodist');
  const r = await runVerb('serve', {
    profile: prof('node-static', { dist: 'dist' }),
    mainRoot: base,
    cwd: qaRoot,
    vars: vars({ dir: qaRoot }),
    timeoutMs: 10000,
  });
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
  assert.match(r.stderr, /no dist\/ — run build first/);
});

// supabase-api: routes and headers (adapter contract, STEP 6)

const lastLine = (text) => text.trimEnd().split('\n').pop();

// Runs `headers <role>` in cwd with QA_STACK and the sign-in credentials; '' leaves one unset.
function supabaseHeaders(cwd, role, { stack, user = '', password = '' }) {
  return runVerb('headers', {
    profile: prof('supabase-api'),
    mainRoot: base,
    cwd,
    args: [role],
    vars: vars({ dir: cwd }),
    env: { QA_STACK: stack, QA_USER: user, QA_PASSWORD: password },
  });
}

// A node:http server posing as Supabase's auth endpoint: answer(body) gives { status, json }.
// fn(url, seen) gets the server's URL and every request it received, in order.
async function withAuthServer(answer, fn) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const { status, json } = answer(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`, seen);
  } finally {
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }
}

t('supabase-api routes: each function directory with an index.ts or index.js is a POST route; _shared, dot and index-less directories are skipped', async () => {
  const qaRoot = dir('sb-routes');
  const functions = path.join(qaRoot, 'supabase', 'functions');
  file(path.join(functions, 'a', 'index.ts'), 'export {};');
  file(path.join(functions, 'c', 'index.js'), 'export {};');
  file(path.join(functions, '_shared', 'index.ts'), 'export {};');
  file(path.join(functions, '.cache', 'index.ts'), 'export {};');
  file(path.join(functions, 'b', 'notes.md'), 'no entry point');
  const r = await runVerb('routes', { profile: prof('supabase-api'), mainRoot: base, cwd: qaRoot, vars: vars({ dir: qaRoot }) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastLine(r.stdout)), [
    { method: 'POST', path: '/functions/v1/a' },
    { method: 'POST', path: '/functions/v1/c' },
  ]);
});

t('supabase-api routes: no functions directory prints []', async () => {
  const qaRoot = dir('sb-routes-none');
  const r = await runVerb('routes', { profile: prof('supabase-api'), mainRoot: base, cwd: qaRoot, vars: vars({ dir: qaRoot }) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastLine(r.stdout)), []);
});

t('supabase-api headers anon: the env SUPABASE_URL and anon key become the baseUrl, apikey and a bearer token', async () => {
  const qaRoot = dir('sb-headers-anon');
  const stack = JSON.stringify({ env: { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_ANON_KEY: 'anon-test-key' } });
  const r = await supabaseHeaders(qaRoot, 'anon', { stack });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { baseUrl: 'http://127.0.0.1:54321', headers: { apikey: 'anon-test-key', authorization: 'Bearer anon-test-key' } });
});

t('supabase-api headers staff: POSTs the role\'s credentials to /auth/v1/token and answers the access token as a bearer', async () => {
  const qaRoot = dir('sb-headers-staff');
  await withAuthServer(() => ({ status: 200, json: { access_token: 'staff-access-token', token_type: 'bearer' } }), async (url, seen) => {
    const stack = JSON.stringify({ env: { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: 'pub-test-key' } });
    const r = await supabaseHeaders(qaRoot, 'staff', { stack, user: 'staff@example.test', password: 'staff-test-pass' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { baseUrl: url, headers: { apikey: 'pub-test-key', authorization: 'Bearer staff-access-token' } });
    assert.equal(seen.length, 1, 'one sign-in request');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/auth/v1/token?grant_type=password');
    assert.equal(seen[0].headers.apikey, 'pub-test-key');
    assert.match(seen[0].headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(seen[0].body), { email: 'staff@example.test', password: 'staff-test-pass' });
  });
});

t('supabase-api headers: no Supabase URL or anon key in the sandbox output is stderr and exit 1', async () => {
  const qaRoot = dir('sb-headers-nokey');
  const r = await supabaseHeaders(qaRoot, 'anon', { stack: JSON.stringify({ env: { SUPABASE_URL: 'http://127.0.0.1:54321' } }) });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /headers: no Supabase URL or anon key in the sandbox output/);
});

t('supabase-api headers staff: QA_USER or QA_PASSWORD unset is stderr and exit 1, with no request made', async () => {
  const qaRoot = dir('sb-headers-nocreds');
  await withAuthServer(() => ({ status: 200, json: { access_token: 'never-sent' } }), async (url, seen) => {
    const stack = JSON.stringify({ env: { SUPABASE_URL: url, SUPABASE_ANON_KEY: 'anon-test-key' } });
    const r = await supabaseHeaders(qaRoot, 'staff', { stack, user: '', password: 'staff-test-pass' });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /headers staff: QA_USER\/QA_PASSWORD unset/);
    assert.equal(seen.length, 0, 'no sign-in is attempted without credentials');
  });
});

t('supabase-api headers staff: a sign-in answered non-2xx is stderr "sign-in answered <status>" and exit 1', async () => {
  const qaRoot = dir('sb-headers-400');
  await withAuthServer(() => ({ status: 400, json: { error: 'invalid_grant' } }), async (url) => {
    const stack = JSON.stringify({ env: { SUPABASE_URL: url, SUPABASE_ANON_KEY: 'anon-test-key' } });
    const r = await supabaseHeaders(qaRoot, 'staff', { stack, user: 'staff@example.test', password: 'wrong' });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /headers staff: sign-in answered 400/);
    assert.equal(r.json, null);
  });
});
