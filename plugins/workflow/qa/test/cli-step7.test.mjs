// Tests for the STEP 7 CLI block of scripts/qa.mjs (the block's comment is the contract):
// `run --full / --record` usage errors, `qa affected`, and `report build` copying videos.
// Each test spawns `node scripts/qa.mjs …` in its own temp git repo.
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
const DETAIL = 'src/features/candidates/Detail.tsx';
const made = [];

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function newRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-step7-')));
  made.push(dir);
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  return dir;
}

// One commit on main: qa.json of {}, the brief's example map (qa/map/candidates.json) and its
// recorded sources (qa/map/candidates.sources.json). Returns { dir, sha }.
function makeRepo() {
  const dir = newRepo();
  write(dir, 'qa.json', {});
  write(dir, DETAIL, 'export const a = 1;\n');
  write(dir, 'src/features/jobs/List.tsx', 'export const b = 1;\n');
  write(dir, 'qa/map/candidates.json', {
    area: 'candidates',
    flows: { 'open:candidates': [{ flow: 'login:staff' }, { goto: '/candidates' }] },
    screens: [
      { name: 'candidates-list', flow: 'open:candidates', steps: [{ capture: 'list' }] },
      { name: 'candidate-detail', flow: 'open:candidates', steps: [{ click: 'role=link[name="Alice"]' }, { capture: 'detail' }] },
      { name: 'jobs-list', steps: [{ goto: '/jobs' }, { capture: 'list' }] },
    ],
  });
  write(dir, 'qa/map/candidates.sources.json', {
    sha: 'a'.repeat(40),
    screens: { 'candidate-detail': [DETAIL], 'jobs-list': ['src/features/jobs/List.tsx'] },
  });
  return { dir, sha: commitAll(dir, 'one') };
}

function cli(repo, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ── run flags ─────────────────────────────────────────────────────────────────

describe('step 7 cli: run flags', () => {
  it('--full with --screens is usage, exit 64, naming both flags', () => {
    const r = cli(makeRepo(), ['run', '--full', '--screens', 'jobs-*']);
    assert.equal(r.status, 64, r.out);
    assert.match(r.out, /pick --full or --screens/);
  });

  it('--record with a value other than journeys, all or none is usage, exit 64', () => {
    const r = cli(makeRepo(), ['run', '--record', 'sometimes']);
    assert.equal(r.status, 64, r.out);
    assert.match(r.out, /record must be journeys, all or none/);
  });

  it('--full and --record journeys|all|none are accepted: the run goes on to resolve its refs', () => {
    for (const flags of [['--full'], ['--record', 'journeys'], ['--record', 'all'], ['--record', 'none'], ['--full', '--record', 'none']]) {
      const r = cli(makeRepo(), ['run', '--base', 'no-such-ref', ...flags]);
      assert.equal(r.status, 64, r.out);
      assert.match(r.out, /unknown ref no-such-ref/, flags.join(' '));
    }
  });
});

// ── affected ──────────────────────────────────────────────────────────────────

describe('step 7 cli: affected', () => {
  // A branch that changes Detail.tsx only.
  function branchWithDetailChange() {
    const repo = makeRepo();
    git(['checkout', '-q', '-b', 'feat/x'], repo.dir);
    write(repo.dir, DETAIL, 'export const a = 2;\n');
    commitAll(repo.dir, 'two');
    return repo;
  }

  it('--json prints the Affected object: names, why, total, mapThese, unknown, skipped', () => {
    const repo = branchWithDetailChange();
    const r = cli(repo, ['affected', '--json']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), {
      names: ['candidate-detail'],
      why: { 'candidate-detail': `source: ${DETAIL}` },
      total: 3, mapThese: ['candidates-list'], unknown: 1, skipped: ['candidates-list', 'jobs-list'], unmapped: [],
    });
  });

  it('prints one "- <screen>: <why>" line per affected screen and the count line, exit 0', () => {
    const repo = branchWithDetailChange();
    const r = cli(repo, ['affected']);
    assert.equal(r.status, 0, r.out);
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.deepEqual(lines, [
      `- candidate-detail: source: ${DETAIL}`,
      '- map these (no known sources, not walked): candidates-list',
      '1 of 3 affected · 1 without known sources',
    ]);
  });

  // A branch that changes a UI file no map entry walks (the RMS pilot's case).
  const COMPOSE = 'src/features/jobs/JobAdComposePage.tsx';
  function branchWithUnmappedChange() {
    const repo = makeRepo();
    git(['checkout', '-q', '-b', 'feat/u'], repo.dir);
    write(repo.dir, COMPOSE, 'export const c = 1;\n');
    commitAll(repo.dir, 'compose');
    return repo;
  }

  it('unmapped: prints "- unmapped: <file>" after the screen lines and a totals suffix counting them, exit 0', () => {
    const r = cli(branchWithUnmappedChange(), ['affected']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), [
      `- unmapped: ${COMPOSE}`,
      '- map these (no known sources, not walked): candidates-list',
      '0 of 3 affected · 1 without known sources · 1 changed UI file(s) no screen walks',
    ]);
  });

  it('unmapped: --json carries unmapped in the Affected object', () => {
    const a = JSON.parse(cli(branchWithUnmappedChange(), ['affected', '--json']).stdout);
    assert.deepEqual(a.unmapped, [COMPOSE]);
  });

  it('unmapped: a branch with no unmapped file prints no unmapped line and no totals suffix', () => {
    const r = cli(branchWithDetailChange(), ['affected']);
    assert.doesNotMatch(r.stdout, /unmapped|no screen walks/);
  });

  it('--base names the base ref: a diff that touches only the jobs source affects jobs-list; the unknown screen is out of scope', () => {
    const repo = makeRepo();
    git(['checkout', '-q', '-b', 'feat/y'], repo.dir);
    write(repo.dir, 'src/features/jobs/List.tsx', 'export const b = 2;\n');
    commitAll(repo.dir, 'jobs');
    const r = cli(repo, ['affected', '--base', 'main', '--json']);
    assert.equal(r.status, 0, r.out);
    const a = JSON.parse(r.stdout);
    assert.deepEqual(a.names, ['jobs-list']);
    assert.equal(a.why['jobs-list'], 'source: src/features/jobs/List.tsx');
    assert.deepEqual(a.skipped, ['candidates-list', 'candidate-detail']);
    assert.deepEqual(a.mapThese, ['candidates-list']);
  });

  it('a new screen on the branch is affected as a new entry', () => {
    const repo = makeRepo();
    git(['checkout', '-q', '-b', 'feat/z'], repo.dir);
    write(repo.dir, 'qa/map/reports.json', { area: 'reports', screens: [{ name: 'reports-list', steps: [{ goto: '/reports' }, { capture: 'list' }] }] });
    commitAll(repo.dir, 'reports');
    const a = JSON.parse(cli(repo, ['affected', '--json']).stdout);
    assert.equal(a.why['reports-list'], 'new entry');
    assert.ok(a.names.includes('reports-list'));
    assert.equal(a.total, 4);
  });
});

// ── report build copies videos ────────────────────────────────────────────────

// The step 5 CLI test's valid verdict, eyes and charter for the example results.
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

describe('step 7 cli: report build with videos', () => {
  function writeRun(repo, videos) {
    const V = path.join(repo.dir, 'qa', SLUG);
    const results = buildResults(exampleRun());
    results.head.sha = repo.sha;
    results.videos = videos;
    write(V, 'results.json', JSON.stringify(results, null, 2));
    write(V, 'verdict.md', verdictMd(repo.sha));
    write(V, 'eyes.md', EYES_MD);
    write(V, 'charter.md', CHARTER_MD);
    write(V, 'summary.md', '# qa run — feat-x: findings (exit 1)\n');
    write(V, 'run.json', '{}\n');
    return V;
  }

  it('copies each results.videos file to V/shots/video/<viewport>/<screen>.webm and shows it in report.html', () => {
    const repo = makeRepo();
    const src = path.join(newRepo(), 'candidate-detail.webm');
    fs.writeFileSync(src, 'webm bytes');
    const V = writeRun(repo, [{ id: 'vid:desktop/candidate-detail', viewport: 'desktop', screen: 'candidate-detail', file: src, checkpoints: [{ state: 'detail', atMs: 4210 }] }]);

    const r = cli(repo, ['report', 'build', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    const copied = path.join(V, 'shots', 'video', 'desktop', 'candidate-detail.webm');
    assert.equal(fs.readFileSync(copied, 'utf8'), 'webm bytes');
    const html = fs.readFileSync(path.join(V, 'report.html'), 'utf8');
    assert.match(html, /<video[^>]*src="shots\/video\/desktop\/candidate-detail\.webm"/);
    assert.match(html, /detail · [^<]* · 4\.2 s/);
  });

  it('a video file that is gone is skipped: the report is still written, with no Journeys section', () => {
    const repo = makeRepo();
    const V = writeRun(repo, [{ id: 'vid:desktop/candidate-detail', viewport: 'desktop', screen: 'candidate-detail', file: path.join(repo.dir, 'gone.webm'), checkpoints: [] }]);
    const r = cli(repo, ['report', 'build', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.join(V, 'shots', 'video', 'desktop', 'candidate-detail.webm')), false);
    assert.doesNotMatch(fs.readFileSync(path.join(V, 'report.html'), 'utf8'), /<h2>Journeys<\/h2>/);
  });
});
