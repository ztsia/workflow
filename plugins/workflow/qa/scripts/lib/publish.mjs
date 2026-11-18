// Where a verification's report goes and how people see it (rework U9, design §12). A local session's report stays on
// its machine; a cloud session's is published as a private claude.ai artifact on the user's own account, by the
// session itself with its Artifact tool: these functions only decide, prepare files and record URLs, and the PR gets
// one comment, edited each round. Pure, except the three small readers (whereAmI, sessionAccount) and postComment,
// whose inputs are injectable. Zero model calls; nothing here names an app, a screen or a person.
//
// CONTRACT (tests: test/publish.test.mjs)
//
//   LIMITS (frozen) = { pageBytes: 16e6, fileBytes: 15e6, publishBytes: 64e6, publishFiles: 255, pageReserve: 1e6 }
//     The Artifact tool's limits, in decimal megabytes so a part never sits on the edge: a page ≤ 16 MB, each binary
//     file ≤ 15 MB, one publish ≤ 64 MB and ≤ 255 files with the page counted among them; pageReserve is the room a part
//     keeps for its page. QA_PUBLISH_LIMITS (JSON, merged over LIMITS) overrides them in the CLI (tests).
//   MEDIA_TYPES = { '.png': 'image/png', '.webm': 'video/webm' }   what goes up: PNG screenshots and webm journeys, the
//     files the run wrote, byte for byte (no re-encode, no lossy compression).
//
//   publishedShots(results, shots) -> shots   only the screens that are new or changed: results.screens status new,
//     changed or gone, pixel.changed true, or an id in results.eyes. A finding on an unchanged screen keeps its text; its
//     pictures stay in the local report only.
//   mediaItems({ shots, videos }) -> [{ path, kind: 'image' | 'video', label }]   in publish order: every picture first,
//     per shot id in its order the branch picture then the base one ('<id> · branch' / '<id> · base'), then every video
//     ('<id> · <screen> <viewport>'). path is the src the page uses, relative to it, which is also its published path.
//   packParts(items, limits = LIMITS) -> { parts: [[item]], left: [{ ...item, why }] }   items carry bytes. One over
//     fileBytes is left out ('over the <n> MB per-file limit'). The rest go, in order, into the current part while it
//     holds fewer than publishFiles - 1 files and its bytes plus the next stay within publishBytes - pageReserve; the
//     next file that would pass either opens a new part. Part 1 always exists: it holds the report, file or not.
//   placeOf({ parts, left, urls = [] }) -> { [path]: { part, href } | { left: why } }   where the part-1 page finds a
//     file it cannot show itself: on part n ≥ 2, href = urls[n - 1] or '#part-<n>' until that URL is known
//     (linkPart fills it); left out, why. Part 1's own files are absent (shown in place).
//   linkPart(html, part, url) -> html   every '<a … data-part="<part>" href="…"' now points at url.
//   partHtml({ slug, verdict, head, part, of, items, back = null }) -> string   the artifact page for part n ≥ 2: a
//     fragment (no doctype, html, head or body: the publisher wraps it), '<title><slug> QA report part <n></title>' first,
//     the page contract's viewport meta and theme tokens (report.mjs PAGE_CSS), a line saying part 1 holds the verdict
//     (a link, data-part="1", when back — part 1's URL from an earlier round — is known; plain text before), then each
//     item: an <img> or a <video controls> with its label.
//   publishPlan({ slug, head, verdict, parts, left, pages, urls, limits }) -> PublishJson   (V/publish.json)
//     pages: [{ file (absolute), bytes, title }] one per part. Each part's items carry from (absolute) and bytes.
//     { slug, head, verdict, limits, total: { files, bytes } (media only),
//       artifacts: [{ part, of, page: file, title, url: urls[part - 1] ?? null, icon: 'report', description,
//                     capabilities: { assets: {} } when the part holds a video (the upload is refused without it) else null,
//                     files: { path: from } (the Artifact tool's files map), list: [{ path, from, bytes, type }],
//                     bytes: page + files, videos: count }],
//       left: [{ path, from, bytes, why }] }
//
//   decideReport({ where, session, launcher }) -> { where, publish, why, reason? }
//     local -> publish false (the report stays on this machine). cloud -> publish true, unless session and launcher are
//     both known and differ: publish false, reason 'not your account' (an artifact is private to the account that
//     publishes it). An unknown account publishes: a cloud environment is personal.
//   whereAmI({ env = process.env, home = os.homedir() }) -> 'cloud' | 'local'
//     env.QA_WHERE ('cloud' | 'local'), else env.CLAUDE_CODE_REMOTE === 'true' (Claude Code on the web), else 'local'.
//   sessionAccount({ env = process.env, home = os.homedir() }) -> uuid | null   env.QA_ACCOUNT, else
//     <home>/.claude.json oauthAccount.accountUuid, else null.
//   launchAccount(text) -> uuid | null   the `account` of a launch record (JSON text); null when absent or unreadable.
//
//   localLine(host, file) = 'Report: on <host> at <file>'; urlLine(url) = 'Report: <url>';
//   notPublishedLine(reason) = 'Report: NOT PUBLISHED — <reason>'   (verdict.mjs parseReportLine reads all three)
//   withReportLine(verdictMd, line) -> verdictMd   every earlier 'Report: ' line removed, trailing blank lines dropped,
//     then line as the last line, the file ending in one newline.
//   recordUrl(published, { slug, part, url, head, at, of = null }) -> published.json
//     { slug, parts: [url | null] (index part - 1), retired: [url], head, at }. A different URL for a part retires the
//     old one; of (part 1's publish: the number of parts now) retires every part URL beyond it.
//
//   COMMENT_MARKER = '<!-- qa:report -->'   the hidden first line of the one comment per PR.
//   commentBody({ verdictMd, slug }) -> markdown   the marker; '### qa: <outcome>'; slug, head (12) and the criteria
//     line; 'Gating' (FAIL rows, Blockers, rows whose text has '— gates'), 'Needs you' (UNVERIFIABLE rows not marked
//     advisory, with their 'would prove it' or 'ask'; a round cap's '[gap:cap]' line first, then the rows it caps and
//     the exp: ids those rows cite, which are the user's to decide and never under Gating), 'Blocked' (BLOCKED rows,
//     Gaps whose text starts BLOCKED), each
//     at most 15 rows then '… and <n> more in the report'; the report: its link, 'report on <host>' (the path in
//     code), 'not published — <reason>', or 'not placed yet'. Sections with no row are left out, but Gating, which
//     says '- none'.
//   postComment({ body, pr = null, gh }) -> { action: 'posted' | 'edited', url } | { skipped: why }
//     gh(args, input) -> { status, stdout, stderr, missing }. The PR: pr, else `gh pr view --json number,url` (the
//     branch's); none -> skipped 'no pull request for this branch'. The comment: the first id of
//     `gh api --paginate repos/{owner}/{repo}/issues/<n>/comments --jq <the ones whose body has the marker>`; found ->
//     `gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> --input -`, else `gh api -X POST
//     repos/{owner}/{repo}/issues/<n>/comments --input -`, stdin { body }. gh missing -> skipped 'gh is not installed
//     (…)'; any failing call -> skipped with its first stderr line. Never throws.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { esc } from './util.mjs';
import { PAGE_CSS } from './report.mjs';
import { capIds, parseVerdict } from './verdict.mjs';

export const LIMITS = Object.freeze({ pageBytes: 16e6, fileBytes: 15e6, publishBytes: 64e6, publishFiles: 255, pageReserve: 1e6 });
export const MEDIA_TYPES = Object.freeze({ '.png': 'image/png', '.webm': 'video/webm' });
export const COMMENT_MARKER = '<!-- qa:report -->';
const mb = (bytes) => `${Math.round(bytes / 1e5) / 10} MB`;

// ── the publish set ───────────────────────────────────────────────────────────

export function publishedShots(results, shots) {
  const eyes = new Set(results?.eyes ?? []);
  const screens = new Map((results?.screens ?? []).map((s) => [s.id, s]));
  const changed = (id) => {
    const s = screens.get(id);
    return eyes.has(id) || ['new', 'changed', 'gone'].includes(s?.status) || s?.pixel?.changed === true;
  };
  return Object.fromEntries(Object.entries(shots ?? {}).filter(([id]) => changed(id)));
}

export function mediaItems({ shots = {}, videos = [] }) {
  const items = [];
  for (const [id, s] of Object.entries(shots)) {
    if (s?.after) items.push({ path: s.after, kind: 'image', label: `${id} · branch` });
    if (s?.before) items.push({ path: s.before, kind: 'image', label: `${id} · base` });
  }
  for (const v of videos) items.push({ path: v.src, kind: 'video', label: `${v.id} · ${v.screen} ${v.viewport}` });
  return items;
}

export function packParts(items, limits = LIMITS) {
  const room = limits.publishBytes - limits.pageReserve;
  const parts = [[]];
  const left = [];
  let bytes = 0;
  for (const item of items) {
    if (item.bytes > limits.fileBytes) { left.push({ ...item, why: `over the ${mb(limits.fileBytes)} per-file limit (${mb(item.bytes)})` }); continue; }
    const cur = parts[parts.length - 1];
    if (cur.length && (cur.length >= limits.publishFiles - 1 || bytes + item.bytes > room)) { parts.push([]); bytes = 0; }
    parts[parts.length - 1].push(item);
    bytes += item.bytes;
  }
  return { parts, left };
}

export function placeOf({ parts, left = [], urls = [] }) {
  const place = {};
  parts.forEach((items, i) => {
    if (i === 0) return;
    for (const it of items) place[it.path] = { part: i + 1, href: urls[i] ?? `#part-${i + 1}` };
  });
  for (const it of left) place[it.path] = { left: it.why };
  return place;
}

export function linkPart(html, part, url) {
  return String(html).replace(new RegExp(`(data-part="${part}" href=")[^"]*(")`, 'g'), (_, a, b) => `${a}${esc(url)}${b}`);
}

export function partHtml({ slug, verdict, head, part, of, items, back = null }) {
  const media = items.map((it) => (it.kind === 'video'
    ? `<figure><video controls preload="metadata" src="${esc(it.path)}"></video><figcaption>${esc(it.label)}</figcaption></figure>`
    : `<figure><img src="${esc(it.path)}" alt="${esc(it.label)}"><figcaption>${esc(it.label)}</figcaption></figure>`));
  return `<title>${esc(`${slug} QA report part ${part}`)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${PAGE_CSS}</style>
<main>
<h1>${esc(slug)}: part ${part} of ${of}</h1>
<p class="meta">${esc(verdict ?? '')} · head <code>${esc(String(head ?? '').slice(0, 12))}</code>. The verdict, the criteria and the findings are on ${back ? `<a class="part" data-part="1" href="${esc(back)}" target="_blank" rel="noopener">part 1</a>` : 'part 1 of this report'}; this part holds the pictures and videos that did not fit there.</p>
<section class="media">
${media.join('\n')}
</section>
</main>
`;
}

export function publishPlan({ slug, head, verdict, parts, left = [], pages, urls = [], limits = LIMITS }) {
  const of = parts.length;
  const media = parts.flat();
  const artifacts = parts.map((items, i) => {
    const page = pages[i];
    const videos = items.filter((x) => x.kind === 'video').length;
    return {
      part: i + 1,
      of,
      page: page.file,
      title: page.title,
      url: urls[i] ?? null,
      icon: 'report',
      description: of > 1 ? `QA report for ${slug} at ${String(head).slice(0, 12)}: ${verdict}. Part ${i + 1} of ${of}.` : `QA report for ${slug} at ${String(head).slice(0, 12)}: ${verdict}.`,
      capabilities: videos ? { assets: {} } : null,
      files: Object.fromEntries(items.map((x) => [x.path, x.from])),
      list: items.map((x) => ({ path: x.path, from: x.from, bytes: x.bytes, type: MEDIA_TYPES[path.extname(x.path)] ?? 'application/octet-stream' })),
      bytes: page.bytes + items.reduce((n, x) => n + x.bytes, 0),
      videos,
    };
  });
  return {
    slug, head, verdict, limits: { ...limits },
    total: { files: media.length, bytes: media.reduce((n, x) => n + x.bytes, 0) },
    artifacts,
    left: left.map((x) => ({ path: x.path, from: x.from, bytes: x.bytes, why: x.why })),
  };
}

// ── where it goes ─────────────────────────────────────────────────────────────

export function decideReport({ where, session = null, launcher = null }) {
  if (where !== 'cloud') return { where: 'local', publish: false, why: 'a local session: the report stays on this machine, opened from its file' };
  if (!session) return { where, publish: true, why: 'a cloud session whose account cannot be read: a cloud environment is personal, so it is the user\'s own' };
  if (!launcher) return { where, publish: true, why: 'a cloud session with no launch record naming another account: published on this account' };
  if (session === launcher) return { where, publish: true, why: 'a cloud session on the launching person\'s own account' };
  return { where, publish: false, reason: 'not your account', why: 'a cloud session on an account that is not the launching person\'s: an artifact would be private to its owner' };
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

export function whereAmI({ env = process.env, home = os.homedir() } = {}) {
  if (env.QA_WHERE === 'cloud' || env.QA_WHERE === 'local') return env.QA_WHERE;
  return env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : 'local';
}

export function sessionAccount({ env = process.env, home = os.homedir() } = {}) {
  if (env.QA_ACCOUNT) return env.QA_ACCOUNT;
  try {
    return JSON.parse(readText(path.join(home, '.claude.json')) ?? 'null')?.oauthAccount?.accountUuid || null;
  } catch {
    return null;
  }
}

export function launchAccount(text) {
  try {
    const a = JSON.parse(text ?? 'null')?.account;
    return typeof a === 'string' && a ? a : null;
  } catch {
    return null;
  }
}

// ── the Report line and the URL record ────────────────────────────────────────

export const localLine = (host, file) => `Report: on ${host} at ${file}`;
export const urlLine = (url) => `Report: ${url}`;
export const notPublishedLine = (reason) => `Report: NOT PUBLISHED — ${String(reason).replace(/\s+/g, ' ').trim()}`;

export function withReportLine(verdictMd, line) {
  const lines = String(verdictMd ?? '').split(/\r?\n/).filter((l) => !l.startsWith('Report: '));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return `${[...lines, line].join('\n')}\n`;
}

export function recordUrl(published, { slug, part = 1, url, head = null, at = null, of = null }) {
  const parts = [...(published?.parts ?? [])];
  const retired = [...(published?.retired ?? [])];
  const retire = (u) => { if (u && !retired.includes(u) && !parts.includes(u)) retired.push(u); };
  while (parts.length < part) parts.push(null);
  const old = parts[part - 1];
  parts[part - 1] = url;
  if (old && old !== url) retire(old);
  if (of != null && parts.length > of) for (const u of parts.splice(of)) retire(u);
  return { slug: slug ?? published?.slug ?? null, parts, retired, head, at };
}

// ── the PR comment ────────────────────────────────────────────────────────────

const MAX_ROWS = 15;
const capped = (rows) => (rows.length > MAX_ROWS ? [...rows.slice(0, MAX_ROWS), `- … and ${rows.length - MAX_ROWS} more in the report`] : rows);

export function commentBody({ verdictMd, slug }) {
  const v = parseVerdict(verdictMd);
  // A round cap: the rows it names (and the expectations they cite) wait for the user's decision; they never gate.
  const cap = v.gaps.find((g) => g.id === 'gap:cap') ?? null;
  const onCap = new Set(capIds(cap?.text));
  for (const c of v.criteria) if (onCap.has(c.id)) for (const m of String(c.detail).matchAll(/\bexp:[^\s,;:)\]]+/g)) onCap.add(m[0]);
  const gating = [];
  const seen = new Set();
  const add = (id, line) => { if (!seen.has(id) && !onCap.has(id)) { seen.add(id); gating.push(line); } };
  for (const c of v.criteria) if (c.status === 'FAIL' || /— gates/.test(c.detail)) add(c.id, `- ${c.status} \`[${c.id}]\` ${c.name}: ${c.detail}`);
  for (const f of v.findings) if (f.severity === 'Blocker' || /— gates/.test(f.text)) add(f.id, `- ${f.severity} \`[${f.id}]\` ${f.text}`);
  const open = [
    ...(cap ? [`- \`[${cap.id}]\` ${cap.text}`] : []),
    ...v.criteria.filter((c) => onCap.has(c.id)).map((c) => `- ${c.status} \`[${c.id}]\` ${c.name}: ${c.detail}`),
    ...v.criteria.filter((c) => c.status === 'UNVERIFIABLE' && !onCap.has(c.id) && !/(^|— )advisory\b/.test(c.detail))
      .map((c) => `- \`[${c.id}]\` ${c.name}: ${c.detail}`),
  ];
  const blocked = [
    ...v.criteria.filter((c) => c.status === 'BLOCKED').map((c) => `- \`[${c.id}]\` ${c.name}: ${c.detail}`),
    ...v.gaps.filter((g) => /^BLOCKED\b/.test(g.text)).map((g) => `- \`[${g.id}]\` ${g.text}`),
  ];
  const c = v.criteriaLine;
  const counts = c ? `${c.pass} pass · ${c.fail} fail · ${c.unverifiable} unverifiable · ${c.blocked} blocked · ${c.waived} waived` : 'no criteria line';
  const r = v.report;
  const report = !r ? 'not placed yet'
    : r.kind === 'url' ? `[open the report](${r.url})`
      : r.kind === 'local' ? `report on ${r.host} (\`${r.path}\`)`
        : `not published — ${r.reason}`;
  const out = [
    COMMENT_MARKER,
    `### qa: ${v.verdict ?? 'no verdict'}`,
    `\`${v.slug ?? slug}\` at \`${String(v.head ?? '').slice(0, 12)}\` · ${counts}`,
    '',
    '**Gating**',
    ...(gating.length ? capped(gating) : ['- none']),
  ];
  if (open.length) out.push('', '**Needs you**', ...capped(open));
  if (blocked.length) out.push('', '**Blocked**', ...capped(blocked));
  out.push('', `**Report:** ${report}`, '', '<sub>One comment per PR, edited by qa each verify round.</sub>');
  return `${out.join('\n')}\n`;
}

const firstLine = (text) => String(text ?? '').trim().split('\n').find(Boolean) ?? '';

export function postComment({ body, pr = null, gh }) {
  const call = (args, input) => {
    const r = gh(args, input);
    if (r.missing) return { skip: `gh is not installed or cannot run (${r.missing})` };
    if (r.status !== 0) return { skip: firstLine(r.stderr) || `gh ${args.slice(0, 2).join(' ')} exited ${r.status}` };
    return { out: String(r.stdout ?? '') };
  };
  let number = pr;
  if (number == null) {
    const r = call(['pr', 'view', '--json', 'number,url']);
    if (r.skip && /gh is not installed/.test(r.skip)) return { skipped: r.skip };
    let n = null;
    try { n = JSON.parse(r.out ?? 'null')?.number ?? null; } catch { /* no PR */ }
    if (!Number.isInteger(n)) return { skipped: `no pull request for this branch${r.skip ? ` (${r.skip})` : ''}` };
    number = n;
  }
  const jq = `.[] | select(.body | contains(${JSON.stringify(COMMENT_MARKER)})) | .id`;
  const found = call(['api', '--paginate', `repos/{owner}/{repo}/issues/${number}/comments`, '--jq', jq]);
  if (found.skip) return { skipped: found.skip };
  const id = found.out.split('\n').map((l) => l.trim()).find((l) => /^\d+$/.test(l)) ?? null;
  const input = JSON.stringify({ body });
  const sent = id
    ? call(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${id}`, '--input', '-'], input)
    : call(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${number}/comments`, '--input', '-'], input);
  if (sent.skip) return { skipped: sent.skip };
  let url = null;
  try { url = JSON.parse(sent.out)?.html_url ?? null; } catch { /* no url in the answer */ }
  return { action: id ? 'edited' : 'posted', url: url ?? `PR #${number}` };
}
