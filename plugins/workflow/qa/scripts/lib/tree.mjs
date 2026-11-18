// The accessibility tree of a screen, as text, and the diff of two trees: decision 10's first
// signal ("what changed, as text; expectations match here"). Playwright's ARIA snapshot (YAML of
// roles and accessible names) is the tree; probe.mjs prints the same thing for the mapper.
// Zero model calls. Ported in spirit from Sen's catalogue (workflow branch qa-diff,
// examples/qa/catalogue.spec.ts toMatchAriaSnapshot), which diffed committed trees with git;
// here both sides are recordings, so the diff is ours.
//
// CONTRACT (tests: test/tree.test.mjs; ariaTree runs a real headless browser)
//
//   ariaTree(page) -> Promise<string>
//     await page.locator('body').ariaSnapshot(), then normaliseTree().
//
//   normaliseTree(text) -> string
//     CRLF -> LF; trailing spaces trimmed per line; blank lines dropped; ends without a newline.
//     Nothing else is rewritten (ids in /url: lines stay: both sides run the same seed).
//
//   treeDiff(before, after, { maxLines = 5000 } = {})
//     -> { same: boolean, added: [{ n, line }], removed: [{ n, line }], truncated: boolean }
//     Both inputs go through normaliseTree first; n counts those normalised lines. Line diff by
//     longest common subsequence. Lines compare by
//     their text with leading indentation REMOVED, so a node that only moved one level deeper
//     (a new wrapper) is not reported; `line` keeps the original indentation for display.
//     n = 1-based line number in its own side (removed: before, added: after). Each list in
//     document order. same = no added and no removed. Either side longer than maxLines: only the
//     first maxLines lines of each are diffed and truncated = true. before or after null/undefined
//     -> { same: false, added: [], removed: [], truncated: false, missing: 'before'|'after'|'both' }.
//
//   treeText(line) -> string
//     The text a person reads on a tree line, for expectation matching: the quoted accessible
//     name when there is one ('- button "Save"' -> 'Save'; '- heading "Jobs" [level=1]' -> 'Jobs'),
//     else the text after the role and colon ('- text: Total 12' -> 'Total 12';
//     '- paragraph: Hello' -> 'Hello'), else '' ('- list:' -> ''). JSON-style escapes in the quoted
//     name are undone ('\"' -> '"').
//
// Example: treeDiff('- heading "Jobs" [level=1]\n- button "Add"', '- heading "Jobs" [level=1]\n- button "Add job"')
//   -> { same: false, removed: [{ n: 2, line: '- button "Add"' }], added: [{ n: 2, line: '- button "Add job"' }], truncated: false }

export async function ariaTree(page) {
  return normaliseTree(await page.locator('body').ariaSnapshot());
}

export function normaliseTree(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line) => line !== '')
    .join('\n');
}

// Splits a normalised tree into its lines; the empty tree has no lines (not one empty line).
function linesOf(text) {
  return text === '' ? [] : text.split('\n');
}

// The line with its leading indentation removed, the key two lines are compared by.
function keyOf(line) {
  return line.replace(/^[ \t]+/, '');
}

// Longest common subsequence of two key arrays, as matched index pairs in document order. The DP
// table is (n+1) x (m+1) and typed (Uint16 when the lengths allow it, else Uint32); the common
// prefix and suffix are trimmed first, so only the changed middle is tabled.
function lcsPairs(ka, kb) {
  let p = 0;
  while (p < ka.length && p < kb.length && ka[p] === kb[p]) p++;
  let s = 0;
  while (s < ka.length - p && s < kb.length - p && ka[ka.length - 1 - s] === kb[kb.length - 1 - s]) s++;
  const n = ka.length - p - s;
  const m = kb.length - p - s;
  const pairs = [];
  for (let i = 0; i < p; i++) pairs.push([i, i]);

  const Table = Math.max(n, m) < 65536 ? Uint16Array : Uint32Array;
  const w = m + 1;
  const L = new Table((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = ka[p + i] === kb[p + j]
        ? L[(i + 1) * w + j + 1] + 1
        : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const middle = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[p + i] === kb[p + j]) {
      middle.push([p + i, p + j]);
      i++;
      j++;
    } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  for (const pair of middle) pairs.push(pair);
  for (let t = 0; t < s; t++) pairs.push([ka.length - s + t, kb.length - s + t]);
  return pairs;
}

export function treeDiff(before, after, { maxLines = 5000 } = {}) {
  if (before == null || after == null) {
    const missing = before == null && after == null ? 'both' : before == null ? 'before' : 'after';
    return { same: false, added: [], removed: [], truncated: false, missing };
  }
  let a = linesOf(normaliseTree(before));
  let b = linesOf(normaliseTree(after));
  const truncated = a.length > maxLines || b.length > maxLines;
  a = a.slice(0, maxLines);
  b = b.slice(0, maxLines);

  const ka = a.map(keyOf);
  const kb = b.map(keyOf);
  const pairs = lcsPairs(ka, kb);
  const removed = [];
  const added = [];
  let ia = 0;
  let ib = 0;
  for (const [x, y] of [...pairs, [a.length, b.length]]) {
    for (; ia < x; ia++) removed.push({ n: ia + 1, line: a[ia] });
    for (; ib < y; ib++) added.push({ n: ib + 1, line: b[ib] });
    ia = x + 1;
    ib = y + 1;
  }
  return { same: added.length === 0 && removed.length === 0, added, removed, truncated };
}

// A quoted accessible name, JSON-style (the escapes Playwright writes are undone by JSON.parse).
const QUOTED_NAME = /^\s*-\s+[^\s":]+\s+("(?:[^"\\]|\\.)*")/;

export function treeText(line) {
  const name = QUOTED_NAME.exec(line);
  if (name) {
    try {
      return JSON.parse(name[1]);
    } catch {
      return name[1].slice(1, -1);
    }
  }
  const bullet = /^\s*-\s+/.exec(line);
  if (!bullet) return '';
  const rest = line.slice(bullet[0].length);
  const colon = rest.indexOf(': ');
  return colon < 0 ? '' : rest.slice(colon + 2).trim();
}
