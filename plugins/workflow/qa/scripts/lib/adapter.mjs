// Stack adapters (design decision 25). The engine knows only VERBS; an adapter is a folder of
// executables, any language, one per verb, plus adapter.json. A project names its adapters in
// qa.json `stack.adapter` (a list; the first that has a verb wins), and may give any verb as a
// plain command string in `stack.<verb>`, which wins over every adapter.
//
// Lookup per verb, first hit wins:
//   1. qa.json stack.<verb> (a string: run with `bash -c` in cwd, after {port} {slug} {dir} {main}
//      substitution)
//   2. for each name in stack.adapter, in order:
//        a. <mainRoot>/qa/adapters/<name>/<verb>     (the project's own adapter)
//        b. <plugin>/adapters/<name>/<verb>          (shipped: node-static, supabase-api)
//   3. none -> NOT RUN: `no adapter for <verb> (<names>)`. NOT RUN is never a pass.
//
// adapter.json: { "type": "stack", "verbs": ["setup", ...], "detect": ["vite.config.ts", ...],
//                 "description": "one line" }. `verbs` must list exactly the executables present.
//
// Every executable runs with cwd = opts.cwd and this env on top of process.env:
//   QA_ROOT      the tree it acts on (a sandbox worktree, or the checkout)
//   QA_MAIN_ROOT the main checkout (owns qa-artifacts/)
//   QA_SLUG      the sandbox slug ('' outside a sandbox)
//   QA_PORT      the app port claimed for this tree ('' when none)
//   QA_SETTINGS  JSON of qa.json stack.settings
//   QA_PROFILE   absolute path of qa.json
// Output rule: a verb that reports state (up, status) prints ONE JSON object as its LAST stdout
// line: { appUrl?, ports?, env?, dbUrl? }. Exit 0 = done; non-zero = failed (the caller decides
// whether that is BLOCKED ON INFRASTRUCTURE). An adapter that cannot run prints `skip: <why>` and
// exits 0 (e.g. `setup` with nothing to install).
//
// CONTRACT (tests: test/adapter.test.mjs)
//
//   VERBS = ['setup', 'up', 'down', 'status', 'build', 'serve', 'seed', 'reset', 'test', 'logins', 'query',
//            'routes', 'headers']
//     STEP 6: routes = the routes the app registers, last stdout line a JSON array [{ method, path }];
//     headers <role|anon> = the request headers that act as that role, last line { headers, baseUrl? }
//     (env QA_USER / QA_PASSWORD for a role, QA_STACK = JSON of the sandbox's `up` output).
//   PLUGIN_ADAPTERS = <plugin>/adapters
//
//   resolveVerb(verb, { profile, mainRoot, pluginAdapters = PLUGIN_ADAPTERS })
//     -> { kind: 'command', command: string, source: 'qa.json' }
//      | { kind: 'exec', file: string, adapter: string, source: 'project' | 'plugin' }
//      | { kind: 'none', reason: 'no adapter for <verb> (<names or "none named">)' }
//     Throws Error('unknown verb <verb>') for a verb not in VERBS.
//
//   runVerb(verb, { profile, mainRoot, cwd, args = [], vars = {}, env = {}, detached = false,
//                  logFile = null, timeoutMs = 0, pluginAdapters })
//     -> Promise<{ code: number|null, stdout: string, stderr: string, json: object|null,
//                  notRun: string|null, ms: number, pid?: number }>
//     vars: { port, slug, dir, main } fill both {placeholders} in command strings and QA_* env.
//     args: appended as argv to an executable; appended shell-quoted to a command string.
//     QA_ROOT = vars.dir.
//     kind 'none' -> resolves { code: null, notRun: 'NOT RUN: no adapter for …', json: null }.
//     json = the last stdout line parsed as JSON when it parses as an object or (STEP 6, the routes
//     verb) an array, else null.
//     detached: spawn in its own process group (detached: true), stdout+stderr appended to
//     logFile, unref'd; resolves at once with { code: null, pid } (the caller health-waits).
//     timeoutMs > 0: kill the process group on expiry, resolve with code 124.
//
//   listAdapters({ mainRoot, pluginAdapters }) -> [{ name, source, dir, verbs, detect, description }]
//     project adapters first, then plugin ones; a project adapter shadows a plugin one of the same name.
//
//   detectAdapters({ root, mainRoot, pluginAdapters }) -> string[]
//     names whose adapter.json `detect` lists a file that exists under root (any one is enough),
//     in listAdapters order. Used by `qa profile` to suggest `stack.adapter`.
//
//   validateAdapter(dir) -> string[]  problems: missing adapter.json, verb listed without an
//     executable, executable not listed, executable bit missing, unknown verb.
//
// Example: qa.json { "stack": { "adapter": ["supabase-api", "node-static"], "build": "npm run build" } }
//   resolveVerb('headers') -> exec  <plugin>/adapters/supabase-api/headers   (supabase-api has it)
//   resolveVerb('build')   -> command 'npm run build'                        (qa.json wins)
//   resolveVerb('serve')   -> exec  <plugin>/adapters/node-static/serve      (supabase-api lacks it)
//   with { "adapter": [] }: resolveVerb('up') -> none 'no adapter for up (none named)'

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERBS = Object.freeze(['setup', 'up', 'down', 'status', 'build', 'serve', 'seed', 'reset', 'test', 'logins', 'query', 'routes', 'headers']);
export const PLUGIN_ADAPTERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'adapters');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLACEHOLDER = /\{(port|slug|dir|main)\}/g;
const META_FILES = new Set(['adapter.json', 'README.md']);

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};
const isExecutable = (p) => {
  try { return (fs.statSync(p).mode & 0o111) !== 0; } catch { return false; }
};
const projectAdaptersDir = (mainRoot) => path.join(mainRoot, 'qa', 'adapters');
const adapterNames = (profile) => [].concat(profile?.stack?.adapter ?? []);
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function resolveVerb(verb, opts = {}) {
  if (!VERBS.includes(verb)) throw new Error(`unknown verb ${verb}`);
  const { profile, mainRoot, pluginAdapters = PLUGIN_ADAPTERS } = opts;
  const override = profile?.stack?.[verb];
  if (typeof override === 'string' && override.trim()) return { kind: 'command', command: override, source: 'qa.json' };
  const names = adapterNames(profile);
  for (const name of names) {
    if (!SAFE_NAME.test(name)) continue;
    const candidates = [
      { source: 'project', file: mainRoot ? path.join(projectAdaptersDir(mainRoot), name, verb) : null },
      { source: 'plugin', file: path.join(pluginAdapters, name, verb) },
    ];
    for (const c of candidates) {
      if (c.file && isFile(c.file)) return { kind: 'exec', file: c.file, adapter: name, source: c.source };
    }
  }
  return { kind: 'none', reason: `no adapter for ${verb} (${names.length ? names.join(', ') : 'none named'})` };
}

// Last stdout line as a JSON object, or null.
function parseLastJson(stdout) {
  const last = stdout.trimEnd().split('\n').pop() ?? '';
  try {
    const value = JSON.parse(last);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

// Spawns one run. A detached run (or any run with a timeout) gets its own process group, so the
// timeout can kill the whole tree; a plain run stays in the caller's group.
function launch(file, argv, { cwd, env, detached, logFile, timeoutMs, started }) {
  const ownGroup = detached || timeoutMs > 0;
  if (detached) {
    const out = logFile ? fs.openSync(logFile, 'a') : 'ignore';
    return new Promise((resolve, reject) => {
      const child = spawn(file, argv, { cwd, env, detached: true, stdio: ['ignore', out, out] });
      if (typeof out === 'number') fs.closeSync(out);
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve({ code: null, stdout: '', stderr: '', json: null, notRun: null, ms: Date.now() - started, pid: child.pid });
      });
    });
  }
  return new Promise((resolve) => {
    const child = spawn(file, argv, { cwd, env, detached: ownGroup, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra, json: parseLastJson(stdout), notRun: null, ms: Date.now() - started });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error.code === 'ENOENT' ? 127 : 126, `${error.message}\n`));
    child.on('close', (code) => finish(timedOut ? 124 : code));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, timeoutMs);
    }
  });
}

export async function runVerb(verb, opts = {}) {
  const { profile, mainRoot, cwd, args = [], vars = {}, env = {}, detached = false, logFile = null, timeoutMs = 0, pluginAdapters = PLUGIN_ADAPTERS } = opts;
  const started = Date.now();
  const r = resolveVerb(verb, { profile, mainRoot, pluginAdapters });
  if (r.kind === 'none') {
    return { code: null, stdout: '', stderr: '', json: null, notRun: `NOT RUN: ${r.reason}`, ms: Date.now() - started };
  }
  const qaEnv = {
    QA_ROOT: String(vars.dir ?? cwd ?? ''),
    QA_MAIN_ROOT: String(vars.main ?? mainRoot ?? ''),
    QA_SLUG: String(vars.slug ?? ''),
    QA_PORT: vars.port == null ? '' : String(vars.port),
    QA_SETTINGS: JSON.stringify(profile?.stack?.settings ?? {}),
    QA_PROFILE: mainRoot ? path.join(mainRoot, 'qa.json') : '',
  };
  const childEnv = { ...process.env, ...qaEnv, ...env };
  const fill = (s) => s.replace(PLACEHOLDER, (_, key) => String(vars[key] ?? ''));
  let file;
  let argv;
  if (r.kind === 'command') {
    const line = fill(r.command);
    file = 'bash';
    argv = ['-c', args.length ? `${line} ${args.map(shellQuote).join(' ')}` : line];
  } else {
    file = r.file;
    argv = args.map(String);
  }
  return launch(file, argv, { cwd, env: childEnv, detached, logFile, timeoutMs, started });
}

export function listAdapters({ mainRoot, pluginAdapters = PLUGIN_ADAPTERS } = {}) {
  const roots = [];
  if (mainRoot) roots.push(['project', projectAdaptersDir(mainRoot)]);
  roots.push(['plugin', pluginAdapters]);
  const seen = new Set();
  const rows = [];
  for (const [source, root] of roots) {
    if (!isDir(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      const dir = path.join(root, name);
      if (seen.has(name) || !SAFE_NAME.test(name) || !isDir(dir)) continue;
      seen.add(name); // a project adapter shadows a plugin one of the same name, even when it is broken
      const manifest = readManifest(dir);
      if (manifest) rows.push({ name, source, dir, ...manifest });
    }
  }
  return rows;
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'adapter.json'), 'utf8'));
    return {
      verbs: Array.isArray(m.verbs) ? m.verbs : [],
      detect: Array.isArray(m.detect) ? m.detect : [],
      description: typeof m.description === 'string' ? m.description : '',
    };
  } catch {
    return null;
  }
}

export function detectAdapters({ root, mainRoot, pluginAdapters = PLUGIN_ADAPTERS } = {}) {
  return listAdapters({ mainRoot, pluginAdapters })
    .filter((a) => a.detect.some((rel) => fs.existsSync(path.join(root, rel))))
    .map((a) => a.name);
}

export function validateAdapter(dir) {
  if (!isDir(dir)) return [`not a directory: ${dir}`];
  const problems = [];
  let manifest = null;
  const manifestPath = path.join(dir, 'adapter.json');
  if (!isFile(manifestPath)) {
    problems.push('adapter.json is missing');
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problems.push(`adapter.json is not valid JSON (${error.message})`);
    }
  }
  if (manifest) {
    if (manifest.type !== 'stack') problems.push(`adapter.json type must be "stack", got ${JSON.stringify(manifest.type)}`);
    if (!Array.isArray(manifest.verbs)) problems.push('adapter.json verbs must be an array');
  }
  const listed = Array.isArray(manifest?.verbs) ? manifest.verbs : [];
  for (const verb of listed) {
    if (!VERBS.includes(verb)) {
      problems.push(`unknown verb ${verb} listed in adapter.json`);
      continue;
    }
    const file = path.join(dir, verb);
    if (!isFile(file)) {
      problems.push(`verb ${verb} is listed but has no executable ${verb}`);
    } else if (!isExecutable(file)) {
      problems.push(`${verb} is not executable (exec bit missing)`);
    }
  }
  // Only top-level regular files are verbs; subdirectories such as lib/ are not scanned.
  for (const name of fs.readdirSync(dir).sort()) {
    if (META_FILES.has(name)) continue;
    const file = path.join(dir, name);
    if (isFile(file) && isExecutable(file) && !listed.includes(name)) {
      problems.push(`executable ${name} is not listed in adapter.json verbs`);
    }
  }
  return problems;
}
