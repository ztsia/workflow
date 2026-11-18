// The project's integration branch: what a PR is compared against when no --base / --at / --onto names one.
//
// baseCandidates(root) -> string[]   refs to try, in order:
//   1. qa.json `integrationBranch` (the checkout's qa.json, else the main tree's);
//   2. origin/HEAD's target; 3. main; 4. master.
//   A branch named by 1 is tried as origin/<name> first (the local branch may be old), then <name>.
//   origin/HEAD is often stale (an old `main` that nobody merges into), so it comes after the named branch.
// defaultBaseRef(root) -> { ref, sha } | null   the first candidate that resolves to a commit.
// defaultMergeBase(root, head = 'HEAD') -> string | null   merge-base of head and the first candidate that has one.
import fs from 'node:fs';
import path from 'node:path';
import { gitOne } from './util.mjs';
import { mainRoot } from './profile.mjs';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const named = (v) => (typeof v === 'string' && /^[A-Za-z0-9][\w./-]*$/.test(v) ? v : null);

export function baseCandidates(root) {
  let main = root;
  try { main = mainRoot(root); } catch { /* not a checkout: root alone */ }
  const dirs = [...new Set([root, main])];
  const first = (file, key) => dirs.map((d) => named(readJson(path.join(d, file))?.[key])).find(Boolean) ?? null;
  const out = [];
  const name = first('qa.json', 'integrationBranch');
  if (name) out.push(`origin/${name}`, name);
  const originHead = gitOne(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  out.push(...[originHead, 'main', 'master'].filter(Boolean));
  return [...new Set(out)];
}

const commit = (root, ref) => gitOne(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });

export function defaultBaseRef(root) {
  for (const ref of baseCandidates(root)) {
    const sha = commit(root, ref);
    if (sha) return { ref, sha };
  }
  return null;
}

export function defaultMergeBase(root, head = 'HEAD') {
  for (const ref of baseCandidates(root)) {
    const sha = commit(root, ref);
    const mb = sha ? gitOne(['merge-base', head, sha], { cwd: root }) : null;
    if (mb) return mb;
  }
  return null;
}
