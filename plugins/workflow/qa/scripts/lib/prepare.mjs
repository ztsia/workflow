// `qa prepare check` (rework U5, design §5, D30): the PR's QA files are proven on the head sandbox in a minute or
// two, before the plan and the 35–60 minute run, so a missing map entry, route row or seed record costs a send-back to
// the mapper instead of a round. It walks ONLY the PR's own entries, once, with no page checks and no tour; fires each
// new route row once; checks every test file the PR adds sits in a registered suite; and reports (never edits) the
// qa.json concerns of §5's table. The head sandbox it brings up is left up for the run (sandbox.mjs handOff). Every rule
// is general (D39): the map, the route table, the runners' list modes, git and the accessibility tree; nothing names an
// app. Zero model calls.
//
// CONTRACT (tests: test/prepare.test.mjs — a small fixture app on node:http with a real headless browser; injected
// up/down; the CLI against a registered fixture sandbox)
//
//   prepareCheck(opts, deps = {}) -> Promise<PrepareCheck>
//     opts: { mainRoot, repoRoot, profile, slug, V, head (sha), base (sha), overlay (dir | null), map (dir | null),
//             seedNames (file | null), headless = true, log }
//     deps: { up, captureSide, routeActors, sweep, listFile, handOff, readAt, mapAt } (defaults: sandbox.mjs,
//             run.mjs captureSide / routeActors, routes.mjs sweep, the runners' list modes, git, affected.mjs mapAt).
//     1. The PR's QA files. head map = the map on disk (opts.map, else profile.map in repoRoot: the mapper's entries need
//          no commit) with the overlay on top; base map = the base commit's map (mapAt) when that commit carries one;
//          else, when the head commit carries none either (the QA files are untracked), the disk map without
//          the overlay; else null (the base had no map: every entry is new).
//        entries = affected.mjs prEntries(head, base, { slug })(the overlay's entries when a caller gives one), else the entries the
//          branch adds or changes. Per entry, before any walk: no `sources` (and none recorded) -> problem 'no sources:
//          name the files that render it (from the diff and the router), or no other PR's change will ever walk it';
//          no `expectData` and no `emptyOk: true` -> problem 'no expectData: name a text the seeded data shows there
//          (or "emptyOk": true when the empty state is the point)'.
//        routes = with an overlay, the rows of <overlay>/routes.json (as the table merges them, seeds resolved; their
//          errors are problems); without, the table's rows at head (read from git, the side file too) that are new or
//          changed (JSON-equal) against the table at base (a table that cannot be read -> no row is fired, a note says
//          why). So a PR that touches no table brings no sandbox up for routes.
//        pages = with an overlay, its routes.json pages; each `screens` name the head map lacks -> problem.
//        tests = the files the diff adds (git diff --name-only --diff-filter=A base head) that paths.mjs isTestFile names a
//        test (test_*.py, *.spec.ts, …; a helper such as tests/keys_fake.py or conftest.py is not one).
//        concerns (§5's qa.json row, reported, never a problem): each file the diff adds or changes whose path has an
//          auth, session, permission, payment, billing or migration word and that no profile.sensitive glob matches:
//          '<file>: looks like an auth, payment or migration path and no qa.json sensitive glob covers it'; each
//          ready.mjs execCheck FAIL of the project's adapters and scripts: '<file>: <why>'.
//        seedNeeds = <overlay>/seed-needs.md (a note: a builder writes that data into the seed in the PR).
//        No entry, no route row, no page and no test file -> nothing: true, no sandbox. Pages alone need none either.
//     2. The head sandbox: deps.up at head (qaFrom repoRoot; a live one is reused — the mapper's, started to probe). It
//        does not come up -> blocked = its message, nothing that needs it is judged. Whether it brought it up or reused
//        it, the check leaves it up and hands it to the run: handOff({ name }), so the run reuses it and then takes it
//        down (the plan check between them reuses it and leaves it).
//     3. The walk: per entry, at the first profile viewport it is walked at (its own viewports narrow them), one
//        captureSide per viewport with the head profile (overlay on), screens = onlyGlob(those names), checks false,
//        tour false, record 'none', clock off, the map on disk (map, seed names), into <mainRoot>/qa-artifacts/runs/<slug>-prepare/. Each entry is
//          reached        captured, and its tree shows its expectData (ready.mjs emptyState; $seed tokens resolved);
//          not reached    a failed step (the step and the error, as ready.mjs walkCheck says it) or NOT RUN;
//          empty          captured, but expectData is not on the screen, or (no expectData) it shows an empty state.
//        not reached and empty are problems.
//     4. Each route row once: routes.mjs planSweep([row], { roles, signIn }) — its 'happy' probe, else its first — swept
//        with run.mjs routeActors. A judgeProbe problem (no answer, 5xx, stack trace, happy path not 2xx, a signed-out
//        call answered, …) is a note, 'route <METHOD path>: <kind> (<actor>) <why> — the run's route sweep judges it',
//        never a problem (1.0.3): an answer is the app's, judged by the run's sweep, so it never stops the round. Only a
//        row that cannot be read (its table errors) is a problem.
//     5. Each new test file, per registered suite (suites.mjs loadSuites in the sandbox tree): the suite's list mode
//        for that file (tests.mjs listCommandFor with no grep). in = some suite lists at least one test (jest: the
//        file). No suite registered -> problem 'no suite is registered in qa/suites.*: its tests cannot be evidence';
//        every suite has a list mode and none lists it -> problem 'no registered suite lists it (<ids>): add it to a
//        suite in qa/suites.*, or a suite whose command reaches it'; none listed it but some suite has no list mode
//        (node --test, a shell line) -> not checked, a note.
//        SUITES MODE (suitesmode.mjs suitesModeApplies: no map entries, no stack that serves): there is no app to bring up,
//          so steps 2 to 4 are skipped (no sandbox, no route row fired: a note says so) and step 5 lists each new test file
//          in a git worktree of the head commit (withHeadWorktree). Nothing is BLOCKED for want of a serve. The concerns stay.
//     PrepareCheck = { slug, head, base, overlay, sandbox: { name, state } | null, blocked, nothing,
//       counts: { entries, routes, pages, tests }, entries: [{ screen, viewport, state, detail }],
//       routes: [{ route, kind, actor, status, problem }], tests: [{ file, state: 'in'|'out'|'not checked', suites }],
//       problems: [{ id, text }] (id 'map:<screen>' | 'route:<METHOD path>' | 'page:<path>' | 'test:<file>'),
//       concerns: [string], notes: [string], seedNeeds, ms }
//   prepareMd(check) -> the text of V/prepare.md:
//     '# Prepare check — <slug>', 'head: <sha12> · base: <sha12> · overlay: <dir | "none (qa/ in the branch)"> ·
//     sandbox <name> (<state>) | no sandbox · <s> s', 'checked: <n> entr(y|ies) · <n> route row(s) · <n> page(s) ·
//     <n> new test file(s)', then 'seed needs: <first line>[ (+<k> more lines)]', 'note: …', 'concern: …',
//     'blocked: <why> (nothing that needs the head sandbox was checked)', a blank line, '## Entries' ('- <screen>
//     (<vp>): reached' | 'not reached — <detail>' | 'reached but empty — <detail>' | '- none'), '## Routes'
//     ('- <route> (<kind>, <actor>): answered <status>' | ': <problem>' | '- none'), '## Test files' ('- <file>: in
//     <suites>' | 'not in a registered suite' | 'not checked (<why>)' | '- none'), '## Problems' ('- [<id>] <text>' |
//     '- none').
//   prepareExit(check) -> 4 blocked · 3 nothing to check · 1 any problem · 0 clean.
//   STUBS (design §6.1 rung 3; tests: test/stubs.test.mjs 'prepare check'): opts gain stubs = null ([id], else the ids
//     the charter V/charter.md names on its `stubs:` line, stubs.mjs charterStubs: the plan of this PR from an earlier
//     round; none in a first round, where the plan check holds the fresh plan to the same rule). Each id qa.json stubs
//     does not declare -> problem 'stub:<id>' 'the charter names stub <id>, which qa.json stubs does not declare:
//     declare it in qa.json stubs, or verify with --full to re-plan (a stub is { "for": …, "env": { "<NAME>":
//     "<switch>" } })'. Except in a FULL round (V/round.json for this head says full; opts.full overrides), where the
//     planner rewrites the charter and the plan check holds the new one to qa.json stubs: there it is a concern,
//     'stub <id>: the charter of an earlier round names it and qa.json stubs does not declare it; this full round plans
//     again, and the plan check holds the new charter to it' (never a problem, so it cannot block the re-plan). The head
//     sandbox comes up with the declared ones (sandbox.mjs up stubs), so the run that reuses it has them on.
//     PrepareCheck gains stubs: [declared ids]; prepareMd adds 'stubs: <ids> (qa.json stubs, set on the head sandbox)'
//     after the 'checked:' line when there are any. A check with problems is never `nothing` (exit 1, not 3).
//   blockedText(check) -> the one line a BLOCKED verdict carries when the problems outlive the mapper's repair round:
//     'prepare check: the PR's QA files could not be proven (<n> problem(s)): <first 3 "[id] text" joined by "; ">[;
//     +<k> more] — V/prepare.md lists them'.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as sandbox from './sandbox.mjs';
import { mapAt, prEntries, onlyGlob } from './affected.mjs';
import { readSources } from './sources.mjs';
import { execCheck, execTargets, walkCheck } from './ready.mjs';
import { loadMap, resolveSeedsDeep } from './map.mjs';
import { loadRouteTable, judgeProbe, planSweep, routeName, sweep as sweepDefault } from './routes.mjs';
import { OVERLAY_ROUTES, routesFile, seedNeeds as seedNeedsOf } from './overlay.mjs';
import { loadSuites, timeoutOf } from './suites.mjs';
import { execCommand, listCommandFor, parseListed } from './tests.mjs';
import { isTestFile, TEST_RE } from './paths.mjs';
import { git, gitOne, glob, isProductChange } from './util.mjs';
import { charterStubs, resolveStubs } from './stubs.mjs';
import { suitesModeApplies, withHeadWorktree } from './suitesmode.mjs';

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const isText = (v) => typeof v === 'string' && v.length > 0;
// Words a path carries when it is auth, session, permission, payment or migration code (design §5, qa.json row).
const SENSITIVE_WORDS = /(^|[/._-])(auth\w*|oauth\w*|sso|login|logout|session\w*|password\w*|credential\w*|token\w*|permission\w*|acl|payment\w*|billing|checkout|invoice\w*|refund\w*|migration\w*|migrate\w*)(?=$|[/._-])/i;

function showAt(repoRoot, sha, file) {
  try {
    return execFileSync('git', ['show', `${sha}:${file}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}

// The table's rows at a commit, read from a temp copy of its files there; null when it cannot be read.
async function rowsAt({ repoRoot, sha, profile, readAt }) {
  const names = profile?.routes?.table ? [profile.routes.table] : ['qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs'];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-prepare-table-'));
  try {
    let any = false;
    for (const rel of [...names, 'qa/routes.json']) {
      const text = readAt(sha, rel);
      if (text === null) continue;
      any = true;
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), text);
    }
    if (!any) return [];
    const t = await loadRouteTable({ root: tmp, profile: { ...profile, overlay: undefined } });
    return t.errors.length && !t.rows.length ? null : t.rows;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Every suite's list mode for one file: { listed: n } (names, or jest's files), or { noListMode: true }.
async function listFileDefault({ suite, file, dir, profile, mainRoot, vars, logDir, id }) {
  const report = path.join(logDir, `prepare-${id}-${path.basename(file)}.list.report`);
  const list = listCommandFor(suite, { grep: null, report, testFile: path.resolve(dir, file) });
  if (!list) return { noListMode: true };
  fs.mkdirSync(logDir, { recursive: true });
  fs.rmSync(report, { force: true });
  const env = { ...process.env, QA_ROOT: String(dir), QA_MAIN_ROOT: String(mainRoot ?? ''), QA_SLUG: String(vars.slug ?? ''), QA_PORT: vars.port == null ? '' : String(vars.port), ...list.env };
  delete env.NODE_TEST_CONTEXT;
  const r = await execCommand({ file: list.file, argv: list.argv, cwd: dir, env, logFile: path.join(logDir, `prepare-${id}-${path.basename(file)}.list.log`), timeoutMs: Math.min(120000, timeoutOf(suite, profile)) });
  let text = null;
  try { text = fs.readFileSync(report, 'utf8'); } catch { /* printed on the output */ }
  const parsed = parseListed(list.runner, { output: r.output, report: text });
  return { listed: list.kind === 'files' ? (parsed.files?.length ?? 0) : (parsed.tests?.length ?? 0) };
}

export async function prepareCheck(opts, deps = {}) {
  const { mainRoot, repoRoot, profile, slug, head, base } = opts;
  const overlay = typeof opts.overlay === 'string' && opts.overlay ? opts.overlay : null;
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const run = await import('./run.mjs');
  const d = {
    up: sandbox.up, captureSide: run.captureSide, routeActors: run.routeActors, mapAt,
    sweep: sweepDefault, listFile: listFileDefault, handOff: sandbox.handOff, readAt: (sha, file) => showAt(repoRoot, sha, file), ...deps,
  };
  const plain = run.withoutOverlay(profile);
  const headProfile = overlay ? { ...plain, overlay } : plain;
  const problems = [];
  const problem = (id, text) => problems.push({ id, text });
  const notes = [];
  const concerns = [];

  // 1. The PR's QA files.
  // The map on disk (the mapper's entries need no commit) with the overlay on top, against the base commit's map; when
  // neither commit carries a map (the QA files are untracked) the base is the same disk map without
  // the overlay.
  const mapDir = opts.map ?? path.resolve(repoRoot, plain.map ?? 'qa/map');
  const relMap = plain.map ?? 'qa/map';
  const diskProfile = (p) => ({ ...p, map: mapDir, ...(opts.seedNames ? { seedNames: opts.seedNames } : {}) });
  const load = (p) => {
    try { return loadMap({ root: repoRoot, profile: diskProfile(p) }); } catch { return null; }
  };
  const inCommit = (sha) => (git(['ls-tree', '-r', '--name-only', sha, '--', relMap], { cwd: repoRoot }) ?? []).length > 0;
  const headMap = load(headProfile);
  let baseMap = null;
  if (inCommit(base)) {
    try { baseMap = await d.mapAt({ repoRoot, sha: base, mapDir: relMap, seedNames: plain.seedNames ?? 'qa/seed.json', profile: plain }); } catch { baseMap = null; }
  } else if (!inCommit(head)) baseMap = overlay ? load(plain) : headMap;
  if (!headMap) notes.push('the head map could not be read (qa map check names why): no entry was walked');
  const names = headMap ? prEntries(headMap, baseMap, { slug }) : [];
  const entryOf = (n) => (headMap?.screens ?? []).find((s) => s.name === n);
  let sources = {};
  try { sources = (await readSources(mapDir)) ?? {}; } catch { /* none recorded */ }
  const seedName = path.basename(headMap?.seedFile ?? 'seed.json');
  for (const n of names) {
    const s = entryOf(n) ?? {};
    const hasSources = (Array.isArray(s.sources) && s.sources.some(isText)) || (Array.isArray(sources[n]) && sources[n].length > 0);
    if (!hasSources) problem(`map:${n}`, 'no sources: name the files that render it (from the diff and the router), or no other PR\'s change will ever walk it');
    if (!isText(s.expectData) && s.emptyOk !== true) problem(`map:${n}`, 'no expectData: name a text the seeded data shows there (or "emptyOk": true when the empty state is the point)');
  }
  const overRoutes = overlay ? routesFile(path.join(overlay, OVERLAY_ROUTES)) : { routes: [], pages: [], errors: [] };
  for (const e of overRoutes.errors) problem('route:overlay', e);
  for (const p of overRoutes.pages) {
    for (const sname of [].concat(p?.screens ?? [])) {
      if (typeof sname === 'string' && !(headMap?.screens ?? []).some((s) => s.name === sname)) problem(`page:${p.path}`, `names screen "${sname}", which the map does not have`);
    }
  }
  const changed = (git(['-c', 'core.quotepath=false', 'diff', '--name-only', base, head], { cwd: repoRoot }) ?? []).filter(isProductChange);
  const added = (git(['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=A', base, head], { cwd: repoRoot }) ?? []).filter(isProductChange);
  const testFiles = added.filter(isTestFile);
  const covered = (f) => (Array.isArray(plain.sensitive) ? plain.sensitive : []).some((g) => typeof g === 'string' && glob(g).test(f));
  for (const f of changed) if (SENSITIVE_WORDS.test(f) && !TEST_RE.test(f) && !covered(f)) concerns.push(`${f}: looks like an auth, payment or migration path and no qa.json sensitive glob covers it`);
  try {
    const loaded = await loadSuites({ root: repoRoot, profile: plain });
    const gitMode = (rel) => {
      const line = gitOne(['ls-files', '-s', '--', rel], { cwd: mainRoot });
      return line ? line.split(' ')[0] : null;
    };
    for (const item of execCheck({ targets: execTargets({ profile: plain, mainRoot, suites: loaded.suites }), gitMode }).items ?? []) {
      if (item.status === 'FAIL') concerns.push(`${item.id.replace(/^exec:/, '')}: ${item.reason ?? 'not executable'}`);
    }
  } catch { /* no suites file: nothing to say about executables */ }
  const seedNeeds = seedNeedsOf(overlay);
  // The stubs the plan of this PR names (its charter from an earlier round, or opts.stubs): each must be declared.
  let charterText = null;
  try { charterText = opts.V ? fs.readFileSync(path.join(opts.V, 'charter.md'), 'utf8') : null; } catch { /* no plan yet */ }
  const stubbed = resolveStubs(plain, Array.isArray(opts.stubs) ? opts.stubs : charterStubs(charterText));
  // A full round plans again (the plan check holds the new charter to qa.json stubs): the old charter's stub is a concern
  // there, never a block. An incremental round keeps that charter: a problem, with its way out.
  let roundPlan = null;
  try { roundPlan = opts.V ? JSON.parse(fs.readFileSync(path.join(opts.V, 'round.json'), 'utf8')) : null; } catch { /* no plan */ }
  const fullRound = typeof opts.full === 'boolean' ? opts.full : roundPlan?.head === head && roundPlan.of !== 'incremental';
  for (const id of stubbed.unknown) {
    if (fullRound && !Array.isArray(opts.stubs)) concerns.push(`stub ${id}: the charter of an earlier round names it and qa.json stubs does not declare it; this full round plans again, and the plan check holds the new charter to it`);
    else problem(`stub:${id}`, `the charter names stub ${id}, which qa.json stubs does not declare: declare it in qa.json stubs, or verify with --full to re-plan (a stub is { "for": …, "env": { "<NAME>": "<switch>" } })`);
  }

  // The route rows to fire: the overlay's (as the table merges them, seeds resolved), or (no overlay) the table's rows
  // that are new or changed against base — read from git, so a PR that touches no table needs no sandbox for them.
  let routeRows = [];
  if (overlay) {
    const keys = new Set(overRoutes.routes.filter((r) => r && typeof r === 'object').map((r) => `${r.method} ${r.path}`));
    if (keys.size) {
      const t = await loadRouteTable({ root: repoRoot, profile: headProfile, seed: headMap?.seed ?? null, seedName });
      for (const e of t.errors) if (e.startsWith(`overlay ${OVERLAY_ROUTES}`)) problem('route:overlay', e);
      routeRows = t.rows.filter((r) => keys.has(routeName(r)));
    }
  } else {
    const after = await rowsAt({ repoRoot, sha: head, profile: plain, readAt: d.readAt });
    const before = await rowsAt({ repoRoot, sha: base, profile: plain, readAt: d.readAt });
    if (after === null || before === null) notes.push(`the route table at ${after === null ? 'head' : 'base'} could not be read: no route row was fired`);
    else routeRows = after.filter((r) => !before.some((b) => routeName(b) === routeName(r) && JSON.stringify(b) === JSON.stringify(r)));
  }

  // Suites mode (suitesmode.mjs): no map entries and no stack that serves, so there is no app to bring up. The test
  // files are checked in a worktree of the head commit, and nothing waits on a sandbox.
  const fit = suitesModeApplies({ repoRoot, mainRoot, profile: plain, map: opts.map ?? null });
  const suitesMode = fit.applies && !names.length;
  if (suitesMode) {
    if (routeRows.length) notes.push('suites mode: nothing serves the app, so no route row was fired');
    routeRows = [];
    notes.push('suites mode: no screens and no stack, so no sandbox; the new test files are checked in a worktree of the head commit');
  }
  const counts = { entries: names.length, routes: routeRows.length, pages: overRoutes.pages.length, tests: testFiles.length };
  const result = (extra) => ({
    slug, head, base, overlay, sandbox: null, blocked: null, nothing: false, counts, entries: [], routes: [], tests: [],
    problems, concerns, notes, seedNeeds, stubs: stubbed.ids, ms: Date.now() - started, ...extra,
  });
  if (!names.length && !routeRows.length && !counts.pages && !testFiles.length) return result({ nothing: problems.length === 0 });

  // 2. The head sandbox (left up for the run).
  let desc = null;
  if (!suitesMode && (names.length || routeRows.length || testFiles.length)) {
    try {
      desc = await d.up({ mainRoot, profile: headProfile, at: head, qaFrom: repoRoot, log, stubs: stubbed.ids });
    } catch (e) {
      return result({ blocked: firstLine(e) });
    }
  }
  const vars = desc ? { dir: desc.dir, main: mainRoot, slug: desc.slug, port: String(desc.port) } : {};

  // 3. The walk: each entry once, at its first viewport, no checks, no tour.
  const entries = [];
  // The walk reads the map on disk, as step 1 did (an entry the mapper has not committed is walked too).
  const seedAbs = fs.existsSync(path.resolve(repoRoot, plain.seedNames ?? 'qa/seed.json')) ? path.resolve(repoRoot, plain.seedNames ?? 'qa/seed.json') : null;
  const allVps = Object.keys(headProfile.viewports ?? {});
  const byVp = new Map();
  for (const n of names) {
    const s = entryOf(n) ?? {};
    const vp = allVps.find((v) => !Array.isArray(s.viewports) || s.viewports.includes(v));
    if (!vp) {
      entries.push({ screen: n, viewport: null, state: 'not walked', detail: 'no profile viewport it is walked at' });
      continue;
    }
    if (!byVp.has(vp)) byVp.set(vp, []);
    byVp.get(vp).push(n);
  }
  const out = path.join(mainRoot, 'qa-artifacts', 'runs', `${slug}-prepare`);
  fs.rmSync(out, { recursive: true, force: true });
  const seeded = (s) => {
    if (!isText(s.expectData) || !s.expectData.includes('$seed.')) return s;
    try {
      return { ...s, expectData: resolveSeedsDeep(s.expectData, { seed: headMap.seed, seedName }) };
    } catch {
      return s;
    }
  };
  for (const [vp, list] of byVp) {
    let side;
    try {
      side = await d.captureSide({
        mainRoot, profile: headProfile, baseUrl: desc.appUrl, cwd: desc.dir, vars, out, viewports: [vp], screens: onlyGlob(list),
        map: mapDir, seedNames: opts.seedNames ?? seedAbs, checks: false, tour: false, clock: 'off', seedStartedAt: desc.seedStartedAt ?? null,
        headless: opts.headless !== false, record: 'none', log: (...a) => log(...a),
      });
    } catch (e) {
      for (const n of list) {
        entries.push({ screen: n, viewport: vp, state: 'not reached', detail: `the walk failed: ${firstLine(e)}` });
        problem(`map:${n}`, `not reached (${vp}): the walk failed: ${firstLine(e)}`);
      }
      continue;
    }
    const screens = Object.fromEntries(list.map((n) => [n, seeded(entryOf(n) ?? {})]));
    const walked = walkCheck({ side, out, screens, profile: headProfile });
    for (const n of list) {
      const lost = walked.check.items.find((i) => i.id === `walk:${vp}/${n}`);
      const empty = walked.check.items.find((i) => i.id.startsWith(`empty:${vp}/`) && (i.id.slice(`empty:${vp}/`.length) === n || i.id.slice(`empty:${vp}/`.length).startsWith(`${n}__`)));
      const captured = (side.viewports ?? []).some((v) => v.viewport === vp && (v.captured ?? []).some((k) => k === n || k.startsWith(`${n}__`)));
      if (lost) {
        const why = lost.reason ?? '';
        entries.push({ screen: n, viewport: vp, state: 'not reached', detail: why });
        problem(`map:${n}`, `not reached (${vp}): ${why}`);
      } else if (empty) {
        const why = empty.reason ?? '';
        entries.push({ screen: n, viewport: vp, state: 'empty', detail: why });
        problem(`map:${n}`, `reached but empty (${vp}): ${why}`);
      } else if (!captured) {
        entries.push({ screen: n, viewport: vp, state: 'not reached', detail: 'the walk captured nothing for it' });
        problem(`map:${n}`, `not reached (${vp}): the walk captured nothing for it`);
      } else entries.push({ screen: n, viewport: vp, state: 'reached', detail: '' });
    }
  }

  // 4. Each route row once.
  const routes = [];
  if (routeRows.length) {
    const roles = Object.keys(headProfile.login ?? {});
    let actors = { anon: {} };
    try {
      actors = (await d.routeActors({ profile: headProfile, mainRoot, descriptor: desc, vars })).headers;
    } catch (e) {
      notes.push(`route actors: ${firstLine(e)}`);
    }
    for (const row of routeRows) {
      const probes = planSweep([row], { roles, signIn: headProfile.routes?.signIn !== false }).filter((p) => p.kind !== 'unknown-path');
      const probe = probes.find((p) => p.kind === 'happy') ?? probes[0];
      if (!probe) continue;
      const [r] = await d.sweep({ baseUrl: headProfile.routes?.base ?? desc.appUrl, probes: [probe], actors });
      const why = r?.notRun ? `not fired: ${r.notRun}` : r?.problem ?? null;
      routes.push({ route: routeName(row), kind: probe.kind, actor: probe.actor, status: r?.status ?? null, problem: why });
      // A route row's answer is the run's to judge (its sweep fires the same row): never a problem that stops the round.
      if (why) notes.push(`route ${routeName(row)}: ${probe.kind} (${probe.actor}) ${why} — the run's route sweep judges it`);
    }
  }

  // 5. Each new test file in a registered suite.
  const tests = [];
  const checkTests = async (treeDir, treeVars) => {
    const loaded = await loadSuites({ root: treeDir, profile: headProfile });
    const ids = Object.keys(loaded.suites ?? {});
    for (const file of testFiles) {
      if (!ids.length) {
        tests.push({ file, state: 'out', suites: [] });
        problem(`test:${file}`, 'no suite is registered in qa/suites.*: its tests cannot be evidence');
        continue;
      }
      const inSuites = [];
      const unlisted = [];
      for (const id of ids) {
        let r;
        try {
          r = await d.listFile({ id, suite: loaded.suites[id], file, dir: treeDir, profile: headProfile, mainRoot, vars: treeVars, logDir: path.join(opts.V ?? out, 'logs', 'prepare') });
        } catch (e) {
          r = { error: firstLine(e) };
        }
        if (r?.noListMode || r?.error) unlisted.push(id);
        else if ((r?.listed ?? 0) > 0) inSuites.push(id);
      }
      if (inSuites.length) tests.push({ file, state: 'in', suites: inSuites });
      else if (unlisted.length) {
        tests.push({ file, state: 'not checked', suites: unlisted });
        notes.push(`${file}: not checked — ${unlisted.join(', ')} ha${unlisted.length === 1 ? 's' : 've'} no list mode (node --test, a shell line); the plan check tries its tests by name`);
      } else {
        tests.push({ file, state: 'out', suites: [] });
        problem(`test:${file}`, `no registered suite lists it (${ids.join(', ')}): add it to a suite in qa/suites.*, or a suite whose command reaches it`);
      }
    }
  };
  if (testFiles.length && suitesMode) {
    await withHeadWorktree({ repoRoot, mainRoot, headSha: head, slug: `${slug}-prepare` }, (dir) => checkTests(dir, { dir, main: mainRoot, slug, port: '' }));
  } else if (testFiles.length) await checkTests(desc.dir, vars);

  // Left up for the run, which reuses it and takes it down: brought up here, or reused (the mapper's, started to probe).
  if (desc) d.handOff({ mainRoot, name: desc.name });
  return result({ sandbox: desc ? { name: desc.name, state: desc.reused ? 'reused' : 'up' } : null, entries, routes, tests });
}

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, ' ');

export function prepareMd(check) {
  const c = check.counts ?? {};
  const head = String(check.head ?? '').slice(0, 12);
  const base = String(check.base ?? '').slice(0, 12);
  const box = check.sandbox ? `sandbox ${check.sandbox.name} (${check.sandbox.state})` : 'no sandbox';
  const needs = String(check.seedNeeds ?? '').split('\n').filter((l) => l.trim());
  const lines = [
    `# Prepare check — ${check.slug}`,
    `head: ${head} · base: ${base} · overlay: ${check.overlay ?? 'none (qa/ in the branch)'} · ${box} · ${Math.round((check.ms ?? 0) / 1000)} s`,
    `checked: ${c.entries ?? 0} entr${c.entries === 1 ? 'y' : 'ies'} · ${c.routes ?? 0} route row(s) · ${c.pages ?? 0} page(s) · ${c.tests ?? 0} new test file(s)`,
    ...(check.stubs?.length ? [`stubs: ${check.stubs.join(', ')} (qa.json stubs, set on the head sandbox)`] : []),
    ...(needs.length ? [`seed needs: ${needs[0].replace(/^[-*]\s*/, '')}${needs.length > 1 ? ` (+${needs.length - 1} more lines)` : ''}`] : []),
    ...(check.notes ?? []).map((n) => `note: ${oneLine(n)}`),
    ...(check.concerns ?? []).map((n) => `concern: ${oneLine(n)}`),
    ...(check.blocked ? [`blocked: ${oneLine(check.blocked)} (nothing that needs the head sandbox was checked)`] : []),
    ...(check.nothing ? ['nothing to check: this PR adds or changes no map entry, route row, page or test file'] : []),
    '',
    '## Entries',
    ...(check.entries?.length ? check.entries.map((e) => `- ${e.screen} (${e.viewport ?? '-'}): ${e.state === 'reached' ? 'reached' : e.state === 'empty' ? `reached but empty — ${oneLine(e.detail)}` : `${e.state} — ${oneLine(e.detail)}`}`) : ['- none']),
    '## Routes',
    ...(check.routes?.length ? check.routes.map((r) => `- ${r.route} (${r.kind}, ${r.actor}): ${r.problem ? oneLine(r.problem) : `answered ${r.status}`}`) : ['- none']),
    '## Test files',
    ...(check.tests?.length ? check.tests.map((t) => `- ${t.file}: ${t.state === 'in' ? `in ${t.suites.join(', ')}` : t.state === 'out' ? 'not in a registered suite' : `not checked (${t.suites.join(', ')}: no list mode)`}`) : ['- none']),
    '## Problems',
    ...(check.problems?.length ? check.problems.map((p) => `- [${p.id}] ${oneLine(p.text)}`) : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
}

export function prepareExit(check) {
  if (check.blocked) return 4;
  if (check.nothing) return 3;
  return check.problems?.length ? 1 : 0;
}

export function blockedText(check) {
  const list = (check.problems ?? []).map((p) => `[${p.id}] ${oneLine(p.text)}`);
  const shown = list.slice(0, 3).join('; ');
  return `prepare check: the PR's QA files could not be proven (${list.length} problem(s)): ${shown}${list.length > 3 ? `; +${list.length - 3} more` : ''} — V/prepare.md lists them`;
}

