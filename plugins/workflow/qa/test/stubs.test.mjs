// Contract tests for qa.json `stubs` (design §6.1 rung 3): a deterministic stand-in for what varies (a model's answer,
// a payment provider), declared as env switches the sandbox sets. The charter names the stubs a plan needs on its
// `stubs:` line; the runner, the plan check and the prepare check read it from V/charter.md and bring the sandboxes up
// with them; an undeclared id is a problem in minutes, never a 40-minute round. Secrets never go in qa.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { DEFAULTS, loadProfile, looksSecret, validateProfile } from '../scripts/lib/profile.mjs';
import { charterStubs, resolveStubs } from '../scripts/lib/stubs.mjs';
import { prepareCheck, prepareExit, prepareMd } from '../scripts/lib/prepare.mjs';
import { dropFailed, planCheck, planCheckMd } from '../scripts/lib/plan.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { down, up } from '../scripts/lib/sandbox.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir(prefix = 'mfqa-stubs-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
function write(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  return file;
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const STUBS = {
  'fixed-answer': { for: 'the chat model\'s answer', env: { QA_LLM_MODE: 'fixture', QA_LLM_FIXTURE: 'chart-answer' } },
  'fake-pay': { for: 'the payment provider', env: { PAY_PROVIDER: 'fake' } },
};
const CHARTER = (stubs) => `# Charter — x\nsecurity: no — none\n${stubs === null ? '' : `stubs: ${stubs} — the chat answer\n`}\n- [ch:1] the chat draws a chart — axis: happy path — rung 3: stub fixed-answer makes the answer fixed — by: expectation chart-shown\n`;

describe('qa.json stubs: schema, defaults, secrets', () => {
  test('the shape { <id>: { for, env: { NAME: value } } } is valid; the default is no stub', () => {
    assert.deepEqual(validateProfile({ stubs: STUBS }).errors, []);
    assert.deepEqual(DEFAULTS.stubs, {});
    const dir = tmpDir();
    write(dir, 'qa.json', {});
    assert.deepEqual(loadProfile(dir).profile.stubs, {});
    write(dir, 'qa.json', { stubs: STUBS });
    assert.deepEqual(loadProfile(dir).profile.stubs, STUBS);
  });

  test('a stub needs `for` and at least one env switch; an id is a plain name; a value is a string', () => {
    const errs = (stubs) => validateProfile({ stubs }).errors;
    assert.ok(errs({ a: { env: { X_MODE: '1' } } }).some((e) => /^stubs\.a\.for: missing required key/.test(e)));
    assert.ok(errs({ a: { for: 'x', env: {} } }).some((e) => /^stubs\.a\.env: needs at least one switch/.test(e)));
    assert.ok(errs({ 'bad id!': { for: 'x', env: { X_MODE: '1' } } }).some((e) => /^stubs\.bad id!: a stub id is a plain name/.test(e)));
    assert.ok(errs({ a: { for: 'x', env: { X_MODE: 1 } } }).some((e) => /^stubs\.a\.env\.X_MODE: must be string/.test(e)));
    assert.ok(errs({ a: { for: 'x', env: { 'lower-case': 'on' } } }).some((e) => /^stubs\.a\.env\.lower-case: must be an environment variable name/.test(e)));
    assert.ok(errs({ a: { for: 'x', env: { X_MODE: '1' }, extra: 1 } }).some((e) => /^stubs\.a\.extra: unknown key/.test(e)));
  });

  test('an env name that looks like a secret is refused, whatever its value (the profile secret guard, widened)', () => {
    for (const name of ['OPENAI_API_KEY', 'DB_PASSWORD', 'AUTH_TOKEN', 'CLIENT_SECRET', 'STRIPE_KEY', 'APIKEY', 'SENTRY_DSN', 'GCP_CREDENTIALS']) {
      assert.equal(looksSecret(name), true, name);
      const { errors } = validateProfile({ stubs: { a: { for: 'x', env: { [name]: 'FAKE' } } } });
      assert.ok(errors.some((e) => e === `stubs.a.env.${name}: looks like a secret's name — a stub sets a switch, never a credential (secrets never go in qa.json)`), `${name}: ${errors.join(' | ')}`);
    }
    for (const name of ['QA_LLM_MODE', 'PAY_PROVIDER', 'FEATURE_KEYBOARD', 'MONKEY_MODE']) assert.equal(looksSecret(name), false, name);
  });
});

describe('the charter names the stubs; resolveStubs turns ids into env', () => {
  test('charterStubs reads the `stubs:` line; none or no line is []', () => {
    assert.deepEqual(charterStubs(CHARTER('fixed-answer, fake-pay')), ['fixed-answer', 'fake-pay']);
    assert.deepEqual(charterStubs(CHARTER('none')), []);
    assert.deepEqual(charterStubs(CHARTER(null)), []);
    assert.deepEqual(charterStubs(null), []);
    assert.deepEqual(charterStubs('stubs: fixed-answer fixed-answer\n'), ['fixed-answer'], 'each id once');
  });

  test('resolveStubs: the env of the declared ids plus QA_STUBS; an undeclared id and a switch two stubs set differently are named', () => {
    const r = resolveStubs({ stubs: STUBS }, ['fixed-answer', 'ghost']);
    assert.deepEqual(r.ids, ['fixed-answer']);
    assert.deepEqual(r.unknown, ['ghost']);
    assert.deepEqual(r.env, { QA_LLM_MODE: 'fixture', QA_LLM_FIXTURE: 'chart-answer', QA_STUBS: 'fixed-answer' });
    assert.deepEqual(r.conflicts, []);
    const clash = resolveStubs({ stubs: { ...STUBS, other: { for: 'y', env: { PAY_PROVIDER: 'sandbox' } } } }, ['other', 'fake-pay']);
    assert.deepEqual(clash.ids, ['fake-pay', 'other']);
    assert.deepEqual(clash.conflicts, ['PAY_PROVIDER']);
    assert.deepEqual(resolveStubs({ stubs: STUBS }, []).env, {}, 'no stub: no env at all');
  });
});

// A repo with qa/ untracked; head adds src/chat.ts; an overlay folder holds one entry (the library takes one; the CLI sets none).
function prepRepo() {
  const dir = tmpDir('mfqa-stubs-prep-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(dir, '.gitignore', 'qa/\nqa.json\nqa-artifacts/\nqa/\noverlays/\n');
  write(dir, 'src/app.ts', 'export {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'feat/x');
  write(dir, 'src/chat.ts', 'export {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'two');
  const head = git(dir, 'rev-parse', 'HEAD');
  const overlay = path.join(dir, 'overlays', 'prs', 'x', 'qa');
  write(overlay, 'map/x.json', { screens: [{ name: 'chat', sources: ['src/chat.ts'], expectData: 'Revenue', steps: [{ goto: '/' }] }] });
  return { dir, base, head, overlay, V: path.join(dir, 'qa', 'x') };
}
const prepDeps = (r, ups) => ({
  up: async (req) => { ups.push(req); return { name: 'qa-x', slug: 'x', dir: r.dir, port: 1, appUrl: 'http://127.0.0.1:1' }; },
  handOff: () => true,
  captureSide: async () => ({ viewports: [{ viewport: 'desktop', captured: [], failed: [], notRun: [], warnings: [] }] }),
});
const PROFILE = { map: 'qa/map', seedNames: 'qa/seed.json', viewports: { desktop: [1280, 800] }, clock: 'off', run: { cacheKeep: 5 }, sandbox: { retryWaitMs: 1 }, stubs: STUBS, login: {} };

describe('prepare check: every stub the charter names must be declared', () => {
  test('an undeclared id is a [stub:<id>] problem (exit 1, never "nothing to check"); the sandbox comes up with the declared ones', async () => {
    const r = prepRepo();
    write(r.V, 'charter.md', CHARTER('fixed-answer, ghost'));
    const ups = [];
    const check = await prepareCheck({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'x', V: r.V, head: r.head, base: r.base, overlay: r.overlay }, prepDeps(r, ups));
    const p = check.problems.find((x) => x.id === 'stub:ghost');
    assert.ok(p, JSON.stringify(check.problems));
    assert.match(p.text, /^the charter names stub ghost, which qa\.json stubs does not declare/);
    assert.equal(prepareExit(check), 1);
    assert.deepEqual(check.stubs, ['fixed-answer']);
    assert.match(prepareMd(check), /^stubs: fixed-answer \(qa\.json stubs, set on the head sandbox\)$/m);
    assert.match(prepareMd(check), /^- \[stub:ghost\] the charter names stub ghost/m);
    assert.deepEqual(ups.map((req) => req.stubs), [['fixed-answer']]);
    // A charter whose every stub is undeclared, and nothing else to check: still a problem, never 'nothing to check'.
    const bare = prepRepo();
    fs.rmSync(bare.overlay, { recursive: true });
    write(bare.V, 'charter.md', CHARTER('ghost'));
    const lone = await prepareCheck({ mainRoot: bare.dir, repoRoot: bare.dir, profile: PROFILE, slug: 'x', V: bare.V, head: bare.head, base: bare.base, overlay: null }, prepDeps(bare, []));
    assert.equal(lone.nothing, false);
    assert.equal(prepareExit(lone), 1);
  });

  test('a full round re-plans: an undeclared stub of the old charter is a concern, never a problem; an incremental round keeps it a problem that says the way out', async () => {
    const r = prepRepo();
    write(r.V, 'charter.md', CHARTER('ghost'));
    const opts = { mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'x', V: r.V, head: r.head, base: r.base, overlay: r.overlay };
    write(r.V, 'round.json', { round: 2, head: r.head, of: 'full', why: '--full' });
    const full = await prepareCheck(opts, prepDeps(r, []));
    assert.ok(!full.problems.some((x) => x.id.startsWith('stub:')), JSON.stringify(full.problems));
    assert.ok(full.concerns.some((c) => /^stub ghost: /.test(c) && /the plan check holds the new charter to it/.test(c)), full.concerns.join(' | '));
    write(r.V, 'round.json', { round: 2, head: r.head, of: 'incremental', why: 'after round 1' });
    const inc = await prepareCheck(opts, prepDeps(r, []));
    const p = inc.problems.find((x) => x.id === 'stub:ghost');
    assert.ok(p, JSON.stringify(inc.problems));
    assert.match(p.text, /declare it in qa\.json stubs, or verify with --full to re-plan/);
    // A round plan of another head says nothing about this round: the stub is a problem, as before.
    write(r.V, 'round.json', { round: 1, head: 'f'.repeat(40), of: 'full' });
    assert.ok((await prepareCheck(opts, prepDeps(r, []))).problems.some((x) => x.id === 'stub:ghost'));
  });

  test('opts.stubs names them directly; every one declared is no problem; no charter and no opts is no stub', async () => {
    const r = prepRepo();
    const ups = [];
    const deps = prepDeps(r, ups);
    const named = await prepareCheck({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'x', V: r.V, head: r.head, base: r.base, overlay: r.overlay, stubs: ['fake-pay'] }, deps);
    assert.ok(!named.problems.some((x) => x.id.startsWith('stub:')));
    assert.deepEqual(ups.at(-1).stubs, ['fake-pay']);
    const none = await prepareCheck({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'x', V: path.join(r.dir, 'qa', 'other'), head: r.head, base: r.base, overlay: r.overlay }, deps);
    assert.deepEqual(none.stubs, []);
    assert.deepEqual(ups.at(-1).stubs, []);
  });
});

describe('plan check: the fresh charter\'s stubs', () => {
  test('the head sandbox comes up with the declared stubs; an undeclared one is a stub problem, and --drop takes it off the charter line', async () => {
    const r = prepRepo();
    write(r.V, 'expectations.json', [{ name: 'chart-shown', criterion: 'ch:1', screens: 'chat', text: 'Revenue by month' }]);
    write(r.V, 'charter.md', CHARTER('fixed-answer, ghost'));
    write(r.dir, 'qa/map/app.json', { screens: [{ name: 'chat', steps: [{ goto: '/' }] }] });
    const ups = [];
    const check = await planCheck({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, slug: 'x', V: r.V, head: r.head, map: path.join(r.dir, 'qa', 'map') }, {
      up: async (req) => { ups.push(req); return { name: 'qa-x', slug: 'x', dir: r.dir, port: 1, appUrl: 'http://127.0.0.1:1', reused: true }; },
      observe: async () => ({ observations: [{ index: 0, viewport: 'desktop', screen: 'chat', key: 'chat__default', count: 1, svg: 0, matched: 1, tree: 1, samples: ['Revenue by month'], contexts: [] }], failures: [] }),
    });
    assert.deepEqual(ups.map((u) => u.stubs), [['fixed-answer']]);
    assert.deepEqual(check.stubs, [{ id: 'ghost', problem: 'not declared in qa.json stubs: name a declared stub (qa profile lists them) or take another rung' }]);
    const md = planCheckMd(check);
    assert.match(md, /^## Stub problems\n- stub:ghost: not declared in qa\.json stubs/m);
    dropFailed({ V: r.V, check });
    assert.deepEqual(charterStubs(fs.readFileSync(path.join(r.V, 'charter.md'), 'utf8')), ['fixed-answer']);
    assert.match(fs.readFileSync(path.join(r.V, 'charter.md'), 'utf8'), /^- \[ch:1\] the chat draws a chart/m, 'the rest of the charter is kept');
  });
});

describe('the run: the charter\'s stubs on both sandboxes', () => {
  function runRepo() {
    const r = prepRepo();
    write(r.dir, 'qa/map/app.json', { screens: [{ name: 'chat', sources: ['src/chat.ts'], steps: [{ goto: '/' }] }] });
    return r;
  }
  function fakes(dir) {
    const ups = [];
    const deps = {
      up: async (req) => { ups.push({ at: req.at, stubs: req.stubs }); return { name: `qa-${req.at.slice(0, 10)}`, slug: 'x', dir, port: 1, appUrl: 'http://127.0.0.1:1', seedStartedAt: null }; },
      down: async () => ({ warnings: [] }),
      captureSide: async (req) => {
        const vps = req.viewports ?? Object.keys(req.profile.viewports);
        return { viewports: vps.map((viewport) => ({ viewport, captured: [], failed: [], notRun: [], warnings: [] })), clock: { clock: null, why: 'off' }, mapErrors: [], ms: 1 };
      },
      compare: async (req) => { fs.mkdirSync(req.out, { recursive: true }); return { exit: 0, viewports: [] }; },
      sweepSide: async () => ({ file: null, rows: 0, registered: null, probes: [], unlisted: [], stale: [], errors: [], notRun: 'no route table', expectations: [] }),
      runVerb: async () => ({ notRun: 'none' }),
      mutate: async () => ({ selected: 0, result: null }),
      readiness: () => ({ state: 'ready', line: null }),
      sleep: async () => {},
    };
    return { ups, deps };
  }

  test('base and head both come up with the declared stubs; an undeclared one is a warning, never set; run.json says which', async () => {
    const r = runRepo();
    write(r.V, 'charter.md', CHARTER('fixed-answer, ghost'));
    const f = fakes(r.dir);
    const run = await runQa({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, base: r.base, slug: 'x', log: () => {}, cache: false }, f.deps);
    assert.deepEqual(f.ups.map((u) => u.stubs), [['fixed-answer'], ['fixed-answer']]);
    assert.deepEqual(run.stubs, ['fixed-answer']);
    assert.ok(run.warnings.some((w) => /^stub ghost: the charter names it, but qa\.json stubs does not declare it — not set$/.test(w)), run.warnings.join(' | '));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.V, 'run.json'), 'utf8')).stubs, ['fixed-answer']);
  });

  test('the base cache key holds the stubs: a run with a stub never reuses base captures made without it', async () => {
    const r = runRepo();
    const plain = await runQa({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, base: r.base, slug: 'x', log: () => {} }, fakes(r.dir).deps);
    write(r.V, 'charter.md', CHARTER('fixed-answer'));
    const stubbed = await runQa({ mainRoot: r.dir, repoRoot: r.dir, profile: PROFILE, base: r.base, slug: 'x', log: () => {} }, fakes(r.dir).deps);
    assert.notEqual(stubbed.maps.base, plain.maps.base);
    assert.notEqual(stubbed.dirs.cache, plain.dirs.cache);
  });
});

describe('sandbox.up sets a stub\'s env on the stack verbs', () => {
  // A command stack: seed writes the env it sees; serve answers the health check.
  function sandboxRepo() {
    const base = tmpDir('mfqa-stubs-sbx-');
    const mainRoot = path.join(base, 'repo');
    fs.mkdirSync(mainRoot);
    git(mainRoot, 'init', '-q');
    write(mainRoot, 'app.txt', 'one\n');
    write(mainRoot, '.gitignore', 'qa-artifacts/\n');
    git(mainRoot, 'add', '-A');
    git(mainRoot, 'commit', '-qm', 'one');
    const seen = path.join(base, 'seen.txt');
    const serve = "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.QA_PORT), '127.0.0.1')";
    const profile = {
      stubs: STUBS, ports: { band: [18460, 18470], reserved: [], extra: [] }, sandbox: { max: 3 },
      stack: { adapter: [], healthPath: '/', healthTimeoutMs: 20000, settings: {}, setup: 'true', up: 'true', build: 'true',
        seed: `echo "mode=\${QA_LLM_MODE:-} stubs=\${QA_STUBS:-}" >> ${seen}`, serve: `exec node -e "${serve}"` },
    };
    return { mainRoot, seen, profile, sha: git(mainRoot, 'rev-parse', 'HEAD') };
  }

  test('the verbs see the env and QA_STUBS; the descriptor records them; other stubs restart it; the same reuse it; an undeclared id is refused', { timeout: 90000 }, async () => {
    const s = sandboxRepo();
    const log = () => {};
    let d;
    try {
      d = await up({ mainRoot: s.mainRoot, profile: s.profile, at: s.sha, stubs: ['fixed-answer'], log });
      assert.deepEqual(d.stubs, ['fixed-answer']);
      assert.equal(fs.readFileSync(s.seen, 'utf8'), 'mode=fixture stubs=fixed-answer\n');
      const same = await up({ mainRoot: s.mainRoot, profile: s.profile, at: s.sha, stubs: ['fixed-answer'], log });
      assert.equal(same.reused, true);
      d = await up({ mainRoot: s.mainRoot, profile: s.profile, at: s.sha, stubs: [], log });
      assert.equal(d.reused, undefined, 'a sandbox with other stubs is taken down and brought up again');
      assert.deepEqual(d.stubs, []);
      assert.equal(fs.readFileSync(s.seen, 'utf8'), 'mode=fixture stubs=fixed-answer\nmode= stubs=\n');
      await assert.rejects(up({ mainRoot: s.mainRoot, profile: s.profile, at: s.sha, stubs: ['ghost'], log }), /stub ghost is not declared in qa\.json stubs/);
    } finally {
      if (d) await down({ mainRoot: s.mainRoot, profile: s.profile, name: d.name }).catch(() => {});
    }
  });
});
