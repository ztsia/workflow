// What a changed path is (rework U8): a test file, route code, or a path the security review must see. Pure: the rules
// read the path's words and the project's own globs (qa.json `sensitive`, `security`, `routes.table`), never a project,
// a library or a screen. The verifier's charter line `security: yes|no — …` and a round's "run the security review
// again?" are the same test: securityPaths, through `qa security` and `qa round plan`.
//
// CONTRACT (tests: test/paths.test.mjs)
//
//   TEST_RE (moved from tier.mjs): a path is a test file when it matches
//     /(^|\/)(test|tests|__tests__|e2e|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$/
//   isTestFile(file) -> a file a runner collects as tests, by its name (what the prepare check counts as a new test):
//     test_*.py, *_test.py, *.test.* / *.spec.* (js, ts, jsx, tsx, mjs, cjs, mts, cts), *_test.go, *Test(s).java|kt|cs,
//     and any js/ts file under __tests__/. A helper beside the tests (tests/keys_fake.py, conftest.py, __init__.py,
//     tests/helpers/db.ts, a fixture) is TEST_RE but not a test file: no suite can list it.
//   DOC_RE: a doc or text file, /\.(md|mdx|txt|rst)$/i.
//   Words match one segment of the path (split on / . _ -), case-insensitive:
//     AUTH_RE       auth*, oauth*, sso, saml, oidc, login*, logout, signin, signon, session*, password(s), passwd,
//                   credential(s), token(s), jwt, permission(s), acl, role(s), rbac
//     ROUTE_RE      api, apis, route(s), router*, controller(s), handler(s), endpoint(s), middleware*, resolver(s)
//     MIGRATION_RE  migration(s), migrate*, polic(y|ies), rls; or a .sql file
//   isRouteCode(file) -> ROUTE_RE matches, and the file is neither a test (TEST_RE) nor a doc (DOC_RE).
//   ROUTE_TABLE_FILES = ['qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs', 'qa/routes.json']
//   routeTableFiles(profile) -> [profile.routes.table when a string, ...ROUTE_TABLE_FILES], each once, in that order.
//   securityPaths(changed, { profile = {}, routesChanged = false } = {}) -> [{ file, why }]
//     One entry per changed path that is sensitive, in changed order, with the FIRST reason that applies:
//       'sensitive glob <g>'          a string of profile.sensitive matches (util.mjs glob), any file
//       'security glob <g>'           a string of profile.security matches, any file
//       'route table'                 the path is one of routeTableFiles(profile)
//       'auth, role or session code'  AUTH_RE, not a test or doc
//       'route handler'               isRouteCode
//       'migration or policy'         MIGRATION_RE, not a test or doc
//     routesChanged (the PR's overlay route rows were added or changed) appends { file: 'overlay routes.json',
//     why: 'route rows added or changed' }. changed null -> [] (plus that entry).
//   securityLine(hits) -> 'security: yes — <file> (<why>), …' | 'security: no — the diff touches no sensitive, auth, role,
//     session, route or migration path'

import { glob } from './util.mjs';

export const TEST_RE = /(^|\/)(test|tests|__tests__|e2e|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_NAME_RE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.(py|go)|[^/]*\.(test|spec)\.[cm]?[jt]sx?|[^/]*(Test|Tests)\.(java|kt|cs))$/;
const JEST_DIR_RE = /(^|\/)__tests__\/(.*\/)?[^/]+\.[cm]?[jt]sx?$/;
export const isTestFile = (file) => TEST_NAME_RE.test(file) || JEST_DIR_RE.test(file);
export const DOC_RE = /\.(md|mdx|txt|rst)$/i;
const seg = (words) => new RegExp(`(^|[/._-])(${words})(?=$|[/._-])`, 'i');
export const AUTH_RE = seg('auth\\w*|oauth\\w*|sso|saml|oidc|login\\w*|logout|signin|signon|session\\w*|passwords?|passwd|credentials?|tokens?|jwt|permissions?|acl|roles?|rbac');
export const ROUTE_RE = seg('api|apis|routes?|router\\w*|controllers?|handlers?|endpoints?|middleware\\w*|resolvers?');
export const MIGRATION_RE = /(^|[/._-])(migrations?|migrate\w*|polic(?:y|ies)|rls)(?=$|[/._-])|\.sql$/i;
export const ROUTE_TABLE_FILES = Object.freeze(['qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs', 'qa/routes.json']);

const code = (file) => !TEST_RE.test(file) && !DOC_RE.test(file);

export const isRouteCode = (file) => code(file) && ROUTE_RE.test(file);

export function routeTableFiles(profile = {}) {
  const named = typeof profile?.routes?.table === 'string' && profile.routes.table ? [profile.routes.table] : [];
  return [...new Set([...named, ...ROUTE_TABLE_FILES])];
}

const globsOf = (list) => (Array.isArray(list) ? list.filter((g) => typeof g === 'string' && g) : []).map((g) => ({ g, re: glob(g) }));

export function securityPaths(changed, { profile = {}, routesChanged = false } = {}) {
  const sensitive = globsOf(profile?.sensitive);
  const security = globsOf(profile?.security);
  const tables = routeTableFiles(profile);
  const out = [];
  for (const file of changed ?? []) {
    const s = sensitive.find((x) => x.re.test(file));
    const k = security.find((x) => x.re.test(file));
    const why = s ? `sensitive glob ${s.g}`
      : k ? `security glob ${k.g}`
        : tables.includes(file) ? 'route table'
          : code(file) && AUTH_RE.test(file) ? 'auth, role or session code'
            : isRouteCode(file) ? 'route handler'
              : code(file) && MIGRATION_RE.test(file) ? 'migration or policy'
                : null;
    if (why) out.push({ file, why });
  }
  if (routesChanged) out.push({ file: 'overlay routes.json', why: 'route rows added or changed' });
  return out;
}

export function securityLine(hits) {
  if (!hits?.length) return 'security: no — the diff touches no sensitive, auth, role, session, route or migration path';
  return `security: yes — ${hits.map((h) => `${h.file} (${h.why})`).join(', ')}`;
}
