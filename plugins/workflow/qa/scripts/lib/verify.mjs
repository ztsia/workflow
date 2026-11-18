// `qa verify` (rework U10, design §13 D38, §14, §17 answer 1): one command runs a whole verify round — the verify
// skill's steps 1–7 and step 8 short of the Artifact tool — and starts the mapper, the planner, the security review,
// the eyes and the judge itself as headless Claude sessions (headless.mjs). The session starts it, waits for its one
// completion notice and reads its last line. Every rule, exit code and send-back is the skill's: this file only puts
// them in order. The agents never wait for anything: the script runs `qa run`, the prepare check and the plan
// check, and hands each agent finished files.
//
// CONTRACT (tests: test/verify.test.mjs — the qa steps a recorded fake, `claude` the fake at
// test/fixtures/fake-claude.mjs through the real runHeadless; the CLI on a small repo up to the round)
//
//   verifyRound(o, d) -> Promise<{ exit, line, lines, json }>
//     o: { root (the checkout), mainRoot, pluginDir, cli (bin/qa: what the agents run), spec, onto, security, full,
//          record (journeys|all|none|null), until (UNTIL|null), agents (qa.json agents over the defaults) }
//     d: { step(argv) -> Promise<{ code, stdout, stderr }> (one qa command, cwd root), claude(callOpts) -> Promise<Call>
//          (default runHeadless with QA_CLAUDE), headSha(), originBase() (merge-base of HEAD and origin/HEAD, or null),
//          say(line) (progress), now() }
//     lines: what the CLI prints on stdout; the last is the outcome — line 1 of V/verdict.md, a hand-over line, a NOT RUN
//       line or a stopped line. Before it: the Report line (or 'report: <path>'), the PR comment's line, 'costs: …' of this
//       head's headless sessions, the 'project not proven ready' line, and for a session that should publish 'publish: run
//       step 8 (Artifact tool), then <its then>, then qa report comment'.
//     VERIFY_EXIT: ACCEPT 0 · REJECT 1 · NEEDS YOU 2 · NOT RUN 3 · BLOCKED 4 · hand over 5 · usage 64; --until stops with 0.
//
//   The round, in order (n is the skill's step):
//     1 resolve [--spec] [--onto] -> the Target. base.sha null -> NOT RUN 'base <ref> is not in this repo …'. No spec
//       (and no V/spec.md) -> NOT RUN 'no spec: write the acceptance criteria to <V>/spec.md …'. `ready status`: its
//       'project not proven ready: …' line is kept for the end; it never blocks.
//     2 V/verdict.md for HEAD already, and no --full: `verdict waivers` first (the user's new waivers, by script, no
//       run): exit 1 -> hand over at 2. Line 1 (after them) still BLOCKED -> again from 3, the round of V/round.json
//       standing (a whole-run block — no sandbox, the prepare check — is never waived row by row).
//       Else exit 0 -> report build, 8; exit 3 (no waivers) -> line 1 is the answer (a missing report.html is built
//       first: check, build, 8). Else (no verdict for HEAD, or --full: a full round again, whose `round plan --full`
//       moves that verdict's round files to V/prev) `round plan --slug --base <sha> --map [--seed-names] --spec <path>
//       [--full]`; V/round.json says full or incremental.
//     3 New screens (not in suites mode): `qa affected --base <sha> --map … --json` names the changed UI files no map entry
//       walks (`unmapped`); none -> go on. Some -> `sandbox up --at HEAD` (its appUrl; no appUrl -> one line, go on), then
//       one headless mapper `phase: prepare` (cli, base, spec, roles, url, `check: script …`, the files). A mapper that
//       fails -> one line, go on. A QA file it changed counts as a repair (below).
//     3 `prepare check` 0|3 go on; 1 -> one headless mapper `phase: repair` with the lines of prepare.md that start '- ['
//       but not '- [stub:' (none: no mapper), the head sandbox's url (`sandbox status` of the sandbox prepare.md names),
//       `check: script …`; then `prepare check --final`; 4 -> `--final` once. --final 0|3 go on; 1|4 -> its BLOCKED
//       verdict: report build, 8. A repair that changed any QA file of the PR (the branch's qa/ and map) re-plans the round for this head: `round plan … --replan [--full]` (the entries the
//       mapper changed then re-run), and V/round.json is read again. A new-screen mapper that changed one re-plans the
//       same way, also when the prepare check then passes.
//       Plan (a full round, or no V/charter.md): headless planner `phase: plan`. No fresh charter.md, or its return says its map check
//       failed -> that line once, by resuming its session; still so -> hand over at 3 (plan). `plan check`: 3 -> the line
//       once (resume), check again, 3 again -> hand over; 1 -> the lines starting '- [', '- mut:' or '- stub:' ONCE
//       (resume), 'fix these in …', then `plan check --drop`, whatever it says; 4 -> its blocked line, go on.
//     4 Security: a full round when the charter says `security: yes`, --security or --full; an incremental one when
//       V/round.json security.rerun or --security. Every call runs as the agent workflow:qa-security with SECURITY_TOOLS (the
//       write-up adds Write); a full round that skips it leaves the earlier V/security.md to the run, which moves it
//       to V/prev. The native review (`claude -p "/security-review"`, which diffs
//       origin/HEAD...) when origin/HEAD's merge-base is the base; else, or when that command could not run (0 turns, a
//       'Shell command failed' answer), a headless session told to review `git diff <base>...HEAD` the same way. Then
//       the same session (resumed, Write allowed) writes V/security.md; none fresh -> hand over at 4.
//     5 `run --base <sha> --slug --map [--seed-names] [--full] [--record]`: 4 -> its BLOCKED verdict: report build, 8;
//       64 -> usage; 0–3 with results.json for HEAD go on.
//     6 `eyes prompt`: a path -> headless eyes `Read <path> and do what it says.` (no fresh eyes.md -> hand over), then
//       `eyes merge`; 'no new screenshot' -> no pass; either way `verdict draft`. 'no changed or new screen' -> skip.
//     7 Headless judge `phase: judge` (round, cost-plan, cost-eyes, waivers when there are). No fresh verdict.md for
//       HEAD -> hand over. The cost line is rewritten with this head's numbers. `report build --check`: 1 -> the rule
//       lines once (resume), check again; 1 again -> hand over at 7. Then `report build`.
//     8 `report where --json`: publish -> the publish line, no comment (it would go up before the report's URL); else
//       `report comment`.
//   A step that crashed (a 'FAIL: ' line on stderr) or answered an exit no rule names -> '<step> failed (exit <n>): <why>
//   — continue by hand from step <n>' (exit 5). A headless call that failed -> 'headless <role> failed: <why> — continue
//   by hand from step <n>' (exit 5). Every file stays where it is, so the hand-driven steps go on from there.
//
//   QA files (1.0.3): resolve's qaFiles { from: 'checkout' | 'main tree' } plus its map go into V/run.json as
//   qaFiles right after step 1, so every verdict names where the QA files were read from.
//   Costs: each call is recorded in V/run.json (read-merge-write): agents = { head, calls: [{ role, n, session, model, ok,
//   why, usd, turns, ms, tokens, at }] } (another head's calls are dropped first), and cost-mapper, cost-plan,
//   cost-security, cost-eyes, cost-judge = per role, the sum over its sessions of each session's total (a resumed
//   session counts once, at its last total). V/verify.log keeps every step's argv, exit and output, and each call.
//   costLine(costs) -> 'cost: plan $a · eyes $b · judge $c[ · mapper $m][ · security $s] · runner 0 · total $t'
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, SECURITY_TOOLS, agentToolsOf, claudeBin, roleConfig, runHeadless } from './headless.mjs';
import { parseVerdict } from './verdict.mjs';
import { ensureVGitignore } from './util.mjs';
import { loadProfile } from './profile.mjs';
import { suitesModeApplies } from './suitesmode.mjs';

export const VERIFY_EXIT = Object.freeze({ ACCEPT: 0, REJECT: 1, 'NEEDS YOU': 2, notRun: 3, BLOCKED: 4, handover: 5, usage: 64 });
export const UNTIL = Object.freeze(['resolve', 'round', 'prepare', 'plan', 'security', 'run', 'eyes', 'judge']);
export const COST_KEYS = Object.freeze({ mapper: 'cost-mapper', planner: 'cost-plan', security: 'cost-security', eyes: 'cost-eyes', judge: 'cost-judge' });

class Stop extends Error {
  constructor(exit, line, kind) {
    super(line);
    this.exit = exit;
    this.line = line;
    this.kind = kind;
  }
}

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const usd = (n) => `$${(n ?? 0).toFixed(2)}`;
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`); };
const outside = (root, p) => { const rel = path.relative(root, p); return rel.startsWith('..') || path.isAbsolute(rel); };
const crashed = (r) => /^FAIL: /m.test(r.stderr ?? '');
const whyOf = (r) => firstLine((r.stderr ?? '').split('\n').find((l) => l.startsWith('FAIL: '))) || firstLine(r.stderr) || firstLine(r.stdout) || 'no output';

// ── costs ─────────────────────────────────────────────────────────────────────

// Per role, each session's last total (claude -p reports a resumed session's cost so far), summed over sessions.
export function costsOf(calls = []) {
  const bySession = new Map();
  calls.forEach((c, i) => {
    const key = `${c.role}\u0000${c.session ?? `#${i}`}`;
    bySession.set(key, { role: c.role, usd: Math.max(bySession.get(key)?.usd ?? 0, c.usd ?? 0) });
  });
  const out = Object.fromEntries(Object.keys(COST_KEYS).map((r) => [r, 0]));
  for (const { role, usd: u } of bySession.values()) if (role in out) out[role] += u;
  for (const r of Object.keys(out)) out[r] = r4(out[r]);
  return out;
}

export function recordCall(V, call, head, at = new Date().toISOString()) {
  const file = path.join(V, 'run.json');
  const cur = readJson(file) ?? {};
  const agents = cur.agents?.head === head ? { head, calls: [...(cur.agents.calls ?? [])] } : { head, calls: [] };
  agents.calls.push({
    role: call.role, n: call.n, session: call.session, model: call.models?.[0] ?? null, ok: call.ok, why: call.why,
    usd: call.usd, turns: call.turns, ms: call.ms, tokens: call.tokens, at,
  });
  const costs = costsOf(agents.calls);
  writeJson(file, { ...cur, agents, ...Object.fromEntries(Object.entries(COST_KEYS).map(([r, k]) => [k, costs[r]])) });
  return costs;
}

// This head's calls, or none.
function headCalls(V, head) {
  const a = readJson(path.join(V, 'run.json'))?.agents;
  return a?.head === head ? a.calls ?? [] : [];
}

export function costLine(costs, ran = new Set()) {
  const total = Object.values(costs).reduce((s, n) => s + n, 0);
  const extra = ['mapper', 'security'].filter((r) => ran.has(r)).map((r) => ` · ${r} ${usd(costs[r])}`).join('');
  return `cost: plan ${usd(costs.planner)} · eyes ${usd(costs.eyes)} · judge ${usd(costs.judge)}${extra} · runner 0 · total ${usd(total)}`;
}

function costsSummary(calls) {
  if (!calls.length) return null;
  const costs = costsOf(calls);
  const ran = new Set(calls.map((c) => c.role));
  const parts = Object.keys(COST_KEYS).filter((r) => ran.has(r)).map((r) => `${r} ${usd(costs[r])}`);
  const total = Object.values(costs).reduce((s, n) => s + n, 0);
  return `costs: ${parts.join(' · ')} · total ${usd(total)} (this head, headless sessions, API-price equivalent)`;
}

// The verdict's cost line, with this head's numbers (the judge is told plan and eyes; its own it cannot know).
function fillCost(c) {
  const file = path.join(c.V, 'verdict.md');
  const md = readText(file);
  if (md === null) return;
  const calls = headCalls(c.V, c.head);
  const line = costLine(costsOf(calls), new Set(calls.map((x) => x.role)));
  const lines = md.split('\n');
  const at = lines.findLastIndex((l) => l.startsWith('cost: '));
  if (at < 0) return;
  lines[at] = line;
  fs.writeFileSync(file, lines.join('\n'));
}

// ── the round ─────────────────────────────────────────────────────────────────

const STEP = {
  resolve: '1 (resolve)', round: '2 (round)', prepare: '3 (prepare check)', plan: '3 (plan)', planCheck: '3 (plan check)',
  security: '4 (security)', run: '5 (run)', eyes: '6 (eyes)', judge: '7 (judge)', report: '8 (report)',
};

export async function verifyRound(o, deps = {}) {
  const d = {
    claude: (call) => runHeadless({ ...call, bin: claudeBin() }),
    say: () => {},
    now: () => Date.now(),
    originBase: () => null,
    ...deps,
  };
  const c = { o, d, log: [], V: null, t: null, slug: null, head: null, spec: null, full: true, round: null, ready: null, where: null, comment: null, addDirs: [], repaired: false };
  try {
    await flow(c);
    return finish(c, outcome(c));
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return finish(c, e);
  }
}

function log(c, text) {
  if (c.V) fs.appendFileSync(path.join(c.V, 'verify.log'), `${text}\n`);
  else c.log.push(text);
}

async function step(c, no, label, argv) {
  const t0 = c.d.now();
  const r = { code: 0, stdout: '', stderr: '', ...(await c.d.step(argv)) };
  log(c, `== [${no}] ${label} · exit ${r.code} · ${Math.round((c.d.now() - t0) / 1000)} s ==\n$ qa ${argv.join(' ')}\n${r.stdout}${r.stderr ? `--- stderr\n${r.stderr}` : ''}`);
  const head = firstLine(r.stdout);
  c.d.say(`[${no}] ${label}: exit ${r.code}${head && !/^[[{]$/.test(head) ? ` — ${head.slice(0, 160)}` : ''}`);
  return r;
}

const failed = (label, r, from) => new Stop(VERIFY_EXIT.handover, `${label} failed (exit ${r.code}): ${whyOf(r)} — continue by hand from step ${from}`, 'handover');
const handover = (role, why, from) => new Stop(VERIFY_EXIT.handover, `headless ${role} failed: ${why} — continue by hand from step ${from}`, 'handover');
const notRun = (why) => new Stop(VERIFY_EXIT.notRun, `NOT RUN: ${why}`, 'notRun');
const usage = (r) => new Stop(VERIFY_EXIT.usage, firstLine(r.stderr) || firstLine(r.stdout) || 'usage error', 'usage');

function until(c, name, next) {
  if (c.o.until === name) throw new Stop(0, `stopped after ${name} (--until ${name}) — continue by hand from step ${next}`, 'until');
}

// A file the agent wrote in this call (not one an earlier round left).
const fresh = (file, t0) => fs.existsSync(file) && fs.statSync(file).mtimeMs >= t0 - 1000;

async function headless(c, role, { prompt, resume = null, from, tools = null, addDirs = [] }) {
  const cfg = roleConfig(c.o.agents, role);
  const agent = ROLES[role].agent;
  const allowed = tools ?? agentToolsOf(c.o.pluginDir, agent);
  const call = await c.d.claude({
    role, prompt, resume, cwd: c.o.root, dir: path.join(c.V, 'agents'), pluginDir: c.o.pluginDir, agent, model: cfg.model,
    tools: allowed, timeoutMs: cfg.timeoutMs, addDirs: [...new Set([...c.addDirs, ...addDirs])],
  });
  recordCall(c.V, call, c.head);
  const note = `headless ${role}${resume ? ' (resumed)' : ''} (${cfg.model}): ${call.ok ? 'ok' : `FAILED — ${call.why}`}${call.usd != null ? ` · session $${call.usd.toFixed(2)}` : ''}${call.turns != null ? ` · ${call.turns} turns` : ''} · ${Math.round(call.ms / 1000)} s · ${call.out}`;
  log(c, `== [${from}] ${note} ==`);
  c.d.say(`[${from.split(' ')[0]}] ${note}`);
  if (!call.ok) throw handover(role, call.why, from);
  return call;
}

async function flow(c) {
  await resolve(c);
  until(c, 'resolve', STEP.round);
  const start = await roundOf(c);
  if (start === 'done') return;
  if (start === 'report') { await checkAndBuild(c); await place(c); return; }
  if (start === 'prepare') {
    until(c, 'round', STEP.prepare);
    if (await prepare(c)) { await build(c); await place(c); return; }
    until(c, 'prepare', planned(c) ? STEP.plan : STEP.security);
    if (planned(c)) await plan(c);
    until(c, 'plan', STEP.security);
    await security(c);
    until(c, 'security', STEP.run);
  }
  if (await run(c)) { await build(c); await place(c); return; }
  until(c, 'run', STEP.eyes);
  await eyes(c);
  until(c, 'eyes', STEP.judge);
  await judge(c);
  until(c, 'judge', STEP.report);
  await place(c);
}

// 1 ── resolve, and is the project proven ready
async function resolve(c) {
  const { o } = c;
  const r = await step(c, '1', 'resolve', ['resolve', ...(o.spec ? ['--spec', o.spec] : []), ...(o.onto ? ['--onto', o.onto] : [])]);
  if (r.code === VERIFY_EXIT.usage) throw usage(r);
  if (r.code === 3) throw notRun(firstLine(r.stderr) || firstLine(r.stdout));
  if (r.code !== 0 || crashed(r)) throw failed('resolve', r, STEP.resolve);
  let t;
  try { t = JSON.parse(r.stdout); } catch { throw failed('resolve', { ...r, stderr: `not a Target: ${firstLine(r.stdout)}` }, STEP.resolve); }
  c.t = t;
  c.slug = t.slug;
  c.V = path.join(o.root, t.verification ?? path.join('qa', t.slug));
  ensureVGitignore(c.V);
  fs.appendFileSync(path.join(c.V, 'verify.log'), `\n######## qa verify · ${new Date(c.d.now()).toISOString()}\n${c.log.join('\n')}\n`);
  c.log = [];
  c.head = c.d.headSha();
  // Which QA files this verify reads (1.0.3): the checkout's or the main tree's, kept in V/run.json (the runner keeps
  // keys it does not write).
  if (t.qaFiles) {
    const file = path.join(c.V, 'run.json');
    writeJson(file, { ...(readJson(file) ?? {}), qaFiles: { ...t.qaFiles, map: t.map ?? null } });
  }
  for (const w of r.stderr.split('\n').filter((l) => l.startsWith('warning: '))) c.d.say(w);
  c.d.say(`[1] ${t.slug} · base ${t.base?.ref ?? '?'} · spec ${t.spec?.path ?? 'none'}`);
  if (!t.base?.sha) throw notRun(`base ${t.base?.ref ?? '(none)'} is not in this repo: fetch it, or pass --onto <ref>`);
  if (t.spec?.path) {
    c.spec = path.resolve(o.root, t.spec.path);
    if (!fs.existsSync(c.spec)) throw notRun(`spec ${t.spec.path} does not exist`);
  } else if (fs.existsSync(path.join(c.V, 'spec.md'))) c.spec = path.join(c.V, 'spec.md');
  else throw notRun(`no spec: write the acceptance criteria to ${path.join(c.V, 'spec.md')} (or pass --spec <file>), then run qa verify again`);
  const ready = await step(c, '1', 'ready status', ['ready', 'status']);
  c.ready = ready.stdout.split('\n').find((l) => l.startsWith('project not proven ready:')) ?? null;
  if (c.ready) c.d.say(`warning: ${c.ready}`);
}

const seedArgs = (c) => (c.t.seedNames ? ['--seed-names', c.t.seedNames] : []);
const mapArgs = (c) => (c.t.map ? ['--map', c.t.map] : []);

// 2 ── the round: this head verified already (its waivers, or a BLOCKED round again), or a new round's plan
async function roundOf(c) {
  const V = c.V;
  const md = readText(path.join(V, 'verdict.md'));
  const v = md === null ? null : parseVerdict(md);
  // --full on a head that already has a verdict is a full round again: round plan --full moves that verdict's files.
  if (v?.head && v.head === c.head && !c.o.full) {
    c.round = readJson(path.join(V, 'round.json'));
    if (c.round?.head !== c.head) c.round = null;
    c.full = c.round?.of !== 'incremental';
    // The user's new waivers first, by script and with no run; only a verdict still BLOCKED after them runs again.
    const w = await step(c, '2', 'verdict waivers', ['verdict', 'waivers', '--slug', c.slug]);
    if (w.code === 1 && !crashed(w)) throw new Stop(VERIFY_EXIT.handover, `verdict waivers refused: ${firstLine(w.stdout)} — continue by hand from step ${STEP.round}`, 'handover');
    if (![0, 3].includes(w.code) || crashed(w)) throw failed('verdict waivers', w, STEP.round);
    const now = w.code === 0 ? parseVerdict(readText(path.join(V, 'verdict.md')) ?? '') : v;
    if (now.verdict === 'BLOCKED') {
      c.d.say('[2] this head is BLOCKED: again from step 3 (the prepare check)');
      log(c, '== [2] this head is BLOCKED: again from step 3 (prepare check) ==');
      return 'prepare';
    }
    if (w.code === 0) { await build(c); await place(c); return 'done'; }
    return fs.existsSync(path.join(V, 'report.html')) ? 'done' : 'report';
  }
  const r = await step(c, '2', 'round plan', ['round', 'plan', ...roundArgs(c), ...(c.o.full ? ['--full'] : [])]);
  if (r.code === VERIFY_EXIT.usage) throw usage(r);
  if (r.code !== 0 || crashed(r)) throw failed('round plan', r, STEP.round);
  readRound(c, r, STEP.round, 'round plan');
  return 'prepare';
}

const roundArgs = (c) => ['--slug', c.slug, '--base', c.t.base.sha, ...mapArgs(c), ...seedArgs(c), '--spec', c.spec];

function readRound(c, r, from, label) {
  c.round = readJson(path.join(c.V, 'round.json'));
  if (c.round?.head !== c.head) throw failed(label, { ...r, stderr: `no round.json for ${c.head.slice(0, 12)}` }, from);
  c.full = c.round.of !== 'incremental';
}

// The planner runs in a full round, and in any round that has no charter to carry.
const planned = (c) => c.full || !fs.existsSync(path.join(c.V, 'charter.md'));

// The PR's QA files the mapper repairs: qa/ and the map in the branch (the slug's own folder, where the run writes,
// is left out). One hash of every file's path and bytes, so a repair that changed any of them is seen.
function qaState(c) {
  const dirs = [...new Set([path.join(c.o.root, 'qa'), c.t.map].filter(Boolean))];
  const h = createHash('sha1');
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) { if (file !== c.V) walk(file); }
      else if (e.isFile()) { h.update(`${file}\0`); h.update(fs.readFileSync(file)); h.update('\0'); }
    }
  };
  for (const d of dirs) walk(d);
  return h.digest('hex');
}

const problemLines = (md) => String(md ?? '').split('\n').filter((l) => l.startsWith('- ['));

const jsonOf = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; } };

// The checkout's qa.json, as qa.mjs reads it for the same root; none -> {}.
function profileOf(c) {
  try { return loadProfile(c.o.mainRoot ?? c.o.root).profile; } catch { return {}; }
}

// 3 ── the new screens: a changed UI file that no map entry walks is never seen by the run, so the mapper writes its
// entries before the prepare check. Suites mode has no screens to map. Only the mapper's own handover is swallowed.
async function mapNew(c) {
  const profile = profileOf(c);
  const mainRoot = c.o.mainRoot ?? c.o.root;
  if ((c.d.suitesMode ?? suitesModeApplies)({ repoRoot: c.o.root, mainRoot, profile, map: c.t.map ?? null }).applies) return;
  const a = await step(c, '3', 'affected', ['affected', '--base', c.t.base.sha, ...mapArgs(c), ...seedArgs(c), '--json']);
  const unmapped = a.code === 0 && !crashed(a) ? jsonOf(a.stdout)?.unmapped : undefined;
  if (!Array.isArray(unmapped)) {
    c.d.say(`[3] the new-screen check could not run: ${a.code === 0 && !crashed(a) ? 'its output is not a list' : whyOf(a)}`);
    return;
  }
  if (!unmapped.length) return;
  const up = await step(c, '3', 'sandbox up', ['sandbox', 'up', '--at', 'HEAD']);
  const url = up.code === 0 && !crashed(up) ? jsonOf(up.stdout)?.appUrl : null;
  if (!url) { c.d.say('[3] the new screens stay unmapped: the head sandbox did not come up'); return; }
  c.d.say(`[3] ${unmapped.length} changed UI file(s) no map entry walks: the mapper writes their entries`);
  const before = qaState(c);
  const roles = Object.keys(profile.login ?? {});
  let failure = null;
  try {
    await headless(c, 'mapper', { from: STEP.prepare, prompt: [
      'phase: prepare', `cli: ${c.o.cli}`, `base: ${c.t.base.sha}`, `spec: ${c.spec}`, `roles: ${roles.length ? roles.join(', ') : 'none'}`,
      `url: ${url}`,
      'check: script — qa verify runs the prepare check after you return: do not run it, and never start or wait on anything in the background',
      'targets: the changed files below that no map entry walks. Name the screens and routes they render from the router, and write their entries',
      '', ...unmapped.map((f) => `- ${f}`),
    ].join('\n') });
  } catch (e) {
    if (!(e instanceof Stop) || e.kind !== 'handover' || !e.line.startsWith('headless mapper failed: ')) throw e;
    failure = e.line.replace(/^headless mapper failed: /, '').replace(/ — continue by hand from step .*$/, '');
  }
  if (qaState(c) !== before) c.repaired = true;
  if (failure !== null) c.d.say(`[3] mapper (prepare) failed: ${failure} — the new screens stay unmapped`);
}

// 3 ── the new screens, then the prepare check, the mapper's one repair round; true when it ends the round BLOCKED
async function prepare(c) {
  await mapNew(c);
  const argv = ['prepare', 'check', '--slug', c.slug, '--base', c.t.base.sha, ...mapArgs(c), ...seedArgs(c)];
  const r = await step(c, '3', 'prepare check', argv);
  if (r.code === VERIFY_EXIT.usage) throw usage(r);
  if ((r.code === 0 || r.code === 3) && !crashed(r)) {
    if (c.repaired) await replan(c);
    return false;
  }
  if (r.code === 1 && !crashed(r)) {
    const md = readText(path.join(c.V, 'prepare.md'));
    const lines = problemLines(md).filter((l) => !l.startsWith('- [stub:'));
    if (lines.length) {
      const before = qaState(c);
      const url = await appUrl(c, md);
      await headless(c, 'mapper', { from: STEP.prepare, prompt: [
        'phase: repair', `cli: ${c.o.cli}`, `base: ${c.t.base.sha}`,
        url ? `url: ${url}` : 'url: none — no app is up: fix what needs none, and report the rest',
        'check: script — qa verify runs the prepare check after you return: do not run it, and never start or wait on anything in the background',
        '', ...lines,
      ].join('\n') });
      c.repaired = c.repaired || qaState(c) !== before;
    }
  } else if (r.code !== 4 || crashed(r)) throw failed('prepare check', r, STEP.prepare);
  const f = await step(c, '3', 'prepare check --final', [...argv, '--final']);
  if ((f.code === 0 || f.code === 3) && !crashed(f)) {
    if (c.repaired) await replan(c);
    return false;
  }
  if ((f.code === 1 || f.code === 4) && !crashed(f) && verdictHead(c) === c.head) return true;
  throw failed('prepare check --final', f, STEP.prepare);
}

// The mapper changed the PR's QA files: the round of this head is planned again, so the entries it changed re-run.
async function replan(c) {
  const r = await step(c, '3', 'round plan --replan', ['round', 'plan', ...roundArgs(c), '--replan', ...(c.o.full ? ['--full'] : [])]);
  if (r.code === VERIFY_EXIT.usage) throw usage(r);
  if (r.code !== 0 || crashed(r)) throw failed('round plan --replan', r, STEP.prepare);
  readRound(c, r, STEP.prepare, 'round plan --replan');
}

// The head sandbox the prepare check left up, for the mapper's probes and captures.
async function appUrl(c, prepareMd) {
  const name = /· sandbox (\S+) \(/.exec(String(prepareMd ?? '').split('\n')[1] ?? '')?.[1];
  if (!name) return null;
  const s = await step(c, '3', 'sandbox status', ['sandbox', 'status', name]);
  try { const d = JSON.parse(s.stdout); return d.alive === false ? null : d.appUrl ?? null; } catch { return null; }
}

function verdictHead(c) {
  const md = readText(path.join(c.V, 'verdict.md'));
  return md === null ? null : parseVerdict(md).head;
}

// The planner's return says its map check did not pass.
function mapCheckFailed(result) {
  const lines = String(result ?? '').split('\n').map((l) => l.trim());
  const failedLine = lines.find((l) => /map check (failed|error)/i.test(l));
  if (failedLine) return failedLine;
  const map = lines.find((l) => /^map:/i.test(l));
  return map && /map check/i.test(map) && !/map check ok/i.test(map) ? map : null;
}

// 3 ── the plan (full rounds), and the plan check with its one send-back
async function plan(c) {
  const V = c.V;
  const charter = path.join(V, 'charter.md');
  const t0 = c.d.now();
  let call = await headless(c, 'planner', { from: STEP.plan, prompt: [
    'phase: plan', `slug: ${c.slug}`, `V: ${V}`, `spec: ${c.spec}`, `base: ${c.t.base.ref}`, `head: ${c.head}`, `cli: ${c.o.cli}`,
    `record: ${c.o.record ?? 'journeys'}`,
  ].join('\n') });
  const session = call.session;
  const missing = !fresh(charter, t0);
  const mapFail = mapCheckFailed(call.result);
  if (missing || mapFail) {
    call = await headless(c, 'planner', { from: STEP.plan, resume: session, prompt: missing
      ? `${charter} is missing: write it, and ${path.join(V, 'expectations.json')}, as phase plan says, then return as it says.`
      : `Your map check did not pass: ${mapFail}. Fix your entries until qa map check exits 0, then return as phase plan says.` });
    if (!fresh(charter, t0)) throw handover('planner', 'no charter.md written after one send-back', STEP.plan);
    const still = mapCheckFailed(call.result);
    if (still) throw handover('planner', `the map check still fails after one send-back: ${still}`, STEP.plan);
  }
  const argv = ['plan', 'check', '--slug', c.slug, ...mapArgs(c), ...seedArgs(c)];
  let r = await step(c, '3', 'plan check', argv);
  if (r.code === 3 && !crashed(r)) {
    await headless(c, 'planner', { from: STEP.plan, resume: session, prompt: `${firstLine(r.stdout)}: write ${path.join(V, 'expectations.json')} as phase plan says, then return as it says.` });
    r = await step(c, '3', 'plan check', argv);
    if (r.code === 3 && !crashed(r)) throw handover('planner', 'no expectations.json written after one send-back', STEP.plan);
  }
  if (r.code === 1 && !crashed(r)) {
    const lines = String(readText(path.join(V, 'plan-check.md')) ?? r.stdout).split('\n')
      .filter((l) => l.startsWith('- [') || l.startsWith('- mut:') || l.startsWith('- stub:'));
    await headless(c, 'planner', { from: STEP.planCheck, resume: session, prompt: [
      'The plan check found these problems:', ...lines, '',
      `fix these in ${path.join(V, 'expectations.json')}, ${path.join(V, 'mutants.json')} and ${path.join(V, 'charter.md')}, then return as phase plan says (Plan check problems).`,
    ].join('\n') });
    r = await step(c, '3', 'plan check --drop', [...argv, '--drop']);
  }
  if (r.code === 4 && !crashed(r)) c.d.say(`[3] ${r.stdout.split('\n').find((l) => l.startsWith('blocked:')) ?? 'blocked: the head sandbox did not come up'}`);
  else if (![0, 1].includes(r.code) || crashed(r)) throw failed('plan check', r, STEP.planCheck);
}

// 4 ── the security review: native when origin/HEAD is the base, else the same review told its diff
async function security(c) {
  const { o, V } = c;
  const charter = readText(path.join(V, 'charter.md')) ?? '';
  const want = o.security || (c.full ? (o.full || /^security:\s*yes\b/m.test(charter)) : Boolean(c.round?.security?.rerun));
  if (!want) {
    const why = c.full ? 'the charter says security: no' : `carried — ${c.round?.security?.why ?? 'no sensitive path in the fix'}`;
    c.d.say(`[4] security: not run (${why})`);
    log(c, `== [4] security: not run (${why}) ==`);
    return;
  }
  const base = c.t.base.sha;
  const told = [
    `Review the security of the changes on this branch since ${base}: the diff is \`git diff ${base}...HEAD\` (origin/HEAD is not`,
    'this branch\'s base here, so the /security-review command would review the wrong diff). Do the review that command does: as a',
    'senior security engineer, report only high-confidence vulnerabilities this diff newly adds that could really be exploited',
    '(injection, an authentication or authorization bypass, a secret in code, unsafe deserialization, XSS, data exposure). Skip',
    'denial of service, rate limits, secrets stored on disk, style and theory. Read the diff, then the code around it as you need.',
    'Edit nothing. Answer with one line per finding (High, Medium or Low, what it is, file:line), or "No vulnerabilities found."',
  ].join('\n');
  const native = c.d.originBase() === base;
  let call = await headless(c, 'security', { from: STEP.security, tools: SECURITY_TOOLS, prompt: native ? '/security-review' : told });
  if (native && (call.turns === 0 || /^Shell command failed/m.test(call.result ?? ''))) {
    c.d.say('[4] the native /security-review could not run here: the same review, told its diff');
    call = await headless(c, 'security', { from: STEP.security, tools: SECURITY_TOOLS, prompt: told });
  }
  const file = path.join(V, 'security.md');
  const t0 = c.d.now();
  await headless(c, 'security', { from: STEP.security, resume: call.session, tools: [...SECURITY_TOOLS, 'Write'], prompt: [
    `Write ${file} with the findings of your review, in exactly this form and nothing else: line 1 \`# Security — ${c.slug}\`,`,
    'then one line per finding: `- High|Medium|Low [sec:<n>] <text> — <path>:<line>` (n from 1, in your order). With no',
    'findings, only line 1. Write no other file.',
  ].join('\n') });
  if (!fresh(file, t0) || !firstLine(readText(file)).startsWith('# Security — ')) throw handover('security', 'no security.md written', STEP.security);
}

// 5 ── the run; true when it ends the round BLOCKED (its verdict written by the run itself)
async function run(c) {
  const r = await step(c, '5', 'run', ['run', '--base', c.t.base.sha, '--slug', c.slug, ...mapArgs(c), ...seedArgs(c),
    ...(c.o.full ? ['--full'] : []), ...(c.o.record ? ['--record', c.o.record] : [])]);
  if (r.code === VERIFY_EXIT.usage) throw usage(r);
  if (r.code === 4 && !crashed(r) && verdictHead(c) === c.head) return true;
  const results = readJson(path.join(c.V, 'results.json'));
  if ([0, 1, 2, 3].includes(r.code) && !crashed(r) && results?.head?.sha === c.head) return false;
  throw failed('run', r, STEP.run);
}

// 6 ── the eyes pass on new screenshots only, then the redraft
async function eyes(c) {
  const r = await step(c, '6', 'eyes prompt', ['eyes', 'prompt', '--slug', c.slug]);
  if (r.code !== 0 || crashed(r)) throw failed('eyes prompt', r, STEP.eyes);
  const first = firstLine(r.stdout);
  if (first.startsWith('no changed or new screen')) return;
  if (!first.startsWith('no new screenshot')) {
    const file = path.join(c.V, 'eyes.md');
    const t0 = c.d.now();
    const shots = path.join(c.o.mainRoot ?? c.o.root, 'qa-artifacts');
    await headless(c, 'eyes', { from: STEP.eyes, prompt: `Read ${first} and do what it says.`, addDirs: outside(c.o.root, shots) ? [shots] : [] });
    if (!fresh(file, t0)) throw handover('eyes', 'no eyes.md written', STEP.eyes);
    const m = await step(c, '6', 'eyes merge', ['eyes', 'merge', '--slug', c.slug]);
    if (m.code !== 0 || crashed(m)) throw failed('eyes merge', m, STEP.eyes);
  }
  const dr = await step(c, '6', 'verdict draft', ['verdict', 'draft', '--slug', c.slug]);
  if (![0, 1].includes(dr.code) || crashed(dr)) throw failed('verdict draft', dr, STEP.eyes);
}

function waiversPath(c) {
  const mine = path.join(c.V, 'waivers.md');
  return fs.existsSync(mine) ? mine : null;
}

const ruleLines = (r) => r.stdout.split('\n').filter((l) => /^R\d+: /.test(l));

// 7 ── a fresh judge, the report check with its one send-back, the report
async function judge(c) {
  const V = c.V;
  const costs = costsOf(headCalls(V, c.head));
  const waivers = waiversPath(c);
  const t0 = c.d.now();
  const call = await headless(c, 'judge', { from: STEP.judge, prompt: [
    'phase: judge', `slug: ${c.slug}`, `V: ${V}`, `spec: ${c.spec}`, `base: ${c.t.base.ref}`, `head: ${c.head}`, `cli: ${c.o.cli}`,
    `round: ${c.round?.round ?? 1}`, `cost-plan: ${usd(costs.planner)}`, `cost-eyes: ${usd(costs.eyes)}`, ...(waivers ? [`waivers: ${waivers}`] : []),
  ].join('\n') });
  if (!fresh(path.join(V, 'verdict.md'), t0) || verdictHead(c) !== c.head) throw handover('judge', `no verdict.md for ${c.head.slice(0, 12)} written`, STEP.judge);
  fillCost(c);
  const argv = ['report', 'build', '--check', '--slug', c.slug];
  let r = await step(c, '7', 'report build --check', argv);
  if (r.code === 1 && !crashed(r)) {
    await headless(c, 'judge', { from: STEP.judge, resume: call.session, prompt: [
      `qa report build --check refused ${path.join(V, 'verdict.md')}:`, ...ruleLines(r), '',
      `Fix V/verdict.md (never by deleting a row, an id or a gap), run qa report build --check --slug ${c.slug} again, and return as phase judge says.`,
    ].join('\n') });
    fillCost(c);
    r = await step(c, '7', 'report build --check', argv);
    if (r.code === 1 && !crashed(r)) throw handover('judge', `verdict.md still fails the check (${ruleLines(r)[0] ?? firstLine(r.stdout)})`, STEP.judge);
  }
  if (r.code !== 0 || crashed(r)) throw failed('report build --check', r, STEP.judge);
  await build(c);
}

async function build(c) {
  const r = await step(c, '8', 'report build', ['report', 'build', '--slug', c.slug]);
  if (r.code !== 0 || crashed(r)) throw failed('report build', r, STEP.report);
}

async function checkAndBuild(c) {
  const r = await step(c, '7', 'report build --check', ['report', 'build', '--check', '--slug', c.slug]);
  if (r.code !== 0 || crashed(r)) throw failed('report build --check', r, STEP.judge);
  await build(c);
}

// 8 ── where the report goes, and the PR comment (not before a cloud report has its URL)
async function place(c) {
  const w = await step(c, '8', 'report where', ['report', 'where', '--json', '--slug', c.slug]);
  if (w.code !== 0 || crashed(w)) throw failed('report where', w, STEP.report);
  try { c.where = JSON.parse(w.stdout); } catch { throw failed('report where', { ...w, stderr: 'no JSON' }, STEP.report); }
  if (c.where.publish) return;
  const cm = await step(c, '8', 'report comment', ['report', 'comment', '--slug', c.slug]);
  c.comment = firstLine(cm.stdout) || null;
}

// ── the end ───────────────────────────────────────────────────────────────────

function outcome(c) {
  const md = readText(path.join(c.V, 'verdict.md'));
  const v = md === null ? null : parseVerdict(md);
  if (!v || v.head !== c.head || !(v.verdict in VERIFY_EXIT)) {
    return new Stop(VERIFY_EXIT.handover, `no verdict for ${c.head.slice(0, 12)} in ${path.join(c.V, 'verdict.md')} — continue by hand from step ${STEP.judge}`, 'handover');
  }
  return new Stop(VERIFY_EXIT[v.verdict], md.split('\n')[0], 'outcome');
}

function finish(c, end) {
  const lines = [];
  let report = null;
  if (c.V) {
    const md = readText(path.join(c.V, 'verdict.md'));
    const reportLine = md?.trimEnd().split('\n').at(-1);
    const html = path.join(c.V, 'report.html');
    if (end.kind === 'outcome' && reportLine?.startsWith('Report: ')) lines.push((report = reportLine));
    else if (end.kind === 'outcome' && fs.existsSync(html)) lines.push(`report: ${(report = html)}`);
    if (c.comment) lines.push(c.comment);
    const costs = costsSummary(c.head ? headCalls(c.V, c.head) : []);
    if (costs) lines.push(costs);
  }
  if (c.ready) lines.push(c.ready);
  const publish = end.kind === 'outcome' && c.where?.publish;
  if (publish) {
    const then = (c.where.artifacts ?? []).map((a) => a.then).filter(Boolean).join(', then ') || 'qa report url <url>';
    lines.push(`publish: run step 8 (Artifact tool), then ${then}, then qa report comment`);
  }
  lines.push(end.line);
  if (c.V) log(c, `== end: exit ${end.exit} · ${end.line} ==`);
  const calls = c.V && c.head ? headCalls(c.V, c.head) : [];
  return {
    exit: end.exit, line: end.line, lines,
    json: {
      exit: end.exit, kind: end.kind, line: end.line, slug: c.slug, V: c.V, verdict: c.V ? path.join(c.V, 'verdict.md') : null, report,
      costs: calls.length ? costsOf(calls) : null, ready: c.ready, publish: publish ? c.where : null, comment: c.comment,
    },
  };
}
