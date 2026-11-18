#!/usr/bin/env node
// PreToolUse command hook on the Agent tool: the brief skill's model rule, enforced. An implementer
// (subagent_type workflow:implementer) runs on Haiku at high; any other model is allowed only when the brief
// carries a line `Sonnet because: <clause> — <why>` naming one of the three clauses. Without it the dispatch is
// denied, and the reason says exactly what to add. Nothing for any other subagent type. Never blocks on its own
// error: every failure is exit 0 with nothing printed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const IMPLEMENTER = 'workflow:implementer';
// The three clauses, as the brief skill words them; a line names one by its key words.
export const CLAUSES = Object.freeze([
  ['unknown cause', 'unknown cause to find'],
  ['unfamiliar code', 'large body of unfamiliar code to reason across'],
  ['second miss', 'second miss on the same point'],
]);

const LINE = /^[\s>*-]*Sonnet because:(.*)$/gim;

// True when one `Sonnet because:` line names a clause and, after a dash, why.
export function hasReason(prompt) {
  for (const [, rest] of String(prompt ?? '').matchAll(LINE)) {
    const low = rest.toLowerCase();
    const at = CLAUSES.map(([key]) => low.indexOf(key)).find((i) => i >= 0);
    if (at !== undefined && /[—–-]\s*\S/.test(rest.slice(at))) return true;
  }
  return false;
}

export const denyReason = (model) => `workflow: an implementer runs on Haiku at high (leave model out). To dispatch it on ${model}, the brief needs one line, also on its row of the slice's unit table:
Sonnet because: <clause> — <why, in this unit>
where <clause> is one of: ${CLAUSES.map(([, words]) => words).join(' | ')}. "Long", "repetitive", "tests" and "the example" never qualify: send it on Haiku instead.`;

// The hook's decision for one PreToolUse input: null (let it run) or the deny output.
export function decide(input) {
  const tool = input?.tool_input ?? {};
  if (input?.tool_name !== 'Agent' && input?.tool_name !== 'Task') return null;
  if (tool.subagent_type !== IMPLEMENTER) return null;
  const model = String(tool.model ?? '').trim();
  if (!model || /haiku/i.test(model)) return null;
  if (hasReason(tool.prompt)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReason(model) } };
}

function main() {
  try {
    const out = decide(JSON.parse(readFileSync(0, 'utf8') || '{}'));
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch { /* never block on our own error */ }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
