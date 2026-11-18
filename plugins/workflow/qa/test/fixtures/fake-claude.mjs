#!/usr/bin/env node
// A fake `claude` for the headless contract tests (QA_CLAUDE points here). It records every call and plays a
// scripted part per role, so the tests see exactly what `qa verify` passes and how it reads the answer.
//
//   FAKE_CLAUDE_DIR/plan.json   { "<role>": [behaviour, …] } — the n-th call of a role (counted across the run, a
//                               resume included) plays behaviour n, the last one again when the list runs out.
//   FAKE_CLAUDE_DIR/calls.jsonl one line per call: { role, argv, cwd, prompt, resume }
//   behaviour = { exit = 0, stderr = '', stdout (raw text instead of the JSON), json (merged over the default
//                 result), files: { "<path relative to cwd>": "<text>" } written before answering, sleepMs, usd }
// The role is the `--name qa:<role>` the caller passes. The session id is `s-<role>-<n>`, or the resumed one.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const dir = process.env.FAKE_CLAUDE_DIR;
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const role = (flag('--name') ?? 'qa:unknown').replace(/^qa:/, '');
const prompt = argv[0] === '-p' ? argv[1] : null;
const resume = flag('--resume');
const model = flag('--model') ?? 'claude-sonnet-5-5';

fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ role, argv, cwd: process.cwd(), prompt, resume })}\n`);
const countFile = path.join(dir, `count-${role}`);
const n = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
fs.writeFileSync(countFile, String(n));
const plan = fs.existsSync(path.join(dir, 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) : {};
const list = plan[role] ?? [];
const b = list[n - 1] ?? list.at(-1) ?? {};

const answer = () => {
  for (const [rel, text] of Object.entries(b.files ?? {})) {
    const file = path.resolve(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  if (b.stderr) process.stderr.write(b.stderr);
  if (typeof b.stdout === 'string') process.stdout.write(b.stdout);
  else {
    const usd = b.usd ?? 0.1 * n;
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: resume ?? `s-${role}-${n}`,
      num_turns: 3, duration_ms: 12, total_cost_usd: usd,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
      modelUsage: { [model]: { inputTokens: 100 * n, outputTokens: 20 * n, cacheReadInputTokens: 1000 * n, cacheCreationInputTokens: 50 * n, costUSD: usd } },
      ...(b.json ?? {}),
    }));
  }
  process.exitCode = b.exit ?? 0;
};
if (b.sleepMs) setTimeout(answer, b.sleepMs);
else answer();
