// results.json and summary.md for a run (decision 13). Pure functions: no files, no clock.
// The judge reads summary.md only; scripts (verdict draft, CI) read results.json. Both carry the
// same ids, so a finding in verdict.md cites a summary line.
//
// CONTRACT (tests: test/summary.test.mjs — fixtures are hand-built Run objects, see run.mjs)
//
//   IDS (stable for the same run; <vp> viewport, <key> compare's pair key '<screen>__<state>',
//   <n> 1-based position within that pair's list in the order compare gives):
//     scr:<vp>/<key>            a screen pair; a failed screen with no pair: scr:<vp>/<screen>
//     fail:<side>/<vp>/<screen> a capture failure (side base|head|a|b); fail:sandbox/<side> a blocked up
//     nrun:<side>/<vp>/<screen> a NOT RUN screen
//     exp:<name>                an expectation; exp:<name>@<vp> when the run has more than one viewport
//     unx:<vp>/<key>/<n>        an UNEXPECTED change (compare's unexpected entries for that key)
//     tour:<vp>/<key>/<n>       a NEW tour problem
//     chk:<vp>/<key>/<n>        a NEW check finding
//     con:<vp>/<key>/<n>        a NEW console line
//     more:<section>            the overflow line of a section (see summaryMd)
//
//   tourKind(problem) -> 'clipped' | 'covered' | 'stuck'
//     ' cut off by ' or ' runs past the ' -> clipped; ' covered at ' -> covered;
//     ' does not close on Escape' -> stuck (tour.mjs's problem texts).
//
//   buildResults(run) -> Results   (run: run.mjs's Run without `results`)
//     Results = {
//       version: 1, mode, slug, exit, head: { sha, ref }, base: { sha, ref, cached } | null,
//       maps: { head, base }, sandboxes, steps, warnings, blocked,
//       mapErrors: number of failed entries with mapError on the head side (self: side a),
//       failures: [{ id, side, viewport, screen, step, error, lines, mapError, onBase }]
//         every failed entry of every side's SideResult, plus { id: 'fail:sandbox/<side>', side,
//         viewport: null, screen: null, step: 'up', error: run.blocked, lines, mapError: false,
//         onBase: false } when blocked. lines = the error's first 3 lines. onBase (head entries
//         only): the base side failed the same screen at the same viewport; false elsewhere.
//       notRun: [{ id, side, viewport, screen, why }]
//       screens: [{ id, viewport, key, screen, status, tree, elements, pixel, eyes, checksRan }]
//         checksRan = the pair's after record's checksRan ([check id] | null: the page checks that ran on it).
//         one per compare pair (status = the pair's: same|changed|drift|new|gone) and one per
//         failed head screen at a viewport that has no pair for that screen (status 'MAP ERROR'
//         when mapError, else 'failed'; key null; tree/pixel null; elements { changed: 0, drift: 0 }).
//         tree = pair.tree ? { added, removed, unexplained } (counts; unexplained = the pair's
//         lines in compare's unexpected kind 'tree', added + removed) : null.
//         elements = { changed, drift } counts of the pair's element statuses.
//         pixel = pair.pixel ? { ratio, worstTile, changed } : null. eyes = the key is in compare's eyes.
//       expectations: [{ id, viewport, name, result, detail }]   result 'n/a' entries dropped
//       unexpected: [{ id, viewport, key, kind, added?, removed?, element?, before?, after? }]
//         (compare's entries; element entries keep before/after style objects)
//       tour: { opened, failed, clipped, covered, stuck, hoverAnswered, hoverTotal,
//               new: [{ id, viewport, key, text, kind }], standing: n }
//         opened/failed/hover from each pair's tour counts (hoverAnswered = hover - hoverSilent);
//         clipped/covered/stuck count NEW + standing problems by tourKind.
//       checks: { new: [{ id, viewport, key, check, detail }], standing: n, fixed: n }
//       console: { new: [{ id, viewport, key, text }], standing: n }
//       eyes: [screen id]
//       routes: null, mutants: null, livedIn: null      (later steps)
//       metrics: { captures, msPerCapture } | null      head side: captured count over all
//                viewports and round(head SideResult.ms / captures); null when nothing captured
//       standing: { checks, tour, console, file, added } (counts from compare's standing; file and
//                 added from run.standing, null/0 when absent)
//       identical: self mode only (else null): compare ran, its exit is 0, every pair is 'same',
//                 eyes is empty, and there are no new checks, tour problems or console lines.
//       report: run.report, compare: path of compare's results.json (dirname(report)/results.json) | null
//     }
//     A blocked run (compare null) still builds: screens/expectations/unexpected/eyes empty,
//     tour/checks/console zero, failures holds the sandbox line.
//
//   summaryMd(results, { maxLines = 150 } = {}) -> string
//     Sections in this fixed order; every section is always present.
//       # qa run — <slug>: <word> (exit <exit>)            self mode: '# qa self-test — <slug>: identical|NOT DETERMINISTIC (exit <exit>)'
//         word by exit: 0 nothing to report, 1 findings, 2 inconclusive, 3 NOT RUN, 4 BLOCKED
//       head <sha 12> · base <sha 12> (cached|fresh|live) · maps <head hash 12>     (self: 'head <sha 12> · self-test · maps <hash 12>')
//       sandbox: base <state> <s> s · head <state> <s> s · MAP ERROR <n>             (a null side omitted)
//       steps: <side>.<verb> ok|FAILED <s> s · …                                    (s = ms/1000, 0 decimals)
//       warning: <text>                                                             (one line per warning)
//       ## Failures (<n>)
//       - [<id>] <step>: <first line of error>          then up to 2 more lines, each '    <line>'
//       - [<id>] NOT RUN: <why>                          (notRun entries also listed here)
//       ## Screens — <u> unchanged · <c> changed · <n> new · <r> removed · <m> MAP ERROR · <f> failed
//         (changed counts 'changed' and 'drift'; unchanged screens are counted, never listed)
//       - [<id>] <status>[ · tree +<added> −<removed>[ (<unexplained> unexplained)]][ · elements <c> changed][ · <d> on one side][ · pixels <ratio %, 1 decimal>% (tile <worstTile, 3 decimals>)][ → eyes]
//       ## Expectations — met <m> · NOT MET <n> · other <o> · UNEXPECTED <u>
//       - [<id>] <result> — <name>: <detail>
//       - [<id>] UNEXPECTED <kind>: <first added line as '+ <line>', else first removed as '- <line>', else element '<element>'> (+<more> more)
//       ## Tour — <opened> opened · <clipped> clipped · <covered> covered · <stuck> stuck · <a>/<t> hovers answer
//       - [<id>] new: <text>
//       ## Checks — <n> new · <s> standing · <f> fixed · console <c> new
//       - [<id>] <check>: <detail>
//       - [<id>] console: <text>
//       ## Routes — not run
//       ## Mutants — not run
//       ## Metrics — <captures> captures, <s> s each    (or '## Metrics — none')
//       ## Lived-in — not run
//       ## Standing — <total> (<checks> checks · <tour> tour · <console> console)[ → <file> (+<added> new)]
//     Every item line starts '- [<id>] '; continuation lines start with four spaces. Item order
//     within a section = results order.
//     Cap: the result never has more than maxLines lines (newline-separated, no trailing blank
//     line counted). Header lines and the 10 '## ' section headings are always kept. Item lines are
//     placed section by section in the order above until the budget runs out; a section that
//     loses items ends with one '- [more:<section>] <k> more in results.json' line (section =
//     failures|screens|expectations|tour|checks), and the budget reserves room for those lines.
//     A failure item and its continuation lines are kept or dropped together.

//   STEP 6 (tests: test/summary.test.mjs 'step 6'): routes, mutants, metrics filled.
//     IDS gain:  rte:<n> | rte:unlisted/<n> | rte:stale/<n>   (routes.mjs diffRoutes)
//                mut:<mutant id>                               (mutants.mjs)
//                met:<vp>/<key>/<metric>                       a metric flag
//     buildResults(run): routes = run.routes ?? null (routes.mjs RoutesResult, kept as is);
//       mutants = run.mutants ?? null (mutants.mjs MutantsResult, kept as is);
//       metrics = { captures, msPerCapture, flags: [{ id, viewport, key, metric, kind, head, base,
//         limit }] (every pair.metrics flag, compare order), standing: sum of viewports'
//         metricsStanding } — null only when nothing was captured (flags [] / standing 0 otherwise);
//       expectations also gets run.routeExpectations ?? [] appended (after compare's), each as
//         { id: 'exp:<name>', viewport: null, name, result, detail } ('n/a' dropped as before).
//     Texts (exported, verdict.mjs reuses them):
//       routeText(r)   new: '<route> <kind> (<actor>): <problem>'; unlisted: 'unlisted: <method> <path>';
//                      stale: 'stale: <method> <path>'   (r is one entry of new | unlisted | stale)
//       mutantText(m)  survived: 'SURVIVED: <breaks> (<file>, suite <suite>)'; stale: 'stale: <detail>' (a
//                      leading 'stale: ' already in detail is not repeated);
//                      not judged: 'not judged: <detail>' — the verdict word comes from which list
//                      it is in: mutantText(m, 'survived'|'stale'|'notJudged')
//       metricText(f)  metrics.mjs metricsLine(f)
//     summaryMd: the Routes, Mutants and Metrics headings become item sections (the budget order
//     is failures, screens, expectations, tour, checks, routes, mutants, metrics; more:<section>
//     for the three new ones too; still 10 headings):
//       ## Routes — <probes> probes · <new> new · <standing> standing · <fixed> fixed · <u> unlisted · <s> stale
//         (routes null -> '## Routes — not run'; routes.notRun -> '## Routes — not run: <notRun>')
//       - [rte:<n>] <routeText>          then '- [rte:unlisted/<n>] …', then '- [rte:stale/<n>] …'
//       ## Mutants — <killed>/<run> killed · <s> survived · <t> stale · <j> not judged (<mode>)
//         (mutants null -> '## Mutants — not run')
//       - [mut:<id>] <mutantText>        survived, then stale, then not judged
//       ## Metrics — <captures> captures, <s> s each · <f> flag(s) · <st> standing   ('## Metrics — none' when null)
//       - [met:<vp>/<key>/<metric>] <metricText>
//     A route expectation's line in Expectations is the usual '- [exp:<name>] <result> — <name>: <detail>'.

//   READY (0.5.0; tests: test/ready.test.mjs 'summary'): buildResults keeps readiness = run.readiness ?? null
//     (ready.mjs readiness()); summaryMd puts its line ('project not proven ready: <why>') as header line 3, right
//     after the head/base line, when readiness is present and its state is not 'ready'. No id: it says what the
//     project lacks, not what the PR did.

//   STEP 7 (tests: test/summary.test.mjs 'step 7'):
//     buildResults (still pure): affected = run.affected ?? null; videos = run.videos ?? [] (run.mjs
//       lists them: [{ id: 'vid:<vp>/<screen>', viewport, screen, file (absolute), checkpoints }]);
//       sourcesWritten = run.sourcesWritten ?? [].
//     summaryMd: one header line after 'steps:' —
//       'affected: <n> of <total> screens (<unknown> without known sources)' (mode affected), and (rework U4), when
//       affected.mapThese is non-empty, right after it 'map these: <up to 12 names>[ +<k> more] — no known sources, so
//       not walked (out of scope); the prepare step or the qa skill records their sources',
//       'full: every screen[ · sources written: <k> file(s)]' (mode full), nothing for screens mode
//       or affected null. And when videos is non-empty, one line after it: 'videos: <n> (report.html)'.
//       Then, one per viewport whose pairs carry checksRan: 'checks ran (<vp>): <ids> on every screen (<n>)
//       [ · <id> not on <keys>][ · not run: <ids>]' — what the page checks looked at, so no finding is not
//       read as no look.
//     IDS gain vid:<vp>/<screen>.

//   NEW ON HEAD (tests: test/new-on-head.test.mjs; compare.mjs and run.mjs NEW ON HEAD):
//     buildResults: every pair-derived screen gains newOnHead = the pair's newOnHead ?? null; a base
//     failure of a screen in that viewport's compare fresh gains newOnHead = its reason (the field is
//     absent otherwise); a head failure's onBase is also false when its screen is in run.newEntries.
//     Texts: screenText says 'new on head (<reason>)' for a 'new' screen with a newOnHead;
//     failureText starts 'new on head (<reason>), no before picture — ' for a failure with one.

//   UNMAPPED (tests: test/summary.test.mjs 'unmapped'): buildResults: unmapped =
//     (run.affected?.unmapped ?? []).map((file, i) => ({ id: 'unm:' + (i + 1), file })).
//     summaryMd: after the Screens section's screen items, one item per entry:
//     '- [unm:<n>] unmapped: <file> — no map entry walks it' (part of the screens budget section).
//     unmappedText(u) exported = 'unmapped: <file> — no map entry walks it'.

//   TESTS (0.4.0; tests: test/tests.test.mjs 'summary'): buildResults: tests = run.tests ?? [] (tests.mjs
//     TestRecords, kept as is); expectations also gets each record appended after the route ones, as
//     { id: 'exp:<name>', viewport: null, name, result, detail }. summaryMd: a test expectation's line in
//     Expectations is the usual one, followed by continuation lines (testLines(t), kept with it):
//       '    $ <command> · exit <code> · <s> s · head <at 12>'      (or '    not run' when no command ran)
//       '    tests: <matched> matched of <total> · <passed> passed · <failed> failed · <skipped> skipped (<source>)'
//       '    | <line>'  the last 3 lines of the output
//     so the judge reads what ran, what it counted and how it ended without opening a log.

//   0.6.0 (tests: test/docs.test.mjs, test/noise.test.mjs, test/mutants.test.mjs 'red baseline'): buildResults:
//     docs = run.docs ?? [] (docs.mjs DocRecords), each also appended to expectations after the tests' as
//     { id: 'exp:<name>', viewport: null, name, result, detail }. mutantText(m, 'survived') ends ' — <detail>' when
//     the detail starts 'judged on names', or (rework) 'kill test ' (a mutant judged by the one test the plan named).
//     summaryMd: the Mutants heading gains ' · <n> baseline failure(s) excluded (<suite> <k>, …)' when a suite
//     failed unmutated and its failing tests were named (mutants.mjs suites[id].baseline), so mutants were judged
//     on the tests that passed unmutated.

//   1.0.0 (tests: test/outcomes.test.mjs 'results'): buildResults keeps what the gate needs to tell a tool failure from
//     a product one. failures gain, when capture.mjs recorded them: timeout (a step timed out), retried (it timed out
//     twice: once, then again after the other screens), serverError (the head answered 5xx or showed an error page:
//     '<status> <path>'), and baseWalked (head entries: the base captured that screen at that viewport). expectations
//     gain observed (compare's count of the elements it judged) when compare gave one. checks.new and tour.new
//     entries gain onBase (compare's newOnBase: the element was on the base screen) when compare gave it. screens gain error (compare
//     could not read that pair: its first line) when there was one. compareError = run.compareError ?? null (compare
//     itself threw; nothing on any screen was judged). failureText is unchanged.

//   U7 (rework, design 2026-11-12 §8; tests: test/fingerprint.test.mjs). Standing and shared-chrome fingerprints.
//     buildResults: every checks.new and tour.new entry gains fingerprint = fingerprint.mjs checkFingerprint(the
//       finding) / tourFingerprint(the pair's after record, the problem) when the capture gave one (key absent
//       otherwise). run.standingRows (standing.mjs readStanding of qa/standing.md, run.mjs) are matched with
//       standingMatcher, item { viewport, key, kind: 'check'|'tour', text: '<check>: <detail>' | the problem,
//       fingerprint }: a match gains standing: <row id> and is listed in results.standing.matched = [{ id, text: the
//       row's finding, findings: [finding ids] }] (row order of first match; [] when none).
//     Shared chrome: a fingerprint (by fingerprintKey) seen on 2 or more distinct walked screens — a screen is the
//       map entry, whatever its states and viewports — counting every head finding of the run (new and those the base
//       has too), is shared chrome when it has at least one new finding no standing row matched, and is not a
//       regression: no new finding of it sits on a pair with a base record (status not 'new') with onBase true (the
//       PR broke an element the base had, so the page rule judges it). results.chrome = [{ id: 'chrome:<n>' (first-seen
//       order), fingerprint, text: fingerprintText, screens: [screen names, first-seen order], findings: [the new,
//       unmatched finding ids] }] ([] when none); each of those findings gains chrome: <id>.
//     summaryMd: a checks or tour line of a finding with standing ends ' — standing <id>', with chrome ' — shared
//       chrome <id>'. The Standing section gets items (a budget section after metrics; more:standing):
//       '- [<chrome id>] <text>: <n> screens — add to standing?' per chrome entry, then
//       '- [<row id>] standing: <row text> — <k> finding(s) in this run, Notes, never gating' per matched row.

import path from 'node:path';
import { CHECK_IDS } from './checks.mjs';
import { checkFingerprint, fingerprintKey, fingerprintText, tourFingerprint, tourKind } from './fingerprint.mjs';
import { metricsLine } from './metrics.mjs';
import { standingMatcher } from './standing.mjs';

export { tourKind };

const SECTION_ORDER = ['failures', 'screens', 'expectations', 'tour', 'checks', 'routes', 'mutants', 'metrics', 'standing'];

const count = (list, test) => list.filter(test).length;
const firstLines = (error) => String(error ?? '').split('\n').slice(0, 3);

export function buildResults(run) {
  const self = run.mode === 'self';
  const sideEntries = self
    ? [['a', run.sides?.head], ['b', run.sides?.again]]
    : [['base', run.sides?.base], ['head', run.sides?.head]];
  const headSide = run.sides?.head ?? null;
  const baseSide = self ? null : run.sides?.base ?? null;

  // Failures and NOT RUN screens, every side.
  const failedOn = (side, vp, screen) => !!side?.viewports?.find((v) => v.viewport === vp)?.failed?.some((f) => f.screen === screen);
  const walkedOn = (side, vp, screen) => !!side?.viewports?.find((v) => v.viewport === vp)?.captured?.some((k) => String(k).split('__')[0] === screen);
  // NEW ON HEAD: why a screen has no before picture at a viewport (compare's fresh), and the screens whose map entry is
  // new (a base failure of theirs was not of this entry).
  const freshAt = (vp, screen) => (run.compare?.viewports ?? []).find((v) => v.viewport === vp)?.fresh?.[screen] ?? null;
  const newEntries = run.newEntries ?? {};
  const failures = [];
  const notRun = [];
  for (const [label, side] of sideEntries) {
    for (const v of side?.viewports ?? []) {
      for (const f of v.failed ?? []) {
        failures.push({
          id: `fail:${label}/${v.viewport}/${f.screen}`, side: label, viewport: v.viewport, screen: f.screen,
          step: f.step, error: f.error, lines: firstLines(f.error), mapError: !!f.mapError,
          onBase: label === 'head' && failedOn(baseSide, v.viewport, f.screen) && !Object.hasOwn(newEntries, f.screen),
          ...(f.timeout ? { timeout: true } : {}), ...(f.retried ? { retried: true } : {}), ...(f.serverError ? { serverError: f.serverError } : {}),
          ...(label === 'head' && walkedOn(baseSide, v.viewport, f.screen) ? { baseWalked: true } : {}),
          ...(label === 'base' && freshAt(v.viewport, f.screen) ? { newOnHead: freshAt(v.viewport, f.screen) } : {}),
        });
      }
      for (const n of v.notRun ?? []) {
        notRun.push({ id: `nrun:${label}/${v.viewport}/${n.screen}`, side: label, viewport: v.viewport, screen: n.screen, why: n.why });
      }
    }
  }
  if (run.blocked && run.mode === 'suites') {
    failures.push({
      id: 'fail:suites', side: 'head', viewport: null, screen: null, step: 'suites', error: run.blocked,
      lines: firstLines(run.blocked), mapError: false, onBase: false,
    });
  } else if (run.blocked) {
    const side = run.sandboxes?.base?.state === 'blocked' ? 'base' : 'head';
    failures.push({
      id: `fail:sandbox/${side}`, side, viewport: null, screen: null, step: 'up', error: run.blocked,
      lines: firstLines(run.blocked), mapError: false, onBase: false,
    });
  }
  const mapErrors = (headSide?.viewports ?? []).reduce((n, v) => n + count(v.failed ?? [], (f) => f.mapError), 0);

  // Compare, per viewport.
  const cvs = run.compare?.viewports ?? [];
  const multi = cvs.length > 1;
  const screens = [];
  const expectations = [];
  const unexpected = [];
  const tour = { opened: 0, failed: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [], standing: 0 };
  const checks = { new: [], standing: 0, fixed: 0 };
  const consoleR = { new: [], standing: 0 };
  const eyes = [];
  const standingCounts = { checks: 0, tour: 0, console: 0 };
  const metricFlags = [];
  let metricsStanding = 0;
  // U7: standing rows matched by fingerprint (or by one screen's id), and the fingerprints seen per screen.
  const matchStanding = standingMatcher(run.standingRows ?? []);
  const matched = new Map();
  const prints = new Map();
  const seenOn = (fp, screen) => {
    if (!fp) return null;
    const k = fingerprintKey(fp);
    if (!prints.has(k)) prints.set(k, { fingerprint: fp, screens: new Set(), regression: false, open: [] });
    const e = prints.get(k);
    e.screens.add(screen);
    return e;
  };
  // A new finding: its fingerprint, a standing row that stands for it, and its part in shared chrome.
  const mark = (entry, item, fp, p, screen) => {
    if (fp) entry.fingerprint = fp;
    const row = matchStanding({ ...item, ...(fp ? { fingerprint: fp } : {}) });
    if (row) {
      entry.standing = row.id;
      if (!matched.has(row.id)) matched.set(row.id, { id: row.id, text: row.finding, findings: [] });
      matched.get(row.id).findings.push(entry.id);
    }
    const e = seenOn(fp, screen);
    if (!e) return entry;
    if (!row) e.open.push(entry);
    if (entry.onBase === true && p.status !== 'new' && p.before) e.regression = true;
    return entry;
  };

  for (const cv of cvs) {
    const vp = cv.viewport;
    const treeUnexplained = {};
    const perKey = {};
    for (const u of cv.unexpected ?? []) {
      perKey[u.key] = (perKey[u.key] ?? 0) + 1;
      unexpected.push({ id: `unx:${vp}/${u.key}/${perKey[u.key]}`, viewport: vp, ...u });
      if (u.kind === 'tree') treeUnexplained[u.key] = (treeUnexplained[u.key] ?? 0) + (u.added?.length ?? 0) + (u.removed?.length ?? 0);
    }
    for (const e of cv.expectations ?? []) {
      if (e.result === 'n/a') continue;
      expectations.push({ id: multi ? `exp:${e.name}@${vp}` : `exp:${e.name}`, viewport: vp, name: e.name, result: e.result, detail: e.detail, ...(Number.isInteger(e.observed) ? { observed: e.observed } : {}) });
    }
    const eyeKeys = new Set(cv.eyes ?? []);
    for (const k of cv.eyes ?? []) eyes.push(`scr:${vp}/${k}`);
    const paired = new Set();
    for (const p of cv.pairs ?? []) {
      const screen = (p.after ?? p.before)?.screen ?? String(p.key).split('__')[0];
      paired.add(screen);
      screens.push({
        id: `scr:${vp}/${p.key}`, viewport: vp, key: p.key, screen, status: p.status,
        tree: p.tree ? { added: p.tree.added.length, removed: p.tree.removed.length, unexplained: treeUnexplained[p.key] ?? 0 } : null,
        elements: { changed: count(p.elements ?? [], (e) => e.status === 'changed'), drift: count(p.elements ?? [], (e) => e.status === 'drift') },
        pixel: p.pixel ? { ratio: p.pixel.ratio, worstTile: p.pixel.worstTile, changed: p.pixel.changed } : null,
        eyes: eyeKeys.has(p.key), checksRan: p.after?.checksRan ?? null, newOnHead: p.newOnHead ?? null,
        ...(p.error ? { error: p.error } : {}),
      });
      const t = p.tour;
      if (t) {
        tour.opened += t.opened ?? 0;
        tour.failed += t.failed ?? 0;
        tour.hoverTotal += t.hover ?? 0;
        tour.hoverAnswered += (t.hover ?? 0) - (t.hoverSilent ?? 0);
        (t.new ?? []).forEach((text, i) => tour.new.push(mark(
          { id: `tour:${vp}/${p.key}/${i + 1}`, viewport: vp, key: p.key, text, kind: tourKind(text), ...(typeof t.newOnBase?.[i] === 'boolean' ? { onBase: t.newOnBase[i] } : {}) },
          { viewport: vp, key: p.key, kind: 'tour', text }, tourFingerprint(p.after, text), p, screen,
        )));
        for (const text of t.standing ?? []) seenOn(tourFingerprint(p.after, text), screen);
        tour.standing += (t.standing ?? []).length;
        for (const text of [...(t.new ?? []), ...(t.standing ?? [])]) tour[tourKind(text)] += 1;
      }
      for (const f of p.metrics?.flags ?? []) {
        metricFlags.push({ id: `met:${vp}/${p.key}/${f.metric}`, viewport: vp, key: p.key, metric: f.metric, kind: f.kind, head: f.head, base: f.base, limit: f.limit });
      }
      const c = p.checks;
      if (c) {
        (c.new ?? []).forEach((f, i) => checks.new.push(mark(
          { id: `chk:${vp}/${p.key}/${i + 1}`, viewport: vp, key: p.key, check: f.check, detail: f.detail, ...(typeof c.newOnBase?.[i] === 'boolean' ? { onBase: c.newOnBase[i] } : {}) },
          { viewport: vp, key: p.key, kind: 'check', text: `${f.check}: ${f.detail}` }, checkFingerprint(f), p, screen,
        )));
        for (const f of c.standing ?? []) seenOn(checkFingerprint(f), screen);
        checks.standing += (c.standing ?? []).length;
        checks.fixed += (c.fixed ?? []).length;
      }
      const k = p.console;
      if (k) {
        (k.new ?? []).forEach((text, i) => consoleR.new.push({ id: `con:${vp}/${p.key}/${i + 1}`, viewport: vp, key: p.key, text }));
        consoleR.standing += (k.standing ?? []).length;
      }
    }
    metricsStanding += cv.metricsStanding ?? 0;
    standingCounts.checks += cv.standing?.checks ?? 0;
    standingCounts.tour += cv.standing?.tour ?? 0;
    standingCounts.console += cv.standing?.console ?? 0;

    // A failed head screen with no pair at this viewport.
    const seen = new Set();
    for (const f of failures) {
      if (f.side !== (self ? 'a' : 'head') || f.viewport !== vp || f.screen === null || paired.has(f.screen) || seen.has(f.screen)) continue;
      seen.add(f.screen);
      screens.push({
        id: `scr:${vp}/${f.screen}`, viewport: vp, key: null, screen: f.screen, status: f.mapError ? 'MAP ERROR' : 'failed',
        tree: null, elements: { changed: 0, drift: 0 }, pixel: null, eyes: false,
      });
    }
  }

  // Shared chrome: on 2 or more walked screens, with a new finding no standing row stands for, and no regression.
  const chrome = [];
  for (const e of prints.values()) {
    if (e.screens.size < 2 || e.regression || !e.open.length) continue;
    const id = `chrome:${chrome.length + 1}`;
    for (const entry of e.open) entry.chrome = id;
    chrome.push({ id, fingerprint: e.fingerprint, text: fingerprintText(e.fingerprint), screens: [...e.screens], findings: e.open.map((x) => x.id) });
  }

  const captures = (headSide?.viewports ?? []).reduce((n, v) => n + (v.captured ?? []).length, 0);
  const metrics = captures > 0
    ? { captures, msPerCapture: Math.round((headSide.ms ?? 0) / captures), flags: metricFlags, standing: metricsStanding }
    : null;
  // Suites mode: each suite run whole is a row of its own, ahead of the rest (id suite:<id>).
  for (const t of run.suites ?? []) expectations.push({ id: `suite:${t.id}`, viewport: null, name: `suite ${t.id}`, result: t.result, detail: t.detail });
  for (const e of run.routeExpectations ?? []) {
    if (e.result === 'n/a') continue;
    expectations.push({ id: `exp:${e.name}`, viewport: null, name: e.name, result: e.result, detail: e.detail });
  }
  for (const t of run.tests ?? []) expectations.push({ id: `exp:${t.name}`, viewport: null, name: t.name, result: t.result, detail: t.detail });
  for (const t of run.docs ?? []) expectations.push({ id: `exp:${t.name}`, viewport: null, name: t.name, result: t.result, detail: t.detail });

  let identical = null;
  if (self) {
    identical = !!run.compare && run.compare.exit === 0
      && cvs.every((v) => (v.pairs ?? []).every((p) => p.status === 'same'))
      && eyes.length === 0 && checks.new.length === 0 && tour.new.length === 0 && consoleR.new.length === 0;
  }

  return {
    version: 1, mode: run.mode, slug: run.slug, exit: run.exit,
    head: { sha: run.head?.sha ?? null, ref: run.head?.ref ?? null },
    base: run.base ? { sha: run.base.sha ?? null, ref: run.base.ref ?? null, cached: !!run.base.cached } : null,
    maps: run.maps ?? { head: null, base: null },
    sandboxes: run.sandboxes ?? { base: null, head: null },
    steps: run.steps ?? [], warnings: run.warnings ?? [], blocked: run.blocked ?? null, compareError: run.compareError ?? null,
    mapErrors, failures, notRun, screens, expectations, unexpected, tour, checks, console: consoleR, eyes,
    routes: run.routes ?? null, mutants: run.mutants ?? null, tests: run.tests ?? [], docs: run.docs ?? [], suites: run.suites ?? null, livedIn: null, metrics,
    unmapped: (run.affected?.unmapped ?? []).map((file, i) => ({ id: `unm:${i + 1}`, file })),
    affected: run.affected ?? null, videos: run.videos ?? [], sourcesWritten: run.sourcesWritten ?? [],
    readiness: run.readiness ?? null,
    standing: { ...standingCounts, file: run.standing?.file ?? null, added: run.standing?.added ?? 0, matched: [...matched.values()] },
    chrome,
    identical,
    report: run.report ?? null,
    compare: run.report ? path.join(path.dirname(run.report), 'results.json') : null,
  };
}

// ---- line texts (the text after '- [<id>] '); verdict.mjs reuses these -------------------------

export const failureText = (f) => `${f.newOnHead ? `new on head (${f.newOnHead}), no before picture — ` : ''}${f.step}: ${f.lines?.[0] ?? ''}`;
export const notRunText = (n) => `NOT RUN: ${n.why}`;
export const expectationText = (e) => `${e.result} — ${e.name}: ${e.detail}`;
export const tourText = (t) => `new: ${t.text}`;
export const checkText = (c) => `${c.check}: ${c.detail}`;
export const consoleText = (c) => `console: ${c.text}`;
export const unmappedText = (u) => `unmapped: ${u.file} — no map entry walks it`;

export function routeText(r) {
  if (String(r.id).startsWith('rte:unlisted/')) return `unlisted: ${r.method} ${r.path}`;
  if (String(r.id).startsWith('rte:stale/')) return `stale: ${r.method} ${r.path}`;
  return `${r.route} ${r.kind} (${r.actor}): ${r.problem}`;
}

export function mutantText(m, list = 'survived') {
  if (list === 'stale') return `stale: ${String(m.detail ?? '').replace(/^stale: /, '')}`;
  if (list === 'notJudged') return `not judged: ${m.detail}`;
  // a mutant judged against a red baseline, or by its kill test, says so (mutants.mjs)
  const named = /^(judged on names|kill test )/.test(String(m.detail ?? '')) ? ` — ${m.detail}` : '';
  return `SURVIVED: ${m.breaks} (${m.file}, suite ${m.suite})${named}`;
}

export const metricText = (f) => metricsLine(f);

// The continuation lines under a test expectation: the command qa ran, what the runner counted, the output's end.
export function testLines(t) {
  const c = t.counts ?? {};
  const where = `${t.side ?? 'head'}${t.at ? ` ${String(t.at).slice(0, 12)}` : ''}`;
  const ran = t.command
    ? `    $ ${t.command} · exit ${t.exit ?? 'none'}${t.timedOut ? ' (timed out)' : ''} · ${Math.round((t.ms ?? 0) / 1000)} s · ${where}`
    : '    not run';
  const counted = `    tests: ${c.matched ?? 0} matched of ${c.total ?? 0} · ${c.passed ?? 0} passed · ${c.failed ?? 0} failed · ${c.skipped ?? 0} skipped (${t.source ?? 'none'})`;
  const tail = (t.tail ?? []).slice(-3).map((l) => `    | ${l.length > 200 ? `${l.slice(0, 197)}...` : l}`);
  return [ran, counted, ...tail];
}

export function unexpectedText(u) {
  const added = u.added ?? [];
  const removed = u.removed ?? [];
  const first = added.length ? `+ ${added[0]}` : removed.length ? `- ${removed[0]}` : u.element ?? '';
  const more = Math.max(0, added.length + removed.length - 1);
  return `UNEXPECTED ${u.kind}: ${first}${more > 0 ? ` (+${more} more)` : ''}`;
}

export function screenText(s) {
  const parts = [s.status === 'new' && s.newOnHead ? `new on head (${s.newOnHead})` : s.status];
  if (s.tree && (s.tree.added || s.tree.removed)) {
    parts.push(`tree +${s.tree.added} −${s.tree.removed}${s.tree.unexplained ? ` (${s.tree.unexplained} unexplained)` : ''}`);
  }
  if (s.elements?.changed) parts.push(`elements ${s.elements.changed} changed`);
  if (s.elements?.drift) parts.push(`${s.elements.drift} on one side`);
  if (s.pixel?.changed) parts.push(`pixels ${(s.pixel.ratio * 100).toFixed(1)}% (tile ${s.pixel.worstTile.toFixed(3)})`);
  return parts.join(' · ') + (s.eyes ? ' → eyes' : '');
}

// ---- summary.md -------------------------------------------------------------------------------

const secs = (ms) => `${Math.round((ms ?? 0) / 1000)} s`;
const short = (hash) => (hash ? String(hash).slice(0, 12) : 'none');
const SUITE_WORDS = { 0: 'all suites pass', 1: 'a suite fails', 2: 'inconclusive', 4: 'BLOCKED' };
const WORDS = { 0: 'nothing to report', 1: 'findings', 2: 'inconclusive', 3: 'NOT RUN', 4: 'BLOCKED' };

// What a page check's silence means: one line per viewport naming the checks that ran on every captured screen, and
// any that ran on only some or none ('not run' = never looked, so no finding proves nothing). Pairs from a capture
// before this field existed carry no list and are left out; when none carry one there is no line.
function checksRanLines(r) {
  const byVp = new Map();
  for (const s of r.screens) if (Array.isArray(s.checksRan)) byVp.set(s.viewport, [...(byVp.get(s.viewport) ?? []), s]);
  return [...byVp].map(([vp, list]) => {
    const ids = [...new Set(list.flatMap((s) => s.checksRan))];
    const all = CHECK_IDS.filter((id) => list.every((s) => s.checksRan.includes(id)));
    const some = CHECK_IDS.filter((id) => ids.includes(id) && !all.includes(id));
    const never = CHECK_IDS.filter((id) => !ids.includes(id));
    const parts = [`${all.length ? all.join(', ') : 'none'} on every screen (${list.length})`];
    for (const id of some) {
      const lacking = list.filter((s) => !s.checksRan.includes(id)).map((s) => s.key);
      parts.push(`${id} not on ${lacking.slice(0, 5).join(', ')}${lacking.length > 5 ? ` +${lacking.length - 5} more` : ''}`);
    }
    if (never.length) parts.push(`not run: ${never.join(', ')}`);
    return `checks ran (${vp}): ${parts.join(' · ')}`;
  });
}

function headerLines(r) {
  const self = r.mode === 'self';
  const out = [];
  if (self) {
    const word = r.blocked ? 'BLOCKED' : r.identical ? 'identical' : 'NOT DETERMINISTIC';
    out.push(`# qa self-test — ${r.slug}: ${word} (exit ${r.exit})`);
    out.push(`head ${short(r.head.sha)} · self-test · maps ${short(r.maps?.head)}`);
  } else {
    out.push(`# qa run — ${r.slug}: ${WORDS[r.exit] ?? `exit ${r.exit}`} (exit ${r.exit})`);
    const b = r.base;
    const baseWord = r.sandboxes?.base?.state === 'live' ? 'live' : b?.cached ? 'cached' : 'fresh';
    out.push(`head ${short(r.head.sha)} · base ${b ? (b.sha ? short(b.sha) : (b.ref ?? 'none')) : 'none'} (${baseWord}) · maps ${short(r.maps?.head)}`);
  }
  if (r.readiness?.line && r.readiness.state !== 'ready') out.push(r.readiness.line);
  const sb = [];
  for (const side of ['base', 'head']) {
    const s = r.sandboxes?.[side];
    if (s) sb.push(`${side} ${s.state} ${secs(s.ms)}`);
  }
  sb.push(`MAP ERROR ${r.mapErrors}`);
  out.push(`sandbox: ${sb.join(' · ')}`);
  out.push(`steps: ${r.steps.length ? r.steps.map((s) => `${s.side}.${s.verb} ${s.ok ? 'ok' : 'FAILED'} ${secs(s.ms)}`).join(' · ') : 'none'}`);
  const a = r.affected;
  if (a?.mode === 'affected') {
    out.push(`affected: ${a.names.length} of ${a.total} screens (${a.unknown} without known sources)`);
    // Out of scope for want of sources (rework U4): never walked, never UNVERIFIABLE; the prepare step maps them.
    const these = a.mapThese ?? [];
    if (these.length) out.push(`map these: ${these.slice(0, 12).join(', ')}${these.length > 12 ? ` +${these.length - 12} more` : ''} — no known sources, so not walked (out of scope); the prepare step or the qa skill records their sources`);
  }
  else if (a?.mode === 'full') {
    const k = r.sourcesWritten?.length ?? 0;
    out.push(`full: every screen${k > 0 ? ` · sources written: ${k} file(s)` : ''}`);
  }
  if (r.videos?.length) out.push(`videos: ${r.videos.length} (report.html)`);
  out.push(...checksRanLines(r));
  for (const w of r.warnings) out.push(`warning: ${w}`);
  return out;
}

// How many tests failed unmutated and were left out of judging the mutants (a red baseline, 0.6.0).
function baselineNote(mu) {
  const red = Object.entries(mu.suites ?? {}).filter(([, s]) => s?.baseline?.failed > 0);
  if (!red.length) return '';
  const n = red.reduce((sum, [, s]) => sum + s.baseline.failed, 0);
  return ` · ${n} baseline failure(s) excluded (${red.map(([id, s]) => `${id} ${s.baseline.failed}`).join(', ')})`;
}

// What a standing row or shared chrome makes of a finding (U7): the suffix of its line.
const standingMark = (f) => (f.standing ? ` — standing ${f.standing}` : f.chrome ? ` — shared chrome ${f.chrome}` : '');

// One unit = the lines of one item (a failure keeps its continuation lines). keep: placed before
// ordinary items when the section is cut, so a console line is not starved by a long list of checks.
const unit = (id, text, extra = [], keep = false) => ({ lines: [`- [${id}] ${text}`, ...extra], keep });

// A suites-mode run (suitesmode.mjs): the suites first, then the named tests and docs, the mutants, and what blocked it.
function suitesSummary(r) {
  const word = (e) => (e.result === 'met' ? 'PASS' : e.result === 'NOT MET' ? 'FAIL' : 'UNVERIFIABLE');
  const suiteRows = r.expectations.filter((e) => e.id.startsWith('suite:'));
  const other = r.expectations.filter((e) => !e.id.startsWith('suite:'));
  const out = [`# qa run — ${r.slug}: ${SUITE_WORDS[r.exit] ?? `exit ${r.exit}`} (exit ${r.exit})`, `head ${short(r.head.sha)} · suites mode: no screens and no stack, so the test suites run whole on the head commit (no sandbox, no base side)`];
  if (r.readiness?.line && r.readiness.state !== 'ready') out.push(`note: ${r.readiness.line}`);
  out.push(`steps: ${r.steps.length ? r.steps.map((x) => `${x.side}.${x.verb} ${x.ok ? 'ok' : 'FAILED'} ${secs(x.ms)}`).join(' · ') : 'none'}`);
  for (const w of r.warnings) out.push(`warning: ${w}`);
  if (r.blocked) out.push('', `## Blocked`, `- [fail:suites] ${String(r.blocked).split('\n')[0]}`);
  const pass = count(suiteRows, (e) => e.result === 'met');
  const fail = count(suiteRows, (e) => e.result === 'NOT MET');
  out.push('', `## Suites — ${suiteRows.length} run · ${pass} PASS · ${fail} FAIL · ${suiteRows.length - pass - fail} not run`);
  for (const e of suiteRows) out.push(`- [${e.id}] ${word(e)} — ${e.name}: ${e.detail}`);
  for (const s of r.suites ?? []) {
    if (s.result === 'NOT MET' && s.failing?.length > 5) out.push(`  - ${s.id}: ${s.failing.length} failing tests; every name is in results.json`);
  }
  if (other.length) {
    out.push('', `## Expectations — ${other.length}`);
    for (const e of other) {
      const t = (r.tests ?? []).find((x) => x.id === e.id);
      out.push(`- [${e.id}] ${expectationText(e)}`, ...(t ? testLines(t) : []));
    }
  }
  const mu = r.mutants;
  out.push('', mu ? `## Mutants — ${mu.killed}/${mu.run} killed · ${mu.survived.length} survived · ${mu.stale.length} stale · ${mu.notJudged.length} not judged (${mu.mode})` : '## Mutants — not run');
  for (const x of mu?.survived ?? []) out.push(`- [${x.id}] ${mutantText(x, 'survived')}`);
  for (const x of mu?.stale ?? []) out.push(`- [${x.id}] ${mutantText(x, 'stale')}`);
  return out.join('\n') + '\n';
}

export function summaryMd(results, { maxLines = 150 } = {}) {
  const r = results;
  if (r.mode === 'suites') return suitesSummary(r);
  const header = headerLines(r);
  const m = r.metrics;
  const rt = r.routes;
  const mu = r.mutants;

  const units = {
    failures: [
      ...r.failures.map((f) => unit(f.id, failureText(f), (f.lines ?? []).slice(1, 3).map((l) => `    ${l}`))),
      ...r.notRun.map((n) => unit(n.id, notRunText(n))),
    ],
    screens: [
      ...r.screens.filter((s) => s.status !== 'same').map((s) => unit(s.id, screenText(s))),
      ...(r.unmapped ?? []).map((u) => unit(u.id, unmappedText(u))),
    ],
    expectations: [
      ...r.expectations.map((e) => {
        const t = e.viewport === null ? (r.tests ?? []).find((x) => x.id === e.id) : null;
        return unit(e.id, expectationText(e), t ? testLines(t) : []);
      }),
      ...r.unexpected.map((u) => unit(u.id, unexpectedText(u))),
    ],
    tour: r.tour.new.map((t) => unit(t.id, `${tourText(t)}${standingMark(t)}`)),
    checks: [
      ...r.checks.new.map((c) => unit(c.id, `${checkText(c)}${standingMark(c)}`)),
      ...r.console.new.map((c) => unit(c.id, consoleText(c), [], true)),
    ],
    routes: [
      ...(r.routes?.new ?? []).map((x) => unit(x.id, routeText(x))),
      ...(r.routes?.unlisted ?? []).map((x) => unit(x.id, routeText(x))),
      ...(r.routes?.stale ?? []).map((x) => unit(x.id, routeText(x))),
    ],
    mutants: [
      ...(r.mutants?.survived ?? []).map((x) => unit(x.id, mutantText(x, 'survived'))),
      ...(r.mutants?.stale ?? []).map((x) => unit(x.id, mutantText(x, 'stale'))),
      ...(r.mutants?.notJudged ?? []).map((x) => unit(x.id, mutantText(x, 'notJudged'))),
    ],
    metrics: (m?.flags ?? []).map((f) => unit(f.id, metricText(f))),
    standing: [
      ...(r.chrome ?? []).map((c) => unit(c.id, `${c.text}: ${c.screens.length} screens — add to standing?`)),
      ...(r.standing.matched ?? []).map((x) => unit(x.id, `standing: ${x.text} — ${x.findings.length} finding(s) in this run, Notes, never gating`)),
    ],
  };

  const count_ = (st) => count(r.screens, (s) => s.status === st);
  const met = count(r.expectations, (e) => e.result === 'met');
  const notMet = count(r.expectations, (e) => e.result === 'NOT MET');
  const t = r.tour;
  const total = r.standing.checks + r.standing.tour + r.standing.console;
  const headings = {
    failures: `## Failures (${r.failures.length + r.notRun.length})`,
    screens: `## Screens — ${count_('same')} unchanged · ${count_('changed') + count_('drift')} changed · ${count_('new')} new · ${count_('gone')} removed · ${count_('MAP ERROR')} MAP ERROR · ${count_('failed')} failed`,
    expectations: `## Expectations — met ${met} · NOT MET ${notMet} · other ${r.expectations.length - met - notMet} · UNEXPECTED ${r.unexpected.length}`,
    tour: `## Tour — ${t.opened} opened · ${t.clipped} clipped · ${t.covered} covered · ${t.stuck} stuck · ${t.hoverAnswered}/${t.hoverTotal} hovers answer`,
    checks: `## Checks — ${r.checks.new.length} new · ${r.checks.standing} standing · ${r.checks.fixed} fixed · console ${r.console.new.length} new`,
    routes: !rt ? '## Routes — not run'
      : rt.notRun ? `## Routes — not run: ${rt.notRun}`
        : `## Routes — ${rt.probes} probes · ${rt.new.length} new · ${rt.standing} standing · ${rt.fixed} fixed · ${rt.unlisted.length} unlisted · ${rt.stale.length} stale`,
    mutants: mu
      ? `## Mutants — ${mu.killed}/${mu.run} killed · ${mu.survived.length} survived · ${mu.stale.length} stale · ${mu.notJudged.length} not judged (${mu.mode})${baselineNote(mu)}`
      : '## Mutants — not run',
    metrics: m ? `## Metrics — ${m.captures} captures, ${secs(m.msPerCapture)} each · ${m.flags.length} flag(s) · ${m.standing} standing` : '## Metrics — none',
  };
  const tails = {
    livedIn: `## Lived-in — ${r.livedIn ? 'see results.json' : 'not run'}`,
    standing: `## Standing — ${total} (${r.standing.checks} checks · ${r.standing.tour} tour · ${r.standing.console} console)${r.standing.file ? ` → ${r.standing.file} (+${r.standing.added} new)` : ''}`,
  };

  // Budget: header lines and the ten headings are fixed; items take what is left, section by
  // section, and a section that loses items spends one line on its more-line.
  const fixed = header.length + 10;
  let used = fixed;
  const body = {};
  SECTION_ORDER.forEach((name, i) => {
    const list = units[name];
    const later = SECTION_ORDER.slice(i + 1).filter((n) => units[n].length > 0).length;
    const need = list.reduce((n, u) => n + u.lines.length, 0);
    if (used + need + later <= maxLines) {
      body[name] = list.flatMap((u) => u.lines);
      used += need;
      return;
    }
    let room = Math.max(0, maxLines - used - later - 1);
    const kept = new Set();
    for (const [j, u] of list.entries()) {
      if (u.keep && u.lines.length <= room) { kept.add(j); room -= u.lines.length; }
    }
    for (const [j, u] of list.entries()) {
      if (u.keep) continue;
      if (u.lines.length > room) break;
      kept.add(j);
      room -= u.lines.length;
    }
    const lines = list.flatMap((u, j) => (kept.has(j) ? u.lines : []));
    lines.push(`- [more:${name}] ${list.length - kept.size} more in results.json`);
    body[name] = lines;
    used += lines.length;
  });

  const out = [
    ...header,
    headings.failures, ...body.failures,
    headings.screens, ...body.screens,
    headings.expectations, ...body.expectations,
    headings.tour, ...body.tour,
    headings.checks, ...body.checks,
    headings.routes, ...body.routes,
    headings.mutants, ...body.mutants,
    headings.metrics, ...body.metrics,
    tails.livedIn, tails.standing, ...body.standing,
  ];
  return out.join('\n') + '\n';
}
