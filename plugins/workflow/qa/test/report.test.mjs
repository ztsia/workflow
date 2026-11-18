// report.mjs: validateVerdict (R1–R10 on the judge's verdict.md), reportHtml, shotsFor. Each test builds
// its own Results from the step 5 example (buildResults(exampleRun())) or from that run with one piece
// emptied, and mutates the judge's verdict.md with swap(), which fails loudly when the piece is missing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { reportHtml, shotsFor, validateVerdict } from '../scripts/lib/report.mjs';
import { buildResults } from '../scripts/lib/summary.mjs';
import { exampleRun } from './fixtures/run-example.mjs';
import { exampleRun6 } from './fixtures/run-example6.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DETAIL = 'scr:desktop/detail__default';
const LIST = 'scr:desktop/list__default';

// The judge's verdict.md for the example run (brief: VALID).
const JUDGE = `# REJECT — feat-x
head: ${SHA_A}
base: ${SHA_B}
maps: cccccccccccc
criteria: 2 pass · 0 fail · 0 unverifiable

## Criteria
- [exp:title-renamed] PASS — title-renamed: 1 element(s): 1 right
- [ch:1] PASS — archive is offered: the Archive button appears for an open record

## Expectations
- [unx:desktop/detail__default/1] explained — the spec adds an Archive button to the detail header

## Findings
- Major [tour:desktop/detail__default/1] new: listbox "Status" 200×240 cut off by div.card — files: src/detail/StatusSelect.tsx
- Major [chk:desktop/detail__default/1] contrast: span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1 — files: src/detail/Detail.css
- Major [con:desktop/detail__default/1] console: TypeError: x is undefined — files: src/detail/Detail.tsx
- Minor [scr:desktop/detail__default] the Archive button sits under the fold on a short window

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 2 standing item(s), never gating — qa/standing.md

## Notes
- lived-in: not run in this step
- routes: no route table
- mutants: not run

cost: plan $0.41 · eyes $0.62 · judge $0.18 · runner 0 · total $1.21
`;

const EYES = `# Eyes — feat-x

## [${DETAIL}] detail
First look: the title, then the new Archive button. …
Verdict: look again — the Archive button sits under the fold on a short window
`;

const CHARTER_ONE = `# Charter — feat-x
security: no — the diff touches no auth, route, migration or sensitive path

- [ch:1] archive is offered on an open record — axis: happy path — by: spec
`;

const CHARTER = `${CHARTER_ONE}- [ch:2] the renamed title shows on the detail page — axis: copy — by: expectation title-renamed
`;

const SUMMARY = '# Summary — feat-x\n## Failures (0)\n- none\n';

const fresh = () => buildResults(exampleRun());

// The example with no expectations: the draft then has a 'gap:criteria' gap.
function noExpectations() {
  const run = exampleRun();
  run.compare.viewports[0].expectations = [];
  return buildResults(run);
}

// The example with no new checks, tour problems or console lines: the draft has no Major.
function quiet() {
  const run = exampleRun();
  for (const p of run.compare.viewports[0].pairs) {
    p.checks.new = [];
    p.tour.new = [];
    p.console.new = [];
  }
  return buildResults(run);
}

const check = (over = {}) => validateVerdict({ verdictMd: JUDGE, results: fresh(), eyesMd: EYES, charterMd: CHARTER_ONE, ...over });

// Replace one exact piece of text; fails if the piece is not in the md, so a mutation never silently does nothing.
function swap(md, from, to) {
  assert.ok(md.includes(from), `fixture has no ${JSON.stringify(from)}`);
  return md.replace(from, to);
}

const rules = (problems) => problems.map((p) => p.rule);

// Every problem is the given rule, and there is at least one.
function onlyRule(problems, rule) {
  assert.ok(problems.length > 0, 'expected at least one problem');
  assert.deepEqual([...new Set(rules(problems))], [rule], JSON.stringify(problems));
}

const MINOR_SCR = '- Minor [scr:desktop/detail__default] the Archive button sits under the fold on a short window\n';

// --- validateVerdict: the valid example ---

test('the step 5 example judge verdict is valid', () => {
  assert.deepEqual(check(), []);
});

test('with the charter citing ch:2, which the verdict never cites, the only problem is R9', () => {
  const p = check({ charterMd: CHARTER });
  assert.deepEqual(rules(p), ['R9']);
  assert.match(p[0].message, /ch:2/);
});

// --- R1 header ---

test('R1: a head sha that is not the run head is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, `head: ${SHA_A}`, `head: ${'e'.repeat(40)}`) }), 'R1');
});

test('R1: base none when the run has a base is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, `base: ${SHA_B}`, 'base: none') }), 'R1');
});

test('R1: maps that is not the first 12 of the maps head is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, 'maps: cccccccccccc', 'maps: dddddddddddd') }), 'R1');
});

test('R1: a title slug that is not the run slug is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, '# REJECT — feat-x', '# REJECT — other') }), 'R1');
});

test('R1: the draft line kept in the judge verdict is a problem', () => {
  const md = swap(JUDGE, 'criteria: 2 pass', 'draft: qa verdict draft — the judge resolves judge and eyes rows, then writes verdict.md\ncriteria: 2 pass');
  onlyRule(check({ verdictMd: md }), 'R1');
});

test('R1: a missing cost line is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, '\ncost: plan $0.41 · eyes $0.62 · judge $0.18 · runner 0 · total $1.21\n', '\n') }), 'R1');
});

// --- R2 sections ---

test('R2: a missing ## Notes section is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, '## Notes\n- lived-in: not run in this step\n- routes: no route table\n- mutants: not run\n', '') }), 'R2');
});

test('R2: an item line that is unreadable is a problem, quoting the line', () => {
  const md = swap(JUDGE, MINOR_SCR, `${MINOR_SCR}- this line has no shape\n`);
  const p = check({ verdictMd: md });
  onlyRule(p, 'R2');
  assert.ok(p.some((x) => x.message.includes('this line has no shape')), JSON.stringify(p));
});

test('R2: a section with no item line at all (not even - none) is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, '## Gaps\n- none\n', '## Gaps\n') }), 'R2');
});

// --- R3 criteria ---

const EXP_ROW = '- [exp:title-renamed] PASS — title-renamed: 1 element(s): 1 right\n';

test('R3: an expectation with no criteria row is a problem naming it', () => {
  const p = check({ verdictMd: swap(JUDGE, EXP_ROW, '') });
  onlyRule(p, 'R3');
  assert.ok(p.some((x) => x.message.includes('exp:title-renamed')), JSON.stringify(p));
});

test('R3: a criteria line that does not count the rows is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, 'criteria: 2 pass', 'criteria: 3 pass') }), 'R3');
});

test('R3: an id that appears twice in criteria is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, EXP_ROW, EXP_ROW + EXP_ROW) }), 'R3');
});

// --- R4 ids ---

test('R4: a finding citing an id the run does not know is a problem', () => {
  const md = swap(JUDGE, MINOR_SCR, `${MINOR_SCR}- Minor [scr:desktop/other__default] a finding on a screen that is not in the run\n`);
  onlyRule(check({ verdictMd: md }), 'R4');
});

test('R4: a judge severity row is a problem (draft-only)', () => {
  const md = swap(JUDGE, MINOR_SCR, `${MINOR_SCR}- judge [chk:desktop/detail__default/1] still open\n`);
  onlyRule(check({ verdictMd: md }), 'R4');
});

test('R4: a gap:<word> id in Gaps is known to the judge, so it is not a problem', () => {
  const md = swap(JUDGE, '## Gaps\n- none\n', '## Gaps\n- [gap:log] could not read the server log\n');
  assert.deepEqual(check({ verdictMd: md }), []);
});

// --- R5 table ---

test('R5: a draft Major downgraded to Minor is a problem', () => {
  const md = swap(JUDGE, '- Major [con:desktop/detail__default/1]', '- Minor [con:desktop/detail__default/1]');
  onlyRule(check({ verdictMd: md }), 'R5');
});

test('R5: a draft Major row dropped from Findings is a problem', () => {
  const row = '- Major [chk:desktop/detail__default/1] contrast: span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1 — files: src/detail/Detail.css\n';
  onlyRule(check({ verdictMd: swap(JUDGE, row, '') }), 'R5');
});

// --- R6 gate ---

test('R6: ACCEPT with a Major finding is a problem', () => {
  onlyRule(check({ verdictMd: swap(JUDGE, '# REJECT — feat-x', '# ACCEPT — feat-x') }), 'R6');
});

test('R6: REJECT with nothing gating (no block, Blocker, Major or failing criterion) is a problem', () => {
  const md = JUDGE.replace(/^- Major .*\n/gm, '');
  onlyRule(validateVerdict({ verdictMd: md, results: quiet(), eyesMd: EYES, charterMd: CHARTER_ONE }), 'R6');
});

// --- R7 unexpected ---

test('R7: an UNEXPECTED row left in Expectations is a problem', () => {
  const md = swap(JUDGE, '- [unx:desktop/detail__default/1] explained — the spec adds an Archive button to the detail header',
    '- [unx:desktop/detail__default/1] UNEXPECTED tree: + heading "New title" [level=1] (+1 more)');
  onlyRule(check({ verdictMd: md }), 'R7');
});

test('R7: a finding row with no Findings row for its id is a problem', () => {
  const md = swap(JUDGE, 'explained — the spec adds an Archive button to the detail header', 'finding — the Archive button is hidden on a short window');
  onlyRule(check({ verdictMd: md }), 'R7');
});

// --- R8 eyes ---

test('R8: eyes.md missing when the run has eyes screens is a problem', () => {
  const p = check({ eyesMd: null });
  onlyRule(p, 'R8');
  assert.ok(p.some((x) => x.message.includes('eyes.md is missing')), JSON.stringify(p));
});

test('R8: a wrong eyes verdict with no Findings row for its screen is a problem', () => {
  const md = swap(JUDGE, MINOR_SCR, '');
  onlyRule(check({ verdictMd: md, eyesMd: swap(EYES, 'Verdict: look again', 'Verdict: wrong') }), 'R8');
});

test('R8: a wrong eyes verdict whose only finding is a Note is a problem', () => {
  const md = swap(JUDGE, MINOR_SCR, MINOR_SCR.replace('- Minor', '- Note'));
  onlyRule(check({ verdictMd: md, eyesMd: swap(EYES, 'Verdict: look again', 'Verdict: wrong') }), 'R8');
});

test('R8: an eyes section with no verdict line is a problem', () => {
  const eyesMd = swap(EYES, 'Verdict: look again — the Archive button sits under the fold on a short window', 'Verdict is still pending');
  onlyRule(check({ eyesMd }), 'R8');
});

// --- R9 charter ---

test('R9: charter.md missing is a problem', () => {
  const p = check({ charterMd: null });
  onlyRule(p, 'R9');
  assert.ok(p.some((x) => x.message.includes('charter.md is missing')), JSON.stringify(p));
});

// --- R10 gaps ---

test('R10: a draft gap id missing from Gaps is a problem naming it', () => {
  // No expectations: the draft gap is gap:criteria. The judge's criteria then count the charter row only.
  const md = swap(swap(JUDGE, 'criteria: 2 pass', 'criteria: 1 pass'), EXP_ROW, '');
  const p = validateVerdict({ verdictMd: md, results: noExpectations(), eyesMd: EYES, charterMd: CHARTER_ONE });
  onlyRule(p, 'R10');
  assert.ok(p.some((x) => x.message.includes('gap:criteria')), JSON.stringify(p));
});

// --- Security (draftVerdict's security option, through R5) ---

const HIGH = [{ id: 'sec:1', level: 'High', text: 'the archive route skips the role check' }];
const SEC_ROW = '- Blocker [sec:1] the archive route skips the role check — files: src/api/archive.ts\n';

test('security: a High entry makes a Blocker draft row, and the verdict carries it: valid', () => {
  const md = swap(JUDGE, '## Findings\n', `## Findings\n${SEC_ROW}`);
  assert.deepEqual(check({ verdictMd: md, security: HIGH }), []);
});

test('security: a High entry whose Blocker row is missing from the verdict is an R5 problem', () => {
  const p = check({ security: HIGH });
  onlyRule(p, 'R5');
  assert.ok(p.some((x) => x.message.includes('sec:1')), JSON.stringify(p));
});

// --- reportHtml ---

const html = (over = {}) => reportHtml({ verdictMd: JUDGE, summaryMd: SUMMARY, results: fresh(), eyes: [], shots: {}, ...over });

test('reportHtml is a whole document titled with the verdict and the slug', () => {
  const h = html();
  assert.match(h, /^\s*<!doctype html>/i);
  assert.ok(h.includes('<title>REJECT — feat-x</title>'));
  assert.match(h, /<\/html>\s*$/);
});

test('reportHtml is self-contained: inline style, no script, no external URL, light and dark', () => {
  const h = html();
  assert.match(h, /<style[\s>]/);
  assert.ok(!/<script/i.test(h));
  assert.ok(!/https?:\/\//i.test(h));
  assert.ok(h.includes('prefers-color-scheme'));
});

test('reportHtml escapes < in the texts it takes, from the verdict and from summary.md', () => {
  const md = swap(JUDGE, 'console: TypeError: x is undefined', 'console: <b>TypeError</b>: x is undefined');
  const h = html({ verdictMd: md, summaryMd: '# Summary\n<i>raw</i>\n' });
  assert.ok(!h.includes('<b>TypeError</b>'));
  assert.ok(h.includes('&lt;b'));
  assert.ok(!h.includes('<i>raw</i>'));
  assert.ok(h.includes('&lt;i'));
});

test('reportHtml shows the head, base, maps, criteria, the Criteria table and the cost line', () => {
  const h = html();
  assert.ok(h.includes(SHA_A) && h.includes(SHA_B));
  assert.ok(h.includes('cccccccccccc'));
  assert.ok(h.includes('2 pass'));
  assert.ok(h.includes('<table'));
  assert.ok(h.includes('title-renamed'));
  assert.ok(h.includes('total $1.21'));
});

test('reportHtml shows each finding with its severity, id and text', () => {
  const h = html();
  for (const s of ['Major', 'Minor', 'chk:desktop/detail__default/1', 'span.muted contrast 2.8:1', 'the Archive button sits under the fold on a short window']) {
    assert.ok(h.includes(s), `missing ${s}`);
  }
});

test('reportHtml shows the other sections as lists, and summary.md in a pre', () => {
  const h = html();
  assert.ok(h.includes('explained'));
  assert.ok(h.includes('none (the runner ran data only)'));
  assert.ok(h.includes('2 standing item(s)'));
  assert.ok(h.includes('lived-in: not run in this step'));
  assert.match(h, /<pre[\s>][\s\S]*Failures \(0\)[\s\S]*<\/pre>/);
});

test('reportHtml puts the two shots of a cited screen in img tags, base and branch', () => {
  const h = html({ shots: { [DETAIL]: { before: 'shots/detail-before.png', after: 'shots/detail-after.png' } } });
  assert.match(h, /<img\b[^>]*shots\/detail-before\.png/);
  assert.match(h, /<img\b[^>]*shots\/detail-after\.png/);
});

test('reportHtml leaves out a missing shot', () => {
  const h = html({ shots: { [DETAIL]: { after: 'shots/detail-after.png' } } });
  assert.equal((h.match(/<img\b/g) ?? []).length, 1);
});

test('reportHtml lists the eyes verdicts with their fix', () => {
  const h = html({ eyes: [{ id: DETAIL, verdict: 'wrong', fix: 'eyes fix sentinel' }] });
  assert.ok(h.includes('eyes fix sentinel'));
  assert.ok(h.includes('wrong'));
});

// --- shotsFor ---

test('shotsFor: the scr ids the Findings cite, then the eyes screens, each once', () => {
  const results = fresh();
  assert.deepEqual(shotsFor(JUDGE, results), [DETAIL]);
  results.eyes = [LIST];
  assert.deepEqual(shotsFor(JUDGE, results), [DETAIL, LIST]);
  results.eyes = [DETAIL];
  assert.deepEqual(shotsFor(JUDGE, results), [DETAIL]);
});

test('shotsFor: a screen cited twice in Findings appears once, and non-scr findings are not shots', () => {
  const md = swap(JUDGE, MINOR_SCR, `${MINOR_SCR}- Note [${DETAIL}] the same screen again\n`);
  const results = fresh();
  results.eyes = [];
  assert.deepEqual(shotsFor(md, results), [DETAIL]);
});

// step 6 -----------------------------------------------------------------------------------------

// The judge's verdict.md for exampleRun6(): the route, mutant and criteria rows added, the met: row dropped.
const JUDGE6 = `# REJECT — feat-x
head: ${SHA_A}
base: ${SHA_B}
maps: cccccccccccc
criteria: 3 pass · 0 fail · 0 unverifiable

## Criteria
- [exp:title-renamed] PASS — title-renamed: 1 element(s): 1 right
- [exp:notes-denied-to-viewer] PASS — notes-denied-to-viewer: POST /api/notes as viewer: 403
- [ch:1] PASS — archive is offered: the Archive button appears for an open record

## Expectations
- [unx:desktop/detail__default/1] explained — the spec adds an Archive button to the detail header

## Findings
- Blocker [rte:1] POST /api/notes deep (staff): 500 answered
- Major [rte:2] POST /api/notes happy (staff): happy path answered 400
- Major [rte:unlisted/1] unlisted: DELETE /api/notes/:id
- Major [mut:rls-check-dropped] SURVIVED: a person can move their row to someone else (supabase/migrations/0007.sql, suite db)
- Major [tour:desktop/detail__default/1] new: listbox "Status" 200×240 cut off by div.card — files: src/detail/StatusSelect.tsx
- Major [chk:desktop/detail__default/1] contrast: span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1 — files: src/detail/Detail.css
- Major [con:desktop/detail__default/1] console: TypeError: x is undefined — files: src/detail/Detail.tsx
- Minor [scr:desktop/detail__default] the Archive button sits under the fold on a short window

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 2 standing item(s), never gating — qa/standing.md

## Notes
- lived-in: not run in this step

cost: plan $0.41 · eyes $0.62 · judge $0.18 · runner 0 · total $1.21
`;

const check6 = (over = {}) => validateVerdict({ verdictMd: JUDGE6, results: buildResults(exampleRun6()), eyesMd: EYES, charterMd: CHARTER_ONE, ...over });

test('step 6: a verdict citing the route, mutant and criteria rows of the example is valid, with the met: row dropped (no R5)', () => {
  assert.deepEqual(check6(), []);
});

test('step 6: a met: judge row kept as a Note finding is valid', () => {
  const md = swap(JUDGE6, '- Minor [scr:desktop/detail__default]',
    '- Note [met:desktop/detail__default/screen.readyMs] screen.readyMs 1800 ms over 1000 ms (base 900 ms)\n- Minor [scr:desktop/detail__default]');
  assert.deepEqual(check6({ verdictMd: md }), []);
});

test('step 6: an rte: or mut: id the run does not have is an R4 problem, and the known ones are not', () => {
  assert.deepEqual(check6(), [], 'the known rte: and mut: ids pass R4');
  const badRoute = check6({ verdictMd: swap(JUDGE6, '- Major [rte:2]', '- Major [rte:9]') });
  assert.ok(badRoute.some((p) => p.rule === 'R4' && p.message.includes('rte:9')), `R4 names rte:9: ${JSON.stringify(badRoute)}`);
  const badMutant = check6({ verdictMd: swap(JUDGE6, '- Major [mut:rls-check-dropped]', '- Major [mut:nope]') });
  assert.ok(badMutant.some((p) => p.rule === 'R4' && p.message.includes('mut:nope')), `R4 names mut:nope: ${JSON.stringify(badMutant)}`);
});

test('step 6: gap:routes and gap:route-actors are known gap ids, and each must be a Gaps row', () => {
  const run = exampleRun6();
  run.routes = { ...run.routes, notRun: 'route table has errors', notRunProbes: 2 };
  const results = buildResults(run);
  const md = swap(JUDGE6, '## Gaps\n- none\n',
    '## Gaps\n- [gap:routes] route sweep not run: route table has errors\n- [gap:route-actors] 2 probe(s) not run: see results.json\n');
  assert.deepEqual(validateVerdict({ verdictMd: md, results, eyesMd: EYES, charterMd: CHARTER_ONE }), []);
  const without = swap(md, '- [gap:routes] route sweep not run: route table has errors\n', '');
  const problems = validateVerdict({ verdictMd: without, results, eyesMd: EYES, charterMd: CHARTER_ONE });
  assert.ok(problems.some((p) => p.rule === 'R10' && p.message.includes('gap:routes')), `R10 names gap:routes: ${JSON.stringify(problems)}`);
});

// STEP 7 (videos: the Journeys section) -----------------------------------------------------------

const JOURNEY_SRC = 'videos/desktop/candidate-detail.webm';

// One recorded journey: the detail screen's video with two checkpoints (the first one changed).
function journey(over = {}) {
  return {
    id: 'vid:desktop/candidate-detail', viewport: 'desktop', screen: 'candidate-detail', src: JOURNEY_SRC,
    checkpoints: [
      { state: 'detail', atMs: 4210, status: 'changed' },
      { state: 'list', atMs: 12300, status: 'not captured' },
    ],
    ...over,
  };
}

// The checkpoint statuses are the results.screens statuses of scr:<vp>/<screen>__<state>; the run
// has the first one, so the second reads 'not captured'.
function journeyResults() {
  const results = fresh();
  results.screens.push({
    id: 'scr:desktop/candidate-detail__detail', viewport: 'desktop', key: 'candidate-detail__detail', screen: 'candidate-detail',
    status: 'changed', tree: null, elements: { changed: 0, drift: 0 }, pixel: null, eyes: false,
  });
  return results;
}

const withJourneys = (videos, over = {}) => reportHtml({ verdictMd: JUDGE, summaryMd: SUMMARY, results: journeyResults(), eyes: [], shots: {}, videos, ...over });

test('step 7: a video adds a Journeys section with one <video controls preload="metadata" src> per video', () => {
  const h = withJourneys([journey(), journey({ id: 'vid:desktop/jobs-list', screen: 'jobs-list', src: 'videos/desktop/jobs-list.webm' })]);
  assert.match(h, /<h2[^>]*>Journeys<\/h2>/);
  assert.equal((h.match(/<video\b/g) ?? []).length, 2);
  assert.ok(h.includes(`<video controls preload="metadata" src="${JOURNEY_SRC}"`), 'the candidate-detail video tag');
  assert.ok(h.includes('<video controls preload="metadata" src="videos/desktop/jobs-list.webm"'), 'the jobs-list video tag');
});

test('step 7: each checkpoint is a button reading "state · status · s", one per checkpoint', () => {
  const h = withJourneys([journey()]);
  assert.match(h, /<button[^>]*>detail · changed · 4\.2 s<\/button>/);
  assert.match(h, /<button[^>]*>list · not captured · 12\.3 s<\/button>/);
  assert.equal((h.match(/<button\b/g) ?? []).length, 2);
});

test('step 7: the Journeys section carries an inline script that seeks the video to atMs / 1000, and no external URL', () => {
  const h = withJourneys([journey()]);
  assert.match(h, /<script[^>]*>[\s\S]*currentTime\s*=[^;]*1000[\s\S]*<\/script>/);
  assert.ok(!/https?:\/\//i.test(h));
});

test('step 7: a screen name with < is escaped in the Journeys section', () => {
  const h = withJourneys([journey({ screen: 'deal<b>x' })]);
  assert.ok(!h.includes('deal<b>x'), 'the raw screen name is not in the page');
  assert.ok(h.includes('deal&lt;b&gt;x'), 'the escaped screen name is in the page');
});

test('step 7: the Journeys section comes after the verdict heading', () => {
  const h = withJourneys([journey()]);
  assert.ok(h.indexOf('Journeys') > h.indexOf('<h1>'), 'Journeys follows the verdict h1');
});

test('step 7: no videos or videos [] gives no Journeys section and no video, and one video gives one', () => {
  for (const h of [html(), html({ videos: [] })]) {
    assert.ok(!h.includes('Journeys'), 'no Journeys section');
    assert.ok(!h.includes('<video'), 'no video');
  }
  assert.ok(withJourneys([journey()]).includes('Journeys'), 'one video gives the Journeys section');
});

// unmapped ---------------------------------------------------------------------------------------

const UNM_ROW = '- Major [unm:1] unmapped: src/features/jobs/JobAdComposePage.tsx — no map entry walks it';
const withUnm = () => buildResults({ ...exampleRun6(), affected: { mode: 'affected', names: ['a'], why: { a: 'new entry' }, total: 1, unknown: 0, skipped: 0, unmapped: ['src/features/jobs/JobAdComposePage.tsx'] } });
const checkUnm = (verdictMd) => validateVerdict({ verdictMd, results: withUnm(), eyesMd: EYES, charterMd: CHARTER_ONE });

test('unmapped: an unm: id the run has is known to the judge, so a Findings row citing it is valid', () => {
  const md = swap(JUDGE6, '- Major [rte:unlisted/1]', `${UNM_ROW}\n- Major [rte:unlisted/1]`);
  assert.deepEqual(checkUnm(md), []);
});

test('unmapped: an unm: id the run does not have is an R4 problem', () => {
  const md = swap(JUDGE6, '- Major [rte:unlisted/1]', `${UNM_ROW.replace('unm:1', 'unm:7')}\n- Major [rte:unlisted/1]`);
  const problems = checkUnm(md);
  assert.ok(problems.some((p) => p.rule === 'R4' && p.message.includes('unm:7')), `R4 names unm:7: ${JSON.stringify(problems)}`);
});
