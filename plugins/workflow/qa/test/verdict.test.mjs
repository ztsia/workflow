// SEVERITY and draftVerdict on hand-built Results objects (shapes as summary.mjs's contract), so these
// tests do not depend on buildResults: the severity table, criteria, findings order, gaps, the verdict
// rules and the draft's md layout.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildResults } from '../scripts/lib/summary.mjs';
import { SEVERITY, draftVerdict, parseSecurity, parseVerdict } from '../scripts/lib/verdict.mjs';
import { exampleRun } from './fixtures/run-example.mjs';
import { exampleRun6 } from './fixtures/run-example6.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function results(over = {}) {
  return {
    version: 1, mode: 'diff', slug: 'feat-x', exit: 0,
    head: { sha: SHA_A, ref: 'HEAD' }, base: { sha: SHA_B, ref: 'main', cached: true },
    maps: { head: 'c'.repeat(64), base: 'd'.repeat(64) },
    sandboxes: { base: null, head: null }, steps: [], warnings: [], blocked: null, mapErrors: 0,
    failures: [], notRun: [], screens: [], expectations: [], unexpected: [],
    tour: { opened: 0, failed: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [], standing: 0 },
    checks: { new: [], standing: 0, fixed: 0 },
    console: { new: [], standing: 0 },
    eyes: [], routes: null, mutants: null, livedIn: null, metrics: null,
    standing: { checks: 0, tour: 0, console: 0, file: null, added: 0 },
    identical: null, report: null, compare: null,
    ...over,
  };
}

// Fixture pieces: each returns a fresh object.
function ex(result, name = 'title-renamed') {
  return { id: `exp:${name}`, viewport: 'desktop', name, result, detail: `${name} detail` };
}

function headFailure(over = {}) {
  return {
    id: 'fail:head/desktop/detail', side: 'head', viewport: 'desktop', screen: 'detail', step: '{"click":"x"}',
    error: 'line1\nline2\nline3\nline4', lines: ['line1', 'line2', 'line3'], mapError: false, onBase: false, ...over,
  };
}

function baseFailure() {
  return {
    id: 'fail:base/desktop/detail', side: 'base', viewport: 'desktop', screen: 'detail', step: '{"click":"x"}',
    error: 'line1\nline2\nline3\nline4', lines: ['line1', 'line2', 'line3'], mapError: false, onBase: false,
  };
}

function screenEntry(over = {}) {
  return {
    id: 'scr:desktop/detail__default', viewport: 'desktop', key: 'detail__default', screen: 'detail', status: 'changed',
    tree: { added: 2, removed: 1, unexplained: 2 }, elements: { changed: 1, drift: 0 },
    pixel: { ratio: 0.024, worstTile: 0.031, changed: true }, eyes: true, ...over,
  };
}

function tourProblem() {
  return {
    id: 'tour:desktop/detail__default/1', viewport: 'desktop', key: 'detail__default',
    text: 'listbox "Status" 200×240 cut off by div.card', kind: 'clipped',
  };
}

function tourWith(list) {
  return { opened: 1, failed: 0, clipped: list.length, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: list, standing: 0 };
}

function consoleLine() {
  return { id: 'con:desktop/detail__default/1', viewport: 'desktop', key: 'detail__default', text: 'TypeError: x is undefined' };
}

function check(id, name) {
  return { id, viewport: 'desktop', key: 'detail__default', check: name, detail: `${name} detail text` };
}

function unexpectedTree() {
  return {
    id: 'unx:desktop/detail__default/1', viewport: 'desktop', key: 'detail__default', kind: 'tree',
    added: ['heading "New title" [level=1]', 'button "Archive"'], removed: [],
  };
}

function sev(draft, id) {
  return draft.findings.find((f) => f.id === id)?.severity;
}

// V1 ---------------------------------------------------------------------------------------------

test('V1 SEVERITY is frozen and maps each finding source to its severity', () => {
  assert.ok(Object.isFrozen(SEVERITY), 'SEVERITY is frozen');
  const want = {
    'head-failure': 'Blocker', tour: 'Major', console: 'Major',
    'check:contrast': 'Major', 'check:keyboard': 'Major', 'check:focus': 'Major', 'check:covered': 'Major', 'check:clipped': 'Major',
    'check:target': 'Minor', 'check:overlap': 'Minor',
    unexpected: 'judge', eyes: 'eyes',
  };
  for (const [source, severity] of Object.entries(want)) {
    assert.equal(SEVERITY[source], severity, source);
  }
});

test('V1 a check outside the named list (check:<other>) is a Minor finding', () => {
  const d = draftVerdict(results({ checks: { new: [check('chk:desktop/detail__default/1', 'zzz-other')], standing: 0, fixed: 0 } }));
  assert.equal(sev(d, 'chk:desktop/detail__default/1'), 'Minor');
});

// V2 ---------------------------------------------------------------------------------------------

test('V2 criteria: met passes, NOT MET fails, not observed (0 elements: the tool) is blocked; the md criteria line counts them', () => {
  const d = draftVerdict(results({ expectations: [ex('met', 'a'), ex('NOT MET', 'b'), ex('not observed', 'c')] }));
  assert.deepEqual(d.criteria, { pass: 1, fail: 1, unverifiable: 0, blocked: 1, waived: 0 });
  assert.equal(d.md.split('\n')[4], 'criteria: 1 pass · 1 fail · 0 unverifiable · 1 blocked · 0 waived');
});

test('V2 already true before counts as unverifiable', () => {
  const d = draftVerdict(results({ expectations: [ex('already true before')] }));
  assert.deepEqual(d.criteria, { pass: 0, fail: 0, unverifiable: 1, blocked: 0, waived: 0 });
});

test('V2 the Criteria section names each expectation with its result', () => {
  const d = draftVerdict(results({ expectations: [ex('met', 'a'), ex('NOT MET', 'b'), ex('not observed', 'c')] }));
  const ls = d.md.split('\n');
  const at = ls.indexOf('## Criteria');
  assert.notEqual(at, -1, 'a ## Criteria heading');
  assert.equal(ls[at + 1], '- [exp:a] PASS — a: a detail');
  assert.equal(ls[at + 2], '- [exp:b] FAIL — b: b detail');
  assert.equal(ls[at + 3], '- [exp:c] BLOCKED — c: c detail; it observed 0 elements, so the tool could not check it');
});

// V3 ---------------------------------------------------------------------------------------------

test('V3 a head failure the base does not share is a BLOCKED item (the tool could not walk it), never a finding', () => {
  const d = draftVerdict(results({ failures: [headFailure({ onBase: false })] }));
  assert.equal(sev(d, 'fail:head/desktop/detail'), undefined);
  assert.deepEqual(d.blocked.map((b) => b.id), ['fail:head/desktop/detail']);
  assert.ok(d.gaps.some((g) => g.id === 'fail:head/desktop/detail' && g.text.startsWith('BLOCKED — ')), JSON.stringify(d.gaps));
});

test('V3 a head failure where the app answered a server error is a Blocker finding', () => {
  const d = draftVerdict(results({ failures: [headFailure({ onBase: false, serverError: '500 GET /api/detail' })] }));
  assert.equal(sev(d, 'fail:head/desktop/detail'), 'Blocker');
  assert.match(d.findings[0].text, /the app answered: 500 GET \/api\/detail$/);
  assert.deepEqual(d.blocked, []);
});

test('V3 a head failure the base also had is a gap, not a finding', () => {
  const d = draftVerdict(results({ failures: [headFailure({ onBase: true }), baseFailure()] }));
  assert.deepEqual(d.findings, []);
  assert.ok(d.gaps.some((g) => /desktop\/detail/.test(g.id)), `a gap names the screen, got ${JSON.stringify(d.gaps)}`);
});

test('V3 a MAP ERROR head failure is a gap, not a finding', () => {
  const d = draftVerdict(results({
    failures: [headFailure({ mapError: true, onBase: false })],
    mapErrors: 1,
    screens: [screenEntry({ id: 'scr:desktop/detail', key: null, status: 'MAP ERROR', tree: null, pixel: null, elements: { changed: 0, drift: 0 }, eyes: false })],
  }));
  assert.deepEqual(d.findings, []);
  assert.ok(d.gaps.some((g) => /desktop\/detail/.test(g.id)), `a gap names the screen, got ${JSON.stringify(d.gaps)}`);
});

// V4 ---------------------------------------------------------------------------------------------

test('V4 findings order: Blocker, Major, Minor, judge, eyes, with the source rules applied', () => {
  const d = draftVerdict(results({
    expectations: [ex('met')],
    failures: [headFailure({ onBase: false, serverError: '502 document /detail' })],
    tour: tourWith([tourProblem()]),
    console: { new: [consoleLine()], standing: 0 },
    checks: { new: [check('chk:desktop/detail__default/1', 'contrast'), check('chk:desktop/detail__default/2', 'target')], standing: 0, fixed: 0 },
    unexpected: [unexpectedTree()],
    screens: [screenEntry()],
    eyes: ['scr:desktop/detail__default'],
  }));
  assert.deepEqual(d.findings.map((f) => f.severity), ['Blocker', 'Major', 'Major', 'Major', 'Minor', 'judge', 'eyes']);
  assert.equal(d.findings[0].id, 'fail:head/desktop/detail');
  assert.deepEqual(d.findings.slice(1, 4).map((f) => f.id).sort(),
    ['chk:desktop/detail__default/1', 'con:desktop/detail__default/1', 'tour:desktop/detail__default/1']);
  assert.equal(sev(d, 'chk:desktop/detail__default/1'), 'Major');
  assert.equal(sev(d, 'chk:desktop/detail__default/2'), 'Minor');
  assert.equal(sev(d, 'unx:desktop/detail__default/1'), 'judge');
  assert.equal(sev(d, 'scr:desktop/detail__default'), 'eyes');
});

// V5 ---------------------------------------------------------------------------------------------

test('V5 a Major on a changed screen the base walked too gates (corroborated regression): REJECT', () => {
  const d = draftVerdict(results({ expectations: [ex('met')], tour: tourWith([tourProblem()]), screens: [screenEntry({ eyes: false })] }));
  assert.equal(d.verdict, 'REJECT');
  assert.deepEqual(d.gates, ['tour:desktop/detail__default/1']);
});

test('V5 a Major that is not a corroborated page check on a changed screen never gates: ACCEPT', () => {
  const d = draftVerdict(results({ expectations: [ex('met')], console: { new: [consoleLine()], standing: 0 } }));
  assert.equal(sev(d, 'con:desktop/detail__default/1'), 'Major');
  assert.equal(d.verdict, 'ACCEPT');
});

test('V5 a NOT MET criterion gives REJECT', () => {
  assert.equal(draftVerdict(results({ expectations: [ex('NOT MET')] })).verdict, 'REJECT');
});

test('V5 an unverifiable criterion gives NEEDS YOU; one the tool could not check gives BLOCKED', () => {
  assert.equal(draftVerdict(results({ expectations: [ex('already true before')] })).verdict, 'NEEDS YOU');
  assert.equal(draftVerdict(results({ expectations: [ex('not observed')] })).verdict, 'BLOCKED');
});

test('V5 a Blocker finding gives REJECT', () => {
  assert.equal(draftVerdict(results({ expectations: [ex('met')], failures: [headFailure({ onBase: false, serverError: '500 document /x' })] })).verdict, 'REJECT');
});

test('V5 a blocked run gives BLOCKED', () => {
  const d = draftVerdict(results({
    expectations: [ex('met')], blocked: 'BLOCKED ON INFRASTRUCTURE: head: supabase start failed',
    failures: [{ id: 'fail:sandbox/head', side: 'head', viewport: null, screen: null, step: 'up', error: 'BLOCKED ON INFRASTRUCTURE: head: supabase start failed', lines: ['BLOCKED ON INFRASTRUCTURE: head: supabase start failed'], mapError: false, onBase: false }],
  }));
  assert.equal(d.verdict, 'BLOCKED');
});

test('V5 only judge and eyes findings, all criteria met gives PENDING', () => {
  const d = draftVerdict(results({
    expectations: [ex('met')], unexpected: [unexpectedTree()], screens: [screenEntry()], eyes: ['scr:desktop/detail__default'],
  }));
  assert.deepEqual(d.findings.map((f) => f.severity), ['judge', 'eyes']);
  assert.equal(d.verdict, 'PENDING');
});

test('V5 no expectations gives PENDING with the gap:criteria gap', () => {
  const d = draftVerdict(results({ expectations: [] }));
  assert.equal(d.verdict, 'PENDING');
  assert.ok(d.gaps.some((g) => g.id === 'gap:criteria'), 'gap:criteria is listed');
});

test('V5 all met and nothing else gives ACCEPT', () => {
  assert.equal(draftVerdict(results({ expectations: [ex('met')] })).verdict, 'ACCEPT');
});

// V6 ---------------------------------------------------------------------------------------------

function sectionOf(ls, name) {
  const at = ls.indexOf(`## ${name}`);
  assert.notEqual(at, -1, `a ## ${name} heading`);
  const out = [];
  for (const l of ls.slice(at + 1)) {
    if (l.startsWith('## ') || l.startsWith('cost: ')) break;
    if (l !== '') out.push(l);
  }
  return out;
}

test('V6 the md header block, the seven sections in order, the none lines and the cost line', () => {
  const d = draftVerdict(results({
    expectations: [ex('met')], unexpected: [unexpectedTree()],
    standing: { checks: 1, tour: 1, console: 0, file: 'qa/standing.md', added: 2 },
  }));
  const ls = d.md.replace(/\n$/, '').split('\n');
  assert.equal(ls[0], '# PENDING — feat-x');
  assert.ok(ls[1].startsWith('head: ') && ls[1].includes('a'.repeat(12)), `head line: ${ls[1]}`);
  assert.ok(ls[2].startsWith('base: ') && ls[2].includes('b'.repeat(12)), `base line: ${ls[2]}`);
  assert.equal(ls[3], `maps: ${'c'.repeat(12)}`);
  assert.equal(ls[4], 'criteria: 1 pass · 0 fail · 0 unverifiable · 0 blocked · 0 waived');
  assert.ok(ls[5].startsWith('draft: qa verdict draft'), `draft line: ${ls[5]}`);
  assert.equal(ls[6], '');

  assert.deepEqual(ls.filter((l) => l.startsWith('## ')),
    ['## Criteria', '## Expectations', '## Findings', '## Spec cases', '## Gaps', '## Standing', '## Notes']);

  assert.deepEqual(sectionOf(ls, 'Criteria'), ['- [exp:title-renamed] PASS — title-renamed: title-renamed detail']);
  assert.match(sectionOf(ls, 'Expectations')[0], /^- \[unx:desktop\/detail__default\/1\] UNEXPECTED tree: /);
  assert.match(sectionOf(ls, 'Findings')[0], /^- judge \[unx:desktop\/detail__default\/1\] /);
  assert.deepEqual(sectionOf(ls, 'Spec cases'), ['- none (the runner ran data only)']);
  assert.deepEqual(sectionOf(ls, 'Gaps'), ['- none']);
  assert.deepEqual(sectionOf(ls, 'Standing'), ['- 2 standing item(s), never gating — qa/standing.md']);
  assert.deepEqual(sectionOf(ls, 'Notes'), ['- lived-in: not run in this step', '- routes: no route table', '- mutants: not run']);

  assert.equal(ls[ls.length - 2], '', 'a blank line before the cost line');
  assert.equal(ls[ls.length - 1], 'cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0');
});

test('V6 an empty Findings section holds "- none", and base null reads "base: none"', () => {
  const d = draftVerdict(results({ expectations: [ex('met')], base: null }));
  const ls = d.md.replace(/\n$/, '').split('\n');
  assert.equal(ls[2], 'base: none');
  assert.deepEqual(sectionOf(ls, 'Findings'), ['- none']);
});

// V7 ---------------------------------------------------------------------------------------------

test('V7 self-mode results throw: a self-test has no verdict', () => {
  assert.throws(() => draftVerdict(results({ mode: 'self', base: null })), /self-test has no verdict/);
});

// STEP 5 (contract: scripts/lib/verdict.mjs, the "STEP 5" block): parseSecurity, draftVerdict's
// security option, the judge's verdict.md as parseVerdict reads it, and the draft read back.

// The step 5 brief's judge verdict.md for exampleRun() (validateVerdict returns []).
const JUDGE_MD = `# REJECT — feat-x
head: ${'a'.repeat(40)}
base: ${'b'.repeat(40)}
maps: cccccccccccc
criteria: 2 pass · 0 fail · 0 unverifiable

## Criteria
- [exp:title-renamed] PASS — title-renamed: 1 element(s): 1 right
- [ch:1] PASS — archive is offered: the Archive button appears for an open record

## Expectations
- [unx:desktop/detail__default/1] explained — the spec adds an Archive button to the detail header

## Findings
- Major [tour:desktop/detail__default/1] new: listbox "Status" 200×240 cut off by div.card — files: src/detail/StatusSelect.tsx
- Major [chk:desktop/detail__default/1] contrast: span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1 — files: src/detail/Detail.css
- Major [con:desktop/detail__default/1] console: TypeError: x is undefined — files: src/detail/Detail.tsx
- Minor [scr:desktop/detail__default] the Archive button sits under the fold on a short window

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 2 standing item(s), never gating — qa/standing.md

## Notes
- lived-in: not run in this step
- routes: no route table
- mutants: not run

cost: plan $0.41 · eyes $0.62 · judge $0.18 · runner 0 · total $1.21
`;

const SEC_TEXT = [
  '# Security — feat-x',
  '- High [sec:1] the archive route skips the role check — src/api/archive.ts:14',
  '- Low [sec:3] the error message echoes the record id — src/api/archive.ts:30',
  '- Medium [sec:2] the session cookie has no SameSite flag',
].join('\n');

describe('step 5', () => {
  test('S5.1 parseSecurity reads each "- High|Medium|Low [sec:n] text" line, in file order', () => {
    assert.deepEqual(parseSecurity(SEC_TEXT), [
      { id: 'sec:1', level: 'High', text: 'the archive route skips the role check — src/api/archive.ts:14' },
      { id: 'sec:3', level: 'Low', text: 'the error message echoes the record id — src/api/archive.ts:30' },
      { id: 'sec:2', level: 'Medium', text: 'the session cookie has no SameSite flag' },
    ]);
  });

  test('S5.2 parseSecurity ignores every other line', () => {
    const text = [
      'Some prose about the review.',
      '- Critical [sec:4] not a level',
      '- High sec:5 no brackets',
      '  - High [sec:6] indented',
      '- High [sec:7] the only real one',
      '- none',
    ].join('\n');
    assert.deepEqual(parseSecurity(text), [{ id: 'sec:7', level: 'High', text: 'the only real one' }]);
  });

  test('S5.3 parseSecurity of null or an empty string is []', () => {
    assert.deepEqual(parseSecurity(null), []);
    assert.deepEqual(parseSecurity(''), []);
  });

  test('S5.4 security High is a Blocker, Medium a Major, Low a Minor, each after the results findings of its severity', () => {
    const d = draftVerdict(results({
      expectations: [ex('met')],
      tour: tourWith([tourProblem()]),
      checks: { new: [check('chk:desktop/detail__default/1', 'target')], standing: 0, fixed: 0 },
    }), { security: parseSecurity(SEC_TEXT) });
    assert.deepEqual(d.findings.map((f) => [f.id, f.severity]), [
      ['sec:1', 'Blocker'],
      ['tour:desktop/detail__default/1', 'Major'],
      ['sec:2', 'Major'],
      ['chk:desktop/detail__default/1', 'Minor'],
      ['sec:3', 'Minor'],
    ]);
    assert.equal(d.verdict, 'REJECT');
    assert.ok(d.md.split('\n').includes('- Blocker [sec:1] the archive route skips the role check — src/api/archive.ts:14'), 'the md has the Blocker row');
  });

  test('S5.4 a Low security finding alone gives ACCEPT: Minor never rejects', () => {
    const d = draftVerdict(results({ expectations: [ex('met')] }), { security: parseSecurity('- Low [sec:3] the error echoes the id') });
    assert.equal(d.verdict, 'ACCEPT');
  });

  test('S5.5 with no security entries the draft is exactly the step 4 draft', () => {
    const r = results({ expectations: [ex('met')], tour: tourWith([tourProblem()]), unexpected: [unexpectedTree()] });
    assert.deepEqual(draftVerdict(r, { security: [] }), draftVerdict(r));
    assert.equal(draftVerdict(r, {}).md, draftVerdict(r).md);
  });

  test('S5.6 parseVerdict reads the step 5 brief example: header, criteria, findings, expectations', () => {
    const v = parseVerdict(JUDGE_MD);
    assert.equal(v.verdict, 'REJECT');
    assert.equal(v.slug, 'feat-x');
    assert.equal(v.head, 'a'.repeat(40));
    assert.equal(v.base, 'b'.repeat(40));
    assert.equal(v.maps, 'cccccccccccc');
    assert.deepEqual(v.criteriaLine, { pass: 2, fail: 0, unverifiable: 0, blocked: 0, waived: 0 });
    assert.equal(v.draft, false);
    assert.deepEqual(v.sections, ['Criteria', 'Expectations', 'Findings', 'Spec cases', 'Gaps', 'Standing', 'Notes']);
    assert.deepEqual(v.criteria, [
      { id: 'exp:title-renamed', status: 'PASS', name: 'title-renamed', detail: '1 element(s): 1 right' },
      { id: 'ch:1', status: 'PASS', name: 'archive is offered', detail: 'the Archive button appears for an open record' },
    ]);
    assert.deepEqual(v.findings[0], {
      severity: 'Major', id: 'tour:desktop/detail__default/1', text: 'new: listbox "Status" 200×240 cut off by div.card', files: ['src/detail/StatusSelect.tsx'],
    });
    assert.deepEqual(v.findings[3], { severity: 'Minor', id: 'scr:desktop/detail__default', text: 'the Archive button sits under the fold on a short window', files: [] });
    assert.deepEqual(v.expectations, [{ id: 'unx:desktop/detail__default/1', resolution: 'explained', text: 'the spec adds an Archive button to the detail header' }]);
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.gaps, []);
    assert.deepEqual(v.specCases, []);
    assert.equal(v.standing, '2 standing item(s), never gating — qa/standing.md');
    assert.equal(v.cost, 'cost: plan $0.41 · eyes $0.62 · judge $0.18 · runner 0 · total $1.21');
  });

  test('S5.7 parseVerdict reads a draft: draft true, judge and eyes rows, the UNEXPECTED expectation', () => {
    const v = parseVerdict(draftVerdict(buildResults(exampleRun())).md);
    assert.equal(v.verdict, 'REJECT');
    assert.equal(v.draft, true);
    assert.equal(v.slug, 'feat-x');
    assert.deepEqual(v.criteriaLine, { pass: 1, fail: 0, unverifiable: 0, blocked: 0, waived: 0 });
    assert.deepEqual(v.findings.map((f) => f.severity), ['Major', 'Major', 'Major', 'judge', 'eyes']);
    assert.deepEqual(v.findings.slice(3).map((f) => f.id), ['unx:desktop/detail__default/1', 'scr:desktop/detail__default']);
    assert.equal(v.expectations.length, 1);
    assert.equal(v.expectations[0].id, 'unx:desktop/detail__default/1');
    assert.equal(v.expectations[0].resolution, 'UNEXPECTED');
    assert.ok(v.expectations[0].text.startsWith('tree: '), v.expectations[0].text);
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.specCases, []);
    assert.equal(v.cost, 'cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0');
  });

  test('S5.7 parseVerdict reads a PENDING draft that holds only judge and eyes rows', () => {
    const md = draftVerdict(results({
      expectations: [ex('met')], unexpected: [unexpectedTree()], screens: [screenEntry()], eyes: ['scr:desktop/detail__default'],
    })).md;
    const v = parseVerdict(md);
    assert.equal(v.verdict, 'PENDING');
    assert.equal(v.draft, true);
    assert.deepEqual(v.findings.map((f) => f.severity), ['judge', 'eyes']);
    assert.deepEqual(v.errors, []);
  });

  test('S5.8 an item line that matches no form is an error, quoted whole; "- none" never is', () => {
    const bad = [
      '- [exp:title-renamed] MAYBE — title-renamed: 1 right',
      '- Critical [tour:desktop/detail__default/1] new: listbox cut off',
    ];
    const md = JUDGE_MD
      .replace('- [ch:1] PASS', `${bad[0]}\n- [ch:1] PASS`)
      .replace('- Major [tour:', `${bad[1]}\n- Major [tour:`);
    assert.deepEqual(parseVerdict(md).errors, bad);
  });

  test('S5.9 parseVerdict never throws, and reads ACCEPT as a verdict word', () => {
    for (const text of ['', 'nonsense', '# ', '## Findings\n- ']) {
      assert.doesNotThrow(() => parseVerdict(text), JSON.stringify(text));
    }
    assert.equal(parseVerdict('nonsense').verdict, null);
    assert.equal(parseVerdict('nonsense').draft, false);
    assert.equal(parseVerdict('# ACCEPT — feat-x\n').verdict, 'ACCEPT');
  });
});

// step 6 -----------------------------------------------------------------------------------------

const FLAG = { id: 'met:desktop/detail__default/screen.readyMs', viewport: 'desktop', key: 'detail__default', metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 };

function routesWith(newList, over = {}) {
  return {
    file: 'qa/routes.table.json', rows: 2, probes: 30, notRunProbes: 0, failed: newList.length, new: newList, standing: 0, fixed: 0,
    unlisted: [], stale: [], errors: [], notRun: null, base: 'swept', ...over,
  };
}

function routeNew(id, problem) {
  return { id, pid: `POST /api/notes|${id}`, route: 'POST /api/notes', kind: 'deep', actor: 'staff', status: 500, problem };
}

function mutantsWith(over = {}) {
  return { mode: 'affected', file: 'qa/mutants.json', run: 2, killed: 1, survived: [], stale: [], notJudged: [], suites: {}, errors: [], ...over };
}

function mutantEntry(id, over = {}) {
  return { id, mutant: id.slice(4), origin: 'registry', breaks: 'a person can move their row to someone else', file: 'supabase/migrations/0007.sql', suite: 'db', detail: '', ...over };
}

function metricsWith(flags, standing = 0) {
  return { captures: 2, msPerCapture: 16000, flags, standing };
}

test('step 6: SEVERITY gives the route, mutant and metric sources their severities', () => {
  assert.equal(SEVERITY['route:blocker'], 'Blocker');
  assert.equal(SEVERITY.route, 'Major');
  assert.equal(SEVERITY['route:unlisted'], 'Major');
  assert.equal(SEVERITY['route:stale'], 'Minor');
  assert.equal(SEVERITY['mutant:survived'], 'Major');
  assert.equal(SEVERITY['mutant:stale'], 'Minor');
  assert.equal(SEVERITY.metric, 'judge');
});

const BLOCKER_PROBLEMS = [
  '500 answered', '503 answered', 'stack trace in the answer',
  'answered 200 to signed-out (anon)', 'answered 200 to no-right (viewer)', 'answered 200 to other-id (staff)',
  'answered 200 to origin-foreign (staff)', 'answered 200 to origin-null (staff)',
];
for (const problem of BLOCKER_PROBLEMS) {
  test(`step 6: a route problem "${problem}" is a Blocker finding`, () => {
    const d = draftVerdict(results({ routes: routesWith([routeNew('rte:1', problem)]) }));
    assert.equal(sev(d, 'rte:1'), 'Blocker');
  });
}

for (const problem of ['happy path answered 400', 'answered 200 to wrong-method (staff)']) {
  test(`step 6: a route problem "${problem}" that is not a 5xx, stack or auth bypass is a Major finding`, () => {
    const d = draftVerdict(results({ routes: routesWith([routeNew('rte:1', problem)]) }));
    assert.equal(sev(d, 'rte:1'), 'Major');
  });
}

test('step 6: an unlisted route is a Major finding and a stale route is a Minor finding', () => {
  const d = draftVerdict(results({
    routes: routesWith([], {
      unlisted: [{ id: 'rte:unlisted/1', method: 'DELETE', path: '/api/notes/:id' }],
      stale: [{ id: 'rte:stale/1', method: 'GET', path: '/api/old' }],
    }),
  }));
  assert.equal(sev(d, 'rte:unlisted/1'), 'Major');
  assert.equal(sev(d, 'rte:stale/1'), 'Minor');
});

test('step 6: a survived mutant is a Major finding and a stale mutant is a Minor finding', () => {
  const d = draftVerdict(results({
    mutants: mutantsWith({ survived: [mutantEntry('mut:rls-check-dropped')], stale: [mutantEntry('mut:old', { detail: 'stale: x.sql missing' })] }),
  }));
  assert.equal(sev(d, 'mut:rls-check-dropped'), 'Major');
  assert.equal(sev(d, 'mut:old'), 'Minor');
});

test('step 6: a metric flag is a judge row, so a draft with only a metric flag is PENDING', () => {
  const d = draftVerdict(results({ expectations: [ex('met')], metrics: metricsWith([FLAG]) }));
  assert.deepEqual(d.findings.map((f) => f.severity), ['judge']);
  assert.equal(sev(d, FLAG.id), 'judge');
  assert.equal(d.verdict, 'PENDING');
});

test('step 6: findings order within a severity: results, then routes, then mutants, then metrics, then security', () => {
  const d = draftVerdict(results({
    failures: [headFailure({ onBase: false, serverError: '500 document /detail' })],
    tour: tourWith([tourProblem()]),
    unexpected: [unexpectedTree()],
    routes: routesWith([routeNew('rte:1', '500 answered'), routeNew('rte:2', 'happy path answered 400')], {
      unlisted: [{ id: 'rte:unlisted/1', method: 'DELETE', path: '/api/notes/:id' }],
      stale: [{ id: 'rte:stale/1', method: 'GET', path: '/api/old' }],
    }),
    mutants: mutantsWith({ survived: [mutantEntry('mut:x')], stale: [mutantEntry('mut:y')] }),
    metrics: metricsWith([FLAG]),
  }), {
    security: [
      { id: 'sec:2', level: 'Medium', text: 'the session cookie has no SameSite flag' },
      { id: 'sec:3', level: 'Low', text: 'the error message echoes the record id' },
    ],
  });
  assert.deepEqual(d.findings.map((f) => f.id), [
    'fail:head/desktop/detail', 'rte:1',
    'tour:desktop/detail__default/1', 'rte:2', 'rte:unlisted/1', 'mut:x', 'sec:2',
    'rte:stale/1', 'mut:y', 'sec:3',
    'unx:desktop/detail__default/1', FLAG.id,
  ]);
});

test('step 6: an unjudged mutant is a Gaps row with its mut: id, and changes no verdict', () => {
  const d = draftVerdict(results({
    expectations: [ex('met')],
    mutants: mutantsWith({ notJudged: [mutantEntry('mut:z', { detail: 'suite db fails unmutated' })] }),
  }));
  assert.deepEqual(d.gaps.find((g) => g.id === 'mut:z'), { id: 'mut:z', text: 'not judged: suite db fails unmutated' });
  assert.deepEqual(d.findings, []);
  assert.deepEqual(d.criteria, { pass: 1, fail: 0, unverifiable: 0, blocked: 0, waived: 0 });
  assert.equal(d.verdict, 'ACCEPT');
});

test('step 6: a route sweep that did not run is a gap:routes row with its reason, and changes no verdict', () => {
  const d = draftVerdict(results({ expectations: [ex('met')], routes: routesWith([], { notRun: 'route table has errors' }) }));
  assert.deepEqual(d.gaps.find((g) => g.id === 'gap:routes'), { id: 'gap:routes', text: 'route sweep not run: route table has errors' });
  assert.deepEqual(d.findings, []);
  assert.equal(d.verdict, 'ACCEPT');
});

test('step 6: probes that did not run give one gap:route-actors row that says see results.json', () => {
  const d = draftVerdict(results({ routes: routesWith([], { notRunProbes: 3 }) }));
  assert.deepEqual(d.gaps.filter((g) => g.id === 'gap:route-actors'), [{ id: 'gap:route-actors', text: '3 probe(s) not run: see results.json' }]);
});

test('step 6: Notes with routes and mutants run say only lived-in is not run', () => {
  const d = draftVerdict(results({ routes: routesWith([]), mutants: mutantsWith() }));
  assert.deepEqual(sectionOf(d.md.split('\n'), 'Notes'), ['- lived-in: not run in this step']);
});

test('step 6: Notes with no route table and no mutant run list routes and mutants, and give no gap:routes', () => {
  const d = draftVerdict(results({ routes: routesWith([], { notRun: 'no route table' }), mutants: null }));
  assert.deepEqual(sectionOf(d.md.split('\n'), 'Notes'), ['- lived-in: not run in this step', '- routes: no route table', '- mutants: not run']);
  assert.ok(!d.gaps.some((g) => g.id === 'gap:routes'), 'no gap:routes for no route table');
});

test('step 6: Notes with a route sweep that failed to run list only lived-in', () => {
  const d = draftVerdict(results({ routes: routesWith([], { notRun: 'route table has errors' }), mutants: mutantsWith() }));
  assert.deepEqual(sectionOf(d.md.split('\n'), 'Notes'), ['- lived-in: not run in this step']);
});

test('step 6: a route expectation gets a Criteria row under its exp: id', () => {
  const d = draftVerdict(buildResults(exampleRun6()));
  const ls = d.md.split('\n');
  assert.equal(ls.indexOf('- [exp:notes-denied-to-viewer] PASS — notes-denied-to-viewer: POST /api/notes as viewer: 403') > ls.indexOf('## Criteria'), true);
  assert.equal(ls[4], 'criteria: 2 pass · 0 fail · 0 unverifiable · 0 blocked · 0 waived');
});

test('step 6: the draft of the step 6 example: findings in order, REJECT, no gaps, and the md rows', () => {
  const d = draftVerdict(buildResults(exampleRun6()));
  assert.equal(d.verdict, 'REJECT');
  assert.deepEqual(d.findings.map((f) => `${f.severity} ${f.id}`), [
    'Blocker rte:1',
    'Major tour:desktop/detail__default/1', 'Major chk:desktop/detail__default/1', 'Major con:desktop/detail__default/1',
    'Major rte:2', 'Major rte:unlisted/1', 'Major mut:rls-check-dropped',
    'judge unx:desktop/detail__default/1', 'judge met:desktop/detail__default/screen.readyMs',
    'eyes scr:desktop/detail__default',
  ]);
  assert.deepEqual(d.gaps, []);
  assert.deepEqual(d.criteria, { pass: 2, fail: 0, unverifiable: 0, blocked: 0, waived: 0 });
  const ls = d.md.split('\n');
  assert.ok(ls.includes('- Blocker [rte:1] POST /api/notes deep (staff): 500 answered'), 'the Blocker row');
  assert.ok(ls.includes('- judge [met:desktop/detail__default/screen.readyMs] screen.readyMs 1800 ms over 1000 ms (base 900 ms)'), 'the judge row');
  assert.deepEqual(sectionOf(ls, 'Notes'), ['- lived-in: not run in this step']);
});

test('step 6 pilot: route table and mutant registry errors are gaps, never silent', () => {
  const run = exampleRun6();
  run.routes = { ...run.routes, errors: ['qa/routes.table.json: row 3: method must be one of the five'] };
  run.mutants = { ...run.mutants, errors: ['/abs/qa/mutants.json: ENOENT: no such file'] };
  const d = draftVerdict(buildResults(run));
  assert.ok(d.md.includes('- [gap:route-table] route table: 1 error(s), first: qa/routes.table.json: row 3: method must be one of the five'));
  assert.ok(d.md.includes('- [gap:mutants] mutant registry: 1 error(s), first: /abs/qa/mutants.json: ENOENT: no such file'));
});

// unmapped ---------------------------------------------------------------------------------------

const UNM = [
  { id: 'unm:1', file: 'src/features/jobs/JobAdComposePage.tsx' },
  { id: 'unm:2', file: 'src/features/jobs/JobAdPreview.tsx' },
];

test('unmapped: SEVERITY gives unmapped the Major severity', () => {
  assert.equal(SEVERITY.unmapped, 'Major');
  assert.ok(Object.isFrozen(SEVERITY));
});

test('unmapped: each unmapped file is a Major finding with the unmappedText, reported and never gating (1.0.0)', () => {
  const d = draftVerdict(results({ expectations: [ex('met')], unmapped: UNM }));
  assert.equal(sev(d, 'unm:1'), 'Major');
  assert.equal(sev(d, 'unm:2'), 'Major');
  assert.equal(d.verdict, 'ACCEPT');
  assert.equal(d.findings.find((f) => f.id === 'unm:1').text, 'unmapped: src/features/jobs/JobAdComposePage.tsx — no map entry walks it');
  assert.ok(d.md.includes('- Major [unm:1] unmapped: src/features/jobs/JobAdComposePage.tsx — no map entry walks it'));
  assert.ok(d.md.includes('- Major [unm:2] unmapped: src/features/jobs/JobAdPreview.tsx — no map entry walks it'));
});

test('unmapped: results without an unmapped list (or an empty one) add no finding', () => {
  const d = draftVerdict(results({ expectations: [ex('met')] }));
  assert.equal(d.findings.length, 0);
  assert.equal(d.verdict, 'ACCEPT');
  assert.equal(draftVerdict(results({ expectations: [ex('met')], unmapped: [] })).verdict, 'ACCEPT');
});

test('unmapped: the Majors keep their order, the unmapped rows after the route rows and before the mutant rows', () => {
  const d = draftVerdict(results({
    tour: tourWith([tourProblem()]),
    routes: routesWith([routeNew('rte:2', 'happy path answered 400')], {
      unlisted: [{ id: 'rte:unlisted/1', method: 'DELETE', path: '/api/notes/:id' }],
      stale: [{ id: 'rte:stale/1', method: 'GET', path: '/api/old' }],
    }),
    unmapped: UNM,
    mutants: mutantsWith({ survived: [mutantEntry('mut:x')] }),
  }));
  const majors = d.findings.filter((f) => f.severity === 'Major').map((f) => f.id);
  assert.deepEqual(majors, ['tour:desktop/detail__default/1', 'rte:2', 'rte:unlisted/1', 'unm:1', 'unm:2', 'mut:x']);
  assert.ok(d.findings.map((f) => f.id).indexOf('unm:1') < d.findings.map((f) => f.id).indexOf('rte:stale/1'), 'Majors before Minors');
});
