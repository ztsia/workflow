// Page checks stop gating on their own (0.6.0): verdict.mjs CORROBORATION and tests.mjs CLEARS. A page-check row
// keeps a gating severity only when eyes rules its screen wrong or the base captured that screen too; a met test that
// clears it makes it a Note. Hand-built Results objects (summary.mjs shapes), as test/verdict.test.mjs does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, describe } from 'node:test';
import { validateVerdict } from '../scripts/lib/report.mjs';
import { clearsFinding, clearsProblem, entryProblem, runTests } from '../scripts/lib/tests.mjs';
import { draftVerdict } from '../scripts/lib/verdict.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function results(over = {}) {
  return {
    version: 1, mode: 'diff', slug: 'feat-x', exit: 1,
    head: { sha: SHA_A, ref: 'HEAD' }, base: { sha: SHA_B, ref: 'main', cached: true },
    maps: { head: 'c'.repeat(64), base: 'd'.repeat(64) },
    sandboxes: { base: null, head: null }, steps: [], warnings: [], blocked: null, mapErrors: 0,
    failures: [], notRun: [], screens: [], expectations: [{ id: 'exp:shown', viewport: 'desktop', name: 'shown', result: 'met', detail: 'shown detail' }],
    unexpected: [],
    tour: { opened: 0, failed: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [], standing: 0 },
    checks: { new: [], standing: 0, fixed: 0 },
    console: { new: [], standing: 0 },
    eyes: [], routes: null, mutants: null, tests: [], livedIn: null, metrics: null,
    standing: { checks: 0, tour: 0, console: 0, file: null, added: 0 },
    identical: null, report: null, compare: null,
    ...over,
  };
}

const KEY = 'chart__drawn';
const screen = (status, over = {}) => ({
  id: `scr:desktop/${KEY}`, viewport: 'desktop', key: KEY, screen: 'chart', status,
  tree: null, elements: { changed: 0, drift: 0 }, pixel: null, eyes: false, ...over,
});
const finding = (check, detail, n = 1) => ({ id: `chk:desktop/${KEY}/${n}`, viewport: 'desktop', key: KEY, check, detail });
const COVERED = finding('covered', 'svg "" 200×200 under span.total "Total"', 1);
const FOCUS = finding('focus', 'g "Total" 120×120 takes focus with no ring to see', 2);
const TARGET = finding('target', 'button "x" 20×20 under 24 px', 3);
const tour = (kind, text) => ({ id: `tour:desktop/${KEY}/1`, viewport: 'desktop', key: KEY, text, kind });
const testRecord = (name, result, clears) => ({
  id: `exp:${name}`, name, criterion: null, suite: 'e2e', grep: name, side: 'head', at: SHA_A, result, why: '', detail: `e2e "${name}": ${result}`,
  counts: { total: 1, matched: 1, passed: result === 'met' ? 1 : 0, failed: result === 'met' ? 0 : 1, skipped: 0, flaky: 0 }, names: [], tail: [], base: null, clears,
});
const withTests = (r, records) => ({ ...r, tests: records, expectations: [...r.expectations, ...records.map((t) => ({ id: t.id, viewport: null, name: t.name, result: t.result, detail: t.detail }))] });
const row = (d, id) => d.findings.find((f) => f.id === id);

describe('corroboration', () => {
  test('a Major page check on a screen only head has, with no eyes agreement, is a Minor that does not gate', () => {
    const d = draftVerdict(results({ screens: [screen('new', { newOnHead: 'base could not reach it' })], checks: { new: [COVERED, FOCUS], standing: 0, fixed: 0 } }));
    assert.equal(row(d, COVERED.id).severity, 'Minor');
    assert.equal(row(d, COVERED.id).text, `covered: ${COVERED.detail} — uncorroborated page check: no base screen to compare (new on head)`);
    assert.equal(row(d, FOCUS.id).severity, 'Minor');
    assert.equal(d.verdict, 'ACCEPT', 'every criterion passes and nothing gates');
    assert.match(d.md, /^- page checks: 2 uncorroborated \(Minor\), 0 cleared by a met test \(Note\); a page check gates only when/m);
  });

  test('the same finding is Major again when eyes rules that screen wrong; on a new screen it is reported, never gating (1.0.0)', () => {
    const eyes = [{ id: `scr:desktop/${KEY}`, verdict: 'wrong', fix: 'the total hides the chart' }];
    const d = draftVerdict(results({ screens: [screen('new')], checks: { new: [COVERED], standing: 0, fixed: 0 } }), { eyes });
    assert.equal(row(d, COVERED.id).severity, 'Major');
    assert.equal(row(d, COVERED.id).text, `covered: ${COVERED.detail}`);
    assert.deepEqual(d.gates, []);
    assert.equal(d.verdict, 'ACCEPT');
  });

  test('eyes wrong on a changed screen: Major and gating, the text says so (1.0.0)', () => {
    const eyes = [{ id: `scr:desktop/${KEY}`, verdict: 'wrong', fix: 'the total hides the chart' }];
    const d = draftVerdict(results({ screens: [screen('changed')], checks: { new: [COVERED], standing: 0, fixed: 0 } }), { eyes });
    assert.equal(row(d, COVERED.id).severity, 'Major');
    assert.equal(row(d, COVERED.id).text, `covered: ${COVERED.detail} — gates: corroborated on a changed screen`);
    assert.deepEqual(d.gates, [COVERED.id]);
    assert.equal(d.verdict, 'REJECT');
  });

  test("eyes 'look again' or a verdict on another screen corroborates nothing", () => {
    const eyes = [{ id: `scr:desktop/${KEY}`, verdict: 'look again', fix: '' }, { id: 'scr:desktop/other__x', verdict: 'wrong', fix: '' }];
    const d = draftVerdict(results({ screens: [screen('new')], checks: { new: [COVERED], standing: 0, fixed: 0 } }), { eyes });
    assert.equal(row(d, COVERED.id).severity, 'Minor');
  });

  test('a finding new on head on a screen the base captured too is a regression: Major; it gates only on a changed screen (1.0.0)', () => {
    for (const [status, pixel, gates] of [['changed', null, true], ['drift', null, true], ['same', { ratio: 0.02, worstTile: 0.2, changed: true }, true], ['same', null, false]]) {
      const d = draftVerdict(results({ screens: [screen(status, { pixel })], checks: { new: [COVERED], standing: 0, fixed: 0 } }));
      assert.equal(row(d, COVERED.id).severity, 'Major', status);
      assert.equal(row(d, COVERED.id).text, `covered: ${COVERED.detail}${gates ? ' — gates: corroborated on a changed screen' : ''}`, status);
      assert.equal(d.verdict, gates ? 'REJECT' : 'ACCEPT', `${status} ${pixel ? 'pixels changed' : ''}`);
      assert.doesNotMatch(d.md, /page checks:/);
    }
  });

  test('a finding whose screen is not in results counts as captured on base: the table severity stands', () => {
    const d = draftVerdict(results({ checks: { new: [FOCUS], standing: 0, fixed: 0 } }));
    assert.equal(row(d, FOCUS.id).severity, 'Major');
  });

  test('a Minor by the table stays Minor, with no uncorroborated note', () => {
    const d = draftVerdict(results({ screens: [screen('new')], checks: { new: [TARGET], standing: 0, fixed: 0 } }));
    assert.equal(row(d, TARGET.id).severity, 'Minor');
    assert.equal(row(d, TARGET.id).text, `target: ${TARGET.detail}`);
  });

  test('tour covered and clipped follow the rule; a stuck tour (not a page measurement) stays Major', () => {
    const covered = tour('covered', 'menu "More" covered at 10,10 by div.toast');
    const stuck = tour('stuck', 'dialog "Edit" does not close on Escape');
    const on = (t) => draftVerdict(results({ screens: [screen('new')], tour: { ...results().tour, new: [t] } }));
    assert.equal(row(on(covered), covered.id).severity, 'Minor');
    assert.match(row(on(covered), covered.id).text, / — uncorroborated page check: /);
    assert.equal(row(on(stuck), stuck.id).severity, 'Major');
  });
});

describe('cleared by test evidence', () => {
  const base = () => results({ screens: [screen('changed')], checks: { new: [COVERED, FOCUS, TARGET], standing: 0, fixed: 0 } });

  test('a met test whose clears match a row makes it a Note naming the test; Notes never gate', () => {
    const r = withTests(base(), [testRecord('focus ring shows', 'met', [{ check: 'focus', screens: 'chart', detail: '"Total"' }])]);
    const d = draftVerdict(r);
    assert.deepEqual([row(d, FOCUS.id).severity, row(d, FOCUS.id).text], ['Note', `focus: ${FOCUS.detail} — cleared by test focus ring shows (met)`]);
    assert.equal(row(d, COVERED.id).severity, 'Major', 'a row the test does not clear is untouched');
    assert.deepEqual(d.findings.map((f) => f.severity), ['Major', 'Minor', 'Note'], 'Note after Minor');
    assert.match(d.md, /^- page checks: 0 uncorroborated \(Minor\), 1 cleared by a met test \(Note\)/m);
  });

  test('a finding id clears that row; a Minor row can be cleared too; with every gating row cleared the draft accepts', () => {
    const r = withTests(base(), [testRecord('chart taps', 'met', [COVERED.id, { check: 'focus' }, TARGET.id])]);
    const d = draftVerdict(r);
    assert.deepEqual(d.findings.map((f) => [f.id, f.severity]), [[COVERED.id, 'Note'], [FOCUS.id, 'Note'], [TARGET.id, 'Note']]);
    assert.equal(d.verdict, 'ACCEPT');
  });

  test('a test that is NOT MET or unverifiable clears nothing', () => {
    for (const result of ['NOT MET', 'unverifiable']) {
      const d = draftVerdict(withTests(base(), [testRecord('focus ring shows', result, [{ check: 'focus' }])]));
      assert.equal(row(d, FOCUS.id).severity, 'Major', result);
    }
  });

  test('clearsFinding: check, screens glob (name or key), viewports, detail text or /re/; tour rows by check tour', () => {
    assert.equal(clearsFinding({ check: 'focus' }, FOCUS), true);
    assert.equal(clearsFinding({ check: 'covered' }, FOCUS), false);
    assert.equal(clearsFinding({ check: 'focus', screens: 'ch*' }, FOCUS), true);
    assert.equal(clearsFinding({ check: 'focus', screens: ['other', `${KEY}`] }, FOCUS), true);
    assert.equal(clearsFinding({ check: 'focus', screens: 'other*' }, FOCUS), false);
    assert.equal(clearsFinding({ check: 'focus', viewports: ['phone'] }, FOCUS), false);
    assert.equal(clearsFinding({ check: 'focus', detail: '/no ring/i' }, FOCUS), true);
    assert.equal(clearsFinding({ check: 'focus', detail: 'button' }, FOCUS), false);
    const t = tour('covered', 'menu "More" covered at 10,10 by div.toast');
    assert.equal(clearsFinding({ check: 'tour', detail: 'More' }, t), true);
    assert.equal(clearsFinding({ check: 'covered' }, t), false);
    assert.equal(clearsFinding(t.id, t), true);
  });

  test('clearsProblem and entryProblem name a bad clears list, so the test is not run on it', () => {
    assert.equal(clearsProblem(undefined), null);
    assert.equal(clearsProblem([COVERED.id, { check: 'tour', screens: ['a*'], viewports: ['phone'], detail: '/x/' }]), null);
    assert.equal(clearsProblem('chk:desktop/a/1'), 'clears must be a list');
    assert.match(clearsProblem(['scr:desktop/a']), /^clears\[0\]: "scr:desktop\/a" is not a chk:/);
    assert.match(clearsProblem([{ check: 'ring' }]), /^clears\[0\]\.check: one of contrast, target/);
    assert.match(clearsProblem([{ check: 'focus', detail: '/(/' }]), /^clears\[0\]\.detail: /);
    assert.match(clearsProblem([{ check: 'focus', viewports: 'phone' }]), /^clears\[0\]\.viewports/);
    const entry = { name: 'x', test: { suite: 'unit', grep: 'x' }, clears: [{ check: 'nope' }] };
    assert.match(entryProblem(entry, { unit: 'node --test' }), /^clears\[0\]\.check/);
  });

  test('runTests keeps the entry clears on its record', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-clears-')));
    made.push(dir);
    const clears = [{ check: 'focus', screens: 'chart' }];
    const exec = async ({ logFile }) => {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      return { code: 0, output: 'TAP version 13\nok 1 - focus ring shows\n1..1\n', ms: 1, timedOut: false };
    };
    const [rec] = await runTests({ dir, entries: [{ name: 'ring', test: { suite: 'unit', grep: 'focus ring shows' }, clears }], suites: { unit: 'node --test t.mjs' }, logDir: path.join(dir, 'logs'), exec });
    assert.equal(rec.result, 'met');
    assert.deepEqual(rec.clears, clears);
  });
});

describe('the judge is held to the same table', () => {
  const verdictMd = (findings) => `# ACCEPT — feat-x
head: ${SHA_A}
base: ${SHA_B}
maps: ${'c'.repeat(12)}
criteria: 1 pass · 0 fail · 0 unverifiable

## Criteria
- [exp:shown] PASS — shown: shown detail

## Expectations
- none

## Findings
${findings}

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 0 standing item(s), never gating

## Notes
- none

cost: plan $? · eyes $? · judge $? · runner 0 · total $?
`;
  const charterMd = '# Charter — feat-x\nsecurity: no — none\n';

  test('R5: an uncorroborated row is Minor without eyes, and must be Major when eyes.md rules the screen wrong', () => {
    const r = results({ screens: [screen('new', { eyes: true })], eyes: [`scr:desktop/${KEY}`], checks: { new: [COVERED], standing: 0, fixed: 0 } });
    const minor = verdictMd(`- Minor [${COVERED.id}] covered: x\n- Minor [scr:desktop/${KEY}] fix it`);
    const fine = `## [scr:desktop/${KEY}] chart\nVerdict: look again — fix it\n`;
    assert.deepEqual(validateVerdict({ verdictMd: minor, results: r, eyesMd: fine, charterMd }), []);
    const wrong = `## [scr:desktop/${KEY}] chart\nVerdict: wrong — the label hides the chart\n`;
    const problems = validateVerdict({ verdictMd: minor, results: r, eyesMd: wrong, charterMd });
    assert.ok(problems.some((p) => p.rule === 'R5' && p.message.includes(`[${COVERED.id}] is Major in the fixed table, Minor in the verdict`)), JSON.stringify(problems));
  });

  test('R5: a cleared Note is kept as a Note; the judge may not drop or raise it', () => {
    const r = withTests(results({ screens: [screen('changed')], checks: { new: [FOCUS], standing: 0, fixed: 0 } }), [testRecord('ring', 'met', [FOCUS.id])]);
    const rows = (sev) => `- ${sev} [${FOCUS.id}] focus: x`;
    const md = (sev) => verdictMd(rows(sev)).replace('criteria: 1 pass', 'criteria: 2 pass').replace('## Criteria\n', `## Criteria\n- [exp:ring] PASS — ring: e2e "ring": met\n`);
    assert.deepEqual(validateVerdict({ verdictMd: md('Note'), results: r, charterMd }), []);
    assert.ok(validateVerdict({ verdictMd: md('Major').replace('# ACCEPT', '# REJECT'), results: r, charterMd }).some((p) => p.rule === 'R5'));
  });

  test('qa verdict draft reads eyes.md beside results.json', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-draft-')));
    made.push(dir);
    const file = path.join(dir, 'results.json');
    fs.writeFileSync(file, JSON.stringify(results({ screens: [screen('new')], checks: { new: [COVERED], standing: 0, fixed: 0 } })));
    const draft = () => {
      const run = spawnSync(process.execPath, [CLI, 'verdict', 'draft', '--results', file], { cwd: dir, encoding: 'utf8' });
      return { line: run.stdout.trim(), md: fs.readFileSync(path.join(dir, 'verdict.draft.md'), 'utf8') };
    };
    assert.equal(draft().line, '# ACCEPT — feat-x');
    assert.ok(draft().md.includes(`- Minor [${COVERED.id}] covered: ${COVERED.detail} — uncorroborated`));
    fs.writeFileSync(path.join(dir, 'eyes.md'), `## [scr:desktop/${KEY}] chart\nVerdict: wrong — the label hides the chart\n`);
    const again = draft();
    assert.equal(again.line, '# ACCEPT — feat-x', 'a new screen: corroborated, reported, never gating');
    assert.ok(again.md.includes(`- Major [${COVERED.id}] covered: ${COVERED.detail}\n`), again.md);
  });
});
