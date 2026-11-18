// Contract tests for the eyes cache (rework U8, design 2026-11-12 §9 and §17 answer 6): eyes rulings are cached by the
// screenshot's image hash in qa/<slug>/eyes-cache.json; `qa eyes prompt` lists only the screens whose image
// has no ruling yet, `qa eyes merge` keeps the new rulings and adds the cached ones to eyes.md ('cached from round
// N'), and a waived eyes ruling stays waived while its image is unchanged. Contracts: eyes.mjs 'EYES CACHE' and the CLI's
// 'ROUNDS' block. Neutral fixtures: made-up screens and bytes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { bindEyesWaivers, eyesRound, eyesSections, imageHash, mergeEyes, parseEyes } from '../scripts/lib/eyes.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const sha = (s) => createHash('sha256').update(s).digest('hex');

const target = (id, screen) => ({ id, viewport: 'desktop', key: `${screen}__default`, screen, status: 'changed', ratio: 0.5, tree: null, after: `/w/${screen}.png`, before: null });

describe('eyes cache: pure', () => {
  test('imageHash is the sha256 of the bytes', () => {
    assert.equal(imageHash(Buffer.from('png-a')), sha('png-a'));
  });

  test('eyesSections: each ## [id] section with its body, up to the next heading', () => {
    const md = '# Eyes — x\n\n## [scr:desktop/a__default] a\nFirst look: fine.\nVerdict: fine\n\n## [scr:desktop/b__default] b\nVerdict: wrong — cut off\n';
    assert.deepEqual(eyesSections(md), [
      { id: 'scr:desktop/a__default', heading: '## [scr:desktop/a__default] a', body: 'First look: fine.\nVerdict: fine' },
      { id: 'scr:desktop/b__default', heading: '## [scr:desktop/b__default] b', body: 'Verdict: wrong — cut off' },
    ]);
    assert.deepEqual(eyesSections(null), []);
  });

  test('eyesRound: a target whose image has a ruling is cached, the rest are fresh; ids and current are recorded', () => {
    const cache = { rulings: { [sha('a')]: { id: 'scr:desktop/a__default', screen: 'a', verdict: 'fine', fix: '', body: 'Verdict: fine', round: 1, head: SHA1 } } };
    const hashes = { '/w/a.png': sha('a'), '/w/b.png': sha('b'), '/w/c.png': null };
    const r = eyesRound({ targets: [target('scr:desktop/a__default', 'a'), target('scr:desktop/b__default', 'b'), target('scr:desktop/c__default', 'c')], cache, hashOf: (t) => hashes[t.after], round: 2, head: SHA2 });
    assert.deepEqual(r.fresh.map((t) => t.id), ['scr:desktop/b__default', 'scr:desktop/c__default']);
    assert.deepEqual(r.cached.map((c) => c.target.id), ['scr:desktop/a__default']);
    assert.deepEqual(r.cache.ids, { 'scr:desktop/a__default': sha('a'), 'scr:desktop/b__default': sha('b') });
    assert.deepEqual(r.cache.current, { round: 2, head: SHA2, targets: [
      { id: 'scr:desktop/a__default', screen: 'a', hash: sha('a') }, { id: 'scr:desktop/b__default', screen: 'b', hash: sha('b') }, { id: 'scr:desktop/c__default', screen: 'c', hash: null },
    ] });
    assert.equal(cache.ids, undefined, 'the cache given is not changed');
  });

  test('mergeEyes: keeps each new ruling under its image, and adds each cached one, saying cached from round N', () => {
    const cache = {
      rulings: { [sha('a')]: { id: 'scr:desktop/a__default', screen: 'a', verdict: 'look again', fix: 'tighten', body: 'First look: ok.\nVerdict: look again — tighten', round: 1, head: SHA1, at: 't0' } },
      ids: {}, current: { round: 2, head: SHA2, targets: [{ id: 'scr:desktop/a__default', screen: 'a', hash: sha('a') }, { id: 'scr:desktop/b__default', screen: 'b', hash: sha('b') }] },
    };
    const eyesMd = '# Eyes — feat-x\n\n## [scr:desktop/b__default] b\nFirst look: cut off.\nVerdict: wrong — the total is cut off\n';
    const r = mergeEyes({ slug: 'feat-x', eyesMd, cache, at: 't1' });
    assert.deepEqual(r.added, ['scr:desktop/b__default']);
    assert.deepEqual(r.cached, ['scr:desktop/a__default']);
    assert.deepEqual(r.cache.rulings[sha('b')], { id: 'scr:desktop/b__default', screen: 'b', verdict: 'wrong', fix: 'the total is cut off', body: 'First look: cut off.\nVerdict: wrong — the total is cut off', round: 2, head: SHA2, at: 't1' });
    assert.equal(r.md, [
      '# Eyes — feat-x', '',
      '## [scr:desktop/a__default] a',
      `(cached from round 1, ${SHA1.slice(0, 12)}: the same screenshot, sha256 ${sha('a').slice(0, 12)})`,
      'First look: ok.', 'Verdict: look again — tighten', '',
      '## [scr:desktop/b__default] b',
      'First look: cut off.', 'Verdict: wrong — the total is cut off', '',
    ].join('\n'));
    assert.deepEqual(parseEyes(r.md).map((e) => [e.id, e.verdict]), [['scr:desktop/a__default', 'look again'], ['scr:desktop/b__default', 'wrong']]);
  });

  test('mergeEyes: a section with no verdict is never cached; no eyes.md and every image cached gives the cached sections alone', () => {
    const cache = { rulings: {}, current: { round: 2, head: SHA2, targets: [{ id: 'scr:desktop/b__default', screen: 'b', hash: sha('b') }] } };
    const r = mergeEyes({ slug: 'x', eyesMd: '## [scr:desktop/b__default] b\nno verdict line\n', cache, at: 't' });
    assert.deepEqual(r.cache.rulings, {});
    assert.deepEqual(r.added, []);
    const all = mergeEyes({ slug: 'x', eyesMd: null, cache: { rulings: { [sha('b')]: { id: 'scr:desktop/b__default', screen: 'b', verdict: 'fine', fix: '', body: 'Verdict: fine', round: 1, head: SHA1 } }, current: cache.current }, at: 't' });
    assert.deepEqual(all.cached, ['scr:desktop/b__default']);
    assert.match(all.md, /^## \[scr:desktop\/b__default\] b\n\(cached from round 1, /m);
  });

  test('bindEyesWaivers: a waiver of a screen is bound to its image when first seen, and stays only while the image is the same', () => {
    const line = '- [scr:desktop/a__default] waived: the spacing is on purpose (user, 2026-11-12)';
    const other = '- [ch:2] waived: fine (user, 2026-11-12)';
    const first = bindEyesWaivers(`${line}\n${other}\n`, { ids: { 'scr:desktop/a__default': sha('a') } });
    assert.equal(first.changed, true);
    assert.deepEqual(first.cache.waivers, { [line]: sha('a') });
    assert.equal(first.text, `${line}\n${other}\n`);
    const same = bindEyesWaivers(`${line}\n${other}\n`, { ...first.cache });
    assert.equal(same.changed, false);
    assert.deepEqual(same.stale, []);
    assert.equal(same.text, `${line}\n${other}\n`);
    const moved = bindEyesWaivers(`${line}\n${other}\n`, { ...first.cache, ids: { 'scr:desktop/a__default': sha('a2') } });
    assert.deepEqual(moved.stale, ['scr:desktop/a__default']);
    assert.equal(moved.text, `${other}\n`);
    assert.deepEqual(bindEyesWaivers(`${line}\n`, {}).stale, [], 'an image never hashed: the waiver stands by its id');
    assert.equal(bindEyesWaivers(null, {}).text, null);
  });
});

// ── the CLI: eyes prompt, eyes merge, and the waivers every command reads ─────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-eyescache-')));
  made.push(dir);
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  fs.writeFileSync(path.join(dir, 'qa.json'), '{}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'qa-artifacts/\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'one'], dir);
  return { dir, sha: git(['rev-parse', 'HEAD'], dir) };
}
const cli = (repo, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const screen = (name) => ({ id: `scr:desktop/${name}__default`, viewport: 'desktop', key: `${name}__default`, screen: name, status: 'changed', tree: null, elements: { changed: 0, drift: 0 }, pixel: { ratio: 0.5, worstTile: 0.5, changed: true }, eyes: true, checksRan: null });
function results(sha1, names) {
  return {
    version: 1, mode: 'diff', slug: 'feat-x', exit: 0, head: { sha: sha1, ref: 'HEAD' }, base: { sha: 'b'.repeat(40), ref: 'main', cached: true },
    maps: { head: 'c'.repeat(64), base: 'd'.repeat(64) }, sandboxes: { base: null, head: null }, steps: [], warnings: [], blocked: null, compareError: null, mapErrors: 0,
    failures: [], notRun: [], screens: names.map(screen), expectations: [], unexpected: [],
    tour: { opened: 0, failed: 0, clipped: 0, covered: 0, stuck: 0, hoverAnswered: 0, hoverTotal: 0, new: [], standing: 0 },
    checks: { new: [], standing: 0, fixed: 0 }, console: { new: [], standing: 0 }, eyes: names.map((n) => `scr:desktop/${n}__default`),
    routes: null, mutants: null, tests: [], docs: [], livedIn: null, metrics: null,
    standing: { checks: 0, tour: 0, console: 0, file: null, added: 0 }, identical: null, report: null, compare: null, round: { n: 2 },
  };
}
// Two changed screens with their head shots in the run dir; the round is 2 (V/round.json).
function setup({ cachedA = true } = {}) {
  const repo = makeRepo();
  const V = path.join(repo.dir, 'qa', 'feat-x');
  write(path.join(V, 'results.json'), JSON.stringify(results(repo.sha, ['a', 'b'])));
  write(path.join(V, 'run.json'), '{}\n');
  write(path.join(V, 'round.json'), JSON.stringify({ round: 2, head: repo.sha, of: 'incremental' }));
  const work = path.join(repo.dir, 'qa-artifacts', 'runs', 'feat-x', 'head', 'desktop');
  write(path.join(work, 'a__default.png'), 'png-a');
  write(path.join(work, 'b__default.png'), 'png-b');
  if (cachedA) {
    write(path.join(V, 'eyes-cache.json'), JSON.stringify({ rulings: { [sha('png-a')]: { id: 'scr:desktop/a__default', screen: 'a', verdict: 'fine', fix: '', body: 'First look: clear.\nVerdict: fine', round: 1, head: SHA1, at: 't0' } } }));
  }
  return { repo, V };
}

describe('eyes cache: CLI', () => {
  test('eyes prompt lists only the screen whose image has no ruling, and says how many are cached', () => {
    const { repo, V } = setup();
    const r = cli(repo, ['eyes', 'prompt', '--slug', 'feat-x']);
    assert.equal(r.status, 0, r.out);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], path.join(V, 'eyes-prompt.md'));
    assert.equal(lines[1], 'cached: 1 screen(s) seen before (their rulings are kept); after the eyes pass run qa eyes merge');
    const prompt = fs.readFileSync(path.join(V, 'eyes-prompt.md'), 'utf8');
    assert.match(prompt, /^## Screens to look at \(1\)$/m);
    assert.match(prompt, /^### \[scr:desktop\/b__default\] b — changed$/m);
    assert.ok(!prompt.includes('a__default'));
    const cache = readJson(path.join(V, 'eyes-cache.json'));
    assert.deepEqual(cache.ids, { 'scr:desktop/a__default': sha('png-a'), 'scr:desktop/b__default': sha('png-b') });
    assert.equal(cache.current.round, 2);
  });

  test('eyes prompt with every image cached writes eyes.md from the cache and asks for no eyes pass', () => {
    const { repo, V } = setup();
    const cache = readJson(path.join(V, 'eyes-cache.json'));
    cache.rulings[sha('png-b')] = { id: 'scr:desktop/b__default', screen: 'b', verdict: 'look again', fix: 'crowded', body: 'Verdict: look again — crowded', round: 1, head: SHA1, at: 't0' };
    write(path.join(V, 'eyes-cache.json'), JSON.stringify(cache));
    const r = cli(repo, ['eyes', 'prompt', '--slug', 'feat-x']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), 'no new screenshot: 2 screen(s) seen before; eyes.md written from the cache, no eyes pass');
    assert.equal(fs.existsSync(path.join(V, 'eyes-prompt.md')), false);
    const eyes = fs.readFileSync(path.join(V, 'eyes.md'), 'utf8');
    assert.equal((eyes.match(/\(cached from round 1, /g) ?? []).length, 2);
  });

  test('eyes merge keeps the new ruling under its image and adds the cached one; a second round with the same image needs no look', () => {
    const { repo, V } = setup();
    assert.equal(cli(repo, ['eyes', 'prompt', '--slug', 'feat-x']).status, 0);
    write(path.join(V, 'eyes.md'), '# Eyes — feat-x\n\n## [scr:desktop/b__default] b\nFirst look: the total is cut off.\nVerdict: wrong — the total is cut off\n');
    const r = cli(repo, ['eyes', 'merge', '--slug', 'feat-x']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), 'eyes: 1 new ruling(s) kept, 1 from the cache');
    const eyes = fs.readFileSync(path.join(V, 'eyes.md'), 'utf8');
    assert.match(eyes, /^## \[scr:desktop\/a__default\] a\n\(cached from round 1, 111111111111: the same screenshot, sha256 [0-9a-f]{12}\)\nFirst look: clear\.\nVerdict: fine$/m);
    assert.match(eyes, /^## \[scr:desktop\/b__default\] b\nFirst look: the total is cut off\.$/m);
    const cache = readJson(path.join(V, 'eyes-cache.json'));
    assert.equal(cache.rulings[sha('png-b')].verdict, 'wrong');
    assert.equal(cache.rulings[sha('png-b')].round, 2);
    const again = cli(repo, ['eyes', 'prompt', '--slug', 'feat-x']);
    assert.match(again.stdout, /^no new screenshot: 2 screen\(s\) seen before/);
  });

  test('eyes merge with fresh screens and no eyes.md is NOT RUN', () => {
    const { repo } = setup();
    assert.equal(cli(repo, ['eyes', 'prompt', '--slug', 'feat-x']).status, 0);
    const r = cli(repo, ['eyes', 'merge', '--slug', 'feat-x']);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /NOT RUN: no \S*eyes\.md/);
  });

  test('a waived eyes ruling stays waived while the image is unchanged, and stops when the image changes', () => {
    const { repo, V } = setup();
    assert.equal(cli(repo, ['eyes', 'prompt', '--slug', 'feat-x']).status, 0);
    const line = '- [scr:desktop/b__default] waived: the crop is on purpose (user, 2026-11-12)';
    write(path.join(V, 'waivers.md'), `${line}\n`);
    const draft = () => {
      assert.equal(cli(repo, ['verdict', 'draft', '--slug', 'feat-x']).status !== 64, true);
      return fs.readFileSync(path.join(V, 'verdict.draft.md'), 'utf8');
    };
    assert.match(draft(), /^- waived \[scr:desktop\/b__default\]: the crop is on purpose/m, 'first seen: bound to this image');
    assert.equal(readJson(path.join(V, 'eyes-cache.json')).waivers[line], sha('png-b'));
    assert.match(draft(), /^- waived \[scr:desktop\/b__default\]/m, 'the same image: still waived');
    write(path.join(repo.dir, 'qa-artifacts', 'runs', 'feat-x', 'head', 'desktop', 'b__default.png'), 'png-b2');
    assert.equal(cli(repo, ['eyes', 'prompt', '--slug', 'feat-x']).status, 0);
    assert.ok(!/^- waived \[scr:desktop\/b__default\]/m.test(draft()), 'a new image: the waiver no longer applies');
  });
});
