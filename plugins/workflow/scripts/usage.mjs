#!/usr/bin/env node
// What a session spent, by agent and by model, read from Claude Code's own transcripts, so the
// workflow can be tuned on measurements. Run it before a handoff or a PR:
//
//   node <plugin>/scripts/usage.mjs                 the newest session in this project: a table on stdout
//   node <plugin>/scripts/usage.mjs --log <slice>   and upsert its row in docs/usage.md, tagged with the slice
//   node <plugin>/scripts/usage.mjs --session <id>  a given session
//
// Transcripts live in ~/.claude/projects/<project>/, one .jsonl per session and one per subagent
// under <session>/subagents/, with a .meta.json naming its type. They go when the cloud VM does,
// so a session that never ran this leaves no row.
//
// The dollar column is an API-price equivalent, a proxy for the share of the plan's quota a part of
// the work used, not a bill. Prices per million tokens; cache writes are multiples of input, cache reads
// have their own price.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// $ per million tokens: [model, input, output, cache read]. List prices of 6 Oct 2026. First match wins; a family alone is its
// current generation; an unknown model is priced as Opus 5.5. Haiku 5.5 above 100K prompt tokens is not told apart.
export const PRICES = [
  [/fable|mythos/i, 10, 50, 0.25],
  [/opus-5-5/i, 4, 20, 0.2], [/opus-(5|4)/i, 5, 25, 0.5], [/opus/i, 4, 20, 0.2],
  [/sonnet-5/i, 2, 10, 0.2], [/sonnet-4|sonnet-3/i, 3, 15, 0.3], [/sonnet/i, 2, 10, 0.2],
  [/haiku-5/i, 0.1, 0.5, 0.01], [/haiku-4|haiku-3/i, 1, 5, 0.1], [/haiku/i, 0.1, 0.5, 0.01],
];
export function priceOf(model = '') { const p = PRICES.find(([re]) => re.test(model || '')) ?? PRICES[1]; return { in: p[1], out: p[2], read: p[3] }; }
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;

// The families of the "By model" split; any other model is 'other'.
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const family = (model = '') => FAMILIES.find((f) => model.includes(f)) ?? 'other';

// An advisor consult rides inside the executor's message: usage.iterations[] entries of type 'advisor_message', each
// with its own model and token counts, none of them in the message's top-level usage (measured 2026-11-12: the
// top level is the sum of the 'message' iterations). One call each: { model, input, cacheWrite5m, cacheWrite1h,
// cacheRead, output }.
export const advisorCalls = (usage) => (Array.isArray(usage?.iterations) ? usage.iterations : [])
  .filter((it) => it?.type === 'advisor_message')
  .map((it) => ({ model: it.model ?? 'unknown', ...tokens(it), output: it.output_tokens ?? 0 }));

// Input and cache tokens of one usage object; cache writes split 5m/1h when it says so, else all 5m.
function tokens(u) {
  const total = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  return { input: u.input_tokens ?? 0, cacheWrite5m: w5m || w1h ? w5m : total, cacheWrite1h: w1h, cacheRead: u.cache_read_input_tokens ?? 0 };
}

// The context one call carried: input + cache read + cache write of its largest executor pass (a message with an
// advisor consult runs the executor twice, and its top-level usage sums both).
export function contextOf(usage) {
  const size = (u) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const passes = (Array.isArray(usage?.iterations) ? usage.iterations : []).filter((it) => it?.type === 'message');
  return passes.length ? Math.max(...passes.map(size)) : size(usage ?? {});
}

// One advisor consult's dollars, priced by its own model (not the session's): the same rates as the executor's.
const advisorUsd = (a) => {
  const p = priceOf(a.model);
  return (a.input * p.in + a.cacheRead * p.read + a.cacheWrite5m * p.in * CACHE_WRITE_5M + a.cacheWrite1h * p.in * CACHE_WRITE_1H
    + a.output * p.out) / 1e6;
};

/**
 * Totals for one transcript: one entry per API message (a streamed message is logged more than once), plus the
 * advisor consults inside those messages (advisor: { calls, usd, models }), the largest context of any message
 * (maxContext) and the count of compactions (compact_boundary lines). `usd` includes the advisor consults.
 */
export function readTranscript(file) {
  const byMessage = new Map();
  let first, last;
  let compactions = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') compactions++;
    if (d.timestamp) {
      first ??= d.timestamp;
      last = d.timestamp;
    }
    const m = d.message;
    if (d.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
    // A message's blocks arrive as separate entries; a subagent's usage is the stream's start, whose
    // output count is a placeholder, so its output is estimated from what it wrote (about 4 chars a token)
    const key = m.id ?? d.uuid;
    const prev = byMessage.get(key);
    const chars = (m.content ?? []).reduce(
      (n, c) => n + (c.text?.length ?? 0) + (c.thinking?.length ?? 0) + (c.input ? JSON.stringify(c.input).length : 0),
      0,
    );
    byMessage.set(key, { model: m.model, u: m.usage, chars: (prev?.chars ?? 0) + chars });
  }
  const t = {
    estimated: false,
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    usd: 0,
    models: new Set(),
    advisor: { calls: 0, usd: 0, models: new Set() },
    maxContext: 0,
    compactions,
  };
  for (const { model, u: raw, chars } of byMessage.values()) {
    const p = priceOf(model);
    const guess = Math.round(chars / 4);
    if (guess > (raw.output_tokens ?? 0)) t.estimated = true;
    const u = { ...raw, output_tokens: Math.max(raw.output_tokens ?? 0, guess) };
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = (u.cache_creation_input_tokens ?? 0) - w1h;
    t.turns++;
    t.models.add(model);
    t.input += u.input_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.usd +=
      ((u.input_tokens ?? 0) * p.in +
        (u.cache_read_input_tokens ?? 0) * p.read +
        w5m * p.in * CACHE_WRITE_5M +
        w1h * p.in * CACHE_WRITE_1H +
        (u.output_tokens ?? 0) * p.out) /
      1e6;
    t.maxContext = Math.max(t.maxContext, contextOf(raw));
    for (const a of advisorCalls(raw)) {
      const usd = advisorUsd(a);
      t.advisor.calls++;
      t.advisor.usd += usd;
      t.advisor.models.add(a.model); // not in t.models: that set is the executor's
      t.usd += usd;
    }
  }
  t.minutes = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : 0;
  return t;
}

const k = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1e3)}k`);
const usd = (n) => `$${Math.round(n * 100) / 100}`;
const short = (models) => [...models].map((m) => m.replace(/^claude-/, '')).join(', ');

export function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const repo = process.cwd();
  const dir = join(homedir(), '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  if (!existsSync(dir)) {
    console.error(`No transcripts at ${dir}`);
    process.exit(1);
  }
  const session =
    flag('--session') ??
    readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: basename(f, '.jsonl'), t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.id;
  if (!session) {
    console.error('No session found');
    process.exit(1);
  }

  const rows = [{ who: 'main', what: 'the main session', ...readTranscript(join(dir, `${session}.jsonl`)) }];
  const subs = join(dir, session, 'subagents');
  if (existsSync(subs))
    for (const f of readdirSync(subs).filter((f) => f.endsWith('.jsonl'))) {
      const metaFile = join(subs, f.replace(/\.jsonl$/, '.meta.json'));
      const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
      rows.push({
        who: meta.agentType ?? 'agent',
        what: meta.description ?? basename(f, '.jsonl'),
        ...readTranscript(join(subs, f)),
      });
    }

  console.log(`Session ${session}\n`);
  console.log(
    '| Agent | Task | Model | Turns | Minutes | Input | Cache read | Cache write | Output | Largest context | Advisor | API-price equivalent |',
  );
  console.log('|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of rows)
    console.log(
      `| ${r.who} | ${r.what} | ${short(r.models)} | ${r.turns} | ${r.minutes} | ${k(r.input)} | ${k(r.cacheRead)} | ${k(r.cacheWrite)} | ${r.estimated ? '≈' : ''}${k(r.output)} | ${k(r.maxContext)} | ${r.advisor.calls > 0 ? `${r.advisor.calls} · ${usd(r.advisor.usd)}` : ''} | ${usd(r.usd)} |`,
    );

  // A row's own dollars (its total less its advisor consults) go to its models; the advisor's go to the advisor's.
  const byFamily = {};
  for (const r of rows) {
    for (const m of r.models) byFamily[family(m)] = (byFamily[family(m)] ?? 0) + (r.usd - r.advisor.usd) / r.models.size;
    for (const m of r.advisor.models) byFamily[family(m)] = (byFamily[family(m)] ?? 0) + r.advisor.usd / r.advisor.models.size;
  }
  const total = rows.reduce((s, r) => s + r.usd, 0);
  const advisorCount = rows.reduce((s, r) => s + r.advisor.calls, 0);
  const advisorTotal = rows.reduce((s, r) => s + r.advisor.usd, 0);
  const split = Object.entries(byFamily)
    .sort((a, b) => b[1] - a[1])
    .map(([f, v]) => `${f} ${Math.round((v / total) * 100)}%`)
    .join(', ');
  const advisorSentence = advisorCount > 0 ? ` Advisor ${usd(advisorTotal)} in ${advisorCount} consults (inside the rows above).` : '';
  console.log(
    `\nTotal ${usd(total)}: ${split}.${advisorSentence} Main session: largest context ${k(rows[0].maxContext)}, ${rows[0].compactions} compaction(s). ≈ is output estimated from what the agent wrote.`,
  );

  const slice = flag('--log');
  if (slice) {
    const log = join(repo, 'docs', 'usage.md');
    const date = new Date().toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      // the project's own time zone, if it sets one (USAGE_TZ=Asia/Kuala_Lumpur), else the machine's
      timeZone: process.env.USAGE_TZ || undefined,
    });
    const groups = new Map();
    for (const r of rows.slice(1)) {
      const g = `${r.who} on ${short(r.models)}`;
      const v = groups.get(g) ?? { n: 0, usd: 0 };
      groups.set(g, { n: v.n + 1, usd: v.usd + r.usd });
    }
    const agents = [...groups].map(([g, v]) => `${v.n}× ${g} ${usd(v.usd)}`).join('; ');
    const mainCell =
      rows[0].advisor.usd > 0 ? `${usd(rows[0].usd)} (incl. advisor ${usd(rows[0].advisor.usd)})` : usd(rows[0].usd);
    const row = `| ${date} | ${slice} | \`${session.slice(0, 8)}\` | ${mainCell} | ${agents || 'none'} | ${usd(total)} | ${split} |`;
    // the first --log creates the file, with its header
    if (!existsSync(log)) {
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(
        log,
        [
          '# Usage by session',
          '',
          'One row per session, written by the workflow plugin `scripts/usage.mjs --log <slice>` before a handoff or a PR.',
          "The dollar figures are API-price equivalents, a proxy for the share of the plan's quota each part",
          'used, not a bill. Read it when tuning which model does what.',
          '',
          '| Date | Slice | Session | Main | Subagents | Total | By model |',
          '|---|---|---|--:|---|--:|---|',
          '',
        ].join('\n'),
      );
    }
    const lines = readFileSync(log, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes(`\`${session.slice(0, 8)}\``));
    if (at >= 0) lines[at] = row;
    else {
      const end = lines.findLastIndex((l) => l.startsWith('|'));
      lines.splice(end + 1, 0, row);
    }
    writeFileSync(log, lines.join('\n'));
    console.log(`\n${at >= 0 ? 'Updated' : 'Added'} its row in docs/usage.md`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
