// Contract tests for scripts/lib/ready.mjs (`qa ready`, 0.5.0) and its two readers: runQa's readiness and
// summary.md's line. Each check is pinned on fixtures shaped like the gaps real verifies hit mid-PR: an adapter verb
// committed without its exec bit, a page no map entry reaches, a screen that shows its empty state, a seed that is
// not the same twice, a suite whose output names no test. checkReady runs with injected sandbox, capture, compare
// and suite fakes; test/ready.e2e.test.mjs runs the real thing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { DEFAULTS, validateProfile } from '../scripts/lib/profile.mjs';
import { loadMap } from '../scripts/lib/map.mjs';
import { loadPages } from '../scripts/lib/routes.mjs';
import { commandFor } from '../scripts/lib/tests.mjs';
import { buildResults, summaryMd } from '../scripts/lib/summary.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import {
  READY_FILE, checkReady, coverageCheck, determinismCheck, emptyState, execCheck, execTargets, pagePattern, pluginVersion,
  readiness, readyInputs, readyText, sampleOf, suiteItem, suitesCheck, urlPath, verbsCheck, walkCheck,
} from '../scripts/lib/ready.mjs';
import { exampleRun } from './fixtures/run-example.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix = 'mfqa-ready-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
  return file;
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

const profile = (over = {}) => ({ ...structuredClone(DEFAULTS), ...over });
const ids = (check) => check.items.filter((i) => i.status === 'FAIL').map((i) => i.id);
const itemOf = (check, id) => check.items.find((i) => i.id === id);

// ── verbs ──────────────────────────────────────────────────────────────────────

describe('verbsCheck', () => {
  test('a verb nothing serves is FAIL with the reason and the qa.json command that fixes it; a served verb passes', () => {
    const p = profile({ stack: { ...DEFAULTS.stack, adapter: ['node-static'], seed: 'node seed.mjs' } });
    const c = verbsCheck({ profile: p, mainRoot: tmpDir() });
    assert.equal(c.status, 'FAIL');
    assert.deepEqual(ids(c), ['verb:up', 'verb:test']);
    assert.match(itemOf(c, 'verb:up').reason, /^NOT RUN: no adapter for up \(node-static\)/);
    assert.match(itemOf(c, 'verb:up').fix, /qa\.json stack\.up/);
    assert.equal(itemOf(c, 'verb:seed').reason, 'qa.json: node seed.mjs');
    assert.match(itemOf(c, 'verb:build').reason, /^node-static \(plugin\)/);
    assert.equal(c.summary, '4 of 6 served');
  });

  test("an 'echo skip: <why>' command serves a verb the app does not need", () => {
    const stack = { ...DEFAULTS.stack, adapter: ['node-static'], up: "echo 'skip: no backend'", seed: 'x', test: 'y' };
    assert.equal(verbsCheck({ profile: profile({ stack }), mainRoot: tmpDir() }).status, 'PASS');
  });
});

// ── executables ────────────────────────────────────────────────────────────────

describe('execCheck', () => {
  function crmLike() {
    const root = tmpDir();
    const dir = path.join(root, 'qa', 'adapters', 'crm-api');
    write(path.join(dir, 'adapter.json'), JSON.stringify({ type: 'stack', verbs: ['headers', 'routes'] }));
    write(path.join(dir, 'headers'), '#!/usr/bin/env bash\necho {}\n', 0o644);
    write(path.join(dir, 'routes'), '#!/usr/bin/env bash\necho []\n', 0o644);
    write(path.join(dir, 'lib', 'x.sh'), 'echo lib\n', 0o644);
    write(path.join(root, 'qa', 'seed.sh'), '#!/usr/bin/env bash\n', 0o644);
    write(path.join(root, 'qa', 'e2e.sh'), '#!/usr/bin/env bash\n', 0o755);
    const p = profile({ stack: { ...DEFAULTS.stack, adapter: ['crm-api', 'custom-stack'], seed: './qa/seed.sh --fast', build: 'npm run build' } });
    return { root, p };
  }

  test('an adapter verb without its exec bit is FAIL (the CRM headers/routes case); lib files and PATH commands are not targets', () => {
    const { root, p } = crmLike();
    const targets = execTargets({ profile: p, mainRoot: root, suites: { e2e: ['qa/e2e.sh'], unit: 'npx vitest run' } });
    assert.deepEqual(targets.map((t) => t.rel), ['qa/adapters/crm-api/headers', 'qa/adapters/crm-api/routes', 'qa/seed.sh', 'qa/e2e.sh']);
    const c = execCheck({ targets });
    assert.equal(c.status, 'FAIL');
    assert.deepEqual(ids(c), ['exec:qa/adapters/crm-api/headers', 'exec:qa/adapters/crm-api/routes', 'exec:qa/seed.sh']);
    assert.equal(itemOf(c, 'exec:qa/adapters/crm-api/headers').fix, 'chmod +x qa/adapters/crm-api/headers (or qa ready --fix)');
    assert.equal(c.summary, '3 of 4 not runnable');
  });

  test('--fix makes each one executable and passes it', () => {
    const { root, p } = crmLike();
    const c = execCheck({ targets: execTargets({ profile: p, mainRoot: root }), fix: true });
    assert.equal(c.status, 'PASS');
    fs.accessSync(path.join(root, 'qa', 'adapters', 'crm-api', 'headers'), fs.constants.X_OK);
    assert.match(itemOf(c, 'exec:qa/adapters/crm-api/routes').reason, /^made executable \(--fix\)/);
    assert.match(readyText({ ready: true, open: [], checks: [c] }), /pass exec:qa\/seed\.sh — made executable/);
  });

  test('a file committed as 100644 stays FAIL after --fix: a fresh checkout would lose the bit again', () => {
    const { root, p } = crmLike();
    const c = execCheck({ targets: execTargets({ profile: p, mainRoot: root }), fix: true, gitMode: (rel) => (rel.endsWith('headers') ? '100644' : null) });
    assert.deepEqual(ids(c), ['exec:qa/adapters/crm-api/headers']);
    assert.match(itemOf(c, 'exec:qa/adapters/crm-api/headers').fix, /^git update-index --chmod=\+x qa\/adapters\/crm-api\/headers/);
  });

  test('nothing to run is one PASS item', () => {
    const c = execCheck({ targets: execTargets({ profile: profile(), mainRoot: tmpDir() }) });
    assert.equal(c.status, 'PASS');
    assert.deepEqual(c.items.map((i) => i.id), ['exec:none']);
  });
});

// ── map coverage ───────────────────────────────────────────────────────────────

describe('coverageCheck', () => {
  const screen = (name, steps, extra = {}) => ({ name, steps, file: '/m/app.json', area: 'app', ...extra });
  const map = (screens, files = ['/m/app.json']) => ({ screens, flows: {}, seed: { call: { first: { id: 'c-1' } } }, seedFile: '/m/seed.json', files, errors: [] });
  const table = (pages, file = 'qa/routes.table.json') => ({ file, pages: pages.map((p) => ({ screens: [], ...p })), errors: [] });

  test('a page no entry reaches is FAIL with the qa skill line; goto, :params, explicit screens and the walk\'s urls reach pages; skip passes with its reason', () => {
    const m = map([
      screen('home', [{ goto: '/' }, { capture: 'home' }]),
      screen('call-detail', [{ goto: '/calls/$seed.call.first.id' }, { capture: 'detail' }]),
      screen('survey-list', [{ goto: '/' }, { click: 'role=link[name="Surveys"]' }, { capture: 'list' }]),
      screen('report', [{ goto: '/' }, { click: 'role=link[name="Report"]' }, { capture: 'r' }]),
      screen('verify-only', [{ goto: '/ai-calls' }], { origin: 'verify:pr-9' }),
    ]);
    const t = table([{ path: '/' }, { path: '/calls/:id' }, { path: '/surveys', screens: ['survey-list'] }, { path: '/reports/*' },
      { path: '/ai-calls' }, { path: '/admin/debug', skip: 'internal tool, never shipped' }]);
    const c = coverageCheck({ table: t, map: m, profile: profile(), urls: { report: ['/reports/weekly'] } });
    assert.deepEqual(ids(c), ['page:/ai-calls']);
    assert.equal(itemOf(c, 'page:/ai-calls').reason, 'no map entry reaches it');
    assert.match(itemOf(c, 'page:/ai-calls').fix, /^the qa skill \/ai-calls \(or \{ "path": "\/ai-calls", "skip": "<why>" \} in qa\/routes\.table\.json\)/);
    assert.equal(itemOf(c, 'page:/admin/debug').reason, 'skipped: internal tool, never shipped');
    assert.equal(c.summary, '4 of 5 page(s) mapped · 1 skipped · 4 screen(s)');
  });

  test('no page list is FAIL pages:none (coverage cannot be measured); an empty map and the setup example are FAIL too', () => {
    const c = coverageCheck({ table: { file: null, pages: [], errors: [] }, map: map([], ['/m/example.json']), profile: profile() });
    assert.deepEqual(ids(c), ['map:empty', 'map:example', 'pages:none']);
    assert.match(itemOf(c, 'pages:none').fix, /qa\/routes\.table\.json "pages"/);
  });

  test('a page that names a screen the map lacks is FAIL', () => {
    const c = coverageCheck({ table: table([{ path: '/x', screens: ['gone'] }]), map: map([screen('home', [{ goto: '/' }])]), profile: profile() });
    assert.deepEqual(ids(c), ['page:/x']);
    assert.match(itemOf(c, 'page:/x').reason, /gone/);
  });

  test('pagePattern and urlPath', () => {
    assert.ok(pagePattern('/calls/:id').test('/calls/7'));
    assert.ok(!pagePattern('/calls/:id').test('/calls/7/edit'));
    assert.ok(pagePattern('/calls/').test('/calls'));
    assert.ok(pagePattern('/reports/*').test('/reports'));
    assert.ok(pagePattern('/reports/*').test('/reports/a/b'));
    assert.equal(urlPath('/calls?tab=2#x'), '/calls');
    assert.equal(urlPath('http://127.0.0.1:8011/#/calls/3'), '/calls/3');
  });

  test('loadPages reads JSON pages and .mjs PAGES, and drops a bad page with its error', async () => {
    const root = tmpDir();
    write(path.join(root, 'qa', 'routes.table.json'), JSON.stringify({ routes: [], pages: [{ path: '/' }, { path: 'nope' }, { path: '/a', skip: '' }, { path: '/b', screens: 'b-list' }] }));
    const r = await loadPages({ root, profile: profile() });
    assert.deepEqual(r.pages, [{ path: '/', screens: [] }, { path: '/b', screens: ['b-list'] }]);
    assert.deepEqual(r.errors, ['qa/routes.table.json: page 2: path must start with "/"', 'qa/routes.table.json: page 3: skip must be a non-empty reason']);
    const root2 = tmpDir();
    write(path.join(root2, 'qa', 'routes.table.mjs'), 'export const ROUTES = [];\nexport const PAGES = [{ path: "/x", skip: "why" }];\n');
    assert.deepEqual((await loadPages({ root: root2, profile: profile() })).pages, [{ path: '/x', screens: [], skip: 'why' }]);
    assert.deepEqual(await loadPages({ root: tmpDir(), profile: profile() }), { file: null, pages: [], errors: [] });
  });

  test('the routes.table.ts template exports PAGES that load clean', async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'qa'));
    fs.copyFileSync(new URL('../templates/routes.table.ts', import.meta.url), path.join(root, 'qa', 'routes.table.ts'));
    const r = await loadPages({ root, profile: profile() });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.pages.map((pg) => pg.path), ['/candidates', '/candidates/:id', '/admin/debug']);
  });
});

// ── the walk: failures and empty-data screens ─────────────────────────────────

describe('emptyState and walkCheck', () => {
  const TREE_EMPTY = '- heading "Calls" [level=1]\n- paragraph: No calls yet\n- button "New call"';
  const TREE_FULL = '- heading "Calls" [level=1]\n- table:\n  - row "Alice Tan 3 min":\n    - cell "Alice Tan"';

  test('an empty-state phrase is flagged; emptyOk never is; expectData decides alone when given', () => {
    assert.deepEqual(emptyState(TREE_EMPTY), { line: '- paragraph: No calls yet', why: 'shows an empty state: "No calls yet"' });
    assert.equal(emptyState(TREE_FULL), null);
    assert.equal(emptyState(TREE_EMPTY, { emptyOk: true }), null);
    assert.equal(emptyState(TREE_FULL, { expectData: 'Alice Tan' }), null);
    assert.equal(emptyState(TREE_EMPTY, { expectData: '/alice/i' }).why, 'expected data "/alice/i" is not on the screen');
    for (const text of ['Nothing to show', 'No results found', 'Your inbox is empty', 'No surveys available']) {
      assert.ok(emptyState(`- paragraph: ${text}`), text);
    }
    assert.equal(emptyState(`- paragraph: No more than five calls can be scheduled at once, so pick the ones that matter to you this week`), null, 'a long sentence is not an empty state');
    assert.equal(emptyState('- paragraph: Awaiting review'), null);
    assert.ok(emptyState('- paragraph: Awaiting review', { extra: ['^awaiting'] }), 'qa.json ready.emptyText adds phrases');
  });

  test('qa.json ready.emptyText is a valid profile key; anything else under ready is not', () => {
    assert.deepEqual(validateProfile({ ready: { emptyText: ['^awaiting'] } }).errors, []);
    assert.deepEqual(validateProfile({ ready: { sample: 3 } }).errors, ['ready.sample: unknown key']);
  });

  test('walkCheck: a failed or NOT RUN screen and an empty-data capture are FAIL; urls come from the records', () => {
    const out = tmpDir();
    write(path.join(out, 'desktop', 'calls__list.json'), JSON.stringify({ screen: 'calls', url: 'http://127.0.0.1:9/calls', tree: 'calls__list.aria.yml' }));
    write(path.join(out, 'desktop', 'calls__list.aria.yml'), TREE_EMPTY);
    write(path.join(out, 'desktop', 'search__empty.json'), JSON.stringify({ screen: 'search', url: 'http://127.0.0.1:9/search?q=zzz', tree: 'search__empty.aria.yml' }));
    write(path.join(out, 'desktop', 'search__empty.aria.yml'), '- paragraph: No results found');
    const side = { viewports: [{ viewport: 'desktop', captured: ['calls__list', 'search__empty'],
      failed: [{ screen: 'surveys', step: '{"click":"role=link[name=\\"Surveys\\"]"}', error: 'Timeout 20000ms exceeded.\nmore' }],
      notRun: [{ screen: 'admin', why: 'env QA_ADMIN_PASSWORD unset' }], warnings: [] }] };
    const { check, urls } = walkCheck({ side, out, screens: { calls: {}, search: { emptyOk: true } } });
    assert.deepEqual(ids(check), ['walk:desktop/surveys', 'walk:desktop/admin', 'empty:desktop/calls__list']);
    assert.match(itemOf(check, 'walk:desktop/surveys').reason, /^FAILED at \{"click".*: Timeout 20000ms exceeded\.$/);
    assert.match(itemOf(check, 'empty:desktop/calls__list').fix, /seed .* "emptyOk": true/);
    assert.deepEqual(urls, { calls: ['/calls'], search: ['/search'] });
  });

  test('walkCheck: a clean walk is one PASS item', () => {
    const out = tmpDir();
    write(path.join(out, 'desktop', 'calls__list.json'), JSON.stringify({ screen: 'calls', url: '/calls' }));
    write(path.join(out, 'desktop', 'calls__list.aria.yml'), TREE_FULL);
    const { check } = walkCheck({ side: { viewports: [{ viewport: 'desktop', captured: ['calls__list'], failed: [], notRun: [] }] }, out });
    assert.equal(check.status, 'PASS');
    assert.equal(check.summary, '1 capture(s) · 0 problem(s)');
  });
});

// ── determinism ────────────────────────────────────────────────────────────────

describe('determinismCheck', () => {
  const pair = (key, status, extra = {}) => ({ key, status, tree: { added: [], removed: [] }, pixel: { ratio: 0, changed: false }, ...extra });

  test('a screen that differs between two fresh seeds of one commit is FAIL with the first changed line', () => {
    const c = determinismCheck({ viewports: [{ viewport: 'desktop', pairs: [
      pair('home__default', 'same'),
      pair('calls__list', 'changed', { tree: { added: [{ n: 3, line: '  - cell "Seeded 10:42:07"' }], removed: [{ n: 3, line: '  - cell "Seeded 10:41:55"' }] } }),
      pair('avatar__default', 'same', { pixel: { ratio: 0.031, changed: true } }),
      pair('surveys__list', 'gone'),
    ] }] });
    assert.deepEqual(ids(c), ['det:desktop/calls__list', 'det:desktop/avatar__default', 'det:desktop/surveys__list']);
    assert.equal(itemOf(c, 'det:desktop/calls__list').reason, 'differs between two fresh seeds: - cell "Seeded 10:42:07"');
    assert.match(itemOf(c, 'det:desktop/avatar__default').reason, /pixels differ .*3\.1%/);
    assert.match(itemOf(c, 'det:desktop/calls__list').fix, /make the seed fixed/);
    assert.equal(c.summary, '1 of 4 sample capture(s) identical');
  });

  test('all same passes; no pair at all is FAIL det:none', () => {
    const ok = determinismCheck({ viewports: [{ viewport: 'desktop', pairs: [pair('a__x', 'same'), pair('b__y', 'same')] }] });
    assert.equal(ok.status, 'PASS');
    assert.equal(ok.items[0].reason, '2 screen(s) identical on two fresh seeds: a__x, b__y');
    assert.deepEqual(ids(determinismCheck({ viewports: [{ viewport: 'desktop', pairs: [] }] })), ['det:none']);
  });

  test('sampleOf spreads the sample evenly', () => {
    assert.deepEqual(sampleOf(['a', 'b', 'c', 'd', 'e', 'f'], 3), ['a', 'c', 'e']);
    assert.deepEqual(sampleOf(['a', 'b'], 3), ['a', 'b']);
    assert.deepEqual(sampleOf(['a'], 0), []);
  });
});

// ── suites ─────────────────────────────────────────────────────────────────────

describe('suiteItem and suitesCheck', () => {
  const TAP = 'TAP version 13\n# Subtest: radar refuses a seventh item\nok 1 - radar refuses a seventh item\n  ---\n  duration_ms: 1\n  ...\n1..1\n';

  test('a suite whose output names no test is FAIL with the reporter to add (the bizassist case)', () => {
    const i = suiteItem('unit', 'npm test', { command: 'npm test', runner: null, code: 0, output: 'Tests: 12 passed, 12 total\n', report: null });
    assert.equal(i.status, 'FAIL');
    assert.match(i.reason, /^the output names no test \(summary line: 12 passed, 0 failed, 0 skipped\)/);
    assert.match(i.fix, /call the runner directly .* \$QA_TEST_REPORT/);
    const v = suiteItem('db', 'test:db', { command: 'test:db', code: 0, output: 'all good\n', report: null });
    assert.match(v.fix, /test verb print TAP/);
  });

  test('named tests that pass are PASS; a failing one, a non-zero exit, a timeout and NOT RUN are FAIL', () => {
    assert.equal(suiteItem('unit', 'node --test', { code: 0, output: TAP }).reason, '1 named test(s) passed (tap)');
    const failed = suiteItem('unit', 'node --test', { code: 1, output: TAP.replace('ok 1', 'not ok 1') });
    assert.match(failed.reason, /^1 of 1 failed on the integration branch: radar refuses a seventh item/);
    assert.match(suiteItem('unit', 'node --test', { code: 1, output: TAP }).reason, /^exit 1 though every named test passed/);
    assert.match(suiteItem('unit', 'node --test', { code: 124, output: TAP, timedOut: true }).reason, /^timed out/);
    assert.match(suiteItem('db', 'test:db', { notRun: 'NOT RUN: no adapter for test (custom-stack)' }).reason, /^not run: NOT RUN/);
  });

  test('a JUnit report the runner wrote names the tests even when the output does not', () => {
    const report = '<testsuite><testcase classname="calls" name="lists calls"/></testsuite>';
    assert.equal(suiteItem('py', 'pytest', { code: 0, output: '1 passed', report }).status, 'PASS');
  });

  test('no registry, or a registry with no suite, is FAIL suites:none; registry errors are FAIL', () => {
    assert.deepEqual(ids(suitesCheck({ loaded: { file: null, suites: {}, mutants: [], errors: [] } })), ['suites:none']);
    const c = suitesCheck({ loaded: { file: 'qa/mutants.json', suites: { unit: 'x' }, mutants: [], errors: ['qa/mutants.json: mutant 1: missing find'] }, outcomes: { unit: { code: 0, output: TAP } } });
    assert.deepEqual(ids(c), ['registry:1']);
    assert.equal(c.summary, '1 of 1 suite(s) name their tests and pass');
  });

  test('commandFor with grep null adds the reporter and no name filter', () => {
    const c = commandFor('npx vitest run', { grep: null, report: '/r.json' });
    assert.equal(c.shown, "npx vitest run '--reporter=json' '--outputFile=/r.json'");
    assert.equal(c.filtered, false);
    assert.equal(c.env.QA_TEST_GREP, '');
    assert.equal(commandFor('node --test test/', { grep: null, report: '/r' }).shown, "node --test '--test-reporter=tap' test/");
  });
});

// ── readiness: what qa run reads ───────────────────────────────────────────

describe('readiness', () => {
  function project() {
    const root = tmpDir();
    write(path.join(root, 'qa.json'), '{}\n');
    write(path.join(root, 'qa', 'map', 'app.json'), '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
    write(path.join(root, 'qa', 'seed.json'), '{}\n');
    write(path.join(root, 'qa', 'mutants.json'), '{"suites":{"unit":"node --test"},"mutants":[]}\n');
    return root;
  }
  const writeReady = (root, over = {}) => write(path.join(root, READY_FILE), JSON.stringify({
    version: 1, ready: true, plugin: pluginVersion(), at: '2026-11-11T00:00:00.000Z', inputs: readyInputs({ repoRoot: root, mainRoot: root, profile: profile() }), open: [], ...over,
  }));

  test('no qa/ready.json is missing, with the command that proves it', () => {
    const r = readiness({ repoRoot: project(), mainRoot: null, profile: profile() });
    assert.equal(r.state, 'missing');
    assert.equal(r.line, 'project not proven ready: no qa/ready.json — run qa ready (or the qa skill)');
  });

  test('a fresh PASS is ready, with no line; a verify plan\'s map file and recorded sources do not stale it', () => {
    const root = project();
    writeReady(root);
    write(path.join(root, 'qa', 'map', 'verify-pr-9.json'), '{"screens":[]}\n');
    write(path.join(root, 'qa', 'map', 'app.sources.json'), '{}\n');
    assert.deepEqual(readiness({ repoRoot: root, mainRoot: root, profile: profile() }), { state: 'ready', why: [], line: null, file: path.join(root, READY_FILE) });
  });

  test('a changed map, seed or suite registry, or an older qa minor, is stale and names what changed', () => {
    const root = project();
    writeReady(root, { plugin: '0.4.1' });
    write(path.join(root, 'qa', 'map', 'app.json'), '{"screens":[{"name":"x","steps":[{"goto":"/"}]}]}\n');
    write(path.join(root, 'qa', 'mutants.json'), '{"suites":{},"mutants":[]}\n');
    const r = readiness({ repoRoot: root, mainRoot: root, profile: profile(), version: '0.5.0' });
    assert.equal(r.state, 'stale');
    assert.deepEqual(r.why, ['stale: proven by qa 0.4.1, this is 0.5.0', 'stale: map, suites changed since 2026-11-11']);
    assert.equal(readiness({ repoRoot: root, mainRoot: root, profile: profile(), version: '0.4.9' }).why.length, 1, 'a patch release never stales it');
  });

  test('a FAIL lists its open items first', () => {
    const root = project();
    writeReady(root, { ready: false, open: ['exec:qa/adapters/crm-api/headers', 'page:/calls', 'a', 'b', 'c', 'd'] });
    const r = readiness({ repoRoot: root, mainRoot: root, profile: profile() });
    assert.equal(r.state, 'not ready');
    assert.equal(r.line, 'project not proven ready: FAIL exec:qa/adapters/crm-api/headers, page:/calls, a, b, c +1 more');
  });

  test("summary.md carries the line as header line 3; a ready project's summary is unchanged", () => {
    const line = 'project not proven ready: FAIL page:/calls';
    const md = summaryMd(buildResults({ ...exampleRun(), readiness: { state: 'not ready', why: ['FAIL page:/calls'], line } })).split('\n');
    assert.equal(md[2], line);
    const plain = summaryMd(buildResults(exampleRun()));
    assert.equal(summaryMd(buildResults({ ...exampleRun(), readiness: { state: 'ready', why: [], line: null } })), plain);
  });

  test('runQa logs the warning before it starts, keeps it in results, and never changes the exit', async () => {
    const dir = tmpDir();
    git(['init', '-q'], dir);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
    write(path.join(dir, 'qa', 'map', 'app.json'), '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'one'], dir);
    git(['checkout', '-q', '-b', 'feat/x'], dir);
    write(path.join(dir, 'a.txt'), 'x\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'two'], dir);
    const logged = [];
    const side = { viewports: [{ viewport: 'desktop', captured: ['home__default'], failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: '' }, mapErrors: [], ms: 1 };
    const deps = {
      up: async ({ at }) => ({ name: `qa-${at.slice(0, 10)}`, slug: 'x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null }),
      down: async ({ name }) => ({ name, warnings: [] }),
      captureSide: async (req) => {
        logged.push(`capture ${path.basename(req.out)}`);
        fs.mkdirSync(path.join(req.out, 'desktop'), { recursive: true });
        return structuredClone(side);
      },
      compare: async () => ({ exit: 0, viewports: [{ viewport: 'desktop', exit: 0, pairs: [], expectations: [], unexpected: [], overflow: [], inconclusive: [], eyes: [], standing: { checks: 0, tour: 0, console: 0 } }] }),
    };
    const run = await runQa({ mainRoot: dir, repoRoot: dir, profile: profile(), routes: false, mutants: 'none', full: true, log: (...a) => logged.push(a.join(' ')) }, deps);
    assert.equal(logged[0], 'warning: project not proven ready: no qa/ready.json — run qa ready (or the qa skill)');
    assert.equal(run.results.readiness.state, 'missing');
    assert.equal(run.exit, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'qa', 'feat-x', 'summary.md'), 'utf8').split('\n')[2], 'project not proven ready: no qa/ready.json — run qa ready (or the qa skill)');
  });
});

// ── checkReady with injected deps ─────────────────────────────────────────────

describe('checkReady', () => {
  function repo() {
    const dir = tmpDir();
    git(['init', '-q'], dir);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
    write(path.join(dir, 'qa.json'), '{}\n');
    write(path.join(dir, 'qa', 'map', 'app.json'), JSON.stringify({ screens: [
      { name: 'home', sources: ['src/Home.tsx'], steps: [{ goto: '/' }, { capture: 'home' }] },
      { name: 'calls', sources: ['src/calls/**'], steps: [{ goto: '/calls' }, { capture: 'list' }] },
    ] }));
    write(path.join(dir, 'qa', 'routes.table.json'), JSON.stringify({ routes: [], pages: [{ path: '/' }, { path: '/calls' }, { path: '/surveys' }] }));
    write(path.join(dir, 'qa', 'mutants.json'), JSON.stringify({ suites: { unit: 'node --test' }, mutants: [] }));
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'one'], dir);
    return dir;
  }
  const p = () => profile({ stack: { ...DEFAULTS.stack, setup: 'true', up: 'true', seed: 'true', build: 'true', serve: 'true', test: 'true' } });

  // A capture that writes a record and tree per screen; trees[name] decides what the screen shows.
  function fakes(dir, { trees = {}, compareResult, reused = false } = {}) {
    const calls = { up: [], down: [], capture: [], suite: [] };
    const deps = {
      up: async (req) => {
        calls.up.push(req.at);
        return { name: 'qa-x', slug: 'qa-x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null, reused, steps: [{ verb: 'seed', code: 0, ms: 2000, notRun: null }] };
      },
      down: async (req) => { calls.down.push(req.name); return { name: req.name, warnings: [] }; },
      captureSide: async (req) => {
        calls.capture.push({ out: path.basename(req.out), screens: req.screens, viewports: req.viewports, map: req.map });
        const names = req.screens ? req.screens.split(',') : ['home', 'calls'];
        for (const n of names) {
          write(path.join(req.out, 'desktop', `${n}__x.json`), JSON.stringify({ screen: n, url: `http://127.0.0.1:1/${n === 'home' ? '' : n}`, tree: `${n}__x.aria.yml` }));
          write(path.join(req.out, 'desktop', `${n}__x.aria.yml`), trees[n] ?? `- heading "${n}"\n- row "Alice Tan"`);
        }
        return { viewports: [{ viewport: 'desktop', captured: names.map((n) => `${n}__x`), failed: [], notRun: [], warnings: [] }] };
      },
      compare: async () => compareResult ?? { exit: 0, viewports: [{ viewport: 'desktop', pairs: [{ key: 'home__x', status: 'same' }, { key: 'calls__x', status: 'same' }] }] },
      runSuite: async (req) => { calls.suite.push(req.id); return { command: 'node --test', code: 0, output: 'TAP version 13\nok 1 - lists calls\n1..1\n' }; },
    };
    return { calls, deps };
  }

  test('the order is A up, sample, full walk, suites, A down, B up, sample, B down; the checkout\'s map is walked; qa/ready.json is written', async () => {
    const dir = repo();
    const { calls, deps } = fakes(dir);
    const r = await checkReady({ mainRoot: dir, repoRoot: dir, profile: p(), sample: 2, log: () => {} }, deps);
    assert.deepEqual(calls.capture.map((c) => [c.out, c.screens]), [['a', 'calls,home'], ['walk', 'calls,home'], ['b', 'calls,home']]);
    assert.equal(calls.capture[1].map, path.join(dir, 'qa', 'map'));
    assert.deepEqual(calls.suite, ['unit']);
    assert.equal(calls.up.length, 2);
    assert.equal(calls.down.length, 2);
    assert.equal(r.ref, 'main');
    assert.deepEqual(r.open, ['page:/surveys']);
    assert.equal(r.ready, false);
    const file = JSON.parse(fs.readFileSync(path.join(dir, READY_FILE), 'utf8'));
    assert.deepEqual(file.open, ['page:/surveys']);
    assert.equal(file.commit, git(['rev-parse', 'HEAD'], dir));
    assert.deepEqual(file.checks.map((c) => `${c.id} ${c.status}`), ['verbs PASS', 'exec PASS', 'map FAIL', 'seed PASS', 'walk PASS', 'determinism PASS', 'suites PASS', 'upgrade CONCERN']);
    assert.deepEqual(file.concerns, ['suites:old-place'], 'the suites still sit in qa/mutants.json: a concern, never open');
  });

  test('an empty-data screen and a seed that differs twice are both open items (the CRM seed case)', async () => {
    const dir = repo();
    const compareResult = { exit: 1, viewports: [{ viewport: 'desktop', pairs: [{ key: 'home__x', status: 'changed', tree: { added: [{ line: '- text: Seeded at 10:42' }], removed: [] } }] }] };
    const { deps } = fakes(dir, { trees: { calls: '- heading "Calls"\n- paragraph: No calls yet' }, compareResult });
    const r = await checkReady({ mainRoot: dir, repoRoot: dir, profile: p(), log: () => {} }, deps);
    assert.deepEqual(r.open, ['page:/surveys', 'empty:desktop/calls__x', 'det:desktop/home__x']);
    assert.match(readyText(r), /^NOT READY — 3 open/);
    assert.match(readyText(r), /FAIL empty:desktop\/calls__x — shows an empty state: "No calls yet"/);
  });

  test('a sandbox that was already up is never downed, and its seed and determinism are FAIL', async () => {
    const dir = repo();
    const { calls, deps } = fakes(dir, { reused: true });
    const r = await checkReady({ mainRoot: dir, repoRoot: dir, profile: p(), log: () => {} }, deps);
    assert.deepEqual(calls.down, []);
    assert.equal(calls.up.length, 1);
    assert.ok(r.open.includes('seed:run') && r.open.includes('det:reused'), r.open.join(' '));
  });

  test('a sandbox that does not come up is a seed FAIL with its message, the rest not run', async () => {
    const dir = repo();
    const { deps } = fakes(dir);
    deps.up = async () => { throw new Error('BLOCKED ON INFRASTRUCTURE: seed: exit 1: relation "calls" does not exist'); };
    const r = await checkReady({ mainRoot: dir, repoRoot: dir, profile: p(), log: () => {} }, deps);
    const seed = r.checks.find((c) => c.id === 'seed');
    assert.equal(seed.items[0].reason, 'BLOCKED ON INFRASTRUCTURE: seed: exit 1: relation "calls" does not exist');
    assert.ok(r.open.includes('walk:not-run') && r.open.includes('determinism:not-run') && r.open.includes('suite:unit'), r.open.join(' '));
  });

  test('expectData may name a seeded record: $seed tokens resolve from the seed names before the walk is judged', async () => {
    const dir = repo();
    write(path.join(dir, 'qa', 'seed.json'), JSON.stringify({ call: { first: { who: 'Alice Tan' } } }));
    write(path.join(dir, 'qa', 'map', 'app.json'), JSON.stringify({ screens: [
      { name: 'home', steps: [{ goto: '/' }], expectData: '$seed.call.first.who' },
      { name: 'calls', steps: [{ goto: '/calls' }], expectData: '$seed.call.first.who' },
    ] }));
    const { deps } = fakes(dir, { trees: { home: '- heading "Home"\n- paragraph: Welcome' } });
    const r = await checkReady({ mainRoot: dir, repoRoot: dir, profile: p(), log: () => {} }, deps);
    const walk = r.checks.find((c) => c.id === 'walk');
    assert.deepEqual(ids(walk), ['empty:desktop/home__x']);
    assert.equal(itemOf(walk, 'empty:desktop/home__x').reason, 'expected data "Alice Tan" is not on the screen');
  });

  test('--static checks without a sandbox and writes no file', async () => {
    const dir = repo();
    const { calls, deps } = fakes(dir);
    const r = await checkReady({ mainRoot: dir, repoRoot: dir, profile: p(), sandbox: false, log: () => {} }, deps);
    assert.equal(calls.up.length, 0);
    assert.equal(r.ready, false);
    assert.ok(!fs.existsSync(path.join(dir, READY_FILE)));
  });

  test('loadMap of the checkout keeps expectData and emptyOk as map keys (map check accepts them)', () => {
    const dir = tmpDir();
    write(path.join(dir, 'qa', 'map', 'app.json'), JSON.stringify({ screens: [{ name: 's', steps: [{ goto: '/' }], expectData: 'Alice', emptyOk: false }] }));
    const m = loadMap({ root: dir, profile: profile() });
    const c = coverageCheck({ table: { file: 'qa/routes.table.json', pages: [{ path: '/', screens: [] }], errors: [] }, map: m, profile: profile() });
    assert.equal(c.status, 'PASS', JSON.stringify(c.items));
  });
});
