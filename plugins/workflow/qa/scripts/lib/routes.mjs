// The route sweep (decisions 2, 3, 7, 12): every route in one table, the same bad requests fired at
// each, judged by a fixed rule. An API's input edge cases are found once for all routes, not one
// route per QA run. Zero model calls. The table says what a route is (method, path, who may call
// it, a body it accepts); the sweep never knows what a route means: route expectations and the
// verifier's charter go there.
//
// CONTRACT (tests: test/routes.test.mjs — pure functions with fixtures; sweep() with an injected
// fetch; one test runs sweep() against a node:http server on 127.0.0.1:0)
//
//   ROUTE TABLE: profile.routes.table (a path relative to the tree), else the first that exists of
//   qa/routes.table.json, qa/routes.table.ts, qa/routes.table.mjs. A .json file is the array of
//   rows (or { "routes": [rows] }); a .ts/.mjs file is imported and its export ROUTES is the array
//   (Node strips the types). Row:
//     { method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',
//       path: '/api/items/:id'          (':name' params; a trailing '/*' matches any rest)
//       auth: 'public' | 'signed-in' | 'role'          (default 'signed-in')
//       roles?: [role]                  (auth 'role': the login roles that may call it)
//       params?: { name: value }        (fills ':name'; strings may hold $seed.* tokens)
//       otherId?: { name: value }       (the same params pointing at a record the caller must not reach)
//       calls?: [path]                  (concrete paths to call when `path` has '/*'; default [path])
//       body?: object                   (a body it accepts; sent by the happy probe; $seed.* resolved)
//       happy?: boolean                 (default true when body is given or method is GET; false skips it)
//       idempotent?: boolean }          (documentation only in step 6)
//
//   loadRouteTable({ root, profile, seed = null, seedName }) -> Promise<{ file, rows, errors }>
//     file = the table's path relative to root, or null when none exists (rows [], errors []).
//     Every string in params, otherId, calls and body has $seed.* resolved (map.mjs
//     resolveSeedsDeep); a MapError becomes an errors entry '<METHOD path>: <message>' and the row
//     is dropped. Validation errors (each '<file>: row <n>: <problem>', row dropped): method not
//     one of the five, path not starting '/', auth not one of the three, auth 'role' without a
//     non-empty roles array, a ':name' in path with no params.name. A file that does not parse or
//     import -> errors ['<file>: <message>'], rows [].
//
//   SIDE FILE AND OVERLAY (rework U4/U5; tests: test/scope.test.mjs 'routes'): after the table, loadRouteTable and
//   loadPages merge SIDE_FILE (qa/routes.json, unless it is the table itself) and then <profile.overlay>/routes.json
//   (overlay.mjs routesFile: { routes, pages } or a bare array of rows). A row replaces the row of the same
//   '<METHOD> <path>' (a page the page of the same path), else it is appended. Their errors are labelled 'qa/routes.json'
//   and 'overlay routes.json'. file = the table's, else 'qa/routes.json', else the overlay file's absolute path; none of
//   the three -> file null as before. The side file is where a PR's rows go when the table is
//   code: code is never generated into a .ts/.mjs table.
//
//   routeName(row) -> '<METHOD> <path>'   (the table's own path, params unfilled)
//
//   fillPath(path, params) -> string     ':name' replaced by encodeURIComponent(String(params[name]));
//     a param missing from params is left as ':name'.
//
//   matchRoute(row, method, path) -> boolean   same method and the path matches row.path where
//     ':name' matches one segment and a trailing '/*' matches any rest (including nothing).
//
//   BAD (exported, frozen): the fixed bad-request set as { kind: expect } for the eleven kinds below
//   (input:* and happy are not in it). When each applies:
//     'signed-out'    rows with auth !== 'public'; actor 'anon'                        expect 'deny'
//     'no-right'      auth 'role' rows, once per login role NOT in roles; actor = that role  'deny'
//     'other-id'      rows with otherId; actor = the first allowed role (see actorFor); params
//                     = { ...params, ...otherId }                                      'deny'
//     'not-json'      POST/PUT/PATCH rows with body; body 'not json{' as application/json  'reject'
//     'nul'           POST/PUT/PATCH rows with body; every top-level string field of body → 'a\u0000b'  'reject'
//     'deep'          POST/PUT/PATCH rows with body; body { ...body, deep: <200 nested objects { a: … }> }  'reject'
//     'oversized'     POST/PUT/PATCH rows with body; body { ...body, big: 'x'.repeat(2_000_000) }  'reject'
//     'wrong-method'  every row: the first of DELETE, PATCH, PUT, POST, GET that no row of the
//                     table registers at the same path                                 'refuse'
//     'origin-foreign','origin-null'  only when profile.routes.origin === true: POST/PUT/PATCH/DELETE
//                     rows with body or DELETE; header Origin 'https://evil.example' / 'null'   'deny'
//   and once per table (not per row): 'unknown-path' GET '/<first segment of the first row's path>/qa-no-such-route-404'
//     actor 'anon'                                                                    'refuse'
//   PROBES (per-input, each top-level field of body; POST/PUT/PATCH rows with body):
//     'input:<field>:empty' (''), 'input:<field>:blank' ('   '), 'input:<field>:long' ('x' × 10001),
//     'input:<field>:html' ('<img src=x onerror=alert(1)>'), 'input:<field>:missing' (field deleted),
//     'input:<field>:type' (a string field → 12345, any other → 'not-a-<typeof>')        expect 'reject'
//   'happy': rows where happy applies; actor = the first allowed role; body = row.body   expect 'ok'
//
//   actorFor(row, roles) -> role | 'anon' | null   who calls a row's happy, other-id and input probes:
//     auth 'public' -> 'anon'; 'signed-in' -> roles[0] ?? null; 'role' -> the first of row.roles
//     that is in roles, else null (no probe needs an actor it cannot have: those probes are dropped).
//
//   planSweep(rows, { roles, origin = false, signIn = true }) -> Probe[]
//     signIn false (qa.json routes.signIn false: the sandbox answers every call as a signed-in user, e.g. a dev-user
//     gate; 1.0.3): no 'signed-out', 'no-right' or 'other-id' probe is planned, since none can be refused there.
//     roles = the login role names (Object.keys(profile.login)). Probe = { pid, route, kind, actor,
//     method, path (filled), headers: {} (extra headers, e.g. Origin), body: string | null
//     (JSON.stringify of the object, or the raw 'not json{'), expect: 'ok'|'deny'|'reject'|'refuse' }.
//     pid = '<route>|<kind>|<actor>' — unique; stable across runs (no position in it).
//     Order: per row in table order: happy, signed-out, no-right (roles order), other-id, not-json,
//     nul, deep, oversized, input probes (field order, then the six in the order above),
//     wrong-method, origin-foreign, origin-null; then unknown-path last. calls: a row with calls
//     plans every probe once per call path (route stays routeName(row); pid gets '@<call path>'
//     after the route). GET/DELETE probes have body null. Pure.
//
//   judgeProbe(probe, { status, body, headers }) -> null | problem string. First that applies:
//     status === 0 (no answer / network error)          'no answer: <body or "connection failed">'
//     status >= 500                                     '<status> answered'
//     body matches STACK                                 'stack trace in the answer'
//     expect 'ok':     status not 2xx                   'happy path answered <status>'
//     expect 'deny':   2xx with a JSON body that is an empty array, or empty text -> null (rows hidden);
//                      other 2xx/3xx                    'answered <status> to <kind> (<actor>)'
//                      (pilot, CRM): a 3xx whose Location path differs from the probe's path (sent to a
//                      login page) is a refusal -> null; the same holds for expect 'refuse'
//                      401, 403, 404 -> null; any other 4xx -> null
//     expect 'reject': any 4xx -> null; 2xx -> null for input:*:empty|blank|missing|long|html and
//                      'nul' (a route may accept or clean them); 2xx for not-json, deep, oversized,
//                      input:*:type -> 'accepted <kind> with <status>'
//     expect 'refuse': 2xx/3xx -> 'answered <status> to <kind>'; 4xx -> null
//   STACK (exported) = /\bat [\w$.<>]+ \(.*:\d+:\d+\)|Traceback \(most recent call last\)|\.java:\d+\)|node_modules\/|Exception in thread|SQLSTATE|syntax error at or near/
//
//   sweep({ baseUrl, probes, actors, fetch = globalThis.fetch, timeoutMs = 15000, now = Date.now })
//     -> Promise<ProbeResult[]>   in probe order, one at a time (never parallel: writes share a db)
//     actors: { anon: headers, <role>: headers | { notRun: string } }. A probe whose actor is
//     missing or notRun -> { ...probe, status: null, ms: 0, problem: null, notRun: <why or
//     'no headers for <actor>'> }. Else fetch(baseUrl + path, { method, headers: { ...actors[actor],
//     'content-type': 'application/json' when body !== null, ...probe.headers }, body, redirect:
//     'manual', signal: AbortSignal.timeout(timeoutMs) }); body text read (cut to 4000 chars);
//     a thrown fetch -> status 0, body = the error message. ProbeResult = { ...probe minus body,
//     status, ms, problem: judgeProbe(…), notRun: null, timing: parseServerTiming(answer header
//     'server-timing') }.
//
//   parseServerTiming(header) -> { [name]: number } | null   'app;dur=12.5, db;dur=3, db-queries;dur=4'
//     -> { app: 12.5, db: 3, 'db-queries': 4 }; entries without dur are skipped; null/'' -> null.
//
//   registeredDiff(rows, registered) -> { unlisted: [{ method, path }], stale: [{ method, path }] }
//     registered = [{ method, path }] from the stack's `routes` verb. unlisted: registered routes no
//     row matches (matchRoute); stale: rows whose routeName matches no registered route (a row
//     matches when some registered { method, path } equals it, or matchRoute(row, …) is true for
//     it). Pure; both in input order.
//
//   routeExpectations(expectations, results, { rows }) -> [{ name, result, detail }]
//     Decision 12's `route` type, from expectations.json entries that have a `route` key:
//       { name, route: '<METHOD> <path>', as: role | 'anon', status: n | [n], has?: text }
//     They are planned as extra probes by expectationProbes (below) and judged here from the
//     sweep's ProbeResults (kind 'expect:<name>'): result 'met' when the status is one of
//     status (a number is [n]) and, with `has`, the answer body contains has; 'NOT MET' otherwise;
//     'not observed' when the probe has no status (notRun) or is missing. detail:
//     met '<route> as <as>: <status>'; NOT MET '<route> as <as>: <status>, expected <status list>[,
//     body lacks "<has>"]'; not observed '<route> as <as>: <notRun or "not run">'.
//   expectationProbes(expectations, { rows }) -> Probe[]   one per `route` entry: kind 'expect:<name>',
//     actor = as, method/path from route (params filled from the row whose routeName or calls match,
//     else the path as written), body = JSON of entry.body when given, else the row's body for
//     POST/PUT/PATCH, else null; expect 'ok' (judgeProbe still flags 5xx/stack; the result above
//     decides met). Sweep these with the others; ProbeResult keeps `answer` (the body text, cut to
//     4000) ONLY for kind 'expect:*'.
//
//   diffRoutes(head, base) -> RoutesResult        (head/base: SweepSide | null; pure)
//     SweepSide = { file, rows: n, registered: n | null, probes: [ProbeResult], unlisted, stale,
//                   errors: [string], notRun: string | null }
//     RoutesResult (results.json `routes`) = {
//       file, rows, probes: count of probes that ran (status !== null, kind not 'expect:*'),
//       notRunProbes: count with notRun, failed: count with a problem (head),
//       new: [{ id: 'rte:<n>', pid, route, kind, actor, status, problem }]   head problems whose
//            pid had no problem on base, or base is null / base.notRun / base has no such pid,
//       standing: count of head problems whose pid also has a problem on base,
//       fixed: count of base problems whose pid ran on head without one,
//       unlisted: [{ id: 'rte:unlisted/<n>', method, path }]  (head's, all of them: a route nobody
//            listed is never standing — listing it is the fix)
//       stale: [{ id: 'rte:stale/<n>', method, path }]       (head's)
//       errors: head.errors, notRun: head.notRun, base: base ? (base.notRun ? 'not run' : 'swept') : 'none' }
//     n is 1-based in head probe order. head null -> null. head.notRun -> the same shape with
//     zero counts and empty lists, notRun kept.
//
//   sweepSide({ root, profile, baseUrl, actors, expectations = [], seed, seedName, fetch, registered = null })
//     -> Promise<SweepSide & { expectations: [{ name, result, detail }] }>
//     loadRouteTable; no table -> { notRun: 'no route table', file: null, rows: 0, …empty };
//     rows empty and errors -> notRun 'route table has errors'. planSweep(rows, { roles:
//     Object.keys(profile.login ?? {}), origin: profile.routes?.origin === true, signIn: profile.routes?.signIn !== false }) + expectationProbes;
//     baseUrl = profile.routes?.base ?? the given baseUrl; sweep; registeredDiff when registered is
//     an array (else unlisted/stale []); expectations = routeExpectations(…).
//
// Example. Table row { method: 'POST', path: '/functions/v1/notes', auth: 'role', roles: ['staff'],
// body: { text: 'hi' } } with login roles ['staff', 'viewer'] plans, in order:
//   happy staff · signed-out anon · no-right viewer · not-json staff · nul staff · deep staff · oversized staff ·
//   input:text:empty … input:text:type (6, staff) · wrong-method staff (DELETE) — then unknown-path anon.
// A 500 to `deep` gives new [{ id: 'rte:1', pid: 'POST /functions/v1/notes|deep|staff', route:
// 'POST /functions/v1/notes', kind: 'deep', actor: 'staff', status: 500, problem: '500 answered' }].

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MapError, resolveSeedsDeep } from './map.mjs';
import { OVERLAY_ROUTES, mergeBy, routesFile } from './overlay.mjs';

export const STACK = /\bat [\w$.<>]+ \(.*:\d+:\d+\)|Traceback \(most recent call last\)|\.java:\d+\)|node_modules\/|Exception in thread|SQLSTATE|syntax error at or near/;

export const BAD = Object.freeze({
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

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTHS = ['public', 'signed-in', 'role'];
const WITH_BODY = ['POST', 'PUT', 'PATCH'];
const TABLE_NAMES = ['qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs'];
// Where a PR's route and PAGES rows go when the table is code (.ts/.mjs): never code generated
// into the table, a JSON side file both loaders merge over it instead (rework U5).
export const SIDE_FILE = 'qa/routes.json';
const BODY_CUT = 4000;
const PARAM = /^:([A-Za-z_]\w*)$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => o != null && Object.hasOwn(o, k);
const errText = (e) => (e && e.message ? String(e.message) : String(e));
const toPosix = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------
// The table

function validateRow(row) {
  if (!isObject(row)) return 'row is not an object';
  if (!METHODS.includes(row.method)) return `method must be one of ${METHODS.join(', ')}`;
  if (typeof row.path !== 'string' || !row.path.startsWith('/')) return 'path must start with "/"';
  if (row.auth !== undefined && !AUTHS.includes(row.auth)) return `auth must be one of ${AUTHS.join(', ')}`;
  if (row.auth === 'role' && !(Array.isArray(row.roles) && row.roles.length > 0)) return 'auth "role" needs a non-empty roles array';
  for (const seg of row.path.split('/')) {
    const m = PARAM.exec(seg);
    if (m && !hasOwn(row.params, m[1])) return `path has ":${m[1]}" but params.${m[1]} is not given`;
  }
  return null;
}

// The table's own rows, as written: { file (relative to root) | null, abs, list, errors }.
async function readTable(root, profile) {
  const named = profile?.routes?.table;
  const candidates = typeof named === 'string' && named ? [named] : TABLE_NAMES;
  const abs = candidates.map((c) => path.resolve(root, c)).find((f) => fs.existsSync(f));
  if (!abs) return { file: null, abs: null, list: [], errors: [] };
  const file = toPosix(path.relative(root, abs));
  try {
    let list;
    if (abs.endsWith('.json')) {
      const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
      list = Array.isArray(parsed) ? parsed : parsed?.routes;
      if (!Array.isArray(list)) throw new Error('expected an array of rows or { "routes": [rows] }');
    } else {
      const stamp = fs.statSync(abs).mtimeMs;
      const mod = await import(`${pathToFileURL(abs).href}?v=${stamp}`);
      list = mod.ROUTES;
      if (!Array.isArray(list)) throw new Error('expected an exported ROUTES array');
    }
    return { file, abs, list, errors: [] };
  } catch (e) {
    return { file, abs, list: [], errors: [`${file}: ${errText(e)}`] };
  }
}

// The JSON files merged over the table (rework U4/U5): the side file qa/routes.json (where a PR's rows go
// when the table is code), then the run's overlay routes.json. [{ file (label), abs, routes, pages, errors }].
function extraSources(root, profile, tableAbs) {
  const out = [];
  const side = path.resolve(root, SIDE_FILE);
  if (side !== tableAbs && fs.existsSync(side)) out.push({ file: SIDE_FILE, abs: side, ...routesFile(side) });
  if (typeof profile?.overlay === 'string' && profile.overlay) {
    const abs = path.join(profile.overlay, OVERLAY_ROUTES);
    if (fs.existsSync(abs)) out.push({ file: `overlay ${OVERLAY_ROUTES}`, abs, ...routesFile(abs) });
  }
  return out;
}

export async function loadRouteTable({ root, profile, seed = null, seedName = 'qa/seed.json' } = {}) {
  const table = await readTable(root, profile);
  const extra = extraSources(root, profile, table.abs);
  if (!table.file && !extra.length) return { file: null, rows: [], errors: [] };
  const errors = [...table.errors];
  const checked = (list, file) => {
    const rows = [];
    list.forEach((row, i) => {
      const problem = validateRow(row);
      if (problem) {
        errors.push(`${file}: row ${i + 1}: ${problem}`);
        return;
      }
      try {
        const out = { ...row };
        for (const key of ['params', 'otherId', 'calls', 'body']) {
          if (row[key] !== undefined) out[key] = resolveSeedsDeep(row[key], { seed, seedName });
        }
        rows.push(out);
      } catch (e) {
        if (!(e instanceof MapError)) throw e;
        errors.push(`${row.method} ${row.path}: ${e.message}`);
      }
    });
    return rows;
  };
  let rows = checked(table.list, table.file);
  for (const x of extra) {
    errors.push(...x.errors);
    rows = mergeBy(rows, checked(x.routes, x.file), routeName);
  }
  const file = table.file ?? (extra[0].file === SIDE_FILE ? SIDE_FILE : extra[0].abs);
  return { file, rows, errors };
}

// READY (0.5.0; tests: test/ready.test.mjs): the screens the app serves, beside its API routes, so `qa ready`
// can say which pages no map entry reaches. The same table file: JSON { routes, pages }, or a .ts/.mjs exporting
// PAGES (ROUTES stays required; [] is fine). Page = { path: '/x' (':name' one segment, a trailing '/*' any rest),
// screens?: name | [name] (map entries that reach it by clicks, not by a goto), skip?: '<why no entry maps it>' }.
//   loadPages({ root, profile }) -> Promise<{ file, pages, errors }>   file null when there is no table; a table
//     with no pages -> pages []. Errors: '<file>: page <n>: <problem>' (path must start with "/", screens must be
//     a name or a list of names, skip must be a non-empty reason); the page is dropped.
export async function loadPages({ root, profile } = {}) {
  const named = profile?.routes?.table;
  const candidates = typeof named === 'string' && named ? [named] : TABLE_NAMES;
  const abs = candidates.map((c) => path.resolve(root, c)).find((f) => fs.existsSync(f)) ?? null;
  const extra = extraSources(root, profile, abs);
  if (!abs && !extra.length) return { file: null, pages: [], errors: [] };
  const file = abs ? toPosix(path.relative(root, abs)) : (extra[0].file === SIDE_FILE ? SIDE_FILE : extra[0].abs);
  let list = [];
  const errors = [];
  if (abs) {
    try {
      if (abs.endsWith('.json')) {
        const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
        list = Array.isArray(parsed) ? [] : parsed?.pages ?? [];
      } else {
        const mod = await import(`${pathToFileURL(abs).href}?v=${fs.statSync(abs).mtimeMs}`);
        list = mod.PAGES ?? [];
      }
      if (!Array.isArray(list)) throw new Error('pages must be an array');
    } catch (e) {
      list = [];
      errors.push(`${file}: ${errText(e)}`);
    }
  }
  const checked = (items, label) => {
    const pages = [];
    items.forEach((page, i) => {
      const screens = page?.screens;
      const problem = !isObject(page) ? 'not an object'
        : typeof page.path !== 'string' || !page.path.startsWith('/') ? 'path must start with "/"'
          : screens !== undefined && !(typeof screens === 'string' || (Array.isArray(screens) && screens.every((s) => typeof s === 'string'))) ? 'screens must be a name or a list of names'
            : page.skip !== undefined && !(typeof page.skip === 'string' && page.skip.trim()) ? 'skip must be a non-empty reason'
              : null;
      if (problem) errors.push(`${label}: page ${i + 1}: ${problem}`);
      else pages.push({ path: page.path, screens: screens === undefined ? [] : [].concat(screens), ...(page.skip ? { skip: page.skip } : {}) });
    });
    return pages;
  };
  let pages = checked(list, file);
  for (const x of extra) {
    errors.push(...x.errors);
    pages = mergeBy(pages, checked(x.pages, x.file), (p) => p.path);
  }
  return { file, pages, errors };
}

export function routeName(row) {
  return `${row.method} ${row.path}`;
}

export function fillPath(p, params) {
  return String(p).split('/').map((seg) => {
    const m = PARAM.exec(seg);
    if (!m || !hasOwn(params, m[1]) || params[m[1]] === undefined) return seg;
    return encodeURIComponent(String(params[m[1]]));
  }).join('/');
}

export function matchRoute(row, method, p) {
  if (String(row.method).toUpperCase() !== String(method).toUpperCase()) return false;
  let pattern = row.path;
  const wild = pattern.endsWith('/*');
  if (wild) pattern = pattern.slice(0, -2);
  const body = pattern.split('/').map((seg) => (PARAM.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}${wild ? '(?:/.*)?' : ''}$`, 's').test(String(p));
}

export function actorFor(row, roles) {
  const auth = row.auth ?? 'signed-in';
  if (auth === 'public') return 'anon';
  if (auth === 'signed-in') return roles[0] ?? null;
  return (row.roles ?? []).find((r) => roles.includes(r)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// The plan

function nested(depth) {
  let node = {};
  for (let i = 1; i < depth; i += 1) node = { a: node };
  return node;
}

function inputVariants(body, field) {
  const value = body[field];
  const set = (v) => ({ ...body, [field]: v });
  const missing = { ...body };
  delete missing[field];
  return [
    ['empty', set('')],
    ['blank', set('   ')],
    ['long', set('x'.repeat(10001))],
    ['html', set('<img src=x onerror=alert(1)>')],
    ['missing', missing],
    ['type', set(typeof value === 'string' ? 12345 : `not-a-${typeof value}`)],
  ];
}

export function planSweep(rows, { roles = [], origin = false, signIn = true } = {}) {
  const probes = [];

  for (const row of rows) {
    const route = routeName(row);
    const method = row.method;
    const sendsBody = WITH_BODY.includes(method);
    const hasBody = row.body !== undefined && row.body !== null;
    const bodyObj = sendsBody && isObject(row.body) ? row.body : null;
    const wire = (obj) => (obj === null || obj === undefined ? null : JSON.stringify(obj));
    const ownBody = sendsBody && hasBody ? wire(row.body) : null;
    const happy = row.happy ?? (hasBody || method === 'GET');
    const actor = actorFor(row, roles);
    const own = (row.auth ?? 'signed-in') === 'role' ? row.roles : null;
    const taken = new Set(rows.filter((r) => r.path === row.path).map((r) => r.method));
    const wrongMethod = ['DELETE', 'PATCH', 'PUT', 'POST', 'GET'].find((m) => !taken.has(m));
    const callPaths = Array.isArray(row.calls) && row.calls.length ? row.calls : null;

    for (const call of callPaths ?? [row.path]) {
      const at = callPaths ? `@${call}` : '';
      const filled = fillPath(call, row.params);
      const add = (kind, who, over = {}) => {
        probes.push({
          pid: `${route}${at}|${kind}|${who}`,
          route,
          kind,
          actor: who,
          method,
          path: filled,
          headers: {},
          body: ownBody,
          expect: BAD[kind] ?? 'ok',
          ...over,
        });
      };

      if (happy && actor !== null) add('happy', actor, { expect: 'ok' });
      if (signIn && (row.auth ?? 'signed-in') !== 'public') add('signed-out', 'anon');
      if (signIn && own) for (const r of roles) if (!own.includes(r)) add('no-right', r);
      if (signIn && row.otherId && actor !== null) {
        add('other-id', actor, { path: fillPath(call, { ...row.params, ...row.otherId }) });
      }
      if (sendsBody && hasBody && actor !== null) add('not-json', actor, { body: 'not json{' });
      if (bodyObj && actor !== null) {
        const nul = Object.fromEntries(Object.entries(bodyObj).map(([k, v]) => [k, typeof v === 'string' ? 'a\u0000b' : v]));
        add('nul', actor, { body: wire(nul) });
        add('deep', actor, { body: wire({ ...bodyObj, deep: nested(200) }) });
        add('oversized', actor, { body: wire({ ...bodyObj, big: 'x'.repeat(2_000_000) }) });
        for (const field of Object.keys(bodyObj)) {
          for (const [what, variant] of inputVariants(bodyObj, field)) {
            add(`input:${field}:${what}`, actor, { expect: 'reject', body: wire(variant) });
          }
        }
      }
      if (wrongMethod && actor !== null) add('wrong-method', actor, { method: wrongMethod, body: null });
      if (origin && actor !== null && (method === 'DELETE' || (sendsBody && hasBody))) {
        add('origin-foreign', actor, { headers: { Origin: 'https://evil.example' } });
        add('origin-null', actor, { headers: { Origin: 'null' } });
      }
    }
  }

  if (rows.length) {
    const first = String(rows[0].path).split('/')[1] ?? '';
    const p = `/${first ? `${first}/` : ''}qa-no-such-route-404`;
    probes.push({
      pid: `GET ${p}|unknown-path|anon`,
      route: `GET ${p}`,
      kind: 'unknown-path',
      actor: 'anon',
      method: 'GET',
      path: p,
      headers: {},
      body: null,
      expect: BAD['unknown-path'],
    });
  }
  return probes;
}

// ---------------------------------------------------------------------------------------------
// The judge

const NEVER_ACCEPTED = (kind) => kind === 'not-json' || kind === 'deep' || kind === 'oversized' || /^input:.*:type$/.test(kind);

function emptyAnswer(text) {
  const t = String(text ?? '').trim();
  if (t === '') return true;
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) && v.length === 0;
  } catch {
    return false;
  }
}

// A redirect away from the asked path (a server-rendered app sends a signed-out visitor to its
// login page): the resource was not served, so it counts as a refusal.
function redirectsAway(probe, headers) {
  const loc = headers?.location ?? headers?.Location ?? (typeof headers?.get === 'function' ? headers.get('location') : null);
  if (!loc) return false;
  try {
    return new URL(loc, 'http://x').pathname !== String(probe.path ?? '').split('?')[0];
  } catch {
    return false;
  }
}

export function judgeProbe(probe, { status, body = '', headers = {} } = {}) {
  if (status === 0) return `no answer: ${body || 'connection failed'}`;
  if (status >= 500) return `${status} answered`;
  if (STACK.test(String(body ?? ''))) return 'stack trace in the answer';
  const ok2xx = status >= 200 && status < 300;
  const redirect = status >= 300 && status < 400 && !redirectsAway(probe, headers);
  switch (probe.expect) {
    case 'ok':
      return ok2xx ? null : `happy path answered ${status}`;
    case 'deny':
      if (ok2xx && emptyAnswer(body)) return null;
      return ok2xx || redirect ? `answered ${status} to ${probe.kind} (${probe.actor})` : null;
    case 'reject':
      return ok2xx && NEVER_ACCEPTED(probe.kind) ? `accepted ${probe.kind} with ${status}` : null;
    case 'refuse':
      return ok2xx || redirect ? `answered ${status} to ${probe.kind}` : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The sweep

export function parseServerTiming(header) {
  if (header === null || header === undefined || header === '') return null;
  const out = {};
  for (const entry of String(header).split(',')) {
    const [name, ...params] = entry.split(';').map((x) => x.trim());
    if (!name) continue;
    for (const param of params) {
      const m = /^dur=(.+)$/.exec(param);
      if (!m) continue;
      const n = Number(m[1].replace(/^"|"$/g, ''));
      if (Number.isFinite(n)) out[name] = n;
    }
  }
  return Object.keys(out).length ? out : null;
}

export async function sweep({ baseUrl, probes, actors = {}, fetch = globalThis.fetch, timeoutMs = 15000, now = Date.now } = {}) {
  const out = [];
  for (const probe of probes) {
    const { body, ...rest } = probe;
    const who = actors[probe.actor];
    if (who === undefined || who === null || who.notRun) {
      out.push({
        ...rest, status: null, ms: 0, problem: null, notRun: who?.notRun || `no headers for ${probe.actor}`, timing: null,
      });
      continue;
    }
    const headers = { ...who };
    if (body !== null && body !== undefined) headers['content-type'] = 'application/json';
    Object.assign(headers, probe.headers);

    const started = now();
    let status;
    let text;
    let timing = null;
    let location = null;
    try {
      const res = await fetch(baseUrl + probe.path, {
        method: probe.method,
        headers,
        body: body ?? undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      timing = parseServerTiming(res.headers?.get?.('server-timing') ?? null);
      location = res.headers?.get?.('location') ?? null;
      try {
        text = (await res.text()).slice(0, BODY_CUT);
      } catch {
        text = '';
      }
    } catch (e) {
      status = 0;
      text = errText(e);
    }
    const ms = now() - started;
    const result = {
      ...rest, status, ms, problem: judgeProbe(probe, { status, body: text, headers: { location } }), notRun: null, timing,
    };
    if (String(probe.kind).startsWith('expect:')) result.answer = text;
    out.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Registered routes

export function registeredDiff(rows, registered) {
  const regs = registered ?? [];
  const same = (r, row) => String(r.method).toUpperCase() === row.method && r.path === row.path;
  const unlisted = regs.filter((r) => !rows.some((row) => matchRoute(row, r.method, r.path) || same(r, row)));
  const stale = rows.filter((row) => !regs.some((r) => same(r, row) || matchRoute(row, r.method, r.path)));
  return {
    unlisted: unlisted.map((r) => ({ method: r.method, path: r.path })),
    stale: stale.map((row) => ({ method: row.method, path: row.path })),
  };
}

// ---------------------------------------------------------------------------------------------
// Route expectations (decision 12)

const routeEntries = (expectations) => (expectations ?? []).filter((e) => e && typeof e === 'object' && e.route !== undefined);

function splitRoute(route) {
  const s = String(route).trim();
  const i = s.indexOf(' ');
  return i < 0 ? { method: s.toUpperCase(), path: '' } : { method: s.slice(0, i).toUpperCase(), path: s.slice(i + 1).trim() };
}

export function expectationProbes(expectations, { rows = [] } = {}) {
  return routeEntries(expectations).map((entry) => {
    const { method, path: written } = splitRoute(entry.route);
    const row = rows.find((r) => routeName(r) === entry.route)
      ?? rows.find((r) => r.method === method && Array.isArray(r.calls) && r.calls.includes(written));
    const actor = entry.as ?? 'anon';
    let body = null;
    if (entry.body !== undefined) body = JSON.stringify(entry.body);
    else if (row && WITH_BODY.includes(method) && row.body !== undefined && row.body !== null) body = JSON.stringify(row.body);
    return {
      pid: `${entry.route}|expect:${entry.name}|${actor}`,
      route: entry.route,
      kind: `expect:${entry.name}`,
      actor,
      method,
      path: row ? fillPath(written, row.params) : written,
      headers: {},
      body,
      expect: 'ok',
    };
  });
}

export function routeExpectations(expectations, results) {
  return routeEntries(expectations).map((entry) => {
    const actor = entry.as ?? 'anon';
    const head = `${entry.route} as ${actor}`;
    const r = (results ?? []).find((x) => x.kind === `expect:${entry.name}`);
    if (!r || r.status === null || r.status === undefined) {
      return { name: entry.name, result: 'not observed', detail: `${head}: ${r?.notRun || 'not run'}` };
    }
    const wanted = Array.isArray(entry.status) ? entry.status : [entry.status];
    const statusOk = wanted.includes(r.status);
    const lacks = entry.has !== undefined && !String(r.answer ?? '').includes(String(entry.has));
    if (statusOk && !lacks) return { name: entry.name, result: 'met', detail: `${head}: ${r.status}` };
    const detail = `${head}: ${r.status}, expected ${wanted.join(', ')}${lacks ? `, body lacks "${entry.has}"` : ''}`;
    return { name: entry.name, result: 'NOT MET', detail };
  });
}

// ---------------------------------------------------------------------------------------------
// Head against base

const isExpect = (p) => String(p.kind).startsWith('expect:');

export function diffRoutes(head, base) {
  if (!head) return null;
  const baseState = base ? (base.notRun ? 'not run' : 'swept') : 'none';
  const result = {
    file: head.file ?? null,
    rows: head.rows ?? 0,
    probes: 0,
    notRunProbes: 0,
    failed: 0,
    new: [],
    standing: 0,
    fixed: 0,
    unlisted: [],
    stale: [],
    errors: head.errors ?? [],
    notRun: head.notRun ?? null,
    base: baseState,
  };
  if (head.notRun) return result;

  const probes = (head.probes ?? []).filter((p) => !isExpect(p));
  result.probes = probes.filter((p) => p.status !== null && p.status !== undefined).length;
  result.notRunProbes = probes.filter((p) => p.notRun).length;

  const baseProbes = baseState === 'swept' ? (base.probes ?? []).filter((p) => !isExpect(p)) : [];
  const baseProblem = new Map(baseProbes.map((p) => [p.pid, p.problem]));

  for (const p of probes) {
    if (!p.problem) continue;
    result.failed += 1;
    if (baseProblem.get(p.pid)) {
      result.standing += 1;
    } else {
      result.new.push({
        id: `rte:${result.new.length + 1}`, pid: p.pid, route: p.route, kind: p.kind, actor: p.actor, status: p.status, problem: p.problem,
      });
    }
  }

  const headRan = new Map(probes.filter((p) => p.status !== null && p.status !== undefined).map((p) => [p.pid, p]));
  for (const p of baseProbes) {
    if (!p.problem) continue;
    const h = headRan.get(p.pid);
    if (h && !h.problem) result.fixed += 1;
  }

  result.unlisted = (head.unlisted ?? []).map((u, i) => ({ id: `rte:unlisted/${i + 1}`, method: u.method, path: u.path }));
  result.stale = (head.stale ?? []).map((u, i) => ({ id: `rte:stale/${i + 1}`, method: u.method, path: u.path }));
  return result;
}

// ---------------------------------------------------------------------------------------------
// One side

export async function sweepSide({
  root, profile, baseUrl, actors, expectations = [], seed = null, seedName, fetch, registered = null,
}) {
  const empty = (over) => ({
    file: null, rows: 0, registered: Array.isArray(registered) ? registered.length : null, probes: [], unlisted: [], stale: [], errors: [], notRun: null, expectations: [], ...over,
  });
  const table = await loadRouteTable({ root, profile, seed, seedName });
  if (table.file === null) return empty({ notRun: 'no route table' });
  if (table.rows.length === 0 && table.errors.length) {
    return empty({ file: table.file, errors: table.errors, notRun: 'route table has errors' });
  }

  const planned = [
    ...planSweep(table.rows, { roles: Object.keys(profile?.login ?? {}), origin: profile?.routes?.origin === true, signIn: profile?.routes?.signIn !== false }),
    ...expectationProbes(expectations, { rows: table.rows }),
  ];
  const probes = await sweep({ baseUrl: profile?.routes?.base ?? baseUrl, probes: planned, actors, fetch });
  const diff = Array.isArray(registered) ? registeredDiff(table.rows, registered) : { unlisted: [], stale: [] };
  return empty({
    file: table.file,
    rows: table.rows.length,
    probes,
    unlisted: diff.unlisted,
    stale: diff.stale,
    errors: table.errors,
    expectations: routeExpectations(expectations, probes),
  });
}
