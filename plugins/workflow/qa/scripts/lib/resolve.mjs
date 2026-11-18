// One command, no arguments (decision 22): what the qa skill works on, resolved from the repo,
// the open PR and the docs. Flags only override. Pure apart from the injected deps.
//
// CONTRACT (tests: test/resolve.test.mjs)
//
//   resolveTarget({ repoRoot, spec = null, onto = null, slug = null }, deps) -> Target
//     deps: { git(args) -> string | null   (trimmed stdout, null on failure; run in repoRoot)
//             gh(args)  -> string | null   (trimmed stdout, null when gh is missing or fails)
//             exists(relPath) -> bool, list(relDir) -> [relPath]  (every file under relDir, recursive,
//             '/'-separated, relative to repoRoot; [] when absent), read(relPath) -> string,
//             integration() -> string | null   (optional: qa.json's `integrationBranch`) }
//     Target = { slug, branch, head, pr, base, spec, verification, warnings }
//       branch = git(['rev-parse','--abbrev-ref','HEAD']); head = git(['rev-parse','HEAD'])
//       slug   = slug ?? run.mjs slugOf(branch, head)   (feat/x -> feat-x; B01/library -> B01-library)
//       pr     = JSON.parse(gh(['pr','view','--json','number,baseRefName,body,url'])) as
//                { number, base: baseRefName, body, url }, or null when gh returns null or bad JSON
//       base   = { ref, from }, the first that applies:
//                  onto                    -> { ref: onto, from: 'flag' }
//                  integration()           -> { ref: <qa.json integrationBranch>, from: 'qa.json' }
//                  git(['symbolic-ref','--short','refs/remotes/origin/HEAD']) = 'origin/<b>' -> { ref: '<b>', from: 'default' }
//                  main, else master (the first the repo has, as <ref> or origin/<ref>)  -> { ref, from: 'default' }
//                  otherwise               -> { ref: 'main', from: 'default' }
//                and base.sha = the merge-base the run diffs against: of git(['merge-base','HEAD','origin/' + ref]) and
//                git(['merge-base','HEAD', ref]), the newer (when both answer and differ: the local one only when the
//                origin one is its ancestor); else whichever answers; else null (a ref the repo does not have).
//                (Never the ref's tip: a moved base would bring other people's work into the diff.)
//       spec   = { path, from } | null, the first that applies:
//                  spec given              -> { path: spec, from: 'flag' }   (warning when !exists(spec): 'spec <spec> does not exist')
//                  branch '<label>/<name>' and exists docs/briefs/<label>-<name>.md -> { path, from: 'brief' }
//                  list('docs') entries that are a spec (a basename matching /spec.*\.md$/i) or a brief (a .md under a
//                    briefs/ folder) and whose path, lower-cased, contains slug lower-cased -> the first in sorted
//                    order, { path, from: 'docs' }; more than one -> warning 'spec: <n> candidates, took <path>'
//                  pr with a body that is non-empty after trim -> { path: 'qa/<slug>/spec.md',
//                    from: 'pr', body: '<!-- from <pr.url> -->\n\n' + body.trim() + '\n' }
//                    (the caller writes body to path; resolveTarget writes nothing)
//                  otherwise               -> null  (the skill asks its one question)
//       verification = 'qa/<slug>'   (the folder of the slug's verdict; the field keeps its name)
//       warnings = [string] in the order raised

import path from 'node:path';
import { slugOf } from './run.mjs';

function readPr(gh) {
  const out = gh(['pr', 'view', '--json', 'number,baseRefName,body,url']);
  if (out == null) return null;
  try {
    const j = JSON.parse(out);
    if (!j || typeof j !== 'object' || typeof j.number !== 'number') return null;
    return { number: j.number, base: j.baseRefName, body: j.body ?? '', url: j.url };
  } catch {
    return null;
  }
}

export function resolveTarget({ repoRoot, spec = null, onto = null, slug = null }, deps) {
  void repoRoot;
  const { git, gh, exists, list } = deps;
  const warnings = [];
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  const useSlug = slug ?? slugOf(branch, head);
  const pr = readPr(gh);

  let base;
  const named = deps.integration?.() ?? null;
  if (onto) base = { ref: onto, from: 'flag' };
  else if (named) base = { ref: named, from: 'qa.json' };
  else {
    const origin = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const has = (ref) => git(['rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`]) != null || git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) != null;
    const ref = origin?.startsWith('origin/') && origin.length > 7 ? origin.slice(7) : ['main', 'master'].find(has) ?? 'main';
    base = { ref, from: 'default' };
  }
  // The newer of the two merge-bases: a local base branch is often behind origin, and a head that merged the newer
  // origin tip would otherwise diff against the old one and carry other PRs' files into the run (1.0.3).
  const viaOrigin = git(['merge-base', 'HEAD', `origin/${base.ref}`]);
  const viaLocal = git(['merge-base', 'HEAD', base.ref]);
  base.sha = viaOrigin ?? viaLocal ?? null;
  if (viaOrigin && viaLocal && viaOrigin !== viaLocal) base.sha = git(['merge-base', viaOrigin, viaLocal]) === viaOrigin ? viaLocal : viaOrigin;

  let found = null;
  if (spec) {
    found = { path: spec, from: 'flag' };
    if (!exists(spec)) warnings.push(`spec ${spec} does not exist`);
  } else {
    const parts = /^([^/]+)\/([^/]+)$/.exec(String(branch ?? ''));
    const brief = parts ? `docs/briefs/${parts[1]}-${parts[2]}.md` : null;
    if (brief && exists(brief)) found = { path: brief, from: 'brief' };
    else {
      const needle = useSlug.toLowerCase();
      const isSpec = (p) => /spec.*\.md$/i.test(p.split('/').pop()) || (/\.md$/i.test(p) && /(^|\/)briefs\//i.test(p));
      const cands = list('docs')
        .filter((p) => isSpec(p) && p.toLowerCase().includes(needle))
        .sort();
      if (cands.length) {
        found = { path: cands[0], from: 'docs' };
        if (cands.length > 1) warnings.push(`spec: ${cands.length} candidates, took ${cands[0]}`);
      } else if (pr && String(pr.body ?? '').trim()) {
        found = { path: `qa/${useSlug}/spec.md`, from: 'pr', body: `<!-- from ${pr.url} -->\n\n${pr.body.trim()}\n` };
      }
    }
  }

  return { slug: useSlug, branch, head, pr, base, spec: found, verification: `qa/${useSlug}`, warnings };
}

// QA FILES (1.0.3; tests: test/resolve.test.mjs 'qaFilesOf'): where this checkout's map and seed names come from.
//   qaFilesOf({ root, main, profile, exists }) -> { map, seedNames, from, warnings }
//     map = <root>/<profile.map> when it exists; else <main>/<profile.map> when that exists (a worktree that lacks
//     the untracked QA files), with warning 'this checkout has no <profile.map>; the main tree's is used (<path>)'; else the
//     checkout's path as before. seedNames the same way (null when neither exists). from = 'checkout' | 'main tree'.
export function qaFilesOf({ root, main = root, profile = {}, exists }) {
  const mapRel = profile.map ?? 'qa/map';
  const seedRel = profile.seedNames ?? 'qa/seed.json';
  const warnings = [];
  const pick = (rel) => {
    const own = path.resolve(root, rel);
    if (exists(own) || !main || main === root) return { file: own, from: 'checkout', ok: exists(own) };
    const alt = path.resolve(main, rel);
    return exists(alt) ? { file: alt, from: 'main tree', ok: true } : { file: own, from: 'checkout', ok: false };
  };
  const m = pick(mapRel);
  if (m.from === 'main tree') warnings.push(`this checkout has no ${mapRel}; the main tree's is used (${m.file})`);
  const sd = pick(seedRel);
  return { map: m.file, seedNames: sd.ok ? sd.file : null, from: m.from, warnings };
}
