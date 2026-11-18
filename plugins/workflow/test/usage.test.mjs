// scripts/usage.mjs: the prices, the advisor consults inside a message, the largest context and compactions of a
// transcript, and the table the script prints for the newest session. Transcripts are built in throwaway folders.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextOf, priceOf, readTranscript } from '../scripts/usage.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/usage.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'usage-'));
after(() => rmSync(root, { recursive: true, force: true }));

// An advisor consult inside a message: its own model and tokens, Opus 5.5 at $4 in, $0.2 read, $20 out.
const advisorIteration = {
  type: 'advisor_message',
  model: 'claude-opus-5-5',
  input_tokens: 10,
  cache_read_input_tokens: 200000,
  output_tokens: 500,
};
// What that consult costs: (10*4 + 200000*0.2 + 500*20) / 1e6.
const ADVISOR_USD = (10 * 4 + 200000 * 0.2 + 500 * 20) / 1e6;

// One assistant line of a transcript, for a message id.
const assistantLine = (id, usage, { model = 'claude-opus-5-5', uuid = `${id}-line` } = {}) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-11-18T10:00:00.000Z',
    message: { id, model, content: [{ type: 'text', text: 'hello' }], usage },
  });

// A transcript file in the root folder, one JSON line per entry.
function transcript(name, lines) {
  const file = join(root, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('prices: an explicit cache-read price per model, and the family rates', () => {
  assert.equal(priceOf('claude-opus-5-5').read, 0.2);
  assert.equal(priceOf('claude-haiku-5-5').in, 0.1);
  // an unknown model is priced as Opus 5.5
  assert.deepEqual(priceOf('some-other-model'), { in: 4, out: 20, read: 0.2 });
});

test('a message with an advisor consult: the consult is counted and priced by its own model, and adds to usd', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
    iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      advisorIteration,
    ],
  };
  const file = transcript('advisor.jsonl', [assistantLine('msg_a', usage)]);
  const t = readTranscript(file);
  assert.equal(t.advisor.calls, 1);
  assert.deepEqual([...t.advisor.models], ['claude-opus-5-5']);
  assert.ok(Math.abs(t.advisor.usd - ADVISOR_USD) < 1e-12, `advisor usd ${t.advisor.usd}`);
  // the executor's own dollars: (100*4 + 1000*0.2 + 50*20) / 1e6, and the row total includes the consult
  const own = (100 * 4 + 1000 * 0.2 + 50 * 20) / 1e6;
  assert.ok(Math.abs(t.usd - (own + ADVISOR_USD)) < 1e-12, `row usd ${t.usd}`);
  // the advisor's model is not one of the row's models
  assert.deepEqual([...t.models], ['claude-opus-5-5']);
});

test('the largest context is the largest executor pass, not the top-level sum', () => {
  const usage = {
    input_tokens: 20,
    output_tokens: 30,
    cache_read_input_tokens: 110000,
    cache_creation_input_tokens: 0,
    iterations: [
      { type: 'message', input_tokens: 10, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, output_tokens: 10 },
      advisorIteration,
      { type: 'message', input_tokens: 10, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0, output_tokens: 20 },
    ],
  };
  assert.equal(contextOf(usage), 60010);
  const t = readTranscript(transcript('context.jsonl', [assistantLine('msg_c', usage)]));
  assert.equal(t.maxContext, 60010);
});

test('a compact_boundary line counts as one compaction', () => {
  const usage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  const file = transcript('compact.jsonl', [
    assistantLine('msg_d1', usage),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-18T10:05:00.000Z' }),
    assistantLine('msg_d2', usage),
  ]);
  assert.equal(readTranscript(file).compactions, 1);
});

test('the same message id logged twice counts once, consult included', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
    iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      advisorIteration,
    ],
  };
  const once = readTranscript(transcript('once.jsonl', [assistantLine('msg_e', usage)]));
  const twice = readTranscript(
    transcript('twice.jsonl', [assistantLine('msg_e', usage, { uuid: 'first' }), assistantLine('msg_e', usage, { uuid: 'second' })]),
  );
  assert.equal(twice.turns, 1);
  assert.equal(twice.advisor.calls, 1);
  assert.ok(Math.abs(twice.advisor.usd - ADVISOR_USD) < 1e-12);
  assert.ok(Math.abs(twice.usd - once.usd) < 1e-12);
});

test('the script prints the largest context, the advisor column and the advisor sentence for the newest session', () => {
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  // Claude Code names a checkout's transcript folder after its real path, every non-alphanumeric character as '-'
  const projectDir = join(home, '.claude', 'projects', realpathSync(project).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
    iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      advisorIteration,
    ],
  };
  writeFileSync(join(projectDir, 'sess-1.jsonl'), `${assistantLine('msg_f', usage)}\n`);

  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: project,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Largest context/);
  assert.match(r.stdout, /Advisor \$/);
  assert.match(r.stdout, /Main session: largest context 1k, 0 compaction\(s\)/);
});
