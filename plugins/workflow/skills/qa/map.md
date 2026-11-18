# QA map

This file belongs to the `qa` skill. `qa` means `"${CLAUDE_PLUGIN_ROOT}/qa/bin/qa"`, run from the project root, and `V` means `qa/<slug>`.

A map entry is the route to a screen and what to capture there. These steps get the entries written and proved.
They judge nothing about the app. The steps cover three jobs: write or repair entries (steps 1 to 6), prepare the
branch's QA files before a verify (the prepare part), and backfill the `sources` of existing entries (the sources
part).

## Write or repair entries

1. **Targets.** The request names screens, areas or routes. With none named, take the screens the current diff
   touches: `git diff --name-only $(git merge-base HEAD <default branch>)`. Then read the project's router to name
   the routes those files serve. List the targets before you dispatch. If none can be named, say so and stop.

2. **The app.** Use `--url` if one was given. Otherwise use a live sandbox for HEAD from `qa sandbox list`.
   Otherwise run `qa sandbox up --at HEAD` in the background. It takes several minutes on a database-backed stack.
   Wait for its one completion notice, and never poll. Its output names the sandbox and its URL. If it exits 3
   (NOT RUN) or 4 (BLOCKED ON INFRASTRUCTURE), report that and stop. If this session started the sandbox, run
   `qa sandbox down <name>` at the end, even when a step failed.

3. **Check first.** `qa map check`. An existing error on a target joins the work list as a repair. An error on a
   screen that is not a target is reported, not fixed.

4. **Dispatch** the `workflow:qa-mapper` agent (Agent tool, `subagent_type: workflow:qa-mapper`) with: the CLI
   path `${CLAUDE_PLUGIN_ROOT}/qa/bin/qa`, written out in full; the targets; the base URL; the roles (the keys of
   `qa.json` `login`); and the map file for each area (`qa/map/<area>.json`). One agent handles up to about 6
   screens. Split a larger list by area, and dispatch the agents in parallel, one map file each, so they never edit
   the same file. `qa/seed.json` is shared: tell each agent to add a seed record only by Edit of that single record.

5. **Verify its report yourself.** Do not take its word.
   - `qa map check` exits 0.
   - One `qa capture --url <base> --screens <every mapped screen, comma-separated> --out qa-artifacts/runs/map-check`
     exits 0.
   A `MAP ERROR` it reports stays listed. Do not hand-edit around it without saying so. If check or capture fails on
   a screen the agent called done, dispatch it once more with that evidence.

6. **Report to the owner:** the screens mapped and repaired (with their states), every `MAP ERROR`, the seed records
   missing, and the files changed (`qa/map/*.json`, `qa/seed.json`). Do not commit unless the owner asks.

## Prepare the branch's QA files

Before every verify, the branch's own QA files are written and proved: its map entries, its route rows and its seed
needs. They sit in the branch's `qa/`, and they reach the default branch with the PR. The mapper writes them. It
never edits product code.

1. **Targets.** The screens the diff adds or changes: `git diff --name-only <base>...HEAD`, and the router names
   them. Also the routes it adds or changes, and the pages it adds. List them.

2. **Dispatch** the `workflow:qa-mapper` agent. Its prompt's first line is exactly `phase: prepare`. Then give:
   `cli` (the full path), `base` (the sha), `spec` (its path), `roles`, `targets`, and the routes. It brings up the
   head sandbox to probe (`qa sandbox up --at HEAD` in the background, or a URL you give). It writes:

   | File | Content |
   |---|---|
   | `qa/map/<area>.json` | only the entries the branch adds or changes, each with `sources` (the files that render it) and `expectData` (text the seeded data shows there, or `"emptyOk": true`) |
   | `qa/routes.json` | `{ "routes": [rows], "pages": [pages] }`: a row in the route table's shape for every route the branch adds or changes, and a PAGES row for every page it adds |
   | `qa/seed-needs.md` | one line per record the PR's screens need that the seed does not make. A builder writes those records into the seed, in the PR |

3. **Prove it.** `qa prepare check --slug <slug> --base <base.sha> --map qa/map` takes about 1–2 minutes. It walks
   only the entries the branch adds or changes. It fires each new route row once, and it checks that each new test
   file sits in a registered suite. It prints `V/prepare.md` and leaves the head sandbox up for the run.
   - Exit 0 or 3: done.
   - Exit 1: send the mapper the lines that start `- [`, once, with `phase: repair`. Then run
     `qa prepare check --final`. What still fails is reported, never hand-fixed.
   - Exit 4: the app did not start at head. Report its `blocked:` line.

4. **Report** the files written and the lines of `qa/seed-needs.md` (the builder's work). `qa verify`
   does this itself when the diff has changed UI files no map entry walks. Running these steps by hand only gets the
   files ready early.

## Backfill sources

A screen is walked for a PR only when the PR touches its sources, or when the PR's own entries hold it. A screen
with no sources, declared or recorded, is out of every PR's scope and shows up as `map these`. `qa ready` reports
it as `sources:missing`. This part gives existing entries their `sources`. It needs no app.

1. **Targets.** The screens named. Otherwise, every line that `qa map check --sources` prints as
   `error: <file> <screen>: no sources`, grouped by map file. Say how many.

2. **Dispatch** the `workflow:qa-mapper` agent. Its prompt's first line is exactly `phase: sources`. Then give:
   `cli` (the full path), `map file` (one `qa/map/<area>.json`), and `targets` (its screens). Use one agent per map
   file, in parallel, up to about 30 screens each. The agent reads the router and the page each route renders. It
   writes `sources` globs on those entries and changes nothing else.

3. **Prove it yourself.** `qa map check --sources` has no `no sources` line for the targets, and no
   `matches no file` error. A screen the agent reports as `unsure` stays listed. Ask the owner which files render
   it, or leave it out of scope knowingly. Dispatch once more with the failing lines when a screen the agent called
   done still fails.

4. **Report** the screens given sources, the ones left `unsure`, and the files changed. Commit only when the owner
   asks, and then on a branch, never on the default branch.

## Examples

- Map the screens the current branch's diff touches, in a sandbox at HEAD.
- Repair the `candidate-detail` entry against a dev server at `http://127.0.0.1:5173`.
- Write entries for `/jobs`, a route not in the map yet: its list, detail and empty states.
- Give every existing entry with no sources its `sources` from the router, proven by `qa map check --sources`. This
  clears what `qa ready` reports as `sources:missing`.
- Write the branch's QA files (entries with sources and expectData, route rows, seed needs), and prove them with
  `qa prepare check`.
