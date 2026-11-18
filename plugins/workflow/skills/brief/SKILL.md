---
name: brief
description: How the main session hands a unit to a subagent and what it does when the work comes back wrong. Shape versus fill (who writes what), the model per unit and the `Sonnet because:` line, the brief's template with its unit, criteria and trailers, its checks, the tests brief with its three honesty rules, batches through the Workflow tool, agents running at once, waiting on long runs, the rule for a miss, and who makes each fix after QA. Use before every Agent call that does work (workflow:implementer, a port, tests written to given criteria), and whenever a subagent's report or diff falls short.
---

# Briefing a subagent

This skill's files are in `${CLAUDE_SKILL_DIR}`. **The project's additions win:** read
`docs/workflow/brief.md` first when it exists, and follow it where it differs from this skill.

The main session is the brain and subagents are its hands. It runs on the stronger model, which
costs most and is there to think: it decides, then hands down work that is decided. **A brief that
leaves thinking to the subagent is the main session's failure, not the model's.**

Decisions start from the slice's brief: its asks (the owner's words) and its acceptance criteria.
Every subagent brief cites the criteria it serves, so the subagent can tell when it is about to build
less than was asked. Unit ids come from the slice's unit table (the rules' *Models and subagents*).

## 1. Decide first

Write down every decision the unit needs before choosing who does it. If one can't be written yet,
the unit isn't ready to delegate: make that decision (record it for the owner if it's theirs), or it
is a unit where what's left can't be written down in advance (step 2).

## 2. Shape versus fill: who does the unit

**The main session writes only what defines the shape: interfaces, types, seams, scaffolding, a
non-negotiable's logic, and any design call that can't be briefed. Subagents write everything that
fills it, including the first instance of a repeated pattern.** There is no "under ~100 lines is the
main session's" and no "one finished example first": those rules grew until the main session wrote
most of the code. What costs is not the output price but that every file the main session reads and
every line it writes is re-read on every later call.

The pattern for repeated work:

1. The main session commits the contract (the shape units in the unit table).
2. **A Haiku implementer writes the example unit** from the contract and the brief, once they specify
   it: names, keys, behaviour, edge cases. Its reads are thrown away instead of sitting in the main
   session's context. A contract that leaves a detail open is finished first; that's not a reason
   for Sonnet.
3. **The main session reviews the example once** and accepts it as the template, or sends it back
   with one correction.
4. **Haiku copies it**, in parallel, one batch per implementer (step 6).

Choose the model per unit. The goal is **one run, on the cheapest model a complete brief allows**, not
many cheap runs and not one expensive one:

- **Haiku at `high`** (`workflow:implementer`'s default: leave `model` out) for anything the brief can
  fully specify: the example unit, copies of it, tests to criteria, ports, boilerplate, fixtures, a
  fix already worked out. Long, repetitive, many files, long fixture setup: all Haiku work. Measured
  runs came out 10 to 16 times cheaper than Sonnet for comparable work. At `low` and `medium` it
  sometimes reports a change done without running a check.
- **Sonnet at `high`** (`model` and `effort` on the Agent call) only under one of three clauses: **an
  unknown cause to find**, **a large body of unfamiliar code to reason across**, or **a second miss on
  the same point** (step 7). Before dispatch, write one line naming the clause and why, for this unit,
  on its unit-table row and in the brief:

  ```
  Sonnet because: large body of unfamiliar code to reason across — U4 wires into the auth middleware chain
  ```

  **No line, no Sonnet:** a hook refuses a Sonnet implementer whose brief lacks it, and its message
  says what to add. "Long", "repetitive", "tests" and "the example" never qualify, and neither does a
  contract with a detail still open.
- **The main session** only for the shape. If it catches itself writing a screen, a handler or a test,
  it stops and briefs it. A unit planned for an implementer but finished by the main session is a
  deviation the PR explains.
- **Test runs are the main session's.** A run expected to end within ten minutes runs in the
  foreground with a timeout; a longer one runs in the background and the session waits for its one
  completion notice, never polls. An implementer runs only its own unit's checks.
- `xhigh` and `max` only for a gain you have measured.

Aim for at least 60% of a slice's implementers on Haiku. Implementers are **best under 100k context**
(Haiku's price rises above it): small briefs, ranged reads, one batch each. A batch that needs 120k is
fine; never split work unnaturally to stay under.

## 3. Write the brief

Point at files rather than restating them; the brief carries decisions, not context the agent can
read.

```
Unit: <id from the unit table, e.g. U3> — <what, one line>
Sonnet because: <clause> — <why>   (a Sonnet brief only: the line from its unit-table row, step 2)
Goal: <the outcome in one sentence, as the person using it will see it>
Serves: <the slice brief's criteria, e.g. AC3, AC7>. Quote any ask whose wording matters.
Decided: <every decision: what's primary, names, behaviour, edge cases>
Copy: <the finished example to follow (path), or the exact contract: types, keys, test selectors,
       names that must not change>. A brief without one is not sent.
Owns: <the files it may edit>. Don't touch: <files>. Also editing now: <who, which files>
Done when: <the commands to run and what passing looks like>. Wait for long runs to end;
           never report one still running.
Environment: working directory <absolute path>; start with `pwd` and use only paths under it;
             port <n>, its own; build folder <path>, its own; format only your own files;
             don't commit.
Trailers: end your report with this block, filled in, for the main session to commit with:
             Unit: U3
             Done: U3            (only when the unit is finished)
             Built-by: haiku     (the model you run on: haiku | sonnet)
Report: each file changed, each check's result, the Trailers block, anything the brief didn't
        settle, and any ask it could not meet as worded.
```

The main session commits each unit with those trailers (`Unit:` on a partial commit, `Done:` on the
one that finishes it, `Built-by:`; `Built-by: main` for shape units). They are how the PR's
deviations and the Haiku share are counted, from `git log`.

## 4. Check it before sending

Each line below is a miss that happened because a brief left it unsaid:

- **The outcome and every decision.** Nothing left that a reviewer would argue about. (An agent
  accepted only the settings keys it knew of, because the full set wasn't named.)
- **What to copy.** A finished example beats a description. A unit with nothing to copy yet means
  the example unit comes first (a Haiku implementer, from the contract), not that the main session
  writes it.
- **The model.** Haiku at `high`, unless one of step 2's clauses holds and its `Sonnet because:` line
  is in the brief and on the unit-table row.
- **The scope.** Its unit id and trailers, its files, the ones it mustn't touch, and what other
  agents are editing now. (One ran a repo-wide formatter over another agent's files.)
- **How it proves it's done.** The checks, and *wait for long runs to end*. (One reported a test run
  while it was still going.) For a run over ten minutes, say how to wait: one wait that ends when
  the run does (an until-loop on its exit file), not a check every minute. Each time the agent stops
  to wait, the main session is woken for a turn; an hour of minute checks was sixty turns.
- **What it shares with agents running at once.** Its own ports and build folders, and who holds the
  test database when a suite resets it. Two runs on one port or one database fail each other, and
  the failure looks like a bug in the code under test.
- **For a measurement, how the person meets the thing, and a time budget.** (A brief asked for cold
  opens, three samples each; it measured first installs, not a phone opening the app from its cache,
  and took 70 minutes.)
- **Its environment.** The absolute working directory, a port of its own, *don't commit*. A worktree
  may start at `main`: tell it which commit to check out. (One worked in the main checkout instead of
  its worktree, was blocked, and was judged a failure of the model; the same model succeeded with the
  path stated.)

## 5. Tests are a brief template, not a role

Tests written to given criteria are the ideal Haiku unit. Use the step 3 template with `Copy:` naming
a finished test file (or the framework's conventions) and `Decided:` carrying these three rules word
for word, since they are what make the tests honest:

1. **Test behaviour, not implementation.** Assert what a user or caller observes; never what a private
   function happens to call.
2. **Never mock the thing under test.** Mock only what is outside the unit (network, clock, a paid
   API), and say which in `Decided:`.
3. **Show the test fails before the fix.** Run it against the code without the change (or under the
   exact break named) and report the failing output. A test never seen red proves nothing.

`Done when:` is the test command, its pass count, and the red run for rule 3. QA's own checks are a
different thing, adversarial and independent, and not an implementer's to write.

## 6. Two or more implementers: a workflow, when the session has one

When the session has the Workflow tool, a batch of **two or more implementers goes through it** (load
its authoring skill first): one script runs the N implementers in parallel, then one fix pass.
Intermediate output stays in script variables and never enters the main session's context; it sees
**one structured result per batch**, so it is woken once per batch instead of once per agent. Give
every agent a schema so the result is data, not prose:

```
schema: { unit, status: "done" | "stuck", files: [path], checks: [{ cmd, result }],
          trailers: "<the block>", unmet: [ "<ask not met as worded, quoted>" ] }
```

Without the Workflow tool, run them as background Agent calls and keep working; each wakes the
session once, when it ends.

## 7. When it comes back

**Review every report and diff:** its file list, that it ran its checks, and the result itself. A
report is a claim, not proof. Fix a small slip in shape code yourself; send anything else back
(below). Then commit the unit (explicit paths) with the trailers from its report.

When it fell short, **ask first what the brief left unsaid.** Usually it's the brief.

| | What to do |
|---|---|
| **First miss** | Add the missing line to the brief, then **correct the same agent** (SendMessage), so it keeps what it knows: *what's wrong, where, because which decision or ask; change it to exactly this; leave the rest; re-run the checks.* |
| **Off track** (wrong files, wrong approach) | Start a fresh run on the same model with the corrected brief, handing it whatever is salvageable. |
| **Second miss on the same point** | Re-judge. The brief was complete and it still failed, so the unit needs judgment that couldn't be written down: Sonnet, starting from the work so far, with `Sonnet because: second miss on the same point — <the point>`. |
| **"Can't meet an ask as worded"** | Never accept a narrower version. Decide it within the slice brief's room if you can; otherwise record it for the owner in the handoff and build everything else. |

There is no fixed retry count. One correction is almost always cheaper than a stronger model;
repeated rounds on the same point mean the model choice was wrong. When a miss came from the brief,
carry that line into every later brief too.

## 8. After QA rejects: who makes each fix

A QA REJECT is a miss like any other: first ask what the brief left unsaid. Then, per finding:

- **The main session:** a fix that changes the shape (an interface, a seam), one with a design call in
  it, or one touching a non-negotiable.
- **A new Haiku implementer:** a fix already decided, however long. Its brief names the finding, the
  verdict row and the exact change, and carries the trailers (`Unit:` of the unit it repairs).
- **The implementer that built the part, resumed** (SendMessage), only when it finished recently and
  the fix builds on what it holds. One from hours ago reloads its whole conversation at full price; a
  fresh implementer with a tight brief costs less.
- **A test that guards a fix fails on the code before the fix:** red first, or shown failing under the
  exact break QA used.

Then re-verify as the `qa` skill says.

## Working rules

- **One checkout unless two agents edit the same files.** Implementers run in parallel only on separate
  files; two that need the same file run one after the other.
- **Implementers may send a scout, or a sub-implementer for a separable part.** Nesting stops three
  levels below the main session; `workflow:scout` starts nothing.
- **Waiting costs.** An agent re-reads its whole conversation each time it wakes, and a wait longer
  than a few minutes lets the prompt cache expire, so the next turn writes it all again (one agent ran
  185 turns, mostly waits). Brief one until-loop per long run, and no repeat of a long run whose point
  an earlier run already proved.
- **An agent stopped at a usage limit is resumed** (SendMessage), never restarted. Check which model
  its next turns ran on (`node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs"`): one resumed on the
  strongest model instead of its Sonnet, and cost three times its first run. If it switched, stop it
  and brief a fresh agent on the right model with the work so far.
- **Commit an agent's files only after reviewing its report**, staging explicit paths, never `-a`,
  while other agents are still editing.
- **Keep every agent's id** until its unit is committed, so a resume survives a compaction.
