#!/usr/bin/env node
// PreCompact command hook. Claude Code adds a PreCompact hook's stdout to the compaction instructions, so it
// prints what the summary must keep and may drop:
//   - a slice session: the checkout is on <label>/<name> and docs/briefs/<label>-<name>.md exists (the rules'
//     "one brief, one branch");
//   - any other session in a project with docs/handoff.md: the shorter session rules.
// Never to a QA session: one whose agent_type starts 'workflow:qa', or whose session name (the last agent-name line
// `claude --name` wrote in its transcript_path) starts 'qa:' or 'workflow:qa' — the QA runner's headless sessions
// run in the build's checkout. Anywhere else, print nothing. Never fails the compaction: every error is exit 0 with
// nothing printed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (cwd, args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return ''; }
};

const DROP = 'Drop file contents you read (they are on disk), subagent transcripts and reports already committed, test and build logs, and usage tables.';

export function sliceRules({ cwd }) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return '';
  const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  const m = /^([^/]+)\/([^/]+)$/.exec(branch);
  const brief = m ? `docs/briefs/${m[1]}-${m[2]}.md` : null;
  if (brief && existsSync(join(top, brief))) {
    const plan = `docs/plans/${m[1]}-${m[2]}.md`;
    return [
      `This session builds slice ${m[1]} on branch ${branch}. When you summarise, keep:`,
      `- the brief, ${brief}, the slice's unit table, ${plan}, and docs/handoff.md: after this summary re-read them rather than trust a summary of them`,
      "- which units are done (their commit), in flight (the implementer's agent id, kept until the unit is committed) and waiting; each `Sonnet because:` line",
      '- the interfaces, types and seams decided but not yet committed',
      '- every decision taken since the brief, with why',
      '- the questions for the owner, recorded in the handoff rather than asked',
      '- the QA round: how many runs so far, the last verdict, its head commit and its open items',
      "- each deviation the PR must explain (a unit done by a different model or by you, a criterion read differently from its ask)",
      '- the next step',
      DROP,
    ].join('\n');
  }
  if (!existsSync(join(top, 'docs', 'handoff.md'))) return '';
  return [
    `This session works on branch ${branch || 'detached'}. When you summarise, keep:`,
    '- docs/handoff.md and any plan file this session is following: after this summary re-read them rather than trust a summary of them',
    "- the subagents in flight (their agent id, kept until their work is committed) and what each owns",
    '- every decision taken this session, with why',
    "- the owner's open questions and their answers",
    '- the next step',
    DROP,
  ].join('\n');
}

// The session's name: the last agent-name line of its transcript (`claude --name`), or null.
export function sessionName(transcriptPath) {
  if (!transcriptPath) return null;
  let name = null;
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.includes('"agent-name"')) continue;
      try { const d = JSON.parse(line); if (d.type === 'agent-name' && typeof d.agentName === 'string') name = d.agentName; } catch { /* not a line */ }
    }
  } catch { /* no transcript */ }
  return name;
}

export const isQa = ({ agentType, name }) =>
  String(agentType ?? '').startsWith('workflow:qa') || /^(qa:|workflow:qa)/.test(String(name ?? ''));

export function keepRules({ cwd, agentType, name = null }) {
  if (isQa({ agentType, name })) return '';
  return sliceRules({ cwd });
}

function main() {
  try {
    let input = {};
    try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no input */ }
    const text = keepRules({ cwd: input.cwd || process.cwd(), agentType: input.agent_type, name: sessionName(input.transcript_path) });
    if (text) process.stdout.write(`${text}\n`);
  } catch { /* never fail the compaction */ }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
