// RED tests for the STEP 5 CLI block of scripts/qa.mjs (the block's comment, lines 1–75, is the
// contract). Each test spawns `node scripts/qa.mjs …` in its own temp git repo: one commit, a
// qa.json of `{}` and one source file. The verification files are written from the step 5 brief's
// example (exampleRun() through buildResults, the judge's verdict.md, eyes.md and charter.md). Until
// the commands exist, every test fails: the CLI answers usage with exit 64.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { buildResults } from '../scripts/lib/summary.mjs';
import { exampleRun } from './fixtures/run-example.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const SLUG = 'feat-x';
const made = [];

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

// One commit on main: qa.json and src/detail/Detail.tsx. Returns { dir, sha }.
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-step5-')));
  made.push(dir);
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  fs.writeFileSync(path.join(dir, 'qa.json'), '{}\n');
  fs.mkdirSync(path.join(dir, 'src', 'detail'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'detail', 'Detail.tsx'), 'export const a = 1;\n');
  return { dir, sha: commitAll(dir, 'one') };
}

// Runs the CLI in the repo. out is stdout and stderr together, for the 'NOT RUN' and 'R1:' lines.
function cli(repo, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function verdictDir(repo) {
  return path.join(repo.dir, 'qa', SLUG);
}

function writeIn(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// results.json from the brief's example, its head sha set to the repo's real HEAD.
function resultsFor(sha) {
  const results = buildResults(exampleRun());
  results.head.sha = sha;
  return results;
}

// The judge's verdict.md for the example (brief), with the head line set to sha.
function verdictMd(sha) {
  return `# REJECT — feat-x
head: ${sha}
base: ${'b'.repeat(40)}
maps: cccccccccccc
criteria: 2 pass · 0 fail · 0 unverifiable

## Criteria
- [exp:title-renamed] PASS — title-renamed: 1 element(s): 1 right
- [ch:1] PASS — archive is offered: the Archive button appears for an open record

## Expectations
- [unx:desktop/detail__default/1] explained — the spec adds an Archive button to the detail header

## Findings
- Major [tour:desktop/detail__default/1] new: listbox "Status" 200×240 cut off by div.card — files: src/detail/StatusSelect.tsx
- Major [chk:desktop/detail__default/1] contrast: span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1 — files: src/detail/Detail.css
- Major [con:desktop/detail__default/1] console: TypeError: x is undefined — files: src/detail/Detail.tsx
- Minor [scr:desktop/detail__default] the Archive button sits under the fold on a short window

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 2 standing item(s), never gating — qa/standing.md

## Notes
- lived-in: not run in this step
- routes: no route table
- mutants: not run

cost: plan $0.41 · eyes $0.62 · judge $0.18 · runner 0 · total $1.21
`;
}

const CHARTER_MD = `# Charter — feat-x
security: no — the diff touches no auth, route, migration or sensitive path

- [ch:1] archive is offered on an open record — axis: happy path — by: spec
`;

const EYES_MD = `# Eyes — feat-x

## [scr:desktop/detail__default] detail
First look: the title, then the new Archive button. …
Verdict: look again — the Archive button sits under the fold on a short window
`;

// Everything report build reads, valid, under V = qa/feat-x. run.json is {} so the
// judge and verdict keys are the command's own writes.
function writeValidRun(repo, { results = resultsFor(repo.sha), verdict = verdictMd(repo.sha) } = {}) {
  const V = verdictDir(repo);
  writeIn(V, 'results.json', JSON.stringify(results, null, 2));
  writeIn(V, 'verdict.md', verdict);
  writeIn(V, 'eyes.md', EYES_MD);
  writeIn(V, 'charter.md', CHARTER_MD);
  writeIn(V, 'summary.md', '# qa run — feat-x: findings (exit 1)\n');
  writeIn(V, 'run.json', '{}\n');
  return V;
}

// ── eyes prompt / eyes parse ──────────────────────────────────────────────────

describe('STEP 5 CLI: eyes prompt', () => {
  it('with results.eyes empty prints no changed or new screen: no eyes pass, exits 0 and writes nothing', () => {
    const repo = makeRepo();
    const V = verdictDir(repo);
    const results = resultsFor(repo.sha);
    results.eyes = [];
    writeIn(V, 'results.json', JSON.stringify(results, null, 2));
    writeIn(V, 'run.json', '{}\n');

    const r = cli(repo, ['eyes', 'prompt', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /no changed or new screen: no eyes pass/);
    assert.equal(fs.existsSync(path.join(V, 'eyes-prompt.md')), false);
  });

  it('with the example results writes V/eyes-prompt.md and prints its path', () => {
    const repo = makeRepo();
    const V = verdictDir(repo);
    writeIn(V, 'results.json', JSON.stringify(resultsFor(repo.sha), null, 2));
    writeIn(V, 'run.json', '{}\n');

    const r = cli(repo, ['eyes', 'prompt', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /eyes-prompt\.md/);
    const prompt = fs.readFileSync(path.join(V, 'eyes-prompt.md'), 'utf8');
    assert.match(prompt, /^Eyes pass for feat-x\./m);
    assert.match(prompt, /^## Screens to look at \(1\)$/m);
    assert.match(prompt, /^### \[scr:desktop\/detail__default\] detail — changed$/m);
  });

  it('eyes parse with no eyes.md exits 3', () => {
    const repo = makeRepo();
    writeIn(verdictDir(repo), 'results.json', JSON.stringify(resultsFor(repo.sha), null, 2));
    const r = cli(repo, ['eyes', 'parse', '--slug', SLUG]);
    assert.equal(r.status, 3, r.out);
  });
});

// ── report build ──────────────────────────────────────────────────────────────

describe('STEP 5 CLI: report build', () => {
  it('0.2.0: --out <V> --work <run dir> --rebuilt-on <host> builds V\'s report from that run\'s screenshots, with the rebuilt banner', () => {
    const repo = makeRepo();
    const V = writeValidRun(repo);
    const out = path.join(repo.dir, 'elsewhere');
    fs.renameSync(V, out);
    const work = path.join(repo.dir, 'fresh-run');
    for (const side of ['head', 'base']) writeIn(path.join(work, side, 'desktop'), 'detail__default.png', `png-${side}`);
    const r = cli(repo, ['report', 'build', '--slug', SLUG, '--out', out, '--work', work, '--rebuilt-on', 'laptop-1']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), path.join(out, 'report.html'));
    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    assert.match(html, new RegExp(`The screenshots were rebuilt on laptop-1 at \\S+ from head ${repo.sha}\\.`));
    assert.equal(fs.readFileSync(path.join(out, 'shots', 'desktop', 'after', 'detail__default.png'), 'utf8'), 'png-head');
    assert.equal(fs.existsSync(V), false, 'nothing written under qa/');
  });

  it('with no verdict.md exits 3', () => {
    const repo = makeRepo();
    writeIn(verdictDir(repo), 'results.json', JSON.stringify(resultsFor(repo.sha), null, 2));
    const r = cli(repo, ['report', 'build', '--slug', SLUG]);
    assert.equal(r.status, 3, r.out);
  });

  it('--check on a valid verdict prints valid, exits 0 and writes no report.html', () => {
    const repo = makeRepo();
    const V = writeValidRun(repo);
    const r = cli(repo, ['report', 'build', '--slug', SLUG, '--check']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^valid$/m);
    assert.equal(fs.existsSync(path.join(V, 'report.html')), false);
  });

  it('a bad verdict.md prints one R<n>: line per problem and exits 1, writing nothing', () => {
    const repo = makeRepo();
    const V = writeValidRun(repo, { verdict: verdictMd('e'.repeat(40)) });
    const r = cli(repo, ['report', 'build', '--slug', SLUG]);
    assert.equal(r.status, 1, r.out);
    const lines = r.out.split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length > 0, 'no problem lines printed');
    for (const line of lines) assert.match(line, /^R\d+: /, `not a rule line: ${line}`);
    assert.ok(lines.some((line) => line.startsWith('R1: ')), r.out);
    assert.equal(fs.existsSync(path.join(V, 'report.html')), false);
  });

  it('a valid verdict writes report.html and one verdicts entry ({ head, verdict, at }); a second run keeps one entry', () => {
    const repo = makeRepo();
    const V = writeValidRun(repo);

    const first = cli(repo, ['report', 'build', '--slug', SLUG]);
    assert.equal(first.status, 0, first.out);
    assert.match(fs.readFileSync(path.join(V, 'report.html'), 'utf8'), /<html/i);

    const run1 = readJson(path.join(V, 'run.json'));
    assert.equal(run1.verdicts.length, 1);
    assert.deepEqual(Object.keys(run1.verdicts[0]), ['head', 'verdict', 'at']);
    assert.equal(run1.verdicts[0].head, repo.sha);
    assert.equal(run1.verdicts[0].verdict, 'REJECT');
    assert.equal(run1.judge, undefined);

    const second = cli(repo, ['report', 'build', '--slug', SLUG]);
    assert.equal(second.status, 0, second.out);
    assert.equal(readJson(path.join(V, 'run.json')).verdicts.length, 1);
  });

  it('U8: --judge is gone (a fresh judge each round): a usage error', () => {
    const repo = makeRepo();
    writeValidRun(repo);
    const r = cli(repo, ['report', 'build', '--slug', SLUG, '--judge', 'abc']);
    assert.equal(r.status, 64, r.out);
    assert.match(r.out, /--judge is gone/);
  });
});

// ── resolve ───────────────────────────────────────────────────────────────────

describe('STEP 5 CLI: resolve', () => {
  it('--slug s --onto dev in a repo with no remote prints the Target as JSON with base from the flag, exits 0', () => {
    const repo = makeRepo();
    const r = cli(repo, ['resolve', '--slug', 's', '--onto', 'dev']);
    assert.equal(r.status, 0, r.out);
    const target = JSON.parse(r.stdout);
    assert.equal(target.slug, 's');
    assert.deepEqual(target.base, { ref: 'dev', from: 'flag', sha: null });
  });

  it('--onto <the first commit sha> prints base.sha equal to that sha', () => {
    const repo = makeRepo();
    const r = cli(repo, ['resolve', '--slug', 's', '--onto', repo.sha]);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(r.stdout).base.sha, repo.sha);
  });

  it('prints map as the absolute path of qa/map in the repo root (the profile default)', () => {
    const repo = makeRepo();
    const r = cli(repo, ['resolve', '--slug', 's', '--onto', repo.sha]);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(r.stdout).map, path.join(repo.dir, 'qa/map'));
  });

  it('prints seedNames null when the repo has no qa/seed.json', () => {
    const repo = makeRepo();
    const r = cli(repo, ['resolve', '--slug', 's', '--onto', repo.sha]);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(r.stdout).seedNames, null);
  });

  it('prints seedNames as the absolute path of qa/seed.json when that file exists', () => {
    const repo = makeRepo();
    writeIn(path.join(repo.dir, 'qa'), 'seed.json', '{}\n');
    const r = cli(repo, ['resolve', '--slug', 's', '--onto', repo.sha]);
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(r.stdout).seedNames, path.join(repo.dir, 'qa/seed.json'));
  });
});
