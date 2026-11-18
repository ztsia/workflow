// Tests for the STEP 8 CLI block of scripts/qa.mjs (the block's comment is the contract):
// setup questions|detect|write, standing list|set|asks, escapes list|add|close, and the CI summary
// of `run --json` (ciSummary in run.mjs; a real run needs sandboxes, so the JSON shape is tested
// through the helper). Each CLI test spawns `node scripts/qa.mjs …` in its own temp git repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { ciSummary } from '../scripts/lib/run.mjs';
import { QUESTIONS } from '../scripts/lib/setup.mjs';
import { asksMd, readStanding } from '../scripts/lib/standing.mjs';
import { readEscapes, CLOSERS } from '../scripts/lib/escapes.mjs';
import { buildResults } from '../scripts/lib/summary.mjs';
import { draftVerdict } from '../scripts/lib/verdict.mjs';
import { blockedRun, exampleRun, selfRun } from './fixtures/run-example.mjs';
import { exampleRun6 } from './fixtures/run-example6.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const TODAY = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // the local day, as the CLI dates rows
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

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

// A git repo with one commit holding the files given (path -> content). No qa.json unless given.
function makeRepo(files = { 'README.md': 'x\n' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-step8-')));
  made.push(dir);
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commitAll(dir, 'one');
  return { dir };
}

function cli(repo, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// The brief's example qa/standing.md rows, after the template's prose.
const STANDING_HEADER = '| id | screen | kind | finding | first seen | last seen | owner | note |\n|---|---|---|---|---|---|---|---|\n';
const ROW_A = '| st-1a2b3c4d | desktop/candidate-detail__detail | check | contrast: span.muted contrast 4.0:1 (#7a7a7a on #ffffff), needs 4.5:1 | 2026-11-06 feat-x | 2026-11-07 feat-y | ZT | design token |';
const ROW_B = '| st-5e6f7a8b | phone/jobs__list | tour | menu "Columns" 180×240 cut off by the top of the window | 2026-11-06 feat-x | 2026-11-06 feat-x |  |  |';
const STANDING = `# Standing items\n\nprose.\n\n${STANDING_HEADER}${ROW_A}\n${ROW_B}\n`;
const standingRepo = () => makeRepo({ 'qa/standing.md': STANDING });

// ── setup ─────────────────────────────────────────────────────────────────────

describe('step 8 cli: setup questions', () => {
  it("prints the five QUESTIONS as '<n>. <key>: <ask>', exit 0, with no qa.json needed", () => {
    const r = cli(makeRepo(), ['setup', 'questions']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), QUESTIONS.map((q, i) => `${i + 1}. ${q.key}: ${q.ask}`));
  });
});

describe('step 8 cli: setup detect', () => {
  it('prints { adapters, hasProfile } as JSON: a package.json is the node-static adapter, no qa.json is hasProfile false', () => {
    const r = cli(makeRepo({ 'package.json': {} }), ['setup', 'detect']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), { adapters: ['node-static'], hasProfile: false });
  });

  it('a qa.json at the root makes hasProfile true; nothing to detect gives no adapters', () => {
    const r = cli(makeRepo({ 'qa.json': {} }), ['setup', 'detect']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), { adapters: [], hasProfile: true });
  });
});

describe('step 8 cli: setup write', () => {
  const ANSWERS = {
    stack: { adapter: ['custom-stack', 'node-static'], build: 'npm run build' },
    login: { staff: { mode: 'form', path: '/auth', from: 'adapter' } },
    base: 'sandbox',
    viewports: 'desktop+phone',
    sensitive: ['supabase/migrations/**'],
  };
  const withAnswers = (repo, answers = ANSWERS) => {
    const file = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
    fs.writeFileSync(file, JSON.stringify(answers));
    made.push(file);
    return file;
  };

  it("writes qa.json from the answers and the starter qa/ files, printing 'wrote <path>' for each", () => {
    const repo = makeRepo();
    const r = cli(repo, ['setup', 'write', '--answers', withAnswers(repo)]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), ['qa.json', 'qa/map/example.json', 'qa/standing.md', 'qa/escapes.md', 'qa/seed.json'].map((p) => `wrote ${p}`));
    const qa = JSON.parse(read(repo.dir, 'qa.json'));
    assert.equal(qa.map, 'qa/map');
    assert.deepEqual(qa.viewports, { desktop: [1440, 900], phone: [390, 844] });
    assert.deepEqual(qa.sensitive, ['supabase/migrations/**']);
    assert.ok(fs.existsSync(path.join(repo.dir, 'qa', 'standing.md')));
  });

  it("a second run keeps what exists ('kept <path>') and leaves qa.json untouched", () => {
    const repo = makeRepo();
    const answers = withAnswers(repo);
    cli(repo, ['setup', 'write', '--answers', answers]);
    write(repo.dir, 'qa.json', { map: 'qa/map', mine: true });
    const r = cli(repo, ['setup', 'write', '--answers', answers]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), ['qa.json', 'qa/map/example.json', 'qa/standing.md', 'qa/escapes.md', 'qa/seed.json'].map((p) => `kept ${p}`));
    assert.equal(JSON.parse(read(repo.dir, 'qa.json')).mine, true);
  });

  it('--force writes qa.json over the existing one and keeps the other files', () => {
    const repo = makeRepo();
    const answers = withAnswers(repo);
    cli(repo, ['setup', 'write', '--answers', answers]);
    write(repo.dir, 'qa.json', { map: 'qa/map', mine: true });
    const r = cli(repo, ['setup', 'write', '--answers', answers, '--force']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^wrote qa\.json$/m);
    assert.match(r.stdout, /^kept qa\/standing\.md$/m);
    assert.equal(JSON.parse(read(repo.dir, 'qa.json')).mine, undefined);
  });

  it('with no adapter named, the detected adapters fill the stack', () => {
    const repo = makeRepo({ 'package.json': {} });
    const r = cli(repo, ['setup', 'write', '--answers', withAnswers(repo, { ...ANSWERS, stack: { build: 'npm run build' } })]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(read(repo.dir, 'qa.json')).stack.adapter, ['node-static']);
  });

  it('a login env value that is not an env NAME prints the message and exits 1, writing nothing', () => {
    const repo = makeRepo();
    const bad = { ...ANSWERS, login: { staff: { mode: 'form', path: '/auth', user: 'staff@example.com', password: 'HR_PW' } } };
    const r = cli(repo, ['setup', 'write', '--answers', withAnswers(repo, bad)]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /login staff: user must be an env NAME, not a value/);
    assert.equal(fs.existsSync(path.join(repo.dir, 'qa.json')), false);
  });
});

// ── standing ──────────────────────────────────────────────────────────────────

const LINE_A = '- [st-1a2b3c4d] desktop/candidate-detail__detail check: contrast: span.muted contrast 4.0:1 (#7a7a7a on #ffffff), needs 4.5:1 (owner ZT)';
const LINE_B = '- [st-5e6f7a8b] phone/jobs__list tour: menu "Columns" 180×240 cut off by the top of the window';

describe('step 8 cli: standing list', () => {
  it("prints '- [<id>] <screen> <kind>: <finding>[ (owner <o>)]' per row and '<n> of <total>'", () => {
    const r = cli(standingRepo(), ['standing', 'list']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), [LINE_A, LINE_B, '2 of 2']);
  });

  it('--kind picks that kind; the count line keeps the total', () => {
    const r = cli(standingRepo(), ['standing', 'list', '--kind', 'tour']);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), [LINE_B, '1 of 2']);
  });

  it('--unowned picks the rows with no owner; --owner picks an exact owner', () => {
    const repo = standingRepo();
    assert.deepEqual(cli(repo, ['standing', 'list', '--unowned']).stdout.split('\n').filter(Boolean), [LINE_B, '1 of 2']);
    assert.deepEqual(cli(repo, ['standing', 'list', '--owner', 'ZT']).stdout.split('\n').filter(Boolean), [LINE_A, '1 of 2']);
  });

  it('--screen picks by glob on the screen cell', () => {
    const r = cli(standingRepo(), ['standing', 'list', '--screen', 'phone/*']);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), [LINE_B, '1 of 2']);
  });

  it('--json prints the picked rows as readStanding gives them', () => {
    const r = cli(standingRepo(), ['standing', 'list', '--kind', 'check', '--json']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), readStanding(STANDING).filter((x) => x.kind === 'check'));
  });

  it("no qa/standing.md is exit 3 with 'no qa/standing.md'", () => {
    const r = cli(makeRepo(), ['standing', 'list']);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /no qa\/standing\.md/);
  });
});

describe('step 8 cli: standing set', () => {
  it('sets owner and note on the row, writes the file keeping every other byte, and prints the row', () => {
    const repo = standingRepo();
    const r = cli(repo, ['standing', 'set', 'st-5e6f7a8b', '--owner', 'AB', '--note', 'next sprint']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /st-5e6f7a8b/);
    assert.match(r.stdout, /owner AB/);
    const rows = readStanding(read(repo.dir, 'qa/standing.md'));
    assert.deepEqual(rows.map((x) => [x.id, x.owner, x.note]), [['st-1a2b3c4d', 'ZT', 'design token'], ['st-5e6f7a8b', 'AB', 'next sprint']]);
    assert.ok(read(repo.dir, 'qa/standing.md').startsWith('# Standing items\n\nprose.\n'));
  });

  it('an unknown id exits 1 with the message and leaves the file alone', () => {
    const repo = standingRepo();
    const r = cli(repo, ['standing', 'set', 'st-nope', '--owner', 'AB']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no standing item st-nope/);
    assert.equal(read(repo.dir, 'qa/standing.md'), STANDING);
  });
});

describe('step 8 cli: standing asks', () => {
  const rowB = () => readStanding(STANDING)[1];

  it('prints asksMd of those rows on stdout', () => {
    const r = cli(standingRepo(), ['standing', 'asks', 'st-5e6f7a8b']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout, asksMd([rowB()], { date: TODAY() }));
    assert.match(r.stdout, /^- \[st-5e6f7a8b\] Fix on phone\/jobs__list: menu "Columns" 180×240 cut off by the top of the window \(standing since 2026-11-06 feat-x; tour\)$/m);
  });

  it('several ids, comma separated, give one ask each in the given order', () => {
    const r = cli(standingRepo(), ['standing', 'asks', 'st-5e6f7a8b,st-1a2b3c4d']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout, asksMd([rowB(), readStanding(STANDING)[0]], { date: TODAY() }));
  });

  it('--out writes the asks to that file (directories made) and prints its path', () => {
    const repo = standingRepo();
    const out = path.join(repo.dir, 'out', 'deep', 'asks.md');
    const r = cli(repo, ['standing', 'asks', 'st-5e6f7a8b', '--out', out]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), out);
    assert.equal(fs.readFileSync(out, 'utf8'), asksMd([rowB()], { date: TODAY() }));
  });

  it('an unknown id exits 1 and writes no --out file', () => {
    const repo = standingRepo();
    const out = path.join(repo.dir, 'asks.md');
    const r = cli(repo, ['standing', 'asks', 'st-5e6f7a8b,st-nope', '--out', out]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /st-nope/);
    assert.equal(fs.existsSync(out), false);
  });

  it('no qa/standing.md is exit 3', () => {
    assert.equal(cli(makeRepo(), ['standing', 'asks', 'st-5e6f7a8b']).status, 3);
  });
});

// ── escapes ───────────────────────────────────────────────────────────────────

const ADD = ['--what', 'the Save button hides behind the keyboard on phones', '--caught', 'tour at phone width on job-edit', '--ask', 'Is any button hidden behind the on-screen keyboard?'];

describe('step 8 cli: escapes add', () => {
  it('makes qa/escapes.md from the template when missing and prints the id; found defaults to today', () => {
    const repo = makeRepo();
    const r = cli(repo, ['escapes', 'add', ...ADD]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), 'esc-1');
    const text = read(repo.dir, 'qa/escapes.md');
    assert.ok(text.startsWith('# Escapes\n'), 'the template is the start');
    assert.deepEqual(readEscapes(text), [{
      id: 'esc-1', found: TODAY(), what: 'the Save button hides behind the keyboard on phones',
      caught: 'tour at phone width on job-edit', ask: 'Is any button hidden behind the on-screen keyboard?', closedBy: '',
    }]);
  });

  it('a second add is esc-2, and --found is written as given', () => {
    const repo = makeRepo();
    cli(repo, ['escapes', 'add', ...ADD]);
    const r = cli(repo, ['escapes', 'add', ...ADD, '--found', '2026-11-07 PR #240']);
    assert.equal(r.stdout.trim(), 'esc-2');
    assert.equal(readEscapes(read(repo.dir, 'qa/escapes.md'))[1].found, '2026-11-07 PR #240');
  });

  it('a missing --what is exit 1 with the message, and writes nothing', () => {
    const repo = makeRepo();
    const r = cli(repo, ['escapes', 'add', '--caught', 'tour', '--ask', 'Is it cut off?']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /what is required/);
    assert.equal(fs.existsSync(path.join(repo.dir, 'qa', 'escapes.md')), false);
  });
});

describe('step 8 cli: escapes list', () => {
  // esc-1 open, esc-2 closed.
  const repoWithTwo = () => {
    const repo = makeRepo();
    cli(repo, ['escapes', 'add', '--what', 'a menu is cut off', '--caught', 'tour on jobs', '--ask', 'Is a menu cut off?']);
    cli(repo, ['escapes', 'add', '--what', 'the date is wrong', '--caught', 'a check', '--ask', 'Is a date wrong?']);
    const file = path.join(repo.dir, 'qa', 'escapes.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(\| Is a date wrong\? \|)  \|/, '$1 abc1234 fix date |'));
    return repo;
  };

  it("prints '- [<id>] <what> — ask: <ask>' and ' — closed by <c>' for a closed one", () => {
    const r = cli(repoWithTwo(), ['escapes', 'list']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), [
      '- [esc-1] a menu is cut off — ask: Is a menu cut off?',
      '- [esc-2] the date is wrong — ask: Is a date wrong? — closed by abc1234 fix date',
    ]);
  });

  it('--open leaves out the closed ones', () => {
    const r = cli(repoWithTwo(), ['escapes', 'list', '--open']);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), ['- [esc-1] a menu is cut off — ask: Is a menu cut off?']);
  });

  it('no qa/escapes.md is exit 3', () => {
    assert.equal(cli(makeRepo(), ['escapes', 'list']).status, 3);
  });
});

describe('step 8 cli: escapes close', () => {
  const withEscape = (files = {}) => {
    const repo = makeRepo({ 'qa.json': {}, ...files });
    cli(repo, ['escapes', 'add', ...ADD]);
    return repo;
  };
  const closedBy = (repo) => readEscapes(read(repo.dir, 'qa/escapes.md'))[0].closedBy;

  it("a commit that touches qa/map/ closes the row with '<short sha> <subject>' and exits 0", () => {
    const repo = withEscape();
    write(repo.dir, 'qa/map/jobs.json', { screens: [] });
    git(['add', '-A'], repo.dir);
    git(['commit', '-q', '-m', 'map: job-edit at phone width'], repo.dir);
    const sha = git(['rev-parse', 'HEAD'], repo.dir);
    const r = cli(repo, ['escapes', 'close', 'esc-1', '--by', sha]);
    assert.equal(r.status, 0, r.out);
    assert.equal(closedBy(repo), `${git(['rev-parse', '--short', sha], repo.dir)} map: job-edit at phone width`);
  });

  it('a commit that touches only src/ prints why, exits 1 and writes nothing', () => {
    const repo = withEscape();
    write(repo.dir, 'src/App.tsx', 'export const a = 1;\n');
    const sha = commitAll(repo.dir, 'fix the button');
    const before = read(repo.dir, 'qa/escapes.md');
    const r = cli(repo, ['escapes', 'close', 'esc-1', '--by', sha]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /an escape closes only by a map, tour or check change: the commit touches none of /);
    for (const c of CLOSERS) assert.ok(r.out.includes(c), `the why lists ${c}`);
    assert.equal(read(repo.dir, 'qa/escapes.md'), before);
  });

  it("the profile's map directory is the closing one: a commit under it closes, qa/map/ no longer does", () => {
    const repo = withEscape();
    write(repo.dir, 'qa.json', { map: 'maps' });
    write(repo.dir, 'maps/jobs.json', { screens: [] });
    const sha = commitAll(repo.dir, 'maps moved');
    assert.equal(cli(repo, ['escapes', 'close', 'esc-1', '--by', sha]).status, 0);
    assert.ok(closedBy(repo).endsWith('maps moved'));
  });

  it('an unknown commit is usage, exit 64', () => {
    const repo = withEscape();
    const r = cli(repo, ['escapes', 'close', 'esc-1', '--by', 'deadbeef']);
    assert.equal(r.status, 64, r.out);
    assert.equal(closedBy(repo), '');
  });
});

// ── help ──────────────────────────────────────────────────────────────────────

describe('step 8 cli: help', () => {
  it('lists the new commands and flags', () => {
    const r = cli(makeRepo(), ['help']);
    assert.equal(r.status, 0, r.out);
    for (const s of ['--json', '--baseline', 'setup questions', 'setup detect', 'setup write --answers', 'standing list', 'standing set', 'standing asks', 'escapes list', 'escapes add', 'escapes close']) {
      assert.ok(r.stdout.includes(s), `help lacks "${s}"`);
    }
  });
});

// ── run --json: the CI summary ────────────────────────────────────────────────

describe('step 8: ciSummary', () => {
  const V = '/repo/qa/feat-x';
  const resultsOf = (run) => buildResults(run);
  const summaryOf = (run) => {
    const results = resultsOf(run);
    return ciSummary(results, results.mode === 'self' ? null : draftVerdict(results), V);
  };

  it('is { exit, verdict, blockers, majors, summary }: the draft word, finding ids by severity, <V>/summary.md', () => {
    const s = summaryOf(exampleRun());
    assert.deepEqual(s, {
      exit: 0, verdict: 'REJECT', blockers: [],
      majors: ['tour:desktop/detail__default/1', 'chk:desktop/detail__default/1', 'con:desktop/detail__default/1'],
      summary: '/repo/qa/feat-x/summary.md',
    });
    assert.deepEqual(Object.keys(s), ['exit', 'verdict', 'blockers', 'majors', 'summary']);
  });

  it('Majors alone exit 0 in CI; a Blocker exits 1', () => {
    const s = summaryOf(exampleRun6());
    assert.deepEqual(s.blockers, ['rte:1']);
    assert.ok(s.majors.includes('rte:2') && s.majors.includes('mut:rls-check-dropped'));
    assert.equal(s.exit, 1);
    assert.equal(s.verdict, 'REJECT');
  });

  it('a blocked run exits 4 even with a Blocker', () => {
    const results = resultsOf(blockedRun());
    results.routes = exampleRun6().routes;
    const s = ciSummary(results, draftVerdict(results), V);
    assert.equal(s.exit, 4);
  });

  it('a NOT RUN screen exits 3, ahead of a Blocker', () => {
    const run = exampleRun6();
    run.sides.head.viewports[0].notRun = [{ screen: 'list', why: 'no route' }];
    const results = resultsOf(run);
    assert.ok(results.notRun.length > 0);
    assert.equal(ciSummary(results, draftVerdict(results), V).exit, 3);
  });

  it('a self-test has no verdict: verdict null, no blockers or majors', () => {
    const s = summaryOf(selfRun());
    assert.equal(s.verdict, null);
    assert.deepEqual([s.blockers, s.majors], [[], []]);
    assert.equal(s.exit, 0);
  });
});

it('step 8: ciSummary in self mode follows the run exit (a failed capture is not a pass)', async () => {
  const { ciSummary } = await import('../scripts/lib/run.mjs');
  const base = { mode: 'self', blocked: null, notRun: [], identical: true };
  assert.equal(ciSummary({ ...base, exit: 1 }, null, '/v').exit, 1);
  assert.equal(ciSummary({ ...base, exit: 0 }, null, '/v').exit, 0);
});
