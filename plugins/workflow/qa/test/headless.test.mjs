// Contract tests for scripts/lib/headless.mjs (rework U10, design §13 and §14): how `qa verify` starts one agent as a
// headless Claude session — the argv (plugin dir, agent, model, allowed tools from the agent's own frontmatter, JSON
// output), where its output is kept, what it cost, and how a failed call is told apart from an answer. `claude` is the
// fake at test/fixtures/fake-claude.mjs (QA_CLAUDE in the CLI; `bin` here).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  PLUGIN_ROOT, ROLES, SECURITY_TOOLS, agentTools, agentToolsOf, claudeArgv, claudeBin, roleConfig, runHeadless,
} from '../scripts/lib/headless.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };

// A project dir, its V/agents and a fake claude playing `plan`.
function setup(plan = {}) {
  const root = tmp('mfqa-headless-');
  const fake = tmp('mfqa-fake-claude-');
  fs.writeFileSync(path.join(fake, 'plan.json'), JSON.stringify(plan));
  const dir = path.join(root, 'qa', 'feat-x', 'agents');
  const calls = () => (fs.existsSync(path.join(fake, 'calls.jsonl')) ? fs.readFileSync(path.join(fake, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const call = (over = {}) => runHeadless({
    role: 'planner', prompt: 'phase: plan', cwd: root, dir, bin: FAKE, pluginDir: PLUGIN_ROOT, agent: 'qa-reviewer', model: 'sonnet',
    tools: ['Read', 'Bash'], timeoutMs: 30000, env: { FAKE_CLAUDE_DIR: fake }, ...over,
  });
  return { root, dir, fake, calls, call };
}

describe('headless: the agent definition', () => {
  test('PLUGIN_ROOT is this plugin; each role names its agent (security: its own neutral persona, never one a settings file picks)', () => {
    assert.equal(PLUGIN_ROOT, ROOT);
    assert.deepEqual(Object.fromEntries(Object.entries(ROLES).map(([r, v]) => [r, v.agent])),
      { mapper: 'qa-mapper', planner: 'qa-reviewer', security: 'qa-security', eyes: 'qa-eyes', judge: 'qa-reviewer' });
    assert.ok(SECURITY_TOOLS.includes('Read') && !SECURITY_TOOLS.includes('Write') && !SECURITY_TOOLS.includes('Edit'), 'the review only reads');
    // The persona may write (the write-up adds Write to the call's allowed tools); every review tool is in it.
    const persona = agentToolsOf(PLUGIN_ROOT, 'qa-security');
    for (const t of ['Read', 'Grep', 'Glob', 'Agent', 'Bash', 'Write']) assert.ok(persona.includes(t), `security persona tools: ${persona.join(', ')}`);
    assert.ok(!persona.includes('Edit'), 'the review never edits');
  });

  test('agentTools: the frontmatter tools line of each shipped agent, nothing from the body', () => {
    assert.deepEqual(agentToolsOf(PLUGIN_ROOT, 'qa-reviewer'), ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit']);
    assert.deepEqual(agentToolsOf(PLUGIN_ROOT, 'qa-eyes'), ['Read', 'Glob', 'Write']);
    assert.deepEqual(agentToolsOf(PLUGIN_ROOT, 'qa-mapper'), ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write']);
    assert.deepEqual(agentTools('---\nname: x\n---\ntools: Bash\n'), [], 'no tools line in the frontmatter');
    assert.deepEqual(agentTools('---\nname: x\ntools: Read, Bash(git diff *), Glob\n---\nbody\n'), ['Read', 'Bash(git diff *)', 'Glob']);
    assert.throws(() => agentToolsOf(PLUGIN_ROOT, 'nope'), /no agent nope/);
  });

  test('roleConfig: the design §14 models by default, qa.json agents.<role> over them key by key', () => {
    const models = Object.fromEntries(Object.keys(ROLES).map((r) => [r, roleConfig(undefined, r).model]));
    assert.deepEqual(models, { mapper: 'haiku', planner: 'sonnet', security: 'sonnet', eyes: 'opus', judge: 'sonnet' });
    for (const r of Object.keys(ROLES)) assert.ok(roleConfig(undefined, r).timeoutMs >= 600000, `${r} has a timeout of 10 minutes or more`);
    const eyes = roleConfig({ eyes: { model: 'sonnet' } }, 'eyes');
    assert.deepEqual(eyes, { model: 'sonnet', timeoutMs: roleConfig(undefined, 'eyes').timeoutMs });
    assert.deepEqual(roleConfig({ judge: { timeoutMs: 60000 } }, 'judge'), { model: 'sonnet', timeoutMs: 60000 });
  });

  test('claudeBin: QA_CLAUDE, else claude on PATH', () => {
    assert.equal(claudeBin({}), 'claude');
    assert.equal(claudeBin({ QA_CLAUDE: '/x/fake' }), '/x/fake');
  });

  test('claudeArgv: print mode, JSON, the plugin dir always, the agent by its plugin name, the model, a session name, the tools', () => {
    const argv = claudeArgv({ prompt: 'phase: plan\nslug: x', pluginDir: '/p', agent: 'qa-reviewer', model: 'sonnet', tools: ['Read', 'Bash'], name: 'qa:planner', addDirs: ['/o'] });
    assert.deepEqual(argv, ['-p', 'phase: plan\nslug: x', '--output-format', 'json', '--setting-sources', 'user', '--plugin-dir', '/p', '--agent', 'workflow:qa-reviewer',
      '--model', 'sonnet', '--name', 'qa:planner', '--allowedTools=Read,Bash', '--add-dir=/o']);
    const again = claudeArgv({ prompt: 'fix', pluginDir: '/p', agent: null, model: 'sonnet', tools: [], name: 'qa:security', resume: 's-1' });
    assert.deepEqual(again, ['-p', 'fix', '--output-format', 'json', '--setting-sources', 'user', '--plugin-dir', '/p', '--model', 'sonnet', '--name', 'qa:security', '--resume', 's-1']);
  });
});

describe('headless: runHeadless', () => {
  test('an answer: its JSON and its log kept under V/agents/<role>-<n>, the session, cost, turns and tokens read back', async () => {
    const s = setup({ planner: [{ usd: 0.3, json: { result: 'charter: 2 rows' } }] });
    const c = await s.call();
    assert.equal(c.ok, true, c.why);
    assert.deepEqual([c.role, c.n, c.session, c.usd, c.turns, c.result, c.why], ['planner', 1, 's-planner-1', 0.3, 3, 'charter: 2 rows', null]);
    assert.deepEqual(c.tokens, { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 });
    assert.deepEqual(c.models, ['sonnet']);
    assert.equal(c.out, path.join(s.dir, 'planner-1.json'));
    assert.equal(c.log, path.join(s.dir, 'planner-1.log'));
    assert.equal(JSON.parse(fs.readFileSync(c.out, 'utf8')).session_id, 's-planner-1');
    assert.ok(fs.existsSync(c.log));
    const [rec] = s.calls();
    assert.equal(rec.cwd, s.root, 'cwd is the project root');
    assert.deepEqual(rec.argv.slice(0, 2), ['-p', 'phase: plan']);
    assert.ok(rec.argv.includes('--allowedTools=Read,Bash'));
    const second = await s.call({ role: 'judge' });
    assert.equal(second.n, 1, 'numbered per role');
    const third = await s.call();
    assert.equal(third.n, 2);
    assert.ok(fs.existsSync(path.join(s.dir, 'planner-2.json')));
  });

  test('a resumed session: the same session id, and usd is the session total so far (claude -p reports it cumulative)', async () => {
    const s = setup({ planner: [{ usd: 0.3 }, { usd: 0.45 }] });
    const first = await s.call();
    const again = await s.call({ prompt: 'fix these', resume: first.session });
    assert.deepEqual([again.ok, again.session, again.usd, again.resume], [true, 's-planner-1', 0.45, 's-planner-1']);
    assert.deepEqual(s.calls()[1].argv.slice(-2), ['--resume', 's-planner-1']);
  });

  test('a failure is never an answer: exit code, is_error, a timeout, a missing binary, no JSON each give ok false and why', async () => {
    const s = setup({
      planner: [{ exit: 1, stderr: "--agent 'workflow:qa-reviewer' not found. Available agents: claude, Explore\n", stdout: '' }],
      judge: [{ exit: 1, json: { is_error: true, result: 'Invalid API key · Please run /login' } }],
      eyes: [{ json: { is_error: true, subtype: 'error_max_turns', result: '' } }],
      mapper: [{ sleepMs: 5000 }],
      security: [{ stdout: 'not json at all' }],
    });
    const notFound = await s.call();
    assert.deepEqual([notFound.ok, notFound.exit, notFound.why], [false, 1, "--agent 'workflow:qa-reviewer' not found. Available agents: claude, Explore"]);
    const auth = await s.call({ role: 'judge' });
    assert.deepEqual([auth.ok, auth.why], [false, 'Invalid API key · Please run /login']);
    const turns = await s.call({ role: 'eyes' });
    assert.deepEqual([turns.ok, turns.why], [false, 'error_max_turns']);
    const t0 = Date.now();
    const slow = await s.call({ role: 'mapper', timeoutMs: 300 });
    assert.equal(slow.ok, false);
    assert.match(slow.why, /^timed out after 0\.3 s/);
    assert.ok(Date.now() - t0 < 4000, 'killed at the timeout, not waited out');
    const garbled = await s.call({ role: 'security' });
    assert.deepEqual([garbled.ok, garbled.why], [false, 'no JSON result on stdout: not json at all']);
    const missing = await s.call({ bin: path.join(s.root, 'no-such-claude') });
    assert.equal(missing.ok, false);
    assert.match(missing.why, /^claude not found: .*no-such-claude/);
    for (const c of [notFound, auth, slow]) assert.ok(fs.existsSync(c.log), `${c.role}: its log is kept`);
  });
});
