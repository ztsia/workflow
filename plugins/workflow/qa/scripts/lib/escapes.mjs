// qa/escapes.md (decision 19): a bug found after an ACCEPT gets a row — which run could have caught
// it, and the Ask the eyes pass puts to every screen from then on (eyes.mjs openAsks reads it). A
// row closes only by a map, tour or check change, so closing names the commit that made one, and
// the script checks that it did. Pure apart from the injected git reader.
//
// CONTRACT (tests: test/escapes.test.mjs)
//
//   ESCAPES_HEADER (eyes.mjs) = '| id | found | what | could have caught | ask | closed by |'
//   TEMPLATE = templates/escapes.md (read at import).
//
//   readEscapes(text) -> [{ id, found, what, caught, ask, closedBy }]   the rows of the first table
//     whose header is ESCAPES_HEADER (cells as eyes.mjs openAsks splits them: '|' not preceded by
//     '\', trimmed, '\|' read as '|'); null or no table -> [].
//
//   addEscape(text, { found, what, caught, ask }) -> { text, id }
//     text null -> the template is the start; no table -> the template's heading row and separator
//     appended after a blank line. id = 'esc-<n>', n = 1 + the highest n among existing 'esc-<n>'
//     ids (1 when none). The row '| <id> | <found> | <what> | <caught> | <ask> |  |' is appended at
//     the table's end ('|' in a value written '\|', newlines made spaces). Every other byte kept.
//     Throws Error('<field> is required') for an empty what, caught or ask (found defaults to today
//     — the caller passes it; an empty found is allowed).
//
//   CLOSERS (exported, frozen) = ['qa/map/', 'qa.json', 'qa/routes.table.', 'qa/mutants.']
//     a closing change must touch a path starting with one of these (with profile.map, when set,
//     replacing 'qa/map/' by '<profile.map>/').
//   closeCheck(files, { map = 'qa/map' } = {}) -> null | why
//     files: the paths a commit touches. null when one matches CLOSERS; else
//     'an escape closes only by a map, tour or check change: the commit touches none of <list>'
//     with <list> = the closers joined ', '.
//   closeEscape(text, id, by) -> text   the row's 'closed by' cell becomes `by`; unknown id ->
//     Error('no escape <id>'); already closed -> Error('<id> is already closed by <cell>').
//
// Example: addEscape(null, { found: '2026-11-07 PR #240', what: 'the Save button hides behind the
// keyboard on phones', caught: 'tour at phone width on job-edit', ask: 'Is any button hidden behind
// the on-screen keyboard?' }) -> id 'esc-1' and a row ending '| Is any button hidden behind the
// on-screen keyboard? |  |'. closeCheck(['qa/map/jobs.json'], {}) -> null.

import fs from 'node:fs';
import { ESCAPES_HEADER } from './eyes.mjs';

export const TEMPLATE = fs.readFileSync(new URL('../../templates/escapes.md', import.meta.url), 'utf8');
export const CLOSERS = Object.freeze(['qa/map/', 'qa.json', 'qa/routes.table.', 'qa/mutants.']);

const UNESCAPED_PIPE = /(?<!\\)\|/;
const ESC_ID = /^esc-(\d+)$/;
const CLOSED_BY = 5;

// The text's lines and its line ending.
function split(text) {
  const source = String(text);
  return { lines: source.split(/\r?\n/), eol: source.includes('\r\n') ? '\r\n' : '\n' };
}

// The first table whose header row is ESCAPES_HEADER: the header's line index and the last line of
// its run of '|' lines (the separator when there are no rows). null when there is no such table.
function tableOf(lines) {
  const at = lines.findIndex((l) => l.trimEnd() === ESCAPES_HEADER);
  if (at < 0) return null;
  let last = at;
  while (last + 1 < lines.length && lines[last + 1].startsWith('|')) last += 1;
  return { at, last };
}

// The rows of a table: the lines after the header and its separator.
const rowsOf = (lines, table) => lines.slice(table.at + 2, table.last + 1);

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

const finish = (lines, eol) => {
  const text = lines.join(eol);
  return text.endsWith('\n') ? text : text + eol;
};

export function readEscapes(text) {
  if (text == null) return [];
  const { lines } = split(text);
  const table = tableOf(lines);
  if (!table) return [];
  return rowsOf(lines, table).map((line) => {
    const [id = '', found = '', what = '', caught = '', ask = '', closedBy = ''] = cellsOf(line);
    return { id, found, what, caught, ask, closedBy };
  });
}

export function addEscape(text, { found = '', what, caught, ask } = {}) {
  for (const [field, value] of [['what', what], ['caught', caught], ['ask', ask]]) {
    if (!cellOut(value)) throw new Error(`${field} is required`);
  }
  const source = text ?? TEMPLATE;
  const { lines, eol } = split(source);
  const highest = Math.max(0, ...readEscapes(source).map((r) => Number(ESC_ID.exec(r.id)?.[1] ?? 0)));
  const id = `esc-${highest + 1}`;
  const row = `| ${id} | ${cellOut(found)} | ${cellOut(what)} | ${cellOut(caught)} | ${cellOut(ask)} |  |`;

  const table = tableOf(lines);
  if (table) {
    lines.splice(table.last + 1, 0, row);
    return { text: finish(lines, eol), id };
  }
  // No escapes table: the template's heading row and separator go after a blank line.
  const templateLines = TEMPLATE.split('\n');
  const at = templateLines.findIndex((l) => l.trimEnd() === ESCAPES_HEADER);
  const body = source === '' ? '' : (source.endsWith('\n') ? source : source + eol) + eol;
  const newTable = [templateLines[at], templateLines[at + 1], row].join(eol) + eol;
  return { text: body + newTable, id };
}

export function closeCheck(files, { map = 'qa/map' } = {}) {
  const base = String(map || 'qa/map').replace(/\/+$/, '');
  const closers = CLOSERS.map((c) => (c === 'qa/map/' ? `${base}/` : c));
  if ((files ?? []).some((f) => closers.some((c) => String(f).startsWith(c)))) return null;
  return `an escape closes only by a map, tour or check change: the commit touches none of ${closers.join(', ')}`;
}

export function closeEscape(text, id, by) {
  const { lines, eol } = split(text ?? '');
  const table = tableOf(lines);
  let at = -1;
  if (table) {
    for (let i = table.at + 2; i <= table.last && at < 0; i += 1) {
      if (cellsOf(lines[i])[0] === id) at = i;
    }
  }
  if (at < 0) throw new Error(`no escape ${id}`);
  const closedBy = cellsOf(lines[at])[CLOSED_BY] ?? '';
  if (closedBy) throw new Error(`${id} is already closed by ${closedBy}`);
  lines[at] = withCell(lines[at], CLOSED_BY, by);
  return lines.join(eol);
}
