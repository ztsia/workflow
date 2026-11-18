// End-to-end contract test for scripts/lib/run.mjs (runQa): the real sandbox module, a real capture in a
// headless browser (captureSide -> capture.mjs -> Playwright), and the real compare. The only fake is the
// stack: a project adapter at qa/adapters/fake whose serve verb runs a tiny node server on $QA_PORT that
// returns the worktree's index.html for every path. The fixture is a temp git repo: commit 1 on 'main'
// (base), commit 2 on 'feat/e2e' (head) changing the heading from "Old title" to "New title".
// The tests share the repo and run in file order (E1 fills the base cache that E2 reuses).
// Until run.mjs is built, E1–E4 fail with 'not built: runQa' and nothing else.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { loadProfile } from '../scripts/lib/profile.mjs';
import { browserSkip } from './fixtures/browser.mjs';
import { loadPlaywright } from '../scripts/lib/playwright.mjs';
import { runQa } from '../scripts/lib/run.mjs';
import { down, list } from '../scripts/lib/sandbox.mjs';

const skip = await browserSkip();
const t = (name, fn) => test(name, { timeout: 180000, skip }, fn);
const BAND = [18440, 18460];
const quiet = () => {};

// Fake project adapter. Every verb is a bash script (cwd = the sandbox worktree, QA_PORT = the claimed port).
const SERVE_JS = "const fs = require('fs'), path = require('path'); require('http').createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(process.env.QA_ROOT || process.cwd(), 'index.html'))); }).listen(Number(process.env.QA_PORT), '127.0.0.1');";
const FAKE = {
  setup: 'echo "skip: nothing to install"',
  up: `echo '{"appUrl":null,"ports":{"db":1}}'`,
  down: 'exit 0',
  seed: 'echo "skip: nothing to seed"',
  build: 'echo "skip: static page, nothing to build"',
  // SERVE_JS has single quotes and no ", $ or backtick, so double quotes keep it whole.
  serve: `exec ${JSON.stringify(process.execPath)} -e "${SERVE_JS}"`,
};
const FAKE_JSON = { type: 'stack', verbs: Object.keys(FAKE), detect: ['index.html'], description: 'e2e fixture: a static page served by node' };

const PAGE = (heading) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture</title></head>
<body><h1>${heading}</h1><p>Body</p></body></html>
`;

function writeExec(file, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function commitAll(cwd, message) {
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

let base;
let repo;
let profile;
let pw;

before(async () => {
  if (skip) return;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-run-e2e-')));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q'], repo);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);

  fs.writeFileSync(path.join(repo, 'qa.json'), JSON.stringify({
    stack: { adapter: ['fake'], healthPath: '/', healthTimeoutMs: 20000 },
    viewports: { desktop: [800, 600] },
    ports: { band: BAND, reserved: [] },
    browser: { channel: 'chromium' },
  }, null, 2) + '\n');
  for (const [verb, body] of Object.entries(FAKE)) writeExec(path.join(repo, 'qa', 'adapters', 'fake', verb), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  writeExec(path.join(repo, 'qa', 'adapters', 'fake', 'adapter.json'), JSON.stringify(FAKE_JSON, null, 2) + '\n', 0o644);
  fs.mkdirSync(path.join(repo, 'qa', 'map'), { recursive: true });
  // home's sources name index.html, which the branch changes: it is affected (rework U4: no known sources = not walked).
  fs.writeFileSync(path.join(repo, 'qa', 'map', 'app.json'), JSON.stringify({ screens: [{ name: 'home', sources: ['index.html'], steps: [{ goto: '/' }] }] }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'index.html'), PAGE('Old title'));
  commitAll(repo, 'base: old title');

  git(['checkout', '-q', '-b', 'feat/e2e'], repo);
  fs.writeFileSync(path.join(repo, 'index.html'), PAGE('New title'));
  commitAll(repo, 'head: new title');

  // Fixture setup must succeed on its own: two commits, the adapter verbs executable, the profile valid.
  assert.equal(git(['rev-list', '--count', 'main'], repo), '1');
  assert.equal(git(['rev-list', '--count', 'HEAD'], repo), '2');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo), 'feat/e2e');
  for (const verb of Object.keys(FAKE)) fs.accessSync(path.join(repo, 'qa', 'adapters', 'fake', verb), fs.constants.X_OK);
  const loaded = loadProfile(repo);
  assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
  profile = loaded.profile;

  // Same loader the tests of capture use; the real browser is launched by captureSide.
  pw = loadPlaywright(repo);
  assert.equal(typeof pw.chromium.launch, 'function');
});

const V = () => path.join(repo, 'qa', 'feat-e2e');
const readSummary = () => fs.readFileSync(path.join(V(), 'summary.md'), 'utf8').split('\n');
const readResults = () => JSON.parse(fs.readFileSync(path.join(V(), 'results.json'), 'utf8'));
const quietRun = (extra = {}) => runQa({ mainRoot: repo, repoRoot: repo, profile, log: quiet, ...extra });

t('E1 a diff run with no cache: findings, exit 1, every output written, base cached, no sandbox left', async () => {
  const run = await quietRun();

  assert.equal(run.exit, 1);
  assert.equal(run.slug, 'feat-e2e');

  const summary = readSummary();
  assert.equal(summary[0], '# qa run — feat-e2e: findings (exit 1)');
  assert.ok(summary.some((line) => line.startsWith('- [scr:desktop/home__default] changed')), summary.join('\n'));

  assert.equal(readResults().version, 1);

  const verdictFirst = fs.readFileSync(path.join(V(), 'verdict.draft.md'), 'utf8').split('\n')[0];
  assert.match(verdictFirst, /^# (REJECT|PENDING)/);

  const cache = path.join(repo, 'qa-artifacts', 'cache', `base-${run.base.sha.slice(0, 10)}-${run.maps.base.slice(0, 12)}`);
  const meta = JSON.parse(fs.readFileSync(path.join(cache, 'meta.json'), 'utf8'));
  // Rework U4: the base cache is kept per screen.
  assert.ok(meta.screens.desktop.home.keys.length > 0, JSON.stringify(meta));

  assert.deepEqual(await list({ mainRoot: repo }), []);
});

t('E2 the same run again reuses the cached base: no base sandbox, exactly one head up', async () => {
  const run = await quietRun();

  assert.equal(run.sandboxes.base.state, 'cached');
  const ups = run.steps.filter((step) => step.verb === 'up');
  assert.equal(ups.length, 1, JSON.stringify(run.steps));
  assert.equal(ups[0].side, 'head');
});

t('E3 an expectation that names the new text and its old text explains the heading change', async () => {
  const expectFile = path.join(base, 'expect.json');
  fs.writeFileSync(expectFile, JSON.stringify([{ name: 'title', screens: 'home', text: 'New title', before: 'Old title' }]));

  const run = await quietRun({ expect: expectFile });

  const pair = run.compare.viewports[0].pairs.find((p) => p.key === 'home__default');
  assert.ok(pair, JSON.stringify(run.compare.viewports[0].pairs.map((p) => p.key)));
  assert.ok(pair.tree.explained.some((line) => String(line).includes('New title')), JSON.stringify(pair.tree.explained));
  assert.ok(pair.tree.explained.some((line) => String(line).includes('Old title')), JSON.stringify(pair.tree.explained));

  const results = readResults();
  assert.equal(results.expectations[0].result, 'met', JSON.stringify(results.expectations));
  assert.deepEqual(results.unexpected, [], JSON.stringify(results.unexpected));
});

t('E4 self-test: the head captured twice is identical, exit 0', async () => {
  const run = await quietRun({ self: true });

  assert.equal(run.mode, 'self');
  assert.equal(run.exit, 0);
  assert.equal(readResults().identical, true);
  assert.equal(readSummary()[0], '# qa self-test — feat-e2e: identical (exit 0)');
});

// Down every sandbox left in the registry (and kill its server), then remove the temp repo.
after(async () => {
  if (!base) return;
  const dir = path.join(repo, 'qa-artifacts', 'sandboxes');
  const names = new Set();
  const killLeftovers = () => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        names.add(entry.name);
        if (entry.serverPid) killGroup(entry.serverPid);
      } catch { /* unreadable entry: nothing to kill */ }
    }
  };
  try {
    for (const d of await list({ mainRoot: repo })) names.add(d.name);
  } catch { /* registry unreadable: fall through to the file scan */ }
  killLeftovers();
  for (const name of names) {
    try { await down({ mainRoot: repo, profile, name }); } catch { /* not up, or already down */ }
  }
  killLeftovers();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});
