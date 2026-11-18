---
name: qa
description: Independent QA of the current branch before its PR, with one of four outcomes (ACCEPT, REJECT, NEEDS YOU, BLOCKED), plus the rules for fixing what it finds. One command, `qa verify`, resolves the slice's brief and base, proves the slice's QA files, has a clean-context reviewer plan evidence for each acceptance criterion, runs every check by script with zero model calls (the suites, a route sweep, breakage checks, metrics, each affected screen captured and compared with the default branch), has an eyes pass look at each changed screen, has a fresh judge rule, and builds the report. Only the brief's criteria and a short Blocker list decide. Re-runs cover only what failed or what a fix touched, with a cap of three rounds; small fixes the main session verifies itself. Also: setting QA up in a project, the screen map, standing findings, escapes, and Claude Security before launch. Use when a slice is finished, before a PR, when a non-negotiable was touched, or when asked to verify, QA or review work.
---

# QA pass

This skill's files are in `${CLAUDE_SKILL_DIR}`. **The project's additions win:** read
`docs/workflow/qa.md` first when it exists, and follow it where it differs from this skill. A file
at `docs/workflow/qa/<path>` replaces this skill's own `<path>`.

Verification by someone who didn't write the code, plus a fixed rule for what happens next. Scripts do
every run, walk, capture, diff and wait; models do only the judgement (what is worth checking, what the
evidence means, how a screen looks). The engine is `${CLAUDE_PLUGIN_ROOT}/qa/bin/qa`, written `qa` below,
run from the project root; `qa help` lists its commands. `V` below is `qa/<slug>` (the slug is the branch
name with unsafe characters made `-`: `B07-sync` for `B07/sync`).

Beside this file: `verify.md` (what `qa verify` does, step by step, and how to continue by hand),
`setup.md` (QA in a new project, and `qa ready`), `map.md` (the screen map), `standing.md` (findings
the default branch has too, and escapes).

## When to run it

- **A slice branch is finished, before its PR is opened.** The main case: a full round, whatever the
  slice.
- **A `CLAUDE.md` non-negotiable was touched**, even mid-slice.
- **Someone asks** to verify, QA or independently check work.

Skip it for a docs-only change: if `git diff --stat main...HEAD` shows nothing outside docs and `*.md`
files, say so and stop. (Use the project's default branch if it isn't `main`.)

**Before handing a branch to QA, run the fast checks yourself, unpiped.** A check piped into `tail` or
`grep` reports the pipe's exit code, not its own, so a failing typecheck looks clean. That cost a whole
QA run once. Commit first: QA checks commits, not the working tree.

A project with no `qa.json` gets one first (`setup.md`). A project with no screens yet (no map entries,
nothing to serve) runs in **suites mode**: each suite whole on the head commit, then the verdict; the
screen stages start when the map has entries. `qa ready` can't pass without screens, so such a project
skips it (`setup.md`).

## Run it

1. `qa verify [--spec <file>] [--onto <ref>] [--security] [--full]` with Bash `run_in_background`. Wait
   for its ONE completion notice. Never poll, never read its log while it runs, never drive its steps
   yourself: it takes minutes to an hour.
2. Read the LAST line it printed and act on it:

   | Last line | Exit | What you do |
   |---|---|---|
   | `# ACCEPT\|REJECT\|NEEDS YOU\|BLOCKED — <slug>` | 0 · 1 · 2 · 4 | the outcome: *The four outcomes*, below |
   | `NOT RUN: no spec: …` | 3 | the slice's brief wasn't found: rerun with `--spec docs/briefs/<file>` |
   | another `NOT RUN: …` | 3 | say so in the handoff and stop |
   | `headless <role> failed: … — continue by hand from step <n>` or `<step> failed …` | 5 | once, `verify.md`'s *By hand* from that step; every file is where the script left it. Still failing: *When QA itself fails* |
   | a usage error | 64 | fix the command |

   Lines above the last: `Report:` (or `report: <path>`), `costs: …` (this head's headless sessions),
   `project not proven ready: …` (a warning; `setup.md` closes it after the report; in suites mode, it says so and needs nothing), and in a cloud
   session `publish: …` (step 3).
3. **Publish** when that `publish:` line is there: `verify.md` step 8, with the Artifact tool. The script
   can't call it. Give the owner the link.

A branch that adds screens needs no mapping first: when its diff has UI files no map entry walks, `qa verify`
starts the mapper on them before its prepare check, and the new entries are walked in the same run.

The reviewer, the eyes pass, the mapper and the security review run as headless sessions on the models in
`qa.json` `agents.<role>.model` (defaults: mapper Haiku, planner, judge and security Sonnet, eyes Opus).
A project that runs QA on Sonnet sets `agents.eyes.model` there.

> **Never hand the reviewer what you built, how it works, or why you think it's right.** Its value is that
> it derives its evidence from the brief independently: it reads the brief, the decisions log and the
> diff, never the handoff, the unit table or a builder's report. Don't pre-empt it with known issues
> either; if it misses one, that's a finding about how clear the brief is.

## The four outcomes

Only **the brief's acceptance criteria and the Blocker list decide.** Rows the reviewer adds from its own
risk reading are advisory: findings for the report, never a gate. **Blockers:** a non-negotiable broken;
the head crashed or showed an error page on an affected screen; a route answered 5xx or a stack trace,
or let in someone who must not get in; a High security finding.

Relay line 1 of `V/verdict.md`, its `Report:` line, and by outcome:

| Outcome | Relay | Next |
|---|---|---|
| **ACCEPT** | nothing more | the PR |
| **REJECT** | each FAIL criterion, each Blocker and each row ending `— gates: …`, with its id and text | fix (*Fixing*, below), commit, `qa verify` again |
| **NEEDS YOU** | each open criterion with what would prove it (`would prove it: …`, or a manual row's `ask: …`) | the owner waives it with a reason, or supplies the proof; recorded in the handoff. Never another round by itself |
| **BLOCKED** | each BLOCKED criterion or gap: what couldn't be checked, and what the evidence does show | *When QA itself fails*. Never a REJECT, never a retry loop |

A waiver is a line in `V/waivers.md`: `- [<row id>] waived: <reason> (<who>, <YYYY-MM-DD>)`; `qa verify`
on the same head applies it by script, with no run.

| Severity | Meaning | Rule |
|---|---|---|
| **Blocker** | the Blocker list above | Fix it before the PR. Never downgrade it |
| **Major** | an advisory risk a person would hit (not a criterion) | Fix it, or record in the handoff why it's deliberate |
| **Minor** | real, but survivable | Your judgement. Say what you're leaving and why |
| **Note** | an observation, or a standing finding | No action claimed |

If you disagree with a finding, argue it from the brief, not from what you meant. If the brief is
genuinely ambiguous, that's a brief bug: fix it, because the next slice will misread it the same way.

## Fixing

**Who makes each fix** is the `brief` skill's *After QA rejects*, by shape versus fill: the main session
only for a fix that changes the shape, carries a design call or touches a non-negotiable; a new Haiku
implementer for any fix already decided, however long; the agent that built the part, resumed, only when
it finished recently. A test that guards a fix fails on the code before the fix: red first, or shown
failing under the exact break QA used.

**How it's re-checked**, per fix:

- **Small, self-verified:** one source file plus its test, or a test, a word or a style; no behaviour
  beyond the finding; not a Blocker. Red first, fix, the suite, typecheck and lint green, a screenshot if
  it was visual, and a row in `V/ledger.md` with the finding id, the red and green output and the
  screenshot path. No QA re-run: the ledger is how the owner audits it.
- **Everything else: the next round.** Commit, push, `qa verify`. The round is **incremental**: only rows
  that failed or were open, and rows whose evidence the fix touched, re-run; every other row is carried,
  pinned to the commit it was proven on. Use `--full` only when a fix reaches the whole flow (a migration
  or row-level security, navigation or a shared UI pattern, a shared store, a core module the
  non-negotiables name, the theme, or how the slice works as a whole).
- **Round cap.** A criterion REJECTed in three rounds turns the outcome to NEEDS YOU with a `Round cap:`
  row: the owner decides (fix it differently, change the brief, or waive). Repeated misses usually mean
  the design is wrong, not that it needs another patch.

## After the verdict

**A verdict is pinned to the commit it judged** (`head:` in `V/verdict.md`). Work may go on after it:
often docs or a minor change. Before the PR, report what changed since, and never block on it:

```bash
git diff --stat <head>..HEAD    # then say: docs only, or which code files
```

Put that line in the PR body. A code change since the verdict is the owner's call: a new round, or merge
on their word.

## When QA itself fails

A BLOCKED outcome, or a hand-over that still fails by hand, is a fault of the machine or the QA tool, not
of the slice. **Don't debug or patch `qa` mid-slice.** Record it in the handoff (the outcome, the last
line, `V/verify.log`'s failing step), say so in the PR, and keep building. After the build, the tool's
fix is its own step: a PR to `ztsia/workflow` (or the manual-work file when the session can't reach it).

## The security review

`qa verify` runs Claude Code's native security review of the diff when the reviewer's charter says
`security: yes` (or with `--security`), into `V/security.md`: High is a Blocker, Medium a Major, Low a
Minor. It diffs against `origin/HEAD`; a fresh clone may lack it: `git remote set-head origin <default
branch>` first.

**Claude Security's whole-codebase scan runs once, before the product launches**, at high effort: *run
Claude Security: scan the codebase at high effort; the cost is accepted*. It costs far more than a slice's
diff warrants and needs the Workflow tool, which cloud sessions don't have, so queue it in the
manual-work file with the steps. Copy its `CLAUDE-SECURITY-RESULTS.md` into `qa/`; its Critical and High
findings block the launch.

## Escapes

When the owner finds a bug by hand that QA passed, the main session adds it to `qa/escapes.md`
with `qa escapes add` before fixing it: what the owner saw (`--what`), which run could have caught it
(`--caught`), and the question the eyes pass will ask of every changed screen from then on (`--ask`).
The fix gets a pin: a test that fails on the code before the fix. An escape closes (`qa escapes close
<id> --by <commit>`) only on a commit that changed the tooling (the map, `qa.json`, the route table,
the mutants): a pin catches that bug, a tool catches its kind. More in `standing.md`.

## The retro, and the workflow plugin

Each slice ends with a retro at the bottom of `V/ledger.md`, before its PR:
- what QA found late, or round after round, and why the first round didn't
- what cost the most (`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs"`, `docs/usage.md`, `V/run.json`
  `costs`)
- which skill, agent, script or check changed because of it (a change, not an intention)

Lessons that hold beyond the project go to `ztsia/workflow` as a PR at the slice's end, linked in the
retro. If the session can't reach that repository, queue it in the manual-work file.

## What is committed, and what isn't

| Path | Committed? | Why |
|---|---|---|
| `qa.json`, `qa/suites.*`, `qa/map/`, `qa/seed.json`, `qa/routes.table.*`, `qa/mutants.*`, `qa/ready.json` | Yes | The project's QA setup |
| `V/` (`charter.md`, `expectations.json`, `summary.md`, `results.json`, `verdict.md`, `eyes.md`, `security.md`, `run.json`, `round*.json`, `waivers.md`, `ledger.md`) | Yes | The slice's evidence, verdict and rounds, in the repo so they outlive the VM |
| `V/logs/`, `V/shots/`, `V/agents/`, `V/prev/`, `V/report.html`, `V/verify.log` | No | The runner's own `V/.gitignore` keeps them out; the published report holds the screenshots |
| `qa/standing.md`, `qa/escapes.md` | Yes | Findings the default branch has too; every bug QA missed and the tooling change that closed it |
| `qa-artifacts/` | No | Sandboxes, captures, the base cache, saved logins. Add it to `.gitignore` |
