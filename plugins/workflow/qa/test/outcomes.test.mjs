// 1.0.0: four outcomes (ACCEPT, REJECT, NEEDS YOU, BLOCKED), advisory and manual charter rows, waivers, tool
// failures that never fail a PR (one retry for a timed-out capture, a per-row catch, a BLOCKED verdict when no sandbox
// comes up) and ports.extra. Contracts: scripts/lib/verdict.mjs 'FOUR OUTCOMES', report.mjs R3
// and R6, capture.mjs / compare.mjs / summary.mjs / run.mjs '1.0.0', sandbox.mjs 'ports.extra'.
// Every fixture is neutral: no project, library, selector or screen of a real app.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import { capture, isTimeout, serverErrorOf } from '../scripts/lib/capture.mjs';
import { compareViewport, onBaseTree } from '../scripts/lib/compare.mjs';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { validateVerdict } from '../scripts/lib/report.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { validateProfile } from '../scripts/lib/profile.mjs';
import { claimPort } from '../scripts/lib/sandbox.mjs';
import { buildResults } from '../scripts/lib/summary.mjs';
import {
  OUTCOMES, applyWaivers, countRows, criteriaLine, decide, draftVerdict, evidence, parseCharter, parseVerdict, parseWaivers,
  verdictOutcome, waiverMap, waiverText,
} from '../scripts/lib/verdict.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};

function results(over = {}) {
  return {
    version: 1, mode: 'diff', slug: 'feat-x', exit: 0,
    head: { sha: SHA_A, ref: 'HEAD' }, base: { sha: SHA_B, ref: 'main', cached: true },
    maps: { head: 'c'.repeat(64), base: 'd'.repeat(64) },
    sandboxes: { base: null, head: null }, steps: [], warnings: [], blocked: null, compareError: null, mapErrors: 0,
    failures: [], notRun: [], screens: [], expectations: [], unexpected: [],
    tour: { opened: 0, failed: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [], standing: 0 },
    checks: { new: [], standing: 0, fixed: 0 }, console: { new: [], standing: 0 },
    eyes: [], routes: null, mutants: null, tests: [], docs: [], livedIn: null, metrics: null,
    standing: { checks: 0, tour: 0, console: 0, file: null, added: 0 }, identical: null, report: null, compare: null,
    ...over,
  };
}
const ex = (name, result, over = {}) => ({ id: `exp:${name}`, viewport: 'desktop', name, result, detail: `${name} detail`, ...over });
const headFailure = (over = {}) => ({
  id: 'fail:head/desktop/item', side: 'head', viewport: 'desktop', screen: 'item', step: '{"waitFor":"role=heading"}',
  error: 'locator.waitFor: Timeout 20000ms exceeded.', lines: ['locator.waitFor: Timeout 20000ms exceeded.'], mapError: false, onBase: false, ...over,
});

// A charter: two spec criteria, one manual, one advisory beyond the spec.
const CHARTER = `# Charter — feat-x
security: no — none

- [ch:1] the list shows the new column — axis: happy path — by: expectation column-shown
- [ch:2] an empty list says so — axis: cardinality — by: expectation empty-text, expectation empty-icon
- [ch:3] works with a real provider key — axis: state — by: manual — ask: Did a real key work when you tried it?
- [ch:4] the rows are 44 px tall on touch — axis: layout — by: expectation row-height — advisory
`;

// ── charter and waivers ───────────────────────────────────────────────────────

describe('charter and waivers', () => {
  test('parseCharter reads each row: its case, advisory, manual with its ask, and the expectations it cites', () => {
    const rows = parseCharter(CHARTER);
    assert.deepEqual(rows.map((r) => r.id), ['ch:1', 'ch:2', 'ch:3', 'ch:4']);
    assert.deepEqual(rows[0], { id: 'ch:1', text: 'the list shows the new column', advisory: false, manual: false, ask: null, expectations: ['column-shown'], suites: [] });
    assert.deepEqual(rows[1].expectations, ['empty-text', 'empty-icon']);
    assert.equal(rows[2].manual, true);
    assert.equal(rows[2].ask, 'Did a real key work when you tried it?');
    assert.equal(rows[3].advisory, true);
    assert.deepEqual(rows[3].expectations, ['row-height']);
    assert.deepEqual(parseCharter(null), []);
  });

  test('parseCharter reads suite citations: by: suite unit, suite lint; beside an expectation; with and or +', () => {
    const [a] = parseCharter('- [ch:6] ruff and pytest are clean — axis: regression — rung 4: the suites run whole in suites mode — by: suite unit, suite lint');
    assert.deepEqual(a.suites, ['unit', 'lint']);
    assert.deepEqual(a.expectations, []);
    const [b] = parseCharter('- [ch:7] the list is sorted — axis: copy — by: suite unit; expectation column-shown');
    assert.deepEqual(b.suites, ['unit']);
    assert.deepEqual(b.expectations, ['column-shown']);
    assert.deepEqual(parseCharter('- [ch:8] c — axis: x — by: suite unit and suite lint')[0].suites, ['unit', 'lint']);
    assert.deepEqual(parseCharter('- [ch:8] c — axis: x — by: suite unit + lint')[0].suites, ['unit', 'lint']);
    assert.deepEqual(parseCharter('- [ch:9] d — axis: x — by: expectation foo')[0].suites, []);
  });

  test('a manual advisory row keeps its ask without the advisory tail', () => {
    const [row] = parseCharter('- [ch:9] a person likes it — axis: copy — by: manual — ask: Does it read well? — advisory');
    assert.equal(row.advisory, true);
    assert.equal(row.ask, 'Does it read well?');
  });

  test('parseWaivers reads the contract line; other lines are ignored; waiverMap keeps the last one per id', () => {
    const md = [
      '# Waivers — feat-x',
      '- [ch:3] waived: no real key exists in the sandbox (the user, 2026-11-12)',
      'free text the hub wrote',
      '- [ch:3] waived: checked by hand on a phone (Ann, Lee, 2026-11-13)',
      '- [fail:head/desktop/item] waived: the screen loads by hand (the user, 2026-11-12)',
      '- [ch:5] waived: no date',
    ].join('\n');
    const list = parseWaivers(md);
    assert.equal(list.length, 3);
    const map = waiverMap(list);
    assert.deepEqual(map.get('ch:3'), { id: 'ch:3', reason: 'checked by hand on a phone', who: 'Ann, Lee', date: '2026-11-13' });
    assert.equal(waiverText(map.get('fail:head/desktop/item')), 'waived: the screen loads by hand (the user, 2026-11-12)');
    assert.equal(map.has('ch:5'), false);
  });
});

// ── evidence: an expectation row by the fixed table ───────────────────────────

describe('evidence', () => {
  const test0 = (over) => ({ name: 'probe', counts: { total: 0, matched: 0, passed: 0, failed: 0, skipped: 0 }, timedOut: false, ...over });
  test('met PASS, NOT MET FAIL, already true before UNVERIFIABLE (with what would prove it)', () => {
    assert.equal(evidence(ex('a', 'met')).status, 'PASS');
    assert.equal(evidence(ex('a', 'NOT MET')).status, 'FAIL');
    const before = evidence(ex('a', 'already true before'));
    assert.equal(before.status, 'UNVERIFIABLE');
    assert.match(before.note, /would prove it: /);
  });

  test('an expectation that observed 0 elements is BLOCKED, never NOT MET', () => {
    assert.equal(evidence(ex('a', 'not observed')).status, 'BLOCKED');
    assert.equal(evidence(ex('a', 'NOT MET', { observed: 0 })).status, 'BLOCKED');
    assert.equal(evidence(ex('a', 'NOT MET', { observed: 2 })).status, 'FAIL');
  });

  test('an exception while judging a row is BLOCKED', () => {
    assert.equal(evidence(ex('a', 'error', { detail: 'the tool failed: boom' })).status, 'BLOCKED');
  });

  test('a test that matched and was skipped is UNVERIFIABLE; not run, matched nothing, timed out or a tool error is BLOCKED', () => {
    const e = { id: 'exp:probe', viewport: null, name: 'probe', result: 'unverifiable', detail: 'x' };
    const skipped = test0({ counts: { total: 3, matched: 1, passed: 0, failed: 0, skipped: 1 } });
    assert.equal(evidence(e, { tests: [skipped] }).status, 'UNVERIFIABLE');
    assert.equal(evidence(e, { tests: [test0()] }).status, 'BLOCKED');
    assert.equal(evidence(e, { tests: [{ ...skipped, timedOut: true }] }).status, 'BLOCKED');
    assert.equal(evidence(e, { tests: [{ ...skipped, toolError: true }] }).status, 'BLOCKED');
    assert.equal(evidence(e, { docs: [{ name: 'probe' }] }).status, 'BLOCKED');
    assert.equal(evidence(e, {}).status, 'UNVERIFIABLE');
  });
});

// ── decide: the gate ──────────────────────────────────────────────────────────

describe('decide', () => {
  const charter = parseCharter(CHARTER);
  const rows = (over = {}) => [
    { id: 'ch:1', status: 'PASS' }, { id: 'ch:2', status: 'PASS' }, { id: 'ch:3', status: 'WAIVED' }, { id: 'ch:4', status: 'PASS' },
    ...Object.entries(over).map(([id, status]) => ({ id, status })),
  ].filter((r, i, all) => all.findLastIndex((x) => x.id === r.id) === i);
  const gate = (o) => decide({ charter, waivers: waiverMap(parseWaivers('- [ch:3] waived: no key (u, 2026-11-12)')), ...o });

  test('every spec criterion PASS or waived, no Blocker: ACCEPT', () => {
    assert.equal(gate({ rows: rows() }).outcome, 'ACCEPT');
  });

  test('a spec criterion FAIL, or a Blocker, or a fixed-table row that gates: REJECT', () => {
    assert.equal(gate({ rows: rows({ 'ch:1': 'FAIL' }) }).outcome, 'REJECT');
    assert.equal(gate({ rows: rows(), findings: [{ id: 'rte:1', severity: 'Blocker' }] }).outcome, 'REJECT');
    assert.equal(gate({ rows: rows(), findings: [{ id: 'chk:x', severity: 'Major' }], gates: new Set(['chk:x']) }).outcome, 'REJECT');
  });

  test('a Major, Minor or Note that the table does not flag never gates', () => {
    const findings = ['Major', 'Minor', 'Note'].map((severity, i) => ({ id: `f:${i}`, severity }));
    assert.equal(gate({ rows: rows(), findings }).outcome, 'ACCEPT');
  });

  test('a criterion the tool could not check, or a blocked item: BLOCKED; an UNVERIFIABLE one: NEEDS YOU', () => {
    assert.equal(gate({ rows: rows({ 'ch:2': 'BLOCKED' }) }).outcome, 'BLOCKED');
    assert.equal(gate({ rows: rows(), blocked: [{ id: 'fail:head/desktop/item' }] }).outcome, 'BLOCKED');
    assert.equal(gate({ rows: rows({ 'ch:2': 'UNVERIFIABLE' }) }).outcome, 'NEEDS YOU');
  });

  test('precedence: blocked run, then REJECT, then PENDING, then BLOCKED, then NEEDS YOU', () => {
    const all = rows({ 'ch:1': 'FAIL', 'ch:2': 'BLOCKED' });
    assert.equal(gate({ rows: all, runBlocked: true }).outcome, 'BLOCKED');
    assert.equal(gate({ rows: all, pending: ['x'] }).outcome, 'REJECT');
    assert.equal(gate({ rows: rows({ 'ch:2': 'BLOCKED' }), pending: ['x'] }).outcome, 'PENDING');
    assert.equal(gate({ rows: rows({ 'ch:2': 'BLOCKED', 'ch:1': 'UNVERIFIABLE' }) }).outcome, 'BLOCKED');
  });

  test('an advisory row never gates, whatever its status', () => {
    for (const status of ['FAIL', 'BLOCKED', 'UNVERIFIABLE']) assert.equal(gate({ rows: rows({ 'ch:4': status }) }).outcome, 'ACCEPT', status);
  });

  test('a manual row is open (NEEDS YOU) unless waived, whatever status it carries, and when it has no row', () => {
    const none = decide({ charter, rows: [{ id: 'ch:1', status: 'PASS' }, { id: 'ch:2', status: 'PASS' }] });
    assert.equal(none.outcome, 'NEEDS YOU');
    assert.deepEqual(none.open, ['ch:3']);
    assert.equal(decide({ charter, rows: rows({ 'ch:3': 'PASS' }) }).outcome, 'NEEDS YOU');
    assert.equal(gate({ rows: rows({ 'ch:3': 'UNVERIFIABLE' }) }).outcome, 'ACCEPT', 'the waiver covers it');
  });

  test('a waived id never gates: a FAIL row, a Blocker finding, a blocked item', () => {
    const waivers = waiverMap(parseWaivers([
      '- [ch:1] waived: the user accepts the old wording (u, 2026-11-12)',
      '- [ch:3] waived: no key (u, 2026-11-12)',
      '- [rte:1] waived: an internal route (u, 2026-11-12)',
      '- [fail:head/desktop/item] waived: loads by hand (u, 2026-11-12)',
    ].join('\n')));
    const g = decide({ charter, waivers, rows: rows({ 'ch:1': 'FAIL' }), findings: [{ id: 'rte:1', severity: 'Blocker' }], blocked: [{ id: 'fail:head/desktop/item' }] });
    assert.equal(g.outcome, 'ACCEPT');
    assert.deepEqual(g.waived.sort(), ['ch:1', 'ch:3', 'fail:head/desktop/item', 'rte:1']);
  });

  test('with a charter, expectation rows are evidence and never decide; with none, every row decides', () => {
    assert.equal(decide({ charter, rows: [...rows(), { id: 'exp:other', status: 'FAIL' }], waivers: waiverMap(parseWaivers('- [ch:3] waived: x (u, 2026-11-12)')) }).outcome, 'ACCEPT');
    assert.equal(decide({ rows: [{ id: 'exp:other', status: 'FAIL' }] }).outcome, 'REJECT');
    assert.equal(decide({ rows: [{ id: 'exp:other', status: 'UNVERIFIABLE' }] }).outcome, 'NEEDS YOU');
  });
});

// ── the draft with a charter and waivers ──────────────────────────────────────

describe('draftVerdict with a charter', () => {
  const met = (name) => ex(name, 'met');
  const base = (over = {}) => results({ expectations: [met('column-shown'), met('empty-text'), met('empty-icon'), met('row-height')], ...over });

  test('a manual row is NEEDS YOU from the start: its row carries the ask', () => {
    const d = draftVerdict(base(), { charterMd: CHARTER });
    assert.equal(d.verdict, 'NEEDS YOU');
    assert.ok(d.md.includes('- [ch:3] UNVERIFIABLE — works with a real provider key: manual — ask: Did a real key work when you tried it?\n'), d.md);
    assert.equal(d.criteria.unverifiable, 1);
  });

  test('with the manual row waived, every spec criterion met: ACCEPT, the waiver cited on the row', () => {
    const d = draftVerdict(base(), { charterMd: CHARTER, waiversMd: '- [ch:3] waived: no real key in the sandbox (the user, 2026-11-12)' });
    assert.equal(d.verdict, 'ACCEPT');
    assert.ok(d.md.includes('- [ch:3] WAIVED — works with a real provider key: waived: no real key in the sandbox (the user, 2026-11-12) — was manual — ask: Did a real key work when you tried it?'), d.md);
    assert.deepEqual(d.criteria, { pass: 4, fail: 0, unverifiable: 0, blocked: 0, waived: 1 });
  });

  test("an advisory row's failing expectation is reported and never gates", () => {
    const waiversMd = '- [ch:3] waived: no key (u, 2026-11-12)';
    const d = draftVerdict(base({ expectations: [met('column-shown'), met('empty-text'), met('empty-icon'), ex('row-height', 'NOT MET')] }), { charterMd: CHARTER, waiversMd });
    assert.equal(d.verdict, 'ACCEPT');
    assert.match(d.md, /^- advisory: 1 charter row\(s\) beyond the spec \(ch:4\); checked and reported, never gating$/m);
  });

  test("a spec criterion's failing expectation is a REJECT; one the tool could not check is BLOCKED", () => {
    const waiversMd = '- [ch:3] waived: no key (u, 2026-11-12)';
    assert.equal(draftVerdict(base({ expectations: [met('column-shown'), ex('empty-text', 'NOT MET'), met('empty-icon')] }), { charterMd: CHARTER, waiversMd }).verdict, 'REJECT');
    assert.equal(draftVerdict(base({ expectations: [met('column-shown'), ex('empty-text', 'not observed'), met('empty-icon')] }), { charterMd: CHARTER, waiversMd }).verdict, 'BLOCKED');
  });

  test('a waived expectation is a WAIVED row and stops gating', () => {
    const waiversMd = '- [ch:3] waived: no key (u, 2026-11-12)\n- [exp:empty-text] waived: the copy is still being written (u, 2026-11-12)';
    const d = draftVerdict(base({ expectations: [met('column-shown'), ex('empty-text', 'NOT MET'), met('empty-icon')] }), { charterMd: CHARTER, waiversMd });
    assert.ok(d.md.includes('- [exp:empty-text] WAIVED — empty-text: waived: the copy is still being written (u, 2026-11-12) — was FAIL: empty-text detail'), d.md);
    assert.equal(d.verdict, 'ACCEPT');
  });

  test('a spec criterion no expectation proves leaves the draft PENDING for the judge', () => {
    const charterMd = `${CHARTER}- [ch:5] the page reads well — axis: copy — by: eyes\n`;
    assert.equal(draftVerdict(base(), { charterMd, waiversMd: '- [ch:3] waived: no key (u, 2026-11-12)' }).verdict, 'PENDING');
  });

  describe('suite evidence in a charter row', () => {
    const SUITES = '# Charter — feat-x\nsecurity: no — none\n\n- [ch:6] ruff and pytest are clean — axis: regression — rung 4: the suites run whole in suites mode — by: suite unit, suite lint\n';
    const suite = (id, result) => ({ id: `suite:${id}`, viewport: null, name: `suite ${id}`, result, detail: `suite ${id} detail` });

    test('both suites PASS: the row is PASS and the draft is ACCEPT, not PENDING for the judge', () => {
      const d = draftVerdict(results({ expectations: [suite('unit', 'met'), suite('lint', 'met')] }), { charterMd: SUITES });
      assert.equal(d.verdict, 'ACCEPT');
      assert.equal(d.criteria.pass, 2);
    });

    test('one suite FAILs: the row FAILs and the draft is REJECT', () => {
      const d = draftVerdict(results({ expectations: [suite('unit', 'met'), suite('lint', 'NOT MET')] }), { charterMd: SUITES });
      assert.equal(d.verdict, 'REJECT');
    });

    test('a cited suite with no row did not run: UNVERIFIABLE, NEEDS YOU, and a gap that says so', () => {
      const r = results({ expectations: [suite('unit', 'met')] });
      const d = draftVerdict(r, { charterMd: SUITES });
      assert.equal(d.verdict, 'NEEDS YOU');
      assert.match(d.md, /^- \[gap:suite\] suite lint did not run: /m);
      assert.equal(verdictOutcome({ verdictMd: d.md, results: r, charterMd: SUITES }).outcome, 'NEEDS YOU', 'the judged verdict keeps it too');
    });

    test('a mixed citation derives from both the suite row and the expectation', () => {
      const charterMd = '- [ch:7] the list is sorted — axis: copy — by: suite unit; expectation column-shown\n';
      assert.equal(draftVerdict(results({ expectations: [suite('unit', 'NOT MET'), met('column-shown')] }), { charterMd }).verdict, 'REJECT');
      assert.equal(draftVerdict(results({ expectations: [suite('unit', 'met'), met('column-shown')] }), { charterMd }).verdict, 'ACCEPT');
    });
  });

  test('a test or doc record naming a criterion proves it too', () => {
    const charterMd = '- [ch:1] the limit holds — axis: data shape — by: spec\n';
    const record = { id: 'exp:limit-holds', name: 'limit-holds', criterion: 'ch:1', result: 'NOT MET', counts: { matched: 1, failed: 1 } };
    const r = results({ tests: [record], expectations: [{ id: 'exp:limit-holds', viewport: null, name: 'limit-holds', result: 'NOT MET', detail: 'x' }] });
    assert.equal(draftVerdict(r, { charterMd }).verdict, 'REJECT');
  });

  test('a waived Blocker and a waived blocked item get a Notes line each and never gate', () => {
    const r = base({ failures: [headFailure()], routes: { new: [{ id: 'rte:1', route: 'GET /api/x', kind: 'happy', actor: 'anon', problem: '500 answered' }], unlisted: [], stale: [] } });
    const waiversMd = '- [ch:3] waived: no key (u, 2026-11-12)\n- [rte:1] waived: an internal route (u, 2026-11-12)\n- [fail:head/desktop/item] waived: loads by hand (u, 2026-11-12)';
    const d = draftVerdict(r, { charterMd: CHARTER, waiversMd });
    assert.equal(d.verdict, 'ACCEPT');
    assert.match(d.md, /^- waived \[rte:1\]: an internal route \(u, 2026-11-12\); never gating$/m);
    assert.match(d.md, /^- waived \[fail:head\/desktop\/item\]: loads by hand \(u, 2026-11-12\); never gating$/m);
  });
});

// ── tool failures in the draft ────────────────────────────────────────────────

describe('tool failures are BLOCKED items', () => {
  test('a head capture that timed out twice is a BLOCKED gap naming the retry and whether base walked it', () => {
    const d = draftVerdict(results({ expectations: [ex('a', 'met')], failures: [headFailure({ timeout: true, retried: true, baseWalked: true })] }));
    assert.equal(d.verdict, 'BLOCKED');
    assert.deepEqual(d.blocked.map((b) => b.id), ['fail:head/desktop/item']);
    const gap = d.md.split('\n').find((l) => l.startsWith('- [fail:head/desktop/item] '));
    assert.equal(gap, '- [fail:head/desktop/item] BLOCKED — {"waitFor":"role=heading"}: locator.waitFor: Timeout 20000ms exceeded. (timed out, retried once); base walked it');
    assert.match(d.md, /^- blocked: 1 item\(s\) the tool could not check \(Gaps BLOCKED rows\); they never fail the PR/m);
  });

  test('a head failure where the app answered 5xx is a Blocker, never BLOCKED', () => {
    const d = draftVerdict(results({ expectations: [ex('a', 'met')], failures: [headFailure({ timeout: true, serverError: '503 document /item' })] }));
    assert.equal(d.verdict, 'REJECT');
    assert.deepEqual(d.blocked, []);
    assert.equal(d.findings[0].severity, 'Blocker');
  });

  test('a compare that threw and a screen compare could not read are BLOCKED items', () => {
    const d = draftVerdict(results({
      expectations: [ex('a', 'met')], compareError: 'Unexpected end of JSON input',
      screens: [{ id: 'scr:desktop/item__default', viewport: 'desktop', key: 'item__default', screen: 'item', status: 'same', error: 'bad PNG' }],
    }));
    assert.deepEqual(d.blocked.map((b) => b.id), ['fail:compare', 'scr:desktop/item__default']);
    assert.equal(d.verdict, 'BLOCKED');
  });

  test('a run whose sandbox never came up: final BLOCKED verdict, every charter row BLOCKED, valid as it stands', () => {
    const blocked = 'BLOCKED ON INFRASTRUCTURE: head: up: exit 1: the stack did not start';
    const r = results({
      exit: 4, blocked, sandboxes: { base: null, head: { name: null, state: 'blocked', ms: 1 } },
      failures: [{ id: 'fail:sandbox/head', side: 'head', viewport: null, screen: null, step: 'up', error: blocked, lines: [blocked], mapError: false, onBase: false }],
    });
    const d = draftVerdict(r, { charterMd: CHARTER, final: true });
    const ls = d.md.split('\n');
    assert.equal(ls[0], '# BLOCKED — feat-x');
    assert.ok(!d.md.includes('\ndraft: '), 'no draft line');
    assert.ok(ls.includes('- [ch:1] BLOCKED — the list shows the new column: not checked: BLOCKED ON INFRASTRUCTURE: head: up: exit 1: the stack did not start'));
    assert.ok(ls.includes('- [ch:4] BLOCKED — the rows are 44 px tall on touch: not checked: BLOCKED ON INFRASTRUCTURE: head: up: exit 1: the stack did not start — advisory'));
    assert.deepEqual(validateVerdict({ verdictMd: d.md, results: r, charterMd: CHARTER }), []);
  });
});

// ── the judge's verdict against the gate (R3, R6) ─────────────────────────────

describe('validateVerdict: R3 and R6', () => {
  const r = results({ expectations: [ex('column-shown', 'met'), ex('empty-text', 'met'), ex('empty-icon', 'met'), ex('row-height', 'NOT MET')] });
  const judge = (rows, word, extraNotes = '') => {
    const parsed = rows.map((l) => parseVerdict(`# X — y\n\n## Criteria\n${l}\n`).criteria[0]);
    return [
      `# ${word} — feat-x`, `head: ${SHA_A}`, `base: ${SHA_B}`, `maps: ${'c'.repeat(12)}`, criteriaLine(countRows(parsed)), '',
      '## Criteria',
      '- [exp:column-shown] PASS — column-shown: column-shown detail',
      '- [exp:empty-text] PASS — empty-text: empty-text detail',
      '- [exp:empty-icon] PASS — empty-icon: empty-icon detail',
      '- [exp:row-height] FAIL — row-height: row-height detail',
      ...rows, '',
      '## Expectations', '- none', '', '## Findings', '- none', '', '## Spec cases', '- none (the runner ran data only)', '',
      '## Gaps', '- none', '', '## Standing', '- 0 standing item(s), never gating', '', '## Notes', '- lived-in: not run in this step', extraNotes, '',
      'cost: plan $? · eyes $? · judge $? · runner 0 · total $?', '',
    ].filter((l) => l !== null).join('\n').replace('\n\n\ncost', '\n\ncost');
  };
  const counted = (md) => {
    const v = parseVerdict(md);
    return md.replace(/^criteria: .*$/m, criteriaLine(countRows(v.criteria)));
  };
  const ok = [
    '- [ch:1] PASS — new column: exp:column-shown met',
    '- [ch:2] PASS — empty list: exp:empty-text and exp:empty-icon met',
    '- [ch:3] UNVERIFIABLE — real key: manual — ask: Did a real key work when you tried it?',
    '- [ch:4] FAIL — 44 px rows: exp:row-height NOT MET — advisory',
  ];
  const check = (md, over = {}) => validateVerdict({ verdictMd: counted(md), results: r, charterMd: CHARTER, ...over });

  test('NEEDS YOU with the manual row open and the advisory row failing is valid', () => {
    assert.deepEqual(check(judge(ok, 'NEEDS YOU')), []);
  });

  test('R6: line 1 must be the outcome the gate gives', () => {
    const p = check(judge(ok, 'ACCEPT'));
    assert.deepEqual(p.map((x) => x.rule), ['R6']);
    assert.match(p[0].message, /line 1 is ACCEPT; the gate gives NEEDS YOU: open ch:3/);
    assert.deepEqual(check(judge(ok, 'REJECT')).map((x) => x.rule), ['R6']);
  });

  test('R6 with the waiver: ACCEPT is required once ch:3 is WAIVED', () => {
    const rows = ok.map((l) => (l.startsWith('- [ch:3]') ? '- [ch:3] WAIVED — real key: waived: no key (u, 2026-11-12) — was manual — ask: Did a real key work?' : l));
    const waiversMd = '- [ch:3] waived: no key (u, 2026-11-12)';
    assert.deepEqual(check(judge(rows, 'ACCEPT'), { waiversMd }), []);
    assert.deepEqual(check(judge(rows, 'ACCEPT')).map((x) => x.rule), ['R3'], 'no waiver: WAIVED is not allowed');
  });

  test('R3: a manual row PASS, an open row that says nothing would prove it, a ch row PASS over a failing expectation', () => {
    const manualPass = ok.map((l) => (l.startsWith('- [ch:3]') ? '- [ch:3] PASS — real key: it looked fine' : l));
    assert.ok(check(judge(manualPass, 'ACCEPT')).some((x) => x.rule === 'R3' && /\[ch:3\] is manual/.test(x.message)));
    const vague = ok.map((l) => (l.startsWith('- [ch:2]') ? '- [ch:2] UNVERIFIABLE — empty list: no capture of an empty list' : l));
    assert.ok(check(judge(vague, 'NEEDS YOU')).some((x) => x.rule === 'R3' && /\[ch:2\] is open: say what would prove it/.test(x.message)));
    const said = ok.map((l) => (l.startsWith('- [ch:2]') ? '- [ch:2] UNVERIFIABLE — empty list: no capture — would prove it: a seed with an empty list' : l));
    assert.deepEqual(check(judge(said, 'NEEDS YOU')), []);
    const advisoryPass = ok.map((l) => (l.startsWith('- [ch:4]') ? '- [ch:4] PASS — 44 px rows: fine — advisory' : l));
    assert.ok(check(judge(advisoryPass, 'NEEDS YOU')).some((x) => x.rule === 'R3' && /exp:row-height/.test(x.message)));
  });

  test('R3: an expectation row keeps the fixed table status', () => {
    const md = judge(ok, 'NEEDS YOU').replace('- [exp:row-height] FAIL', '- [exp:row-height] PASS');
    assert.ok(check(md).some((x) => x.rule === 'R3' && x.message === '[exp:row-height] is FAIL by the fixed table, PASS in the verdict'));
  });

  test('R1: each of the four outcomes is a verdict word; PENDING is not', () => {
    for (const word of OUTCOMES) assert.ok(!check(judge(ok, word)).some((x) => x.rule === 'R1'), word);
    assert.ok(check(judge(ok, 'PENDING')).some((x) => x.rule === 'R1'));
  });
});

// ── waivers applied by script ─────────────────────────────────────────────────

describe('applyWaivers', () => {
  const r = results({ expectations: [ex('column-shown', 'met'), ex('empty-text', 'met'), ex('empty-icon', 'met'), ex('row-height', 'met')] });
  const verdict = () => {
    const md = draftVerdict(r, { charterMd: CHARTER, final: true }).md;
    return md.replace('## Criteria\n', '## Criteria\n- [ch:1] PASS — new column: exp:column-shown met\n- [ch:2] PASS — empty list: met\n- [ch:4] PASS — rows: met — advisory\n')
      .replace(/^criteria: .*$/m, 'criteria: 7 pass · 0 fail · 1 unverifiable · 0 blocked · 0 waived');
  };

  test('the draft judged as NEEDS YOU is valid before', () => {
    assert.equal(parseVerdict(verdict()).verdict, 'NEEDS YOU');
    assert.deepEqual(validateVerdict({ verdictMd: verdict(), results: r, charterMd: CHARTER }), []);
  });

  test('a waiver for the open row makes it WAIVED, recounts, and line 1 ACCEPT; the result validates', () => {
    const waiversMd = '- [ch:3] waived: checked by hand with a real key (the user, 2026-11-12)';
    const out = applyWaivers({ verdictMd: verdict(), results: r, charterMd: CHARTER, waiversMd });
    assert.deepEqual(out.applied, ['ch:3']);
    assert.equal(out.outcome, 'ACCEPT');
    assert.ok(out.md.startsWith('# ACCEPT — feat-x\n'));
    assert.ok(out.md.includes('\ncriteria: 7 pass · 0 fail · 0 unverifiable · 0 blocked · 1 waived\n'));
    assert.ok(out.md.includes('- [ch:3] WAIVED — works with a real provider key: waived: checked by hand with a real key (the user, 2026-11-12) — was UNVERIFIABLE: manual — ask: '));
    assert.deepEqual(validateVerdict({ verdictMd: out.md, results: r, charterMd: CHARTER, waiversMd }), []);
    assert.deepEqual(applyWaivers({ verdictMd: out.md, results: r, charterMd: CHARTER, waiversMd }).applied, [], 'twice changes nothing');
  });

  test('a waiver for an id that is only a finding or gap gets a Notes line', () => {
    const rb = results({ ...r, failures: [headFailure()] });
    const md = draftVerdict(rb, { charterMd: CHARTER, final: true }).md
      .replace('## Criteria\n', '## Criteria\n- [ch:1] PASS — a: met\n- [ch:2] PASS — b: met\n- [ch:4] PASS — c: met — advisory\n')
      .replace(/^criteria: .*$/m, 'criteria: 7 pass · 0 fail · 1 unverifiable · 0 blocked · 0 waived');
    const waiversMd = '- [ch:3] waived: by hand (u, 2026-11-12)\n- [fail:head/desktop/item] waived: it loads by hand (u, 2026-11-12)';
    const out = applyWaivers({ verdictMd: md, results: rb, charterMd: CHARTER, waiversMd });
    assert.equal(out.outcome, 'ACCEPT');
    assert.match(out.md, /^- waived \[fail:head\/desktop\/item\]: it loads by hand \(u, 2026-11-12\); never gating$/m);
    assert.deepEqual(validateVerdict({ verdictMd: out.md, results: rb, charterMd: CHARTER, waiversMd }), []);
  });

  test('verdictOutcome reads a judged verdict the way R6 does', () => {
    assert.equal(verdictOutcome({ verdictMd: verdict(), results: r, charterMd: CHARTER }).outcome, 'NEEDS YOU');
  });
});

// ── page checks: a regression needs its element on the base screen; the gate needs a changed screen ──

describe('page checks', () => {
  const KEY = 'item__default';
  const scr = (status, over = {}) => ({ id: `scr:desktop/${KEY}`, viewport: 'desktop', key: KEY, screen: 'item', status, tree: null, elements: { changed: 0, drift: 0 }, pixel: null, eyes: false, ...over });
  const chk = (over = {}) => ({ id: `chk:desktop/${KEY}/1`, viewport: 'desktop', key: KEY, check: 'focus', detail: 'g "Total" 120×120 takes focus with no ring to see', ...over });
  const base = (c, status = 'changed') => results({ expectations: [ex('a', 'met')], screens: [scr(status)], checks: { new: [c], standing: 0, fixed: 0 } });

  test('onBaseTree: the first quoted name on the base tree; an unnamed element or no tree is not', () => {
    const tree = '- heading "Items" [level=1]\n- link "Support":\n  - /url: /help';
    assert.equal(onBaseTree('span "Support" 65×23 contrast 3.9:1', tree), true);
    assert.equal(onBaseTree('g "Total" 120×120 takes focus', tree), false);
    assert.equal(onBaseTree('svg "" 200×200 under span "Items"', tree), false);
    assert.equal(onBaseTree('span "Support"', null), false);
  });

  test('a new finding on an element the base did not have is new content: Minor, never gating, even on a changed screen', () => {
    const d = draftVerdict(base(chk({ onBase: false })));
    assert.equal(d.findings[0].severity, 'Minor');
    assert.match(d.findings[0].text, / — uncorroborated page check: the element is new on head \(not on the base screen\)$/);
    assert.equal(d.verdict, 'ACCEPT');
  });

  test('a regression of an element the base had, on a changed screen, gates; on an unchanged screen it is reported only', () => {
    assert.deepEqual(draftVerdict(base(chk({ onBase: true }))).gates, [`chk:desktop/${KEY}/1`]);
    const same = draftVerdict(base(chk({ onBase: true }), 'same'));
    assert.deepEqual([same.findings[0].severity, same.gates, same.verdict], ['Major', [], 'ACCEPT']);
  });

  test('eyes ruling the screen wrong corroborates a new element too, and it gates on a changed screen', () => {
    const d = draftVerdict(base(chk({ onBase: false })), { eyes: [{ id: `scr:desktop/${KEY}`, verdict: 'wrong', fix: 'no focus ring' }] });
    assert.equal(d.verdict, 'REJECT');
  });

  test('compare marks each new finding of a pair with a base record: on the base tree or not', () => {
    const rec = (checks) => ({ screen: 'item', capture: 'default', url: 'http://x/', elements: [], overflow: [], writes: [], errors: [], tree: 'x.aria.yml', checks, tour: null });
    const side = (checks, tree) => ({ records: { [KEY]: rec(checks) }, failed: {}, videos: {}, trees: { [KEY]: tree }, pngs: {} });
    const r = compareViewport({
      before: side([], '- link "Support"'), viewport: 'desktop', profile: {},
      after: side([{ check: 'contrast', detail: 'span "Support" 65×23 contrast 3.9:1' }, { check: 'focus', detail: 'g "Total" 1×1 takes focus with no ring to see' }], '- link "Support"\n- img "Total"'),
    });
    assert.deepEqual(r.pairs[0].checks.newOnBase, [true, false]);
  });
});

// ── results: what summary.mjs keeps for the gate ──────────────────────────────

describe('results', () => {
  test('buildResults keeps timeout, retried, serverError, baseWalked, observed, a screen error and compareError', () => {
    const side = (failed, captured = []) => ({ viewports: [{ viewport: 'desktop', captured, failed, notRun: [], warnings: [] }], ms: 1 });
    const pair = { key: 'other__default', status: 'same', before: { screen: 'other' }, after: { screen: 'other' }, elements: [], tree: null, pixel: null, error: 'bad PNG' };
    const run = {
      mode: 'diff', slug: 's', exit: 1, head: { sha: SHA_A }, base: { sha: SHA_B }, maps: {}, sandboxes: {}, steps: [], warnings: [], blocked: null,
      compareError: 'boom', newEntries: {},
      sides: {
        base: side([], ['item__default']),
        head: side([{ screen: 'item', step: 'x', error: 'Timeout 5000ms exceeded.', timeout: true, retried: true, serverError: '502 GET /api/x' }]),
      },
      compare: { exit: 1, viewports: [{ viewport: 'desktop', pairs: [pair], expectations: [{ name: 'e', result: 'not observed', detail: 'd', observed: 0 }], unexpected: [], eyes: [], standing: {} }] },
    };
    const r = buildResults(run);
    const f = r.failures.find((x) => x.id === 'fail:head/desktop/item');
    assert.equal(f.timeout, true);
    assert.equal(f.retried, true);
    assert.equal(f.serverError, '502 GET /api/x');
    assert.equal(f.baseWalked, true);
    assert.equal(r.expectations[0].observed, 0);
    assert.equal(r.screens.find((s) => s.id === 'scr:desktop/other__default').error, 'bad PNG');
    assert.equal(r.compareError, 'boom');
  });
});

// ── compare: one row's exception never stops the others ───────────────────────

describe('compare', () => {
  const rec = (screen, elements) => ({ screen, capture: 'default', url: 'http://x/', elements, overflow: [], writes: [], errors: [] });
  const side = (elements) => ({ records: { 'item__default': rec('item', elements) }, failed: {}, videos: {} });
  const el = (text, background = 'rgb(255, 255, 255)') => ({ text, context: '', className: '', style: { background, color: 'rgb(0, 0, 0)', border: '0px none rgb(0, 0, 0)' } });

  test('an expectation that throws is an error row; the next one is still judged; observed counts what was judged', () => {
    const r = compareViewport({
      before: side([el('Draft')]), after: side([el('Ready', 'rgb(0, 128, 0)')]), viewport: 'desktop',
      expectations: [
        { name: 'bad-token', screens: 'item', text: 'Ready', after: 'no-such-token' },
        { name: 'renamed', screens: 'item', text: 'Ready', before: 'Draft' },
        { name: 'missing', screens: 'item', text: 'Nowhere' },
      ],
      profile: {},
    });
    const by = Object.fromEntries(r.expectations.map((e) => [e.name, e]));
    assert.equal(by['bad-token'].result, 'error');
    assert.match(by['bad-token'].detail, /^the tool failed: unknown palette token "no-such-token"/);
    assert.equal(by.renamed.result, 'met');
    assert.ok(by.renamed.observed >= 1);
    assert.equal(by.missing.result, 'not observed');
    assert.equal(by.missing.observed, 0);
    assert.notEqual(r.exit, 0, 'a row the tool could not judge is never a clean pass');
  });
});

// ── capture: timeouts walked again after the others; a server error never retried ──

describe('capture', () => {
  let server;
  let baseUrl;
  let pw;
  let mainRoot;
  const hits = {};
  before(async () => {
    mainRoot = tmp('mfqa-out-main-');
    server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://fixture');
      hits[pathname] = (hits[pathname] ?? 0) + 1;
      const page = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`); };
      // The marker comes on the second visit only: a page that was slow the first time.
      if (pathname === '/late') return page(hits[pathname] > 1 ? '<h1>Late</h1><p id="marker">here</p>' : '<h1>Late</h1>');
      if (pathname === '/never') return page('<h1>Never</h1>');
      if (pathname === '/broken') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<h1>Internal error</h1>'); return; }
      return page('<h1>Plain</h1>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    pw = loadPlaywright(mainRoot);
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test('isTimeout and serverErrorOf read Playwright errors and the walk trace', () => {
    assert.equal(isTimeout(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
    assert.equal(isTimeout(new Error('locator.waitFor: Timeout 20000ms exceeded.')), true);
    assert.equal(isTimeout(new Error('unknown step {}')), false);
    assert.equal(serverErrorOf({ document: { status: 503, path: '/a' }, errors: [] }), '503 document /a');
    assert.equal(serverErrorOf({ document: { status: 200, path: '/a' }, errors: ['HTTP 404 GET /api/y', 'HTTP 502 POST /api/z'] }), '502 POST /api/z');
    assert.equal(serverErrorOf({ document: null, errors: ['HTTP 404 GET /api/y'] }), null);
  });

  test('a timed-out screen is walked again after the others: once it works it is captured; twice timed out it is marked so; a 5xx is never retried', { timeout: 60000 }, async () => {
    const out = tmp('mfqa-out-');
    const order = [];
    const profile = {
      viewports: { desktop: [800, 600] }, browser: { channel: 'chromium' }, watch: 'h1', settle: { timeoutMs: 1000, quietMs: 100, hidden: null },
      stepTimeoutMs: 1200, maxElementsPerCapture: 20, login: {}, ignoreErrors: [], writes: { scope: null, allow: [], block: false },
    };
    const screens = [
      { name: 'late', steps: [{ goto: '/late' }, { waitFor: '#marker' }] },
      { name: 'never', steps: [{ goto: '/never' }, { waitFor: '#marker' }] },
      { name: 'broken', steps: [{ goto: '/broken' }, { waitFor: '#marker' }] },
      { name: 'plain', steps: [{ goto: '/plain' }] },
    ];
    const r = await capture({
      profile, mainRoot, baseUrl, screens, out, viewport: 'desktop', headless: true, cwd: mainRoot, vars: {}, pw, checks: false, tour: false,
      log: (line) => order.push(String(line)),
    });
    assert.deepEqual(r.captured.sort(), ['late__default', 'plain__default']);
    const byName = Object.fromEntries(r.failed.map((f) => [f.screen, f]));
    assert.equal(byName.never.timeout, true);
    assert.equal(byName.never.retried, true);
    assert.equal(byName.broken.serverError, '500 document /broken');
    assert.equal(byName.broken.retried, undefined, 'a server error is not walked again');
    assert.equal(hits['/broken'], 1);
    assert.equal(hits['/never'], 2);
    assert.ok(order.findIndex((l) => l.startsWith('plain ok')) < order.findIndex((l) => l.startsWith('late ok')), 'the retry comes after the other screens');
    const failedJson = JSON.parse(fs.readFileSync(path.join(out, 'desktop', 'never__FAILED.json'), 'utf8'));
    assert.equal(failedJson.retried, true);
    assert.ok(!fs.existsSync(path.join(out, 'desktop', 'late__FAILED.json')), 'no stale failure for the screen that worked the second time');
  });
});

// ── runQa: a run that cannot start still has an outcome ──────────────────────

describe('runQa', () => {
  const gitIn = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  function repo() {
    const dir = tmp('mfqa-oc-run-');
    gitIn(['init', '-q'], dir);
    gitIn(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
    fs.mkdirSync(path.join(dir, 'qa', 'map'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'qa', 'map', 'app.json'), '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
    gitIn(['add', '-A'], dir);
    gitIn(['commit', '-q', '-m', 'one'], dir);
    gitIn(['checkout', '-q', '-b', 'feat/item'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
    gitIn(['add', '-A'], dir);
    gitIn(['commit', '-q', '-m', 'two'], dir);
    return dir;
  }
  const profile = { map: 'qa/map', seedNames: 'qa/seed.json', base: 'sandbox', viewports: { desktop: [800, 600] }, clock: 'off', checks: { enabled: false }, tour: { enabled: false }, sandbox: { max: 3, retryWaitMs: 0 }, run: { cacheKeep: 5 }, volatile: [] };
  const never = () => { throw new Error('nothing may start'); };

  test('a block before any plan (round 1\'s prepare check: no charter.md yet): a BLOCKED verdict report build accepts; R9 does not apply to it', async () => {
    const dir = repo();
    const V = path.join(dir, 'qa', 'feat-item');
    const text = 'prepare check: the PR\'s QA files could not be proven (1 problem(s)): [map:home] not reached — V/prepare.md lists them';
    const run = await runQa({ mainRoot: dir, repoRoot: dir, profile, log: () => {}, blocked: { text } }, { up: never, captureSide: never, compare: never });
    assert.equal(run.exit, 4);
    assert.ok(!fs.existsSync(path.join(V, 'charter.md')), 'no plan was made');
    const md = fs.readFileSync(path.join(V, 'verdict.md'), 'utf8');
    assert.ok(md.startsWith('# BLOCKED — feat-item\n'), md);
    const r = JSON.parse(fs.readFileSync(path.join(V, 'results.json'), 'utf8'));
    assert.deepEqual(validateVerdict({ verdictMd: md, results: r, charterMd: null }), []);
    // The CLI builds its report like any BLOCKED verdict's: the round ends exit 4 with its Report line and PR comment.
    const b = spawnSync(process.execPath, [CLI, 'report', 'build', '--slug', 'feat-item'], { cwd: dir, encoding: 'utf8' });
    assert.equal(b.status, 0, `${b.stdout}${b.stderr}`);
    assert.ok(fs.existsSync(path.join(V, 'report.html')));
    // A judged verdict is still held to its charter.
    const judged = md.replace('# BLOCKED — feat-item', '# REJECT — feat-item');
    assert.ok(validateVerdict({ verdictMd: judged, results: r, charterMd: null }).some((p) => p.rule === 'R9' && p.message === 'charter.md is missing'));
  });

  test('a compare that throws is a BLOCKED row of its own; an unknown --base is a USAGE error before anything starts', async () => {
    const dir = repo();
    const desc = { name: 'qa-x', slug: 'qa-x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null };
    const side = { viewports: [{ viewport: 'desktop', captured: ['home__default'], failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: 'off' }, mapErrors: [], ms: 1 };
    const run = await runQa({ mainRoot: dir, repoRoot: dir, profile, log: () => {}, screens: 'home', routes: false, mutants: 'none' }, {
      up: async () => desc, down: async () => ({ warnings: [] }), captureSide: async (req) => { fs.mkdirSync(req.out, { recursive: true }); return structuredClone(side); },
      compare: async () => { throw new Error('the compare broke'); }, sleep: async () => {},
    });
    assert.equal(run.results.compareError, 'the compare broke');
    assert.deepEqual(draftVerdict(run.results).blocked.map((b) => b.id), ['fail:compare']);
    await assert.rejects(runQa({ mainRoot: dir, repoRoot: dir, profile, log: () => {}, base: 'no-such-ref' }), /unknown ref/);
  });

  test('named tests whose runner throws are tool errors: BLOCKED, never UNVERIFIABLE', async () => {
    const dir = repo();
    const V = path.join(dir, 'qa', 'feat-item');
    fs.mkdirSync(V, { recursive: true });
    fs.writeFileSync(path.join(V, 'expectations.json'), JSON.stringify([{ name: 'probe', test: { suite: 'unit', grep: 'probe' }, criterion: 'ch:1' }]));
    const desc = { name: 'qa-x', slug: 'qa-x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null };
    const side = { viewports: [{ viewport: 'desktop', captured: [], failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: 'off' }, mapErrors: [], ms: 1 };
    const run = await runQa({ mainRoot: dir, repoRoot: dir, profile, log: () => {}, screens: 'home', routes: false, mutants: 'none' }, {
      up: async () => desc, down: async () => ({ warnings: [] }), captureSide: async (req) => { fs.mkdirSync(req.out, { recursive: true }); return structuredClone(side); },
      compare: async () => ({ exit: 0, viewports: [] }), sleep: async () => {}, runTests: async () => { throw new Error('spawn ENOENT'); },
    });
    const t = run.results.tests[0];
    assert.equal(t.toolError, true);
    const d = draftVerdict(run.results, { charterMd: '- [ch:1] the probe holds — axis: state — by: expectation probe\n' });
    assert.ok(d.md.includes('- [exp:probe] BLOCKED — probe: '), d.md);
    assert.equal(d.verdict, 'BLOCKED');
  });
});

// ── ports.extra ───────────────────────────────────────────────────────────────

describe('ports.extra', () => {
  const listen = (port) => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });

  test('a port whose extra port is taken by another sandbox, reserved, or bound is skipped', async () => {
    const lo = 18800;
    // Another sandbox at lo+1 holds lo+1 and lo+1+100; lo+100 is bound by something else.
    const skip = new Set([lo + 1, lo + 101]);
    const busy = await listen(lo + 100);
    try {
      const claim = await claimPort(lo, lo + 10, skip, [100]);
      assert.ok(claim, 'a port was found');
      // lo: its extra (lo+100) is bound. lo+1: taken. lo+2 is the first whose own and extra port are free.
      assert.equal(claim.port, lo + 2);
      await claim.release();
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  test('a candidate whose extra port is another sandbox own port is skipped too', async () => {
    const lo = 18900;
    const claim = await claimPort(lo, lo + 5, new Set([lo + 3]), [3]);
    assert.notEqual(claim.port, lo, 'lo + 3 belongs to another sandbox');
    assert.equal(claim.port, lo + 1);
    await claim.release();
  });

  test('no extra offsets: the claim is as before', async () => {
    const claim = await claimPort(19000, 19005, new Set([19000]));
    assert.equal(claim.port, 19001);
    await claim.release();
  });
});

// ── the CLI: verdict waivers ──────────────────────────────────────────────────

describe('cli', () => {
  test('qa verdict waivers applies V/waivers.md to V/verdict.md, validates and writes it', () => {
    const dir = tmp('mfqa-oc-cli-');
    const gitIn = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    gitIn(['init', '-q']);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
    gitIn(['add', '-A']);
    gitIn(['commit', '-q', '-m', 'one']);
    const V = path.join(dir, 'qa', 'pr-x');
    fs.mkdirSync(V, { recursive: true });
    const r = results({ slug: 'pr-x', expectations: [ex('column-shown', 'met'), ex('empty-text', 'met'), ex('empty-icon', 'met'), ex('row-height', 'met')] });
    fs.writeFileSync(path.join(V, 'results.json'), JSON.stringify(r));
    fs.writeFileSync(path.join(V, 'charter.md'), CHARTER);
    const md = draftVerdict(r, { charterMd: CHARTER, final: true }).md
      .replace('## Criteria\n', '## Criteria\n- [ch:1] PASS — a: met\n- [ch:2] PASS — b: met\n- [ch:4] PASS — c: met — advisory\n')
      .replace(/^criteria: .*$/m, 'criteria: 7 pass · 0 fail · 1 unverifiable · 0 blocked · 0 waived');
    fs.writeFileSync(path.join(V, 'verdict.md'), md);
    const run = () => spawnSync(process.execPath, [CLI, 'verdict', 'waivers', '--slug', 'pr-x'], { cwd: dir, encoding: 'utf8' });
    const none = run();
    assert.equal(none.status, 3, none.stdout + none.stderr);
    fs.writeFileSync(path.join(V, 'waivers.md'), '# Waivers — pr-x\n- [ch:3] waived: checked by hand (the user, 2026-11-12)\n');
    const ok = run();
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.deepEqual(ok.stdout.trim().split('\n'), ['# ACCEPT — pr-x', 'waived: ch:3']);
    assert.ok(fs.readFileSync(path.join(V, 'verdict.md'), 'utf8').startsWith('# ACCEPT — pr-x\n'));
    const again = run();
    assert.deepEqual(again.stdout.trim().split('\n'), ['# ACCEPT — pr-x', 'no new waiver']);
  });
});
