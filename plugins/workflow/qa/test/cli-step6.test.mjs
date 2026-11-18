// Tests for the STEP 6 CLI block of scripts/qa.mjs (the block's comment is the contract):
// `routes check`, `routes sweep`, `mutants`, `metrics` and the `run` flags --no-routes / --mutants.
// Each test spawns `node scripts/qa.mjs …` in its own temp git repo (one commit, a qa.json of
// `{}`). `routes sweep` runs against a node:http server on 127.0.0.1:0 registered as a sandbox, so
// it uses an async spawn (spawnSync would freeze the server); `mutants` runs against a registered
// sandbox whose tree is a plain temp directory and whose suites are shell commands.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const SLUG = 'feat-x';
const made = [];
const closers = [];

after(async () => {
  for (const close of closers) await close();
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}

// One commit on main: qa.json and a source file. Returns { dir }.
function makeRepo(qa = {}) {
  const dir = tmp('mfqa-step6-');
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  write(dir, 'qa.json', qa);
  write(dir, 'src.txt', 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'one'], dir);
  return { dir };
}

function cli(repo, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function cliAsync(repo, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: repo.dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  });
}

function register(repo, name, dir, port = 1) {
  write(repo.dir, `qa-artifacts/sandboxes/${name}.json`, {
    name, slug: name, dir, port, appUrl: `http://127.0.0.1:${port}`, sha: 'a'.repeat(40), seedStartedAt: '2026-11-06T00:00:00.000Z', stack: null,
  });
}

// ── routes check ──────────────────────────────────────────────────────────────

describe('step 6 cli: routes check', () => {
  it('no table: prints "no route table" and exits 3', () => {
    const repo = makeRepo();
    const r = cli(repo, ['routes', 'check']);
    assert.equal(r.status, 3, r.out);
    assert.match(r.stdout, /no route table/);
  });

  it('a valid table: "<file>: <n> route(s)" and exit 0', () => {
    const repo = makeRepo();
    write(repo.dir, 'qa/routes.table.json', [{ method: 'GET', path: '/api/notes', auth: 'public' }, { method: 'POST', path: '/api/notes', body: { text: 'hi' } }]);
    const r = cli(repo, ['routes', 'check']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^qa\/routes\.table\.json: 2 route\(s\)$/m);
    assert.doesNotMatch(r.stdout, /error:/);
  });

  it('a table with a bad row: one "error: …" line per error, the good rows still counted, exit 1', () => {
    const repo = makeRepo();
    write(repo.dir, 'qa/routes.table.json', [{ method: 'GET', path: '/api/ok' }, { method: 'FETCH', path: '/api/bad' }, { method: 'GET', path: 'no-slash' }]);
    const r = cli(repo, ['routes', 'check']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^qa\/routes\.table\.json: 1 route\(s\)$/m);
    const errors = r.stdout.split('\n').filter((l) => l.startsWith('error: '));
    assert.equal(errors.length, 2, r.stdout);
    assert.match(errors[0], /row 2/);
    assert.match(errors[1], /row 3/);
  });

  it('a table that does not parse is an error and exit 1', () => {
    const repo = makeRepo();
    write(repo.dir, 'qa/routes.table.json', '{ not json');
    const r = cli(repo, ['routes', 'check']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /error: qa\/routes\.table\.json/);
  });

  it('--table points at another file', () => {
    const repo = makeRepo();
    write(repo.dir, 'api/routes.json', { routes: [{ method: 'GET', path: '/a' }] });
    const r = cli(repo, ['routes', 'check', '--table', 'api/routes.json']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^api\/routes\.json: 1 route\(s\)$/m);
  });

  it('profile.routes.table names the table without a flag', () => {
    const repo = makeRepo({ routes: { table: 'api/routes.json' } });
    write(repo.dir, 'api/routes.json', [{ method: 'GET', path: '/a' }, { method: 'GET', path: '/b' }]);
    const r = cli(repo, ['routes', 'check']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^api\/routes\.json: 2 route\(s\)$/m);
  });

  it('a $seed token resolves from the seed names file and one that is not there is an error', () => {
    const repo = makeRepo();
    write(repo.dir, 'qa/seed.json', { note: { id: 'n1' } });
    write(repo.dir, 'qa/routes.table.json', [
      { method: 'GET', path: '/api/notes/:id', params: { id: '$seed.note.id' } },
      { method: 'GET', path: '/api/other/:id', params: { id: '$seed.nope.id' } },
    ]);
    const r = cli(repo, ['routes', 'check']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^qa\/routes\.table\.json: 1 route\(s\)$/m);
    assert.match(r.stdout, /error: GET \/api\/other\/:id: .*\$seed\.nope\.id/);
  });

  it('a routes subcommand it does not know is usage, exit 64', () => {
    assert.equal(cli(makeRepo(), ['routes', 'nope']).status, 64);
    assert.equal(cli(makeRepo(), ['routes']).status, 64);
  });
});

// ── routes sweep ──────────────────────────────────────────────────────────────

describe('step 6 cli: routes sweep', () => {
  async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
    return server.address().port;
  }
  const TABLE = [{ method: 'GET', path: '/api/notes', auth: 'public' }];

  it('without --sandbox it is usage, exit 64; an unknown sandbox is too', () => {
    const repo = makeRepo();
    assert.equal(cli(repo, ['routes', 'sweep']).status, 64);
    assert.equal(cli(repo, ['routes', 'sweep', '--sandbox', 'qa-nope']).status, 64);
  });

  it('a clean sweep: the summary line and exit 0', async () => {
    const port = await serve((req, res) => {
      res.statusCode = req.method === 'GET' && (req.url === '/' || req.url === '/api/notes') ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/api/notes' ? '[{"id":1}]' : '{}');
    });
    const repo = makeRepo();
    write(repo.dir, 'qa/routes.table.json', TABLE);
    register(repo, 'qa-sweep', repo.dir, port);
    const r = await cliAsync(repo, ['routes', 'sweep', '--sandbox', 'qa-sweep']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^\d+ probes · 0 problem\(s\) · 0 unlisted · 0 stale$/m);
  });

  it('a problem is one "<problem> — <route> <kind> (<actor>)" line, counted, and exit 1', async () => {
    const port = await serve((req, res) => {
      // Answers every method with 200: the wrong-method probe (DELETE) must be flagged.
      res.statusCode = req.url === '/' || req.url === '/api/notes' ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end('[{"id":1}]');
    });
    const repo = makeRepo();
    write(repo.dir, 'qa/routes.table.json', TABLE);
    register(repo, 'qa-sweep', repo.dir, port);
    const r = await cliAsync(repo, ['routes', 'sweep', '--sandbox', 'qa-sweep']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^answered 200 to wrong-method — GET \/api\/notes wrong-method \(anon\)$/m);
    assert.match(r.stdout, /^\d+ probes · 1 problem\(s\) · 0 unlisted · 0 stale$/m);
  });

  it('--json prints the SweepSide instead of the lines', async () => {
    const port = await serve((req, res) => { res.statusCode = req.method === 'GET' && (req.url === '/' || req.url === '/api/notes') ? 200 : 404; res.end('[]'); });
    const repo = makeRepo();
    write(repo.dir, 'qa/routes.table.json', TABLE);
    register(repo, 'qa-sweep', repo.dir, port);
    const r = await cliAsync(repo, ['routes', 'sweep', '--sandbox', 'qa-sweep', '--json']);
    const side = JSON.parse(r.stdout);
    assert.equal(side.file, 'qa/routes.table.json');
    assert.equal(side.rows, 1);
    assert.ok(Array.isArray(side.probes) && side.probes.length >= 3);
    assert.equal(side.notRun, null);
    assert.equal(r.status, 0, r.out);
  });

  it('no route table: exit 3', async () => {
    const port = await serve((req, res) => { res.statusCode = 200; res.end('{}'); });
    const repo = makeRepo();
    register(repo, 'qa-sweep', repo.dir, port);
    const r = await cliAsync(repo, ['routes', 'sweep', '--sandbox', 'qa-sweep']);
    assert.equal(r.status, 3, r.out);
  });

  it('a route expectation from --expect is judged on the sweep', async () => {
    const port = await serve((req, res) => { res.statusCode = req.method === 'GET' && (req.url === '/' || req.url === '/api/notes') ? 200 : 404; res.end('[{"id":1}]'); });
    const repo = makeRepo();
    write(repo.dir, 'qa/routes.table.json', TABLE);
    write(repo.dir, 'exp.json', [{ name: 'notes-open', route: 'GET /api/notes', as: 'anon', status: 200 }, { name: 'title', text: 'x' }]);
    register(repo, 'qa-sweep', repo.dir, port);
    const r = await cliAsync(repo, ['routes', 'sweep', '--sandbox', 'qa-sweep', '--json', '--expect', 'exp.json']);
    assert.deepEqual(JSON.parse(r.stdout).expectations.map((e) => [e.name, e.result]), [['notes-open', 'met']]);
  });
});

// ── mutants ───────────────────────────────────────────────────────────────────

describe('step 6 cli: mutants', () => {
  // A sandbox tree with a file the suites read; suite 'holds' fails when the mutant edits it, suite 'blind' never does.
  function tree() {
    const dir = tmp('mfqa-mtree-');
    write(dir, 'guard.txt', 'GUARD ON\nOTHER ON\n');
    write(dir, 'qa/mutants.json', {
      suites: { holds: 'grep -q "GUARD ON" guard.txt', blind: 'true' },
      mutants: [
        { id: 'guard-off', breaks: 'anyone can read the notes', file: 'guard.txt', find: 'GUARD ON', replace: 'GUARD OFF', suite: 'holds' },
        { id: 'other-off', breaks: 'the other guard is gone', file: 'guard.txt', find: 'OTHER ON', replace: 'OTHER OFF', suite: 'blind' },
      ],
    });
    return dir;
  }

  it('without --sandbox it is usage, exit 64 (never runs in the user checkout)', () => {
    const repo = makeRepo();
    write(repo.dir, 'qa/mutants.json', { suites: {}, mutants: [] });
    const r = cli(repo, ['mutants']);
    assert.equal(r.status, 64, r.out);
    assert.match(r.out, /--sandbox/);
  });

  it('--all: a verdict line per mutant, "<k>/<n> killed", a survivor makes exit 1, and the tree is restored', () => {
    const repo = makeRepo();
    const dir = tree();
    register(repo, 'qa-m', dir);
    const r = cli(repo, ['mutants', '--sandbox', 'qa-m', '--all']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^killed guard-off — /m);
    assert.match(r.stdout, /^SURVIVED other-off — /m);
    assert.match(r.stdout, /^1\/2 killed$/m);
    assert.equal(fs.readFileSync(path.join(dir, 'guard.txt'), 'utf8'), 'GUARD ON\nOTHER ON\n');
  });

  it('--only picks mutants by id; all killed is exit 0', () => {
    const repo = makeRepo();
    register(repo, 'qa-m', tree());
    const r = cli(repo, ['mutants', '--sandbox', 'qa-m', '--only', 'guard-off']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^killed guard-off — /m);
    assert.doesNotMatch(r.stdout, /other-off/);
    assert.match(r.stdout, /^1\/1 killed$/m);
  });

  it('a mutant whose text is not in the file is stale: exit 1', () => {
    const repo = makeRepo();
    const dir = tree();
    write(dir, 'guard.txt', 'nothing to find\n');
    register(repo, 'qa-m', dir);
    const r = cli(repo, ['mutants', '--sandbox', 'qa-m', '--only', 'guard-off']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^stale guard-off — /m);
  });

  it('the default is the affected mutants: none changed on this branch means nothing selected, exit 3', () => {
    const repo = makeRepo();
    register(repo, 'qa-m', tree());
    const r = cli(repo, ['mutants', '--sandbox', 'qa-m']);
    assert.equal(r.status, 3, r.out);
  });

  it('the default picks a mutant whose file the branch changed, against the merge-base with main', () => {
    const repo = makeRepo();
    git(['checkout', '-q', '-b', SLUG], repo.dir);
    write(repo.dir, 'guard.txt', 'changed on the branch\n');
    git(['add', '-A'], repo.dir);
    git(['commit', '-q', '-m', 'two'], repo.dir);
    register(repo, 'qa-m', tree());
    const r = cli(repo, ['mutants', '--sandbox', 'qa-m']);
    assert.match(r.stdout, /guard-off/, r.out);
    assert.match(r.stdout, /other-off/);
    assert.equal(r.status, 1, r.out);
  });

  it('--proposals adds the verifier\'s mutants; a proposal is always selected', () => {
    const repo = makeRepo();
    const dir = tree();
    register(repo, 'qa-m', dir);
    const proposals = path.join(tmp('mfqa-prop-'), 'mutants.json');
    write(path.dirname(proposals), 'mutants.json', { mutants: [{ id: 'third-off', breaks: 'a third guard', file: 'guard.txt', find: 'GUARD ON', replace: 'GUARD OFF', suite: 'holds' }] });
    const r = cli(repo, ['mutants', '--sandbox', 'qa-m', '--proposals', proposals]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^killed third-off — /m);
    assert.match(r.stdout, /^1\/1 killed$/m);
  });

  it('--only with an id the registry does not have is usage', () => {
    const repo = makeRepo();
    register(repo, 'qa-m', tree());
    assert.equal(cli(repo, ['mutants', '--sandbox', 'qa-m', '--only', 'nope']).status, 64);
  });
});

// ── metrics ───────────────────────────────────────────────────────────────────

describe('step 6 cli: metrics', () => {
  const FLAG = { id: 'met:desktop/detail__default/screen.readyMs', viewport: 'desktop', key: 'detail__default', metric: 'screen.readyMs', kind: 'over', head: 1800, base: 900, limit: 1000 };
  const results = (metrics) => ({ mode: 'diff', slug: SLUG, head: { ref: 'HEAD', sha: 'a'.repeat(40) }, metrics });

  it('prints the counts line and one line per flag, exit 0', () => {
    const repo = makeRepo();
    write(repo.dir, `qa/${SLUG}/results.json`, results({ captures: 2, msPerCapture: 900, flags: [FLAG], standing: 1 }));
    const r = cli(repo, ['metrics', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], '2 captures · 1 flag(s) · 1 standing');
    assert.equal(lines[1], '- [met:desktop/detail__default/screen.readyMs] screen.readyMs 1800 ms over 1000 ms (base 900 ms)');
    assert.equal(lines.length, 2);
  });

  it('no flags: only the counts line', () => {
    const repo = makeRepo();
    write(repo.dir, `qa/${SLUG}/results.json`, results({ captures: 3, msPerCapture: 100, flags: [], standing: 0 }));
    const r = cli(repo, ['metrics', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), '3 captures · 0 flag(s) · 0 standing');
  });

  it('the slug defaults to the branch name', () => {
    const repo = makeRepo();
    git(['checkout', '-q', '-b', SLUG], repo.dir);
    write(repo.dir, `qa/${SLUG}/results.json`, results({ captures: 1, msPerCapture: 5, flags: [], standing: 0 }));
    const r = cli(repo, ['metrics']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^1 captures · 0 flag\(s\) · 0 standing$/m);
  });

  it('a missing results.json is NOT RUN, exit 3', () => {
    const r = cli(makeRepo(), ['metrics', '--slug', SLUG]);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /NOT RUN/);
  });
});

// ── run flags ─────────────────────────────────────────────────────────────────

describe('step 6 cli: run flags', () => {
  it('--mutants with a value that is not affected, all or none is usage, exit 64, before anything starts', () => {
    const r = cli(makeRepo(), ['run', '--mutants', 'some']);
    assert.equal(r.status, 64, r.out);
    assert.match(r.out, /mutants/);
  });

  it('--mutants with no value is usage, exit 64', () => {
    assert.equal(cli(makeRepo(), ['run', '--mutants']).status, 64);
  });

  it('--no-routes and --mutants none|all|affected are accepted: the run goes on to resolve its refs', () => {
    for (const flags of [['--no-routes'], ['--mutants', 'none'], ['--mutants', 'all'], ['--mutants', 'affected', '--no-routes']]) {
      const r = cli(makeRepo(), ['run', '--base', 'no-such-ref', ...flags]);
      assert.equal(r.status, 64, r.out);
      assert.match(r.out, /unknown ref no-such-ref/, `${flags.join(' ')}: ${r.out}`);
    }
  });

  it('the help text names the new commands and flags', () => {
    const r = cli(makeRepo(), ['help']);
    for (const text of ['routes check', 'routes sweep', 'mutants --sandbox', 'metrics', '--no-routes', '--mutants']) assert.ok(r.stdout.includes(text), `help lacks ${text}`);
  });
});
