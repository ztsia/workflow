/**
 * TEMPLATE. Copy to qa/routes.table.ts in the project and replace the rows with the project's own.
 * scripts/lib/routes.mjs imports it (Node strips the types) and reads its export ROUTES, so keep that
 * name and the row shape. The three rows below are illustrative only.
 *
 * Every route the app serves goes in this table, once. The route sweep fires the same bad requests at
 * each row, with no per-route code:
 *   - signed-out (every row but auth 'public') and no-right (once per login role not in roles): denied
 *   - other-id (the row's otherId, as the first allowed role): denied
 *   - not-json, deep nesting, an oversized body: a 4xx; a 2xx is a finding
 *   - a NUL in each string: a 4xx, or a clean 2xx; a 5xx is a finding
 *   - each top-level body field empty, blank, over 10000 characters, HTML or missing: a 4xx, or a
 *     clean 2xx (the route may clean them); of the wrong type: a 4xx. A 5xx is always a finding
 *   - the wrong method, and an unknown path under the first row's first segment: refused
 *   - with profile routes.origin true: a foreign or null Origin on each write: denied
 *   - the happy path: the row's body, as the first allowed role: succeeds
 * A 5xx, a stack trace in an answer, or a request that gets through where it should not is a finding.
 *
 * PAGES (qa ready, 0.5.0) lists the screens the browser shows, beside the API routes: every page needs a map
 * entry that reaches it (a goto, or `screens` for one reached by clicks), or a `skip` reason. Keep ROUTES even when
 * it is empty.
 *
 * A route the app registers that this table does not list is a Major (it is reported as unlisted), so
 * a new route gets every check by being listed here. The sweep never knows what a route means: the
 * route expectations and the verifier's charter say that. Nothing here is read in production.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Who may call it:
 * - `public`: anyone, signed in or not
 * - `signed-in` (the default): any signed-in login
 * - `role`: only the logins named in `roles`
 */
export type Auth = 'public' | 'signed-in' | 'role';

export interface RouteSpec {
  method: Method;
  /** As the app serves it. `:name` is a param; a trailing `/*` matches any rest. */
  path: string;
  auth?: Auth;
  /** For auth `role`: the login roles that may call it (the names under qa.json `login`). */
  roles?: string[];
  /** Fills `:name` in `path`. Strings may hold `$seed.*` tokens, resolved from qa/seed.json. */
  params?: Record<string, string | number | boolean>;
  /** The same params pointing at a record the caller must not reach. */
  otherId?: Record<string, string | number | boolean>;
  /** Concrete paths to call when `path` ends in `/*`; defaults to [path]. */
  calls?: string[];
  /** A body the route accepts. The happy probe sends it, so the bad variants hit a route that works. */
  body?: Record<string, unknown>;
  /** Whether the happy probe runs: default true when `body` is given or the method is GET; false skips it. */
  happy?: boolean;
  /** Documentation only: the sweep does not read it. */
  idempotent?: boolean;
}

export const ROUTES: RouteSpec[] = [
  // Anyone may check the service is up
  { method: 'GET', path: '/api/health', auth: 'public' },
  // Any signed-in person may write a note; the body is what the happy probe sends
  {
    method: 'POST',
    path: '/api/notes',
    auth: 'signed-in',
    body: { title: 'QA note', text: 'Written by the route sweep' },
  },
  // Only staff may read one note; the other-id probe asks for a note that belongs to someone else
  {
    method: 'GET',
    path: '/api/notes/:id',
    auth: 'role',
    roles: ['staff'],
    params: { id: '$seed.note.own.id' },
    otherId: { id: '$seed.note.other.id' },
  },
];

export interface PageSpec {
  /** As the browser shows it. `:name` is one segment; a trailing `/*` matches any rest. */
  path: string;
  /** Map entries that reach this page by clicks rather than a goto. */
  screens?: string | string[];
  /** Why no map entry reaches this page; `qa ready` lists it and passes it. */
  skip?: string;
}

export const PAGES: PageSpec[] = [
  { path: '/candidates' },
  // Reached by clicking a row in the list, so it names the entry
  { path: '/candidates/:id', screens: 'candidate-detail' },
  { path: '/admin/debug', skip: 'an internal tool, never shipped' },
];
