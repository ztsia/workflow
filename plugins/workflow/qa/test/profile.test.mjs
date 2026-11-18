// Contract tests for scripts/lib/profile.mjs (the CONTRACT comment at the top of that file is the spec).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadProfile, mainRoot, repoRoot, requireProfile, schemaErrors, validateProfile } from '../scripts/lib/profile.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// A fresh temp directory, a git repository unless git is false.
function tempDir({ git = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-profile-')));
  made.push(dir);
  if (git) execFileSync('git', ['init', '-q', dir]);
  return dir;
}

// Writes qa.json: an object is serialised, a string is written as-is (for bad JSON).
function writeQa(root, content) {
  fs.writeFileSync(path.join(root, 'qa.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

// Returns what fn threw. A stub's 'not built: …' error is rethrown so the failure names the missing function.
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    if (String(err.message).startsWith('not built')) throw err;
    return err;
  }
  assert.fail('expected a throw');
}

const RMS_EXAMPLE = {
  stack: { adapter: ['custom-stack', 'node-static'], build: 'npm run build' },
  login: {
    staff: {
      mode: 'form',
      path: '/auth',
      from: 'adapter',
      fields: { email: 'input[type=email]', password: 'input[type=password]' },
      submit: 'button[type=submit]',
      done: { urlNot: '/auth' },
    },
  },
  viewports: { desktop: [1440, 900], phone: [390, 844] },
  ports: { band: [8010, 8030], reserved: [8090] },
};

describe('profile: loadProfile', () => {
  it('a root without qa.json throws NO_PROFILE', () => {
    const root = tempDir();
    const err = thrown(() => loadProfile(root));
    assert.equal(err.code, 'NO_PROFILE');
  });

  it('a qa.json that is not JSON throws BAD_JSON', () => {
    const root = tempDir();
    writeQa(root, '{ "stack": ');
    const err = thrown(() => loadProfile(root));
    assert.equal(err.code, 'BAD_JSON');
  });

  it('an empty qa.json loads as exactly DEFAULTS, with path, errors and warnings', () => {
    const root = tempDir();
    writeQa(root, {});
    const r = loadProfile(root);
    assert.deepEqual(r.profile, {
      map: 'qa/map',
      seedNames: 'qa/seed.json',
      base: 'sandbox',
      viewports: { desktop: [1440, 900] },
      modes: ['light'],
      ports: { band: [8010, 8030], reserved: [], extra: [] },
      sandbox: { max: 3, retryWaitMs: 15000 },
      run: { cacheKeep: 5 },
      workers: 1,
      browser: { channel: 'chrome' },
      stack: { adapter: [], healthPath: '/', healthTimeoutMs: 120000, settings: {} },
      settle: { timeoutMs: 10000, quietMs: 500, hidden: null },
      checks: { enabled: true, touchBelow: 768, keyboardHeight: 508 },
      tour: { enabled: true, max: 30, hover: true, maxHover: 40, open: [], skip: [] },
      stepTimeoutMs: 20000,
      maxElementsPerCapture: 80,
      watch: null,
      palette: {},
      writes: { scope: null, allow: [], block: false },
      ignoreErrors: [],
      login: {},
      sensitive: [],
      security: [],
      limits: {},
      clock: 'seed',
      volatile: [],
      eyes: { questions: [] },
      routes: { enabled: true, table: null, base: null, origin: false, headers: {}, timeoutMs: 15000 },
      mutants: { file: null, timeoutMs: 900000 },
      plan: { maxMatches: 20 },
      stubs: {},
      agents: {
        mapper: { model: 'haiku', timeoutMs: 1200000 }, planner: { model: 'sonnet', timeoutMs: 1800000 },
        security: { model: 'sonnet', timeoutMs: 1200000 }, eyes: { model: 'opus', timeoutMs: 1800000 },
        judge: { model: 'sonnet', timeoutMs: 1200000 },
      },
    });
    assert.equal(r.path, path.join(root, 'qa.json'));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  it('file objects deep-merge over DEFAULTS and file arrays replace them', () => {
    const root = tempDir();
    writeQa(root, {
      viewports: { phone: [390, 844] },
      modes: ['dark'],
      ports: { band: [9000, 9010] },
      stack: { settings: { a: 1 } },
    });
    const { profile } = loadProfile(root);
    assert.deepEqual(profile.viewports, { desktop: [1440, 900], phone: [390, 844] });
    assert.deepEqual(profile.modes, ['dark']);
    assert.deepEqual(profile.ports, { band: [9000, 9010], reserved: [], extra: [] });
    assert.deepEqual(profile.stack, { adapter: [], healthPath: '/', healthTimeoutMs: 120000, settings: { a: 1 } });
  });

  it("stack.adapter 'custom-stack' is normalised to ['custom-stack']; an array stays an array", () => {
    const single = tempDir();
    writeQa(single, { stack: { adapter: 'custom-stack' } });
    assert.deepEqual(loadProfile(single).profile.stack.adapter, ['custom-stack']);

    const list = tempDir();
    writeQa(list, { stack: { adapter: ['custom-stack', 'node-static'] } });
    assert.deepEqual(loadProfile(list).profile.stack.adapter, ['custom-stack', 'node-static']);
  });

  it('schema violations are returned in errors, not thrown', () => {
    const root = tempDir();
    writeQa(root, { stack: { adapter: 5 } });
    const r = loadProfile(root);
    assert.ok(r.errors.some((e) => e.startsWith('stack.adapter: ')), `errors were ${JSON.stringify(r.errors)}`);
  });

  it("volatile must be an array: a string is an error 'volatile: must be array'", () => {
    const root = tempDir();
    writeQa(root, { volatile: 'x' });
    const r = loadProfile(root);
    assert.ok(r.errors.includes('volatile: must be array'), `errors were ${JSON.stringify(r.errors)}`);
  });
});

describe('profile: validateProfile', () => {
  it('a plain-string password under login, or a token anywhere, is an error naming the path', () => {
    const underLogin = validateProfile({ login: { staff: { mode: 'form', password: 'hunter2' } } });
    assert.ok(underLogin.errors.includes('login.staff.password: secrets go in env names, never qa.json'), JSON.stringify(underLogin.errors));

    const anywhere = validateProfile({ stack: { settings: { token: 'abc' } } });
    assert.ok(anywhere.errors.includes('stack.settings.token: secrets go in env names, never qa.json'), JSON.stringify(anywhere.errors));
  });

  it('a login env name must match /^[A-Z][A-Z0-9_]*$/: qa_hr is an error, QA_HR_EMAIL is not', () => {
    const bad = validateProfile({ login: { staff: { mode: 'form', from: 'env', user: 'qa_hr' } } });
    assert.ok(bad.errors.some((e) => e.startsWith('login.staff.user: ')), JSON.stringify(bad.errors));

    const good = validateProfile({ login: { staff: { mode: 'form', from: 'env', user: 'QA_HR_EMAIL' } } });
    assert.ok(!good.errors.some((e) => e.startsWith('login.staff.user: ')), JSON.stringify(good.errors));
  });

  it('the RMS example in the comment validates with zero errors and loads through requireProfile', () => {
    const r = validateProfile(RMS_EXAMPLE);
    assert.deepEqual(r.errors, []);

    const root = tempDir();
    writeQa(root, RMS_EXAMPLE);
    const profile = requireProfile(root);
    assert.deepEqual(profile.stack.adapter, ['custom-stack', 'node-static']);
    assert.deepEqual(profile.ports.reserved, [8090]);
  });

  it('checks: { enabled: false } validates clean and merges over the checks defaults', () => {
    const r = validateProfile({ checks: { enabled: false } });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);

    const root = tempDir();
    writeQa(root, { checks: { enabled: false } });
    assert.deepEqual(loadProfile(root).profile.checks, { enabled: false, touchBelow: 768, keyboardHeight: 508 });
  });

  it("checks: { bogus: 1 } is an error 'checks.bogus: unknown key'", () => {
    const r = validateProfile({ checks: { bogus: 1 } });
    assert.ok(r.errors.includes('checks.bogus: unknown key'), JSON.stringify(r.errors));
  });

  it('sandbox.retryWaitMs 0 and run.cacheKeep 2 validate with no errors and merge over DEFAULTS', () => {
    const r = validateProfile({ sandbox: { retryWaitMs: 0 }, run: { cacheKeep: 2 } });
    assert.deepEqual(r.errors, []);

    const root = tempDir();
    writeQa(root, { sandbox: { retryWaitMs: 0 }, run: { cacheKeep: 2 } });
    const loaded = loadProfile(root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.profile.sandbox.max, 3);
    assert.equal(loaded.profile.sandbox.retryWaitMs, 0);
    assert.equal(loaded.profile.run.cacheKeep, 2);
  });

  it("run: { cacheKeep: 'x' } is an error 'run.cacheKeep: must be integer'", () => {
    const r = validateProfile({ run: { cacheKeep: 'x' } });
    assert.ok(r.errors.some((e) => e.startsWith('run.cacheKeep: ')), JSON.stringify(r.errors));
  });

  it("run: { bogus: 1 } is an error 'run.bogus: unknown key'", () => {
    const r = validateProfile({ run: { bogus: 1 } });
    assert.ok(r.errors.includes('run.bogus: unknown key'), JSON.stringify(r.errors));
  });

  it("eyes: { questions: ['Is the total obvious?'] } validates clean and loads as given", () => {
    const r = validateProfile({ eyes: { questions: ['Is the total obvious?'] } });
    assert.deepEqual(r.errors, []);

    const root = tempDir();
    writeQa(root, { eyes: { questions: ['Is the total obvious?'] } });
    const loaded = loadProfile(root);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.profile.eyes, { questions: ['Is the total obvious?'] });
  });

  it("eyes: { other: 1 } is an error 'eyes.other: unknown key'", () => {
    const r = validateProfile({ eyes: { other: 1 } });
    assert.ok(r.errors.includes('eyes.other: unknown key'), JSON.stringify(r.errors));
  });

  it("eyes: { questions: 'x' } is an error 'eyes.questions: must be array'", () => {
    const r = validateProfile({ eyes: { questions: 'x' } });
    assert.ok(r.errors.includes('eyes.questions: must be array'), JSON.stringify(r.errors));
  });

  it("eyes: { questions: [5] } is an error 'eyes.questions[0]: must be string'", () => {
    const r = validateProfile({ eyes: { questions: [5] } });
    assert.ok(r.errors.includes('eyes.questions[0]: must be string'), JSON.stringify(r.errors));
  });
});

describe('profile: agents (rework U10, qa verify)', () => {
  it('agents.<role>.model and timeoutMs validate clean and merge over the defaults key by key', () => {
    assert.deepEqual(validateProfile({ agents: { eyes: { model: 'sonnet' }, judge: { timeoutMs: 600000 } } }).errors, []);
    const root = tempDir();
    writeQa(root, { agents: { eyes: { model: 'claude-sonnet-5-5' } } });
    const { profile } = loadProfile(root);
    assert.deepEqual(profile.agents.eyes, { model: 'claude-sonnet-5-5', timeoutMs: 1800000 });
    assert.deepEqual(profile.agents.planner, { model: 'sonnet', timeoutMs: 1800000 });
  });

  it('an unknown role, an unknown key, a short timeout or an empty model is an error', () => {
    const errors = (agents) => validateProfile({ agents }).errors;
    assert.ok(errors({ builder: { model: 'haiku' } }).includes('agents.builder: unknown key'), JSON.stringify(errors({ builder: {} })));
    assert.ok(errors({ eyes: { effort: 'high' } }).includes('agents.eyes.effort: unknown key'));
    assert.ok(errors({ judge: { timeoutMs: 1000 } }).some((e) => e.startsWith('agents.judge.timeoutMs: ')));
    assert.ok(errors({ mapper: { model: '' } }).some((e) => e.startsWith('agents.mapper.model: ')));
  });
});

describe('profile: requireProfile', () => {
  it('an invalid profile throws INVALID listing every error', () => {
    const root = tempDir();
    writeQa(root, { stack: { adapter: 5 }, login: { staff: { password: 'x' } } });
    const err = thrown(() => requireProfile(root));
    assert.equal(err.code, 'INVALID');
    assert.match(err.message, /stack\.adapter: /);
    assert.ok(err.message.includes('login.staff.password: secrets go in env names, never qa.json'), err.message);
  });
});

describe('profile: roots', () => {
  it('mainRoot from a linked worktree is the main checkout that owns it', () => {
    const main = tempDir();
    execFileSync('git', ['-C', main, '-c', 'user.name=qa test', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = path.join(tempDir({ git: false }), 'wt');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'qa-sandbox', wt]);
    assert.equal(mainRoot(wt), main);
    assert.equal(mainRoot(main), main);
  });

  it('repoRoot is the toplevel of cwd; both roots throw outside a git repository', () => {
    const top = tempDir();
    const sub = path.join(top, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(repoRoot(sub), top);

    const plain = tempDir({ git: false });
    assert.match(thrown(() => repoRoot(plain)).message, /not a git repository/);
    assert.match(thrown(() => mainRoot(plain)).message, /not a git repository/);
  });
});

describe('profile: schemaErrors', () => {
  it('a wrong-typed property is reported as <path>: must be <type>', () => {
    assert.deepEqual(schemaErrors({ a: 'x' }, { type: 'object', properties: { a: { type: 'integer' } } }), ['a: must be integer']);
  });

  it('a wrong-typed root is reported as (root): must be <type>', () => {
    assert.deepEqual(schemaErrors(5, { type: 'object' }), ['(root): must be object']);
  });
});
