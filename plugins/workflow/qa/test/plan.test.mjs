// `qa plan check` (scripts/lib/plan.mjs; its CONTRACT comment is the spec) and the runners' list modes
// (tests.mjs LIST MODE). Screens are observed in a real headless browser against a fixture server; tests resolve
// through real `node --test` files or injected list outputs in each runner's shape; planCheck and the CLI run with a
// fake head sandbox (injected, or registered as live so the CLI reuses it).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import {
  criteriaOf, criterionOf, dropFailed, judgeScreens, kindOf, observeScreens, planCheck, planCheckMd, resolveTest, routeProblem,
} from '../scripts/lib/plan.mjs';
import { execCommand, listCommandFor, parseListed } from '../scripts/lib/tests.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const made = [];
let server;
let baseUrl;
let port;
let pw;

const PAGES = {
  '/list': `<h1>Orders</h1><ul>${Array.from({ length: 25 }, (_, i) => `<li>Row</li><li>Order ${i + 1}</li>`).join('')}</ul>`,
  '/chart': `<h1>Margin</h1><svg width="300" height="100"><g><text x="10" y="40">Margin 22%</text></g></svg><p>Total 400K</p>`,
  '/plain': `<h1>Report</h1><button aria-label="Close dialog">×</button>
<table><thead><tr><th>Status</th><th>Name</th></tr></thead><tbody><tr><td>Open</td><td>Kite</td></tr></tbody></table>`,
  '/toggle': `<h1>Toggle</h1><button onclick="document.getElementById('d').hidden=false">Show</button><p id="d" hidden>Details shown</p>`,
};

before(async () => {
  server = http.createServer((req, res) => {
    const page = PAGES[new URL(req.url, 'http://x').pathname];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ? `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${page}</body></html>` : 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  pw = loadPlaywright(tmpDir('mfqa-pw-'));
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix = 'mfqa-plan-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
}

const PROFILE = {
  viewports: { desktop: [1280, 800] }, browser: { channel: 'chromium' }, watch: null, settle: { timeoutMs: 3000, quietMs: 100, hidden: null },
  stepTimeoutMs: 3000, maxElementsPerCapture: 80, login: { viewer: { mode: 'manual' } }, ignoreErrors: [], writes: { scope: null, allow: [], block: false }, clock: 'off',
};

const MAP = {
  flows: {},
  seed: null,
  screens: [
    { name: 'list', steps: [{ goto: '/list' }, { capture: 'default' }] },
    { name: 'chart', steps: [{ goto: '/chart' }, { capture: 'default' }] },
    { name: 'plain', steps: [{ goto: '/plain' }, { capture: 'default' }] },
    { name: 'toggle', steps: [{ goto: '/toggle' }, { capture: 'closed' }, { click: 'role=button[name="Show"]' }, { capture: 'open' }] },
    { name: 'broken', steps: [{ goto: '/plain' }, { click: 'role=button[name="Nowhere"]' }, { capture: 'default' }] },
  ],
};

// Each row: the expectation, and the problem it must get (null: none).
const SCREEN_CASES = [
  [{ name: 'orders', screens: 'list', text: 'Orders' }, null],
  [{ name: 'rows', screens: 'list', text: 'Row' }, /^matches 25 elements on list__default \(desktop\), more than 20: narrow the text, the context or the screens$/],
  [{ name: 'margin', screens: 'chart', text: 'Margin 22%' }, /^matches text inside an <svg> on chart__default \(desktop\): "Margin 22%"; capture reads no chart text/],
  [{ name: 'margin-svg', screens: 'chart', text: 'Margin 22%', svg: true }, null],
  [{ name: 'total', screens: 'chart', text: '/^Total \\d+K$/' }, null],
  [{ name: 'archived', screens: 'plain', text: 'Archived' }, /^observes 0 elements on plain__default \(desktop\): "Archived" is not on head there$/],
  [{ name: 'gone', screens: 'plain', text: 'Archived', after: 'absent' }, null],
  [{ name: 'open-status', screens: 'plain', text: 'Open', context: 'Status' }, null],
  [{ name: 'open-name', screens: 'plain', text: 'Open', context: 'Name' }, /^"Open" is on plain__default \(desktop\), but never with context "Name" \(its contexts: "Status"\)$/],
  [{ name: 'close-label', screens: 'plain', text: 'Close dialog' }, null],
  [{ name: 'shown-open', screens: 'toggle__open', text: 'Details shown' }, null],
  [{ name: 'shown-closed', screens: 'toggle__closed', text: 'Details shown' }, /^observes 0 elements on toggle__closed/],
  [{ name: 'nowhere', screens: 'nosuch-*', text: 'x' }, /^screens "nosuch-\*" matches no map screen$/],
  [{ name: 'lands', screens: 'list', url: '/list' }, null],
  [{ name: 'broken-walk', screens: 'broken', text: 'Report' }, /^could not walk broken \(desktop\): /],
  [{ name: 'bad-re', screens: 'plain', text: '/(/' }, /^text: /],
];

describe('plan check: screens, in a real browser', () => {
  let judged;
  before(async () => {
    const entries = SCREEN_CASES.map(([entry], index) => ({ index, entry }));
    const observed = await observeScreens({
      profile: PROFILE, mainRoot: tmpDir(), baseUrl, cwd: tmpDir(), vars: {}, map: MAP, pw,
      entries: entries.filter((e) => kindOf(e.entry) === 'screen'),
    });
    judged = judgeScreens({ entries, map: MAP, profile: PROFILE, ...observed, maxMatches: 20 });
  });

  for (const [i, [entry, want]] of SCREEN_CASES.entries()) {
    test(`${entry.name}: ${want ? 'a problem' : 'no problem'}`, () => {
      const got = judged[i] ?? [];
      if (!want) assert.deepEqual(got, [], `${entry.name}: ${got.join('; ')}`);
      else assert.ok(got.some((p) => want.test(p)), `${entry.name}: ${got.join('; ') || 'no problem'}`);
    });
  }

  test('the bound is the profile\'s, said in the problem', () => {
    const r = judgeScreens({
      entries: [{ index: 0, entry: { name: 'a', screens: 'list', text: 'Row' } }], map: MAP, profile: PROFILE, maxMatches: 30,
      observations: [{ index: 0, viewport: 'desktop', screen: 'list', key: 'list__default', count: 25, svg: 0, matched: 25, tree: 0, samples: [] }],
    });
    assert.deepEqual(r, {});
  });
});

// ── list modes ────────────────────────────────────────────────────────────────

describe('list modes: commands and parsers per runner', () => {
  const R = '/logs/x.list.report';
  test('each runner\'s list command carries the evidence filter and the file', () => {
    assert.equal(listCommandFor(['uv', 'run', '--directory', 'apps/server', 'pytest'], { grep: 'test_a', report: R, testFile: '/w/t.py' }).shown, 'uv run --directory apps/server pytest --collect-only --verbosity=-1 -k test_a /w/t.py');
    assert.equal(listCommandFor(['pnpm', 'exec', 'vitest', 'run'], { grep: 'draws it', report: R }).shown, `pnpm exec vitest list -t 'draws it' --json=${R}`);
    assert.equal(listCommandFor('npx vitest --run', { grep: 'x', report: R }).shown, `npx vitest list --run '-t' 'x' '--json=${R}'`);
    const p = listCommandFor(['pnpm', 'exec', 'playwright', 'test'], { grep: 'a tap', report: R, testFile: '/w/e2e/a.spec.ts' });
    assert.equal(p.shown, "pnpm exec playwright test --grep 'a tap' --list --reporter json /w/e2e/a.spec.ts");
    assert.equal(p.env.PLAYWRIGHT_JSON_OUTPUT_NAME, R);
    assert.deepEqual([listCommandFor(['npx', 'jest'], { grep: 'x', report: R, testFile: '/w/a.test.js' }).shown, listCommandFor(['npx', 'jest'], { grep: 'x', report: R }).kind], ['npx jest --runTestsByPath /w/a.test.js --listTests', 'files']);
    assert.equal(listCommandFor(['node', '--test'], { grep: 'x', report: R }), null, 'node --test has no list mode');
    assert.equal(listCommandFor('npm test', { grep: 'x', report: R }), null);
    assert.equal(listCommandFor('cd web && npx vitest run', { grep: 'x', report: R }), null, 'a shell line qa does not edit');
  });

  test('pytest --collect-only --verbosity=-1: node ids named as JUnit names them', () => {
    const r = parseListed('pytest', { output: 'tests/test_charts.py::test_radar_is_a_table\ntests/test_charts.py::TestLimits::test_seventh[6]\n\n2 tests collected in 0.02s\n' });
    assert.equal(r.source, 'pytest --collect-only');
    assert.deepEqual(r.tests[0], { name: 'tests.test_charts::test_radar_is_a_table', names: ['test_radar_is_a_table', 'tests.test_charts.test_radar_is_a_table', 'tests.test_charts › test_radar_is_a_table', 'tests/test_charts.py::test_radar_is_a_table'] });
    assert.equal(r.tests[1].name, 'tests.test_charts.TestLimits::test_seventh[6]');
    assert.deepEqual(parseListed('pytest', { output: 'no tests ran in 0.01s\n' }).tests, null);
  });

  test('vitest list: the JSON list, or "file > a > b" lines', () => {
    const json = parseListed('vitest', { report: JSON.stringify([{ name: 'chart taps > a tap lights one bar', file: '/w/a.test.ts' }]) });
    assert.deepEqual(json.tests, [{ name: 'chart taps a tap lights one bar', names: ['chart taps › a tap lights one bar', 'chart taps a tap lights one bar', 'a tap lights one bar'] }]);
    const text = parseListed('vitest', { output: 'src/a.test.ts > chart taps > a tap lights one bar\nsrc/b.test.ts > alone\n' });
    assert.deepEqual(text.tests.map((t) => t.name), ['chart taps a tap lights one bar', 'alone']);
  });

  test('playwright --list: its JSON report, or the list reporter\'s lines', () => {
    const report = JSON.stringify({ suites: [{ title: 'charts.app.spec.ts', specs: [{ title: 'a tap on a bar lights it', tests: [{ projectName: 'app', expectedStatus: 'passed', results: [] }] }] }] });
    assert.deepEqual(parseListed('playwright', { report }).tests, [{ name: '[app] › charts.app.spec.ts › a tap on a bar lights it', names: ['charts.app.spec.ts › a tap on a bar lights it', 'charts.app.spec.ts a tap on a bar lights it', 'a tap on a bar lights it'] }]);
    const text = parseListed('playwright', { output: 'Listing tests:\n  [app] › charts.app.spec.ts:395:1 › range › the range switcher redraws\nTotal: 1 test in 1 file\n' });
    assert.deepEqual(text.tests, [{ name: '[app] › charts.app.spec.ts › range › the range switcher redraws', names: ['charts.app.spec.ts › range › the range switcher redraws', 'charts.app.spec.ts range the range switcher redraws', 'the range switcher redraws'] }]);
  });

  test('jest --listTests: the files', () => {
    assert.deepEqual(parseListed('jest', { output: '/w/src/a.test.js\n/w/src/b.test.js\n' }).files, ['/w/src/a.test.js', '/w/src/b.test.js']);
  });
});

// ── tests ─────────────────────────────────────────────────────────────────────

const childExec = (req) => { const env = { ...req.env }; delete env.NODE_TEST_CONTEXT; return execCommand({ ...req, env }); };

function testTree() {
  const dir = tmpDir('mfqa-plan-tests-');
  write(dir, 'test/charts.test.mjs', `import test from 'node:test';
test('a tap on a bar lights only it', () => {});
test('a seventh series is refused', () => { throw new Error('accepted'); });
test('later', { skip: 'not yet' }, () => {});
`);
  return dir;
}

// An exec that answers a list command with `listed` (writing the report when the argv names one), and a filtered run
// with `ran`.
function fakeExec({ listed = '', report = null, ran = '' } = {}) {
  const calls = [];
  const exec = async (req) => {
    calls.push(req);
    const line = [req.file, ...req.argv].join(' ');
    if (/--collect-only|--listTests|\slist\s|--list/.test(line)) {
      const out = /--json=(\S+)/.exec(line)?.[1] ?? (req.env.PLAYWRIGHT_JSON_OUTPUT_NAME && /--list/.test(line) ? req.env.PLAYWRIGHT_JSON_OUTPUT_NAME : null);
      if (out && report) fs.writeFileSync(out.replace(/'$/, ''), report);
      return { code: 0, output: listed, ms: 1 };
    }
    return { code: 0, output: ran, ms: 1 };
  };
  return { exec, calls };
}

describe('plan check: every test entry resolves to a named test', () => {
  const resolve = (entry, suites, over = {}) => resolveTest({ entry, suites, dir: over.dir ?? testTree(), logDir: tmpDir('mfqa-plan-logs-'), exec: over.exec ?? childExec, ...over });

  test("a 'test:<level>' entry resolves with no runVerb passed, as planCheck calls it (TypeError in crm, 2026-11-13)", async () => {
    const r = await resolve({ name: 'v', test: { suite: 'test:unit', grep: 'limits hold' } }, {});
    assert.equal(r.ok, false);
    assert.match(r.problem, /NOT RUN: /);
  });

  test('node --test (no list mode): the test runs filtered; a failing one still resolves, one that is not there does not', { timeout: 60000 }, async () => {
    const suites = { unit: 'node --test' };
    const ok = await resolve({ name: 'a', test: { suite: 'unit', grep: 'a tap on a bar lights only it', file: 'test/charts.test.mjs' } }, suites);
    assert.deepEqual([ok.ok, ok.how], [true, 'ran filtered']);
    const red = await resolve({ name: 'b', test: { suite: 'unit', grep: 'a seventh series is refused', file: 'test/charts.test.mjs' } }, suites);
    assert.deepEqual([red.ok, red.how], [true, 'ran filtered'], 'a failing test is the run\'s evidence, not a plan problem');
    const none = await resolve({ name: 'c', test: { suite: 'unit', grep: 'no such test', file: 'test/charts.test.mjs' } }, suites);
    assert.equal(none.ok, false);
    assert.match(none.problem, /^0 of \d+ test\(s\) match \(tap/);
    const skipped = await resolve({ name: 'd', test: { suite: 'unit', grep: 'later', file: 'test/charts.test.mjs' } }, suites);
    assert.equal(skipped.ok, false);
    assert.match(skipped.problem, /skipped: later; a skipped test proves nothing/);
  });

  test('a file not in the head tree, an unknown suite, and a whole-suite command are problems before anything runs', async () => {
    const { exec, calls } = fakeExec();
    assert.deepEqual(await resolve({ name: 'a', test: { suite: 'unit', grep: 'x', file: 'test/none.test.mjs' } }, { unit: 'node --test' }, { exec }), { ok: false, problem: 'test.file test/none.test.mjs is not in the head tree' });
    assert.deepEqual(await resolve({ name: 'a', test: { suite: 'e2e', grep: 'x' } }, { unit: 'node --test' }, { exec }), { ok: false, problem: 'unknown suite "e2e" (known: unit or test:<level>)' });
    const whole = await resolve({ name: 'a', test: { suite: 'all', grep: 'x' } }, { all: 'npm test' }, { exec });
    assert.equal(whole.ok, false);
    assert.match(whole.problem, /^suite all cannot run one test/);
    assert.equal(calls.length, 0);
  });

  test('pytest: the collected names decide; a near miss names the first listed', async () => {
    const listed = 'tests/test_charts.py::test_a_radar_outside_three_to_eight_measures_is_a_table\ntests/test_charts.py::test_kinds_match\n\n2 tests collected in 0.02s\n';
    const suites = { server: ['uv', 'run', '--directory', 'apps/server', 'pytest'] };
    const { exec, calls } = fakeExec({ listed });
    const ok = await resolve({ name: 'a', test: { suite: 'server', grep: 'test_kinds_match' } }, suites, { exec });
    assert.deepEqual(ok, { ok: true, how: 'pytest list', names: ['tests.test_charts::test_kinds_match'] });
    assert.match([calls[0].file, ...calls[0].argv].join(' '), /pytest --collect-only --verbosity=-1 -k test_kinds_match$/);
    const miss = await resolve({ name: 'b', test: { suite: 'server', grep: 'test_options_match' } }, suites, { exec });
    assert.deepEqual(miss, { ok: false, problem: 'no test matches "test_options_match" in the pytest list (2 listed, first: tests.test_charts::test_a_radar_outside_three_to_eight_measures_is_a_table)' });
    const empty = await resolve({ name: 'c', test: { suite: 'server', grep: 'test_x' } }, suites, { exec: fakeExec({ listed: 'ERROR: file or directory not found\n' }).exec });
    assert.deepEqual(empty, { ok: false, problem: 'the pytest list gave no test names (exit 0): ERROR: file or directory not found' });
  });

  test('vitest and playwright: the JSON list in the report', async () => {
    const v = await resolve({ name: 'a', test: { suite: 'web', grep: 'a tap lights one bar' } }, { web: ['pnpm', 'exec', 'vitest', 'run'] }, { exec: fakeExec({ report: JSON.stringify([{ name: 'chart > a tap lights one bar', file: '/w/a.ts' }]) }).exec });
    assert.deepEqual(v, { ok: true, how: 'vitest list', names: ['chart a tap lights one bar'] });
    const report = JSON.stringify({ suites: [{ title: 'charts.app.spec.ts', specs: [{ title: 'a tap on a map state shows that state only', tests: [{ projectName: 'app', results: [] }] }] }] });
    const p = await resolve({ name: 'b', test: { suite: 'e2e', grep: 'a tap on a map state shows that state only' } }, { e2e: ['pnpm', 'exec', 'playwright', 'test'] }, { exec: fakeExec({ report }).exec });
    assert.deepEqual(p, { ok: true, how: 'playwright list', names: ['[app] › charts.app.spec.ts › a tap on a map state shows that state only'] });
  });

  test('jest: --listTests must list the file, then the test runs filtered', async () => {
    const dir = testTree();
    const file = path.join(dir, 'test/charts.test.mjs');
    const ran = JSON.stringify({ testResults: [{ assertionResults: [{ ancestorTitles: [], title: 'a tap on a bar lights only it', status: 'passed' }] }] });
    const { exec, calls } = fakeExec({ listed: `${file}\n`, ran });
    const ok = await resolve({ name: 'a', test: { suite: 'unit', grep: 'a tap on a bar', file: 'test/charts.test.mjs' } }, { unit: ['npx', 'jest'] }, { exec, dir });
    assert.deepEqual([ok.ok, ok.how], [true, 'ran filtered']);
    assert.equal(calls.length, 2);
    const none = await resolve({ name: 'b', test: { suite: 'unit', grep: 'x', file: 'test/charts.test.mjs' } }, { unit: ['npx', 'jest'] }, { exec: fakeExec({ listed: '' }).exec, dir });
    assert.equal(none.problem, 'jest lists no test file for test/charts.test.mjs (exit 0): ');
  });
});

// ── routes, the charter, the whole check ──────────────────────────────────────

describe('plan check: routes and criteria', () => {
  const rows = [{ method: 'GET', path: '/api/notes/:id' }, { method: 'POST', path: '/api/notes', calls: ['/api/notes?draft=1'] }];
  test('routeProblem: in the table by name, by calls or by pattern; as a known role', () => {
    assert.equal(routeProblem({ route: 'GET /api/notes/:id', as: 'viewer' }, { rows, roles: ['viewer'] }), null);
    assert.equal(routeProblem({ route: 'GET /api/notes/42' }, { rows }), null);
    assert.equal(routeProblem({ route: 'POST /api/notes?draft=1' }, { rows }), null);
    assert.equal(routeProblem({ route: 'DELETE /api/notes/42' }, { rows, file: 'qa/routes.table.json' }), 'route "DELETE /api/notes/42" is not in the route table (qa/routes.table.json)');
    assert.equal(routeProblem({ route: 'GET /api/notes/1', as: 'admin' }, { rows, roles: ['viewer'] }), 'as "admin" is not anon or a login role (viewer)');
    assert.equal(routeProblem({ route: '/api/notes' }, { rows }), 'route must be "<METHOD> <path>"');
    assert.equal(routeProblem({ route: 'GET /x' }, { rows: null }), 'no route table: a route the table lacks cannot be probed');
  });

  test('criteriaOf reads the charter\'s by: expectation <name>; the entry\'s own criterion wins', () => {
    const charter = '# Charter — x\nsecurity: no — none\n\n- [ch:1] a — axis: copy — by: expectation title-renamed\n- [ch:2] b — axis: state — by: spec\n- [ch:7] c — axis: copy — by: expectation title-renamed — advisory\n';
    const byName = criteriaOf(charter);
    assert.deepEqual(byName, { 'title-renamed': ['ch:1', 'ch:7'] });
    assert.equal(criterionOf({ name: 'title-renamed' }, byName), 'ch:1,ch:7');
    assert.equal(criterionOf({ name: 'title-renamed', criterion: 'ch:3' }, byName), 'ch:3');
    assert.equal(criterionOf({ name: 'other' }, byName), '-');
  });
});

function gitRepo() {
  const dir = tmpDir('mfqa-plan-repo-');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('symbolic-ref', 'HEAD', 'refs/heads/main');
  write(dir, 'qa.json', { ...PROFILE, login: {} });
  write(dir, 'docs/guide.md', 'CSV export\n');
  write(dir, 'qa/map/app.json', { screens: MAP.screens.slice(0, 3) });
  write(dir, '.gitignore', 'qa-artifacts/\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'one');
  return { dir, head: g('rev-parse', 'HEAD') };
}

// The plan: one entry of each kind that passes, one of each that fails, and three mutants.
function writePlan(V) {
  write(V, 'charter.md', '# Charter — x\nsecurity: no — none\n\n- [ch:1] rows — axis: cardinality — by: expectation rows\n');
  write(V, 'expectations.json', [
    { name: 'orders', screens: 'list', text: 'Orders', criterion: 'ch:2' },
    { name: 'rows', screens: 'list', text: 'Row' },
    { name: 'tap', test: { suite: 'unit', grep: 'a tap on a bar lights only it', file: 'test/charts.test.mjs' }, criterion: 'ch:3' },
    { name: 'no-test', test: { suite: 'unit', grep: 'never written', file: 'test/charts.test.mjs' }, criterion: 'ch:4' },
    { name: 'guide', doc: { file: 'docs/guide.md', contains: 'CSV export' }, criterion: 'ch:5' },
    { name: 'no-guide', doc: { file: 'docs/missing.md', contains: 'x' }, criterion: 'ch:6' },
    { name: 'denied', route: 'GET /api/x', as: 'anon', status: 401, criterion: 'ch:8' },
  ]);
  write(V, 'mutants.json', { mutants: [
    { id: 'guard-off', breaks: 'x', file: 'test/charts.test.mjs', find: "() => {});\ntest('a seventh", replace: "() => { throw 1; });\ntest('a seventh", kill: { suite: 'unit', grep: 'a tap on a bar lights only it', file: 'test/charts.test.mjs' } },
    { id: 'no-kill', breaks: 'x', file: 'test/charts.test.mjs', find: 'later', replace: 'sooner', suite: 'unit' },
    { id: 'stale', breaks: 'x', file: 'test/charts.test.mjs', find: 'nowhere in it', replace: 'y', kill: { suite: 'unit', grep: 'later' } },
  ] });
}

describe('planCheck and the CLI', () => {
  test('one pass over the plan: every kind checked, problems named with their criterion, the sandbox it brought up taken down', { timeout: 120000 }, async () => {
    const repo = gitRepo();
    const box = testTree();
    write(box, 'qa/suites.json', { suites: { unit: 'node --test' } });
    const V = path.join(repo.dir, 'qa', 'x');
    writePlan(V);
    const downs = [];
    const check = await planCheck({ mainRoot: repo.dir, repoRoot: repo.dir, profile: { ...PROFILE, login: {} }, slug: 'x', V, head: repo.head }, {
      up: async () => ({ name: 'qa-test', slug: 'qa-test', dir: box, port, appUrl: baseUrl, seedStartedAt: null }),
      down: async ({ name }) => downs.push(name),
      loadRouteTable: async () => ({ file: 'qa/routes.table.json', rows: [{ method: 'GET', path: '/api/y' }], errors: [] }),
      resolveTest: (req) => resolveTest({ ...req, exec: childExec }),
      observe: (req) => observeScreens({ ...req, pw }),
    });
    assert.deepEqual(downs, ['qa-test']);
    assert.deepEqual(check.counts, { screen: 2, url: 0, test: 2, doc: 2, route: 1, other: 0, mutant: 3 });
    assert.deepEqual(check.problems.map((p) => [p.name, p.criterion, p.kind]), [['rows', 'ch:1', 'screen'], ['no-test', 'ch:4', 'test'], ['no-guide', 'ch:6', 'doc'], ['denied', 'ch:8', 'route']]);
    assert.match(check.problems[1].problem, /^0 of \d+ test\(s\) match \(tap/);
    assert.equal(check.problems[2].problem, 'doc.file docs/missing.md is not in the head commit');
    assert.deepEqual(check.mutants.map((m) => [m.id, m.problem]), [
      ['no-kill', 'no kill test: a mutant runs only with kill { suite, grep } naming the test that must fail'],
      ['stale', 'stale: found 0 times'],
    ]);
    const md = planCheckMd(check);
    assert.match(md, /^# Plan check — x\nhead: [0-9a-f]{12} · sandbox qa-test \(up\) · at most 20 matching elements per capture\nchecked: 2 screen · 0 url · 2 test · 2 doc · 1 route · 3 mutant\n\n## Problems\n- \[rows\] ch:1: matches 25 elements/);
    assert.match(md, /\n- \[denied\] ch:8: route "GET \/api\/x" is not in the route table \(qa\/routes\.table\.json\)\n\n## Mutant problems\n- mut:no-kill: no kill test/);
    assert.deepEqual(dropFailed({ V, check }), { expectations: 4, mutants: 2, stubs: 0 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(V, 'expectations.json'), 'utf8')).map((e) => e.name), ['orders', 'tap', 'guide']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(V, 'mutants.json'), 'utf8')).mutants.map((m) => m.id), ['guard-off']);
  });

  test('a reused sandbox is left up; a sandbox that does not come up blocks the check and invents no problem', async () => {
    const repo = gitRepo();
    const V = path.join(repo.dir, 'qa', 'y');
    write(V, 'expectations.json', [{ name: 'orders', screens: 'list', text: 'Orders' }, { name: 'no-guide', doc: { file: 'docs/missing.md', contains: 'x' } }]);
    const downs = [];
    const blocked = await planCheck({ mainRoot: repo.dir, repoRoot: repo.dir, profile: PROFILE, slug: 'y', V, head: repo.head }, {
      up: async () => { throw new Error('BLOCKED ON INFRASTRUCTURE: up: port in use'); }, down: async ({ name }) => downs.push(name),
    });
    assert.equal(blocked.blocked, 'BLOCKED ON INFRASTRUCTURE: up: port in use');
    assert.deepEqual(blocked.problems.map((p) => p.name), ['no-guide'], 'docs are read from git, without the sandbox');
    assert.match(planCheckMd(blocked, { dropped: true }), /\nblocked: BLOCKED ON INFRASTRUCTURE: up: port in use \(nothing that needs the head sandbox was checked\)\n\n## Dropped from the plan\n- \[no-guide\] -: doc\.file/);
    await planCheck({ mainRoot: repo.dir, repoRoot: repo.dir, profile: PROFILE, slug: 'y', V, head: repo.head }, {
      up: async () => ({ name: 'qa-live', dir: tmpDir(), port, appUrl: baseUrl, reused: true }), down: async ({ name }) => downs.push(name),
      observe: (req) => observeScreens({ ...req, pw }),
    });
    assert.deepEqual(downs, []);
  });

  test('planCheckMd with nothing wrong: "- none"', () => {
    const md = planCheckMd({ slug: 'z', head: 'a'.repeat(40), sandbox: null, maxMatches: 20, counts: {}, problems: [], mutants: [], notes: ['n'] });
    assert.equal(md, '# Plan check — z\nhead: aaaaaaaaaaaa · no sandbox · at most 20 matching elements per capture\nchecked: 0 screen · 0 url · 0 test · 0 doc · 0 route · 0 mutant\nnote: n\n\n## Problems\n- none\n');
  });

  const cli = (cwd, args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (status) => resolve({ status, out }));
  });

  test('qa plan check: reuses the live head sandbox, writes V/plan-check.md, exit 1; --drop takes the failures out; no plan is exit 3', { timeout: 120000 }, async () => {
    const repo = gitRepo();
    const box = testTree();
    write(box, 'qa/suites.json', { suites: { unit: 'node --test' } });
    write(repo.dir, `qa-artifacts/sandboxes/qa-${repo.head.slice(0, 10)}.json`, { name: `qa-${repo.head.slice(0, 10)}`, slug: 'x', dir: box, port, appUrl: baseUrl, sha: repo.head, seedStartedAt: null, stack: null });
    assert.equal((await cli(repo.dir, ['plan', 'check', '--slug', 'x'])).status, 3);
    const V = path.join(repo.dir, 'qa', 'x');
    write(V, 'expectations.json', [
      { name: 'orders', screens: 'list', text: 'Orders', criterion: 'ch:1' },
      { name: 'margin', screens: 'chart', text: 'Margin 22%', criterion: 'ch:2' },
      { name: 'tap', test: { suite: 'unit', grep: 'a tap on a bar lights only it', file: 'test/charts.test.mjs' }, criterion: 'ch:3' },
    ]);
    write(repo.dir, 'qa/map/app.json', { screens: MAP.screens.slice(0, 3) });
    const r = await cli(repo.dir, ['plan', 'check', '--slug', 'x']);
    assert.equal(r.status, 1, r.out);
    const md = fs.readFileSync(path.join(V, 'plan-check.md'), 'utf8');
    assert.match(md, /sandbox qa-[0-9a-f]{10} \(reused\)/);
    assert.match(md, /\n## Problems\n- \[margin\] ch:2: matches text inside an <svg> on chart__default \(desktop\): "Margin 22%"/);
    assert.equal(md.split('\n').filter((l) => l.startsWith('- [')).length, 1);
    const d = await cli(repo.dir, ['plan', 'check', '--slug', 'x', '--drop']);
    assert.equal(d.status, 1, d.out);
    assert.match(fs.readFileSync(path.join(V, 'plan-check.md'), 'utf8'), /\n## Dropped from the plan\n- \[margin\] ch:2: /);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(V, 'expectations.json'), 'utf8')).map((e) => e.name), ['orders', 'tap']);
    const again = await cli(repo.dir, ['plan', 'check', '--slug', 'x']);
    assert.equal(again.status, 0, again.out);
    assert.match(fs.readFileSync(path.join(V, 'plan-check.md'), 'utf8'), /\n## Problems\n- none\n$/);
  });
});
