// The eyes pass (decisions 4, 9): a clean-context look at each changed or new screen, as the person
// who will use it. This module writes the brief and reads the answers; the looking is the `qa-eyes`
// agent (agents/qa-eyes.md, Opus), dispatched by the qa skill with the brief this writes. The screens come from results.json (results.eyes) instead of
// diff.json, and every screen is named by its summary id so a verdict finding can cite it.
//
// CONTRACT (tests: test/eyes.test.mjs)
//
//   CORE_QUESTIONS (exported, frozen): [[name, question]] x 6, in this order and wording:
//     First look   'What do you see first? Should it be? What is this screen for, in one line, from the screen alone?'
//     Reading      'Can everything be read without effort: size, weight, wrapping, words that do not explain themselves?'
//     Tapping      'What can be tapped? Is each one obviously tappable, and is anything that looks tappable not? Is the main action where a thumb reaches it?'
//     Broken       'Does anything look broken, cramped, misaligned, cut off, doubled or out of place?'
//     Trust        'Would I trust this with my data, or my money if it shows any? Do the figures look right and consistent, signs and units as everywhere else, and nothing alarming without a reason?'
//     Against the base  'Only after judging the branch on its own: open the base shot. What got better, what got worse, and is every change one a person would want?'
//   VERDICTS (exported, frozen): ['fine', 'look again', 'wrong']
//
//   eyesTargets(results, { work, cacheDir = null, exists, ids = results.eyes }) -> [Target]
//     Target = { id, viewport, key, screen, status, ratio, tree, after, before }
//     One per id in `ids` (deduplicated) that is a results.screens id with a non-null key (other
//     ids skipped), with
//     viewport/key/screen/status from that screen, ratio = screen.pixel?.ratio ?? null,
//     tree = screen.tree ? { added, removed } : null.
//     after  = the first path p with exists(p) of:
//                <work>/compare/media/<viewport>/after/<key>.png, <work>/head/<viewport>/<key>.png
//              else null.
//     before = the first path p with exists(p) of:
//                <work>/compare/media/<viewport>/before/<key>.png,
//                <cacheDir>/<viewport>/<key>.png (only when cacheDir), <work>/base/<viewport>/<key>.png
//              else null; always null for a screen with status 'new' (new on head: report.html shows
//              head only, and base may hold a file of that name from another walk).
//     (path.join for every path.) Order: by ratio descending, a null ratio counting as 1 (a new
//     screen is wholly changed); ties keep `ids` order. Pure apart from `exists`.
//
//   eyesPrompt({ slug, out, targets, questions = [], asks = [] }) -> string
//     out = the verification dir. Exactly these lines, joined with '\n', ending with '\n':
//       Eyes pass for <slug>. Write <out>/eyes.md as your instructions (agents/eyes.md) say.
//       (blank)
//       Read ONLY this brief and the screenshots it lists. Nothing else: not the code, the spec, summary.md or any other file.
//       (blank)
//       ## Screens to look at (<targets.length>)
//       (blank)
//       per target, in order:
//         ### [<id>] <screen> — <status>
//         - branch: <after ?? 'missing'>
//         - base: <before>                          (only when before)
//         - measured: <parts joined ' · '>          (only when a part exists; parts: 'pixels <ratio*100, 1 decimal>% differ'
//                                                    when ratio is a number, 'tree +<added> −<removed>' when tree)
//         (blank)
//       ## Questions — answer every one for every screen, in writing
//       (blank)
//       <i>. **<name>.** <question>                 CORE_QUESTIONS, i from 1
//       <i>. <question>                             each of `questions` (the project's own), numbering on
//       <i>. **<ask.id>.** <ask.ask>                each open escape Ask, numbering on
//       (blank)
//       Write one section per screen, headed exactly `## [<id>] <screen>`. End each with one line: `Verdict: fine | look again | wrong — <the one thing to fix first>`.
//       `wrong` = a person would be misled, stuck or put off; `look again` = it works but reads worse than it should.
//
//   parseEyes(text) -> [{ id, verdict, fix }]
//     A section starts at a line matching /^##\s+\[([^\]]+)\]/ (id = the bracket's content) and
//     runs to the next line starting '## ' or '# '. In a section, the first line matching
//     /^\s*\**verdict\**\s*:\s*\**\s*(fine|look again|wrong)\b\**\s*(?:[—–:-]+\s*(.*))?$/i sets
//     verdict (lower-cased) and fix (group 2 trimmed, '' when absent). A section with no such line
//     -> verdict null, fix ''. A '## ' heading without [id] adds nothing. null/'' -> [].
//
//   ESCAPES_HEADER = '| id | found | what | could have caught | ask | closed by |'
//   openAsks(text) -> [{ id, ask }]
//     qa/escapes.md (decision 19): the rows of the first table whose header row is exactly
//     ESCAPES_HEADER (trailing spaces ignored), separator row skipped, rows = the following lines
//     starting '|'. Cells split on '|' not preceded by '\', trimmed, '\|' read as '|'. A row is
//     open when its 'closed by' cell is empty and its 'ask' cell is not. null or no table -> [].

//   EYES CACHE (rework U8, design 2026-11-12 §9 and §17 answer 6; tests: test/eyes-cache.test.mjs). Eyes rulings are
//   cached by the screenshot's image hash in qa/<slug>/eyes-cache.json:
//     { rulings: { <sha256>: { id, screen, verdict, fix, body, round, head, at } },   a ruling per image
//       ids: { <screen id>: <sha256> },                                              the last image of each screen
//       current: { round, head, targets: [{ id, screen, hash }] },                   this round's eyes targets
//       waivers: { <waiver line>: <sha256> } }                                       the image each eyes waiver was given for
//   imageHash(bytes) -> sha256 hex.
//   eyesSections(text) -> [{ id, heading, body }]   each '## [<id>] …' section of eyes.md; body = its lines up to the
//     next '## ' or '# ' heading, trailing blank lines cut. null -> [].
//   eyesRound({ targets, cache, hashOf, round, head }) -> { fresh, cached: [{ target, ruling }], cache }
//     hashOf(target) -> the image hash of target.after, or null (no file: never cached). A target whose hash has a
//     ruling is cached; the rest are fresh (the eyes pass looks at those only). The returned cache (a copy) has ids[id]
//     set for every hashed target and current = { round, head, targets: [{ id, screen, hash }] }.
//   mergeEyes({ slug, eyesMd, cache, at }) -> { md, cache, added, cached }
//     For each current target, in order: its section in eyesMd (the eyes pass's new ruling) when there is one — a
//     section with a verdict line is kept in the cache under its image (added) — else its image's cached ruling, written
//     as '## [<id>] <screen>', then '(cached from round <r>, <head12>: the same screenshot, sha256 <hash12>)', then the
//     ruling's body (cached). Sections of eyesMd for other ids follow, as written. md = '# Eyes — <slug>', a blank line,
//     then each section followed by a blank line.
//   bindEyesWaivers(waiversMd, cache) -> { text, cache, changed, stale }
//     A waiver of a screen id (scr:…) whose screen has an image hash (cache.ids) is bound to that image the first time it
//     is seen (cache.waivers[<the line>] = hash; changed true), and is dropped from text (stale) once the screen's image
//     is another: a waived eyes ruling stays waived while the image is unchanged. Other waivers are kept as they are.
//     The CLI reads every waivers.md through it (waiversText), so the run, the draft, the gate and the report agree.

import { createHash } from 'node:crypto';
import path from 'node:path';

export const CORE_QUESTIONS = Object.freeze([
  Object.freeze(['First look', 'What do you see first? Should it be? What is this screen for, in one line, from the screen alone?']),
  Object.freeze(['Reading', 'Can everything be read without effort: size, weight, wrapping, words that do not explain themselves?']),
  Object.freeze(['Tapping', 'What can be tapped? Is each one obviously tappable, and is anything that looks tappable not? Is the main action where a thumb reaches it?']),
  Object.freeze(['Broken', 'Does anything look broken, cramped, misaligned, cut off, doubled or out of place?']),
  Object.freeze(['Trust', 'Would I trust this with my data, or my money if it shows any? Do the figures look right and consistent, signs and units as everywhere else, and nothing alarming without a reason?']),
  Object.freeze(['Against the base', 'Only after judging the branch on its own: open the base shot. What got better, what got worse, and is every change one a person would want?']),
]);
export const VERDICTS = Object.freeze(['fine', 'look again', 'wrong']);
export const ESCAPES_HEADER = '| id | found | what | could have caught | ask | closed by |';

export function eyesTargets(results, { work, cacheDir = null, exists, ids = results.eyes }) {
  const first = (paths) => paths.find((p) => exists(p)) ?? null;
  const targets = [];
  for (const id of new Set(ids)) {
    const s = results.screens.find((x) => x.id === id);
    if (!s || s.key == null) continue;
    const { viewport, key } = s;
    targets.push({
      id,
      viewport,
      key,
      screen: s.screen,
      status: s.status,
      ratio: s.pixel?.ratio ?? null,
      tree: s.tree ? { added: s.tree.added, removed: s.tree.removed } : null,
      after: first([
        path.join(work, 'compare', 'media', viewport, 'after', `${key}.png`),
        path.join(work, 'head', viewport, `${key}.png`),
      ]),
      // A screen new on head has no before picture, even when base left a file of that name (another walk).
      before: s.status === 'new' ? null : first([
        path.join(work, 'compare', 'media', viewport, 'before', `${key}.png`),
        ...(cacheDir ? [path.join(cacheDir, viewport, `${key}.png`)] : []),
        path.join(work, 'base', viewport, `${key}.png`),
      ]),
    });
  }
  // Array.prototype.sort is stable, so ties keep the ids order.
  return targets.sort((a, b) => (b.ratio ?? 1) - (a.ratio ?? 1));
}

export function eyesPrompt({ slug, out, targets, questions = [], asks = [] }) {
  const lines = [
    `Eyes pass for ${slug}. Write ${out}/eyes.md as your instructions (agents/eyes.md) say.`,
    '',
    'Read ONLY this brief and the screenshots it lists. Nothing else: not the code, the spec, summary.md or any other file.',
    '',
    `## Screens to look at (${targets.length})`,
    '',
  ];
  for (const t of targets) {
    lines.push(`### [${t.id}] ${t.screen} — ${t.status}`, `- branch: ${t.after ?? 'missing'}`);
    if (t.before) lines.push(`- base: ${t.before}`);
    const measured = [];
    if (typeof t.ratio === 'number') measured.push(`pixels ${(t.ratio * 100).toFixed(1)}% differ`);
    if (t.tree) measured.push(`tree +${t.tree.added} −${t.tree.removed}`);
    if (measured.length) lines.push(`- measured: ${measured.join(' · ')}`);
    lines.push('');
  }
  lines.push('## Questions — answer every one for every screen, in writing', '');
  let n = 0;
  for (const [name, q] of CORE_QUESTIONS) lines.push(`${++n}. **${name}.** ${q}`);
  for (const q of questions) lines.push(`${++n}. ${q}`);
  for (const a of asks) lines.push(`${++n}. **${a.id}.** ${a.ask}`);
  lines.push(
    '',
    'Write one section per screen, headed exactly `## [<id>] <screen>`. End each with one line: `Verdict: fine | look again | wrong — <the one thing to fix first>`.',
    '`wrong` = a person would be misled, stuck or put off; `look again` = it works but reads worse than it should.',
    '',
  );
  return lines.join('\n');
}

const VERDICT_LINE = /^\s*\**verdict\**\s*:\s*\**\s*(fine|look again|wrong)\b\**\s*(?:[—–:-]+\s*(.*))?$/i;

export function parseEyes(text) {
  const rows = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) {
      const m = line.match(/^##\s+\[([^\]]+)\]/);
      cur = m ? { id: m[1], verdict: null, fix: '' } : null;
      if (cur) rows.push(cur);
      continue;
    }
    if (!cur || cur.verdict) continue;
    const m = line.match(VERDICT_LINE);
    if (m) {
      cur.verdict = m[1].toLowerCase();
      cur.fix = (m[2] ?? '').trim();
    }
  }
  return rows;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

export function openAsks(text) {
  if (text == null) return [];
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex((l) => l.trimEnd() === ESCAPES_HEADER);
  if (at < 0) return [];
  const out = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    const [id, , , , ask, closedBy] = cells(line);
    if (ask && !closedBy) out.push({ id, ask });
  }
  return out;
}

// ── the eyes cache (U8) ──────────────────────────────────────────────────────

export const imageHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function eyesSections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) {
      const m = line.match(/^##\s+\[([^\]]+)\]/);
      cur = m ? { id: m[1], heading: line, lines: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return out.map((x) => {
    const lines = [...x.lines];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return { id: x.id, heading: x.heading, body: lines.join('\n') };
  });
}

export function eyesRound({ targets, cache = {}, hashOf, round = null, head = null }) {
  const rulings = cache?.rulings ?? {};
  const ids = { ...(cache?.ids ?? {}) };
  const fresh = [];
  const cached = [];
  const current = [];
  for (const t of targets ?? []) {
    const hash = hashOf(t) ?? null;
    current.push({ id: t.id, screen: t.screen, hash });
    if (hash) ids[t.id] = hash;
    if (hash && rulings[hash]) cached.push({ target: t, ruling: rulings[hash] });
    else fresh.push(t);
  }
  return { fresh, cached, cache: { ...cache, rulings, ids, current: { round, head, targets: current } } };
}

export function mergeEyes({ slug, eyesMd = null, cache = {}, at = new Date().toISOString() }) {
  const rulings = { ...(cache?.rulings ?? {}) };
  const current = cache?.current ?? { round: null, head: null, targets: [] };
  const sections = eyesSections(eyesMd);
  const parsed = new Map(parseEyes(eyesMd).map((e) => [e.id, e]));
  const own = new Map(sections.map((x) => [x.id, x]));
  const blocks = [];
  const added = [];
  const cachedIds = [];
  const seen = new Set();
  for (const t of current.targets ?? []) {
    seen.add(t.id);
    const mine = own.get(t.id);
    if (mine) {
      blocks.push([`## [${t.id}] ${t.screen}`, ...(mine.body ? [mine.body] : [])].join('\n'));
      const e = parsed.get(t.id);
      if (t.hash && e?.verdict) {
        rulings[t.hash] = { id: t.id, screen: t.screen, verdict: e.verdict, fix: e.fix, body: mine.body, round: current.round, head: current.head, at };
        added.push(t.id);
      }
      continue;
    }
    const r = t.hash ? rulings[t.hash] : null;
    if (!r) continue;
    blocks.push([`## [${t.id}] ${t.screen}`, `(cached from round ${r.round ?? '?'}, ${String(r.head ?? '').slice(0, 12)}: the same screenshot, sha256 ${t.hash.slice(0, 12)})`, ...(r.body ? [r.body] : [])].join('\n'));
    cachedIds.push(t.id);
  }
  for (const x of sections) if (!seen.has(x.id)) blocks.push([x.heading, ...(x.body ? [x.body] : [])].join('\n'));
  const md = [`# Eyes — ${slug}`, '', ...blocks.flatMap((b) => [b, ''])].join('\n');
  return { md, cache: { ...cache, rulings }, added, cached: cachedIds };
}

const WAIVER_LINE = /^- \[(scr:[^\]]+)\] waived: /;

export function bindEyesWaivers(waiversMd, cache = {}) {
  if (waiversMd == null) return { text: waiversMd, cache, changed: false, stale: [] };
  const ids = cache?.ids ?? {};
  const bound = { ...(cache?.waivers ?? {}) };
  let changed = false;
  const stale = [];
  const kept = [];
  for (const line of String(waiversMd).split('\n')) {
    const id = line.match(WAIVER_LINE)?.[1];
    const hash = id ? ids[id] : null;
    if (!hash) { kept.push(line); continue; }
    const key = line.trim();
    if (!Object.hasOwn(bound, key)) { bound[key] = hash; changed = true; }
    if (bound[key] === hash) kept.push(line);
    else stale.push(id);
  }
  return { text: kept.join('\n'), cache: changed ? { ...cache, waivers: bound } : cache, changed, stale };
}
