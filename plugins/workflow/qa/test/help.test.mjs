// qa <command> --help (or -h) prints that command's usage lines and never runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.join(import.meta.dirname, '..', 'scripts', 'qa.mjs');

for (const [cmd, line] of [['ready', '  ready [--at <ref>]'], ['sandbox', '  sandbox up --at <ref>'], ['verify', '  verify ']]) {
  test(`qa ${cmd} … --help: its usage, exit 0, nothing run`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfqa-help-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const r = spawnSync(process.execPath, [CLI, cmd, 'down', 'qa-x', '--help'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith(`qa ${cmd}\n`), r.stdout);
    assert.ok(r.stdout.includes(line), r.stdout);
    assert.equal(r.stderr, '', 'it ran and said something');
    assert.deepEqual(fs.readdirSync(dir), [], 'it wrote into the directory');
  });
}

test('qa ready -h: the short flag too', () => {
  const r = spawnSync(process.execPath, [CLI, 'ready', '-h'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ready \[--at <ref>\]/);
});
