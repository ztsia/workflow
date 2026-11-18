// Contract tests for the CLI's ROUNDS block (rework U8, design 2026-11-12 §9 and §15): `qa round plan` records the
// last verdict in qa/<slug>/rounds.json and writes this round's plan to round.json; `qa security` is the
// verifier's `security:` line as a script; `qa tier` and `verdict --tier1` are gone. Each test builds a small git repo
// (neutral files: src/a, src/b, a guide) and writes the earlier round's verification files by hand.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { loadMap } from '../scripts/lib/map.mjs';
import { loadProfile } from '../scripts/lib/profile.mjs';
import { entryKeys, qaHashes } from '../scripts/lib/rounds.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const SLUG = 'feat-x';
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function commit(repo, files, message) {
  for (const [rel, text] of Object.entries(files)) write(path.join(repo.dir, rel), text);
  git(['add', '-A'], repo.dir);
  git(['commit', '-qm', message], repo.dir);
  return git(['rev-parse', 'HEAD'], repo.dir);
}
const cli = (repo, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const MAP = { screens: [
  { name: 'alpha', sources: ['src/a/**'], steps: [{ goto: '/a' }] },
  { name: 'beta', sources: ['src/b/**'], steps: [{ goto: '/b' }] },
] };
const EXPECTATIONS = [
  { name: 'e-alpha', criterion: 'ch:1', screens: 'alpha', text: 'A' },
  { name: 'e-beta', criterion: 'ch:2', screens: 'beta', text: 'B' },
];
const CHARTER = `# Charter — feat-x
security: no — none

- [ch:1] alpha shows A — by: expectation e-alpha
- [ch:2] beta shows B — by: expectation e-beta
`;

// main: qa.json, the map, two sources and a guide; feat/x changes src/a (the PR). V holds the spec and the plan.
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-round-')));
  made.push(dir);
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  const repo = { dir };
  repo.base = commit(repo, {
    '.gitignore': 'qa-artifacts/\n', 'qa.json': '{}\n', 'qa/map/app.json': JSON.stringify(MAP), 'src/a/A.tsx': 'a1\n', 'src/b/B.tsx': 'b1\n', 'docs/guide.md': 'g1\n',
  }, 'one');
  git(['checkout', '-qb', 'feat/x'], dir);
  repo.h1 = commit(repo, { 'src/a/A.tsx': 'a2\n' }, 'the change');
  repo.V = path.join(dir, 'qa', SLUG);
  write(path.join(repo.V, 'spec.md'), '# Spec\n1. alpha shows A\n2. beta shows B\n');
  write(path.join(repo.V, 'charter.md'), CHARTER);
  write(path.join(repo.V, 'expectations.json'), JSON.stringify(EXPECTATIONS));
  return repo;
}

// What round <n>'s run and judge left in V, for head <head>: results.json (with the map entries and QA hashes the run
// records) and the judge's verdict.md, ch:2 FAIL unless pass.
function judged(repo, head, n, { pass = false, of = 'full' } = {}) {
  const { profile } = loadProfile(repo.dir);
  const map = loadMap({ root: repo.dir, profile });
  write(path.join(repo.V, 'results.json'), JSON.stringify({
    version: 1, mode: 'diff', slug: SLUG, head: { sha: head, ref: 'HEAD' }, base: { sha: repo.base, ref: 'main' }, blocked: null, compareError: null,
    expectations: [
      { id: 'exp:e-alpha', viewport: 'desktop', name: 'e-alpha', result: 'met', detail: '1 of 1 right' },
      { id: 'exp:e-beta', viewport: 'desktop', name: 'e-beta', result: pass ? 'met' : 'NOT MET', detail: pass ? '1 of 1 right' : '0 of 1 right' },
    ],
    tests: [], docs: [], routes: null, mutants: null,
    round: { n, of, entries: entryKeys(map), qa: qaHashes({ root: repo.dir, profile, overlay: null }) },
  }));
  const status = pass ? 'PASS' : 'FAIL';
  write(path.join(repo.V, 'verdict.md'), `# ${pass ? 'ACCEPT' : 'REJECT'} — ${SLUG}
head: ${head}
base: ${repo.base}
maps: cccccccccccc
criteria: ${pass ? 4 : 2} pass · ${pass ? 0 : 2} fail · 0 unverifiable · 0 blocked · 0 waived

## Criteria
- [exp:e-alpha] PASS — e-alpha: 1 of 1 right
- [exp:e-beta] ${status} — e-beta: ${pass ? '1 of 1 right' : '0 of 1 right'}
- [ch:1] PASS — alpha shows A: exp:e-alpha met
- [ch:2] ${status} — beta shows B: exp:e-beta

## Expectations
- none

## Findings
- none

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 0 standing item(s), never gating

## Notes
- none

cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0
`);
}

describe('qa round plan', () => {
  test('round 1: a full round; round.json is written for HEAD and rounds.json is empty', () => {
    const repo = makeRepo();
    const r = cli(repo, ['round', 'plan', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.split('\n')[0], 'round 1: full — round 1');
    const plan = readJson(path.join(repo.V, 'round.json'));
    assert.equal(plan.round, 1);
    assert.equal(plan.head, repo.h1);
    assert.equal(plan.base, repo.base);
    assert.equal(plan.of, 'full');
    assert.match(plan.spec, /^[0-9a-f]{16}$/);
    assert.deepEqual(readJson(path.join(repo.V, 'rounds.json')), { rounds: [] });
  });

  test('round 2 after a REJECT: the fix touches src/b, so beta is walked and its rows re-run; alpha\'s are carried; round 1 is recorded', () => {
    const repo = makeRepo();
    assert.equal(cli(repo, ['round', 'plan', '--slug', SLUG]).status, 0);
    judged(repo, repo.h1, 1);
    const h2 = commit(repo, { 'src/b/B.tsx': 'b2\n' }, 'fix beta');
    const r = cli(repo, ['round', 'plan', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], `round 2: incremental from round 1 (${repo.h1.slice(0, 12)}) — 1 file(s) changed`);
    assert.ok(lines.includes('history: ch:2 failed in 1 earlier round(s); at 3 the verdict is NEEDS YOU (round cap)'), r.out);
    const plan = readJson(path.join(repo.V, 'round.json'));
    assert.equal(plan.head, h2);
    assert.equal(plan.of, 'incremental');
    assert.deepEqual(plan.changed, ['src/b/B.tsx']);
    assert.deepEqual(plan.screens, ['beta']);
    assert.deepEqual(plan.expectations, ['e-beta']);
    assert.deepEqual(plan.rerun, ['exp:e-beta', 'ch:2']);
    assert.deepEqual(plan.carried, ['exp:e-alpha', 'ch:1']);
    assert.deepEqual(plan.carry.criteria.map((c) => [c.id, c.sha, c.round]), [['ch:1', repo.h1, 1]]);
    const rounds = readJson(path.join(repo.V, 'rounds.json')).rounds;
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].round, 1);
    assert.equal(rounds[0].head, repo.h1);
    assert.equal(rounds[0].outcome, 'REJECT');
    assert.equal(rounds[0].spec, plan.spec);
    assert.deepEqual(rounds[0].rows.find((x) => x.id === 'ch:2'), { id: 'ch:2', status: 'FAIL', sha: repo.h1, round: 1 });
  });

  test('the same head again keeps its plan; --full makes it a full round', () => {
    const repo = makeRepo();
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    judged(repo, repo.h1, 1);
    commit(repo, { 'src/b/B.tsx': 'b2\n' }, 'fix beta');
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    const again = cli(repo, ['round', 'plan', '--slug', SLUG]);
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout.split('\n')[0], /^round 2: incremental from round 1 \([0-9a-f]{12}\) — 1 file\(s\) changed \(planned before for this head\)$/);
    assert.equal(readJson(path.join(repo.V, 'rounds.json')).rounds.length, 1);
    const full = cli(repo, ['round', 'plan', '--slug', SLUG, '--full']);
    assert.equal(full.stdout.split('\n')[0], 'round 2: full — --full');
    assert.equal(readJson(path.join(repo.V, 'round.json')).of, 'full');
  });

  test('--full on a head that already has a verdict is a full round again: that verdict\'s round files move to prev/, the plan stays', () => {
    const repo = makeRepo();
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    judged(repo, repo.h1, 1);
    for (const f of ['summary.md', 'eyes.md', 'report.html']) write(path.join(repo.V, f), 'x\n');
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    assert.ok(fs.existsSync(path.join(repo.V, 'verdict.md')) && !fs.existsSync(path.join(repo.V, 'prev')), 'the same head without --full moves nothing');
    const full = cli(repo, ['round', 'plan', '--slug', SLUG, '--full']);
    assert.equal(full.status, 0, full.out);
    assert.equal(full.stdout.split('\n')[0], 'round 1: full — --full');
    for (const f of ['verdict.md', 'results.json', 'summary.md', 'eyes.md', 'report.html']) {
      assert.ok(!fs.existsSync(path.join(repo.V, f)), `${f} left V`);
      assert.ok(fs.existsSync(path.join(repo.V, 'prev', f)), `${f} is in prev/`);
    }
    for (const f of ['charter.md', 'expectations.json', 'spec.md', 'round.json']) assert.ok(fs.existsSync(path.join(repo.V, f)), `${f} stays`);
    assert.equal(readJson(path.join(repo.V, 'round.json')).of, 'full');
  });

  test('--replan plans this head again after the mapper changed QA files: the entries it changed re-run; nothing moves, the round stays', () => {
    const repo = makeRepo();
    const args = ['round', 'plan', '--slug', SLUG, '--map', 'qa/map'];
    cli(repo, args);
    judged(repo, repo.h1, 1);
    commit(repo, { 'src/b/B.tsx': 'b2\n' }, 'fix beta');
    assert.equal(cli(repo, args).status, 0);
    assert.deepEqual(readJson(path.join(repo.V, 'round.json')).screens, ['beta']);
    // The mapper's repair round rewrites alpha's entry in the branch's own map.
    write(path.join(repo.dir, 'qa', 'map', 'app.json'), JSON.stringify({ screens: [{ name: 'alpha', sources: ['src/a/**'], steps: [{ goto: '/a?tab=all' }] }, MAP.screens[1]] }));
    assert.match(cli(repo, args).stdout.split('\n')[0], /\(planned before for this head\)$/);
    assert.deepEqual(readJson(path.join(repo.V, 'round.json')).screens, ['beta'], 'without --replan the plan of this head stands');
    const again = cli(repo, [...args, '--replan']);
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout.split('\n')[0], /^round 2: incremental from round 1 \([0-9a-f]{12}\) — 1 file\(s\) changed$/);
    const plan = readJson(path.join(repo.V, 'round.json'));
    assert.deepEqual(plan.screens, ['alpha', 'beta']);
    assert.equal(plan.screensWhy.alpha, 'entry changed');
    assert.ok(plan.rerun.includes('exp:e-alpha'));
    const rounds = readJson(path.join(repo.V, 'rounds.json')).rounds;
    assert.deepEqual(rounds.map((x) => [x.round, x.head, x.spec]), [[1, repo.h1, plan.spec]], 'round 1 stays round 1, as first recorded');
    assert.ok(!fs.existsSync(path.join(repo.V, 'prev')));
  });

  test('an incremental round walks only the PR\'s scope: an entry another PR\'s merge added to the shared map is never new for this PR', () => {
    const repo = makeRepo();
    const args = ['round', 'plan', '--slug', SLUG, '--map', 'qa/map'];
    cli(repo, args);
    judged(repo, repo.h1, 1);
    commit(repo, { 'src/b/B.tsx': 'b2\n' }, 'fix beta');
    // The shared map on disk gains another PR's screen between the rounds (another PR merged).
    write(path.join(repo.dir, 'qa', 'map', 'promoted.json'), JSON.stringify({ screens: [{ name: 'zeta', sources: ['src/z/**'], steps: [{ goto: '/z' }] }] }));
    const r = cli(repo, args);
    assert.equal(r.status, 0, r.out);
    const plan = readJson(path.join(repo.V, 'round.json'));
    assert.equal(plan.of, 'incremental');
    assert.deepEqual(plan.screens, ['beta'], r.out);
  });

  test('a fix that changes qa.json, or a changed spec, is a full round', () => {
    const repo = makeRepo();
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    judged(repo, repo.h1, 1);
    commit(repo, { 'qa.json': '{ "viewports": { "desktop": [1280, 800] } }\n' }, 'qa');
    assert.equal(cli(repo, ['round', 'plan', '--slug', SLUG]).stdout.split('\n')[0], 'round 2: full — qa.json changed');
    const other = makeRepo();
    cli(other, ['round', 'plan', '--slug', SLUG]);
    judged(other, other.h1, 1);
    commit(other, { 'src/b/B.tsx': 'b2\n' }, 'fix beta');
    write(path.join(other.V, 'spec.md'), '# Spec\n1. alpha shows A\n2. beta shows C\n');
    assert.equal(cli(other, ['round', 'plan', '--slug', SLUG]).stdout.split('\n')[0], 'round 2: full — the spec changed since round 1');
  });

  test('round 3 of a criterion REJECTed twice: the history says the next FAIL is capped', () => {
    const repo = makeRepo();
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    judged(repo, repo.h1, 1);
    const h2 = commit(repo, { 'src/b/B.tsx': 'b2\n' }, 'fix beta');
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    judged(repo, h2, 2, { of: 'incremental' });
    commit(repo, { 'src/b/B.tsx': 'b3\n' }, 'fix beta again');
    const r = cli(repo, ['round', 'plan', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^round 3: incremental from round 2 /);
    assert.ok(r.stdout.includes('history: ch:2 failed in 2 earlier round(s); at 3 the verdict is NEEDS YOU (round cap)'), r.out);
    assert.deepEqual(readJson(path.join(repo.V, 'round.json')).history, { 'ch:2': 2 });
  });

  test('after an ACCEPT a new commit is a full round', () => {
    const repo = makeRepo();
    cli(repo, ['round', 'plan', '--slug', SLUG]);
    judged(repo, repo.h1, 1, { pass: true });
    commit(repo, { 'src/b/B.tsx': 'b2\n' }, 'more');
    assert.equal(cli(repo, ['round', 'plan', '--slug', SLUG]).stdout.split('\n')[0], 'round 2: full — round 1 was an ACCEPT: a new commit needs a new check');
  });
});

describe('qa security', () => {
  test('prints the charter\'s security line from the diff: no for plain UI files, yes with each sensitive path', () => {
    const repo = makeRepo();
    const no = cli(repo, ['security', '--from', repo.base]);
    assert.equal(no.status, 0, no.out);
    assert.equal(no.stdout.trim(), 'security: no — the diff touches no sensitive, auth, role, session, route or migration path');
    commit(repo, { 'src/auth/login.ts': 'x\n', 'db/migrations/002.sql': 'y\n' }, 'auth');
    const yes = cli(repo, ['security', '--from', repo.base]);
    assert.equal(yes.stdout.trim(), 'security: yes — db/migrations/002.sql (migration or policy), src/auth/login.ts (auth, role or session code)');
    const json = JSON.parse(cli(repo, ['security', '--from', repo.base, '--json']).stdout);
    assert.deepEqual(json.paths.map((p) => p.file), ['db/migrations/002.sql', 'src/auth/login.ts']);
  });
});

describe('the tiers are gone', () => {
  test('qa tier and verdict --tier1 are usage errors', () => {
    const repo = makeRepo();
    const tier = cli(repo, ['tier']);
    assert.equal(tier.status, 64, tier.out);
    assert.match(tier.out, /unknown command tier/);
    const tier1 = cli(repo, ['verdict', '--tier1']);
    assert.equal(tier1.status, 64, tier1.out);
    assert.ok(!/tier/.test(cli(repo, ['help']).stdout), 'the usage text names no tier');
  });
});
