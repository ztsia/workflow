// The step 4 brief's example Run (diff mode, one viewport, two pairs), as functions that build fresh
// objects on every call, so one test can change a field without touching another. Only the fields
// the summary.mjs and verdict.mjs contracts read are here (run.mjs, compare.mjs).

export function pairDetail() {
  return {
    key: 'detail__default', status: 'changed',
    before: { screen: 'detail' }, after: { screen: 'detail' },
    elements: [{ k: 'Title#1', status: 'changed' }, { k: 'Badge#1', status: 'same' }],
    tree: {
      same: false,
      added: [{ n: 4, line: 'heading "New title" [level=1]' }, { n: 9, line: 'button "Archive"' }],
      removed: [{ n: 4, line: 'heading "Old title" [level=1]' }],
      truncated: false, explained: [], masked: 0,
    },
    pixel: { ratio: 0.024, worstTile: 0.031, sameSize: true, changed: true },
    checks: {
      new: [{ check: 'contrast', detail: 'span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1' }],
      standing: [{ check: 'target', detail: 'button "x" is 20×20 px, needs 24 px' }],
      fixed: [],
    },
    tour: {
      opened: 3, failed: 0, hover: 10, hoverSilent: 2,
      new: ['listbox "Status" 200×240 cut off by div.card'],
      standing: ['menu "Columns" 180×300 runs past the top of the screen'],
      fixed: [],
    },
    console: { new: ['TypeError: x is undefined'], standing: [] },
  };
}

export function pairList() {
  return {
    key: 'list__default', status: 'same',
    before: { screen: 'list' }, after: { screen: 'list' },
    elements: [],
    tree: { same: true, added: [], removed: [], truncated: false, explained: [], masked: 0 },
    pixel: { ratio: 0, worstTile: 0, sameSize: true, changed: false },
    checks: { new: [], standing: [], fixed: [] },
    tour: { opened: 1, failed: 0, hover: 4, hoverSilent: 0, new: [], standing: [], fixed: [] },
    console: { new: [], standing: [] },
  };
}

export function compareResult() {
  return {
    exit: 1,
    viewports: [{
      viewport: 'desktop', exit: 1, pairs: [pairDetail(), pairList()],
      expectations: [{ name: 'title-renamed', describe: '…', result: 'met', detail: '1 element(s): 1 right' }],
      unexpected: [{ key: 'detail__default', kind: 'tree', added: ['heading "New title" [level=1]', 'button "Archive"'], removed: [] }],
      overflow: [], inconclusive: [], eyes: ['detail__default'], standing: { checks: 1, tour: 1, console: 0 },
    }],
  };
}

// One SideResult with one viewport ('desktop') unless the test adds more.
export function sideResult(ms, { failed = [], notRun = [], captured = ['detail__default', 'list__default'] } = {}) {
  return {
    viewports: [{ viewport: 'desktop', captured, failed, notRun, warnings: [] }],
    clock: { clock: null, why: 'real' }, mapErrors: [], ms,
  };
}

export function exampleRun() {
  return {
    exit: 1, mode: 'diff', slug: 'feat-x',
    head: { ref: 'HEAD', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40), cached: true },
    maps: { head: 'c'.repeat(64), base: 'd'.repeat(64) },
    sandboxes: { base: { name: null, state: 'cached', ms: 0 }, head: { name: 'qa-aaaaaaaaaa', state: 'up', ms: 81000 } },
    steps: [
      { side: 'head', verb: 'up', ok: true, ms: 81000, note: '' },
      { side: 'head', verb: 'capture', ok: true, ms: 32000, note: '' },
      { side: 'head', verb: 'down', ok: true, ms: 4000, note: '' },
      { side: 'run', verb: 'compare', ok: true, ms: 3000, note: '' },
    ],
    sides: { base: sideResult(30000), head: sideResult(32000), again: null },
    compare: compareResult(), blocked: null, warnings: [],
    standing: { file: 'qa/standing.md', added: 2, seen: 0 },
    dirs: { verification: '/v', work: '/w', cache: '/c' }, report: '/w/compare/index.html',
  };
}

// A self-test (decision 13): head captured twice, compare of the two captures, base null.
// Identical: every pair same, compare exit 0.
export function sameDetail() {
  return { ...pairList(), key: 'detail__default', before: { screen: 'detail' }, after: { screen: 'detail' } };
}

export function selfRun() {
  return {
    exit: 0, mode: 'self', slug: 'feat-x',
    head: { ref: 'HEAD', sha: 'a'.repeat(40) }, base: null,
    maps: { head: 'c'.repeat(64), base: null },
    sandboxes: { base: null, head: { name: 'qa-aaaaaaaaaa', state: 'up', ms: 81000 } },
    steps: [
      { side: 'head', verb: 'up', ok: true, ms: 81000, note: '' },
      { side: 'head', verb: 'capture', ok: true, ms: 32000, note: '' },
      { side: 'head', verb: 'down', ok: true, ms: 4000, note: '' },
      { side: 'run', verb: 'compare', ok: true, ms: 3000, note: '' },
    ],
    sides: { base: null, head: sideResult(32000), again: sideResult(31000) },
    compare: {
      exit: 0,
      viewports: [{
        viewport: 'desktop', exit: 0, pairs: [sameDetail(), pairList()],
        expectations: [], unexpected: [], overflow: [], inconclusive: [], eyes: [],
        standing: { checks: 0, tour: 0, console: 0 },
      }],
    },
    blocked: null, warnings: [], standing: null,
    dirs: { verification: '/v', work: '/w', cache: null }, report: '/w/compare/index.html',
  };
}

// A run the sandbox could not bring up: compare never ran, the head side is null.
export function blockedRun() {
  return {
    ...exampleRun(),
    exit: 4, compare: null,
    blocked: 'BLOCKED ON INFRASTRUCTURE: head: supabase start failed',
    sandboxes: { base: { name: null, state: 'cached', ms: 0 }, head: null },
    steps: [],
    sides: { base: sideResult(30000), head: null, again: null },
    standing: null,
    report: null,
  };
}
