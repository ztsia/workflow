// Contract tests for scripts/lib/escapes.mjs (the CONTRACT comment at the top of that file is the spec).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ESCAPES_HEADER, openAsks } from '../scripts/lib/eyes.mjs';
import { CLOSERS, TEMPLATE, addEscape, closeCheck, closeEscape, readEscapes } from '../scripts/lib/escapes.mjs';

const SEPARATOR = '|---|---|---|---|---|---|';

// The contract's Example, as addEscape's input.
const FIRST = {
  found: '2026-11-07 PR #240',
  what: 'the Save button hides behind the keyboard on phones',
  caught: 'tour at phone width on job-edit',
  ask: 'Is any button hidden behind the on-screen keyboard?',
};
const FIRST_ROW = '| esc-1 | 2026-11-07 PR #240 | the Save button hides behind the keyboard on phones | tour at phone width on job-edit | Is any button hidden behind the on-screen keyboard? |  |';

const lastLine = (text) => text.split('\n').filter((l) => l !== '').at(-1);
const withoutTrailingNewlines = (text) => text.replace(/\n+$/, '');

describe('escapes: readEscapes', () => {
  it('null text, and text with no escapes table, give no rows', () => {
    assert.deepEqual(readEscapes(null), []);
    assert.deepEqual(readEscapes('# Escapes\n\nNo table here.\n'), []);
  });

  it('reads each row of the ESCAPES_HEADER table; an empty closed-by cell reads as an empty string', () => {
    assert.deepEqual(readEscapes(`${TEMPLATE}${FIRST_ROW}\n`), [
      { id: 'esc-1', found: '2026-11-07 PR #240', what: 'the Save button hides behind the keyboard on phones',
        caught: 'tour at phone width on job-edit', ask: 'Is any button hidden behind the on-screen keyboard?', closedBy: '' },
    ]);
  });

  it("a closed row reads its closed-by cell", () => {
    const closed = '| esc-2 | 2026-11-06 | a menu cut off | tour on jobs | Is the menu cut off? | qa/map/jobs.json |';
    assert.equal(readEscapes(`${TEMPLATE}${closed}\n`)[0].closedBy, 'qa/map/jobs.json');
  });

  it("'\\|' in a cell is read as '|'", () => {
    const row = '| esc-3 | 2026-11-06 | a\\|b cut off | tour | 5 \\| 3 is the rule? |  |';
    assert.deepEqual(readEscapes(`${TEMPLATE}${row}\n`)[0], {
      id: 'esc-3', found: '2026-11-06', what: 'a|b cut off', caught: 'tour', ask: '5 | 3 is the rule?', closedBy: '',
    });
  });

  it('only the table whose header is ESCAPES_HEADER is read', () => {
    const other = '| x | y |\n|---|---|\n| 1 | 2 |\n\n';
    assert.deepEqual(readEscapes(`${other}${TEMPLATE}${FIRST_ROW}\n`).map((r) => r.id), ['esc-1']);
  });
});

describe('escapes: addEscape', () => {
  it('the contract Example: from null the template is the start, the id is esc-1, and the row ends the table', () => {
    const { text, id } = addEscape(null, FIRST);
    assert.equal(id, 'esc-1');
    assert.ok(text.startsWith(TEMPLATE), 'the template is the start of the new file');
    assert.equal(lastLine(text), FIRST_ROW);
  });

  it('ids go esc-1 then esc-2', () => {
    const first = addEscape(null, FIRST);
    const second = addEscape(first.text, { ...FIRST, what: 'a second bug' });
    assert.equal(second.id, 'esc-2');
    assert.deepEqual(readEscapes(second.text).map((r) => r.id), ['esc-1', 'esc-2']);
  });

  it('the new id is the highest n plus one, so a gap is not filled', () => {
    const text = `${TEMPLATE}| esc-1 | 2026-11-06 | a | b | Ask one? |  |\n| esc-3 | 2026-11-06 | c | d | Ask three? |  |\n`;
    assert.equal(addEscape(text, FIRST).id, 'esc-4');
  });

  it("a '|' in a value is written '\\|' and a newline becomes a space; the row reads back the same", () => {
    const { text, id } = addEscape(null, { found: 'x', what: 'a|b', caught: 'line one\nline two', ask: 'Ask | with pipe?' });
    assert.equal(id, 'esc-1');
    assert.equal(lastLine(text), '| esc-1 | x | a\\|b | line one line two | Ask \\| with pipe? |  |');
    assert.deepEqual(readEscapes(text)[0], {
      id: 'esc-1', found: 'x', what: 'a|b', caught: 'line one line two', ask: 'Ask | with pipe?', closedBy: '',
    });
  });

  it('every other byte of the file is kept: prose, other rows and their closed-by cells; the row goes at the table end', () => {
    const before = '# Escapes\n\nPlain prose with a | pipe, kept.\n\n' + ESCAPES_HEADER + '\n' + SEPARATOR + '\n'
      + '| esc-1 | 2026-11-06 | old | x | Old ask? | qa.json |\n\nTail prose.\n';
    const { text, id } = addEscape(before, FIRST);
    assert.equal(id, 'esc-2');
    const expected = before.replace('| esc-1 | 2026-11-06 | old | x | Old ask? | qa.json |\n',
      '| esc-1 | 2026-11-06 | old | x | Old ask? | qa.json |\n'
      + '| esc-2 | 2026-11-07 PR #240 | the Save button hides behind the keyboard on phones | tour at phone width on job-edit | Is any button hidden behind the on-screen keyboard? |  |\n');
    assert.equal(text, expected);
  });

  it('a file with prose and no escapes table gets the heading and separator after a blank line, then the row', () => {
    const prose = 'Notes kept as written.\n';
    const { text, id } = addEscape(prose, FIRST);
    assert.equal(id, 'esc-1');
    assert.equal(withoutTrailingNewlines(text), prose + '\n' + ESCAPES_HEADER + '\n' + SEPARATOR + '\n' + FIRST_ROW);
  });

  it('an empty found is allowed', () => {
    const { text } = addEscape(null, { ...FIRST, found: '' });
    assert.equal(readEscapes(text)[0].found, '');
  });

  for (const field of ['what', 'caught', 'ask']) {
    it(`an empty ${field} is refused with '${field} is required'`, () => {
      assert.throws(() => addEscape(null, { ...FIRST, [field]: '' }), { name: 'Error', message: `${field} is required` });
    });
  }
});

describe('escapes: CLOSERS and closeCheck', () => {
  it('CLOSERS are the four the contract names, frozen; a path under each one closes the escape', () => {
    assert.deepEqual([...CLOSERS], ['qa/map/', 'qa.json', 'qa/routes.table.', 'qa/mutants.']);
    assert.ok(Object.isFrozen(CLOSERS));
    assert.equal(closeCheck(['qa/map/jobs.json'], {}), null);
    assert.equal(closeCheck(['qa.json'], {}), null);
    assert.equal(closeCheck(['qa/routes.table.ts'], {}), null);
    assert.equal(closeCheck(['qa/mutants.ts'], {}), null);
  });

  it('the contract Example: a commit touching qa/map/jobs.json closes', () => {
    assert.equal(closeCheck(['qa/map/jobs.json'], {}), null);
  });

  it('one closing path among others is enough', () => {
    assert.equal(closeCheck(['src/app.ts', 'qa.json'], {}), null);
  });

  it("a profile map replaces 'qa/map/': the new map closes, the old one no longer does", () => {
    assert.equal(closeCheck(['e2e/map/jobs.json'], { map: 'e2e/map' }), null);
    assert.match(closeCheck(['qa/map/jobs.json'], { map: 'e2e/map' }), /^an escape closes only by a map, tour or check change/);
  });

  it('no closing path gives the exact why text, naming the closers', () => {
    assert.equal(closeCheck(['src/app.ts'], {}),
      'an escape closes only by a map, tour or check change: the commit touches none of qa/map/, qa.json, qa/routes.table., qa/mutants.');
  });
});

describe('escapes: closeEscape', () => {
  it('sets the closed-by cell of that row and keeps the other rows and their values', () => {
    const { text } = addEscape(null, FIRST);
    const closed = closeEscape(text, 'esc-1', 'qa/map/jobs.json');
    assert.equal(closed.split('\n').length, text.split('\n').length);
    assert.deepEqual(readEscapes(closed), [{ ...readEscapes(text)[0], closedBy: 'qa/map/jobs.json' }]);
  });

  it('an unknown id is refused with no escape <id>', () => {
    const { text } = addEscape(null, FIRST);
    assert.throws(() => closeEscape(text, 'esc-9', 'qa.json'), { name: 'Error', message: 'no escape esc-9' });
  });

  it('an already closed row is refused, naming the cell as it stands', () => {
    const closed = closeEscape(addEscape(null, FIRST).text, 'esc-1', 'qa/map/jobs.json');
    assert.throws(() => closeEscape(closed, 'esc-1', 'qa/mutants.ts'),
      { name: 'Error', message: 'esc-1 is already closed by qa/map/jobs.json' });
  });
});

describe('escapes: openAsks (eyes.mjs) reads the rows', () => {
  it('an added row is an open ask', () => {
    const { text } = addEscape(null, FIRST);
    assert.deepEqual(openAsks(text), [{ id: 'esc-1', ask: FIRST.ask }]);
  });

  it('a closed row is not an open ask', () => {
    const closed = closeEscape(addEscape(null, FIRST).text, 'esc-1', 'qa.json');
    assert.deepEqual(openAsks(closed), []);
  });
});
