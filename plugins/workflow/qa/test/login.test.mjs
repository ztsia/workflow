// Contract tests for scripts/lib/login.mjs: credentials() and storageFile() only (no browser).
// The CONTRACT comment at the top of that file is the spec.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { credentials, storageFile } from '../scripts/lib/login.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const mainRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-login-')));
made.push(mainRoot);

// A runVerb stub: records its calls and answers like the adapter's `logins` verb (json is left for the module to parse).
function fakeRunVerb(stdout) {
  const calls = [];
  const runVerb = async (...args) => {
    calls.push(args);
    return { code: 0, stdout, json: null };
  };
  return { runVerb, calls };
}

const LOGINS_STDOUT = 'seeding accounts\n[{"role":"staff","email":"a@x.test","password":"p"}]\n';

describe('login: credentials from env', () => {
  it('both env names set give { user, password } from those variables', async () => {
    const profile = { login: { staff: { mode: 'form', from: 'env', user: 'QA_HR_EMAIL', password: 'QA_HR_PASSWORD' } } };
    const r = await credentials('staff', {
      profile,
      mainRoot,
      cwd: mainRoot,
      vars: {},
      env: { QA_HR_EMAIL: 'a@x.test', QA_HR_PASSWORD: 'p' },
      runVerb: async () => assert.fail('runVerb must not run for from: env'),
    });
    assert.deepEqual(r, { user: 'a@x.test', password: 'p' });
  });

  it("an unset env name is notRun: 'NOT RUN: login <role>: env <NAME> unset'", async () => {
    const profile = { login: { staff: { mode: 'form', from: 'env', user: 'QA_HR_EMAIL', password: 'QA_HR_PASSWORD' } } };
    const noEmail = await credentials('staff', { profile, mainRoot, cwd: mainRoot, vars: {}, env: { QA_HR_PASSWORD: 'p' }, runVerb: async () => assert.fail('no verb') });
    assert.match(noEmail.notRun, /^NOT RUN: login staff: env QA_HR_EMAIL unset$/);

    const noPassword = await credentials('staff', { profile, mainRoot, cwd: mainRoot, vars: {}, env: { QA_HR_EMAIL: 'a@x.test' }, runVerb: async () => assert.fail('no verb') });
    assert.match(noPassword.notRun, /^NOT RUN: login staff: env QA_HR_\w+ unset$/);
  });
});

describe('login: credentials from the adapter', () => {
  it('the logins verb output (last line JSON, parsed by the module) gives the role row, email mapped to user', async () => {
    const { runVerb, calls } = fakeRunVerb(LOGINS_STDOUT);
    const profile = { login: { staff: { mode: 'form', from: 'adapter', path: '/auth' } } };
    const r = await credentials('staff', { profile, mainRoot, cwd: mainRoot, vars: {}, env: {}, runVerb });
    assert.deepEqual(r, { user: 'a@x.test', password: 'p' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'logins');
  });

  it('account picks that row instead of the role key', async () => {
    const stdout = '[{"role":"staff","email":"a@x.test","password":"p"},{"role":"owner","email":"o@x.test","password":"o"}]\n';
    const { runVerb } = fakeRunVerb(stdout);
    const profile = { login: { staff: { mode: 'form', from: 'adapter', account: 'owner' } } };
    const r = await credentials('staff', { profile, mainRoot, cwd: mainRoot, vars: {}, env: {}, runVerb });
    assert.deepEqual(r, { user: 'o@x.test', password: 'o' });
  });

  it("a missing account is notRun naming the account (the role key when no account is set)", async () => {
    const { runVerb } = fakeRunVerb(LOGINS_STDOUT);
    const ghost = await credentials('staff', {
      profile: { login: { staff: { mode: 'form', from: 'adapter', account: 'ghost' } } },
      mainRoot,
      cwd: mainRoot,
      vars: {},
      env: {},
      runVerb,
    });
    assert.match(ghost.notRun, /^NOT RUN: login staff: adapter has no account ghost$/);

    const byRole = await credentials('auditor', {
      profile: { login: { auditor: { mode: 'form', from: 'adapter' } } },
      mainRoot,
      cwd: mainRoot,
      vars: {},
      env: {},
      runVerb,
    });
    assert.match(byRole.notRun, /^NOT RUN: login auditor: adapter has no account auditor$/);
  });
});

describe('login: storageFile', () => {
  it('storage-state: the file resolved from mainRoot', () => {
    const profile = { login: { staff: { mode: 'storage-state', file: 'qa-artifacts/auth/staff.json' } } };
    assert.equal(storageFile('staff', { profile, mainRoot }), path.join(mainRoot, 'qa-artifacts', 'auth', 'staff.json'));
  });

  it('manual: <mainRoot>/qa-artifacts/auth/<role>.json', () => {
    const profile = { login: { staff: { mode: 'manual', path: '/auth', done: { urlNot: '/auth' } } } };
    assert.equal(storageFile('staff', { profile, mainRoot }), path.join(mainRoot, 'qa-artifacts', 'auth', 'staff.json'));
  });

  it('form: null, because a form login keeps no storage file', () => {
    const profile = { login: { staff: { mode: 'form', from: 'env', user: 'QA_HR_EMAIL', password: 'QA_HR_PASSWORD' } } };
    assert.equal(storageFile('staff', { profile, mainRoot }), null);
  });
});
