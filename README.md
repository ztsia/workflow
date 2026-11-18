# workflow

A Claude Code plugin for building a product with Claude: the main session decides and talks with
the owner, subagents build, QA checks every slice, and every session hands off to the next. Taken
from the projects that proved it (Sen's build first).

## What's in it

| Path in `plugins/workflow/` | What it is |
|---|---|
| `rules.md` | The workflow's rules: handoff rotation, one brief one branch, the owner's rules, the main session as the brain. Loaded into every session by the hook, under its 10,000-character limit |
| `hooks/hooks.json`, `scripts/session-start.sh` | The SessionStart hook: the rules, a pointer at the handoff and, in the cloud, the newest slice branch |
| `hooks/implementer-model.mjs` | Refuses a Sonnet `workflow:implementer` whose brief has no `Sonnet because:` line |
| `hooks/pre-compact.mjs` | Tells a compaction what to keep: the brief, the unit table, units in flight, decisions, the QA round |
| `agents/implementer.md` | `workflow:implementer`: carries out a unit already decided; Haiku at high effort by default, Sonnet only with a `Sonnet because:` line in its brief |
| `agents/qa-reviewer.md` | `workflow:qa-reviewer`: QA's planner and judge, run headless by `qa verify`. Plans evidence for each acceptance criterion from the brief alone, then rules on what the scripts gathered |
| `agents/qa-eyes.md` | `workflow:qa-eyes`: each changed screen and each tap's filmstrip, looked at as a person would, with fixed questions |
| `agents/qa-mapper.md`, `agents/qa-security.md` | QA's screen mapper (Haiku) and the security review of the diff |
| `agents/scout.md` | `workflow:scout`: cheap Haiku lookups over long logs or unfamiliar code |
| `skills/brief/` | How the main session briefs a subagent: shape versus fill, the model per unit and the `Sonnet because:` line, the template with its unit and trailers, its checks, and what to do on a miss or a QA reject |
| `skills/qa/` | How a slice is QA'd with `qa verify`: four outcomes gated only by the brief's criteria and a Blocker list, incremental rounds with a cap, escapes and the retro, the published report |
| `qa/` | The QA engine (`qa/bin/qa`): scripts run, walk, capture and diff with zero model calls; the reviewer, eyes and mapper run as headless sessions. Its own tests are in `qa/test/` |
| `skills/uiux/` | shadcn/ui components, one set of shared patterns, calm card-based structure, the size hierarchy and the phone-first checklist. Carries shadcn's docs for every base library (Radix, Base UI, React Aria); `scripts/refresh.mjs` re-pulls them once they're 90 days old |
| `skills/database/` | Data layer and backend security: RLS per request, on plain Postgres and on Supabase; every route in one table, swept |
| `skills/llm/` | Model calls in a product: prompts, checking an existing prompt, API errors, caching, cost, moving models and evals, with dated notes per vendor (Anthropic, OpenAI, Google) refreshed from the official docs |
| `skills/security/` | A product's own code without vulnerabilities, with dated notes per stack (TypeScript, Python, Go), of which a session reads only the one in use |
| `skills/setup/` | `/workflow:setup`: sets a project up, or moves one with its own copies onto the plugin |
| `scripts/usage.mjs` | What a session cost, by agent and model, with advisor consults and the largest context; `--log <slice>` keeps a row in the project's `docs/usage.md` |
| `scripts/cloud-setup.sh` | The cloud environment's setup script: places this plugin and Anthropic's `claude-security` and `security-guidance` under `~/.claude/skills/`, where a cloud session loads them |
| `templates/` | A project's own files: `CLAUDE.md`, `settings.json`, `scripts/session-setup.sh`, `claude-security-guidance.md` and API examples (`api/`). QA's project files are in `qa/templates/` |

`examples/devpos-CLAUDE.md` is an earlier project's CLAUDE.md, kept for reference.

## Using it in a project

**On each machine, once:**

```bash
claude plugin marketplace add ztsia/workflow
claude plugin install claude-security@claude-plugins-official
claude plugin install security-guidance@claude-plugins-official
```

**In each project**, from its root: `claude plugin install workflow@ztsia --scope project`, then run
`/workflow:setup` in a session. It writes the project's `CLAUDE.md`, `.claude/settings.json`, its
docs and QA's tooling from the templates, and moves a project that has its own copies of the
agents, skills and scripts onto the plugin.

**In the cloud:** cloud sessions don't install the plugins a repository enables; a plugin folder
under `~/.claude/skills/` does load. Put this line in the environment's setup script at
claude.ai/code (it fetches the newest `cloud-setup.sh` each time the setup runs). A project's own
installs go in its `scripts/session-setup.sh`, which its SessionStart hook runs every session:

```bash
curl -fsSL --max-time 60 https://raw.githubusercontent.com/ztsia/workflow/main/plugins/workflow/scripts/cloud-setup.sh | bash
```

## What a project keeps

The plugin holds what's true of every project; the project holds what's true of it alone, and wins:

| In the project | What it holds |
|---|---|
| `CLAUDE.md` | The project, its non-negotiables, stack, commands and layout, and an *Overrides* section for where it departs from `rules.md` |
| `docs/workflow/<skill>.md` | What the project adds to or overrides in one skill: its stack, its patterns, a rule it chose |
| `docs/workflow/<skill>/<path>` | A refreshed copy of a skill's file (a vendor note, a stack note, the shadcn docs), which replaces the plugin's until the plugin catches up |
| `.claude/claude-security-guidance.md` | The project's security rules, read by `security-guidance`'s reviews |
| `qa.json`, `qa/`, `scripts/session-setup.sh` | QA's setup (from `qa/templates/`, the `qa` skill's `setup.md`) and the project's own session setup |

A refresh or a lesson that holds for every project goes back here as a PR, queued in the project's
`docs/local.md` when the session can't open it.

## Updating

Every merged change bumps `version` in `plugins/workflow/.claude-plugin/plugin.json`; an installed
copy updates only when it changes. Third-party marketplaces don't update themselves, so a project
moves to a new version when its owner runs `claude plugin update workflow@ztsia`, between slices.
A cloud environment caches its setup for about seven days, so its copy of the plugin can lag main's.
The plugin updates itself: at the start of each cloud session its hook compares its version with
main's and, when they differ, installs main's (`cloud-setup.sh --workflow-only`, a couple of
seconds) before printing the rules. Rules, skills and scripts are then current; agent definitions
and the hook list, which Claude Code loads before any hook runs, stay the cached version's until the
environment runs its setup again. To bring those along at once, edit any line of the setup script (a
comment will do) and start a new session.

## Where the rules came from

Each rule here was measured or hit in a real build (Sen's, October 2026), and the reasoning travels
with it:

- **The main session is the brain.** The strongest model is there to think. When Sen's briefs
  asked only for correct data and states, the screens came back as plain lists of text, and the
  fault was the brief, not the model that built them. When the brief named what's primary on each
  screen and pointed at two finished reference screens, every model built well.
- **Haiku by default, at `high`.** The same brief ran on Sonnet and on Haiku, twice. Eight screens:
  Haiku $0.11 against Sonnet $1.12, comparable. Seventeen screens: Haiku $0.21 against Sonnet $3.43,
  comparable, once the brief stated its working directory; the run that lacked it edited the wrong
  checkout. Every Haiku slip so far traced to something the brief left unsaid. Per token Haiku is a
  twentieth of Sonnet's price, so `high` effort still leaves it about ten times cheaper, and
  Anthropic's docs recommend `high` for long agent tasks and strict instruction following.
- **Calm, card-based screens.** An owner's phone review found screens correct but plain: facts and
  actions drawn alike, no icons, nothing primary. The structure rules in `uiux` fixed it across
  forty screens in one pass, built by five agents from one set of blocks.
- **Measure, don't guess causes.** Two bugs the owner found on a phone after QA passed. Sign-in took
  seconds because the function ran in another region from the database. A deploy needed several
  restarts to arrive and re-downloaded 3.7 MB. No run measured time, and none spanned a deploy. QA
  now records time, bytes, CPU and memory from the runs it already makes, judges them against human
  limits and the default branch, and has the reviewer find each flag's cause; no check names one.
- **Check the routes once, for all of them.** One slice's QA took four runs (about $60), mostly
  finding input edge cases one route at a time. A route table and a sweep of the same bad requests
  at every route replaced that.
- **Run what a fresh browser never does, and break the code on purpose.** The lived-in journeys
  (a deploy, resume, offline, a slow network, 200% text), on their first run, found text drawn over
  text at 200% font size on three screens. The breakage checks, on theirs, found a row lock no test
  held.
- **Date every model fact, and refresh it.** The `llm` skill's first vendor docs (as `prompt`) were
  copies of each vendor's guide, written for Claude Opus 4.6, GPT-5 and Gemini 3. By October 2026
  the newest models rejected or ignored three things they taught: sampling parameters
  (`temperature`), prefilled replies and thinking budgets. On Claude 5.5 each is an HTTP 400. The
  named frameworks they picked between (CRAFT, CO-STAR) appear in no vendor's guide. The notes are
  now short, dated and sourced, with the principles kept apart, so a refresh touches only the facts.
