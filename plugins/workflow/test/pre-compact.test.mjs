// hooks/pre-compact.mjs: the PreCompact hook that prints the keep-rules. Run as a process with real hook JSON on
// stdin, as Claude Code runs it, in throwaway git checkouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'pre-compact.mjs');

// A git checkout on `branch`, with the given files.
function checkout(t, branch, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-compact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', branch, dir]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const run = (payload) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
const input = (cwd, extra = {}) => ({ session_id: 's1', cwd, hook_event_name: 'PreCompact', trigger: 'auto', ...extra });

test('a slice branch with its brief → the slice keep-rules, naming brief, unit table and handoff', (t) => {
  const dir = checkout(t, 'B02/abc', { 'docs/briefs/B02-abc.md': '# B02\n', 'docs/handoff.md': '# h\n' });
  const r = run(input(join(dir, 'docs')));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^This session builds slice B02 on branch B02\/abc\. When you summarise, keep:/);
  assert.match(r.stdout, /docs\/briefs\/B02-abc\.md, the slice's unit table, docs\/plans\/B02-abc\.md, and docs\/handoff\.md/);
  assert.match(r.stdout, /in flight \(the implementer's agent id/);
  assert.match(r.stdout, /the QA round: .* head commit/);
  assert.match(r.stdout, /^Drop file contents/m);
});

test('no brief for the branch but a handoff → the shorter session rules', (t) => {
  const dir = checkout(t, 'workflow/work-lessons', { 'docs/handoff.md': '# h\n' });
  const r = run(input(dir));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^This session works on branch workflow\/work-lessons\./);
  assert.doesNotMatch(r.stdout, /unit table/);
});

test('a QA session, by agent type or by session name, gets nothing', (t) => {
  const dir = checkout(t, 'B02/abc', { 'docs/briefs/B02-abc.md': '# B02\n' });
  assert.equal(run(input(dir, { agent_type: 'workflow:qa-reviewer' })).stdout, '');
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'agent-name', agentName: 'qa:judge' })}\n`);
  assert.equal(run(input(dir, { transcript_path: transcript })).stdout, '');
});

test('outside git, a project with no handoff, or bad input → nothing, exit 0', (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'pre-compact-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(run(input(plain)).stdout, '');
  const bare = checkout(t, 'main');
  assert.equal(run(input(bare)).stdout, '');
  for (const text of ['not json', '', '{}']) {
    const r = spawnSync(process.execPath, [HOOK], { input: text, encoding: 'utf8', cwd: plain });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});
