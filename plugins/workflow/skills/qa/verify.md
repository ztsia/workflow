# QA verify

This file belongs to the `qa` skill. `qa` means `"${CLAUDE_PLUGIN_ROOT}/qa/bin/qa"`, run from the project root, and `V` means `qa/<slug>`.

`qa verify [--spec <file>] [--onto <ref>] [--security] [--full] [--record journeys|all|none]` runs a whole round.
It does every step below in order, and it starts the mapper, the planner, the security review, the eyes pass and
the judge itself, as headless Claude sessions. You start it, wait for its one notice, read its last line and act.
It judges and reports. It never merges and never edits feature code. The fix is someone else's commit.

## Run it

1. `qa verify` with the arguments given, run with Bash `run_in_background`. Wait for its ONE completion notice.
   Never poll, never read its log while it runs, never drive its steps yourself: it takes minutes to an hour. A
   project with no `qa.json` gets one first (`setup.md`).
2. Read the LAST line it printed, and act on it:

   | Last line | Exit | What you do |
   |---|---|---|
   | `# ACCEPT\|REJECT\|NEEDS YOU\|BLOCKED — <slug>` | 0 · 1 · 2 · 4 | the outcome: **Report**, below |
   | `NOT RUN: no spec: write the acceptance criteria to <V>/spec.md …` | 3 | ask ONE question: where the spec is, or paste the acceptance criteria. Write the answer (or a copy of the named file) to `V/spec.md`, then step 1 again |
   | `NOT RUN: base <ref> is not in this repo …` or another `NOT RUN:` | 3 | say so and stop |
   | `headless <role> failed: <why> — continue by hand from step <n> (…)` | 5 | say the line, then **By hand** from that step. Every file is where the script left it |
   | `<step> failed (exit <k>): <why> — continue by hand from step <n> (…)` | 5 | the same |
   | a usage error | 64 | show it and stop |

   The lines above the last one: the `Report:` line (or `report: <path>`), the PR comment's line, `costs: …`, and
   `project not proven ready: …` (print it as a warning; it never blocks; `setup.md` closes it after the report).
   In a cloud session there is also `publish: …`.
3. **Publish** (only when there is a `publish:` line): step 8's **Where** with `publish: true`, below. The Artifact
   tool publishes; the script cannot call it. Give the owner the link.

## Report

Print line 1 of `V/verdict.md`, its `Report:` line, the `project not proven ready` line when there was one, and by
outcome (the rows come from `V/verdict.md`):

| Outcome | Print | Next |
|---|---|---|
| ACCEPT | nothing more | the PR |
| REJECT | each FAIL criterion, each Blocker and each row ending `— gates: …`, with its id and text | fix, commit, then `qa verify` again. The next round re-runs only what failed or what the fix touched |
| NEEDS YOU | each open criterion with what would prove it (`would prove it: …`, or a manual row's `ask: …`) | the owner waives it with a reason, or gives the proof. Never another round by itself |
| BLOCKED | each BLOCKED criterion and each `BLOCKED — …` gap: what could not be checked, and what the evidence does show | the owner decides: check again later, or the PR on their word. Never a retry by itself. A whole-run block (nothing checked: no sandbox, the prepare check) is never waived row by row |

**Round cap.** A `[gap:cap] Round cap: <ids> rejected 3 times — …` row means those criteria FAILed in 3 rounds. The
outcome is NEEDS YOU, not REJECT. Print the row. The owner decides: fix differently, change the spec, or waive.

Only spec criteria and Blockers decide. Advisory rows (`— advisory`), Majors without `— gates`, Minors and Notes are
findings for the report. Do not merge, do not edit feature code, and do not commit the verification files unless
the owner asks.

## What it does, and By hand

Each headless call's JSON and log are in `V/agents/<role>-<n>.json|.log` (the log starts with the prompt it was
given). Its cost is in `V/run.json`. Every step's output is in `V/verify.log`. After a `continue by hand from step
<n>` line, do the steps from n yourself: the agents by the Agent tool, with the prompt the failed call's log shows;
the scripts with Bash `run_in_background`, one notice each, never polled. Never debug `qa`'s code.

| Role | Agent (`subagent_type`) | Model by default | Session name |
|---|---|---|---|
| mapper | `workflow:qa-mapper` | haiku | `qa:mapper` |
| planner, judge | `workflow:qa-reviewer` | sonnet | `qa:planner`, `qa:judge` |
| security | `workflow:qa-security` | sonnet | `qa:security` |
| eyes | `workflow:qa-eyes` | opus | `qa:eyes` |

`qa.json` `agents.<role>.model` overrides the model.

1. **Resolve.** `qa resolve [--spec <file>] [--onto <ref>]` prints the Target as JSON: `slug`, `base` (`ref`, and
   `sha`, the merge-base), `spec`, `verification`, `map`, `seedNames`, `qaFiles`. `base.sha` null: NOT RUN. No
   `spec` and no `V/spec.md`: NOT RUN (the question above). The base is `--onto`, else the repo's default branch.
   `qa ready status` runs here too: its `project not proven ready` line is a warning. A missing `qa/ready.json` is
   a note, never BLOCKED.
2. **Round.** If `V/verdict.md` already exists for the current HEAD, and there is no `--full`: first
   `qa verdict waivers --slug <slug>`. The owner's new waivers apply by script, with no run. Exit 1: print its
   lines and stop. Line 1 still `BLOCKED`: go again from step 3, keeping the round of `V/round.json`. Exit 0:
   `qa report build`, then step 8. Exit 3 (no waivers): line 1 is the answer. If `V/report.html` is missing, run
   `qa report build` first.
   Otherwise (no verdict for HEAD, or `--full`): `qa round plan --slug <slug> --base <base.sha> --map <map>
   [--seed-names <f>] --spec <spec> [--full]` writes `V/round.json`. A round is **full** (round 1, `--full`, after an
   ACCEPT, a changed spec, base, `qa.json` or seed names), or **incremental** (only what failed or what the fix
   touched re-runs; every other row is carried, `carried from <sha> (round n)`). `--full` on a head that already
   has its verdict moves that verdict's round files to `V/prev` first.
3. **Prepare check, then the plan.**
   - **New screens** (not in suites mode). `qa affected --base <base.sha> --map <map> [--seed-names <f>] --json`: its
     `unmapped` lists the changed UI files no map entry walks. None: go on. Some: `qa sandbox up --at HEAD` (its
     `appUrl`), then ONE mapper, Agent `workflow:qa-mapper`, prompt first line `phase: prepare`, then `cli`, `base`,
     `spec`, `roles` (the `login` keys of `qa.json`, or `none`), `url` (the `appUrl`), `check: script …` (the prepare
     check runs after it returns: never run it, never wait on a background job), `targets: …`, a blank line, and one
     `- <file>` line per unmapped file. A mapper that fails, or a sandbox that does not come up: say so, and go on.
     A mapper that changed a QA file re-plans the round, as after a repair (`qa round plan … --replan`).
   - `qa prepare check --slug <slug> --base <base.sha> --map <map> [--seed-names <f>]`. Exit 0 or 3: go on.
     Exit 1: ONE repair round. Agent `workflow:qa-mapper`, prompt first line `phase: repair`, then `cli`, `base`,
     `url` (the head sandbox's `appUrl`, from `qa sandbox status <the sandbox prepare.md names>`), and the lines of
     `V/prepare.md` that start `- [`, except `- [stub:` lines. Then `qa prepare check --final`. Exit 4: `--final`
     once. If `--final` exits 1 or 4, it wrote `V/verdict.md` itself as `# BLOCKED — <slug>`: `qa report build`,
     then step 8. A `[stub:<id>]` problem in an incremental round: declare it in `qa.json` `stubs`, or verify with
     `--full`.
   - **Plan** (a full round, or no `V/charter.md`). Agent `workflow:qa-reviewer`, `model: sonnet`, prompt first line
     `phase: plan`, then `slug`, `V`, `spec` (path), `base` (ref), `head` (full sha), `cli`, `record` (default
     `journeys`). It writes `V/charter.md`, `V/expectations.json`, sad-path entries in `qa/map/verify-<slug>.json`,
     and maybe `V/mutants.json`. With no charter, or its return says the map check failed: send it that line once.
   - **Plan check.** `qa plan check --slug <slug> --map <map> [--seed-names <f>]`. Exit 1: SendMessage the planner
     the lines of `V/plan-check.md` that start `- [`, `- mut:` or `- stub:`, ONCE, with "fix these in
     `V/expectations.json`, `V/mutants.json` and `V/charter.md`". Then `qa plan check --drop`: what still fails
     leaves the plan and is listed, never NOT MET. Exit 3: send the planner its line once. Exit 4: print its
     `blocked:` line, then go on.
4. **Security.** Full round: only when `V/charter.md` says `security: yes`, or with `--security` or `--full`.
   Incremental: only when `V/round.json` says `security` `rerun: true`, or with `--security`. Otherwise
   `V/security.md` is carried. Run the native `/security-review` (Skill tool, skill `security-review`) on the diff
   from `base.sha`. Write `V/security.md`: line 1 `# Security — <slug>`, then one line per finding,
   `- High|Medium|Low [sec:<n>] <text> — <path>:<line>`. With no findings, only the heading. High is a Blocker,
   Medium a Major, Low a Minor.
5. **Run.** `qa run --base <base.sha> --slug <slug> --map <map> [--seed-names <f>] [--full] [--record <r>]`.
   Exit 4: it wrote the BLOCKED verdict itself. Go to step 8. No eyes, no judge, and never a retry of your own.
   Exit 64: show it and stop. Exit 0–3: go on. Findings and NOT RUN screens are data for the judge. The run walks
   only the PR's screens (a screen with no known `sources` is out of scope, listed under `map these`), and in an
   incremental round only what `V/round.json` lists. With no map entries and nothing to serve, see **Suites mode**.
6. **Eyes.** `qa eyes prompt`. A path: Agent `workflow:qa-eyes`, `model: opus`, prompt `Read <path> and do what it
   says.`, then `qa eyes merge`. `no new screenshot: …`: `eyes.md` came from the cache, with no eyes pass. Then
   `qa verdict draft --slug <slug>`. Its exit is the draft's verdict, not an error. `no changed or new screen`:
   skip both.
7. **Judge.** A fresh judge every round. Agent `workflow:qa-reviewer`, `model: sonnet`, prompt first line
   `phase: judge`, then `slug`, `V`, `spec`, `base`, `head`, `cli`, `round` (of `V/round.json`), `cost-plan` and
   `cost-eyes` (from `V/run.json`, `?` when unknown), and `waivers` (the path of `V/waivers.md`, when it exists).
   Then `qa report build --check --slug <slug>`. Problem lines (`R<n>: …`): SendMessage them to this round's judge
   once, then check again. Still failing: print them and line 1, and say the report was not built. Otherwise
   `qa report build`.
8. **Report.** `qa report where --json`.
   - **Where.** With `publish: false`, it wrote the `Report:` line itself: `Report: on <host> at <path>` locally, or
     `Report: NOT PUBLISHED — not your account` on another person's account.
     With `publish: true`, for each entry of `artifacts`, in the order given (a later part first, so part 1 can
     link to it), call the Artifact tool. Pass `file_path` and `files` as given, `capabilities` when given (a video
     is refused without `assets`), and `icon` and `description` on a first publish only. An entry with a `url` is
     this PR's artifact from the last round: publish to that `url`. Read it first if this session has not, list its
     files with `scope: "files"`, and pass `null` for each listed path its `files` lacks. Then run the entry's
     `then` command with the URL the tool returned: `qa report url <url> --part <n> --slug <s>`. Part 1 writes
     `Report: <url>` as the last line of `V/verdict.md`. If the Artifact tool is missing or refuses:
     `qa report line --not-published "<what it said>" --slug <s>`. The `Report:` line is never left out, because
     the PR comment reads it.
   - **PR comment.** `qa report comment [--slug <s>] [--pr <n>]`: one comment on the PR, edited each round. With no
     PR, or no `gh`, it says so and exits 0. With `publish: true`, run it after the last `qa report url`, so the
     comment carries the link.
   - Then **Report**, above.

A cloud session publishes the report as a private artifact on the owner's account. A local session keeps it on the
laptop. A large report comes in parts: part 1 holds the verdict and links the others.

## Suites mode

A project with no map entries and nothing to serve (no `serve` stack command, no adapter that serves) runs in
suites mode. The run uses no sandbox, no base side and no screens. Each suite in `qa/suites.*` runs whole on the
head commit. The test and doc rows and the breakage checks are checked, then the verdict, as usual. The screen steps
(the prepare check's walk, the eyes pass) have nothing to do. `setup.md`'s `qa setup suites` still applies. A
missing `qa/ready.json` is a note, never BLOCKED.

## The runner alone (`qa run`)

`qa run` is the runner by itself: no planner, no eyes pass, no judge. It gives a draft, never ACCEPT or REJECT.

- Options: `--base <ref>` (default: the default branch); `--full` (every screen; it cannot be combined with
  `--screens`, which is exit 64); `--screens <globs>`; `--record journeys|all|none`; `--self` (the determinism
  self-test on HEAD, no verdict); `--json`. `qa affected [--base <ref>]` lists the screens the branch touches.
- Exit: 0, 1 and 2 go on (1 is findings, 2 is inconclusive; blockers make 1, majors alone make 0). 3: a screen or
  verb did not run. Say which, from `summary.md`, and go on as for 4. 4 (BLOCKED ON INFRASTRUCTURE): print the
  header and Failures section of `summary.md`, and say the run did not test the change. 64: show the usage error.
- With `--json`, the object on stdout is `{ exit, verdict, blockers, majors, summary }`. Otherwise print the
  `summary.md` header, each `##` heading with its count, and the path of `verdict.draft.md` beside it.
- A judged ACCEPT or REJECT, with the eyes pass, needs `qa verify`.

## Files in `V` (`qa/<slug>/`)

| file | what it is | who writes it |
|---|---|---|
| `spec.md` | the spec, when it was asked or fetched from the PR | the `qa` skill, `qa resolve` |
| `charter.md`, `expectations.json`, `mutants.json` | the cases to check, the `security:` call, the expectations and breakage checks | the planner |
| `prepare.md`, `plan-check.md` | what the prepare check and the plan check found; `- [<id>] <problem>` lines | `qa prepare check`, `qa plan check` |
| `security.md` | the security review's findings, when it ran | `qa verify` (or the main session, by hand) |
| `summary.md`, `results.json`, `verdict.draft.md`, `logs/` | the run's output | `qa run` |
| `run.json` | the run's facts, the verdicts, and `agents` (each headless call of this head) with the `cost-*` totals | `qa run`, `qa report build`, `qa verify` |
| `round.json`, `rounds.json`, `prev/` | this round's plan; every earlier round's outcome; the files of the round before the last fix | `qa round plan`, `qa run` |
| `eyes-prompt.md`, `eyes-cache.json`, `eyes.md` | the eyes brief (new screenshots only), rulings by image hash, the look per screen | `qa eyes prompt`, `qa eyes merge`, the eyes pass |
| `verdict.md` | the verdict, its last line `Report: …` | the judge (or `qa verdict waivers`, or the run when nothing could start); the Report line from `qa report` |
| `waivers.md` | the owner's waivers: `- [<row id>] waived: <reason> (<who>, <YYYY-MM-DD>)` | the owner, or the main session on their word |
| `report.html`, `shots/`, `publish.json`, `artifact-<n>.html`, `published.json` | the report, and what a cloud publish sends and got | `qa report build`, `qa report url` |
| `agents/<role>-<n>.json`, `.log`; `verify.log` | each headless call's answer, prompt and stderr; every step's command, exit and output | `qa verify` |

The runner writes `V/.gitignore` for the heavy parts (`logs/`, `shots/`, `agents/`, `prev/`, the report HTML, the
publish files, `verify.log`).

Verifier-added sad-path screens live in `qa/map/verify-<slug>.json`, tagged `origin: verify:<slug>`. They belong to
their PR. Once it has merged, move them out of the map (`setup.md`, the `sadpaths:shared` line).

## Examples

- `qa verify` in the background: one notice, then line 1 of the verdict with its rows.
- `qa verify --onto develop --security`: against `develop`, always with the security review.
- `qa verify` after a REJECT and a fix commit: round 2 re-runs only what failed or what the fix touched.
- `qa verify` after the owner waived a NEEDS YOU row, on the same head: the waivers apply by script, with no run.
- `qa verify --full` after the owner supplied what a NEEDS YOU row asked for, with no new commit: a full round again.
- The last line is `headless judge failed: timed out after 20 min — continue by hand from step 7 (judge)`: say it,
  then do step 7 by hand, then step 8.
