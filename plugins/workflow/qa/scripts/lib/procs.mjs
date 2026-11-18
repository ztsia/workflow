// Processes that live inside a directory, found from /proc (Linux, WSL included). Elsewhere every
// function here finds nothing, so callers fall back to what they did before.
//
// under(dir, { listeningOnly = false }) -> [{ pid, cwd, cmd }]
//   Every process whose working directory, or whose program path (argv[0]), is dir or below it. Never
//   this process or any of its ancestors. listeningOnly keeps the ones holding a listening TCP socket.
// running(pid) -> boolean   signalable and not a zombie.
// killUnder(dir, opts) -> Promise<[{ pid, cmd }]>   SIGTERM each, up to 3 s, then SIGKILL the rest.
// owner() -> { pid, start } | null   this process, with its start time (a reused pid has another).
// ownerAlive(o) -> boolean   o's process is still running (start time compared where /proc has it).
//   A missing or malformed owner counts as alive, so nothing is reaped on a guess.
import fs from 'node:fs';
import path from 'node:path';

const PROC = '/proc';
const hasProc = () => process.platform === 'linux' && fs.existsSync(path.join(PROC, 'self', 'stat'));
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const link = (file) => { try { return fs.readlinkSync(file); } catch { return null; } };

// /proc/<pid>/stat: fields after the ')' that closes the command name; [1] is ppid, [19] the start time.
function statFields(pid) {
  const text = read(path.join(PROC, String(pid), 'stat'));
  if (!text) return null;
  return text.slice(text.lastIndexOf(')') + 2).split(' ');
}

function ancestors() {
  const seen = new Set([process.pid]);
  let pid = process.pid;
  for (let i = 0; i < 64; i++) {
    const ppid = Number(statFields(pid)?.[1]);
    if (!Number.isInteger(ppid) || ppid <= 1 || seen.has(ppid)) break;
    seen.add(ppid);
    pid = ppid;
  }
  return seen;
}

function listeningInodes() {
  const inodes = new Set();
  for (const file of ['tcp', 'tcp6']) {
    const text = read(path.join(PROC, 'net', file));
    if (!text) continue;
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] === '0A' && f[9]) inodes.add(f[9]);
    }
  }
  return inodes;
}

function holdsAny(pid, inodes) {
  let fds;
  try { fds = fs.readdirSync(path.join(PROC, String(pid), 'fd')); } catch { return false; }
  for (const fd of fds) {
    const m = /^socket:\[(\d+)\]$/.exec(link(path.join(PROC, String(pid), 'fd', fd)) ?? '');
    if (m && inodes.has(m[1])) return true;
  }
  return false;
}

const inside = (p, dir) => typeof p === 'string' && (p === dir || p.startsWith(dir + path.sep));

export function under(dir, { listeningOnly = false } = {}) {
  if (!dir || !hasProc()) return [];
  let root;
  try { root = fs.realpathSync(dir); } catch { root = path.resolve(dir); }
  const skip = ancestors();
  const inodes = listeningOnly ? listeningInodes() : null;
  const found = [];
  for (const name of fs.readdirSync(PROC)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    const cwd = link(path.join(PROC, name, 'cwd'));
    const argv = (read(path.join(PROC, name, 'cmdline')) ?? '').split('\0').filter(Boolean);
    if (!inside(cwd, root) && !inside(argv[0], root)) continue;
    if (inodes && !holdsAny(pid, inodes)) continue;
    found.push({ pid, cwd, cmd: argv.join(' ').slice(0, 160) });
  }
  return found;
}

// Running: signalable and not a zombie (a killed child of ours stays signalable until it is reaped).
export function running(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return statFields(pid)?.[0] !== 'Z';
}
const alive = running;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function killUnder(dir, opts = {}) {
  const procs = under(dir, opts);
  for (const p of procs) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + 3000;
  while (procs.some((p) => alive(p.pid)) && Date.now() < deadline) await sleep(100);
  for (const p of procs) if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  return procs.map(({ pid, cmd }) => ({ pid, cmd }));
}

export function owner() {
  const start = statFields(process.pid)?.[19] ?? null;
  return { pid: process.pid, start };
}

export function ownerAlive(o) {
  if (!o || !Number.isInteger(o.pid) || o.pid <= 1) return true;
  if (!alive(o.pid)) return false;
  if (!o.start || !hasProc()) return true;
  return statFields(o.pid)?.[19] === o.start;
}
