# QA standing findings and escapes

This file belongs to the `qa` skill. `qa` means `"${CLAUDE_PLUGIN_ROOT}/qa/bin/qa"`, run from the project root, and `V` means `qa/<slug>`.

Standing rows are findings that were already on the default branch. They are kept in `qa/standing.md`, so a PR is
not blamed for them. A row whose screen is `*` holds a fingerprint (`contrast on link "Support" in navigation
"Primary"`: the check, the element's role and name, and its landmark). It stands for that finding on every screen.
Escapes are bugs found after an ACCEPT. They are kept in `qa/escapes.md`. This file reads and edits both through
the CLI, and it decides nothing about the app. Standing rows never block the PR.

## Standing

1. **List.** `qa standing list`. Exit 3 (no `qa/standing.md`): say that a run or `setup.md` makes it, and go to
   the escapes part. Otherwise print the count by `kind` (`check`, `tour`, …), unowned rows first, then the
   `<n> of <total>` line.

2. **Choose.** AskUserQuestion with `multiSelect`, at most 4 options: the groups worth acting on (a kind, or a
   screen with several rows), most rows first. "Other" takes ids. Narrow with
   `qa standing list --kind <k> --screen <glob> --unowned` to show the rows of one group.

3. **Act**, once for the chosen rows:
   - **Own:** ask who, and for an optional note. Then `qa standing set <id> --owner <o> --note <t>` for each row.
   - **Fix:** `qa standing asks <id,id…> --out qa/asks/<date>-standing.md` writes them as asks. An unknown id exits 1:
     name it, and ask again. Print the path. When the project has an issue tracker skill, offer to file them as
     tickets from that file. Run it only on a yes, and let it dry-run first.
   Print what changed. Do not commit unless the owner asks.

4. **Add from a run**, when the owner says yes to a candidate, or dismisses a page or tour finding for good. A run's
   `summary.md` lists shared-chrome candidates under Standing (`- [chrome:1] … : 6 screens — add to standing?`). A
   finding has a `chk:…` or `tour:…` id. Ask for an optional note (why it may stay). Then
   `qa standing add <chrome:n|chk:…|tour:…,…> --slug <slug> [--owner o] [--note t]`.
   Exit 1 (`no fingerprint for …`: the run captured none, or the id is unknown): say so. Nothing was written. With a
   fingerprint text the owner gives, use `qa standing add --fp '<check> on <role> "<name>" in <landmark>'`.
   Print the rows. The next run makes each matching finding a Note on any screen. Publishing as in step 3.

## Escapes

5. **List.** `qa escapes list --open` shows the open ones. Exit 3: there is no `qa/escapes.md`. `add` makes it.

6. **Add**, for "a bug found after an ACCEPT". Add it before the fix. Ask three things: what the bug was; which run
   could have caught it (a tour, a check, a map entry, a route, a mutant); and the one question the eyes pass will
   put to every screen from now on, written as a question about what a person sees. Then
   `qa escapes add --what <t> --caught <t> --ask <question> [--found <t>]`. Print the id. When `qa/escapes.md` is
   missing, `add` makes it from `${CLAUDE_PLUGIN_ROOT}/qa/templates/escapes.md`.

7. **Close.** An escape closes only with a commit that changed the map (`qa/map/`), `qa.json`, the route table
   (`qa/routes.table.*`) or the mutants (`qa/mutants.*`). Ask which commit, then
   `qa escapes close <id> --by <commit>`. If the CLI refuses (exit 1, and it prints why), say which change would
   close it: a map entry, a tour step, a check, a route or a mutant for that bug. Never edit `qa/escapes.md` to
   close it by hand. An unknown commit exits 64: say so.

## Examples

- `standing` — the backlog by kind. Then choose rows to own, or to turn into asks or tickets.
- `standing add chrome:1` — "the sidebar link fails contrast on every screen, add it to standing": one `*` row, and a
  Note on every screen from the next run.
- `escape` — "the Save button hid behind the keyboard after we shipped": add the escape and its ask.
- `escape close esc-3 --by 4f2a9c1` — closes it only if that commit touched the map, `qa.json`, the routes or the
  mutants.
