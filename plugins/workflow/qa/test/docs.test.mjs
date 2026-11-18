// Docs evidence (scripts/lib/docs.mjs, 0.6.0): a criterion that the docs say something is checked by script at the
// head commit, never left to the judge, who may not read the docs. checkDocs with an injected reader; runQa with a
// real git repo and injected sandboxes (as test/tests.test.mjs does).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { compareViewport } from '../scripts/lib/compare.mjs';
import { checkDocs, docEntries, docExpectations, docProblem } from '../scripts/lib/docs.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { draftVerdict } from '../scripts/lib/verdict.mjs';

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// A reader over two commits' files.
const reader = (files) => (sha, file) => files[sha]?.[file] ?? null;
const GUIDE = 'The export formats:\n- csv\n- json, with every field\n  quoted\n';
const one = (contains, over = {}) => ({ name: 'formats-listed', doc: { file: 'docs/guide.md', contains }, criterion: 'ch:4', ...over });

describe('checkDocs', () => {
  test('every text in the head file: met, with the criterion first and how many the base already had', () => {
    const [r] = checkDocs({ entries: [one(['json', 'csv'])], head: HEAD, base: BASE, read: reader({ [HEAD]: { 'docs/guide.md': GUIDE }, [BASE]: { 'docs/guide.md': '- csv\n' } }) });
    assert.equal(r.id, 'exp:formats-listed');
    assert.equal(r.result, 'met');
    assert.equal(r.detail, `ch:4 · doc docs/guide.md: 2 of 2 text(s) found at head ${'h'.repeat(12)} · base: 1 of 2 already there`);
  });

  test('a text wrapped over lines still matches; /re/flags is a regex; a single text needs no list', () => {
    const read = reader({ [HEAD]: { 'docs/guide.md': GUIDE } });
    assert.equal(checkDocs({ entries: [one('every field quoted')], head: HEAD, read })[0].result, 'met');
    assert.equal(checkDocs({ entries: [one('/JSON/i')], head: HEAD, read })[0].result, 'met');
    assert.equal(checkDocs({ entries: [one('/JSON/')], head: HEAD, read })[0].result, 'NOT MET');
  });

  test('a text missing at head is NOT MET and names the first missing one', () => {
    const [r] = checkDocs({ entries: [one(['csv', 'xml', 'yaml'])], head: HEAD, base: BASE, read: reader({ [HEAD]: { 'docs/guide.md': GUIDE } }) });
    assert.equal(r.result, 'NOT MET');
    assert.equal(r.why, `missing at head ${'h'.repeat(12)}: "xml" (+1 more) · base: no such file (new with this PR)`);
    assert.deepEqual([r.found, r.missing], [['csv'], ['xml', 'yaml']]);
  });

  test('the file gone at head but on base is NOT MET; in neither commit it is unverifiable (check the path)', () => {
    const gone = checkDocs({ entries: [one('csv')], head: HEAD, base: BASE, read: reader({ [BASE]: { 'docs/guide.md': GUIDE } }) })[0];
    assert.deepEqual([gone.result, gone.why], ['NOT MET', 'docs/guide.md is gone at head (it is on base)']);
    const none = checkDocs({ entries: [one('csv')], head: HEAD, base: BASE, read: reader({}) })[0];
    assert.deepEqual([none.result, none.why], ['unverifiable', `docs/guide.md is in neither head ${'h'.repeat(12)} nor base ${'b'.repeat(12)}: check the path`]);
  });

  test('a bad entry is unverifiable with the problem, and nothing is read for it', () => {
    let reads = 0;
    const [r] = checkDocs({ entries: [{ name: 'x', doc: { file: '../secrets', contains: 'a' } }], head: HEAD, read: () => { reads += 1; return ''; } });
    assert.deepEqual([r.result, r.why, reads], ['unverifiable', 'not run: doc.file must be relative to the repo root', 0]);
  });

  test('docProblem, docEntries and docExpectations', () => {
    assert.equal(docProblem(one('a')), null);
    assert.equal(docProblem({ doc: { file: 'a', contains: 'b' } }), 'no name');
    assert.equal(docProblem({ name: 'n', doc: 'a.md' }), 'doc must be { file, contains }');
    assert.equal(docProblem({ name: 'n', doc: { contains: 'b' } }), 'doc.file missing');
    assert.equal(docProblem({ name: 'n', doc: { file: '/etc/x', contains: 'b' } }), 'doc.file must be relative to the repo root');
    assert.equal(docProblem({ name: 'n', doc: { file: 'a', contains: [] } }), 'doc.contains missing');
    assert.match(docProblem({ name: 'n', doc: { file: 'a', contains: '/(/' } }), /^doc\.contains: /);
    assert.deepEqual(docEntries([one('a'), { name: 't', text: 'x' }, null]).map((e) => e.name), ['formats-listed']);
    assert.deepEqual(docEntries('nope'), []);
    const recs = checkDocs({ entries: [one('csv')], head: HEAD, read: reader({ [HEAD]: { 'docs/guide.md': GUIDE } }) });
    assert.deepEqual(docExpectations(recs), [{ name: 'formats-listed', result: 'met', detail: recs[0].detail }]);
  });

  test('compare leaves a doc expectation alone (n/a)', () => {
    const cv = compareViewport({ before: { records: {}, trees: {} }, after: { records: {}, trees: {} }, viewport: 'desktop', expectations: [one('csv')] });
    assert.equal(cv.expectations[0].result, 'n/a');
  });
});

// ── the run reads the commits, not the checkout ────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}
function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function tmpDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

// main has docs/guide.md listing csv; feat/formats adds json to it.
function makeRepo() {
  const dir = tmpDir('mfqa-docs-repo-');
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  write(dir, 'qa/map/app.json', '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
  write(dir, 'docs/guide.md', '- csv\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'one'], dir);
  git(['checkout', '-q', '-b', 'feat/formats'], dir);
  write(dir, 'docs/guide.md', '- csv\n- json\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'two'], dir);
  return dir;
}

function fakeDeps() {
  const side = { viewports: [{ viewport: 'desktop', captured: [], failed: [], notRun: [], warnings: [] }], clock: { clock: null, why: '' }, mapErrors: [], ms: 1 };
  return {
    async up(req) {
      return { name: `qa-${req.at.slice(0, 10)}`, slug: 'qa', dir: tmpDir('mfqa-sbx-'), port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null, sha: req.at };
    },
    down: async (req) => ({ name: req.name, warnings: [] }),
    captureSide: async (req) => { fs.mkdirSync(req.out, { recursive: true }); return structuredClone(side); },
    compare: async (req) => { fs.mkdirSync(req.out, { recursive: true }); return { exit: 0, viewports: [{ viewport: 'desktop', exit: 0, pairs: [], expectations: [], unexpected: [], overflow: [], inconclusive: [], eyes: [], standing: { checks: 0, tour: 0, console: 0 } }] }; },
    sleep: async () => {},
    now: () => new Date('2026-11-10T10:00:00Z'),
    runVerb: async () => ({ code: null, stdout: '', stderr: '', json: null, notRun: 'NOT RUN: none' }),
    mutate: async (req) => ({ selected: 0, result: { mode: req.mode, file: null, run: 0, killed: 0, survived: [], stale: [], notJudged: [], suites: {}, errors: [] } }),
  };
}

const PROFILE = { map: 'qa/map', seedNames: 'qa/seed.json', base: 'sandbox', viewports: { desktop: [1440, 900] }, routes: { enabled: false }, sandbox: { max: 3 }, run: { cacheKeep: 5 } };

describe('runQa', () => {
  test('a doc expectation is read from the head commit, becomes a criterion, and a missing text is exit 1', async () => {
    const repo = makeRepo();
    write(repo, 'qa/feat-formats/expectations.json', JSON.stringify([
      { name: 'json-listed', doc: { file: 'docs/guide.md', contains: ['json'] }, criterion: 'ch:24' },
      { name: 'xml-listed', doc: { file: 'docs/guide.md', contains: 'xml' } },
    ]));
    // the checkout says xml too, uncommitted: the run reads the commit, not the checkout
    write(repo, 'docs/guide.md', '- csv\n- json\n- xml\n');
    const run = await runQa({ mainRoot: repo, repoRoot: repo, profile: PROFILE, log: () => {}, mutants: 'none' }, fakeDeps());
    assert.deepEqual(run.docs.map((d) => [d.name, d.result]), [['json-listed', 'met'], ['xml-listed', 'NOT MET']]);
    assert.match(run.docs[0].detail, /^ch:24 · doc docs\/guide\.md: 1 of 1 text\(s\) found at head [0-9a-f]{12} · base: none of them there \(new with this PR\)$/);
    assert.deepEqual(run.results.expectations.filter((e) => e.viewport === null).map((e) => [e.id, e.result]), [['exp:json-listed', 'met'], ['exp:xml-listed', 'NOT MET']]);
    assert.deepEqual(run.results.docs.map((d) => d.name), ['json-listed', 'xml-listed']);
    assert.equal(run.exit, 1);
    const d = draftVerdict(run.results);
    assert.deepEqual(d.criteria, { pass: 1, fail: 1, unverifiable: 0, blocked: 0, waived: 0 });
    const draft = fs.readFileSync(path.join(repo, 'qa', 'feat-formats', 'verdict.draft.md'), 'utf8');
    assert.match(draft, /^- \[exp:json-listed\] PASS — json-listed: ch:24 · doc docs\/guide\.md: /m);
  });

  test('no doc expectation: run.docs is [] and the exit is untouched', async () => {
    const repo = makeRepo();
    const run = await runQa({ mainRoot: repo, repoRoot: repo, profile: PROFILE, log: () => {}, mutants: 'none' }, fakeDeps());
    assert.deepEqual(run.docs, []);
    assert.equal(run.exit, 0);
  });
});
