// The step 6 brief's Example Run: exampleRun() (run-example.mjs) extended with a route sweep, a
// mutant run, one route expectation and one metric flag on the detail pair. Fresh objects on every
// call, so one test can change a field without touching another.

import { exampleRun } from './run-example.mjs';

export function exampleRun6() {
  const run = exampleRun();
  run.routes = {
    file: 'qa/routes.table.json', rows: 2, probes: 30, notRunProbes: 0, failed: 2,
    new: [
      { id: 'rte:1', pid: 'POST /api/notes|deep|staff', route: 'POST /api/notes', kind: 'deep', actor: 'staff', status: 500, problem: '500 answered' },
      { id: 'rte:2', pid: 'POST /api/notes|happy|staff', route: 'POST /api/notes', kind: 'happy', actor: 'staff', status: 400, problem: 'happy path answered 400' },
    ],
    standing: 1, fixed: 0,
    unlisted: [{ id: 'rte:unlisted/1', method: 'DELETE', path: '/api/notes/:id' }],
    stale: [], errors: [], notRun: null, base: 'swept',
  };
  run.mutants = {
    mode: 'affected', file: 'qa/mutants.json', run: 2, killed: 1,
    survived: [{ id: 'mut:rls-check-dropped', mutant: 'rls-check-dropped', origin: 'registry', breaks: 'a person can move their row to someone else', file: 'supabase/migrations/0007.sql', suite: 'db', detail: '' }],
    stale: [], notJudged: [], suites: { db: { passed: true, ms: 41000 } }, errors: [],
  };
  run.routeExpectations = [{ name: 'notes-denied-to-viewer', result: 'met', detail: 'POST /api/notes as viewer: 403' }];
  run.compare.viewports[0].pairs[0].metrics = {
    flags: [{ metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 }],
    standing: 0,
  };
  return run;
}
