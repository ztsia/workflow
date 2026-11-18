// `qa ready` (0.5.0): is this project ready for a real verify? Every gap a real PR's verify used to find mid-run
// (35–60 min and a model's spend each) is looked for here, once, on a sandbox of the integration branch: the stack
// verbs, the files that must be executable, map coverage of the app's pages, a seed that fills every mapped screen,
// a seed that is the same twice, and test suites whose output names their tests. Each item is PASS or FAIL with the
// reason and the one action that fixes it. The answer is written to qa/ready.json, which `qa run` reads to warn
// (never block) when the project is not proven ready. Zero model calls.
//
// CONTRACT (tests: test/ready.test.mjs — every check on fixtures; checkReady with injected deps; one end-to-end
// `qa ready` on a temp git repo with a static page served by a fake project adapter)
//
//   READY_FILE = 'qa/ready.json'; READY_VERBS = ['setup', 'up', 'seed', 'build', 'serve', 'test']
//   Item = { id, status: 'PASS' | 'FAIL', reason, fix: string | null }
//   Check = { id, title, status (FAIL when any item is), summary, items: [Item] }
//
//   verbsCheck({ profile, mainRoot }) -> Check 'verbs'
//     one item per READY_VERBS verb, id 'verb:<v>': served (qa.json command or adapter) -> PASS; NOT RUN -> FAIL
//     with the reason, fix: name an adapter that has it, or a command in qa.json stack.<v> (`echo 'skip: <why>'`
//     when the app needs none — the adapter convention for "nothing to do").
//
//   execTargets({ profile, mainRoot, suites = {} }) -> [{ rel, abs, why }]   files that must be executable:
//     each top-level file of a named project adapter (<mainRoot>/qa/adapters/<name>/) that adapter.json lists as a
//     verb or that is named after a verb; the first word of each qa.json stack.<verb> command and of each suite
//     (a string's first word, an argv's argv[0]) when it is a path (has a '/') to a file under mainRoot.
//   execCheck({ targets, fix = false, gitMode = (rel) => '100755' | '100644' | null }) -> Check 'exec'
//     a target without an exec bit: fix -> chmod u+x,g+x,o+x (by the read bits) and PASS 'made executable (--fix)';
//     else FAIL 'exec bit missing' with fix 'chmod +x <rel> (or qa ready --fix)'. A target tracked in git as
//     100644 -> FAIL 'committed without the exec bit: a fresh checkout cannot run it', fix 'git update-index
//     --chmod=+x <rel>, then commit' (--fix never changes the index). Nothing to check -> one PASS item 'exec:none'.
//
//   pagePattern(path) -> RegExp   ':name' one segment, a trailing '/*' any rest, a trailing '/' optional.
//   urlPath(url) -> pathname of a goto or capture url ('/#/x' hash routes -> '/x'); null when unreadable.
//   coverageCheck({ table: loadPages(), map: loadMap(), profile, urls = {} }) -> Check 'map'
//     urls: { screen: [pathname] } the walk captured. FAIL items: 'map:empty' (no screen), 'map:example'
//     (qa/map/example.json is still there), 'map:check' (validateMap errors, first 10), 'pages:none' (no table or
//     no pages: coverage cannot be measured), 'pages:<n>' (a table page error), 'page:<path>' (no map entry
//     reaches it), 'page:<path>' (screens names an entry the map lacks). A page is reached when one of its
//     `screens` is in the map, an expanded goto of a screen matches it, or a capture of the walk was taken on it.
//     A page with skip -> a PASS item 'page:<path>' 'skipped: <why>'. Screens with origin 'verify:*' are not
//     counted (a PR's sad paths). summary '<m> of <n> pages mapped · <s> skipped'.
//
//   EMPTY_TEXT (exported): the empty-state phrases looked for, as regex sources ("No calls yet", "Nothing to show",
//     "No results found", "… is empty", "No data"). qa.json ready.emptyText adds the project's own.
//   emptyState(tree, { expectData, emptyOk, extra = [] }) -> null | { line, why }
//     emptyOk -> null. expectData ($seed.* tokens resolved by checkReady from the seed names) given: a tree line whose text (tree.mjs treeText) contains it (or matches
//     /re/flags) -> null, else { line: null, why: 'expected data "<x>" is not on the screen' }. Else the first line
//     of 80 characters or fewer whose text matches an EMPTY_TEXT or extra phrase -> { line, why: 'shows an empty
//     state: "<text>"' }; none -> null.
//   walkCheck({ side, out, screens, profile }) -> { check: Check 'walk', urls }
//     side = captureSide's SideResult; screens = { name: map screen }. FAIL 'walk:<vp>/<screen>' per failed or
//     NOT RUN screen (MAP ERROR included); FAIL 'empty:<vp>/<key>' per capture emptyState flags (records read from
//     <out>/<vp>/<key>.json and its .aria.yml). urls = the pathnames each screen was captured on.
//
//   determinismCheck(compareResult, { screens }) -> Check 'determinism'
//     compareResult null -> handled by the caller. Each pair not 'same', or 'same' with pixel.changed -> FAIL
//     'det:<vp>/<key>' (the first changed tree line, or the pixel ratio, or the status); no pair at all -> FAIL
//     'det:none'. All same -> one PASS 'det:sample' '<n> screen(s) identical on two fresh seeds: <names>'.
//
//   suiteItem(id, suite, outcome, { registry, ref }) -> Item 'suite:<id>'   (registry = the suites file named in fixes)
//     outcome = { command, runner, code, output, report, timedOut, notRun, log }. parseTests (tests.mjs) of report and
//     output. notRun -> FAIL. Named tests: a failed one -> FAIL '<f> of <n> failed: <names>'; a timeout -> FAIL;
//     exit non-zero -> FAIL; else PASS '<n> named tests passed (<source>)'. 0 tests -> FAIL 'ran no test'. Output
//     that names no test -> FAIL 'the output names no test (<source>)' with the reporter to add: for a known runner
//     the report qa asked for; for test:<level> the verb must print TAP or write JUnit XML / Jest JSON to
//     $QA_TEST_REPORT; for any other command call the runner directly, or write that report to $QA_TEST_REPORT.
//   suitesCheck({ loaded: suites.mjs loadSuites() (or loadMutants()), outcomes: { id: outcome } | null, why }) -> Check
//     'suites'. No suites file or no suite -> FAIL 'suites:none' (fix: qa/suites.json { "suites": { … } }); each
//     load error -> FAIL 'registry:<n>'; outcomes null -> FAIL 'suite:<id>' 'not run: <why>' each; else suiteItem per
//     suite. Suites read from the old place (loaded.note) keep their items, and the summary ends ' · <note>'.
//     A suite that timed out: the fix names its own timeoutMs ({ "cmd": …, "timeoutMs": … } in the suites file).
//
//   readyInputs({ repoRoot, mainRoot, profile }) -> { profile, map, seed, suites, routes }   16-hex sha256 of qa.json,
//     the map dir (its *.sources.json and verify-*.json left out: a --full run or a verify plan never stales it),
//     the seed names file, the suites file (qa/suites.*, else the mutant registry that still holds them) and the
//     route table, each null when absent.
//   readiness({ repoRoot, mainRoot, profile, version, map = null }) -> { state: 'ready' | 'missing' | 'stale' | 'not ready',
//     why: [string], line: string | null, file }
//     missing/unreadable -> 'missing'; written by an older qa minor, or an input hash differs -> 'stale' (why names
//     them); ready false -> 'not ready' (why = its open item ids, up to 5 and '+<k> more'). Both stale and failing
//     -> 'not ready' with both in why. line = 'project not proven ready: <why joined by "; ">' unless 'ready'.
//     A project in suites mode (suitesmode.mjs suitesModeApplies: no map entries, no stack that serves) keeps its state, but
//     its why is 'no screens yet — qa ready applies once the map has entries' and its line 'project not proven ready:
//     no screens yet — qa ready applies once the map has entries'.
//
//   checkReady(opts, deps = {}) -> Promise<Report>
//     opts: { mainRoot, repoRoot, profile, at = null, sample = 3, fix = false, sandbox = true, log, now }
//     deps: { up, down, captureSide, compare, runSuite, list } (default: the real sandbox, run.mjs captureSide,
//     compare.mjs compare, the real suite runner, sandbox.list).
//     1. Static: verbsCheck, execTargets/execCheck (with fix), loadPages + loadMap of the checkout's disk.
//     2. sandbox false -> the seed, walk, determinism and suites checks are FAIL 'not run (--static)'; the file is
//        not written. Else base = at (rev-parse) or the integration branch's tip (branches.mjs: qa.json
//        integrationBranch, origin/HEAD's target, main, master).
//        Sandbox A up at base (seed on); blocked -> seed FAIL with the message, the rest FAIL 'not run'. A reused
//        sandbox (already up) -> seed and determinism FAIL 'sandbox <name> was already up: its seed did not run
//        now', fix 'qa sandbox down <name>, then qa ready'. On A: the sample screens (up to `sample`, evenly
//        spread over the walkable screens at the first viewport) captured into <W>/a, then every screen at every
//        viewport into <W>/walk, then each suite run once in A's worktree; A down. Sandbox B up at the same commit,
//        the sample into <W>/b, B down; compare(<W>/a, <W>/b) -> determinismCheck. W = <mainRoot>/qa-artifacts/ready.
//        The walk uses the checkout's map and seed names (map/seedNames absolute), checks and tour off.
//     3. coverageCheck again with the walk's urls. Report = { version: 1, ready, plugin, commit, ref, at (ISO),
//        inputs, checks: [verbs, exec, map, seed, walk, determinism, suites], open: [FAIL item ids], work: W }.
//        Unless static, written to <repoRoot>/qa/ready.json (2-space JSON + newline).
//   readyText(report) -> string   'READY' or 'NOT READY — <n> open', then per check '<PASS|FAIL> <id> — <summary>'
//     and under it '  FAIL <item id> — <reason>' + '    → <fix>' per FAIL item and '  pass <id> — <reason>' per
//     skipped page.
//
//   UPGRADE (from older QA files; tests: test/upgrade.test.mjs). What an older qa left in a project, each
//   with its exact fix. An item is FAIL (a problem) only when it stops a verify from doing its job; otherwise it is
//   CONCERN: listed with its fix, never an open item, never NOT READY by itself. A Check's status is FAIL when any item
//   is, else CONCERN when any item is, else PASS. Report gains concerns: [CONCERN item ids].
//   STANDING_BACKLOG = 50   untriaged one-screen standing rows from which the file is better started fresh.
//   upgradeCheck({ repoRoot, mainRoot = repoRoot, profile, fix = false, today = localDate() })
//     -> Promise<Check 'upgrade'>   static (the checkout's disk; --static runs it too).
//     sources:missing  FAIL   screens (map.mjs loadMap of the disk map; origin 'verify:*' left out; each name once)
//                             with neither declared `sources` nor recorded ones (sources.mjs readSources): '<n> of <m>
//                             screen(s) have no declared or recorded sources, so no PR's change ever walks them (the
//                             scope rule): <first 10 names>[ +<k> more]'; fix: the mapper's sources phase,
//                             'the qa skill --sources … qa map check --sources proves them'. --fix never does it.
//                             None missing (and some screen) -> PASS 'sources:all'.
//     sadpaths:shared  CONCERN the verifier's sad-path files (verify-*.json) in the shared map dir: '<n> verifier
//                             sad-path file(s) in the shared map (<names>): …'; fix: a git mv into qa/archive/map/
//                             once their PR has merged. --fix never moves.
//     suites:old-place CONCERN suites.mjs loadSuites reads the suites from qa/mutants.* (legacy); fix 'qa setup suites
//                             --write …'. --fix: setup.mjs writeSuites(repoRoot, {}, { profile }) moves them -> PASS 'moved <ids> to
//                             qa/suites.json (--fix); …'.
//     standing:backlog CONCERN qa/standing.md holds STANDING_BACKLOG or more standing.mjs untriagedRows: 'qa/standing.md
//                             holds <n> one-screen row(s) with no owner or note (first seen <date> on) …'; fix 'start it
//                             fresh: archive the file beside it …'. --fix: the file is copied to
//                             qa/standing.archived-<today>.md (-2, -3… when taken) and qa/standing.md becomes
//                             freshStanding's text -> PASS 'archived to qa/standing.archived-<today>.md (--fix); <k>
//                             triaged or fingerprint row(s) kept, <d> dropped'.
//   checkReady runs upgradeCheck (with opts.fix) before anything reads the suites, and appends its check last.
//   readyText: line 1 gains ' · <k> concern(s)' when there are any; a CONCERN item prints '  concern <id> — <reason>'
//     and '    → <fix>'; a PASS item whose reason holds '(--fix)' prints as '  pass <id> — <reason>'.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVerb, runVerb as adapterRunVerb, VERBS } from './adapter.mjs';
import { compare as compareDirs } from './compare.mjs';
import { expandScreen, loadMap, resolveSeedsDeep, validateMap } from './map.mjs';
import { cmdOf, commandText, loadSuites, REGISTRY_FILES, SUITES_FILES, timeoutOf } from './suites.mjs';
import { loadPages } from './routes.mjs';
import * as sandbox from './sandbox.mjs';
import { commandFor, execCommand, parseTests } from './tests.mjs';
import { treeText } from './tree.mjs';
import { gitOne, localDate } from './util.mjs';
import { readSources } from './sources.mjs';
import { suitesModeApplies } from './suitesmode.mjs';
import { freshStanding, readStanding, untriagedRows } from './standing.mjs';
import { writeSuites } from './setup.mjs';
import { defaultBaseRef } from './branches.mjs';

export const READY_FILE = 'qa/ready.json';
export const READY_VERBS = Object.freeze(['setup', 'up', 'seed', 'build', 'serve', 'test']);
export const STANDING_BACKLOG = 50;
export const EMPTY_TEXT = Object.freeze([
  '^no\\b.{0,40}\\b(yet|found|available|to (show|display)|results?|records?|data|items?|entries|matches)\\b',
  '^nothing (here|to (show|display|see)|yet|found)\\b',
  '\\b(is|are|list is) empty\\b',
  '^(empty|no data)\\b',
  "^(you )?(have|has|haven't|hasn't) (no|not)\\b.{0,40}\\byet\\b",
]);

const PLUGIN_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json');
const ROUTE_TABLES = ['qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs'];
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

export function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const item = (id, status, reason, fix = null) => ({ id, status, reason, fix });
const fail = (id, reason, fix = null) => item(id, 'FAIL', reason, fix);
const pass = (id, reason) => item(id, 'PASS', reason, null);
const concern = (id, reason, fix) => item(id, 'CONCERN', reason, fix);
const statusOf = (items) => (items.some((i) => i.status === 'FAIL') ? 'FAIL' : items.some((i) => i.status === 'CONCERN') ? 'CONCERN' : 'PASS');
const checkOf = (id, title, items, summary) => ({ id, title, status: statusOf(items), summary, items });

// ── verbs ──────────────────────────────────────────────────────────────────────

export function verbsCheck({ profile, mainRoot }) {
  const items = READY_VERBS.map((verb) => {
    const r = resolveVerb(verb, { profile, mainRoot });
    if (r.kind === 'command') return pass(`verb:${verb}`, `qa.json: ${r.command}`);
    if (r.kind === 'exec') return pass(`verb:${verb}`, `${r.adapter} (${r.source})`);
    return fail(`verb:${verb}`, `NOT RUN: ${r.reason}`,
      `name an adapter that has ${verb} in qa.json stack.adapter, or set qa.json stack.${verb} to its command (echo 'skip: <why>' when the app needs no ${verb})`);
  });
  const served = items.filter((i) => i.status === 'PASS').length;
  return checkOf('verbs', 'stack verbs', items, `${served} of ${READY_VERBS.length} served`);
}

// ── executables ────────────────────────────────────────────────────────────────

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const isExec = (p) => {
  try { return (fs.statSync(p).mode & 0o111) !== 0; } catch { return false; }
};
const toPosix = (p) => p.split(path.sep).join('/');

// The program a command string or argv runs, when it is a file in the tree (a path, not a bare name on PATH).
function programOf(suiteOrCmd, root) {
  const cmd = cmdOf(suiteOrCmd);
  const first = Array.isArray(cmd) ? cmd[0] : typeof cmd === 'string' ? cmd.trim().split(/\s+/)[0] : null;
  if (!isText(first) || !first.includes('/') || /^[$~]/.test(first)) return null;
  const abs = path.resolve(root, first);
  const rel = toPosix(path.relative(root, abs));
  if (rel.startsWith('..') || path.isAbsolute(rel) || !isFile(abs)) return null;
  return { rel, abs };
}

export function execTargets({ profile, mainRoot, suites = {} }) {
  const out = new Map();
  const add = (rel, abs, why) => { if (!out.has(rel)) out.set(rel, { rel, abs, why }); };
  for (const name of [].concat(profile?.stack?.adapter ?? [])) {
    const dir = path.join(mainRoot, 'qa', 'adapters', String(name));
    if (!fs.existsSync(dir)) continue;
    let listed = [];
    try { listed = JSON.parse(fs.readFileSync(path.join(dir, 'adapter.json'), 'utf8')).verbs ?? []; } catch { /* no manifest */ }
    for (const f of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, f);
      if (isFile(abs) && (VERBS.includes(f) || listed.includes(f))) add(toPosix(path.relative(mainRoot, abs)), abs, `the ${name} adapter's ${f} verb`);
    }
  }
  for (const verb of VERBS) {
    const p = programOf(profile?.stack?.[verb], mainRoot);
    if (p) add(p.rel, p.abs, `qa.json stack.${verb}`);
  }
  for (const [id, suite] of Object.entries(suites ?? {})) {
    const p = programOf(suite, mainRoot);
    if (p) add(p.rel, p.abs, `suite ${id}`);
  }
  return [...out.values()];
}

export function execCheck({ targets, fix = false, gitMode = () => null }) {
  const items = targets.map((t) => {
    const id = `exec:${t.rel}`;
    let fixed = false;
    if (!isExec(t.abs)) {
      if (!fix) return fail(id, `exec bit missing: ${t.why} cannot run`, `chmod +x ${t.rel} (or qa ready --fix)`);
      const mode = fs.statSync(t.abs).mode;
      fs.chmodSync(t.abs, mode | ((mode & 0o444) >> 2));
      fixed = true;
    }
    if (gitMode(t.rel) === '100644') return fail(id, `committed without the exec bit: a fresh checkout cannot run ${t.why}`, `git update-index --chmod=+x ${t.rel}, then commit`);
    return pass(id, fixed ? `made executable (--fix): ${t.why}` : t.why);
  });
  if (!targets.length) items.push(pass('exec:none', 'no project adapter or qa/ script to run'));
  const bad = items.filter((i) => i.status === 'FAIL').length;
  return checkOf('exec', 'executables', items, bad ? `${bad} of ${targets.length} not runnable` : `${targets.length} executable`);
}

// ── map coverage ───────────────────────────────────────────────────────────────

export function pagePattern(p) {
  let s = String(p).replace(/\/+$/, '');
  const wild = s.endsWith('/*');
  if (wild) s = s.slice(0, -2);
  const body = s.split('/').map((seg) => (/^:[A-Za-z_]\w*$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}${wild ? '(/.*)?' : '/?'}$`);
}

export function urlPath(url) {
  if (!isText(url)) return null;
  try {
    const u = new URL(url, 'http://qa.invalid');
    if (u.hash.startsWith('#/')) return new URL(u.hash.slice(1), 'http://qa.invalid').pathname;
    return u.pathname;
  } catch {
    return null;
  }
}

const walkable = (s) => !String(s?.origin ?? '').startsWith('verify:');

function gotoPaths(screen, map, profile) {
  try {
    const x = expandScreen(screen, { flows: map.flows, seed: map.seed, seedFile: map.seedFile, profile });
    return x.steps.filter((st) => typeof st.goto === 'string').map((st) => urlPath(st.goto)).filter(Boolean);
  } catch {
    return [];
  }
}

export function coverageCheck({ table, map, profile, urls = {} }) {
  const items = [];
  const screens = (map?.screens ?? []).filter(walkable);
  const names = new Set(screens.map((s) => s.name));
  if (!screens.length) items.push(fail('map:empty', 'qa/map has no screen', 'map the pages with the qa skill <page> …'));
  if ((map?.files ?? []).some((f) => path.basename(f) === 'example.json')) {
    items.push(fail('map:example', 'qa/map/example.json is the setup template, not this app', 'delete qa/map/example.json once real screens are mapped'));
  }
  const { errors } = map ? validateMap(map, profile) : { errors: [] };
  errors.slice(0, 10).forEach((e) => items.push(fail('map:check', e, 'the qa skill repairs the entry (qa map check shows every error)')));
  if (errors.length > 10) items.push(fail('map:check', `${errors.length - 10} more map error(s)`, 'qa map check'));

  const pages = table?.pages ?? [];
  const where = table?.file ?? 'qa/routes.table.json';
  (table?.errors ?? []).forEach((e, i) => items.push(fail(`pages:${i + 1}`, e, `fix the page in ${where}`)));
  if (!pages.length) {
    items.push(fail('pages:none', table?.file ? `${table.file} lists no pages: coverage cannot be measured` : 'no route table lists the pages: coverage cannot be measured',
      `list every page the app serves in ${where} ${where.endsWith('.json') ? '"pages"' : 'PAGES'}: [{ path }] (a page nobody should map: { path, skip: "<why>" })`));
    return checkOf('map', 'map coverage', items, `${screens.length} screen(s); no page list`);
  }
  const reached = new Map();
  for (const s of screens) {
    const paths = [...gotoPaths(s, map, profile), ...(urls[s.name] ?? [])];
    reached.set(s.name, paths);
  }
  let mapped = 0;
  let skipped = 0;
  for (const page of pages) {
    if (page.skip) {
      skipped += 1;
      items.push(pass(`page:${page.path}`, `skipped: ${page.skip}`));
      continue;
    }
    const unknown = page.screens.filter((n) => !names.has(n));
    if (unknown.length) {
      items.push(fail(`page:${page.path}`, `names screen(s) the map lacks: ${unknown.join(', ')}`, `map them with the qa skill ${page.path}, or fix the names in ${where}`));
      continue;
    }
    const re = pagePattern(page.path);
    const hit = page.screens.length > 0 || [...reached.values()].some((paths) => paths.some((p) => re.test(p)));
    if (hit) mapped += 1;
    else items.push(fail(`page:${page.path}`, 'no map entry reaches it', `the qa skill ${page.path} (or { "path": "${page.path}", "skip": "<why>" } in ${where})`));
  }
  const open = pages.length - skipped;
  return checkOf('map', 'map coverage', items, `${mapped} of ${open} page(s) mapped${skipped ? ` · ${skipped} skipped` : ''} · ${screens.length} screen(s)`);
}

// ── seed: empty-data screens ──────────────────────────────────────────────────

function textMatcher(want) {
  const s = String(want);
  const slash = s.lastIndexOf('/');
  if (s.startsWith('/') && slash > 0) {
    try {
      const re = new RegExp(s.slice(1, slash), s.slice(slash + 1));
      return (t) => { re.lastIndex = 0; return re.test(t); };
    } catch { /* a bad regex is plain text */ }
  }
  return (t) => t.includes(s);
}

export function emptyState(tree, { expectData = null, emptyOk = false, extra = [] } = {}) {
  if (emptyOk === true) return null;
  const lines = String(tree ?? '').split('\n').filter((l) => l.trim());
  if (isText(expectData)) {
    const match = textMatcher(expectData);
    return lines.some((l) => match(treeText(l)) || match(l)) ? null : { line: null, why: `expected data "${expectData}" is not on the screen` };
  }
  const phrases = [...EMPTY_TEXT, ...extra].map((p) => {
    try { return new RegExp(p, 'i'); } catch { return null; }
  }).filter(Boolean);
  for (const l of lines) {
    const text = treeText(l).trim();
    if (!text || text.length > 80) continue;
    if (phrases.some((re) => re.test(text))) return { line: l.trim(), why: `shows an empty state: "${text}"` };
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function walkCheck({ side, out, screens = {}, profile = {} }) {
  const items = [];
  const urls = {};
  let captured = 0;
  const extra = profile?.ready?.emptyText ?? [];
  for (const v of side?.viewports ?? []) {
    for (const f of v.failed ?? []) {
      items.push(fail(`walk:${v.viewport}/${f.screen}`, `${f.mapError ? '' : 'FAILED '}${f.step === 'map' ? '' : `at ${firstLine(f.step)}: `}${firstLine(f.error)}`,
        `the qa skill ${f.screen} repairs the entry from what the page shows; when the page itself is broken on the integration branch, fix the app`));
    }
    for (const n of v.notRun ?? []) items.push(fail(`walk:${v.viewport}/${n.screen}`, `NOT RUN: ${n.why}`, 'make the login work (qa.json login, its env names, or the adapter logins verb)'));
    for (const key of v.captured ?? []) {
      captured += 1;
      const dir = path.join(out, v.viewport);
      const record = readJson(path.join(dir, `${key}.json`)) ?? {};
      const name = record.screen ?? key.split('__')[0];
      const p = urlPath(record.url);
      if (p) (urls[name] ??= []).includes(p) || urls[name].push(p);
      const entry = screens[name] ?? {};
      let tree = null;
      try { tree = fs.readFileSync(path.join(dir, record.tree ?? `${key}.aria.yml`), 'utf8'); } catch { /* no tree: nothing to judge */ }
      if (tree === null) continue;
      const empty = emptyState(tree, { expectData: entry.expectData ?? null, emptyOk: entry.emptyOk === true, extra });
      if (empty) {
        items.push(fail(`empty:${v.viewport}/${key}`, empty.why,
          `add the records this screen shows to the seed (the stack's seed verb), so base and head both show data; or mark ${name} "emptyOk": true when the empty state is the point of the entry`));
      }
    }
  }
  const bad = items.length;
  if (!bad) items.push(pass('walk:all', `${captured} capture(s), no failure, no empty-data screen`));
  return { check: checkOf('walk', 'full walk on the seed', items, `${captured} capture(s) · ${bad} problem(s)`), urls };
}

// ── determinism ────────────────────────────────────────────────────────────────

export function determinismCheck(result) {
  const items = [];
  const same = [];
  let pairs = 0;
  for (const v of result?.viewports ?? []) {
    for (const p of v.pairs ?? []) {
      pairs += 1;
      const id = `det:${v.viewport}/${p.key}`;
      const fixText = 'make the seed fixed: the same ids, timestamps and random values on every run (text it must stamp with the time goes in qa.json volatile)';
      if (p.status !== 'same') {
        const line = p.tree?.added?.[0]?.line ?? p.tree?.removed?.[0]?.line;
        const why = p.status === 'gone' ? 'captured on the first seed, failed on the second'
          : p.status === 'new' ? 'failed on the first seed, captured on the second'
            : line ? `differs between two fresh seeds: ${line.trim()}` : `differs between two fresh seeds (${p.status})`;
        items.push(fail(id, why, fixText));
      } else if (p.pixel?.changed) {
        items.push(fail(id, `pixels differ between two fresh seeds (${(p.pixel.ratio * 100).toFixed(1)}%)`, fixText));
      } else same.push(p.key);
    }
  }
  if (!pairs) items.push(fail('det:none', 'no sample screen was captured on both seeds', 'fix the walk first (the walk check), then run qa ready again'));
  else if (!items.length) items.push(pass('det:sample', `${same.length} screen(s) identical on two fresh seeds: ${same.join(', ')}`));
  return checkOf('determinism', 'seed determinism', items, `${same.length} of ${pairs} sample capture(s) identical`);
}

// ── suites ─────────────────────────────────────────────────────────────────────

function reporterFix(id, suite, outcome, registry) {
  const text = commandText(suite);
  if (text.startsWith('test:')) {
    return `make the stack's test verb print TAP, or write JUnit XML or Jest JSON to $QA_TEST_REPORT (suite ${id} in ${registry})`;
  }
  if (outcome?.runner) {
    return `qa added the ${outcome.runner} reporter but read no test from it: run \`${outcome.command}\` in a checkout and fix what stops it reporting`;
  }
  return `in ${registry}, make suite ${id} call the runner directly (npx vitest run, npx jest, npx playwright test, pytest, node --test) so qa adds its reporter, or have \`${text}\` write JUnit XML or Jest JSON to $QA_TEST_REPORT`;
}

export function suiteItem(id, suite, outcome, { registry = 'qa/suites.json', ref = 'the integration branch' } = {}) {
  const sid = `suite:${id}`;
  if (outcome?.notRun) return fail(sid, `not run: ${outcome.notRun}`, `serve the test verb (an adapter, or qa.json stack.test), or give suite ${id} a command in ${registry}`);
  const parsed = parseTests({ report: outcome?.report ?? null, output: outcome?.output ?? '' });
  const tests = parsed.tests;
  const log = outcome?.log ? ` (log ${outcome.log})` : '';
  if (!tests) {
    const s = parsed.summary;
    const said = s ? `: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped` : '';
    return fail(sid, `the output names no test (${parsed.source}${said}): a test expectation can never be proven by it${log}`, reporterFix(id, suite, outcome, registry));
  }
  if (!tests.length) return fail(sid, `ran no test (${parsed.source}, exit ${outcome?.code ?? 'none'})${log}`, `make suite ${id} in ${registry} run the project's tests`);
  const failed = tests.filter((t) => t.status === 'failed');
  if (failed.length) {
    return fail(sid, `${failed.length} of ${tests.length} failed on ${ref}: ${failed.slice(0, 3).map((t) => t.name).join('; ')}${failed.length > 3 ? ` +${failed.length - 3} more` : ''}${log}`,
      'make it pass on the integration branch: a suite that fails unmutated judges no mutant');
  }
  if (outcome?.timedOut) return fail(sid, `timed out after ${tests.length} test(s)${log}`, `give suite ${id} its own limit in ${registry} ({ "cmd": …, "timeoutMs": … }), or split the suite`);
  if (outcome?.code !== 0 && outcome?.code !== null && outcome?.code !== undefined) {
    return fail(sid, `exit ${outcome.code} though every named test passed${log}`, `find what fails the command after its tests (coverage limits, a teardown) and fix it, or point suite ${id} at the runner alone`);
  }
  return pass(sid, `${tests.length} named test(s) passed (${parsed.source})`);
}

export function suitesCheck({ loaded, outcomes = null, why = 'not run', ref } = {}) {
  const items = [];
  const named = loaded?.suitesFile ?? loaded?.file ?? null;
  const registry = named ?? 'qa/suites.json';
  const suites = loaded?.suites ?? {};
  const note = loaded?.note ? ` · ${loaded.note}` : '';
  (loaded?.errors ?? []).forEach((e, i) => items.push(fail(`registry:${i + 1}`, e, `fix the entry in ${registry}`)));
  if (!named || !Object.keys(suites).length) {
    items.push(fail('suites:none', named ? `${named} names no suite` : 'no test suites (qa/suites.json, .ts or .mjs)',
      'register the project\'s suites: qa/suites.json { "suites": { "unit": "npx vitest run" } } (the qa skill proposes them: qa setup suites)'));
    return checkOf('suites', 'test suites', items, `no suite${note}`);
  }
  for (const [id, suite] of Object.entries(suites)) {
    if (!outcomes) items.push(fail(`suite:${id}`, `not run: ${why}`, 'run qa ready on a sandbox'));
    else items.push(suiteItem(id, suite, outcomes[id], { registry, ref }));
  }
  const ok = items.filter((i) => i.id.startsWith('suite:') && i.status === 'PASS').length;
  return checkOf('suites', 'test suites', items, `${ok} of ${Object.keys(suites).length} suite(s) name their tests and pass${note}`);
}

// The default suite runner: the suite once, whole, in the sandbox worktree, with the runner's reporter added.
export async function runSuiteDefault({ id, suite, dir, profile, mainRoot, vars, logDir, runVerb = adapterRunVerb, timeoutMs }) {
  fs.mkdirSync(logDir, { recursive: true });
  const stem = `suite-${String(id).replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const report = path.join(logDir, `${stem}.report`);
  const logFile = path.join(logDir, `${stem}.log`);
  fs.rmSync(report, { force: true });
  const readReport = () => { try { return fs.readFileSync(report, 'utf8'); } catch { return null; } };
  const cmd = cmdOf(suite);
  const limit = timeoutMs ?? timeoutOf(suite, profile);
  if (typeof cmd === 'string' && cmd.startsWith('test:')) {
    const r = await runVerb('test', { profile, mainRoot, cwd: dir, args: [cmd.slice(5)], vars, env: { QA_TEST_GREP: '', QA_TEST_FILE: '', QA_TEST_REPORT: report }, timeoutMs: limit });
    const output = `${r?.stdout ?? ''}${r?.stderr ?? ''}`;
    if (!r?.notRun) fs.writeFileSync(logFile, output);
    return { command: cmd, runner: null, code: r?.notRun ? null : r?.code ?? null, output, report: readReport(), timedOut: r?.code === 124, notRun: r?.notRun ?? null, log: r?.notRun ? null : logFile };
  }
  const plan = commandFor(suite, { grep: null, report });
  const env = {
    ...process.env, QA_ROOT: String(dir), QA_MAIN_ROOT: String(mainRoot ?? ''), QA_SLUG: String(vars?.slug ?? ''),
    QA_PORT: vars?.port == null ? '' : String(vars.port), ...plan.env,
  };
  delete env.NODE_TEST_CONTEXT;
  const r = await execCommand({ file: plan.file, argv: plan.argv, cwd: dir, env, logFile, timeoutMs: limit });
  return { command: plan.shown, runner: plan.runner, code: r.code, output: r.output, report: readReport(), timedOut: r.timedOut, notRun: null, log: logFile };
}

// ── upgrade: what an older qa left behind ─────────────────────────────────

const named = (list, n = 10) => `${list.slice(0, n).join(', ')}${list.length > n ? ` +${list.length - n} more` : ''}`;
const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

function archiveName(dir, today) {
  for (let n = 1; ; n++) {
    const rel = `qa/standing.archived-${today}${n > 1 ? `-${n}` : ''}.md`;
    if (!fs.existsSync(path.join(dir, rel))) return rel;
  }
}

export async function upgradeCheck({ repoRoot, mainRoot = repoRoot, profile = {}, fix = false, today = localDate() } = {}) {
  const items = [];
  const mapAbs = path.resolve(repoRoot, profile.map ?? 'qa/map');
  const relMap = toPosix(path.relative(repoRoot, mapAbs)) || 'qa/map';

  // Sources: under the scope rule a screen with none is never walked by another PR's change.
  let map = null;
  try {
    map = loadMap({ root: repoRoot, profile: { ...profile, map: mapAbs, seedNames: path.resolve(repoRoot, profile.seedNames ?? 'qa/seed.json') } });
  } catch { /* the map check reports a map that does not load */ }
  if (map) {
    const recorded = readSources(mapAbs);
    const screens = (map.screens ?? []).filter((s) => typeof s.name === 'string' && walkable(s));
    const names = [...new Set(screens.map((s) => s.name))];
    const known = (n) => screens.some((s) => s.name === n && Array.isArray(s.sources) && s.sources.some(isText)) || (Array.isArray(recorded[n]) && recorded[n].length > 0);
    const missing = names.filter((n) => !known(n));
    if (missing.length) {
      items.push(fail('sources:missing', `${missing.length} of ${names.length} screen(s) have no declared or recorded sources, so no PR's change ever walks them (the scope rule): ${named(missing)}`,
        'the qa skill --sources: the mapper\'s sources phase names each entry\'s files from the router and the page that renders it; qa map check --sources proves them'));
    } else if (names.length) items.push(pass('sources:all', `${names.length} screen(s) name their sources`));
  }

  // The verifier's sad paths: their PR's, never the shared map's.
  let sad = [];
  try { sad = fs.readdirSync(mapAbs).filter((f) => /^verify-.+\.json$/.test(f) && !f.endsWith('.sources.json')).sort(); } catch { /* no map dir */ }
  if (sad.length) {
    items.push(concern('sadpaths:shared', `${sad.length} verifier sad-path file(s) in the shared map (${named(sad)}): a sad path belongs to its PR, and every other PR lists its screens under "map these"`,
      `once their PR has merged, move them out of the map: mkdir -p qa/archive/map && git mv ${relMap}/verify-<slug>.json qa/archive/map/, then commit`));
  }

  // Suites in their old place (still read, with a note).
  const loaded = await loadSuites({ root: repoRoot, profile });
  if (loaded.legacy && Object.keys(loaded.suites).length) {
    if (fix) {
      try {
        const r = await writeSuites(repoRoot, {}, { profile });
        items.push(pass('suites:old-place', `moved ${r.moved.join(', ')} to qa/suites.json (--fix); the SUITES left in ${loaded.file} are no longer read: delete them there`));
      } catch (e) {
        items.push(concern('suites:old-place', `the test suites are read from ${loaded.file}, their old place; --fix could not move them: ${firstLine(e)}`, 'qa setup suites --write'));
      }
    } else {
      items.push(concern('suites:old-place', `the test suites are read from ${loaded.file}, their old place (still read, with a note on every run)`,
        `qa setup suites --write (moves them to qa/suites.json; or qa ready --fix), then delete SUITES from ${loaded.file}`));
    }
  }

  // A standing.md of untriaged one-screen rows from before fingerprints.
  const standingFile = path.join(repoRoot, 'qa', 'standing.md');
  const text = readText(standingFile);
  const old = text === null ? [] : untriagedRows(readStanding(text));
  if (old.length >= STANDING_BACKLOG) {
    if (fix) {
      const rel = archiveName(repoRoot, today);
      fs.writeFileSync(path.join(repoRoot, rel), text);
      const fresh = freshStanding(text);
      fs.writeFileSync(standingFile, fresh.text);
      items.push(pass('standing:backlog', `archived to ${rel} (--fix); ${fresh.kept} triaged or fingerprint row(s) kept, ${fresh.dropped} dropped`));
    } else {
      const since = old.map((r) => String(r.firstSeen).slice(0, 10)).filter(Boolean).sort()[0] ?? '?';
      items.push(concern('standing:backlog', `qa/standing.md holds ${old.length} one-screen row(s) with no owner or note (first seen ${since} on), most from walks of the whole map before fingerprints: nobody will triage them, and they bury the rows that matter`,
        'start it fresh: archive the file beside it (qa/standing.archived-<date>.md) and keep only the fingerprint rows and the rows someone owns or noted — qa ready --fix does both'));
    }
  }

  const fails = items.filter((i) => i.status === 'FAIL').length;
  const concerns = items.filter((i) => i.status === 'CONCERN').length;
  const summary = fails || concerns ? [fails ? `${fails} problem(s)` : null, concerns ? `${concerns} concern(s)` : null].filter(Boolean).join(' · ') : 'nothing an older qa left behind';
  return checkOf('upgrade', 'upgrade gaps', items, summary);
}

// ── inputs and the readiness a run reads ──────────────────────────────────────

function hashFiles(target, skip = () => false) {
  if (!fs.existsSync(target)) return null;
  const h = createHash('sha256');
  const walk = (abs, rel) => {
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
    } else if (!skip(rel)) {
      h.update(`${rel}\0`);
      h.update(fs.readFileSync(abs));
      h.update('\0');
    }
  };
  walk(target, '');
  return h.digest('hex').slice(0, 16);
}

export function readyInputs({ repoRoot, mainRoot, profile }) {
  const first = (names) => names.map((n) => path.resolve(repoRoot, n)).find((f) => fs.existsSync(f)) ?? null;
  const at = (f) => (f ? hashFiles(f) : null);
  return {
    profile: at(path.join(mainRoot ?? repoRoot, 'qa.json')),
    map: hashFiles(path.resolve(repoRoot, profile?.map ?? 'qa/map'), (rel) => rel.endsWith('.sources.json') || /(^|\/)verify-[^/]*\.json$/.test(rel)),
    seed: at(first([profile?.seedNames ?? 'qa/seed.json'])),
    suites: at(first([...SUITES_FILES, ...(profile?.mutants?.file ? [profile.mutants.file] : REGISTRY_FILES)])),
    routes: at(first(profile?.routes?.table ? [profile.routes.table] : ROUTE_TABLES)),
  };
}

const minorOf = (v) => {
  const m = /^(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
};

// A project in suites mode (suitesmode.mjs) has no screens for `qa ready` to prove: its line says so, whatever state
// the file is in. A project that has screens keeps the line below.
const SUITES_LINE = 'project not proven ready: no screens yet — qa ready applies once the map has entries';

export function readiness(opts) {
  const r = readinessOf(opts);
  if (!r.line || !suitesModeApplies({ repoRoot: opts.repoRoot, mainRoot: opts.mainRoot ?? opts.repoRoot, profile: opts.profile ?? {}, map: opts.map ?? null }).applies) return r;
  return { ...r, why: ['no screens yet — qa ready applies once the map has entries'], line: SUITES_LINE };
}

function readinessOf({ repoRoot, mainRoot, profile, version = pluginVersion() }) {
  const file = path.join(repoRoot, READY_FILE);
  const line = (why) => `project not proven ready: ${why.join('; ')}`;
  const r = readJson(file);
  if (!r || typeof r !== 'object') {
    const why = [fs.existsSync(file) ? `${READY_FILE} is unreadable — run qa ready` : `no ${READY_FILE} — run qa ready (or the qa skill)`];
    return { state: 'missing', why, line: line(why), file };
  }
  const why = [];
  const was = minorOf(r.plugin);
  const now = minorOf(version);
  if (now && (!was || was[0] < now[0] || (was[0] === now[0] && was[1] < now[1]))) why.push(`stale: proven by qa ${r.plugin ?? '?'}, this is ${version}`);
  const inputs = readyInputs({ repoRoot, mainRoot, profile });
  const changed = Object.keys(inputs).filter((k) => (r.inputs ?? {})[k] !== inputs[k]);
  if (changed.length) why.push(`stale: ${changed.join(', ')} changed since ${String(r.at ?? '?').slice(0, 10)}`);
  const stale = why.length > 0;
  if (r.ready !== true) {
    const open = Array.isArray(r.open) ? r.open : [];
    why.unshift(`FAIL ${open.slice(0, 5).join(', ') || 'unknown'}${open.length > 5 ? ` +${open.length - 5} more` : ''}`);
    return { state: 'not ready', why, line: line(why), file };
  }
  if (stale) return { state: 'stale', why, line: line(why), file };
  return { state: 'ready', why: [], line: null, file };
}

// ── the whole check ────────────────────────────────────────────────────────────

const defaultBase = (repoRoot) => defaultBaseRef(repoRoot);

// Up to n names spread evenly over the list.
export function sampleOf(names, n) {
  if (n <= 0 || !names.length) return [];
  if (names.length <= n) return [...names];
  return Array.from({ length: n }, (_, i) => names[Math.floor((i * names.length) / n)]);
}

export async function checkReady(opts, deps = {}) {
  const { mainRoot, repoRoot, profile } = opts;
  const log = opts.log ?? console.error;
  const now = opts.now ?? (() => new Date());
  const sampleN = Number.isInteger(opts.sample) ? opts.sample : 3;
  const d = { up: sandbox.up, down: sandbox.down, captureSide: null, compare: compareDirs, runSuite: runSuiteDefault, runVerb: adapterRunVerb, ...deps };
  if (!d.captureSide) d.captureSide = (await import('./run.mjs')).captureSide;
  const W = path.join(mainRoot, 'qa-artifacts', 'ready');

  // 1. Static checks. The upgrade gaps first: --fix may move the suites the suites check then reads.
  const upgrade = await upgradeCheck({ repoRoot, mainRoot, profile, fix: Boolean(opts.fix), today: localDate(now()) });
  const loaded = await loadSuites({ root: repoRoot, profile });
  const verbs = verbsCheck({ profile, mainRoot });
  const gitMode = (rel) => {
    const line = gitOne(['ls-files', '-s', '--', rel], { cwd: mainRoot });
    return line ? line.split(' ')[0] : null;
  };
  const exec = execCheck({ targets: execTargets({ profile, mainRoot, suites: loaded.suites }), fix: Boolean(opts.fix), gitMode });
  const mapAbs = path.resolve(repoRoot, profile.map ?? 'qa/map');
  const seedAbs = path.resolve(repoRoot, profile.seedNames ?? 'qa/seed.json');
  const diskProfile = { ...profile, map: mapAbs, seedNames: seedAbs };
  let map = null;
  let mapLoadError = null;
  try {
    map = loadMap({ root: repoRoot, profile: diskProfile });
  } catch (e) {
    mapLoadError = firstLine(e);
  }
  const table = await loadPages({ root: repoRoot, profile });
  // expectData may name a seeded record ($seed.call.first.who), as a map step does; one that cannot resolve is kept as
  // written, so the walk check says it is not on the screen (map check names the missing seed name).
  const seeded = (s) => {
    if (!isText(s.expectData) || !s.expectData.includes('$seed.')) return s;
    try {
      return { ...s, expectData: resolveSeedsDeep(s.expectData, { seed: map.seed, seedName: path.basename(map.seedFile ?? 'seed.json') }) };
    } catch {
      return s;
    }
  };
  const screens = Object.fromEntries((map?.screens ?? []).filter(walkable).map((s) => [s.name, seeded(s)]));
  const names = Object.keys(screens).sort();

  const notRunCheck = (id, title, why, fix = null) => checkOf(id, title, [fail(`${id}:not-run`, `not run: ${why}`, fix)], 'not run');
  let seedC;
  let walkC;
  let detC;
  let suitesC;
  let urls = {};
  let base = null;

  if (opts.sandbox === false) {
    seedC = notRunCheck('seed', 'seed', 'static check (--static)', 'qa ready');
    walkC = notRunCheck('walk', 'full walk on the seed', 'static check (--static)', 'qa ready');
    detC = notRunCheck('determinism', 'seed determinism', 'static check (--static)', 'qa ready');
    suitesC = suitesCheck({ loaded, outcomes: null, why: 'static check (--static)' });
  } else {
    if (opts.at) {
      const sha = gitOne(['rev-parse', '--verify', '--quiet', `${opts.at}^{commit}`], { cwd: repoRoot });
      if (!sha) throw new Error(`unknown ref ${opts.at}`);
      base = { ref: opts.at, sha };
    } else base = defaultBase(repoRoot);
    if (!base) throw new Error('no integration branch (qa.json integrationBranch, origin/HEAD, main or master); pass --at <ref>');
    log(`ready: integration branch ${base.ref} at ${base.sha.slice(0, 12)}`);
    fs.rmSync(W, { recursive: true, force: true });
    fs.mkdirSync(path.join(W, 'logs'), { recursive: true });
    const firstVp = Object.keys(profile.viewports ?? { desktop: null })[0];
    const sample = sampleOf(names.filter((n) => !Array.isArray(screens[n].viewports) || screens[n].viewports.includes(firstVp)), sampleN);
    const capture = (desc, out, screensGlob, viewports) => d.captureSide({
      mainRoot, profile, baseUrl: desc.appUrl, cwd: desc.dir, vars: { dir: desc.dir, main: mainRoot, slug: desc.slug, port: String(desc.port) },
      out, viewports, screens: screensGlob, map: mapAbs, seedNames: fs.existsSync(seedAbs) ? seedAbs : null, checks: false, tour: false,
      clock: null, seedStartedAt: desc.seedStartedAt ?? null, headless: true, record: 'none', log: (...a) => log(...a),
    });
    const copyLogs = (label, name) => {
      const dir = path.join(mainRoot, 'qa-artifacts', 'sandboxes');
      try {
        for (const f of fs.readdirSync(dir)) if (f.startsWith(`${name}.`) && f.endsWith('.log')) fs.copyFileSync(path.join(dir, f), path.join(W, 'logs', `${label}.${f.slice(name.length + 1)}`));
      } catch { /* no logs */ }
    };
    const bring = async () => {
      try {
        return { desc: await d.up({ mainRoot, profile, at: base.sha, qaFrom: repoRoot, log }) };
      } catch (e) {
        return { error: firstLine(e) };
      }
    };
    const drop = async (label, desc) => {
      copyLogs(label, desc.name);
      if (desc.reused) return;
      try { await d.down({ mainRoot, profile, name: desc.name }); } catch (e) { log(`ready: sandbox down ${desc.name}: ${firstLine(e)}`); }
    };

    // Sandbox A: the seed, the sample, the full walk, the suites.
    const a = await bring();
    let sampleA = null;
    let outcomes = null;
    let suitesWhy = 'the sandbox did not come up';
    if (a.error) {
      seedC = checkOf('seed', 'seed', [fail('seed:run', a.error, 'read qa-artifacts/ready/logs/ and the verb it names; qa sandbox up --at <ref> shows the same')], 'the sandbox did not come up');
      walkC = notRunCheck('walk', 'full walk on the seed', 'the sandbox did not come up');
      detC = notRunCheck('determinism', 'seed determinism', 'the sandbox did not come up');
    } else {
      const desc = a.desc;
      const seedStep = (desc.steps ?? []).find((s) => s.verb === 'seed');
      const seedItems = [];
      if (desc.reused) seedItems.push(fail('seed:run', `sandbox ${desc.name} was already up: its seed did not run now`, `qa sandbox down ${desc.name}, then qa ready`));
      else if (!seedStep || seedStep.notRun) seedItems.push(fail('seed:run', `the seed verb did not run (${seedStep?.notRun ?? 'no seed step'}): every screen shows what an empty database shows`, 'serve the seed verb: an adapter, or qa.json stack.seed'));
      else seedItems.push(pass('seed:run', `seeded in ${Math.round((seedStep.ms ?? 0) / 1000)} s`));
      seedC = checkOf('seed', 'seed', seedItems, seedItems[0].status === 'PASS' ? 'the seed runs' : 'the seed did not run');
      try {
        if (sample.length) sampleA = await capture(desc, path.join(W, 'a'), sample.join(','), [firstVp]);
        const walk = await capture(desc, path.join(W, 'walk'), names.length ? names.join(',') : null, null);
        const w = walkCheck({ side: walk, out: path.join(W, 'walk'), screens, profile });
        walkC = w.check;
        urls = w.urls;
        if (Object.keys(loaded.suites).length) {
          outcomes = {};
          for (const [id, suite] of Object.entries(loaded.suites)) {
            log(`ready: suite ${id}`);
            try {
              outcomes[id] = await d.runSuite({ id, suite, dir: desc.dir, profile, mainRoot, vars: { dir: desc.dir, main: mainRoot, slug: desc.slug, port: String(desc.port) },
                logDir: path.join(W, 'logs'), runVerb: d.runVerb, timeoutMs: timeoutOf(suite, profile) });
            } catch (e) {
              outcomes[id] = { notRun: firstLine(e) };
            }
          }
        }
      } catch (e) {
        walkC = checkOf('walk', 'full walk on the seed', [fail('walk:error', firstLine(e), 'read qa-artifacts/ready/logs/')], 'the walk stopped');
      } finally {
        await drop('a', desc);
      }

      // Sandbox B: the same commit, a fresh seed, the sample again.
      if (desc.reused) detC = checkOf('determinism', 'seed determinism', [fail('det:reused', `sandbox ${desc.name} was already up: two fresh seeds could not be compared`, `qa sandbox down ${desc.name}, then qa ready`)], 'not run');
      else if (!sample.length) detC = notRunCheck('determinism', 'seed determinism', 'no screen to sample', 'map the pages first');
      else if (!sampleA) detC = notRunCheck('determinism', 'seed determinism', 'the first sample was not captured');
      else {
        const b = await bring();
        if (b.error) detC = checkOf('determinism', 'seed determinism', [fail('det:up', `the second sandbox did not come up: ${b.error}`, 'read qa-artifacts/ready/logs/')], 'not run');
        else {
          try {
            await capture(b.desc, path.join(W, 'b'), sample.join(','), [firstVp]);
          } catch (e) {
            log(`ready: second sample: ${firstLine(e)}`);
          } finally {
            await drop('b', b.desc);
          }
          try {
            detC = determinismCheck(await d.compare({ beforeDir: path.join(W, 'a'), afterDir: path.join(W, 'b'), out: path.join(W, 'compare'), profile, viewports: [firstVp] }));
          } catch (e) {
            detC = checkOf('determinism', 'seed determinism', [fail('det:none', `compare failed: ${firstLine(e)}`, 'fix the walk first, then qa ready')], 'not run');
          }
        }
      }
      suitesWhy = 'the walk stopped first';
    }
    suitesC = suitesCheck({ loaded, outcomes, why: suitesWhy, ref: base.ref });
  }

  const mapC = mapLoadError
    ? checkOf('map', 'map coverage', [fail('map:load', mapLoadError, 'fix the map file it names (qa map check)')], 'the map does not load')
    : coverageCheck({ table, map, profile, urls });
  const checks = [verbs, exec, mapC, seedC, walkC, detC, suitesC, upgrade];
  const open = checks.flatMap((c) => c.items.filter((i) => i.status === 'FAIL').map((i) => i.id));
  const concerns = checks.flatMap((c) => c.items.filter((i) => i.status === 'CONCERN').map((i) => i.id));
  const report = {
    version: 1, ready: open.length === 0, plugin: pluginVersion(), commit: base?.sha ?? null, ref: base?.ref ?? null,
    at: now().toISOString(), inputs: readyInputs({ repoRoot, mainRoot, profile }), checks, open, concerns, work: opts.sandbox === false ? null : W,
  };
  if (opts.sandbox !== false) {
    const file = path.join(repoRoot, READY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

export function readyText(report) {
  const concerns = report.concerns ?? (report.checks ?? []).flatMap((c) => c.items.filter((i) => i.status === 'CONCERN').map((i) => i.id));
  const out = [`${report.ready ? 'READY' : `NOT READY — ${report.open.length} open`}${concerns.length ? ` · ${concerns.length} concern(s)` : ''}`];
  if (report.commit) out.push(`on ${report.ref} ${String(report.commit).slice(0, 12)} · qa ${report.plugin}`);
  for (const c of report.checks) {
    out.push(`${c.status} ${c.id} — ${c.summary}`);
    for (const i of c.items) {
      if (i.status === 'FAIL' || i.status === 'CONCERN') {
        out.push(`  ${i.status === 'FAIL' ? 'FAIL' : 'concern'} ${i.id} — ${i.reason}`);
        if (i.fix) out.push(`    → ${i.fix}`);
      } else if (/^skipped: |^made executable|\(--fix\)/.test(i.reason)) out.push(`  pass ${i.id} — ${i.reason}`);
    }
  }
  return out.join('\n');
}
