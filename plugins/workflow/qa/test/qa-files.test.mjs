// A project that does not commit its QA files (qa.json and qa/ untracked in the checkout). The seams that let a run,
// a sandbox and a rebuilt report work there, and leave a project that commits its QA files exactly as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { mapHash, planAffected } from '../scripts/lib/run.mjs';
import { seedQaFiles } from '../scripts/lib/sandbox.mjs';
import { reportHtml } from '../scripts/lib/report.mjs';

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const MAP = '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n';
const PROFILE = { map: 'qa/map', seedNames: 'qa/seed.json', viewports: { desktop: [1440, 900] } };

// A repo whose commits carry no qa/ at all; the map sits on disk, untracked.
function offBranchRepo() {
  const dir = tmp('mfqa-home-');
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'T'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(['add', '-A'], dir); git(['commit', '-qm', 'one'], dir);
  const base = git(['rev-parse', 'HEAD'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  git(['add', '-A'], dir); git(['commit', '-qm', 'two'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  fs.mkdirSync(path.join(dir, 'qa', 'map'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa', 'map', 'app.json'), MAP);
  return { dir, base, head };
}

test('seedQaFiles: copies qa.json and qa/ the commit lacks; a tracked copy wins whole; the same dir is a no-op', () => {
  const from = tmp('mfqa-from-');
  const dir = tmp('mfqa-sbx-');
  fs.writeFileSync(path.join(from, 'qa.json'), '{}\n');
  fs.mkdirSync(path.join(from, 'qa', 'map'), { recursive: true });
  fs.writeFileSync(path.join(from, 'qa', 'map', 'app.json'), MAP);
  assert.deepEqual(seedQaFiles({ from, dir }), ['qa.json', 'qa']);
  assert.equal(fs.readFileSync(path.join(dir, 'qa', 'map', 'app.json'), 'utf8'), MAP);

  const tracked = tmp('mfqa-sbx-');
  fs.mkdirSync(path.join(tracked, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(tracked, 'qa', 'own.json'), 'x');
  assert.deepEqual(seedQaFiles({ from, dir: tracked }), ['qa.json']);
  assert.equal(fs.existsSync(path.join(tracked, 'qa', 'map')), false, 'the commit\'s own qa/ is never mixed');
  assert.deepEqual(seedQaFiles({ from, dir: from }), []);
});

test('seedQaFiles: a commit with its own qa/ and no mutant registry gets the registry alone, never over its own', () => {
  const from = tmp('mfqa-from-');
  fs.mkdirSync(path.join(from, 'qa', 'map'), { recursive: true });
  fs.writeFileSync(path.join(from, 'qa', 'map', 'app.json'), MAP);
  fs.writeFileSync(path.join(from, 'qa', 'mutants.ts'), 'export const SUITES = {}; export const MUTANTS = [];\n');

  const old = tmp('mfqa-sbx-');
  fs.mkdirSync(path.join(old, 'qa', 'map'), { recursive: true });
  fs.writeFileSync(path.join(old, 'qa', 'map', 'own.json'), 'x');
  assert.deepEqual(seedQaFiles({ from, dir: old }), ['qa/mutants.ts']);
  assert.ok(fs.existsSync(path.join(old, 'qa', 'mutants.ts')));
  assert.equal(fs.existsSync(path.join(old, 'qa', 'map', 'app.json')), false, 'the map is still never mixed');
  assert.deepEqual(seedQaFiles({ from, dir: old }), [], 'a second seed copies nothing');

  const own = tmp('mfqa-sbx-');
  fs.mkdirSync(path.join(own, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(own, 'qa', 'mutants.json'), '{"suites":{},"mutants":[]}');
  assert.deepEqual(seedQaFiles({ from, dir: own }), [], 'a commit\'s own registry wins, in any of its forms');
  assert.equal(fs.existsSync(path.join(own, 'qa', 'mutants.ts')), false);
});

test('mapHash: a commit with no map hashes the checkout\'s map on disk — both sides alike, and a map edit changes it', () => {
  const r = offBranchRepo();
  const h1 = mapHash({ repoRoot: r.dir, sha: r.head, profile: PROFILE });
  assert.equal(mapHash({ repoRoot: r.dir, sha: r.base, profile: PROFILE }), h1, 'base and head walk the same map');
  fs.writeFileSync(path.join(r.dir, 'qa', 'map', 'app.json'), MAP.replace('home', 'start'));
  assert.notEqual(mapHash({ repoRoot: r.dir, sha: r.head, profile: PROFILE }), h1);
});

test('planAffected: neither commit carries a map → the head map is the one on disk, and the base is the same map', async () => {
  const r = offBranchRepo();
  const plan = await planAffected({ repoRoot: r.dir, profile: PROFILE, baseSha: r.base, headSha: r.head });
  assert.ok(plan.head, 'the head map was read from disk');
  assert.deepEqual(plan.head.screens.map((s) => s.name), ['home']);
  assert.ok(plan.affected, 'an affected set, not null');
  assert.deepEqual(plan.changed, ['a.txt']);
});

test('reportHtml: rebuilt → the first thing on the page says where and when the screenshots were rebuilt, and that the judgement is the original', () => {
  const verdictMd = '# ACCEPT — x\nhead: abc1234\nbase: def5678\n';
  const html = reportHtml({ verdictMd, summaryMd: '', results: { screens: [] }, rebuilt: { host: 'laptop-1', at: '2026-11-10T09:00:00Z', head: 'abc1234' } });
  const main = html.slice(html.indexOf('<main>'));
  assert.match(main, /^<main>\n<p class="rebuilt"><strong>Rebuilt report\.<\/strong> The screenshots were rebuilt on laptop-1 at 2026-11-10T09:00:00Z from head abc1234\. The judgement \(verdict, criteria, findings, eyes\) is the original run's, unchanged\.<\/p>/);
  assert.ok(!reportHtml({ verdictMd, summaryMd: '', results: { screens: [] } }).includes('class="rebuilt"'), 'no banner on an ordinary report');
});
