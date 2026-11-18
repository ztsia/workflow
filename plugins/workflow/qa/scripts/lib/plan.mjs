// `qa plan check` (rework U6, design §6, D31): the plan is checked on the head sandbox in about a minute, before the
// 35–60 minute run, so a bad expectation costs a send-back to the planner instead of a round. Every rule is general
// (D39): it reads the DOM, the runners' own list modes, git and the route table; nothing names an app. Zero model calls.
//
// CONTRACT (tests: test/plan.test.mjs — the rules on fixtures; observeScreens in a real headless browser against a
// fixture server; resolveTest with real `node --test` files and injected list outputs; planCheck with injected deps)
//
//   The plan = V/expectations.json (the verifier's array) and V/mutants.json ({ mutants: [m] }, optional).
//   kindOf(entry) -> 'screen' | 'url' | 'test' | 'doc' | 'route' | 'other'
//     test/doc/route: the entry has that key; db or mail -> 'other' (not checked here); url/urlPattern -> 'url';
//     a string `text` -> 'screen'; anything else -> 'other'.
//   criteriaOf(charterMd) -> { <expectation name>: ['ch:<n>', …] }   from the charter rows `- [ch:<n>] … by: expectation
//     <name>` (every `expectation <name>` after `by:` counts).
//   criterionOf(entry, byName) -> entry.criterion, else byName[name] joined by ',', else '-'.
//
//   SCREENS. A screen or url entry is in scope on a map screen when one of its `screens` globs (a glob or a list)
//   matches the screen's name or a '<name>__<state>' key, at each of its `viewports` (default: every profile
//   viewport) the screen is walked at (a screen's own `viewports` narrow it).
//   observeScreens({ profile, mainRoot, baseUrl, cwd, vars, map, entries, clock, headless, pw, runVerb, log })
//     -> Promise<{ observations: [Observation], failures: [{ viewport, screen, error }] }>
//     entries = [{ index, entry }] (screen kind). Walks each map screen that some entry is in scope on, once per
//     viewport, as capture does (expandScreen, the role's login, openBrowser with the clock, capture.mjs runStep;
//     tour steps do nothing), and at each capture step (or once at the end when there is none) settles and counts,
//     per in-scope entry, the elements capture would collect for its text: the innermost visible elements whose
//     whole text (whitespace folded; an input's value) equals `text` or matches '/re/flags'.
//     Observation = { index, viewport, screen, key: '<screen>__<state>', count (all such elements), svg (how many
//       sit inside an <svg>), matched (those whose context, the column header or the short texts around them as
//       capture records it, contains entry.context, case-insensitive; = count without context), tree (accessibility
//       tree lines whose text matches, tree.mjs treeText), samples: [up to 3 texts], contexts: [up to 3 contexts] }.
//     A screen that cannot be walked (a step throws, a MAP ERROR, a failed login) is a failure, never a throw.
//   judgeScreens({ entries, map, profile, observations, failures, maxMatches }) -> { <index>: [problem] }
//     entries = [{ index, entry }] (screen and url kinds). Per entry:
//       no map screen in scope -> 'screens "<glob>" matches no map screen'.
//       url kind: nothing more (where a click lands is judged by the run).
//       a bad '/re/' text -> 'text: <regex error>'.
//       every in-scope screen failed -> 'could not walk <screen> (<viewport>): <error>' (the first).
//       any observation with svg > 0 and no `svg: true` -> 'matches text inside an <svg> on <key> (<viewport>): "<sample>";
//         capture reads no chart text: match the text around the chart, or say "svg": true'.
//       after: 'absent' (a removal: head should show none): no other rule.
//       any observation with count > maxMatches -> 'matches <count> elements on <key> (<viewport>), more than <max>:
//         narrow the text, the context or the screens'.
//       nothing observed (no observation with matched > 0, nor one with count 0 and tree > 0: a name only the
//         accessibility tree carries, as compare finds it) -> with a context and some element carrying the text:
//         '"<text>" is on <keys> (<viewports>), but never with context "<context>" (its contexts: "<c>", …)'; else
//         'observes 0 elements on <keys> (<viewports>): "<text>" is not on head there'.
//
//   TESTS. resolveTest({ entry, suites, dir, profile, mainRoot, vars, logDir, runVerb, exec, listTimeoutMs = 120000 })
//     -> Promise<{ ok: true, how, names } | { ok: false, problem }>
//     tests.mjs entryProblem first; then the file must be in the head tree ('test.file <f> is not in the head tree').
//     A registered command (not 'test:<level>'): commandFor (with the file) must be narrowed, else tests.mjs
//     wholeSuiteWhy. Then the runner's list mode (tests.mjs listCommandFor): kind 'names' -> run it (exec, in dir,
//     the QA_* env, at most listTimeoutMs or the suite's own limit) and parseListed; no names -> 'the <runner>
//     list gave no test names (exit <code>): <last output line>'; none matching grep (tests.mjs grepMatcher) ->
//     'no test matches "<grep>" in the <runner> list[ of <file>] (<n> listed[, first: <name>])'; else ok, how
//     '<runner> list'. kind 'files' (jest): no file listed -> 'jest lists no test file[ for <file>]'; else on to:
//     No list mode (node --test, a command of no known runner, 'test:<level>'): the test itself runs, filtered
//     (tests.mjs runTests of this one entry, side 'plan'): met or NOT MET -> ok, how 'ran filtered' (a failing
//     test still exists: that is the run's evidence, not a plan problem); else the record's why is the problem.
//
//   DOCS. A doc entry: docs.mjs docProblem; else its file must be at head (read(head, file) not null): 'doc.file
//     <file> is not in the head commit'.
//   ROUTES. routeProblem(entry, { rows, roles, file }) -> string | null   no table -> 'no route table: a route the
//     table lacks cannot be probed'; route not '<METHOD> <path>' -> 'route must be "<METHOD> <path>"'; no row whose
//     '<METHOD> <path>' equals it, whose calls hold the path, or whose pattern matches it (routes.mjs matchRoute) ->
//     'route "<route>" is not in the route table (<file>)'; `as` not 'anon' nor a login role -> 'as "<as>" is not
//     anon or a login role (<roles>)'.
//   MUTANTS (the proposals; rework: a mutant runs only with its killing test). Per raw proposal: mutants.mjs
//     mutantProblem; no kill -> 'no kill test: a mutant runs only with kill { suite, grep } naming the test that
//     must fail'; mutants.mjs staleWhy in the head tree; resolveTest of { name: 'mut-<id>', test: kill }.
//
//   planCheck(opts, deps = {}) -> Promise<PlanCheck>
//     opts: { mainRoot, repoRoot, profile, slug, V, head (sha), map (dir), seedNames (file | null), headless = true,
//             log }; deps: { up, down, observe, resolveTest, read, loadRouteTable, now } (defaults: sandbox.mjs,
//             observeScreens, resolveTest, git show at head, routes.mjs).
//     Reads V/expectations.json (missing or not an array -> Error), V/mutants.json and V/charter.md when there.
//     Docs are checked from git. When any screen, url, test, route or mutant entry exists, the head sandbox is
//     brought up (sandbox.up at head, qaFrom repoRoot: a live one is reused) and, when this check brought it up,
//     taken down at the end, so the run starts from a fresh seed. A sandbox that does not come up -> blocked =
//     its message, and nothing that needs it is judged (no problem is invented for it).
//     SUITES MODE (suitesmode.mjs suitesModeApplies: no map entries, no stack that serves): no sandbox. The test entries
//     and the mutants' kill tests are resolved in a git worktree of the head commit (withHeadWorktree), which is removed at
//     the end; a screen, url or route entry is a problem, 'suites mode: this project has no screens and nothing serves an
//     app, so a screen, url or route expectation cannot run: name a test or a doc'. The check is never blocked for want of
//     a serve, and its sandbox is null.
//     PlanCheck = { slug, head, sandbox: { name, state: 'up' | 'reused' } | null, blocked, maxMatches
//       (profile.plan.maxMatches ?? 20), counts: { screen, url, test, doc, route, mutant, other },
//       problems: [{ index, name, criterion, kind, problem }] (problems of one entry joined by '; ', in plan order),
//       mutants: [{ index, id, problem }], notes: [string] (the suites note), ms }
//   planCheckMd(check, { dropped = false }) -> the text of V/plan-check.md:
//     '# Plan check — <slug>', 'head: <sha12> · sandbox <name> (<state>) · at most <max> matching elements per
//     capture', 'checked: <n> screen · <n> url · <n> test · <n> doc · <n> route · <n> mutant', a 'note: …' line per
//     note, 'blocked: <why>' when blocked, a blank line, '## Dropped from the plan' (dropped) or '## Problems', then
//     '- [<name>] <criterion>: <problem>' per problem, or '- none'. Mutant problems follow under '## Mutants
//     dropped' / '## Mutant problems' as '- mut:<id>: <problem>' (no brackets: they are not criterion rows).
//   dropFailed({ V, check }) -> { expectations: n, mutants: n, stubs: n }   rewrites V/expectations.json without the
//     entries that have problems and V/mutants.json without the mutants that have problems (2-space JSON + newline),
//     and V/charter.md's `stubs:` line without the stubs that have problems (stubs.mjs withCharterStubs).
//
//   STUBS (design §6.1 rung 3; tests: test/stubs.test.mjs 'plan check'): the charter's `stubs:` line names the stubs
//     the plan needs (stubs.mjs charterStubs). The head sandbox comes up with the declared ones (sandbox.mjs up stubs;
//     a live one with other stubs is brought up again), so a rung-3 expectation is observed with its stand-in on.
//     PlanCheck gains stubs: [{ id, problem: 'not
//     declared in qa.json stubs: name a declared stub (qa profile lists them) or take another rung' }] per
//     undeclared id; planCheckMd lists them under '## Stub problems' ('## Stubs dropped' with dropped) as
//     '- stub:<id>: <problem>'; the CLI exits 1 when there is one.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { login, settle } from './login.mjs';
import { openBrowser, runStep } from './capture.mjs';
import { expandScreen, loadMap } from './map.mjs';
import { docProblem } from './docs.mjs';
import { loadRouteTable, matchRoute, routeName } from './routes.mjs';
import { mutantProblem, staleWhy } from './mutants.mjs';
import { loadSuites, timeoutOf } from './suites.mjs';
import { treeText } from './tree.mjs';
import * as sandbox from './sandbox.mjs';
import { suitesModeApplies, withHeadWorktree } from './suitesmode.mjs';
import {
  commandFor, entryProblem, execCommand, grepMatcher, listCommandFor, parseListed, runTests, suiteRun, wholeSuiteWhy,
} from './tests.mjs';
import { glob } from './util.mjs';
import { charterStubs, resolveStubs, withCharterStubs } from './stubs.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const listOf = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '-');
export const DEFAULT_MAX_MATCHES = 20;

// ── the plan's entries ─────────────────────────────────────────────────────────

export function kindOf(entry) {
  if (!isObject(entry)) return 'other';
  if (entry.test !== undefined) return 'test';
  if (entry.doc !== undefined) return 'doc';
  if (entry.route !== undefined) return 'route';
  if (entry.db !== undefined || entry.mail !== undefined) return 'other';
  if (entry.url || entry.urlPattern) return 'url';
  if (typeof entry.text === 'string' && entry.text) return 'screen';
  return 'other';
}

export function criteriaOf(charterMd) {
  const out = {};
  for (const line of String(charterMd ?? '').split('\n')) {
    const row = /^\s*-\s*\[(ch:[^\]\s]+)\].*?\bby:\s*(.*)$/.exec(line);
    if (!row) continue;
    for (const m of row[2].matchAll(/\bexpectation\s+([^\s,;]+)/g)) (out[m[1]] ??= []).push(row[1]);
  }
  return out;
}

export function criterionOf(entry, byName = {}) {
  if (typeof entry?.criterion === 'string' && entry.criterion.trim()) return entry.criterion.trim();
  const found = byName[entry?.name];
  return found?.length ? [...new Set(found)].join(',') : '-';
}

const nameOf = (entry, index) => (typeof entry?.name === 'string' && entry.name ? entry.name : `#${index + 1}`);

// ── screens ──────────────────────────────────────────────────────────────────

function matcherOf(text) {
  const s = String(text);
  const slash = s.lastIndexOf('/');
  if (s.startsWith('/') && slash > 0) {
    new RegExp(s.slice(1, slash), s.slice(slash + 1)); // throws on a bad pattern
    return { re: s.slice(1, slash), flags: s.slice(slash + 1).replace('g', '') };
  }
  return { exact: s };
}

const screenGlobs = (entry) => listOf(entry.screens).filter((g) => typeof g === 'string').map(glob);

// The states of a map screen an entry is in scope on: 'all', a set of state names, or null (not in scope).
function scopeOn(entry, screen) {
  const globs = screenGlobs(entry);
  if (globs.some((re) => re.test(screen.name))) return 'all';
  const states = (screen.steps ?? []).filter((s) => typeof s?.capture === 'string').map((s) => s.capture);
  const hit = new Set([...(states.length ? states : ['default'])].filter((st) => globs.some((re) => re.test(`${screen.name}__${st}`))));
  return hit.size ? hit : null;
}

const viewportsOf = (entry, screen, profile) => Object.keys(profile.viewports ?? {}).filter((vp) =>
  (!Array.isArray(entry.viewports) || entry.viewports.includes(vp)) && (!Array.isArray(screen.viewports) || screen.viewports.includes(vp)));

// In the page: per matcher, the elements capture.mjs snapshot would collect for that text (see its collect()).
function countInPage(matchers) {
  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const textOf = (n) => (n.matches('input, textarea, select') ? n.value : n.innerText ?? n.textContent);
  const contextOf = (node, own) => {
    let context = '';
    const td = node.closest('td');
    const ths = td?.closest('table')?.querySelectorAll('thead tr:last-child th');
    if (td && ths && td.colSpan === 1 && td.parentElement.children.length === ths.length) {
      context = norm(ths[[...td.parentElement.children].indexOf(td)]?.innerText ?? '');
    }
    if (!context && node.closest('thead')) context = 'column header';
    if (!context) {
      const chain = [];
      for (let p = node.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
        const t = norm(norm(p.innerText ?? p.textContent).replace(own, ''));
        if (t.length > 60) break;
        if (t && t !== chain.at(-1)) chain.push(t);
      }
      context = chain.join(' › ');
    }
    return context;
  };
  return matchers.map((m) => {
    const hit = (t) => (m.exact !== undefined ? t === m.exact : new RegExp(m.re, m.flags).test(t));
    const found = [];
    for (const n of document.body.querySelectorAll('*')) {
      if (SKIP.has(n.tagName) || !hit(norm(n.textContent))) continue;
      if ([...n.children].some((c) => hit(norm(c.textContent)))) continue;
      const box = n.getBoundingClientRect();
      if (!box.width || !box.height || getComputedStyle(n).visibility === 'hidden') continue;
      const own = norm(textOf(n));
      if (!hit(own)) continue;
      found.push({ text: own.slice(0, 80), svg: Boolean(n.closest('svg')), context: contextOf(n, own) });
    }
    const want = m.context ? String(m.context).toLowerCase() : null;
    return {
      id: m.id, count: found.length, svg: found.filter((f) => f.svg).length,
      matched: want ? found.filter((f) => f.context.toLowerCase().includes(want)).length : found.length,
      samples: [...found.filter((f) => f.svg), ...found.filter((f) => !f.svg)].slice(0, 3).map((f) => f.text),
      contexts: [...new Set(found.map((f) => f.context).filter(Boolean))].slice(0, 3),
    };
  });
}

export async function observeScreens({ profile, mainRoot, baseUrl, cwd, vars, map, entries, clock = null, headless = true, pw, runVerb, log = () => {} } = {}) {
  pw ??= (await import('./playwright.mjs')).loadPlaywright(mainRoot);
  const observations = [];
  const failures = [];
  const matchers = new Map();
  for (const { index, entry } of entries) {
    try {
      matchers.set(index, { id: index, ...matcherOf(entry.text), context: entry.context ?? null });
    } catch { /* judgeScreens names the bad pattern */ }
  }
  const logins = new Map();
  for (const vp of Object.keys(profile.viewports ?? {})) {
    const size = profile.viewports[vp];
    for (const mapped of map.screens ?? []) {
      const here = entries.map(({ index, entry }) => ({ index, entry, scope: matchers.has(index) && viewportsOf(entry, mapped, profile).includes(vp) ? scopeOn(entry, mapped) : null }))
        .filter((x) => x.scope);
      if (!here.length) continue;
      const failed = (error) => failures.push({ viewport: vp, screen: mapped.name, error });
      let screen;
      try {
        screen = expandScreen(mapped, { flows: map.flows, seed: map.seed, seedFile: map.seedFile, profile });
      } catch (e) {
        failed(`MAP ERROR: ${firstLine(e)}`);
        continue;
      }
      let storageState = null;
      if (screen.role) {
        const key = `${vp}\0${screen.role}`;
        if (!logins.has(key)) {
          logins.set(key, (async () => {
            const context = await openBrowser(pw, { profile, headless, viewport: size });
            try {
              return await login(context, { role: screen.role, baseUrl, profile, mainRoot, cwd, vars, ...(runVerb ? { runVerb } : {}) });
            } catch (e) {
              return { error: `login ${screen.role}: ${firstLine(e)}` };
            } finally {
              await context.close().catch(() => {});
            }
          })());
        }
        const res = await logins.get(key);
        if (res.notRun || res.error) {
          failed(res.notRun ?? res.error);
          continue;
        }
        storageState = res.storageState;
      }
      const context = await openBrowser(pw, { profile, headless, storageState, viewport: size, clock });
      try {
        const page = await context.newPage();
        const look = async (state) => {
          await settle(page, profile);
          const scoped = here.filter((x) => x.scope === 'all' || x.scope.has(state));
          if (!scoped.length) return;
          const counted = await page.evaluate(countInPage, scoped.map((x) => matchers.get(x.index)));
          let tree = [];
          try {
            tree = (await page.locator('body').ariaSnapshot()).split('\n').map(treeText).filter(Boolean);
          } catch { /* no tree: the DOM count stands alone */ }
          for (const c of counted) {
            const m = matchers.get(c.id);
            const hit = (t) => (m.exact !== undefined ? t === m.exact : new RegExp(m.re, m.flags).test(t));
            observations.push({ index: c.id, viewport: vp, screen: mapped.name, key: `${mapped.name}__${state}`, count: c.count, svg: c.svg, matched: c.matched, tree: tree.filter(hit).length, samples: c.samples, contexts: c.contexts });
          }
        };
        const ctx = { baseUrl, profile, root: cwd ?? mainRoot, recording: false, runTour: async () => {} };
        const steps = screen.steps ?? [];
        for (const s of steps) {
          if (s.capture) await look(s.capture);
          else await runStep(page, s, ctx);
        }
        if (!steps.some((s) => s.capture)) await look('default');
        log(`plan check: ${mapped.name} (${vp}) walked`);
      } catch (e) {
        failed(firstLine(e));
      } finally {
        await context.close().catch(() => {});
      }
    }
  }
  return { observations, failures };
}

export function judgeScreens({ entries, map, profile, observations = [], failures = [], maxMatches = DEFAULT_MAX_MATCHES }) {
  const out = {};
  const say = (index, problem) => (out[index] ??= []).push(problem);
  for (const { index, entry } of entries) {
    const inScope = (map?.screens ?? []).filter((s) => scopeOn(entry, s) && viewportsOf(entry, s, profile).length);
    if (!inScope.length) {
      say(index, `screens ${JSON.stringify(entry.screens ?? null)} matches no map screen`);
      continue;
    }
    if (kindOf(entry) === 'url') continue;
    try {
      matcherOf(entry.text);
    } catch (e) {
      say(index, `text: ${firstLine(e)}`);
      continue;
    }
    const seen = observations.filter((o) => o.index === index);
    const walked = new Set(seen.map((o) => `${o.viewport}\0${o.screen}`));
    const lost = failures.filter((f) => inScope.some((s) => s.name === f.screen) && !walked.has(`${f.viewport}\0${f.screen}`));
    if (!seen.length && lost.length) {
      say(index, `could not walk ${lost[0].screen} (${lost[0].viewport}): ${lost[0].error}`);
      continue;
    }
    const svg = seen.find((o) => o.svg > 0);
    if (svg && entry.svg !== true) {
      say(index, `matches text inside an <svg> on ${svg.key} (${svg.viewport}): "${svg.samples[0] ?? ''}"; capture reads no chart text: match the text around the chart, or say "svg": true`);
    }
    if (entry.after === 'absent') continue;
    const many = seen.find((o) => o.count > maxMatches);
    if (many) say(index, `matches ${many.count} elements on ${many.key} (${many.viewport}), more than ${maxMatches}: narrow the text, the context or the screens`);
    // Observed: an element with the text (and the context), or, when no element carries it at all, a line of the
    // accessibility tree (an aria-label's name), as compare finds it.
    if (seen.length && !seen.some((o) => o.matched > 0 || (o.count === 0 && o.tree > 0))) {
      const keys = [...new Set(seen.map((o) => o.key))];
      const vps = [...new Set(seen.map((o) => o.viewport))];
      const where = `${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` +${keys.length - 3} more` : ''} (${vps.join(', ')})`;
      const elsewhere = entry.context ? seen.filter((o) => o.count > 0) : [];
      if (elsewhere.length) {
        const contexts = [...new Set(elsewhere.flatMap((o) => o.contexts ?? []))].slice(0, 3);
        say(index, `"${entry.text}" is on ${where}, but never with context "${entry.context}"${contexts.length ? ` (its contexts: ${contexts.map((x) => `"${x}"`).join(', ')})` : ''}`);
      } else say(index, `observes 0 elements on ${where}: "${entry.text}" is not on head there`);
    }
  }
  return out;
}

// ── tests ────────────────────────────────────────────────────────────────────

const tailLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';

export async function resolveTest({ entry, suites, dir, profile = {}, mainRoot = null, vars = {}, logDir, runVerb, exec = execCommand, listTimeoutMs = 120000 } = {}) {
  const bad = (problem) => ({ ok: false, problem });
  const problem = entryProblem(entry, suites);
  if (problem) return bad(problem);
  const t = entry.test;
  const how = suiteRun(t, suites);
  const testFile = t.file === undefined ? null : path.resolve(dir, t.file);
  if (testFile && !fs.existsSync(testFile)) return bad(`test.file ${t.file} is not in the head tree`);
  const of = t.file ? ` of ${t.file}` : '';
  if (how.level === null) {
    fs.mkdirSync(logDir, { recursive: true });
    const stem = `plan-${safeName(entry.name)}`;
    const plan = commandFor(how.suite, { grep: t.grep, report: path.join(logDir, `${stem}.report`), testFile });
    if (!plan.narrowed) return bad(wholeSuiteWhy(t.suite, t, plan));
    const listReport = path.join(logDir, `${stem}.list.report`);
    const list = listCommandFor(how.suite, { grep: t.grep, report: listReport, testFile });
    if (list) {
      fs.rmSync(listReport, { force: true });
      const env = { ...process.env, QA_ROOT: String(dir), QA_MAIN_ROOT: String(mainRoot ?? ''), QA_SLUG: String(vars.slug ?? ''), QA_PORT: vars.port == null ? '' : String(vars.port), ...list.env };
      delete env.NODE_TEST_CONTEXT;
      const r = await exec({ file: list.file, argv: list.argv, cwd: dir, env, logFile: path.join(logDir, `${stem}.list.log`), timeoutMs: Math.min(listTimeoutMs, timeoutOf(how.suite, profile)) });
      let report = null;
      try { report = fs.readFileSync(listReport, 'utf8'); } catch { /* the list printed on its output */ }
      const parsed = parseListed(list.runner, { output: r.output, report });
      if (list.kind === 'files') {
        if (!parsed.files?.length) return bad(`jest lists no test file${t.file ? ` for ${t.file}` : ''} (exit ${r.code ?? 'none'}${r.timedOut ? ', timed out' : ''}): ${tailLine(r.output)}`);
      } else {
        if (!parsed.tests) return bad(`the ${list.runner} list gave no test names (exit ${r.code ?? 'none'}${r.timedOut ? ', timed out' : ''}): ${tailLine(r.output)}`);
        const matched = parsed.tests.filter(grepMatcher(t.grep));
        if (!matched.length) {
          const first = parsed.tests[0]?.name;
          return bad(`no test matches "${t.grep}" in the ${list.runner} list${of} (${parsed.tests.length} listed${first ? `, first: ${first}` : ''})`);
        }
        return { ok: true, how: `${list.runner} list`, names: matched.slice(0, 5).map((x) => x.name) };
      }
    }
  }
  const [record] = await runTests({ dir, entries: [entry], suites, profile, mainRoot, vars, logDir, runVerb, side: 'plan', exec });
  if (record.result === 'met' || record.result === 'NOT MET') return { ok: true, how: 'ran filtered', names: record.names };
  return bad(record.why.replace(/^not run: /, ''));
}

// ── routes ───────────────────────────────────────────────────────────────────

export function routeProblem(entry, { rows = null, roles = [], file = null } = {}) {
  if (!rows) return 'no route table: a route the table lacks cannot be probed';
  const route = String(entry.route ?? '').trim();
  const at = route.indexOf(' ');
  if (at < 0) return 'route must be "<METHOD> <path>"';
  const method = route.slice(0, at).toUpperCase();
  const where = route.slice(at + 1).trim();
  const known = rows.some((r) => routeName(r) === route || (r.method === method && Array.isArray(r.calls) && r.calls.includes(where)) || matchRoute(r, method, where));
  if (!known) return `route "${route}" is not in the route table (${file ?? 'qa/routes.table.*'})`;
  const as = entry.as ?? 'anon';
  if (as !== 'anon' && !roles.includes(as)) return `as "${as}" is not anon or a login role (${roles.join(', ') || 'none'})`;
  return null;
}

// ── the whole check ──────────────────────────────────────────────────────────

function showAt(repoRoot, sha, file) {
  try {
    return execFileSync('git', ['show', `${sha}:${file}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export async function planCheck(opts, deps = {}) {
  const { mainRoot, repoRoot, profile, slug, V, head } = opts;
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const d = {
    up: sandbox.up, down: sandbox.down, observe: observeScreens, resolveTest, loadRouteTable,
    read: (sha, file) => showAt(repoRoot, sha, file), ...deps,
  };
  const expectFile = path.join(V, 'expectations.json');
  if (!fs.existsSync(expectFile)) throw new Error(`no ${expectFile}: the plan writes it first`);
  const list = readJson(expectFile);
  if (!Array.isArray(list)) throw new Error(`${expectFile} is not a JSON array`);
  const mutantsFile = path.join(V, 'mutants.json');
  let proposals = [];
  if (fs.existsSync(mutantsFile)) {
    const data = readJson(mutantsFile);
    proposals = Array.isArray(data?.mutants) ? data.mutants : [];
  }
  const charter = fs.existsSync(path.join(V, 'charter.md')) ? fs.readFileSync(path.join(V, 'charter.md'), 'utf8') : '';
  const byName = criteriaOf(charter);
  const stubbed = resolveStubs(profile, charterStubs(charter));
  const stubProblems = stubbed.unknown.map((id) => ({ id, problem: 'not declared in qa.json stubs: name a declared stub (qa profile lists them) or take another rung' }));
  const indexed = list.map((entry, index) => ({ index, entry, kind: kindOf(entry) }));
  const of = (...kinds) => indexed.filter((x) => kinds.includes(x.kind));
  const counts = Object.fromEntries(['screen', 'url', 'test', 'doc', 'route', 'other'].map((k) => [k, of(k).length]));
  counts.mutant = proposals.length;
  const maxMatches = profile.plan?.maxMatches ?? DEFAULT_MAX_MATCHES;
  const found = {};
  const say = (index, problem) => (found[index] ??= []).push(problem);
  const mutantProblems = [];
  const notes = [];

  // Docs: from git at head, no sandbox.
  for (const { index, entry } of of('doc')) {
    const bad = docProblem(entry);
    if (bad) say(index, bad);
    else if (d.read(head, entry.doc.file) === null) say(index, `doc.file ${entry.doc.file} is not in the head commit`);
  }

  let desc = null;
  let blocked = null;
  const needsSandbox = of('screen', 'url', 'test', 'route').length > 0 || proposals.length > 0;
  // Suites mode (suitesmode.mjs): nothing serves an app, so the tests and the mutants' kill tests are resolved in a
  // worktree of the head commit, and a screen, url or route expectation has nothing to run on.
  const suitesMode = suitesModeApplies({ repoRoot, mainRoot, profile, map: opts.map ?? null }).applies;
  if (suitesMode) {
    for (const { index } of of('screen', 'url', 'route')) say(index, 'suites mode: this project has no screens and nothing serves an app, so a screen, url or route expectation cannot run: name a test or a doc');
  }
  const check = async () => {
    try {
      if (desc) {
        const vars = { dir: desc.dir, main: mainRoot, slug: desc.slug, port: String(desc.port) };
        const logDir = path.join(V, 'logs', 'plan');
        // Routes: the head tree's table, as the run's sweep reads it.
        if (of('route').length && !suitesMode) {
          let table = null;
          try {
            table = await d.loadRouteTable({ root: desc.dir, profile });
          } catch (e) {
            table = { file: null, rows: [], errors: [firstLine(e)] };
          }
          for (const { index, entry } of of('route')) {
            const bad = routeProblem(entry, { rows: table?.file ? table.rows : null, roles: Object.keys(profile.login ?? {}), file: table?.file });
            if (bad) say(index, bad);
          }
        }
        // Tests and the mutants' kill tests: the runners' own list modes.
        const loaded = of('test').length || proposals.length ? await loadSuites({ root: desc.dir, profile }) : null;
        if (loaded?.note) notes.push(loaded.note);
        for (const { index, entry } of of('test')) {
          const r = await d.resolveTest({ entry, suites: loaded.suites, dir: desc.dir, profile, mainRoot, vars, logDir });
          log(`plan check: test ${nameOf(entry, index)}: ${r.ok ? `ok (${r.how})` : r.problem}`);
          if (!r.ok) say(index, r.problem);
        }
        for (const [index, m] of proposals.entries()) {
          const id = isObject(m) && typeof m.id === 'string' ? m.id : `#${index + 1}`;
          let bad = isObject(m) && m.kill === undefined ? 'no kill test: a mutant runs only with kill { suite, grep } naming the test that must fail' : mutantProblem(m, loaded.suites);
          if (!bad) bad = staleWhy(desc.dir, m);
          if (!bad) {
            const r = await d.resolveTest({ entry: { name: `mut-${id}`, test: m.kill }, suites: loaded.suites, dir: desc.dir, profile, mainRoot, vars, logDir });
            if (!r.ok) bad = `kill: ${r.problem}`;
          }
          if (bad) mutantProblems.push({ index, id, problem: bad });
        }
        // Screens: one walk of each screen in scope, per viewport.
        const screens = of('screen', 'url');
        if (screens.length && !suitesMode) {
          const mapProfile = { ...profile, map: opts.map ?? path.resolve(repoRoot, profile.map ?? 'qa/map') };
          if (opts.seedNames) mapProfile.seedNames = opts.seedNames;
          else if (fs.existsSync(path.resolve(repoRoot, profile.seedNames ?? 'qa/seed.json'))) mapProfile.seedNames = path.resolve(repoRoot, profile.seedNames ?? 'qa/seed.json');
          let map = null;
          try {
            map = loadMap({ root: repoRoot, profile: mapProfile });
          } catch (e) {
            for (const { index } of screens) say(index, `the map does not load: ${firstLine(e)}`);
          }
          if (map) {
            const { resolveClock } = await import('./run.mjs');
            let clock = null;
            try {
              clock = resolveClock(profile.clock ?? 'seed', desc.seedStartedAt ?? null).clock;
            } catch { /* the real clock */ }
            const observed = of('screen').length
              ? await d.observe({ profile, mainRoot, baseUrl: desc.appUrl, cwd: desc.dir, vars, map, entries: of('screen').map(({ index, entry }) => ({ index, entry })), clock, headless: opts.headless !== false, log })
              : { observations: [], failures: [] };
            const judged = judgeScreens({ entries: screens.map(({ index, entry }) => ({ index, entry })), map, profile, observations: observed.observations, failures: observed.failures, maxMatches });
            for (const [index, problems] of Object.entries(judged)) for (const p of problems) say(Number(index), p);
          }
        }
      }
    } finally {
      if (desc && !desc.reused) {
        try {
          await d.down({ mainRoot, profile, name: desc.name });
        } catch (e) {
          log(`plan check: sandbox down ${desc.name}: ${firstLine(e)}`);
        }
      }
    }
  };
  if (suitesMode && (of('test').length > 0 || proposals.length > 0)) {
    await withHeadWorktree({ repoRoot, mainRoot, headSha: head, slug: `${slug}-plan` }, async (dir) => {
      desc = { dir, name: null, appUrl: null, port: '', seedStartedAt: null, reused: true, slug };
      await check();
    });
    desc = null;
  } else if (!suitesMode && needsSandbox) {
    try {
      desc = await d.up({ mainRoot, profile, at: head, qaFrom: repoRoot, log, stubs: stubbed.ids });
    } catch (e) {
      blocked = firstLine(e);
    }
    if (desc) await check();
  }

  const problems = indexed.filter((x) => found[x.index]).map(({ index, entry, kind }) => ({
    index, name: nameOf(entry, index), criterion: criterionOf(entry, byName), kind, problem: found[index].join('; '),
  }));
  return {
    slug, head, sandbox: desc ? { name: desc.name, state: desc.reused ? 'reused' : 'up' } : null, blocked, maxMatches, counts,
    problems, mutants: mutantProblems, stubs: stubProblems, notes, ms: Date.now() - started,
  };
}

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, ' ');

export function planCheckMd(check, { dropped = false } = {}) {
  const c = check.counts ?? {};
  const lines = [
    `# Plan check — ${check.slug}`,
    `head: ${String(check.head ?? '').slice(0, 12)} · ${check.sandbox ? `sandbox ${check.sandbox.name} (${check.sandbox.state})` : 'no sandbox'} · at most ${check.maxMatches} matching elements per capture`,
    `checked: ${c.screen ?? 0} screen · ${c.url ?? 0} url · ${c.test ?? 0} test · ${c.doc ?? 0} doc · ${c.route ?? 0} route · ${c.mutant ?? 0} mutant${c.other ? ` · not checked here: ${c.other} other` : ''}`,
    ...(check.notes ?? []).map((n) => `note: ${n}`),
    ...(check.blocked ? [`blocked: ${oneLine(check.blocked)} (nothing that needs the head sandbox was checked)`] : []),
    '',
    dropped ? '## Dropped from the plan' : '## Problems',
    ...(check.problems.length ? check.problems.map((p) => `- [${p.name}] ${p.criterion}: ${oneLine(p.problem)}`) : ['- none']),
  ];
  if (check.mutants?.length) {
    lines.push('', dropped ? '## Mutants dropped' : '## Mutant problems', ...check.mutants.map((m) => `- mut:${m.id}: ${oneLine(m.problem)}`));
  }
  if (check.stubs?.length) {
    lines.push('', dropped ? '## Stubs dropped' : '## Stub problems', ...check.stubs.map((x) => `- stub:${x.id}: ${oneLine(x.problem)}`));
  }
  return `${lines.join('\n')}\n`;
}

export function dropFailed({ V, check }) {
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  const expectFile = path.join(V, 'expectations.json');
  const drop = new Set(check.problems.map((p) => p.index));
  let expectations = 0;
  if (drop.size) {
    const list = readJson(expectFile);
    write(expectFile, list.filter((_, i) => !drop.has(i)));
    expectations = drop.size;
  }
  let mutants = 0;
  const mutantsFile = path.join(V, 'mutants.json');
  const gone = new Set((check.mutants ?? []).map((m) => m.index));
  if (gone.size && fs.existsSync(mutantsFile)) {
    const data = readJson(mutantsFile);
    write(mutantsFile, { ...data, mutants: (data.mutants ?? []).filter((_, i) => !gone.has(i)) });
    mutants = gone.size;
  }
  let stubs = 0;
  const charterFile = path.join(V, 'charter.md');
  const badStubs = new Set((check.stubs ?? []).map((x) => x.id));
  if (badStubs.size && fs.existsSync(charterFile)) {
    const text = fs.readFileSync(charterFile, 'utf8');
    const kept = charterStubs(text).filter((id) => !badStubs.has(id));
    fs.writeFileSync(charterFile, withCharterStubs(text, kept));
    stubs = badStubs.size;
  }
  return { expectations, mutants, stubs };
}
