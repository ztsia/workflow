// What a screen shows, as text a model can map from: Playwright's ARIA snapshot (roles and
// accessible names, YAML). The mapper agent reads it to write `role=<role>[name="<name>"]`
// selectors without a browser of its own. Zero model calls.
//
// CONTRACT (tests: test/probe.test.mjs — real headless browser, fixture server)
//
//   probe(page, { maxLines = 400 } = {}) -> Promise<{ url, title, aria, lines, truncated }>
//     aria = await page.locator('body').ariaSnapshot(), cut to its first maxLines lines;
//     lines = the line count before cutting; truncated = lines > maxLines. When truncated, the
//     last line of aria is '# … <n> more lines (raise --lines)'.
//
//   probeScreen({ profile, mainRoot, baseUrl, path = '/', role = null, steps = null,
//                 viewport = 'desktop', pw, cwd, vars, headless = true, maxLines = 400, runVerb, inspect, clock = null })
//     clock: passed to openBrowser (step 3), as capture does.
//     -> Promise<inspect's result (default { url, title, aria, lines, truncated }) | { notRun: string } | { error: string, url }>
//     Logs in as `role` (login.mjs login(), as capture does; a notRun login -> { notRun }), opens
//     a context with capture.mjs openBrowser (that role's storage state, the viewport's size),
//     then either goes to baseUrl + path, or, when `steps` is given (an EXPANDED screen's steps),
//     runs them with capture.mjs runStep (capture steps skipped) instead of the goto. Settles
//     (login.mjs settle), then inspect(page) — probe(page, { maxLines }) unless `inspect` is given
//     (step 3: the CLI's `checks` command passes one that runs checks.mjs runChecks and returns
//     { url, findings }). Any thrown error -> { error: <first line>, url: page url }.
//     The context is always closed.
//
// Example: probeScreen({ …, path: '/candidates', role: 'staff' }) ->
//   { url: 'http://127.0.0.1:8011/candidates', title: 'RMS', lines: 212, truncated: false,
//     aria: '- banner:\n  - link "Dashboard"\n- main:\n  - heading "Candidates" [level=1]\n  - button "Add candidate"\n…' }

import { openBrowser, runStep } from './capture.mjs';
import { login, settle } from './login.mjs';

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

export async function probe(page, { maxLines = 400 } = {}) {
  const full = await page.locator('body').ariaSnapshot();
  const all = full.split('\n');
  const truncated = all.length > maxLines;
  const aria = truncated ? [...all.slice(0, maxLines), `# … ${all.length - maxLines} more lines (raise --lines)`].join('\n') : full;
  return { url: page.url(), title: await page.title(), aria, lines: all.length, truncated };
}

export async function probeScreen({ profile, mainRoot, baseUrl, path = '/', role = null, steps = null, viewport = 'desktop', pw, cwd, vars, headless = true, maxLines = 400, runVerb, inspect, clock = null } = {}) {
  const size = profile.viewports?.[viewport];
  if (!size) return { error: `unknown viewport "${viewport}": the profile has ${Object.keys(profile.viewports ?? {}).join(', ')}`, url: baseUrl };
  pw ??= (await import('./playwright.mjs')).loadPlaywright(mainRoot);

  let storageState = null;
  if (role) {
    const throwaway = await openBrowser(pw, { profile, headless, viewport: size });
    let res;
    try {
      res = await login(throwaway, { role, baseUrl, profile, mainRoot, cwd, vars, ...(runVerb ? { runVerb } : {}) });
    } catch (e) {
      res = { error: `login ${role}: ${firstLine(e)}` };
    } finally {
      await throwaway.close().catch(() => {});
    }
    if (res.notRun) return { notRun: res.notRun };
    if (res.error) return { error: res.error, url: baseUrl };
    storageState = res.storageState;
  }

  const context = await openBrowser(pw, { profile, headless, storageState, viewport: size, clock });
  let page;
  try {
    page = await context.newPage();
    if (steps) {
      for (const step of steps) if (!step.capture) await runStep(page, step, { baseUrl, profile, root: cwd ?? mainRoot });
    } else {
      await page.goto(baseUrl + path, { timeout: 60000 });
    }
    await settle(page, profile);
    return inspect ? await inspect(page) : await probe(page, { maxLines });
  } catch (e) {
    return { error: firstLine(e), url: page?.url?.() ?? baseUrl };
  } finally {
    await context.close().catch(() => {});
  }
}
