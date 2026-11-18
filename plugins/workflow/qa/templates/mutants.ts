/**
 * TEMPLATE. Copy to qa/mutants.ts in the project. Keep the export name MUTANTS and the Mutant shape:
 * scripts/lib/mutants.mjs imports it (Node strips the types). The suites a mutant names live in qa/suites.ts
 * (templates/suites.ts); this file holds the mutants only. (A SUITES export here is the old place: still read while
 * the project has no qa/suites.*, with a note.)
 *
 * Breakage checks: dangerous edits a later change could make by accident, each with the test that must turn red when
 * it is made. An edit is `find` (which must occur exactly once in `file`, or the mutant is stale) replaced by
 * `replace`, in the head sandbox's worktree, never the user's checkout; the file is restored after.
 *
 * Mutants are off unless asked for. `qa run` runs only the verifier's proposals (qa/<slug>/mutants.json)
 * that name their killing test in `kill`, and runs only that test: green unmutated, then red with the edit is
 * killed; still green is SURVIVED, a guard no test holds (a finding). The registry below runs only on
 * `qa run --mutants all` (every mutant) or `--mutants affected` (those whose file the diff touches), and
 * `qa mutants --sandbox <name>`; a registry mutant with a `kill` is judged by that test there too, one without by
 * its whole `suite`. Start from the non-negotiables, then add one for every bug QA or the owner found that a test
 * should have held.
 */

// The suite ids of qa/suites.ts (a type-only import: Node strips it). With qa/suites.json, write
// `type SuiteId = string;` instead.
import type { SuiteId } from './suites';

export interface Mutant {
  /** Lowercase letters, digits and hyphens; unique across the registry and the proposals. */
  id: string;
  /** What breaks, as a person or the data would suffer it. */
  breaks: string;
  file: string;
  find: string;
  replace: string;
  /** The test that must fail with the edit made: a key of SUITES (or 'test:<level>'), its title, its file. */
  kill?: { suite: SuiteId | `test:${string}`; grep: string; file?: string };
  /** A key of SUITES, run whole for this mutant when it has no kill. */
  suite?: SuiteId;
}

export const MUTANTS: Mutant[] = [
  {
    id: 'with-check-weakened',
    breaks: 'a person can move their own row to someone else (an RLS policy without its WITH CHECK)',
    file: '<path/to/the/migration-that-creates-the-policy.sql>',
    find: `USING (<table>.user_id = <current-user-expression>) WITH CHECK (<table>.user_id = <current-user-expression>)`,
    replace: `USING (<table>.user_id = <current-user-expression>) WITH CHECK (true)`,
    kill: { suite: 'db', grep: '<the title of the test that moves a row to another owner>' },
  },
  {
    id: 'row-lock-dropped',
    breaks: 'two identical writes sent at once both pass the check and log two changes',
    file: '<path/to/the/route-or-module-that-locks-the-row.ts>',
    find: `.where(eq(t.id, id)).for('update');`,
    replace: `.where(eq(t.id, id));`,
    kill: { suite: 'db', grep: '<the title of the concurrent-write test>', file: '<path/to/that.test.ts>' },
  },
];
