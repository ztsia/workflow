// Contract tests for rework U4 (design §7, D32/D33): the affected set's four triggers, out-of-scope screens with no
// known sources, the PR's overlay (where it is, how it merges, that another PR's is never read), the route side file,
// and the run's base side: only changed screens, from a per-screen cache every PR on the same base shares.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { affectedScreens, prEntries } from '../scripts/lib/affected.mjs';
import { loadMap, selectScreens } from '../scripts/lib/map.mjs';
import { mergeBy, routesFile } from '../scripts/lib/overlay.mjs';
import { loadPages, loadRouteTable } from '../scripts/lib/routes.mjs';
import { baseScreenNames, runQa } from '../scripts/lib/run.mjs';
import { summaryMd } from '../scripts/lib/summary.mjs';

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(prefix = 'mfqa-scope-') {
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

// ── the affected set ──────────────────────────────────────────────────────────

const FILE = '/repo/qa/map/app.json';
const scr = (name, over = {}) => ({ name, area: 'app', file: FILE, steps: [{ goto: `/${name}` }, { capture: 'default' }], ...over });
const mapOf = (screens, flows = {}, overlay = null) => ({ screens, flows, seed: null, seedFile: '', files: [FILE], errors: [], ...(overlay ? { overlay } : {}) });

describe('affected set (design §7): the first true of four triggers', () => {
  const shared = () => [
    scr('orders', { sources: ['src/orders/**'] }),
    scr('invoices', { sources: ['src/invoices/*.tsx'] }),
    scr('settings'), // no sources known
  ];

  test('1. qa.json or the seed names file changed: every screen', () => {
    for (const file of ['qa.json', 'qa/seed.json']) {
      const a = affectedScreens({ head: mapOf(shared()), base: mapOf(shared()), changed: [file] });
      assert.deepEqual(a.names, ['orders', 'invoices', 'settings'], file);
      assert.equal(a.why.settings, `everything: ${file} changed`);
      assert.deepEqual(a.mapThese, []);
    }
  });

  test('1. a lockfile alone no longer walks everything', () => {
    for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'web/package-lock.json']) {
      const a = affectedScreens({ head: mapOf(shared()), base: mapOf(shared()), changed: [file] });
      assert.deepEqual(a.names, [], file);
    }
  });

  test('2. an entry in the PR\'s overlay: "in overlay", whatever changed (nothing included)', () => {
    const head = mapOf(shared(), {}, { dir: '/o', screens: ['invoices'], flows: [], files: [] });
    const a = affectedScreens({ head, base: mapOf(shared()), changed: [] });
    assert.deepEqual(a.names, ['invoices']);
    assert.equal(a.why.invoices, 'in overlay');
  });

  test('2. with no overlay folder the PR\'s entries are qa/ in the branch: a new or changed entry; the verifier\'s own entries count too', () => {
    const head = mapOf([...shared(), scr('reports', { sources: ['src/reports/x.tsx'] }), scr('orders-empty', { origin: 'verify:pr-1' })]);
    const base = mapOf(shared().map((s) => (s.name === 'invoices' ? { ...s, steps: [{ goto: '/old' }] } : s)));
    const a = affectedScreens({ head, base, changed: ['README.md'], slug: 'pr-1' });
    assert.deepEqual(a.why, { invoices: 'entry changed', reports: 'new entry', 'orders-empty': 'in overlay' });
  });

  test('3. sources match a changed file', () => {
    const a = affectedScreens({ head: mapOf(shared()), base: mapOf(shared()), changed: ['src/orders/list/Table.tsx'], sources: { invoices: ['src/x.ts'] } });
    assert.deepEqual(a.names, ['orders']);
    assert.equal(a.why.orders, 'sources: src/orders/list/Table.tsx');
    const rec = affectedScreens({ head: mapOf(shared()), base: mapOf(shared()), changed: ['src/x.ts'], sources: { invoices: ['src/x.ts'] } });
    assert.equal(rec.why.invoices, 'source: src/x.ts');
  });

  test('4. a journey that passes through an affected screen', () => {
    const flows = { 'open:orders': { steps: [{ goto: '/orders' }], file: FILE } };
    const head = mapOf([scr('orders', { flow: 'open:orders', sources: ['src/orders/**'] }), scr('order-journey', { flow: 'open:orders', record: true })], flows);
    const a = affectedScreens({ head, base: head, changed: ['src/orders/a.ts'] });
    assert.equal(a.why['order-journey'], 'journey through orders');
  });

  test('no known sources and no trigger: out of scope — never in names, listed in mapThese, counted in unknown', () => {
    const a = affectedScreens({ head: mapOf(shared()), base: mapOf(shared()), changed: ['src/orders/a.ts'] });
    assert.deepEqual(a.names, ['orders']);
    assert.ok(!('settings' in a.why));
    assert.deepEqual(a.mapThese, ['settings']);
    assert.equal(a.unknown, 1);
    assert.ok(a.skipped.includes('settings'));
  });

  test('summary.md lists the out-of-scope screens under "map these"', () => {
    const results = minimalResults({ mode: 'affected', names: ['orders'], why: { orders: 'sources: x' }, total: 3, unknown: 1, mapThese: ['settings'], skipped: 2, unmapped: [] });
    const md = summaryMd(results);
    assert.match(md, /\naffected: 1 of 3 screens \(1 without known sources\)\nmap these: settings — no known sources, so not walked \(out of scope\); the prepare step or the qa skill records their sources\n/);
    const none = summaryMd(minimalResults({ mode: 'affected', names: ['orders'], why: {}, total: 1, unknown: 0, mapThese: [], skipped: 0, unmapped: [] }));
    assert.doesNotMatch(none, /map these/);
  });

  test('prEntries: the overlay\'s entries; without one, what the branch adds or changes', () => {
    const head = mapOf(shared(), {}, { dir: '/o', screens: ['settings'], flows: [], files: [] });
    assert.deepEqual(prEntries(head, mapOf(shared())), ['settings']);
    const branch = mapOf([...shared(), scr('reports')]);
    assert.deepEqual(prEntries(branch, mapOf(shared())), ['reports']);
    assert.deepEqual(prEntries(branch, null), ['orders', 'invoices', 'settings', 'reports'], 'a base with no map: all new');
    assert.deepEqual(prEntries(branch, branch), [], 'both read from disk: nothing tells new from old');
  });
});

function minimalResults(affected) {
  return {
    mode: 'diff', slug: 's', exit: 0, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), cached: false }, maps: { head: 'c'.repeat(64) },
    sandboxes: {}, steps: [], warnings: [], mapErrors: 0, affected, videos: [], failures: [], notRun: [], screens: [], expectations: [], unexpected: [],
    tour: { opened: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [] }, checks: { new: [], standing: 0, fixed: 0 },
    console: { new: [] }, routes: null, mutants: null, metrics: null, standing: { checks: 0, tour: 0, console: 0 }, livedIn: null,
  };
}

// ── the overlay ───────────────────────────────────────────────────────────────

describe('overlay: how it merges (a library caller sets profile.overlay; the qa CLI sets none)', () => {
  test('loadMap: an overlay screen replaces the shared one in place, a new one is appended, an overlay flow wins; another PR\'s overlay is never seen', () => {
    const root = tmpDir();
    const local = tmpDir('mfqa-local-');
    write(root, 'qa/map/app.json', { flows: { 'open:o': [{ goto: '/orders' }] }, screens: [
      { name: 'orders', flow: 'open:o', steps: [{ capture: 'list' }] }, { name: 'settings', steps: [{ goto: '/s' }] },
    ] });
    write(local, 'prs/pr-x/qa/map/pr-x.json', { flows: { 'open:o': [{ goto: '/orders?v=2' }] }, screens: [
      { name: 'orders', flow: 'open:o', sources: ['src/orders/**'], steps: [{ capture: 'list' }] }, { name: 'reports', sources: ['src/r.tsx'], steps: [{ goto: '/r' }] },
    ] });
    write(local, 'prs/pr-y/qa/map/pr-y.json', { screens: [{ name: 'secret-y', steps: [{ goto: '/y' }] }] });
    const profile = { map: 'qa/map', seedNames: 'qa/seed.json' };
    const plain = loadMap({ root, profile });
    assert.equal(plain.overlay, undefined, 'no overlay key without profile.overlay');
    const m = loadMap({ root, profile: { ...profile, overlay: path.join(local, 'prs', 'pr-x', 'qa') } });
    assert.deepEqual(m.screens.map((s) => s.name), ['orders', 'settings', 'reports']);
    assert.deepEqual(m.screens[0].sources, ['src/orders/**']);
    assert.deepEqual(m.flows['open:o'].steps, [{ goto: '/orders?v=2' }]);
    assert.deepEqual(m.overlay.screens, ['orders', 'reports']);
    assert.ok(!m.screens.some((s) => s.name === 'secret-y'), 'pr-y\'s overlay is not visible to pr-x');
    assert.deepEqual(m.errors, []);
  });

  test('routes: rows of the side file and the overlay replace the table\'s by METHOD path, the rest are appended; pages by path', async () => {
    const root = tmpDir();
    const over = tmpDir('mfqa-over-');
    write(root, 'qa/routes.table.mjs', "export const ROUTES = [{ method: 'GET', path: '/api/a', auth: 'public' }, { method: 'GET', path: '/api/b' }];\nexport const PAGES = [{ path: '/a' }];\n");
    write(root, 'qa/routes.json', { routes: [{ method: 'GET', path: '/api/b', auth: 'public' }, { method: 'POST', path: '/api/c', body: { x: 1 } }], pages: [{ path: '/c', screens: 'c' }] });
    write(over, 'routes.json', { routes: [{ method: 'DELETE', path: '/api/d', auth: 'role', roles: ['admin'] }, { method: 'GET', path: '/api/a', auth: 'signed-in' }], pages: [{ path: '/d', screens: ['d'] }] });
    const t = await loadRouteTable({ root, profile: { overlay: over } });
    assert.equal(t.file, 'qa/routes.table.mjs');
    assert.deepEqual(t.rows.map((r) => `${r.method} ${r.path} ${r.auth ?? '-'}`), ['GET /api/a signed-in', 'GET /api/b public', 'POST /api/c -', 'DELETE /api/d role']);
    assert.deepEqual(t.errors, []);
    const without = await loadRouteTable({ root, profile: {} });
    assert.deepEqual(without.rows.map((r) => `${r.method} ${r.path}`), ['GET /api/a', 'GET /api/b', 'POST /api/c'], 'no overlay: the table and the side file');
    const p = await loadPages({ root, profile: { overlay: over } });
    assert.deepEqual(p.pages.map((x) => x.path), ['/a', '/c', '/d']);
    const onlySide = tmpDir();
    write(onlySide, 'qa/routes.json', [{ method: 'GET', path: '/x' }]);
    assert.equal((await loadRouteTable({ root: onlySide, profile: {} })).file, 'qa/routes.json');
    write(over, 'routes.json', '{ not json');
    assert.match((await loadRouteTable({ root, profile: { overlay: over } })).errors[0], /^routes\.json: /);
  });

  test('routesFile and mergeBy', () => {
    const dir = tmpDir();
    write(dir, 'a.json', [{ method: 'GET', path: '/a' }]);
    assert.deepEqual(routesFile(path.join(dir, 'a.json')), { routes: [{ method: 'GET', path: '/a' }], pages: [], errors: [] });
    assert.deepEqual(routesFile(path.join(dir, 'none.json')), { routes: [], pages: [], errors: [] });
    assert.deepEqual(mergeBy([{ k: 1, v: 'a' }, { k: 2, v: 'b' }], [{ k: 2, v: 'B' }, { k: 3, v: 'c' }], (x) => x.k), [{ k: 1, v: 'a' }, { k: 2, v: 'B' }, { k: 3, v: 'c' }]);
  });
});

// ── the run: overlay on head only, base only for changed screens, a shared per-screen cache ─────────────────────

// A repo whose qa/ is untracked, with two overlay folders kept beside it. main: commit 1;
// base = main's tip; head = feat/x, which changes src/a.ts. Shared map: alpha (sources src/a.ts), beta (src/b.ts),
// gamma (none known).
function overlayRepo() {
  const dir = tmpDir('mfqa-scope-repo-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(dir, '.gitignore', 'qa/\nqa-artifacts/\noverlays/\n');
  write(dir, 'src/a.ts', 'a1\n');
  write(dir, 'src/b.ts', 'b1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'feat/x');
  write(dir, 'src/a.ts', 'a2\n');
  git(dir, 'commit', '-qam', 'two');
  const head = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'qa/map/app.json', { screens: [
    { name: 'alpha', sources: ['src/a.ts'], steps: [{ goto: '/alpha' }] },
    { name: 'beta', sources: ['src/b.ts'], steps: [{ goto: '/beta' }] },
    { name: 'gamma', steps: [{ goto: '/gamma' }] },
  ] });
  const local = path.join(dir, 'overlays');
  write(local, 'prs/x/qa/map/x.json', { screens: [
    { name: 'alpha', sources: ['src/a.ts'], steps: [{ goto: '/alpha?v=2' }] },
    { name: 'delta', sources: ['src/d.ts'], steps: [{ goto: '/delta' }] },
  ] });
  write(local, 'prs/y/qa/map/y.json', { screens: [
    { name: 'beta', sources: ['src/b.ts'], steps: [{ goto: '/beta?v=2' }] },
    { name: 'epsilon', sources: ['src/e.ts'], steps: [{ goto: '/e' }] },
  ] });
  return { dir, base, head, local };
}

const PROFILE = { map: 'qa/map', seedNames: 'qa/seed.json', viewports: { desktop: [1280, 800] }, clock: 'off', run: { cacheKeep: 5 }, sandbox: { retryWaitMs: 1 } };

// Fakes that walk what the map (as the side's profile reads it) names: one '<screen>__default' capture each.
function fakes(dir, { handOffHead = false } = {}) {
  const calls = { up: [], down: [], capture: [], compare: [] };
  const deps = {
    up: async (req) => {
      calls.up.push(req.at);
      const d = { name: `qa-${req.at.slice(0, 10)}`, slug: 'x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null };
      return handOffHead && req.at !== calls.baseSha ? { ...d, reused: true, handOff: 'prepare' } : d;
    },
    down: async (req) => { calls.down.push(req.name); return { warnings: [] }; },
    captureSide: async (req) => {
      const map = loadMap({ root: req.cwd, profile: req.profile });
      const picked = selectScreens(map.screens, { only: req.screens });
      calls.capture.push({ side: req.out.includes(`${path.sep}.tmp-`) || req.out.endsWith(`${path.sep}base`) ? 'base' : 'head', screens: picked.map((s) => s.name), overlay: req.profile.overlay ?? null, steps: picked.map((s) => s.steps[0].goto) });
      const vps = req.viewports ?? Object.keys(req.profile.viewports);
      for (const vp of vps) for (const s of picked) write(req.out, `${vp}/${s.name}__default.json`, { screen: s.name });
      return { viewports: vps.map((viewport) => ({ viewport, captured: picked.map((s) => `${s.name}__default`), failed: [], notRun: [], warnings: [] })), clock: { clock: null, why: 'off' }, mapErrors: [], ms: 1 };
    },
    compare: async (req) => { calls.compare.push(req); fs.mkdirSync(req.out, { recursive: true }); return { exit: 0, viewports: [] }; },
    sweepSide: async () => ({ file: null, rows: 0, registered: null, probes: [], unlisted: [], stale: [], errors: [], notRun: 'no route table', expectations: [] }),
    runVerb: async () => ({ notRun: 'none' }),
    mutate: async () => ({ selected: 0, result: null }),
    readiness: () => ({ state: 'ready', line: null }),
    sleep: async () => {},
  };
  return { deps, calls };
}

describe('runQa (rework U4): the overlay on head only; base walks only changed screens, from a shared per-screen cache', () => {
  const opts = (r, slug, over = {}) => ({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, base: r.base, slug, log: () => {}, overlay: path.join(r.local, 'prs', slug, 'qa'), ...over });

  test('PR x: head walks its overlay entries (alpha changed, delta new); base walks alpha only, without the overlay; gamma is listed to map', async () => {
    const r = overlayRepo();
    const f = fakes(r.dir);
    const run = await runQa(opts(r, 'x'), f.deps);
    assert.deepEqual(run.affected.why, { alpha: 'in overlay', delta: 'in overlay' });
    assert.deepEqual(run.affected.mapThese, ['gamma']);
    assert.deepEqual(run.newEntries, { delta: 'map entry new' });
    const head = f.calls.capture.find((c) => c.side === 'head');
    const base = f.calls.capture.find((c) => c.side === 'base');
    assert.deepEqual(head.screens, ['alpha', 'delta']);
    assert.deepEqual(head.steps, ['/alpha?v=2', '/delta'], 'head walks the overlay\'s entries');
    assert.ok(head.overlay);
    assert.deepEqual(base.screens, ['alpha'], 'never a screen new on head');
    assert.deepEqual(base.steps, ['/alpha'], 'base walks the shared entry');
    assert.equal(base.overlay, null);
    assert.ok(!f.calls.capture.some((c) => c.screens.includes('epsilon')), 'pr-y\'s overlay is never read');
  });

  test('the base cache is keyed without the PR: PR y on the same base walks only the base screen x did not; a re-verify of x walks no base', async () => {
    const r = overlayRepo();
    const x = await runQa(opts(r, 'x'), fakes(r.dir).deps);
    const fy = fakes(r.dir);
    const y = await runQa(opts(r, 'y'), fy.deps);
    assert.equal(y.dirs.cache, x.dirs.cache, 'one cache entry for the base');
    assert.equal(y.maps.base, x.maps.base);
    assert.deepEqual(y.affected.why, { alpha: 'sources: src/a.ts', beta: 'in overlay', epsilon: 'in overlay' });
    assert.deepEqual(fy.calls.capture.find((c) => c.side === 'base').screens, ['beta'], 'alpha came from the cache');
    const view = path.join(r.dir, 'qa-artifacts', 'runs', 'y', 'base', 'desktop');
    assert.deepEqual(fs.readdirSync(view).sort(), ['alpha__default.json', 'beta__default.json']);
    const fx = fakes(r.dir);
    const again = await runQa(opts(r, 'x'), fx.deps);
    assert.equal(again.base.cached, true);
    assert.equal(again.sandboxes.base.state, 'cached');
    assert.deepEqual(fx.calls.up, [r.head], 'no base sandbox at all');
    assert.ok(!fx.calls.capture.some((c) => c.side === 'base'));
  });

  test('a new expectation text is a miss for the screens cached without it; the base moving is a new cache entry', async () => {
    const r = overlayRepo();
    await runQa(opts(r, 'x'), fakes(r.dir).deps);
    const V = path.join(r.dir, 'qa', 'x');
    write(V, 'expectations.json', [{ name: 'shown', screens: 'alpha', text: 'Alpha total' }]);
    const f = fakes(r.dir);
    await runQa(opts(r, 'x'), f.deps);
    assert.deepEqual(f.calls.capture.find((c) => c.side === 'base').screens, ['alpha']);
    const f2 = fakes(r.dir);
    const second = await runQa(opts(r, 'x'), f2.deps);
    assert.equal(second.base.cached, true, 'now cached with that text');
    git(r.dir, 'checkout', '-q', 'main');
    write(r.dir, 'src/b.ts', 'b2\n');
    git(r.dir, 'commit', '-qam', 'main moves');
    git(r.dir, 'checkout', '-q', 'feat/x');
    git(r.dir, 'merge', '-q', '--no-edit', 'main');
    const moved = await runQa(opts(r, 'x', { base: 'main' }), fakes(r.dir).deps);
    assert.notEqual(moved.dirs.cache, second.dirs.cache);
    assert.equal(moved.base.cached, false);
  });

  test('a head sandbox the prepare check left up (handOff) is taken down by the run', async () => {
    const r = overlayRepo();
    const f = fakes(r.dir, { handOffHead: true });
    f.calls.baseSha = r.base;
    await runQa(opts(r, 'x'), f.deps);
    assert.ok(f.calls.down.includes(`qa-${r.head.slice(0, 10)}`));
  });

  test('baseScreenNames: affected minus new; full/screens from the base map minus new; none for no affected screen', () => {
    const baseMap = mapOf([scr('a'), scr('b'), scr('c')]);
    assert.deepEqual(baseScreenNames({ affected: { mode: 'affected', names: ['a', 'n'] }, newEntries: { n: 'map entry new' } }), ['a']);
    assert.deepEqual(baseScreenNames({ affected: { mode: 'full' }, baseMap, newEntries: {} }), ['a', 'b', 'c']);
    assert.deepEqual(baseScreenNames({ baseMap, screens: 'b*,c' }), ['b', 'c']);
    assert.deepEqual(baseScreenNames({ noAffected: true, baseMap }), []);
    assert.equal(baseScreenNames({ affected: null, baseMap: null }), null);
  });
});
