// Contract tests for scripts/lib/paths.mjs (rework U8): what a changed path is — a test file, route code, or a path
// the security review must see. TEST_RE moved here from tier.mjs (removed with the tiers). The contract is the comment
// block at the top of paths.mjs. Every path below is made up: the rules read words and globs, never a project.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEST_RE, isRouteCode, routeTableFiles, securityLine, securityPaths } from '../scripts/lib/paths.mjs';

test('TEST_RE matches test directories and .test/.spec files', () => {
  for (const p of [
    'test/a.test.mjs', 'tests/x.py', 'src/__tests__/a.ts', 'e2e/login.spec.ts', 'src/spec/a.js', 'specs/a.ts',
    'web/src/Button.test.tsx', 'lib/util.spec.mjs', 'x.test.cjs', 'src/foo.spec.jsx',
  ]) {
    assert.ok(TEST_RE.test(p), `${p} is a test file`);
  }
});

test('TEST_RE rejects source files and look-alike names', () => {
  for (const p of [
    'src/detail/Detail.tsx', 'src/testing/a.ts', 'src/latest/a.ts', 'src/attest.ts', 'src/contest/x.ts',
    'src/spec.ts', 'docs/spec.md', 'src/a.test.md', 'src/tests.ts', 'src/test-utils.ts', 'test.mjs',
  ]) {
    assert.equal(TEST_RE.test(p), false, `${p} is not a test file`);
  }
});

test('isRouteCode: a path segment that names a route, handler, controller, endpoint or middleware; never a test or a doc', () => {
  for (const p of ['src/api/items.ts', 'server/routes/a.js', 'app/controllers/x.rb', 'svc/handlers/y.go', 'src/endpoints.py', 'src/middleware/guard.ts', 'src/router.ts', 'gql/resolvers/q.ts']) {
    assert.ok(isRouteCode(p), `${p} is route code`);
  }
  for (const p of ['src/ui/Button.tsx', 'src/apiary.ts', 'docs/api/guide.md', 'test/api/items.test.ts', 'src/rapid.ts']) {
    assert.equal(isRouteCode(p), false, `${p} is not route code`);
  }
});

test('routeTableFiles: qa.json routes.table first when set, then the table names and the side file, each once', () => {
  assert.deepEqual(routeTableFiles({}), ['qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs', 'qa/routes.json']);
  assert.deepEqual(routeTableFiles({ routes: { table: 'conf/r.json' } }), ['conf/r.json', 'qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs', 'qa/routes.json']);
  assert.deepEqual(routeTableFiles({ routes: { table: 'qa/routes.json' } }), ['qa/routes.json', 'qa/routes.table.json', 'qa/routes.table.ts', 'qa/routes.table.mjs']);
});

test('securityPaths: one hit per path, the first reason in a fixed order; tests and docs only by glob', () => {
  const profile = { sensitive: ['src/pay/**'], security: ['config/keys*', { not: 'a glob' }] };
  const changed = [
    'src/pay/charge.ts', 'config/keys.json', 'src/auth/session.ts', 'src/users/roles.ts', 'src/api/items.ts',
    'db/migrations/001_init.sql', 'sql/report.sql', 'qa/routes.table.json', 'src/ui/Button.tsx', 'docs/auth.md',
    'test/auth.test.ts', 'src/pay/charge.test.ts',
  ];
  assert.deepEqual(securityPaths(changed, { profile }), [
    { file: 'src/pay/charge.ts', why: 'sensitive glob src/pay/**' },
    { file: 'config/keys.json', why: 'security glob config/keys*' },
    { file: 'src/auth/session.ts', why: 'auth, role or session code' },
    { file: 'src/users/roles.ts', why: 'auth, role or session code' },
    { file: 'src/api/items.ts', why: 'route handler' },
    { file: 'db/migrations/001_init.sql', why: 'migration or policy' },
    { file: 'sql/report.sql', why: 'migration or policy' },
    { file: 'qa/routes.table.json', why: 'route table' },
    { file: 'src/pay/charge.test.ts', why: 'sensitive glob src/pay/**' },
  ]);
});

test('securityPaths: routesChanged adds the overlay route rows as one hit; nothing sensitive is []', () => {
  assert.deepEqual(securityPaths(['src/ui/Card.tsx'], { profile: {} }), []);
  assert.deepEqual(securityPaths([], { profile: {}, routesChanged: true }), [{ file: 'overlay routes.json', why: 'route rows added or changed' }]);
  assert.deepEqual(securityPaths(null), []);
});

test('securityLine: yes with each path and why, or no with the reason', () => {
  assert.equal(securityLine([{ file: 'src/auth/a.ts', why: 'auth, role or session code' }, { file: 'src/api/b.ts', why: 'route handler' }]),
    'security: yes — src/auth/a.ts (auth, role or session code), src/api/b.ts (route handler)');
  assert.equal(securityLine([]), 'security: no — the diff touches no sensitive, auth, role, session, route or migration path');
});

// isTestFile (2026-11-12): a helper beside the tests is not a test. tests/keys_fake.py blocked a prepare round
// because no suite could list it.
import { isTestFile } from '../scripts/lib/paths.mjs';

test('isTestFile: files a runner collects', () => {
  for (const f of ['tests/test_keys.py', 'apps/server/tests/unit/test_a.py', 'pkg/keys_test.py', 'src/a.test.ts', 'e2e/login.spec.ts',
    'src/b.spec.mjs', 'web/src/__tests__/c.tsx', 'web/__tests__/deep/d.js', 'cmd/x_test.go', 'src/test/java/FooTest.java', 'Foo.Tests/BarTests.cs']) {
    assert.ok(isTestFile(f), f);
  }
});

test('isTestFile: helpers, fixtures and config beside the tests are not tests', () => {
  for (const f of ['tests/keys_fake.py', 'tests/conftest.py', 'tests/__init__.py', 'tests/helpers/db.ts', 'e2e/fixtures/user.json',
    'tests/mockmcp/seed_system.py', 'spec/support/setup.js', 'tests/dev_fake_server.py', 'src/testing.ts', 'tests/README.md']) {
    assert.ok(!isTestFile(f), f);
  }
});
