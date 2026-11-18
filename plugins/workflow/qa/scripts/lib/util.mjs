// Small helpers shared by every command. Nothing here touches the browser or the network.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else out._.push(argv[i]);
  }
  return out;
}

export function need(args, name) {
  if (!args[name] || args[name] === true) throw new Error(`--${name} is required`);
  return args[name];
}

export const str = (v) => (typeof v === 'string' ? v : null);

export const sha1 = (file) => createHash('sha1').update(fs.readFileSync(file)).digest('hex');

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// "a*b" -> /^a.*b$/, the screen-name globs of expectations and --screens.
export const glob = (p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

// A palette or expectation colour as getComputedStyle prints it: "#4DA938" -> "rgb(77, 169, 56)".
export function rgb(c) {
  if (!c) return c;
  if (c === 'transparent') return 'rgba(0, 0, 0, 0)';
  const hex = c.match(/^#?([0-9a-f]{6})$/i);
  if (!hex) return c.replace(/\s*,\s*/g, ', ');
  const n = parseInt(hex[1], 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

export function hexToRgb(h) {
  const n = parseInt(String(h).slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

// key=value lines, '#' comments skipped. The format of a .properties file.
export function readProps(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  );
}

// git, returning trimmed stdout lines; null when the command fails (unknown ref, not a repo).
export function git(args, { cwd } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean);
  } catch {
    return null;
  }
}

export const gitOne = (args, opts) => git(args, opts)?.[0] ?? null;

// The local calendar date of a Date as YYYY-MM-DD (the person's day, not UTC's): standing rows,
// asks and escapes are dated the way the person reading them counts days.
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// qa/<slug>/ is committed, but what a run regenerates is not: the logs, the pictures, the reports and the publish
// records stay out of git. The runner writes this .gitignore into the folder (made when missing).
// qa/<slug>/ is committed with the branch (the verdict, the plan, the expectations), but a file in it is not a change to
// the product: the changed-file lists that planning, mutants and security read leave it out. qa/map/ is an input, so it stays.
export const isProductChange = (file) => !/^qa\/(?!map\/)[^/]+\/[^/]/.test(file);

export const V_IGNORED = Object.freeze(['logs/', 'shots/', 'agents/', 'prev/', 'report.html', 'artifact-*.html', 'publish.json', 'published.json', 'verify.log']);
export function ensureVGitignore(V) {
  fs.mkdirSync(V, { recursive: true });
  const file = `${V}/.gitignore`;
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = V_IGNORED.filter((l) => !have.has(l));
  if (missing.length) fs.writeFileSync(file, `${cur && !cur.endsWith('\n') ? `${cur}\n` : cur}${missing.join('\n')}\n`);
}
