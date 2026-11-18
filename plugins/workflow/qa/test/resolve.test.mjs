// Contract tests for scripts/lib/resolve.mjs: resolveTarget's base branch, spec and slug rules.
// The contract is the comment block at the top of that file. Every git, gh and file-system call is
// an injected fake (no repo, no gh), so each test states the repo it means. Until resolve.mjs is
// built, every test fails with 'not built: resolveTarget'.
import assert from 'node:assert/strict';
import test from 'node:test';
import { qaFilesOf, resolveTarget } from '../scripts/lib/resolve.mjs';

const REPO = '/repo';
const HEAD = 'h'.repeat(40);
const PR_URL = 'https://github.com/o/r/pull/42';

// Fake deps. `files` maps repo-relative paths to contents (insertion order is what list() returns,
// so a test that needs sorting inserts out of order). `gh` is the JSON text gh prints, or null.
function fakeDeps({ branch = 'feat/x', originHead = null, gh = null, files = {} } = {}) {
  const gitOut = {
    'rev-parse --abbrev-ref HEAD': branch,
    'rev-parse HEAD': HEAD,
    'symbolic-ref --short refs/remotes/origin/HEAD': originHead,
  };
  const names = Object.keys(files);
  return {
    git: (args) => gitOut[args.join(' ')] ?? null,
    gh: (args) => (args[0] === 'pr' ? gh : null),
    exists: (p) => Object.hasOwn(files, p),
    list: (dir) => names.filter((p) => p.startsWith(`${dir}/`)),
    read: (p) => files[p],
  };
}

function prJson(over = {}) {
  return JSON.stringify({ number: 42, baseRefName: 'trunk', body: '', url: PR_URL, ...over });
}

function resolve(opts, deps) {
  return resolveTarget({ repoRoot: REPO, ...opts }, deps);
}

// ── the target's own fields ───────────────────────────────────────────────────

test('R1 branch, head, slug and verification come from git and the branch name', () => {
  const t = resolve({}, fakeDeps({ branch: 'feat/x' }));
  assert.equal(t.branch, 'feat/x');
  assert.equal(t.head, HEAD);
  assert.equal(t.slug, 'feat-x');
  assert.equal(t.verification, 'qa/feat-x');
  assert.deepEqual(t.warnings, []);
});

test('R1 the slug rule turns every character outside [A-Za-z0-9._-] into "-"', () => {
  assert.equal(resolve({}, fakeDeps({ branch: 'feat/x+y' })).slug, 'feat-x-y');
});

test('R1 a detached HEAD gives the slug head-<sha10>', () => {
  assert.equal(resolve({}, fakeDeps({ branch: 'HEAD' })).slug, `head-${'h'.repeat(10)}`);
});

test('R1 a slug override replaces the branch slug in the target and in the spec lookup', () => {
  const t = resolve({ slug: 'mine' }, fakeDeps({ files: { 'docs/specs/mine/spec.md': '# spec' } }));
  assert.equal(t.slug, 'mine');
  assert.equal(t.verification, 'qa/mine');
  assert.deepEqual(t.spec, { path: 'docs/specs/mine/spec.md', from: 'docs' });
});

// ── base ──────────────────────────────────────────────────────────────────────

test('R2 base: the onto flag wins over everything', () => {
  const t = resolve({ onto: 'release/1' }, fakeDeps({ originHead: 'origin/develop', gh: prJson() }));
  assert.deepEqual(t.base, { ref: 'release/1', from: 'flag', sha: null });
});

test('R2 base: qa.json integrationBranch comes before origin/HEAD, and the PR\'s own base is never used', () => {
  const t = resolve({}, { ...fakeDeps({ originHead: 'origin/develop', gh: prJson({ baseRefName: 'trunk' }) }), integration: () => 'staging' });
  assert.deepEqual(t.base, { ref: 'staging', from: 'qa.json', sha: null });
  assert.deepEqual(resolve({}, fakeDeps({ originHead: 'origin/develop', gh: prJson({ baseRefName: 'trunk' }) })).base, { ref: 'develop', from: 'default', sha: null });
});

test('R2 base: origin/HEAD gives its branch with from "default"', () => {
  const t = resolve({}, fakeDeps({ originHead: 'origin/develop', gh: null }));
  assert.deepEqual(t.base, { ref: 'develop', from: 'default', sha: null });
});

test('R2 base: otherwise main with from "default"', () => {
  const t = resolve({}, fakeDeps({ originHead: null, gh: null }));
  assert.deepEqual(t.base, { ref: 'main', from: 'default', sha: null });
});

// ── pr ────────────────────────────────────────────────────────────────────────

test('R3 pr is the gh JSON as { number, base, body, url }', () => {
  const t = resolve({}, fakeDeps({ gh: prJson({ body: 'Goal: x' }) }));
  assert.deepEqual(t.pr, { number: 42, base: 'trunk', body: 'Goal: x', url: PR_URL });
});

test('R3 pr is null when gh returns null (missing or failing)', () => {
  assert.equal(resolve({}, fakeDeps({ gh: null })).pr, null);
});

test('R3 pr is null when gh prints bad JSON, without throwing', () => {
  assert.equal(resolve({}, fakeDeps({ gh: 'not json {' })).pr, null);
});

// ── spec ──────────────────────────────────────────────────────────────────────

test('R4 spec flag: the given path with from "flag", and a warning when it does not exist', () => {
  const t = resolve({ spec: 'docs/x/spec.md' }, fakeDeps({ files: { 'docs/x/spec.md': '# x' } }));
  assert.deepEqual(t.spec, { path: 'docs/x/spec.md', from: 'flag' });
  assert.deepEqual(t.warnings, []);

  const missing = resolve({ spec: 'docs/none.md' }, fakeDeps());
  assert.deepEqual(missing.spec, { path: 'docs/none.md', from: 'flag' });
  assert.deepEqual(missing.warnings, ['spec docs/none.md does not exist']);
});

test('R4 spec flag wins over the brief, the docs search and the PR body', () => {
  const t = resolve({ spec: 'docs/x/spec.md' }, fakeDeps({
    gh: prJson({ body: 'Goal' }),
    files: { 'docs/x/spec.md': '# x', 'docs/specs/feat-x/spec.md': '# docs' },
  }));
  assert.deepEqual(t.spec, { path: 'docs/x/spec.md', from: 'flag' });
});

test('R4 spec brief: docs/briefs/<label>-<name>.md for a branch <label>/<name> comes before the docs search', () => {
  const t = resolve({}, fakeDeps({
    branch: 'B01/library',
    gh: prJson(),
    files: { 'docs/briefs/B01-library.md': '#', 'docs/specs/B01-library/spec.md': '#' },
  }));
  assert.deepEqual(t.spec, { path: 'docs/briefs/B01-library.md', from: 'brief' });
});

test('R4 spec docs: a spec folder named for the slug is found, with no PR needed', () => {
  const t = resolve({}, fakeDeps({ gh: null, files: { 'docs/specs/feat-x/spec.md': '#' } }));
  assert.deepEqual(t.spec, { path: 'docs/specs/feat-x/spec.md', from: 'docs' });
});

test('R4 spec docs: a brief under a briefs/ folder naming the slug counts, a PR number path does not', () => {
  const t = resolve({}, fakeDeps({ gh: prJson(), files: { 'docs/briefs/old/feat-x-notes.md': '#', 'docs/specs/42/spec.md': '#' } }));
  assert.deepEqual(t.spec, { path: 'docs/briefs/old/feat-x-notes.md', from: 'docs' });
  assert.equal(resolve({}, fakeDeps({ gh: prJson(), files: { 'docs/specs/42/spec.md': '#' } })).spec, null);
});

test('R4 spec docs: a spec file under docs whose path contains the slug, sorted first wins, with a warning when several', () => {
  const t = resolve({}, fakeDeps({
    files: {
      'docs/notes/feat-x-spec-2.md': '#',
      'docs/unrelated-spec.md': '#',
      'docs/feat-x-notes.md': '#',
      'docs/feat-x-spec.md': '#',
    },
  }));
  assert.deepEqual(t.spec, { path: 'docs/feat-x-spec.md', from: 'docs' });
  assert.deepEqual(t.warnings, ['spec: 2 candidates, took docs/feat-x-spec.md']);
});

test('R4 spec docs: one candidate gives no warning, and the match ignores case', () => {
  const t = resolve({}, fakeDeps({ files: { 'docs/Feat-X-Spec.md': '#' } }));
  assert.deepEqual(t.spec, { path: 'docs/Feat-X-Spec.md', from: 'docs' });
  assert.deepEqual(t.warnings, []);
});

test('R4 spec pr: a PR body with text becomes the spec, with the exact header and trimmed body', () => {
  const t = resolve({}, fakeDeps({ gh: prJson({ body: '\n  Goal: archive a record.\n\n' }) }));
  assert.deepEqual(t.spec, {
    path: 'qa/feat-x/spec.md',
    from: 'pr',
    body: `<!-- from ${PR_URL} -->\n\nGoal: archive a record.\n`,
  });
});

test('R4 spec pr: a PR body that is only whitespace gives no spec', () => {
  assert.equal(resolve({}, fakeDeps({ gh: prJson({ body: '   \n \t\n' }) })).spec, null);
});

test('R4 spec pr: the docs search comes before the PR body', () => {
  const t = resolve({}, fakeDeps({ gh: prJson({ body: 'Goal' }), files: { 'docs/feat-x-spec.md': '#' } }));
  assert.deepEqual(t.spec, { path: 'docs/feat-x-spec.md', from: 'docs' });
});

test('R4 spec null: nothing found, no flag, no PR body', () => {
  const t = resolve({}, fakeDeps({ gh: null, files: { 'docs/unrelated.md': '#' } }));
  assert.equal(t.spec, null);
  assert.deepEqual(t.warnings, []);
});

// ── base.sha: the merge-base the run diffs against ────────────────────────────

// fakeDeps plus a git that answers `merge-base HEAD <ref>` from mb (ref -> sha; a ref absent from mb fails).
function withMergeBase(deps, mb) {
  const git = deps.git;
  return { ...deps, git: (args) => (args[0] === 'merge-base' ? (mb[args[2]] ?? null) : git(args)) };
}

test('R2 base.sha: the merge-base of HEAD and the base ref', () => {
  const deps = withMergeBase(fakeDeps(), { dev: 'm1' });
  assert.equal(resolve({ onto: 'dev' }, deps).base.sha, 'm1');
});

test('R2 base.sha: when the merge-base with the ref fails, the merge-base with origin/<ref>', () => {
  const deps = withMergeBase(fakeDeps(), { 'origin/dev': 'm2' });
  assert.equal(resolve({ onto: 'dev' }, deps).base.sha, 'm2');
});

test('R2 base.sha: a local base branch behind origin loses to origin/<ref> (1.0.3)', () => {
  // HEAD merged the newer origin tip; merge-base(new, old) = old, so old is behind.
  const deps = withMergeBase(fakeDeps(), { dev: 'old', 'origin/dev': 'new', old: 'old' });
  assert.equal(resolve({ onto: 'dev' }, deps).base.sha, 'new');
});

test('R2 base.sha: a local base branch ahead of origin wins (1.0.3)', () => {
  const deps = withMergeBase(fakeDeps(), { dev: 'ahead', 'origin/dev': 'behind', ahead: 'behind' });
  assert.equal(resolve({ onto: 'dev' }, deps).base.sha, 'ahead');
});

test('R2 base.sha: null when neither merge-base answers', () => {
  const deps = withMergeBase(fakeDeps(), {});
  assert.equal(resolve({ onto: 'dev' }, deps).base.sha, null);
});

// ── qaFilesOf: the checkout's QA files, else the main tree's (1.0.3) ─────────────────────────

test('qaFilesOf: a worktree with no qa/map reads the main tree map and warns', () => {
  const have = new Set(['/main/qa/map', '/main/qa/seed.json']);
  const r = qaFilesOf({ root: '/wt', main: '/main', profile: {}, exists: (f) => have.has(f), read: () => null });
  assert.deepEqual([r.map, r.seedNames, r.from], ['/main/qa/map', '/main/qa/seed.json', 'main tree']);
  assert.match(r.warnings[0], /this checkout has no qa\/map; the main tree's is used/);
});

test("qaFilesOf: the checkout's own map wins, with no warning", () => {
  const have = new Set(['/wt/qa/map', '/main/qa/map']);
  const r = qaFilesOf({ root: '/wt', main: '/main', profile: {}, exists: (f) => have.has(f), read: () => null });
  assert.deepEqual([r.map, r.seedNames, r.from, r.warnings.length], ['/wt/qa/map', null, 'checkout', 0]);
});
