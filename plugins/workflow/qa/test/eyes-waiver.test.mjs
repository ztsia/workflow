// An eyes ruling is dismissable by the user through a waiver, end to end (rework §4.2: "the user can dismiss any
// finding"; "the user can dismiss an eyes ruling", §10). The eyes pass rules a screen `wrong`; the judge makes that a
// Blocker on the screen's scr: id, and the ruling also corroborates a page check on that screen, which then gates. A
// waiver of the scr: id dismisses the ruling: the Blocker stops gating, the page check loses the corroboration the
// ruling gave it (it is judged as if eyes had not ruled), `qa verdict waivers` rewrites the verdict to the gate's
// outcome and the result validates (R5 severities, R6 line 1, R8 the ruling still has its non-Note row).
// Contracts: scripts/lib/verdict.mjs 'FOUR OUTCOMES' (applyWaivers) and 'EYES WAIVER'. Neutral fixtures only.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, describe } from 'node:test';
import { parseEyes } from '../scripts/lib/eyes.mjs';
import { validateVerdict } from '../scripts/lib/report.mjs';
import { applyWaivers, draftVerdict, parseVerdict, verdictOutcome } from '../scripts/lib/verdict.mjs';

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

const KEY = 'item__default';
const SCR = `scr:desktop/${KEY}`;
const CHK = `chk:desktop/${KEY}/1`;
const CHARTER = '# Charter — pr-x\nsecurity: no — none\n\n- [ch:1] the item shows its total — axis: happy path — by: expectation total-shown\n';
const EYES = `# Eyes — pr-x\n\n## [${SCR}] item\nThe total is hard to find.\nVerdict: wrong — the total has no focus ring\n`;
const WAIVER = `- [${SCR}] waived: the ring is the chart's own, seen by hand (the user, 2026-11-12)`;

function results(over = {}) {
  return {
    version: 1, mode: 'diff', slug: 'pr-x', exit: 1,
    head: { sha: SHA_A, ref: 'HEAD' }, base: { sha: SHA_B, ref: 'main', cached: true },
    maps: { head: 'c'.repeat(64), base: 'd'.repeat(64) },
    sandboxes: { base: null, head: null }, steps: [], warnings: [], blocked: null, compareError: null, mapErrors: 0,
    failures: [], notRun: [],
    screens: [{ id: SCR, viewport: 'desktop', key: KEY, screen: 'item', status: 'changed', tree: null, elements: { changed: 1, drift: 0 }, pixel: { ratio: 0.1, worstTile: 0.2, changed: true }, eyes: true }],
    expectations: [{ id: 'exp:total-shown', viewport: 'desktop', name: 'total-shown', result: 'met', detail: '1 of 1 right' }],
    unexpected: [],
    tour: { opened: 0, failed: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [], standing: 0 },
    // a page check on an element new on head (onBase false): only the eyes ruling corroborates it
    checks: { new: [{ id: CHK, viewport: 'desktop', key: KEY, check: 'focus', detail: 'g "Total" 120×120 takes focus with no ring to see', onBase: false }], standing: 0, fixed: 0 },
    console: { new: [], standing: 0 },
    eyes: [SCR], routes: null, mutants: null, tests: [], docs: [], livedIn: null, metrics: null,
    standing: { checks: 0, tour: 0, console: 0, file: null, added: 0 }, identical: null, report: null, compare: null,
    ...over,
  };
}

// The judge's verdict: the draft with the eyes row ruled a Blocker, the charter row ruled, line 1 the gate's.
function judged(r, eyes) {
  const d = draftVerdict(r, { eyes, charterMd: CHARTER, final: true });
  const md = d.md
    .replace(/^- eyes \[[^\]]+\] .*$/m, `- Blocker [${SCR}] the total has no focus ring — eyes ruled the screen wrong`)
    .replace('## Criteria\n', '## Criteria\n- [ch:1] PASS — the item shows its total: exp:total-shown met\n')
    .replace(/^criteria: .*$/m, 'criteria: 2 pass · 0 fail · 0 unverifiable · 0 blocked · 0 waived');
  const outcome = verdictOutcome({ verdictMd: md, results: r, eyes, charterMd: CHARTER }).outcome;
  return md.replace(/^# \S+(?: YOU)? — /, `# ${outcome} — `);
}

describe('an eyes ruling dismissed by a waiver', () => {
  const r = results();
  const eyes = parseEyes(EYES);

  test('before: the ruling is a Blocker and corroborates the page check, which gates: a valid REJECT', () => {
    const md = judged(r, eyes);
    assert.equal(parseVerdict(md).verdict, 'REJECT');
    assert.deepEqual(draftVerdict(r, { eyes, charterMd: CHARTER }).gates, [CHK]);
    assert.deepEqual(validateVerdict({ verdictMd: md, results: r, eyesMd: EYES, charterMd: CHARTER }), []);
  });

  test('a waiver of the scr: id takes the ruling out of the gate: the page check is judged as if eyes had not ruled', () => {
    const d = draftVerdict(r, { eyes, charterMd: CHARTER, waiversMd: WAIVER });
    assert.deepEqual(d.gates, []);
    const row = d.findings.find((f) => f.id === CHK);
    assert.equal(row.severity, 'Minor');
    assert.match(row.text, / — uncorroborated page check: the element is new on head \(not on the base screen\)$/);
  });

  test('applyWaivers: ACCEPT, the page-check row takes the fixed table severity, a Notes line names the waiver; it validates', () => {
    const out = applyWaivers({ verdictMd: judged(r, eyes), results: r, eyes, charterMd: CHARTER, waiversMd: WAIVER });
    assert.equal(out.outcome, 'ACCEPT');
    assert.ok(out.md.startsWith('# ACCEPT — pr-x\n'));
    assert.deepEqual(out.applied.sort(), [CHK, SCR].sort());
    assert.match(out.md, new RegExp(`^- Minor \\[${CHK}\\] focus: .* — uncorroborated page check: the element is new on head \\(not on the base screen\\)$`, 'm'));
    assert.match(out.md, new RegExp(`^- Blocker \\[${SCR.replace(/\//g, '\\/')}\\] `, 'm'), 'R8: the ruling keeps its non-Note row');
    assert.match(out.md, new RegExp(`^- waived \\[${SCR.replace(/\//g, '\\/')}\\]: the ring is the chart's own, seen by hand \\(the user, 2026-11-12\\); never gating$`, 'm'));
    assert.deepEqual(validateVerdict({ verdictMd: out.md, results: r, eyesMd: EYES, charterMd: CHARTER, waiversMd: WAIVER }), []);
    assert.deepEqual(applyWaivers({ verdictMd: out.md, results: r, eyes, charterMd: CHARTER, waiversMd: WAIVER }).applied, [], 'twice changes nothing');
  });

  test('a page check that is a regression on its own still gates after the ruling is waived (only the ruling is dismissed)', () => {
    const reg = results({ checks: { ...results().checks, new: [{ ...results().checks.new[0], onBase: true }] } });
    const out = applyWaivers({ verdictMd: judged(reg, eyes), results: reg, eyes, charterMd: CHARTER, waiversMd: WAIVER });
    assert.equal(out.outcome, 'REJECT');
    assert.deepEqual(validateVerdict({ verdictMd: out.md, results: reg, eyesMd: EYES, charterMd: CHARTER, waiversMd: WAIVER }), []);
  });

  test('cli: qa verdict waivers then report build --check, with the waiver in V/waivers.md', () => {
    const dir = tmp('mfqa-eyes-waiver-');
    const gitIn = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    gitIn(['init', '-q']);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
    gitIn(['add', '-A']);
    gitIn(['commit', '-q', '-m', 'one']);
    const V = path.join(dir, 'qa', 'pr-x');
    fs.mkdirSync(V, { recursive: true });
    fs.writeFileSync(path.join(V, 'results.json'), JSON.stringify(r));
    fs.writeFileSync(path.join(V, 'charter.md'), CHARTER);
    fs.writeFileSync(path.join(V, 'eyes.md'), EYES);
    fs.writeFileSync(path.join(V, 'verdict.md'), judged(r, eyes));
    const env = { ...process.env };
    const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--slug', 'pr-x'], { cwd: dir, encoding: 'utf8', env });
    const before = cli('report', 'build', '--check');
    assert.equal(before.status, 0, before.stdout + before.stderr);
    fs.writeFileSync(path.join(V, 'waivers.md'), `# Waivers — pr-x\n${WAIVER}\n`);
    const waived = cli('verdict', 'waivers');
    assert.equal(waived.status, 0, waived.stdout + waived.stderr);
    assert.equal(waived.stdout.trim().split('\n')[0], '# ACCEPT — pr-x');
    assert.ok(fs.readFileSync(path.join(V, 'verdict.md'), 'utf8').startsWith('# ACCEPT — pr-x\n'));
    const check = cli('report', 'build', '--check');
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.equal(check.stdout.trim(), 'valid');
  });
});
