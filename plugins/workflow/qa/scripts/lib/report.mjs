// report build (decision 17): holds the judge's verdict.md to the run that produced it (R1–R10),
// then renders report.html beside it. Pure: build-side I/O lives in qa.mjs `report build`.
// The judge's verdict.md format is in verdict.mjs's contract ("verdict.md, the judge's").
//
// CONTRACT (tests: test/report.test.mjs)
//
//   validateVerdict({ verdictMd, results, security = [], eyesMd = null, charterMd = null, waiversMd = null }) -> [{ rule, message }]
//     v = parseVerdict(verdictMd); d = draftVerdict(results, { security }) (the fixed table, recomputed,
//     never read from verdict.draft.md). Empty array = valid. rule is 'R1'..'R10'; one entry per
//     problem, in rule order, messages name the id or line at fault.
//     R1 header   v.verdict is ACCEPT, REJECT, NEEDS YOU or BLOCKED (1.0.0); v.slug === results.slug; v.head === results.head.sha;
//                 v.base === (results.base?.sha ?? 'none'); v.maps === first 12 of results.maps.head
//                 ('none' when absent); v.criteriaLine present; v.draft false; v.cost present.
//     R2 sections v.sections equals exactly ['Criteria','Expectations','Findings','Spec cases','Gaps',
//                 'Standing','Notes']; every section has at least one item line ('- none…' counts);
//                 each v.errors line is one R2 problem ('unreadable line: <line>').
//     R3 criteria every results.expectations id has a v.criteria row; no id twice; every status is
//                 PASS|FAIL|UNVERIFIABLE|BLOCKED|WAIVED; v.criteriaLine equals the rows counted by status.
//                 (1.0.0) An expectation row keeps the fixed table's status (verdict.mjs evidence), or is WAIVED;
//                 a WAIVED row has a waiver in waivers.md; every charter row that is not advisory has a Criteria
//                 row; a manual charter row is UNVERIFIABLE or WAIVED; a charter row citing an expectation whose
//                 row is FAIL is FAIL or WAIVED; a deciding UNVERIFIABLE row says what would prove it
//                 ('would prove it: …', or a manual row's 'ask: …').
//     R4 ids      every id in v.criteria, v.expectations, v.findings, v.gaps is known: an id in
//                 results (screens, failures, notRun, expectations, unexpected, tour.new, checks.new,
//                 console.new), a security entry id, a '- [ch:<n>]' id in charterMd, or (in v.gaps only) any
//                 'gap:<word>' id the judge adds (e.g. gap:log for a log line it could not read);
//                 every finding severity is Blocker|Major|Minor|Note ('judge' and 'eyes' rows are
//                 draft-only and are R4 problems here).
//     R5 table    every d.findings entry with severity Blocker|Major|Minor|Note (0.6.0: Note too, a page-check
//                 row a met test cleared; d is drafted with the eyes.md given, so an eyes-corroborated page
//                 check is Major here) is a v.findings row with
//                 the same id and the same severity (the fixed table is not the judge's to change).
//     R6 gate     (1.0.0) line 1 is the outcome verdict.mjs verdictOutcome gives for this verdict, the fixed table,
//                 the charter and the waivers ('line 1 is <word>; the gate gives <outcome>: <reasons>').
//     R7 unexpected  every results.unexpected id is a v.expectations row with resolution
//                 'explained' (non-empty text) or 'finding'; a 'finding' row's id is also a
//                 v.findings row; no row is left 'UNEXPECTED'.
//     R8 eyes     results.eyes non-empty -> eyesMd is present ('eyes.md is missing'); every
//                 results.eyes id has a parseEyes row with a non-null verdict; every 'wrong' row's id
//                 is a v.findings row whose severity is not Note.
//     R9 charter  charterMd is present ('charter.md is missing'); every '- [ch:<n>]' id in it appears
//                 in verdictMd inside '[…]' somewhere. A BLOCKED verdict with no charter.md is a block before any
//                 plan (round 1's prepare check): R9 does not apply to it.
//     R10 gaps    every d.gaps id is a v.gaps row; every v.specCases row has a path and a reason.
//
//   reportHtml({ verdictMd, summaryMd, results, eyes = [], shots = {} }) -> string
//     A whole HTML document, self-contained (inline CSS, no script, no external URL), light and dark
//     (prefers-color-scheme). Title '<verdict> — <slug>'. Shows, in order: the verdict word, slug,
//     head/base/maps and criteria line; the Criteria rows as a table; Findings, each with its
//     severity, id and text, and for an id with shots[id] = { before, after } (paths relative to
//     the html) the two images side by side, labelled base and branch (a missing one omitted);
//     Expectations, Spec cases, Gaps, Standing, Notes as lists; the eyes verdicts (id, verdict,
//     fix) when any; summary.md in a <pre>; the cost line. Every text from the inputs is HTML-escaped.
//
//   shotsFor(verdictMd, results) -> [id]
//     The scr: ids worth a picture: every scr:… id cited in the verdict's Findings plus every
//     results.eyes id, deduplicated, in that order. (The CLI copies their PNGs.)

//   STEP 6 (tests: test/report.test.mjs 'step 6'): knownIds also holds every id of
//     results.routes.new / unlisted / stale, results.mutants.survived / stale / notJudged and
//     results.metrics.flags (each list may be missing or null), plus 'gap:routes',
//     'gap:route-actors', 'gap:route-table' and 'gap:mutants'. A judge row for a met: id is replaced like an UNEXPECTED one: by a
//     Findings row (any severity) or dropped with a Notes line; R5 never requires it.

//   STEP 7 (tests: test/report.test.mjs 'step 7'):
//     reportHtml({ …, rebuilt = null }) — rebuilt: { host, at, head } → a first paragraph (class rebuilt) saying the
//     screenshots were rebuilt on <host> at <at> from head <head> and the judgement is the original run's.
//     reportHtml({ …, videos = [] }) — videos: [{ id, viewport, screen, src (relative to V),
//       checkpoints: [{ state, atMs, status }] }] (status = the results.screens status of
//       scr:<vp>/<screen>__<state>, or 'not captured'). When non-empty, a section 'Journeys' after the
//       verdict: per video a <video controls preload="metadata" src> and a list of checkpoints, each
//       a button '<state> · <status> · <s> s' that seeks the video (inline script: currentTime =
//       atMs / 1000). Escaped like every other text. No videos -> no section.

//   UNMAPPED: knownIds also holds every results.unmapped id.

//   ARTIFACT PAGE (rework U9; tests: test/publish.test.mjs): PAGE_CSS (exported) is the one stylesheet of report.html and
//     of every artifact page, in the Artifact page contract's shape: every colour a token on bare :root (light), redefined
//     under '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … color-scheme: dark } }' and again
//     under ':root[data-theme="dark"]'; body takes var(--bg); the side gutter is 'max(16px, env(safe-area-inset-*, 0px))'
//     with padding-block; wide tables scroll in their own box, never the page.
//     reportHtml({ …, fragment = false, place = {} }) — fragment: the artifact page, with no doctype, html, head or body
//       (the publisher wraps it): '<title><slug> QA report</title>' (a name that stays the same every round), the
//       '<meta name="claude:viewport-fit-sides" content="cover">' line and the <style> first, then the same <main>.
//       place: { [src]: { part, href } | { left: why } } (publish.mjs placeOf) — a picture or video whose src is there is
//       not shown: a link '<a class="part" data-part="<n>" href="<href>" …><label>: on part <n></a>' or a line
//       '<label>: not published (<why>)' stands in its place.

//   TESTS (0.4.0; tests: test/tests.test.mjs 'report'): reportHtml shows, after Criteria, a section 'Tests run'
//     when results.tests is non-empty: per record its id, result, the command qa ran (exit, seconds, side and
//     sha), the counts (matched of total, passed, failed, skipped, source), the base result when one ran, and
//     the output's last lines in a <pre>. Escaped like every other text. No tests -> no section.

import { parseEyes } from './eyes.mjs';
import { OUTCOMES, STATUSES, countRows, draftVerdict, evidence, parseCharter, parseVerdict, parseWaivers, verdictOutcome, waiverMap } from './verdict.mjs';
import { esc } from './util.mjs';

export const RULES = Object.freeze(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']);

const SECTIONS = ['Criteria', 'Expectations', 'Findings', 'Spec cases', 'Gaps', 'Standing', 'Notes'];
const short = (hash) => (hash ? String(hash).slice(0, 12) : 'none');

// The '- ' item lines of each '## ' section, in file order, the cost line excluded.
function sectionItems(md) {
  const out = [];
  let cur = null;
  for (const line of String(md ?? '').split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      cur = { name: line.slice(3).trim(), items: [] };
      out.push(cur);
    } else if (line.startsWith('cost: ')) cur = null;
    else if (cur && line.startsWith('- ')) cur.items.push(line.slice(2));
  }
  return out;
}

const charterIds = (charterMd) => [...String(charterMd ?? '').matchAll(/^- \[(ch:\d+)\]/gm)].map((m) => m[1]);

function knownIds(results, security, charterMd) {
  const ids = new Set();
  const add = (list) => { for (const x of list ?? []) ids.add(typeof x === 'string' ? x : x.id); };
  add(results.screens);
  add(results.failures);
  add(results.notRun);
  add(results.expectations);
  add(results.unexpected);
  add(results.tour?.new);
  add(results.checks?.new);
  add(results.console?.new);
  add(results.unmapped);
  add(results.routes?.new);
  add(results.routes?.unlisted);
  add(results.routes?.stale);
  add(results.mutants?.survived);
  add(results.mutants?.stale);
  add(results.mutants?.notJudged);
  add(results.metrics?.flags);
  add(['gap:routes', 'gap:route-actors', 'gap:route-table', 'gap:mutants', 'fail:compare']);
  add(security);
  add(charterIds(charterMd));
  return ids;
}

export function validateVerdict({ verdictMd, results, security = [], eyesMd = null, charterMd = null, waiversMd = null }) {
  const v = parseVerdict(verdictMd);
  const eyesRows = eyesMd == null ? null : parseEyes(eyesMd);
  const d = draftVerdict(results, { security, eyes: eyesRows, charterMd, waiversMd });
  const charter = parseCharter(charterMd);
  const waivers = waiverMap(parseWaivers(waiversMd));
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message });

  // R1 header
  if (!OUTCOMES.includes(v.verdict)) add('R1', `the verdict word is ${v.verdict ?? 'missing'}, not ${OUTCOMES.join(', ')}`);
  if (v.slug !== results.slug) add('R1', `slug is ${v.slug ?? 'missing'}, the run is ${results.slug}`);
  if (v.head !== results.head.sha) add('R1', `head is ${v.head ?? 'missing'}, the run is ${results.head.sha}`);
  const base = results.base?.sha ?? 'none';
  if (v.base !== base) add('R1', `base is ${v.base ?? 'missing'}, the run is ${base}`);
  const maps = short(results.maps?.head);
  if (v.maps !== maps) add('R1', `maps is ${v.maps ?? 'missing'}, the run is ${maps}`);
  if (!v.criteriaLine) add('R1', 'the criteria line is missing');
  if (v.draft) add('R1', 'the draft line is still there: the judge writes verdict.md, not a draft');
  if (!v.cost) add('R1', 'the cost line is missing');

  // R2 sections
  const found = sectionItems(verdictMd);
  if (v.sections.join('\n') !== SECTIONS.join('\n')) add('R2', `sections are [${v.sections.join(', ')}], expected [${SECTIONS.join(', ')}]`);
  for (const sec of found) if (sec.items.length === 0) add('R2', `section ${sec.name} has no item line (use '- none')`);
  for (const line of v.errors) add('R2', `unreadable line: ${line}`);

  // R3 criteria
  const rowIds = new Set();
  for (const c of v.criteria) {
    if (rowIds.has(c.id)) add('R3', `criterion ${c.id} appears twice`);
    rowIds.add(c.id);
    if (!STATUSES.includes(c.status)) add('R3', `criterion ${c.id} has status ${c.status}`);
  }
  const rowOf = new Map(v.criteria.map((c) => [c.id, c]));
  for (const e of results.expectations) {
    const row = rowOf.get(e.id);
    if (!row) { add('R3', `expectation ${e.id} has no criteria row`); continue; }
    const table = evidence(e, results).status;
    if (row.status !== table && row.status !== 'WAIVED') add('R3', `[${e.id}] is ${table} by the fixed table, ${row.status} in the verdict`);
  }
  for (const c of v.criteria) if (c.status === 'WAIVED' && !waivers.has(c.id)) add('R3', `[${c.id}] is WAIVED with no waiver for it in waivers.md`);
  const deciding = (id) => (charter.length ? charter.some((c) => c.id === id && !c.advisory) : true);
  for (const c of charter) {
    const row = rowOf.get(c.id);
    // Cited nowhere is R9's; cited only in Findings or Gaps is this rule's: a criterion that decides needs its own row.
    if (!row && !c.advisory && new RegExp(`\\[[^\\]]*\\b${c.id}(?!\\d)`).test(String(verdictMd ?? ''))) add('R3', `charter row ${c.id} has no Criteria row (it decides: rule it there)`);
    if (row && c.manual && !['UNVERIFIABLE', 'WAIVED'].includes(row.status)) add('R3', `[${c.id}] is manual: UNVERIFIABLE with its ask, or WAIVED, never ${row.status}`);
    const failed = c.expectations.flatMap((n) => v.criteria.filter((x) => x.status === 'FAIL' && (x.id === `exp:${n}` || x.id.startsWith(`exp:${n}@`))));
    if (row && failed.length && !['FAIL', 'WAIVED'].includes(row.status)) add('R3', `[${c.id}] is ${row.status}, but the expectation it cites failed: ${failed[0].id}`);
  }
  for (const c of v.criteria) {
    if (c.status === 'UNVERIFIABLE' && deciding(c.id) && !/would prove it: |ask: /.test(c.detail)) add('R3', `[${c.id}] is open: say what would prove it (' — would prove it: …')`);
  }
  if (v.criteriaLine) {
    const want = countRows(v.criteria);
    const got = v.criteriaLine;
    if (['pass', 'fail', 'unverifiable', 'blocked', 'waived'].some((k) => got[k] !== want[k])) {
      add('R3', `the criteria line says ${got.pass} pass · ${got.fail} fail · ${got.unverifiable} unverifiable · ${got.blocked} blocked · ${got.waived} waived, the rows count ${want.pass} pass · ${want.fail} fail · ${want.unverifiable} unverifiable · ${want.blocked} blocked · ${want.waived} waived`);
    }
  }

  // R4 ids
  const known = knownIds(results, security, charterMd);
  const unknown = (id, where, gap = false) => {
    // Without charter.md a ch: id cannot be judged; R9 already reports the missing file.
    if (charterMd == null && /^ch:\d+$/.test(id)) return;
    if (!known.has(id) && !(gap && /^gap:\w+$/.test(id))) add('R4', `${where} cites ${id}, which is not in this run`);
  };
  for (const c of v.criteria) unknown(c.id, 'Criteria');
  for (const x of v.expectations) unknown(x.id, 'Expectations');
  for (const f of v.findings) {
    unknown(f.id, 'Findings');
    if (!['Blocker', 'Major', 'Minor', 'Note'].includes(f.severity)) add('R4', `finding ${f.id} has severity ${f.severity}, which only a draft uses`);
  }
  for (const g of v.gaps) unknown(g.id, 'Gaps', true);

  // R5 table
  for (const f of d.findings) {
    if (!['Blocker', 'Major', 'Minor', 'Note'].includes(f.severity)) continue;
    const row = v.findings.find((x) => x.id === f.id);
    if (!row) add('R5', `the fixed table has ${f.severity} [${f.id}], the verdict has no such Findings row`);
    else if (row.severity !== f.severity) add('R5', `[${f.id}] is ${f.severity} in the fixed table, ${row.severity} in the verdict`);
  }

  // R6 gate: line 1 is what the gate gives.
  if (OUTCOMES.includes(v.verdict)) {
    const g = verdictOutcome({ verdictMd, results, security, eyes: eyesRows, charterMd, waiversMd });
    if (g.outcome !== v.verdict) {
      const why = [
        g.fail.length && `failing ${g.fail.join(', ')}`, g.blockers.length && `gating ${g.blockers.join(', ')}`,
        g.blocked.length && `blocked ${g.blocked.join(', ')}`, g.open.length && `open ${g.open.join(', ')}`,
      ].filter(Boolean).join('; ');
      add('R6', `line 1 is ${v.verdict}; the gate gives ${g.outcome}${results.blocked ? ' (the run is blocked)' : ''}${why ? `: ${why}` : ''}`);
    }
  }

  // R7 unexpected
  for (const x of v.expectations) if (x.resolution === 'UNEXPECTED') add('R7', `[${x.id}] is still UNEXPECTED: explain it or make it a finding`);
  for (const u of results.unexpected) {
    const row = v.expectations.find((x) => x.id === u.id);
    if (!row) add('R7', `unexpected ${u.id} has no Expectations row`);
    else if (row.resolution === 'explained' && !row.text.trim()) add('R7', `[${u.id}] is explained with no reason`);
    else if (row.resolution === 'finding' && !v.findings.some((f) => f.id === u.id)) add('R7', `[${u.id}] is a finding with no Findings row`);
  }

  // R8 eyes
  const eyes = eyesMd == null ? [] : parseEyes(eyesMd);
  if (results.eyes.length && eyesMd == null) add('R8', 'eyes.md is missing');
  else if (eyesMd != null) {
    for (const id of results.eyes) {
      const row = eyes.find((e) => e.id === id);
      if (!row || !row.verdict) add('R8', `eyes.md has no verdict for ${id}`);
    }
    for (const e of eyes) {
      if (e.verdict === 'wrong' && !v.findings.some((f) => f.id === e.id && f.severity !== 'Note')) {
        add('R8', `eyes judged ${e.id} wrong, and the Findings have no non-Note row for it`);
      }
    }
  }

  // R9 charter. A BLOCKED verdict with no charter was blocked before any plan: there is no charter row to cite.
  if (charterMd == null) {
    if (v.verdict !== 'BLOCKED') add('R9', 'charter.md is missing');
  } else {
    for (const id of charterIds(charterMd)) {
      if (!new RegExp(`\\[[^\\]]*\\b${id}(?!\\d)[^\\]]*\\]`).test(String(verdictMd ?? ''))) add('R9', `charter row ${id} is cited nowhere in the verdict`);
    }
  }

  // R10 gaps
  for (const g of d.gaps) if (!v.gaps.some((x) => x.id === g.id)) add('R10', `the run has the gap ${g.id}, the verdict's Gaps do not list it`);
  for (const c of v.specCases) if (!c.path.trim() || !c.reason.trim()) add('R10', `spec case '${c.path}: ${c.reason}' needs a path and a reason`);

  return problems;
}

export function shotsFor(verdictMd, results) {
  const ids = parseVerdict(verdictMd).findings.map((f) => f.id).filter((id) => id.startsWith('scr:'));
  return [...new Set([...ids, ...results.eyes])];
}

export const PAGE_CSS = `
:root { --bg: #ffffff; --fg: #1b1f24; --muted: #5b6470; --line: #d5d9df; --card: #f5f6f8; --accent: #0b5cad; --bad: #b3261e; --ok: #1d6f3a; --warn: #8a5a00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #14171b; --fg: #e6e9ed; --muted: #a0a8b3; --line: #343a42; --card: #1d2227; --accent: #6cb0f0; --bad: #ff8a80; --ok: #7bd49a; --warn: #f0c05a; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #14171b; --fg: #e6e9ed; --muted: #a0a8b3; --line: #343a42; --card: #1d2227; --accent: #6cb0f0; --bad: #ff8a80; --ok: #7bd49a; --warn: #f0c05a; color-scheme: dark; }
* { box-sizing: border-box; }
.rebuilt { border: 2px solid var(--warn); border-radius: 6px; padding: 8px 12px; background: var(--card); }
body { margin: 0; padding-block: 24px 48px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; min-width: 0; }
h1 { margin: 0 0 4px; font-size: 1.6rem; text-wrap: balance; overflow-wrap: anywhere; }
h2 { margin: 28px 0 8px; font-size: 1.1rem; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
a { color: var(--accent); }
code, pre, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85rem; overflow-wrap: anywhere; }
pre { background: var(--card); border: 1px solid var(--line); padding: 12px; overflow-x: auto; white-space: pre-wrap; }
.meta { color: var(--muted); margin: 0; }
.verdict { display: inline-block; padding: 2px 10px; border-radius: 4px; font-weight: 700; border: 1px solid var(--line); }
.ACCEPT, .PASS, .fine { color: var(--ok); }
.REJECT, .FAIL, .Blocker, .wrong { color: var(--bad); }
.Major, .UNVERIFIABLE, .look-again, .NEEDS-YOU, .BLOCKED, .WAIVED { color: var(--warn); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
ul { padding-left: 20px; }
li.finding { margin-bottom: 12px; }
.shots, .media { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; }
figure { margin: 0; max-width: 100%; min-width: 0; }
figure img { max-width: 100%; height: auto; border: 1px solid var(--line); }
figure.away { border: 1px dashed var(--line); border-radius: 4px; padding: 8px 12px; color: var(--muted); }
video { max-width: 100%; display: block; margin: 6px 0; }
.checkpoints { list-style: none; padding-left: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.checkpoints button { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 4px 10px; cursor: pointer; }
.checkpoints button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
figcaption { color: var(--muted); font-size: 0.8rem; }
`;

const list = (items) => (items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="meta">none</p>');

const seconds = (ms) => `${(Number(ms ?? 0) / 1000).toFixed(1)} s`;

// The Journeys section: one video per recorded journey, one seek button per checkpoint. A
// checkpoint's status is its own when it has one, else the results.screens status of
// scr:<vp>/<screen>__<state>, else 'not captured'.
// A picture or video the page does not show itself (publish.mjs placeOf): a link to the part that holds it, or why it
// was not published. null when it is shown in place.
function away(label, src, place) {
  const p = place?.[src];
  if (!p) return null;
  if (p.left) return `<figure class="away"><figcaption>${esc(label)}: not published (${esc(p.left)})</figcaption></figure>`;
  return `<figure class="away"><a class="part" data-part="${esc(p.part)}" href="${esc(p.href)}" target="_blank" rel="noopener">${esc(label)}: on part ${esc(p.part)}</a></figure>`;
}

function journeysHtml(videos, results, place = {}) {
  if (!videos?.length) return '';
  const statusOf = new Map((results?.screens ?? []).map((s) => [s.id, s.status]));
  const blocks = videos.map((v) => {
    const buttons = (v.checkpoints ?? []).map((cp) => {
      const status = cp.status ?? statusOf.get(`scr:${v.viewport}/${v.screen}__${cp.state}`) ?? 'not captured';
      return `<li><button type="button" data-at="${esc(cp.atMs)}">${esc(cp.state)} · ${esc(status)} · ${esc(seconds(cp.atMs))}</button></li>`;
    });
    const player = away(`${v.id} · ${v.screen} ${v.viewport}`, v.src, place) ?? `<video controls preload="metadata" src="${esc(v.src)}"></video>`;
    return `<section class="journey"><h3><code>${esc(v.id)}</code> ${esc(v.screen)} <span class="meta">${esc(v.viewport)}</span></h3>
${player}
<ul class="checkpoints">${buttons.join('')}</ul></section>`;
  });
  const script = `document.querySelectorAll('.journey button[data-at]').forEach(function (b) {
  b.addEventListener('click', function () {
    var video = b.closest('.journey').querySelector('video');
    if (!video) return;
    video.currentTime = Number(b.getAttribute('data-at')) / 1000;
    video.play();
  });
});`;
  return `<h2>Journeys</h2>\n${blocks.join('\n')}\n<script>${script}</script>\n`;
}

// rebuilt: { host, at, head } when the screenshots were captured again elsewhere than the judgement (a report rebuilt on another machine): a banner says so plainly, above everything else.
export function rebuiltBanner(rebuilt) {
  if (!rebuilt) return '';
  return `<p class="rebuilt"><strong>Rebuilt report.</strong> The screenshots were rebuilt on ${esc(rebuilt.host)} at ${esc(rebuilt.at)} `
    + `from head ${esc(rebuilt.head ?? '')}. The judgement (verdict, criteria, findings, eyes) is the original run's, unchanged.</p>\n`;
}

const TEST_CLASS = { met: 'PASS', 'NOT MET': 'FAIL' };

// The named tests qa ran: what ran, what the runner counted, how the output ended.
function testsHtml(tests) {
  if (!tests.length) return '';
  const rows = tests.map((t) => {
    const c = t.counts ?? {};
    const where = `${t.side ?? 'head'}${t.at ? ` ${String(t.at).slice(0, 12)}` : ''}`;
    const ran = t.command
      ? `<code>${esc(t.command)}</code> <span class="meta">exit ${esc(t.exit ?? 'none')}${t.timedOut ? ' (timed out)' : ''} · ${Math.round((t.ms ?? 0) / 1000)} s · ${esc(where)}</span>`
      : '<span class="meta">not run</span>';
    const base = t.base ? `<br><span class="meta">base: ${esc(t.base.notRun ? `not run: ${t.base.notRun}` : `${t.base.result} — ${t.base.why ?? ''}`)}</span>` : '';
    const tail = (t.tail ?? []).length ? `<pre>${esc(t.tail.join('\n'))}</pre>` : '';
    return `<li><code>${esc(t.id)}</code> <strong class="${esc(TEST_CLASS[t.result] ?? 'UNVERIFIABLE')}">${esc(t.result)}</strong> ${esc(t.why ?? t.detail ?? '')}<br>${ran}`
      + `<br><span class="meta">${c.matched ?? 0} matched of ${c.total ?? 0} · ${c.passed ?? 0} passed · ${c.failed ?? 0} failed · ${c.skipped ?? 0} skipped (${esc(t.source ?? 'none')})</span>${base}${tail}</li>`;
  });
  return `<h2>Tests run</h2>\n<p class="meta">Named tests qa ran itself in the sandbox worktree at the commit shown; a test that matched nothing or was skipped is not a pass.</p>\n<ul>${rows.join('')}</ul>\n`;
}

export function reportHtml({ verdictMd, summaryMd, results, eyes = [], shots = {}, videos = [], rebuilt = null, fragment = false, place = {} }) {
  const v = parseVerdict(verdictMd);
  const sections = sectionItems(verdictMd);
  const items = (name) => sections.filter((s) => s.name === name).flatMap((s) => s.items);
  const word = v.verdict ?? 'UNKNOWN';
  const slug = v.slug ?? results?.slug ?? '';
  const c = v.criteriaLine;

  const criteria = v.criteria.length
    ? `<div class="table-wrap"><table><thead><tr><th>id</th><th>status</th><th>criterion</th><th>detail</th></tr></thead><tbody>${v.criteria
      .map((r) => `<tr><td class="mono">${esc(r.id)}</td><td class="${esc(r.status)}">${esc(r.status)}</td><td>${esc(r.name)}</td><td>${esc(r.detail)}</td></tr>`)
      .join('')}</tbody></table></div>`
    : '<p class="meta">none</p>';

  const image = (label, src, id) => {
    if (!src) return '';
    return away(`${id} · ${label}`, src, place)
      ?? `<figure><img src="${esc(src)}" alt="${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`;
  };
  const findings = v.findings.length
    ? `<ul>${v.findings
      .map((f) => {
        const shot = shots[f.id];
        const pics = shot && (shot.before || shot.after) ? `<div class="shots">${image('base', shot.before, f.id)}${image('branch', shot.after, f.id)}</div>` : '';
        const files = f.files.length ? ` <span class="meta">files: ${esc(f.files.join(', '))}</span>` : '';
        return `<li class="finding"><strong class="${esc(f.severity)}">${esc(f.severity)}</strong> <code>${esc(f.id)}</code> ${esc(f.text)}${files}${pics}</li>`;
      })
      .join('')}</ul>`
    : '<p class="meta">none</p>';

  const testsBlock = testsHtml(results?.tests ?? []);

  const eyesBlock = eyes.length
    ? `<h2>Eyes</h2><ul>${eyes
      .map((e) => `<li><code>${esc(e.id)}</code> <strong class="${esc(String(e.verdict ?? '').replace(/\s+/g, '-'))}">${esc(e.verdict ?? 'no verdict')}</strong>${e.fix ? ` — ${esc(e.fix)}` : ''}</li>`)
      .join('')}</ul>`
    : '';

  const head = fragment
    ? `<title>${esc(`${slug} QA report`)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${PAGE_CSS}</style>
`
    : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${word} — ${slug}`)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
`;
  return `${head}<main>
${rebuiltBanner(rebuilt)}<h1><span class="verdict ${esc(word.replace(/\s+/g, '-'))}">${esc(word)}</span> ${esc(slug)}</h1>
<p class="meta mono">head: ${esc(v.head ?? '')}<br>base: ${esc(v.base ?? '')}<br>maps: ${esc(v.maps ?? '')}</p>
<p>${c ? `${c.pass} pass · ${c.fail} fail · ${c.unverifiable} unverifiable · ${c.blocked} blocked · ${c.waived} waived` : ''}</p>
${journeysHtml(videos, results, place)}<h2>Criteria</h2>
${criteria}
${testsBlock}<h2>Findings</h2>
${findings}
<h2>Expectations</h2>
${list(items('Expectations'))}
<h2>Spec cases</h2>
${list(items('Spec cases'))}
<h2>Gaps</h2>
${list(items('Gaps'))}
<h2>Standing</h2>
${list(items('Standing'))}
<h2>Notes</h2>
${list(items('Notes'))}
${eyesBlock}
<h2>Summary</h2>
<pre>${esc(summaryMd)}</pre>
<p class="meta mono">${esc(v.cost ?? '')}</p>
</main>
${fragment ? '' : '</body>\n</html>\n'}`;
}
