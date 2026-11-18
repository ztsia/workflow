// Login per role (design decisions 21, 25): form, storage-state, manual. Secrets never in qa.json:
// a form login reads env NAMES, or asks the stack adapter's `logins` verb (which knows the seeded
// accounts of its sandbox).
// loginForm fills and submits; settle and visible wait for the page.
//
// qa.json `login.<role>`:
//   form:          { mode: 'form', path: '/auth', from: 'env' | 'adapter',
//                    user: 'QA_HR_EMAIL', password: 'QA_HR_PASSWORD',     (env names; from: 'env')
//                    account: 'staff',                                      (role in `logins` output; from: 'adapter', default = the role key)
//                    fields: { user: selector, password: selector }, submit: selector,
//                    done: { urlNot: '/auth' } | { waitFor: selector } }
//   storage-state: { mode: 'storage-state', file: 'qa-artifacts/auth/staff.json' }  (path from mainRoot; never committed)
//   manual:        { mode: 'manual', path: '/auth', done: {...} }  -> `qa login <role> --manual`
//                  saves qa-artifacts/auth/<role>.json; captures then use it like storage-state.
//
// CONTRACT (tests: test/login.test.mjs — pure parts only; the browser part is proven by the RMS run)
//
//   credentials(role, { profile, mainRoot, cwd, vars, env = process.env, runVerb })
//     -> Promise<{ user, password } | { notRun: string }>
//     from 'env': both env vars set -> values; else notRun 'NOT RUN: login <role>: env QA_HR_EMAIL unset'.
//     from 'adapter': runVerb('logins', …) -> stdout last line JSON array [{ role, email, password }];
//       pick role === (account ?? role); missing -> notRun 'NOT RUN: login <role>: adapter has no account <x>'.
//       `email` maps to user. runVerb is injected (adapter.runVerb by default) so tests stub it.
//
//   storageFile(role, { profile, mainRoot }) -> absolute path   (storage-state: its file; manual:
//     <mainRoot>/qa-artifacts/auth/<role>.json; form: null)
//
//   login(context, { role, baseUrl, profile, mainRoot, cwd, vars, runVerb })
//     -> Promise<{ ok: true, storageState: object } | { notRun: string } | { error: string }>
//     form: open a page, goto baseUrl+path, fill fields, click submit, wait for `done`
//       (urlNot: URL path no longer starts with it; waitFor: selector visible) up to
//       profile.stepTimeoutMs; then settle(); return context.storageState().
//       Done never reached -> { error: 'login <role>: still on <url> after submit' }.
//     storage-state / manual: file missing -> notRun 'NOT RUN: login <role>: no <file> (run qa login <role> --manual)';
//       else add its cookies/origins to the context and return it.
//
//   manualLogin(role, { baseUrl, profile, mainRoot, openBrowser }) -> Promise<string>  file written
//     headed browser at baseUrl+path; waits (no timeout) for `done`; writes storageState to
//     storageFile(role) with mode 0600; returns the path.
//
//   settle(page, profile) -> Promise<void>
//     waits for network idle-ish: no request in flight for settle.quietMs, capped at settle.timeoutMs;
//     and, when settle.hidden is set, until no element matching it is visible. Never throws.

import fs from 'node:fs';
import path from 'node:path';

const notRun = (role, why) => ({ notRun: `NOT RUN: login ${role}: ${why}` });
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const visible = (page, selector) => page.locator(selector).filter({ visible: true }).first();
const roleConfig = (role, profile) => profile?.login?.[role] ?? null;

export async function credentials(role, { profile, mainRoot, cwd, vars, env = process.env, runVerb } = {}) {
  const cfg = roleConfig(role, profile);
  if (!cfg) return notRun(role, 'no login configured in qa.json');
  const from = cfg.from ?? (cfg.user ? 'env' : 'adapter');
  if (from === 'env') {
    const user = env[cfg.user];
    const password = env[cfg.password];
    if (!cfg.user || !user) return notRun(role, `env ${cfg.user ?? 'user (no name given)'} unset`);
    if (!cfg.password || !password) return notRun(role, `env ${cfg.password ?? 'password (no name given)'} unset`);
    return { user, password };
  }
  if (from !== 'adapter') return notRun(role, `unknown credentials source ${from}`);
  const verb = runVerb ?? (await import('./adapter.mjs')).runVerb;
  const res = await verb('logins', { profile, mainRoot, cwd, vars });
  if (res?.notRun) return notRun(role, String(res.notRun).replace(/^NOT RUN: /, ''));
  if (res?.code) return notRun(role, `adapter logins verb exited ${res.code}`);
  // The verb's answer is its last stdout line; earlier lines are progress.
  const last = String(res?.stdout ?? '').split(/\r?\n/).filter((l) => l.trim()).at(-1) ?? '';
  let rows;
  try {
    rows = JSON.parse(last);
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) return notRun(role, 'adapter logins output is not a JSON array on its last line');
  const account = cfg.account ?? role;
  const row = rows.find((r) => r?.role === account);
  if (!row) return notRun(role, `adapter has no account ${account}`);
  return { user: row.email ?? row.user, password: row.password };
}

export function storageFile(role, { profile, mainRoot } = {}) {
  const cfg = roleConfig(role, profile);
  if (cfg?.mode === 'storage-state') return path.resolve(mainRoot, cfg.file);
  if (cfg?.mode === 'manual') return path.join(mainRoot, 'qa-artifacts', 'auth', `${role}.json`);
  return null;
}

// Wait until the login has gone through: the URL path leaves `urlNot`, or `waitFor` shows. Default: leave the login path.
async function waitDone(page, cfg, timeout) {
  const done = cfg.done ?? { urlNot: cfg.path ?? '/' };
  if (done.waitFor) return visible(page, done.waitFor).waitFor({ state: 'visible', timeout });
  const stay = done.urlNot ?? cfg.path ?? '/';
  await page.waitForURL((u) => !new URL(String(u)).pathname.startsWith(stay), { waitUntil: 'commit', timeout });
}

export async function login(context, { role, baseUrl, profile, mainRoot, cwd, vars, runVerb } = {}) {
  const cfg = roleConfig(role, profile);
  if (!cfg) return notRun(role, 'no login configured in qa.json');
  if (cfg.mode === 'storage-state' || cfg.mode === 'manual') {
    const file = storageFile(role, { profile, mainRoot });
    if (!fs.existsSync(file)) return notRun(role, `no ${file} (run qa login ${role} --manual)`);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { error: `login ${role}: ${file} is not valid JSON (${firstLine(e)})` };
    }
    if (state.cookies?.length) await context.addCookies(state.cookies);
    // A context cannot take localStorage after it is made, so seed it before each page of that origin loads.
    if (state.origins?.length) {
      await context.addInitScript((origins) => {
        const o = origins.find((x) => x.origin === location.origin);
        if (o) for (const { name, value } of o.localStorage ?? []) localStorage.setItem(name, value);
      }, state.origins);
    }
    return { ok: true, storageState: state };
  }
  if (cfg.mode !== 'form') return { error: `login ${role}: unknown mode ${cfg.mode}` };

  const creds = await credentials(role, { profile, mainRoot, cwd, vars, runVerb });
  if (creds.notRun) return creds;
  const timeout = profile?.stepTimeoutMs ?? 20000;
  const fields = { user: 'input[type=email], input[name=email], input[name=username]', password: 'input[type=password]', ...cfg.fields };
  const page = await context.newPage();
  try {
    await page.goto(baseUrl + (cfg.path ?? '/'), { timeout: 60000 });
    await visible(page, fields.user).fill(creds.user, { timeout });
    await visible(page, fields.password).fill(creds.password, { timeout });
    await visible(page, cfg.submit ?? 'button[type=submit]').click({ timeout });
    try {
      await waitDone(page, cfg, timeout);
    } catch {
      return { error: `login ${role}: still on ${page.url()} after submit` };
    }
    await settle(page, profile);
    return { ok: true, storageState: await context.storageState() };
  } catch (e) {
    return { error: `login ${role}: ${firstLine(e)}` };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function manualLogin(role, { baseUrl, profile, mainRoot, openBrowser } = {}) {
  const cfg = roleConfig(role, profile);
  if (!cfg || cfg.mode !== 'manual') throw new Error(`login ${role}: not a manual login in qa.json`);
  const file = storageFile(role, { profile, mainRoot });
  const context = await openBrowser({ headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseUrl + (cfg.path ?? '/'), { timeout: 60000 });
    console.error(`Log in as ${role} in the browser window (no time limit); it saves when the login goes through.`);
    const closed = new Promise((_, reject) => context.on('close', () => reject(new Error(`login ${role}: the browser was closed before the login finished`))));
    await Promise.race([waitDone(page, cfg, 0), closed]);
    await settle(page, profile);
    const state = await context.storageState();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } finally {
    await context.close().catch(() => {});
  }
}

// Let data land: loading placeholders gone (settle.hidden), then no request in flight for quietMs, all capped at
// settle.timeoutMs. Requests already running when it is called are not seen; the load state covers a fresh page.
export async function settle(page, profile) {
  const { timeoutMs = 10000, quietMs = 500, hidden = null } = profile?.settle ?? {};
  const deadline = Date.now() + timeoutMs;
  let inflight = 0;
  let lastActivity = Date.now();
  const start = () => (inflight++, (lastActivity = Date.now()));
  const end = () => (inflight = Math.max(0, inflight - 1), (lastActivity = Date.now()));
  try {
    page.on('request', start);
    page.on('requestfinished', end);
    page.on('requestfailed', end);
    if (hidden) {
      await page
        .waitForFunction((sel) => ![...document.querySelectorAll(sel)].some((el) => el.offsetParent !== null), hidden, { timeout: Math.max(1, deadline - Date.now()) })
        .catch(() => {});
    }
    await page.waitForLoadState('load', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
    while (Date.now() < deadline) {
      if (inflight === 0 && Date.now() - lastActivity >= quietMs) break;
      await page.waitForTimeout(50);
    }
  } catch {
    // never throws: a closed page ends the wait
  } finally {
    page.off('request', start);
    page.off('requestfinished', end);
    page.off('requestfailed', end);
  }
}
