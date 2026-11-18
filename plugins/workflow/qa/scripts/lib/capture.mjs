// Walks the map in a real browser and records what each screen shows. Zero model calls.
// It runs steps, collects each screen's snapshot with element context, overflow, expandEach, write
// policing and click-ring recordings. Every setting comes from qa.json; login is login.mjs per role.
//
// CONTRACT (tests: test/capture.test.mjs — runs a real headless browser against a fixture server)
//
//   openBrowser(pw, { profile, headless = true, recordDir = null, storageState = null, viewport, clock = null })
//     -> Promise<BrowserContext>
//     clock (step 3): an ISO time -> await context.clock.setFixedTime(new Date(clock)) before any
//     page opens (Date.now and new Date() return it; timers still run). null -> the real clock.
//     capture({ …, clock = null }) passes it to every screen's context (never the login's).
//     browser.channel 'chrome' (default) = the installed Chrome; when launch fails because it is
//     missing, fall back to Playwright's bundled chromium and add a warning; 'chromium' = bundled only. Where
//     Playwright's chromium is not downloaded either, /opt/pw-browsers/chromium is launched by executablePath.
//     Context: viewport [w,h] -> { width, height }, reducedMotion 'reduce', locale 'en-US',
//     timezoneId 'UTC', recordVideo { dir: recordDir, size: viewport } when recordDir.
//
//   capture({ profile, mainRoot, baseUrl, screens, out, viewport = 'desktop', record = false,
//             headless = true, cwd, vars, pw, log = console.error, flows = {}, seed = null, seedFile })
//     -> Promise<{ viewport, captured: string[], failed: [{ screen, step, error }], notRun: [{ screen, why }],
//                  warnings: string[] }>
//     pw = loadPlaywright(mainRoot) unless given. Per role: one login (login.mjs) per viewport,
//     storage state reused by every screen of that role; a notRun login marks each screen of
//     that role notRun (never captured, never passed).
//     MAP (step 2): each screen is expanded with map.mjs expandScreen(screen, { flows, seed,
//     seedFile, profile }) BEFORE its login, so a `login:<role>` flow sets the role used. A MapError
//     opens no browser: failed gets { screen, step: 'map', error: 'MAP ERROR: <message>', mapError: true }
//     and <screen>__FAILED.json { screen, step: 'map', error, url: baseUrl, mapError: true }; the other
//     screens still run. A failing step's `step` in failed/FAILED.json is JSON of the expanded step,
//     so a step from a flow shows its `via`.
//     Per screen: fresh page; requestOverrides;
//     write policing; run steps; at each `capture` step (and once at the end when the screen has
//     none, state name 'default') settle then snapshot.
//     Files under <out>/<viewport>/:
//       <screen>__<state>.png        full page
//       <screen>__<state>.json       the record below
//       <screen>__<state>__<n>.png   crop of watched element n (n from 0)
//       <screen>__FAILED.json/.png   on a failing non-optional step: { screen, step, error, url }
//       <screen>.webm                when record (screen.record or record=true)
//     Record JSON (unchanged from visual-diff, so compare.mjs reads both):
//       { screen, capture, url, takenAt, viewport, role, watch,
//         elements: [{ text, context, className, style: { background, color, border }, shot }],
//         overflow: [{ key, by, text }], writes: [{ method, url, status }], errors: [string],
//         ignoredErrors: [string], overrides: [string] }
//     Recording: the red click ring init script (36px, #e53935, 800 ms) and the 900 ms pause after
//     click/clickAll/fill/press/hover, as in visual-diff.
//
//     STEP 3 (tree, checks, tour, deterministic capture):
//       capture() takes two more options, checks = true and tour = true (the CLI's --no-checks /
//       --no-tour pass false); profile.checks.enabled / profile.tour.enabled false turn them off too.
//       openBrowser adds serviceWorkers: 'block' to the context. snapshot() awaits
//       document.fonts.ready (5 s cap) before the PNG.
//       Every snapshot, after the PNG, crops and overflow, in this order:
//         tree   tree.mjs ariaTree(page) -> <screen>__<state>.aria.yml; record.tree = that basename.
//         checks when checks are on: checks.mjs runChecks(page, { touch, keyboardHeight }) with
//                touch = viewport width < profile.checks.touchBelow; record.checks = the findings
//                ([] when none; null when checks are off).
//         tour   only on the LAST capture of a screen (the 'default' one when it has no capture
//                step), when tour is on, screen.tour !== false, and the screen has NO tour step
//                (tour steps replace the automatic tour): tour.mjs tourPage(page, { ...profile.tour, ...(screen.tour object), shot }).
//       A { tour: true | {options} } STEP runs tourPage at that point (options merged the same
//       way) when tour is on; its result waits in the screen's trace and goes into the next record.
//       A tour step AFTER the screen's last capture has no next record: its result is merged into
//       the screen's last record instead (the <screen>__<state>.json is rewritten), never dropped.
//       record.tour = null, or every tour since the previous record merged: opened, failed and hover
//       concatenated, skipped summed. shot() writes <screen>__tour-<n>.png (n from 0, per screen
//       per viewport) and returns the basename. The 'tour steps are skipped …' warning is gone.
//       A check or tour that throws never fails the screen: record.checks = [{ check: 'checks',
//       detail: 'check failed: …' }] / record.tour = { opened: [], failed: [{ control: 'tour',
//       error }], hover: [], skipped: 0 }.
//       Record JSON gains: tree: string, checks: [{ check, detail }] | null, tour: {…} | null,
//       checksRan: [check id] | null (checks.mjs checksRan: the checks that ran on this capture, findings or not).
//       errors already holds console errors (console 'error' + page errors) and HTTP >= 400 lines.
//
//   runStep(page, step, { baseUrl, profile, root, recording, runTour }) -> Promise<void>
//     The step vocabulary of map.mjs STEP_ACTIONS (minus capture, which capture() handles).
//     Unknown action -> Error('unknown step <json>'). `flow` -> Error('flow steps are expanded
//     before the walk: <json>'). `tour` -> await ctx.runTour(step.tour) when capture() passes
//     runTour in the 4th argument, else nothing (probe.mjs walks steps without a tour).
//     The `via` key on a step is ignored. Selectors are Playwright's: role=button[name="Save"] works. back/forward throw when the URL is unchanged
//     or leaves baseUrl. optional: timeout 3000 ms and errors swallowed.
//
//   snapshot(page, { screen, state, watch, viewport, role, expandEach, profile, out, log, checks, tour }) -> Promise<record>
//     checks = null | { touch, keyboardHeight }; tour = null | async () => tour result; log.tours holds the
//     results of tour steps, merged into this record's tour.
//     watch precedence: step.watch, screen.watch, profile.watch; capped at
//     profile.maxElementsPerCapture; collection waits for a stable element count.
//     expectTexts = [the `text` of each expectation, 'exact' or '/re/flags'] (capture() takes the same option):
//     whatever the watch, every visible element whose WHOLE text matches one is collected too (the innermost
//     such element, so <li>Yo-yo <span>SALE</span></li> yields the span for 'SALE'), with the same record
//     fields. A role-less span is in the accessibility tree only inside its parent's line, so without this an
//     exact-text expectation on it was never observed. With no watch and no expectTexts nothing is collected.

//   STEP 6 (metrics; tests: test/capture.test.mjs 'step 6'):
//     Every screen's page gets metrics.mjs collectMetrics(page) right after it opens. start() is
//     called right before the screen's LAST goto, reload, back or forward step (expanded steps, so
//     a flow's goto counts), or before its first step when it has none of those. At each snapshot,
//     after settle and before the PNG: record.metrics = await read() (the first capture of a
//     screen measures from that step; a later capture measures from the same t0). A collector
//     that throws never fails the screen: record.metrics = null. Record JSON gains
//     metrics: { readyMs, bytes, requests, longTaskMs, heapBytes, server } | null.

//   STEP 7 (coverage and video; tests: test/capture.test.mjs 'step 7'):
//     capture() takes two more options: coverage = false and record (now also a mode):
//       record true | 'all'  -> every screen records;  'journeys' -> screens with record: true, or
//       with two or more capture steps after expansion;  false (default) -> only record: true
//       screens (as before);  'none' -> no screen records, record: true included.
//     coverage true: sources.mjs startCoverage(page) right after the screen's page opens (before
//       login steps' navigation is fine: the login runs in its own context), stopCoverage after the
//       screen's last capture; screenSources(entries, { origin: new URL(baseUrl).origin, fetchText:
//       url -> page.request.get(url).text(), exists: f -> fs.existsSync(path.join(cwd, f)) }) ->
//       <out>/<viewport>/<screen>__sources.json = JSON array of files. Any error there -> the file
//       holds [] and a warning '<screen>: coverage failed: <first line>'; the screen is never failed.
//     Recording overlay (a recorded screen only), added to the click-ring init script: a 14px dark
//       dot with a white ring follows the pointer (mousemove/pointermove; it starts hidden); a hover
//       step outlines the hovered element (2px #1e88e5) for 600 ms. Before a click, hover or fill on
//       a recorded screen, runStep moves the mouse to the element's centre in 10 steps
//       (page.mouse.move(x, y, { steps: 10 })) so the cursor travels on the video.
//     Checkpoints: a recorded screen writes <out>/<viewport>/<screen>.checkpoints.json =
//       [{ state, atMs }] — atMs = ms from the recording context's creation to the snapshot of that
//       state (Date.now() differences; the video starts with the context).

//   1.0.0 (tests: test/outcomes.test.mjs 'capture'): a tool failure is told from a product one.
//     A failing step that timed out (Playwright's TimeoutError, or 'Timeout <n>ms exceeded') is walked once more, after
//     every other screen of this viewport (its files and captured states from the first walk dropped), unless the
//     page showed a server error. A screen that fails again keeps the failure, marked timeout: true, retried: true.
//     A failure (any step) records serverError when the page's main document answered >= 500 or the app's own API
//     answered 5xx during the walk ('<status> <METHOD> <path>' / '<status> document <path>'); then it is never
//     retried (the head showed an error: a Blocker, not a tool fault). failed entries and <screen>__FAILED.json gain
//     timeout / retried / serverError when they apply.

//   U11 (rework, design 2026-11-12 §10; tests: test/capture-touch.test.mjs):
//     runStep(page, step, { …, touch, note }) — capture() passes touch (the viewport is narrower than
//     profile.checks.touchBelow, default 768: the rule the page checks use) and note (a sink for what a step did
//     instead of what the map said).
//     A hover step on a touch screen (touch true, or the page itself reports touch: navigator.maxTouchPoints > 0 or
//     (hover: none), as a context made with hasTouch does) is what a tap does there: the element is hovered first (a
//     tap fires the mouse-over events, so a CSS or script reveal still shows); when the page answered nothing (no
//     element shown or hidden, no aria-expanded or tooltip change, no change to the element's own look: background,
//     colour, border, shadow, outline, opacity, text decoration, transform) and the element opens something on a tap —
//     it or an ancestor declares a reveal (aria-haspopup not false, aria-expanded or aria-controls), or is a <summary>,
//     and it is enabled, no link with a real href and no form's submit — it is clicked once (a tap). Otherwise nothing
//     is clicked (an action or a link a person would trigger by that tap). note({ step, tapped | skipped: true, why }),
//     why one of (w = the viewport width):
//       'hover on a touch screen (<w> px): nothing answered the hover; tapped instead'                      (tapped)
//       'hover on a touch screen (<w> px): nothing answered the hover and a tap opens nothing there, so it was skipped'
//       'hover on a touch screen (<w> px): tapped, and nothing answered the tap either'                      (skipped)
//     capture() logs '<screen>: ' + why with the selector after 'hover' ('<screen>: hover <sel> on a touch screen …'),
//     and for a skipped one the screen's next record gains skipped: [{ step: JSON of the step, why }] (the key is
//     absent when nothing was skipped). compare.mjs never sends such a capture to eyes: it does not show what the map
//     meant it to.
//     A click or clickAll step keeps the scroll position of the scroll container it started in: the nearest ancestor
//     of the (first) target that scrolls, else the page. click: after the target is scrolled into view (as the click
//     would), the container's position is recorded; clickAll: before its first click. After the step (and settle), when
//     the URL is the same, the container still in the page, the click expanded something (more [aria-expanded="true"]
//     or open <details> in the page, or more elements shown inside the container) and the container's position moved,
//     it is scrolled back. A click that expands nothing (a scroll-to-top button, a page change) is left as the app made it.
//     snapshot(): the crops of watched elements and expandEach scroll elements into view; every scroll container's
//     position (not the window's) is recorded before them and put back before the full-page PNG, so the picture shows
//     what the steps left, not the last crop.

//   SVG TEXT (tests: test/capture-touch.test.mjs 'svg'): an element inside an <svg> has no innerText; the snapshot's
//     own text, its context chain and waitForStableCount read textContent where innerText is undefined.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { login, settle } from './login.mjs';
import { collectMetrics } from './metrics.mjs';
import { checksRan, runChecks } from './checks.mjs';
import { expandScreen, MapError } from './map.mjs';
import { screenSources, startCoverage, stopCoverage } from './sources.mjs';
import { tourPage } from './tour.mjs';
import { ariaTree } from './tree.mjs';

const visible = (page, selector) => page.locator(selector).filter({ visible: true }).first();
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
// A step that ran out of time (the page was slow or the element never came): the one kind of failure walked again.
export const isTimeout = (e) => e?.name === 'TimeoutError' || /\bTimeout \d+ms exceeded\b/.test(String(e?.message ?? e));
// The server's own error during a walk: the main document >= 500, else the app's API answering 5xx.
export function serverErrorOf(trace) {
  if (trace?.document && trace.document.status >= 500) return `${trace.document.status} document ${trace.document.path}`;
  const line = (trace?.errors ?? []).find((l) => /^HTTP 5\d\d /.test(l));
  return line ? line.slice('HTTP '.length) : null;
}

// A Chromium at /opt/pw-browsers/chromium (a cloud session's) is used by path when neither the installed Chrome nor
// Playwright's own download will start.
export const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';
async function launchChromium(pw, options) {
  try {
    return await pw.chromium.launch(options);
  } catch (e) {
    if (!fs.existsSync(FALLBACK_CHROMIUM)) throw e;
    return pw.chromium.launch({ ...options, executablePath: FALLBACK_CHROMIUM });
  }
}

export async function openBrowser(pw, { profile, headless = true, recordDir = null, storageState = null, viewport, clock = null } = {}) {
  const channel = profile?.browser?.channel ?? 'chrome';
  const [width, height] = viewport ?? profile?.viewports?.desktop ?? [1440, 900];
  const warnings = [];
  let browser;
  if (channel === 'chromium') browser = await launchChromium(pw, { headless });
  else {
    try {
      browser = await pw.chromium.launch({ channel, headless });
    } catch (e) {
      warnings.push(`browser channel ${channel} did not start (${firstLine(e)}): used Playwright's chromium`);
      browser = await launchChromium(pw, { headless });
    }
  }
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: 'reduce',
      locale: 'en-US',
      timezoneId: 'UTC',
      serviceWorkers: 'block',
      ...(recordDir ? { recordVideo: { dir: recordDir, size: { width, height } } } : {}),
      ...(storageState ? { storageState } : {}),
    });
    context.on('close', () => browser.close().catch(() => {}));
    if (clock) await context.clock.setFixedTime(new Date(clock));
    context.qaWarnings = warnings;
    return context;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

// Remove the localStorage and sessionStorage keys matching any of the patterns on the page's origin; returns them.
async function removeStorage(page, patterns) {
  return page.evaluate((patterns) => {
    const res = patterns.map((p) => new RegExp(p));
    const gone = [];
    for (const store of [localStorage, sessionStorage]) {
      for (const k of Object.keys(store)) if (res.some((re) => re.test(k))) (store.removeItem(k), gone.push(k));
    }
    return gone;
  }, patterns);
}

// Playwright's video has no mouse pointer, so a recorded screen draws its own: a red ring marks where each click lands
// (800 ms), and a 14px dark dot with a white ring follows the pointer (hidden until the first move). runStep moves the
// mouse to each target first and pauses after each action, so a viewer can follow the flow.
async function addRecordingOverlay(context) {
  await context.addInitScript(() => {
    addEventListener(
      'mousedown',
      (e) => {
        const ring = document.createElement('div');
        ring.setAttribute('data-mfqa-overlay', '');
        ring.style.cssText = `position:fixed;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border:3px solid #e53935;border-radius:50%;pointer-events:none;z-index:2147483647`;
        document.documentElement.appendChild(ring);
        setTimeout(() => ring.remove(), 800);
      },
      true
    );
    const dot = () => {
      if (!document.documentElement) return null;
      let el = document.getElementById('__qa-cursor');
      if (!el) {
        el = document.createElement('div');
        el.id = '__qa-cursor';
        el.setAttribute('data-mfqa-overlay', '');
        el.style.cssText = 'position:fixed;left:0;top:0;width:14px;height:14px;box-sizing:border-box;border:2px solid #fff;border-radius:50%;background:#212121;box-shadow:0 0 3px rgba(0,0,0,.6);pointer-events:none;z-index:2147483647;display:none';
        document.documentElement.appendChild(el);
      }
      return el;
    };
    const follow = (e) => {
      const el = dot();
      if (!el) return;
      el.style.left = `${e.clientX - 7}px`;
      el.style.top = `${e.clientY - 7}px`;
      el.style.display = 'block';
    };
    addEventListener('mousemove', follow, true);
    addEventListener('pointermove', follow, true);
    addEventListener('DOMContentLoaded', dot);
  });
}

async function saveRecording(page, file) {
  // Hold the end state for a moment, so the video doesn't cut off as the flow lands.
  await page.waitForTimeout(1500).catch(() => {});
  const video = page.video();
  await page.close().catch(() => {});
  await video?.saveAs(file).catch(() => {});
}

// What a person would see change when an element is hovered or tapped: the elements shown, the open disclosures and
// tooltips, and the element's own look. Runs in the browser, on the element.
function answerSig(el) {
  const shown = (n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  let count = 0;
  for (const n of document.body.querySelectorAll('*')) if (shown(n)) count++;
  const tips = [...document.querySelectorAll('[role="tooltip"]')].filter(shown).length;
  const open = document.querySelectorAll('[aria-expanded="true"], details[open]').length;
  const cs = getComputedStyle(el);
  const look = [cs.backgroundColor, cs.color, cs.borderColor, cs.boxShadow, cs.outlineStyle, cs.outlineColor, cs.opacity, cs.textDecorationLine, cs.transform].join('|');
  return `${count}|${tips}|${open}|${look}`;
}

// Whether a tap on the element opens something, as its markup declares: a reveal control (aria-haspopup, aria-expanded,
// aria-controls, <summary>) that is enabled, and neither a link that leaves nor a form's submit. Runs in the browser.
function opensOnTap(el) {
  const ctl = el.closest('[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded], [aria-controls], summary');
  if (!ctl || ctl.matches(':disabled, [aria-disabled="true"]')) return false;
  const link = ctl.closest('a[href]');
  if (link && !/^(#|javascript:)/i.test(link.getAttribute('href') ?? '')) return false;
  const submit = ctl.closest('button, input');
  if (submit?.form && (submit.type === 'submit' || submit.type === 'image')) return false;
  return true;
}

// A hover where no pointer hovers: what a tap does (see U11). Returns nothing; tells `note` what it did instead.
async function touchHover(page, loc, step, { timeout, note }) {
  await loc.waitFor({ state: 'visible', timeout });
  const width = page.viewportSize()?.width ?? (await page.evaluate(() => innerWidth));
  const where = `hover on a touch screen (${width} px)`;
  const before = await loc.evaluate(answerSig);
  await loc.hover({ timeout });
  await page.waitForTimeout(150);
  if ((await loc.evaluate(answerSig).catch(() => null)) !== before) return;
  if (!(await loc.evaluate(opensOnTap))) {
    note?.({ step, skipped: true, why: `${where}: nothing answered the hover and a tap opens nothing there, so it was skipped` });
    return;
  }
  await loc.click({ timeout });
  await page.waitForTimeout(150);
  if ((await loc.evaluate(answerSig).catch(() => null)) === before) note?.({ step, skipped: true, why: `${where}: tapped, and nothing answered the tap either` });
  else note?.({ step, tapped: true, why: `${where}: nothing answered the hover; tapped instead` });
}

// The scroll an expand must not lose (see U11). mode 'mark' records the container of a.el (or the page), 'restore' puts
// it back when the click expanded something and the page is the same one. Runs in the browser.
function keepScroll(a) {
  const shown = (n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const inside = (box) => {
    let n = 0;
    for (const e of box.querySelectorAll('*')) if (shown(e)) n++;
    return n;
  };
  const opened = () => document.querySelectorAll('[aria-expanded="true"], details[open]').length;
  if (a.mode === 'mark') {
    const scrolls = (n) => {
      const cs = getComputedStyle(n);
      const by = (v) => v === 'auto' || v === 'scroll';
      return (by(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) || (by(cs.overflowX) && n.scrollWidth > n.clientWidth + 1);
    };
    let box = null;
    for (let n = a.el?.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (scrolls(n)) {
        box = n;
        break;
      }
    }
    box ??= document.scrollingElement ?? document.documentElement;
    window.__mfqaKeep = { box, top: box.scrollTop, left: box.scrollLeft, url: location.href, opened: opened(), shown: inside(box) };
    return true;
  }
  const k = window.__mfqaKeep;
  delete window.__mfqaKeep;
  if (!k || location.href !== k.url || !k.box.isConnected) return false;
  if (k.box.scrollTop === k.top && k.box.scrollLeft === k.left) return false;
  if (!(opened() > k.opened || inside(k.box) > k.shown)) return false;
  k.box.scrollTo({ top: k.top, left: k.left, behavior: 'instant' });
  return true;
}

export async function runStep(page, step, { baseUrl, profile, root, recording, runTour, touch = false, note = null } = {}) {
  if (step.flow) throw new Error(`flow steps are expanded before the walk: ${JSON.stringify(step)}`);
  if (step.tour) {
    // capture() passes runTour; probe.mjs walks steps without one, so a tour step is nothing there.
    await runTour?.(step.tour);
    return;
  }
  const timeout = step.optional ? 3000 : profile?.stepTimeoutMs ?? 20000;
  let kept = false;
  try {
    if (step.capture) return;
    // A recorded screen's cursor travels to the element first, so the video shows where the action lands.
    const target = step.click ?? step.hover ?? step.fill;
    const loc = recording && target ? visible(page, target) : null;
    if (loc) {
      await loc.waitFor({ state: 'visible', timeout });
      try {
        await loc.scrollIntoViewIfNeeded({ timeout });
        const box = await loc.boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      } catch {
        // the element moved or went away: the action itself reports it
      }
    }
    if (step.goto) await page.goto(baseUrl + step.goto, { timeout: 60000 });
    else if (step.click) {
      // Where the click starts is what an expand keeps (U11): the target in view, as the click itself would put it.
      const target = visible(page, step.click);
      await target.waitFor({ state: 'visible', timeout });
      await target.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
      kept = await target.elementHandle({ timeout }).then((el) => page.evaluate(keepScroll, { mode: 'mark', el })).catch(() => false);
      await target.click({ timeout });
    } else if (step.clickAll) {
      const all = page.locator(step.clickAll).filter({ visible: true });
      await all.first().waitFor({ timeout });
      // Click the elements found now: expanding one row shifts the indexes of the rest.
      const els = await all.elementHandles();
      kept = await page.evaluate(keepScroll, { mode: 'mark', el: els[0] }).catch(() => false);
      for (const el of els) await el.click({ timeout }).catch(() => {});
    } else if (step.fill) await visible(page, step.fill).fill(step.value ?? '', { timeout });
    else if (step.setFiles) await page.locator(step.setFiles).first().setInputFiles([].concat(step.files ?? []).map((f) => path.resolve(root, f)), { timeout });
    // Remove saved app state by key (regex, or a list). Never everything: the login token lives in the same storage.
    // Follow it with a goto or reload, so the app rehydrates without it.
    else if (step.clearStorage) await removeStorage(page, [].concat(step.clearStorage));
    else if (step.hover) {
      // A touch screen has no hover: what a tap does there (U11). The page may say it is one (a context with touch).
      const onTouch = touch || (await page.evaluate(() => navigator.maxTouchPoints > 0 || matchMedia('(hover: none)').matches).catch(() => false));
      if (onTouch) await touchHover(page, visible(page, step.hover), step, { timeout, note });
      else await visible(page, step.hover).hover({ timeout });
      // On a recording, outline what is hovered for 600 ms: a hover leaves no other mark on the video.
      if (recording) {
        await visible(page, step.hover)
          .evaluate((n) => {
            const was = n.style.outline;
            n.style.outline = '2px solid #1e88e5';
            setTimeout(() => (n.style.outline = was), 600);
          })
          .catch(() => {});
      }
    }
    else if (step.press) await page.keyboard.press(step.press);
    else if (step.waitFor) await visible(page, step.waitFor).waitFor({ state: 'visible', timeout });
    else if (step.wait) await page.waitForTimeout(step.wait);
    else if (step.reload) await page.reload({ timeout: 60000 });
    else if (step.back || step.forward) {
      const from = page.url();
      await (step.back ? page.goBack({ timeout: 60000 }) : page.goForward({ timeout: 60000 }));
      // Both return null at the end of history and for an in-app route change alike; only the URL tells them apart.
      if (page.url() === from) throw new Error(`${step.back ? 'back' : 'forward'}: still on ${from}, no history entry to go to`);
      if (!page.url().startsWith(baseUrl)) throw new Error(`${step.back ? 'back' : 'forward'}: left the app for ${page.url()}`);
    } else throw new Error(`unknown step ${JSON.stringify(step)}`);
  } catch (e) {
    if (!step.optional) throw e;
  }
  // In a recording, give each action a beat on screen (the click ring fades in 0.8s).
  if (recording && (step.click || step.clickAll || step.fill || step.press || step.hover)) await page.waitForTimeout(900);
  await settle(page, profile);
  // An expand that scrolled its container is put back where the click started (U11).
  if (kept) await page.evaluate(keepScroll, { mode: 'restore' }).catch(() => false);
}

// Late panels and lazy rows keep adding watched elements after the network looks idle. Wait until the count of
// visible watched elements (and their text) holds still for stableMs, up to stableTimeoutMs.
async function waitForStableCount(page, watch, profile) {
  const stableMs = profile?.settle?.stableMs ?? 1000;
  const deadline = Date.now() + (profile?.settle?.stableTimeoutMs ?? 10000);
  const sample = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((n) => n.getBoundingClientRect().width).map((n) => (n.innerText ?? n.textContent ?? '').trim()).join('|'), watch);
  let last = await sample();
  let since = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const now = await sample();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= stableMs) return;
  }
}

// expectations.json `text` values -> what the page-side collector matches: 'exact' or '/re/flags' (a bad regex is skipped).
function expectMatchers(texts) {
  const out = [];
  for (const t of new Set(texts ?? [])) {
    if (typeof t !== 'string' || !t) continue;
    const slash = t.lastIndexOf('/');
    if (t.startsWith('/') && slash > 0) {
      try {
        new RegExp(t.slice(1, slash), t.slice(slash + 1));
        out.push({ re: t.slice(1, slash), flags: t.slice(slash + 1) });
      } catch {}
    } else out.push({ exact: t });
  }
  return out;
}

// One capture: full-page png, a crop per watched element, and the record. Files are written only with `out`; `log`
// ({ writes, errors, overrides }) is what the screen's traffic collected so far, and is drained into the record.
// checks = null (off) or { touch, keyboardHeight }; tour = null or async () => tour result (the screen's last capture
// only). Tour results that steps left in log.tours are merged into this record's tour.
// Several tours (tour steps, the automatic one) as one record.tour; null when there were none.
const mergeTours = (tours) =>
  tours.length
    ? tours.reduce((all, t) => ({ opened: [...all.opened, ...(t.opened ?? [])], failed: [...all.failed, ...(t.failed ?? [])], hover: [...all.hover, ...(t.hover ?? [])], skipped: all.skipped + (t.skipped ?? 0) }), { opened: [], failed: [], hover: [], skipped: 0 })
    : null;

export async function snapshot(page, { screen, state, watch, viewport, role = null, expandEach, profile, out = null, log = null, checks = null, tour = null, metrics = null, expectTexts = [] } = {}) {
  // Right after settle, before anything else touches the page: what opening it cost. A collector that throws is null.
  let measured = null;
  if (metrics) measured = await metrics().catch(() => null);
  const name = typeof screen === 'string' ? screen : screen.name;
  const id = `${name}__${state}`;
  const max = profile?.maxElementsPerCapture ?? 80;
  const elements = [];
  await page.evaluate(() => document.querySelectorAll('[data-qa-id]').forEach((n) => delete n.dataset.qaId));
  // Web fonts that load late reflow the page: wait for them (at most 5 s) so the picture is the settled one.
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))])).catch(() => {});
  if (watch) await waitForStableCount(page, watch, profile);

  // Collect every visible watched element not collected yet; marking each one keeps repeat passes duplicate-free.
  const matchers = expectMatchers(expectTexts);
  const collect = async () => {
    if (!watch && !matchers.length) return;
    const found = await page.evaluate(
      ({ watch, matchers, start, max }) => {
        const out = [];
        // An expectation's text is looked for on the page itself, whatever the element (a bare span has no role, so the
        // accessibility tree shows it only inside its parent's line): the innermost elements whose whole text matches.
        const norm = (t) => t.replace(/\s+/g, ' ').trim();
        const hit = (t) => matchers.some((m) => (m.exact !== undefined ? t === m.exact : new RegExp(m.re, m.flags).test(t)));
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
        const byText = new Set();
        if (matchers.length) {
          for (const n of document.body.querySelectorAll('*')) {
            if (SKIP.has(n.tagName) || !hit(norm(n.textContent ?? ''))) continue;
            if ([...n.children].some((c) => hit(norm(c.textContent ?? '')))) continue;
            byText.add(n);
          }
        }
        for (const node of [...byText, ...(watch ? document.querySelectorAll(watch) : [])]) {
          if (start + out.length >= max) break;
          const box = node.getBoundingClientRect();
          const cs = getComputedStyle(node);
          if (node.dataset.qaId || !box.width || !box.height || cs.visibility === 'hidden') continue;
          // An input has no innerText; its value is what a reload or back step must keep. A textarea's innerText is
          // its initial content and a select's is every option, so read value there too.
          // An element inside an <svg> has no innerText: its textContent is the text it draws.
          const own = (node.matches('input, textarea, select') ? node.value : node.innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (byText.has(node) && !hit(own)) continue;
          node.dataset.qaId = String(start + out.length);
          // Where the element sits, so an expectation can target "the Report Status tag", not every tag with that
          // text: a table cell's column header, else the nearest surrounding label text.
          let context = '';
          const td = node.closest('td');
          const ths = td?.closest('table')?.querySelectorAll('thead tr:last-child th');
          // Only a plain cell in a row shaped like the header; an expanded detail row spans every column.
          if (td && ths && td.colSpan === 1 && td.parentElement.children.length === ths.length) {
            context = ths[[...td.parentElement.children].indexOf(td)]?.innerText.replace(/\s+/g, ' ').trim() ?? '';
          }
          // A header cell: its row is too long to read as context, so name the place instead.
          if (!context && node.closest('thead')) context = 'column header';
          // Outside a table cell: the texts around it, level by level, stopping before a level long enough to be a
          // whole card (that would contain every other row's label too).
          if (!context) {
            const chain = [];
            for (let p = node.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
              const t = (p.innerText ?? p.textContent ?? '').replace(/\s+/g, ' ').replace(own, '').replace(/\s+/g, ' ').trim();
              if (t.length > 60) break;
              if (t && t !== chain.at(-1)) chain.push(t);
            }
            context = chain.join(' › ');
          }
          out.push({
            qaId: node.dataset.qaId,
            text: own,
            context,
            // an SVG element's className is an SVGAnimatedString: its class attribute is the text
            className: String(typeof node.className === 'string' ? node.className : node.getAttribute('class') ?? '').replace(/\s+/g, ' ').trim(),
            style: { background: cs.backgroundColor, color: cs.color, border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` },
          });
        }
        return out;
      },
      { watch, matchers, start: elements.length, max }
    );
    for (const { qaId, ...info } of found) {
      const shot = `${id}__${qaId}.png`;
      if (out) {
        const el = page.locator(`[data-qa-id="${qaId}"]`);
        // Centre it first: scrolled only "into view" it can sit under a sticky header or pagination bar, and the crop
        // then shows the bar instead of the element.
        await el.evaluate((n) => n.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
        await el.screenshot({ path: path.join(out, shot), timeout: 5000 }).catch(() => {});
      }
      elements.push({ ...info, shot });
    }
  };
  // The crops below and expandEach scroll elements into view: every scroll container is put back before the full
  // picture, so it shows what the steps left (U11). The window is scrolled to the top below, as before.
  await page.evaluate(() => {
    window.__mfqaBoxes = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)
      .filter((e) => e !== document.documentElement && e !== document.body).map((e) => [e, e.scrollLeft, e.scrollTop]);
  }).catch(() => {});
  await collect();

  // Tables that open one row at a time (mobile layouts): open each row in turn and collect what it reveals.
  if (expandEach) {
    for (const toggle of await page.locator(expandEach).filter({ visible: true }).elementHandles()) {
      await toggle.click({ timeout: 3000 }).catch(() => {});
      await settle(page, profile);
      await collect();
    }
  }
  await page.evaluate(() => {
    for (const [e, x, y] of window.__mfqaBoxes ?? []) if (e.isConnected) e.scrollTo({ left: x, top: y, behavior: 'instant' });
    delete window.__mfqaBoxes;
  }).catch(() => {});
  // Back to the top: centring the crops scrolled the window, and a full-page shot paints fixed elements (header,
  // drawers) at the scroll offset, halfway down the image.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  if (out) await page.screenshot({ path: path.join(out, `${id}.png`), fullPage: true });
  // Responsiveness: elements whose right edge passes the viewport and that no scroll or clip container holds (a table
  // scrolling inside its wrapper is fine). html/body don't count as containers. Only the outermost offender is listed.
  const overflow = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const held = (n) => {
      for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true;
      return false;
    };
    const out = [];
    for (const n of document.body.querySelectorAll('*')) {
      const box = n.getBoundingClientRect();
      if (box.right + scrollX <= W + 1 || !box.width || !box.height || getComputedStyle(n).visibility === 'hidden') continue;
      if (out.some((o) => o.node.contains(n)) || held(n)) continue;
      out.push({ node: n, key: `${n.tagName.toLowerCase()}${n.classList[0] ? '.' + n.classList[0] : ''}`, by: Math.round(box.right + scrollX - W), text: n.innerText?.replace(/\s+/g, ' ').trim().slice(0, 40) ?? '' });
      if (out.length >= 10) break;
    }
    return out.map(({ node, ...o }) => o);
  });
  // The accessibility tree, then the page checks, then (on a screen's last capture) the tour: the tour opens popups and
  // the checks move focus, so they come last and in this order.
  const treeFile = `${id}.aria.yml`;
  const treed = await ariaTree(page).then((text) => (out && fs.writeFileSync(path.join(out, treeFile), text), true), () => false);
  let found = null;
  if (checks) {
    try {
      found = await runChecks(page, checks);
    } catch (e) {
      found = [{ check: 'checks', detail: `check failed: ${firstLine(e)}` }];
    }
  }
  const tours = [...(log?.tours ?? [])];
  if (log?.tours) log.tours.length = 0;
  // Steps that did not do what the map said (a hover skipped on a touch screen): this capture does not show it.
  const skipped = [...(log?.skipped ?? [])];
  if (log?.skipped) log.skipped.length = 0;
  if (tour) tours.push(await tour());
  const merged = mergeTours(tours);
  // Known errors (profile.ignoreErrors) are kept as evidence but don't count against the capture.
  const patterns = (profile?.ignoreErrors ?? []).map((p) => new RegExp(p));
  const known = (e) => patterns.some((re) => re.test(e));
  const errors = log?.errors ?? [];
  const record = {
    screen: name,
    capture: state,
    url: page.url(),
    takenAt: new Date().toISOString(),
    viewport,
    role,
    watch: watch ?? null,
    elements,
    overflow,
    writes: [...(log?.writes ?? [])],
    errors: errors.filter((e) => !known(e)),
    ignoredErrors: errors.filter(known),
    overrides: [...new Set(log?.overrides ?? [])],
    tree: treed ? treeFile : null,
    checks: found,
    checksRan: found ? checksRan(found, checks) : null,
    tour: merged,
    metrics: measured,
    ...(skipped.length ? { skipped } : {}),
  };
  if (log) (log.writes.length = 0, (log.errors.length = 0), (log.overrides.length = 0));
  if (out) fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

// Wire one screen's context: no animations, write policing (every non-GET request is logged; with writes.block, those
// not matching a writes.allow pattern, tested against "METHOD /path", are aborted), requestOverrides, and the error log.
async function instrument(context, profile, screen, log) {
  // No transitions or animations, so a chip is captured in its final colour.
  await context.addInitScript(() => {
    const css = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css })));
  });
  const { scope = null, allow = [], block = false } = profile.writes ?? {};
  const scopeRe = scope ? new RegExp(scope) : null;
  const allowRes = allow.map((p) => new RegExp(p));
  const sent = new WeakMap();
  await context.route('**/*', (route) => {
    const r = route.request();
    if (r.method() === 'GET' || r.method() === 'OPTIONS') return route.continue();
    const where = new URL(r.url()).pathname;
    // Only the app's own API is policed; third-party telemetry (maps, analytics) passes untouched.
    if (scopeRe && !scopeRe.test(where)) return route.continue();
    const call = `${r.method()} ${where}`;
    const blocked = block && !allowRes.some((re) => re.test(call));
    const entry = { method: r.method(), url: where, status: blocked ? 'BLOCKED' : null };
    log.writes.push(entry);
    if (blocked) return route.abort();
    sent.set(r, entry);
    const override = (screen.requestOverrides ?? []).find((o) => new RegExp(o.url).test(call));
    if (!override || !r.postData()) return route.continue();
    log.overrides.push(call);
    return route.continue({ postData: JSON.stringify({ ...JSON.parse(r.postData()), ...override.json }) });
  });
  context.on('weberror', (e) => log.errors.push(firstLine(e.error().message)));
  context.on('console', (m) => m.type() === 'error' && log.errors.push(m.text().split('\n')[0]));
  // The app's own API answering 4xx/5xx, with the path: a 403, a 404 or a 5xx means the capture may be missing
  // data, and the console line alone doesn't say which call.
  context.on('response', (res) => {
    const entry = sent.get(res.request());
    if (entry) entry.status = res.status();
    if (res.status() < 400) return;
    const where = new URL(res.url()).pathname;
    if (scopeRe && !scopeRe.test(where)) return;
    log.errors.push(`HTTP ${res.status()} ${res.request().method()} ${where}`);
  });
}

export async function capture({ profile, mainRoot, baseUrl, screens, out, viewport = 'desktop', record = false, headless = true, cwd, vars, pw, log = console.error, runVerb, flows = {}, seed = null, seedFile, checks = true, tour = true, clock = null, coverage = false, expectTexts = [] } = {}) {
  const size = profile.viewports?.[viewport];
  if (!size) throw new Error(`unknown viewport "${viewport}": the profile has ${Object.keys(profile.viewports ?? {}).join(', ')}`);
  pw ??= (await import('./playwright.mjs')).loadPlaywright(mainRoot);
  const outDir = path.join(out, viewport);
  fs.mkdirSync(outDir, { recursive: true });
  const result = { viewport, captured: [], failed: [], notRun: [], warnings: [] };
  const warn = (context) => {
    for (const w of context.qaWarnings ?? []) if (!result.warnings.includes(w)) result.warnings.push(w);
  };

  // One login per role per viewport, in a throwaway context; every screen of the role starts from its storage state.
  const logins = new Map();
  const loginFor = (role) => {
    if (!logins.has(role)) {
      logins.set(
        role,
        (async () => {
          const context = await openBrowser(pw, { profile, headless, viewport: size });
          warn(context);
          try {
            return await login(context, { role, baseUrl, profile, mainRoot, cwd, vars, ...(runVerb ? { runVerb } : {}) });
          } catch (e) {
            return { error: `login ${role}: ${firstLine(e)}` };
          } finally {
            await context.close().catch(() => {});
          }
        })()
      );
    }
    return logins.get(role);
  };
  const checksOn = checks !== false && profile.checks?.enabled !== false;
  const tourOn = tour !== false && profile.tour?.enabled !== false;
  const fail = (screen, step, error, extra = {}) => {
    const marks = {
      ...(extra.mapError ? { mapError: true } : {}), ...(extra.timeout ? { timeout: true } : {}),
      ...(extra.retried ? { retried: true } : {}), ...(extra.serverError ? { serverError: extra.serverError } : {}),
    };
    result.failed.push({ screen: screen.name, step, error, ...marks });
    fs.writeFileSync(path.join(outDir, `${screen.name}__FAILED.json`), JSON.stringify({ screen: screen.name, step, error, url: extra.url ?? baseUrl, ...marks }, null, 2));
  };

  // Screens whose walk timed out once: walked again after the others (1.0.0).
  const again = [];
  const walk = async (mapped, attempt) => {
    if (mapped.viewports && !mapped.viewports.includes(viewport)) return;
    if (attempt > 1) result.captured = result.captured.filter((k) => !k.startsWith(`${mapped.name}__`));
    // Re-capturing a screen replaces its earlier files, so a stale FAILED record cannot linger.
    for (const f of fs.readdirSync(outDir)) if (f.startsWith(`${mapped.name}__`) || f === `${mapped.name}.webm` || f === `${mapped.name}.checkpoints.json`) fs.rmSync(path.join(outDir, f));

    // Flows are expanded before the login, so a login:<role> flow sets the role used. A MapError opens no browser.
    let screen;
    try {
      screen = expandScreen(mapped, { flows, seed, seedFile, profile });
    } catch (e) {
      if (!(e instanceof MapError)) throw e;
      fail(mapped, 'map', `MAP ERROR: ${e.message}`, { mapError: true });
      log(`${mapped.name}: MAP ERROR: ${e.message}`);
      return;
    }

    let storageState = null;
    if (screen.role) {
      const res = await loginFor(screen.role);
      if (res.notRun) {
        result.notRun.push({ screen: screen.name, why: res.notRun });
        log(`${screen.name}: ${res.notRun}`);
        return;
      }
      if (res.error) {
        fail(screen, 'login', res.error);
        log(`${screen.name}: FAILED: ${res.error}`);
        return;
      }
      storageState = res.storageState;
    }

    // record: true | 'all' every screen; 'journeys' a record: true screen or one with two or more captures; 'none' none.
    const captures = (screen.steps ?? []).filter((s) => s.capture).length;
    const filming = record === 'none' ? false : !!(screen.record || record === true || record === 'all' || (record === 'journeys' && captures >= 2));
    const recordDir = filming ? fs.mkdtempSync(path.join(os.tmpdir(), 'qa-video-')) : null;
    const context = await openBrowser(pw, { profile, headless, recordDir, storageState, viewport: size, clock });
    warn(context);
    const trace = { writes: [], errors: [], overrides: [], tours: [], skipped: [], document: null };
    let page;
    try {
      await instrument(context, profile, screen, trace);
      if (filming) await addRecordingOverlay(context);
      // The video starts with the page; checkpoints count from here.
      const startedAt = Date.now();
      const checkpoints = [];
      page = await context.newPage();
      // The main document's last answer: a 5xx there is the app's error page, never a slow tool.
      page.on('response', (res) => {
        try {
          if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) trace.document = { status: res.status(), path: new URL(res.url()).pathname };
        } catch { /* a response from a closed frame */ }
      });
      let coverageError = null;
      if (coverage) {
        try {
          await startCoverage(page);
        } catch (e) {
          coverageError = e;
        }
      }
      // The tour: a failure inside it is a record, never a failed screen. Its pictures are <screen>__tour-<n>.png.
      let tourShots = 0;
      // Tour steps replace the automatic tour, wherever in the walk they are.
      const hasTourStep = (screen.steps ?? []).some((s) => s.tour);
      let lastRecord = null;
      const shot = async () => {
        const file = `${screen.name}__tour-${tourShots++}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        return file;
      };
      const touring = async (options) => {
        try {
          return await tourPage(page, { ...(profile.tour ?? {}), ...(options && typeof options === 'object' ? options : {}), shot });
        } catch (e) {
          return { opened: [], failed: [{ control: 'tour', error: firstLine(e) }], hover: [], skipped: 0 };
        }
      };
      const ctx = {
        baseUrl,
        profile,
        root: cwd ?? mainRoot,
        recording: filming,
        // A touch screen by width, the rule the page checks use (U11): a hover there is what a tap does.
        touch: size[0] < (profile.checks?.touchBelow ?? 768),
        note: (n) => {
          log(`${screen.name}: ${n.why.replace(/^hover /, `hover ${n.step.hover} `)}`);
          if (n.skipped) trace.skipped.push({ step: JSON.stringify(n.step), why: n.why });
        },
        runTour: async (options) => {
          if (!tourOn) return;
          trace.tours.push(await touring(options));
        },
      };
      const checkOptions = checksOn ? { touch: size[0] < (profile.checks?.touchBelow ?? 768), keyboardHeight: profile.checks?.keyboardHeight } : null;
      // Metrics: installed before any navigation, started before the screen's last page load. A collector that
      // fails to install or read leaves metrics null; it never fails the screen.
      let collector = null;
      try {
        collector = await collectMetrics(page);
      } catch {
        collector = null;
      }
      const readMetrics = collector ? async () => collector.read() : null;
      const snap = async (state, step = {}, last = false) => {
        await settle(page, profile);
        if (filming) checkpoints.push({ state, atMs: Date.now() - startedAt });
        const automatic = last && tourOn && screen.tour !== false && !hasTourStep;
        lastRecord = await snapshot(page, { screen, state, watch: step.watch ?? screen.watch ?? profile.watch ?? null, viewport, role: screen.role ?? null, expandEach: step.expandEach, profile, out: outDir, log: trace, checks: checkOptions, tour: automatic ? () => touring(screen.tour) : null, metrics: readMetrics, expectTexts });
        result.captured.push(`${screen.name}__${state}`);
      };
      let step = null;
      try {
        const steps = screen.steps ?? [];
        const lastCapture = steps.findLastIndex((s) => s.capture);
        const loads = steps.findLastIndex((s) => s.goto || s.reload || s.back || s.forward);
        const startAt = loads < 0 ? 0 : loads;
        const startMetrics = () => {
          try {
            collector?.start();
          } catch {
            collector = null;
          }
        };
        if (!steps.length) startMetrics();
        for (const [i, s] of steps.entries()) {
          step = s;
          if (i === startAt) startMetrics();
          if (s.capture) await snap(s.capture, s, i === lastCapture);
          else await runStep(page, s, ctx);
        }
        step = null;
        if (lastCapture < 0) await snap('default', {}, true);
        // A tour step after the last capture has no next record: it joins the last one, never dropped.
        if (trace.tours.length && lastRecord) {
          lastRecord.tour = mergeTours([lastRecord.tour, ...trace.tours].filter(Boolean));
          trace.tours.length = 0;
          fs.writeFileSync(path.join(outDir, `${screen.name}__${lastRecord.capture}.json`), JSON.stringify(lastRecord, null, 2));
        }
        if (coverage) {
          // After the last capture: the files the walk ran. Never fails the screen; any error leaves [].
          let files = [];
          try {
            if (coverageError) throw coverageError;
            const entries = await stopCoverage(page);
            const fetchText = async (url) => (await page.request.get(url)).text();
            files = await screenSources(entries, { origin: new URL(baseUrl).origin, fetchText, exists: (f) => fs.existsSync(path.join(cwd ?? mainRoot, f)) });
          } catch (e) {
            files = [];
            result.warnings.push(`${screen.name}: coverage failed: ${firstLine(e)}`);
          }
          fs.writeFileSync(path.join(outDir, `${screen.name}__sources.json`), JSON.stringify(files, null, 2));
        }
        log(`${screen.name} ok${filming ? ` (video: ${screen.name}.webm)` : ''}`);
      } catch (e) {
        const where = step ? JSON.stringify(step) : 'capture';
        const timeout = isTimeout(e);
        const serverError = serverErrorOf(trace);
        if (timeout && !serverError && attempt === 1) {
          log(`${screen.name}: timed out (${firstLine(e)}); walking it again after the other screens`);
          again.push(mapped);
        } else {
          log(`${screen.name} FAILED: ${firstLine(e)}${attempt > 1 ? ' (again)' : ''}`);
          fail(screen, where, String(e.message), { url: page.url(), timeout, retried: attempt > 1, serverError });
          await page.screenshot({ path: path.join(outDir, `${screen.name}__FAILED.png`) }).catch(() => {});
        }
      }
      // A failed flow keeps its video too: it shows where the flow stopped.
      if (filming) fs.writeFileSync(path.join(outDir, `${screen.name}.checkpoints.json`), JSON.stringify(checkpoints, null, 2));
      if (filming) await saveRecording(page, path.join(outDir, `${screen.name}.webm`));
    } finally {
      await context.close().catch(() => {});
      if (recordDir) fs.rmSync(recordDir, { recursive: true, force: true });
    }
  };

  for (const mapped of screens) await walk(mapped, 1);
  for (const mapped of again) await walk(mapped, 2);
  return result;
}
