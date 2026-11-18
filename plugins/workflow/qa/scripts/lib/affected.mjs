// Affected by default, full as a mode (decision 15; rework U4, design §7). `qa run` walks only the screens the PR
// affects: every new or changed map entry, every screen whose source
// files the diff touches, and every journey that passes through one of those. A screen whose sources are unknown is
// out of scope and listed to be mapped, never walked.
// `--full` walks the whole map and refreshes the recorded sources (sources.mjs). Pure apart from
// the injected git reader; no browser.
//
// CONTRACT (tests: test/affected.test.mjs — screens and flows built by hand; mapAt with a temp git repo)
//
//   mapAt({ repoRoot, sha, mapDir, seedNames, profile, git = util.git }) -> map | null
//     The screen map as it was at `sha`: every file under mapDir (relative to repoRoot) at that
//     commit (git ls-tree -r --name-only <sha> -- <mapDir>; git show <sha>:<file>), plus the seed
//     names file at that commit when it exists there, written into a fresh temp dir and read with
//     map.mjs loadMap({ root: tmp, profile: { ...profile, map: mapDir, seedNames } }); the temp dir is
//     removed before returning. No map files at sha -> null. A load error -> null (the caller then
//     treats every head screen as changed).
//
//   chainOf(screen, flows) -> [flow name]   every flow the screen walks, outermost first: screen.flow,
//     then (depth first, in step order) each { flow } step inside a flow's steps and inside
//     screen.steps; each name once; 'login:<role>' names are skipped; an unknown name is kept (and
//     not walked).
//
//   entryKey(screen, flows) -> string   JSON.stringify of { screen minus area/file/origin/sources,
//     flows: { name: flows[name]?.steps ?? null for name of chainOf(screen, flows) } } — two maps
//     agree on a screen when its key is equal.
//
//   affectedScreens({ head, base, changed, sources = {}, profile = {}, slug = null }) -> Affected
//     head/base: loadMap results (base may be null); changed: files the diff touches (repo-relative,
//     '/'-separated); sources: { screenName: [file] } recorded by the last full run.
//     SCOPE (rework U4, design §7, D32; tests: test/scope.test.mjs): a screen is affected by the FIRST of:
//       'everything: <file> changed'   a changed file is qa.json or the seed names file (profile.seedNames ??
//                                       'qa/seed.json'). A lockfile no longer is: it changes no screen by itself.
//       'in overlay'                    the entry is in the PR's overlay: head.overlay.screens (map.mjs OVERLAY) holds
//                                       its name, or its origin is 'verify:<slug>' (the verifier's entries for this PR)
//       'new entry'                     base is null or has no screen of that name   } the overlay is qa/ in the
//       'entry changed'                 entryKey differs between head and base       } branch: what it adds
//       'sources: <file>'               screen.sources (globs, util.glob) match a changed file (first one)
//       'source: <file>'                a changed file is in sources[screen.name] (first in changed order)
//       'journey through <name>'        the screen has record: true and some flow in its chain is also in the chain of
//                                       a screen already affected for one of the reasons above (the first, head order)
//     else it is not affected. A screen with no screen.sources and no sources[screen.name] that is not affected is OUT
//     OF SCOPE: never walked and never UNVERIFIABLE (only --full walks it), listed in mapThese so the prepare step or
//     the qa skill records its sources. ('no sources known = affected', decision 15, is gone.)
//     Affected = { names: [screen name] (head order), why: { name: reason }, total: head screen count,
//                  mapThese: [name] (out of scope for want of sources, head order, each once), unknown: mapThese.length,
//                  skipped: [name] (head screens not affected, mapThese included) }
//     changed empty -> only the overlay and entry reasons apply ('in overlay', 'new entry', 'entry changed').
//
//   newMapEntries(head, base) -> { screenName: 'map entry new' }   (NEW ON HEAD;
//     tests: test/new-on-head.test.mjs)
//     The head screens base has no entry of that name for, each name once, as affectedScreens' 'new
//     entry' decides it (no trigger file can override it). A changed entry is NOT listed: its
//     before/after diff is how a regression on an existing screen is caught. base null or
//     head === base -> {} (no base map to tell new from old).
//
//   prEntries(head, base, { slug }) -> [name]   (rework U5, the prepare check) the PR's own entries: the overlay's
//     (head.overlay.screens) when the head map has one; else (the overlay is qa/ in the branch) every head
//     screen that is new or changed against base (entryKey), and every one whose origin is 'verify:<slug>'. base null (the
//     base commit has no map: every entry is new) -> every head screen; base === head (both read the map on disk, so
//     nothing tells new from old) -> only the verifier's own. Head order, each name once.
//
//   onlyGlob(names) -> string   names joined with ',' for selectScreens({ only }); [] -> '' (the
//     caller checks names.length first: an empty affected set captures nothing).
//
// Example. head: candidates-list (flow open:candidates), candidate-detail (flow open:candidates,
// sources recorded ['src/features/candidates/Detail.tsx']), jobs-list (sources recorded
// ['src/features/jobs/List.tsx']); base identical; changed ['src/features/candidates/Detail.tsx'];
// candidates-list has no recorded sources ->
//   names ['candidate-detail'], why { 'candidate-detail': 'source: src/features/candidates/Detail.tsx' }, total 3,
//   mapThese ['candidates-list'], unknown 1, skipped ['candidates-list', 'jobs-list'].

//   UNMAPPED (decision 6, found by the RMS pilot; tests: test/affected.test.mjs 'unmapped'):
//     UI_EXT (exported, frozen) = ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.jinja', '.j2',
//       '.erb', '.cshtml', '.jsp', '.hbs'] (profile.affected?.ui replaces it when an array).
//     affectedScreens' Affected gains unmapped: [file] — the changed files whose extension is in
//     UI_EXT, that paths.mjs TEST_RE does not match, that are in no head screen's recorded sources
//     and match no head screen's declared `sources` glob, in changed order. [] when no head screen
//     has recorded or declared sources (then nothing is known: every screen is in mapThese instead).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMap } from './map.mjs';
import { TEST_RE } from './paths.mjs';
import { git as gitDefault, glob } from './util.mjs';

export const UI_EXT = Object.freeze(['.tsx', '.jsx', '.vue', '.svelte', '.html', '.jinja', '.j2', '.erb', '.cshtml', '.jsp', '.hbs']);
const LOGIN = 'login:';
const isLogin = (name) => typeof name === 'string' && name.startsWith(LOGIN);

export function mapAt({ repoRoot, sha, mapDir, seedNames, profile = {}, git = gitDefault }) {
  const listed = git(['ls-tree', '-r', '--name-only', sha, '--', mapDir], { cwd: repoRoot });
  if (!listed || listed.length === 0) return null;
  const show = (file) => {
    const lines = git(['show', `${sha}:${file}`], { cwd: repoRoot });
    return lines === null ? null : lines.join('\n');
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-mapat-'));
  try {
    const put = (file, text) => {
      const dest = path.join(tmp, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    };
    for (const file of listed) {
      const text = show(file);
      if (text === null) return null;
      put(file, text);
    }
    if (seedNames) {
      const text = show(seedNames);
      if (text !== null) put(seedNames, text);
    }
    return loadMap({ root: tmp, profile: { ...profile, map: mapDir, seedNames } });
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function chainOf(screen, flows) {
  const out = [];
  const seen = new Set();
  const visit = (name) => {
    if (typeof name !== 'string' || isLogin(name) || seen.has(name)) return;
    seen.add(name);
    out.push(name);
    const steps = Object.hasOwn(flows ?? {}, name) ? flows[name]?.steps : null;
    walk(steps);
  };
  const walk = (steps) => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) if (step && typeof step === 'object' && step.flow !== undefined) visit(step.flow);
  };
  visit(screen.flow);
  walk(screen.steps);
  return out;
}

export function entryKey(screen, flows) {
  const { area, file, origin, sources, ...rest } = screen;
  void area; void file; void origin; void sources;
  const walked = {};
  for (const name of chainOf(screen, flows)) walked[name] = (Object.hasOwn(flows ?? {}, name) ? flows[name]?.steps : null) ?? null;
  return JSON.stringify({ ...rest, flows: walked });
}

// Changed UI files (not tests) that no head screen records or declares: nothing walks them.
function unmappedOf(screens, changed, sources, profile, globsOf) {
  const exts = Array.isArray(profile?.affected?.ui) ? profile.affected.ui : UI_EXT;
  const globs = screens.flatMap(globsOf).map(glob);
  const recorded = new Set(screens.flatMap((s) => (Array.isArray(sources?.[s.name]) ? sources[s.name] : [])));
  if (globs.length === 0 && recorded.size === 0) return [];
  return changed.filter((f) => exts.some((e) => f.endsWith(e)) && !TEST_RE.test(f) && !recorded.has(f) && !globs.some((re) => re.test(f)));
}

export function affectedScreens({ head, base, changed = [], sources = {}, profile = {}, slug = null }) {
  const screens = head.screens ?? [];
  const headFlows = head.flows ?? {};
  const baseKeys = new Map(); // name -> Set of entry keys in the base
  for (const s of base?.screens ?? []) {
    if (!baseKeys.has(s.name)) baseKeys.set(s.name, new Set());
    baseKeys.get(s.name).add(entryKey(s, base.flows ?? {}));
  }

  const seedFile = profile.seedNames ?? 'qa/seed.json';
  const trigger = changed.find((f) => f === 'qa.json' || f === seedFile);
  const overlay = new Set(Array.isArray(head.overlay?.screens) ? head.overlay.screens : []);
  const own = typeof slug === 'string' && slug ? `verify:${slug}` : null;
  const globsOf = (s) => (Array.isArray(s.sources) ? s.sources.filter((g) => typeof g === 'string') : []);
  const recordedOf = (s) => (Array.isArray(sources?.[s.name]) ? sources[s.name] : []);
  const known = (s) => globsOf(s).length > 0 || recordedOf(s).length > 0;

  const reasonOf = (s) => {
    if (trigger !== undefined) return `everything: ${trigger} changed`;
    if (overlay.has(s.name) || (own !== null && s.origin === own)) return 'in overlay';
    if (!baseKeys.has(s.name)) return 'new entry';
    if (!baseKeys.get(s.name).has(entryKey(s, headFlows))) return 'entry changed';
    if (changed.length === 0) return null;
    const globs = globsOf(s).map(glob);
    const byGlob = changed.find((f) => globs.some((re) => re.test(f)));
    if (byGlob !== undefined) return `sources: ${byGlob}`;
    const recorded = new Set(recordedOf(s));
    const byRecord = changed.find((f) => recorded.has(f));
    if (byRecord !== undefined) return `source: ${byRecord}`;
    return null;
  };

  const reasons = screens.map(reasonOf);
  if (changed.length > 0) {
    const chains = screens.map((s) => new Set(chainOf(s, headFlows)));
    const pulled = [];
    for (const [i, s] of screens.entries()) {
      if (reasons[i] !== null || s.record !== true) continue;
      const j = screens.findIndex((_, k) => reasons[k] !== null && [...chains[k]].some((f) => chains[i].has(f)));
      if (j !== -1) pulled.push([i, `journey through ${screens[j].name}`]);
    }
    for (const [i, reason] of pulled) reasons[i] = reason;
  }

  const why = {};
  const names = [];
  const skipped = [];
  const mapThese = [];
  const unique = new Set();
  for (const [i, s] of screens.entries()) {
    if (reasons[i] === null || Object.hasOwn(why, s.name)) continue;
    why[s.name] = reasons[i];
    names.push(s.name);
  }
  for (const s of screens) {
    if (Object.hasOwn(why, s.name) || unique.has(s.name)) continue;
    unique.add(s.name);
    skipped.push(s.name);
    if (!screens.some((x) => x.name === s.name && known(x))) mapThese.push(s.name);
  }
  return { names, why, total: screens.length, mapThese, unknown: mapThese.length, skipped, unmapped: unmappedOf(screens, changed, sources, profile, globsOf) };
}

export function newMapEntries(head, base) {
  const out = {};
  if (!head || !base || head === base) return out;
  const names = new Set((base.screens ?? []).map((s) => s?.name));
  for (const s of head.screens ?? []) {
    if (typeof s?.name === 'string' && !names.has(s.name)) out[s.name] = 'map entry new';
  }
  return out;
}

export function prEntries(head, base, { slug = null } = {}) {
  if (!head) return [];
  const screens = head.screens ?? [];
  if (head.overlay) return [...new Set(head.overlay.screens ?? [])];
  const own = typeof slug === 'string' && slug ? `verify:${slug}` : null;
  const baseKeys = new Map();
  for (const s of (base && base !== head ? base.screens : null) ?? []) {
    if (!baseKeys.has(s.name)) baseKeys.set(s.name, new Set());
    baseKeys.get(s.name).add(entryKey(s, base.flows ?? {}));
  }
  const out = [];
  for (const s of screens) {
    if (typeof s?.name !== 'string' || out.includes(s.name)) continue;
    const mine = own !== null && s.origin === own;
    const changed = base === null || base === undefined ? true
      : base !== head && (!baseKeys.has(s.name) || !baseKeys.get(s.name).has(entryKey(s, head.flows ?? {})));
    if (mine || changed) out.push(s.name);
  }
  return out;
}

export function onlyGlob(names) {
  return names.join(',');
}
