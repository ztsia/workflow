// playwright-core, pinned, installed once per machine instead of once per worktree.
// Browser choice (installed Chrome or Playwright's chromium) is the caller's: see openBrowser in capture.mjs.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAYWRIGHT_VERSION = '1.63.0';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Claude Code sets CLAUDE_PLUGIN_DATA for an installed plugin; any other run (--plugin-dir, tests) uses ~/.cache/workflow-qa, so
// they share one install.
export function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.cache', 'workflow-qa');
}

// Where a playwright-core install may already be, in the order worth trying: the plugin data directory, the plugin
// itself (npm ci in a checkout), and the project's own node_modules (a project that already has Playwright).
export function searchPath(repoRoot = process.cwd()) {
  return [dataDir(), PLUGIN_ROOT, repoRoot];
}

function tryLoad(base) {
  try {
    return createRequire(path.join(base, 'noop.js'))('playwright-core');
  } catch {
    return null;
  }
}

export function loadPlaywright(repoRoot) {
  for (const base of searchPath(repoRoot)) {
    const pw = tryLoad(base);
    if (pw) return pw;
  }
  install();
  const pw = tryLoad(dataDir());
  if (!pw) throw new Error(`playwright-core did not load after installing it into ${dataDir()}`);
  return pw;
}

export function install() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'workflow-qa-data', private: true }, null, 2));
  }
  console.log(`installing playwright-core@${PLAYWRIGHT_VERSION} into ${dir} (once per machine)`);
  execSync(`npm install --no-audit --no-fund --save-exact playwright-core@${PLAYWRIGHT_VERSION}`, { cwd: dir, stdio: 'inherit' });
}
