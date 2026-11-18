// Contract tests for the upgrade path from qa 0.6 (ready.mjs UPGRADE, standing.mjs FRESH START, the map check's
// SOURCES, `setup suites --write` with no file). What an older qa left in a project — screens with no sources (out of
// every PR's scope under the scope rule), the verifier's sad-path files in the shared map, suites in their old place, a
// standing.md of untriaged one-screen rows — is found by `qa ready`, each with its exact fix; --fix applies only the
// mechanical ones. Small generated repos only.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, describe } from 'node:test';
import { DEFAULTS } from '../scripts/lib/profile.mjs';
import { loadMap, validateMap } from '../scripts/lib/map.mjs';
import { checkReady, readyText, STANDING_BACKLOG, upgradeCheck } from '../scripts/lib/ready.mjs';
import { freshStanding, readStanding, untriagedRows } from '../scripts/lib/standing.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix = 'mfqa-upgrade-') {
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
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const profile = (over = {}) => ({ ...structuredClone(DEFAULTS), ...over });
const itemOf = (check, id) => check.items.find((i) => i.id === id);
const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

const HEADER = '| id | screen | kind | finding | first seen | last seen | owner | note |\n|---|---|---|---|---|---|---|---|\n';
const oneScreenRow = (n, { owner = '', note = '' } = {}) => `| st-${String(n).padStart(8, '0')} | desktop/screen-${n}__list | check | contrast: text ${n} | 2026-11-01 old | 2026-11-02 old | ${owner} | ${note} |\n`;
const FP_ROW = '| st-fpfpfpfp | * | check | contrast on link "Support" in navigation | 2026-11-11 x | 2026-11-11 x |  |  |\n';
function standingText(untriaged, extra = '') {
  let rows = '';
  for (let i = 1; i <= untriaged; i++) rows += oneScreenRow(i);
  return `# Standing items\n\nProse a person wrote.\n\n${HEADER}${rows}${extra}`;
}

// A project the way 0.6 left it: two screens with no sources (one with recorded ones), a sad-path file in the shared map,
// suites in qa/mutants.json, a standing.md of untriaged rows. All on disk, one commit.
function oldProject({ standingRows = STANDING_BACKLOG, sadPath = true, legacySuites = true, sources = false } = {}) {
  const dir = tmpDir();
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(dir, 'src/orders/List.tsx', 'export {};\n');
  write(dir, 'src/home/Home.tsx', 'export {};\n');
  write(dir, 'qa.json', '{}\n');
  write(dir, 'qa/map/app.json', { screens: [
    { name: 'home', steps: [{ goto: '/' }], ...(sources ? { sources: ['src/home/**'] } : {}) },
    { name: 'orders', steps: [{ goto: '/orders' }], ...(sources ? { sources: ['src/orders/*.tsx'] } : {}) },
    { name: 'reports', steps: [{ goto: '/reports' }] },
  ] });
  write(dir, 'qa/map/app.sources.json', { screens: { reports: ['src/reports/View.tsx'] } });
  if (sadPath) {
    write(dir, 'qa/map/verify-old-pr.json', { area: 'verify-old-pr', screens: [{ name: 'orders-as-viewer', origin: 'verify:old-pr', steps: [{ goto: '/orders' }] }] });
  }
  if (legacySuites) write(dir, 'qa/mutants.json', { suites: { unit: 'node --test', e2e: ['npx', 'playwright', 'test'] }, mutants: [] });
  if (standingRows !== null) write(dir, 'qa/standing.md', standingText(standingRows, `${FP_ROW}${oneScreenRow(9001, { owner: 'ana' })}${oneScreenRow(9002, { note: 'known: vendor widget' })}`));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}

describe('standing.mjs FRESH START', () => {
  test('untriagedRows: the one-screen rows with neither an owner nor a note; fingerprint rows never count', () => {
    const rows = readStanding(standingText(3, `${FP_ROW}${oneScreenRow(7, { owner: 'ana' })}${oneScreenRow(8, { note: 'n' })}`));
    assert.deepEqual(untriagedRows(rows).map((r) => r.id), ['st-00000001', 'st-00000002', 'st-00000003']);
  });

  test('freshStanding keeps the prose, the fingerprint rows and every row a person triaged; drops the rest', () => {
    const text = standingText(4, `${FP_ROW}${oneScreenRow(7, { owner: 'ana' })}${oneScreenRow(8, { note: 'n' })}`);
    const fresh = freshStanding(text);
    assert.equal(fresh.dropped, 4);
    assert.equal(fresh.kept, 3);
    assert.deepEqual(readStanding(fresh.text).map((r) => r.id), ['st-fpfpfpfp', 'st-00000007', 'st-00000008']);
    assert.ok(fresh.text.includes(FP_ROW), 'kept rows are kept byte for byte');
    assert.match(fresh.text, /^# Standing items/);
  });
});

describe('upgradeCheck: what an older qa left behind, each with its fix', () => {
  test('screens with no declared or recorded sources are a problem, named with their count; the verifier\'s own are not counted', async () => {
    const dir = oldProject();
    const c = await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile() });
    const it = itemOf(c, 'sources:missing');
    assert.equal(it.status, 'FAIL');
    assert.match(it.reason, /^2 of 3 screen\(s\) have no declared or recorded sources/);
    assert.match(it.reason, /home, orders/);
    assert.doesNotMatch(it.reason, /reports|orders-as-viewer/, 'recorded sources count; a sad path is not a screen to map');
    assert.match(it.fix, /the qa skill --sources/);
    assert.match(it.fix, /qa map check --sources/);
    assert.equal(c.status, 'FAIL');
  });

  test('every screen with sources: one PASS item', async () => {
    const dir = oldProject({ sources: true, sadPath: false, legacySuites: false, standingRows: null });
    const c = await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile() });
    assert.equal(itemOf(c, 'sources:missing'), undefined);
    assert.equal(itemOf(c, 'sources:all').status, 'PASS');
    assert.equal(c.status, 'PASS');
  });

  test('sad-path files in the shared map are a concern, and the fix is an archive once their PR has merged', async () => {
    const dir = oldProject({ sources: true });
    const plain = itemOf(await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile() }), 'sadpaths:shared');
    assert.equal(plain.status, 'CONCERN');
    assert.match(plain.reason, /^1 verifier sad-path file\(s\) in the shared map \(verify-old-pr\.json\)/);
    assert.match(plain.fix, /qa\/archive\/map\//);
  });

  test('suites in the old place are a concern whose fix is qa setup suites --write; --fix moves them', async () => {
    const dir = oldProject({ sources: true });
    const c = await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile() });
    const it = itemOf(c, 'suites:old-place');
    assert.equal(it.status, 'CONCERN');
    assert.match(it.reason, /qa\/mutants\.json/);
    assert.match(it.fix, /qa setup suites --write/);
    const fixed = await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile(), fix: true, today: '2026-11-12' });
    assert.equal(itemOf(fixed, 'suites:old-place').status, 'PASS');
    assert.match(itemOf(fixed, 'suites:old-place').reason, /moved unit, e2e to qa\/suites\.json \(--fix\)/);
    assert.deepEqual(JSON.parse(read(dir, 'qa/suites.json')).suites, { unit: 'node --test', e2e: ['npx', 'playwright', 'test'] });
    assert.equal(itemOf(await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile() }), 'suites:old-place'), undefined, 'gone once moved');
  });

  test(`a standing.md with ${STANDING_BACKLOG} or more untriaged one-screen rows is a concern: start it fresh; fewer is nothing`, async () => {
    const dir = oldProject({ sources: true });
    const it = itemOf(await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile() }), 'standing:backlog');
    assert.equal(it.status, 'CONCERN');
    assert.match(it.reason, new RegExp(`^qa/standing\\.md holds ${STANDING_BACKLOG} one-screen row\\(s\\) with no owner or note`));
    assert.match(it.fix, /start it fresh: archive the file beside it/);
    const small = oldProject({ sources: true, standingRows: STANDING_BACKLOG - 1 });
    assert.equal(itemOf(await upgradeCheck({ repoRoot: small, mainRoot: small, profile: profile() }), 'standing:backlog'), undefined);
  });

  test('--fix archives standing.md beside it and starts a fresh one that keeps the triaged and fingerprint rows', async () => {
    const dir = oldProject({ sources: true });
    const before = read(dir, 'qa/standing.md');
    const c = await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile(), fix: true, today: '2026-11-12' });
    const it = itemOf(c, 'standing:backlog');
    assert.equal(it.status, 'PASS');
    assert.match(it.reason, /archived to qa\/standing\.archived-2026-11-12\.md \(--fix\); 3 triaged or fingerprint row\(s\) kept/);
    assert.equal(read(dir, 'qa/standing.archived-2026-11-12.md'), before);
    assert.deepEqual(readStanding(read(dir, 'qa/standing.md')).map((r) => r.id), ['st-fpfpfpfp', 'st-00009001', 'st-00009002']);
    // A second fix the same day never writes over the first archive.
    write(dir, 'qa/standing.md', before);
    await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile(), fix: true, today: '2026-11-12' });
    assert.ok(fs.existsSync(path.join(dir, 'qa/standing.archived-2026-11-12-2.md')));
  });

  test('--fix never does the mapper\'s work: the sources problem and the sad-path concern stay', async () => {
    const dir = oldProject();
    const c = await upgradeCheck({ repoRoot: dir, mainRoot: dir, profile: profile(), fix: true, today: '2026-11-12' });
    assert.equal(itemOf(c, 'sources:missing').status, 'FAIL');
    assert.equal(itemOf(c, 'sadpaths:shared').status, 'CONCERN');
    assert.ok(fs.existsSync(path.join(dir, 'qa/map/verify-old-pr.json')));
    assert.equal(JSON.parse(read(dir, 'qa/map/app.json')).screens[0].sources, undefined);
  });
});

describe('checkReady and readyText carry the upgrade check', () => {
  test('a problem is open; a concern is listed apart and never makes a project NOT READY by itself', async () => {
    const dir = oldProject();
    const r = await checkReady({ mainRoot: dir, repoRoot: dir, profile: profile(), sandbox: false, log: () => {} });
    const up = r.checks.find((c) => c.id === 'upgrade');
    assert.ok(up, r.checks.map((c) => c.id).join(' '));
    assert.ok(r.open.includes('sources:missing'));
    assert.deepEqual(r.concerns, ['sadpaths:shared', 'suites:old-place', 'standing:backlog']);
    for (const id of r.concerns) assert.ok(!r.open.includes(id), id);
    const text = readyText(r);
    assert.match(text.split('\n')[0], / · 3 concern\(s\)$/);
    assert.match(text, /\n {2}concern sadpaths:shared — 1 verifier sad-path file/);
    assert.match(text, /\n {4}→ start it fresh: archive the file beside it/);
  });

  test('concerns alone: READY stays READY (the line says how many concerns)', () => {
    const report = { ready: true, open: [], concerns: ['suites:old-place'], checks: [{ id: 'upgrade', status: 'CONCERN', summary: '1 concern', items: [{ id: 'suites:old-place', status: 'CONCERN', reason: 'r', fix: 'f' }] }] };
    assert.match(readyText(report), /^READY · 1 concern\(s\)\n/);
  });
});

describe('map check proves sources (the mapper\'s sources phase)', () => {
  test('validateMap with the repo\'s files: a sources glob that matches no file is an error; one that matches is fine', () => {
    const dir = oldProject({ sources: true });
    write(dir, 'qa/map/app.json', { screens: [
      { name: 'home', steps: [{ goto: '/' }], sources: ['src/home/**'] },
      { name: 'orders', steps: [{ goto: '/orders' }], sources: ['src/order/*.tsx'] },
    ] });
    const map = loadMap({ root: dir, profile: profile() });
    const files = ['src/home/Home.tsx', 'src/orders/List.tsx'];
    const { errors } = validateMap(map, profile(), { files });
    assert.deepEqual(errors.filter((e) => /sources/.test(e)), ['app.json orders: sources "src/order/*.tsx" matches no file in the repo']);
    assert.deepEqual(validateMap(map, profile()).errors.filter((e) => /sources/.test(e)), [], 'no file list: globs are not checked');
  });

  test("missingSources 'warn' (plain map check, 1.0.4): a shared screen's glob that matches nothing here is a warning; an overlay or verify: screen's stays an error", () => {
    const dir = oldProject({ sources: true });
    write(dir, 'qa/map/app.json', { screens: [
      { name: 'reasons', steps: [{ goto: '/r' }], sources: ['app/services/repeat_reasons/**'] },
      { name: 'mine', origin: 'verify:x', steps: [{ goto: '/m' }], sources: ['src/mine/**'] },
    ] });
    const map = loadMap({ root: dir, profile: profile() });
    const { errors, warnings } = validateMap(map, profile(), { files: ['src/home/Home.tsx'], missingSources: 'warn' });
    assert.deepEqual(errors.filter((e) => /sources/.test(e)), ['app.json mine: sources "src/mine/**" matches no file in the repo']);
    assert.ok(warnings.some((w) => /^app\.json reasons: sources "app\/services\/repeat_reasons\/\*\*" matches no file on this branch/.test(w)), warnings.join(' | '));
  });

  test('qa map check --sources: every screen with no sources is an error; a sad path is not; all named -> exit 0', () => {
    const dir = oldProject();
    let r = cli(dir, 'map', 'check', '--sources');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /error: app\.json home: no sources: name the files that render it/);
    assert.match(r.stdout, /error: app\.json orders: no sources/);
    assert.doesNotMatch(r.stdout, /reports: no sources|orders-as-viewer: no sources/);
    r = cli(dir, 'map', 'check');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /warning: 2 screen\(s\) have no sources \(out of every PR's scope\): qa map check --sources lists them/);
    write(dir, 'qa/map/app.json', { screens: [
      { name: 'home', steps: [{ goto: '/' }], sources: ['src/home/**'] },
      { name: 'orders', steps: [{ goto: '/orders' }], sources: ['src/orders/*.tsx'] },
      { name: 'reports', steps: [{ goto: '/reports' }] },
    ] });
    r = cli(dir, 'map', 'check', '--sources');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('qa setup suites --write with no file: the move alone', () => {
  test('moves the old SUITES into qa/suites.json and says so', () => {
    const dir = oldProject();
    const r = cli(dir, 'setup', 'suites', '--write');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^wrote qa\/suites\.json: moved from the old place unit, e2e/);
    assert.deepEqual(Object.keys(JSON.parse(read(dir, 'qa/suites.json')).suites), ['unit', 'e2e']);
  });

  test('nothing in the old place: nothing written', () => {
    const dir = oldProject({ legacySuites: false });
    const r = cli(dir, 'setup', 'suites', '--write');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to move: no suites in qa\/mutants\.\*/);
    assert.ok(!fs.existsSync(path.join(dir, 'qa/suites.json')));
  });
});
