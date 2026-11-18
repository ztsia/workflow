// Contract tests for `qa verify` (rework U10, design §13): one command runs a whole verify round, the skill's
// steps 1–7 and step 8 short of the Artifact tool, and starts the mapper, planner, security review, eyes and judge
// itself as headless Claude sessions. The qa steps are a recorded fake (the `step` dependency: each step's argv,
// with the files the real step would write); `claude` is the fake at test/fixtures/fake-claude.mjs, run through the
// real runHeadless. The CLI tests at the end run the real steps on a small repo, up to the round.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { DEFAULTS } from '../scripts/lib/profile.mjs';
import { PLUGIN_ROOT, runHeadless } from '../scripts/lib/headless.mjs';
import { VERIFY_EXIT, verifyRound } from '../scripts/lib/verify.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CLI_JS = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const CLI = path.join(PLUGIN_ROOT, 'bin', 'qa');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SLUG = 'feat-x';
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = (name) => `qa/${SLUG}/${name}`;

const CHARTER = (security = 'yes') => `# Charter — ${SLUG}\nsecurity: ${security} — test\nstubs: none\n\n- [ch:1] one — by: expectation e1\n- [ch:2] two — by: expectation e2\n`;
const VERDICT = (word, { head = HEAD, cost = 'cost: plan $0.30 · eyes $0.80 · judge $? · runner 0 · total $?' } = {}) => `# ${word} — ${SLUG}
head: ${head}
base: ${BASE}
maps: cccccccccccc
criteria: 1 pass · 1 fail · 0 unverifiable · 0 blocked · 0 waived

## Criteria
- [ch:1] PASS — one: exp:e1 met
- [ch:2] FAIL — two: exp:e2 not met

## Expectations
- none

## Findings
- none

## Spec cases
- none

## Gaps
- none

## Standing
- none

## Notes
- none

${cost}
`;
const PREPARE = (problems = ['- none'], sandbox = 'sandbox sb1 (up)') => `# Prepare check — ${SLUG}
head: ${HEAD.slice(0, 12)} · base: ${BASE.slice(0, 12)} · overlay: none (qa/ in the branch) · ${sandbox} · 40 s
checked: 2 entries · 0 route row(s) · 0 page(s) · 0 new test file(s)

## Entries
- home (desktop): reached
- list (desktop): reached

## Routes
- none

## Test files
- none

## Problems
${problems.join('\n')}
`;

// The answers a full round's agents give, unless a test says otherwise.
const PLAN = {
  planner: [
    { usd: 0.3, files: { [rel('charter.md')]: CHARTER(), [rel('expectations.json')]: '[]\n' }, json: { result: 'charter: 2 rows (2 spec, 0 advisory, 0 manual) · security: yes\nmap: none · map check ok' } },
    { usd: 0.45, json: { result: 'fixed: 1 · left as is: none' } },
  ],
  security: [{ usd: 0.1, json: { result: 'No vulnerabilities found.' } }, { usd: 0.12, files: { [rel('security.md')]: `# Security — ${SLUG}\n` } }],
  eyes: [{ usd: 0.8, files: { [rel('eyes.md')]: `# Eyes — ${SLUG}\n\n## [scr:desktop/home__page] home\nVerdict: fine\n` } }],
  judge: [{ usd: 0.25, files: { [rel('verdict.md')]: VERDICT('REJECT') } }, { usd: 0.3 }],
  mapper: [{ usd: 0.02 }],
};

// The qa steps, as the real ones answer a full round that ends REJECT. Each writes what the real step writes.
function stepsFor(root, V) {
  const target = { slug: SLUG, branch: 'feat/x', head: HEAD, pr: null, base: { ref: 'main', from: 'default', sha: BASE }, spec: { path: 'docs/spec.md', from: 'flag' }, verification: `qa/${SLUG}`, map: path.join(root, 'qa', 'map'), seedNames: null, overlay: null, warnings: [] };
  return {
    resolve: () => ({ stdout: `${JSON.stringify(target)}\n` }),
    'ready status': () => ({ stdout: 'ready: yes\n' }),
    'round plan': () => {
      write(path.join(V, 'round.json'), JSON.stringify({ round: 1, head: HEAD, base: BASE, of: 'full', why: 'the first round', security: { rerun: true, why: 'a full round' } }));
      return { stdout: 'round 1: full — the first round\n' };
    },
    'prepare check': () => { write(path.join(V, 'prepare.md'), PREPARE()); return { stdout: PREPARE() }; },
    'plan check': () => { write(path.join(V, 'plan-check.md'), `# Plan check — ${SLUG}\n\n## Problems\n- none\n`); return { stdout: '' }; },
    run: () => { write(path.join(V, 'results.json'), JSON.stringify({ mode: 'diff', head: { sha: HEAD } })); return { code: 1, stdout: `summary: ${V}/summary.md\n` }; },
    'eyes prompt': () => { write(path.join(V, 'eyes-prompt.md'), '# brief\n'); return { stdout: `${path.join(V, 'eyes-prompt.md')}\n` }; },
    'eyes merge': () => ({ stdout: 'eyes: 1 new ruling(s) kept, 0 from the cache\n' }),
    'verdict draft': () => ({ code: 1, stdout: `# REJECT — ${SLUG}\n` }),
    'verdict waivers': () => ({ code: 3, stdout: `NOT RUN: no waivers.md for ${SLUG}\n` }),
    'report build --check': () => ({ stdout: 'valid\n' }),
    'report build': () => { write(path.join(V, 'report.html'), '<html></html>'); return { stdout: `${path.join(V, 'report.html')}\n` }; },
    'report where': () => {
      const line = `Report: on box at ${path.join(V, 'report.html')}`;
      fs.appendFileSync(path.join(V, 'verdict.md'), `${line}\n`);
      return { stdout: JSON.stringify({ where: 'local', publish: false, why: 'a local lead keeps its report', line, artifacts: [] }) };
    },
    'report comment': () => ({ stdout: 'no comment: no PR for this branch\n' }),
    'sandbox status': () => ({ stdout: JSON.stringify({ name: 'sb1', appUrl: 'http://127.0.0.1:18001', alive: true }) }),
    affected: () => ({ stdout: '{\n  "unmapped": []\n}\n' }),
    'sandbox up': () => ({ stdout: `${JSON.stringify({ name: 'sb1', appUrl: 'http://127.0.0.1:18001' })}\n` }),
  };
}

// 'prepare check --final', 'report build --check', 'round plan', 'run': the command words, then the flags that change a step.
function labelOf(argv) {
  const words = [];
  for (const a of argv) { if (a.startsWith('--') || words.length === 2) break; words.push(a); }
  return [...words, ...argv.filter((a) => ['--check', '--final', '--drop'].includes(a))].join(' ');
}

function setup({ plan = {}, steps = {}, opts = {}, deps = {}, claude = null } = {}) {
  const root = tmp('mfqa-verify-');
  const V = path.join(root, 'qa', SLUG);
  fs.mkdirSync(V, { recursive: true });
  write(path.join(root, 'docs', 'spec.md'), '# Spec\n1. one\n2. two\n');
  const fake = tmp('mfqa-verify-claude-');
  fs.writeFileSync(path.join(fake, 'plan.json'), JSON.stringify({ ...PLAN, ...plan }));
  const seq = [];
  const step = { ...stepsFor(root, V), ...steps };
  const said = [];
  const d = {
    step: async (argv) => {
      const label = labelOf(argv);
      seq.push(label);
      const r = step[label] ? await step[label](argv) : {};
      return { code: 0, stdout: '', stderr: '', ...r };
    },
    claude: claude ?? (async (o) => { seq.push(`claude ${o.role}${o.resume ? ' resume' : ''}`); return runHeadless({ ...o, bin: FAKE, env: { FAKE_CLAUDE_DIR: fake } }); }),
    headSha: () => HEAD,
    originBase: () => BASE,
    prFolder: () => null,
    say: (line) => said.push(line),
    ...deps,
  };
  const run = () => verifyRound({ root, mainRoot: root, pluginDir: PLUGIN_ROOT, cli: CLI, agents: DEFAULTS.agents, ...opts }, d);
  const calls = () => (fs.existsSync(path.join(fake, 'calls.jsonl')) ? fs.readFileSync(path.join(fake, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { root, V, fake, seq, said, run, calls };
}
const promptLines = (prompt) => Object.fromEntries(prompt.split('\n').filter((l) => /^[\w-]+: /.test(l)).map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
const flagOf = (argv, name) => argv[argv.indexOf(name) + 1];
const last = (r) => r.lines.at(-1);

const FULL = ['resolve', 'ready status', 'round plan', 'prepare check', 'claude planner', 'plan check', 'claude security', 'claude security resume',
  'run', 'eyes prompt', 'claude eyes', 'eyes merge', 'verdict draft', 'claude judge', 'report build --check', 'report build', 'report where', 'report comment'];

describe('verify: a whole round', () => {
  test('a full round runs every step in order, each agent headless, and ends on line 1 of verdict.md', async () => {
    const s = setup();
    const r = await s.run();
    assert.deepEqual(s.seq, FULL);
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
    assert.equal(last(r), `# REJECT — ${SLUG}`, 'the last line is the outcome');
    assert.ok(r.lines.some((l) => l === `Report: on box at ${path.join(s.V, 'report.html')}`), r.lines.join('\n'));
  });

  test('every headless call: the plugin dir, its agent, the §14 model, the tools of its frontmatter, JSON, cwd the project root', async () => {
    const s = setup();
    await s.run();
    const calls = s.calls();
    assert.deepEqual(calls.map((c) => c.role), ['planner', 'security', 'security', 'eyes', 'judge']);
    const want = {
      planner: ['workflow:qa-reviewer', 'sonnet', '--allowedTools=Read,Grep,Glob,Bash,Write,Edit'],
      eyes: ['workflow:qa-eyes', 'opus', '--allowedTools=Read,Glob,Write'],
      judge: ['workflow:qa-reviewer', 'sonnet', '--allowedTools=Read,Grep,Glob,Bash,Write,Edit'],
    };
    for (const c of calls) {
      assert.equal(c.cwd, s.root, `${c.role}: cwd`);
      assert.equal(flagOf(c.argv, '--plugin-dir'), PLUGIN_ROOT, `${c.role}: --plugin-dir`);
      assert.equal(flagOf(c.argv, '--output-format'), 'json');
      assert.equal(flagOf(c.argv, '--name'), `qa:${c.role}`);
      // A worktree's .claude/settings.local.json (the lead's agent, model, env) is never loaded into a QA session.
      assert.equal(flagOf(c.argv, '--setting-sources'), 'user', `${c.role}: --setting-sources user`);
      if (c.role === 'security') {
        assert.equal(flagOf(c.argv, '--agent'), 'workflow:qa-security', 'the security review runs as its own neutral persona, never the lead\'s');
        assert.equal(flagOf(c.argv, '--model'), 'sonnet');
        continue;
      }
      const [agent, model, tools] = want[c.role];
      assert.deepEqual([flagOf(c.argv, '--agent'), flagOf(c.argv, '--model')], [agent, model], c.role);
      assert.ok(c.argv.includes(tools), `${c.role}: ${c.argv.join(' ')}`);
    }
  });

  test('the prompts: phase plan and phase judge with their keys, the eyes brief path, the native security review then its file', async () => {
    const s = setup();
    await s.run();
    const [planner, security, securityWrite, eyes, judge] = s.calls();
    assert.equal(planner.prompt.split('\n')[0], 'phase: plan');
    assert.deepEqual(promptLines(planner.prompt), {
      phase: 'plan', slug: SLUG, V: s.V, spec: path.join(s.root, 'docs', 'spec.md'), base: 'main', head: HEAD, cli: CLI, record: 'journeys',
    });
    assert.equal(security.prompt, '/security-review', 'origin/HEAD is the base here: the native command');
    assert.equal(securityWrite.resume, 's-security-1');
    assert.match(securityWrite.prompt, new RegExp(`${path.join(s.V, 'security.md').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.match(securityWrite.prompt, /# Security — feat-x/);
    assert.ok(securityWrite.argv.find((a) => a.startsWith('--allowedTools=')).split(',').includes('Write'), 'only the write-up may write');
    assert.ok(!security.argv.find((a) => a.startsWith('--allowedTools=')).split(',').includes('Write'), 'the review itself never writes');
    assert.equal(eyes.prompt, `Read ${path.join(s.V, 'eyes-prompt.md')} and do what it says.`);
    assert.equal(judge.prompt.split('\n')[0], 'phase: judge');
    assert.deepEqual(promptLines(judge.prompt), {
      phase: 'judge', slug: SLUG, V: s.V, spec: path.join(s.root, 'docs', 'spec.md'), base: 'main', head: HEAD, cli: CLI, round: '1', 'cost-plan': '$0.30', 'cost-eyes': '$0.80',
    });
  });

  test('an incremental round: the prepare check only, no planner and no plan check; security carried; eyes from the cache', async () => {
    const s = setup({
      steps: {
        'round plan': () => {
          write(path.join(s.V, 'round.json'), JSON.stringify({ round: 2, head: HEAD, of: 'incremental', security: { rerun: false, why: 'the fix touches no sensitive path', from: { round: 1 } } }));
          return { stdout: 'round 2: incremental from round 1 (aaaa) — 1 file(s) changed\n' };
        },
        'eyes prompt': () => { write(path.join(s.V, 'eyes.md'), '# Eyes\n'); return { stdout: 'no new screenshot: 1 screen(s) seen before; eyes.md written from the cache, no eyes pass\n' }; },
      },
    });
    write(path.join(s.V, 'charter.md'), CHARTER('yes'));
    const r = await s.run();
    assert.deepEqual(s.seq, ['resolve', 'ready status', 'round plan', 'prepare check', 'run', 'eyes prompt', 'verdict draft', 'claude judge',
      'report build --check', 'report build', 'report where', 'report comment']);
    assert.equal(promptLines(s.calls()[0].prompt).round, '2');
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
  });

  test('an incremental round whose fix touches a sensitive path runs security again; --security forces it', async () => {
    const round = (rerun) => () => {
      write(path.join(s.V, 'round.json'), JSON.stringify({ round: 2, head: HEAD, of: 'incremental', security: { rerun, why: 'x' } }));
      return { stdout: 'round 2: incremental\n' };
    };
    let s = setup({ steps: { 'round plan': round(true) } });
    await s.run();
    assert.ok(s.seq.includes('claude security'));
    s = setup({ steps: { 'round plan': round(false) }, opts: { security: true } });
    await s.run();
    assert.ok(s.seq.includes('claude security'));
  });

  test('no changed or new screen: no eyes pass and no redraft', async () => {
    const s = setup({ steps: { 'eyes prompt': () => ({ stdout: 'no changed or new screen: no eyes pass\n' }) } });
    await s.run();
    assert.deepEqual(s.seq.slice(s.seq.indexOf('eyes prompt'), s.seq.indexOf('claude judge') + 1), ['eyes prompt', 'claude judge']);
  });
});

describe('verify: send-backs', () => {
  test('prepare problems: ONE headless mapper repair (no stub lines, the app url, the script runs the check), then --final; BLOCKED ends the round', async () => {
    const problems = ['- [map:home] not reached: click "Open": timeout', '- [stub:fixed] the charter names stub fixed, which qa.json stubs does not declare'];
    const s = setup({
      steps: {
        'prepare check': () => { write(path.join(s.V, 'prepare.md'), PREPARE(problems)); return { code: 1, stdout: PREPARE(problems) }; },
        'prepare check --final': () => {
          write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED', { cost: 'cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0' }));
          return { code: 1, stdout: `verdict: # BLOCKED — ${SLUG} (${path.join(s.V, 'verdict.md')})\n` };
        },
      },
    });
    const r = await s.run();
    assert.deepEqual(s.seq, ['resolve', 'ready status', 'round plan', 'prepare check', 'sandbox status', 'claude mapper', 'prepare check --final',
      'report build', 'report where', 'report comment']);
    const [mapper] = s.calls();
    assert.equal(mapper.prompt.split('\n')[0], 'phase: repair');
    const keys = promptLines(mapper.prompt);
    assert.deepEqual([keys.cli, keys.base, keys.url], [CLI, BASE, 'http://127.0.0.1:18001']);
    assert.match(keys.check, /^script/, 'the mapper is told the script runs the check: it never waits on one');
    assert.ok(mapper.prompt.includes(problems[0]));
    assert.ok(!mapper.prompt.includes('[stub:'), 'a stub line is for qa.json or the plan, never the mapper');
    assert.deepEqual([flagOf(mapper.argv, '--agent'), flagOf(mapper.argv, '--model')], ['workflow:qa-mapper', 'haiku']);
    assert.equal(r.exit, VERIFY_EXIT.BLOCKED);
    assert.equal(last(r), `# BLOCKED — ${SLUG}`);
  });

  test('prepare exit 4 (the app did not start): --final once, no mapper', async () => {
    const s = setup({
      steps: {
        'prepare check': () => ({ code: 4, stdout: 'blocked: head: serve failed\n' }),
        'prepare check --final': () => ({ code: 0, stdout: PREPARE() }),
      },
    });
    await s.run();
    assert.deepEqual(s.seq.slice(3, 6), ['prepare check', 'prepare check --final', 'claude planner']);
  });

  test('a mapper repair that changed a QA file re-plans the round for this head (round plan --replan); a repair that changed none does not', async () => {
    const problems = ['- [map:home] not reached: click "Open": timeout'];
    const cases = [
      { name: 'the map in the branch', wrote: { 'qa/map/app.json': '{"screens":[{"name":"home","steps":[{"goto":"/home"}]}]}\n' }, replan: true },
      { name: 'a route table in the branch', wrote: { 'qa/routes.table.json': '{"routes":[]}\n' }, replan: true },
      { name: 'nothing', wrote: {}, replan: false },
    ];
    for (const k of cases) {
      const plans = [];
      const s = setup({
        plan: { mapper: [{ usd: 0.02, files: k.wrote }] },
        steps: {
          'round plan': (argv) => {
            plans.push(argv);
            const screens = plans.length === 1 ? ['list'] : ['home', 'list'];
            write(path.join(s.V, 'round.json'), JSON.stringify({ round: 2, head: HEAD, of: 'incremental', screens, security: { rerun: false, why: 'x' } }));
            return { stdout: 'round 2: incremental\n' };
          },
          'prepare check': () => { write(path.join(s.V, 'prepare.md'), PREPARE(problems)); return { code: 1, stdout: PREPARE(problems) }; },
          'prepare check --final': () => ({ code: 0, stdout: PREPARE() }),
        },
      });
      write(path.join(s.root, 'qa', 'map', 'app.json'), '{"screens":[{"name":"home","steps":[{"goto":"/"}]}]}\n');
      write(path.join(s.V, 'charter.md'), CHARTER('no'));
      await s.run();
      const at = s.seq.indexOf('prepare check --final');
      if (k.replan) {
        assert.deepEqual(s.seq.slice(at, at + 3), ['prepare check --final', 'round plan', 'run'], k.name);
        assert.ok(plans[1].includes('--replan'), plans[1].join(' '));
        assert.ok(!plans[1].includes('--full'));
        assert.deepEqual(readJson(path.join(s.V, 'round.json')).screens, ['home', 'list'], 'the run reads the new plan');
      } else {
        assert.deepEqual(s.seq.slice(at, at + 2), ['prepare check --final', 'run'], k.name);
        assert.equal(plans.length, 1);
      }
    }
  });

  test('plan check problems go back to the planner ONCE, in its own session; then --drop, never a second send-back', async () => {
    const md = `# Plan check — ${SLUG}\nhead: x · sandbox sb1 (reused)\nchecked: 2 screen\n\n## Problems\n- [e1] ch:1: observes 0 elements on home\n\n## Mutant problems\n- mut:m1: no kill test\n\n## Stub problems\n- stub:s1: not declared in qa.json stubs\n`;
    const s = setup({
      steps: {
        'plan check': () => { write(path.join(s.V, 'plan-check.md'), md); return { code: 1, stdout: md }; },
        'plan check --drop': () => ({ code: 1, stdout: md }),
      },
    });
    await s.run();
    assert.deepEqual(s.seq.slice(4, 9), ['claude planner', 'plan check', 'claude planner resume', 'plan check --drop', 'claude security']);
    const back = s.calls()[1];
    assert.equal(back.resume, 's-planner-1');
    assert.equal(flagOf(back.argv, '--resume'), 's-planner-1');
    assert.equal(flagOf(back.argv, '--agent'), 'workflow:qa-reviewer', 'a resume names the agent again');
    for (const l of ['- [e1] ch:1: observes 0 elements on home', '- mut:m1: no kill test', '- stub:s1: not declared in qa.json stubs']) assert.ok(back.prompt.includes(l), l);
    assert.match(back.prompt, /fix these in .*expectations\.json, .*mutants\.json and .*charter\.md/);
  });

  test('a planner that wrote no charter, or says its map check failed, gets the line once; still nothing: hand over at step 3 (plan)', async () => {
    let s = setup({ plan: { planner: [{ json: { result: 'map: +1 screen(s) in qa/map/verify-feat-x.json · map check failed: 1 error' }, files: { [rel('charter.md')]: CHARTER(), [rel('expectations.json')]: '[]' } }, { json: { result: 'map: +1 · map check ok' } }] } });
    let r = await s.run();
    assert.deepEqual(s.seq.slice(4, 7), ['claude planner', 'claude planner resume', 'plan check']);
    assert.match(s.calls()[1].prompt, /map check failed: 1 error/);
    assert.equal(r.exit, VERIFY_EXIT.REJECT);

    s = setup({ plan: { planner: [{ json: { result: 'gaps: none' } }, { json: { result: 'done' } }] } });
    r = await s.run();
    assert.deepEqual(s.seq.slice(4), ['claude planner', 'claude planner resume']);
    assert.match(s.calls()[1].prompt, /charter\.md is missing/);
    assert.equal(r.exit, VERIFY_EXIT.handover);
    assert.equal(last(r), 'headless planner failed: no charter.md written after one send-back — continue by hand from step 3 (plan)');
  });

  test('report check problems go back to this round\'s judge once (resume); fixed, the report is built', async () => {
    let n = 0;
    const s = setup({ steps: { 'report build --check': () => (++n === 1 ? { code: 1, stdout: 'R6: line 1 must be REJECT: ch:2 FAIL\n' } : { stdout: 'valid\n' }) } });
    const r = await s.run();
    assert.deepEqual(s.seq.slice(-7), ['claude judge', 'report build --check', 'claude judge resume', 'report build --check', 'report build', 'report where', 'report comment']);
    const back = s.calls().at(-1);
    assert.equal(back.resume, 's-judge-1');
    assert.match(back.prompt, /R6: line 1 must be REJECT: ch:2 FAIL/);
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
  });

  test('a verdict the check still refuses after one send-back: hand over at step 7, no report built, verdict.md left', async () => {
    const s = setup({ steps: { 'report build --check': () => ({ code: 1, stdout: 'R6: line 1 must be REJECT: ch:2 FAIL\n' }) } });
    const r = await s.run();
    assert.deepEqual(s.seq.slice(-4), ['claude judge', 'report build --check', 'claude judge resume', 'report build --check']);
    assert.equal(r.exit, VERIFY_EXIT.handover);
    assert.equal(last(r), 'headless judge failed: verdict.md still fails the check (R6: line 1 must be REJECT: ch:2 FAIL) — continue by hand from step 7 (judge)');
    assert.ok(fs.existsSync(path.join(s.V, 'verdict.md')));
    assert.ok(!fs.existsSync(path.join(s.V, 'report.html')));
  });
});

describe('verify: new screens (the mapper writes the entries no map entry walks, before the prepare check)', () => {
  const notSuites = () => ({ applies: false, why: 'the test has a map' });
  // The affected step names the changed UI files no entry walks; the sandbox up answers with its url.
  const newScreens = (unmapped, argvs = []) => ({
    affected: (argv) => { argvs.push(argv); return { stdout: `${JSON.stringify({ unmapped })}\n` }; },
    'sandbox up': (argv) => { argvs.push(argv); return { stdout: `${JSON.stringify({ name: 'sb2', appUrl: 'http://127.0.0.1:18002' })}\n` }; },
  });

  test('a changed UI file no entry walks: qa affected --json, the head sandbox up, ONE mapper call in phase prepare, then the prepare check', async () => {
    const argvs = [];
    const s = setup({ deps: { suitesMode: notSuites }, steps: newScreens(['src/ui/Home.tsx', 'src/ui/List.tsx'], argvs) });
    await s.run();
    assert.deepEqual(s.seq.slice(0, 7), ['resolve', 'ready status', 'round plan', 'affected', 'sandbox up', 'claude mapper', 'prepare check']);
    assert.deepEqual(argvs, [
      ['affected', '--base', BASE, '--map', path.join(s.root, 'qa', 'map'), '--json'],
      ['sandbox', 'up', '--at', 'HEAD'],
    ]);
    const mappers = s.calls().filter((c) => c.role === 'mapper');
    assert.equal(mappers.length, 1);
    const [mapper] = mappers;
    assert.equal(mapper.prompt.split('\n')[0], 'phase: prepare');
    const keys = promptLines(mapper.prompt);
    assert.deepEqual([keys.cli, keys.base, keys.url, keys.spec], [CLI, BASE, 'http://127.0.0.1:18002', path.join(s.root, 'docs', 'spec.md')]);
    assert.match(keys.check, /^script/, 'the mapper is told the script runs the check');
    assert.deepEqual(mapper.prompt.split('\n').filter((l) => l.startsWith('- ')), ['- src/ui/Home.tsx', '- src/ui/List.tsx']);
    assert.equal(s.seq.filter((x) => x === 'round plan').length, 1, 'the mapper changed no QA file: no replan');
  });

  test('no changed UI file unmapped: the affected step runs and says nothing, no sandbox up, no mapper call', async () => {
    const argvs = [];
    const s = setup({ deps: { suitesMode: notSuites }, steps: newScreens([], argvs) });
    const r = await s.run();
    assert.deepEqual(s.seq.slice(3, 5), ['affected', 'prepare check']);
    assert.ok(!s.seq.includes('sandbox up'));
    assert.equal(s.calls().filter((c) => c.role === 'mapper').length, 0);
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
  });

  test('the mapper changed a QA file and the prepare check passes: round plan --replan, before the run', async () => {
    const plans = [];
    const s = setup({
      deps: { suitesMode: notSuites },
      plan: { mapper: [{ usd: 0.02, files: { 'qa/map/app.json': '{"screens":[{"name":"home","steps":[{"goto":"/home"}]}]}\n' } }] },
      steps: {
        ...newScreens(['src/ui/Home.tsx']),
        'round plan': (argv) => { plans.push(argv); return stepsFor(s.root, s.V)['round plan'](argv); },
      },
    });
    await s.run();
    const at = s.seq.indexOf('prepare check');
    assert.deepEqual(s.seq.slice(at - 1, at + 2), ['claude mapper', 'prepare check', 'round plan']);
    assert.equal(plans.length, 2, 'the round plan, then the replan');
    assert.ok(plans[1].includes('--replan'), plans[1].join(' '));
    assert.equal(s.seq[at + 2], 'claude planner', 'the round goes on from the new plan');
  });

  test('the mapper fails: one [3] line says so, the new screens stay unmapped, and the round goes on to the prepare check', async () => {
    const s = setup({
      deps: { suitesMode: notSuites },
      steps: newScreens(['src/ui/Home.tsx']),
      plan: { mapper: [{ exit: 1, stderr: 'boom: the mapper stopped\n' }] },
    });
    const r = await s.run();
    assert.deepEqual(s.seq.slice(3, 7), ['affected', 'sandbox up', 'claude mapper', 'prepare check']);
    assert.ok(s.said.some((l) => l.startsWith('[3] mapper (prepare) failed: ') && l.endsWith(' — the new screens stay unmapped')), s.said.join('\n'));
    assert.equal(r.exit, VERIFY_EXIT.REJECT, 'the outcome is the round\'s, not a hand-over');
  });

  test('the head sandbox does not come up: one [3] line, no mapper, the round goes on to the prepare check', async () => {
    const s = setup({
      deps: { suitesMode: notSuites },
      steps: { ...newScreens(['src/ui/Home.tsx']), 'sandbox up': () => ({ code: 1, stdout: '', stderr: 'FAIL: no port\n' }) },
    });
    const r = await s.run();
    assert.deepEqual(s.seq.slice(3, 6), ['affected', 'sandbox up', 'prepare check']);
    assert.equal(s.calls().filter((c) => c.role === 'mapper').length, 0);
    assert.ok(s.said.includes('[3] the new screens stay unmapped: the head sandbox did not come up'), s.said.join('\n'));
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
  });

  test('the affected step crashes or prints no list: one [3] line says the check could not run, no mapper, the round goes on', async () => {
    const s = setup({
      deps: { suitesMode: notSuites },
      steps: { affected: () => ({ code: 1, stdout: '', stderr: 'FAIL: the head map could not be read\n' }) },
    });
    const r = await s.run();
    assert.deepEqual(s.seq.slice(3, 5), ['affected', 'prepare check']);
    assert.equal(s.calls().filter((c) => c.role === 'mapper').length, 0);
    assert.ok(s.said.includes('[3] the new-screen check could not run: FAIL: the head map could not be read'), s.said.join('\n'));
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
  });

  test('suites mode applies: no affected step, no sandbox, no mapper; the mode is asked of this checkout', async () => {
    let asked = null;
    const s = setup({
      deps: { suitesMode: (o) => { asked = o; return { applies: true, why: 'no map entries and no stack adapter serves an app' }; } },
      steps: newScreens(['src/ui/Home.tsx']),
    });
    const r = await s.run();
    assert.equal(asked?.repoRoot, s.root);
    assert.deepEqual(s.seq.slice(0, 4), ['resolve', 'ready status', 'round plan', 'prepare check']);
    assert.equal(s.calls().filter((c) => c.role === 'mapper').length, 0);
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
  });
});

describe('verify: a failed headless call hands over, never guesses', () => {
  const cases = [
    ['the agent is not found', { planner: [{ exit: 1, stdout: '', stderr: "--agent 'workflow:qa-reviewer' not found. Available agents: claude\n" }] },
      "headless planner failed: --agent 'workflow:qa-reviewer' not found. Available agents: claude — continue by hand from step 3 (plan)", 'claude planner'],
    ['auth', { eyes: [{ exit: 1, json: { is_error: true, result: 'Invalid API key · Please run /login' } }] },
      'headless eyes failed: Invalid API key · Please run /login — continue by hand from step 6 (eyes)', 'claude eyes'],
    ['is_error with exit 0', { judge: [{ json: { is_error: true, subtype: 'error_during_execution', result: '' } }] },
      'headless judge failed: error_during_execution — continue by hand from step 7 (judge)', 'claude judge'],
  ];
  for (const [name, plan, line, at] of cases) {
    test(`${name}: a distinct exit, the hand-over line, every file left`, async () => {
      const s = setup({ plan });
      const r = await s.run();
      assert.equal(r.exit, VERIFY_EXIT.handover);
      assert.equal(last(r), line);
      assert.equal(s.seq.at(-1), at, 'nothing runs after the failed call');
      assert.ok(fs.existsSync(path.join(s.V, 'round.json')), 'files stay for the hand-driven steps');
      const run = readJson(path.join(s.V, 'run.json'));
      assert.equal(run.agents.calls.at(-1).ok, false, 'the failed call is recorded');
    });
  }

  test('a timeout: the call is killed at qa.json agents.<role>.timeoutMs and the round handed over', async () => {
    const s = setup({ plan: { judge: [{ sleepMs: 8000 }] }, opts: { agents: { ...DEFAULTS.agents, judge: { model: 'sonnet', timeoutMs: 300 } } } });
    const t0 = Date.now();
    const r = await s.run();
    assert.ok(Date.now() - t0 < 6000);
    assert.equal(r.exit, VERIFY_EXIT.handover);
    assert.match(last(r), /^headless judge failed: timed out after 0\.3 s — continue by hand from step 7 \(judge\)$/);
  });

  test('no claude at all (QA_CLAUDE names nothing): the default call reads QA_CLAUDE and hands over at the first agent', async () => {
    const s = setup({ claude: undefined });
    const saved = process.env.QA_CLAUDE;
    process.env.QA_CLAUDE = path.join(s.root, 'no-such-claude');
    try {
      const r = await verifyRound({ root: s.root, mainRoot: s.root, pluginDir: PLUGIN_ROOT, cli: CLI, agents: DEFAULTS.agents }, {
        step: async (argv) => { const fn = stepsFor(s.root, s.V)[labelOf(argv)]; return { code: 0, stdout: '', stderr: '', ...(fn ? await fn(argv) : {}) }; },
        headSha: () => HEAD, originBase: () => BASE, prFolder: () => null,
      });
      assert.equal(r.exit, VERIFY_EXIT.handover);
      assert.match(last(r), /^headless planner failed: claude not found: .*no-such-claude.* — continue by hand from step 3 \(plan\)$/);
    } finally {
      if (saved === undefined) delete process.env.QA_CLAUDE; else process.env.QA_CLAUDE = saved;
    }
  });

  test('a product or tool outcome is no failure: a BLOCKED run exits 4 with its verdict, no eyes, no judge', async () => {
    const s = setup({
      steps: {
        run: () => {
          write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED', { cost: 'cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0' }));
          return { code: 4, stdout: 'BLOCKED ON INFRASTRUCTURE\n' };
        },
      },
    });
    const r = await s.run();
    assert.deepEqual(s.seq.slice(s.seq.indexOf('run')), ['run', 'report build', 'report where', 'report comment']);
    assert.equal(r.exit, VERIFY_EXIT.BLOCKED);
    assert.equal(last(r), `# BLOCKED — ${SLUG}`);
  });
});

describe('verify: costs', () => {
  test('each session\'s cost and tokens go into run.json, cost-<role> per role (a resumed session counted once, at its total)', async () => {
    let checks = 0;
    const md = `# Plan check — ${SLUG}\n\n## Problems\n- [e1] ch:1: observes 0 elements\n`;
    const s = setup({
      steps: {
        'prepare check': () => { write(path.join(s.V, 'prepare.md'), PREPARE(['- [map:home] not reached'])); return { code: 1 }; },
        'prepare check --final': () => ({ code: 0 }),
        'plan check': () => { write(path.join(s.V, 'plan-check.md'), md); return { code: 1, stdout: md }; },
        'plan check --drop': () => ({ code: 0 }),
        'report build --check': () => (++checks === 1 ? { code: 1, stdout: 'R2: a row lost its id\n' } : { stdout: 'valid\n' }),
      },
    });
    write(path.join(s.V, 'run.json'), JSON.stringify({ slug: SLUG, agents: { head: 'f'.repeat(40), calls: [{ role: 'planner', usd: 9 }] }, 'cost-plan': 9 }));
    const r = await s.run();
    const run = readJson(path.join(s.V, 'run.json'));
    assert.equal(run.slug, SLUG, 'other keys are kept');
    assert.equal(run.agents.head, HEAD, 'an earlier head\'s calls are not this head\'s');
    assert.deepEqual(run.agents.calls.map((c) => c.role), ['mapper', 'planner', 'planner', 'security', 'security', 'eyes', 'judge', 'judge']);
    assert.deepEqual(['cost-mapper', 'cost-plan', 'cost-security', 'cost-eyes', 'cost-judge'].map((k) => run[k]), [0.02, 0.45, 0.12, 0.8, 0.3]);
    const c = run.agents.calls[1];
    assert.deepEqual([c.session, c.model, c.ok, c.turns], ['s-planner-1', 'sonnet', true, 3]);
    assert.deepEqual(c.tokens, { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 });
    const cost = fs.readFileSync(path.join(s.V, 'verdict.md'), 'utf8').split('\n').find((l) => l.startsWith('cost: '));
    assert.equal(cost, 'cost: plan $0.45 · eyes $0.80 · judge $0.30 · mapper $0.02 · security $0.12 · runner 0 · total $1.69', 'the script writes the real numbers');
    assert.ok(r.lines.includes('costs: mapper $0.02 · planner $0.45 · security $0.12 · eyes $0.80 · judge $0.30 · total $1.69 (this head, headless sessions, API-price equivalent)'), r.lines.join('\n'));
  });

  test('qa.json agents.<role>.model overrides the default model of that role only', async () => {
    const s = setup({ opts: { agents: { ...DEFAULTS.agents, eyes: { ...DEFAULTS.agents.eyes, model: 'sonnet' } } } });
    await s.run();
    const byRole = Object.fromEntries(s.calls().map((c) => [c.role, flagOf(c.argv, '--model')]));
    assert.deepEqual(byRole, { planner: 'sonnet', security: 'sonnet', eyes: 'sonnet', judge: 'sonnet' });
  });
});

describe('verify: where the round starts and stops', () => {
  test('a verdict for this head already: line 1 is the answer, no run; waivers are applied by script, then the report and step 8', async () => {
    let s = setup();
    write(path.join(s.V, 'verdict.md'), VERDICT('ACCEPT'));
    write(path.join(s.V, 'report.html'), '<html></html>');
    let r = await s.run();
    assert.deepEqual(s.seq, ['resolve', 'ready status', 'verdict waivers']);
    assert.deepEqual([r.exit, last(r)], [VERIFY_EXIT.ACCEPT, `# ACCEPT — ${SLUG}`]);

    s = setup({ steps: { 'verdict waivers': () => { write(path.join(s.V, 'verdict.md'), VERDICT('NEEDS YOU')); return { stdout: `# NEEDS YOU — ${SLUG}\nwaived: ch:2\n` }; } } });
    write(path.join(s.V, 'verdict.md'), VERDICT('REJECT'));
    r = await s.run();
    assert.deepEqual(s.seq, ['resolve', 'ready status', 'verdict waivers', 'report build', 'report where', 'report comment']);
    assert.deepEqual([r.exit, last(r)], [VERIFY_EXIT['NEEDS YOU'], `# NEEDS YOU — ${SLUG}`]);
  });

  test('BLOCKED for this head: always again from step 3 (the prepare check), whatever prepare.md says; the planner in a full round', async () => {
    for (const problems of [['- none'], ['- [map:home] not reached']]) {
      const s = setup();
      write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED'));
      write(path.join(s.V, 'round.json'), JSON.stringify({ round: 1, head: HEAD, of: 'full' }));
      write(path.join(s.V, 'prepare.md'), PREPARE(problems));
      await s.run();
      assert.deepEqual(s.seq.slice(0, 6), ['resolve', 'ready status', 'verdict waivers', 'prepare check', 'claude planner', 'plan check'], problems[0]);
      assert.ok(!s.seq.includes('round plan'), 'the round of round.json stands');
    }
  });

  test('BLOCKED for this head in an incremental round: the prepare check, then on with no planner; the planner only when charter.md is missing', async () => {
    const incremental = JSON.stringify({ round: 2, head: HEAD, of: 'incremental', security: { rerun: false, why: 'x' } });
    let s = setup();
    write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED'));
    write(path.join(s.V, 'round.json'), incremental);
    write(path.join(s.V, 'charter.md'), CHARTER('no'));
    await s.run();
    assert.deepEqual(s.seq.slice(0, 5), ['resolve', 'ready status', 'verdict waivers', 'prepare check', 'run']);

    s = setup();
    write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED'));
    write(path.join(s.V, 'round.json'), incremental);
    await s.run();
    assert.deepEqual(s.seq.slice(0, 6), ['resolve', 'ready status', 'verdict waivers', 'prepare check', 'claude planner', 'plan check']);
  });

  test('BLOCKED for this head with new waivers: applied by script first; no longer BLOCKED -> the report and step 8, no run', async () => {
    const s = setup({
      steps: { 'verdict waivers': () => { write(path.join(s.V, 'verdict.md'), VERDICT('NEEDS YOU')); return { stdout: `# NEEDS YOU — ${SLUG}\nwaived: ch:2\n` }; } },
    });
    write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED'));
    write(path.join(s.V, 'round.json'), JSON.stringify({ round: 1, head: HEAD, of: 'full' }));
    const r = await s.run();
    assert.deepEqual(s.seq, ['resolve', 'ready status', 'verdict waivers', 'report build', 'report where', 'report comment']);
    assert.deepEqual([r.exit, last(r)], [VERIFY_EXIT['NEEDS YOU'], `# NEEDS YOU — ${SLUG}`]);
  });

  test('BLOCKED for this head and still BLOCKED after the waivers (a whole-run block is never waived row by row): again from step 3', async () => {
    const s = setup({
      steps: { 'verdict waivers': () => { write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED')); return { stdout: `# BLOCKED — ${SLUG}\nwaived: ch:2\n` }; } },
    });
    write(path.join(s.V, 'verdict.md'), VERDICT('BLOCKED'));
    write(path.join(s.V, 'round.json'), JSON.stringify({ round: 1, head: HEAD, of: 'full' }));
    await s.run();
    assert.deepEqual(s.seq.slice(0, 5), ['resolve', 'ready status', 'verdict waivers', 'prepare check', 'claude planner']);
  });

  test('--full on a head that already has a verdict: a full round again (round plan --full, the prepare check, the planner), no waivers step', async () => {
    for (const word of ['REJECT', 'NEEDS YOU', 'BLOCKED']) {
      let argv = null;
      const s = setup({
        opts: { full: true },
        steps: {
          'round plan': (a) => {
            argv = a;
            write(path.join(s.V, 'round.json'), JSON.stringify({ round: 1, head: HEAD, base: BASE, of: 'full', why: '--full', security: { rerun: true, why: 'a full round' } }));
            return { stdout: 'round 1: full — --full\n' };
          },
        },
      });
      write(path.join(s.V, 'verdict.md'), VERDICT(word));
      write(path.join(s.V, 'report.html'), '<html></html>');
      write(path.join(s.V, 'round.json'), JSON.stringify({ round: 1, head: HEAD, of: 'incremental' }));
      await s.run();
      assert.deepEqual(s.seq.slice(0, 5), ['resolve', 'ready status', 'round plan', 'prepare check', 'claude planner'], word);
      assert.ok(argv.includes('--full'), argv.join(' '));
      assert.ok(!s.seq.includes('verdict waivers'), word);
    }
  });

  test('NOT RUN when there is no spec (exit 3, one line saying where to put it); V/spec.md is used when resolve finds none', async () => {
    const steps = { resolve: () => ({ stdout: JSON.stringify({ ...JSON.parse(stepsFor(s.root, s.V).resolve().stdout), spec: null }) }) };
    let s = setup({ steps });
    let r = await s.run();
    assert.equal(r.exit, VERIFY_EXIT.notRun);
    assert.match(last(r), /^NOT RUN: no spec: write the acceptance criteria to .*qa\/feat-x\/spec\.md \(or pass --spec <file>\)/);
    assert.deepEqual(s.seq, ['resolve']);

    s = setup({ steps });
    write(path.join(s.V, 'spec.md'), '# Spec\n');
    r = await s.run();
    assert.equal(promptLines(s.calls()[0].prompt).spec, path.join(s.V, 'spec.md'));
  });

  test('NOT RUN when the base is not in this repo', async () => {
    const s = setup({ steps: { resolve: () => ({ stdout: JSON.stringify({ slug: SLUG, base: { ref: 'origin/dev', sha: null }, spec: null, verification: `qa/${SLUG}` }) }) } });
    const r = await s.run();
    assert.equal(r.exit, VERIFY_EXIT.notRun);
    assert.match(last(r), /^NOT RUN: base origin\/dev is not in this repo/);
  });

  test('--until <step> stops after it with exit 0 and says where the hand-driven steps go on', async () => {
    const s = setup({ opts: { until: 'run' } });
    const r = await s.run();
    assert.equal(s.seq.at(-1), 'run');
    assert.deepEqual([r.exit, last(r)], [0, 'stopped after run (--until run) — continue by hand from step 6 (eyes)']);
  });

  test('a cloud session that should publish: no PR comment before the report has its URL, and the publish line before line 1', async () => {
    const s = setup({
      steps: {
        'report where': () => ({ stdout: JSON.stringify({ where: 'cloud', publish: true, why: 'the launcher\'s own account', artifacts: [{ part: 1, of: 1, then: `qa report url <url> --part 1 --slug ${SLUG}` }] }) }),
      },
    });
    const r = await s.run();
    assert.equal(s.seq.at(-1), 'report where');
    assert.equal(r.lines.at(-2), `publish: run step 8 (Artifact tool), then qa report url <url> --part 1 --slug ${SLUG}, then qa report comment`);
    assert.equal(last(r), `# REJECT — ${SLUG}`);
  });

  test('origin/HEAD is not the base, or the native review cannot run here: a headless session reviews git diff <base>...HEAD', async () => {
    let s = setup({ deps: { originBase: () => 'c'.repeat(40) } });
    await s.run();
    let sec = s.calls().filter((c) => c.role === 'security');
    assert.notEqual(sec[0].prompt, '/security-review');
    assert.ok(sec[0].prompt.includes(`git diff ${BASE}...HEAD`), sec[0].prompt);

    s = setup({
      plan: {
        security: [
          { json: { num_turns: 0, result: 'Shell command failed for pattern "!`git diff --name-only origin/HEAD...`": [stderr]\nfatal: ambiguous argument' } },
          { json: { result: 'No vulnerabilities found.' } },
          { files: { [rel('security.md')]: `# Security — ${SLUG}\n` } },
        ],
      },
    });
    const r = await s.run();
    sec = s.calls().filter((c) => c.role === 'security');
    assert.equal(sec.length, 3);
    assert.equal(sec[0].prompt, '/security-review');
    assert.ok(sec[1].prompt.includes(`git diff ${BASE}...HEAD`));
    assert.equal(sec[2].resume, 's-security-2', 'the write-up resumes the review that ran');
    assert.equal(r.exit, VERIFY_EXIT.REJECT);
  });

  test('every step\'s output is kept in V/verify.log', async () => {
    const s = setup();
    await s.run();
    const log = fs.readFileSync(path.join(s.V, 'verify.log'), 'utf8');
    for (const label of ['resolve', 'round plan', 'prepare check', 'report comment']) assert.ok(log.includes(`] ${label}`), label);
    assert.ok(log.includes('headless planner'));
  });
});

describe('verify: the CLI', () => {
  function git(args, cwd) {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  }
  const cli = (cwd, args, env = {}) => {
    const r = spawnSync(process.execPath, [CLI_JS, ...args], { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } });
    return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  function repo() {
    const dir = tmp('mfqa-verify-cli-');
    git(['init', '-q'], dir);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
    write(path.join(dir, '.gitignore'), 'qa-artifacts/\n');
    write(path.join(dir, 'qa.json'), '{}\n');
    write(path.join(dir, 'qa', 'map', 'app.json'), JSON.stringify({ screens: [{ name: 'home', sources: ['src/**'], steps: [{ goto: '/' }] }] }));
    write(path.join(dir, 'src', 'a.txt'), 'a1\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'one'], dir);
    git(['checkout', '-qb', 'feat/x'], dir);
    write(path.join(dir, 'src', 'a.txt'), 'a2\n');
    write(path.join(dir, 'docs', 'x-spec.md'), '# Spec\n1. a reads a2\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'the change'], dir);
    return dir;
  }

  test('usage: a bad --until or --record is exit 64; help lists verify', () => {
    const dir = repo();
    assert.equal(cli(dir, ['verify', '--until', 'lunch']).status, 64);
    assert.equal(cli(dir, ['verify', '--record', 'some']).status, 64);
    assert.match(cli(dir, ['help']).out, /verify \[--spec <file>\]/);
  });

  test('the real steps up to the round: resolve, ready status, round plan; the last line says where to go on', () => {
    const dir = repo();
    const r = cli(dir, ['verify', '--spec', 'docs/x-spec.md', '--until', 'round'], { QA_CLAUDE: path.join(dir, 'no-such-claude') });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim().split('\n').at(-1), 'stopped after round (--until round) — continue by hand from step 3 (prepare check)');
    const V = path.join(dir, 'qa', 'feat-x');
    assert.equal(readJson(path.join(V, 'round.json')).of, 'full');
    assert.match(fs.readFileSync(path.join(V, 'verify.log'), 'utf8'), /round 1: full/);
  });

  test('--json: one JSON object with the outcome line and the exit', () => {
    const dir = repo();
    const r = cli(dir, ['verify', '--spec', 'docs/x-spec.md', '--until', 'resolve', '--json']);
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.exit, j.line, j.slug], [0, 'stopped after resolve (--until resolve) — continue by hand from step 2 (round)', 'feat-x']);
  });
});

describe('verify: suites mode (no map entries, nothing that serves an app)', () => {
  function git(args, cwd) {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  }
  // A library: a passing suite, no qa/map, no stack. The branch adds a test file and a spec.
  function library({ failing = false } = {}) {
    const dir = tmp('mfqa-verify-suites-');
    git(['init', '-q'], dir);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
    write(path.join(dir, '.gitignore'), 'qa-artifacts/\n');
    write(path.join(dir, 'qa.json'), '{}\n');
    write(path.join(dir, 'qa', 'suites.json'), JSON.stringify({ suites: { unit: { cmd: ['node', '--test', 'src/ok.test.mjs'] } } }));
    write(path.join(dir, 'src', 'ok.test.mjs'), "import test from 'node:test';\ntest('adds', () => {});\n");
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'one'], dir);
    git(['checkout', '-qb', 'feat/x'], dir);
    write(path.join(dir, 'src', 'new.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('new', () => assert.ok(${failing ? 'false' : 'true'}));\n`);
    write(path.join(dir, 'src', 'auth.mjs'), 'export const login = 1;\n');
    write(path.join(dir, 'docs', 'x-spec.md'), '# Spec\n1. the library adds\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'the change'], dir);
    return dir;
  }
  const V_SLUG = 'feat-x';
  // The agents' parts: the planner writes a charter and a doc expectation (checked from git, no sandbox); the judge
  // writes the verdict of the run it was handed (the suite's row as the run drafted it, and the charter row cited).
  function agents(dir, { failing = false } = {}) {
    const fake = tmp('mfqa-verify-suites-claude-');
    const q = (name) => `qa/${V_SLUG}/${name}`;
    const head = git(['rev-parse', 'HEAD'], dir);
    const verdict = `# ${failing ? 'REJECT' : 'ACCEPT'} — ${V_SLUG}
head: ${head}
base: none
maps: 052ec45af7dd
criteria: ${failing ? '5 pass · 1 fail' : '5 pass · 0 fail'} · 0 unverifiable · 0 blocked · 0 waived

## Criteria
- [ch:1] PASS — the spec is in the branch: exp:spec-there met
- [ch:2] PASS — adding works: exp:adds-works met
- [suite:unit] PASS — suite unit: exit 0 · node --test src/ok.test.mjs · 1 passed, 0 failed
${failing ? '- [suite:slow] FAIL — suite slow: exit 1 · node --test src/new.test.mjs · 0 passed, 1 failed · failing: new\n' : ''}- [exp:spec-there] PASS — spec-there: ch:1 · doc docs/x-spec.md: 1 of 1 text(s) found
- [exp:adds-works] PASS — adds-works: ch:2 · test unit 'adds' passed

## Expectations
- none

## Findings
- none

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 0 standing item(s), never gating

## Notes
- suites mode: no screens and no stack, so each suite ran whole on the head commit; no base side, no model call

cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0
`;
    fs.writeFileSync(path.join(fake, 'plan.json'), JSON.stringify({
      planner: [{ files: {
        [q('charter.md')]: `# Charter — ${V_SLUG}\nsecurity: no — a library with no sensitive path\nstubs: none\n\n- [ch:1] the spec is in the branch — by: expectation spec-there\n- [ch:2] adding works — by: expectation adds-works\n`,
        [q('expectations.json')]: JSON.stringify([
          { name: 'spec-there', criterion: 'ch:1', doc: { file: 'docs/x-spec.md', contains: ['the library adds'] } },
          { name: 'adds-works', criterion: 'ch:2', test: { suite: 'unit', grep: 'adds' } },
        ]),
      }, json: { result: 'charter: 1 row (1 spec, 0 advisory, 0 manual) · security: no\nmap: none · map check ok' } }],
      judge: [{ files: { [q('verdict.md')]: verdict } }],
    }));
    return fake;
  }
  const cli = (cwd, fake, args) => {
    const r = spawnSync(process.execPath, [CLI_JS, ...args], { cwd, encoding: 'utf8', timeout: 240000, env: { ...process.env, QA_CLAUDE: FAKE, FAKE_CLAUDE_DIR: fake } });
    return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const calledRoles = (fake) => fs.readFileSync(path.join(fake, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).role);

  test('a green library: no sandbox is asked for (a test expectation is checked in a worktree), the planner and the judge run, and the round ends ACCEPT', () => {
    const dir = library();
    const fake = agents(dir);
    const r = cli(dir, fake, ['verify', '--spec', 'docs/x-spec.md', '--onto', 'main']);
    const V = path.join(dir, 'qa', V_SLUG);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim().split('\n').at(-1), `# ACCEPT — ${V_SLUG}`);
    assert.deepEqual(calledRoles(fake), ['planner', 'judge']);
    const log = fs.readFileSync(path.join(V, 'verify.log'), 'utf8');
    assert.doesNotMatch(log, /nothing serves the app/);
    assert.doesNotMatch(log, /BLOCKED/);
    assert.match(fs.readFileSync(path.join(V, 'prepare.md'), 'utf8'), /· no sandbox ·/);
    assert.match(fs.readFileSync(path.join(V, 'prepare.md'), 'utf8'), /concern: src\/auth\.mjs: looks like an auth/, 'the auth concern stays, advisory');
    assert.equal(readJson(path.join(V, 'results.json')).mode, 'suites');
    assert.match(r.out, /project not proven ready: no screens yet — qa ready applies once the map has entries/);
  });

  test('a failing suite ends REJECT (the verdict is the judge\'s, the evidence is the suite), never BLOCKED', () => {
    const dir = library({ failing: true });
    write(path.join(dir, 'qa', 'suites.json'), JSON.stringify({ suites: { unit: { cmd: ['node', '--test', 'src/ok.test.mjs'] }, slow: { cmd: ['node', '--test', 'src/new.test.mjs'] } } }));
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'register the new test in a second suite'], dir);
    const fake = agents(dir, { failing: true });
    const r = cli(dir, fake, ['verify', '--spec', 'docs/x-spec.md', '--onto', 'main']);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.stdout.trim().split('\n').at(-1), `# REJECT — ${V_SLUG}`);
    assert.deepEqual(calledRoles(fake), ['planner', 'judge']);
  });
});
