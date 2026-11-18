# Work lessons into the workflow plugin: plan (2026-11-18)

The owner's work setup (Team plan) has its own fleet plugin (the work fleet) and QA tool (the work QA tool 1.0),
built partly from this plugin. Their audits measured where the quota went and fixed it. This plan
takes what fits a single Pro-plan session (no hub, no parallel sessions) and **copies directly
wherever a file ports**; only the fleet couplings are rewritten. Decided with the owner in the Divisi
B01 session, 18 Nov.

## Sources

The owner's two uploads, kept **only on this machine, never committed or pushed anywhere**:
- `/home/user/work-ref/` (the fleet and the QA tool); copies also in the
  session scratchpad and the raw zips in `/root/.claude/uploads/6de64a3a-d157-58cf-9cf4-055dfb3afc27/`.
- Before using them: `ls /home/user/work-ref`. If they're gone (new container), stop and ask the owner
  to upload them again.
- The evidence: `fleet/docs/2026-11-06-fleet-quota-audit.md` (§0, §3, §4.2–4.4, §5, §7) and
  `qa-tool/docs/2026-11-12-qa-rework-design.md` (§1, §2, §4, §9, §14).

## Why (measured at work, and in Divisi B01)

- Cost is the context re-read on every call, not the model: average calls re-read ~250k tokens; cache
  reads were ~60% of spend, and Opus and Sonnet charged the same for them then. Shrinking context pays;
  switching model barely does. Divisi B01: $11.16, 99% the main session at ~200k context, 131 turns.
- The rules "under ~100 lines is the main session's" and "the main session writes one finished
  example first" made the work lead write ~72% of the code. B01 did the same. Work removed both.
- An advisor consult in Claude Code re-reads the whole transcript uncached at the advisor's price
  (~$1 at 250k on Opus). Worth it only at small context, 2–3 times per task.
- QA at work: ~9 of 17 REJECTs were tool faults; reviewers added gates the spec never asked for; a
  5-minute subagent cache expired during every test wait (405 rebuilds, $215); a verifier read the
  lead's reasoning 235 times.

## Owner's decisions

1. Everything general goes to this plugin; Divisi keeps only its own overrides.
2. Shape vs fill, unit table, trailers, Sonnet hook, PreCompact keep-rules, test honesty rules,
   never narrow an ask: **yes**.
3. QA: criteria-only gating, four outcomes, reviewer independence, round cap with carry-over, 1-hour
   cache on the reviewer only: **yes**.
4. Verdict pinned to a commit: **yes, but never a hard block.** The owner can change things after a
   verdict (often not code, or minor). A check only *reports* what changed since the verdict (code vs
   docs) so the owner decides.
5. A QA-tool fault: **handled after the build is done**, not debugged mid-slice. During the slice it
   is recorded as BLOCKED in the report and the build goes on; fixing the tool is its own step at the
   slice's end (a PR here). (Read as the owner's "should do after the build done"; confirm if unsure.)
6. The zero-model QA runner: **build it now, together**, by porting the work QA tool.
7. Divisi: **keeps ~300k context** (the session sometimes doubles as half a hub); Sonnet after **two**
   misses (was three), recorded in its `docs/decisions.md`.
9. **Default session: Sonnet at `high` with an Opus advisor**, set in settings so no one has to
   remember: `"model": "sonnet"`, `"effortLevel": "high"`, `"advisorModel": "opus"` (all three are
   Claude Code settings keys, checked in the 2.1.327 binary). In the plugin's `templates/settings.json`
   and Divisi's committed `.claude/settings.json`. Slices the project marks Opus switch with `/model`.
   Check at the next session start that the cloud app's model pick doesn't override `model`.
10. **Copying is fine:** ported and adapted files go into this plugin; only the raw reference
    folders stay local (owner, 18 Nov: "A").
8. Skip: hub, waves, home branch, stack adapters' fleet verbs, run queue, deck, cloud leads, merge gate,
   asks-capture hook, 1-hour cache for implementers.

## Part A: brief, agents, rules, hooks (copy and adapt from the work fleet)

| Unit | Change | From | Who |
|---|---|---|---|
| A1 | `skills/brief/SKILL.md`: replace step 2 with **shape vs fill** (main session writes interfaces, types, seams, a non-negotiable's logic; a Haiku implementer writes the example from the contract; the main session reviews it once; Haiku copies it). Drop "under ~100 lines" and "one finished example" everywhere. Add the `Sonnet because: <clause> — <why>` line (three clauses: unknown cause, large unfamiliar code, second miss). Brief template gains `Unit:`, `Serves:` (criteria), `Trailers:`. Add §5 tests brief (three honesty rules, word for word) and §6 batches via the Workflow tool *when the session has it*. Keep our checks and miss table. | `skills/brief/SKILL.md` | main (Opus: skill text) |
| A2 | `agents/implementer.md`: never narrow an ask; trailers in its report; don't consult the advisor unless stuck; may send a scout. | `agents/builder.md` | main |
| A3 | `agents/scout.md`: locations and quotes, not conclusions. | `agents/scout.md` | main |
| A4 | `rules.md` (stay < 8,000 chars): models section says shape vs fill, not "<100 lines"; **unit table before building** (`unit \| what \| who \| model \| after`) committed in the slice's plan file, deviations listed in the PR; **context diet** (ranged reads, never `cat` a whole file, filter test output, no cost commands mid-turn); advisor at three points (after reading, before committing the plan; on a repeated failure; before done) and why it costs. | `agents/lead.md` §Kickoff, §Context diet | main |
| A5 | `hooks/implementer-model.mjs` + test: deny a `workflow:implementer` on a non-Haiku model unless the brief has a valid `Sonnet because:` line. No fleet detection: always on. | `hooks/builder-model.mjs`, `tests/builder-model.test.mjs` | Haiku port |
| A6 | `hooks/pre-compact.mjs` + test: keep-rules for any session on a slice branch: slice and branch, the handoff and plan paths (re-read them after the summary), units done / in flight (agent ids) / waiting, decisions since the brief, open questions, QA round state, next step; drop file contents, reports already committed, logs. Never for a QA session. | `hooks/pre-compact.mjs` | Haiku port, main reviews wording |
| A7 | `hooks/hooks.json`: add PreToolUse `Agent\|Task` → A5, PreCompact → A6. | `hooks/hooks.json` | main |
| A8 | `scripts/usage.mjs`: count advisor consults (`usage.iterations[]` type `advisor_message`) under the advisor's model; split by role and by phase (build vs verify) if it ports cleanly. | `scripts/usage.mjs` (+ `tests/usage.test.mjs`) | Haiku port |
| A9 | `skills/qa/SKILL.md` *Who makes each fix*: replace "<100 lines → main session" with the shape-vs-fill rule for fixes (take the fleet brief's REJECT-fix section if it has one). | `skills/brief/SKILL.md` | main |
| A10 | `templates/CLAUDE.md` Overrides and `templates/settings.json`: the default model, effort and advisor (decision 9), context window guidance, the unit table. | — | main |

## Part B: QA (port the work QA tool; keep our agent names)

**B-rules** (main, Opus: skill and agent text) in `skills/qa/SKILL.md` and `agents/qa-reviewer.md`:
1. **Only the brief's/spec's acceptance criteria and a short Blocker list gate.** Criteria the
   reviewer adds are advisory findings. Blockers: a non-negotiable broken; a crash or error page on an
   affected screen; a 5xx or stack trace; access granted to someone who must not get in; security High.
2. **Four outcomes** replace `ship | fix first | blocked`: ACCEPT, REJECT, NEEDS YOU (a criterion
   only the owner can confirm, with "what would prove it"; the owner waives with a reason, recorded),
   BLOCKED (the tool or machine failed after one retry; never REJECT). Severity table maps onto them.
3. **Independence:** the reviewer does not read the handoff file (the builder's reasoning). Scope comes
   from the prompt, the branch and the diff. The decisions log and spec are fine.
4. **Re-verify:** after a REJECT, re-run only rows that failed or were open plus rows whose evidence
   the fix touches; carry the rest, pinned to their commit. **Round cap 3** on the same criterion →
   the owner decides (fix differently, change the spec, waive). Fits into our three tiers.
5. **Verdict records `head: <sha>`.** Before the PR, a script lists what changed since (code vs
   docs-only). Report only, never a block (decision 4).
6. **A QA fault** is BLOCKED in the report; the build session never reads or patches the QA tool
   mid-slice; it's fixed after the build (decision 5).
7. `agents/qa-reviewer.md` frontmatter `experimental: { cacheTtl: 1h }` (reviewer only).
8. From the verifier and eyes agents, take what our agents lack (read `qa-tool/agents/verifier.md`,
   `eyes.md`, `security.md` against ours; judge rules, `manual` rows at plan time, corroboration of
   page checks). Merge into ours; don't add agents unless one is clearly separate (`mapper`, B-runner).

**B-runner**: copy the work QA tool into `plugins/workflow/qa/` (scripts, `scripts/lib/*`, `schema/`,
`templates/`, `test/`, `adapters/node-static`, `bin/`), rename the CLI `qa` (`${CLAUDE_PLUGIN_ROOT}/qa/bin/qa`),
then remove the fleet couplings until its own tests pass (`node --test`):

| Keep as is (copy) | Adapt | Drop |
|---|---|---|
| `suites, tests, mutants, summary, verdict, rounds, paths, docs, escapes, standing, branches, util, report, profile, setup, png, tree, probe, checks, tour, compare, capture, map, login, metrics, fingerprint, stubs, sources, affected, plan, prepare, ready, routes, sandbox, playwright, eyes, procs` | `run` (no fleet paths), `resolve` (no open-PR/fleet lookup), `verify` + `headless` (one command; judge and eyes as headless sessions only where `claude -p` exists, else the skill's by-hand steps), `publish` (our Artifact flow, no fleet-state), `overlay` (a slice's QA files live in the branch itself) | `queue` (one session at a time), `adapters/fleet`, `adapters/supabase-api` (keep only if a project needs it), home-branch and the fleet's PR command |

- Our existing `scripts/qa-report.mjs`, `templates/qa/{mutants.ts,limits.ts,escapes.md}` and
  `templates/scripts/mutants.mjs` overlap `report`, `mutants`, `metrics`, `escapes`: keep one of each
  (the work QA tool's, unless ours does something it lacks), and update the qa skill's references.
- A project with no web app (Divisi until B07) runs the runner with suites, tests, mutants, docs and
  the verdict draft only; the screen stages turn on when `qa.json` has a map.
- `skills/qa/SKILL.md`: the sweep template becomes "run `qa run`" (zero model calls); the reviewer
  reads `summary.md` and `results.json` instead of a Haiku sweep's index.

Who: copy and fleet-coupling removal are **Haiku ports** (one per group of libs, each with its tests
as Done-when); the skill/agent text and the decision of what to drop are the main session's (Opus).
Sonnet only under a `Sonnet because:` clause (likely "large body of unfamiliar code" for `run`/`verify`).

## Part C: Divisi (`ztsia/divisi`, its own small PR after this plugin's PR merges)

- `CLAUDE.md` Overrides: context stays ~300k; Sonnet after two misses; build sessions default to
  Sonnet `high` with an Opus advisor; point at the plugin's shape vs fill.
- `docs/decisions.md`: the owner's yes on those, with why (this plan's *Why*).
- `docs/workflow/brief.md`: keep only what is Divisi's (the B01 example); the rest is now the plugin's.
- `.claude/settings.json`: add `"model": "sonnet"`, `"effortLevel": "high"`, `"advisorModel": "opus"`.
- `docs/handoff.md`: B01 merged (its first line is stale); B02 starts under the new rules.
- `qa.json` for Divisi (suites: pytest, ruff) once the runner exists.

## Order

1. Branch `workflow/work-lessons` here (this file is its first commit).
2. Part A (A5, A6, A8 Haiku ports in parallel while the main session does A1–A4, A7, A9, A10).
3. Part B: B-runner copy and ports (Haiku, parallel by lib group); B-rules (main) meanwhile.
4. Checks (CLAUDE.md *Checks*): `claude plugin validate` both, `node --check` every `.mjs`, `bash -n`,
   `node --test` for ported tests, regenerate `files.txt`, `rules.md` < 8,000 chars. Bump `version`.
5. Advisor before the PR. PR here. Then Part C in Divisi.
6. `usage.mjs --log` the session.

## Done when

- No "under ~100 lines" or "one finished example" rule left in the plugin; shape vs fill in brief,
  rules, qa skill.
- Both hooks fire and their tests pass; a Sonnet implementer without the line is refused.
- `qa run` runs on a project with only suites (Divisi) and writes `summary.md`, `results.json`, a
  verdict draft with four outcomes; ported tests pass.
- The qa-reviewer no longer reads the handoff; criteria it adds can't gate.

## Part B, as decided after reading the work QA tool (18 Nov, with the advisor)

**Adopt the work QA tool's agents under our names instead of merging rules into the old reviewer** (changes B-rules 8).
`qa verify`, `headless` and `report build` (R1–R10) load the agent files by path and hold the verdict to the
planner's and judge's outputs (`charter.md`, `verdict.md`); grafting the rules onto the old one-long-run reviewer
would rebuild that contract by hand. the work QA tool's verifier already carries B-rules 1–6 (criteria-only gating, four
outcomes, no builder reasoning, rounds with carry-over and a cap of 3). The old reviewer's database and API phase is
covered by the route sweep (`routes`), `metrics` and the `database` skill; its cost phase by `metrics`.

| the work QA tool | Here |
|---|---|
| its CLI (`bin/…`, `scripts/….mjs`) | `qa` (`qa/bin/qa`, `qa/scripts/qa.mjs`), run as `${CLAUDE_PLUGIN_ROOT}/qa/bin/qa` |
| env vars with its prefix | `QA_*` |
| agents the tool's `verifier`, `eyes`, `mapper`, `security` | `workflow:qa-reviewer`, `workflow:qa-eyes`, `workflow:qa-mapper`, `workflow:qa-security`, in `plugins/workflow/agents/`; `--plugin-dir` is the plugin root (the folder above `qa/`) |
| skills its `verify`, `run`, `setup`, `map`, `standing` | one skill, `workflow:qa`, with a section each |
| state the tool's state folder (runs, cache, sandboxes, logins, logs); sandbox worktrees `.<tool>-<repo>-<id>` beside the repo | `qa-artifacts/` (gitignored); worktrees `.qa-<repo>-<id>` beside the repo |
| `verification/<slug>/` | `qa/<slug>/` (committed). Its heavy parts are ignored by a `qa/<slug>/.gitignore` the runner writes: `logs/`, `shots/`, `agents/`, `prev/`, `report.html`, `artifact-*.html`, `publish.json`, `published.json`, `verify.log` |
| headless sessions | named `qa:<role>` (`claude --name`), so `hooks/pre-compact.mjs` leaves them alone |
| `resolve`: spec from the fleet PR folder or `docs/fleet/` | `--spec`, else `docs/briefs/<label>-<name>.md` from branch `<label>/<name>` (the rules' one brief, one branch), else a `*spec*.md` or brief under `docs/` naming the slug, else the PR body when `gh` works |
| `resolve`: base from the open PR | `--onto`, else `qa.json` `integrationBranch`, else `origin/HEAD`, `main`, `master` |
| the PR's QA overlay folder | none: the branch's own `qa/map/`, `qa/routes.table.*`, `qa/seed.json`; sad paths in `qa/map/verify-<slug>.json` |
| dropped | `queue` (and `run.concurrent`, `run.waitMs`), `adapters/fleet`, home-branch code, the fleet's PR and merge commands, `.fleet/` lookups, and their tests |
| plugin version in the base-cache hash | `plugins/workflow/.claude-plugin/plugin.json` `version` |

**New: suites mode.** A project with no screens (no map entries, no `stack` serve; Divisi until B07) runs `qa run`
without a sandbox or capture: a worktree at head, each suite in `qa/suites.*` run whole (a `suite:<id>` row, PASS or
FAIL with its exit and the failing tests' names where the reporter gives them), the expectations' test and doc rows
when `expectations.json` exists, mutants when the project has them, then `summary.md`, `results.json` and the verdict
draft. "Not proven ready" never blocks suites mode.

**Tiers stay; rounds govern re-runs.** The owner approved the round cap with carry-over, never dropping the tiers.
Tier 1 (the main session fixes a small finding and verifies it itself, no re-run) stays: it is the cheapest path on a
Pro plan. Tiers 2 and 3 become `qa verify` rounds (incremental, or `--full`).

**Replaced by the work QA tool's:** `scripts/qa-report.mjs` (`qa report build`), `templates/qa/{mutants.ts,limits.ts,escapes.md}`
and `templates/scripts/mutants.mjs` (`qa/templates/`, `qa mutants`), unless something there is missing from the work QA tool's.

Who: the decoupling is one **Sonnet** implementer owning `qa/` (`Sonnet because: large body of unfamiliar code to
reason across — run, verify, headless, resolve, publish and overlay are ~3.5k lines coupled to fleet paths`); the
agent and skill text is the main session's.

## Part B, as built (18 Nov)

- `qa/` is the work QA engine without the fleet, plus suites mode (no map entries and nothing to serve: each
  suite whole on the head commit in a throwaway worktree, then the verdict). 1,614 of its tests pass here.
- The qa skill's `verify.md`, `setup.md`, `map.md` and `standing.md` are the work skills, de-fleeted, naming
  only commands `qa help` lists.
- `qa ready` has no suites-mode path: a project with no screens skips it (setup.md), and a missing
  `qa/ready.json` is only a note in a run. Revisit when a screenless project needs READY.
- `qa/test` is not in CI: twelve of its files launch Chromium without a skip guard, and the runner has no
  Playwright browser. Guarding them, then adding the step, is a follow-up.
- `integrationBranch` stays a `qa.json` key (resolve's base order); our pages say "the default branch".
