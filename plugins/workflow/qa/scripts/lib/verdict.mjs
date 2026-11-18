// The verdict draft (decision 17): results.json -> the skeleton the judge completes. Pure: no
// files, no model. Everything a fixed table can decide is decided here; what needs the spec
// (UNEXPECTED changes), a look (eyes) or the charter is left to the judge, listed, never guessed.
//
// CONTRACT (tests: test/verdict.test.mjs — fixtures are Results objects, see summary.mjs)
//
//   SEVERITY (exported, frozen) — the fixed table, by finding source:
//     head-failure     a head screen failed (not MAP ERROR) and onBase is false   -> 'Blocker'
//     tour             a NEW tour problem (clipped, covered or stuck)            -> 'Major'
//     console          a NEW console line                                        -> 'Major'
//     check:contrast | check:keyboard | check:focus | check:covered | check:clipped -> 'Major'
//     check:target | check:overlap                                               -> 'Minor'
//     check:<other>                                                              -> 'Minor'
//     unexpected       an UNEXPECTED tree or element change                      -> 'judge'
//     eyes             a screen in results.eyes                                  -> 'eyes'
//   Not findings (they go to Gaps or Standing): MAP ERROR, NOT RUN and failures with onBase true
//   (Gaps: unverifiable), a blocked sandbox (Gaps), standing counts (Standing).
//
//   draftVerdict(results) -> { verdict, criteria: { pass, fail, unverifiable }, findings, gaps, md }
//     criteria: one per expectation: result 'met' -> pass; 'NOT MET' -> fail; anything else
//       ('not observed', 'already true before') -> unverifiable.
//     findings: [{ id, severity, text }] in this order: Blocker, Major, Minor, (0.6.0) Note, judge, eyes; within
//       a severity, results order. text = the summary line's text after its id.
//     gaps: [{ id, text }] — MAP ERROR / failed-on-base-too screens (id = the failure's fail:… id),
//       NOT RUN screens (nrun:… id), the blocked sandbox (fail:sandbox/<side>), and 'no expectations: criteria come from the charter' (id 'gap:criteria') when
//       results.expectations is empty.
//     verdict: since 1.0.0 the FOUR OUTCOMES gate below (decide); until 0.6.0 it was, first that applies:
//       'REJECT'  results.blocked, or any Blocker or Major, or any criterion fail or unverifiable;
//       'PENDING' any judge or eyes finding, or results.expectations is empty;
//       'ACCEPT'  otherwise.
//     md (decision 17's layout; PENDING exists only in a draft, the judge's verdict.md says
//       ACCEPT, REJECT, NEEDS YOU or BLOCKED):
//       # <verdict> — <slug>
//       head: <full sha>
//       base: <full sha | 'none'>
//       maps: <head map hash, 12>
//       criteria: <p> pass · <f> fail · <u> unverifiable
//       draft: qa verdict draft — the judge resolves judge and eyes rows, then writes verdict.md
//       (blank line)
//       ## Criteria        '- [<exp id>] PASS|FAIL|UNVERIFIABLE — <name>: <detail>' or '- none'
//       ## Expectations    '- [<unx id>] UNEXPECTED …' per results.unexpected (summary.md's text) or '- none'
//       ## Findings        '- <severity> [<id>] <text>' or '- none'
//       ## Spec cases      '- none (the runner ran data only)'
//       ## Gaps            '- [<id>] <text>' or '- none'
//       ## Standing        '- <total> standing item(s), never gating[ — <file>]'
//       ## Notes           '- routes, mutants, metrics and lived-in: not run in this step'
//       (blank line)
//       cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0
//     Sections are separated by one blank line; a '## ' heading is followed directly by its items
//     (no blank line between); the cost line is the last line.
//     Self-mode results -> Error('a self-test has no verdict').
//
//   STEP 5 (tests: test/verdict.test.mjs, the 'step 5' tests)
//
//   parseSecurity(text) -> [{ id, level, text }]
//     qa/<slug>/security.md (decision 20; the qa skill session writes it from the
//     native /security-review): every line matching /^- (High|Medium|Low) \[(sec:\d+)\] (.+)$/,
//     in file order; other lines ignored. null or '' -> [].
//
//   draftVerdict(results, { security = [] } = {}) — the second argument is new. Each security entry
//     is a finding { id, severity, text } with severity High -> 'Blocker', Medium -> 'Major',
//     Low -> 'Minor' (SEVERITY gains 'security:High', 'security:Medium', 'security:Low'), placed
//     within its severity after the findings from results. With no entries the result is exactly
//     as before (every step-4 test still passes).
//
//   verdict.md, the judge's (decision 17): the draft's layout with these differences
//     line 1 '# ACCEPT|REJECT|NEEDS YOU|BLOCKED — <slug>' (1.0.0; never PENDING); no 'draft: ' line;
//     ## Criteria      one row per expectation and per charter row the judge ruled on:
//                      '- [<exp:… | ch:…>] PASS|FAIL|UNVERIFIABLE — <name>: <detail>'
//     ## Expectations  one row per UNEXPECTED id: '- [<unx id>] explained — <why, from the spec>' or
//                      '- [<unx id>] finding — <one line>' (and a Findings row with that id)
//     ## Findings      '- <Blocker|Major|Minor|Note> [<id>] <text>[ — files: <path>, <path>]'; the
//                      draft's Blocker/Major/Minor rows kept; its judge/eyes rows replaced by a real
//                      severity or dropped; 'files:' names what a fix may touch
//     ## Spec cases    '- <path>: <why it cannot be data>' or '- none (…)'
//     cost line        'cost: plan $<n> · eyes $<n> · judge $<n> · runner 0 · total $<n>'
//
//   parseVerdict(md) -> Verdict   (a draft or the judge's verdict.md; never throws)
//     { verdict   first line's word after '# ' when ACCEPT|REJECT|NEEDS YOU|BLOCKED|PENDING, else null
//       slug      first line's text after ' — ', else null
//       head, base, maps   the values of the header lines 'head: ', 'base: ', 'maps: ' (null when absent)
//       criteriaLine  { pass, fail, unverifiable, blocked, waived } from the criteria line (1.0.0's five counts, or
//                     0.6.0's three with blocked and waived 0), else null
//       draft     true when a header line starts 'draft: '
//       sections  every '## ' heading's text, in file order
//       cost      the last non-empty line when it starts 'cost: ', else null (rework U9: a 'Report: …' line after it is
//                 skipped first, so the cost line is the one above it)
//       report    (rework U9) parseReportLine of the last non-empty line when it starts 'Report: ', else null
//       criteria      [{ id, status, name, detail }]   Criteria rows '- [<id>] <STATUS> — <name>: <detail>' (STATUS one of STATUSES)
//       expectations  [{ id, resolution, text }]       Expectations rows '- [<id>] <resolution> — <text>' with
//                                                      resolution explained|finding, or '- [<id>] UNEXPECTED <text>'
//                                                      (resolution 'UNEXPECTED', text = the rest after 'UNEXPECTED ')
//       findings  [{ severity, id, text, files }]      Findings rows '- <severity> [<id>] <text>'; a text ending
//                                                      ' — files: a, b' is cut there and files = ['a', 'b'], else []
//       specCases [{ path, reason }]                   Spec cases rows '- <path>: <reason>'
//       gaps      [{ id, text }]                       Gaps rows '- [<id>] <text>'
//       standing  the Standing section's first item text (after '- '), else null
//       errors    [line]  item lines ('- …') in Criteria, Expectations, Findings, Spec cases or Gaps
//                         that match none of the forms above; '- none' and '- none (…)' are never rows
//                         and never errors }
//     Item lines are the lines starting '- ' between a '## ' heading and the next heading or the cost line.

//   STEP 6 (tests: test/verdict.test.mjs 'step 6') — the fixed table gains, in SEVERITY:
//     'route:blocker'    a routes.new entry whose problem starts with a 5xx status ('5xx answered'),
//                        is 'stack trace in the answer', or is 'answered <status> to <kind> (…)'
//                        with kind signed-out, no-right, other-id, origin-foreign or origin-null
//                        (someone reached what they must not)                         -> 'Blocker'
//     'route'            any other routes.new entry                                    -> 'Major'
//     'route:unlisted'   a routes.unlisted entry (a route nobody listed got no check)  -> 'Major'
//     'route:stale'      a routes.stale entry                                          -> 'Minor'
//     'mutant:survived'  a mutants.survived entry (a guard no test holds)              -> 'Major'
//     'mutant:stale'     a mutants.stale entry                                         -> 'Minor'
//     'metric'           a metrics.flags entry                                         -> 'judge'
//   Finding order within a severity: results' (failures, tour, checks, console, unexpected) then
//   routes (new, unlisted, stale), mutants (survived, stale), metrics flags, then security. Text =
//   summary.mjs routeText / mutantText / metricText.
//   Gaps gain: '- [gap:routes] route sweep not run: <notRun>' when routes.notRun is set and is not
//     'no route table'; '- [gap:route-actors] <n> probe(s) not run: <first probe notRun reason>'
//     when routes.notRunProbes > 0 (the reason is not in results: use 'see results.json');
//     '- [<mut id>] not judged: <detail>' per mutants.notJudged entry; (step 6 pilot) '- [gap:route-table]
//     route table: <n> error(s), first: <e>' when routes.errors is non-empty and '- [gap:mutants]
//     mutant registry: <n> error(s), first: <e>' when mutants.errors is non-empty. These make no criterion
//     unverifiable and do not change the verdict by themselves.
//   Notes: the line '- routes, mutants, metrics and lived-in: not run in this step' becomes
//     '- lived-in: not run in this step', followed by '- routes: no route table' when routes is null
//     or its notRun is 'no route table', and '- mutants: not run' when mutants is null.
//   A metric flag is a 'judge' row, so the draft is PENDING while any exists (unless REJECT applies).

//   NEW ON HEAD (tests: test/new-on-head.test.mjs): when any results.screens entry has
//     status 'new' and a newOnHead reason, Notes starts with '- new on head: <n> screen(s) have no
//     before picture (<distinct reasons, first-seen order, ', '>); their checks, tour, console,
//     metrics and expectations are judged on head alone'. Their eyes rows read 'new on head
//     (<reason>) → eyes' (screenText). A base failure is never a gap or a finding (as before).

//   UNMAPPED (tests: test/verdict.test.mjs 'unmapped'): SEVERITY gains 'unmapped' -> 'Major'
//     (decision 6: a screen the diff touches with no map entry). One finding per results.unmapped
//     entry, text unmappedText(u), placed with the Majors after the route rows.

//   TESTS (0.4.0; tests: test/tests.test.mjs 'draft'): a test expectation is a Criteria row like any other
//     (met PASS, NOT MET FAIL, unverifiable UNVERIFIABLE). When results.tests is non-empty, Notes gains, after
//     the lived-in line: '- tests: <n> named test(s) run by qa itself on the head sandbox: <m> met · <f> NOT
//     MET · <u> unverifiable; the command, counts and output are under each in summary.md'.

//   CORROBORATION (0.6.0; tests: test/noise.test.mjs). A page check measures a page; it can misread one (an
//   SVG chart under its own label, a ring drawn where the script does not look). So a page-check row the table makes
//   Blocker or Major — a results.checks.new entry, or a results.tour.new entry of kind clipped or covered — keeps
//   that severity only when something else says the same:
//     eyes        draftVerdict's `eyes` option (eyes.mjs parseEyes rows) rules its screen scr:<vp>/<key> 'wrong'; or
//     regression  it is new on head against a base capture of the same screen: the results.screens entry for
//                 scr:<vp>/<key> has a status other than 'new' (no entry counts as captured on base), and a
//                 checks.new / tour.new row is by definition absent from that base capture.
//   Otherwise (a screen only head has: nothing to compare the measurement with, and no person agreed) it is a Minor
//   whose text ends ' — uncorroborated page check: no base screen to compare (new on head)'. Minor never gates.
//   No check class and no finding is treated differently from another: the rule reads only eyes, base and tests.
//   Before both: a page-check row of any severity that a MET test expectation clears (tests.mjs CLEARS:
//   results.tests[].clears, clearsFinding) is a Note whose text ends ' — cleared by test <name> (met)'.
//   Notes never gate; the finding order is Blocker, Major, Minor, Note, judge, eyes. When any row was made Minor or
//   Note this way, Notes gains, after the tests line: '- page checks: <u> uncorroborated (Minor), <c> cleared by a
//   met test (Note); a page check gates only when eyes rules its screen wrong or it is new on a screen the base
//   walked too, and a met test that clears it makes it a Note'. With no eyes rows, no clears and every page-check
//   row on a screen the base has, the draft is exactly as before.
//   draftVerdict(results, { security = [], eyes = null } = {}) — `qa verdict draft` passes V/eyes.md when it
//   exists, and report.mjs validateVerdict passes the eyes.md it validates against, so R5 holds the judge to the
//   same table.

//   FOUR OUTCOMES (1.0.0; design 2026-11-12 §4 and §10; tests: test/outcomes.test.mjs). Only the spec's criteria and a
//   short Blocker list decide; a tool failure is its own outcome; nothing else gates.
//     OUTCOMES = ['ACCEPT', 'REJECT', 'NEEDS YOU', 'BLOCKED']; a draft may also say PENDING (rows the judge still rules).
//     A Criteria row's status is PASS | FAIL | UNVERIFIABLE | BLOCKED | WAIVED, and the criteria line counts all five:
//       'criteria: <p> pass · <f> fail · <u> unverifiable · <b> blocked · <w> waived' (parseVerdict also reads 0.6.0's
//       three-count line, blocked and waived 0). countRows(rows) -> those counts; criteriaLine(counts) -> that line.
//     parseCharter(md) -> [{ id, text, advisory, manual, ask, expectations }], one per '- [ch:<n>] …' line.
//       advisory  the line ends ' — advisory': a row the planner added beyond the spec; checked, reported, never gates.
//       manual    it says ' — by: manual': nothing the sandbox can observe proves it; ask = the text after ' — ask: '.
//       text      the case, up to its first ' — '.   expectations: the names after 'by: expectation(s) '.
//     parseWaivers(md) -> [{ id, reason, who, date }] from '- [<row id>] waived: <reason> (<who>, <YYYY-MM-DD>)' lines
//       (others ignored); waiverMap(list) -> Map id -> the last waiver for it; waiverText(w) -> 'waived: <reason> (<who>, <date>)'.
//     evidence(e, results) -> { status, note }: an expectation row by the fixed table. met PASS. NOT MET FAIL, except
//       BLOCKED when it observed 0 elements (e.observed === 0, compare.mjs). not observed BLOCKED (0 elements). already
//       true before UNVERIFIABLE. error BLOCKED (an exception while judging it; the detail holds the line). unverifiable:
//       a named test that matched and was skipped is UNVERIFIABLE (the product skips it); any other test record (not
//       run, matched nothing, timed out, a suite that cannot be filtered) and every doc record (not run, a path in
//       neither commit) is BLOCKED: the tool or the plan, never the product. Anything else UNVERIFIABLE.
//     decide({ rows, charter, waivers, findings, gates, blocked, runBlocked, pending }) -> { outcome, fail, blockers,
//       blocked, open, waived } (id lists). Rows that decide: with a charter (one with rows), its rows that are not
//       advisory (expectation rows are their evidence); with none, every row. A waived id (or a WAIVED row) never
//       gates. A manual row is open unless waived, whatever status it carries. Outcome, the first that applies:
//         BLOCKED    runBlocked (no sandbox came up: nothing was checked);
//         REJECT     a deciding row FAIL, or a finding that gates: a Blocker, or a fixed-table row whose id is in gates;
//         PENDING    pending is non-empty (a draft only);
//         BLOCKED    a deciding row BLOCKED, or a blocked item (a tool failure the fixed table found);
//         NEEDS YOU  a deciding row UNVERIFIABLE, or an open manual row;
//         ACCEPT     otherwise.
//     draftVerdict(results, { security, eyes, charterMd = null, waiversMd = null, final = false }) — the draft now:
//       Criteria rows: each expectation with its evidence() status ('; <note>' after the detail when there is one), or
//         WAIVED with 'waived: … — was <STATUS>: <detail>' when waived; then one row per manual charter row
//         ('UNVERIFIABLE — <text>: manual — ask: <ask>', or WAIVED); when results.blocked, one BLOCKED row per other
//         charter row ('not checked: <the block>'). A row for an advisory charter row ends ' — advisory'.
//       Head failures (not MAP ERROR, not failed on base too): with a serverError (the head answered 5xx or showed an
//         error page) a Blocker '<failure text> — the app answered: <serverError>'; else a blocked item, never a
//         finding: '<failure text>[ (timed out, retried once)][; base walked it]'. The blocked sandbox, a compare that
//         failed (results.compareError -> 'fail:compare') and a screen compare could not read (screen.error) are
//         blocked items too. Each blocked item is a Gaps row '- [<id>] BLOCKED — <text>' and is in the result's blocked.
//       Page checks (CORROBORATION kept): a regression now needs its element on the base screen too: a row whose
//         onBase is false (compare.mjs: its element's name is not on the base screen's tree, or it has none) is new
//         content, judged like a screen new on head: a Minor ending ' — uncorroborated page check: the element is new
//         on head (not on the base screen)', unless eyes rules its screen wrong. (No onBase, as in results before
//         1.0.0: the screen-level rule as before.) A corroborated row on a CHANGED screen — status changed or drift,
//         or a pixel change; never 'new' — keeps its Major and gates, its text ending ' — gates: corroborated on a
//         changed screen'; its id is in the result's gates. The gate is screen-level: whether the diff changed the
//         element itself is not in results (the tree diff there is cut to the unexplained lines, and a style change
//         never shows in the tree), so an element the PR meant to change would read as unchanged. Every other Major (corroborated on a new or unchanged screen, console, tour stuck, routes beyond
//         the Blocker ones, unlisted, unmapped, survived mutants, security Medium) is reported and never gates.
//       verdict = decide(...).outcome, PENDING also when a judge or eyes row is left, when there is no charter and no
//         expectation, or when a deciding charter row has no expectation to derive it from (the judge rules it).
//         With a charter, a deciding row's draft status is derived from the expectations it cites (and test and doc
//         records naming it as their criterion): any FAIL -> FAIL; all PASS or WAIVED -> PASS; any BLOCKED -> BLOCKED;
//         else UNVERIFIABLE.
//       Notes gain, when there is something to say: '- advisory: <n> charter row(s) beyond the spec (<ids>); checked
//         and reported, never gating'; '- blocked: <n> item(s) the tool could not check (Gaps BLOCKED rows); they never
//         fail the PR: check again later, or merge on the user's word'; '- waived [<id>]: <reason> (<who>, <date>);
//         never gating' per waiver of an id that is not a Criteria row.
//       final: no 'draft:' line (run.mjs writes the BLOCKED verdict of a run whose sandbox never came up this way).
//       Returns { verdict, criteria: counts, rows, findings, gaps, blocked, gates, md }.
//     verdictOutcome({ verdictMd, results, security, eyes, charterMd, waiversMd }) -> decide(...) over the judge's
//       verdict: its Criteria rows and Findings, the fixed table's gates and blocked items, results.blocked.
//     applyWaivers({ verdictMd, results, security, eyes, charterMd, waiversMd }) -> { md, applied }
//       The waivers that arrived after the verdict, applied by script (no run, no judge): a Criteria row with a waiver
//       that is not PASS or WAIVED becomes 'WAIVED — <name>: waived: … — was <STATUS>: <detail>'; a manual charter row
//       with a waiver and no Criteria row gets one; a waived id cited only in Findings or Gaps gets its Notes line; the
//       criteria line is recounted and line 1 set to verdictOutcome of the result. applied = the ids changed.

//   U7 STANDING AND SHARED CHROME (rework, design 2026-11-12 §8; tests: test/fingerprint.test.mjs). summary.mjs marks
//   a new page-check or tour finding with standing (a qa/standing.md row stands for it: its fingerprint, or its one
//   screen's id) or chrome (its fingerprint is on 2 or more walked screens of this run, and the PR regressed none of
//   them). Before every other rule, such a finding — a page check, or a tour problem of any kind — is a Note that never
//   gates: text '<text> — standing <row id>: in qa/standing.md, never gating', or '<text> — shared chrome <chrome id>:
//   on <n> screens, never gating' (n = that chrome entry's screens). Notes gains, when any:
//   '- standing and shared chrome: <s> finding(s) match qa/standing.md, <c> sit on 2 or more screens (shared chrome);
//   Notes, never gating; the candidates are under Standing'. The Standing section gains, after its count line, one
//   '- [<chrome id>] <fingerprint text>: <n> screens — add to standing?' per results.chrome entry. The judge reads all
//   this from summary.md and the draft; it never reads qa/standing.md.

//   EYES WAIVER (rework U7 follow-up; tests: test/eyes-waiver.test.mjs). An eyes ruling is dismissed by a waiver of its
//   screen's id (scr:<vp>/<key>), like any other row: the judge's row for it stops gating (decide), and the ruling no
//   longer corroborates the page checks on that screen — pageRule reads only the eyes rows whose id is not waived, so a
//   page check there is judged as if eyes had not ruled (a regression of an element the base had still gates on its
//   own). applyWaivers then brings each Findings row of the fixed table whose severity the waivers changed to the
//   table's severity and text (its ' — files: …' tail kept), so the result holds R5; those ids are in applied too.

//   ROUNDS (rework U8, design 2026-11-12 §9; tests: test/rounds.test.mjs 'the round cap'). results.round (run.mjs ROUNDS,
//   rounds.mjs carryInto) is this round: { n, of, why, from, screens, rerun, carried, history, security, criteria }.
//     ROUND_CAP = 3. decide({ …, history = {} }): history is { row id: the earlier rounds (same spec) it FAILed in }. A
//       deciding FAIL row, not waived, whose history is ROUND_CAP - 1 or more is CAPPED: it is in the result's capped and
//       open (never fail), so it gives NEEDS YOU, not REJECT: no automatic round after the third; the user decides (fix
//       differently, change the spec, or waive; a waiver or a spec change clears it). Other FAIL rows still REJECT.
//     draftVerdict: history = results.round.history; when any row is capped, Gaps starts with
//       '- [gap:cap] Round cap: <ids, ', '> rejected 3 times — the user decides (fix differently, change the spec, or
//       waive)' (a gap the judge must keep, R10). Carried charter rows (results.round.criteria: [{ id, status, name,
//       detail }], their detail ending ' — carried from <sha12> (round <n>)') are Criteria rows of the draft, verbatim,
//       after the expectation rows: counted, deciding, never derived again and never BLOCKED by a blocked run. A carried
//       expectation is a results.expectations entry like any other (its detail says carried from). Notes gain, when
//       results.round has n: '- round <n>: full — <why>', or '- round <n>: incremental from round <m> (<sha12>): <r> row(s)
//       re-run, <c> carried (each says carried from <sha>); <w> screen(s) walked'; and with security.rerun false and a
//       from: '- security: carried from round <k> (<sha12>): <why>'.
//     verdictOutcome reads the same history; applyWaivers rewrites the gap:cap row to the ids still capped, or removes it
//       ('- none' when Gaps is left empty).

import { checkText, consoleText, failureText, metricText, mutantText, notRunText, routeText, screenText, tourText, unexpectedText, unmappedText } from './summary.mjs';
import { clearsFinding } from './tests.mjs';

export const SEVERITY = Object.freeze({
  'head-failure': 'Blocker',
  tour: 'Major',
  console: 'Major',
  'check:contrast': 'Major',
  'check:keyboard': 'Major',
  'check:focus': 'Major',
  'check:covered': 'Major',
  'check:clipped': 'Major',
  'check:target': 'Minor',
  'check:overlap': 'Minor',
  unexpected: 'judge',
  eyes: 'eyes',
  'route:blocker': 'Blocker',
  route: 'Major',
  'route:unlisted': 'Major',
  'route:stale': 'Minor',
  unmapped: 'Major',
  'mutant:survived': 'Major',
  'mutant:stale': 'Minor',
  metric: 'judge',
  'security:High': 'Blocker',
  'security:Medium': 'Major',
  'security:Low': 'Minor',
});

export const OUTCOMES = Object.freeze(['ACCEPT', 'REJECT', 'NEEDS YOU', 'BLOCKED']);
// A criterion REJECTed in this many rounds stops the loop: the outcome is NEEDS YOU and the user decides (U8).
export const ROUND_CAP = 3;
export const capText = (ids) => `Round cap: ${ids.join(', ')} rejected ${ROUND_CAP} times — the user decides (fix differently, change the spec, or waive)`;
// The ids a gap:cap row's text names (capText read back); [] for any other text.
export const capIds = (text) => /^Round cap: (.+?) rejected \d+ times\b/.exec(String(text ?? ''))?.[1].split(', ').filter(Boolean) ?? [];
export const STATUSES = Object.freeze(['PASS', 'FAIL', 'UNVERIFIABLE', 'BLOCKED', 'WAIVED']);

const RANK = ['Blocker', 'Major', 'Minor', 'Note', 'judge', 'eyes'];
const GATES = ['Blocker', 'Major'];
const TOUR_PAGE = ['clipped', 'covered'];
const COUNT_KEY = { PASS: 'pass', FAIL: 'fail', UNVERIFIABLE: 'unverifiable', BLOCKED: 'blocked', WAIVED: 'waived' };
const ZERO_SEEN = 'it observed 0 elements, so the tool could not check it';
const checkSeverity = (name) => (Object.hasOwn(SEVERITY, `check:${name}`) ? SEVERITY[`check:${name}`] : 'Minor');
// A route problem that is a Blocker: a 5xx, a stack trace, or someone reaching what they must not.
const BLOCKER_PROBLEM = /^(?:5\d\d\b|stack trace in the answer$|answered \d+ to (?:signed-out|no-right|other-id|origin-foreign|origin-null) \()/;
const short = (hash) => (hash ? String(hash).slice(0, 12) : 'none');
const firstLine = (s) => String(s ?? '').split('\n')[0];

export function countRows(rows) {
  const n = { pass: 0, fail: 0, unverifiable: 0, blocked: 0, waived: 0 };
  for (const r of rows ?? []) if (COUNT_KEY[r.status]) n[COUNT_KEY[r.status]] += 1;
  return n;
}
export const criteriaLine = (n) => `criteria: ${n.pass} pass · ${n.fail} fail · ${n.unverifiable} unverifiable · ${n.blocked ?? 0} blocked · ${n.waived ?? 0} waived`;

// ── charter and waivers ──────────────────────────────────────────────────────

export function parseCharter(md) {
  const rows = [];
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const m = line.match(/^- \[(ch:\d+)\] (.*)$/);
    if (!m) continue;
    const body = m[2].trimEnd();
    const advisory = / — advisory$/.test(body);
    const core = advisory ? body.slice(0, -' — advisory'.length) : body;
    const manual = / — by: manual\b/.test(core);
    const ask = manual ? (core.match(/ — ask: (.+)$/)?.[1]?.trim() ?? null) : null;
    const by = core.match(/ — by: (.*?)(?= — |$)/)?.[1] ?? '';
    const expectations = [];
    for (const hit of by.matchAll(/\bexpectations?\s+([^;]+)/g)) {
      for (const name of hit[1].split(/\s*(?:,|\+|\band\b)\s*/)) {
        const n = name.replace(/^expectations?\s+/, '').trim();
        if (/^[A-Za-z0-9._-]+$/.test(n)) expectations.push(n);
      }
    }
    rows.push({ id: m[1], text: core.split(' — ')[0].trim(), advisory, manual, ask, expectations });
  }
  return rows;
}

const WAIVER = /^- \[([^\]]+)\] waived: (.+) \(([^()]+), (\d{4}-\d{2}-\d{2})\)\s*$/;
export function parseWaivers(md) {
  const out = [];
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const m = line.match(WAIVER);
    if (m) out.push({ id: m[1], reason: m[2].trim(), who: m[3].trim(), date: m[4] });
  }
  return out;
}
export function waiverMap(list) {
  const map = new Map();
  for (const w of list ?? []) map.set(w.id, w);
  return map;
}
export const waiverText = (w) => `waived: ${w.reason} (${w.who}, ${w.date})`;

// ── evidence and the gate ────────────────────────────────────────────────────

export function evidence(e, results = {}) {
  const named = (list) => (e.viewport == null ? (list ?? []).find((t) => t?.name === e.name) ?? null : null);
  switch (e.result) {
    case 'met': return { status: 'PASS', note: '' };
    case 'NOT MET': return e.observed === 0 ? { status: 'BLOCKED', note: ZERO_SEEN } : { status: 'FAIL', note: '' };
    case 'not observed': return { status: 'BLOCKED', note: ZERO_SEEN };
    case 'already true before': return { status: 'UNVERIFIABLE', note: 'the base already showed it; would prove it: a look at head, or your word that it holds' };
    case 'error': return { status: 'BLOCKED', note: 'the tool failed while judging it' };
    case 'unverifiable': {
      const t = named(results.tests);
      if (t) {
        const skipped = (t.counts?.matched ?? 0) > 0 && (t.counts?.skipped ?? 0) > 0 && !t.timedOut && !t.toolError;
        return skipped ? { status: 'UNVERIFIABLE', note: 'would prove it: the test running unskipped' } : { status: 'BLOCKED', note: 'the test did not run as named' };
      }
      if (named(results.docs)) return { status: 'BLOCKED', note: 'the doc could not be checked as named' };
      return { status: 'UNVERIFIABLE', note: '' };
    }
    default: return { status: 'UNVERIFIABLE', note: '' };
  }
}

export function decide({ rows = [], charter = null, waivers = new Map(), findings = [], gates = new Set(), blocked = [], runBlocked = false, pending = [], history = {} } = {}) {
  const meta = new Map((charter ?? []).map((c) => [c.id, c]));
  const byCharter = meta.size > 0;
  const decides = (id) => (byCharter ? (/^ch:\d+$/.test(id) && !meta.get(id)?.advisory) || id.startsWith('suite:') : true);
  const out = { fail: [], blockers: [], blocked: [], open: [], waived: [], capped: [] };
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.id);
    if (!decides(r.id)) continue;
    if (waivers.has(r.id) || r.status === 'WAIVED') { out.waived.push(r.id); continue; }
    // The round cap: a row that FAILed in ROUND_CAP - 1 earlier rounds and fails again is the user's to decide.
    if (r.status === 'FAIL' && (Number(history?.[r.id]) || 0) >= ROUND_CAP - 1) { out.capped.push(r.id); out.open.push(r.id); continue; }
    if (r.status === 'FAIL') out.fail.push(r.id);
    else if (r.status === 'BLOCKED') out.blocked.push(r.id);
    else if (r.status === 'UNVERIFIABLE' || meta.get(r.id)?.manual) out.open.push(r.id);
  }
  for (const c of charter ?? []) {
    if (c.manual && !c.advisory && !seen.has(c.id)) (waivers.has(c.id) ? out.waived : out.open).push(c.id);
  }
  for (const f of findings) {
    if (waivers.has(f.id)) { out.waived.push(f.id); continue; }
    if (f.severity === 'Blocker' || gates.has(f.id)) out.blockers.push(f.id);
  }
  for (const b of blocked) {
    if (waivers.has(b.id)) out.waived.push(b.id);
    else out.blocked.push(b.id);
  }
  const outcome = runBlocked ? 'BLOCKED'
    : out.fail.length || out.blockers.length ? 'REJECT'
      : pending.length ? 'PENDING'
        : out.blocked.length ? 'BLOCKED'
          : out.open.length ? 'NEEDS YOU' : 'ACCEPT';
  return { outcome, ...out };
}

// The page-check rule (CORROBORATION, and since 1.0.0 the changed-screen gate): severity, text and whether it gates.
function pageRule(r, eyes, waivers = new Map()) {
  // A waived ruling (the user dismissed it) corroborates nothing.
  const wrong = new Set((eyes ?? []).filter((e) => e?.verdict === 'wrong' && !waivers.has(e.id)).map((e) => e.id));
  const screens = new Map((r.screens ?? []).map((s) => [s.id, s]));
  const clearers = (r.tests ?? []).filter((t) => t.result === 'met' && Array.isArray(t.clears) && t.clears.length);
  const chrome = new Map((r.chrome ?? []).map((c) => [c.id, c]));
  const tally = { uncorroborated: 0, cleared: 0, standing: 0, chrome: 0 };
  // pageCheck false: a tour problem that is no page measure (stuck) — only the standing and chrome rules apply.
  const rule = (f, severity, text, pageCheck = true) => {
    if (f.standing) {
      tally.standing += 1;
      return { severity: 'Note', text: `${text} — standing ${f.standing}: in qa/standing.md, never gating` };
    }
    if (f.chrome) {
      tally.chrome += 1;
      return { severity: 'Note', text: `${text} — shared chrome ${f.chrome}: on ${chrome.get(f.chrome)?.screens?.length ?? 2} screens, never gating` };
    }
    if (!pageCheck) return { severity, text };
    const by = clearers.find((t) => t.clears.some((c) => clearsFinding(c, f)));
    if (by) {
      tally.cleared += 1;
      return { severity: 'Note', text: `${text} — cleared by test ${by.name} (met)` };
    }
    if (!GATES.includes(severity)) return { severity, text };
    const id = `scr:${f.viewport}/${f.key}`;
    const screen = screens.get(id);
    if (!wrong.has(id) && screen?.status === 'new') {
      tally.uncorroborated += 1;
      return { severity: 'Minor', text: `${text} — uncorroborated page check: no base screen to compare (new on head)` };
    }
    if (!wrong.has(id) && f.onBase === false) {
      tally.uncorroborated += 1;
      return { severity: 'Minor', text: `${text} — uncorroborated page check: the element is new on head (not on the base screen)` };
    }
    const changed = Boolean(screen) && screen.status !== 'new' && (['changed', 'drift'].includes(screen.status) || screen.pixel?.changed === true);
    return changed ? { severity, text: `${text} — gates: corroborated on a changed screen`, gates: true } : { severity, text };
  };
  return { rule, tally };
}

// Which charter rows each expectation proves: 'by: expectation <name>' in the charter, and a test or doc record's criterion.
function linksOf(charter, results) {
  const links = new Map();
  const add = (name, id) => links.set(name, [...new Set([...(links.get(name) ?? []), id])]);
  for (const c of charter) for (const name of c.expectations) add(name, c.id);
  for (const t of [...(results.tests ?? []), ...(results.docs ?? [])]) {
    if (typeof t?.criterion === 'string' && /^ch:\d+$/.test(t.criterion) && t.name) add(t.name, t.criterion);
  }
  return links;
}

function derived(statuses) {
  if (!statuses.length) return null;
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.every((s) => s === 'PASS' || s === 'WAIVED')) return 'PASS';
  return statuses.includes('BLOCKED') ? 'BLOCKED' : 'UNVERIFIABLE';
}

export function draftVerdict(results, { security = [], eyes = null, charterMd = null, waiversMd = null, final = false } = {}) {
  const r = results;
  if (r.mode === 'self') throw new Error('a self-test has no verdict');
  const charter = parseCharter(charterMd);
  const meta = new Map(charter.map((c) => [c.id, c]));
  const waivers = waiverMap(parseWaivers(waiversMd));
  const page = pageRule(r, eyes, waivers);
  const advisory = (id) => (meta.get(id)?.advisory ? ' — advisory' : '');

  // Criteria: the expectations, then the manual charter rows, then (a blocked run) every other charter row.
  const rows = [];
  const lines = [];
  const row = (id, status, name, detail) => {
    rows.push({ id, status, name, detail });
    lines.push(`- [${id}] ${status} — ${name}: ${detail}`);
  };
  for (const e of r.expectations) {
    const ev = evidence(e, r);
    const detail = `${e.detail}${ev.note ? `; ${ev.note}` : ''}`;
    const w = waivers.get(e.id);
    if (w && ev.status !== 'PASS') row(e.id, 'WAIVED', e.name, `${waiverText(w)} — was ${ev.status}: ${detail}`);
    else row(e.id, ev.status, e.name, detail);
  }
  // Charter rows an earlier round ruled on evidence this round did not touch (rounds.mjs): given facts, verbatim.
  const carried = (r.round?.criteria ?? []).filter((c) => typeof c?.id === 'string' && STATUSES.includes(c.status) && !meta.get(c.id)?.manual);
  for (const c of carried) row(c.id, c.status, c.name, c.detail);
  const carriedIds = new Set(carried.map((c) => c.id));
  for (const c of charter) {
    if (!c.manual) continue;
    const ask = `manual — ask: ${c.ask ?? 'what would prove it?'}`;
    const w = waivers.get(c.id);
    if (w) row(c.id, 'WAIVED', c.text, `${waiverText(w)} — was ${ask}${advisory(c.id)}`);
    else row(c.id, 'UNVERIFIABLE', c.text, `${ask}${advisory(c.id)}`);
  }
  if (r.blocked) {
    for (const c of charter) if (!c.manual && !carriedIds.has(c.id)) row(c.id, 'BLOCKED', c.text, `not checked: ${firstLine(r.blocked)}${advisory(c.id)}`);
  }
  const criteria = countRows(rows);

  const found = [];
  const gaps = [];
  const blocked = [];
  const block = (id, text) => blocked.push({ id, text });
  for (const f of r.failures) {
    if (f.id.startsWith('fail:sandbox/')) block(f.id, `the ${f.side} sandbox did not start, so nothing was checked: ${failureText(f)}`);
    else if (f.id === 'fail:suites') block(f.id, `nothing was checked: ${firstLine(f.error)}`);
    else if (f.side !== 'head') continue;
    else if (f.mapError) gaps.push({ id: f.id, text: `MAP ERROR — ${failureText(f)}` });
    else if (f.onBase) gaps.push({ id: f.id, text: `unverifiable, failed on base too — ${failureText(f)}` });
    else if (f.serverError) found.push({ id: f.id, severity: SEVERITY['head-failure'], text: `${failureText(f)} — the app answered: ${f.serverError}` });
    else block(f.id, `${failureText(f)}${f.retried ? ' (timed out, retried once)' : f.timeout ? ' (timed out)' : ''}${f.baseWalked ? '; base walked it' : ''}`);
  }
  if (r.compareError) block('fail:compare', `compare failed, so no screen was judged: ${firstLine(r.compareError)}`);
  for (const s of r.screens ?? []) if (s.error) block(s.id, `compare could not read this screen: ${firstLine(s.error)}`);
  for (const n of r.notRun) gaps.push({ id: n.id, text: notRunText(n) });
  const routes = r.routes ?? null;
  const mutants = r.mutants ?? null;
  if (routes?.notRun && routes.notRun !== 'no route table') gaps.push({ id: 'gap:routes', text: `route sweep not run: ${routes.notRun}` });
  if (routes?.notRunProbes > 0) gaps.push({ id: 'gap:route-actors', text: `${routes.notRunProbes} probe(s) not run: see results.json` });
  if (routes?.errors?.length) gaps.push({ id: 'gap:route-table', text: `route table: ${routes.errors.length} error(s), first: ${routes.errors[0]}` });
  if (mutants?.errors?.length) gaps.push({ id: 'gap:mutants', text: `mutant registry: ${mutants.errors.length} error(s), first: ${mutants.errors[0]}` });
  for (const m of mutants?.notJudged ?? []) gaps.push({ id: m.id, text: mutantText(m, 'notJudged') });
  if (r.expectations.length === 0) gaps.push({ id: 'gap:criteria', text: 'no expectations: criteria come from the charter' });
  gaps.unshift(...blocked.map((b) => ({ id: b.id, text: `BLOCKED — ${b.text}` })));

  for (const u of r.unexpected) found.push({ id: u.id, severity: SEVERITY.unexpected, text: unexpectedText(u) });
  for (const t of r.tour.new) {
    const kind = t.kind ?? null;
    const ruled = page.rule(t, SEVERITY.tour, tourText(t), TOUR_PAGE.includes(kind));
    found.push({ id: t.id, ...ruled });
  }
  for (const c of r.checks.new) found.push({ id: c.id, ...page.rule(c, checkSeverity(c.check), checkText(c)) });
  for (const c of r.console.new) found.push({ id: c.id, severity: SEVERITY.console, text: consoleText(c) });
  for (const id of r.eyes) {
    const screen = r.screens.find((s) => s.id === id);
    found.push({ id, severity: SEVERITY.eyes, text: screen ? screenText(screen) : 'send to eyes' });
  }
  for (const x of routes?.new ?? []) {
    found.push({ id: x.id, severity: BLOCKER_PROBLEM.test(String(x.problem)) ? SEVERITY['route:blocker'] : SEVERITY.route, text: routeText(x) });
  }
  for (const x of routes?.unlisted ?? []) found.push({ id: x.id, severity: SEVERITY['route:unlisted'], text: routeText(x) });
  for (const x of routes?.stale ?? []) found.push({ id: x.id, severity: SEVERITY['route:stale'], text: routeText(x) });
  for (const x of r.unmapped ?? []) found.push({ id: x.id, severity: SEVERITY.unmapped, text: unmappedText(x) });
  for (const x of mutants?.survived ?? []) found.push({ id: x.id, severity: SEVERITY['mutant:survived'], text: mutantText(x, 'survived') });
  for (const x of mutants?.stale ?? []) found.push({ id: x.id, severity: SEVERITY['mutant:stale'], text: mutantText(x, 'stale') });
  for (const f of r.metrics?.flags ?? []) found.push({ id: f.id, severity: SEVERITY.metric, text: metricText(f) });
  for (const s of security) found.push({ id: s.id, severity: SEVERITY[`security:${s.level}`], text: s.text });
  const findings = RANK.flatMap((sev) => found.filter((f) => f.severity === sev));
  const gates = findings.filter((f) => f.gates).map((f) => f.id);

  // The outcome. With a charter its deciding rows are derived from the expectations that cite them; a row nothing
  // derives is the judge's to rule, so the draft is PENDING.
  const pending = findings.filter((f) => f.severity === 'judge' || f.severity === 'eyes').map((f) => f.id);
  let decideRows = rows;
  if (charter.length) {
    const links = linksOf(charter, r);
    decideRows = rows.filter((x) => /^ch:\d+$/.test(x.id) || x.id.startsWith('suite:'));
    const ruled = new Set(decideRows.map((x) => x.id));
    for (const c of charter) {
      if (ruled.has(c.id) || c.advisory) continue;
      const status = derived(rows.filter((x) => x.id.startsWith('exp:') && (links.get(x.name) ?? []).includes(c.id)).map((x) => x.status));
      if (status) decideRows.push({ id: c.id, status });
      else if (!r.blocked) pending.push(c.id);
    }
  } else if (r.expectations.length === 0 && !r.blocked) pending.push('gap:criteria');
  const gate = decide({ rows: decideRows, charter, waivers, findings, gates: new Set(gates), blocked, runBlocked: Boolean(r.blocked), pending, history: r.round?.history ?? {} });
  const verdict = gate.outcome;
  if (gate.capped.length) gaps.unshift({ id: 'gap:cap', text: capText(gate.capped) });

  const section = (name, items) => [`## ${name}`, ...(items.length ? items : ['- none'])];
  const total = r.standing.checks + r.standing.tour + r.standing.console;
  const md = [
    `# ${verdict} — ${r.slug}`,
    `head: ${r.head.sha}`,
    `base: ${r.base?.sha ?? 'none'}`,
    `maps: ${short(r.maps?.head)}`,
    criteriaLine(criteria),
    ...(final ? [] : ['draft: qa verdict draft — the judge resolves judge and eyes rows, then writes verdict.md']),
    '',
    ...section('Criteria', lines),
    '',
    ...section('Expectations', r.unexpected.map((u) => `- [${u.id}] ${unexpectedText(u)}`)),
    '',
    ...section('Findings', findings.map((f) => `- ${f.severity} [${f.id}] ${f.text}`)),
    '',
    '## Spec cases',
    '- none (the runner ran data only)',
    '',
    ...section('Gaps', gaps.map((g) => `- [${g.id}] ${g.text}`)),
    '',
    '## Standing',
    `- ${total} standing item(s), never gating${r.standing.file ? ` — ${r.standing.file}` : ''}`,
    ...(r.chrome ?? []).map((c) => `- [${c.id}] ${c.text}: ${c.screens.length} screens — add to standing?`),
    '',
    '## Notes',
    ...(r.mode === 'suites' ? ['- suites mode: no screens and no stack, so each suite ran whole on the head commit; no base side, no model call'] : []),
    ...newOnHeadNotes(r),
    '- lived-in: not run in this step',
    ...testsNote(r),
    ...pageNote(page.tally),
    ...chromeNote(page.tally),
    ...(!routes || routes.notRun === 'no route table' ? ['- routes: no route table'] : []),
    ...(!mutants ? ['- mutants: not run'] : []),
    ...gateNotes({ charter, blocked, waivers, rowIds: new Set(rows.map((x) => x.id)) }),
    ...roundNotes(r.round),
    '',
    'cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0',
  ].join('\n') + '\n';

  return { verdict, criteria, rows, findings, gaps, blocked, gates, md };
}

// Which round this is, and where its carried rows and security review come from (ROUNDS).
function roundNotes(round) {
  if (!round || round.n == null) return [];
  const sha = (x) => String(x?.head ?? '').slice(0, 12);
  const out = [];
  if (round.of === 'incremental') {
    out.push(`- round ${round.n}: incremental from round ${round.from?.round ?? '?'} (${sha(round.from)}): ${(round.rerun ?? []).length} row(s) re-run, ${(round.carried ?? []).length} carried (each says carried from <sha>); ${(round.screens ?? []).length} screen(s) walked`);
  } else out.push(`- round ${round.n}: full — ${round.why ?? 'every row runs'}`);
  if (round.security && round.security.rerun === false && round.security.from) {
    out.push(`- security: carried from round ${round.security.from.round} (${sha(round.security.from)}): ${round.security.why}`);
  }
  return out;
}

// Notes that say what does not gate and why: advisory rows, blocked items, waivers of ids that are not Criteria rows.
function gateNotes({ charter, blocked, waivers, rowIds }) {
  const out = [];
  const advisory = charter.filter((c) => c.advisory).map((c) => c.id);
  if (advisory.length) out.push(`- advisory: ${advisory.length} charter row(s) beyond the spec (${advisory.join(', ')}); checked and reported, never gating`);
  if (blocked.length) out.push(`- blocked: ${blocked.length} item(s) the tool could not check (Gaps BLOCKED rows); they never fail the PR: check again later, or merge on the user's word`);
  for (const [id, w] of waivers) if (!rowIds.has(id)) out.push(`- waived [${id}]: ${w.reason} (${w.who}, ${w.date}); never gating`);
  return out;
}

function chromeNote({ standing, chrome }) {
  if (!standing && !chrome) return [];
  return [`- standing and shared chrome: ${standing} finding(s) match qa/standing.md, ${chrome} sit on 2 or more screens (shared chrome); Notes, never gating; the candidates are under Standing`];
}

function pageNote({ uncorroborated, cleared }) {
  if (!uncorroborated && !cleared) return [];
  return [`- page checks: ${uncorroborated} uncorroborated (Minor), ${cleared} cleared by a met test (Note); a page check gates only when eyes rules its screen wrong or its element was on the base screen too, and its screen changed; a met test that clears it makes it a Note`];
}

function testsNote(r) {
  const tests = r.tests ?? [];
  if (!tests.length) return [];
  const n = (result) => tests.filter((t) => t.result === result).length;
  const other = tests.length - n('met') - n('NOT MET');
  return [`- tests: ${tests.length} named test(s) run by qa itself on the head sandbox: ${n('met')} met · ${n('NOT MET')} NOT MET · ${other} unverifiable; the command, counts and output are under each in summary.md`];
}

// NEW ON HEAD: why some screens have no before picture, so the judge and the user read no gap into it.
function newOnHeadNotes(r) {
  const fresh = (r.screens ?? []).filter((s) => s.status === 'new' && s.newOnHead);
  if (!fresh.length) return [];
  const why = [...new Set(fresh.map((s) => s.newOnHead))].join(', ');
  return [`- new on head: ${fresh.length} screen(s) have no before picture (${why}); their checks, tour, console, metrics and expectations are judged on head alone`];
}

export function parseSecurity(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^- (High|Medium|Low) \[(sec:\d+)\] (.+)$/);
    if (m) out.push({ id: m[2], level: m[1], text: m[3] });
  }
  return out;
}

const NONE = /^- none\b/;
const FILES = /^(.*?) — files: (.*)$/;
const TITLE = /^# (ACCEPT|REJECT|NEEDS YOU|BLOCKED|PENDING)(?= —|\s*$)/;

// The Report line (rework U9, design §12): the last line of verdict.md, written after the report is placed, in one of
// three forms. parseReportLine(line) -> { kind: 'url', url } | { kind: 'not-published', reason } |
// { kind: 'local', host, path } | null (not a Report line, or none of the forms).
export function parseReportLine(line) {
  const text = String(line ?? '').trim();
  let m = /^Report: NOT PUBLISHED — (.+)$/.exec(text);
  if (m) return { kind: 'not-published', reason: m[1].trim() };
  m = /^Report: on (\S+) at (.+)$/.exec(text);
  if (m) return { kind: 'local', host: m[1], path: m[2].trim() };
  m = /^Report: (https?:\/\/\S+)$/.exec(text);
  if (m) return { kind: 'url', url: m[1] };
  return null;
}
const CRITERIA_LINE = /^criteria: (\d+) pass · (\d+) fail · (\d+) unverifiable(?: · (\d+) blocked · (\d+) waived)?\s*$/;
const ROW = {
  Criteria: /^- \[([^\]]+)\] (PASS|FAIL|UNVERIFIABLE|BLOCKED|WAIVED) — (.*?): (.*)$/,
  Expectations: /^- \[([^\]]+)\] (?:(explained|finding) — |(UNEXPECTED) )(.*)$/,
  Findings: /^- (Blocker|Major|Minor|Note|judge|eyes) \[([^\]]+)\] (.*)$/,
  'Spec cases': /^- (.*?): (.*)$/,
  Gaps: /^- \[([^\]]+)\] (.*)$/,
};

export function parseVerdict(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const v = {
    verdict: null, slug: null, head: null, base: null, maps: null, criteriaLine: null, draft: false,
    sections: [], cost: null, report: null, criteria: [], expectations: [], findings: [], specCases: [], gaps: [], standing: null, errors: [],
  };

  const title = lines[0]?.match(TITLE);
  v.verdict = title ? title[1] : null;
  const dash = lines[0]?.indexOf(' — ') ?? -1;
  if (dash >= 0) v.slug = lines[0].slice(dash + 3).trim() || null;

  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  const reportAt = last >= 0 && lines[last].startsWith('Report: ') ? last : -1;
  if (reportAt >= 0) {
    v.report = parseReportLine(lines[reportAt]);
    last--;
    while (last >= 0 && !lines[last].trim()) last--;
  }
  const costAt = last >= 0 && lines[last].startsWith('cost: ') ? last : -1;
  if (costAt >= 0) v.cost = lines[costAt];

  let section = null;
  for (const [i, line] of lines.entries()) {
    if (i === costAt || i === reportAt) { section = null; continue; }
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      v.sections.push(section);
      continue;
    }
    if (i === 0) continue;
    if (section === null) {
      if (line.startsWith('head: ')) v.head = line.slice(6).trim();
      else if (line.startsWith('base: ')) v.base = line.slice(6).trim();
      else if (line.startsWith('maps: ')) v.maps = line.slice(6).trim();
      else if (line.startsWith('draft: ')) v.draft = true;
      else {
        const c = line.match(CRITERIA_LINE);
        if (c) v.criteriaLine = { pass: Number(c[1]), fail: Number(c[2]), unverifiable: Number(c[3]), blocked: Number(c[4] ?? 0), waived: Number(c[5] ?? 0) };
      }
      continue;
    }
    if (!line.startsWith('- ')) continue;
    if (section === 'Standing') {
      v.standing ??= line.slice(2);
      continue;
    }
    if (!Object.hasOwn(ROW, section) || NONE.test(line)) continue;
    const m = line.match(ROW[section]);
    if (!m) { v.errors.push(line); continue; }
    if (section === 'Criteria') v.criteria.push({ id: m[1], status: m[2], name: m[3], detail: m[4] });
    else if (section === 'Expectations') v.expectations.push({ id: m[1], resolution: m[2] ?? m[3], text: m[4] });
    else if (section === 'Findings') {
      const f = m[3].match(FILES);
      v.findings.push({ severity: m[1], id: m[2], text: f ? f[1] : m[3], files: f ? f[2].split(',').map((x) => x.trim()).filter(Boolean) : [] });
    } else if (section === 'Spec cases') v.specCases.push({ path: m[1], reason: m[2] });
    else v.gaps.push({ id: m[1], text: m[2] });
  }
  return v;
}

// ── the judge's verdict against the gate, and waivers applied by script ──────

export function verdictOutcome({ verdictMd, results, security = [], eyes = null, charterMd = null, waiversMd = null }) {
  const v = parseVerdict(verdictMd);
  const d = draftVerdict(results, { security, eyes, charterMd, waiversMd });
  return decide({
    rows: v.criteria, charter: parseCharter(charterMd), waivers: waiverMap(parseWaivers(waiversMd)), findings: v.findings,
    gates: new Set(d.gates), blocked: d.blocked, runBlocked: Boolean(results.blocked), history: results.round?.history ?? {},
  });
}

export function applyWaivers({ verdictMd, results, security = [], eyes = null, charterMd = null, waiversMd = null }) {
  const waivers = waiverMap(parseWaivers(waiversMd));
  const charter = parseCharter(charterMd);
  const lines = String(verdictMd ?? '').split('\n');
  const applied = [];
  const headingAt = (name) => lines.indexOf(`## ${name}`);
  const sectionEnd = (start) => {
    let i = start + 1;
    while (i < lines.length && !lines[i].startsWith('## ') && !lines[i].startsWith('cost: ')) i++;
    return i;
  };
  const crit = headingAt('Criteria');
  const rowIds = new Set();
  if (crit >= 0) {
    const end = sectionEnd(crit);
    let lastItem = crit;
    for (let i = crit + 1; i < end; i++) {
      if (!lines[i].startsWith('- ')) continue;
      lastItem = i;
      const m = lines[i].match(ROW.Criteria);
      if (!m) continue;
      rowIds.add(m[1]);
      const w = waivers.get(m[1]);
      if (!w || m[2] === 'PASS' || m[2] === 'WAIVED') continue;
      lines[i] = `- [${m[1]}] WAIVED — ${m[3]}: ${waiverText(w)} — was ${m[2]}: ${m[4]}`;
      applied.push(m[1]);
    }
    const added = [];
    for (const c of charter) {
      const w = waivers.get(c.id);
      if (!w || !c.manual || rowIds.has(c.id)) continue;
      added.push(`- [${c.id}] WAIVED — ${c.text}: ${waiverText(w)} — was manual — ask: ${c.ask ?? 'what would prove it?'}`);
      rowIds.add(c.id);
      applied.push(c.id);
    }
    if (added.length) {
      if (/^- none\b/.test(lines[lastItem] ?? '')) lines.splice(lastItem, 1, ...added);
      else lines.splice(lastItem + 1, 0, ...added);
    }
  }
  // The fixed table's rows whose severity the waivers changed (a dismissed eyes ruling no longer corroborates a page
  // check): the table's severity and text, the judge's ' — files: …' tail kept.
  const table = new Map(draftVerdict(results, { security, eyes, charterMd, waiversMd }).findings
    .filter((f) => ['Blocker', 'Major', 'Minor', 'Note'].includes(f.severity)).map((f) => [f.id, f]));
  const fnd = headingAt('Findings');
  if (fnd >= 0) {
    for (let i = fnd + 1; i < sectionEnd(fnd); i++) {
      const m = lines[i].match(ROW.Findings);
      const f = m && table.get(m[2]);
      if (!f || f.severity === m[1]) continue;
      const files = m[3].match(FILES);
      lines[i] = `- ${f.severity} [${f.id}] ${f.text}${files ? ` — files: ${files[2]}` : ''}`;
      applied.push(f.id);
    }
  }
  // Waived ids that are not Criteria rows (a finding, a blocked item): one Notes line each.
  const now = parseVerdict(lines.join('\n'));
  const cited = new Set([...now.findings.map((f) => f.id), ...now.gaps.map((g) => g.id)]);
  const notes = headingAt('Notes');
  if (notes >= 0) {
    let at = sectionEnd(notes);
    while (at > notes + 1 && !lines[at - 1].startsWith('- ')) at--;
    const extra = [];
    for (const [id, w] of waivers) {
      const note = `- waived [${id}]: ${w.reason} (${w.who}, ${w.date}); never gating`;
      if (rowIds.has(id) || !cited.has(id) || lines.includes(note)) continue;
      extra.push(note);
      applied.push(id);
    }
    if (extra.length) {
      if (at === notes + 2 && /^- none\b/.test(lines[notes + 1])) lines.splice(notes + 1, 1, ...extra);
      else lines.splice(at, 0, ...extra);
    }
  }
  // The criteria line (in the header, before the first section) recounted, then line 1 from the gate.
  const firstSection = lines.findIndex((l) => l.startsWith('## '));
  const counted = criteriaLine(countRows(parseVerdict(lines.join('\n')).criteria));
  for (let i = 1; i < (firstSection < 0 ? lines.length : firstSection); i++) if (CRITERIA_LINE.test(lines[i])) lines[i] = counted;
  const gate = verdictOutcome({ verdictMd: lines.join('\n'), results, security, eyes, charterMd, waiversMd });
  lines[0] = `# ${gate.outcome} — ${now.slug ?? results.slug}`;
  // The round cap row says which criteria are still capped; a waiver that cleared them all takes it away.
  const capAt = lines.findIndex((l) => l.startsWith('- [gap:cap] '));
  if (capAt >= 0) {
    if (gate.capped.length) lines[capAt] = `- [gap:cap] ${capText(gate.capped)}`;
    else {
      const gapsAt = headingAt('Gaps');
      const items = gapsAt >= 0 ? lines.slice(gapsAt + 1, sectionEnd(gapsAt)).filter((l) => l.startsWith('- ')).length : 0;
      if (items === 1) lines[capAt] = '- none';
      else lines.splice(capAt, 1);
    }
  }
  return { md: lines.join('\n'), applied, outcome: gate.outcome };
}
