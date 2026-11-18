// Before vs after, then against the expectations: met / NOT MET / UNEXPECTED. Zero model calls.
// It pairs elements by text+context then text, checks
// style equality, expectations incl. rename/absent/url, backend-error and overflow checks, exit
// codes. Profile-neutral: palette and ignoreErrors come from qa.json; no env names, no
// PDF, no live-site labels. Step 3 adds decision 10's other two signals (tree diff, where
// expectations also match; pixel diff, which only says "send to eyes") and the diff-scoped page
// checks, tour problems and console errors (decision 5: only what is NEW on the after side is a
// finding; what both sides have is standing).
//
// Expectations file: JSON array, visual-diff's format unchanged:
//   [{ name, screens: glob, text: 'exact' | '/re/flags', context?, before?, after?: token |
//      { background?, color?, border? } | 'absent', url?, urlPattern?, viewports?, keep? }]
//   keep: true — an invariant that must hold on head (a row that must stay as it is): met when every
//   element observed on head is right, even when the base was already so (never 'already true before').
//
// CONTRACT (tests: test/compare.test.mjs )
//
//   readSide(dir, viewport) -> { records: { '<screen>__<state>': record }, failed: { screen: failedJson },
//                                videos: { screen: file } }    (empty viewport folder -> no records)
//
//   compareViewport({ before, after, viewport, expectations = [], profile })
//     -> { viewport, exit: 0|1|2,
//          pairs: [{ key, status: 'same'|'changed'|'drift'|'new'|'gone', before, after }],
//          expectations: [{ name, result: 'met'|'NOT MET'|'already true before'|'not observed'|'n/a', detail }],
//          unexpected: [{ key, before, after }], overflow: [{ key, by, text }],
//          inconclusive: [{ key, why }], md: string, checkLine: string }
//     Pure: writes nothing. before/after are readSide() results.
//     exit 1: any NOT MET, unexpected change, or new overflow. exit 2: anything not observed or a
//     capture inconclusive (missing on one side, FAILED, backend error status >= 500 or 401/403,
//     blocked write). Else 0. profile.ignoreErrors: [regex] lines dropped from errors first.
//     profile.palette: { token: '#hex' } resolves `after` tokens.
//
//   STEP 3 — readSide also returns trees: { key: text of <key>.aria.yml } and pngs: { key: absolute
//   path of <key>.png }, for the keys that have them. Every pair gains five fields; ALL five are
//   null when the pair is gone (a new pair: see NEW ON HEAD), or either record is from before step 3 (no `tree` key), so
//   old captures compare exactly as before; otherwise each is null when its own input is missing:
//     tree    tree.mjs treeDiff(before tree, after tree) plus explained: [line] (lines an
//             expectation accounts for, see below). A tree that is not same makes the pair 'changed'.
//     pixel   { ratio (png.mjs comparePixels, tolerance 16), worstTile (png.mjs worstTile),
//             sameSize, changed: !sameSize || worstTile > WORST_TILE_THRESHOLD }. Never changes the
//             pair's status or the exit; a pixel-only change is listed as "send to eyes".
//     checks  { new, standing, fixed }: the after record's check findings not in the before
//             record, in both, and only before. Findings match by findingKey(f) = f.check + ' ' +
//             f.detail with every run of digits replaced by '#' (sizes move when text shifts).
//     tour    { opened, failed, hover, hoverSilent, new, standing, fixed }: counts from the after
//             record's tour (opened = opened.length, hoverSilent = hover entries with changed
//             false), and the tour PROBLEMS split like checks (problem = every clipped and covered
//             line of every opened entry, plus `<control> does not close on Escape` when stuck;
//             same digit-insensitive matching).
//     console { new, standing }: errors lines that do not start with 'HTTP ' (console and page
//             errors; profile.ignoreErrors already dropped), split like checks.
//   Volatile text (step 3 pilot): profile.volatile = [regex source]; before treeDiff, every match
//   in either tree is replaced with '…' (flags 'g'), so a seed-time stamp ("Updated 06 Nov, 12:40
//   pm") never reads as a change. pair.tree.masked = how many after-tree lines a mask touched.
//   A seed that writes fixed timestamps needs no mask; the mask is for what the seed cannot fix.
//   Expectations against the tree (text expectations only; url ones are unchanged). Per in-scope
//   pair, using tree.mjs treeText(line) as the line's text and ignoring `context`:
//     - an added line whose text matches `text` is explained by the expectation; when that pair
//       gave the expectation no watched-element hit and `after` is not a style (undefined), it is a
//       hit: met = true, wasAlready = the before tree already had a matching line;
//     - with `before` (rename): a removed line matching `before` is explained; an after-tree line
//       still matching `before` is a hit with met = false (STILL OLD TEXT);
//     - with after 'absent': a removed line matching `text` is explained and a hit met = true;
//       an after-tree line still matching `text` is a hit met = false;
//     - a presence expectation (after undefined) with no element hit, whose text is in the after
//       tree but in no diff line, is a hit met = true, wasAlready = true.
//     A style expectation explains matching tree lines but a tree line never proves a colour.
//   unexpected gains { key, kind: 'tree', added: [line], removed: [line] } per pair with
//   unexplained tree lines (each list cut to 20); element entries gain kind: 'element'.
//   exit 1 also on: an unexplained tree line, a new check finding, a new tour problem, a new
//   console line. Standing items and pixel changes never set the exit.
//   The result gains eyes: [key] (pairs whose pixel.changed, or that are new), standing:
//   { checks: n, tour: n, console: n } (counts of standing findings, tour PROBLEMS, console lines,
//   over all pairs). checks.new/standing/fixed hold the finding objects; tour and console lists
//   hold strings. summary.md: per pair, after its element lines,
//     `<key> tree: +A -R` then up to 5 `  + <line>` / `  - <line>` (unexplained first),
//     `<key> pixels: worst tile 0.031, 2.4% changed — send to eyes` (only when pixel.changed),
//     `<key> checks: N new, S standing, F fixed` then `  new <check>: <detail>` per new one,
//     `<key> tour: O opened, F failed, H/T hovers answer, N new problem(s)` then `  new: <problem>`,
//     `<key> console: N new` then `  new: <line>`;
//   lines only when there is something to say (a pair with no tree change, no new or fixed
//   items has none of them). checkLine adds ', <t> tree lines unexplained, <c> new check(s),
//   <p> new tour problem(s), <e> to eyes' when any is non-zero. index.html shows the tour shots
//   (copied to media/) under the after image.
//
//   compare({ beforeDir, afterDir, expect = null, out, profile, viewports = null, newScreens = {} })
//     -> Promise<{ exit, viewports: [compareViewport result minus md] }>
//     viewports default: every subfolder head (afterDir) captured; a viewport base has no folder for is read as an
//     empty before side, so its screens are new on head (1.0.3: was 'present on both sides', which threw when every
//     screen in scope was new and base walked none). No viewport captured on head -> throws. Worst exit wins.
//     Writes <out>/summary.md (one section per viewport, every line carries its key),
//     <out>/index.html (side-by-side PNGs, element crops, videos when present, expectation table;
//     self-contained except image/video files, which are copied into <out>/media/), and
//     <out>/results.json (the return value).

//   STEP 6 (tests: test/compare.test.mjs 'step 6'):
//     Expectation entries with a `route`, `db`, `mail`, (0.4.0) `test` or (0.6.0) `doc` key are not compare's: they get result
//     'n/a' (dropped by summary.mjs) and never touch pairs, explained lines or the exit.
//     Every pair gains metrics: metrics.mjs compareMetrics(before record.metrics, after
//     record.metrics, limitsFor(profile.limits)) — null when the pair is new or gone or either
//     record has no metrics. Metric flags never change a pair's status or the exit. The viewport
//     result gains metricsStanding: the sum of pair.metrics.standing. summary.md per pair, after
//     the console lines: '<key> metrics: <f> flag(s)' then '  <metricsLine(flag)>' per flag (only
//     when there is a flag).

//   NEW ON HEAD (tests: test/new-on-head.test.mjs): a screen the PR makes reachable has no
//   before picture, and is judged on head alone instead of as a gap.
//     compareViewport({ …, newScreens = {} }) — newScreens: { screen: reason } from the runner, the
//     screens whose map entry is new between base and head ('map entry new'; a changed entry is not
//     listed and keeps its before/after diff). Per screen with a head record at this viewport, newOnHead =
//       newScreens[screen]           when listed (its base records and base failure are set aside);
//       'base could not reach it'    when base has no record of it, base FAILED it and head did not;
//       'not on base'                when base has no record of it and did not fail it;
//       null otherwise (a screen that failed on both sides stays a gap, exactly as before).
//     The viewport result gains fresh: { screen: reason } (the non-null ones); every pair gains
//     newOnHead (its screen's reason, or null). A base FAILED of a fresh screen is not inconclusive.
//     A pair with no before record (status 'new') is checked on its own:
//       checks / tour / console  everything the head record has is new (standing and fixed empty);
//       metrics                  compareMetrics({}, head metrics, limits): human limits only;
//       tree, pixel              null (nothing to diff).
//     Expectations on such a pair are judged from head's tree alone (when it has one):
//       after 'absent'  a head element or tree line with the text -> a hit met false; neither -> a
//                       hit met true (it is not there);
//       before (rename) a head tree line still matching `before` -> a hit met false (stale);
//       presence        no element hit and a head tree line with the text -> a hit met true;
//       any non-absent  no hit anywhere in scope, a new pair's tree was read and no new pair's tree
//                       has the text -> one hit met false (NOT MET: the text is not on it).
//     summary.md and index.html name such a pair 'new on head (<reason>)' where they named it 'new'.
//     wasAlready is false for every such hit. When any in-scope pair is new, the detail ends with
//     'new on head: <a> without it, <b> showing it' (absent), 'new on head: "<text>" is not on it'
//     (the NOT MET above) or 'new on head: <r> right, <w> wrong colour[, <s> still "<before>"]',
//     counted over the new pairs' hits; the usual counts, over the other pairs' hits, come first
//     ('<usual>; new on head: …') only when an in-scope pair is not new.

//   1.0.0 (tests: test/outcomes.test.mjs 'compare'): one row's exception never stops the others.
//     An expectation whose judging throws (an unknown palette token, a bad /re/) gets result 'error' and detail
//     'the tool failed: <first line>'; exit 2 like a not-observed one. A pair whose diff throws (a PNG that will not
//     decode, a tree that will not parse) keeps its key and status ('new' / 'gone' / 'same'), has every step-3 field and
//     metrics null, gains error: '<first line>' and an inconclusive 'compare failed: <first line>'.
//     Every judged screen expectation gains observed: how many elements or tree lines it judged (a new screen's "the
//     text is not on it" counts 0), so the verdict can tell "observed 0" (the tool or the plan) from a real NOT MET.
//     A pair with a base record gains checks.newOnBase and tour.newOnBase, one boolean per entry of checks.new /
//     tour.new: the finding's element (the first "<name>" in its text) is on the base screen's accessibility tree, so
//     the finding is a regression of something that was there; false for an unnamed element or one the base lacks.

//   U11 (tests: test/capture-touch.test.mjs): a pair whose after record has skipped steps (capture.mjs: a hover skipped
//   on a touch screen) is never in eyes: the capture does not show what the map meant it to.

import fs from 'node:fs';
import path from 'node:path';
import { compareMetrics, limitsFor, metricsLine } from './metrics.mjs';
import { comparePixels, decodePng, WORST_TILE_THRESHOLD, worstTile } from './png.mjs';
import { normaliseTree, treeDiff, treeText } from './tree.mjs';
import { esc, glob, rgb } from './util.mjs';

const JSON_EXT = /\.json$/;
// Was a page-check or tour finding's element on the base screen? Its name, the first "…" in the text, on the base tree.
export function onBaseTree(text, tree) {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(String(text ?? ''));
  const name = m ? m[1].replace(/…$/, '').trim() : '';
  return Boolean(name) && typeof tree === 'string' && tree.includes(`"${name}`);
}
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
};

export function readSide(dir, viewport) {
  const vp = path.join(dir, viewport);
  const side = { records: {}, failed: {}, videos: {}, trees: {}, pngs: {}, dir: vp };
  if (!fs.existsSync(vp) || !fs.statSync(vp).isDirectory()) return side;
  const trees = {};
  const pngs = {};
  for (const f of fs.readdirSync(vp).sort()) {
    if (f.endsWith('.webm')) side.videos[f.slice(0, -5)] = path.join(vp, f);
    else if (f.endsWith('.aria.yml')) trees[f.slice(0, -'.aria.yml'.length)] = fs.readFileSync(path.join(vp, f), 'utf8');
    else if (f.endsWith('.png')) pngs[f.slice(0, -4)] = path.join(vp, f);
    else if (f.endsWith('__FAILED.json')) side.failed[f.slice(0, -'__FAILED.json'.length)] = readJson(path.join(vp, f));
    else if (JSON_EXT.test(f)) side.records[f.replace(JSON_EXT, '')] = readJson(path.join(vp, f));
  }
  // Only the keys that have a record: crops, tour shots and FAILED shots are not a capture's own picture.
  for (const key of Object.keys(side.records)) {
    if (key in trees) side.trees[key] = trees[key];
    if (key in pngs) side.pngs[key] = pngs[key];
  }
  return side;
}

// ---- compareViewport ------------------------------------------------------------------------------------------

const screenOf = (key, ...recs) => recs.find((r) => r?.screen)?.screen ?? key.split('__')[0];
const styleOf = (e) => JSON.stringify(e.style);
// "HTTP <status> <METHOD> <path>": a 5xx, or 401/403 (wrong account or organisation), means the capture may lack data.
const backendFailure = (line) => {
  const m = /^HTTP (\d{3}) [A-Z]+ /.exec(line);
  return !!m && (Number(m[1]) >= 500 || m[1] === '401' || m[1] === '403');
};
// A blocked write is a string "BLOCKED <call>" or a { status: 'BLOCKED' | blocked: true } entry.
const isBlocked = (w) => (typeof w === 'string' ? w.startsWith('BLOCKED') : !!w && (w.blocked === true || w.status === 'BLOCKED'));
const writeText = (w) => (typeof w === 'string' ? w : `${w.method ?? ''} ${w.url ?? ''}`.trim());
const overflowText = (list) => list.map((o) => `${o.key}${o.text ? ` "${o.text}"` : ''} +${o.by}px`).join(', ');
const toList = (v) => [].concat(v ?? '*');

function describe(ex) {
  const where = toList(ex.screens).join(', ');
  const name = ex.name ? `${ex.name}: ` : '';
  if (ex.url || ex.urlPattern) return `${name}lands on ${ex.url ? `"${ex.url}"` : `/${ex.urlPattern}/`} at ${where}`;
  return `${name}${ex.before ? `"${ex.before}" → ` : ''}"${ex.text}"${ex.context ? ` under "${ex.context}"` : ''} on ${where}${ex.after ? ` → ${typeof ex.after === 'string' ? ex.after : JSON.stringify(ex.after)}` : ''}`;
}

// The elements of one capture matched before to after: text+context first, then what is left by text alone (a cell
// under a renamed header keeps its text but not its context), each by occurrence number so a reordered list lines up.
function pairElements(a, b) {
  const found = [];
  let restA = a.elements ?? [];
  let restB = b.elements ?? [];
  for (const id of [(e) => `${e.text}\n${e.context}`, (e) => e.text]) {
    const index = (list) => {
      const seen = {};
      return new Map(list.map((e) => [`${id(e)}#${(seen[id(e)] = (seen[id(e)] ?? 0) + 1)}`, e]));
    };
    const kb = index(restB);
    for (const [k, x] of index(restA)) if (kb.has(k)) found.push({ x, y: kb.get(k) });
    const paired = new Set(found.flatMap((p) => [p.x, p.y]));
    restA = restA.filter((e) => !paired.has(e));
    restB = restB.filter((e) => !paired.has(e));
  }
  return [...found, ...restA.map((x) => ({ x })), ...restB.map((y) => ({ y }))];
}

// Findings match by their text with every run of digits made '#': sizes move when text shifts.
const norm = (s) => String(s).replace(/\d+/g, '#');
const findingKey = (f) => norm(`${f.check} ${f.detail}`);
const splitBy = (now, was, keyOf) => {
  const had = new Set(was.map(keyOf));
  const has = new Set(now.map(keyOf));
  return { new: now.filter((x) => !had.has(keyOf(x))), standing: now.filter((x) => had.has(keyOf(x))), fixed: was.filter((x) => !has.has(keyOf(x))) };
};
const tourProblems = (tour) =>
  (tour?.opened ?? []).flatMap((o) => [...(o.clipped ?? []), ...(o.covered ?? []), ...(o.stuck ? [`${o.control} does not close on Escape`] : [])]);

const tourFields = (tour, split) => {
  const hover = tour.hover ?? [];
  return { opened: (tour.opened ?? []).length, failed: (tour.failed ?? []).length, hover: hover.length, hoverSilent: hover.filter((h) => !h.changed).length, ...split };
};

// The five step-3 fields of a pair: all null when the pair is gone or either record is from before step 3. A pair new
// on head (no before record) is checked on its own: no tree or pixel diff, and everything its record has is new.
function step3Fields(key, a, b, before, after, profile) {
  const none = { tree: null, pixel: null, checks: null, tour: null, console: null };
  if (!b || !('tree' in b) || (a && !('tree' in a))) return none;
  const out = { ...none };
  const lines = (r) => (Array.isArray(r?.errors) ? r.errors : []).filter((e) => !String(e).startsWith('HTTP '));
  if (!a) {
    if (Array.isArray(b.checks)) out.checks = splitBy(b.checks, [], findingKey);
    if (b.tour) out.tour = tourFields(b.tour, splitBy(tourProblems(b.tour), [], norm));
    const c = splitBy(lines(b), [], norm);
    out.console = { new: c.new, standing: c.standing };
    return out;
  }
  const ta = before?.trees?.[key];
  const tb = after?.trees?.[key];
  if (typeof ta === 'string' && typeof tb === 'string') {
    // Volatile text the seed cannot pin is masked on both sides first (profile.volatile).
    const masks = (profile?.volatile ?? []).map((p) => new RegExp(p, 'g'));
    const mask = (text) => text.split('\n').map((line) => masks.reduce((l, re) => l.replace(re, '…'), line));
    const la = mask(ta);
    const lb = mask(tb);
    const masked = lb.filter((l, i) => l !== tb.split('\n')[i]).length;
    out.tree = { ...treeDiff(la.join('\n'), lb.join('\n')), explained: [], masked };
  }
  const pa = before?.pngs?.[key];
  const pb = after?.pngs?.[key];
  if (pa && pb) {
    try {
      const ia = decodePng(fs.readFileSync(pa));
      const ib = decodePng(fs.readFileSync(pb));
      const worst = worstTile(ia, ib);
      const px = comparePixels(ia, ib, { tolerance: 16 });
      out.pixel = { ratio: px.ratio, worstTile: worst, sameSize: px.sameSize, changed: !px.sameSize || worst > WORST_TILE_THRESHOLD };
    } catch {
      out.pixel = null;
    }
  }
  if (Array.isArray(a.checks) && Array.isArray(b.checks)) out.checks = splitBy(b.checks, a.checks, findingKey);
  if (a.tour && b.tour) out.tour = tourFields(b.tour, splitBy(tourProblems(b.tour), tourProblems(a.tour), norm));
  // 1.0.0: which new findings sit on an element the base screen had (a regression), and which on new content.
  if (out.checks) out.checks.newOnBase = out.checks.new.map((f) => onBaseTree(f.detail, ta));
  if (out.tour) out.tour.newOnBase = out.tour.new.map((t) => onBaseTree(t, ta));
  const c = splitBy(lines(b), lines(a), norm);
  out.console = { new: c.new, standing: c.standing };
  return out;
}

export function compareViewport({ before, after, viewport, expectations = [], profile = {}, maxLines = 140, newScreens = {} }) {
  const ignore = (profile?.ignoreErrors ?? []).map((p) => new RegExp(p));
  const known = (e) => ignore.some((re) => re.test(e));
  const clean = (r) => {
    if (!r || !Array.isArray(r.errors)) return r;
    return { ...r, errors: r.errors.filter((e) => !known(e)), ignoredErrors: [...(r.ignoredErrors ?? []), ...r.errors.filter(known)] };
  };
  const listed = newScreens ?? {};
  // A screen whose map entry is new in the PR is walked on head alone: any base record or failure of it is set aside.
  const recA = Object.fromEntries(Object.entries(before?.records ?? {}).filter(([k, r]) => !Object.hasOwn(listed, screenOf(k, r))).map(([k, r]) => [k, clean(r)]));
  const recB = Object.fromEntries(Object.entries(after?.records ?? {}).map(([k, r]) => [k, clean(r)]));
  const failedA = Object.fromEntries(Object.entries(before?.failed ?? {}).filter(([screen]) => !Object.hasOwn(listed, screen)));
  const failedB = after?.failed ?? {};
  const keys = [...new Set([...Object.keys(recA), ...Object.keys(recB)])].sort();

  // New on head: the screens head reaches and base has no picture of (see NEW ON HEAD above).
  const baseScreens = new Set(Object.entries(recA).map(([k, r]) => screenOf(k, r)));
  const fresh = {};
  for (const [k, r] of Object.entries(recB)) {
    const screen = screenOf(k, r);
    if (Object.hasOwn(fresh, screen)) continue;
    if (Object.hasOwn(listed, screen)) fresh[screen] = listed[screen];
    else if (baseScreens.has(screen)) continue;
    else if (!failedA[screen]) fresh[screen] = 'not on base';
    else if (!failedB[screen]) fresh[screen] = 'base could not reach it';
  }

  // ---- pair every key, and the watched elements inside it
  const pairs = keys.map((key) => {
    const a = recA[key];
    const b = recB[key];
    const status0 = !a ? 'new' : !b ? 'gone' : null;
    try {
      const elements = a && b ? pairElements(a, b) : b ? (b.elements ?? []).map((y) => ({ y })) : [];
      const nth = {};
      const list = elements.map(({ x, y }) => {
        const text = (x ?? y).text;
        const status = !x || !y ? (status0 === 'new' ? 'new' : 'drift') : styleOf(x) === styleOf(y) ? 'same' : 'changed';
        return { k: `${text}#${(nth[text] = (nth[text] ?? 0) + 1)}`, status, before: x ?? null, after: y ?? null, expectation: null, met: null, stale: false, wasAlready: false, verdict: status };
      });
      const status = status0 ?? (list.some((e) => e.status === 'changed') ? 'changed' : list.some((e) => e.status === 'drift') ? 'drift' : 'same');
      const extra = step3Fields(key, a, b, before, after, profile);
      // Step 6: what opening the screen cost, flagged against the human limits and the base; never changes status or exit.
      // A pair new on head has no base number: the human limits alone.
      const metrics = b ? compareMetrics(a ? a.metrics ?? null : {}, b.metrics ?? null, limitsFor(profile?.limits)) : null;
      const newOnHead = b ? fresh[screenOf(key, b)] ?? null : null;
      return { key, status: extra.tree && !extra.tree.same ? 'changed' : status, before: a ?? null, after: b ?? null, elements: list, ...extra, metrics, newOnHead };
    } catch (e) {
      // One screen the diff cannot read: the rest go on; the verdict lists it as BLOCKED.
      const newOnHead = b ? fresh[screenOf(key, b)] ?? null : null;
      return { key, status: status0 ?? 'same', before: a ?? null, after: b ?? null, elements: [], tree: null, pixel: null, checks: null, tour: null, console: null, metrics: null, newOnHead, error: firstLine(e) };
    }
  });
  const treeLines = (side, key) => (typeof side?.trees?.[key] === 'string' ? normaliseTree(side.trees[key]).split('\n') : []);

  // ---- expectations
  const paletteOf = (token) => {
    if (!profile?.palette?.[token]) throw new Error(`unknown palette token "${token}" (see "palette" in qa.json)`);
    return profile.palette[token];
  };
  // A palette token is '#hex' (the background colour) or already { background, color, border }.
  const tokenStyle = (v) => (typeof v === 'string' ? { background: v } : v);
  const satisfies = (style, w) =>
    (!w.background || style.background === rgb(w.background)) &&
    (!w.color || style.color === rgb(w.color)) &&
    (!w.border || (style.border.endsWith(rgb(w.border)) && !style.border.startsWith('0px')));
  const matcher = (t) => {
    const slash = t.lastIndexOf('/');
    const re = t.startsWith('/') && slash > 0 ? new RegExp(t.slice(1, slash), t.slice(slash + 1)) : null;
    return (el) => (re ? re.test(el.text) : el.text === t);
  };
  const landing = (rec) => {
    const u = new URL(rec.url);
    return u.pathname + u.search;
  };
  const evaluated = expectations.map((ex) => {
    try {
      return judgeOne(ex);
    } catch (e) {
      const name = ex?.name ?? JSON.stringify(ex);
      return { name, describe: name, result: 'error', detail: `the tool failed: ${firstLine(e)}` };
    }
  });
  function judgeOne(ex) {
    // Step 6: a route, db or mail expectation belongs to the sweeps and the oracle, not to the screens; a test
    // expectation (0.4.0) to the runner's named tests (tests.mjs).
    if (ex.route !== undefined || ex.db !== undefined || ex.mail !== undefined || ex.test !== undefined || ex.doc !== undefined) {
      const label = ex.name ?? JSON.stringify(ex);
      return { name: label, describe: label, result: 'n/a', detail: 'not a screen expectation' };
    }
    const name = ex.name ?? describe(ex);
    const out = { name, describe: describe(ex), result: 'n/a', detail: 'other viewport' };
    if (ex.viewports && !ex.viewports.includes(viewport)) return out;
    const screensRe = toList(ex.screens).map(glob);
    const inScope = (p) => screensRe.some((re) => re.test(screenOf(p.key, p.after, p.before)) || re.test(p.key));
    const hits = [];
    // keep: true marks an invariant ("Kite still shows no badge"): holding on head is the proof, so a
    // state the base already had is met, not 'already true before'.
    const resultOf = () => (!hits.length ? 'not observed' : !hits.every((h) => h.met) ? 'NOT MET' : !ex.keep && hits.every((h) => h.wasAlready) ? 'already true before' : 'met');
    if (ex.url || ex.urlPattern) {
      const lands = (rec) => !!rec?.url && (ex.urlPattern ? new RegExp(ex.urlPattern).test(landing(rec)) : landing(rec).includes(ex.url));
      for (const p of pairs) {
        if (!p.after?.url || !inScope(p)) continue;
        hits.push({ key: p.key, met: lands(p.after), wasAlready: lands(p.before), landed: landing(p.after) });
      }
      out.result = resultOf();
      out.observed = hits.length;
      const ok = hits.filter((h) => h.met).length;
      out.detail = `${hits.length} capture(s): ${ok} landed there${ok < hits.length ? `; elsewhere: ${hits.filter((h) => !h.met).map((h) => h.landed).join(', ')}` : ''}`;
      return out;
    }
    const isText = matcher(ex.text);
    // "before": the text a renamed element had. Still showing it after, under the same context, is NOT MET. On the
    // before side it explains the old element's drift; context is not required there (it may be what was renamed).
    const isOld = ex.before ? matcher(ex.before) : () => false;
    const inContext = (el) => !ex.context || (el.context ?? '').toLowerCase().includes(ex.context.toLowerCase());
    const absent = ex.after === 'absent';
    const w = absent ? null : typeof ex.after === 'string' ? tokenStyle(paletteOf(ex.after)) : (ex.after ?? {});
    // New on head: hits found on a pair with no before record, whether such a pair was in scope, whether one's tree was
    // read, and whether the text was on any of those trees.
    const onHead = new Set();
    let newInScope = 0;
    let oldInScope = 0;
    let newTreeRead = false;
    let newHasText = false;
    const textOf = (line) => ({ text: treeText(line) });
    for (const p of pairs) {
      if (p.status === 'gone' || !inScope(p)) continue;
      const headOnly = !p.before;
      if (headOnly) newInScope += 1;
      else oldInScope += 1;
      const hitsBefore = hits.length;
      for (const e of p.elements) {
        if (!absent && e.before && !e.after && isOld(e.before)) {
          e.expectation ??= out.name;
          e.met = true;
          e.verdict = `renamed from "${ex.before}"`;
          continue;
        }
        // 'absent' looks at the base's elements; a screen new on head has none, so it looks at head's.
        const el = absent && !headOnly ? e.before : e.after;
        if (!el || !inContext(el)) continue;
        const stale = !absent && isOld(el);
        if (!stale && !isText(el)) continue;
        e.expectation = out.name;
        e.stale = stale;
        e.met = absent ? !headOnly && !e.after : !stale && satisfies(e.after.style, w);
        e.wasAlready = !absent && !stale && !!e.before && satisfies(e.before.style, w);
        e.verdict = absent && headOnly ? `expected absent, STILL THERE` : stale ? `expected "${ex.text}", STILL OLD TEXT` : e.met ? 'expected' : 'expected, WRONG COLOUR';
        hits.push(e);
        if (headOnly) onHead.add(e);
      }
      if (headOnly) {
        // Judged from head's tree alone: there is no base to diff against.
        if (typeof after?.trees?.[p.key] !== 'string') continue;
        newTreeRead = true;
        const nowLines = treeLines(after, p.key);
        const shows = (m) => nowLines.some((l) => m(textOf(l)));
        const add = (hit) => {
          hits.push(hit);
          onHead.add(hit);
        };
        if (shows(isText)) newHasText = true;
        if (absent) {
          if (hits.length === hitsBefore) add({ key: p.key, met: !shows(isText), wasAlready: false });
          continue;
        }
        if (ex.before && shows(isOld)) add({ key: p.key, met: false, stale: true, wasAlready: false });
        if (ex.after === undefined && hits.length === hitsBefore && shows(isText)) add({ key: p.key, met: true, wasAlready: false });
        continue;
      }
      if (!p.tree) continue;
      // The accessibility tree explains lines and, for text expectations, is a second place to find the text.
      const explain = (line) => {
        if (!p.tree.explained.includes(line)) p.tree.explained.push(line);
      };
      const wasLines = treeLines(before, p.key);
      const nowLines = treeLines(after, p.key);
      if (absent) {
        const goneLines = p.tree.removed.filter((x) => isText(textOf(x.line)));
        goneLines.forEach((x) => explain(x.line));
        if (goneLines.length) hits.push({ key: p.key, met: true, wasAlready: false });
        if (nowLines.some((l) => isText(textOf(l)))) hits.push({ key: p.key, met: false, wasAlready: false });
        continue;
      }
      p.tree.added.filter((x) => isText(textOf(x.line))).forEach((x) => explain(x.line));
      if (ex.before) p.tree.removed.filter((x) => isOld(textOf(x.line))).forEach((x) => explain(x.line));
      if (ex.after === undefined && hits.length === hitsBefore) {
        if (p.tree.added.some((x) => isText(textOf(x.line)))) hits.push({ key: p.key, met: true, wasAlready: wasLines.some((l) => isText(textOf(l))) });
        else if (nowLines.some((l) => isText(textOf(l)))) hits.push({ key: p.key, met: true, wasAlready: true });
      }
      if (ex.before && nowLines.some((l) => isOld(textOf(l)))) hits.push({ key: p.key, met: false, stale: true, wasAlready: false });
    }
    // Expected on a screen new on head and on none of the new screens' trees: NOT MET, not 'not observed'.
    const missing = !absent && !hits.length && newTreeRead && !newHasText;
    if (missing) hits.push({ key: null, met: false, missing: true, wasAlready: false });
    out.result = resultOf();
    out.observed = hits.filter((h) => !h.missing).length;
    const was = hits.filter((h) => !onHead.has(h) && !h.missing);
    const diffed = absent
      ? `${was.length} element(s) before: ${was.filter((h) => h.met).length} gone, ${was.filter((h) => !h.met).length} still there`
      : `${was.length} element(s): ${was.filter((h) => h.met).length} right, ${was.filter((h) => !h.met && !h.stale).length} wrong colour, ${ex.before ? `${was.filter((h) => h.stale).length} still "${ex.before}", ` : ''}${was.filter((h) => h.wasAlready).length} already so before`;
    if (!newInScope) out.detail = diffed;
    else {
      const now = hits.filter((h) => onHead.has(h));
      const onHeadText = absent
        ? `new on head: ${now.filter((h) => h.met).length} without it, ${now.filter((h) => !h.met).length} showing it`
        : missing
          ? `new on head: "${ex.text}" is not on it`
          : `new on head: ${now.filter((h) => h.met).length} right, ${now.filter((h) => !h.met && !h.stale).length} wrong colour${ex.before ? `, ${now.filter((h) => h.stale).length} still "${ex.before}"` : ''}`;
      out.detail = oldInScope ? `${diffed}; ${onHeadText}` : onHeadText;
    }
    return out;
  }
  const unexpectedElements = pairs.flatMap((p) => p.elements.filter((e) => e.status === 'changed' && !e.expectation).map((e) => ({ key: p.key, kind: 'element', element: e.k, before: e.before, after: e.after })));
  // Tree lines no expectation accounts for; the full counts stay for the summary, each list shown is cut to 20.
  const unexplained = (p) => {
    const left = (list) => (p.tree ? list.filter((x) => !p.tree.explained.includes(x.line)).map((x) => x.line) : []);
    return { added: left(p.tree?.added ?? []), removed: left(p.tree?.removed ?? []) };
  };
  const unexpectedTrees = pairs.flatMap((p) => {
    const u = unexplained(p);
    return u.added.length || u.removed.length ? [{ key: p.key, kind: 'tree', added: u.added.slice(0, 20), removed: u.removed.slice(0, 20) }] : [];
  });
  const unexpected = [...unexpectedElements, ...unexpectedTrees];

  // ---- new overflow, inconclusive captures
  const overflow = pairs.flatMap((p) => {
    if (!p.before?.overflow || !p.after?.overflow) return [];
    const had = new Set(p.before.overflow.map((o) => o.key));
    return p.after.overflow.filter((o) => !had.has(o.key)).map((o) => ({ key: p.key, by: o.by, text: o.text ?? o.key }));
  });
  const whys = new Map();
  const why = (key, text) => whys.set(key, [...(whys.get(key) ?? []), text]);
  for (const p of pairs) {
    const screen = screenOf(p.key, p.after, p.before);
    if (p.error) why(p.key, `compare failed: ${p.error}`);
    // A base failure of a screen new on head is why there is no before picture, not a doubt about the after one.
    const sides = [['before', p.newOnHead ? {} : failedA], ['after', failedB]];
    const failed = sides.filter(([, f]) => f[screen]);
    for (const [, f] of failed) why(p.key, `FAILED: ${f[screen].error ?? 'unknown error'}`);
    if (p.status === 'gone' && !failed.length) why(p.key, 'missing after');
    const drift = p.elements.filter((e) => e.status === 'drift' && !e.expectation);
    if (drift.length) why(p.key, `${drift.length} element(s) on one side only: ${drift.slice(0, 3).map((e) => e.k).join(', ')}`);
    const bad = [['before', p.before], ['after', p.after]].filter(([, r]) => r?.errors?.some(backendFailure));
    if (bad.length) why(p.key, `backend error in ${bad.map(([n]) => n).join(' and ')}: ${[p.before, p.after].flatMap((r) => r?.errors ?? []).filter(backendFailure).slice(0, 2).join(' | ')}`);
    const blocked = [...(p.before?.writes ?? []), ...(p.after?.writes ?? [])].filter(isBlocked);
    if (blocked.length) why(p.key, `blocked write: ${[...new Set(blocked.map(writeText))].slice(0, 2).join(' | ')}`);
  }
  // A screen that failed with no record of any state on either side still has to show up.
  const pairKeys = new Set(keys.map((k) => screenOf(k, recA[k], recB[k])));
  for (const [side, f] of [['before', failedA], ['after', failedB]]) {
    for (const screen of Object.keys(f)) if (!pairKeys.has(screen)) why(`${screen}__FAILED`, `FAILED: ${f[screen].error ?? 'unknown error'} (${side})`);
  }
  const inconclusive = [...whys].map(([key, list]) => ({ key, why: list.join('; ') }));

  // 1 = an expectation NOT MET, a change no expectation covers, or new overflow. 2 = nothing failed, but something
  // could not be observed. 0 = proof.
  const notMet = evaluated.filter((e) => e.result === 'NOT MET');
  const unobserved = evaluated.filter((e) => e.result === 'not observed' || e.result === 'already true before' || e.result === 'error');
  const newFindings = pairs.some((p) => p.checks?.new.length || p.tour?.new.length || p.console?.new.length);
  const exit = notMet.length || unexpected.length || overflow.length || newFindings ? 1 : unobserved.length || inconclusive.length ? 2 : 0;

  const allEls = pairs.flatMap((p) => p.elements);
  const changed = allEls.filter((e) => e.status === 'changed').length;
  const drift = allEls.filter((e) => e.status === 'drift').length;
  const eyes = pairs.filter((p) => (p.status === 'new' || p.pixel?.changed) && !p.after?.skipped?.length).map((p) => p.key);
  const count = (pick) => pairs.reduce((n, p) => n + (pick(p)?.length ?? 0), 0);
  const standing = { checks: count((p) => p.checks?.standing), tour: count((p) => p.tour?.standing), console: count((p) => p.console?.standing) };
  const metricsStanding = pairs.reduce((n, p) => n + (p.metrics?.standing ?? 0), 0);
  const result = { viewport, exit, pairs, expectations: evaluated, unexpected, overflow, inconclusive, eyes, standing, metricsStanding, fresh };
  result.md = summaryMd(result, maxLines, unexplained);
  const extras = [
    [unexpectedTrees.length ? pairs.reduce((n, p) => n + unexplained(p).added.length + unexplained(p).removed.length, 0) : 0, 'tree lines unexplained'],
    [count((p) => p.checks?.new), 'new check(s)'],
    [count((p) => p.tour?.new), 'new tour problem(s)'],
    [eyes.length, 'to eyes'],
  ].filter(([n]) => n);
  result.checkLine = [
    `${viewport}: ${exit === 0 && !changed && !drift ? 'identical' : `exit ${exit}, ${changed} changed, ${drift} on one side only, ${inconclusive.length} inconclusive`}${extras.map(([n, t]) => `, ${n} ${t}`).join('')}`,
    ...pairs.filter((p) => p.status !== 'same' || p.elements.some((e) => e.status !== 'same')).map((p) => `  ${p.key}: ${p.status} ${p.elements.filter((e) => e.status !== 'same').map((e) => `${e.k} (${e.status})`).join(', ')}`.trimEnd()),
    ...evaluated.filter((e) => e.result !== 'met' && e.result !== 'n/a').map((e) => `  expect ${e.name}: ${e.result}`),
  ].join('\n');
  return result;
}

// ---- summary.md ------------------------------------------------------------------------------------------------

function styleDelta(e) {
  const props = ['background', 'color', 'border'].filter((p) => e.before.style?.[p] !== e.after.style?.[p]);
  return props.map((p) => `${p} ${e.before.style?.[p]} → ${e.after.style?.[p]}`).join(', ');
}

function summaryMd(r, maxLines, unexplained) {
  const lines = [];
  const bad = (x) => (x.result === 'NOT MET' ? 0 : x.result === 'not observed' || x.result === 'already true before' ? 1 : 2);
  for (const x of [...r.expectations].sort((p, q) => bad(p) - bad(q))) lines.push(`- expect ${x.name}: ${x.result}${x.detail ? ` — ${x.detail}` : ''}`);
  for (const p of r.pairs) {
    if (p.status === 'gone') continue;
    const els = p.elements.filter((e) => e.status !== 'same' || (e.expectation && !e.met));
    if (p.status !== 'same' || els.length) lines.push(...elementLine(p, els));
    lines.push(...step3Lines(p, unexplained(p)));
  }
  for (const o of r.overflow) lines.push(`- ${o.key}: overflow NEW +${o.by}px${o.text ? ` "${o.text}"` : ''}`);
  for (const i of r.inconclusive) lines.push(`- inconclusive ${i.key}: ${i.why}`);
  const same = r.pairs.filter((p) => p.status === 'same' && !p.elements.some((e) => e.expectation && !e.met)).length;
  const room = Math.max(2, maxLines - 3);
  const shown = lines.length > room ? [...lines.slice(0, room - 1), `- … ${lines.length - room + 1} more (see results.json)`] : lines;
  return [`## ${r.viewport} — exit ${r.exit}`, ...shown, `- ${same} of ${r.pairs.length} pairs unchanged`].join('\n');
}

function elementLine(p, els) {
  const what = els.map((e) => {
    const label = `"${(e.after ?? e.before).text}"`;
    const note = e.expectation ? (e.met ? ` (expected: ${e.expectation})` : ` (${e.verdict}: ${e.expectation})`) : e.status === 'changed' ? ' UNEXPECTED' : '';
    return `${label} ${e.status === 'changed' ? styleDelta(e) || 'changed' : e.status === 'drift' ? (e.before ? 'only before' : 'only after') : e.status}${note}`;
  });
  const none = p.tree && !p.tree.same ? 'accessibility tree changed' : `${p.elements.length} watched element(s)`;
  const word = p.status === 'same' ? 'unchanged' : p.newOnHead ? `new on head (${p.newOnHead})` : p.status;
  return [`- ${p.key}: ${word} — ${what.length ? what.join('; ') : none}`];
}

// The lines a pair adds for the step-3 signals; each only when there is something to say.
function step3Lines(p, left) {
  const lines = [];
  if (p.tree && !p.tree.same) {
    const own = (list, sign, un) => list.map((x) => ({ text: `  ${sign} ${x.line}`, un: un.includes(x.line) }));
    const diffLines = [...own(p.tree.added, '+', left.added), ...own(p.tree.removed, '-', left.removed)];
    const shown = [...diffLines.filter((x) => x.un), ...diffLines.filter((x) => !x.un)].slice(0, 5);
    lines.push(`- ${p.key} tree: +${p.tree.added.length} -${p.tree.removed.length}`, ...shown.map((x) => x.text));
  }
  if (p.pixel?.changed) lines.push(`- ${p.key} pixels: worst tile ${p.pixel.worstTile.toFixed(3)}, ${(p.pixel.ratio * 100).toFixed(1)}% changed — send to eyes`);
  if (p.checks && (p.checks.new.length || p.checks.fixed.length)) {
    lines.push(`- ${p.key} checks: ${p.checks.new.length} new, ${p.checks.standing.length} standing, ${p.checks.fixed.length} fixed`, ...p.checks.new.map((f) => `  new ${f.check}: ${f.detail}`));
  }
  const t = p.tour;
  if (t && (t.new.length || t.fixed.length || t.failed)) {
    lines.push(`- ${p.key} tour: ${t.opened} opened, ${t.failed} failed, ${t.hover - t.hoverSilent}/${t.hover} hovers answer, ${t.new.length} new problem(s)`, ...t.new.map((x) => `  new: ${x}`));
  }
  if (p.console?.new.length) lines.push(`- ${p.key} console: ${p.console.new.length} new`, ...p.console.new.map((x) => `  new: ${x}`));
  if (p.metrics?.flags.length) lines.push(`- ${p.key} metrics: ${p.metrics.flags.length} flag(s)`, ...p.metrics.flags.map((f) => `  ${metricsLine(f)}`));
  return lines;
}

// ---- compare ---------------------------------------------------------------------------------------------------

const capturedViewports = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((v) => {
        const sub = path.join(dir, v);
        return fs.statSync(sub).isDirectory() && fs.readdirSync(sub).some((f) => JSON_EXT.test(f));
      })
    : [];

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const ICON = { met: 'ok', same: 'ok', 'NOT MET': 'bad', changed: 'bad', 'already true before': 'meh', 'not observed': 'meh', drift: 'meh', gone: 'meh', new: 'new', 'n/a': 'dim' };

const CSS = `:root{color-scheme:light dark;--fg:#222;--bg:#fff;--line:#ddd;--ok:#1d6b12;--bad:#a40000;--meh:#8a5a00;--new:#1d4fa0;--dim:#777}
@media(prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#181818;--line:#3a3a3a;--ok:#6fcf5f;--bad:#ff7b7b;--meh:#e0b050;--new:#7aaaf0;--dim:#999}}
body{font:14px system-ui,sans-serif;margin:24px;color:var(--fg);background:var(--bg)}h1{font-size:20px}h2{font-size:17px;margin:28px 0 6px;border-bottom:2px solid var(--line);padding-bottom:4px}
table{border-collapse:collapse;margin:8px 0;width:100%}td,th{border:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}
img,video{max-width:100%;border:1px solid var(--line)}td img.shot{width:260px}img.crop{max-height:60px}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.meh{color:var(--meh);font-weight:600}.new{color:var(--new);font-weight:600}.dim{color:var(--dim)}
.s{font:11px ui-monospace,monospace;color:var(--dim)}.d{margin:0 0 8px}.warn{color:var(--meh)}`;

export async function compare({ beforeDir, afterDir, expect = null, out, profile = {}, viewports = null, newScreens = {} }) {
  for (const [label, dir] of [['before', beforeDir], ['after', afterDir]]) if (!fs.existsSync(dir)) throw new Error(`${label} directory not found: ${dir}`);
  const expectations = Array.isArray(expect) ? expect : expect ? readJson(expect) : [];
  if (!Array.isArray(expectations)) throw new Error('the expectations file must be a JSON array');
  // Every viewport head captured: one base has nothing for (every screen in scope new on head, so base walked none)
  // is compared against an empty before side, and each of its screens is judged new on head.
  const names = viewports?.length ? viewports : capturedViewports(afterDir).sort();
  if (!names.length) throw new Error(`no viewport was captured under ${afterDir}`);

  const sides = names.map((v) => ({ before: readSide(beforeDir, v), after: readSide(afterDir, v) }));
  const perViewport = Math.max(8, Math.floor(130 / names.length) - 2);
  const full = names.map((viewport, i) => compareViewport({ ...sides[i], viewport, expectations, profile, maxLines: perViewport, newScreens }));
  const exit = full.some((r) => r.exit === 1) ? 1 : full.some((r) => r.exit === 2) ? 2 : 0;
  const result = { exit, viewports: full.map(({ md, ...r }) => r) };

  fs.mkdirSync(out, { recursive: true });
  const verdict = ['proof', 'failed', 'inconclusive'][exit];
  fs.writeFileSync(path.join(out, 'summary.md'), [`# qa compare — ${verdict} (exit ${exit})`, '', ...full.flatMap((r) => [r.md, ''])].join('\n'));
  fs.writeFileSync(path.join(out, 'index.html'), indexHtml({ full, sides, out, verdict, exit }));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

function indexHtml({ full, sides, out, verdict, exit }) {
  // Every image and video the page shows is copied under <out>/media/ and linked relatively, so the folder moves as one.
  const media = (viewport, side, file) => {
    if (!file || !fs.existsSync(file)) return null;
    const dest = path.join(out, 'media', viewport, side, path.basename(file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    return `media/${enc(`${viewport}/${side}/${path.basename(file)}`)}`;
  };
  const img = (viewport, side, dir, name, cls) => {
    const href = media(viewport, side, path.join(dir, name));
    return href ? `<a href="${href}"><img class="${cls}" src="${href}" alt="${esc(name)}"></a>` : '<em class="dim">no image</em>';
  };
  const cls = (v) => ICON[v] ?? 'meh';
  const exps = full[0]?.expectations ?? [];
  const failedAny = full.flatMap((r) => r.unexpected.map((u) => `${r.viewport} › ${u.key} › ${u.element ?? `tree +${u.added.length} -${u.removed.length}`}`));
  const expSection = exps.length || failedAny.length
    ? `<h2>Expectations</h2>${exps.length ? `<table><tr><th>expected change</th>${full.map((r) => `<th>${esc(r.viewport)}</th>`).join('')}</tr>${exps.map((x, i) => `<tr><td>${esc(x.describe)}</td>${full.map((r) => {
        const e = r.expectations[i];
        return `<td class="${cls(e.result)}">${esc(e.result)}<div class="s">${esc(e.detail)}</div></td>`;
      }).join('')}</tr>`).join('')}</table>` : ''}
<p class="${failedAny.length ? 'bad' : 'dim'}">${failedAny.length ? `${failedAny.length} unexpected change(s): ${esc(failedAny.slice(0, 20).join(' · '))}` : 'No unexpected changes.'}</p>`
    : '';
  const viewportSection = (r, i) => {
    const { before, after } = sides[i];
    const rows = r.pairs.map((p) => {
      const diffs = p.elements.filter((e) => e.status !== 'same' || (e.expectation && !e.met));
      const style = (e) => (e ? `<div class="s">${esc(e.style?.background)} · ${esc(e.style?.color)} · ${esc(e.style?.border)}</div>` : '<em class="dim">not present</em>');
      const crop = (side, dir, e) => (e?.shot ? img(r.viewport, side, dir, e.shot, 'crop') : '');
      const deltas = diffs.map((e) => `<div class="d"><b>${esc(e.k)}</b> <span class="${cls(e.expectation ? (e.met ? 'met' : 'NOT MET') : e.status)}">${esc(e.expectation ? e.verdict : e.status === 'changed' ? 'UNEXPECTED' : e.status)}</span><div class="s">${esc((e.after ?? e.before).context)}</div>${crop('before', before.dir, e.before)}${style(e.before)}${crop('after', after.dir, e.after)}${style(e.after)}</div>`).join('');
      const tourShots = (p.after?.tour?.opened ?? []).filter((o) => o.shot).map((o) => `<div class="s">${esc(o.control)}</div>${img(r.viewport, 'after', after.dir, o.shot, 'shot')}`).join('');
      const note = (r.inconclusive.find((x) => x.key === p.key)?.why ?? '') + (r.overflow.filter((o) => o.key === p.key).map((o) => `NEW OVERFLOW ${o.text} +${o.by}px`).join('; '));
      return `<tr><td>${esc(p.key)}</td><td>${p.before ? img(r.viewport, 'before', before.dir, `${p.key}.png`, 'shot') : '<em class="dim">none</em>'}</td><td>${p.after ? img(r.viewport, 'after', after.dir, `${p.key}.png`, 'shot') : '<em class="dim">none</em>'}${tourShots}</td><td class="${cls(p.status)}">${esc(p.newOnHead ? `new on head (${p.newOnHead})` : p.status)}${note ? `<div class="warn s">${esc(note)}</div>` : ''}</td><td>${deltas || `<span class="dim">${p.elements.length} watched, no change</span>`}</td></tr>`;
    });
    const vids = [...new Set([...Object.keys(before.videos), ...Object.keys(after.videos)])].flatMap((screen) =>
      [['before', before], ['after', after]].filter(([, s]) => s.videos[screen]).map(([name, s]) => {
        const href = media(r.viewport, name, s.videos[screen]);
        return href ? `<figure><figcaption>${esc(name)} › ${esc(screen)}</figcaption><video controls muted preload="metadata" src="${href}"></video></figure>` : '';
      }));
    return `<h2>${esc(r.viewport)} — exit ${r.exit}</h2>
${vids.length ? `<div>${vids.join('')}</div>` : ''}
<table><tr><th>key</th><th>before</th><th>after</th><th>status</th><th>element deltas</th></tr>${rows.join('')}</table>`;
  };
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>qa compare</title>
<style>${CSS}</style>
<h1>qa: before vs after — ${esc(verdict)} (exit ${exit})</h1>
${expSection}
${full.map(viewportSection).join('\n')}
`;
}
