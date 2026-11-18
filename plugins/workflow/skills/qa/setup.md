# QA setup

This file belongs to the `qa` skill. `qa` means `"${CLAUDE_PLUGIN_ROOT}/qa/bin/qa"`, run from the project root, and `V` means `qa/<slug>`.

Setup is not done until the project is proven ready for a real verify. Every gap a verify would hit mid-PR (an
unmapped screen, a seed with no data, an adapter without its exec bit, a suite whose output names no test) is found
here, once, before a PR pays 35–60 minutes for it. The CLI does the work. This file asks, maps and loops. A secret
never goes in `qa.json` or in an answer: only the NAME of the env var that holds it. Long commands (`qa ready`, a
sandbox) run with Bash `run_in_background`. Wait for the one completion notice, never poll.

If the project already has `qa.json`, skip to step 8. To redo `qa.json` from fresh answers, run steps 2 and 3 again
and pass `--force` to the write.

## Projects with no screens

Steps 5, 6, 8 and 9 are skipped until the project has screens. A project with no screens runs in suites mode
(`verify.md`), and `qa setup suites` (step 7) still applies. Do not run `qa ready` for it: until it has screens, it
would report NOT READY on `map:empty`, `pages:none` and `det:none`, and that proves nothing. Go to step 10.

1. **Detect.** `qa setup detect` prints JSON `{ adapters, hasProfile }`. `hasProfile` true and no redo: say that
   `qa.json` already exists, and go to step 8. `adapters` is the list of stacks the script recognised in this
   checkout.

2. **Ask.** `qa setup questions` prints the five questions (`<n>. <key>: <ask>`). Ask them one at a time with
   AskUserQuestion, in order, never two in one call:
   - `stack`: one option per detected adapter (all of them together as the first option, when there is more than
     one), plus "Other" for build and serve commands. Ask for the build command when the stack needs one. The
     ready-made adapters are `node-static` and `supabase-api`.
   - `login`: per role, ask the role name, then the mode: a form (a path, and the env NAMES for the user and the
     password), a saved browser state, or by hand once.
   - `base`: two options, "a sandbox of the base commit" or "a live URL" (then ask the URL).
   - `viewports`: two options, `desktop` or `desktop+phone`.
   - `sensitive`: the globs for auth, payments, migrations; "none" is allowed.
   A value that looks like a secret instead of an env name: ask again for the name.
   In an unattended build session, don't ask. Record the five questions in `docs/handoff.md`, and set up what
   doesn't need an answer.

3. **Write.** Put the answers in a temp JSON file:
   `{ "stack": {"adapter": [..], "build": ".."}, "login": {"<role>": {"mode": "form", "path": "/auth", "user":
   "ENV_NAME", "password": "ENV_NAME"}}, "base": "sandbox" or "https://..", "viewports": "desktop" or
   "desktop+phone", "sensitive": ["glob"] }`. A role's mode is `form`, `storage-state` or `manual`. Run
   `qa setup write --answers <file> [--force]`. It prints `wrote <path>` or `kept <path>` for each file. With
   `--force`, `qa.json` is rewritten and the other files are kept. Exit 1 prints the reason (a bad answer): fix
   that one answer, ask again, and write again. Delete the temp file.

4. **Verbs.** `qa profile` prints the profile. With screens, `ready` needs the verbs `setup`, `up`, `seed`,
   `build`, `serve` and `test` to work. A verb that prints `NOT RUN: …` is settled with the owner now: an adapter
   that has it, a command in `qa.json` `stack.<verb>`, or `echo 'skip: <why>'` when the app truly needs none (a
   frontend with no backend has no `up`). Never hide one.

5. **Pages.** The page list is what map coverage is measured against. Read the project's router (React Router
   routes, `app/**/page.*` or `pages/`, SvelteKit `src/routes`, the server's view controllers) and list every screen
   path a person can open. Put them in the route table: `qa/routes.table.json`
   `{ "routes": [...], "pages": [{ "path": "/calls" }, { "path": "/calls/:id", "screens": "call-detail" }] }`, or
   `PAGES` beside `ROUTES` in a `.ts` or `.mjs` table (`${CLAUDE_PLUGIN_ROOT}/qa/templates/routes.table.ts`). A page
   reached only by clicks names its entry in `screens`. A page nobody should map gets `"skip": "<why>"`, agreed with
   the owner. Show the list before writing it. Routes a PR adds later go in `qa/routes.json`.

6. **Map.** `qa ready --static` lists `page:<path>` for each page no entry reaches. Run the map steps in `map.md`
   with those paths. It brings a sandbox up, dispatches the mapper, and proves each entry. An entry whose empty
   state is the point (an empty search) gets `"emptyOk": true`. A list whose data matters may get
   `"expectData": "$seed.<kind>.<name>.<field>"`. Delete `qa/map/example.json` once real screens are mapped. Then run
   the sources part of `map.md` for the screens just mapped: a screen with no `sources` is never walked for a PR.

7. **Suites.** `qa setup suites` prints `{ registry, existing, proposed, note, write }`: the suites file
   (`qa/suites.*`, or the old `SUITES` of `qa/mutants.*` with a `note`), its suites, and the runners this project
   has (vitest, jest, playwright, pytest, `node --test`). Ask with AskUserQuestion, multiSelect, one option per
   proposed suite (`<id>: <suite>`), plus "none of these" and "another command". In an unattended build session,
   record the proposed suites in `docs/handoff.md` instead.
   Put the chosen ones in a temp JSON file, `{ "<id>": <suite> }`, and run `qa setup suites --write <file>`. It
   writes `qa/suites.json` and keeps every suite already there. It moves the old `SUITES` of `qa/mutants.*` in with
   them. Say that those can be deleted there now; `qa/mutants.*` keeps its mutants. A project with `qa/suites.ts`
   gets the lines to add printed instead: add them to its `SUITES`. Delete the temp file.
   Prefer the runner itself over `npm test`. `qa` can then add the name filter, the test's file and the reporter, so
   a test expectation runs only its own test. A command it cannot narrow is refused as evidence. A slow suite gets
   its own limit: `{ "cmd": ["npx", "playwright", "test"], "timeoutMs": 1800000 }`.

8. **Ready loop.** `qa ready --fix` in the background: a sandbox of the default branch, two fresh seeds, a full walk
   and every suite. It takes minutes. It prints `READY` or `NOT READY — <n> open`, then each check with its FAIL
   items. Each FAIL has the reason and a `→` line naming the fix. It writes `qa/ready.json`. `--fix` already made
   the scripts executable. For each FAIL, do what its `→` line says, or ask the owner when the decision is theirs:
   - `verb:*`: step 4. `exec:*` committed without +x: `git update-index --chmod=+x <file>`, committed with the
     owner's yes.
   - `page:*`, `walk:*`, `map:*`: `map.md` for those screens or pages. `pages:none`: step 5.
   - `seed:*`, `empty:*`: the seed lacks what the screen shows. Show the owner the screen and the seed command
     (`qa.json` `stack.seed`, or the adapter's seed). Edit the seed only with their yes, or mark the entry
     `emptyOk` when the empty state is the point.
   - `det:*`: the seed writes the time or random values. Fixed values go in the seed with the owner's yes. Text the
     seed must stamp goes in `qa.json` `volatile`.
   - `suites:none`, `suite:*`, `registry:*`: step 7, or the reporter or limit the `→` line names.
   - `sources:missing`: the sources part of `map.md`.
   `concern` lines are listed with their `→` fix. They never make the project NOT READY. `--fix` already did the
   mechanical ones (it printed `pass … (--fix)`): `suites:old-place` moved the suites to `qa/suites.json`, and
   `standing:backlog` archived `qa/standing.md` beside it and started a fresh one that keeps the owned, noted and
   fingerprint rows. For `sadpaths:shared` (the verifier's sad paths left in the shared map), follow its `→` line
   once their PR has merged.
   Then run `qa ready --fix` again. After each NOT READY round, ask with AskUserQuestion: "fix these and check
   again" or "stop here". Loop until READY or the owner stops. Never edit product code beyond the seed and the QA
   files without the owner's yes.

9. **Baseline.** When READY: `qa run --self --baseline` in the background. It records the standing baseline in `qa/standing.md`.

10. **Report.** End with exactly one of:
    - `READY`: the date and commit from `qa/ready.json`, any concern still open with its fix, then the next step:
      `qa verify` on a branch.
    - `NOT READY`: every open item id from `qa/ready.json` `open`, with its reason and what each needs. A verify
      still runs, but its summary says `project not proven ready: …`. Gaps there are infrastructure.
    - `NO SCREENS YET`: no `ready` run. Suites mode applies, and the reason is in the Projects with no screens
      section above.
    Never end with "written but not proven". List every path written. `qa/ready.json` is a QA file and travels like
    the others: commit it with `qa/` where the project commits it. Do not commit unless the owner asks.

## Examples

- A new project: the five questions, the `qa/` files, the page list, the map, the suites, then `qa ready` to READY.
- `qa.json` already exists: step 8 only.
