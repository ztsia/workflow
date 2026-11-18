// Contract tests for scripts/lib/standing.mjs (the CONTRACT comment at the top of that file is the spec).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { asksMd, mergeStanding, pickStanding, readStanding, setStanding, standingId, standingItems } from '../scripts/lib/standing.mjs';

const TEMPLATE = fs.readFileSync(new URL('../templates/standing.md', import.meta.url), 'utf8');
const HEADER = '| id | screen | kind | finding | first seen | last seen | owner | note |';
const SEPARATOR = '|---|---|---|---|---|---|---|---|';
const CHECK_TEXT = 'target: button "x" is 20×20 px, needs 24 px';
const TOUR_TEXT = 'menu "Columns" 180×300 runs past the top of the screen';

// The brief's example: a compare() result with one viewport and two pairs (only the fields the contracts read).
const pairDetail = {
  key: 'detail__default', status: 'changed',
  before: { screen: 'detail' }, after: { screen: 'detail' },
  elements: [{ k: 'Title#1', status: 'changed' }, { k: 'Badge#1', status: 'same' }],
  tree: { same: false, added: [{ n: 4, line: 'heading "New title" [level=1]' }, { n: 9, line: 'button "Archive"' }],
          removed: [{ n: 4, line: 'heading "Old title" [level=1]' }], truncated: false, explained: [], masked: 0 },
  pixel: { ratio: 0.024, worstTile: 0.031, sameSize: true, changed: true },
  checks: { new: [{ check: 'contrast', detail: 'span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1' }],
            standing: [{ check: 'target', detail: 'button "x" is 20×20 px, needs 24 px' }], fixed: [] },
  tour: { opened: 3, failed: 0, hover: 10, hoverSilent: 2,
          new: ['listbox "Status" 200×240 cut off by div.card'], standing: ['menu "Columns" 180×300 runs past the top of the screen'], fixed: [] },
  console: { new: ['TypeError: x is undefined'], standing: [] },
};
const pairList = { key: 'list__default', status: 'same', before: { screen: 'list' }, after: { screen: 'list' },
  elements: [], tree: { same: true, added: [], removed: [], truncated: false, explained: [], masked: 0 },
  pixel: { ratio: 0, worstTile: 0, sameSize: true, changed: false },
  checks: { new: [], standing: [], fixed: [] }, tour: { opened: 1, failed: 0, hover: 4, hoverSilent: 0, new: [], standing: [], fixed: [] },
  console: { new: [], standing: [] } };
const compareResult = { exit: 1, viewports: [{
  viewport: 'desktop', exit: 1, pairs: [pairDetail, pairList],
  expectations: [{ name: 'title-renamed', describe: '…', result: 'met', detail: '1 element(s): 1 right' }],
  unexpected: [{ key: 'detail__default', kind: 'tree', added: ['heading "New title" [level=1]', 'button "Archive"'], removed: [] }],
  overflow: [], inconclusive: [], eyes: ['detail__default'], standing: { checks: 1, tour: 1, console: 0 } }] };

const checkItem = { viewport: 'desktop', key: 'detail__default', kind: 'check', text: CHECK_TEXT };
const tourItem = { viewport: 'desktop', key: 'detail__default', kind: 'tour', text: TOUR_TEXT };

// The id the contract gives, computed here with node:crypto so the merge tests do not lean on standingId.
function idOf(item) {
  const normalised = item.text.replace(/\d+/g, '#');
  return 'st-' + crypto.createHash('sha1').update(`${item.viewport}|${item.key}|${item.kind}|${normalised}`).digest('hex').slice(0, 8);
}

// The rows a merge from no file adds after the template.
function rowsAfterTemplate(text) {
  return text.slice(TEMPLATE.length).split('\n').filter(Boolean);
}

const CHECK_ROW = `| ${idOf(checkItem)} | desktop/detail__default | check | ${CHECK_TEXT} | 2026-11-06 feat-x | 2026-11-06 feat-x |  |  |`;
const TOUR_ROW = `| ${idOf(tourItem)} | desktop/detail__default | tour | ${TOUR_TEXT} | 2026-11-06 feat-x | 2026-11-06 feat-x |  |  |`;

describe('standing: standingItems', () => {
  it('lists the checks, then the tour, standing items of the example, in viewport and pair order', () => {
    assert.deepEqual(standingItems(compareResult), [
      { viewport: 'desktop', key: 'detail__default', kind: 'check', text: CHECK_TEXT },
      { viewport: 'desktop', key: 'detail__default', kind: 'tour', text: TOUR_TEXT },
    ]);
  });

  it('a null compareResult gives no items', () => {
    assert.deepEqual(standingItems(null), []);
  });
});

describe('standing: standingId', () => {
  it("is 'st-' plus the first 8 hex digits of sha1 over viewport|key|kind|text with each digit run made #", () => {
    const id = standingId(checkItem);
    assert.match(id, /^st-[0-9a-f]{8}$/);
    const expected = 'st-' + crypto.createHash('sha1')
      .update('desktop|detail__default|check|target: button "x" is #×# px, needs # px')
      .digest('hex').slice(0, 8);
    assert.equal(id, expected);
  });

  it('the same finding with different digits has the same id', () => {
    const otherDigits = { ...checkItem, text: 'target: button "x" is 22×22 px, needs 44 px' };
    assert.equal(standingId(otherDigits), standingId(checkItem));
  });

  it('the same text with a different kind has a different id', () => {
    assert.notEqual(standingId({ ...checkItem, kind: 'tour' }), standingId(checkItem));
  });
});

describe('standing: mergeStanding', () => {
  it('from no file, starts with the template and ends with one row per item', () => {
    const { text, added, seen } = mergeStanding(null, [checkItem, tourItem], { slug: 'feat-x', date: '2026-11-06' });
    assert.ok(text.startsWith(TEMPLATE), 'the template content is the start of the new file');
    assert.deepEqual(rowsAfterTemplate(text), [CHECK_ROW, TOUR_ROW]);
    assert.equal(added, 2);
    assert.equal(seen, 0);
  });

  it('an existing row keeps first seen, owner and note and gets last seen; prose and other rows stay byte-identical; new items are appended', () => {
    const existing = [
      '# Standing items',
      '',
      'Prose the team wrote above the table.',
      '',
      HEADER,
      SEPARATOR,
      '| st-11111111 | desktop/list__default | check | old finding | 2026-10-01 feat-a | 2026-10-20 feat-a | zt | later |',
      `| ${idOf(checkItem)} | desktop/detail__default | check | ${CHECK_TEXT} | 2026-11-06 feat-x | 2026-11-06 feat-x | zt | later |`,
      '',
    ].join('\n');
    const seenRow = `| ${idOf(checkItem)} | desktop/detail__default | check | ${CHECK_TEXT} | 2026-11-06 feat-x | 2026-11-07 feat-y | zt | later |`;
    const oldRow = `| ${idOf(checkItem)} | desktop/detail__default | check | ${CHECK_TEXT} | 2026-11-06 feat-x | 2026-11-06 feat-x | zt | later |`;
    const newTourRow = `| ${idOf(tourItem)} | desktop/detail__default | tour | ${TOUR_TEXT} | 2026-11-07 feat-y | 2026-11-07 feat-y |  |  |`;

    const { text, added, seen } = mergeStanding(existing, [checkItem, tourItem], { slug: 'feat-y', date: '2026-11-07' });
    assert.equal(text, existing.replace(oldRow, seenRow) + newTourRow + '\n');
    assert.equal(added, 1);
    assert.equal(seen, 1);
  });

  it('the same items, slug and date twice give the same text, and the second call adds nothing', () => {
    const first = mergeStanding(null, [checkItem, tourItem], { slug: 'feat-x', date: '2026-11-06' });
    const second = mergeStanding(first.text, [checkItem, tourItem], { slug: 'feat-x', date: '2026-11-06' });
    assert.equal(second.text, first.text);
    assert.equal(second.added, 0);
  });

  it("a '|' inside the finding text is written as '\\|' in the row", () => {
    const piped = { ...checkItem, text: 'target: a|b is 20×20 px, needs 24 px' };
    const { text } = mergeStanding(null, [piped], { slug: 'feat-x', date: '2026-11-06' });
    const row = `| ${idOf(piped)} | desktop/detail__default | check | target: a\\|b is 20×20 px, needs 24 px | 2026-11-06 feat-x | 2026-11-06 feat-x |  |  |`;
    assert.deepEqual(rowsAfterTemplate(text), [row]);
  });

  it('a file with prose and no standing table gets the header and separator after a blank line, then the rows; the prose is kept', () => {
    const prose = 'Notes the team kept, with no table yet.\n';
    const { text, added } = mergeStanding(prose, [checkItem, tourItem], { slug: 'feat-x', date: '2026-11-06' });
    assert.equal(text, prose + '\n' + HEADER + '\n' + SEPARATOR + '\n' + CHECK_ROW + '\n' + TOUR_ROW + '\n');
    assert.equal(added, 2);
  });

  it('duplicate items with one id give one row', () => {
    const { text, added } = mergeStanding(null, [checkItem, { ...checkItem }], { slug: 'feat-x', date: '2026-11-06' });
    const rows = rowsAfterTemplate(text);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].startsWith(`| ${idOf(checkItem)} | `), rows[0]);
    assert.equal(added, 1);
  });
});

// ---- step 8: the qa skill reads the table, sets owner and note, picks rows, writes asks ----
const ROW_CHECK = '| st-1a2b3c4d | desktop/candidate-detail__detail | check | contrast: span.muted contrast 4.0:1 (#7a7a7a on #ffffff), needs 4.5:1 | 2026-11-06 feat-x | 2026-11-07 feat-y | ZT | design token |';
const ROW_TOUR = '| st-5e6f7a8b | phone/jobs__list | tour | menu "Columns" 180×240 cut off by the top of the window | 2026-11-06 feat-x | 2026-11-06 feat-x |  |  |';
const CHECK_OBJ = {
  id: 'st-1a2b3c4d', screen: 'desktop/candidate-detail__detail', kind: 'check',
  finding: 'contrast: span.muted contrast 4.0:1 (#7a7a7a on #ffffff), needs 4.5:1',
  firstSeen: '2026-11-06 feat-x', lastSeen: '2026-11-07 feat-y', owner: 'ZT', note: 'design token',
};
const TOUR_OBJ = {
  id: 'st-5e6f7a8b', screen: 'phone/jobs__list', kind: 'tour',
  finding: 'menu "Columns" 180×240 cut off by the top of the window',
  firstSeen: '2026-11-06 feat-x', lastSeen: '2026-11-06 feat-x', owner: '', note: '',
};
const OTHER_OBJ = {
  id: 'st-0a1b2c3d', screen: 'desktop/jobs__list', kind: 'tour',
  finding: 'menu "Filter" 200×260 cut off', firstSeen: '2026-11-05 feat-w', lastSeen: '2026-11-06 feat-x', owner: 'AB', note: '',
};
const FILE_WITH_ROWS = TEMPLATE + ROW_CHECK + '\n' + ROW_TOUR + '\n';
const ROWS = [CHECK_OBJ, TOUR_OBJ, OTHER_OBJ];
const ids = (rows) => rows.map((r) => r.id);

describe('standing: step 8 readStanding', () => {
  it('the rows of the header table, cells trimmed, empty cells as empty strings', () => {
    assert.deepEqual(readStanding(FILE_WITH_ROWS), [CHECK_OBJ, TOUR_OBJ]);
  });

  it('null text, and a file with no table or no rows, give []', () => {
    assert.deepEqual(readStanding(null), []);
    assert.deepEqual(readStanding('# Standing items\n\nNo table here.\n'), []);
    assert.deepEqual(readStanding(TEMPLATE), []);
  });

  it("'\\|' in a finding is read as '|'", () => {
    const text = TEMPLATE + '| st-9f9f9f9f | desktop/list__default | check | target: a\\|b is 20×20 px | 2026-11-06 feat-x | 2026-11-06 feat-x |  |  |\n';
    assert.equal(readStanding(text)[0].finding, 'target: a|b is 20×20 px');
  });

  it('only the header table is read', () => {
    const other = '| a | b |\n|---|---|\n| 1 | 2 |\n\n';
    assert.deepEqual(readStanding(other + FILE_WITH_ROWS), [CHECK_OBJ, TOUR_OBJ]);
  });
});

describe('standing: step 8 setStanding', () => {
  it('sets the owner and note cells of that row; the other row and the prose are byte-identical', () => {
    const out = setStanding(FILE_WITH_ROWS, 'st-5e6f7a8b', { owner: 'ZT', note: 'design token' });
    const newTour = '| st-5e6f7a8b | phone/jobs__list | tour | menu "Columns" 180×240 cut off by the top of the window | 2026-11-06 feat-x | 2026-11-06 feat-x | ZT | design token |';
    assert.equal(out, FILE_WITH_ROWS.replace(ROW_TOUR, newTour));
  });

  it('undefined leaves a cell as it is', () => {
    const row = readStanding(setStanding(FILE_WITH_ROWS, 'st-1a2b3c4d', { note: 'token fixed' }))[0];
    assert.equal(row.owner, 'ZT');
    assert.equal(row.note, 'token fixed');
  });

  it("'' empties a cell and leaves the other", () => {
    const row = readStanding(setStanding(FILE_WITH_ROWS, 'st-1a2b3c4d', { owner: '' }))[0];
    assert.equal(row.owner, '');
    assert.equal(row.note, 'design token');
  });

  it("a '|' in a value is written '\\|' in the file and read back as '|'", () => {
    const out = setStanding(FILE_WITH_ROWS, 'st-5e6f7a8b', { note: 'a|b' });
    assert.ok(out.includes('| a\\|b |'), 'the note cell holds the escaped pipe');
    assert.equal(readStanding(out)[1].note, 'a|b');
  });

  it('an unknown id is refused with no standing item <id>', () => {
    assert.throws(() => setStanding(FILE_WITH_ROWS, 'st-deadbeef', { owner: 'ZT' }),
      { name: 'Error', message: 'no standing item st-deadbeef' });
  });
});

describe('standing: step 8 pickStanding', () => {
  it('no filters gives every row', () => {
    assert.deepEqual(ids(pickStanding(ROWS, {})), ['st-1a2b3c4d', 'st-5e6f7a8b', 'st-0a1b2c3d']);
  });

  it('kind is exact', () => {
    assert.deepEqual(ids(pickStanding(ROWS, { kind: 'tour' })), ['st-5e6f7a8b', 'st-0a1b2c3d']);
  });

  it('owner is exact: a prefix of the owner does not match', () => {
    assert.deepEqual(ids(pickStanding(ROWS, { owner: 'ZT' })), ['st-1a2b3c4d']);
    assert.deepEqual(ids(pickStanding(ROWS, { owner: 'Z' })), []);
  });

  it('unowned keeps the rows whose owner cell is empty', () => {
    assert.deepEqual(ids(pickStanding(ROWS, { unowned: true })), ['st-5e6f7a8b']);
  });

  it('screen is a glob on the screen cell', () => {
    assert.deepEqual(ids(pickStanding(ROWS, { screen: 'phone/*' })), ['st-5e6f7a8b']);
    assert.deepEqual(ids(pickStanding(ROWS, { screen: '*/jobs__list' })), ['st-5e6f7a8b', 'st-0a1b2c3d']);
    assert.deepEqual(ids(pickStanding(ROWS, { screen: 'desktop/*' })), ['st-1a2b3c4d', 'st-0a1b2c3d']);
  });

  it('filters combine: every given filter must hold', () => {
    assert.deepEqual(ids(pickStanding(ROWS, { kind: 'tour', screen: '*/jobs__list' })), ['st-5e6f7a8b', 'st-0a1b2c3d']);
    assert.deepEqual(ids(pickStanding(ROWS, { kind: 'tour', owner: 'AB' })), ['st-0a1b2c3d']);
  });
});

describe('standing: step 8 asksMd', () => {
  it("the brief's Example: one ask for the second row, exactly", () => {
    const text = asksMd([TOUR_OBJ], { date: '2026-11-07' });
    assert.equal(text.replace(/\n+$/, ''),
      '# Standing items to fix — 2026-11-07\n\n- [st-5e6f7a8b] Fix on phone/jobs__list: menu "Columns" 180×240 cut off by the top of the window (standing since 2026-11-06 feat-x; tour)');
  });

  it("an owner and a note give the continuation line '  owner: <owner> · note: <note>'", () => {
    const text = asksMd([CHECK_OBJ], { date: '2026-11-07' });
    assert.equal(text.replace(/\n+$/, ''),
      '# Standing items to fix — 2026-11-07\n\n- [st-1a2b3c4d] Fix on desktop/candidate-detail__detail: contrast: span.muted contrast 4.0:1 (#7a7a7a on #ffffff), needs 4.5:1 (standing since 2026-11-06 feat-x; check)\n  owner: ZT · note: design token');
  });

  it('an absent owner or note is left out of the continuation line', () => {
    const ownerOnly = asksMd([{ ...CHECK_OBJ, note: '' }], { date: '2026-11-07' }).replace(/\n+$/, '').split('\n');
    assert.equal(ownerOnly.at(-1), '  owner: ZT');
    const noteOnly = asksMd([{ ...CHECK_OBJ, owner: '' }], { date: '2026-11-07' }).replace(/\n+$/, '').split('\n');
    assert.equal(noteOnly.at(-1), '  note: design token');
  });

  it('one ask per row, in row order', () => {
    const asks = asksMd([CHECK_OBJ, TOUR_OBJ], { date: '2026-11-07' }).split('\n').filter((l) => l.startsWith('- ['));
    assert.deepEqual(asks.map((l) => l.match(/^- \[([^\]]+)\]/)[1]), ['st-1a2b3c4d', 'st-5e6f7a8b']);
  });
});
