// eyes.mjs: CORE_QUESTIONS, VERDICTS, ESCAPES_HEADER, eyesTargets, eyesPrompt, parseEyes, openAsks.
// eyesTargets runs on hand-built Results (only the fields the contract reads) and on the step 5 example
// (buildResults(exampleRun())); the brief text and the parsers run on literal strings.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { CORE_QUESTIONS, ESCAPES_HEADER, VERDICTS, eyesPrompt, eyesTargets, openAsks, parseEyes } from '../scripts/lib/eyes.mjs';
import { buildResults } from '../scripts/lib/summary.mjs';
import { exampleRun } from './fixtures/run-example.mjs';

const WORK = '/w';
const CACHE = '/c';
const DETAIL = 'scr:desktop/detail__default';
const LIST = 'scr:desktop/list__default';
const AFTER = path.join(WORK, 'compare', 'media', 'desktop', 'after', 'detail__default.png');
const BEFORE = path.join(WORK, 'compare', 'media', 'desktop', 'before', 'detail__default.png');

// The six questions, exact wording, as the contract gives them.
const QUESTIONS = [
  ['First look', 'What do you see first? Should it be? What is this screen for, in one line, from the screen alone?'],
  ['Reading', 'Can everything be read without effort: size, weight, wrapping, words that do not explain themselves?'],
  ['Tapping', 'What can be tapped? Is each one obviously tappable, and is anything that looks tappable not? Is the main action where a thumb reaches it?'],
  ['Broken', 'Does anything look broken, cramped, misaligned, cut off, doubled or out of place?'],
  ['Trust', 'Would I trust this with my data, or my money if it shows any? Do the figures look right and consistent, signs and units as everywhere else, and nothing alarming without a reason?'],
  ['Against the base', 'Only after judging the branch on its own: open the base shot. What got better, what got worse, and is every change one a person would want?'],
];

// A hand-built screen entry as summary.mjs's Results lists it (tree and pixel as summary.mjs gives them).
function screen(id, over = {}) {
  return {
    id, viewport: 'desktop', key: 'detail__default', screen: 'detail', status: 'changed',
    tree: { added: 2, removed: 1, unexplained: 0 }, elements: { changed: 1, drift: 0 },
    pixel: { ratio: 0.024, worstTile: 0.031, changed: true }, eyes: true, ...over,
  };
}

function results(screens, eyes = []) {
  return { slug: 'feat-x', screens, eyes };
}

// exists() that knows only the given paths.
const on = (...paths) => (p) => paths.includes(p);
const none = () => false;

// --- CORE_QUESTIONS, VERDICTS, ESCAPES_HEADER ---

test('CORE_QUESTIONS is frozen and has six entries', () => {
  assert.equal(CORE_QUESTIONS.length, 6);
  assert.ok(Object.isFrozen(CORE_QUESTIONS));
});

for (const [i, [name, question]] of QUESTIONS.entries()) {
  test(`CORE_QUESTIONS[${i}] is "${name}" with its exact question`, () => {
    assert.deepEqual([...CORE_QUESTIONS[i]], [name, question]);
  });
}

test('VERDICTS are fine, look again, wrong', () => {
  assert.deepEqual([...VERDICTS], ['fine', 'look again', 'wrong']);
});

test('ESCAPES_HEADER is the qa/escapes.md header row', () => {
  assert.equal(ESCAPES_HEADER, '| id | found | what | could have caught | ask | closed by |');
});

// --- eyesTargets ---

test('the example run gives one target: the changed screen with its measured counts and no shots', () => {
  const r = buildResults(exampleRun());
  assert.deepEqual(eyesTargets(r, { work: WORK, exists: none }), [{
    id: DETAIL, viewport: 'desktop', key: 'detail__default', screen: 'detail', status: 'changed',
    ratio: 0.024, tree: { added: 2, removed: 1 }, after: null, before: null,
  }]);
});

test('by default the ids are results.eyes, so a screen not in eyes is not a target', () => {
  const r = results([screen(DETAIL), screen(LIST, { key: 'list__default', screen: 'list', status: 'same', pixel: { ratio: 0 } })], [DETAIL]);
  assert.deepEqual(eyesTargets(r, { work: WORK, exists: none }).map((t) => t.id), [DETAIL]);
});

test('after: the media copy wins, then the head shot, else null', () => {
  const head = path.join(WORK, 'head', 'desktop', 'detail__default.png');
  const r = results([screen(DETAIL)], [DETAIL]);
  const after = (exists) => eyesTargets(r, { work: WORK, exists })[0].after;
  assert.equal(after(on(AFTER, head)), AFTER);
  assert.equal(after(on(head)), head);
  assert.equal(after(none), null);
});

test('before: the media copy wins, then the cache (only with cacheDir), then the base shot, else null', () => {
  const cache = path.join(CACHE, 'desktop', 'detail__default.png');
  const base = path.join(WORK, 'base', 'desktop', 'detail__default.png');
  const r = results([screen(DETAIL)], [DETAIL]);
  const before = (opts, exists) => eyesTargets(r, { work: WORK, exists, ...opts })[0].before;
  assert.equal(before({}, on(BEFORE, cache, base)), BEFORE);
  assert.equal(before({ cacheDir: CACHE }, on(cache, base)), cache);
  assert.equal(before({}, on(base)), base);
  assert.equal(before({}, on(cache)), null, 'the cache is never offered without cacheDir');
  assert.equal(before({ cacheDir: CACHE }, none), null);
});

test('ids: unknown and keyless ids are skipped, a repeated id is one target', () => {
  const r = results([screen(DETAIL), screen(LIST, { key: 'list__default', pixel: { ratio: 0 } }), screen('scr:desktop/err__default', { key: null })]);
  const ids = [DETAIL, 'scr:desktop/nope__default', 'scr:desktop/err__default', DETAIL, LIST];
  assert.deepEqual(eyesTargets(r, { work: WORK, exists: none, ids }).map((t) => t.id), [DETAIL, LIST]);
});

test('order: ratio descending, a null ratio counts as 1, ties keep the ids order', () => {
  const A = 'scr:desktop/a__default';
  const B = 'scr:desktop/b__default';
  const C = 'scr:desktop/c__default';
  const D = 'scr:desktop/d__default';
  const E = 'scr:desktop/e__default';
  const r = results([
    screen(A, { key: 'a__default', pixel: { ratio: 0.2 } }),
    screen(B, { key: 'b__default', pixel: null }),
    screen(C, { key: 'c__default', pixel: { ratio: 0.5 } }),
    screen(D, { key: 'd__default', pixel: { ratio: 0.2 } }),
    screen(E, { key: 'e__default', pixel: { ratio: 1 } }),
  ], [A, B, C, D, E]);
  assert.deepEqual(eyesTargets(r, { work: WORK, exists: none }).map((t) => t.id), [B, E, C, A, D]);
});

test('tree is null when the screen has no tree; ratio is null when it has no pixel entry', () => {
  const r = results([screen(DETAIL, { tree: null, pixel: null })], [DETAIL]);
  const [t] = eyesTargets(r, { work: WORK, exists: none });
  assert.equal(t.tree, null);
  assert.equal(t.ratio, null);
});

// --- eyesPrompt ---

const QUESTION_LINES = QUESTIONS.map(([name, question], i) => `${i + 1}. **${name}.** ${question}`);

test('eyesPrompt: the exact text for one target with a base shot and measured counts', () => {
  const target = {
    id: DETAIL, viewport: 'desktop', key: 'detail__default', screen: 'detail', status: 'changed',
    ratio: 0.024, tree: { added: 2, removed: 1 }, after: AFTER, before: BEFORE,
  };
  const text = eyesPrompt({ slug: 'feat-x', out: '/v/feat-x', targets: [target], questions: [], asks: [] });
  const expected = [
    'Eyes pass for feat-x. Write /v/feat-x/eyes.md as your instructions (agents/eyes.md) say.',
    '',
    'Read ONLY this brief and the screenshots it lists. Nothing else: not the code, the spec, summary.md or any other file.',
    '',
    '## Screens to look at (1)',
    '',
    `### [${DETAIL}] detail — changed`,
    `- branch: ${AFTER}`,
    `- base: ${BEFORE}`,
    '- measured: pixels 2.4% differ · tree +2 −1',
    '',
    '## Questions — answer every one for every screen, in writing',
    '',
    ...QUESTION_LINES,
    '',
    'Write one section per screen, headed exactly `## [<id>] <screen>`. End each with one line: `Verdict: fine | look again | wrong — <the one thing to fix first>`.',
    '`wrong` = a person would be misled, stuck or put off; `look again` = it works but reads worse than it should.',
    '',
  ].join('\n');
  assert.equal(text, expected);
});

test('eyesPrompt: a target with no base, ratio or tree omits those lines and says branch: missing', () => {
  const target = {
    id: LIST, viewport: 'desktop', key: 'list__default', screen: 'list', status: 'new',
    ratio: null, tree: null, after: null, before: null,
  };
  const lines = eyesPrompt({ slug: 'feat-x', out: '/v/feat-x', targets: [target], questions: [], asks: [] }).split('\n');
  const start = lines.indexOf(`### [${LIST}] list — new`);
  assert.ok(start >= 0, 'the target heading is there');
  assert.equal(lines[start + 1], '- branch: missing');
  assert.equal(lines[start + 2], '', 'no base or measured line follows');
  assert.ok(!lines.some((l) => l.startsWith('- base:') || l.startsWith('- measured:')));
});

test('eyesPrompt: the project questions and the escape asks number on after the six core questions', () => {
  const target = {
    id: DETAIL, viewport: 'desktop', key: 'detail__default', screen: 'detail', status: 'changed',
    ratio: null, tree: null, after: AFTER, before: null,
  };
  const other = { ...target, id: LIST, key: 'list__default', screen: 'list' };
  const text = eyesPrompt({
    slug: 'feat-x', out: '/v/feat-x', targets: [target, other],
    questions: ['Is the banner readable on a phone?'],
    asks: [{ id: 'esc:1', ask: 'Does the empty state explain itself?' }],
  });
  const lines = text.split('\n');
  assert.ok(lines.includes('## Screens to look at (2)'));
  assert.ok(lines.includes('7. Is the banner readable on a phone?'));
  assert.ok(lines.includes('8. **esc:1.** Does the empty state explain itself?'));
  assert.ok(lines.includes(QUESTION_LINES[5]), 'the sixth core question is still there');
  assert.ok(text.endsWith('\n'), 'ends with a newline');
});

// --- parseEyes ---

test('parseEyes: a bold verdict line gives the verdict and the fix after the dash', () => {
  const text = `## [${DETAIL}] detail\nFirst look: the title, then the Archive button.\n**Verdict: look again** — the Archive button sits under the fold\n`;
  assert.deepEqual(parseEyes(text), [{ id: DETAIL, verdict: 'look again', fix: 'the Archive button sits under the fold' }]);
});

test('parseEyes: the dash after the verdict may be an em dash, an en dash, a colon or a hyphen', () => {
  const seps = ['—', '–', ':', '-'];
  const text = seps.map((s, i) => `## [scr:desktop/s${i}__default] s\nVerdict: wrong ${s} fix ${i}\n`).join('');
  assert.deepEqual(parseEyes(text), seps.map((_, i) => ({ id: `scr:desktop/s${i}__default`, verdict: 'wrong', fix: `fix ${i}` })));
});

test('parseEyes: a verdict with no fix gives fix empty', () => {
  assert.deepEqual(parseEyes(`## [${DETAIL}] detail\nVerdict: fine\n`), [{ id: DETAIL, verdict: 'fine', fix: '' }]);
});

test('parseEyes: the verdict word is case-insensitive and lower-cased', () => {
  assert.deepEqual(parseEyes(`## [${DETAIL}] detail\nVERDICT: LOOK AGAIN — the title\n`), [{ id: DETAIL, verdict: 'look again', fix: 'the title' }]);
});

test('parseEyes: a section with no verdict line has verdict null and fix empty', () => {
  assert.deepEqual(parseEyes(`## [${DETAIL}] detail\nFirst look: nothing decided yet.\n`), [{ id: DETAIL, verdict: null, fix: '' }]);
});

test('parseEyes: a section ends at the next # heading, so a verdict after it is not its own', () => {
  assert.deepEqual(parseEyes(`## [scr:desktop/c__default] c\n# Other\nVerdict: wrong — x\n`), [{ id: 'scr:desktop/c__default', verdict: null, fix: '' }]);
});

test('parseEyes: a ## heading without [id] adds nothing, and the sections after it still parse', () => {
  assert.deepEqual(parseEyes('## Summary\nVerdict: wrong — x\n'), []);
  assert.deepEqual(
    parseEyes('## Summary\nVerdict: wrong — x\n## [scr:desktop/b__default] b\nVerdict: fine\n'),
    [{ id: 'scr:desktop/b__default', verdict: 'fine', fix: '' }],
  );
});

test('parseEyes: null and empty text give an empty list', () => {
  assert.deepEqual(parseEyes(null), []);
  assert.deepEqual(parseEyes(''), []);
});

// --- openAsks ---

const SEP = '|---|---|---|---|---|---|';

test('openAsks: a row is open when it has an ask and no closed-by', () => {
  const text = [
    '# Escapes', '', ESCAPES_HEADER, SEP,
    '| esc:1 | desktop | Archive hidden | no | Does the Archive button show on a short window? |  |',
    '| esc:2 | desktop | Old title | yes | Is the title right? | esc:0 |',
    '| esc:3 | desktop | Empty ask |  |  |  |',
  ].join('\n');
  assert.deepEqual(openAsks(text), [{ id: 'esc:1', ask: 'Does the Archive button show on a short window?' }]);
});

test('openAsks: an escaped pipe in the ask is read as a pipe and does not split the cell', () => {
  const text = [ESCAPES_HEADER, SEP, '| esc:4 | d | w | c | 5 \\| 3 is the rule? |  |'].join('\n');
  assert.deepEqual(openAsks(text), [{ id: 'esc:4', ask: '5 | 3 is the rule?' }]);
});

test('openAsks: trailing spaces on the header row are ignored', () => {
  const text = [`${ESCAPES_HEADER}   `, SEP, '| esc:5 | d | w | c | Is it open? |  |'].join('\n');
  assert.deepEqual(openAsks(text), [{ id: 'esc:5', ask: 'Is it open?' }]);
});

test('openAsks: only the table whose header is ESCAPES_HEADER is read', () => {
  const text = [
    '| id | x |', '|---|---|', '| esc:9 | y |', '',
    ESCAPES_HEADER, SEP, '| esc:6 | d | w | c | Real ask? |  |',
  ].join('\n');
  assert.deepEqual(openAsks(text), [{ id: 'esc:6', ask: 'Real ask?' }]);
});

test('openAsks: no table, or null, gives an empty list', () => {
  assert.deepEqual(openAsks('just prose\n| esc:1 | d | w | c | Ask? |  |\n'), []);
  assert.deepEqual(openAsks(null), []);
});
