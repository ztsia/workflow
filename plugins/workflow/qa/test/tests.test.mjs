// Test evidence (scripts/lib/tests.mjs, 0.4.0): a criterion proven by a named test qa runs itself on the head
// sandbox. Parsers read fixture outputs in each runner's shape; runTests runs a real `node --test` suite in a temp
// worktree; runQa takes injected sandboxes (as test/run.test.mjs does) and the real runTests, so the test runs in
// the sandbox's worktree, never the checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { compareViewport } from '../scripts/lib/compare.mjs';
import { reportHtml } from '../scripts/lib/report.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { buildResults, summaryMd } from '../scripts/lib/summary.mjs';
import {
  commandFor, entryProblem, grepMatcher, judgeTest, parseTests, runTests, runnerOf, testEntries, withBase,
} from '../scripts/lib/tests.mjs';
import { draftVerdict } from '../scripts/lib/verdict.mjs';
import { exampleRun } from './fixtures/run-example.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A node:test file: one pass, one skip, one fail inside a describe, and one pass at the top level.
const CHART_TESTS = `import test, { describe } from 'node:test';
describe('chart taps', () => {
  test('a tap on a donut slice lights only it', () => {});
  test('a tap on a radar point lights only it', { skip: 'not yet' }, () => {});
  test('a tap on a funnel stage lights only it', () => { throw new Error('two stages lit'); });
});
test('zod and pydantic accept the same kinds', () => {});
`;

// A worktree with that test file under test/ and a node --test suite.
// The env of a child node --test run from inside this one: without NODE_TEST_CONTEXT it prints its own report.
const childEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

function worktree() {
  const dir = tmpDir('mfqa-tests-');
  write(dir, 'test/charts.test.mjs', CHART_TESTS);
  return dir;
}
const SUITES = { unit: 'node --test test/charts.test.mjs' };
const entry = (name, grep, over = {}) => ({ name, test: { suite: 'unit', grep }, ...over });

// ── fixtures in each runner's shape ─────────────────────────────────────────────

// Playwright's JSON reporter: file › describe › spec, one test per project.
const PLAYWRIGHT_JSON = {
  config: { version: '1.48.0' },
  suites: [{
    title: 'charts.spec.ts', file: 'charts.spec.ts', specs: [],
    suites: [{
      title: 'chart taps', file: 'charts.spec.ts',
      specs: [
        { title: 'a tap on a donut slice lights only it', ok: true, tests: [{ projectName: 'chromium', expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] },
        { title: 'a tap on a radar point lights only it', ok: true, tests: [{ projectName: 'chromium', expectedStatus: 'skipped', status: 'skipped', results: [] }] },
        { title: 'a tap on a funnel stage lights only it', ok: false, tests: [{ projectName: 'chromium', expectedStatus: 'passed', status: 'unexpected', results: [{ status: 'failed' }] }] },
        { title: 'the range switch sends no request', ok: true, tests: [{ projectName: 'chromium', expectedStatus: 'passed', status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }] },
      ],
    }],
  }],
  errors: [],
  stats: { expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
};

const JEST_JSON = {
  numTotalTests: 2,
  testResults: [{
    name: '/w/src/limits.test.ts',
    assertionResults: [
      { ancestorTitles: ['limits'], title: 'a 141-character note is refused', fullName: 'limits a 141-character note is refused', status: 'passed' },
      { ancestorTitles: ['limits'], title: 'a seventh series is refused', fullName: 'limits a seventh series is refused', status: 'pending' },
    ],
  }],
};

const JUNIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="3">
<testcase classname="tests.test_charts" name="test_radar_limits_hold" time="0.01" />
<testcase classname="tests.test_charts" name="test_html_in_a_note_is_text" time="0.01"><failure message="assert False">boom</failure></testcase>
<testcase classname="tests.test_charts" name="test_eval_picks_funnel" time="0"><skipped message="no key" /></testcase>
</testsuite></testsuites>`;

// ── parsing ───────────────────────────────────────────────────────────────────

describe('parseTests', () => {
  test('a Playwright-JSON-shaped report parses: titles joined, statuses mapped, the project named', () => {
    const p = parseTests({ report: JSON.stringify(PLAYWRIGHT_JSON) });
    assert.equal(p.source, 'playwright json');
    assert.deepEqual(p.tests.map((t) => [t.name, t.status]), [
      ['[chromium] › charts.spec.ts › chart taps › a tap on a donut slice lights only it', 'passed'],
      ['[chromium] › charts.spec.ts › chart taps › a tap on a radar point lights only it', 'skipped'],
      ['[chromium] › charts.spec.ts › chart taps › a tap on a funnel stage lights only it', 'failed'],
      ['[chromium] › charts.spec.ts › chart taps › the range switch sends no request', 'flaky'],
    ]);
  });

  test('Playwright JSON printed on stdout (no report file) parses too', () => {
    const p = parseTests({ output: `[WebServer] ready\n${JSON.stringify(PLAYWRIGHT_JSON, null, 2)}\n` });
    assert.equal(p.source, 'playwright json');
    assert.equal(p.tests.length, 4);
  });

  test('node --test TAP parses: nested names, suites are not tests, SKIP is skipped', () => {
    const dir = worktree();
    let out;
    try {
      out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'test/charts.test.mjs'], { cwd: dir, env: childEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = e.stdout; // the funnel test fails: exit 1
    }
    const p = parseTests({ output: out });
    assert.equal(p.source, 'tap');
    assert.deepEqual(p.tests.map((t) => [t.name, t.status]), [
      ['chart taps › a tap on a donut slice lights only it', 'passed'],
      ['chart taps › a tap on a radar point lights only it', 'skipped'],
      ['chart taps › a tap on a funnel stage lights only it', 'failed'],
      ['zod and pydantic accept the same kinds', 'passed'],
    ]);
  });

  test("node --test's spec reporter (its default when it is not told) parses the same", () => {
    const dir = worktree();
    let out;
    try {
      out = execFileSync(process.execPath, ['--test', '--test-reporter=spec', 'test/charts.test.mjs'], { cwd: dir, env: childEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = e.stdout;
    }
    const p = parseTests({ output: out });
    assert.equal(p.source, 'node spec');
    assert.deepEqual(p.tests.map((t) => [t.name, t.status]), [
      ['chart taps › a tap on a donut slice lights only it', 'passed'],
      ['chart taps › a tap on a radar point lights only it', 'skipped'],
      ['chart taps › a tap on a funnel stage lights only it', 'failed'],
      ['zod and pydantic accept the same kinds', 'passed'],
    ]);
  });

  test('Jest/Vitest JSON and JUnit XML (pytest) parse', () => {
    const j = parseTests({ report: JSON.stringify(JEST_JSON) });
    assert.equal(j.source, 'jest json');
    assert.deepEqual(j.tests.map((t) => [t.name, t.status]), [['limits a 141-character note is refused', 'passed'], ['limits a seventh series is refused', 'skipped']]);
    const x = parseTests({ report: JUNIT_XML });
    assert.equal(x.source, 'junit xml');
    assert.deepEqual(x.tests.map((t) => [t.name, t.status]), [
      ['tests.test_charts::test_radar_limits_hold', 'passed'],
      ['tests.test_charts::test_html_in_a_note_is_text', 'failed'],
      ['tests.test_charts::test_eval_picks_funnel', 'skipped'],
    ]);
  });

  test('only a summary line: counts, no names; nothing at all: source none', () => {
    assert.deepEqual(parseTests({ output: 'x\n  3 passed (4.1s)\n' }), { tests: null, summary: { passed: 3, failed: 0, skipped: 0 }, source: 'summary line' });
    assert.deepEqual(parseTests({ output: '==== 2 passed, 1 skipped in 0.31s ====\n' }).summary, { passed: 2, failed: 0, skipped: 1 });
    assert.deepEqual(parseTests({ output: 'Tests:       1 failed, 2 passed, 3 total\n' }).summary, { passed: 2, failed: 1, skipped: 0 });
    assert.deepEqual(parseTests({ output: 'npm ERR! missing script: e2e\n' }), { tests: null, summary: null, source: 'none' });
  });
});

// ── judging ───────────────────────────────────────────────────────────────────

describe('judgeTest', () => {
  const pw = parseTests({ report: JSON.stringify(PLAYWRIGHT_JSON) });

  test('a passing named test is met, with what matched and how many ran', () => {
    const j = judgeTest({ parsed: pw, grep: 'donut slice', code: 1 });
    assert.equal(j.result, 'met');
    assert.deepEqual(j.counts, { total: 4, matched: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 });
    assert.match(j.why, /^1 of 1 matched passed \(4 ran, playwright json, exit 1\)$/);
    assert.deepEqual(j.names, ['passed [chromium] › charts.spec.ts › chart taps › a tap on a donut slice lights only it']);
  });

  test('a failing named test is NOT MET and names it', () => {
    const j = judgeTest({ parsed: pw, grep: 'funnel stage', code: 1 });
    assert.equal(j.result, 'NOT MET');
    assert.match(j.why, /1 of 1 matched failed: .*a tap on a funnel stage lights only it/);
  });

  test('a grep that matches 0 tests is unverifiable, saying so', () => {
    const j = judgeTest({ parsed: pw, grep: 'treemap tile', code: 0 });
    assert.equal(j.result, 'unverifiable');
    assert.equal(j.why, '0 of 4 test(s) match (playwright json)');
    assert.equal(j.counts.matched, 0);
  });

  test('a skipped named test is unverifiable, never a pass', () => {
    const j = judgeTest({ parsed: pw, grep: 'radar point', code: 0 });
    assert.equal(j.result, 'unverifiable');
    assert.match(j.why, /1 of 1 matched skipped: .*a skipped test proves nothing/);
  });

  test('a flaky test (passed on a retry) is met and says flaky; a /re/ grep matches', () => {
    const j = judgeTest({ parsed: pw, grep: '/range switch.*no request/', code: 0 });
    assert.equal(j.result, 'met');
    assert.match(j.why, /1 flaky/);
  });

  test('a summary line alone proves nothing unless the command was filtered by name', () => {
    const parsed = { tests: null, summary: { passed: 3, failed: 0, skipped: 0 }, source: 'summary line' };
    assert.equal(judgeTest({ parsed, grep: 'x', code: 0, filtered: false }).result, 'unverifiable');
    assert.equal(judgeTest({ parsed, grep: 'x', code: 0, filtered: true }).result, 'met');
    assert.equal(judgeTest({ parsed: { ...parsed, summary: { passed: 0, failed: 0, skipped: 0 } }, grep: 'x', code: 0, filtered: true }).result, 'unverifiable');
    assert.equal(judgeTest({ parsed, grep: 'x', code: 1, filtered: true }).result, 'NOT MET');
  });

  test('nothing parsed, a timeout or a NOT RUN verb is unverifiable', () => {
    assert.equal(judgeTest({ parsed: { tests: null, summary: null, source: 'none' }, grep: 'x', code: 1 }).why, 'no test results in the output (exit 1)');
    assert.equal(judgeTest({ parsed: { tests: null, summary: null }, grep: 'x', code: 124, timedOut: true }).result, 'unverifiable');
    assert.equal(judgeTest({ notRun: 'NOT RUN: no adapter for test (custom-stack)', grep: 'x' }).why, 'not run: NOT RUN: no adapter for test (custom-stack)');
  });
});

// ── entries and commands ──────────────────────────────────────────────────────

describe('entries and commands', () => {
  test('testEntries keeps only entries with a test key; entryProblem names a bad one', () => {
    const list = [{ name: 'a', text: 'x' }, { name: 'b', route: 'GET /x' }, entry('c', 'y')];
    assert.deepEqual(testEntries(list).map((e) => e.name), ['c']);
    assert.deepEqual(testEntries(null), []);
    assert.equal(entryProblem(entry('c', 'y'), SUITES), null);
    assert.equal(entryProblem({ name: 'c', test: { suite: 'test:unit', grep: 'y' } }, {}), null);
    assert.equal(entryProblem({ name: 'c', test: { suite: 'e2e', grep: 'y' } }, SUITES), 'unknown suite "e2e" (known: unit or test:<level>)');
    assert.equal(entryProblem({ name: 'c', test: { suite: 'unit' } }, SUITES), 'test.grep missing');
    assert.equal(entryProblem({ name: 'c', test: 'unit' }, SUITES), 'test must be { suite, grep }');
    assert.match(entryProblem({ name: 'c', test: { suite: 'unit', grep: '/(/' } }, SUITES), /^test\.grep: /);
  });

  test('grepMatcher: a case-sensitive substring of any name, or /re/flags', () => {
    const t = { name: 'chart taps › a tap on a donut', names: ['chart taps a tap on a donut'] };
    assert.equal(grepMatcher('taps a tap')(t), true);
    assert.equal(grepMatcher('Donut')(t), false);
    assert.equal(grepMatcher('/DONUT$/i')(t), true);
  });

  test('a known runner gets its name filter and a machine-readable reporter; an opaque command gets the env only', () => {
    assert.equal(runnerOf('npx playwright test e2e/'), 'playwright');
    assert.equal(runnerOf('python -m pytest tests'), 'pytest');
    assert.equal(runnerOf('node --test test/'), 'node');
    assert.equal(runnerOf('npm run e2e'), null);
    const pw = commandFor(['npx', 'playwright', 'test'], { grep: 'a (b)', report: '/r/x.report' });
    assert.deepEqual(pw.argv, ['playwright', 'test', '--grep', 'a \\(b\\)', '--reporter', 'json']);
    assert.equal(pw.env.PLAYWRIGHT_JSON_OUTPUT_NAME, '/r/x.report');
    assert.equal(pw.filtered, true);
    const node = commandFor('node --test test/', { grep: 'donut', report: '/r' });
    assert.equal(node.shown, "node --test '--test-reporter=tap' '--test-name-pattern=donut' test/");
    const opaque = commandFor('npm run e2e && echo done', { grep: 'donut', report: '/r' });
    assert.deepEqual([opaque.shown, opaque.filtered, opaque.env.QA_TEST_GREP, opaque.env.QA_TEST_REPORT], ['npm run e2e && echo done', false, 'donut', '/r']);
    assert.equal(commandFor('bash e2e.sh ${QA_TEST_GREP:+--grep "$QA_TEST_GREP"}', { grep: 'x', report: '/r' }).filtered, true);
    const has = commandFor(['npx', 'playwright', 'test', '-g', 'chart'], { grep: 'donut', report: '/r' });
    assert.equal(has.filtered, false, 'a filter the suite already has is left alone, and none is added');
  });
});

// ── running ───────────────────────────────────────────────────────────────────

describe('runTests', () => {
  test('a real node --test suite in the worktree: met, NOT MET, unverifiable for 0 matched and for a skip', async () => {
    const dir = worktree();
    const logDir = path.join(tmpDir('mfqa-tests-logs-'), 'logs');
    const records = await runTests({
      dir, at: 'f'.repeat(40), suites: SUITES, logDir,
      entries: [
        entry('donut-tap', 'a tap on a donut slice', { criterion: 'ch:4' }),
        entry('funnel-tap', 'funnel stage'),
        entry('treemap-tap', 'a tap on a treemap tile'),
        entry('radar-tap', 'radar point'),
      ],
    });
    const by = Object.fromEntries(records.map((r) => [r.name, r]));
    assert.equal(by['donut-tap'].result, 'met');
    assert.equal(by['donut-tap'].detail, 'ch:4 · unit "a tap on a donut slice": 1 of 1 matched passed (1 ran, tap)');
    assert.equal(by['donut-tap'].command, "node --test '--test-reporter=tap' '--test-name-pattern=a tap on a donut slice' test/charts.test.mjs");
    assert.equal(by['donut-tap'].exit, 0);
    assert.equal(by['donut-tap'].dir, dir);
    assert.equal(by['donut-tap'].at, 'f'.repeat(40));
    assert.ok(fs.readFileSync(by['donut-tap'].log, 'utf8').includes('ok 1 - a tap on a donut slice lights only it'), 'the output is in the log');
    assert.ok(by['donut-tap'].tail.length > 0);
    assert.equal(by['funnel-tap'].result, 'NOT MET');
    assert.equal(by['funnel-tap'].exit, 1);
    assert.equal(by['treemap-tap'].result, 'unverifiable');
    assert.match(by['treemap-tap'].why, /^0 of \d+ test\(s\) match \(tap\)$/);
    assert.equal(by['radar-tap'].result, 'unverifiable');
    assert.match(by['radar-tap'].why, /skipped/);
  });

  test('an unknown suite or a missing grep is unverifiable and runs nothing', async () => {
    let ran = 0;
    const records = await runTests({
      dir: worktree(), suites: SUITES, logDir: tmpDir('mfqa-tests-logs-'), exec: async () => { ran += 1; return { code: 0, output: '', ms: 0 }; },
      entries: [{ name: 'a', test: { suite: 'e2e', grep: 'x' } }, { name: 'b', test: { suite: 'unit' } }],
    });
    assert.equal(ran, 0);
    assert.deepEqual(records.map((r) => [r.result, r.why]), [
      ['unverifiable', 'not run: unknown suite "e2e" (known: unit or test:<level>)'],
      ['unverifiable', 'not run: test.grep missing'],
    ]);
  });

  test('an opaque suite that reads neither $QA_TEST_GREP nor $QA_TEST_FILE never runs: evidence never runs the whole suite', async () => {
    const calls = [];
    const exec = async (req) => { calls.push(req); return { code: 0, output: '', ms: 1 }; };
    const records = await runTests({
      dir: '/sandbox/tree', suites: { e2e: 'npm run e2e' }, logDir: tmpDir('mfqa-tests-logs-'), exec,
      entries: [{ name: 'a', test: { suite: 'e2e', grep: 'donut' } }],
    });
    assert.equal(calls.length, 0);
    assert.equal(records[0].result, 'unverifiable');
    assert.match(records[0].why, /^not run: suite e2e cannot run one test \(its command is no known runner/);
    assert.match(records[0].why, /evidence never runs the whole suite: name the test's file/);
    assert.equal(records[0].command, 'npm run e2e');
  });

  test('an opaque suite that reads $QA_TEST_FILE runs once per file for every entry naming it, and the names in its output decide each', async () => {
    const dir = worktree();
    const calls = [];
    const exec = async (req) => {
      calls.push(req);
      return { code: 1, output: 'ok 1 - donut lights\nnot ok 2 - funnel lights\n', ms: 5 };
    };
    const records = await runTests({
      dir, suites: { e2e: 'npm run e2e -- "$QA_TEST_FILE"' }, logDir: tmpDir('mfqa-tests-logs-'), exec, vars: { slug: 'qa-x', port: 4100 },
      entries: [
        { name: 'a', test: { suite: 'e2e', grep: 'donut', file: 'test/charts.test.mjs' } },
        { name: 'b', test: { suite: 'e2e', grep: 'funnel', file: 'test/charts.test.mjs' } },
      ],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, dir);
    assert.equal(calls[0].env.QA_ROOT, dir);
    assert.equal(calls[0].env.QA_PORT, '4100');
    assert.equal(calls[0].env.QA_TEST_FILE, path.join(dir, 'test/charts.test.mjs'));
    assert.deepEqual(records.map((r) => r.result), ['met', 'NOT MET']);
    assert.deepEqual(records.map((r) => r.file), ['test/charts.test.mjs', 'test/charts.test.mjs']);
  });

  test("'test:<level>' runs the stack's test verb in the worktree with the grep in the env; NOT RUN passes through", async () => {
    const calls = [];
    const runVerb = async (verb, req) => {
      calls.push({ verb, ...req });
      return { code: 0, stdout: 'TAP version 13\nok 1 - limits hold\n', stderr: '', ms: 3, notRun: null };
    };
    const [r] = await runTests({ dir: '/sandbox/tree', suites: {}, logDir: tmpDir('mfqa-tests-logs-'), runVerb, entries: [{ name: 'a', test: { suite: 'test:unit', grep: 'limits hold' } }] });
    assert.equal(r.result, 'met');
    assert.deepEqual([calls[0].verb, calls[0].cwd, calls[0].args, calls[0].env.QA_TEST_GREP], ['test', '/sandbox/tree', ['unit'], 'limits hold']);
    const none = async () => ({ code: null, stdout: '', stderr: '', notRun: 'NOT RUN: no adapter for test (none named)' });
    const [n] = await runTests({ dir: '/x', suites: {}, logDir: tmpDir('mfqa-tests-logs-'), runVerb: none, entries: [{ name: 'a', test: { suite: 'test:unit', grep: 'x' } }] });
    assert.deepEqual([n.result, n.why], ['unverifiable', 'not run: NOT RUN: no adapter for test (none named)']);
  });

  test("'test:<level>' with no runVerb given runs the adapter's own (planCheck passed none: TypeError, 2026-11-13)", async () => {
    const [r] = await runTests({ dir: tmpDir('mfqa-tests-dir-'), suites: {}, logDir: tmpDir('mfqa-tests-logs-'), entries: [{ name: 'a', test: { suite: 'test:unit', grep: 'x' } }] });
    assert.equal(r.result, 'unverifiable');
    assert.match(r.why, /^not run: NOT RUN: /);
  });

  const withTestFile = () => { const d = tmpDir('mfqa-tests-dir-'); fs.mkdirSync(path.join(d, 'tests')); fs.writeFileSync(path.join(d, 'tests', 'test_x.py'), 'def test_holds(): pass\n'); return d; };

  test("'test:<level>' whose verb reads neither $QA_TEST_FILE nor $QA_TEST_GREP never runs: it would run the whole suite (CRM, 2026-11-13)", async () => {
    const calls = [];
    const runVerb = async (verb, req) => { calls.push(req); return { code: 0, stdout: '', stderr: '', ms: 1, notRun: null }; };
    const whole = { stack: { test: 'uv run python -m pytest -q' } };
    const [r] = await runTests({ dir: withTestFile(), suites: {}, profile: whole, logDir: tmpDir('mfqa-tests-logs-'), runVerb, entries: [{ name: 'a', test: { suite: 'test:unit', grep: 'holds', file: 'tests/test_x.py' } }] });
    assert.deepEqual(calls, [], 'the whole suite ran');
    assert.equal(r.result, 'unverifiable');
    assert.match(r.why, /suite test:unit cannot run one test .*register the runner's own command as a suite in qa\/suites\.\*/);
    const narrow = { stack: { test: 'uv run python -m pytest -q "$QA_TEST_FILE"' } };
    const [n] = await runTests({ dir: withTestFile(), suites: {}, profile: narrow, logDir: tmpDir('mfqa-tests-logs-'), runVerb, entries: [{ name: 'a', test: { suite: 'test:unit', grep: 'holds', file: 'tests/test_x.py' } }] });
    assert.equal(calls.length, 1, 'a verb that reads $QA_TEST_FILE runs');
    assert.notEqual(n.why ?? '', r.why);
  });

  test('withBase: already passing on base is noted and never changes the result; a test not on base is new', () => {
    const head = [
      { name: 'a', result: 'met', detail: 'unit "x": 1 of 1 matched passed' },
      { name: 'b', result: 'met', detail: 'unit "y": 1 of 1 matched passed' },
      { name: 'c', result: 'met', detail: 'unit "z": ok' },
      { name: 'd', result: 'met', detail: 'unit "w": ok' },
    ];
    const base = [
      { name: 'a', result: 'met', why: '1 of 1 matched passed', counts: { matched: 1 } },
      { name: 'b', result: 'unverifiable', why: '0 of 3 test(s) match (tap)', counts: { matched: 0 } },
      { name: 'c', result: 'NOT MET', why: '1 of 1 matched failed', counts: { matched: 1 } },
    ];
    const out = withBase(head, base);
    assert.deepEqual(out.map((r) => r.result), ['met', 'met', 'met', 'met']);
    assert.match(out[0].detail, / · base: already passing on base \(proves it holds now, not that this PR made it hold\)$/);
    assert.match(out[1].detail, / · base: no such test on base \(new with this PR\)$/);
    assert.match(out[2].detail, / · base: fails on base \(this PR made it pass\)$/);
    assert.equal(out[3].base, undefined, 'no base record: nothing added');
  });
});

// ── the run: the head sandbox, never the checkout ─────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

// main has a.txt; feat/charts changes it. The checkout carries no test file: only the sandbox worktree has one.
function makeRepo() {
  const dir = tmpDir('mfqa-tests-repo-');
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  write(dir, 'qa/map/app.json', '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
  write(dir, 'a.txt', 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'one'], dir);
  git(['checkout', '-q', '-b', 'feat/charts'], dir);
  write(dir, 'a.txt', 'two\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'two'], dir);
  return dir;
}

function fakeDeps(sandboxes) {
  const calls = { up: [] };
  const side = { viewports: [{ viewport: 'desktop', captured: [], failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: '' }, mapErrors: [], ms: 1 };
  return {
    calls,
    deps: {
      async up(req) {
        calls.up.push(req);
        // [base, head] by commit (rework U4: base comes up only when it has something to walk, sweep or test).
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: req.qaFrom, encoding: 'utf8' }).trim();
        const dir = sandboxes[req.at === headSha ? 1 : 0];
        return { name: `qa-${req.at.slice(0, 10)}`, slug: 'qa', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null, sha: req.at };
      },
      down: async (req) => ({ name: req.name, warnings: [] }),
      captureSide: async (req) => { fs.mkdirSync(req.out, { recursive: true }); return structuredClone(side); },
      compare: async (req) => { fs.mkdirSync(req.out, { recursive: true }); return { exit: 0, viewports: [{ viewport: 'desktop', exit: 0, pairs: [], expectations: [], unexpected: [], overflow: [], inconclusive: [], eyes: [], standing: { checks: 0, tour: 0, console: 0 } }] }; },
      sleep: async () => {},
      now: () => new Date('2026-11-10T10:00:00Z'),
      runVerb: async () => ({ code: null, stdout: '', stderr: '', json: null, notRun: 'NOT RUN: none' }),
      mutate: async (req) => ({ selected: 0, result: { mode: req.mode, file: null, run: 0, killed: 0, survived: [], stale: [], notJudged: [], suites: {}, errors: [] } }),
    },
  };
}

const PROFILE = { map: 'qa/map', seedNames: 'qa/seed.json', base: 'sandbox', viewports: { desktop: [1440, 900] }, routes: { enabled: false }, sandbox: { max: 3 }, run: { cacheKeep: 5 } };

function expectationsAt(repo, entries) {
  write(repo, 'qa/feat-charts/expectations.json', JSON.stringify(entries));
  // the expectations file is not part of the commits; keep the checkout clean of anything else
}

describe('runQa', () => {
  test('a test expectation runs in the head sandbox worktree, not the checkout, and becomes a criterion', async () => {
    const repo = makeRepo();
    const headTree = worktree();
    write(headTree, 'qa/mutants.json', JSON.stringify({ suites: SUITES, mutants: [] }));
    expectationsAt(repo, [
      { name: 'donut-tap', test: { suite: 'unit', grep: 'a tap on a donut slice' }, criterion: 'ch:4' },
      { name: 'treemap-tap', test: { suite: 'unit', grep: 'treemap tile' } },
    ]);
    const { deps } = fakeDeps([tmpDir('mfqa-base-'), headTree]);
    const run = await runQa({ mainRoot: repo, repoRoot: repo, profile: PROFILE, log: () => {}, mutants: 'none' }, deps);
    assert.deepEqual(run.tests.map((t) => [t.name, t.result, t.dir]), [['donut-tap', 'met', headTree], ['treemap-tap', 'unverifiable', headTree]]);
    assert.equal(run.tests[0].at, run.head.sha);
    assert.equal(fs.existsSync(path.join(repo, 'test', 'charts.test.mjs')), false, 'the checkout has no such test: it ran in the sandbox');
    assert.deepEqual(run.steps.filter((s) => s.verb === 'tests').map((s) => [s.side, s.ok, s.note]), [['head', true, '1/2 met']]);
    const exps = run.results.expectations.filter((e) => e.viewport === null);
    assert.deepEqual(exps.map((e) => [e.id, e.result]), [['exp:donut-tap', 'met'], ['exp:treemap-tap', 'unverifiable']]);
    assert.equal(run.exit, 2, 'an unverifiable test is inconclusive');
    const draft = fs.readFileSync(path.join(repo, 'qa', 'feat-charts', 'verdict.draft.md'), 'utf8');
    assert.match(draft, /^- \[exp:donut-tap\] PASS — donut-tap: ch:4 · unit "a tap on a donut slice": 1 of 1 matched passed/m);
    // 1.0.0: a named test that matched nothing is the tool's or the plan's problem: BLOCKED, never a product failure.
    assert.match(draft, /^- \[exp:treemap-tap\] BLOCKED — treemap-tap: unit "treemap tile": 0 of \d+ test\(s\) match \(tap\); the test did not run as named$/m);
    assert.match(draft, /^# BLOCKED/);
    const summary = fs.readFileSync(path.join(repo, 'qa', 'feat-charts', 'summary.md'), 'utf8');
    assert.match(summary, /^ {4}\$ node --test '--test-reporter=tap' '--test-name-pattern=a tap on a donut slice' test\/charts\.test\.mjs · exit 0 · \d+ s · head [0-9a-f]{12}$/m);
    assert.match(summary, /^ {4}tests: 1 matched of 1 · 1 passed · 0 failed · 0 skipped \(tap\)$/m);
  });

  test('a failing named test is NOT MET: exit 1 and the draft REJECTs on a FAIL criterion', async () => {
    const repo = makeRepo();
    const headTree = worktree();
    write(headTree, 'qa/mutants.json', JSON.stringify({ suites: SUITES, mutants: [] }));
    expectationsAt(repo, [{ name: 'funnel-tap', test: { suite: 'unit', grep: 'funnel stage' } }]);
    const { deps } = fakeDeps([tmpDir('mfqa-base-'), headTree]);
    const run = await runQa({ mainRoot: repo, repoRoot: repo, profile: PROFILE, log: () => {}, mutants: 'none' }, deps);
    assert.equal(run.tests[0].result, 'NOT MET');
    assert.equal(run.exit, 1);
    const d = draftVerdict(run.results);
    assert.equal(d.verdict, 'REJECT');
    assert.deepEqual(d.criteria, { pass: 0, fail: 1, unverifiable: 0, blocked: 0, waived: 0 });
  });

  test('base: true runs it on the fresh base sandbox too; already passing there is a note, not a failure', async () => {
    const repo = makeRepo();
    const baseTree = worktree();
    const headTree = worktree();
    for (const t of [baseTree, headTree]) write(t, 'qa/mutants.json', JSON.stringify({ suites: SUITES, mutants: [] }));
    expectationsAt(repo, [{ name: 'parity', test: { suite: 'unit', grep: 'zod and pydantic', base: true } }]);
    const { deps } = fakeDeps([baseTree, headTree]);
    const run = await runQa({ mainRoot: repo, repoRoot: repo, profile: PROFILE, log: () => {}, mutants: 'none', cache: false }, deps);
    assert.deepEqual(run.steps.filter((s) => s.verb === 'tests').map((s) => s.side), ['base', 'head']);
    assert.equal(run.tests[0].result, 'met');
    assert.equal(run.tests[0].base.result, 'met');
    assert.match(run.tests[0].detail, /base: already passing on base/);
  });

  test('no test expectation: no tests step and run.tests is []', async () => {
    const repo = makeRepo();
    const { deps } = fakeDeps([tmpDir('mfqa-base-'), tmpDir('mfqa-head-')]);
    const run = await runQa({ mainRoot: repo, repoRoot: repo, profile: PROFILE, log: () => {}, mutants: 'none' }, deps);
    assert.deepEqual(run.tests, []);
    assert.equal(run.steps.some((s) => s.verb === 'tests'), false);
  });
});

// ── what the judge and the report read ────────────────────────────────────────

const RECORD = {
  id: 'exp:donut-tap', name: 'donut-tap', criterion: 'ch:4', suite: 'e2e', grep: 'donut slice', side: 'head', at: 'a'.repeat(40), dir: '/w',
  result: 'met', why: '1 of 1 matched passed (12 ran, playwright json)', detail: 'ch:4 · e2e "donut slice": 1 of 1 matched passed (12 ran, playwright json)',
  command: "npx playwright test --grep 'donut slice' --reporter json", filtered: true, source: 'playwright json', exit: 0, timedOut: false, ms: 9400,
  counts: { total: 12, matched: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 }, names: ['passed chart taps › donut slice'],
  tail: ['Running 12 tests using 2 workers', '<b>12 passed</b> (9.4s)'], log: '/v/logs/test-donut-tap.head.log', base: null,
};

describe('summary, draft and report', () => {
  test('buildResults: the record is in results.tests and its expectation is a criterion; compare ignores it', () => {
    const r = buildResults({ ...exampleRun(), tests: [RECORD] });
    assert.deepEqual(r.tests, [RECORD]);
    assert.deepEqual(r.expectations.at(-1), { id: 'exp:donut-tap', viewport: null, name: 'donut-tap', result: 'met', detail: RECORD.detail });
    const cv = compareViewport({ before: { records: {}, trees: {} }, after: { records: {}, trees: {} }, viewport: 'desktop', expectations: [{ name: 'donut-tap', test: { suite: 'e2e', grep: 'x' } }] });
    assert.equal(cv.expectations[0].result, 'n/a');
  });

  test('summary.md: the command, the counts and the end of the output under the expectation line', () => {
    const md = summaryMd(buildResults({ ...exampleRun(), tests: [RECORD] }));
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith('- [exp:donut-tap] met — donut-tap: ch:4 · e2e "donut slice"'));
    assert.ok(at > 0);
    assert.deepEqual(lines.slice(at + 1, at + 5), [
      `    $ npx playwright test --grep 'donut slice' --reporter json · exit 0 · 9 s · head ${'a'.repeat(12)}`,
      '    tests: 1 matched of 12 · 1 passed · 0 failed · 0 skipped (playwright json)',
      '    | Running 12 tests using 2 workers',
      '    | <b>12 passed</b> (9.4s)',
    ]);
  });

  test('the draft: a PASS row and a tests note; report.html: a Tests run section, escaped', () => {
    const results = buildResults({ ...exampleRun(), tests: [RECORD] });
    const d = draftVerdict(results);
    assert.match(d.md, /^- \[exp:donut-tap\] PASS — donut-tap: ch:4 · e2e/m);
    assert.match(d.md, /^- tests: 1 named test\(s\) run by qa itself on the head sandbox: 1 met · 0 NOT MET · 0 unverifiable/m);
    const html = reportHtml({ verdictMd: d.md.replace('# PENDING', '# REJECT').replace('# ACCEPT', '# REJECT'), summaryMd: '', results });
    assert.match(html, /<h2>Tests run<\/h2>/);
    assert.match(html, /npx playwright test --grep &#39;donut slice&#39;|npx playwright test --grep 'donut slice'/);
    assert.match(html, /1 matched of 12 · 1 passed · 0 failed · 0 skipped \(playwright json\)/);
    assert.ok(html.includes('&lt;b&gt;12 passed&lt;/b&gt;'), 'output lines are escaped');
    const none = reportHtml({ verdictMd: d.md, summaryMd: '', results: buildResults(exampleRun()) });
    assert.equal(none.includes('Tests run'), false);
  });
});
