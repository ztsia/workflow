// normaliseTree, treeDiff and treeText (pure), and ariaTree (a real headless browser).
// The CONTRACT comment in scripts/lib/tree.mjs (lines 1-35) is the spec.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { ariaTree, normaliseTree, treeDiff, treeText } from '../scripts/lib/tree.mjs';

const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-tree-'));

after(() => {
  fs.rmSync(mainRoot, { recursive: true, force: true });
});

const JOBS_BEFORE = '- heading "Jobs" [level=1]\n- button "Add"';
const JOBS_AFTER = '- heading "Jobs" [level=1]\n- button "Add job"';

test('normaliseTree: CRLF becomes LF and the text ends without a newline', () => {
  assert.equal(normaliseTree('- a\r\n- b\r\n'), '- a\n- b');
});

test('normaliseTree: trailing spaces are trimmed per line, and leading indentation is kept', () => {
  assert.equal(normaliseTree('- list:   \n  - button "Save"  \n'), '- list:\n  - button "Save"');
});

test('normaliseTree: blank lines are dropped', () => {
  assert.equal(normaliseTree('- a\n\n   \n- b\n\n\n- c'), '- a\n- b\n- c');
});

test('normaliseTree: a text without a final newline stays as it is, and nothing else is rewritten', () => {
  assert.equal(normaliseTree('- a'), '- a');
  const link = '- link "Home":\n  - /url: /home?id=7f3c';
  assert.equal(normaliseTree(`${link}\n`), link);
});

test('treeDiff: the contract example reports the one changed button on each side', () => {
  assert.deepEqual(treeDiff(JOBS_BEFORE, JOBS_AFTER), {
    same: false,
    removed: [{ n: 2, line: '- button "Add"' }],
    added: [{ n: 2, line: '- button "Add job"' }],
    truncated: false,
  });
});

test('treeDiff: the same text is same, with empty lists', () => {
  assert.deepEqual(treeDiff(JOBS_BEFORE, JOBS_BEFORE), { same: true, added: [], removed: [], truncated: false });
});

test('treeDiff: a line that only changes its indentation is not reported', () => {
  assert.deepEqual(treeDiff('- main:\n- button "Save"', '- main:\n  - button "Save"'), {
    same: true,
    added: [],
    removed: [],
    truncated: false,
  });
});

test('treeDiff: a new wrapper is reported as added, and the node it wraps is not', () => {
  const r = treeDiff('- button "Save"', '- group:\n  - button "Save"');
  assert.equal(r.same, false);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.added, [{ n: 1, line: '- group:' }]);
});

test('treeDiff: an added line keeps its original indentation in line', () => {
  assert.deepEqual(treeDiff('- a', '- a\n  - b').added, [{ n: 2, line: '  - b' }]);
});

test('treeDiff: n is 1-based on its own side, and each list is in document order', () => {
  const r = treeDiff('- a\n- b\n- c', '- a\n- x\n- c\n- d');
  assert.deepEqual(r.removed, [{ n: 2, line: '- b' }]);
  assert.deepEqual(r.added, [{ n: 2, line: '- x' }, { n: 4, line: '- d' }]);

  const gone = treeDiff('- a\n- b\n- c\n- d', '- a\n- c');
  assert.deepEqual(gone.removed, [{ n: 2, line: '- b' }, { n: 4, line: '- d' }]);
  assert.deepEqual(gone.added, []);
});

test('treeDiff: a missing side is reported with missing, and nothing is diffed', () => {
  assert.deepEqual(treeDiff(null, '- a'), { same: false, added: [], removed: [], truncated: false, missing: 'before' });
  assert.deepEqual(treeDiff('- a', undefined), { same: false, added: [], removed: [], truncated: false, missing: 'after' });
  assert.deepEqual(treeDiff(null, undefined), { same: false, added: [], removed: [], truncated: false, missing: 'both' });
  assert.deepEqual(treeDiff(undefined, null), { same: false, added: [], removed: [], truncated: false, missing: 'both' });
});

test('treeDiff: past maxLines only the first maxLines lines of each side are diffed, and truncated is true', () => {
  const before = ['- 1', '- 2', '- 3', '- 4', '- 5', '- 6'].join('\n');
  const after = ['- 1', '- 2', '- 3', '- 4', '- X', '- 6'].join('\n');

  // The change is on line 5, beyond the limit: it is not seen.
  assert.deepEqual(treeDiff(before, after, { maxLines: 3 }), { same: true, added: [], removed: [], truncated: true });

  // A change inside the limit is still reported, and still truncated.
  const inside = treeDiff('- 1\n- 2\n- 3\n- 4', '- 1\n- X\n- 3\n- 4', { maxLines: 3 });
  assert.equal(inside.truncated, true);
  assert.deepEqual(inside.removed, [{ n: 2, line: '- 2' }]);
  assert.deepEqual(inside.added, [{ n: 2, line: '- X' }]);

  // Six lines with a limit of six is not longer than the limit, so nothing is truncated.
  const full = treeDiff(before, after, { maxLines: 6 });
  assert.equal(full.truncated, false);
  assert.equal(full.same, false);
  assert.deepEqual(full.removed, [{ n: 5, line: '- 5' }]);
  assert.deepEqual(full.added, [{ n: 5, line: '- X' }]);
});

test('treeText: the quoted accessible name, with or without attributes after it', () => {
  assert.equal(treeText('- button "Save"'), 'Save');
  assert.equal(treeText('- heading "Jobs" [level=1]'), 'Jobs');
});

test('treeText: the text after the role and colon', () => {
  assert.equal(treeText('- text: Total 12'), 'Total 12');
  assert.equal(treeText('- paragraph: Hello'), 'Hello');
});

test('treeText: a line with no name and no text is empty', () => {
  assert.equal(treeText('- list:'), '');
});

test('treeText: JSON-style escapes in a quoted name are undone', () => {
  assert.equal(treeText('- button "Say \\"hi\\""'), 'Say "hi"');
});

test('ariaTree: a real headless browser gives the heading and the button as tree lines, with no final newline', { timeout: 30000 }, async () => {
  const pw = loadPlaywright(mainRoot);
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Jobs</h1><button>Add</button>');
    const tree = await ariaTree(page);
    assert.ok(tree.includes('- heading "Jobs" [level=1]'), tree);
    assert.ok(tree.includes('- button "Add"'), tree);
    assert.ok(!tree.endsWith('\n'), JSON.stringify(tree));
  } finally {
    await browser.close();
  }
});
