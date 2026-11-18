// Rounds (rework U8, design 2026-11-12 §9, §15 and §17 answer 5): each verify of a slug is round N. Round 1 is the full
// flow; a round after a REJECT, NEEDS YOU or BLOCKED re-runs only the rows that failed or were open and the rows whose
// evidence the fix diff touches, and carries every other row, pinned to the sha its evidence ran on. A criterion that
// FAILed in ROUND_CAP rounds stops the loop (verdict.mjs ROUNDS). Replaces tiers 1–3, `stop`, `qa tier`,
// `verdict --tier1` and the judge resumed by agent id. Pure: git, files and maps are read by qa.mjs and run.mjs and
// passed in (qaHashes alone reads files, through an injectable reader). Nothing names an app, library or screen: every
// rule reads git (the changed files), the verdict (row statuses, gating ids), the map (entries, sources, flows) or qa.json.
//
// FILES (qa/<slug>/)
//   round.json   this round's plan, written by `qa round plan` for HEAD (the RoundPlan below); `qa run` reads it
//                when its head is the run's head.
//   rounds.json  { rounds: [RoundRecord] }: every earlier round, recorded from its final verdict.md when the next round
//                is planned (one record per head; a later verdict of the same head replaces it).
//
// CONTRACT (tests: test/rounds.test.mjs; the CLI's side: test/cli-round.test.mjs; the run's: test/rounds-run.test.mjs)
//
//   entryKeys(map) -> { screenName: key }   key = the sorted sha256 (16 hex) of affected.mjs entryKey of every screen of
//     that name, joined with ','; equal for equal entries (and the flows they walk); null map -> {}.
//
//   fixScreens({ head, prevKeys, changed, sources, own = null }) -> { names, why }
//     The screens the fix diff touches, by the affected-set rules against the LAST ROUND (not the base): per head
//     screen, the first that applies: 'new entry' (no key last round), 'entry changed' (another key), 'sources: <file>'
//     (a screen.sources glob matches a changed file), 'source: <file>' (a changed file is in sources[name]); then
//     'journey through <name>' for a record: true screen sharing a flow with one of those. Head order, each name once.
//     own (a Set): the entry keys are compared only for those names, the PR's own entries; null: every screen.
//
//   qaHashes({ root, profile, overlay = null, read }) -> { profile, seed, routes: { file: hash }, overlayRoutes }
//     What the run read besides git, so a change to QA files kept off the product branches is seen too: profile = hash of
//     qa.json as loaded (overlay key left out), seed = hash of the seed names file (null when none), routes = the hash of
//     each routeTableFiles(profile) file that exists, overlayRoutes = hash of <overlay>/routes.json (null when none).
//     read(abs) -> Buffer | null (default: the file, or null when missing). Hashes are sha256, 16 hex.
//
//   planRound({ n, head, base, spec, full, prev, charterMd, expectations, mutants, headMap, sources, changed, profile, qa,
//               securityMd, suites, history, scope = null }) -> RoundPlan
//     scope: the PR's affected set against its base ({ names, why }: run.mjs planAffected, affected.mjs affectedScreens:
//     its overlay, sources, entries new or changed against the base), or null when unknown. With a scope, an incremental
//     round walks only screens in it (what follows, intersected with scope.names), and fixScreens compares entry keys
//     with the last round only for the PR's own entries: those in scope that its overlay holds (headMap.overlay.screens),
//     or, with no overlay (the map is the branch's own), every entry in scope. So an entry another PR's merge promoted
//     into the shared map is never new for this PR.
//     prev = { round, head, base, spec, verdict: parseVerdict(last verdict.md), results: its results.json, security: the
//     last round.json's security } | null. changed = git diff --name-only <prev.head> <head> (null: prev.head unknown).
//     A FULL round (today's whole flow, the planner included) when the first applies, why:
//       '--full' | 'round 1' (no prev, n 1) | 'no earlier verdict to carry from' (no prev) | 'no verdict for round <m>' |
//       'round <m> was an ACCEPT: a new commit needs a new check' | 'no results for round <m>' (none, not diff mode, or not
//       of the verdict's head) | 'round <m> checked nothing: <results.blocked line 1>' | 'round <m> compared nothing:
//       <compareError>' | 'no plan to carry: charter.md or expectations.json is missing' | 'the head of round <m>
//       (<sha12>) is not in this repo' | 'the spec changed since round <m>' | 'the base moved: <old12> → <new12>' |
//       '<qa.json | the seed names file> changed' (in changed, or its qaHashes differ) | 'round <m> recorded no map entries'
//     A full plan: { round: n, head, base, spec, of: 'full', why, from: prev ? { round, head } : null, changed: changed ??
//       [], screens: null, screensWhy: {}, expectations: null, rerun: [], carried: [], reasons: {}, routes: true, mutants:
//       true, security: { rerun: true, why: 'a full round', paths: [], from: { round: n, head } }, history, carry: null }.
//     Else INCREMENTAL. An expectation re-runs (reasons[exp id]) when, the first that applies:
//       (a) it has no result last round ('no result in round <m>'), its row was not PASS or WAIVED ('<STATUS> in round
//           <m>'), or a charter row citing it was not ('cited by <ch> (<STATUS> in round <m>)');
//       (b) the fix touches its evidence: a screen row whose screens glob (the part before '__') names a fixScreens
//           screen ('screen <s>: <why>'); a test row whose test.file changed ('its test file <f> changed'), when a suites
//           file (suites.mjs SUITES_FILES) changed ('the suites file <f> changed'), or when a changed file matches its
//           suite's `covers` globs ('its suite <id> covers <f>'); a route row when route code (paths.mjs isRouteCode), a
//           route table file, or a route hash in qa changed ('route code or table changed: <first>'); a doc row whose
//           doc.file changed ('its doc <f> changed'); any other kind always ('not a screen, test, route or doc row: it
//           runs every round');
//       (c) a screen row whose screen is walked anyway ('its screen <s> is walked anyway'): its check costs nothing more.
//     The walk (screens, screensWhy; head map order): fixScreens; the screens of re-run screen rows ('for exp:<name>');
//       the `by: screen <s>/<state>` of re-run charter rows ('cited by <ch>'); the screen of each Blocker or ' — gates: '
//       finding ('<id> gated in round <m>') and of each 'BLOCKED — ' gap ('<id> was BLOCKED in round <m>') last round.
//     A charter row (not manual) re-runs when its row was not PASS or WAIVED; when an expectation it cites re-runs ('its
//       evidence re-runs'); when a screen it cites is walked ('its screen <s> is walked'); or, citing neither or `eyes`,
//       when any screen is walked ('ruled from what the walk shows'). Else it is CARRIED. A manual row is neither: the
//       draft writes it from the charter.
//     routes: a route row re-runs, route code or a table changed, or last round had a route Blocker or a gap:route* gap.
//     mutants: a proposal's file or kill.file changed, or proposals exist and last round ran none.
//     security: paths = paths.mjs securityPaths(changed, { profile, routesChanged: overlay route hash changed }) ->
//       { rerun: true, why: 'the fix touches <files>', paths, from: { round: n, head } }; else a High in securityMd ->
//       { rerun: true, why: 'round <m> found a High: <sec id>', paths: [], from: this round }; else { rerun: false, why:
//       'the fix touches no sensitive, auth, role, session, route or migration path', paths: [], from: prev.security.from
//       ?? { round: m, head: prev.head } }.
//     The incremental plan: { …the full plan's keys, of: 'incremental', why: 'after round <m>', screens, screensWhy,
//       expectations: [re-run names, plan order], rerun: [exp ids (plan order), then ch ids (charter order)], carried:
//       [the same for carried rows], reasons: { id: why }, routes, mutants, security, history, carry: { criteria, expectations,
//       tests, docs, routes, mutants } }. Carried criteria: { id, status, name, detail (any carried tail cut), sha, round }
//       — sha and round from last round's results.round.criteria when it was carried there, else last round's head.
//       Carried expectations, tests and docs: last round's entries (results order) of plan names that do not re-run, each
//       { …entry, detail: carried.detail, carried: entry.carried ?? { round: m, sha: last head, detail } }. routes /
//       mutants: last round's result with carried ({ round, sha }) when off this round, else null.
//
//   roundLines(plan) -> [string]   what `qa round plan` prints:
//     'round <n>: full — <why>' | 'round <n>: incremental from round <m> (<sha12>) — <k> file(s) changed', then for an
//     incremental round 're-run: <id> (<why>), …' (or 're-run: none'), 'carried: <c> row(s), each says carried from
//     <sha>', 'walk: <s> (<why>), …' (or 'walk: none'), 'routes: carried|re-run · mutants: carried|re-run', 'security:
//     re-run — <why>' or 'security: carried from round <k> (<sha12>) — <why>'; then, for each id of history
//     (any round): 'history: <id> failed in <c> earlier round(s); at 3 the verdict is NEEDS YOU (round cap)'.
//
//   carryInto(results, plan, { entries, qa }) -> results   (run.mjs, before results.json is written)
//     plan null -> results unchanged. Else results.round = { n, of, why, from, screens, rerun, carried, history, security,
//     criteria, entries, qa } (criteria: carry.criteria, each detail + ' — carried from <sha12> (round <r>)'; [] when
//     full). An incremental plan also appends carry.expectations / tests / docs whose name the run did not produce (detail
//     + the same tail), and sets routes / mutants from carry when the run has none.
//
//   roundRecord({ verdict, roundJson, results, last, at }) -> RoundRecord
//     { round: roundJson.round ?? last + 1, head: verdict.head, base: verdict.base, spec: roundJson.spec ?? null, of:
//       roundJson.of ?? 'full', outcome: verdict.verdict, at, security: roundJson.security.from ?? null,
//       rows: [{ id, status, sha, round }] per Criteria row — sha/round of a carried row (roundJson.carry.criteria, or a
//       results expectation's carried) or this round's head and number }.
//   recordRound(doc, record) -> { rounds }   the record of the same head replaced, else appended; ordered by round.
//   lastRound(doc) -> the highest round recorded, 0 when none.
//   capHistory(rounds, spec, ids = null) -> { id: n }   per row id, the recorded rounds it FAILed in, counting only rounds
//     whose spec equals spec (a null on either side counts): a spec change clears the cap. ids (a Set): only those rows
//     (the CLI passes the charter's deciding rows when there is a charter: expectation rows are evidence, never capped).
//   specHash(text) -> sha256 16 hex | null (no text).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chainOf, entryKey } from './affected.mjs';
import { glob } from './util.mjs';
import { ROUND_CAP, parseCharter, parseSecurity } from './verdict.mjs';
import { isRouteCode, routeTableFiles, securityPaths } from './paths.mjs';
import { SUITES_FILES } from './suites.mjs';

const PASSED = ['PASS', 'WAIVED'];
const hash = (x) => createHash('sha256').update(x).digest('hex').slice(0, 16);
const short = (sha) => String(sha ?? '').slice(0, 12);
const firstLine = (s) => String(s ?? '').split('\n')[0];
const toList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x) => typeof x === 'string');
export const CARRIED_TAIL = / — carried from [0-9a-f]+ \(round \d+\)$/;
export const carriedTail = (sha, round) => ` — carried from ${short(sha)} (round ${round})`;
export const stripCarried = (s) => String(s ?? '').replace(CARRIED_TAIL, '');
export const specHash = (text) => (typeof text === 'string' ? hash(text) : null);

// ── map entries and the screens a fix touches ────────────────────────────────

export function entryKeys(map) {
  const out = {};
  for (const s of map?.screens ?? []) {
    if (typeof s?.name !== 'string') continue;
    (out[s.name] ??= []).push(hash(entryKey(s, map.flows ?? {})));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort().join(',')]));
}

export function fixScreens({ head, prevKeys = {}, changed = [], sources = {}, own = null }) {
  const screens = (head?.screens ?? []).filter((s) => typeof s?.name === 'string');
  const flows = head?.flows ?? {};
  const now = entryKeys(head);
  const globsOf = (s) => toList(s.sources).map(glob);
  const reasonOf = (s) => {
    if (!own || own.has(s.name)) {
      if (!Object.hasOwn(prevKeys ?? {}, s.name)) return 'new entry';
      if (prevKeys[s.name] !== now[s.name]) return 'entry changed';
    }
    const byGlob = changed.find((f) => globsOf(s).some((re) => re.test(f)));
    if (byGlob !== undefined) return `sources: ${byGlob}`;
    const recorded = new Set(Array.isArray(sources?.[s.name]) ? sources[s.name] : []);
    const byRecord = changed.find((f) => recorded.has(f));
    return byRecord === undefined ? null : `source: ${byRecord}`;
  };
  const reasons = screens.map(reasonOf);
  const chains = screens.map((s) => new Set(chainOf(s, flows)));
  for (const [i, s] of screens.entries()) {
    if (reasons[i] !== null || s.record !== true) continue;
    const j = screens.findIndex((_, k) => reasons[k] !== null && !reasons[k].startsWith('journey') && [...chains[k]].some((f) => chains[i].has(f)));
    if (j !== -1) reasons[i] = `journey through ${screens[j].name}`;
  }
  const why = {};
  for (const [i, s] of screens.entries()) if (reasons[i] !== null && !Object.hasOwn(why, s.name)) why[s.name] = reasons[i];
  return { names: Object.keys(why), why };
}

const readOr = (abs) => {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
};

export function qaHashes({ root, profile = {}, overlay = null, read = readOr }) {
  const { overlay: dropped, ...plain } = profile ?? {};
  void dropped;
  const fileHash = (abs) => {
    const bytes = read(abs);
    return bytes == null ? null : hash(bytes);
  };
  const routes = {};
  for (const rel of routeTableFiles(plain)) {
    const h = fileHash(path.resolve(root, rel));
    if (h) routes[rel] = h;
  }
  return {
    profile: hash(JSON.stringify(plain)),
    seed: fileHash(path.resolve(root, plain.seedNames ?? 'qa/seed.json')),
    routes,
    overlayRoutes: overlay ? fileHash(path.join(overlay, 'routes.json')) : null,
  };
}

// ── the plan of a round ──────────────────────────────────────────────────────

const kindOf = (e) => (e?.test !== undefined ? 'test' : e?.doc !== undefined ? 'doc' : e?.route !== undefined ? 'route' : e?.screens !== undefined ? 'screen' : 'other');
const criteriaOf = (e) => String(e?.criterion ?? '').split(/[\s,]+/).filter((x) => /^ch:\d+$/.test(x));

// The screens and eyes a charter row cites in its `by:` part.
function charterEvidence(md) {
  const out = new Map();
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const m = line.match(/^- \[(ch:\d+)\] (.*)$/);
    if (!m) continue;
    const by = m[2].replace(/ — advisory\s*$/, '').match(/ — by: (.*?)(?= — |$)/)?.[1] ?? '';
    const screens = [...by.matchAll(/\bscreens? ([^\s,;+]+)/g)].map((x) => x[1].split('/')[0]).filter(Boolean);
    out.set(m[1], { screens, eyes: /\beyes\b/.test(by) });
  }
  return out;
}

// The screen a summary id names: scr:/chk:/tour:/con:/unx:/met: <vp>/<screen>__<state>…, fail:/nrun: head/<vp>/<screen>.
function screenOfId(id) {
  const pair = /^(?:scr|chk|tour|con|unx|met):[^/]+\/([^/]+)/.exec(String(id));
  if (pair) return pair[1].split('__')[0];
  return /^(?:fail|nrun):head\/[^/]+\/(.+)$/.exec(String(id))?.[1] ?? null;
}

function fullWhy({ n, full, prev, charterMd, expectations, changed, spec, base, profile, qa }) {
  if (full) return '--full';
  if (!prev) return n === 1 ? 'round 1' : 'no earlier verdict to carry from';
  const m = prev.round;
  const v = prev.verdict;
  const r = prev.results;
  if (!v?.verdict) return `no verdict for round ${m}`;
  if (v.verdict === 'ACCEPT') return `round ${m} was an ACCEPT: a new commit needs a new check`;
  if (!r || r.mode !== 'diff' || r.head?.sha !== (v.head ?? prev.head)) return `no results for round ${m}`;
  if (r.blocked) return `round ${m} checked nothing: ${firstLine(r.blocked)}`;
  if (r.compareError) return `round ${m} compared nothing: ${firstLine(r.compareError)}`;
  if (!charterMd || !Array.isArray(expectations)) return 'no plan to carry: charter.md or expectations.json is missing';
  if (changed === null || changed === undefined) return `the head of round ${m} (${short(prev.head)}) is not in this repo`;
  if (prev.spec && spec && prev.spec !== spec) return `the spec changed since round ${m}`;
  const was = prev.base ?? v.base;
  if (was && base && was !== base) return `the base moved: ${short(was)} → ${short(base)}`;
  const seedFile = profile?.seedNames ?? 'qa/seed.json';
  const trigger = changed.find((f) => f === 'qa.json' || f === seedFile);
  if (trigger !== undefined) return `${trigger} changed`;
  const before = r.round?.qa;
  if (before && qa) {
    if (before.profile !== qa.profile) return 'qa.json changed';
    if ((before.seed ?? null) !== (qa.seed ?? null)) return `${seedFile} changed`;
  }
  if (!r.round?.entries) return `round ${m} recorded no map entries`;
  return null;
}

export function planRound({
  n, head, base = null, spec = null, full = false, prev = null, charterMd = null, expectations = null, mutants = [],
  headMap = null, sources = {}, changed = [], profile = {}, qa = null, securityMd = null, suites = {}, history = {}, scope = null,
}) {
  const from = prev ? { round: prev.round, head: prev.head } : null;
  const fullReason = fullWhy({ n, full, prev, charterMd, expectations, changed, spec, base, profile, qa });
  if (fullReason) {
    return {
      round: n, head, base, spec, of: 'full', why: fullReason, from, changed: changed ?? [],
      screens: null, screensWhy: {}, expectations: null, rerun: [], carried: [], reasons: {}, routes: true, mutants: true,
      security: { rerun: true, why: 'a full round', paths: [], from: { round: n, head } }, history, carry: null,
    };
  }

  const m = prev.round;
  const verdict = prev.verdict;
  const pr = prev.results;
  const lastHead = pr.head.sha;
  const charter = parseCharter(charterMd);
  const evidence = charterEvidence(charterMd);
  const plan = expectations.filter((e) => e && typeof e === 'object' && typeof e.name === 'string');
  const planNames = new Set(plan.map((e) => e.name));
  const byName = new Map(plan.map((e) => [e.name, e]));
  const prevExp = pr.expectations ?? [];
  const nameOfId = new Map(prevExp.map((e) => [e.id, e.name]));
  const rowName = (id) => nameOfId.get(id) ?? /^exp:(.+?)(?:@[^@/]+)?$/.exec(id)?.[1] ?? null;
  const rows = verdict.criteria ?? [];
  const rowById = new Map(rows.map((c) => [c.id, c]));
  const headNames = [...new Set((headMap?.screens ?? []).map((s) => s?.name).filter((x) => typeof x === 'string'))];
  // The PR's scope against its base: the walk stays in it, and only the PR's own entries are new or changed for it.
  const inScope = Array.isArray(scope?.names) ? new Set(scope.names) : null;
  const overlaid = Array.isArray(headMap?.overlay?.screens) ? new Set(headMap.overlay.screens) : null;
  const own = inScope ? new Set([...inScope].filter((s) => !overlaid || overlaid.has(s))) : null;
  const fix = fixScreens({ head: headMap, prevKeys: pr.round.entries, changed, sources, own });
  const walkable = (s) => headNames.includes(s) && (!inScope || inScope.has(s));
  const screensOf = (e) => {
    const globs = toList(e.screens).map((g) => glob(g.split('__')[0]));
    return headNames.filter((s) => globs.some((re) => re.test(s)));
  };
  const citedBy = (c) => [...new Set([...c.expectations, ...plan.filter((e) => criteriaOf(e).includes(c.id)).map((e) => e.name)])].filter((x) => planNames.has(x));

  // Route code, a route table, or the route rows on disk (QA files kept off the product branches) changed.
  const before = pr.round?.qa ?? null;
  const routesHashChanged = (k) => (qa?.routes?.[k] ?? null) !== (before?.routes?.[k] ?? null);
  const routeTouch = [
    ...changed.filter((f) => routeTableFiles(profile).includes(f) || isRouteCode(f)),
    ...(before && qa ? Object.keys({ ...(qa.routes ?? {}), ...(before.routes ?? {}) }).filter((k) => routesHashChanged(k) && !changed.includes(k)) : []),
    ...(before && qa && (qa.overlayRoutes ?? null) !== (before.overlayRoutes ?? null) ? ['overlay routes.json'] : []),
  ];
  const suitesChanged = changed.find((f) => SUITES_FILES.includes(f));
  const covers = (id) => {
    const s = suites?.[id];
    return s && typeof s === 'object' && !Array.isArray(s) ? toList(s.covers).map(glob) : [];
  };

  const rerun = new Map();
  const mark = (name, why) => { if (planNames.has(name) && !rerun.has(name)) rerun.set(name, why); };

  // (a) the rows that failed or were open last round, and those that have no result.
  for (const e of plan) {
    const mine = rows.filter((c) => c.id.startsWith('exp:') && rowName(c.id) === e.name);
    const bad = mine.find((c) => !PASSED.includes(c.status));
    if (!prevExp.some((x) => x.name === e.name)) mark(e.name, `no result in round ${m}`);
    else if (bad) mark(e.name, `${bad.status} in round ${m}`);
    else if (!mine.length) mark(e.name, `not ruled in round ${m}`);
  }
  const chWhy = new Map();
  for (const c of charter) {
    if (c.manual) continue;
    const row = rowById.get(c.id);
    if (row && PASSED.includes(row.status)) continue;
    const why = row ? `${row.status} in round ${m}` : `not ruled in round ${m}`;
    chWhy.set(c.id, why);
    for (const name of citedBy(c)) mark(name, `cited by ${c.id} (${why})`);
  }

  // (b) the rows whose evidence the fix diff touches.
  for (const e of plan) {
    if (rerun.has(e.name)) continue;
    const kind = kindOf(e);
    if (kind === 'screen') {
      const hit = screensOf(e).find((s) => fix.why[s] && walkable(s));
      if (hit) mark(e.name, `screen ${hit}: ${fix.why[hit]}`);
    } else if (kind === 'test') {
      const file = typeof e.test?.file === 'string' ? e.test.file : null;
      const hit = changed.find((f) => covers(e.test?.suite).some((re) => re.test(f)));
      if (file && changed.includes(file)) mark(e.name, `its test file ${file} changed`);
      else if (suitesChanged) mark(e.name, `the suites file ${suitesChanged} changed`);
      else if (hit) mark(e.name, `its suite ${e.test.suite} covers ${hit}`);
    } else if (kind === 'route') {
      if (routeTouch.length) mark(e.name, `route code or table changed: ${routeTouch[0]}`);
    } else if (kind === 'doc') {
      const file = e.doc?.file;
      if (typeof file === 'string' && changed.includes(file)) mark(e.name, `its doc ${file} changed`);
    } else mark(e.name, 'not a screen, test, route or doc row: it runs every round');
  }

  // The walk: what the fix touches, what the re-run rows need, and every screen that gated or was BLOCKED last round.
  const walk = new Map(Object.entries(fix.why).filter(([s]) => walkable(s)));
  const addWalk = (s, why) => { if (walkable(s) && !walk.has(s)) walk.set(s, why); };
  for (const [name] of rerun) if (kindOf(byName.get(name)) === 'screen') for (const s of screensOf(byName.get(name))) addWalk(s, `for exp:${name}`);
  for (const [id] of chWhy) for (const s of evidence.get(id)?.screens ?? []) addWalk(s, `cited by ${id}`);
  for (const f of verdict.findings ?? []) if (f.severity === 'Blocker' || / — gates: /.test(f.text)) { const s = screenOfId(f.id); if (s) addWalk(s, `${f.id} gated in round ${m}`); }
  for (const g of verdict.gaps ?? []) if (/^BLOCKED — /.test(g.text)) { const s = screenOfId(g.id); if (s) addWalk(s, `${g.id} was BLOCKED in round ${m}`); }
  // (c) a screen row on a screen that is walked anyway costs nothing more: fresh evidence.
  for (const e of plan) {
    if (rerun.has(e.name) || kindOf(e) !== 'screen') continue;
    const s = screensOf(e).find((x) => walk.has(x));
    if (s) mark(e.name, `its screen ${s} is walked anyway`);
  }
  for (const c of charter) {
    if (c.manual || chWhy.has(c.id)) continue;
    const ev = evidence.get(c.id) ?? { screens: [], eyes: false };
    const names = citedBy(c);
    const walked = ev.screens.find((s) => walk.has(s));
    if (names.some((x) => rerun.has(x))) chWhy.set(c.id, 'its evidence re-runs');
    else if (walked) chWhy.set(c.id, `its screen ${walked} is walked`);
    else if ((ev.eyes || (!names.length && !ev.screens.length)) && walk.size) chWhy.set(c.id, 'ruled from what the walk shows');
  }

  const routes = routeTouch.length > 0 || [...rerun.keys()].some((x) => kindOf(byName.get(x)) === 'route')
    || (verdict.findings ?? []).some((f) => f.id.startsWith('rte:') && f.severity === 'Blocker')
    || (verdict.gaps ?? []).some((g) => g.id.startsWith('gap:route'));
  const proposals = (Array.isArray(mutants) ? mutants : []).filter((x) => x && typeof x === 'object');
  const mutantsOn = proposals.some((x) => changed.includes(x.file) || changed.includes(x.kill?.file)) || (proposals.length > 0 && !pr.mutants);

  const routesChanged = Boolean(before && qa && (qa.overlayRoutes ?? null) !== (before.overlayRoutes ?? null));
  const paths = securityPaths(changed, { profile, routesChanged });
  const high = parseSecurity(securityMd).find((x) => x.level === 'High');
  const security = paths.length ? { rerun: true, why: `the fix touches ${paths.map((p) => p.file).join(', ')}`, paths, from: { round: n, head } }
    : high ? { rerun: true, why: `round ${m} found a High: ${high.id}`, paths: [], from: { round: n, head } }
      : { rerun: false, why: 'the fix touches no sensitive, auth, role, session, route or migration path', paths: [], from: prev.security?.from ?? { round: m, head: prev.head } };

  // What is carried, pinned to the sha its evidence ran on.
  const pin = (x) => {
    const carried = x.carried ?? { round: m, sha: lastHead, detail: x.detail };
    return { ...x, detail: carried.detail, carried };
  };
  const keep = (x) => planNames.has(x?.name) && !rerun.has(x.name);
  const wasCarried = new Map((pr.round?.criteria ?? []).map((c) => [c.id, c]));
  const criteria = [];
  for (const c of charter) {
    if (c.manual || chWhy.has(c.id)) continue;
    const row = rowById.get(c.id);
    const was = wasCarried.get(c.id);
    criteria.push({ id: c.id, status: row.status, name: row.name, detail: stripCarried(row.detail), sha: was?.sha ?? lastHead, round: was?.round ?? m });
  }
  const whole = (x) => (x ? { ...x, carried: x.carried ?? { round: m, sha: lastHead } } : null);
  const carry = {
    criteria,
    expectations: prevExp.filter(keep).map(pin),
    tests: (pr.tests ?? []).filter(keep).map(pin),
    docs: (pr.docs ?? []).filter(keep).map(pin),
    routes: routes ? null : whole(pr.routes),
    mutants: mutantsOn ? null : whole(pr.mutants),
  };

  const idsOf = (name) => {
    const ids = prevExp.filter((x) => x.name === name).map((x) => x.id);
    return ids.length ? ids : [`exp:${name}`];
  };
  const reasons = {};
  const rerunIds = [];
  for (const e of plan) if (rerun.has(e.name)) for (const id of idsOf(e.name)) { rerunIds.push(id); reasons[id] = rerun.get(e.name); }
  for (const c of charter) if (chWhy.has(c.id)) { rerunIds.push(c.id); reasons[c.id] = chWhy.get(c.id); }
  const carriedIds = [...plan.filter((e) => !rerun.has(e.name)).flatMap((e) => idsOf(e.name)), ...criteria.map((c) => c.id)];
  const screens = headNames.filter((s) => walk.has(s));

  return {
    round: n, head, base, spec, of: 'incremental', why: `after round ${m}`, from, changed,
    screens, screensWhy: Object.fromEntries(screens.map((s) => [s, walk.get(s)])), expectations: plan.filter((e) => rerun.has(e.name)).map((e) => e.name),
    rerun: rerunIds, carried: carriedIds, reasons, routes, mutants: mutantsOn, security, history, carry,
  };
}

export function roundLines(plan) {
  const lines = [];
  if (plan.of === 'incremental') {
    lines.push(`round ${plan.round}: incremental from round ${plan.from.round} (${short(plan.from.head)}) — ${plan.changed.length} file(s) changed`);
    lines.push(`re-run: ${plan.rerun.length ? plan.rerun.map((id) => `${id} (${plan.reasons[id]})`).join(', ') : 'none'}`);
    lines.push(`carried: ${plan.carried.length} row(s), each says carried from <sha>`);
    lines.push(`walk: ${plan.screens.length ? plan.screens.map((s) => `${s} (${plan.screensWhy[s]})`).join(', ') : 'none'}`);
    lines.push(`routes: ${plan.routes ? 're-run' : 'carried'} · mutants: ${plan.mutants ? 're-run' : 'carried'}`);
    lines.push(plan.security.rerun ? `security: re-run — ${plan.security.why}` : `security: carried from round ${plan.security.from.round} (${short(plan.security.from.head)}) — ${plan.security.why}`);
  } else lines.push(`round ${plan.round}: full — ${plan.why}`);
  for (const [id, count] of Object.entries(plan.history ?? {})) {
    lines.push(`history: ${id} failed in ${count} earlier round(s); at ${ROUND_CAP} the verdict is NEEDS YOU (round cap)`);
  }
  return lines;
}

// ── carried rows into a run's results ────────────────────────────────────────

export function carryInto(results, plan, { entries = null, qa = null } = {}) {
  if (!plan) return results;
  const tail = (x) => ({ ...x, detail: `${x.carried?.detail ?? x.detail}${carriedTail(x.carried?.sha, x.carried?.round)}` });
  const incremental = plan.of === 'incremental' && plan.carry;
  const round = {
    n: plan.round, of: plan.of, why: plan.why, from: plan.from ?? null, screens: plan.screens ?? null, rerun: plan.rerun ?? [], carried: plan.carried ?? [],
    history: plan.history ?? {}, security: plan.security ?? null,
    criteria: incremental ? plan.carry.criteria.map((c) => ({ ...c, detail: `${stripCarried(c.detail)}${carriedTail(c.sha, c.round)}` })) : [],
    entries, qa,
  };
  if (!incremental) return { ...results, round };
  const add = (own, carried) => {
    const names = new Set((own ?? []).map((x) => x.name));
    return [...(own ?? []), ...(carried ?? []).filter((x) => !names.has(x.name)).map(tail)];
  };
  return {
    ...results,
    expectations: add(results.expectations, plan.carry.expectations),
    tests: add(results.tests, plan.carry.tests),
    docs: add(results.docs, plan.carry.docs),
    routes: results.routes ?? plan.carry.routes ?? null,
    mutants: results.mutants ?? plan.carry.mutants ?? null,
    round,
  };
}

// ── the record of each round, and the cap ────────────────────────────────────

export function roundRecord({ verdict, roundJson = null, results = null, last = 0, at = new Date().toISOString() }) {
  const round = roundJson?.round ?? last + 1;
  const head = verdict.head;
  const carriedCh = new Map((roundJson?.carry?.criteria ?? []).map((c) => [c.id, c]));
  const carriedExp = new Map((results?.expectations ?? []).filter((e) => e.carried).map((e) => [e.id, e.carried]));
  const rows = (verdict.criteria ?? []).map((c) => {
    const pinned = carriedCh.get(c.id) ?? carriedExp.get(c.id) ?? null;
    return { id: c.id, status: c.status, sha: pinned?.sha ?? head, round: pinned?.round ?? round };
  });
  return {
    round, head, base: verdict.base ?? null, spec: roundJson?.spec ?? null, of: roundJson?.of ?? 'full', outcome: verdict.verdict ?? null, at,
    security: roundJson?.security?.from ?? null, rows,
  };
}

export function recordRound(doc, record) {
  const rounds = (doc?.rounds ?? []).filter((r) => r.head !== record.head);
  return { rounds: [...rounds, record].sort((a, b) => a.round - b.round) };
}

export const lastRound = (doc) => Math.max(0, ...(doc?.rounds ?? []).map((r) => Number(r.round) || 0));

export function capHistory(rounds, spec, ids = null) {
  const out = {};
  for (const r of rounds ?? []) {
    if (r.spec && spec && r.spec !== spec) continue;
    for (const row of r.rows ?? []) if (row.status === 'FAIL' && (!ids || ids.has(row.id))) out[row.id] = (out[row.id] ?? 0) + 1;
  }
  return out;
}
