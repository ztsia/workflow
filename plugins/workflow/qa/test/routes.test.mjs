// Contract tests for scripts/lib/routes.mjs. The CONTRACT comment at the top of that file (lines 1-160)
// is the spec. Each test pins one clause; a clause with several sub-rules is one test with several
// asserts. Every test fails now: each function is a stub that throws 'not built: <fn>'.
// Fixtures are written into fresh temp dirs; sweep() and sweepSide() get an injected fetch, except
// the one test that runs against a real node:http server on 127.0.0.1 port 0.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  actorFor, BAD, diffRoutes, expectationProbes, fillPath, judgeProbe, loadRouteTable, matchRoute,
  parseServerTiming, planSweep, registeredDiff, routeExpectations, routeName, sweep, sweepSide,
} from '../scripts/lib/routes.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-routes-'));
  made.push(dir);
  return dir;
}

// Writes qa/<name> under root; an object is serialised as JSON, a string is written as-is.
function writeQa(root, name, content) {
  fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(root, 'qa', name), typeof content === 'string' ? content : JSON.stringify(content));
}

const load = (root, seed = null, profile = {}) => loadRouteTable({ root, profile, seed, seedName: 'qa/seed.json' });

const ROW_ERROR = (n) => new RegExp(`^qa/routes\\.table\\.json: row ${n}: \\S`);

const ROWS = [
  { method: 'GET', path: '/api/notes', auth: 'public' },
  { method: 'POST', path: '/api/notes', auth: 'role', roles: ['staff'], body: { text: 'hi' } },
];
const EXAMPLE = { method: 'POST', path: '/functions/v1/notes', auth: 'role', roles: ['staff'], body: { text: 'hi' } };
const ITEM_ROW = { method: 'GET', path: '/api/items/:id', auth: 'public', params: { id: '7' } };
const ROLES = ['staff', 'viewer'];
const UNKNOWN_PATH = '/functions/qa-no-such-route-404';

// A probe as planSweep returns it, for sweep() and judgeProbe().
const probeFor = (over = {}) => ({
  pid: 'GET /api/x|happy|anon', route: 'GET /api/x', kind: 'happy', actor: 'anon',
  method: 'GET', path: '/api/x', headers: {}, body: null, expect: 'ok', ...over,
});

// A probe as judgeProbe takes it: only kind, expect and actor matter to the judgement.
const pr = (expect, kind = 'happy', actor = 'staff') => ({
  pid: `x|${kind}|${actor}`, route: 'GET /x', kind, actor, method: 'GET', path: '/x', headers: {}, body: null, expect,
});
const seen = (status, body = '') => ({ status, body, headers: {} });

const reply = (status, text = '', headers = {}) => new Response(text, { status, headers });

// A ProbeResult as sweep() returns it (no body; answer only for expect:* kinds).
const probeRes = (over = {}) => ({
  pid: 'POST /api/notes|deep|staff', route: 'POST /api/notes', kind: 'deep', actor: 'staff',
  method: 'POST', path: '/api/notes', headers: {}, expect: 'reject',
  status: 200, ms: 3, problem: null, notRun: null, timing: null, ...over,
});

// A SweepSide as sweepSide() returns it.
const sideOf = (over = {}) => ({
  file: 'qa/routes.table.json', rows: 2, registered: 2, probes: [], unlisted: [], stale: [], errors: [], notRun: null, ...over,
});

describe('loadRouteTable: where the table comes from and what it returns', () => {
  it('a .json file holding an array of rows, or an object { routes: [rows] }, loads its rows; file is its path', async () => {
    const a = tempDir();
    writeQa(a, 'routes.table.json', ROWS);
    const fromArray = await load(a);
    assert.equal(fromArray.file, 'qa/routes.table.json');
    assert.deepEqual(fromArray.rows, ROWS);
    assert.deepEqual(fromArray.errors, []);

    const b = tempDir();
    writeQa(b, 'routes.table.json', { routes: ROWS });
    const fromObject = await load(b);
    assert.equal(fromObject.file, 'qa/routes.table.json');
    assert.deepEqual(fromObject.rows, ROWS);
    assert.deepEqual(fromObject.errors, []);
  });

  it('a .mjs file exporting ROUTES loads that array as the rows', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.mjs', `export const ROUTES = ${JSON.stringify(ROWS)};\n`);
    const r = await load(root);
    assert.equal(r.file, 'qa/routes.table.mjs');
    assert.deepEqual(r.rows, ROWS);
    assert.deepEqual(r.errors, []);
  });

  it('a .ts file exporting ROUTES is imported with its types stripped by Node', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n');
    writeQa(root, 'routes.table.ts', `export const ROUTES: object[] = ${JSON.stringify(ROWS)};\n`);
    const r = await load(root);
    assert.equal(r.file, 'qa/routes.table.ts');
    assert.deepEqual(r.rows, ROWS);
    assert.deepEqual(r.errors, []);
  });

  it('the first table that exists is taken, in the order .json, .ts, .mjs', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', ROWS);
    writeQa(root, 'routes.table.mjs', `export const ROUTES = [{ method: 'DELETE', path: '/api/other', auth: 'public' }];\n`);
    const r = await load(root);
    assert.equal(r.file, 'qa/routes.table.json');
    assert.deepEqual(r.rows, ROWS);
  });

  it('profile.routes.table names the table, a path relative to root, and replaces the default names', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', ROWS);
    fs.mkdirSync(path.join(root, 'tests', 'routes'), { recursive: true });
    const override = [{ method: 'PUT', path: '/api/override/:id', auth: 'public', params: { id: '1' } }];
    fs.writeFileSync(path.join(root, 'tests', 'routes', 'table.json'), JSON.stringify(override));
    const r = await load(root, null, { routes: { table: 'tests/routes/table.json' } });
    assert.equal(r.file, 'tests/routes/table.json');
    assert.deepEqual(r.rows, override);
    assert.deepEqual(r.errors, []);
  });

  it('with no table file the result is { file: null, rows: [], errors: [] }', async () => {
    assert.deepEqual(await load(tempDir()), { file: null, rows: [], errors: [] });
  });

  it('a row whose method is not one of the five is dropped, with a "<file>: row <n>: <problem>" error', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [ROWS[0], { method: 'FETCH', path: '/api/x', auth: 'public' }]);
    const r = await load(root);
    assert.deepEqual(r.rows, [ROWS[0]]);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], ROW_ERROR(2));
  });

  it('a row whose path does not start with "/" is dropped, with a "<file>: row <n>: <problem>" error', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [ROWS[0], { method: 'GET', path: 'api/x', auth: 'public' }]);
    const r = await load(root);
    assert.deepEqual(r.rows, [ROWS[0]]);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], ROW_ERROR(2));
  });

  it('a row whose auth is not one of public, signed-in, role is dropped, with a "<file>: row <n>: <problem>" error', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [ROWS[0], { method: 'GET', path: '/api/x', auth: 'admin' }]);
    const r = await load(root);
    assert.deepEqual(r.rows, [ROWS[0]]);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], ROW_ERROR(2));
  });

  it('auth "role" with no roles array, or an empty one, is dropped, with a "<file>: row <n>: <problem>" error', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [
      ROWS[0],
      { method: 'GET', path: '/api/x', auth: 'role' },
      { method: 'GET', path: '/api/y', auth: 'role', roles: [] },
    ]);
    const r = await load(root);
    assert.deepEqual(r.rows, [ROWS[0]]);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], ROW_ERROR(2));
    assert.match(r.errors[1], ROW_ERROR(3));
  });

  it('a ":name" in path with no params.name is dropped, with a "<file>: row <n>: <problem>" error', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [
      ITEM_ROW,
      { method: 'GET', path: '/api/items/:id', auth: 'public' },
      { method: 'GET', path: '/api/items/:id/:sub', auth: 'public', params: { id: '1' } },
    ]);
    const r = await load(root);
    assert.deepEqual(r.rows, [ITEM_ROW]);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], ROW_ERROR(2));
    assert.match(r.errors[1], ROW_ERROR(3));
  });

  it('$seed.* tokens are resolved in params, otherId, calls and body (nested values too), from the seed passed in', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [
      {
        method: 'PUT',
        path: '/api/notes/:id',
        auth: 'signed-in',
        params: { id: '$seed.note.alice.id' },
        otherId: { id: '$seed.note.bob.id' },
        body: { text: '$seed.note.alice.title', tags: ['$seed.note.alice.id'], meta: { by: '$seed.note.bob.id' } },
      },
      { method: 'GET', path: '/api/notes/*', auth: 'signed-in', calls: ['/api/notes/$seed.note.alice.id'] },
    ]);
    const seed = { note: { alice: { id: 'n-7', title: 'Hi' }, bob: { id: 'n-9' } } };
    const r = await load(root, seed);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows[0].params, { id: 'n-7' });
    assert.deepEqual(r.rows[0].otherId, { id: 'n-9' });
    assert.deepEqual(r.rows[0].body, { text: 'Hi', tags: ['n-7'], meta: { by: 'n-9' } });
    assert.deepEqual(r.rows[1].calls, ['/api/notes/n-7']);
  });

  it('a $seed token that does not resolve gives a "<METHOD path>: <message>" error, and only that row is dropped', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [
      { method: 'POST', path: '/api/notes', auth: 'signed-in', body: { text: '$seed.note.nobody.title' } },
      ROWS[0],
    ]);
    const r = await load(root, { note: { alice: { title: 'x' } } });
    assert.deepEqual(r.rows, [ROWS[0]]);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^POST \/api\/notes: \$seed\.note\.nobody\.title: not in /);
  });

  it('a .json file that does not parse gives errors ["<file>: <message>"] and no rows', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', '{ "routes": [ ');
    const r = await load(root);
    assert.equal(r.file, 'qa/routes.table.json');
    assert.deepEqual(r.rows, []);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].startsWith('qa/routes.table.json: '), r.errors[0]);
  });
});

describe('routeName, fillPath, matchRoute', () => {
  it('routeName is "<METHOD> <path>" with the path as the table wrote it, params unfilled', () => {
    assert.equal(routeName({ method: 'PUT', path: '/api/items/:id', auth: 'public' }), 'PUT /api/items/:id');
  });

  it('fillPath replaces each ":name" with encodeURIComponent(String(value))', () => {
    assert.equal(fillPath('/api/items/:id/:kind', { id: 'a b/c', kind: 7 }), '/api/items/a%20b%2Fc/7');
  });

  it('fillPath leaves a ":name" whose param is missing as ":name"', () => {
    assert.equal(fillPath('/api/items/:id/:kind', { id: '1' }), '/api/items/1/:kind');
  });

  it('matchRoute: ":name" matches one segment, and the method must match', () => {
    const row = { method: 'GET', path: '/api/items/:id', auth: 'public' };
    assert.equal(matchRoute(row, 'GET', '/api/items/7'), true);
    assert.equal(matchRoute(row, 'GET', '/api/items/7/x'), false);
    assert.equal(matchRoute(row, 'POST', '/api/items/7'), false);
  });

  it('matchRoute: a trailing "/*" matches any rest of the path, including nothing', () => {
    const row = { method: 'GET', path: '/api/files/*', auth: 'public' };
    assert.equal(matchRoute(row, 'GET', '/api/files/a/b/c'), true);
    assert.equal(matchRoute(row, 'GET', '/api/files/'), true);
    assert.equal(matchRoute(row, 'GET', '/api/other/a'), false);
  });
});

describe('BAD: the fixed bad-request set', () => {
  it('is frozen, and is exactly the eleven kinds with their expect words', () => {
    assert.equal(Object.isFrozen(BAD), true);
    assert.deepEqual({ ...BAD }, {
      'signed-out': 'deny',
      'no-right': 'deny',
      'other-id': 'deny',
      'not-json': 'reject',
      nul: 'reject',
      deep: 'reject',
      oversized: 'reject',
      'wrong-method': 'refuse',
      'origin-foreign': 'deny',
      'origin-null': 'deny',
      'unknown-path': 'refuse',
    });
  });

});

describe('actorFor: who calls a row\'s happy, other-id and input probes', () => {
  it('public rows get "anon", whatever the roles', () => {
    assert.equal(actorFor({ method: 'GET', path: '/a', auth: 'public' }, ['staff']), 'anon');
  });

  it('signed-in rows (and rows with no auth) get the first login role, or null when there are none', () => {
    assert.equal(actorFor({ method: 'GET', path: '/a', auth: 'signed-in' }, ['staff', 'viewer']), 'staff');
    assert.equal(actorFor({ method: 'GET', path: '/a' }, ['viewer']), 'viewer');
    assert.equal(actorFor({ method: 'GET', path: '/a', auth: 'signed-in' }, []), null);
  });

  it('role rows get the first of row.roles that is a login role, or null when none is', () => {
    assert.equal(actorFor({ method: 'GET', path: '/a', auth: 'role', roles: ['viewer', 'staff'] }, ['staff', 'viewer']), 'viewer');
    assert.equal(actorFor({ method: 'GET', path: '/a', auth: 'role', roles: ['admin'] }, ['staff', 'viewer']), null);
  });
});

describe('planSweep', () => {
  it('the contract example row with roles [staff, viewer] plans exactly the contract order, actors and expect words', () => {
    const probes = planSweep([EXAMPLE], { roles: ROLES });
    assert.deepEqual(probes.map((p) => [p.kind, p.actor, p.expect]), [
      ['happy', 'staff', 'ok'],
      ['signed-out', 'anon', 'deny'],
      ['no-right', 'viewer', 'deny'],
      ['not-json', 'staff', 'reject'],
      ['nul', 'staff', 'reject'],
      ['deep', 'staff', 'reject'],
      ['oversized', 'staff', 'reject'],
      ['input:text:empty', 'staff', 'reject'],
      ['input:text:blank', 'staff', 'reject'],
      ['input:text:long', 'staff', 'reject'],
      ['input:text:html', 'staff', 'reject'],
      ['input:text:missing', 'staff', 'reject'],
      ['input:text:type', 'staff', 'reject'],
      ['wrong-method', 'staff', 'refuse'],
      ['unknown-path', 'anon', 'refuse'],
    ]);
  });

  it('unknown-path is planned once per table, last, as GET /<first segment of the first row>/qa-no-such-route-404', () => {
    const probes = planSweep([EXAMPLE, ITEM_ROW], { roles: ROLES });
    assert.equal(probes.filter((p) => p.kind === 'unknown-path').length, 1);
    const last = probes.at(-1);
    assert.equal(last.kind, 'unknown-path');
    assert.equal(last.method, 'GET');
    assert.equal(last.path, UNKNOWN_PATH);
    assert.equal(last.actor, 'anon');
    assert.equal(last.expect, 'refuse');
    assert.equal(last.body, null);
  });

  it('pid is "<route>|<kind>|<actor>", unique across the plan, and the same on a second plan', () => {
    const probes = planSweep([EXAMPLE, ITEM_ROW], { roles: ROLES });
    assert.equal(probes[0].pid, 'POST /functions/v1/notes|happy|staff');
    for (const p of probes.filter((x) => x.kind !== 'unknown-path')) {
      assert.equal(p.pid, `${p.route}|${p.kind}|${p.actor}`);
    }
    const pids = probes.map((p) => p.pid);
    assert.equal(new Set(pids).size, pids.length);
    assert.deepEqual(planSweep([EXAMPLE, ITEM_ROW], { roles: ROLES }).map((p) => p.pid), pids);
  });

  it('wrong-method is the first of DELETE, PATCH, PUT, POST, GET that no row registers at the same path', () => {
    const a = planSweep([
      { method: 'POST', path: '/api/x', auth: 'public', body: { a: 1 } },
      { method: 'DELETE', path: '/api/x', auth: 'public' },
    ], { roles: [] });
    assert.deepEqual(a.filter((p) => p.kind === 'wrong-method').map((p) => p.method), ['PATCH', 'PATCH']);

    const b = planSweep([
      { method: 'POST', path: '/api/x', auth: 'public', body: { a: 1 } },
      { method: 'DELETE', path: '/api/x', auth: 'public' },
      { method: 'PATCH', path: '/api/x', auth: 'public' },
      { method: 'PUT', path: '/api/x', auth: 'public' },
    ], { roles: [] });
    assert.deepEqual(b.filter((p) => p.kind === 'wrong-method' && p.route === 'POST /api/x').map((p) => p.method), ['GET']);
  });

  it('origin probes are planned only with origin:true, for POST/PUT/PATCH/DELETE rows with a body or DELETE, headers Origin foreign then null', () => {
    const rows = [
      EXAMPLE,
      { method: 'GET', path: '/api/items', auth: 'public' },
      { method: 'DELETE', path: '/api/items/:id', auth: 'public', params: { id: '7' } },
      { method: 'POST', path: '/api/ping', auth: 'public' },
    ];
    const without = planSweep(rows, { roles: ROLES });
    assert.deepEqual(without.filter((p) => p.kind.startsWith('origin-')), []);

    const withOrigin = planSweep(rows, { roles: ROLES, origin: true });
    const origins = withOrigin.filter((p) => p.kind.startsWith('origin-'));
    assert.deepEqual(origins.map((p) => `${p.route}|${p.kind}`), [
      'POST /functions/v1/notes|origin-foreign',
      'POST /functions/v1/notes|origin-null',
      'DELETE /api/items/:id|origin-foreign',
      'DELETE /api/items/:id|origin-null',
    ]);
    assert.deepEqual(origins.map((p) => p.headers), [
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
    ]);
    assert.ok(origins.every((p) => p.expect === 'deny'));
  });

  it('calls: every probe is planned once per call path, route stays routeName(row), pid gets "@<call path>" after the route', () => {
    const probes = planSweep([{ method: 'GET', path: '/api/items/*', auth: 'public', calls: ['/api/items/1', '/api/items/2'] }], { roles: [] });
    const happy = probes.filter((p) => p.kind === 'happy');
    assert.deepEqual(happy.map((p) => p.pid), [
      'GET /api/items/*@/api/items/1|happy|anon',
      'GET /api/items/*@/api/items/2|happy|anon',
    ]);
    assert.deepEqual(happy.map((p) => p.path), ['/api/items/1', '/api/items/2']);
    assert.deepEqual(happy.map((p) => p.route), ['GET /api/items/*', 'GET /api/items/*']);
    assert.equal(probes.filter((p) => p.kind === 'wrong-method').length, 2);
  });

  it('GET and DELETE probes have body null, even for a DELETE row that has a body', () => {
    const probes = planSweep([
      { method: 'DELETE', path: '/api/items/:id', auth: 'public', params: { id: '7' }, body: { a: 1 } },
      { method: 'GET', path: '/api/items', auth: 'public' },
    ], { roles: [] });
    const getOrDelete = probes.filter((p) => p.method === 'GET' || p.method === 'DELETE');
    assert.ok(getOrDelete.some((p) => p.kind === 'happy' && p.method === 'DELETE'));
    for (const p of getOrDelete) assert.equal(p.body, null, p.pid);
  });

  it('with no actor for a row (actorFor null), its happy, other-id and input probes are dropped; signed-out and no-right stay', () => {
    const probes = planSweep([
      { method: 'PUT', path: '/api/items/:id', auth: 'role', roles: ['admin'], params: { id: '1' }, otherId: { id: '2' }, body: { text: 'hi' } },
    ], { roles: ROLES });
    const kinds = probes.map((p) => p.kind);
    assert.deepEqual(kinds.filter((k) => k === 'happy' || k === 'other-id' || k.startsWith('input:')), []);
    assert.ok(kinds.includes('signed-out'));
    assert.equal(kinds.filter((k) => k === 'no-right').length, 2);
  });

  it('input probes: for each top-level field, six probes in order (empty, blank, long, html, missing, type), with the contract values', () => {
    const probes = planSweep([{ method: 'POST', path: '/api/notes', auth: 'public', body: { text: 'hi', title: 't' } }], { roles: [] });
    const inputs = probes.filter((p) => p.kind.startsWith('input:'));
    assert.deepEqual(inputs.map((p) => p.kind), [
      'input:text:empty', 'input:text:blank', 'input:text:long', 'input:text:html', 'input:text:missing', 'input:text:type',
      'input:title:empty', 'input:title:blank', 'input:title:long', 'input:title:html', 'input:title:missing', 'input:title:type',
    ]);
    const body = (kind) => JSON.parse(inputs.find((p) => p.kind === kind).body);
    assert.equal(body('input:text:empty').text, '');
    assert.equal(body('input:text:blank').text, '   ');
    assert.equal(body('input:text:long').text, 'x'.repeat(10001));
    assert.equal(body('input:text:html').text, '<img src=x onerror=alert(1)>');
    assert.ok(!('text' in body('input:text:missing')));
    assert.equal(body('input:text:missing').title, 't');
    assert.equal(body('input:title:empty').text, 'hi');
  });

  it('input:<field>:type sends 12345 for a string field and "not-a-<typeof>" for any other', () => {
    const probes = planSweep([{ method: 'POST', path: '/api/notes', auth: 'public', body: { text: 'hi', count: 3, flag: true } }], { roles: [] });
    const body = (kind) => JSON.parse(probes.find((p) => p.kind === kind).body);
    assert.equal(body('input:text:type').text, 12345);
    assert.equal(body('input:count:type').count, 'not-a-number');
    assert.equal(body('input:flag:type').flag, 'not-a-boolean');
  });

  it('happy is planned when a body is given or the method is GET, and not for a POST with no body; happy:false skips it', () => {
    const probes = planSweep([
      { method: 'GET', path: '/a', auth: 'public' },
      { method: 'POST', path: '/b', auth: 'public' },
      { method: 'POST', path: '/c', auth: 'public', body: { a: 1 }, happy: false },
    ], { roles: [] });
    assert.deepEqual(probes.filter((p) => p.kind === 'happy').map((p) => p.route), ['GET /a']);
  });

  it('no-right is planned once per login role not in row.roles, in the roles order', () => {
    const probes = planSweep([{ method: 'GET', path: '/api/x', auth: 'role', roles: ['staff'] }], { roles: ['staff', 'viewer', 'admin'] });
    const nr = probes.filter((p) => p.kind === 'no-right');
    assert.deepEqual(nr.map((p) => p.actor), ['viewer', 'admin']);
    assert.ok(nr.every((p) => p.expect === 'deny'));
  });

  it('signIn false (a sandbox that signs every call in) plans no signed-out, no-right or other-id probe; the rest stay (1.0.3)', () => {
    const rows = [
      { method: 'GET', path: '/api/signed', auth: 'signed-in' },
      { method: 'POST', path: '/api/role/:id', auth: 'role', roles: ['staff'], params: { id: '1' }, otherId: { id: '2' }, body: { a: 'x' } },
    ];
    const kinds = (o) => new Set(planSweep(rows, { roles: ['staff', 'viewer'], ...o }).map((p) => p.kind));
    const on = kinds({});
    for (const k of ['signed-out', 'no-right', 'other-id']) assert.ok(on.has(k), `${k} missing by default`);
    const off = kinds({ signIn: false });
    for (const k of ['signed-out', 'no-right', 'other-id']) assert.ok(!off.has(k), `${k} planned with signIn false`);
    for (const k of ['happy', 'not-json', 'nul', 'deep', 'oversized', 'wrong-method']) assert.ok(off.has(k), `${k} dropped with signIn false`);
  });

  it('signed-out is planned only for rows whose auth is not public, as actor anon', () => {
    const probes = planSweep([
      { method: 'GET', path: '/api/pub', auth: 'public' },
      { method: 'GET', path: '/api/signed', auth: 'signed-in' },
      { method: 'GET', path: '/api/role', auth: 'role', roles: ['staff'] },
    ], { roles: ['staff'] });
    const so = probes.filter((p) => p.kind === 'signed-out');
    assert.deepEqual(so.map((p) => p.route), ['GET /api/signed', 'GET /api/role']);
    assert.ok(so.every((p) => p.actor === 'anon' && p.expect === 'deny'));
  });

  it('other-id is planned with the first allowed role, path from params merged with otherId, expect deny; happy keeps the own params', () => {
    const probes = planSweep([
      { method: 'GET', path: '/api/notes/:id', auth: 'signed-in', params: { id: 'mine' }, otherId: { id: 'theirs' } },
    ], { roles: ['staff', 'viewer'] });
    const other = probes.find((p) => p.kind === 'other-id');
    assert.equal(other.actor, 'staff');
    assert.equal(other.path, '/api/notes/theirs');
    assert.equal(other.expect, 'deny');
    assert.equal(probes.find((p) => p.kind === 'happy').path, '/api/notes/mine');
  });

  it('nul is planned with every top-level string field set to "a\\u0000b" and other fields left alone, expect reject', () => {
    const probes = planSweep([{ method: 'POST', path: '/api/notes', auth: 'public', body: { text: 'hi', title: 't', n: 3 } }], { roles: [] });
    const nul = probes.find((p) => p.kind === 'nul');
    assert.equal(nul.expect, 'reject');
    assert.deepEqual(JSON.parse(nul.body), { text: 'a\u0000b', title: 'a\u0000b', n: 3 });
  });

  it('deep is planned with body plus deep: 200 nested objects of the form { a: ... }, expect reject', () => {
    const probes = planSweep([{ method: 'POST', path: '/api/notes', auth: 'public', body: { text: 'hi' } }], { roles: [] });
    const deep = probes.find((p) => p.kind === 'deep');
    assert.equal(deep.expect, 'reject');
    const parsed = JSON.parse(deep.body);
    assert.equal(parsed.text, 'hi');
    let node = parsed.deep;
    let objects = 0;
    while (node !== null && typeof node === 'object') {
      objects += 1;
      node = node.a;
    }
    assert.equal(objects, 200);
  });

  it('oversized is planned with body plus big: 2,000,000 "x" characters, expect reject', () => {
    const probes = planSweep([{ method: 'POST', path: '/api/notes', auth: 'public', body: { text: 'hi' } }], { roles: [] });
    const big = probes.find((p) => p.kind === 'oversized');
    assert.equal(big.expect, 'reject');
    const parsed = JSON.parse(big.body);
    assert.equal(parsed.text, 'hi');
    assert.equal(parsed.big, 'x'.repeat(2000000));
  });

  it('not-json is planned with the raw body "not json{" (not re-encoded), expect reject', () => {
    const probes = planSweep([{ method: 'POST', path: '/api/notes', auth: 'public', body: { text: 'hi' } }], { roles: [] });
    const nj = probes.find((p) => p.kind === 'not-json');
    assert.equal(nj.body, 'not json{');
    assert.equal(nj.expect, 'reject');
  });
});

describe('judgeProbe', () => {
  it('status 0 is "no answer: <body or connection failed>"', () => {
    assert.equal(judgeProbe(pr('ok'), seen(0, 'connection refused')), 'no answer: connection refused');
    assert.equal(judgeProbe(pr('ok'), seen(0, '')), 'no answer: connection failed');
  });

  it('a 5xx is "<status> answered" for every expect, before the expect rules apply', () => {
    assert.equal(judgeProbe(pr('ok'), seen(500)), '500 answered');
    assert.equal(judgeProbe(pr('deny', 'no-right', 'viewer'), seen(503)), '503 answered');
  });

  it('a body matching STACK is "stack trace in the answer", before the expect rules apply', () => {
    assert.equal(judgeProbe(pr('ok'), seen(200, 'boom\n    at handle (/srv/app/notes.js:12:5)')), 'stack trace in the answer');
    assert.equal(judgeProbe(pr('deny', 'no-right', 'viewer'), seen(403, 'Traceback (most recent call last):\n  File "app.py"')), 'stack trace in the answer');
  });

  it('expect ok: a non-2xx is "happy path answered <status>", a 2xx is no problem', () => {
    assert.equal(judgeProbe(pr('ok'), seen(200)), null);
    assert.equal(judgeProbe(pr('ok'), seen(404)), 'happy path answered 404');
    assert.equal(judgeProbe(pr('ok'), seen(302)), 'happy path answered 302');
  });

  it('expect deny: a 2xx with an empty array or empty text is no problem; other 2xx/3xx is "answered <status> to <kind> (<actor>)"; 401, 403, 404 and other 4xx are no problem', () => {
    assert.equal(judgeProbe(pr('deny', 'no-right', 'viewer'), seen(200, '[]')), null);
    assert.equal(judgeProbe(pr('deny', 'no-right', 'viewer'), seen(200, '')), null);
    assert.equal(judgeProbe(pr('deny', 'no-right', 'viewer'), seen(200, '{"id":1}')), 'answered 200 to no-right (viewer)');
    assert.equal(judgeProbe(pr('deny', 'signed-out', 'anon'), seen(302, '')), 'answered 302 to signed-out (anon)');
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(judgeProbe(pr('deny', 'no-right', 'viewer'), seen(status, '{"error":"no"}')), null, String(status));
    }
  });

  it('expect reject: any 4xx is no problem; a 2xx is no problem for the empty, blank, missing, long, html and nul kinds, and "accepted <kind> with <status>" for not-json, deep, oversized and input:*:type', () => {
    for (const status of [400, 401, 404, 422]) assert.equal(judgeProbe(pr('reject', 'not-json'), seen(status)), null, String(status));
    for (const kind of ['input:text:empty', 'input:text:blank', 'input:text:missing', 'input:text:long', 'input:text:html', 'nul']) {
      assert.equal(judgeProbe(pr('reject', kind), seen(200)), null, kind);
    }
    assert.equal(judgeProbe(pr('reject', 'not-json'), seen(200)), 'accepted not-json with 200');
    assert.equal(judgeProbe(pr('reject', 'deep'), seen(201)), 'accepted deep with 201');
    assert.equal(judgeProbe(pr('reject', 'oversized'), seen(200)), 'accepted oversized with 200');
    assert.equal(judgeProbe(pr('reject', 'input:text:type'), seen(200)), 'accepted input:text:type with 200');
  });

  it('expect refuse: a 2xx or 3xx is "answered <status> to <kind>"; a 4xx is no problem', () => {
    assert.equal(judgeProbe(pr('refuse', 'wrong-method'), seen(200)), 'answered 200 to wrong-method');
    assert.equal(judgeProbe(pr('refuse', 'unknown-path'), seen(302)), 'answered 302 to unknown-path');
    assert.equal(judgeProbe(pr('refuse', 'wrong-method'), seen(404)), null);
    assert.equal(judgeProbe(pr('refuse', 'wrong-method'), seen(405)), null);
  });
});

describe('sweep', () => {
  it('fires the probes in probe order, one at a time, never in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return reply(200, '{}');
    };
    const probes = ['/api/a', '/api/b', '/api/c'].map((p) => probeFor({ pid: p, path: p }));
    const out = await sweep({ baseUrl: 'http://app.test', probes, actors: { anon: {} }, fetch });
    assert.deepEqual(out.map((r) => r.pid), ['/api/a', '/api/b', '/api/c']);
    assert.deepEqual(urls, ['http://app.test/api/a', 'http://app.test/api/b', 'http://app.test/api/c']);
    assert.equal(maxInFlight, 1);
  });

  it('a probe whose actor is notRun, or has no headers, is not fetched: status null, ms 0, problem null, notRun given or "no headers for <actor>"', async () => {
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      return reply(200, '{}');
    };
    const probes = [
      probeFor({ pid: 'v', actor: 'viewer' }),
      probeFor({ pid: 'n', actor: 'nobody' }),
    ];
    const out = await sweep({
      baseUrl: 'http://app.test', probes, actors: { anon: {}, viewer: { notRun: 'no login for viewer' } }, fetch,
    });
    assert.deepEqual(calls, []);
    assert.equal(out[0].status, null);
    assert.equal(out[0].ms, 0);
    assert.equal(out[0].problem, null);
    assert.equal(out[0].notRun, 'no login for viewer');
    assert.equal(out[1].notRun, 'no headers for nobody');
  });

  it('fetch gets baseUrl + path, the probe method, redirect "manual" and an AbortSignal', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, init });
      return reply(200, '{}');
    };
    const probe = probeFor({ pid: 'p', method: 'POST', path: '/api/notes', body: '{"text":"hi"}', kind: 'happy', expect: 'ok' });
    await sweep({ baseUrl: 'http://app.test', probes: [probe], actors: { anon: {} }, fetch });
    assert.equal(seen[0].url, 'http://app.test/api/notes');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.redirect, 'manual');
    assert.equal(seen[0].init.body, '{"text":"hi"}');
    assert.ok(seen[0].init.signal instanceof AbortSignal);
  });

  it('headers are the actor headers, plus content-type application/json when there is a body, plus the probe headers', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push(init);
      return reply(200, '{}');
    };
    const probe = probeFor({ pid: 'p', actor: 'staff', method: 'POST', path: '/api/notes', body: '{"a":1}', headers: { Origin: 'https://evil.example' } });
    await sweep({ baseUrl: 'http://app.test', probes: [probe], actors: { staff: { authorization: 'Bearer staff' } }, fetch });
    assert.deepEqual(seen[0].headers, {
      authorization: 'Bearer staff',
      'content-type': 'application/json',
      Origin: 'https://evil.example',
    });
  });

  it('content-type is sent only with a body: a probe with body null gets the actor headers and no content-type', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push(init);
      return reply(200, '{}');
    };
    await sweep({ baseUrl: 'http://app.test', probes: [probeFor({ pid: 'p', body: null })], actors: { anon: { 'x-test': '1' } }, fetch });
    assert.deepEqual(seen[0].headers, { 'x-test': '1' });
    assert.equal('content-type' in seen[0].headers, false);
  });

  it('a thrown fetch gives status 0 with the error message as the body, judged as "no answer: <message>"', async () => {
    const fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const [r] = await sweep({ baseUrl: 'http://app.test', probes: [probeFor({ pid: 'p' })], actors: { anon: {} }, fetch });
    assert.equal(r.status, 0);
    assert.equal(r.notRun, null);
    assert.equal(r.problem, 'no answer: ECONNREFUSED');
  });

  it('a result keeps no body; for expect:* kinds it keeps answer, the body cut to 4000 characters', async () => {
    const long = 'x'.repeat(5000);
    const fetch = async () => reply(200, long);
    const [plain, expect] = await sweep({
      baseUrl: 'http://app.test',
      probes: [probeFor({ pid: 'plain' }), probeFor({ pid: 'e', kind: 'expect:notes', expect: 'ok' })],
      actors: { anon: {} },
      fetch,
    });
    assert.equal('body' in plain, false);
    assert.equal('answer' in plain, false);
    assert.equal('body' in expect, false);
    assert.equal(expect.answer, long.slice(0, 4000));
  });

  it('the server-timing answer header is parsed into timing; no header gives timing null', async () => {
    const fetch = async (url) => (url.endsWith('/timed')
      ? reply(200, '{}', { 'server-timing': 'app;dur=12.5, db;dur=3' })
      : reply(200, '{}'));
    const out = await sweep({
      baseUrl: 'http://app.test',
      probes: [probeFor({ pid: 'timed', path: '/timed' }), probeFor({ pid: 'plain', path: '/plain' })],
      actors: { anon: {} },
      fetch,
    });
    assert.deepEqual(out[0].timing, { app: 12.5, db: 3 });
    assert.equal(out[1].timing, null);
  });

  it('runs against a real node:http server on 127.0.0.1 (port 0): a 500 on one path is "500 answered" on that probe only', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/boom') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('oops');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const probes = [
        probeFor({ pid: 'GET /api/ok|happy|anon', route: 'GET /api/ok', path: '/api/ok' }),
        probeFor({ pid: 'GET /api/boom|happy|anon', route: 'GET /api/boom', path: '/api/boom' }),
      ];
      const out = await sweep({ baseUrl: `http://127.0.0.1:${port}`, probes, actors: { anon: {} } });
      assert.equal(out[0].status, 200);
      assert.equal(out[0].problem, null);
      assert.equal(out[1].status, 500);
      assert.equal(out[1].problem, '500 answered');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('parseServerTiming', () => {
  it('"app;dur=12.5, db;dur=3, db-queries;dur=4" is { app: 12.5, db: 3, "db-queries": 4 }', () => {
    assert.deepEqual(parseServerTiming('app;dur=12.5, db;dur=3, db-queries;dur=4'), { app: 12.5, db: 3, 'db-queries': 4 });
  });

  it('entries without a dur are skipped', () => {
    assert.deepEqual(parseServerTiming('cache;desc="hit", app;dur=2'), { app: 2 });
  });

  it('a null or empty header gives null', () => {
    assert.equal(parseServerTiming(null), null);
    assert.equal(parseServerTiming(''), null);
  });
});

describe('registeredDiff', () => {
  it('unlisted: registered routes no row matches (method and path), in input order', () => {
    const rows = [{ method: 'GET', path: '/api/items/:id', auth: 'public' }];
    const registered = [
      { method: 'GET', path: '/api/items/7' },
      { method: 'DELETE', path: '/api/items/7' },
      { method: 'GET', path: '/api/other' },
    ];
    assert.deepEqual(registeredDiff(rows, registered), {
      unlisted: [{ method: 'DELETE', path: '/api/items/7' }, { method: 'GET', path: '/api/other' }],
      stale: [],
    });
  });

  it('stale: rows whose routeName matches no registered route, in input order', () => {
    const rows = [
      { method: 'GET', path: '/api/items/:id', auth: 'public' },
      { method: 'DELETE', path: '/api/gone', auth: 'public' },
      { method: 'POST', path: '/api/notes', auth: 'public' },
    ];
    const registered = [{ method: 'GET', path: '/api/items/9' }, { method: 'POST', path: '/api/notes' }];
    assert.deepEqual(registeredDiff(rows, registered), {
      unlisted: [],
      stale: [{ method: 'DELETE', path: '/api/gone' }],
    });
  });

  it('a row matches a registered route by equal method and path, or by matchRoute (a trailing /* matches the rest)', () => {
    const rows = [
      { method: 'GET', path: '/files/*', auth: 'public' },
      { method: 'GET', path: '/api/ping', auth: 'public' },
    ];
    const registered = [{ method: 'GET', path: '/files/a/b' }, { method: 'GET', path: '/api/ping' }];
    assert.deepEqual(registeredDiff(rows, registered), { unlisted: [], stale: [] });
  });
});

describe('routeExpectations', () => {
  it('met: the status is one of status (a number is [n]) and, with has, the answer contains it; detail is "<route> as <as>: <status>"', () => {
    const expectations = [
      { name: 'notes-denied-to-viewer', route: 'POST /api/notes', as: 'viewer', status: 403 },
      { name: 'notes-listed', route: 'GET /api/notes', as: 'staff', status: [200, 204], has: 'saved' },
    ];
    const results = [
      { kind: 'expect:notes-denied-to-viewer', status: 403, answer: '{"error":"forbidden"}', notRun: null },
      { kind: 'expect:notes-listed', status: 200, answer: '{"saved":true}', notRun: null },
    ];
    assert.deepEqual(routeExpectations(expectations, results, { rows: [] }), [
      { name: 'notes-denied-to-viewer', result: 'met', detail: 'POST /api/notes as viewer: 403' },
      { name: 'notes-listed', result: 'met', detail: 'GET /api/notes as staff: 200' },
    ]);
  });

  it('NOT MET: a status outside status is detailed with the expected status; a missing has text adds body lacks "<has>"', () => {
    const expectations = [
      { name: 'a', route: 'POST /api/notes', as: 'viewer', status: 403 },
      { name: 'b', route: 'GET /api/notes', as: 'anon', status: 200, has: 'saved' },
    ];
    const results = [
      { kind: 'expect:a', status: 200, answer: '{}', notRun: null },
      { kind: 'expect:b', status: 200, answer: '{"ok":true}', notRun: null },
    ];
    assert.deepEqual(routeExpectations(expectations, results, { rows: [] }), [
      { name: 'a', result: 'NOT MET', detail: 'POST /api/notes as viewer: 200, expected 403' },
      { name: 'b', result: 'NOT MET', detail: 'GET /api/notes as anon: 200, expected 200, body lacks "saved"' },
    ]);
  });

  it('not observed when the probe has a notRun: detail is "<route> as <as>: <notRun>"', () => {
    const expectations = [{ name: 'c', route: 'GET /api/notes', as: 'viewer', status: 200 }];
    const results = [{ kind: 'expect:c', status: null, answer: undefined, notRun: 'no headers for viewer' }];
    assert.deepEqual(routeExpectations(expectations, results, { rows: [] }), [
      { name: 'c', result: 'not observed', detail: 'GET /api/notes as viewer: no headers for viewer' },
    ]);
  });

  it('not observed when the probe is missing from the results: detail is "<route> as <as>: not run"', () => {
    const expectations = [{ name: 'd', route: 'GET /api/notes', as: 'anon', status: 200 }];
    assert.deepEqual(routeExpectations(expectations, [], { rows: [] }), [
      { name: 'd', result: 'not observed', detail: 'GET /api/notes as anon: not run' },
    ]);
  });
});

describe('expectationProbes', () => {
  it('one probe per route entry: kind "expect:<name>", actor as, method and path from route, body the row body for POST, expect ok', () => {
    const probes = expectationProbes(
      [{ name: 'notes-denied-to-viewer', route: 'POST /api/notes', as: 'viewer', status: 403 }],
      { rows: [{ method: 'POST', path: '/api/notes', auth: 'role', roles: ['staff'], body: { text: 'hi' } }] },
    );
    assert.equal(probes.length, 1);
    assert.equal(probes[0].kind, 'expect:notes-denied-to-viewer');
    assert.equal(probes[0].actor, 'viewer');
    assert.equal(probes[0].method, 'POST');
    assert.equal(probes[0].path, '/api/notes');
    assert.equal(probes[0].body, '{"text":"hi"}');
    assert.equal(probes[0].expect, 'ok');
  });

  it('params are filled from the row whose routeName matches; a GET has body null', () => {
    const probes = expectationProbes(
      [{ name: 'item', route: 'GET /api/items/:id', as: 'anon', status: 200 }],
      { rows: [{ method: 'GET', path: '/api/items/:id', auth: 'public', params: { id: 'a b' } }] },
    );
    assert.equal(probes[0].path, '/api/items/a%20b');
    assert.equal(probes[0].body, null);
    assert.equal(probes[0].actor, 'anon');
  });

  it('a route entry with its own body sends that body (JSON), not the row body', () => {
    const probes = expectationProbes(
      [{ name: 'made', route: 'POST /api/notes', as: 'staff', status: 201, body: { text: 'from entry' } }],
      { rows: [{ method: 'POST', path: '/api/notes', auth: 'role', roles: ['staff'], body: { text: 'from row' } }] },
    );
    assert.equal(probes[0].body, '{"text":"from entry"}');
  });

  it('with no matching row the path is the route path as written', () => {
    const probes = expectationProbes([{ name: 'ghost', route: 'GET /api/things/:id', as: 'anon', status: 200 }], { rows: [] });
    assert.equal(probes[0].path, '/api/things/:id');
  });
});

describe('diffRoutes', () => {
  it('probes counts the head probes that ran (status not null, kind not expect:*); notRunProbes those with notRun; failed those with a problem', () => {
    const head = sideOf({
      probes: [
        probeRes({ pid: 'a', kind: 'happy', expect: 'ok', status: 200, problem: null }),
        probeRes({ pid: 'b', kind: 'deep', status: 500, problem: '500 answered' }),
        probeRes({ pid: 'c', kind: 'nul', status: null, notRun: 'no headers for viewer', problem: null }),
        probeRes({ pid: 'd', kind: 'expect:x', expect: 'ok', status: 200, problem: null }),
      ],
    });
    const r = diffRoutes(head, null);
    assert.equal(r.probes, 2);
    assert.equal(r.notRunProbes, 1);
    assert.equal(r.failed, 1);
  });

  it('new: head problems with no problem on base, as { id: rte:<n>, pid, route, kind, actor, status, problem } in order', () => {
    const head = sideOf({
      probes: [
        probeRes({ pid: 'POST /api/notes|deep|staff', kind: 'deep', status: 500, problem: '500 answered' }),
        probeRes({ pid: 'POST /api/notes|happy|staff', kind: 'happy', expect: 'ok', actor: 'staff', status: 400, problem: 'happy path answered 400' }),
        probeRes({ pid: 'POST /api/notes|nul|staff', kind: 'nul', status: 200, problem: null }),
      ],
    });
    const r = diffRoutes(head, null);
    assert.deepEqual(r.new, [
      { id: 'rte:1', pid: 'POST /api/notes|deep|staff', route: 'POST /api/notes', kind: 'deep', actor: 'staff', status: 500, problem: '500 answered' },
      { id: 'rte:2', pid: 'POST /api/notes|happy|staff', route: 'POST /api/notes', kind: 'happy', actor: 'staff', status: 400, problem: 'happy path answered 400' },
    ]);
    assert.equal(r.standing, 0);
    assert.equal(r.fixed, 0);
  });

  it('base is "none" when base is null, "swept" for a swept base, "not run" for a base with notRun', () => {
    const head = sideOf({ probes: [probeRes({ pid: 'x', status: 500, problem: '500 answered' })] });
    assert.equal(diffRoutes(head, null).base, 'none');
    assert.equal(diffRoutes(head, sideOf()).base, 'swept');
    assert.equal(diffRoutes(head, sideOf({ file: null, rows: 0, registered: null, notRun: 'no route table' })).base, 'not run');
  });

  it('standing: a head problem whose pid also had a problem on base; a head problem whose pid had no problem on base, or was absent, is new', () => {
    const head = sideOf({
      probes: [
        probeRes({ pid: 'p1', status: 500, problem: '500 answered' }),
        probeRes({ pid: 'p2', status: 400, problem: 'happy path answered 400' }),
        probeRes({ pid: 'p3', status: 500, problem: '500 answered' }),
      ],
    });
    const base = sideOf({
      probes: [
        probeRes({ pid: 'p1', status: 500, problem: '500 answered' }),
        probeRes({ pid: 'p2', status: 200, problem: null }),
      ],
    });
    const r = diffRoutes(head, base);
    assert.equal(r.standing, 1);
    assert.deepEqual(r.new.map((n) => n.pid), ['p2', 'p3']);
    assert.equal(r.failed, 3);
  });

  it('fixed: a base problem whose pid ran on head without one; a pid absent on head, or with notRun on head, is not fixed', () => {
    const base = sideOf({
      probes: [
        probeRes({ pid: 'f1', status: 500, problem: '500 answered' }),
        probeRes({ pid: 'f2', status: 500, problem: '500 answered' }),
        probeRes({ pid: 'f3', status: 500, problem: '500 answered' }),
      ],
    });
    const head = sideOf({
      probes: [
        probeRes({ pid: 'f1', status: 200, problem: null }),
        probeRes({ pid: 'f3', status: null, notRun: 'no headers for staff', problem: null }),
      ],
    });
    const r = diffRoutes(head, base);
    assert.equal(r.fixed, 1);
    assert.equal(r.standing, 0);
    assert.deepEqual(r.new, []);
  });

  it('unlisted and stale come from head only, with ids rte:unlisted/<n> and rte:stale/<n>; errors pass through; rows and file are head\'s', () => {
    const head = sideOf({
      unlisted: [{ method: 'DELETE', path: '/api/gone' }, { method: 'GET', path: '/api/z' }],
      stale: [{ method: 'PUT', path: '/api/old' }],
      errors: ['qa/routes.table.json: row 3: bad'],
    });
    const base = sideOf({ unlisted: [{ method: 'GET', path: '/api/z' }] });
    const r = diffRoutes(head, base);
    assert.deepEqual(r.unlisted, [
      { id: 'rte:unlisted/1', method: 'DELETE', path: '/api/gone' },
      { id: 'rte:unlisted/2', method: 'GET', path: '/api/z' },
    ]);
    assert.deepEqual(r.stale, [{ id: 'rte:stale/1', method: 'PUT', path: '/api/old' }]);
    assert.deepEqual(r.errors, ['qa/routes.table.json: row 3: bad']);
    assert.equal(r.file, 'qa/routes.table.json');
    assert.equal(r.rows, 2);
    assert.equal(r.standing, 0);
  });

  it('a head with notRun gives the same shape with zero counts and empty lists, notRun kept', () => {
    const head = sideOf({ file: null, rows: 0, registered: null, notRun: 'no route table' });
    assert.deepEqual(diffRoutes(head, null), {
      file: null,
      rows: 0,
      probes: 0,
      notRunProbes: 0,
      failed: 0,
      new: [],
      standing: 0,
      fixed: 0,
      unlisted: [],
      stale: [],
      errors: [],
      notRun: 'no route table',
      base: 'none',
    });
  });

  it('head null gives null', () => {
    assert.equal(diffRoutes(null, sideOf()), null);
    assert.equal(diffRoutes(null, null), null);
  });
});

describe('sweepSide', () => {
  it('no table: { notRun: "no route table", file: null, rows: 0, probes, unlisted, stale, errors and expectations empty } and nothing is fetched', async () => {
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      return reply(200, '{}');
    };
    const r = await sweepSide({
      root: tempDir(), profile: {}, baseUrl: 'http://app.test', actors: { anon: {} }, fetch,
    });
    assert.equal(r.notRun, 'no route table');
    assert.equal(r.file, null);
    assert.equal(r.rows, 0);
    assert.deepEqual(r.probes, []);
    assert.deepEqual(r.unlisted, []);
    assert.deepEqual(r.stale, []);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.expectations, []);
    assert.deepEqual(calls, []);
  });

  it('with a table: loads it, plans with roles from profile.login, sweeps with the given actors and reports the probes', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [
      { method: 'GET', path: '/api/items', auth: 'public' },
      { method: 'POST', path: '/api/items', auth: 'role', roles: ['staff'], body: { name: 'x' } },
    ]);
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return reply(200, '{"ok":1}');
    };
    const r = await sweepSide({
      root,
      profile: { login: { staff: {}, viewer: {} } },
      baseUrl: 'http://app.test',
      actors: { anon: { 'x-a': '1' }, staff: { authorization: 'staff' }, viewer: { authorization: 'v' } },
      fetch,
    });
    assert.equal(r.file, 'qa/routes.table.json');
    assert.equal(r.rows, 2);
    assert.equal(r.notRun, null);
    assert.deepEqual(r.errors, []);
    assert.ok(r.probes.length > 0);
    assert.equal(r.probes.find((p) => p.kind === 'no-right').problem, 'answered 200 to no-right (viewer)');
    assert.ok(r.probes.every((p) => !('body' in p)));
    assert.ok(calls.every((c) => c.url.startsWith('http://app.test/')));
  });

  it('profile.routes.base replaces the baseUrl given', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [{ method: 'GET', path: '/api/items', auth: 'public' }]);
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      return reply(200, '{}');
    };
    await sweepSide({
      root, profile: { routes: { base: 'http://override.test' } }, baseUrl: 'http://ignored.test', actors: { anon: {} }, fetch,
    });
    assert.ok(urls.length > 0);
    assert.ok(urls.every((u) => u.startsWith('http://override.test/')));
  });

  it('registered as an array fills unlisted and stale by registeredDiff; registered null leaves both empty', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [
      { method: 'GET', path: '/api/items', auth: 'public' },
      { method: 'POST', path: '/api/items', auth: 'role', roles: ['staff'], body: { name: 'x' } },
    ]);
    const fetch = async () => reply(200, '{}');
    const profile = { login: { staff: {} } };
    const actors = { anon: {}, staff: {} };
    const withList = await sweepSide({
      root, profile, baseUrl: 'http://app.test', actors, fetch,
      registered: [{ method: 'GET', path: '/api/items' }, { method: 'DELETE', path: '/api/items/:id' }],
    });
    assert.deepEqual(withList.unlisted, [{ method: 'DELETE', path: '/api/items/:id' }]);
    assert.deepEqual(withList.stale, [{ method: 'POST', path: '/api/items' }]);

    const withNull = await sweepSide({ root, profile, baseUrl: 'http://app.test', actors, fetch, registered: null });
    assert.deepEqual(withNull.unlisted, []);
    assert.deepEqual(withNull.stale, []);
  });

  it('a table with rows empty and errors gives notRun "route table has errors", with no probes and nothing fetched', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [{ method: 'FETCH', path: '/api/x', auth: 'public' }]);
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      return reply(200, '{}');
    };
    const r = await sweepSide({ root, profile: {}, baseUrl: 'http://app.test', actors: { anon: {} }, fetch });
    assert.equal(r.notRun, 'route table has errors');
    assert.equal(r.file, 'qa/routes.table.json');
    assert.equal(r.rows, 0);
    assert.equal(r.errors.length, 1);
    assert.deepEqual(r.probes, []);
    assert.deepEqual(calls, []);
  });

  it('expectations are the route entries judged from the sweep: { name, result, detail }', async () => {
    const root = tempDir();
    writeQa(root, 'routes.table.json', [{ method: 'POST', path: '/api/notes', auth: 'role', roles: ['staff'], body: { text: 'hi' } }]);
    const fetch = async () => reply(403, '{"error":"no"}');
    const r = await sweepSide({
      root,
      profile: { login: { staff: {}, viewer: {} } },
      baseUrl: 'http://app.test',
      actors: { anon: {}, staff: {}, viewer: {} },
      expectations: [{ name: 'notes-denied-to-viewer', route: 'POST /api/notes', as: 'viewer', status: 403 }],
      fetch,
    });
    assert.deepEqual(r.expectations, [
      { name: 'notes-denied-to-viewer', result: 'met', detail: 'POST /api/notes as viewer: 403' },
    ]);
  });
});

it('pilot (CRM): a redirect away to a login page denies; a redirect to the same path does not', () => {
  const probe = { kind: 'signed-out', actor: 'anon', expect: 'deny', path: '/crm-squad/analytics' };
  assert.equal(judgeProbe(probe, { status: 303, body: '', headers: { location: '/crm-squad/login?next=/crm-squad/analytics' } }), null);
  assert.equal(judgeProbe(probe, { status: 303, body: '', headers: { location: '/crm-squad/analytics' } }), 'answered 303 to signed-out (anon)');
  assert.equal(judgeProbe(probe, { status: 302, body: '' }), 'answered 302 to signed-out (anon)');
  const refuse = { kind: 'unknown-path', actor: 'anon', expect: 'refuse', path: '/crm-squad/qa-no-such-route-404' };
  assert.equal(judgeProbe(refuse, { status: 303, body: '', headers: { location: '/crm-squad/login' } }), null);
});
