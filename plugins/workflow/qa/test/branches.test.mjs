// branches.mjs: the default base is the project's integration branch, not a stale origin/HEAD. In crm, origin/HEAD
// was an old main; ready brought its sandbox up there and 4 of 6 checks never ran (2026-11-12).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { baseCandidates, defaultBaseRef, defaultMergeBase } from '../scripts/lib/branches.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();

// origin has main (its HEAD, old) and staging/master (newer); the clone sits on a feature branch off staging/master.
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-branches-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const seed = path.join(base, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a'), '1');
  git(seed, 'add', 'a'); git(seed, 'commit', '-qm', 'old main');
  git(seed, 'checkout', '-qb', 'staging/master');
  fs.writeFileSync(path.join(seed, 'a'), '2');
  git(seed, 'commit', '-qam', 'staging');
  git(seed, 'checkout', '-q', 'main');
  const clone = path.join(base, 'clone');
  git(base, 'clone', '-q', seed, clone);
  git(clone, 'checkout', '-qb', 'feat/x', 'origin/staging/master');
  fs.writeFileSync(path.join(clone, 'b'), 'x');
  git(clone, 'add', 'b'); git(clone, 'commit', '-qm', 'feature');
  return { clone, main: git(clone, 'rev-parse', 'origin/main'), staging: git(clone, 'rev-parse', 'origin/staging/master') };
}

test('no integrationBranch anywhere: origin/HEAD, then main, then master', (t) => {
  const f = fixture(t);
  assert.deepEqual(baseCandidates(f.clone), ['origin/main', 'main', 'master']);
  assert.deepEqual(defaultBaseRef(f.clone), { ref: 'origin/main', sha: f.main });
});

test('qa.json integrationBranch comes before a stale origin/HEAD', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.clone, 'qa.json'), JSON.stringify({ integrationBranch: 'staging/master' }));
  assert.deepEqual(defaultBaseRef(f.clone), { ref: 'origin/staging/master', sha: f.staging });
  assert.equal(defaultMergeBase(f.clone), f.staging, 'the merge-base is taken against it too');
});

test('a named branch that does not resolve falls through to origin/HEAD', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.clone, 'qa.json'), JSON.stringify({ integrationBranch: 'gone' }));
  assert.equal(defaultBaseRef(f.clone).ref, 'origin/main');
});

test('a linked worktree reads the main tree\'s qa.json', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.clone, 'qa.json'), JSON.stringify({ integrationBranch: 'staging/master' }));
  git(f.clone, 'add', 'qa.json'); git(f.clone, 'commit', '-qm', 'qa.json');
  const wt = path.join(path.dirname(f.clone), 'wt');
  git(f.clone, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  fs.rmSync(path.join(wt, 'qa.json'));
  assert.equal(defaultBaseRef(wt).ref, 'origin/staging/master');
});
