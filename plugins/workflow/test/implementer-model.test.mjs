// hooks/implementer-model.mjs: the PreToolUse hook that holds an implementer to Haiku unless its brief carries a
// `Sonnet because: <clause> — <why>` line. Run as a process with real hook JSON on stdin, as Claude Code runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'implementer-model.mjs');

// A plain project folder with a sub-folder to stand in.
function checkout(t) {
  const dir = mkdtempSync(join(tmpdir(), 'implementer-model-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  return dir;
}

// The PreToolUse input Claude Code sends for an Agent call.
const input = (cwd, toolInput, extra = {}) => ({
  session_id: 'b9a1c2d3', transcript_path: join(cwd, 'x.jsonl'), cwd, permission_mode: 'acceptEdits',
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_01abc',
  tool_input: { description: 'U4 session refresh', prompt: 'Unit: U4 — fix the session refresh\nGoal: …', ...toolInput },
  ...extra,
});
const run = (payload) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });

const denied = (r) => {
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
};
const allowed = (r) => { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '', 'no decision: the call runs'); };

test('implementer on sonnet with a Sonnet because line naming a clause and why → allowed', (t) => {
  const dir = checkout(t);
  for (const line of [
    'Sonnet because: unknown cause to find — refresh fails only after an idle hour',
    'Sonnet because: large body of unfamiliar code to reason across – the auth middleware chain',
    '- Sonnet because: second miss on the same point - the implementer twice dropped the retry header',
  ]) {
    allowed(run(input(join(dir, 'src', 'app'), { subagent_type: 'workflow:implementer', model: 'sonnet', prompt: `Unit: U4 — fix it\n${line}\nGoal: …` })));
  }
});

test('implementer on sonnet with no line, or a line naming no clause or no why → denied, saying exactly what to add', (t) => {
  const dir = checkout(t);
  for (const prompt of [
    'Unit: U2 — sign-in screen (example)\nGoal: …',
    'Unit: U2 — sign-in screen\nSonnet because: the example — it is long and repetitive',
    'Unit: U4\nSonnet because: unknown cause to find',
  ]) {
    const why = denied(run(input(dir, { subagent_type: 'workflow:implementer', model: 'sonnet', prompt })));
    assert.match(why, /To dispatch it on sonnet, the brief needs one line, also on its row of the slice's unit table:\nSonnet because: <clause> — <why, in this unit>/);
    assert.match(why, /unknown cause to find \| large body of unfamiliar code to reason across \| second miss on the same point/);
    assert.match(why, /"Long", "repetitive", "tests" and "the example" never qualify/);
  }
  assert.match(denied(run(input(dir, { subagent_type: 'workflow:implementer', model: 'opus' }))), /on opus/, 'any model above haiku');
});

test('implementer with no model, or on haiku → allowed (Haiku at high is its default)', (t) => {
  const dir = checkout(t);
  allowed(run(input(dir, { subagent_type: 'workflow:implementer' })));
  allowed(run(input(dir, { subagent_type: 'workflow:implementer', model: 'haiku' })));
});

test('any other subagent type on sonnet → nothing, anywhere', (t) => {
  const dir = checkout(t);
  for (const type of ['workflow:scout', 'workflow:qa-reviewer', 'general-purpose', 'Explore']) {
    allowed(run(input(dir, { subagent_type: type, model: 'sonnet' })));
  }
  allowed(run({ ...input(dir, { subagent_type: 'workflow:implementer', model: 'sonnet' }), tool_name: 'Bash', tool_input: { command: 'ls' } }));
});

test('no project marker needed: denied in any folder', (t) => {
  const plain = checkout(t);
  denied(run(input(plain, { subagent_type: 'workflow:implementer', model: 'sonnet' })));
});

test('bad input never blocks: not JSON, empty, no tool_input → exit 0, nothing printed', () => {
  for (const text of ['not json', '', '{}', '{"tool_name":"Agent"}']) {
    const r = spawnSync(process.execPath, [HOOK], { input: text, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});
