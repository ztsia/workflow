// Contract tests for rework U5 (design §5, D30): `qa prepare check` against a small fixture app on node:http, in a
// real headless browser. The library takes an overlay folder (the CLI sets none: the PR's QA files are the branch's own qa/).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import { blockedText, prepareCheck, prepareExit, prepareMd } from '../scripts/lib/prepare.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const made = [];
let server;
let baseUrl;
let port;

const PAGES = {
  '/orders': '<h1>Orders</h1><ul><li>Order 1 — Kite</li><li>Order 2 — Lark</li></ul>',
  '/invoices': '<h1>Invoices</h1><p>No data</p>',
  '/reports': '<h1>Reports</h1>',
};

before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/orders') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[{"id":1}]'); return; }
    if (p === '/api/broken') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return; }
    const page = PAGES[p] ?? (p === '/' ? '<h1>Home</h1>' : null);
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ? `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${page}</body></html>` : 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix = 'mfqa-prep-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
function write(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const PROFILE = {
  map: 'qa/map', seedNames: 'qa/seed.json', viewports: { desktop: [1280, 800] }, browser: { channel: 'chromium' }, watch: null,
  settle: { timeoutMs: 3000, quietMs: 100, hidden: null }, stepTimeoutMs: 3000, maxElementsPerCapture: 80, login: {}, ignoreErrors: [],
  writes: { scope: null, allow: [], block: false }, clock: 'off', sensitive: ['src/billing/**'],
};

// main: src/app.ts. feat/x adds test/orders.test.mjs, test/orphan.test.mjs, two test helpers, src/auth/session.ts,
// src/billing/pay.ts.
// qa/ is untracked here and the overlay folder (overlays/prs/x/qa) holds the PR's files. The overlay of x: four entries and two route rows.
function repo({ overlay = true, adds = true } = {}) {
  const dir = tmpDir('mfqa-prep-repo-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(dir, '.gitignore', 'qa/\nqa.json\nqa-artifacts/\noverlays/\n');
  write(dir, 'src/app.ts', 'export {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'feat/x');
  if (adds) {
    write(dir, 'test/orders.test.mjs', "import test from 'node:test';\ntest('orders list', () => {});\n");
    write(dir, 'test/orphan.test.mjs', "import test from 'node:test';\ntest('nobody runs me', () => {});\n");
    // helpers beside the tests (2026-11-12: tests/keys_fake.py blocked a round): not test files, never a problem
    write(dir, 'test/helpers/db.mjs', 'export const db = {};\n');
    write(dir, 'tests/keys_fake.py', 'KEY = "fake"\n');
    write(dir, 'src/auth/session.ts', 'export {};\n');
    write(dir, 'src/billing/pay.ts', 'export {};\n');
  } else write(dir, 'src/app.ts', 'export const x = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'two');
  const head = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'qa.json', PROFILE);
  write(dir, 'qa/map/app.json', { screens: [{ name: 'home', sources: ['src/app.ts'], expectData: 'Home', steps: [{ goto: '/' }] }] });
  write(dir, 'qa/suites.json', { suites: { unit: ['npx', 'jest'] } });
  const local = path.join(dir, 'overlays');
  write(local, 'prs/x/spec.md', '---\npr: x\n---\n');
  if (overlay) {
    write(local, 'prs/x/qa/map/x.json', { screens: [
      { name: 'orders', sources: ['src/orders/*.tsx'], expectData: 'Kite', steps: [{ goto: '/orders' }] },
      { name: 'invoices', sources: ['src/invoices/*.tsx'], expectData: 'Invoice 7', steps: [{ goto: '/invoices' }] },
      { name: 'reports', sources: ['src/reports/*.tsx'], expectData: 'x', steps: [{ goto: '/reports' }, { click: 'role=button[name="Open"]' }] },
      { name: 'nosrc', emptyOk: true, steps: [{ goto: '/' }] },
    ] });
    write(local, 'prs/x/qa/routes.json', { routes: [
      { method: 'GET', path: '/api/orders', auth: 'public' }, { method: 'GET', path: '/api/broken', auth: 'public' },
    ], pages: [{ path: '/orders', screens: 'orders' }, { path: '/ghost', screens: 'ghost' }] });
    write(local, 'prs/x/qa/seed-needs.md', '- an invoice numbered 7 for the first customer\n');
  }
  return { dir, base, head, local, overlayDir: path.join(local, 'prs', 'x', 'qa') };
}

const upFixture = (dir, calls = []) => async (req) => { calls.push(req.at); return { name: `qa-${req.at.slice(0, 10)}`, slug: 'qa', dir, port, appUrl: baseUrl, seedStartedAt: null }; };

describe('prepareCheck: the PR\'s entries walked once, its rows fired once, its test files placed', () => {
  let check;
  const handOffs = [];
  const r0 = { };
  before(async () => {
    const r = repo();
    Object.assign(r0, r);
    check = await prepareCheck({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'x', V: path.join(r.dir, 'qa', 'x'), head: r.head, base: r.base, overlay: r.overlayDir }, {
      up: upFixture(r.dir),
      handOff: (req) => handOffs.push(req.name),
      routeActors: async () => ({ baseUrl: null, headers: { anon: {} } }),
      listFile: async ({ file, id }) => ({ listed: id === 'unit' && file === 'test/orders.test.mjs' ? 1 : 0 }),
    });
  });

  test('reached / not reached (the failing step) / reached but empty (expectData missing)', () => {
    const by = Object.fromEntries(check.entries.map((e) => [e.screen, e]));
    assert.equal(by.orders.state, 'reached');
    assert.equal(by.invoices.state, 'empty');
    assert.match(by.invoices.detail, /expected data "Invoice 7" is not on the screen/);
    assert.equal(by.reports.state, 'not reached');
    assert.match(by.reports.detail, /Open/, 'the step that failed is named');
    assert.equal(by.nosrc.state, 'reached');
    assert.ok(!check.entries.some((e) => e.screen === 'home'), 'only the overlay\'s entries are walked');
  });

  test('an entry with no sources is a problem; each route row is fired once, and a bad answer is a note, not a problem (1.0.3)', () => {
    assert.ok(check.problems.some((p) => p.id === 'map:nosrc' && /^no sources/.test(p.text)));
    assert.deepEqual(check.routes.map((x) => [x.route, x.kind, x.status, x.problem]), [
      ['GET /api/orders', 'happy', 200, null], ['GET /api/broken', 'happy', 500, '500 answered'],
    ]);
    assert.ok(!check.problems.some((p) => p.id.startsWith('route:')), 'a route answer stopped the round');
    assert.ok(check.notes.some((n) => /^route GET \/api\/broken: happy \(anon\) 500 answered — the run's route sweep judges it/.test(n)), JSON.stringify(check.notes));
    assert.ok(check.problems.some((p) => p.id === 'page:/ghost' && /"ghost"/.test(p.text)));
  });

  test('a test file the PR adds outside every registered suite is a problem; one a suite lists is not', () => {
    assert.deepEqual(check.tests, [{ file: 'test/orders.test.mjs', state: 'in', suites: ['unit'] }, { file: 'test/orphan.test.mjs', state: 'out', suites: [] }]);
    assert.ok(check.problems.some((p) => p.id === 'test:test/orphan.test.mjs' && /no registered suite lists it \(unit\)/.test(p.text)));
  });

  test('qa.json concerns are reported, never problems: a new auth path no sensitive glob covers', () => {
    assert.deepEqual(check.concerns.filter((c) => !c.startsWith('qa/')), ['src/auth/session.ts: looks like an auth, payment or migration path and no qa.json sensitive glob covers it']);
    assert.ok(!check.problems.some((p) => /session/.test(p.text)));
  });

  test('the head sandbox is left up and handed to the run (handOff), and prepare.md says it all; exit 1', () => {
    assert.deepEqual(handOffs, [`qa-${r0.head.slice(0, 10)}`]);
    const md = prepareMd(check);
    assert.match(md, /^# Prepare check — x\nhead: [0-9a-f]{12} · base: [0-9a-f]{12} · overlay: .*prs\/x\/qa · sandbox qa-[0-9a-f]{10} \(up\) · \d+ s\nchecked: 4 entries · 2 route row\(s\) · 2 page\(s\) · 2 new test file\(s\)\nseed needs: an invoice numbered 7 for the first customer\n/);
    assert.match(md, /\n## Entries\n- orders \(desktop\): reached\n- invoices \(desktop\): reached but empty — expected data "Invoice 7"/);
    assert.match(md, /\n## Routes\n- GET \/api\/orders \(happy, anon\): answered 200\n- GET \/api\/broken \(happy, anon\): 500 answered\n/);
    assert.match(md, /\n## Problems\n- \[map:/);
    assert.equal(prepareExit(check), 1);
    assert.match(blockedText(check), /^prepare check: the PR's QA files could not be proven \(5 problem\(s\)\): \[map:nosrc\] no sources: [^;]+; \[page:\/ghost\] [^;]+; \[map:invoices\] reached but empty [^;]+; \+2 more — V\/prepare\.md lists them$/);
  });
});

describe('prepareCheck: exit codes', () => {
  test('a clean overlay is exit 0; nothing to check is exit 3 with no sandbox; a sandbox that does not come up is exit 4', async () => {
    const r = repo({ adds: false });
    write(r.local, 'prs/x/qa/map/x.json', { screens: [{ name: 'orders', sources: ['src/orders/*.tsx'], expectData: 'Kite', steps: [{ goto: '/orders' }] }] });
    fs.rmSync(path.join(r.local, 'prs', 'x', 'qa', 'routes.json'));
    const opts = { mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'x', head: r.head, base: r.base, overlay: r.overlayDir };
    const clean = await prepareCheck(opts, { up: upFixture(r.dir), handOff: () => true });
    assert.deepEqual(clean.problems, []);
    assert.equal(prepareExit(clean), 0);
    const ups = [];
    const none = await prepareCheck({ ...opts, overlay: null }, { up: upFixture(r.dir, ups), handOff: () => true });
    assert.equal(none.nothing, true);
    assert.equal(prepareExit(none), 3);
    assert.deepEqual(ups, [], 'nothing to check brings no sandbox up');
    const blocked = await prepareCheck(opts, { up: async () => { throw new Error('BLOCKED ON INFRASTRUCTURE: up: port in use'); } });
    assert.equal(blocked.blocked, 'BLOCKED ON INFRASTRUCTURE: up: port in use');
    assert.equal(prepareExit(blocked), 4);
    assert.match(prepareMd(blocked), /\nblocked: BLOCKED ON INFRASTRUCTURE: up: port in use \(nothing that needs the head sandbox was checked\)\n/);
  });

  test('with no overlay the PR\'s entries are what the branch adds or changes', async () => {
    const r = repo({ overlay: false, adds: false });
    // A project that commits its QA files: the branch adds an entry.
    fs.rmSync(path.join(r.dir, '.gitignore'));
    git(r.dir, 'checkout', '-q', 'main');
    write(r.dir, '.gitignore', 'qa-artifacts/\n');
    git(r.dir, 'add', '-A');
    git(r.dir, 'commit', '-qm', 'qa files');
    const base = git(r.dir, 'rev-parse', 'HEAD');
    git(r.dir, 'checkout', '-qb', 'feat/y');
    write(r.dir, 'qa/map/more.json', { screens: [{ name: 'orders', sources: ['src/o.tsx'], expectData: 'Lark', steps: [{ goto: '/orders' }] }] });
    git(r.dir, 'add', '-A');
    git(r.dir, 'commit', '-qm', 'orders entry');
    const head = git(r.dir, 'rev-parse', 'HEAD');
    const check = await prepareCheck({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'y', head, base, overlay: null }, { up: upFixture(r.dir), handOff: () => true });
    assert.deepEqual(check.entries.map((e) => [e.screen, e.state]), [['orders', 'reached']]);
    assert.equal(prepareExit(check), 0);
  });
});

describe('qa prepare check (CLI)', () => {
  const cli = (cwd, args, env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (status) => resolve({ status, out }));
  });

  test('finds the branch\'s own QA files, reuses the live head sandbox, writes V/prepare.md, exit 1; --final makes it a BLOCKED verdict', { timeout: 120000 }, async () => {
    const r = repo();
    // The branch commits its QA files: move the fixture's overlay into qa/ and commit it on feat/x.
    fs.rmSync(path.join(r.dir, 'qa', 'map', 'app.json'));
    for (const f of ['map/x.json', 'routes.json', 'seed-needs.md']) {
      fs.mkdirSync(path.dirname(path.join(r.dir, 'qa', f)), { recursive: true });
      fs.copyFileSync(path.join(r.overlayDir, f), path.join(r.dir, 'qa', f));
    }
    write(r.dir, 'qa/suites.json', { suites: { unit: ['node', '--test'] } });
    write(r.dir, '.gitignore', 'qa-artifacts/\nqa.json\n');
    git(r.dir, 'add', '-A');
    git(r.dir, 'commit', '-qm', 'qa files');
    const head = git(r.dir, 'rev-parse', 'HEAD');
    const name = `qa-${head.slice(0, 10)}`;
    write(r.dir, `qa-artifacts/sandboxes/${name}.json`, { name, slug: name, dir: r.dir, port, appUrl: baseUrl, sha: head, seedStartedAt: null, stack: null });
    const first = await cli(r.dir, ['prepare', 'check', '--base', 'main'], {});
    assert.equal(first.status, 1, first.out);
    const md = fs.readFileSync(path.join(r.dir, 'qa', 'feat-x', 'prepare.md'), 'utf8');
    assert.match(md, new RegExp(`sandbox ${name} \\(reused\\)`));
    assert.match(md, /- \[map:invoices\] reached but empty/);
    const final = await cli(r.dir, ['prepare', 'check', '--base', 'main', '--final'], {});
    assert.equal(final.status, 1, final.out);
    const verdict = fs.readFileSync(path.join(r.dir, 'qa', 'feat-x', 'verdict.md'), 'utf8');
    assert.match(verdict, /^# BLOCKED — feat-x\n/);
    assert.match(verdict, /BLOCKED: prepare check: the PR's QA files could not be proven/);
    assert.match(final.out, /verdict: # BLOCKED — feat-x/);
  });

  test('nothing to check is exit 3', { timeout: 60000 }, async () => {
    const r = repo({ overlay: false, adds: false });
    const res = await cli(r.dir, ['prepare', 'check', '--base', 'main'], {});
    assert.equal(res.status, 3, res.out);
    assert.match(res.out, /nothing to check/);
  });
});
