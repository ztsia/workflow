// A sandbox = one commit, running: a detached git worktree at a SHA, the project's stack up on
// its own ports, the built app served on a claimed port, seeded. Stack-neutral: every stack step is an
// adapter verb (adapter.mjs). Base and head of a run are two sandboxes, same seed.
//
// Layout
//   worktree:  <dirname(mainRoot)>/.qa-<basename(mainRoot)>-<name>   (outside the repo)
//   registry:  <mainRoot>/qa-artifacts/sandboxes/<name>.json                 (the descriptor; mode 0600)
//   logs:      <mainRoot>/qa-artifacts/sandboxes/<name>.<verb>.log
//   name:      'qa-' + first 10 hex of the SHA  (one sandbox per commit; `up` at a live SHA reuses it)
//   slug:      same as name (passed to adapters as QA_SLUG / {slug})
//
// up({ mainRoot, profile, at, seed = true, serve = true, qaFrom = mainRoot, log = console.error }) -> Promise<descriptor>
//   1. sha = `git rev-parse <at>^{commit}` in mainRoot; unknown ref -> Error('unknown ref <at>').
//   1b. Orphans first: every registered sandbox whose owner process has ended (a run killed mid-verify; never one
//      handed off by the prepare check, whose owner ends by design) or whose dir is gone is downed (reap's rule).
//   1c. (1.0.4) One boot per commit: <registry>/<name>.boot { pid, start } is taken (O_EXCL) before step 2 and removed
//      when up returns or throws. Held by a live process -> 'sandbox <name>: another run (pid <p>) is starting it;
//      waiting', polled until it is gone (then step 2 reuses what it booted) or profile.sandbox.bootWaitMs (default 30
//      min) -> BLOCKED; held by an ended process -> taken over.
//   2. Registry has <name> and its server answers -> return that descriptor with reused: true; this process is added to
//      its users ({ pid, start }; ended ones dropped). othersUsing({ mainRoot, name, self }) -> the owner and users still
//      running, minus self: the run downs a sandbox only when that is empty, so the last run using it takes it down.
//      Registry has <name> but dead -> down() it first, then continue.
//      (1.0.4) The descriptor keeps seededQa, the names seedQaFiles copied at boot; a reuse refreshes each from qaFrom
//      when it differs (refreshQaFiles, 'sandbox <name>: <names> refreshed from <qaFrom> (published since it came up)'),
//      since a seeded copy is never the commit's own.
//   3. Refuse when live sandboxes >= (profile.sandbox?.max ?? 3): Error('<n> sandboxes up (the limit, qa.json sandbox.max,
//      is <max>); qa sandbox down <name>, or raise sandbox.max').
//   4. `git worktree add --detach <dir> <sha>` in mainRoot. Then seedQaFiles({ from: qaFrom, dir }): a project that
//      keeps its QA files untracked has them only as copies in the checkout, so a commit's worktree lacks them; they are copied in from the checkout under test. A commit with its own
//      qa/ and no mutant registry gets the checkout's registry file alone.
//   5. Claim the app port: first port in profile.ports.band [lo, hi] not in ports.reserved, not
//      used by another registry entry, and free by a real bind on 127.0.0.1. None -> Error('no free port in <lo>-<hi>').
//   6. Verbs in this order, each with cwd = dir, vars { port, slug, dir, main: mainRoot }:
//        setup  (install deps)            NOT RUN = warning, continue
//        up     (backend; JSON last line) NOT RUN = warning (a frontend-only app); non-zero = fail
//        seed   (only when seed)          NOT RUN = warning; non-zero = fail
//        build                             NOT RUN = warning; non-zero = fail
//        serve  (detached, log file)       only when serve; NOT RUN = fail ('nothing serves the app')
//      Every verb's output goes to its log file; a step record { verb, code, ms, notRun } per verb.
//      The adapter `up` JSON is kept as descriptor.stack; its env (if any) is NOT written anywhere
//      by this module (adapters write their own env files).
//   7. Health: GET http://127.0.0.1:<port><stack.healthPath> until status < 500, every 1 s, up to
//      stack.healthTimeoutMs. Timeout -> fail with the last 20 lines of the serve log in the message.
//   8. Write the registry file; return the descriptor.
//   Any failure after step 4: run down() on what exists (server, adapter down when up ran, worktree),
//   then throw SandboxError code 'BLOCKED' with message 'BLOCKED ON INFRASTRUCTURE: <verb>: <why>'.
//
// descriptor: { name, slug, dir, mainRoot, at, sha, shaShort, port, appUrl: 'http://127.0.0.1:<port>',
//               stack: object|null, serverPid: number|null, bootedAt: ISO, steps: [{verb, code, ms, notRun}],
//               warnings: string[], reused?: true, seedStartedAt: ISO|null, owner: { pid, start } }
//   owner: the process that ran `up` (procs.mjs owner()); its end makes the sandbox an orphan.
//   seedStartedAt (step 3): the moment the seed verb started; null when seed is off or NOT RUN.
//   capture freezes the browser clock there (decision 10), so time-relative text written from
//   seed rows ("2m ago") reads the same on every capture of every sandbox.
//
// down({ mainRoot, profile, name }) -> Promise<{ name, warnings: string[] }>
//   Refuses a dir that does not start with the .qa- prefix. Kills the server's process group
//   (SIGTERM, 3 s, SIGKILL); runs the `down` verb when step `up` ran (cwd = dir); then kills every process
//   still running inside dir (procs.mjs killUnder: a stack helper or seed server that left the group), one
//   warning naming them, so an adapter that leaks shows; `git worktree
//   remove --force <dir>` then `git worktree prune`; deletes the registry file. Each failure is a
//   warning, never a throw, so down always finishes. Unknown name -> Error('no sandbox <name>').
//
// status({ mainRoot, name }) -> Promise<descriptor & { alive: boolean }>   (alive = health answers)
// list({ mainRoot }) -> descriptor[]   (from the registry, sorted by bootedAt)
// reap({ mainRoot, profile, maxAgeHours = 6, orphansOnly = false }) -> Promise<string[]>   names downed: older
//   than the age (skipped with orphansOnly), whose worktree dir no longer exists, whose owner has ended and that is
//   not handed off and that no running run reuses (users), or (1.0.3) that is handed off at a commit no checkout of the repo is at any more (the sandboxes'
//   own worktrees aside), so no run will claim it.
// nameFor(sha) -> 'qa-' + sha.slice(0, 10)
// handOff({ mainRoot, name, by = 'prepare' }) -> boolean   (rework U5) writes handOff: by into the registry descriptor:
//   a sandbox the prepare check leaves up for the run; `up` returns it as reused (handOff kept) and the run downs it.
//
// class SandboxError extends Error { code }   codes: 'BLOCKED', 'LIMIT', 'NO_PORT', 'UNKNOWN_REF', 'STUB'
//
// 1.0.0 (tests: test/sandbox.test.mjs 'ports.extra'): profile.ports.extra = [offsets] (default []), the ports an app
//   opens beside its own (a mock server at PORT+300). A sandbox on port p holds p and p + every offset; the claim skips
//   a p whose set meets ports.reserved or any registered sandbox's set (its descriptor.ports, else its port + the
//   offsets), and every extra port must also be free by a real bind (checked, then let go at once: the app binds it).
//   The descriptor gains ports: [p, p + offset, …].
//   claimPort(lo, hi, skip, extra = []) — extra is the offsets; skip holds every port already taken.
//
// STUBS (rework, design §6.1 rung 3; tests: test/stubs.test.mjs 'sandbox.up'): up gains stubs = [id] (default []), the
//   qa.json stubs the PR's charter names (stubs.mjs). An id qa.json does not declare -> SandboxError 'STUB' 'stub <id>
//   is not declared in qa.json stubs', before anything starts. Every stack verb of the sandbox (setup, up, seed, build,
//   serve, and down) runs with stubs.mjs resolveStubs(profile, stubs).env on top of its env (each switch, and QA_STUBS
//   = the ids joined by ','; nothing when there is none). The descriptor gains stubs: [ids, sorted]. A live sandbox is
//   reused only when its stubs are the asked ones (sameStubs; an older descriptor without the key has []); else it is
//   taken down ('sandbox <name>: up with stubs [a] but [b] asked; taking it down first') and brought up again.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runVerb } from './adapter.mjs';
import { resolveStubs, sameStubs } from './stubs.mjs';
import { git, gitOne } from './util.mjs';
import { killUnder, owner, ownerAlive } from './procs.mjs';

const PREFIX = '.qa-';
const DOWN_VERB_TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tail = (text, n = 20) => String(text ?? '').trim().split('\n').slice(-n).join('\n');
const message = (error) => (error && error.message) || String(error);

export class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const nameFor = (sha) => 'qa-' + String(sha).slice(0, 10);

// ── paths ─────────────────────────────────────────────────────────────────────

const registryDir = (mainRoot) => path.join(mainRoot, 'qa-artifacts', 'sandboxes');
const registryFile = (mainRoot, name) => path.join(registryDir(mainRoot), `${name}.json`);
const logFileFor = (mainRoot, name, verb) => path.join(registryDir(mainRoot), `${name}.${verb}.log`);
const dirFor = (mainRoot, name) => path.join(path.dirname(mainRoot), `${PREFIX}${path.basename(mainRoot)}-${name}`);
const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

function ensureRegistry(mainRoot) {
  const dir = registryDir(mainRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [path.join(mainRoot, 'qa-artifacts'), dir]) {
    try { fs.chmodSync(d, 0o700); } catch { /* not ours to change */ }
  }
  return dir;
}

function readDescriptor(mainRoot, name) {
  if (!validName(name)) return null;
  try {
    return JSON.parse(fs.readFileSync(registryFile(mainRoot, name), 'utf8'));
  } catch {
    return null;
  }
}

function writeDescriptor(mainRoot, descriptor) {
  const file = registryFile(mainRoot, descriptor.name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function removeRegistry(mainRoot, name, { logs = true } = {}) {
  fs.rmSync(registryFile(mainRoot, name), { force: true });
  if (!logs) return;
  try {
    for (const f of fs.readdirSync(registryDir(mainRoot))) {
      if (f.startsWith(`${name}.`) && f.endsWith('.log')) fs.rmSync(path.join(registryDir(mainRoot), f), { force: true });
    }
  } catch { /* nothing to remove */ }
}

function entries(mainRoot) {
  let files;
  try {
    files = fs.readdirSync(registryDir(mainRoot)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(registryDir(mainRoot), f), 'utf8'));
      if (d && typeof d.name === 'string') out.push(d);
    } catch { /* unreadable entry: not listed */ }
  }
  return out.sort((a, b) => Date.parse(a.bootedAt) - Date.parse(b.bootedAt));
}

// ── ports ─────────────────────────────────────────────────────────────────────

// An `ss` look alone races two sandboxes into one port; bind for real and hold the listener until
// right before the server starts. The listener only reserves the port: a client that connects
// meanwhile (a browser tab still pointed at an old sandbox, a port prober) is dropped at once,
// because server.close() waits for every open connection and an idle one would hold up() forever.
// Exported for the test.
// A port no one listens on, by a real bind that is let go at once.
function freeNow(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export async function claimPort(lo, hi, skip, extra = []) {
  const offsets = [...new Set((extra ?? []).filter((o) => Number.isInteger(o) && o !== 0))];
  for (let port = lo; port <= hi; port++) {
    if (skip.has(port) || offsets.some((o) => skip.has(port + o) || port + o <= 0 || port + o > 65535)) continue;
    let extrasFree = true;
    for (const o of offsets) if (!(await freeNow(port + o))) { extrasFree = false; break; }
    if (!extrasFree) continue;
    const server = net.createServer((socket) => socket.destroy());
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      let closed = false;
      return {
        port,
        release: () => (closed ? Promise.resolve() : new Promise((resolve) => { closed = true; server.close(() => resolve()); })),
      };
    }
  }
  return null;
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function healthy(port, healthPath = '/') {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(2000) });
    res.body?.cancel().catch(() => {});
    return res.status < 500;
  } catch {
    return false;
  }
}

// ── process groups ────────────────────────────────────────────────────────────

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitGroupGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await sleep(100);
  }
  return !groupAlive(pid);
}

// SIGTERM the group, 3 s, then SIGKILL. Resolves true when something was signalled.
async function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (await waitGroupGone(pid, 3000)) return true;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  await waitGroupGone(pid, 2000);
  return true;
}

function assertPlatform() {
  if (process.platform === 'win32') throw new Error('sandbox needs Linux or macOS for now');
}

// ── teardown (down, and the rollback of a failed up) ──────────────────────────

// Every failure is a warning, so this always finishes.
async function teardown({ mainRoot, profile, name, dir, slug, port, serverPid, upRan, keepLogs = false, env = {} }) {
  const warnings = [];
  const warn = (text) => warnings.push(text);

  if (serverPid) {
    try { await killGroup(serverPid); } catch (error) { warn(`server: could not stop process group ${serverPid}: ${message(error)}`); }
  }
  if (port && (await listening(port))) warn(`port ${port} is still listening after the server was stopped`);

  if (upRan) {
    try {
      const r = await runVerb('down', {
        profile, mainRoot, cwd: dir && fs.existsSync(dir) ? dir : mainRoot,
        vars: { port, slug, dir, main: mainRoot }, env, timeoutMs: DOWN_VERB_TIMEOUT_MS,
      });
      if (r.code === 124) warn(`down: stopped after ${DOWN_VERB_TIMEOUT_MS / 1000} s (exit 124); what it had not removed yet is left for the stack's next cleanup: ${tail(`${r.stdout}\n${r.stderr}`, 5)}`);
      else if (r.code !== 0 && !r.notRun) warn(`down: exit ${r.code}: ${tail(`${r.stdout}\n${r.stderr}`, 5)}`);
    } catch (error) {
      warn(`down: ${message(error)}`);
    }
  }

  if (dir && path.basename(dir).startsWith(PREFIX)) {
    try {
      const left = await killUnder(dir);
      if (left.length) warn(`stopped ${left.length} process(es) still running in ${dir}: ${left.map((p) => `${p.pid} ${p.cmd}`).join('; ')}`);
    } catch (error) { warn(`processes: ${message(error)}`); }
    if (fs.existsSync(dir)) {
      if (git(['worktree', 'remove', '--force', dir], { cwd: mainRoot }) === null) {
        warn(`worktree: git worktree remove --force failed for ${dir}; deleting the directory`);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { warn(`worktree: ${message(error)}`); }
      }
    }
    git(['worktree', 'prune'], { cwd: mainRoot });
  } else if (dir) {
    warn(`worktree: refusing ${dir}: not a ${PREFIX}* directory`);
  }

  try { removeRegistry(mainRoot, name, { logs: !keepLogs }); } catch (error) { warn(`registry: ${message(error)}`); }
  return warnings;
}

// ── up ────────────────────────────────────────────────────────────────────────

// qa.json and qa/ from `from` into the sandbox `dir`, each only when the commit does not carry it (a tracked copy
// always wins, whole). One exception: a commit that carries qa/ but no mutant registry (a branch cut before the
// registry existed keeps its old qa/, and the registry is new there) gets the
// registry alone, since the suites name how to run the tests, not what the screens are. The suites file (qa/suites.*,
// rework 2026-11-12) is copied alone the same way. Returns the names copied.
export const QA_ROOTS = Object.freeze(['qa.json', 'qa']);
export const REGISTRY_FILES = Object.freeze(['qa/mutants.json', 'qa/mutants.ts', 'qa/mutants.mjs']);
const SUITES_FILES = Object.freeze(['qa/suites.json', 'qa/suites.ts', 'qa/suites.mjs']);
export function seedQaFiles({ from, dir }) {
  const copied = [];
  if (!from || path.resolve(from) === path.resolve(dir)) return copied;
  for (const name of QA_ROOTS) {
    if (fs.existsSync(path.join(dir, name)) || !fs.existsSync(path.join(from, name))) continue;
    fs.cpSync(path.join(from, name), path.join(dir, name), { recursive: true });
    copied.push(name);
  }
  for (const files of [REGISTRY_FILES, SUITES_FILES]) {
    if (copied.includes('qa') || files.some((f) => fs.existsSync(path.join(dir, f)))) continue;
    const one = files.find((f) => fs.existsSync(path.join(from, f)));
    if (one) {
      fs.mkdirSync(path.join(dir, 'qa'), { recursive: true });
      fs.copyFileSync(path.join(from, one), path.join(dir, one));
      copied.push(one);
    }
  }
  return copied;
}

// ── one boot at a time per commit (1.0.4) ───────────────────────────────────
// The descriptor is written only once the sandbox answers, so a second run at the same commit used to find no entry
// while the first was still booting, take its worktree for a crash's debris and remove it (the first run's `up` then
// found a half-built tree). <registry>/<name>.boot { pid, start } now marks a boot in progress: a
// second `up` waits for it (then reuses the sandbox, or boots it itself when the first failed), and takes over a mark
// whose process has ended.
const bootFile = (mainRoot, name) => path.join(registryDir(mainRoot), `${name}.boot`);
async function bootLock(mainRoot, name, { say, waitMs = 30 * 60_000, pollMs = 2000 } = {}) {
  const file = bootFile(mainRoot, name);
  const me = owner();
  const started = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify(me), { flag: 'wx', mode: 0o600 });
      return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8'))?.pid === me.pid) fs.rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* being written */ }
    if (holder && Number.isInteger(holder.pid) && !ownerAlive(holder)) { fs.rmSync(file, { force: true }); continue; }
    if (Date.now() - started > waitMs) throw new SandboxError('BLOCKED', `BLOCKED ON INFRASTRUCTURE: sandbox ${name}: another run (pid ${holder?.pid ?? '?'}) has been starting it for ${Math.round(waitMs / 60000)} min`);
    if (!told) { say(`sandbox ${name}: another run (pid ${holder?.pid ?? '?'}) is starting it; waiting`); told = true; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// The other live processes using a sandbox: its owner and every run that reused it, minus `self`.
const validOwner = (o) => o && Number.isInteger(o.pid) && o.pid > 1;
export function othersUsing({ mainRoot, name, self = owner() } = {}) {
  const d = readDescriptor(mainRoot, name);
  if (!d) return [];
  return [d.owner, ...(Array.isArray(d.users) ? d.users : [])].filter((o) => validOwner(o) && o.pid !== self?.pid && ownerAlive(o));
}

// The QA files a sandbox was seeded with (seedQaFiles' names) are copies, never the commit's: each that differs from
// `from` now is replaced whole. Returns the names replaced.
const sameTree = (a, b) => {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.isDirectory() !== sb.isDirectory()) return false;
    if (!sa.isDirectory()) return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
    const na = fs.readdirSync(a).sort();
    const nb = fs.readdirSync(b).sort();
    return na.length === nb.length && na.every((n, i) => n === nb[i] && sameTree(path.join(a, n), path.join(b, n)));
  } catch {
    return false;
  }
};
export function refreshQaFiles({ from, dir, names = [] }) {
  const done = [];
  if (!from || path.resolve(from) === path.resolve(dir)) return done;
  for (const n of names) {
    if (typeof n !== 'string' || n.includes('..')) continue;
    const src = path.join(from, n);
    const dst = path.join(dir, n);
    if (!fs.existsSync(src) || sameTree(src, dst)) continue;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
    done.push(n);
  }
  return done;
}

export async function up(opts = {}) {
  assertPlatform();
  const { mainRoot, at } = opts;
  const sha = typeof at === 'string' && at && !at.startsWith('-') ? gitOne(['rev-parse', '--verify', '--quiet', `${at}^{commit}`], { cwd: mainRoot }) : null;
  if (!sha) return upLocked(opts);   // upLocked says 'unknown ref'
  ensureRegistry(mainRoot);
  const say = (text) => { try { (opts.log ?? console.error)(text); } catch { /* a logger must not break up */ } };
  const release = await bootLock(mainRoot, nameFor(sha), { say, waitMs: opts.profile?.sandbox?.bootWaitMs ?? 30 * 60_000 });
  try {
    return await upLocked(opts);
  } finally {
    release();
  }
}

async function upLocked({ mainRoot, profile, at, seed = true, serve = true, qaFrom = mainRoot, log = console.error, stubs = [] } = {}) {
  assertPlatform();
  const say = (text) => { try { log(text); } catch { /* a logger must not break up */ } };
  // The stubs the charter names: refused before anything starts when qa.json does not declare one.
  const stubbed = resolveStubs(profile, stubs ?? []);
  if (stubbed.unknown.length) throw new SandboxError('STUB', `stub ${stubbed.unknown.join(', ')} is not declared in qa.json stubs`);
  const stubEnv = stubbed.env;

  // 1. the commit
  const sha = typeof at === 'string' && at && !at.startsWith('-')
    ? gitOne(['rev-parse', '--verify', '--quiet', `${at}^{commit}`], { cwd: mainRoot })
    : null;
  if (!sha) throw new SandboxError('UNKNOWN_REF', `unknown ref ${at}`);
  const name = nameFor(sha);
  const slug = name;
  const dir = dirFor(mainRoot, name);
  const healthPath = profile?.stack?.healthPath ?? '/';
  const healthTimeoutMs = profile?.stack?.healthTimeoutMs ?? 60_000;

  // 1b. orphans: a run killed mid-verify never downed its sandboxes
  for (const n of await reap({ mainRoot, profile, orphansOnly: true })) say(`sandbox ${n}: its run has ended; taken down`);

  // 2. a live sandbox at this commit is reused; a dead one is replaced
  const existing = readDescriptor(mainRoot, name);
  if (existing) {
    const live = await healthy(existing.port, healthPath);
    if (live && !sameStubs(existing.stubs, stubbed.ids)) {
      say(`sandbox ${name}: up with stubs [${(existing.stubs ?? []).join(', ')}] but [${stubbed.ids.join(', ')}] asked; taking it down first`);
      await down({ mainRoot, profile, name });
    } else if (live) {
      say(`sandbox ${name}: already up on :${existing.port}`);
      // a QA file published since it came up (a new mutant registry) still reaches it; nothing the commit carries is
      // overwritten. 1.0.4: the copies this sandbox was seeded with are not the commit's, so they are refreshed from
      // qaFrom when they differ (CRM 11-13: a suite published after the boot never reached the reused sandbox).
      const ok = existing.dir && fs.existsSync(existing.dir);
      const fresh = ok ? refreshQaFiles({ from: qaFrom, dir: existing.dir, names: existing.seededQa ?? [] }) : [];
      if (fresh.length) say(`sandbox ${name}: ${fresh.join(', ')} refreshed from ${qaFrom} (published since it came up)`);
      const late = ok ? seedQaFiles({ from: qaFrom, dir: existing.dir }) : [];
      if (late.length) say(`sandbox ${name}: ${late.join(', ')} copied from ${qaFrom} (the commit carries none)`);
      if (late.length) existing.seededQa = [...new Set([...(existing.seededQa ?? []), ...late])];
      // Recorded as a user, so the run that started it leaves it up until this one ends (othersUsing).
      const me = owner();
      const users = [...(Array.isArray(existing.users) ? existing.users : []).filter((o) => validOwner(o) && o.pid !== me.pid && ownerAlive(o)), me];
      try { writeDescriptor(mainRoot, { ...existing, users }); } catch { /* a concurrent down */ }
      return { ...existing, users, reused: true };
    } else {
      say(`sandbox ${name}: registered but not answering; taking it down first`);
      await down({ mainRoot, profile, name });
    }
  }

  // 3. the limit
  const max = profile?.sandbox?.max ?? 3;
  const registered = entries(mainRoot);
  if (registered.length >= max) throw new SandboxError('LIMIT', `${registered.length} sandboxes up (the limit, qa.json sandbox.max, is ${max}); qa sandbox down <name>, or raise sandbox.max`);

  ensureRegistry(mainRoot);
  const warnings = [];
  if (git(['check-ignore', '-q', 'qa-artifacts'], { cwd: mainRoot }) === null) warnings.push('add qa-artifacts/ to .gitignore');

  // 4. the worktree (a leftover directory of this name, with no registry entry, is a crash's debris)
  say(`sandbox ${name}: worktree at ${dir}`);
  if (fs.existsSync(dir)) {
    git(['worktree', 'remove', '--force', dir], { cwd: mainRoot });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  git(['worktree', 'prune'], { cwd: mainRoot });
  for (const f of fs.readdirSync(registryDir(mainRoot))) {
    if (f.startsWith(`${name}.`) && f.endsWith('.log')) fs.rmSync(path.join(registryDir(mainRoot), f), { force: true });
  }
  if (git(['worktree', 'add', '--detach', dir, sha], { cwd: mainRoot }) === null) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing there */ }
    git(['worktree', 'prune'], { cwd: mainRoot });
    throw new SandboxError('BLOCKED', 'BLOCKED ON INFRASTRUCTURE: worktree: git worktree add --detach failed');
  }
  const seededQa = seedQaFiles({ from: qaFrom, dir });
  if (seededQa.length) say(`sandbox ${name}: ${seededQa.join(', ')} copied from ${qaFrom} (the commit carries none)`);

  const steps = [];
  let claim = null;
  let port = null;
  let serverPid = null;
  let upRan = false;
  let current = 'worktree';
  const vars = () => ({ port, slug, dir, main: mainRoot });
  const blocked = (verb, why) => new SandboxError('BLOCKED', `BLOCKED ON INFRASTRUCTURE: ${verb}: ${why}`);

  // One non-detached verb: run it, keep its output in <name>.<verb>.log, record the step.
  const runStep = async (verb) => {
    current = verb;
    say(`sandbox ${name}: ${verb}`);
    const logFile = logFileFor(mainRoot, name, verb);
    const r = await runVerb(verb, { profile, mainRoot, cwd: dir, vars: vars(), env: stubEnv });
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    fs.appendFileSync(logFile, `${r.notRun ?? output}${output || r.notRun ? '\n' : ''}`);
    steps.push({ verb, code: r.code ?? null, ms: r.ms ?? 0, notRun: r.notRun ?? null });
    if (r.notRun) {
      return r;
    }
    if (r.code !== 0) throw blocked(verb, `exit ${r.code}: ${tail(output)}`);
    return r;
  };

  try {
    // 5. the port
    current = 'port';
    const [lo, hi] = profile?.ports?.band ?? [];
    const extra = profile?.ports?.extra ?? [];
    const taken = (d) => (Array.isArray(d.ports) && d.ports.length ? d.ports : [d.port, ...extra.map((o) => d.port + o)]);
    const skip = new Set([...(profile?.ports?.reserved ?? []), ...registered.flatMap(taken)]);
    claim = Number.isInteger(lo) && Number.isInteger(hi) ? await claimPort(lo, hi, skip, extra) : null;
    if (!claim) throw new SandboxError('NO_PORT', `no free port in ${lo}-${hi}${extra.length ? ` (with its extra ports +${extra.join(', +')} free too)` : ''}`);
    port = claim.port;

    // 6. the verbs
    let stack = null;
    const setup = await runStep('setup');
    if (setup.notRun) warnings.push(`setup: ${setup.notRun}`);

    const upResult = await (async () => {
      const r = await runStep('up');
      if (r.notRun) warnings.push(`up: ${r.notRun}`);
      else upRan = true;
      return r;
    })().catch((error) => {
      // a failed `up` may have started part of a stack: down must still run it
      if (steps.some((s) => s.verb === 'up' && !s.notRun)) upRan = true;
      throw error;
    });
    stack = upResult.json ?? null;

    let seedStartedAt = null;
    if (seed) {
      const startedAt = new Date().toISOString();
      const r = await runStep('seed');
      if (r.notRun) warnings.push(`seed: ${r.notRun}`);
      else seedStartedAt = startedAt;
    }
    const build = await runStep('build');
    if (build.notRun) warnings.push(`build: ${build.notRun}`);

    const bootedAt = new Date().toISOString();
    await claim.release();
    claim = null;
    if (serve) {
      current = 'serve';
      say(`sandbox ${name}: serve on :${port}`);
      const logFile = logFileFor(mainRoot, name, 'serve');
      fs.appendFileSync(logFile, '');
      const r = await runVerb('serve', { profile, mainRoot, cwd: dir, vars: vars(), env: stubEnv, detached: true, logFile });
      steps.push({ verb: 'serve', code: r.code ?? null, ms: r.ms ?? 0, notRun: r.notRun ?? null });
      if (r.notRun) throw blocked('serve', `nothing serves the app (${r.notRun})`);
      if (!Number.isInteger(r.pid)) throw blocked('serve', 'the serve verb did not start a process');
      serverPid = r.pid;

      // 7. health
      current = 'health';
      const deadline = Date.now() + healthTimeoutMs;
      let ok = await healthy(port, healthPath);
      while (!ok && Date.now() < deadline) {
        await sleep(1000);
        ok = await healthy(port, healthPath);
      }
      if (!ok) {
        let serveLog = '';
        try { serveLog = fs.readFileSync(logFile, 'utf8'); } catch { /* no log */ }
        throw blocked('health', `no answer from http://127.0.0.1:${port}${healthPath} within ${healthTimeoutMs} ms\n${tail(serveLog)}`);
      }
    }

    // 8. the descriptor
    current = 'registry';
    const descriptor = {
      name, slug, dir, mainRoot, at, sha,
      shaShort: gitOne(['rev-parse', '--short', sha], { cwd: mainRoot }) ?? sha.slice(0, 7),
      port, ports: [port, ...(profile?.ports?.extra ?? []).filter((o) => Number.isInteger(o) && o !== 0).map((o) => port + o)], appUrl: `http://127.0.0.1:${port}`,
      stack, serverPid, bootedAt, steps, warnings, seedStartedAt, stubs: stubbed.ids, owner: owner(), seededQa,
    };
    writeDescriptor(mainRoot, descriptor);
    say(`sandbox ${name}: up at ${descriptor.appUrl}`);
    return descriptor;
  } catch (error) {
    if (claim) await claim.release();
    const failure = error instanceof SandboxError ? error : blocked(current, message(error));
    say(`sandbox ${name}: failed (${failure.message.split('\n')[0]}); rolling back`);
    const leftovers = await teardown({ mainRoot, profile, name, dir, slug, port, serverPid, upRan, keepLogs: true, env: stubEnv });
    for (const w of leftovers) say(`sandbox ${name}: rollback: ${w}`);
    throw failure;
  }
}

// ── down ──────────────────────────────────────────────────────────────────────

// The prepare check leaves the head sandbox up for the run (rework U5): the registry descriptor gains handOff: <by>, so
// `up` hands it to the run as reused and the run takes it down (run.mjs). No such sandbox -> false.
export function handOff({ mainRoot, name, by = 'prepare' } = {}) {
  const d = readDescriptor(mainRoot, name);
  if (!d) return false;
  writeDescriptor(mainRoot, { ...d, handOff: by });
  return true;
}

export async function down({ mainRoot, profile, name } = {}) {
  assertPlatform();
  const d = readDescriptor(mainRoot, name);
  if (!d) throw new SandboxError('UNKNOWN_SANDBOX', `no sandbox ${name}`);
  const dir = typeof d.dir === 'string' ? d.dir : dirFor(mainRoot, name);
  const upRan = Array.isArray(d.steps) && d.steps.some((s) => s.verb === 'up' && !s.notRun);
  const warnings = await teardown({
    mainRoot, profile, name, dir, slug: d.slug ?? name, port: d.port, serverPid: d.serverPid, upRan, env: resolveStubs(profile, d.stubs ?? []).env,
  });
  return { name, warnings };
}

// ── status, list, reap ────────────────────────────────────────────────────────

export async function status({ mainRoot, name, profile } = {}) {
  const d = readDescriptor(mainRoot, name);
  if (!d) throw new SandboxError('UNKNOWN_SANDBOX', `no sandbox ${name}`);
  return { ...d, alive: await healthy(d.port, profile?.stack?.healthPath ?? '/') };
}

export function list({ mainRoot } = {}) {
  return entries(mainRoot);
}

// The commits a run could still claim a hand-off for: the HEAD of every checkout of the repo except the sandboxes'
// own worktrees (<dirname(mainRoot)>/.qa-<basename(mainRoot)>-*; a live sandbox in a checkout keeps that
// checkout's HEAD). null when git cannot list them (then no hand-off is reaped).
function checkoutHeads(mainRoot) {
  const lines = git(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
  if (!lines) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const root = real(mainRoot);
  const own = path.join(path.dirname(root), `.qa-${path.basename(root)}-`);
  const heads = new Set();
  let at = null;
  for (const l of lines) {
    if (l.startsWith('worktree ')) at = real(l.slice(9));
    else if (l.startsWith('HEAD ') && at && !at.startsWith(own)) heads.add(l.slice(5));
  }
  return heads;
}

export async function reap({ mainRoot, profile, maxAgeHours = 6, orphansOnly = false } = {}) {
  assertPlatform();
  const reaped = [];
  let heads;
  for (const d of entries(mainRoot)) {
    const old = !orphansOnly && Date.now() - Date.parse(d.bootedAt) > maxAgeHours * 3_600_000;
    // A hand-off outlives its owner by design, but only a run on the same commit claims it: once no checkout is at
    // its commit (the PR moved on), nothing will, and it is taken down (1.0.3).
    if (d.handOff && heads === undefined) heads = checkoutHeads(mainRoot);
    const unclaimable = Boolean(d.handOff && heads && d.sha && !heads.has(d.sha));
    const users = (Array.isArray(d.users) ? d.users : []).filter((o) => validOwner(o) && ownerAlive(o));
    const orphan = unclaimable || (!d.handOff && !ownerAlive(d.owner) && !users.length);
    if (!old && !orphan && fs.existsSync(d.dir)) continue;
    try {
      await down({ mainRoot, profile, name: d.name });
      reaped.push(d.name);
    } catch { /* a concurrent down got there first */ }
  }
  return reaped;
}
