// The runner (decisions 3, 13, 14): one command walks the map on base and head with the same seed,
// compares, and writes what a judge reads. Zero model calls. Step 4 walks the whole map every run
// (the affected set is step 7); routes, mutants, metrics beyond capture timing and lived-in are
// later steps and show as "not run" in summary.md.
//
// CONTRACT (tests: test/run.test.mjs — unit tests inject deps; one end-to-end test uses a temp git
// repo with a fake stack adapter, as test/sandbox.test.mjs does, and a real headless browser)
//
//   class RunError extends Error { code }   codes: 'USAGE' (CLI exit 64)
//
//   resolveClock(want, seedStartedAt) -> { clock: ISO | null, why: string }
//     Moved here from the CLI's clockOf, unchanged: want = 'off' -> { null, 'real clock (off)' };
//     'seed' -> seedStartedAt ? { seedStartedAt, 'frozen at <iso> (seed start)' }
//                             : { null, 'real clock (no seed start known)' };
//     else an ISO time -> { want, 'frozen at <want>' }; anything else -> RunError USAGE
//     'clock must be seed, off or an ISO time, not "<want>"'. want null/undefined = 'seed'.
//
//   captureSide({ mainRoot, profile, baseUrl, cwd, vars, out, viewports = null, screens = null,
//                 map = null, seedNames = null, checks = true, tour = true, clock = null,
//                 seedStartedAt = null, headless = true, record = false, pw = null, log = console.error,
//                 expectTexts = [] })
//     -> Promise<SideResult>
//     What `qa capture` does, as a function (the CLI's cmdCapture now calls it; its printed
//     lines are unchanged): the map is loaded from `cwd` (the tree being captured) with
//     map.mjs loadMap, unless map / seedNames (absolute paths) override profile.map /
//     profile.seedNames; clock = resolveClock(clock ?? profile.clock, seedStartedAt);
//     viewports default Object.keys(profile.viewports); per viewport selectScreens(…, { only:
//     screens, viewport }) then capture.mjs capture({ …, checks, tour, clock, flows, seed, seedFile }).
//     pw = loadPlaywright(mainRoot) when null.
//     SideResult = { viewports: [{ viewport, captured: [key], failed: [{ screen, step, error,
//                    mapError? }], notRun: [{ screen, why }], warnings: [string] }],
//                    clock: { clock, why }, mapErrors: [string] (map.errors), ms }
//
//   mapHash({ repoRoot, sha = null, profile, map = null, seedNames = null, extra = {} }) -> hex string (64)
//     sha256 over, in this order: every file under profile.map at `sha` (git ls-tree -r
//     --name-only, sorted; each as "<path>\0<blob>\0"), the profile.seedNames file at `sha` when
//     it exists there, then JSON of { viewports, watch, checks, tour, clock, settle, login,
//     maxElementsPerCapture, stepTimeoutMs, browser, writes } from profile, the plugin version
//     (.claude-plugin/plugin.json) and JSON of `extra` (the run's viewports/screens/checks/tour
//     choices). map / seedNames given (absolute paths) -> those files are read from disk instead
//     of git, `sha` unused for them. Same inputs -> same hash; any map byte changes it.
//     A `sha` that carries no profile.map at all (the project keeps its QA files off its product branches:
//     the QA files are untracked) -> the map, seed names and route table are read from the checkout on disk.
//
//   PREV_FILES (exported, frozen) = ['results.json', 'summary.md', 'verdict.draft.md', 'verdict.md',
//     'eyes.md', 'eyes-prompt.md', 'report.html', 'shots']
//   rotatePrev(V, headSha) -> [name]   (STEP 5; tests: test/run.test.mjs 'rotatePrev')
//     When V/results.json exists, parses, has mode 'diff' and head.sha !== headSha: V/prev is
//     removed (recursive) and remade, and every PREV_FILES entry present in V is moved into it
//     (rename); returns the moved names in PREV_FILES order. Otherwise moves nothing, leaves any
//     V/prev alone and returns []. charter.md, expectations.json, security.md, spec.md, run.json and
//     logs/ always stay. A missing V -> [].
//   moveToPrev(V) -> [name]   the move itself, whatever the head (`qa round plan --full` on a head that already has
//     its verdict: a full round again).

//   runQa(opts, deps = {}) -> Promise<Run>
//     opts: { mainRoot, repoRoot, profile, base = null, head = 'HEAD', slug = null, self = false,
//             expect = null, viewports = null, screens = null, map = null, seedNames = null,
//             cache = true, checks = true, tour = true, clock = null, headless = true,
//             out = null, log = console.error }
//     deps (tests inject; default to the real functions): { up, down, captureSide, compare,
//             sleep = ms => Promise, now = () => new Date() }
//
//     1. Resolve, in repoRoot. headSha = rev-parse <head>^{commit} (unknown -> USAGE 'unknown ref <head>').
//        Unless self: baseSha = rev-parse <base> when given, else merge-base(headSha, D) with D the
//        first that exists of origin/HEAD's target, main, master (none -> USAGE 'no base branch;
//        pass --base <ref>'). baseSha === headSha -> USAGE 'base and head are the same commit
//        (<sha12>); --self runs the determinism self-test'.
//        slug = opts.slug, else the branch name (rev-parse --abbrev-ref HEAD) with every char
//        outside [A-Za-z0-9._-] made '-' (B01/library -> B01-library); detached HEAD -> 'head-<sha10>'.
//        A dirty repoRoot (git status --porcelain, untracked files included) adds the warning
//        'uncommitted changes are not in the run: it captures commits'.
//        expect = opts.expect, else V/expectations.json when that file exists, else null.
//     2. Dirs. V = opts.out ?? <repoRoot>/qa/<slug>; work W =
//        <mainRoot>/qa-artifacts/runs/<slug> (removed, then made, at start); base cache C =
//        <mainRoot>/qa-artifacts/cache/base-<baseSha 10>-<base map hash 12>/.
//        maps = { head: mapHash at headSha, base: mapHash at baseSha | null }, both with
//        extra = { viewports, screens, checks, tour } and the run's map / seedNames overrides.
//     3. Base side (diff mode only):
//        - profile.base is a URL: captureSide against that URL, cwd = repoRoot, clock = 'off',
//          into W/base; no sandbox, no cache; sandboxes.base = { name: null, state: 'live', ms }.
//        (rework U4: the cache below is now kept per screen and shared by every PR on the base; see SCOPE.)
//        - else cache && C/meta.json has complete: true -> reuse C; sandboxes.base.state = 'cached';
//          no sandbox is started.
//        - else bring a sandbox up at baseSha (see "Up" below), captureSide with baseUrl =
//          descriptor.appUrl, cwd = descriptor.dir, vars = { dir, main: mainRoot, slug, port },
//          seedStartedAt = descriptor.seedStartedAt, into a fresh dir; down it (always, in a
//          finally). When the side is clean (no failed, no notRun in any viewport) the dir becomes
//          C with C/meta.json { complete: true, sha, mapHash, at: ISO, plugin } and the oldest
//          base-* cache dirs beyond profile.run.cacheKeep (default 5, by meta.json mtime) are
//          removed; else it stays as W/base and nothing is cached.
//     4. Head side: Up at headSha, captureSide into W/head, down. Self mode instead captures
//        twice on the same head sandbox, into W/a and W/b, then downs it.
//     5. compare({ beforeDir, afterDir, out: W/compare, expect, profile, viewports }) with
//        before/after = base dir/W/head (diff) or W/a/W/b (self). Skipped when a side is blocked.
//     6. Write (summary.mjs, verdict.mjs, standing.mjs). STEP 5: first, in diff mode,
//        rotatePrev(V, headSha) keeps the last round's files in V/prev (the report of the round before).
//        V/results.json   buildResults(run)            (always, even when blocked)
//        V/summary.md     summaryMd(results)           (always)
//        V/verdict.draft.md  draftVerdict(results, { security: parseSecurity(V/security.md text
//                           or null) }).md  (diff mode only)
//        V/run.json       { slug, mode, startedAt, finishedAt, head, base, maps, exit, sandboxes,
//                           cache: { hit, dir }, plugin, warnings }, merged over an existing
//                           run.json: keys the runner does not write are kept (later steps keep
//                           the judge's agent id there).
//        V/logs/<side>.<verb>.log  copies of the sandbox's verb logs
//                           (<mainRoot>/qa-artifacts/sandboxes/<name>.<verb>.log), taken before down;
//        V/logs/<side>.capture.log  every line captureSide logged for that side.
//        <repoRoot>/qa/standing.md   diff mode, when compare ran and opts.standing !== false (`run --no-standing`:
//                           a report rebuild must not touch the checkout's QA files): mergeStanding(existing text or
//                           null, standingItems(compare result), { slug, date: YYYY-MM-DD of now(), touched }).
//                           U7: in diff mode run.standingRows = readStanding(the file's text, or []) before results are
//                           built (with --no-standing too: it reads, never writes), so buildResults matches the new
//                           findings against it; touched = the ids of results.standing.matched (their last seen).
//     Up (one side): deps.up({ mainRoot, profile, at: sha }); a SandboxError with code 'BLOCKED'
//        logs 'sandbox up <side> BLOCKED; retrying once in <s> s', awaits
//        sleep(profile.sandbox.retryWaitMs ?? 15000) and tries once more. A second BLOCKED (or any
//        other error) marks the side blocked: run.blocked = 'BLOCKED ON INFRASTRUCTURE: <side>:
//        <message>', no capture, no compare, later sides skipped. A descriptor with reused: true
//        (the sandbox was up before the run) is never downed by the runner.
//     Every up/capture/down/compare appends to run.steps { side: 'base'|'head'|'run', verb:
//        'up'|'capture'|'down'|'compare', ok, ms, note } (note: 'retried', 'cached', the error's
//        first line, '' otherwise). Nothing is left running when runQa returns or throws (USAGE
//        throws before any sandbox starts).
//
//     Run = { exit, mode: 'diff'|'self', slug, head: { ref, sha }, base: { ref, sha, cached } | null,
//             maps: { head, base }, sandboxes: { base: { name, state, ms } | null, head: { name, state, ms } },
//             steps, sides: { base, head, again } (SideResult | null; again = self mode's 2nd capture),
//             compare: compare() result | null, blocked: string | null, warnings: [string],
//             standing: { file, added, seen } | null, dirs: { verification, work, cache },
//             report: W/compare/index.html | null, results }   (results = buildResults(run))
//       sandbox state: 'up' (started by this run), 'reused', 'cached', 'live', 'blocked'.
//     exit, first that applies: 4 blocked; 1 compare exit 1, or a head screen failed that did not
//       fail on base (self mode: anything not identical, see summary.mjs); 3 a NOT RUN screen on
//       head; 2 compare exit 2; else 0.

//   STEP 6 (tests: test/run.test.mjs 'step 6' — deps injected; the e2e test gains a route table
//   and a mutant on its fake stack):
//     opts gain routes = true, mutants = 'named' ('named'|'affected'|'all'|'none'; rework 2026-11-12: 'named', the
//     default, runs only the planner's proposals that carry a kill test, each judged by that test). deps gain
//     { sweepSide, runVerb, credentials, mutate } (default: routes.mjs sweepSide, adapter.mjs
//     runVerb, login.mjs credentials, and mutate = the real mutants flow below).
//     mapHash also hashes the route table (profile.routes.table, else the first that exists of
//     qa/routes.table.json|.ts|.mjs) at `sha` like the seed names file, so a cached base sweep
//     is redone when the table changes.
//     Route sweep, diff mode, on each side that has a sandbox up (base fresh, head), after
//     captureSide and before down, when opts.routes and profile.routes?.enabled !== false:
//       actors = routeActors(…) (below); registered = runVerb('routes', { cwd: dir, vars }).json
//       when it is an array, else null; sweepSide({ root: dir, profile, baseUrl: actors.baseUrl ??
//       descriptor.appUrl, actors: actors.headers, expectations: head side only — the entries of the
//       run's expectations file that have a `route` key, else [], seed, seedName, registered }).
//       Step { side, verb: 'routes', ok: !notRun or notRun 'no route table' (nothing to sweep is not a failure), ms, note: notRun ?? '' }.
//       The base sweep is written to <base dir>/routes.json before the dir becomes the cache, and
//       read from C/routes.json on a cache hit (missing -> base sweep null). A live base -> null.
//       run.routes = diffRoutes(head sweep, base sweep); run.routeExpectations = head sweep's
//       expectations. routes off -> run.routes null, run.routeExpectations [].
//     routeActors({ profile, mainRoot, descriptor, vars, runVerb, credentials, env = process.env })
//       -> Promise<{ baseUrl: string | null, headers: { anon: {…}, <role>: {…} | { notRun } } }>
//       For 'anon' then each login role: runVerb('headers', { profile, mainRoot, cwd: descriptor.dir,
//       vars, args: [role], env: { QA_USER, QA_PASSWORD (credentials(role, …) for a role; unset for
//       anon; a notRun credential -> that role { notRun }), QA_STACK: JSON.stringify(descriptor.stack
//       ?? {}) } }). json { headers, baseUrl? } -> headers (the first baseUrl seen wins). Verb kind
//       none -> profile.routes.headers?.[role] = { Header: ENV_NAME }: each value from env (an unset
//       name -> { notRun: 'env <NAME> unset' }); no entry -> anon {}, a role { notRun: 'no headers
//       for <role>: no headers verb and no routes.headers' }. Verb exit non-zero -> { notRun:
//       'headers <role> exited <code>' }.
//     Mutants, diff mode, head side, after the sweep and before down, when opts.mutants !== 'none':
//       changed = git diff --name-only <baseSha> <headSha> in repoRoot; loadMutants({ root: dir,
//       profile, proposals: V/mutants.json when it exists }); selectMutants(mode opts.mutants);
//       nothing selected -> run.mutants = mutantsResult(null, …) and no step; else runMutants with
//       makeRunSuite({ dir, suites, profile, mainRoot, vars, logDir: V/logs, runVerb }) (each suite's own
//       timeoutMs, else profile.mutants.timeoutMs ?? 900000) and makeRunKill (the same args); mode 'named' adds
//       mutants.mjs unnamedNote of the proposals to the result's errors; step { side: 'head', verb: 'mutants', ok: true,
//       ms, note: '<killed>/<run> killed' }; a thrown 'restore failed' -> ok false, note = message,
//       run.mutants = null, a warning, and the head sandbox is downed as usual.
//     Run gains routes, routeExpectations, mutants; buildResults passes them through (summary.mjs).
//     exit 1 also when routes.new or routes.unlisted is non-empty, or mutants.survived or
//     mutants.stale is non-empty. Self mode: no sweep, no mutants (routes/mutants null).
//     deps.mutate({ dir, profile, mainRoot, vars, mode, changed, proposals, logDir, runVerb, log })
//       -> Promise<{ selected: n, result: MutantsResult }>: the flow above (selected 0 -> result =
//       mutantsResult(null, …)). opts.mutants other than named|affected|all|none -> RunError USAGE.
//     A sweep that throws, or a sweepSide that is notRun, never stops the run: the side is a
//     { notRun } SweepSide and a step with ok false. A mutate that throws (restore failed or any
//     other error) is a step with ok false, a warning and run.mutants null.

//   STEP 7 (tests: test/run.test.mjs 'step 7'; deps gain affected, mapAt, readSources, writeSources):
//     opts gain full = false and record = null ('journeys'|'all'|'none'|null).
//     Which screens, diff mode: opts.screens given -> those (affected null, mode 'screens');
//       opts.full -> every screen (mode 'full'); else mode 'affected': changed = git diff --name-only
//       <baseSha> <headSha>; head = loadMap of the head map (opts.map, else the head tree's
//       profile.map read at headSha with affected.mjs mapAt); base = mapAt(baseSha) (with opts.map,
//       base = the same map: the planner's entries are on disk, not in git); sources = readSources
//       of the map dir on disk (opts.map ?? <repoRoot>/<profile.map>); affectedScreens(...). Both
//       sides then capture only those names (onlyGlob). No affected screen -> no capture and no
//       compare on either side (steps note 'no affected screen'), the sweep and mutants still run,
//       and every screen-derived count is zero.
//       Self mode is always every screen (mode 'full', no affected).
//     run.affected = { mode, names, why, total, unknown, skipped: skipped.length } | null (screens mode).
//     record: opts.record ?? (mode 'affected' ? 'journeys' : 'none') is passed to captureSide on
//       both sides (captureSide passes it to capture()).
//     full: coverage true on the HEAD side only; after the head capture, for each area of the head
//       map: screens of that area that have a <W/head>/<vp>/<screen>__sources.json (union over
//       viewports) -> writeSources(<map dir on disk>, { area, screens, sha: headSha }); written
//       paths go in run.sourcesWritten ([]). (Rework: full no longer changes the mutants mode; it stays 'named'
//       unless opts.mutants says otherwise.)
//     run.videos: after the head capture, per viewport, per <screen>.webm in W/head/<vp>/:
//       { id: 'vid:<vp>/<screen>', viewport, screen, file (absolute), checkpoints: the parsed
//       <screen>.checkpoints.json or [] }; [] when none.
//     The base cache key (mapHash extra) gains { screens: the affected names (sorted) or null, record }.
//     Built as: planAffected({ repoRoot, profile, baseSha, headSha, map, seedNames, deps }) (exported; `qa
//       affected` uses it too) -> { affected: Affected | null, head, mapDir, changed } — null when the head
//       map cannot be read, and the run then walks every screen with a warning. No affected screen: both sides
//       get an empty SideResult (capture step ok, note 'no affected screen') and compare is a step with the
//       same note. Self mode and --full set run.affected { mode: 'full', names, why: {}, total, unknown: 0,
//       skipped: 0 } from the head map. A screen with a __sources.json (even []) is written to the sources file;
//       writeSources failing is a warning. --record without a value on the CLI means 'all'.

//   STEP 8 (tests: test/run.test.mjs 'step 8'):
//     opts gain baseline = false. Self mode with baseline: after compare, the standing items of
//     that compare (findings the two captures share = everything the head shows) are merged into
//     <repoRoot>/qa/standing.md exactly as diff mode does (slug, date); run.standing set. This is
//     the first-run standing baseline the qa skill records. Diff mode ignores baseline.

//   NEW ON HEAD (tests: test/new-on-head.test.mjs): diff mode, run.newEntries = affected.mjs
//     newMapEntries(head map, base map) — the head map as the affected set reads it (headMapOf), the base
//     map at baseSha (the head map itself when opts.map is given or neither commit carries a map, so {}).
//     planAffected also returns that base map. Self mode: {}. compare gets newScreens: run.newEntries
//     (compare.mjs NEW ON HEAD). A head failure of a screen in run.newEntries counts as new for the exit
//     even when base failed it too (base had no such entry). buildResults reads newEntries (summary.mjs).

//   TESTS (0.4.0; tests: test/tests.test.mjs 'runQa'): the expectations file's entries with a `test` key
//     (tests.mjs) are named tests qa runs itself. Diff mode, head side, after the route sweep and before the
//     mutants: run.tests = deps.runTests({ dir, at: headSha, entries, profile, mainRoot, vars, logDir: V/logs,
//     runVerb, side: 'head', log }), then tests.mjs withBase(…, base records); step { side: 'head', verb: 'tests',
//     ok: true, ms, note: '<met>/<n> met' } (a throw: ok false, every entry unverifiable 'not run: <message>',
//     a warning). No test entry: no step, run.tests []. Entries with base: true also run on the base sandbox
//     when it is brought up fresh (side 'base', at baseSha; written to <base dir>/tests.json, read back from
//     C/tests.json on a cache hit; the mapHash extra gains baseTests, their { name, suite, grep }, so a cache
//     made without them is not reused; file too when an entry has one); a cached base without the file or a live base -> each base record
//     { notRun: 'base cached before this test was asked for' | 'live base' }. buildResults appends their
//     expectations (summary.mjs). exit 1 also when a test is NOT MET; 2 (when nothing else applies) when one
//     is unverifiable. Self mode: none.

//   READY (0.5.0; tests: test/ready.test.mjs 'runQa'): before anything starts, run.readiness = deps.readiness ??
//     ready.mjs readiness({ repoRoot, mainRoot, profile }) of <repoRoot>/qa/ready.json. When it is not 'ready' its line
//     ('project not proven ready: …') is logged as 'warning: <line>' and summary.md carries it as a header line, so the
//     judge can tell an infrastructure gap from a product defect. It never blocks the run and never changes the exit.
//     In suites mode its line says 'no screens yet — qa ready applies once the map has entries' (ready.mjs).

//   DOCS (0.6.0; tests: test/docs.test.mjs):
//     The expectations file's entries with a `doc` key (docs.mjs) are checked in diff mode, before any sandbox,
//     against git at the head and base commits: run.docs = checkDocs({ entries, head: headSha, base: baseSha,
//     read: deps.readAt ?? `git show <sha>:<file>` in repoRoot (null when it fails) }); self mode: []. No step.
//     buildResults appends their expectations after the tests'. exit 1 also when a doc is NOT MET; 2 (when
//     nothing else applies) when one is unverifiable.

//   1.0.0 (tests: test/outcomes.test.mjs 'runQa'): a tool failure is BLOCKED, never a product failure, and the run goes on.
//     opts gain blocked = null and waivers = null. opts.blocked (a string) marks the run blocked before any sandbox:
//     run.blocked = 'BLOCKED ON INFRASTRUCTURE: <string>', nothing starts, exit 4. waivers: the text of the PR's waivers.md (the CLI finds it), passed to the draft.
//     compare throwing: run.compareError = its first line (results.compareError; a BLOCKED item in the draft), the
//     warning as before. runTests throwing: each record also gets toolError: true (BLOCKED, not UNVERIFIABLE).
//     The draft is draftVerdict(results, { security, charterMd: V/charter.md or null, waiversMd: opts.waivers }).
//     A blocked diff run (no sandbox) also writes V/verdict.md: the same draft with final: true, line 1
//     '# BLOCKED — <slug>', every charter row BLOCKED, so there is an outcome without a judge.

//   SCOPE (rework U4, design §7; tests: test/scope.test.mjs 'runQa'):
//     opts gain overlay = null (the PR's overlay folder, overlay.mjs; the CLI finds it) and slug-aware scoping.
//     profile.overlay is never read from opts.profile: the base side always reads the shared QA files (profile), the
//     head side reads them with the overlay on top (headProfile = { ...profile, overlay }): the head map, the head
//     capture, the head route sweep and maps.head; the base map, base capture, base sweep and maps.base never see it.
//     planAffected({ …, overlay, slug }) passes both on: head = headMapOf(headProfile), base = baseMapOf(profile) —
//     with --map or a map kept off the product branches the base map is the same one read WITHOUT the overlay, so the
//     overlay's new screens are new on head. affectedScreens gets the slug (the verifier's own entries are 'in
//     overlay'). run.affected gains mapThese (the out-of-scope screens with no known sources).
//     Base walks only changed screens: baseScreenNames({ affected, noAffected, baseMap, screens, newEntries }) — the
//     affected names (or, --full / --screens, the base map's) minus run.newEntries; a live base captures those too.
//     Base cache, per screen: C = <cache>/base-<baseSha 10>-<maps.base 12>, maps.base = mapHash at baseSha with extra
//     { checks, tour, record[, clock] } only — never the PR's screens, texts or tests — so every PR on the same base
//     shares C. C/meta.json { sha, mapHash, plugin, at, clock, screens: { <vp>: { <screen>: { keys, expect, at } } } }.
//     A screen is a hit when C has its entry and that entry's expect holds every text of this run (cache false: never a
//     hit, but C is still written). Only the misses are captured (their viewports, onlyGlob of their names, the run's
//     texts plus the texts their old entries had) into a temp dir; each one captured cleanly moves into C/<vp>/ and
//     its meta entry is replaced; a failed or NOT RUN screen is never cached. C/routes.json (the base sweep, whatever
//     it found, as before) and C/tests.json (base test records, each with key JSON [name, suite, grep, file])
//     are reused the same way. Nothing missing -> no base sandbox at all: run.base.cached true, sandboxes.base
//     'cached', a capture step noted 'cached'. The compare reads the view W/base/<vp>/: the wanted screens' files
//     linked from C (copied when a link fails), plus this run's failure files; run.sides.base lists their keys. A
//     re-verify on the same base walks base again only for screens it never walked cleanly with these texts.
//     A head sandbox the prepare check left up for the run (descriptor handOff) is taken down by the run, as one it
//     started. opts.blocked may also be { text } (the prepare check): run.blocked = 'BLOCKED: <text>', nothing starts.

//   STUBS (rework, design §6.1 rung 3; tests: test/stubs.test.mjs 'the run'): opts gain stubs = null ([id]: the stubs to
//     set; null: the ids V/charter.md's `stubs:` line names, stubs.mjs charterStubs). resolveStubs against the profile:
//     each undeclared id is a warning 'stub <id>: the charter names it, but qa.json stubs does not declare it — not set'
//     (and a switch two of them set differently: 'stubs: <NAME> is set by two of them; the last one wins'); the declared
//     ids go to deps.up as stubs on BOTH sides (the base walks with the same stand-ins as the head), run.stubs = them.
//     When there are any, the mapHash extras (head and the base cache key) gain stubs: [{ id, env }], so a base
//     captured without them is never reused. run.json gains stubs. Self mode: the same, on its one sandbox.

//   UNMAPPED: run.affected carries Affected.unmapped through (affected mode only; [] otherwise).
//     `qa affected` prints '- unmapped: <file>' per entry after the screens, and the totals line
//     gains ' · <k> changed UI file(s) no screen walks' when k > 0.

//   ROUNDS (rework U8, design §9; tests: test/rounds-run.test.mjs). opts gain round = null: this verify's round plan
//     (V/round.json, rounds.mjs planRound; the CLI reads it). It counts only in diff mode, without --screens, and when its
//     head is the run's head (a plan for another head is ignored: the run is as before and results gain no round).
//     An INCREMENTAL plan (of 'incremental', not with --full) narrows the run: the affected set becomes the plan's
//     screens (those in the head map and in the affected set: never a screen outside the PR's scope; why =
//     plan.screensWhy, mode still 'affected', so base walks them minus the new ones and record defaults to journeys);
//     the expectations file is read as only the plan's expectations (written to W/round-expectations.json, which
//     compare and the sweep read), so only those screen, test, route and doc rows run; the sweep is off unless
//     plan.routes, the mutants are 'none' unless plan.mutants. Any plan for this head: before results.json is written,
//     results = rounds.mjs carryInto(results, plan, { entries: entryKeys(head map) | null, qa: qaHashes({ root:
//     repoRoot, profile, overlay }) }): the carried rows join the results ('carried from <sha12> (round n)') and
//     results.round records the round, its map entries and QA hashes for the next one. summary.md, the draft and
//     run.exit read the merged results (the exit is the run's own: carried rows never change it).
//     A FULL plan for this head (or --full): a V/security.md older than V/round.json is an earlier round's review, which
//     this round did not run again (verify step 4 skipped it): after rotatePrev it moves to V/prev/security.md, so no
//     earlier High drafts a Blocker. An incremental round carries it (rounds.mjs security).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare as compareDirs } from './compare.mjs';
import { loadMap, selectScreens } from './map.mjs';
import { capture } from './capture.mjs';
import { loadPlaywright } from './playwright.mjs';
import * as sandbox from './sandbox.mjs';
import { mapAt as mapAtDefault, affectedScreens, newMapEntries, onlyGlob } from './affected.mjs';
import { readSources as readSourcesDefault, writeSources as writeSourcesDefault } from './sources.mjs';
import { standingItems, mergeStanding, readStanding } from './standing.mjs';
import { buildResults, summaryMd } from './summary.mjs';
import { draftVerdict, parseSecurity } from './verdict.mjs';
import { ensureVGitignore, git, gitOne, isProductChange, localDate } from './util.mjs';
import { runVerb as adapterRunVerb } from './adapter.mjs';
import { credentials as loginCredentials } from './login.mjs';
import { SIDE_FILE, diffRoutes, sweepSide as routesSweepSide } from './routes.mjs';
import { OVERLAY_ROUTES } from './overlay.mjs';
import { loadMutants, selectMutants, runMutants, makeRunSuite, makeRunKill, mutantsResult, unnamedNote, MUTANT_MODES } from './mutants.mjs';
import { runTests as runTestsDefault, testEntries, withBase } from './tests.mjs';
import { readiness as readinessDefault } from './ready.mjs';
import { checkDocs, docEntries } from './docs.mjs';
import { charterStubs, resolveStubs } from './stubs.mjs';
import { carryInto, entryKeys, qaHashes } from './rounds.mjs';
import { suitesModeApplies, withHeadWorktree, runSuites } from './suitesmode.mjs';

const PLUGIN_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json');
const BLOCKED_PREFIX = 'BLOCKED ON INFRASTRUCTURE: ';
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RunError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// The branch name with every character outside [A-Za-z0-9._-] made '-'; a detached HEAD (or no branch) is head-<sha10>.
export const PREV_FILES = Object.freeze(['results.json', 'summary.md', 'verdict.draft.md', 'verdict.md', 'eyes.md', 'eyes-prompt.md', 'report.html', 'shots']);

// Keeps the previous round's files in V/prev when a new head is run (U8: rounds.json is the record; prev is for reading).
export function rotatePrev(V, headSha) {
  let prevResults;
  try {
    prevResults = JSON.parse(fs.readFileSync(path.join(V, 'results.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!['diff', 'suites'].includes(prevResults?.mode) || prevResults?.head?.sha === headSha) return [];
  return moveToPrev(V);
}

// V/security.md older than this head's V/round.json was written in an earlier round (the review of this round is written
// after its plan): it goes to V/prev, so no earlier High drafts a Blocker in a full round that did not review again.
function staleSecurityToPrev(V) {
  const file = path.join(V, 'security.md');
  const plan = path.join(V, 'round.json');
  let older;
  try { older = fs.statSync(file).mtimeMs < fs.statSync(plan).mtimeMs; } catch { return; }
  if (!older) return;
  fs.mkdirSync(path.join(V, 'prev'), { recursive: true });
  fs.renameSync(file, path.join(V, 'prev', 'security.md'));
}

export function moveToPrev(V) {
  if (!fs.existsSync(V)) return [];
  const prev = path.join(V, 'prev');
  fs.rmSync(prev, { recursive: true, force: true });
  fs.mkdirSync(prev, { recursive: true });
  const moved = [];
  for (const name of PREV_FILES) {
    if (!fs.existsSync(path.join(V, name))) continue;
    fs.renameSync(path.join(V, name), path.join(prev, name));
    moved.push(name);
  }
  return moved;
}

// STEP 8, `qa run --json` (CI mode): the one JSON object printed on stdout, and the exit code it
// stands for. results = run.results; draft = draftVerdict(results) (null in self mode, which has no
// verdict); V = <repoRoot>/qa/<slug>. Exit: 4 blocked, 3 a screen NOT RUN, 1 a Blocker
// finding (a self-test: the two captures differ), else 0 — Majors alone need a judge, so they do not
// fail CI.
export function ciSummary(results, draft, V) {
  const idsOf = (severity) => (draft?.findings ?? []).filter((f) => f.severity === severity).map((f) => f.id);
  const blockers = idsOf('Blocker');
  const majors = idsOf('Major');
  const exit = results.blocked ? 4
    : results.mode === 'suites' ? results.exit
    : results.notRun?.length ? 3
      : draft === null ? (results.exit ? 1 : 0)
        : blockers.length ? 1 : 0;
  return { exit, verdict: draft ? draft.verdict : null, blockers, majors, summary: path.join(V, 'summary.md') };
}

// The slug of a branch: its name with every character outside [A-Za-z0-9._-] as '-' (B01/library -> B01-library),
// qa/<slug>/ being where its verdict lives; a detached HEAD is head-<sha10>.
export function slugOf(branch, sha) {
  if (!branch || branch === 'HEAD') return `head-${String(sha ?? '').slice(0, 10)}`;
  return branch.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function resolveClock(want, seedStartedAt) {
  want ??= 'seed';
  if (want === 'off') return { clock: null, why: 'real clock (off)' };
  if (want === 'seed') return seedStartedAt ? { clock: seedStartedAt, why: `frozen at ${seedStartedAt} (seed start)` } : { clock: null, why: 'real clock (no seed start known)' };
  if (Number.isNaN(Date.parse(want))) throw new RunError('USAGE', `clock must be seed, off or an ISO time, not "${want}"`);
  return { clock: want, why: `frozen at ${want}` };
}

export async function captureSide({
  mainRoot, profile, baseUrl, cwd, vars, out, viewports = null, screens = null, map = null, seedNames = null,
  checks = true, tour = true, clock = null, seedStartedAt = null, headless = true, record = false, coverage = false, pw = null, log = console.error, expectTexts = [],
}) {
  const started = Date.now();
  const p = { ...profile };
  if (typeof map === 'string') p.map = map;
  if (typeof seedNames === 'string') p.seedNames = seedNames;
  const loaded = loadMap({ root: cwd, profile: p });
  if (!loaded.screens.length) log(`warning: no screens in ${path.resolve(cwd, p.map)}`);
  for (const e of loaded.errors) log(`warning: map: ${e}`);
  const resolved = resolveClock(clock ?? profile.clock ?? 'seed', seedStartedAt);
  pw ??= loadPlaywright(mainRoot);
  const result = { viewports: [], clock: resolved, mapErrors: [...loaded.errors], ms: 0 };
  for (const viewport of viewports ?? Object.keys(profile.viewports)) {
    const picked = selectScreens(loaded.screens, { only: typeof screens === 'string' ? screens : null, viewport });
    const r = await capture({
      profile: p, mainRoot, baseUrl, screens: picked, out, viewport, record, coverage, headless, cwd, vars, pw, log: (...a) => log(...a),
      checks, tour, expectTexts, clock: resolved.clock, flows: loaded.flows, seed: loaded.seed, seedFile: loaded.seedFile,
    });
    result.viewports.push(r);
  }
  result.ms = Date.now() - started;
  return result;
}

// ── mapHash ───────────────────────────────────────────────────────────────────

function lsTree(repoRoot, sha, target) {
  let raw;
  try {
    raw = execFileSync('git', ['ls-tree', '-r', '-z', sha, '--', target], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  return raw.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]];
  });
}

function diskFiles(target, prefix = '') {
  if (!fs.existsSync(target)) return [];
  if (!fs.statSync(target).isDirectory()) return [[prefix || path.basename(target), fs.readFileSync(target)]];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) return diskFiles(path.join(target, d.name), rel);
    return d.isFile() ? [[rel, fs.readFileSync(path.join(target, d.name))]] : [];
  });
}

// The files of `rel` at `sha` (git), or on disk when there is no sha, or when `offSha` (the commit carries no map at
// all: a project that keeps its QA files untracked); `override` (an absolute path) is
// always read from disk.
function fingerprint(repoRoot, sha, rel, override, offSha = false) {
  const resolved = override ?? (sha && !offSha ? null : path.resolve(repoRoot, rel));
  const files = resolved
    ? diskFiles(resolved).map(([p, bytes]) => [p, createHash('sha1').update(bytes).digest('hex')])
    : lsTree(repoRoot, sha, rel);
  return files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const ROUTE_TABLES = ['qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs'];
const RECORD_MODES = ['journeys', 'all', 'none'];

export function mapHash({ repoRoot, sha = null, profile, map = null, seedNames = null, extra = {} }) {
  const hash = createHash('sha256');
  const mapDir = profile.map ?? 'qa/map';
  const seedFile = profile.seedNames ?? 'qa/seed.json';
  // A commit with no map: its QA files live off the branch, so the checkout's copy is what both sides walk.
  const offSha = Boolean(sha) && !map && !lsTree(repoRoot, sha, mapDir).length;
  for (const [file, id] of fingerprint(repoRoot, sha, mapDir, map, offSha)) hash.update(`${file}\0${id}\0`);
  for (const [file, id] of fingerprint(repoRoot, sha, seedFile, seedNames, offSha)) hash.update(`${file}\0${id}\0`);
  for (const rel of profile.routes?.table ? [profile.routes.table] : ROUTE_TABLES) {
    const found = fingerprint(repoRoot, sha, rel, null, offSha);
    if (!found.length) continue;
    for (const [file, id] of found) hash.update(`${file}\0${id}\0`);
    break;
  }
  // The route side file (rows kept beside a code table), and the run's overlay when it has one.
  for (const [file, id] of fingerprint(repoRoot, sha, SIDE_FILE, null, offSha)) hash.update(`side:${file}\0${id}\0`);
  if (typeof profile.overlay === 'string' && profile.overlay) {
    for (const rel of ['map', OVERLAY_ROUTES]) {
      const abs = path.join(profile.overlay, rel);
      for (const [file, id] of fingerprint(repoRoot, null, rel, abs)) hash.update(`overlay:${rel}/${file}\0${id}\0`);
    }
  }
  const { viewports, watch, checks, tour, clock, settle, login, maxElementsPerCapture, stepTimeoutMs, browser, writes } = profile;
  hash.update(JSON.stringify({ viewports, watch, checks, tour, clock, settle, login, maxElementsPerCapture, stepTimeoutMs, browser, writes }));
  hash.update(String(pluginVersion()));
  hash.update(JSON.stringify(extra));
  return hash.digest('hex');
}

// ── runQa ─────────────────────────────────────────────────────────────────────

const sideKeys = (side) => new Set((side?.viewports ?? []).flatMap((v) => v.failed.map((f) => `${v.viewport}\0${f.screen}`)));

// A file's text at a commit, or null when the commit does not hold it.
function showAt(repoRoot, sha, file) {
  if (!sha) return null;
  try {
    return execFileSync('git', ['show', `${sha}:${file}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resolveRefs({ repoRoot, head, base, self }) {
  const sha = (ref) => gitOne(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot });
  const headSha = sha(head);
  if (!headSha) throw new RunError('USAGE', `unknown ref ${head}`);
  if (self) return { headSha, baseSha: null, baseRef: null };
  let baseSha = null;
  let baseRef = base;
  if (base) {
    baseSha = sha(base);
    if (!baseSha) throw new RunError('USAGE', `unknown ref ${base}`);
  } else {
    const originHead = gitOne(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot });
    for (const candidate of [originHead, 'main', 'master'].filter(Boolean)) {
      const tip = sha(candidate);
      if (!tip) continue;
      baseSha = gitOne(['merge-base', headSha, tip], { cwd: repoRoot });
      if (baseSha) { baseRef = candidate; break; }
    }
    if (!baseSha) throw new RunError('USAGE', 'no base branch; pass --base <ref>');
  }
  if (baseSha === headSha) throw new RunError('USAGE', `base and head are the same commit (${headSha.slice(0, 12)}); --self runs the determinism self-test`);
  return { headSha, baseSha, baseRef };
}

function pruneCache(cacheRoot, keep, current) {
  let names;
  try {
    names = fs.readdirSync(cacheRoot);
  } catch {
    return;
  }
  const now = Date.now();
  const entries = [];
  for (const name of names) {
    const dir = path.join(cacheRoot, name);
    try {
      if (name.startsWith('.tmp-')) {
        if (now - fs.statSync(dir).mtimeMs > 24 * 3600 * 1000) fs.rmSync(dir, { recursive: true, force: true });
      } else if (name.startsWith('base-') && dir !== current) {
        entries.push({ dir, at: fs.statSync(path.join(dir, 'meta.json')).mtimeMs });
      }
    } catch { /* not a cache entry we can date: leave it */ }
  }
  entries.sort((a, b) => b.at - a.at);
  for (const old of entries.slice(Math.max(0, keep - 1))) fs.rmSync(old.dir, { recursive: true, force: true });
}

// ── route actors and mutants (step 6) ─────────────────────────────────────────

// Who the route sweep acts as: the request headers of anon and each login role.
export async function routeActors({ profile, mainRoot, descriptor, vars, runVerb = adapterRunVerb, credentials = loginCredentials, env = process.env }) {
  const configured = (role) => profile.routes?.headers?.[role] ?? null;
  const fromEnv = (map) => {
    const out = {};
    for (const [header, name] of Object.entries(map)) {
      if (env[name] === undefined || env[name] === '') return { notRun: `env ${name} unset` };
      out[header] = env[name];
    }
    return out;
  };
  const fallback = (role) => {
    if (configured(role)) return fromEnv(configured(role));
    return role === 'anon' ? {} : { notRun: `no headers for ${role}: no headers verb and no routes.headers` };
  };
  const headers = {};
  let baseUrl = null;
  for (const role of ['anon', ...Object.keys(profile.login ?? {})]) {
    let cred = null;
    if (role !== 'anon') {
      try {
        cred = await credentials(role, { profile, mainRoot, cwd: descriptor.dir, vars, runVerb });
      } catch (e) {
        cred = { notRun: `login ${role}: ${firstLine(e)}` };
      }
      if (cred?.notRun && !configured(role)) {
        headers[role] = { notRun: cred.notRun };
        continue;
      }
    }
    const verbEnv = { QA_STACK: JSON.stringify(descriptor.stack ?? {}) };
    if (cred && !cred.notRun) {
      verbEnv.QA_USER = cred.user;
      verbEnv.QA_PASSWORD = cred.password;
    }
    let res;
    try {
      res = await runVerb('headers', { profile, mainRoot, cwd: descriptor.dir, vars, args: [role], env: verbEnv });
    } catch (e) {
      headers[role] = { notRun: `headers ${role}: ${firstLine(e)}` };
      continue;
    }
    if (res?.notRun) headers[role] = fallback(role);
    else if (cred?.notRun) headers[role] = { notRun: cred.notRun };
    else if (res?.code) headers[role] = { notRun: `headers ${role} exited ${res.code}` };
    else if (!res?.json || typeof res.json.headers !== 'object' || res.json.headers === null || Array.isArray(res.json.headers)) {
      headers[role] = { notRun: `headers ${role}: no { headers } on the last line` };
    } else {
      headers[role] = res.json.headers;
      if (baseUrl === null && typeof res.json.baseUrl === 'string' && res.json.baseUrl) baseUrl = res.json.baseUrl;
    }
  }
  return { baseUrl, headers };
}

// The real mutants flow on the head tree: registry plus proposals, the selected ones run one by one. Mode 'named'
// (the default) runs only the proposals that name their killing test, each judged by that one test.
async function realMutate({ dir, profile, mainRoot, vars, mode, changed, proposals, logDir, runVerb, log }) {
  const loaded = await loadMutants({ root: dir, profile, proposals });
  const selected = selectMutants(loaded.mutants, { mode, changed });
  const errors = [...loaded.errors, ...(mode === 'named' ? unnamedNote(loaded.mutants, proposals) : [])];
  const info = { mode, file: loaded.file, errors };
  if (!selected.length) return { selected: 0, result: mutantsResult(null, info) };
  const runSuite = makeRunSuite({ dir, suites: loaded.suites, profile, mainRoot, vars, logDir, runVerb });
  const runKill = makeRunKill({ dir, suites: loaded.suites, profile, mainRoot, vars, logDir, runVerb });
  const ran = await runMutants({ dir, mutants: selected, suites: loaded.suites, runSuite, runKill, log });
  return { selected: selected.length, result: mutantsResult(ran, info) };
}

// ── affected set, sources and videos (step 7) ────────────────────────────────

// The checkout's map on disk, for a commit that carries none (QA files kept off the product branches). null when
// there is none on disk either.
function diskMap(repoRoot, profile) {
  if (!fs.existsSync(path.resolve(repoRoot, profile.map ?? 'qa/map'))) return null;
  try {
    return loadMap({ root: repoRoot, profile: { ...profile, map: profile.map ?? 'qa/map' } });
  } catch {
    return null;
  }
}

// The head tree's map: the directory given on disk (opts.map), else the profile map as it was at `sha`
// (affected.mjs mapAt), else the checkout's map on disk (the commit carries none). null when it cannot be read.
async function headMapOf({ repoRoot, profile, sha, map, seedNames, mapAt }) {
  if (typeof map === 'string') {
    const p = { ...profile, map };
    if (typeof seedNames === 'string') p.seedNames = seedNames;
    try {
      return loadMap({ root: repoRoot, profile: p });
    } catch {
      return null;
    }
  }
  let atSha = null;
  try {
    atSha = (await mapAt({ repoRoot, sha, mapDir: profile.map ?? 'qa/map', seedNames: profile.seedNames ?? 'qa/seed.json', profile })) ?? null;
  } catch {
    atSha = null;
  }
  return atSha ?? diskMap(repoRoot, profile);
}

// The profile without the run's overlay: what the base side reads (the shared QA files, never the PR's overlay).
export function withoutOverlay(profile) {
  if (!profile || profile.overlay === undefined) return profile;
  const { overlay, ...plain } = profile;
  void overlay;
  return plain;
}

// What an affected run would walk: { affected: Affected | null, head, base, mapDir, changed }. affected is null when
// the head map cannot be read (the caller then walks every screen). Used by runQa and `qa affected`. overlay: the
// PR's overlay folder (overlay.mjs), read on top of the head map only; slug: the run's, for the verifier's own entries.
export async function planAffected({ repoRoot, profile, baseSha, headSha, map = null, seedNames = null, overlay = null, slug = null, deps = {} }) {
  const mapAt = deps.mapAt ?? mapAtDefault;
  const readSources = deps.readSources ?? readSourcesDefault;
  const affectedOf = deps.affected ?? affectedScreens;
  const plain = withoutOverlay(profile);
  const headProfile = overlay ? { ...plain, overlay } : plain;
  const mapDir = typeof map === 'string' ? map : path.resolve(repoRoot, profile.map ?? 'qa/map');
  const head = await headMapOf({ repoRoot, profile: headProfile, sha: headSha, map, seedNames, mapAt });
  if (!head) return { affected: null, head: null, mapDir, changed: [] };
  const base = await baseMapOf({ repoRoot, profile: plain, baseSha, headSha, map, seedNames, head, mapAt });
  const changed = (git(['-c', 'core.quotepath=false', 'diff', '--name-only', baseSha, headSha], { cwd: repoRoot }) ?? []).filter(isProductChange);
  const sources = (await readSources(mapDir)) ?? {};
  return { affected: await affectedOf({ head, base, changed, sources, profile: plain, slug }), head, base, mapDir, changed };
}

// The base tree's map, never with the PR's overlay: the head map itself when the map is given on disk (opts.map) or
// neither commit carries one (it lives off the product branches, so both sides walk the one on disk) — read again
// without the overlay when the head map has one; else the profile map as it was at baseSha (null when base carries
// none or it cannot be read).
async function baseMapOf({ repoRoot, profile, baseSha, headSha, map, seedNames = null, head, mapAt }) {
  const plain = withoutOverlay(profile);
  const sameAsHead = async () => (head?.overlay ? headMapOf({ repoRoot, profile: plain, sha: headSha, map, seedNames, mapAt: async () => null }) : head);
  if (typeof map === 'string') return sameAsHead();
  let base;
  try {
    base = (await mapAt({ repoRoot, sha: baseSha, mapDir: plain.map ?? 'qa/map', seedNames: plain.seedNames ?? 'qa/seed.json', profile: plain })) ?? null;
  } catch {
    base = null;
  }
  if (base === null && !lsTree(repoRoot, headSha, plain.map ?? 'qa/map').length) base = await sameAsHead();
  return base;
}

// The .webm files of one captured side, per viewport, with the checkpoints beside each.
function videosIn(dir, viewportNames) {
  const out = [];
  for (const viewport of viewportNames) {
    let names;
    try {
      names = fs.readdirSync(path.join(dir, viewport)).filter((n) => n.endsWith('.webm')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const screen = name.slice(0, -'.webm'.length);
      const checkpoints = readJson(path.join(dir, viewport, `${screen}.checkpoints.json`));
      out.push({ id: `vid:${viewport}/${screen}`, viewport, screen, file: path.join(dir, viewport, name), checkpoints: Array.isArray(checkpoints) ? checkpoints : [] });
    }
  }
  return out;
}

// Per area of the head map, the sources the head capture recorded for its screens (union over viewports).
function recordedSources(dir, viewportNames, headMap) {
  const areas = new Map();
  for (const screen of headMap?.screens ?? []) {
    if (typeof screen?.name !== 'string') continue;
    const files = new Set();
    let seen = false;
    for (const viewport of viewportNames) {
      const list = readJson(path.join(dir, viewport, `${screen.name}__sources.json`));
      if (!Array.isArray(list)) continue;
      seen = true;
      for (const f of list) if (typeof f === 'string') files.add(f);
    }
    if (!seen) continue;
    if (!areas.has(screen.area)) areas.set(screen.area, {});
    areas.get(screen.area)[screen.name] = [...files].sort();
  }
  return areas;
}

// ── the base cache, per screen (rework U4, design §7) ───────────────────────────

// The base screens a run walks: the affected ones (or, --full and --screens, those of the base map) that are not new on
// head — a new screen has no before picture and is judged on head alone. null: no base map to name them by.
export function baseScreenNames({ affected = null, noAffected = false, baseMap = null, screens = null, newEntries = {} }) {
  if (noAffected) return [];
  const isNew = (n) => Object.hasOwn(newEntries ?? {}, n);
  if (affected?.mode === 'affected') return affected.names.filter((n) => !isNew(n));
  if (!baseMap) return null;
  const picked = selectScreens(baseMap.screens ?? [], { only: typeof screens === 'string' ? screens : null });
  return [...new Set(picked.map((x) => x.name).filter((n) => typeof n === 'string' && !isNew(n)))];
}

// C/meta.json: { sha, mapHash, plugin, at, clock, screens: { <vp>: { <screen>: { keys, expect, at } } } }. A missing or
// older (whole-side) meta has no screens.
function readMeta(C) {
  const meta = readJson(path.join(C, 'meta.json'));
  return meta && typeof meta === 'object' ? { ...meta, screens: meta.screens && typeof meta.screens === 'object' ? meta.screens : {} } : { screens: {} };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function writeMeta(C, meta) {
  const { complete, side, ...rest } = meta;
  void complete; void side;
  writeJsonAtomic(path.join(C, 'meta.json'), rest);
}

// The screen a capture key or file belongs to: the longest name it starts with ('<screen>__…', '<screen>.webm',
// '<screen>.checkpoints.json'); null for none.
function ownerOf(file, names) {
  let best = null;
  for (const n of names) {
    if (file === n || file.startsWith(`${n}__`) || file === `${n}.webm` || file === `${n}.checkpoints.json`) {
      if (best === null || n.length > best.length) best = n;
    }
  }
  return best;
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// Each screen the miss capture got cleanly (captured, not failed, not NOT RUN) moves into C, replacing what C had for
// it; meta records its keys and the texts it was captured with. A failed screen is never cached.
function storeScreens({ C, meta, side, dir, names, texts, at }) {
  for (const v of side?.viewports ?? []) {
    const bad = new Set([...(v.failed ?? []).map((f) => f.screen), ...(v.notRun ?? []).map((n) => n.screen)]);
    const keysOf = new Map();
    for (const key of v.captured ?? []) {
      const owner = ownerOf(key, names);
      if (owner && !bad.has(owner)) (keysOf.get(owner) ?? keysOf.set(owner, []).get(owner)).push(key);
    }
    if (!keysOf.size) continue;
    const src = path.join(dir, v.viewport);
    const dest = path.join(C, v.viewport);
    fs.mkdirSync(dest, { recursive: true });
    const known = [...new Set([...names, ...Object.keys(meta.screens[v.viewport] ?? {})])];
    for (const f of listDir(dest)) if (keysOf.has(ownerOf(f, known))) fs.rmSync(path.join(dest, f), { force: true });
    for (const f of listDir(src)) if (keysOf.has(ownerOf(f, names))) fs.renameSync(path.join(src, f), path.join(dest, f));
    meta.screens[v.viewport] ??= {};
    for (const [name, keys] of keysOf) meta.screens[v.viewport][name] = { keys, expect: texts, at };
  }
}

// The run's base view: per viewport, the files of every screen it wants, linked from C (or, a screen that failed in
// this run, copied from the miss capture), and the SideResult that says so.
function assembleBase({ C, meta, view, vps, perVp, fresh, ms }) {
  fs.rmSync(view, { recursive: true, force: true });
  const viewports = [];
  for (const vp of vps) {
    const out = path.join(view, vp);
    fs.mkdirSync(out, { recursive: true });
    const freshVp = (fresh.side?.viewports ?? []).find((v) => v.viewport === vp) ?? null;
    const failedHere = new Set([...(freshVp?.failed ?? []).map((f) => f.screen), ...(freshVp?.notRun ?? []).map((n) => n.screen)]);
    const names = perVp[vp] ?? [];
    const captured = [];
    const fromCache = names.filter((n) => !failedHere.has(n) && meta.screens?.[vp]?.[n]);
    const cachedNames = [...new Set([...names, ...Object.keys(meta.screens?.[vp] ?? {})])];
    for (const f of listDir(path.join(C, vp))) {
      const owner = ownerOf(f, cachedNames);
      if (!fromCache.includes(owner)) continue;
      try {
        fs.linkSync(path.join(C, vp, f), path.join(out, f));
      } catch {
        fs.copyFileSync(path.join(C, vp, f), path.join(out, f));
      }
    }
    for (const n of fromCache) captured.push(...(meta.screens[vp][n].keys ?? []));
    if (fresh.dir && failedHere.size) {
      for (const f of listDir(path.join(fresh.dir, vp))) {
        if (failedHere.has(ownerOf(f, names))) fs.copyFileSync(path.join(fresh.dir, vp, f), path.join(out, f));
      }
    }
    viewports.push({ viewport: vp, captured, failed: freshVp?.failed ?? [], notRun: freshVp?.notRun ?? [], warnings: freshVp?.warnings ?? [] });
  }
  return { viewports, clock: fresh.side?.clock ?? meta.clock ?? { clock: null, why: 'from the base cache' }, mapErrors: fresh.side?.mapErrors ?? [], ms };
}

const emptySweep = (notRun) => ({ file: null, rows: 0, registered: null, probes: [], unlisted: [], stale: [], errors: [], notRun, expectations: [] });

export async function runQa(opts, deps = {}) {
  const { mainRoot, repoRoot } = opts;
  // The base side reads the shared QA files; the head side reads them with the PR's overlay on top (rework U4).
  const profile = withoutOverlay(opts.profile);
  const overlay = typeof opts.overlay === 'string' && opts.overlay ? opts.overlay : null;
  const headProfile = overlay ? { ...profile, overlay } : profile;
  const head = opts.head ?? 'HEAD';
  const self = Boolean(opts.self);
  const { viewports = null, screens = null, map = null, seedNames = null, clock = null, headless = true } = opts;
  const full = Boolean(opts.full);
  const cache = opts.cache !== false;
  const checks = opts.checks !== false;
  const tour = opts.tour !== false;
  const log = opts.log ?? console.error;
  const d = {
    up: sandbox.up, down: sandbox.down, othersUsing: sandbox.othersUsing, captureSide, compare: compareDirs, sleep: sleepMs, now: () => new Date(),
    sweepSide: routesSweepSide, runVerb: adapterRunVerb, credentials: loginCredentials, mutate: realMutate,
    affected: affectedScreens, mapAt: mapAtDefault, readSources: readSourcesDefault, writeSources: writeSourcesDefault,
    runTests: runTestsDefault, readAt: (sha, file) => showAt(repoRoot, sha, file), ...deps,
  };
  // Mutants are off unless the planner named one with its killing test (rework, design §17 item 3); --full no longer
  // turns the registry on: `--mutants all` does.
  let mutantsMode = opts.mutants ?? 'named';
  if (!MUTANT_MODES.includes(mutantsMode)) throw new RunError('USAGE', `mutants must be named, affected, all or none, not "${mutantsMode}"`);
  if (opts.record !== undefined && opts.record !== null && !RECORD_MODES.includes(opts.record)) throw new RunError('USAGE', `record must be journeys, all or none, not "${opts.record}"`);
  if (full && screens) throw new RunError('USAGE', 'pick --full or --screens, not both');
  let routesOn = !self && opts.routes !== false && profile.routes?.enabled !== false;
  const startedAt = d.now();

  // 1. Resolve (every USAGE is thrown here, before anything starts).
  // SUITES MODE: no map entries and no stack adapter serves an app, so the evidence is the project's own test suites,
  // run whole on the head commit (suitesmode.mjs). Its base is only the docs' other side: a missing one is not an error.
  let suitesMode = false;
  let suitesWhy = '';
  let refs = null;
  if (!self && !screens && opts.suites !== false) {
    const headOnly = resolveRefs({ repoRoot, head, base: null, self: true });
    const fit = suitesModeApplies({ repoRoot, mainRoot, profile, map });
    if (fit.applies) {
      suitesMode = true;
      suitesWhy = fit.why;
      try {
        refs = resolveRefs({ repoRoot, head, base: opts.base ?? null, self });
      } catch (e) {
        // A base the person named must exist; a default one that cannot be found just means the docs have no other side.
        if (!(e instanceof RunError) || opts.base) throw e;
        refs = { headSha: headOnly.headSha, baseSha: null, baseRef: null };
      }
    }
  }
  const { headSha, baseSha, baseRef } = refs ?? resolveRefs({ repoRoot, head, base: opts.base ?? null, self });
  if (suitesMode && opts.mutants === undefined) mutantsMode = 'all';
  // ROUNDS (U8): this head's round plan; an incremental one runs only its rows and walks only its screens.
  const round = !self && !suitesMode && !screens && opts.round && typeof opts.round === 'object' && opts.round.head === headSha ? opts.round : null;
  const incremental = !full && round?.of === 'incremental' && Array.isArray(round.screens) && Array.isArray(round.expectations);
  if (incremental && !round.routes) routesOn = false;
  if (incremental && !round.mutants) mutantsMode = 'none';
  for (const v of viewports ?? []) {
    if (!profile.viewports?.[v]) throw new RunError('USAGE', `unknown viewport "${v}": the profile has ${Object.keys(profile.viewports ?? {}).join(', ')}`);
  }
  if (clock) resolveClock(clock, null);
  const slug = opts.slug ?? slugOf(gitOne(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }), headSha);
  const warnings = [];
  const preBlocked = typeof opts.blocked === 'string' ? opts.blocked : null;
  // A block that is not the machine's (the prepare check: the PR's QA files could not be proven) is said as it is.
  const ownBlock = opts.blocked && typeof opts.blocked === 'object' && typeof opts.blocked.text === 'string' ? `BLOCKED: ${opts.blocked.text}` : null;
  // The run's own folder (qa/<slug>/, committed by design) is not a change to the product.
  const dirty = (git(['status', '--porcelain'], { cwd: repoRoot }) ?? []).filter((l) => !l.slice(3).startsWith(`qa/${slug}/`));
  if (dirty.length) warnings.push('uncommitted changes are not in the run: it captures commits');
  // Is the project proven ready for a verify (qa/ready.json)? A gap there is infrastructure, not the PR: warn, never block.
  let readiness = null;
  try {
    readiness = (d.readiness ?? readinessDefault)({ repoRoot, mainRoot, profile, map: typeof map === 'string' ? map : null });
  } catch (e) {
    readiness = { state: 'missing', why: [`qa/ready.json: ${firstLine(e)}`], line: `project not proven ready: qa/ready.json: ${firstLine(e)}` };
  }
  if (readiness?.line) log(`warning: ${readiness.line}`);

  // Which screens: --screens as given; every screen for --full and for a self-test; else the affected set.
  let screenArg = screens || null;
  let headMap = null;
  let mapDirOnDisk = typeof map === 'string' ? map : path.resolve(repoRoot, profile.map ?? 'qa/map');
  let baseMap;
  let affected = null;
  let noAffected = false;
  if (suitesMode) {
    noAffected = true;
  } else if (!screens && (full || self)) {
    headMap = await headMapOf({ repoRoot, profile: headProfile, sha: headSha, map, seedNames, mapAt: d.mapAt });
    const names = [...new Set((headMap?.screens ?? []).map((s) => s.name))];
    affected = headMap ? { mode: 'full', names, why: {}, total: (headMap.screens ?? []).length, unknown: 0, skipped: 0 } : null;
  } else if (!screens) {
    const plan = await planAffected({ repoRoot, profile, baseSha, headSha, map, seedNames, overlay, slug, deps: d });
    mapDirOnDisk = plan.mapDir;
    headMap = plan.head;
    baseMap = plan.base;
    if (plan.affected) {
      const a = plan.affected;
      affected = { mode: 'affected', names: a.names, why: a.why, total: a.total, unknown: a.unknown, mapThese: a.mapThese ?? [], skipped: a.skipped.length, unmapped: a.unmapped ?? [] };
      noAffected = a.names.length === 0;
      if (!noAffected) screenArg = onlyGlob(a.names);
      if (incremental) {
        // The round's screens, not the PR's whole affected set (the rest of the rows are carried), and never a screen
        // outside it: the round walks only the PR's scope.
        const names = round.screens.filter((n) => a.names.includes(n) && (headMap?.screens ?? []).some((x) => x.name === n));
        affected = { ...affected, names, why: Object.fromEntries(names.map((n) => [n, round.screensWhy?.[n] ?? `round ${round.round}`])), round: round.round };
        noAffected = names.length === 0;
        screenArg = noAffected ? null : onlyGlob(names);
      }
    } else {
      warnings.push('affected: the head map could not be read; every screen is walked');
    }
  }
  const recordMode = opts.record ?? (affected?.mode === 'affected' ? 'journeys' : 'none');
  // NEW ON HEAD: the screens whose map entry is new between base and head are judged on head alone. A changed entry
  // keeps its before/after diff: that diff is how a regression on an existing screen is caught.
  let newEntries = {};
  if (!self && !suitesMode) {
    if (baseMap === undefined) {
      headMap ??= await headMapOf({ repoRoot, profile: headProfile, sha: headSha, map, seedNames, mapAt: d.mapAt });
      baseMap = headMap ? await baseMapOf({ repoRoot, profile, baseSha, headSha, map, seedNames, head: headMap, mapAt: d.mapAt }) : null;
    }
    newEntries = newMapEntries(headMap, baseMap);
  }

  // 2. Dirs and map hashes.
  const V = opts.out ?? path.join(repoRoot, 'qa', slug);
  const W = path.join(mainRoot, 'qa-artifacts', 'runs', slug);
  const cacheRoot = path.join(mainRoot, 'qa-artifacts', 'cache');
  let expect = opts.expect ?? (fs.existsSync(path.join(V, 'expectations.json')) ? path.join(V, 'expectations.json') : null);
  // The texts the expectations look for: both sides capture the elements that carry them (capture.mjs expectTexts).
  let expectList = expect ? readJson(expect) : null;
  // An incremental round runs only its own rows (the plan's expectations); the others are carried.
  if (incremental && Array.isArray(expectList)) {
    const keep = new Set(round.expectations);
    expectList = expectList.filter((e) => keep.has(e?.name));
  }
  const expectTexts = [...new Set((Array.isArray(expectList) ? expectList : []).filter((e) => typeof e?.text === 'string' && e.route === undefined && e.db === undefined && e.mail === undefined && e.test === undefined && e.doc === undefined && !e.url && !e.urlPattern).map((e) => e.text))];
  // Named tests qa runs itself (tests.mjs); those with base: true run on a fresh base sandbox too.
  const testList = self ? [] : testEntries(expectList);
  const baseTestList = testList.filter((e) => e.base === true || e.test?.base === true);
  const baseTests = baseTestList.map((e) => ({ name: e.name, suite: e.test?.suite ?? null, grep: e.test?.grep ?? null, ...(e.test?.file ? { file: e.test.file } : {}) }));
  // Docs the criteria name (docs.mjs): read from git at both commits, no sandbox needed.
  const docs = self ? [] : checkDocs({ entries: docEntries(expectList), head: headSha, base: baseSha, read: d.readAt });
  // The stubs the charter names (design §6.1 rung 3): set on both sandboxes; an undeclared one is a warning, never set.
  let charterText = null;
  try { charterText = fs.readFileSync(path.join(V, 'charter.md'), 'utf8'); } catch { /* no plan yet */ }
  const stubbed = resolveStubs(profile, Array.isArray(opts.stubs) ? opts.stubs : charterStubs(charterText));
  for (const id of stubbed.unknown) warnings.push(`stub ${id}: the charter names it, but qa.json stubs does not declare it — not set`);
  for (const name of stubbed.conflicts) warnings.push(`stubs: ${name} is set by two of them; the last one wins`);
  if (stubbed.ids.length) log(`stubs on both sandboxes: ${stubbed.ids.join(', ')}`);
  const stubKey = stubbed.ids.length ? { stubs: stubbed.ids.map((id) => ({ id, env: profile.stubs[id].env })) } : {};
  const extra = { viewports, screens: affected?.mode === 'affected' ? [...affected.names].sort() : screens, checks, tour, record: recordMode, ...(clock ? { clock } : {}), ...(expectTexts.length ? { expect: expectTexts } : {}), ...(baseTests.length ? { baseTests } : {}), ...stubKey };
  // The base cache key (design §7): base sha + the base map's hash + the walk settings — never the PR's screens, texts
  // or tests, so every PR on the same base shares it; what each screen was captured with is kept per screen (meta).
  const baseKey = { checks, tour, record: recordMode, ...(clock ? { clock } : {}), ...stubKey };
  const maps = {
    head: mapHash({ repoRoot, sha: headSha, profile: headProfile, map, seedNames, extra }),
    base: baseSha ? mapHash({ repoRoot, sha: baseSha, profile, map, seedNames, extra: baseKey }) : null,
  };
  const liveBase = !self && !suitesMode && /^https?:\/\//.test(String(profile.base ?? ''));
  const C = !self && !suitesMode && !liveBase ? path.join(cacheRoot, `base-${baseSha.slice(0, 10)}-${maps.base.slice(0, 12)}`) : null;
  fs.rmSync(W, { recursive: true, force: true });
  fs.mkdirSync(W, { recursive: true });
  if (incremental && expect && Array.isArray(expectList)) {
    expect = path.join(W, 'round-expectations.json');
    fs.writeFileSync(expect, JSON.stringify(expectList, null, 2) + '\n');
  }
  fs.rmSync(path.join(V, 'logs'), { recursive: true, force: true });
  fs.mkdirSync(path.join(V, 'logs'), { recursive: true });
  ensureVGitignore(V);

  const run = {
    exit: 0, mode: self ? 'self' : suitesMode ? 'suites' : 'diff', slug,
    head: { ref: head, sha: headSha },
    base: self || suitesMode ? null : { ref: baseRef, sha: baseSha, cached: false },
    maps, sandboxes: { base: null, head: null }, steps: [], sides: { base: null, head: null, again: null },
    compare: null, compareError: null, blocked: ownBlock ?? (preBlocked ? `${BLOCKED_PREFIX}${preBlocked}` : null), warnings, standing: null, routes: null, routeExpectations: [], mutants: null, tests: [],
    docs, affected, videos: [], sourcesWritten: [], newEntries, readiness, stubs: stubbed.ids,
    dirs: { verification: V, work: W, cache: C }, report: null,
  };
  const step = (side, verb, ok, ms, note = '') => run.steps.push({ side, verb, ok, ms, note });

  const sideLog = (label) => {
    const file = path.join(V, 'logs', `${label}.capture.log`);
    fs.writeFileSync(file, '');
    return (...a) => {
      log(...a);
      fs.appendFileSync(file, `${a.join(' ')}\n`);
    };
  };
  const copyLogs = (side, name) => {
    const dir = path.join(mainRoot, 'qa-artifacts', 'sandboxes');
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith(`${name}.`) && file.endsWith('.log')) fs.copyFileSync(path.join(dir, file), path.join(V, 'logs', `${side}.${file.slice(name.length + 1)}`));
      }
    } catch { /* no verb logs to copy */ }
  };

  // Up (one side), with one retry after a BLOCKED. Returns the descriptor, or null with run.blocked set.
  const bringUp = async (side, sha) => {
    const started = Date.now();
    let note = '';
    for (let attempt = 1; ; attempt++) {
      try {
        const desc = await d.up({ mainRoot, profile, at: sha, qaFrom: repoRoot, log, stubs: stubbed.ids });
        const ms = Date.now() - started;
        step(side, 'up', true, ms, note);
        run.sandboxes[side] = { name: desc.name, state: desc.reused ? 'reused' : 'up', ms };
        return desc;
      } catch (e) {
        if (attempt === 1 && e?.code === 'BLOCKED') {
          const wait = profile.sandbox?.retryWaitMs ?? 15000;
          log(`sandbox up ${side} BLOCKED; retrying once in ${Math.round(wait / 1000)} s`);
          await d.sleep(wait);
          note = 'retried';
          continue;
        }
        const ms = Date.now() - started;
        step(side, 'up', false, ms, firstLine(e));
        run.sandboxes[side] = { name: null, state: 'blocked', ms };
        const message = String(e?.message ?? e);
        run.blocked = `${BLOCKED_PREFIX}${side}: ${message.startsWith(BLOCKED_PREFIX) ? message.slice(BLOCKED_PREFIX.length) : message}`;
        return null;
      }
    }
  };

  // A sandbox up, `body` run against it, its verb logs copied, then down (not when it was already up): always.
  const inSandbox = async (side, sha, body) => {
    const desc = await bringUp(side, sha);
    if (!desc) return false;
    try {
      await body(desc);
    } finally {
      copyLogs(side, desc.name);
      // A sandbox the prepare check left up for this run (handOff) is the run's to take down, as one it started. A
      // reused one is never this run's. 1.0.4: one it started is left up while another running run reuses it (sandbox.mjs
      // othersUsing: two PRs on one base share its sandbox); the next `up` reaps it once no run uses it.
      const mine = !desc.reused || desc.handOff;
      const others = mine && d.othersUsing ? d.othersUsing({ mainRoot, name: desc.name }) : [];
      if (mine && others.length) warnings.push(`sandbox ${desc.name} (${side}) left up: another run (pid ${others.map((o) => o.pid).join(', ')}) still uses it`);
      else if (mine) {
        const started = Date.now();
        try {
          const r = await d.down({ mainRoot, profile, name: desc.name });
          for (const w of r?.warnings ?? []) warnings.push(`sandbox down ${side}: ${w}`);
          step(side, 'down', true, Date.now() - started);
        } catch (e) {
          step(side, 'down', false, Date.now() - started, firstLine(e));
          warnings.push(`sandbox down ${side} failed: ${firstLine(e)}`);
        }
      }
    }
    return true;
  };

  // No affected screen: nothing is captured (the sandbox is up for the sweep and the mutants).
  const skippedSide = (side, out) => {
    fs.mkdirSync(out, { recursive: true });
    step(side, 'capture', true, 0, 'no affected screen');
    return {
      viewports: (viewports ?? Object.keys(profile.viewports ?? {})).map((viewport) => ({ viewport, captured: [], failed: [], notRun: [], warnings: [] })),
      clock: { clock: null, why: 'not captured: no affected screen' }, mapErrors: [], ms: 0,
    };
  };

  // One side's capture. The head side reads the overlay (headProfile); the base side the shared files only, and it
  // passes its own screens, viewports and texts (the screens the base cache lacks).
  const sandboxCapture = async (side, label, desc, out, coverage = false, only = {}) => {
    if (noAffected) return skippedSide(side, out);
    const started = Date.now();
    try {
      const result = await d.captureSide({
        mainRoot, profile: side === 'base' ? profile : headProfile, baseUrl: desc.appUrl, cwd: desc.dir,
        vars: { dir: desc.dir, main: mainRoot, slug: desc.slug, port: String(desc.port) },
        out, viewports: only.viewports ?? viewports, screens: only.screens ?? screenArg, map, seedNames, checks, tour, clock, seedStartedAt: desc.seedStartedAt ?? null, headless,
        coverage, record: recordMode, expectTexts: only.expectTexts ?? expectTexts, log: sideLog(label),
      });
      step(side, 'capture', true, Date.now() - started);
      return result;
    } catch (e) {
      step(side, 'capture', false, Date.now() - started, firstLine(e));
      throw e;
    }
  };

  const varsOf = (desc) => ({ dir: desc.dir, main: mainRoot, slug: desc.slug, port: String(desc.port) });

  // The seed names of the tree being swept, for $seed.* tokens in the route table.
  const seedOf = (dir) => {
    const p = { ...profile };
    if (typeof map === 'string') p.map = map;
    if (typeof seedNames === 'string') p.seedNames = seedNames;
    try {
      const loaded = loadMap({ root: dir, profile: p });
      return { seed: loaded.seed, seedName: path.basename(loaded.seedFile ?? 'seed.json') };
    } catch {
      return { seed: null, seedName: path.basename(p.seedNames ?? 'qa/seed.json') };
    }
  };

  // Route expectations: the entries of the expectations file that have a `route` key (head side only).
  const routeEntries = () => {
    const entries = expect ? readJson(expect) : null;
    return Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object' && e.route !== undefined) : [];
  };

  // One side's route sweep, against the sandbox that is up. Never throws.
  const sweepOn = async (side, desc, expectations) => {
    const started = Date.now();
    const vars = varsOf(desc);
    try {
      const actors = await routeActors({ profile, mainRoot, descriptor: desc, vars, runVerb: d.runVerb, credentials: d.credentials });
      let registered = null;
      try {
        const r = await d.runVerb('routes', { profile, mainRoot, cwd: desc.dir, vars });
        if (Array.isArray(r?.json)) registered = r.json;
      } catch { /* no routes verb answer: unlisted and stale are then not judged */ }
      const { seed, seedName } = seedOf(desc.dir);
      // The head sweep reads the PR's overlay rows on top of the table; the base sweep the table alone.
      const swept = await d.sweepSide({ root: desc.dir, profile: side === 'head' ? headProfile : profile, baseUrl: actors.baseUrl ?? desc.appUrl, actors: actors.headers, expectations, seed, seedName, registered });
      step(side, 'routes', !swept.notRun || swept.notRun === 'no route table', Date.now() - started, swept.notRun ?? '');
      return swept;
    } catch (e) {
      step(side, 'routes', false, Date.now() - started, firstLine(e));
      return emptySweep(firstLine(e));
    }
  };

  // The named tests of one side, on its sandbox. Never throws: a throw makes every entry unverifiable.
  const testsOn = async (side, desc, entries) => {
    const started = Date.now();
    try {
      const records = await d.runTests({
        dir: desc.dir, at: side === 'head' ? headSha : baseSha, entries, profile, mainRoot, vars: varsOf(desc),
        logDir: path.join(V, 'logs'), runVerb: d.runVerb, side, log,
      });
      step(side, 'tests', true, Date.now() - started, `${records.filter((r) => r.result === 'met').length}/${records.length} met`);
      return records;
    } catch (e) {
      step(side, 'tests', false, Date.now() - started, firstLine(e));
      warnings.push(`tests ${side}: ${firstLine(e)}`);
      return entries.map((entry) => ({
        id: `exp:${entry.name}`, name: entry.name, criterion: entry.criterion ?? null, suite: entry.test?.suite ?? null, grep: entry.test?.grep ?? null,
        side, result: 'unverifiable', toolError: true, why: `not run: ${firstLine(e)}`, detail: `${entry.test?.suite ?? 'test'} "${entry.test?.grep ?? ''}": not run: ${firstLine(e)}`,
        command: null, counts: { total: 0, matched: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 }, names: [], tail: [], log: null, base: null,
        clears: Array.isArray(entry.clears) ? entry.clears : [],
      }));
    }
  };
  // Base records for the entries that asked for one: from a fresh base run, the cache, or why there are none.
  let baseTestRecords = null;
  const baseTestsMissing = (why) => baseTestList.map((e) => ({ name: e.name, notRun: why }));

  // The mutants of the head tree, after its sweep. Never throws.
  const mutantsOn = async (desc) => {
    const started = Date.now();
    const proposals = path.join(V, 'mutants.json');
    const changed = baseSha ? (git(['-c', 'core.quotepath=false', 'diff', '--name-only', baseSha, headSha], { cwd: repoRoot }) ?? []).filter(isProductChange) : [];
    try {
      const m = await d.mutate({
        dir: desc.dir, profile, mainRoot, vars: varsOf(desc), mode: mutantsMode, changed,
        proposals: fs.existsSync(proposals) ? proposals : null, logDir: path.join(V, 'logs'), runVerb: d.runVerb, log,
      });
      run.mutants = m.result;
      if (m.selected > 0) step('head', 'mutants', true, Date.now() - started, `${m.result.killed}/${m.result.run} killed`);
    } catch (e) {
      step('head', 'mutants', false, Date.now() - started, firstLine(e));
      warnings.push(`mutants: ${firstLine(e)}`);
      run.mutants = null;
    }
  };

  let beforeDir = null;
  let afterDir = null;
  let baseSweep = null;

  // SUITES MODE (suitesmode.mjs): a git worktree of the head commit, each suite of qa/suites.* run whole in it, then the
  // named tests, the docs and the mutants; no sandbox, no capture, no base side, no model call. The worktree is removed
  // at the end, even on an error. Four outcomes, all by script: ACCEPT, REJECT, NEEDS YOU, BLOCKED.
  if (suitesMode) {
    log(`suites mode: ${suitesWhy}`);
    run.suites = [];
    run.suitesFile = null;
    const started = Date.now();
    try {
      if (!run.blocked) await withHeadWorktree({ repoRoot, mainRoot, headSha, slug }, async (dir) => {
        const desc = { dir, slug, port: '' };
        const ran = await runSuites({ dir, mainRoot, profile, slug, V, log }, { runVerb: d.runVerb, ...(d.runSuite ? { runSuite: d.runSuite } : {}) });
        run.suites = ran.records;
        run.suitesFile = ran.suitesFile;
        step('head', 'suites', ran.records.length > 0 && !ran.errors.length, Date.now() - started, `${ran.records.filter((r) => r.result === 'met').length}/${ran.records.length} passed`);
        if (ran.errors.length) {
          run.blocked = `BLOCKED: ${ran.suitesFile ?? 'qa/suites.json'} is wrong, so no suite was trusted: ${ran.errors[0]}${ran.errors.length > 1 ? ` (and ${ran.errors.length - 1} more)` : ''}`;
          run.suites = [];
          return;
        }
        if (!ran.records.length && !testList.length && !docs.length) {
          run.blocked = 'BLOCKED: nothing to run: no map entries, no stack adapter and no suites (write qa/suites.json: {"suites": {"unit": "<command>"}})';
          return;
        }
        if (testList.length) run.tests = withBase(await testsOn('head', desc, testList), baseTestsMissing('suites mode: the base side is not run'));
        if (mutantsMode !== 'none' && ran.records.length) {
          await mutantsOn(desc);
          if (run.mutants && !run.mutants.run && !(run.mutants.errors ?? []).length) run.mutants = null;
        }
      });
    } catch (e) {
      step('head', 'suites', false, Date.now() - started, firstLine(e));
      run.blocked = `BLOCKED: suites mode could not run: ${firstLine(e)}`;
    }
    const evidence = [...run.suites, ...run.tests, ...run.docs];
    const bad = evidence.some((t) => t.result === 'NOT MET') || Boolean(run.mutants?.survived?.length || run.mutants?.stale?.length);
    const open = evidence.some((t) => t.result !== 'met' && t.result !== 'NOT MET');
    run.exit = run.blocked ? 4 : bad ? 1 : open ? 2 : 0;
    run.results = buildResults(run);
    fs.mkdirSync(V, { recursive: true });
    rotatePrev(V, run.head.sha);
    const text = (t) => (t.endsWith('\n') ? t : `${t}\n`);
    fs.writeFileSync(path.join(V, 'results.json'), JSON.stringify(run.results, null, 2) + '\n');
    fs.writeFileSync(path.join(V, 'summary.md'), text(summaryMd(run.results)));
    const draftOpts = { waiversMd: opts.waivers ?? null, final: true };
    fs.writeFileSync(path.join(V, 'verdict.draft.md'), text(draftVerdict(run.results, draftOpts).md));
    if (run.blocked) fs.writeFileSync(path.join(V, 'verdict.md'), text(draftVerdict(run.results, draftOpts).md));
    const runJson = path.join(V, 'run.json');
    fs.writeFileSync(runJson, JSON.stringify({
      ...(readJson(runJson) ?? {}),
      slug, mode: run.mode, startedAt: startedAt.toISOString(), finishedAt: d.now().toISOString(),
      head: run.head, base: null, maps, exit: run.exit, sandboxes: run.sandboxes,
      cache: { hit: false, dir: null }, plugin: pluginVersion(), warnings, stubs: run.stubs,
    }, null, 2) + '\n');
    return run;
  }

  // 3. Base side.
  if (!self && !run.blocked) {
    if (liveBase) {
      const started = Date.now();
      const out = path.join(W, 'base');
      const wantedLive = baseScreenNames({ affected, noAffected, baseMap, screens, newEntries });
      try {
        if (noAffected || (wantedLive !== null && !wantedLive.length)) run.sides.base = skippedSide('base', out);
        else {
          run.sides.base = await d.captureSide({
            mainRoot, profile, baseUrl: profile.base, cwd: repoRoot, vars: { dir: repoRoot, main: mainRoot, slug, port: '' },
            out, viewports, screens: wantedLive === null ? screenArg : onlyGlob(wantedLive), map, seedNames, checks, tour, clock: 'off', headless, coverage: false, record: recordMode, expectTexts, log: sideLog('base'),
          });
          step('base', 'capture', true, Date.now() - started);
        }
      } catch (e) {
        step('base', 'capture', false, Date.now() - started, firstLine(e));
        throw e;
      }
      run.sandboxes.base = { name: null, state: 'live', ms: Date.now() - started };
      beforeDir = out;
      if (baseTestList.length) baseTestRecords = baseTestsMissing('live base');
    } else {
      // The base cache, per screen (design §7): what C holds for this base commit and map, every PR on the same base
      // shares; only the screens it lacks (or captured without one of this run's texts) are walked, and the routes and
      // base tests only when C has none for them. Base never walks a screen that is new on head.
      const view = path.join(W, 'base');
      const vps = viewports ?? Object.keys(profile.viewports ?? {});
      const wanted = baseScreenNames({ affected, noAffected, baseMap, screens, newEntries });
      const meta = readMeta(C);
      const fresh = { side: null, dir: null };
      const tmpRoot = path.join(cacheRoot, `.tmp-${process.pid}-${Date.now()}`);
      try {
        if (wanted === null) {
          // No base map to name the screens by: walk as asked, straight into the run dir, nothing cached per screen.
          await inSandbox('base', baseSha, async (desc) => {
            run.sides.base = await sandboxCapture('base', 'base', desc, view);
            if (routesOn) baseSweep = await sweepOn('base', desc, []);
            if (baseTestList.length) baseTestRecords = await testsOn('base', desc, baseTestList);
          });
          beforeDir = view;
        } else {
          const perVp = Object.fromEntries(vps.map((vp) => [vp, [...new Set(selectScreens((baseMap?.screens ?? []).filter((x) => wanted.includes(x.name)), { viewport: vp }).map((x) => x.name))]]));
          const has = (vp, name) => {
            const entry = cache ? meta.screens?.[vp]?.[name] : null;
            return Boolean(entry) && expectTexts.every((t) => (entry.expect ?? []).includes(t));
          };
          const missing = Object.fromEntries(vps.map((vp) => [vp, perVp[vp].filter((n) => !has(vp, n))]));
          const missVps = vps.filter((vp) => missing[vp].length);
          const missNames = [...new Set(missVps.flatMap((vp) => missing[vp]))];
          const cachedRoutes = cache && routesOn ? readJson(path.join(C, 'routes.json')) : null;
          const cachedTests = cache ? (readJson(path.join(C, 'tests.json')) ?? []) : [];
          const testKey = (e) => JSON.stringify([e.name, e.test?.suite ?? null, e.test?.grep ?? null, e.test?.file ?? null]);
          const needTests = baseTestList.filter((e) => !(Array.isArray(cachedTests) && cachedTests.some((r) => r?.key === testKey(e))));
          const needRoutes = routesOn && !cachedRoutes;
          let tests = Array.isArray(cachedTests) ? cachedTests : [];
          baseSweep = cachedRoutes;
          if (noAffected) run.sides.base = skippedSide('base', view);
          if (!missNames.length && !needRoutes && !needTests.length) {
            run.base.cached = true;
            run.sandboxes.base = { name: null, state: 'cached', ms: 0 };
            if (!noAffected) step('base', 'capture', true, 0, 'cached');
          } else {
            fresh.dir = path.join(tmpRoot, 'base');
            fs.mkdirSync(fresh.dir, { recursive: true });
            const up = await inSandbox('base', baseSha, async (desc) => {
              if (missNames.length) {
                // The texts the old entries had are captured again too, so an entry only ever gains texts.
                const texts = [...new Set([...expectTexts, ...missVps.flatMap((vp) => missing[vp].flatMap((n) => meta.screens?.[vp]?.[n]?.expect ?? []))])];
                fresh.side = await sandboxCapture('base', 'base', desc, fresh.dir, false, { viewports: missVps, screens: onlyGlob(missNames), expectTexts: texts });
                fresh.texts = texts;
              } else if (!noAffected) step('base', 'capture', true, 0, 'cached');
              if (needRoutes) {
                baseSweep = await sweepOn('base', desc, []);
                writeJsonAtomic(path.join(C, 'routes.json'), baseSweep);
              }
              if (needTests.length) {
                const ran = (await testsOn('base', desc, needTests)).map((r, i) => ({ ...r, key: testKey(needTests[i]) }));
                tests = [...tests.filter((r) => !ran.some((x) => x.key === r.key)), ...ran];
                writeJsonAtomic(path.join(C, 'tests.json'), tests);
              }
            });
            if (up && fresh.side) storeScreens({ C, meta, side: fresh.side, dir: fresh.dir, names: missNames, texts: fresh.texts, at: d.now().toISOString() });
          }
          if (baseTestList.length) baseTestRecords = baseTestList.map((e) => tests.find((r) => r?.key === testKey(e)) ?? { name: e.name, notRun: 'the base sandbox did not run it' });
          if (!run.blocked) {
            writeMeta(C, { ...meta, sha: baseSha, mapHash: maps.base, plugin: pluginVersion(), at: d.now().toISOString(), clock: fresh.side?.clock ?? meta.clock ?? null });
            pruneCache(cacheRoot, profile.run?.cacheKeep ?? 5, C);
            if (!noAffected) run.sides.base = assembleBase({ C, meta, view, vps, perVp, fresh, ms: fresh.side?.ms ?? 0 });
            beforeDir = view;
          }
        }
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  }

  // 4. Head side.
  if (!run.blocked) {
    if (self) {
      const a = path.join(W, 'a');
      const b = path.join(W, 'b');
      await inSandbox('head', headSha, async (desc) => {
        run.sides.head = await sandboxCapture('head', 'head', desc, a);
        run.sides.again = await sandboxCapture('head', 'again', desc, b);
      });
      beforeDir = a;
      afterDir = b;
    } else {
      afterDir = path.join(W, 'head');
      await inSandbox('head', headSha, async (desc) => {
        run.sides.head = await sandboxCapture('head', 'head', desc, afterDir, full);
        if (routesOn) {
          const headSweep = await sweepOn('head', desc, routeEntries());
          run.routes = diffRoutes(headSweep, baseSweep);
          run.routeExpectations = headSweep.expectations ?? [];
        }
        if (testList.length) run.tests = withBase(await testsOn('head', desc, testList), baseTestRecords ?? []);
        if (mutantsMode !== 'none') await mutantsOn(desc);
      });
    }
  }

  // Head capture products: the videos, and with --full the sources each screen ran.
  if (!self && run.sides.head && !noAffected) {
    const vps = viewports ?? Object.keys(profile.viewports ?? {});
    run.videos = videosIn(afterDir, vps);
    if (full) {
      for (const [area, screensOf] of recordedSources(afterDir, vps, headMap)) {
        try {
          run.sourcesWritten.push(await d.writeSources(mapDirOnDisk, { area, screens: screensOf, sha: headSha }));
        } catch (e) {
          warnings.push(`sources ${area}: ${firstLine(e)}`);
        }
      }
    }
  }

  // 5. Compare.
  let compareExit = null;
  if (!run.blocked && noAffected) {
    step('run', 'compare', true, 0, 'no affected screen');
  } else if (!run.blocked) {
    const started = Date.now();
    try {
      run.compare = await d.compare({ beforeDir, afterDir, out: path.join(W, 'compare'), expect, profile, viewports, newScreens: newEntries });
      step('run', 'compare', true, Date.now() - started);
      run.report = path.join(W, 'compare', 'index.html');
      compareExit = run.compare.exit;
    } catch (e) {
      step('run', 'compare', false, Date.now() - started, firstLine(e));
      warnings.push(`compare failed: ${firstLine(e)}`);
      run.compareError = firstLine(e);
      compareExit = 2;
    }
  }

  // 6. Standing, exit, results, files.
  // U7: a diff run matches its new findings against qa/standing.md (read even with --no-standing, which only stops
  // the write); the rows they matched get their last seen with the rest.
  const standingFile = path.join(repoRoot, 'qa', 'standing.md');
  const standingText = fs.existsSync(standingFile) ? fs.readFileSync(standingFile, 'utf8') : null;
  if (!self) run.standingRows = readStanding(standingText);
  if ((!self || opts.baseline) && run.compare && opts.standing !== false) {
    const file = standingFile;
    const existing = standingText;
    const touched = self ? [] : buildResults(run).standing.matched.map((m) => m.id);
    const merged = mergeStanding(existing, standingItems(run.compare), { slug, date: localDate(d.now()), touched });
    if (merged.text !== existing) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, merged.text);
    }
    run.standing = { file: 'qa/standing.md', added: merged.added, seen: merged.seen };
  }

  const sides = [run.sides.head, run.sides.again];
  const headFailed = sides.some((s) => (s?.viewports ?? []).some((v) => v.failed.length));
  const headNotRun = sides.some((s) => (s?.viewports ?? []).some((v) => v.notRun.length));
  if (run.blocked) run.exit = 4;
  else if (self) {
    run.exit = !buildResults(run).identical || headFailed ? 1 : headNotRun ? 3 : 0;
  } else {
    const onBase = sideKeys(run.sides.base);
    // A screen whose map entry is new: any base failure of it was not of this entry, so a head failure is new.
    const newFailure = (run.sides.head?.viewports ?? []).some((v) => v.failed.some((f) => !onBase.has(`${v.viewport}\0${f.screen}`) || Object.hasOwn(newEntries, f.screen)));
    const routeBad = Boolean(run.routes?.new?.length || run.routes?.unlisted?.length);
    const mutantBad = Boolean(run.mutants?.survived?.length || run.mutants?.stale?.length);
    const evidence = [...run.tests, ...run.docs];
    const testBad = evidence.some((t) => t.result === 'NOT MET');
    const testOpen = evidence.some((t) => t.result !== 'met' && t.result !== 'NOT MET');
    run.exit = compareExit === 1 || newFailure || routeBad || mutantBad || testBad ? 1 : headNotRun ? 3 : compareExit === 2 || testOpen ? 2 : 0;
  }
  run.results = buildResults(run);
  // The round: carried rows join the results, and the round records what the next one compares against.
  if (round) run.results = carryInto(run.results, round, { entries: headMap ? entryKeys(headMap) : null, qa: qaHashes({ root: repoRoot, profile, overlay }) });

  fs.mkdirSync(V, { recursive: true });
  if (!self) rotatePrev(V, run.head.sha);
  // A full round whose security review did not run this round: an earlier review is not this round's evidence.
  if (!self && round && (full || round.of !== 'incremental')) staleSecurityToPrev(V);
  const text = (s) => (s.endsWith('\n') ? s : `${s}\n`);
  fs.writeFileSync(path.join(V, 'results.json'), JSON.stringify(run.results, null, 2) + '\n');
  fs.writeFileSync(path.join(V, 'summary.md'), text(summaryMd(run.results)));
  if (!self) {
    const readIf = (name) => (fs.existsSync(path.join(V, name)) ? fs.readFileSync(path.join(V, name), 'utf8') : null);
    const draftOpts = { security: parseSecurity(readIf('security.md')), charterMd: readIf('charter.md'), waiversMd: opts.waivers ?? null };
    fs.writeFileSync(path.join(V, 'verdict.draft.md'), text(draftVerdict(run.results, draftOpts).md));
    // Nothing could be checked: the outcome is BLOCKED by script, so whoever waits on a verdict gets one.
    if (run.blocked) fs.writeFileSync(path.join(V, 'verdict.md'), text(draftVerdict(run.results, { ...draftOpts, final: true }).md));
  }
  const runJson = path.join(V, 'run.json');
  fs.writeFileSync(runJson, JSON.stringify({
    ...(readJson(runJson) ?? {}),
    slug, mode: run.mode, startedAt: startedAt.toISOString(), finishedAt: d.now().toISOString(),
    head: run.head, base: run.base, maps, exit: run.exit, sandboxes: run.sandboxes,
    cache: { hit: run.base?.cached ?? false, dir: C }, plugin: pluginVersion(), warnings, stubs: run.stubs,
  }, null, 2) + '\n');
  return run;
}
