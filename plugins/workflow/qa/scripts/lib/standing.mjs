// qa/standing.md (decision 5, §3 cold start): findings the base has too. Never a REJECT; listed
// once, each with an owner, and the qa skill (step 8) turns chosen rows into asks or
// tickets. The runner only adds rows and bumps "last seen"; people own the owner and note
// columns and may delete rows.
//
// CONTRACT (tests: test/standing.test.mjs)
//
//   standingItems(compareResult) -> [{ viewport, key, kind: 'check'|'tour'|'console', text }]
//     From every viewport's pairs: checks.standing (text = '<check>: <detail>'), tour.standing
//     (text = the problem), console.standing (text = the line). Order: viewports, pairs, then
//     checks, tour, console. A null compareResult -> [].
//
//   standingId(item) -> 'st-' + first 8 hex of sha1('<viewport>|<key>|<kind>|<text with every run
//     of digits made #>')   (digits ignored, as compare matches findings)
//
//   mergeStanding(text, items, { slug, date }) -> { text, added, seen }
//     text = the current qa/standing.md, or null when there is none (then the template
//     templates/standing.md is the start). The table is the first markdown table whose header row
//     is exactly '| id | screen | kind | finding | first seen | last seen | owner | note |'.
//     Per item (deduplicated by id): a row with that id -> its 'last seen' becomes '<date> <slug>'
//     (seen += 1); otherwise a new row is appended at the end of the table:
//     '| <id> | <viewport>/<key> | <kind> | <text> | <date> <slug> | <date> <slug> |  |  |' (added += 1).
//     '|' inside text is written '\|'. Every other byte of the file (prose, other rows, owner and
//     note cells, rows the run did not see) is kept exactly. A file with no such table gets the
//     template's heading row and separator appended after a blank line, then the rows.
//     Same text, items, slug and date twice -> the second call returns the same text, added 0.

//   STEP 8 (tests: test/standing.test.mjs 'step 8'; the qa skill uses these through the CLI):
//   readStanding(text) -> [{ id, screen, kind, finding, firstSeen, lastSeen, owner, note }]
//     the rows of the HEADER table (cells split on '|' not preceded by '\', trimmed, '\|' read as
//     '|'); null or no table -> [].
//   setStanding(text, id, { owner, note }) -> text   only the given cells of that row change
//     (undefined leaves a cell; '' empties it; '|' written '\|'); every other byte kept; unknown id
//     -> Error('no standing item <id>').
//   pickStanding(rows, { kind = null, owner = undefined, unowned = false, screen = null }) -> rows
//     kind: exact; owner: exact; unowned: owner cell empty; screen: util.glob on the screen cell.
//   asksMd(rows, { date }) -> string   one ask per row, for a ledger or a ticket:
//     '# Standing items to fix — <date>' + blank line + per row
//     '- [<id>] Fix on <screen>: <finding> (standing since <firstSeen>; <kind>)' and, when the row
//     has an owner or a note, a continuation '  owner: <owner> · note: <note>' (absent parts left out).

//   U7 (rework, design 2026-11-12 §8; tests: test/fingerprint.test.mjs): a row can carry a FINGERPRINT (fingerprint.mjs)
//   instead of one screen's finding, and then stands for that finding on any screen. Backward compatible: the table and
//   its columns are unchanged; a fingerprint row is an ordinary row whose screen cell is '*' (any screen) and whose
//   finding cell is the fingerprint text, '<check> on <role> "<name>" in <landmark>'; its id is fingerprintId(fp) and
//   its kind 'tour' for a tour:<kind> check, else 'check'. Every other row keeps its meaning (one finding on one screen,
//   matched by its standingId). People add fingerprint rows with `qa standing add` (the qa skill),
//   from a finding or a shared-chrome candidate of a run; the runner never adds one by itself.
//   rowFingerprint(row) -> Fingerprint | null    parseFingerprint(row.finding) when row.screen is '*', else null.
//   standingMatcher(rows) -> (item) -> row | null   item = { viewport, key, kind, text, fingerprint? } (a finding as
//     standingItems makes them): the fingerprint row with the same fingerprintKey, else the row whose id is
//     standingId(item), else null.
//   addFingerprints(text, fps, { slug, date, owner = '', note = '' }) -> { text, added: [id], existing: [id] }
//     one row per fingerprint not yet in the table (by id), appended like mergeStanding's rows (the template when text
//     is null): '| <id> | * | <check|tour> | <fingerprint text> | <date> <slug> | <date> <slug> | <owner> | <note> |'.
//     A fingerprint whose row exists is listed in existing and changes nothing.
//   standingItems: an item gains fingerprint (checkFingerprint / tourFingerprint of the pair's after record) when the
//     record gave one; the key is absent otherwise.
//   mergeStanding(text, items, { slug, date, touched = [] }): an item with a fingerprint whose fingerprint row exists
//     bumps that row's last seen (seen += 1, once per row) and adds no row of its own; touched = more row ids whose last
//     seen is bumped (the rows a run's new findings matched, run.mjs). Everything else as above.

//   FRESH START (the upgrade from 0.6; tests: test/upgrade.test.mjs 'standing.mjs FRESH START'): before fingerprints, every
//   run added one row per finding per screen, so a project can hold hundreds of one-screen rows nobody triaged.
//   untriagedRows(rows) -> rows   the one-screen rows (screen cell not '*') with neither an owner nor a note.
//   freshStanding(text) -> { text, kept: n, dropped: n }   the same file with only the rows a person owns: the
//     fingerprint rows and every row with an owner or a note, each line kept byte for byte, in order; the untriaged
//     one-screen rows are dropped (`qa ready --fix` archives the whole file beside it first). Prose, heading and
//     separator kept. No table -> { text, kept: 0, dropped: 0 }.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { checkFingerprint, fingerprintId, fingerprintKey, fingerprintText, parseFingerprint, tourFingerprint } from './fingerprint.mjs';
import { glob } from './util.mjs';

const TEMPLATE = fs.readFileSync(new URL('../../templates/standing.md', import.meta.url), 'utf8');
const HEADER = '| id | screen | kind | finding | first seen | last seen | owner | note |';
const UNESCAPED_PIPE = /(?<!\\)\|/;
const LAST_SEEN = 6;

export function standingItems(compareResult) {
  const items = [];
  for (const v of compareResult?.viewports ?? []) {
    for (const p of v.pairs ?? []) {
      const add = (kind, text, fingerprint = null) => items.push({ viewport: v.viewport, key: p.key, kind, text, ...(fingerprint ? { fingerprint } : {}) });
      for (const f of p.checks?.standing ?? []) add('check', `${f.check}: ${f.detail}`, checkFingerprint(f));
      for (const t of p.tour?.standing ?? []) add('tour', t, tourFingerprint(p.after, t));
      for (const c of p.console?.standing ?? []) add('console', c);
    }
  }
  return items;
}

export function standingId(item) {
  const text = String(item.text).replace(/\d+/g, '#');
  return 'st-' + crypto.createHash('sha1').update(`${item.viewport}|${item.key}|${item.kind}|${text}`).digest('hex').slice(0, 8);
}

const cell = (text) => String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

export function mergeStanding(text, items, { slug, date, touched = [] }) {
  const stamp = `${date} ${slug}`;
  const source = text ?? TEMPLATE;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split('\n');
  const headerAt = lines.findIndex((l) => l.trimEnd() === HEADER);

  // Table rows: the lines after the header (and its separator) that start with '|'. Fingerprint rows (screen '*')
  // are also found by their fingerprint's key.
  const rowAt = new Map();
  const fpAt = new Map();
  let lastAt = headerAt;
  if (headerAt !== -1) {
    let i = headerAt + 1;
    while (i < lines.length && lines[i].startsWith('|')) {
      const id = lines[i].split(UNESCAPED_PIPE)[1]?.trim();
      if (i > headerAt + 1 && id && !rowAt.has(id)) {
        rowAt.set(id, i);
        const fp = rowFingerprint({ screen: cellsOf(lines[i])[1], finding: cellsOf(lines[i])[3] });
        if (fp && !fpAt.has(fingerprintKey(fp))) fpAt.set(fingerprintKey(fp), id);
      }
      lastAt = i;
      i += 1;
    }
  }

  const fresh = [];
  let added = 0;
  let seen = 0;
  const done = new Set();
  const bump = (id) => {
    if (done.has(id) || !rowAt.has(id)) return;
    done.add(id);
    const at = rowAt.get(id);
    const cells = lines[at].split(UNESCAPED_PIPE);
    const tail = cells[LAST_SEEN].match(/\s*$/)[0];
    cells[LAST_SEEN] = ` ${stamp}${tail.startsWith(' ') ? tail : ' '}`;
    lines[at] = cells.join('|');
    seen += 1;
  };
  for (const id of touched) bump(id);
  for (const item of items) {
    // A finding a fingerprint row stands for: that row is seen again, and no row of its own is added.
    const byFp = item.fingerprint ? fpAt.get(fingerprintKey(item.fingerprint)) : null;
    if (byFp) {
      bump(byFp);
      continue;
    }
    const id = standingId(item);
    if (done.has(id)) continue;
    if (rowAt.has(id)) bump(id);
    else {
      done.add(id);
      fresh.push(`| ${id} | ${cell(`${item.viewport}/${item.key}`)} | ${item.kind} | ${cell(item.text)} | ${stamp} | ${stamp} |  |  |`);
      added += 1;
    }
  }

  if (headerAt !== -1) {
    lines.splice(lastAt + 1, 0, ...fresh.map((l) => l + (eol === '\r\n' ? '\r' : '')));
    return { text: lines.join('\n'), added, seen };
  }
  if (fresh.length === 0 && items.length === 0) return { text: source, added, seen };
  const templateLines = TEMPLATE.split('\n');
  const at = templateLines.findIndex((l) => l.trimEnd() === HEADER);
  const table = [templateLines[at], templateLines[at + 1], ...fresh].map((l) => l.replace(/\r$/, '')).join(eol) + eol;
  const body = source === '' ? '' : (source.endsWith('\n') ? source : source + eol) + eol;
  return { text: body + table, added, seen };
}

// ---- STEP 8: the qa skill reads the header table, sets owner and note, picks rows, writes asks

// The header table: its lines, line ending, the header's index and the last line of its '|' run.
// null when the text is null or has no table with the header row.
function headerTable(text) {
  if (text == null) return null;
  const source = String(text);
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trimEnd() === HEADER);
  if (at < 0) return null;
  let last = at;
  while (last + 1 < lines.length && lines[last + 1].startsWith('|')) last += 1;
  return { lines, eol: source.includes('\r\n') ? '\r\n' : '\n', at, last };
}

// A row's cells: split on '|' not preceded by '\', trimmed, '\|' read as '|'.
const cellsOf = (line) => line.slice(1, line.lastIndexOf('|')).split(UNESCAPED_PIPE).map((c) => c.trim().replace(/\\\|/g, '|'));

// A value as a cell: '|' written '\|', a newline made a space.
const cellOut = (value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

// The row with its data cell `index` (0-based) set to `value`; every other byte of the line kept.
function withCell(line, index, value) {
  const end = line.lastIndexOf('|');
  const data = line.slice(1, end).split(UNESCAPED_PIPE);
  while (data.length <= index) data.push(' ');
  data[index] = ` ${cellOut(value)} `;
  return `|${data.join('|')}${line.slice(end)}`;
}

// The index of the row with this id, or -1. The separator row (the line after the header) is skipped.
function rowIndex(table, id) {
  for (let i = table.at + 2; i <= table.last; i += 1) {
    if (cellsOf(table.lines[i])[0] === id) return i;
  }
  return -1;
}

const OWNER = 6;
const NOTE = 7;

export function readStanding(text) {
  const table = headerTable(text);
  if (!table) return [];
  return table.lines.slice(table.at + 2, table.last + 1).map((line) => {
    const [id = '', screen = '', kind = '', finding = '', firstSeen = '', lastSeen = '', owner = '', note = ''] = cellsOf(line);
    return { id, screen, kind, finding, firstSeen, lastSeen, owner, note };
  });
}

export function setStanding(text, id, { owner, note } = {}) {
  const table = headerTable(text);
  const at = table ? rowIndex(table, id) : -1;
  if (at < 0) throw new Error(`no standing item ${id}`);
  let line = table.lines[at];
  if (owner !== undefined) line = withCell(line, OWNER, owner);
  if (note !== undefined) line = withCell(line, NOTE, note);
  table.lines[at] = line;
  return table.lines.join(table.eol);
}

export function pickStanding(rows, { kind = null, owner = undefined, unowned = false, screen = null } = {}) {
  const onScreen = screen == null ? null : glob(screen);
  return (rows ?? []).filter((r) => (kind == null || r.kind === kind)
    && (owner == null || r.owner === owner)
    && (!unowned || !r.owner)
    && (onScreen === null || onScreen.test(r.screen)));
}

export function asksMd(rows, { date } = {}) {
  const lines = [`# Standing items to fix — ${date}`];
  for (const r of rows ?? []) {
    lines.push('', `- [${r.id}] Fix on ${r.screen}: ${r.finding} (standing since ${r.firstSeen}; ${r.kind})`);
    const who = [r.owner ? `owner: ${r.owner}` : '', r.note ? `note: ${r.note}` : ''].filter(Boolean);
    if (who.length > 0) lines.push(`  ${who.join(' · ')}`);
  }
  return lines.join('\n') + '\n';
}

// ---- U7: fingerprint rows

export const rowFingerprint = (row) => (row?.screen === '*' ? parseFingerprint(row.finding) : null);

export function standingMatcher(rows) {
  const byFp = new Map();
  const byId = new Map();
  for (const r of rows ?? []) {
    const fp = rowFingerprint(r);
    if (fp) byFp.set(fingerprintKey(fp), r);
    else byId.set(r.id, r);
  }
  return (item) => (item?.fingerprint ? byFp.get(fingerprintKey(item.fingerprint)) : null) ?? byId.get(standingId(item)) ?? null;
}

export function addFingerprints(text, fps, { slug, date, owner = '', note = '' } = {}) {
  const source = text ?? TEMPLATE;
  const have = new Set(readStanding(source).map((r) => r.id));
  const added = [];
  const existing = [];
  const rows = [];
  for (const fp of fps ?? []) {
    const id = fingerprintId(fp);
    if (have.has(id)) {
      if (!existing.includes(id)) existing.push(id);
      continue;
    }
    have.add(id);
    added.push(id);
    const kind = String(fp.check).startsWith('tour:') ? 'tour' : 'check';
    rows.push(`| ${id} | * | ${kind} | ${cell(fingerprintText(fp))} | ${date} ${slug} | ${date} ${slug} | ${cellOut(owner)} | ${cellOut(note)} |`);
  }
  if (!rows.length) return { text: source, added, existing };
  const table = headerTable(source);
  if (!table) {
    const templateLines = TEMPLATE.split('\n');
    const at = templateLines.findIndex((l) => l.trimEnd() === HEADER);
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const body = source === '' ? '' : (source.endsWith('\n') ? source : source + eol) + eol;
    return { text: body + [templateLines[at], templateLines[at + 1], ...rows].map((l) => l.replace(/\r$/, '')).join(eol) + eol, added, existing };
  }
  table.lines.splice(table.last + 1, 0, ...rows);
  return { text: table.lines.join(table.eol), added, existing };
}

// ── a fresh start (the upgrade from 0.6) ───────────────────────────────────────

const owned = (row) => row.screen === '*' || Boolean(row.owner) || Boolean(row.note);

export function untriagedRows(rows) {
  return (rows ?? []).filter((r) => !owned(r));
}

export function freshStanding(text) {
  const table = headerTable(text);
  if (!table) return { text: String(text ?? ''), kept: 0, dropped: 0 };
  const out = [];
  let kept = 0;
  let dropped = 0;
  table.lines.forEach((line, i) => {
    if (i < table.at + 2 || i > table.last) { out.push(line); return; }
    const [id = '', screen = '', , , , , owner = '', note = ''] = cellsOf(line);
    if (owned({ id, screen, owner, note })) { out.push(line); kept += 1; } else dropped += 1;
  });
  return { text: out.join(table.eol), kept, dropped };
}
