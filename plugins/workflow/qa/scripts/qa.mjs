#!/usr/bin/env node
// qa — deterministic QA engine. Node stdlib + playwright-core only; zero model calls.
//
//   qa profile [--json]                        validate qa.json; show which adapter serves each verb
//   qa adapter <verb> [args…]                  run one stack verb in this checkout
//   qa sandbox up --at <ref> [--no-seed] [--no-serve]
//   qa sandbox down <name> | status <name> | list | reap [--hours N]
//   qa map check [--sources] [--map <dir>] [--seed-names <file>]   validate the screen map against qa.json
//   qa map show <screen> [--map <dir>]          the screen's steps after flows and $seed expand
//   qa map probe (--url <base> | --sandbox <name>) [--path /x | --screen <name>] [--role r]
//                 [--viewport v] [--lines N] [--headed]   ARIA snapshot of a page, for the mapper
//   qa checks (--url <base> | --sandbox <name>) [--path /x | --screen <name>] [--role r]
//                 [--viewport v] [--headed]        the seven page checks on one page, now
//   qa login <role> --manual [--url <base>]    log in by hand once; saves qa-artifacts/auth/<role>.json
//   qa capture (--url <base> | --sandbox <name>) --out <dir>
//                 [--viewports desktop,phone] [--screens <globs>] [--map <dir>] [--seed-names <file>]
//                 [--record] [--headed] [--no-checks] [--no-tour] [--clock seed|off|<ISO>]
//                 (map and seed names are the captured tree's own unless --map / --seed-names name others)
//   qa compare --before <dir> --after <dir> --out <dir> [--expect <file>] [--viewports a,b]
//   qa run [--base <ref>] [--head <ref>] [--slug <s>] [--self] [--expect <file>] [--viewports a,b]
//             [--screens <globs>] [--map <dir>] [--seed-names <file>] [--no-cache] [--no-checks]
//             [--no-tour] [--clock seed|off|<ISO>] [--out <dir>] [--headed]
//                 base sandbox (cached) and head sandbox, same seed, capture, compare; writes
//                 qa/<slug>/{summary.md,results.json,verdict.draft.md,run.json,logs/}
//                 and qa/standing.md (run.mjs). --self: the determinism self-test on head.
//   qa verdict draft [--slug <s> | --results <file>] [--out <file>]
//                 results.json -> verdict.draft.md beside it (verdict.mjs); prints line 1
//
// STEP 5 (tests: test/cli-step5.test.mjs; V = <repoRoot>/qa/<slug>, slug = --slug or
// slugOf(branch, head) as `verdict draft` does):
//   qa verdict draft …         also reads V/security.md (parseSecurity) into draftVerdict, and (0.6.0) V/eyes.md
//                                 when it exists (parseEyes), so a page check eyes ruled wrong is Major again
//   qa resolve [--spec <file>] [--onto <ref>] [--slug <s>]
//                 resolveTarget (resolve.mjs) with real deps; when spec.from is 'pr' writes
//                 spec.body to spec.path (dirs made); prints the Target as JSON (spec.body and pr.body omitted)
//                 plus map: the absolute path of profile.map in repoRoot (the map on disk, which the
//                 skill passes to `run --map` so entries the planner just wrote are captured) and
//                 seedNames: the absolute path of profile.seedNames in repoRoot when that file
//                 exists, else null (passed as `run --seed-names`);
//                 warnings to stderr as 'warning: <w>'. Exit 0 (spec null is not an error).
//   qa eyes prompt [--slug <s>]
//                 results = V/results.json (missing -> exit 3 'NOT RUN: …'); run = V/run.json;
//                 targets = eyesTargets(results, { work: dirname(dirname(results.report)) (or
//                 <mainRoot>/qa-artifacts/runs/<slug> when report is null), cacheDir: run.cache.dir when
//                 run.cache.hit, exists: fs.existsSync }); none -> prints 'no changed or new screen:
//                 no eyes pass', exit 0, writes nothing. Else writes V/eyes-prompt.md = eyesPrompt({
//                 slug, out: V, targets, questions: profile.eyes?.questions ?? [], asks:
//                 openAsks(<repoRoot>/qa/escapes.md text or null) }), prints its path, exit 0.
//   qa eyes parse [--slug <s>]  parseEyes(V/eyes.md) as JSON; missing -> exit 3.
//   qa report build [--slug <s>] [--out <dir>] [--work <dir>] [--check]
//                 (--out: V itself instead of <repoRoot>/qa/<slug>; --work: the run folder whose
//                 base/head/compare screenshots the report shows, instead of the one results.report names;
//                 --rebuilt-on: the screenshots were captured again on <host> — reportHtml rebuilt { host, at: now,
//                 head: the verdict's }; for a report rebuilt on another machine.)
//                 validateVerdict({ verdictMd: V/verdict.md, results, security, eyesMd: V/eyes.md
//                 or null, charterMd: V/charter.md or null }). No verdict.md or results.json ->
//                 exit 3. Problems -> prints '<rule>: <message>' per problem, writes nothing, exit 1.
//                 Valid and --check -> prints 'valid', exit 0. Valid -> copies, for each id of
//                 shotsFor(verdictMd, results), the eyesTargets before/after PNGs to
//                 V/shots/<viewport>/{before,after}/<key>.png; writes V/report.html = reportHtml({
//                 verdictMd, summaryMd: V/summary.md, results, eyes: parseEyes(eyes.md) or [],
//                 shots: { id: { before, after } relative to V } }); appends { head, verdict, at } to
//                 V/run.json `verdicts` (one entry per head+verdict: an equal last entry is not appended
//                 twice); prints the report path; exit 0. (U8: no tier, no judge agent id: every round has
//                 a fresh judge.)
//   run.json is always read-merge-written: keys a command does not write are kept.
//
// Exit codes: 0 ok · 1 findings or failure · 2 inconclusive (compare) · 3 NOT RUN (no adapter,
// missing secret) · 4 BLOCKED ON INFRASTRUCTURE (sandbox) · 64 usage.

// STEP 6 (tests: test/cli-step6.test.mjs):
//   qa run … [--no-routes] [--mutants affected|all|none]   (run.mjs opts routes / mutants)
//   qa run … --no-standing     (run.mjs opts standing false: qa/standing.md is not written)
//   qa routes check [--table <file>]
//                 loadRouteTable in repoRoot (--table overrides profile.routes.table); prints
//                 '<file>: <n> route(s)' and one 'error: <e>' per error; no table -> 'no route
//                 table', exit 3. Exit 1 when errors, else 0.
//   qa routes sweep --sandbox <name> [--expect <file>] [--json]
//                 on a running sandbox (sandbox.mjs registry descriptor): routeActors + sweepSide
//                 (registered from the routes verb as run does). Prints one '<problem> — <route>
//                 <kind> (<actor>)' line per problem, then '<n> probes · <p> problem(s) · <u>
//                 unlisted · <s> stale'; --json prints the SweepSide instead. Exit 1 when any
//                 problem, unlisted or stale; 3 when notRun; else 0.
//   qa mutants --sandbox <name> [--all | --only <id,id>] [--proposals <file>]
//                 loadMutants in the sandbox dir; --only picks by id, --all every one, default
//                 affected against git diff --name-only <merge-base of HEAD and the default
//                 branch>..HEAD in repoRoot. Prints '<verdict> <id> — <detail or breaks>' per
//                 mutant and '<k>/<n> killed'. Exit 1 when any SURVIVED or stale, 3 when nothing
//                 was selected, else 0. NEVER runs in the user's checkout: --sandbox is required.
//   qa metrics [--slug <s>]
//                 V/results.json metrics: '<captures> captures · <f> flag(s) · <st> standing'
//                 then '- [<id>] <metricsLine>' per flag. Missing results -> exit 3.

// STEP 7 (tests: test/cli-step7.test.mjs):
//   qa run … [--full] [--record journeys|all|none]   (run.mjs opts full / record; a bad --record
//                 value -> usage 64). --full with --screens -> usage 64 'pick --full or --screens'.
//   qa affected [--base <ref>] [--map <dir>] [--seed-names <file>] [--json]
//                 what an affected run would walk, without running: changed files of
//                 merge-base(HEAD, --base or the default branch)..HEAD, the head map (--map or
//                 profile.map at HEAD), the base map at the merge-base, readSources of the map dir.
//                 Prints '- <screen>: <why>' per affected screen then '<n> of <total> affected ·
//                 <unknown> without known sources'; --json prints the Affected object. Exit 0.
//                 UNMAPPED: after the screen lines, '- unmapped: <file>' per Affected.unmapped entry
//                 (a changed UI file no map entry walks), and the totals line gains
//                 ' · <k> changed UI file(s) no screen walks' when k > 0.
//   qa capture … [--coverage] [--record [journeys|all|none]]   (--record alone = all)
//   qa report build …          also copies each results.videos file to V/shots/video/<vp>/<screen>.webm
//                 and passes videos (src relative to V; checkpoint status from results.screens) to reportHtml.

// STEP 8 (tests: test/cli-step8.test.mjs):
//   qa run … --json            CI mode (decision 21): runs as usual, then prints ONE JSON object
//                 { exit, verdict: draft line-1 word | null (self mode), blockers: [id], majors: [id],
//                   summary: <V>/summary.md } on stdout (human lines stay on stderr) and exits:
//                 4 blocked, 3 NOT RUN, 1 when blockers is non-empty, else 0 (Majors alone exit 0 in
//                 CI: they need a judge). blockers/majors = draftVerdict(results).findings by severity.
//   qa run --self --baseline   STEP 8 run.mjs baseline (the standing baseline).
//   qa setup questions         prints the five QUESTIONS as '<n>. <key>: <ask>'.
//   qa setup detect            prints JSON { adapters: detectAdapters(...), hasProfile: bool }.
//   qa setup write --answers <file> [--force]
//                 draftProfile(JSON of file, { detected }) -> writeSetup(repoRoot, …, { force, today });
//                 prints 'wrote <path>' / 'kept <path>' per path. A bad answer -> the Error message,
//                 exit 1.
//   qa standing list [--kind k] [--owner o | --unowned] [--screen glob] [--json]
//                 readStanding(<repoRoot>/qa/standing.md) -> pickStanding -> '- [<id>] <screen> <kind>:
//                 <finding>[ (owner <o>)]' per row and '<n> of <total>'; --json prints the rows.
//                 No file -> 'no qa/standing.md', exit 3.
//   qa standing set <id> [--owner o] [--note t]   setStanding, writes the file, prints the row.
//   qa standing add <id,id…> [--slug <s>] [--owner o] [--note t]   |   standing add --fp '<fingerprint text>' […]
//                 (rework U7) fingerprint rows (standing.mjs addFingerprints) in <repoRoot>/qa/standing.md, made from the
//                 template when missing. Each id is a chrome:<n> candidate or a chk:/tour: finding of V/results.json
//                 (V = qa/<slug>; no results.json -> exit 3 'NOT RUN: no <path>'); its fingerprint is the
//                 candidate's or the finding's. --fp takes the fingerprint text itself (no results needed). An unknown id,
//                 an id with no fingerprint ('no fingerprint for <id>: …') or a text that is no fingerprint -> the
//                 message on stderr, exit 1, nothing written. Prints '- [<id>] * <kind>: <text>' per added row and
//                 '- [<id>] already standing: <text>' per one that was there; exit 0.
//   qa standing asks <id,id…> [--out <file>]     asksMd of those rows (unknown id -> exit 1);
//                 prints it, or writes --out (dirs made) and prints the path.
//   qa escapes list [--open]                     readEscapes(<repoRoot>/qa/escapes.md); '- [<id>]
//                 <what> — ask: <ask>[ — closed by <c>]'; --open: no closed ones. No file -> exit 3.
//   qa escapes add --what t --caught t --ask t [--found t]   addEscape (found default: today);
//                 writes qa/escapes.md (made from the template when missing); prints the id.
//   qa escapes close <id> --by <commit>
//                 closeCheck(git show --name-only --format= <commit> in repoRoot, { map: profile.map })
//                 -> why: prints it, exit 1, writes nothing; else closeEscape(…, '<short sha> <subject>')
//                 and writes. Unknown commit -> exit 64.

// READY (0.5.0; tests: test/ready.test.mjs, test/ready.e2e.test.mjs):
//   qa ready [--at <ref>] [--sample <n>] [--fix] [--static] [--json]
//                 ready.mjs checkReady on a sandbox of the integration branch (--at, else the integration branch: qa.json integrationBranch, origin/HEAD's target, main,
//                 master): stack verbs, executables (--fix chmods them), map coverage of the route table's pages, the
//                 seed and a full walk with no failure and no empty-data screen, seed determinism (two fresh seeds of
//                 one commit, a sample of screens), and the test suites (each names its tests). Writes qa/ready.json
//                 (not with --static, which skips the sandbox). Prints readyText, or the report as JSON with --json.
//                 Exit 0 READY, 1 NOT READY, 64 usage (a bad --sample or an unknown --at ref).
//   qa setup suites      detectSuites(repoRoot) (setup.mjs) as JSON { registry, existing, proposed }: the test
//                 suites the project has, for the qa skill to confirm with the user and register. Exit 0.
//   qa ready status [--json]
//                 readiness() of qa/ready.json without a sandbox: prints 'ready: <state>' and the
//                 'project not proven ready: …' line when not ready (what `qa run` and the qa skill warn with).
//                 Exit 0 ready, 1 otherwise.

// FOUR OUTCOMES (1.0.0; tests: test/outcomes.test.mjs 'cli'):
//   Waivers: the PR's waivers.md is V/waivers.md. `run`, `verdict draft`, `verdict waivers` and `report build` pass
//     them on.
//   qa verdict draft …     also reads V/charter.md (advisory and manual rows) and the waivers.
//   qa verdict waivers [--slug <s>]
//                 applyWaivers (verdict.mjs) to V/verdict.md with the waivers, results.json, security.md, eyes.md and
//                 charter.md; validateVerdict on the result; valid -> writes V/verdict.md, prints line 1 and
//                 'waived: <ids>' (or 'no new waiver'), exit 0; problems -> '<rule>: <message>' lines, nothing
//                 written, exit 1. No verdict.md, results.json or waivers -> exit 3 'NOT RUN: no <path>'.
//   qa report build …      validates with the waivers too. With --rebuilt-on (a report rebuilt on another machine: the
//                             judgement is the original run's, validated when it was made, perhaps by an older
//                             qa) it is not validated again: an old verdict keeps its report.
// PLAN CHECK (rework U6, design §6; tests: test/plan.test.mjs, test/cli-plan.test.mjs):
//   qa plan check [--slug <s>] [--head <ref>] [--map <dir>] [--seed-names <file>] [--drop] [--json] [--headed]
//                 plan.mjs planCheck of V/expectations.json and V/mutants.json on the head sandbox (reused when live;
//                 brought up and taken down again when not), the map on disk (--map, else profile.map in repoRoot),
//                 then writes V/plan-check.md (planCheckMd) and prints it (--json: the PlanCheck). --drop: the
//                 entries and mutants that still fail are taken out of V/expectations.json and V/mutants.json
//                 (dropFailed), and plan-check.md lists them as dropped; the verify skill passes it on the second
//                 check, after the planner had one go at the problems. No V/expectations.json -> exit 3 'NOT RUN:
//                 …'. Exit 4 when the head sandbox did not come up, 1 when any problem, else 0.
//   qa run … --mutants named|affected|all|none   (rework: 'named', the default, runs only the plan's mutants that
//                 name a kill test; 'affected' and 'all' are the registry's, on request)
//   qa setup suites [--write <file>]   --write: setup.mjs writeSuites(repoRoot, JSON of the file { id: suite }):
//                 prints 'wrote qa/suites.json: added …; kept …; moved … from the old place'. A bad suite or a
//                 qa/suites.ts|.mjs project -> the message, exit 1.

// UPGRADE FROM 0.6 (tests: test/upgrade.test.mjs, test/stubs.test.mjs):
//   qa map check [--sources] …  validateMap with { files: the repo's files (git ls-files --cached --others
//                 --exclude-standard in the checkout) }, so a `sources` glob that matches no file is an error. A screen
//                 with neither declared `sources` nor recorded ones (<map dir>/*.sources.json), its origin not
//                 'verify:*', is out of every PR's scope: one warning '<n> screen(s) have no sources (out of every PR's
//                 scope): qa map check --sources lists them'; with --sources, one error per screen '<basename>
//                 <screen>: no sources: name the files that render it (…)' instead (the mapper's sources phase proof).
//   qa setup suites --write    with no file: the move alone — the old SUITES of qa/mutants.* into qa/suites.json
//                 (writeSuites with nothing chosen); none there -> 'nothing to move: no suites in qa/mutants.*', no write.
//   qa sandbox up --at <ref> [--stubs <id,id>]   the qa.json stubs to set on the sandbox's verbs (sandbox.mjs STUBS).
//   qa profile [--json]        also lists qa.json stubs ('  stub <id> — <for>: NAME=value, …'; --json: stubs).
//   qa ready …                 the upgrade check's CONCERN items print as '  concern <id> — <reason>' + '    → <fix>';
//                 line 1 gains ' · <k> concern(s)'; --json has concerns: [ids]. Concerns never change the exit.

// SCOPE AND PREPARE (rework U4/U5, design §5 and §7; tests: test/scope.test.mjs, test/prepare.test.mjs):
//   There is no overlay folder: the PR's QA files are the branch's own qa/ (qa/map/, qa/routes.table.*, qa/seed.json),
//     its sad paths in qa/map/verify-<slug>.json. `run`, `affected`, `plan check`, `capture` and `map check|show|probe`
//     read them from the checkout.
//   qa affected …  also prints '- map these (no known sources, not walked): <names>' when Affected.mapThese is
//                     non-empty (out of scope: never walked, never UNVERIFIABLE).
//   qa prepare check [--slug <s>] [--base <ref>] [--head <ref>] [--map <dir>]
//                 [--seed-names <file>] [--final] [--json] [--headed]
//                 prepare.mjs prepareCheck at HEAD (or --head) against merge-base(HEAD, --base or the default branch);
//                 writes V/prepare.md (prepareMd) and prints it (--json: the PrepareCheck). Exit (prepareExit): 0 clean,
//                 1 problems, 3 nothing to check, 4 the head sandbox did not come up; 64 usage (base = head too). The
//                 head sandbox stays up for the run. --final (the check after the mapper's one repair round): on exit 1
//                 or 4 it takes that sandbox down and writes the BLOCKED verdict through runQa ({ blocked: { text:
//                 blockedText } } for problems, 'head: <why>' for the sandbox), so the outcome is BLOCKED with the
//                 lines and no full run happens; prints 'verdict: <line 1> (<path>)'. The exit code is the check's.

// REPORTS (rework U9, design §12; tests: test/publish.test.mjs; publish.mjs holds the rules):
//   qa report build …     also (not with --check or --rebuilt-on) writes the publish set: V/artifact-<n>.html, the
//                 artifact page(s) (part 1: reportHtml fragment with only the new and changed screens; part n ≥ 2:
//                 partHtml), and V/publish.json = publishPlan(…), the files to go up (publishedShots + every copied
//                 video, packParts with LIMITS, or QA_PUBLISH_LIMITS JSON over them), each with its size, one artifact
//                 per part, each part's url from the PR's record (V/published.json, else a Report URL in V/verdict.md or V/prev/verdict.md). Earlier V/artifact-*.html are removed first. stdout stays the report path.
//   qa report where [--slug <s>] [--json]
//                 decideReport({ where: whereAmI(), session: sessionAccount(), launcher: null }). Not publishing: writes the Report line as V/verdict.md's last line (withReportLine):
//                 local -> localLine(hostname, V/report.html), or notPublishedLine('no report.html …') when it is missing;
//                 cloud -> notPublishedLine(reason). Publishing with no V/publish.json for the verdict's head -> writes
//                 notPublishedLine('… run qa report build first') and publish becomes false. Publishing -> writes
//                 nothing and lists the artifacts, the last part first (so part 1 can link to the others): { part, of,
//                 file_path, files, url, title, icon, description, capabilities, then: 'qa report url <url> --part <n>
//                 --slug <s>' }. --json prints { where, publish, why, session, launcher, line, artifacts, left }; else line 1
//                 'local', 'cloud publish' or 'cloud not published', then the why, the line or one line per artifact.
//                 No V/verdict.md -> exit 3. Exit 0.
//   qa report url <https://…> [--part <n>] [--slug <s>]
//                 recordUrl into V/published.json (from the record report build reads; part 1 passes of = the publish
//                 set's part count); linkPart in every V/artifact-*.html; part 1 (the default) also writes urlLine(url)
//                 as V/verdict.md's last line. Prints 'recorded part <n>: <url>' (and the line). Not an https URL, or a
//                 bad --part -> usage 64. No V/verdict.md -> exit 3.
//   qa report line --not-published "<why>" [--slug <s>]
//                 notPublishedLine(why) as V/verdict.md's last line (the Artifact tool is missing or refused). Exit 0.
//   qa report comment [--slug <s>] [--pr <n>]
//                 postComment({ body: commentBody(V/verdict.md), pr, gh }) with gh = $QA_GH or 'gh', run in the repo.
//                 Prints 'comment: posted <url>', 'comment: edited <url>' or 'no comment: <why>'. Exit 0 every time but
//                 no V/verdict.md (exit 3) and a bad --pr (64): a PR comment never blocks.

// ROUNDS (rework U8, design §9 and §15; tests: test/cli-round.test.mjs, test/eyes-cache.test.mjs):
//   qa round plan [--slug <s>] [--spec <file>] [--base <ref>] [--map <dir>] [--seed-names <file>] [--full] [--replan]
//                 [--json]
//                 V = qa/<slug>. When V/round.json is for HEAD already (and no --full or --replan): prints its
//                 roundLines, the first ending ' (planned before for this head)', writes nothing, exit 0. --replan plans
//                 this head again as below (verify runs it after a mapper repair changed the PR's QA files, so the entries
//                 it changed re-run): never a full round by itself, and nothing moves. --full (without --replan) on a head
//                 V/verdict.md already judges is a full round again: first that verdict's round files (run.mjs PREV_FILES)
//                 move to V/prev (run.mjs moveToPrev), as a new round's do, and a line 'prev: <names> moved to <V>/prev
//                 (the verdict of this head)' follows the plan. Else: the last verdict
//                 (V/verdict.md, when its head is not HEAD) is recorded in V/rounds.json (rounds.mjs roundRecord /
//                 recordRound, with V/round.json when it is that head's and V/results.json when it is that head's; when
//                 V/round.json is HEAD's already — this head planned again — its record there is kept as it is); then
//                 planRound for HEAD: n = the round of V/round.json for HEAD, else the last recorded + 1; base = --base
//                 (rev-parse), else merge-base(HEAD, the integration branch — branches.mjs), else HEAD; spec = specHash of
//                 --spec, else the first that exists of V/spec.md, docs/briefs/<label>-<name>.md (branch <label>/<name>); changed = git diff --name-only <last
//                 head> HEAD (null when that fails); the head map, mapDir and sources as `qa run` reads them
//                 (run.mjs planAffected; sources.mjs readSources), and the PR's scope: planAffected's
//                 affected set against the base (rounds.mjs planRound scope); charter.md, expectations.json,
//                 mutants.json's mutants, security.md, the suites (suites.mjs loadSuites), qaHashes, and capHistory of
//                 rounds.json for that spec. Writes V/round.json (the plan) and V/rounds.json ({ rounds: [] } at least),
//                 prints roundLines (--json: the plan), exit 0.
//   qa run …    reads V/round.json (V = --out, else qa/<slug>) and passes it as runQa's round (run.mjs
//                 ROUNDS: only a plan for the run's head counts).
//   qa security [--from <ref>] [--json]
//                 paths.mjs securityPaths of git diff --name-only <from (default: merge-base with the default
//                 branch)>..HEAD, prints securityLine (the
//                 charter's `security:` line; --json: { line, paths }), exit 0.
//   qa eyes prompt …  (eyes.mjs EYES CACHE) hashes each target's branch shot and splits them with eyesRound against
//                 V/eyes-cache.json (round = V/round.json's when it is the results' head, else results.round.n), writing
//                 the cache back. No target: as before. Every target cached: writes V/eyes.md with mergeEyes alone,
//                 removes a stale V/eyes-prompt.md, prints 'no new screenshot: <n> screen(s) seen before; eyes.md written
//                 from the cache, no eyes pass'. Else the brief lists the fresh targets only, and after its path prints
//                 'cached: <n> screen(s) seen before (their rulings are kept); after the eyes pass run qa eyes merge'
//                 when n > 0.
//   qa eyes merge [--slug <s>]   mergeEyes of V/eyes.md and V/eyes-cache.json: writes both, prints 'eyes: <a> new
//                 ruling(s) kept, <c> from the cache', exit 0. No cache -> exit 3 'NOT RUN: no <cache>'. A fresh target and
//                 no eyes.md -> exit 3 'NOT RUN: no <V>/eyes.md'.
//   Waivers (waiversText) are read through bindEyesWaivers with V/eyes-cache.json, which is written back when a waiver
//                 is bound: a waived eyes ruling stays waived while its screen's image is unchanged.
//   Removed with the tiers: `qa tier`, `qa verdict --tier1`, `report build --judge` (usage errors now).

// ONE COMMAND (rework U10, design §13; tests: test/verify.test.mjs, test/headless.test.mjs; verify.mjs holds the order):
//   qa verify [--spec <file>] [--onto <ref>] [--security] [--full] [--record journeys|all|none] [--until <step>] [--json]
//                 verify.mjs verifyRound in the checkout: every step is this CLI run as a child (cwd the repo root), each
//                 agent a headless `claude -p` (headless.mjs; QA_CLAUDE overrides the binary) with --plugin-dir this
//                 plugin, its agent, qa.json agents.<role>.model (profile.mjs AGENT_DEFAULTS), the tools its frontmatter
//                 names, JSON output; its output under V/agents/<role>-<n>.json|.log, its cost and tokens in V/run.json
//                 (agents, cost-mapper, cost-plan, cost-security, cost-eyes, cost-judge). Progress goes to stderr, every
//                 step's output to V/verify.log. stdout: the Report line, the PR comment's line, the costs, the 'project
//                 not proven ready' line, 'publish: …' for a cloud session that should publish, and LAST line 1 of
//                 V/verdict.md, or 'headless <role> failed: <why> — continue by hand from step <n>', '<step> failed (exit
//                 <n>): … — continue by hand from step <n>', 'NOT RUN: …' or 'stopped after <step> (--until <step>) — …'.
//                 --json: one object instead ({ exit, kind, line, slug, V, verdict, report, costs, ready, publish, comment }).
//                 --until <step> (resolve|round|prepare|plan|security|run|eyes|judge) stops after that step.
//                 --spec is read from the cwd and passed to resolve repo-relative. originBase = merge-base(HEAD, origin/HEAD)
//                 (the native /security-review diffs origin/HEAD...). A bad --until or --record -> usage 64.
//                 Exit: ACCEPT 0 · REJECT 1 · NEEDS YOU 2 · NOT RUN 3 · BLOCKED 4 · hand over 5 · usage 64 · --until 0.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, git, gitOne, isProductChange, localDate, str } from './lib/util.mjs';
import { defaultMergeBase } from './lib/branches.mjs';
import { mainRoot as findMainRoot, repoRoot as findRepoRoot, loadProfile, requireProfile, ProfileError } from './lib/profile.mjs';
import { VERBS, resolveVerb, runVerb, detectAdapters } from './lib/adapter.mjs';
import * as sandbox from './lib/sandbox.mjs';
import { loadMap, validateMap, expandScreen, MapError } from './lib/map.mjs';
import { readSources } from './lib/sources.mjs';
import { loadSuites } from './lib/suites.mjs';
import { probeScreen } from './lib/probe.mjs';
import { runChecks } from './lib/checks.mjs';
import { openBrowser } from './lib/capture.mjs';
import { manualLogin } from './lib/login.mjs';
import { compare } from './lib/compare.mjs';
import { loadPlaywright } from './lib/playwright.mjs';
import { RunError, resolveClock, captureSide, runQa, slugOf, routeActors, planAffected, ciSummary, moveToPrev } from './lib/run.mjs';
import { loadRouteTable, sweepSide } from './lib/routes.mjs';
import { loadMutants, selectMutants, runMutants, makeRunSuite, makeRunKill, mutantsResult, MUTANT_MODES } from './lib/mutants.mjs';
import { metricsLine } from './lib/metrics.mjs';
import { applyWaivers, draftVerdict, parseCharter, parseSecurity, parseVerdict } from './lib/verdict.mjs';
import { qaFilesOf, resolveTarget } from './lib/resolve.mjs';
import { bindEyesWaivers, eyesTargets, eyesPrompt, eyesRound, imageHash, mergeEyes, parseEyes, openAsks } from './lib/eyes.mjs';
import { capHistory, lastRound, planRound, qaHashes, recordRound, roundLines, roundRecord, specHash } from './lib/rounds.mjs';
import { securityLine, securityPaths } from './lib/paths.mjs';
import { validateVerdict, reportHtml, shotsFor } from './lib/report.mjs';
import {
  LIMITS, commentBody, decideReport, launchAccount, linkPart, localLine, mediaItems, notPublishedLine, packParts, partHtml,
  placeOf, postComment, publishPlan, publishedShots, recordUrl, sessionAccount, urlLine, whereAmI, withReportLine,
} from './lib/publish.mjs';
import { QUESTIONS, detectSuites, draftProfile, writeSetup, writeSuites } from './lib/setup.mjs';
import { planCheck, planCheckMd, dropFailed } from './lib/plan.mjs';
import { readStanding, setStanding, pickStanding, asksMd, addFingerprints } from './lib/standing.mjs';
import { fingerprintId, fingerprintText, parseFingerprint } from './lib/fingerprint.mjs';
import { readEscapes, addEscape, closeCheck, closeEscape } from './lib/escapes.mjs';
import { checkReady, readiness, readyText } from './lib/ready.mjs';
import { blockedText, prepareCheck, prepareExit, prepareMd } from './lib/prepare.mjs';
import { PLUGIN_ROOT, QA_ROOT } from './lib/headless.mjs';
import { UNTIL, verifyRound } from './lib/verify.mjs';

const EXIT = { ok: 0, fail: 1, inconclusive: 2, notRun: 3, blocked: 4, usage: 64 };

class Usage extends Error {}

const HELP = `qa <command>
  profile [--json]
  adapter <verb> [args…]            verbs: ${VERBS.join(' ')}
  sandbox up --at <ref> [--no-seed] [--no-serve] [--stubs <id,id>] | down <name> | status <name> | list | reap [--hours N]
  map check [--sources] [--map <dir>] [--seed-names <file>]
  map show <screen> [--map <dir>] [--seed-names <file>]
  map probe (--url <base> | --sandbox <name>) [--path /x | --screen <name>] [--role r] [--viewport v] [--lines N] [--headed]
  checks (--url <base> | --sandbox <name>) [--path /x | --screen <name>] [--role r] [--viewport v] [--headed]
  login <role> --manual [--url <base>]
  capture (--url <base> | --sandbox <name>) --out <dir> [--viewports a,b] [--screens globs] [--map <dir>] [--seed-names <file>] [--coverage] [--record [journeys|all|none]] [--headed] [--no-checks] [--no-tour] [--clock seed|off|<ISO>]
  compare --before <dir> --after <dir> --out <dir> [--expect <file>] [--viewports a,b]
  run [--base <ref>] [--head <ref>] [--slug <s>] [--self [--baseline]] [--json] [--full] [--expect <file>] [--viewports a,b] [--screens globs] [--map <dir>] [--seed-names <file>] [--no-cache] [--no-checks] [--no-tour] [--no-routes] [--no-standing] [--mutants named|affected|all|none] [--record journeys|all|none] [--clock seed|off|<ISO>] [--out <dir>] [--headed]
  affected [--base <ref>] [--map <dir>] [--seed-names <file>] [--json]
  routes check [--table <file>]
  routes sweep --sandbox <name> [--expect <file>] [--json]
  mutants --sandbox <name> [--all | --only <id,id>] [--proposals <file>]
  metrics [--slug <s>]
  verdict draft [--slug <s> | --results <file>] [--out <file>]
  verdict waivers [--slug <s>]
  round plan [--slug <s>] [--spec <file>] [--base <ref>] [--map <dir>] [--seed-names <file>] [--full] [--replan] [--json]
  security [--from <ref>] [--json]
  resolve [--spec <file>] [--onto <ref>] [--slug <s>]
  eyes prompt [--slug <s>] | eyes merge [--slug <s>] | eyes parse [--slug <s>]
  report build [--slug <s>] [--out <dir>] [--work <dir>] [--rebuilt-on <host>] [--check]
  report where [--slug <s>] [--json]
  report url <https://…> [--part <n>] [--slug <s>]
  report line --not-published "<why>" [--slug <s>]
  report comment [--slug <s>] [--pr <n>]
  setup questions
  setup detect
  setup suites [--write [<file>]]
  setup write --answers <file> [--force]
  standing list [--kind k] [--owner o | --unowned] [--screen glob] [--json]
  standing set <id> [--owner o] [--note t]
  standing asks <id,id…> [--out <file>]
  standing add <id,id…> [--slug <s>] [--owner o] [--note t] | standing add --fp '<fingerprint text>'
  escapes list [--open]
  escapes add --what t --caught t --ask t [--found t]
  escapes close <id> --by <commit>
  ready [--at <ref>] [--sample <n>] [--fix] [--static] [--json]
  ready status [--json]
  plan check [--slug <s>] [--head <ref>] [--map <dir>] [--seed-names <file>] [--drop] [--json] [--headed]
  prepare check [--slug <s>] [--base <ref>] [--head <ref>] [--map <dir>] [--seed-names <file>] [--final] [--json] [--headed]
  verify [--spec <file>] [--onto <ref>] [--security] [--full] [--record journeys|all|none] [--until <step>] [--json]`;

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);
const print = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

function context() {
  const mainRoot = findMainRoot();
  return { mainRoot, profile: requireProfile(mainRoot) };
}

async function cmdProfile(args) {
  const mainRoot = findMainRoot();
  const { profile, path: file, errors, warnings } = loadProfile(mainRoot);
  const verbs = Object.fromEntries(VERBS.map((v) => {
    const r = resolveVerb(v, { profile, mainRoot });
    return [v, r.kind === 'command' ? `qa.json: ${r.command}` : r.kind === 'exec' ? `${r.adapter} (${r.source})` : `NOT RUN: ${r.reason}`];
  }));
  const detected = detectAdapters({ root: mainRoot, mainRoot });
  const stubs = profile.stubs ?? {};
  if (args.json) print({ file, errors, warnings, verbs, detected, stubs });
  else {
    console.log(`profile: ${file}`);
    for (const e of errors) console.log(`  error: ${e}`);
    for (const w of warnings) console.log(`  warning: ${w}`);
    for (const [v, s] of Object.entries(verbs)) console.log(`  ${v.padEnd(7)} ${s}`);
    if (detected.length) console.log(`  detected adapters: ${detected.join(', ')}`);
    for (const [id, st] of Object.entries(stubs)) console.log(`  stub ${id} — ${st?.for ?? '?'}: ${Object.entries(st?.env ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  return errors.length ? EXIT.fail : EXIT.ok;
}

async function cmdAdapter(args) {
  const [verb, ...rest] = args._;
  if (!verb) throw new Usage('adapter <verb> [args…]');
  const { mainRoot, profile } = context();
  const cwd = process.cwd();
  const r = await runVerb(verb, { profile, mainRoot, cwd, args: rest, vars: { dir: cwd, main: mainRoot, slug: '', port: '' } });
  if (r.notRun) { console.error(r.notRun); return EXIT.notRun; }
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.code ?? EXIT.fail;
}

async function cmdSandbox(args) {
  const [sub, name] = args._;
  const { mainRoot, profile } = context();
  if (sub === 'up') {
    if (!args.at || args.at === true) throw new Usage('sandbox up --at <ref>');
    try {
      if (args.stubs === true) throw new Usage('sandbox up --stubs needs <id,id>');
      print(await sandbox.up({ mainRoot, profile, at: args.at, seed: !args['no-seed'], serve: !args['no-serve'], stubs: list(args.stubs) ?? [] }));
      return EXIT.ok;
    } catch (e) {
      if (e instanceof sandbox.SandboxError) { console.error(e.message); return e.code === 'BLOCKED' ? EXIT.blocked : EXIT.fail; }
      throw e;
    }
  }
  if (sub === 'down') { if (!name) throw new Usage('sandbox down <name>'); print(await sandbox.down({ mainRoot, profile, name })); return EXIT.ok; }
  if (sub === 'status') { if (!name) throw new Usage('sandbox status <name>'); const s = await sandbox.status({ mainRoot, name }); print(s); return s.alive ? EXIT.ok : EXIT.fail; }
  if (sub === 'list') { print(sandbox.list({ mainRoot })); return EXIT.ok; }
  if (sub === 'reap') { print(await sandbox.reap({ mainRoot, profile, maxAgeHours: Number(args.hours ?? 6) })); return EXIT.ok; }
  throw new Usage('sandbox up|down|status|list|reap');
}

// The map of `root` (a checkout or sandbox tree), unless --map / --seed-names point elsewhere.
function mapOf(args, root, profile) {
  const p = { ...profile };
  if (typeof args.map === 'string') p.map = path.resolve(args.map);
  if (typeof args['seed-names'] === 'string') p.seedNames = path.resolve(args['seed-names']);
  return { profile: p, map: loadMap({ root, profile: p }) };
}

// The checkout's files, for the sources globs: tracked and untracked (not ignored), '/'-separated.
function repoFiles(root) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}
// The map's screens with no sources, declared or recorded (a verifier's sad path is the PR's, never counted).
const unsourcedScreens = (map, recorded) => {
  const seen = new Set();
  return (map?.screens ?? []).filter((s) => {
    if (typeof s.name !== 'string' || String(s.origin ?? '').startsWith('verify:') || seen.has(s.name)) return false;
    seen.add(s.name);
    const declared = (map.screens ?? []).some((x) => x.name === s.name && Array.isArray(x.sources) && x.sources.some((g) => typeof g === 'string' && g));
    return !declared && !(Array.isArray(recorded?.[s.name]) && recorded[s.name].length);
  });
};

// --url, or a live sandbox: the base URL, the tree it serves and the adapter vars for login.
async function target(args, mainRoot) {
  if (typeof args.sandbox === 'string') {
    const s = await sandbox.status({ mainRoot, name: args.sandbox });
    if (!s.alive) return { blocked: `sandbox ${args.sandbox} is not answering at ${s.appUrl}` };
    return { baseUrl: s.appUrl, cwd: s.dir, vars: { dir: s.dir, main: mainRoot, slug: s.slug, port: String(s.port) }, seedStartedAt: s.seedStartedAt ?? null };
  }
  if (typeof args.url === 'string') return { baseUrl: args.url, cwd: mainRoot, vars: { dir: mainRoot, main: mainRoot, slug: '', port: '' }, seedStartedAt: null };
  return {};
}

// The browser clock (decision 10): --clock beats qa.json clock. 'seed' = the sandbox's seed start
// (a --url target has none, so the clock stays real), 'off' = real, else an ISO time.
function clockOf(args, profile, t) {
  const want = typeof args.clock === 'string' ? args.clock : profile.clock ?? 'seed';
  try {
    return resolveClock(want, t.seedStartedAt);
  } catch (e) {
    if (e instanceof RunError && e.code === 'USAGE') throw new Usage(e.message);
    throw e;
  }
}

const expandOpts = (map, profile) => ({ flows: map.flows, seed: map.seed, seedFile: map.seedFile, profile });

async function cmdMap(args) {
  const [sub, name] = args._;
  const { mainRoot, profile: base } = context();
  if (sub === 'check') {
    const { profile, map } = mapOf(args, mainRoot, base);
    const { errors, warnings } = validateMap(map, profile, { files: repoFiles(findRepoRoot()), missingSources: args.sources ? 'error' : 'warn' });
    // Sources (the mapper's sources phase): a screen with none, declared or recorded, is out of every PR's scope.
    const recorded = readSources(typeof args.map === 'string' ? path.resolve(args.map) : path.resolve(mainRoot, profile.map ?? 'qa/map'));
    const unsourced = unsourcedScreens(map, recorded);
    if (args.sources) for (const s of unsourced) errors.push(`${s.file ? path.basename(s.file) : '?'} ${s.name}: no sources: name the files that render it (the page the router serves for its route, and that page's own files), or no PR's change will ever walk it`);
    else if (unsourced.length) warnings.push(`${unsourced.length} screen(s) have no sources (out of every PR's scope): qa map check --sources lists them`);
    console.log(`map: ${map.screens.length} screens, ${Object.keys(map.flows).length} flows in ${map.files.length} files; seed names: ${map.seed ? map.seedFile : 'none'}`);
    for (const e of errors) console.log(`  error: ${e}`);
    for (const w of warnings) console.log(`  warning: ${w}`);
    return errors.length ? EXIT.fail : EXIT.ok;
  }
  if (sub === 'show') {
    if (!name) throw new Usage('map show <screen>');
    const { profile, map } = mapOf(args, mainRoot, base);
    const found = map.screens.filter((s) => s.name === name);
    if (!found.length) { console.error(`no screen "${name}" in the map`); return EXIT.fail; }
    let code = EXIT.ok;
    for (const s of found) {
      try { print(expandScreen(s, expandOpts(map, profile))); } catch (e) {
        if (!(e instanceof MapError)) throw e;
        console.log(`MAP ERROR ${name}: ${e.message}`);
        code = EXIT.fail;
      }
    }
    return code;
  }
  if (sub === 'probe') {
    const r = await onePage(args, mainRoot, base, 'map probe', { maxLines: Number(args.lines ?? 400) });
    if (typeof r === 'number') return r;
    console.log(`# ${r.url} — ${r.title}${r.truncated ? ` (first ${r.aria.split('\n').length - 1} of ${r.lines} lines)` : ''}`);
    console.log(r.aria);
    return EXIT.ok;
  }
  throw new Usage('map check | show <screen> | probe');
}

// One page of the app, reached by --path or by a map screen's expanded steps, then inspected
// (probeScreen's default inspect is the ARIA probe). Returns the inspect result, or an exit code.
async function onePage(args, mainRoot, base, what, extra = {}) {
  const t = await target(args, mainRoot);
  if (t.blocked) { console.error(t.blocked); return EXIT.blocked; }
  if (!t.baseUrl) throw new Usage(`${what} needs --url <base> or --sandbox <name>`);
  const { profile, map } = mapOf(args, t.cwd, base);
  let steps = null;
  let role = typeof args.role === 'string' ? args.role : null;
  if (typeof args.screen === 'string') {
    const s = map.screens.find((x) => x.name === args.screen);
    if (!s) { console.error(`no screen "${args.screen}" in the map`); return EXIT.fail; }
    try {
      const x = expandScreen(s, expandOpts(map, profile));
      steps = x.steps;
      role ??= x.role ?? null;
    } catch (e) {
      if (!(e instanceof MapError)) throw e;
      console.log(`MAP ERROR ${args.screen}: ${e.message}`);
      return EXIT.fail;
    }
  }
  const viewport = typeof args.viewport === 'string' ? args.viewport : Object.keys(profile.viewports)[0];
  const { clock } = clockOf(args, profile, t);
  const r = await probeScreen({ clock,
    profile, mainRoot, baseUrl: t.baseUrl, path: typeof args.path === 'string' ? args.path : '/', role, steps,
    viewport, pw: loadPlaywright(mainRoot), cwd: t.cwd, vars: t.vars, headless: !args.headed, ...extra,
    ...(extra.inspect ? { inspect: (page) => extra.inspect(page, profile, viewport) } : {}),
  });
  if (r.notRun) { console.log(`NOT RUN: ${r.notRun}`); return EXIT.notRun; }
  if (r.error) { console.log(`FAILED at ${r.url}: ${r.error}`); return EXIT.fail; }
  return r;
}

async function cmdChecks(args) {
  const { mainRoot, profile: base } = context();
  const r = await onePage(args, mainRoot, base, 'checks', {
    inspect: async (page, profile, viewport) => {
      const width = profile.viewports?.[viewport]?.[0] ?? page.viewportSize()?.width ?? 1440;
      const findings = await runChecks(page, { touch: width < (profile.checks?.touchBelow ?? 768), keyboardHeight: profile.checks?.keyboardHeight });
      return { url: page.url(), findings };
    },
  });
  if (typeof r === 'number') return r;
  console.log(`# ${r.url} — ${r.findings.length} finding(s)`);
  for (const f of r.findings) console.log(`${f.check}: ${f.detail}`);
  return r.findings.length ? EXIT.fail : EXIT.ok;
}

async function cmdLogin(args) {
  const [role] = args._;
  if (!role || !args.manual) throw new Usage('login <role> --manual [--url <base>]');
  const { mainRoot, profile } = context();
  const baseUrl = typeof args.url === 'string' ? args.url : profile.base;
  if (!/^https?:/.test(baseUrl)) throw new Usage('login --manual needs --url <base> (qa.json base is not a URL)');
  const pw = loadPlaywright(mainRoot);
  console.log(await manualLogin(role, { baseUrl, profile, mainRoot, openBrowser: (o) => openBrowser(pw, { profile, ...o }) }));
  return EXIT.ok;
}

// --record: absent -> `absent`; alone -> 'all'; else journeys, all or none.
function recordOf(args, what, absent = false) {
  if (args.record === undefined) return absent;
  if (args.record === true) return 'all';
  if (!['journeys', 'all', 'none'].includes(args.record)) throw new Usage(`${what} --record must be journeys, all or none`);
  return args.record;
}

async function cmdCapture(args) {
  if (!args.out || args.out === true) throw new Usage('capture --out <dir> is required');
  recordOf(args, 'capture');
  const { mainRoot, profile: base } = context();
  const t = await target(args, mainRoot);
  if (t.blocked) { console.error(t.blocked); return EXIT.blocked; }
  if (!t.baseUrl) throw new Usage('capture needs --url <base> or --sandbox <name>');
  const { baseUrl, cwd, vars } = t;
  const { why } = clockOf(args, base, t);
  console.log(`clock: ${why}`);
  const side = await captureSide({
    mainRoot, profile: base, baseUrl, cwd, vars, out: path.resolve(args.out),
    viewports: list(args.viewports), screens: typeof args.screens === 'string' ? args.screens : null,
    map: typeof args.map === 'string' ? path.resolve(args.map) : null,
    seedNames: typeof args['seed-names'] === 'string' ? path.resolve(args['seed-names']) : null,
    checks: !args['no-checks'], tour: !args['no-tour'], clock: typeof args.clock === 'string' ? args.clock : null,
    seedStartedAt: t.seedStartedAt, headless: !args.headed, record: recordOf(args, 'capture'), coverage: Boolean(args.coverage),
  });
  let worst = EXIT.ok;
  for (const r of side.viewports) {
    console.log(`${r.viewport}: ${r.captured.length} captured · ${r.failed.length} failed · ${r.notRun.length} not run`);
    for (const f of r.failed) console.log(`  ${f.mapError ? '' : 'FAILED '}${f.screen}: ${f.error}`);
    for (const n of r.notRun) console.log(`  NOT RUN ${n.screen}: ${n.why}`);
    for (const w of r.warnings) console.log(`  warning: ${w}`);
    if (r.failed.length) worst = EXIT.fail;
    else if (r.notRun.length && worst === EXIT.ok) worst = EXIT.notRun;
  }
  return worst;
}

async function cmdCompare(args) {
  for (const k of ['before', 'after', 'out']) if (!args[k] || args[k] === true) throw new Usage(`compare --${k} <dir> is required`);
  const { profile } = context();
  const r = await compare({
    beforeDir: path.resolve(args.before), afterDir: path.resolve(args.after), out: path.resolve(args.out),
    expect: typeof args.expect === 'string' ? path.resolve(args.expect) : null, profile, viewports: list(args.viewports),
  });
  for (const v of r.viewports) console.log(v.checkLine);
  console.log(`report: ${path.join(path.resolve(args.out), 'summary.md')}`);
  return r.exit;
}

async function cmdRun(args) {
  for (const k of ['base', 'head', 'slug', 'expect', 'viewports', 'screens', 'map', 'seed-names', 'clock', 'out']) {
    if (args[k] === true) throw new Usage(`run --${k} needs a value`);
  }
  if (args.mutants !== undefined && !MUTANT_MODES.includes(args.mutants)) throw new Usage(`run --mutants must be ${MUTANT_MODES.join(', ')}`);
  if (args.full && args.screens !== undefined) throw new Usage('pick --full or --screens');
  const record = recordOf(args, 'run', null);
  const { mainRoot, profile } = context();
  const abs = (k) => (typeof args[k] === 'string' ? path.resolve(args[k]) : null);
  const root = findRepoRoot();
  const slug = str(args.slug) ?? slugFor(args, root);
  // This verify's round plan (`qa round plan`); runQa uses it only when it is for the run's head.
  const round = readJsonFile(path.join(abs('out') ?? path.join(root, 'qa', slug), 'round.json'));
  let run;
  try {
    run = await runQa({
      round, waivers: waiversText(root, slug, abs('out')),
      mainRoot, repoRoot: root, profile,
      base: str(args.base), head: str(args.head) ?? 'HEAD', slug: str(args.slug), self: Boolean(args.self),
      expect: abs('expect'), viewports: list(args.viewports), screens: str(args.screens), map: abs('map'), seedNames: abs('seed-names'),
      cache: !args['no-cache'], checks: !args['no-checks'], tour: !args['no-tour'], clock: str(args.clock),
      headless: !args.headed, out: abs('out'), routes: !args['no-routes'], mutants: str(args.mutants),
      full: Boolean(args.full), record, baseline: Boolean(args.baseline), standing: !args['no-standing'],
    });
  } catch (e) {
    if (e instanceof RunError && e.code === 'USAGE') throw new Usage(e.message);
    throw e;
  }
  const V = run.dirs.verification;
  // --json: stdout carries the one JSON object, so every human line goes to stderr.
  const say = args.json ? console.error : console.log;
  for (const line of fs.readFileSync(path.join(V, 'summary.md'), 'utf8').split('\n').slice(0, 4)) say(line);
  say(`summary: ${path.join(V, 'summary.md')}`);
  say(`results: ${path.join(V, 'results.json')}`);
  if (run.mode === 'diff' || run.mode === 'suites') say(`verdict draft: ${path.join(V, 'verdict.draft.md')}`);
  if (run.report) say(`report: ${run.report}`);
  if (args.json) {
    const security = parseSecurity(readText(path.join(V, 'security.md')));
    const summary = ciSummary(run.results, run.mode === 'diff' ? draftVerdict(run.results, { security }) : run.mode === 'suites' ? draftVerdict(run.results, { final: true }) : null, V);
    print(summary);
    return summary.exit;
  }
  return run.exit;
}

// ── step 5: the verifier's commands ──────────────────────────────────────────

const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeJsonFile = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
};
// run.json is read-merge-written: keys a command does not write are kept.
const mergeRunJson = (V, change) => {
  const file = path.join(V, 'run.json');
  const cur = readJsonFile(file) ?? {};
  const next = typeof change === 'function' ? change(cur) : { ...cur, ...change };
  writeJsonFile(file, next);
  return next;
};
const slugFor = (args, root) => str(args.slug) ?? slugOf(gitOne(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }), gitOne(['rev-parse', 'HEAD'], { cwd: root }));
const notRun = (file) => { console.log(`NOT RUN: no ${file}`); return EXIT.notRun; };
// The PR's waivers: V/waivers.md; null when it does not exist.
// U8: a waiver of an eyes ruling holds only while the screen's image is the one it was given for (eyes-cache.json).
function waiversText(root, slug, out = null) {
  const V = out ?? path.join(root, 'qa', slug);
  const texts = [readText(path.join(V, 'waivers.md'))].filter((t) => t !== null);
  if (!texts.length) return null;
  const cacheFile = path.join(V, 'eyes-cache.json');
  const cache = readJsonFile(cacheFile);
  if (!cache) return texts.join('\n');
  const bound = bindEyesWaivers(texts.join('\n'), cache);
  if (bound.changed) writeJsonFile(cacheFile, bound.cache);
  return bound.text;
}

async function cmdVerdict(args) {
  if (args._[0] === 'waivers') return cmdVerdictWaivers(args);
  if (args._[0] !== 'draft') throw new Usage('verdict draft [--slug <s> | --results <file>] [--out <file>] | verdict waivers [--slug <s>]');
  let file;
  let root = null;
  if (typeof args.results === 'string') {
    file = path.resolve(args.results);
    try { root = findRepoRoot(path.dirname(file)); } catch { /* results outside a checkout: only waivers.md beside it */ }
  } else {
    root = findRepoRoot();
    file = path.join(root, 'qa', slugFor(args, root), 'results.json');
  }
  if (!fs.existsSync(file)) { console.log(`NOT RUN: no results at ${file}; run qa run first`); return EXIT.notRun; }
  const results = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (results.mode === 'self') throw new Usage('a self-test has no verdict');
  const dir = path.dirname(file);
  const eyesMd = readText(path.join(dir, 'eyes.md'));
  const draft = draftVerdict(results, {
    security: parseSecurity(readText(path.join(dir, 'security.md'))), eyes: eyesMd == null ? null : parseEyes(eyesMd),
    charterMd: readText(path.join(dir, 'charter.md')), waiversMd: waiversText(root, results.slug, dir),
  });
  const out = typeof args.out === 'string' ? path.resolve(args.out) : path.join(path.dirname(file), 'verdict.draft.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, draft.md.endsWith('\n') ? draft.md : `${draft.md}\n`);
  console.log(draft.md.split('\n')[0]);
  return draft.verdict === 'REJECT' ? EXIT.fail : EXIT.ok;
}

// The user's waivers, applied to the verdict by script: no run, no judge (1.0.0).
async function cmdVerdictWaivers(args) {
  const root = findRepoRoot();
  const slug = slugFor(args, root);
  const V = path.join(root, 'qa', slug);
  for (const f of ['verdict.md', 'results.json']) if (!fs.existsSync(path.join(V, f))) return notRun(path.join(V, f));
  const waiversMd = waiversText(root, slug, V);
  if (waiversMd === null) return notRun(`waivers.md for ${slug} (${path.join(V, 'waivers.md')})`);
  const results = readJsonFile(path.join(V, 'results.json'));
  if (!results) throw new Usage(`${path.join(V, 'results.json')} is not valid JSON`);
  const eyesMd = readText(path.join(V, 'eyes.md'));
  const inputs = {
    results, security: parseSecurity(readText(path.join(V, 'security.md'))), eyes: eyesMd == null ? null : parseEyes(eyesMd),
    charterMd: readText(path.join(V, 'charter.md')), waiversMd,
  };
  const r = applyWaivers({ verdictMd: fs.readFileSync(path.join(V, 'verdict.md'), 'utf8'), ...inputs });
  const problems = validateVerdict({ verdictMd: r.md, results, security: inputs.security, eyesMd, charterMd: inputs.charterMd, waiversMd });
  if (problems.length) {
    for (const p of problems) console.log(`${p.rule}: ${p.message}`);
    return EXIT.fail;
  }
  fs.writeFileSync(path.join(V, 'verdict.md'), r.md.endsWith('\n') ? r.md : `${r.md}\n`);
  console.log(r.md.split('\n')[0]);
  console.log(r.applied.length ? `waived: ${r.applied.join(', ')}` : 'no new waiver');
  return EXIT.ok;
}

// ── rounds (U8): the plan of each verify round, and the security line ───────

// The merge-base of HEAD and the integration branch (branches.mjs: qa.json integrationBranch,
// origin/HEAD's target, main, master), or null.
const defaultBase = (root) => defaultMergeBase(root);

// The branch's own brief: docs/briefs/<label>-<name>.md for a branch <label>/<name>.
function briefFiles(root) {
  const m = /^([^/]+)\/([^/]+)$/.exec(gitOne(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }) ?? '');
  return m ? [path.join(root, 'docs', 'briefs', `${m[1]}-${m[2]}.md`)] : [];
}

// The spec this verify judges against: --spec, else V/spec.md, else docs/briefs/<label>-<name>.md for a branch <label>/<name>.
function specText(root, slug, V, given) {
  const files = given ? [path.resolve(root, given)] : [path.join(V, 'spec.md'), ...briefFiles(root)];
  for (const f of files) {
    const t = readText(f);
    if (t !== null) return t;
  }
  return null;
}

async function cmdRound(args) {
  if (args._[0] !== 'plan') throw new Usage('round plan [--slug <s>] [--spec <file>] [--base <ref>] [--map <dir>] [--seed-names <file>] [--full] [--replan] [--json]');
  for (const k of ['slug', 'spec', 'base', 'map', 'seed-names']) if (args[k] === true) throw new Usage(`round plan --${k} needs a value`);
  const root = findRepoRoot();
  const slug = slugFor(args, root);
  const V = path.join(root, 'qa', slug);
  const { profile } = context();
  const head = gitOne(['rev-parse', 'HEAD'], { cwd: root });
  const roundFile = path.join(V, 'round.json');
  const current = readJsonFile(roundFile);
  const say = (plan, again = false) => {
    if (args.json) { print(plan); return; }
    const lines = roundLines(plan);
    if (again) lines[0] = `${lines[0]} (planned before for this head)`;
    for (const line of lines) console.log(line);
  };
  if (current?.head === head && !args.full && !args.replan) { say(current, true); return EXIT.ok; }

  // The last round: recorded from its final verdict, once its head is behind us.
  const roundsFile = path.join(V, 'rounds.json');
  let doc = readJsonFile(roundsFile) ?? { rounds: [] };
  const verdictMd = readText(path.join(V, 'verdict.md'));
  const verdict = verdictMd === null ? null : parseVerdict(verdictMd);
  const results = readJsonFile(path.join(V, 'results.json'));
  let prev = null;
  if (verdict?.head && verdict.head !== head) {
    const mine = current?.head === verdict.head ? current : null;
    const ran = results?.head?.sha === verdict.head ? results : null;
    // This head planned again (--replan, --full): the last verdict is recorded already, under its own round.
    const recorded = mine ? null : (doc.rounds ?? []).find((r) => r.head === verdict.head) ?? null;
    const record = recorded ?? roundRecord({ verdict, roundJson: mine, results: ran, last: lastRound(doc), at: new Date().toISOString() });
    doc = recordRound(doc, record);
    prev = {
      round: record.round, head: verdict.head, base: verdict.base, spec: record.spec, verdict, results: ran,
      security: mine?.security ?? (record.security ? { from: record.security } : null),
    };
  }
  const n = current?.head === head ? current.round : lastRound(doc) + 1;

  let base = null;
  if (typeof args.base === 'string') {
    base = gitOne(['rev-parse', '--verify', '--quiet', `${args.base}^{commit}`], { cwd: root });
    if (!base) throw new Usage(`unknown ref ${args.base}`);
  }
  base ??= defaultBase(root) ?? head;
  const spec = specHash(specText(root, slug, V, str(args.spec)));
  const changed = prev ? (git(['-c', 'core.quotepath=false', 'diff', '--name-only', prev.head, head], { cwd: root }) ?? []).filter(isProductChange) : [];
  const map = typeof args.map === 'string' ? path.resolve(args.map) : null;
  const seedNames = typeof args['seed-names'] === 'string' ? path.resolve(args['seed-names']) : null;
  const affected = await planAffected({ repoRoot: root, profile, baseSha: base, headSha: head, map, seedNames, slug });
  const sources = affected.mapDir ? ((await readSources(affected.mapDir)) ?? {}) : {};
  const suites = (await loadSuites({ root, profile })).suites ?? {};
  const charterMd = readText(path.join(V, 'charter.md'));
  // With a charter its rows decide (expectation rows are their evidence): only they count toward the cap.
  const deciding = parseCharter(charterMd).filter((c) => !c.advisory).map((c) => c.id);
  const plan = planRound({
    n, head, base, spec, full: Boolean(args.full), prev,
    charterMd, expectations: readJsonFile(path.join(V, 'expectations.json')),
    mutants: readJsonFile(path.join(V, 'mutants.json'))?.mutants ?? [], headMap: affected.head, sources, changed,
    profile, qa: qaHashes({ root, profile }), securityMd: readText(path.join(V, 'security.md')), suites,
    history: capHistory(doc.rounds, spec, deciding.length ? new Set(deciding) : null),
    scope: affected.affected ? { names: affected.affected.names, why: affected.affected.why } : null,
  });
  // --full on a head that has its verdict: a full round again, so that verdict's round files go to V/prev first.
  const moved = args.full && !args.replan && verdict?.head === head ? moveToPrev(V) : [];
  writeJsonFile(roundsFile, doc);
  writeJsonFile(roundFile, plan);
  say(plan);
  if (moved.length && !args.json) console.log(`prev: ${moved.join(', ')} moved to ${path.join(V, 'prev')} (the verdict of this head)`);
  return EXIT.ok;
}

async function cmdSecurity(args) {
  if (args.from === true) throw new Usage('security --from needs a ref');
  const root = findRepoRoot();
  const { profile } = context();
  const from = typeof args.from === 'string' ? gitOne(['rev-parse', '--verify', '--quiet', `${args.from}^{commit}`], { cwd: root }) : defaultBase(root);
  if (typeof args.from === 'string' && !from) throw new Usage(`unknown ref ${args.from}`);
  const changed = from ? (git(['-c', 'core.quotepath=false', 'diff', '--name-only', `${from}..HEAD`], { cwd: root }) ?? []).filter(isProductChange) : [];
  const paths = securityPaths(changed, { profile });
  const line = securityLine(paths);
  if (args.json) print({ line, paths });
  else console.log(line);
  return EXIT.ok;
}

function realDeps(root) {
  const run = (cmd, argv, timeout) => {
    try {
      return execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
      const child = `${rel}/${e.name}`;
      return e.isDirectory() ? walk(child) : [child];
    });
  };
  return {
    git: (a) => run('git', a, 30000),
    gh: (a) => run('gh', a, 20000),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    list: walk,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    integration: () => {
      const n = (loadProfile(findMainRoot(root)).profile ?? {}).integrationBranch;
      return typeof n === 'string' && /^[A-Za-z0-9][\w./-]*$/.test(n) ? n : null;
    },
  };
}

async function cmdResolve(args) {
  for (const k of ['spec', 'onto', 'slug']) if (args[k] === true) throw new Usage(`resolve --${k} needs a value`);
  const root = findRepoRoot();
  const t = resolveTarget({ repoRoot: root, spec: str(args.spec), onto: str(args.onto), slug: str(args.slug) }, realDeps(root));
  let spec = t.spec;
  if (spec?.from === 'pr') {
    const file = path.join(root, spec.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, spec.body);
    spec = { path: spec.path, from: spec.from };
  }
  for (const w of t.warnings) console.error(`warning: ${w}`);
  const { profile } = context();   // qa.json is the main checkout's; the map is this checkout's, else the main tree's
  let main = root;
  try { main = findMainRoot(root); } catch { /* not a worktree: the checkout alone */ }
  const qa = qaFilesOf({ root, main, profile, exists: fs.existsSync });
  for (const w of qa.warnings) console.error(`warning: ${w}`);
  print({ ...t, pr: t.pr && { number: t.pr.number, base: t.pr.base, url: t.pr.url }, spec, map: qa.map, seedNames: qa.seedNames, qaFiles: { from: qa.from } });
  return EXIT.ok;
}

// Where a run's screenshots live: the work dir the report sits in, and the base cache when it was used.
function eyesContext(results, run, mainRoot, slug) {
  const work = results.report ? path.dirname(path.dirname(results.report)) : path.join(mainRoot, 'qa-artifacts', 'runs', slug);
  return { work, cacheDir: run.cache?.hit ? run.cache.dir : null, exists: fs.existsSync };
}

async function cmdEyes(args) {
  const [sub] = args._;
  if (!['prompt', 'merge', 'parse'].includes(sub)) throw new Usage('eyes prompt [--slug <s>] | eyes merge [--slug <s>] | eyes parse [--slug <s>]');
  const root = findRepoRoot();
  const slug = slugFor(args, root);
  const V = path.join(root, 'qa', slug);
  if (sub === 'parse') {
    const file = path.join(V, 'eyes.md');
    if (!fs.existsSync(file)) return notRun(file);
    print(parseEyes(fs.readFileSync(file, 'utf8')));
    return EXIT.ok;
  }
  const cacheFile = path.join(V, 'eyes-cache.json');
  if (sub === 'merge') {
    const cache = readJsonFile(cacheFile);
    if (!cache) return notRun(cacheFile);
    const eyesFile = path.join(V, 'eyes.md');
    const eyesMd = readText(eyesFile);
    const fresh = (cache.current?.targets ?? []).filter((t) => !(t.hash && cache.rulings?.[t.hash]));
    if (eyesMd === null && fresh.length) return notRun(eyesFile);
    const m = mergeEyes({ slug, eyesMd, cache });
    fs.writeFileSync(eyesFile, m.md);
    writeJsonFile(cacheFile, m.cache);
    console.log(`eyes: ${m.added.length} new ruling(s) kept, ${m.cached.length} from the cache`);
    return EXIT.ok;
  }
  const resultsFile = path.join(V, 'results.json');
  if (!fs.existsSync(resultsFile)) return notRun(resultsFile);
  const { mainRoot, profile } = context();
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const run = readJsonFile(path.join(V, 'run.json')) ?? {};
  const targets = eyesTargets(results, eyesContext(results, run, mainRoot, slug));
  if (!targets.length) { console.log('no changed or new screen: no eyes pass'); return EXIT.ok; }
  // The eyes cache (U8): a screenshot seen before keeps its ruling; only new images go to the eyes pass.
  const plan = readJsonFile(path.join(V, 'round.json'));
  const roundN = plan?.head === results.head?.sha ? plan.round : (results.round?.n ?? null);
  const hashOf = (t) => (t.after && fs.existsSync(t.after) ? imageHash(fs.readFileSync(t.after)) : null);
  const split = eyesRound({ targets, cache: readJsonFile(cacheFile) ?? {}, hashOf, round: roundN, head: results.head?.sha ?? null });
  writeJsonFile(cacheFile, split.cache);
  const out = path.join(V, 'eyes-prompt.md');
  if (!split.fresh.length) {
    const m = mergeEyes({ slug, eyesMd: null, cache: split.cache });
    fs.writeFileSync(path.join(V, 'eyes.md'), m.md);
    fs.rmSync(out, { force: true });
    console.log(`no new screenshot: ${split.cached.length} screen(s) seen before; eyes.md written from the cache, no eyes pass`);
    return EXIT.ok;
  }
  fs.writeFileSync(out, eyesPrompt({
    slug, out: V, targets: split.fresh, questions: profile.eyes?.questions ?? [], asks: openAsks(readText(path.join(root, 'qa', 'escapes.md'))),
  }));
  console.log(out);
  if (split.cached.length) console.log(`cached: ${split.cached.length} screen(s) seen before (their rulings are kept); after the eyes pass run qa eyes merge`);
  return EXIT.ok;
}

const REPORT_USAGE = 'report build [--slug <s>] [--out <dir>] [--work <dir>] [--check] | report where [--slug <s>] [--json] | report url <https://…> [--part <n>] [--slug <s>] | report line --not-published "<why>" [--slug <s>] | report comment [--slug <s>] [--pr <n>]';

async function cmdReport(args) {
  const sub = args._[0];
  if (sub === 'where') return cmdReportWhere(args);
  if (sub === 'url') return cmdReportUrl(args);
  if (sub === 'line') return cmdReportLine(args);
  if (sub === 'comment') return cmdReportComment(args);
  if (sub !== 'build') throw new Usage(REPORT_USAGE);
  if (args.judge !== undefined) throw new Usage('report build --judge is gone: each round has a fresh judge (U8)');
  for (const k of ['out', 'work', 'rebuilt-on']) if (args[k] === true) throw new Usage(`report build --${k} needs a value`);
  const root = findRepoRoot();
  const slug = slugFor(args, root);
  const V = typeof args.out === 'string' ? path.resolve(args.out) : path.join(root, 'qa', slug);
  const verdictFile = path.join(V, 'verdict.md');
  const resultsFile = path.join(V, 'results.json');
  for (const f of [verdictFile, resultsFile]) if (!fs.existsSync(f)) return notRun(f);
  const verdictMd = fs.readFileSync(verdictFile, 'utf8');
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const eyesMd = readText(path.join(V, 'eyes.md'));
  // A rebuilt report shows the original judgement, validated when it was made: never validated again here.
  const problems = typeof args['rebuilt-on'] === 'string' ? [] : validateVerdict({
    verdictMd, results, security: parseSecurity(readText(path.join(V, 'security.md'))), eyesMd, charterMd: readText(path.join(V, 'charter.md')),
    waiversMd: waiversText(root, slug, V),
  });
  if (problems.length) {
    for (const p of problems) console.log(`${p.rule}: ${p.message}`);
    return EXIT.fail;
  }
  if (args.check) { console.log('valid'); return EXIT.ok; }

  const run = readJsonFile(path.join(V, 'run.json')) ?? {};
  const mainRoot = findMainRoot();
  const ctx = eyesContext(results, run, mainRoot, slug);
  if (typeof args.work === 'string') ctx.work = path.resolve(args.work);
  const targets = eyesTargets(results, { ...ctx, ids: shotsFor(verdictMd, results) });
  const shots = {};
  for (const t of targets) {
    const entry = {};
    for (const side of ['before', 'after']) {
      if (!t[side]) continue;
      const rel = ['shots', t.viewport, side, `${t.key}.png`].join('/');
      fs.mkdirSync(path.dirname(path.join(V, rel)), { recursive: true });
      fs.copyFileSync(t[side], path.join(V, rel));
      entry[side] = rel;
    }
    if (entry.before || entry.after) shots[t.id] = entry;
  }
  // Recorded journeys: each video still on disk is copied beside the report, its checkpoints named by the status of their screen.
  const statusOf = new Map((results.screens ?? []).map((sc) => [sc.id, sc.status]));
  const videos = [];
  for (const v of results.videos ?? []) {
    if (!v?.file || !fs.existsSync(v.file)) continue;
    const rel = ['shots', 'video', v.viewport, `${v.screen}.webm`].join('/');
    fs.mkdirSync(path.dirname(path.join(V, rel)), { recursive: true });
    fs.copyFileSync(v.file, path.join(V, rel));
    videos.push({
      id: v.id, viewport: v.viewport, screen: v.screen, src: rel,
      checkpoints: (v.checkpoints ?? []).map((cp) => ({ ...cp, status: statusOf.get(`scr:${v.viewport}/${v.screen}__${cp.state}`) ?? 'not captured' })),
    });
  }
  const reportFile = path.join(V, 'report.html');
  const summaryMd = readText(path.join(V, 'summary.md')) ?? '';
  const eyes = eyesMd ? parseEyes(eyesMd) : [];
  fs.writeFileSync(reportFile, reportHtml({
    verdictMd, summaryMd, results, eyes, shots, videos,
    rebuilt: typeof args['rebuilt-on'] === 'string' ? { host: args['rebuilt-on'], at: new Date().toISOString(), head: parseVerdict(verdictMd).head } : null,
  }));
  // A rebuilt report is for this machine only: it is never published, so it gets no publish set.
  if (typeof args['rebuilt-on'] !== 'string') {
    const plan = writePublishSet({ root, V, slug, verdictMd, results, summaryMd, eyes, shots, videos });
    console.error(`publish set: ${plan.artifacts.length} artifact(s), ${plan.total.files} file(s), ${(plan.total.bytes / 1e6).toFixed(1)} MB${plan.left.length ? `, ${plan.left.length} left out` : ''} (${path.join(V, 'publish.json')})`);
  }
  const v = parseVerdict(verdictMd);
  const at = new Date().toISOString();
  mergeRunJson(V, (cur) => {
    const verdicts = [...(cur.verdicts ?? [])];
    const last = verdicts[verdicts.length - 1];
    if (!(last && last.head === v.head && last.verdict === v.verdict)) verdicts.push({ head: v.head, verdict: v.verdict, at });
    return { ...cur, verdicts };
  });
  console.log(reportFile);
  return EXIT.ok;
}

// ── report: where it goes, its URL, its line, the PR comment (rework U9) ──────

function publishLimits() {
  const raw = process.env.QA_PUBLISH_LIMITS;
  if (!raw) return LIMITS;
  try { return { ...LIMITS, ...JSON.parse(raw) }; } catch { throw new Usage('QA_PUBLISH_LIMITS is not JSON'); }
}

// The PR's artifact URLs from an earlier round, so this round republishes the same artifact: V/published.json, else a
// Report URL in an earlier verdict. null: none yet.
function publishedRecord(root, slug, V) {
  const j = readJsonFile(path.join(V, 'published.json'));
  if (j && Array.isArray(j.parts)) return j;
  for (const file of [path.join(V, 'verdict.md'), path.join(V, 'prev', 'verdict.md')]) {
    const r = parseVerdict(readText(file) ?? '').report;
    if (r?.kind === 'url') return { slug, parts: [r.url], retired: [] };
  }
  return null;
}

// V/artifact-<n>.html and V/publish.json: what goes up, and where each file is shown.
function writePublishSet({ root, V, slug, verdictMd, results, summaryMd, eyes, shots, videos }) {
  const limits = publishLimits();
  const v = parseVerdict(verdictMd);
  const name = v.slug ?? slug;
  const urls = publishedRecord(root, slug, V)?.parts ?? [];
  const pubShots = publishedShots(results, shots);
  const items = mediaItems({ shots: pubShots, videos }).map((it) => {
    const from = path.join(V, it.path);
    return { ...it, from, bytes: fs.statSync(from).size };
  });
  const { parts, left } = packParts(items, limits);
  const place = placeOf({ parts, left, urls });
  for (const f of fs.readdirSync(V)) if (/^artifact-\d+\.html$/.test(f)) fs.rmSync(path.join(V, f), { force: true });
  const pages = parts.map((partItems, i) => {
    const file = path.join(V, `artifact-${i + 1}.html`);
    const html = i === 0
      ? reportHtml({ verdictMd, summaryMd, results, eyes, shots: pubShots, videos, fragment: true, place })
      : partHtml({ slug: name, verdict: v.verdict, head: v.head, part: i + 1, of: parts.length, items: partItems, back: urls[0] ?? null });
    fs.writeFileSync(file, html);
    return { file, bytes: Buffer.byteLength(html), title: i === 0 ? `${name} QA report` : `${name} QA report part ${i + 1}` };
  });
  const plan = publishPlan({ slug, head: v.head, verdict: v.verdict, parts, left, pages, urls, limits });
  fs.writeFileSync(path.join(V, 'publish.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

// The slug's folder (qa/<slug>) and its verdict for the report sub-commands; null verdict: not there.
function reportContext(args) {
  if (args.slug === true) throw new Usage('--slug needs a value');
  const root = findRepoRoot();
  const slug = slugFor(args, root);
  const V = path.join(root, 'qa', slug);
  const verdictFile = path.join(V, 'verdict.md');
  return { root, slug, V, verdictFile, verdictMd: readText(verdictFile) };
}

async function cmdReportWhere(args) {
  const { root, slug, V, verdictFile, verdictMd } = reportContext(args);
  if (verdictMd === null) return notRun(verdictFile);
  const session = sessionAccount();
  const launcher = null;   // no launch record: a cloud session publishes on its own account
  const d = decideReport({ where: whereAmI(), session, launcher });
  let line = null;
  let artifacts = [];
  let left = [];
  if (!d.publish) {
    const report = path.join(V, 'report.html');
    if (d.where === 'local') line = fs.existsSync(report) ? localLine(os.hostname(), report) : notPublishedLine('no report.html (run qa report build first)');
    else line = notPublishedLine(d.reason);
  } else {
    const head = parseVerdict(verdictMd).head;
    const plan = readJsonFile(path.join(V, 'publish.json'));
    if (!plan || plan.head !== head || !Array.isArray(plan.artifacts)) {
      d.publish = false;
      d.why = plan ? `the publish set is for another head than the verdict's (${String(head).slice(0, 12)})` : 'there is no publish set';
      line = notPublishedLine(`${d.why} (run qa report build first)`);
    } else {
      left = plan.left ?? [];
      artifacts = [...plan.artifacts].reverse().map((a) => ({
        part: a.part, of: a.of, file_path: a.page, files: a.files, url: a.url, title: a.title, icon: a.icon,
        description: a.description, capabilities: a.capabilities, then: `qa report url <url> --part ${a.part} --slug ${slug}`,
      }));
    }
  }
  if (line) fs.writeFileSync(verdictFile, withReportLine(verdictMd, line));
  if (args.json) {
    print({ where: d.where, publish: d.publish, why: d.why, session, launcher, line, artifacts, left });
    return EXIT.ok;
  }
  console.log(d.where === 'local' ? 'local' : d.publish ? 'cloud publish' : 'cloud not published');
  console.log(`why: ${d.why}`);
  if (line) console.log(`wrote: ${line}`);
  for (const a of artifacts) {
    const bytes = a.files ? Object.keys(a.files).length : 0;
    console.log(`part ${a.part} of ${a.of}: publish ${a.file_path} with ${bytes} file(s)${a.url ? `, url ${a.url}` : ', a new artifact'}${a.capabilities ? ', capabilities assets' : ''} — then: ${a.then}`);
  }
  for (const l of left) console.log(`left out: ${l.path} — ${l.why}`);
  return EXIT.ok;
}

async function cmdReportUrl(args) {
  const url = args._[1];
  if (typeof url !== 'string' || !/^https:\/\/\S+$/.test(url) || args._.length > 2) throw new Usage('report url <https://…> [--part <n>] [--slug <s>]');
  const part = args.part === undefined ? 1 : Number(args.part);
  if (args.part === true || !Number.isInteger(part) || part < 1) throw new Usage('report url … --part needs a whole number from 1');
  const { root, slug, V, verdictFile, verdictMd } = reportContext(args);
  if (verdictMd === null) return notRun(verdictFile);
  const plan = readJsonFile(path.join(V, 'publish.json'));
  const record = recordUrl(publishedRecord(root, slug, V), {
    slug, part, url, head: parseVerdict(verdictMd).head, at: new Date().toISOString(), of: part === 1 ? plan?.artifacts?.length ?? null : null,
  });
  fs.writeFileSync(path.join(V, 'published.json'), `${JSON.stringify(record, null, 2)}\n`);
  for (const f of fs.readdirSync(V)) {
    if (!/^artifact-\d+\.html$/.test(f)) continue;
    const file = path.join(V, f);
    const html = fs.readFileSync(file, 'utf8');
    const linked = linkPart(html, part, url);
    if (linked !== html) fs.writeFileSync(file, linked);
  }
  console.log(`recorded part ${part}: ${url}`);
  if (part === 1) {
    const line = urlLine(url);
    fs.writeFileSync(verdictFile, withReportLine(verdictMd, line));
    console.log(`wrote: ${line}`);
  }
  return EXIT.ok;
}

async function cmdReportLine(args) {
  const why = str(args['not-published'])?.trim();
  if (!why) throw new Usage('report line --not-published "<why>" [--slug <s>]');
  const { verdictFile, verdictMd } = reportContext(args);
  if (verdictMd === null) return notRun(verdictFile);
  const line = notPublishedLine(why);
  fs.writeFileSync(verdictFile, withReportLine(verdictMd, line));
  console.log(`wrote: ${line}`);
  return EXIT.ok;
}

async function cmdReportComment(args) {
  let pr = null;
  if (args.pr !== undefined) {
    pr = Number(args.pr);
    if (!Number.isInteger(pr) || pr < 1) throw new Usage('report comment --pr needs a PR number');
  }
  const { root, slug, verdictFile, verdictMd } = reportContext(args);
  if (verdictMd === null) return notRun(verdictFile);
  const bin = process.env.QA_GH || 'gh';
  const gh = (argv, input) => {
    const r = spawnSync(bin, argv, { cwd: root, input, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.error && ['ENOENT', 'EACCES'].includes(r.error.code)) return { missing: `${bin}: ${r.error.code}` };
    if (r.error) return { status: 1, stdout: '', stderr: r.error.message };
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const done = postComment({ body: commentBody({ verdictMd, slug }), pr, gh });
  console.log(done.skipped ? `no comment: ${done.skipped}` : `comment: ${done.action} ${done.url}`);
  return EXIT.ok;
}

// ── step 6: routes, mutants, metrics ─────────────────────────────────────────

// The seed names of a tree, for $seed.* tokens in the route table (none readable -> no seed).
function seedOf(root, profile) {
  try {
    const m = loadMap({ root, profile });
    return { seed: m.seed, seedName: path.basename(m.seedFile ?? 'seed.json') };
  } catch {
    return { seed: null, seedName: path.basename(profile.seedNames ?? 'qa/seed.json') };
  }
}

// A sandbox that is registered, or a usage error naming it.
async function sandboxOf(args, mainRoot, profile, what) {
  if (typeof args.sandbox !== 'string') throw new Usage(`${what} needs --sandbox <name>`);
  try {
    return await sandbox.status({ mainRoot, name: args.sandbox, profile });
  } catch (e) {
    if (e instanceof sandbox.SandboxError) throw new Usage(e.message);
    throw e;
  }
}

async function cmdRoutes(args) {
  const [sub] = args._;
  if (sub === 'check') {
    if (args.table === true) throw new Usage('routes check --table needs a file');
    const { profile: base } = context();
    const root = findRepoRoot();
    const profile = typeof args.table === 'string' ? { ...base, routes: { ...base.routes, table: args.table } } : base;
    const { seed, seedName } = seedOf(root, profile);
    const table = await loadRouteTable({ root, profile, seed, seedName });
    if (!table.file) { console.log('no route table'); return EXIT.notRun; }
    console.log(`${table.file}: ${table.rows.length} route(s)`);
    for (const e of table.errors) console.log(`error: ${e}`);
    return table.errors.length ? EXIT.fail : EXIT.ok;
  }
  if (sub === 'sweep') {
    if (args.expect === true) throw new Usage('routes sweep --expect needs a file');
    const { mainRoot, profile } = context();
    const s = await sandboxOf(args, mainRoot, profile, 'routes sweep');
    if (!s.alive) { console.error(`sandbox ${args.sandbox} is not answering at ${s.appUrl}`); return EXIT.blocked; }
    const vars = { dir: s.dir, main: mainRoot, slug: s.slug, port: String(s.port) };
    const actors = await routeActors({ profile, mainRoot, descriptor: s, vars, runVerb });
    let registered = null;
    try {
      const r = await runVerb('routes', { profile, mainRoot, cwd: s.dir, vars });
      if (Array.isArray(r?.json)) registered = r.json;
    } catch { /* no routes verb: unlisted and stale are not judged */ }
    let expectations = [];
    if (typeof args.expect === 'string') {
      const entries = readJsonFile(path.resolve(args.expect));
      if (!Array.isArray(entries)) throw new Usage(`${args.expect} must be a JSON array of expectations`);
      expectations = entries.filter((e) => e && typeof e === 'object' && e.route !== undefined);
    }
    const { seed, seedName } = seedOf(s.dir, profile);
    const swept = await sweepSide({ root: s.dir, profile, baseUrl: actors.baseUrl ?? s.appUrl, actors: actors.headers, expectations, seed, seedName, registered });
    if (args.json) print(swept);
    else if (swept.notRun) console.log(`NOT RUN: ${swept.notRun}`);
    else {
      const problems = swept.probes.filter((p) => p.problem);
      for (const p of problems) console.log(`${p.problem} — ${p.route} ${p.kind} (${p.actor})`);
      for (const u of swept.unlisted) console.log(`unlisted: ${u.method} ${u.path}`);
      for (const st of swept.stale) console.log(`stale: ${st.method} ${st.path}`);
      for (const x of swept.expectations ?? []) console.log(`expectation ${x.name}: ${x.result} — ${x.detail}`);
      const ran = swept.probes.filter((p) => p.status !== null && p.status !== undefined && !String(p.kind).startsWith('expect:')).length;
      console.log(`${ran} probes · ${problems.length} problem(s) · ${swept.unlisted.length} unlisted · ${swept.stale.length} stale`);
    }
    if (swept.notRun) return EXIT.notRun;
    return swept.probes.some((p) => p.problem) || swept.unlisted.length || swept.stale.length ? EXIT.fail : EXIT.ok;
  }
  throw new Usage('routes check [--table <file>] | routes sweep --sandbox <name> [--expect <file>] [--json]');
}

// The files this branch changes against the default branch (merge-base of HEAD and it, to HEAD).
function changedFiles(root) {
  const mb = defaultMergeBase(root);
  if (mb) return (git(['-c', 'core.quotepath=false', 'diff', '--name-only', `${mb}..HEAD`], { cwd: root }) ?? []).filter(isProductChange);
  console.error('warning: no default branch found; "affected" counts only proposed mutants');
  return [];
}

async function cmdMutants(args) {
  for (const k of ['only', 'proposals']) if (args[k] === true) throw new Usage(`mutants --${k} needs a value`);
  const { mainRoot, profile } = context();
  const s = await sandboxOf(args, mainRoot, profile, 'mutants');
  const loaded = await loadMutants({ root: s.dir, profile, proposals: typeof args.proposals === 'string' ? path.resolve(args.proposals) : null });
  for (const e of loaded.errors) console.log(`error: ${e}`);
  let selected;
  let mode = 'affected';
  if (typeof args.only === 'string') {
    const ids = list(args.only);
    const unknown = ids.filter((id) => !loaded.mutants.some((m) => m.id === id));
    if (unknown.length) throw new Usage(`no mutant ${unknown.join(', ')} (known: ${loaded.mutants.map((m) => m.id).join(', ') || 'none'})`);
    selected = loaded.mutants.filter((m) => ids.includes(m.id));
    mode = 'all';
  } else if (args.all) {
    selected = selectMutants(loaded.mutants, { mode: 'all' });
    mode = 'all';
  } else {
    selected = selectMutants(loaded.mutants, { mode: 'affected', changed: changedFiles(findRepoRoot()) });
  }
  if (!selected.length) { console.log('no mutants selected'); return EXIT.notRun; }
  const vars = { dir: s.dir, main: mainRoot, slug: s.slug, port: String(s.port) };
  const logDir = path.join(mainRoot, 'qa-artifacts', 'mutants', s.name);
  fs.mkdirSync(logDir, { recursive: true });
  if (loaded.note) console.error(`note: ${loaded.note}`);
  const runSuite = makeRunSuite({ dir: s.dir, suites: loaded.suites, profile, mainRoot, vars, logDir, runVerb });
  const runKill = makeRunKill({ dir: s.dir, suites: loaded.suites, profile, mainRoot, vars, logDir, runVerb });
  let ran;
  try {
    ran = await runMutants({ dir: s.dir, mutants: selected, suites: loaded.suites, runSuite, runKill, log: (...a) => console.error(...a) });
  } catch (e) {
    console.error(`FAIL: ${String(e?.message ?? e).split('\n')[0]}`);
    return EXIT.fail;
  }
  for (const m of ran.mutants) console.log(`${m.verdict} ${m.mutant} — ${m.detail || m.breaks}`);
  const r = mutantsResult(ran, { mode, file: loaded.file, errors: loaded.errors });
  console.log(`${r.killed}/${r.run} killed`);
  return r.survived.length || r.stale.length ? EXIT.fail : EXIT.ok;
}

async function cmdMetrics(args) {
  const root = findRepoRoot();
  const file = path.join(root, 'qa', slugFor(args, root), 'results.json');
  if (!fs.existsSync(file)) return notRun('results.json (run qa run first)');
  const results = readJsonFile(file);
  if (!results) throw new Usage(`${file} is not valid JSON`);
  const m = results.metrics ?? { captures: 0, flags: [], standing: 0 };
  console.log(`${m.captures} captures · ${m.flags.length} flag(s) · ${m.standing} standing`);
  for (const f of m.flags) console.log(`- [${f.id}] ${metricsLine(f)}`);
  return EXIT.ok;
}

// ── step 7: the affected set ─────────────────────────────────────────────────

// merge-base of HEAD and `ref`, or of HEAD and the default branch when no ref is given.
function baseShaOf(root, ref) {
  const tip = (r) => gitOne(['rev-parse', '--verify', '--quiet', `${r}^{commit}`], { cwd: root });
  if (ref) {
    const sha = tip(ref);
    if (!sha) throw new Usage(`unknown ref ${ref}`);
    return gitOne(['merge-base', 'HEAD', sha], { cwd: root }) ?? sha;
  }
  const mb = defaultMergeBase(root);
  if (mb) return mb;
  throw new Usage('no base branch; pass --base <ref>, or set integrationBranch in qa.json');
}

async function cmdAffected(args) {
  for (const k of ['base', 'map', 'seed-names']) if (args[k] === true) throw new Usage(`affected --${k} needs a value`);
  const { profile } = context();
  const root = findRepoRoot();
  const headSha = gitOne(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root });
  if (!headSha) throw new Usage('no commit to compare');
  const baseSha = baseShaOf(root, str(args.base));
  const plan = await planAffected({
    repoRoot: root, profile, baseSha, headSha,
    map: typeof args.map === 'string' ? path.resolve(args.map) : null,
    seedNames: typeof args['seed-names'] === 'string' ? path.resolve(args['seed-names']) : null,
    slug: slugFor(args, root),
  });
  if (!plan.affected) { console.error('the head map could not be read: run qa map check'); return EXIT.fail; }
  const a = plan.affected;
  if (args.json) print(a);
  else {
    const unmapped = a.unmapped ?? [];
    for (const name of a.names) console.log(`- ${name}: ${a.why[name]}`);
    for (const file of unmapped) console.log(`- unmapped: ${file}`);
    if (a.mapThese?.length) console.log(`- map these (no known sources, not walked): ${a.mapThese.join(', ')}`);
    console.log(`${a.names.length} of ${a.total} affected · ${a.unknown} without known sources${unmapped.length > 0 ? ` · ${unmapped.length} changed UI file(s) no screen walks` : ''}`);
  }
  return EXIT.ok;
}

// ── step 8: setup, standing, escapes ─────────────────────────────────────────

const today = () => localDate();
const needValue = (args, what, keys) => {
  for (const k of keys) if (args[k] === true) throw new Usage(`${what} --${k} needs a value`);
};

async function cmdSetup(args) {
  const [sub] = args._;
  if (sub === 'questions') {
    QUESTIONS.forEach((q, i) => console.log(`${i + 1}. ${q.key}: ${q.ask}`));
    return EXIT.ok;
  }
  if (sub === 'suites') {
    if (args.write !== undefined) {
      // --write with no file: the move alone (the old SUITES of qa/mutants.* into qa/suites.json).
      const chosen = args.write === true ? {} : readJsonFile(path.resolve(args.write));
      if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) throw new Usage(`${args.write} is not a JSON object of suites ({ "<id>": <suite> })`);
      if (args.write === true && !(await loadSuites({ root: findRepoRoot(), profile: {} })).legacy) {
        console.log('nothing to move: no suites in qa/mutants.* (their old place)');
        return EXIT.ok;
      }
      let r;
      try {
        r = await writeSuites(findRepoRoot(), chosen);
      } catch (e) {
        console.error(e.message);
        return EXIT.fail;
      }
      const said = [['added', r.added], ['kept', r.kept], ['moved from the old place', r.moved]].filter(([, ids]) => ids.length).map(([what, ids]) => `${what} ${ids.join(', ')}`);
      console.log(`wrote ${r.file}${said.length ? `: ${said.join('; ')}` : ''}`);
      return EXIT.ok;
    }
    print(await detectSuites(findRepoRoot()));
    return EXIT.ok;
  }
  if (sub !== 'detect' && sub !== 'write') throw new Usage('setup questions | detect | suites | write --answers <file> [--force]');
  const root = findRepoRoot();
  const detected = detectAdapters({ root, mainRoot: findMainRoot() });
  if (sub === 'detect') {
    print({ adapters: detected, hasProfile: fs.existsSync(path.join(root, 'qa.json')) });
    return EXIT.ok;
  }
  if (typeof args.answers !== 'string') throw new Usage('setup write --answers <file> is required');
  const answers = readJsonFile(path.resolve(args.answers));
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Usage(`${args.answers} is not a JSON object of answers`);
  let profile;
  try {
    profile = draftProfile(answers, { detected });
  } catch (e) {
    console.error(e.message);
    return EXIT.fail;
  }
  const { written, kept } = writeSetup(root, profile, { force: Boolean(args.force), today: today() });
  for (const f of written) console.log(`wrote ${f}`);
  for (const f of kept) console.log(`kept ${f}`);
  return EXIT.ok;
}

const standingLine = (r) => `- [${r.id}] ${r.screen} ${r.kind}: ${r.finding}${r.owner ? ` (owner ${r.owner})` : ''}`;

// The fingerprints `standing add` was asked for: from --fp, or from the run's results (a chrome candidate or a finding).
function wantedFingerprints(args, ids) {
  if (typeof args.fp === 'string') {
    const fp = parseFingerprint(args.fp);
    return fp ? { fps: [fp] } : { error: `not a fingerprint: ${args.fp} (want '<check> on <role> "<name>" in <landmark>')` };
  }
  const root = findRepoRoot();
  const file = path.join(root, 'qa', slugFor(args, root), 'results.json');
  const text = readText(file);
  if (text === null) return { notRun: `NOT RUN: no ${file}` };
  const results = JSON.parse(text);
  const fps = [];
  for (const id of ids) {
    const chrome = (results.chrome ?? []).find((c) => c.id === id);
    const finding = [...(results.checks?.new ?? []), ...(results.tour?.new ?? [])].find((f) => f.id === id);
    if (!chrome && !finding) return { error: `no chrome candidate or finding ${id} in ${file}` };
    const fp = chrome?.fingerprint ?? finding.fingerprint;
    if (!fp) return { error: `no fingerprint for ${id}: its capture recorded none (captured before fingerprints, or no element)` };
    fps.push(fp);
  }
  return { fps };
}

async function cmdStanding(args) {
  const [sub, id] = args._;
  if (!['list', 'set', 'asks', 'add'].includes(sub)) throw new Usage('standing list | set <id> | asks <id,id…> | add <id,id…>');
  if (sub === 'add') {
    needValue(args, 'standing add', ['slug', 'owner', 'note', 'fp']);
    const ids = list(id) ?? [];
    if (!ids.length && typeof args.fp !== 'string') throw new Usage("standing add <id,id…> [--slug <s>] | standing add --fp '<fingerprint text>'");
    const got = wantedFingerprints(args, ids);
    if (got.notRun) { console.log(got.notRun); return EXIT.notRun; }
    if (got.error) { console.error(got.error); return EXIT.fail; }
    const file = path.join(findRepoRoot(), 'qa', 'standing.md');
    const before = readText(file);
    const slug = str(args.slug) ?? slugFor(args, findRepoRoot());
    const out = addFingerprints(before, got.fps, { slug, date: today(), owner: str(args.owner) ?? '', note: str(args.note) ?? '' });
    if (out.added.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, out.text);
    }
    const rows = readStanding(out.text);
    for (const fp of got.fps) {
      const fid = fingerprintId(fp);
      if (out.added.includes(fid)) console.log(standingLine(rows.find((r) => r.id === fid)));
      else console.log(`- [${fid}] already standing: ${fingerprintText(fp)}`);
    }
    return EXIT.ok;
  }
  needValue(args, `standing ${sub}`, ['kind', 'owner', 'screen', 'out', 'note'].filter((k) => !(sub === 'set' && (k === 'owner' || k === 'note'))));
  const file = path.join(findRepoRoot(), 'qa', 'standing.md');
  const text = readText(file);
  if (text === null) { console.log('no qa/standing.md'); return EXIT.notRun; }
  const rows = readStanding(text);
  if (sub === 'list') {
    const picked = pickStanding(rows, { kind: str(args.kind), owner: str(args.owner) ?? undefined, unowned: Boolean(args.unowned), screen: str(args.screen) });
    if (args.json) print(picked);
    else {
      for (const r of picked) console.log(standingLine(r));
      console.log(`${picked.length} of ${rows.length}`);
    }
    return EXIT.ok;
  }
  if (sub === 'set') {
    if (!id) throw new Usage('standing set <id> [--owner o] [--note t]');
    // A flag with no value (`--owner ''` parses so) empties the cell.
    const cell = (v) => (v === true ? '' : typeof v === 'string' ? v : undefined);
    const change = { owner: cell(args.owner), note: cell(args.note) };
    if (change.owner === undefined && change.note === undefined) throw new Usage('standing set <id> needs --owner or --note');
    let next;
    try {
      next = setStanding(text, id, change);
    } catch (e) {
      console.error(e.message);
      return EXIT.fail;
    }
    fs.writeFileSync(file, next);
    const row = readStanding(next).find((r) => r.id === id);
    console.log(standingLine(row));
    if (row.note) console.log(`  note: ${row.note}`);
    return EXIT.ok;
  }
  const ids = list(id);
  if (!ids?.length) throw new Usage('standing asks <id,id…> [--out <file>]');
  const picked = [];
  for (const wanted of ids) {
    const row = rows.find((r) => r.id === wanted);
    if (!row) { console.error(`no standing item ${wanted}`); return EXIT.fail; }
    picked.push(row);
  }
  const md = asksMd(picked, { date: today() });
  if (typeof args.out === 'string') {
    const out = path.resolve(args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md);
    console.log(out);
  } else process.stdout.write(md);
  return EXIT.ok;
}

async function cmdEscapes(args) {
  const [sub, id] = args._;
  if (!['list', 'add', 'close'].includes(sub)) throw new Usage('escapes list | add | close <id> --by <commit>');
  needValue(args, `escapes ${sub}`, ['what', 'caught', 'ask', 'found', 'by']);
  const root = findRepoRoot();
  const file = path.join(root, 'qa', 'escapes.md');
  const text = readText(file);
  if (sub === 'add') {
    let added;
    try {
      added = addEscape(text, { found: str(args.found) ?? today(), what: str(args.what) ?? '', caught: str(args.caught) ?? '', ask: str(args.ask) ?? '' });
    } catch (e) {
      console.error(e.message);
      return EXIT.fail;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, added.text);
    console.log(added.id);
    return EXIT.ok;
  }
  if (sub === 'close') {
    if (!id) throw new Usage('escapes close <id> --by <commit>');
    if (typeof args.by !== 'string') throw new Usage('escapes close <id> --by <commit> is required');
    const sha = gitOne(['rev-parse', '--verify', '--quiet', `${args.by}^{commit}`], { cwd: root });
    if (!sha) throw new Usage(`unknown commit ${args.by}`);
    if (text === null) { console.log('no qa/escapes.md'); return EXIT.notRun; }
    let map;
    try {
      map = loadProfile(findMainRoot()).profile.map;
    } catch (e) {
      if (!(e instanceof ProfileError && e.code === 'NO_PROFILE')) throw e;
    }
    const why = closeCheck(git(['show', '--name-only', '--format=', sha], { cwd: root }) ?? [], { map });
    if (why) { console.log(why); return EXIT.fail; }
    try {
      fs.writeFileSync(file, closeEscape(text, id, gitOne(['show', '-s', '--format=%h %s', sha], { cwd: root })));
    } catch (e) {
      console.error(e.message);
      return EXIT.fail;
    }
    console.log(`closed ${id}`);
    return EXIT.ok;
  }
  if (text === null) { console.log('no qa/escapes.md'); return EXIT.notRun; }
  for (const e of readEscapes(text)) {
    if (args.open && e.closedBy) continue;
    console.log(`- [${e.id}] ${e.what} — ask: ${e.ask}${e.closedBy ? ` — closed by ${e.closedBy}` : ''}`);
  }
  return EXIT.ok;
}

// ── 0.5.0: is the project ready for a real verify? ─────────────────────────────

async function cmdReady(args) {
  const [sub] = args._;
  needValue(args, 'ready', ['at', 'sample']);
  const { mainRoot, profile } = context();
  const repoRoot = findRepoRoot();
  if (sub === 'status') {
    const r = readiness({ repoRoot, mainRoot, profile });
    if (args.json) print(r);
    else {
      console.log(`ready: ${r.state}`);
      if (r.line) console.log(r.line);
    }
    return r.state === 'ready' ? EXIT.ok : EXIT.fail;
  }
  if (sub !== undefined) throw new Usage('ready [--at <ref>] [--sample <n>] [--fix] [--static] [--json] | ready status [--json]');
  const sample = args.sample === undefined ? 3 : Number(args.sample);
  if (!Number.isInteger(sample) || sample < 0) throw new Usage('ready --sample must be a whole number');
  let report;
  try {
    report = await checkReady({ mainRoot, repoRoot, profile, at: str(args.at), sample, fix: Boolean(args.fix), sandbox: !args.static, log: (...a) => console.error(...a) });
  } catch (e) {
    if (/^unknown ref |^no integration branch/.test(String(e?.message))) throw new Usage(e.message);
    throw e;
  }
  if (args.json) print(report);
  else {
    console.log(readyText(report));
    if (!args.static) console.log(`written: ${path.join(repoRoot, 'qa', 'ready.json')}`);
  }
  return report.ready ? EXIT.ok : EXIT.fail;
}

// ── rework U6: the plan check ──────────────────────────────────────────────────

async function cmdPlan(args) {
  const [sub] = args._;
  if (sub !== 'check') throw new Usage('plan check [--slug <s>] [--head <ref>] [--map <dir>] [--seed-names <file>] [--drop] [--json] [--headed]');
  needValue(args, 'plan check', ['slug', 'head', 'map', 'seed-names']);
  const { mainRoot, profile } = context();
  const repoRoot = findRepoRoot();
  const head = gitOne(['rev-parse', '--verify', '--quiet', `${str(args.head) ?? 'HEAD'}^{commit}`], { cwd: repoRoot });
  if (!head) throw new Usage(`unknown ref ${str(args.head) ?? 'HEAD'}`);
  const slug = slugFor(args, repoRoot);
  const V = path.join(repoRoot, 'qa', slug);
  if (!fs.existsSync(path.join(V, 'expectations.json'))) return notRun(`${path.join(V, 'expectations.json')} (the plan writes it)`);
  const check = await planCheck({
    mainRoot, repoRoot, profile, slug, V, head,
    map: typeof args.map === 'string' ? path.resolve(args.map) : null,
    seedNames: typeof args['seed-names'] === 'string' ? path.resolve(args['seed-names']) : null,
    headless: !args.headed, log: (...a) => console.error(...a),
  });
  const md = planCheckMd(check, { dropped: Boolean(args.drop) });
  fs.writeFileSync(path.join(V, 'plan-check.md'), md);
  if (args.drop) dropFailed({ V, check });
  if (args.json) print(check);
  else process.stdout.write(md);
  if (check.blocked) return EXIT.blocked;
  return check.problems.length || check.mutants.length || check.stubs?.length ? EXIT.fail : EXIT.ok;
}

// ── rework U5: the prepare check ──────────────────────────────────────────────

async function cmdPrepare(args) {
  const [sub] = args._;
  const usage = 'prepare check [--slug <s>] [--base <ref>] [--head <ref>] [--map <dir>] [--seed-names <file>] [--final] [--json] [--headed]';
  if (sub !== 'check') throw new Usage(usage);
  needValue(args, 'prepare check', ['slug', 'base', 'head', 'map', 'seed-names']);
  const { mainRoot, profile } = context();
  const repoRoot = findRepoRoot();
  const head = gitOne(['rev-parse', '--verify', '--quiet', `${str(args.head) ?? 'HEAD'}^{commit}`], { cwd: repoRoot });
  if (!head) throw new Usage(`unknown ref ${str(args.head) ?? 'HEAD'}`);
  const base = baseShaOf(repoRoot, str(args.base));
  if (base === head) throw new Usage(`base and head are the same commit (${head.slice(0, 12)}): nothing to prepare`);
  const slug = slugFor(args, repoRoot);
  const V = path.join(repoRoot, 'qa', slug);
  fs.mkdirSync(V, { recursive: true });
  const map = typeof args.map === 'string' ? path.resolve(args.map) : null;
  const seedNames = typeof args['seed-names'] === 'string' ? path.resolve(args['seed-names']) : null;
  const check = await prepareCheck({ mainRoot, repoRoot, profile, slug, V, head, base, map, seedNames, headless: !args.headed, log: (...a) => console.error(...a) });
  const md = prepareMd(check);
  fs.writeFileSync(path.join(V, 'prepare.md'), md);
  if (args.json) print(check);
  else process.stdout.write(md);
  const code = prepareExit(check);
  // --final (after the mapper's one repair round): what is still wrong is a BLOCKED verdict, never a full run. The
  // sandbox left up for the run is taken down: no run follows.
  if (args.final && (code === EXIT.fail || code === EXIT.blocked)) {
    if (check.sandbox) {
      try { await sandbox.down({ mainRoot, profile, name: check.sandbox.name }); } catch (e) { console.error(`prepare: sandbox down ${check.sandbox.name}: ${String(e?.message ?? e).split('\n')[0]}`); }
    }
    await runQa({
      mainRoot, repoRoot, profile, base, head, slug, map, seedNames, log: () => {},
      blocked: code === EXIT.blocked ? (`head: ${check.blocked}`) : { text: blockedText(check) },
      waivers: waiversText(repoRoot, slug), standing: false,
    });
    console.log(`verdict: ${fs.readFileSync(path.join(V, 'verdict.md'), 'utf8').split('\n')[0]} (${path.join(V, 'verdict.md')})`);
  }
  return code;
}

// ── rework U10: one command for a whole verify round ─────────────────────────

const RECORDS = ['journeys', 'all', 'none'];

// One qa step, this CLI as a child in the repo root.
function stepRunner(root) {
  const self = fileURLToPath(import.meta.url);
  return (argv) => new Promise((resolve) => {
    const child = spawn(process.execPath, [self, ...argv], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: `${stderr}FAIL: ${e.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function cmdVerify(args) {
  needValue(args, 'verify', ['spec', 'onto', 'record', 'until']);
  if (args.record !== undefined && !RECORDS.includes(args.record)) throw new Usage(`verify --record must be ${RECORDS.join(', ')}`);
  if (args.until !== undefined && !UNTIL.includes(args.until)) throw new Usage(`verify --until must be one of ${UNTIL.join(', ')}`);
  const root = findRepoRoot();
  const mainRoot = findMainRoot();
  const { profile } = context();
  let spec = str(args.spec);
  if (spec) {
    const abs = path.resolve(spec);
    const rel = path.relative(root, abs);
    spec = rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
  }
  const r = await verifyRound({
    root, mainRoot, pluginDir: PLUGIN_ROOT, cli: path.join(QA_ROOT, 'bin', 'qa'), spec, onto: str(args.onto),
    security: Boolean(args.security), full: Boolean(args.full), record: str(args.record), until: str(args.until), agents: profile.agents,
  }, {
    step: stepRunner(root),
    headSha: () => gitOne(['rev-parse', 'HEAD'], { cwd: root }),
    originBase: () => {
      const tip = gitOne(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD^{commit}'], { cwd: root });
      return tip ? gitOne(['merge-base', 'HEAD', tip], { cwd: root }) : null;
    },
    say: (line) => console.error(line),
  });
  if (args.json) print(r.json);
  else for (const line of r.lines) console.log(line);
  return r.exit;
}

const COMMANDS = { verify: cmdVerify, prepare: cmdPrepare, plan: cmdPlan, profile: cmdProfile, adapter: cmdAdapter, sandbox: cmdSandbox, map: cmdMap, checks: cmdChecks, login: cmdLogin, capture: cmdCapture, compare: cmdCompare, run: cmdRun, affected: cmdAffected, routes: cmdRoutes, mutants: cmdMutants, metrics: cmdMetrics, verdict: cmdVerdict, round: cmdRound, security: cmdSecurity, resolve: cmdResolve, eyes: cmdEyes, report: cmdReport, setup: cmdSetup, standing: cmdStanding, escapes: cmdEscapes, ready: cmdReady };

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return cmd ? EXIT.ok : EXIT.usage; }
  const run = COMMANDS[cmd];
  if (!run) throw new Usage(`unknown command ${cmd}`);
  // -h / --help anywhere before `--` prints the command's usage lines and never runs it.
  const own = rest.indexOf('--') === -1 ? rest : rest.slice(0, rest.indexOf('--'));
  if (own.includes('--help') || own.includes('-h')) {
    const lines = HELP.split('\n').filter((l) => l.startsWith(`  ${cmd} `) || l === `  ${cmd}`);
    console.log(lines.length ? `qa ${cmd}\n${lines.join('\n')}` : HELP);
    return EXIT.ok;
  }
  return run(parseArgs(rest));
}

// A command whose promise never settles (an await on something with no live handle) lets Node exit
// with code 0 mid-run. That is never a pass: report it as a failure.
let settled = false;
process.on('exit', (code) => {
  if (settled || code !== 0) return;
  console.error('FAIL: qa stopped before the command finished (a wait that could never end); nothing it reported is complete');
  process.exitCode = EXIT.fail;
});

main(process.argv.slice(2)).finally(() => { settled = true; }).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof Usage) { console.error(`${e.message}\n\n${HELP}`); process.exitCode = EXIT.usage; return; }
    if (e instanceof ProfileError) { console.error(`qa.json: ${e.message}`); process.exitCode = e.code === 'NO_PROFILE' ? EXIT.notRun : EXIT.fail; return; }
    console.error(`FAIL: ${e.stack || e.message}`);
    process.exitCode = EXIT.fail;
  },
);
