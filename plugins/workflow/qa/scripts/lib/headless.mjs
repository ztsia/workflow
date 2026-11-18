// Headless agent sessions for `qa verify` (rework U10, design §13 and §14): one agent of this plugin started as
// `claude -p` with the agent definition, a pinned model, the tools its own frontmatter names, JSON output and the
// project root as cwd. Its answer and its cost are read back from that JSON; a call that fails is told apart from an
// answer and never guessed past. The binary is QA_CLAUDE, else `claude` on PATH (tests use a fake).
//
// Measured 2026-11-12 (claude 2.1.x): `claude -p … --plugin-dir <root> --agent workflow:<name>` works locally and inside a
// cloud session, where no plugin is installed, so --plugin-dir is always this plugin's own root (the folder above qa/), where agents/<name>.md is found. In -p mode a tool is
// usable only when allowed. An unknown --agent exits 1 with "--agent '<x>' not found" on stderr. A resumed session
// (--resume <id>) keeps its id, and its total_cost_usd and modelUsage are the session's totals so far, not the call's.
// `--name <n>` names the session in its transcript (an agent-name line): QA sessions are named `qa:<role>`, so the
// pre-compact hook leaves them alone.
// Measured too: `--setting-sources user` does not load a worktree's .claude/settings.local.json (a session's own agent,
// advisor model and default mode); `user,project,local` does. So every call passes `--setting-sources user`, and every
// role names its own agent: the security review too (its persona, agents/qa-security.md, is a neutral reviewer), so no
// settings file can make a QA session the main session.
//
// CONTRACT (tests: test/headless.test.mjs; through verify: test/verify.test.mjs)
//
//   ROLES = { mapper: { agent: 'qa-mapper' }, planner: { agent: 'qa-reviewer' }, security: { agent: 'qa-security' },
//     eyes: { agent: 'qa-eyes' }, judge: { agent: 'qa-reviewer' } }   (security runs the native /security-review, or the
//     same review told its diff, as the plugin's own neutral persona: agents/qa-security.md)
//   SECURITY_TOOLS = the read-only tools the review may use (the call passes them, not its persona's); its write-up adds
//     Write.
//   PLUGIN_ROOT = this plugin's root: the folder above qa/ (from import.meta.url); QA_ROOT = its qa/ folder.
//   claudeBin(env = process.env) -> env.QA_CLAUDE || 'claude'
//   agentTools(text) -> [tool]   the `tools:` line of a frontmatter (between the first two '---' lines), split on
//     commas outside parentheses, trimmed; [] when there is none.
//   agentToolsOf(pluginDir, agent) -> agentTools(<pluginDir>/agents/<agent>.md); a missing file throws 'no agent <agent>'.
//   roleConfig(agents, role) -> { model, timeoutMs }   qa.json agents.<role> over profile.mjs AGENT_DEFAULTS[role].
//   claudeArgv({ prompt, pluginDir, agent, model, tools, name, resume, addDirs }) ->
//     ['-p', prompt, '--output-format', 'json', '--setting-sources', 'user', '--plugin-dir', pluginDir, ('--agent',
//      'workflow:<agent>'), '--model', model,
//      '--name', name, ('--allowedTools=<a,b>'), ('--add-dir=<dir>' …), ('--resume', resume)]   (parenthesised: only when
//      given; the = forms keep a variadic flag from swallowing the next argument)
//   runHeadless(opts) -> Promise<Call>
//     opts: { role, prompt, cwd, dir (where its files go: V/agents), bin, pluginDir, agent, model, tools, timeoutMs,
//             resume = null, addDirs = [], env = {} (over process.env) }
//     n = 1 + the number of <dir>/<role>-*.json already there. stdout goes to <dir>/<role>-<n>.json, stderr to
//     <dir>/<role>-<n>.log, after a header: '$ <bin> -p <prompt> <the other args>', '--- prompt', the prompt,
//     '--- stderr' (so a hand-driven step can see what the agent was asked). stdin is closed. The child is its own
//     process group: at timeoutMs the group gets SIGTERM, 5 s later SIGKILL; a verify that exits takes its running
//     calls with it.
//     Call = { role, n, ok, why, exit, session, resume, usd, turns, ms, result, tokens: { input, output, cacheRead,
//       cacheWrite }, models, out, log }
//       ok false, why (one line), the first that applies:
//         the binary could not start (ENOENT)       'claude not found: <bin> (put claude on PATH, or set QA_CLAUDE)'
//         killed at the timeout                     'timed out after <t>' (<t>: '<s> s' under a minute, else '<m> min')
//         stdout parses as JSON and is_error         the subtype when it is not 'success', and the result's first line,
//                                                    joined ': ' (else 'is_error')
//         a non-zero exit                            the first non-empty stderr line (else 'exit <code>')
//         exit 0 and stdout is no JSON               'no JSON result on stdout: <its first 80 characters>'
//       session = session_id; usd = total_cost_usd (the session's so far); tokens = the sums over modelUsage (the
//       session's so far); models = the --model asked for.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_DEFAULTS } from './profile.mjs';

export const QA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN_ROOT = path.resolve(QA_ROOT, '..');

export const ROLES = Object.freeze({
  mapper: Object.freeze({ agent: 'qa-mapper' }),
  planner: Object.freeze({ agent: 'qa-reviewer' }),
  security: Object.freeze({ agent: 'qa-security' }),
  eyes: Object.freeze({ agent: 'qa-eyes' }),
  judge: Object.freeze({ agent: 'qa-reviewer' }),
});

// What the native review reads with: the files, and git for the diff and history. Never an edit.
export const SECURITY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Agent', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git status *)']);

export const claudeBin = (env = process.env) => env.QA_CLAUDE || 'claude';

export function agentTools(text) {
  const lines = String(text ?? '').split('\n');
  if (lines[0].trim() !== '---') return [];
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = /^tools:\s*(.*)$/.exec(lines[i]);
    if (m) return m[1].split(/,(?![^(]*\))/).map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

export function agentToolsOf(pluginDir, agent) {
  const file = path.join(pluginDir, 'agents', `${agent}.md`);
  if (!fs.existsSync(file)) throw new Error(`no agent ${agent} at ${file}`);
  return agentTools(fs.readFileSync(file, 'utf8'));
}

export function roleConfig(agents, role) {
  return { ...AGENT_DEFAULTS[role], ...(agents?.[role] ?? {}) };
}

export function claudeArgv({ prompt, pluginDir, agent = null, model, tools = [], name, resume = null, addDirs = [] }) {
  return [
    '-p', prompt, '--output-format', 'json', '--setting-sources', 'user', '--plugin-dir', pluginDir,
    ...(agent ? ['--agent', `workflow:${agent}`] : []),
    '--model', model, '--name', name,
    ...(tools.length ? [`--allowedTools=${tools.join(',')}`] : []),
    ...addDirs.map((d) => `--add-dir=${d}`),
    ...(resume ? ['--resume', resume] : []),
  ];
}

const STDERR = '--- stderr';
const span = (ms) => (ms < 60000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 60000)} min`);
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// Calls still running when verify exits (a kill, an uncaught error): their process groups go with it.
const running = new Set();
process.on('exit', () => {
  for (const pid of running) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

function nextN(dir, role) {
  if (!fs.existsSync(dir)) return 1;
  const re = new RegExp(`^${role}-(\\d+)\\.json$`);
  return 1 + fs.readdirSync(dir).filter((f) => re.test(f)).length;
}

function tokensOf(modelUsage) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of Object.values(modelUsage ?? {})) {
    t.input += u?.inputTokens ?? 0;
    t.output += u?.outputTokens ?? 0;
    t.cacheRead += u?.cacheReadInputTokens ?? 0;
    t.cacheWrite += u?.cacheCreationInputTokens ?? 0;
  }
  return t;
}

export async function runHeadless(opts) {
  const { role, prompt, cwd, dir, bin, pluginDir, agent = null, model, tools = [], timeoutMs, resume = null, addDirs = [], env = {} } = opts;
  fs.mkdirSync(dir, { recursive: true });
  const n = nextN(dir, role);
  const out = path.join(dir, `${role}-${n}.json`);
  const log = path.join(dir, `${role}-${n}.log`);
  const argv = claudeArgv({ prompt, pluginDir, agent, model, tools, name: `qa:${role}`, resume, addDirs });
  fs.writeFileSync(log, `$ ${bin} -p <prompt> ${argv.slice(2).map((a) => JSON.stringify(a)).join(' ')}\n--- prompt\n${prompt}\n${STDERR}\n`);
  const outFd = fs.openSync(out, 'w');
  const logFd = fs.openSync(log, 'a');
  const t0 = Date.now();
  const ended = await new Promise((resolve) => {
    let child;
    let timedOut = false;
    let killer = null;
    try {
      child = spawn(bin, argv, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', outFd, logFd], detached: true });
    } catch (e) {
      resolve({ spawnError: e });
      return;
    }
    running.add(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
      killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000);
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); running.delete(child.pid); resolve({ spawnError: e }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      running.delete(child.pid);
      resolve({ code, signal, timedOut });
    });
  });
  fs.closeSync(outFd);
  fs.closeSync(logFd);
  const ms = Date.now() - t0;
  const call = { role, n, ok: false, why: null, exit: ended.code ?? null, session: null, resume, usd: null, turns: null, ms, result: null, tokens: null, models: [model], out, log };
  if (ended.spawnError) {
    call.why = ended.spawnError.code === 'ENOENT' ? `claude not found: ${bin} (put claude on PATH, or set QA_CLAUDE)` : `claude did not start: ${ended.spawnError.message}`;
    return call;
  }
  if (ended.timedOut) { call.why = `timed out after ${span(timeoutMs)}`; return call; }
  const stdout = fs.readFileSync(out, 'utf8');
  let json = null;
  try { json = JSON.parse(stdout); } catch { /* not JSON */ }
  if (json && typeof json === 'object') {
    call.session = json.session_id ?? null;
    call.usd = typeof json.total_cost_usd === 'number' ? json.total_cost_usd : null;
    call.turns = json.num_turns ?? null;
    call.result = typeof json.result === 'string' ? json.result : null;
    call.tokens = tokensOf(json.modelUsage);
    if (json.is_error) {
      call.why = [json.subtype && json.subtype !== 'success' ? json.subtype : null, firstLine(json.result) || null].filter(Boolean).join(': ') || 'is_error';
      return call;
    }
  }
  if (ended.code !== 0) {
    const text = fs.readFileSync(log, 'utf8');
    call.why = firstLine(text.slice(text.indexOf(`${STDERR}\n`) + STDERR.length + 1)) || `exit ${ended.code ?? ended.signal}`;
    return call;
  }
  if (!json || typeof json !== 'object') { call.why = `no JSON result on stdout: ${stdout.trim().slice(0, 80)}`; return call; }
  call.ok = true;
  return call;
}
