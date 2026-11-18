/**
 * TEMPLATE. Copy to qa/suites.ts in the project (or write qa/suites.json { "suites": { … } }; `qa setup suites
 * --write <file>` writes that one for you). Keep the export name SUITES: scripts/lib/suites.mjs imports it (Node
 * strips the types). These were the SUITES of qa/mutants.ts; qa still reads them there, with a note, until a
 * suites file exists.
 *
 * A suite is how the project's tests run, in the worktree's root:
 *   - 'test:<level>'   the stack adapter's test verb at that level. It receives QA_TEST_GREP, QA_TEST_FILE and
 *                      QA_TEST_REPORT in its env and should run only that test (or file) when they are set.
 *   - an argv list     run directly, argv[0] the program. Preferred.
 *   - a string         a shell command (bash -c). A string with ; & | < > ` or $( in it is never edited by qa:
 *                      it gets the env above only, so it must read them itself, e.g.
 *                      `cd web && npx vitest run ${QA_TEST_FILE:-} ${QA_TEST_GREP:+-t "$QA_TEST_GREP"}`.
 *   - { cmd, timeoutMs }  one of the above with its own limit for one run (default qa.json mutants.timeoutMs,
 *                      900000). Give a slow end-to-end suite its own.
 *   - covers (optional, in the object form): the globs of the source files this suite's tests exercise, e.g.
 *                      { cmd: [...], covers: ['src/lib/**'] }. A re-verify round re-runs a test row of this suite,
 *                      carried from an earlier round, when the fix changes one of those files; without covers a
 *                      test row re-runs only when its own test file changes.
 *
 * A playwright, vitest, jest, pytest or `node --test` command gets the test's name filter, its file and a
 * machine-readable reporter added at its end, so a test expectation runs ONE test: evidence never runs a whole
 * suite. A command qa cannot narrow (no known runner, and no $QA_TEST_GREP / $QA_TEST_FILE in it) is refused for
 * evidence; `qa plan check` says so before the run. Register a suite without paths of its own (a test entry's
 * file is added to them, not put in their place). `qa ready` runs each suite whole once to prove it names its
 * tests and passes on the integration branch.
 */

export const SUITES = {
  // unit and component tests
  unit: ['npx', 'vitest', 'run'],
  // end to end, with its own limit
  e2e: { cmd: ['npx', 'playwright', 'test'], timeoutMs: 1_800_000 },
  // the stack adapter's test verb at level db: the database's tests
  db: 'test:db',
} as const;
export type SuiteId = keyof typeof SUITES;
