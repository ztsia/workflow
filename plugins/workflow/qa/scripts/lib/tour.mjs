// The tour: bugs in sizing, overflow and clipping live in a control's OPEN state, which a walk that
// only uses what it needs never photographs. Every popup control on the screen (menus, selects,
// comboboxes, date pickers, side sheets, modals) is opened once, photographed, checked for being
// clipped or covered, and closed with Escape; every interactive element is hovered once to see
// whether anything answers. Nothing is chosen. Zero model calls.
// with these changes: no width switching (capture already runs each viewport); each opened popup
// is located and checked; hover added; the page is restored.
//
// CONTRACT (tests: test/tour.test.mjs — real headless browser, page.setContent or a fixture server)
//
//   POPUP_CONTROLS = '[aria-haspopup]:not([aria-haspopup="false"]), [role="combobox"], '
//     + 'input[type="date"], input[type="datetime-local"], input[type="time"], input[type="month"], input[type="week"]'
//   A native <select> is never toured (the OS draws its list; there is nothing to photograph).
//
//   tourPage(page, { shot, max = 30, open = [], skip = [], hover = true, maxHover = 40 } = {})
//     -> Promise<{ opened: [entry], failed: [{ control, error }], hover: [{ control, changed }],
//                  skipped: number }>
//     shot: async () => string — capture.mjs supplies it; it writes a PNG of the page as it is and
//       returns the file's basename. Called once per opened control, while the popup is open.
//     Controls: POPUP_CONTROLS plus every selector in `open` (map: tour.open), minus elements that
//       match any selector in `skip` (tour.skip) and minus <select>; visible and enabled only;
//       document order; de-duplicated by control name; the first `max`; skipped = how many more
//       there were after skip and de-duplication.
//     control name: `<role> "<name>"`, role = the role attribute else the lowercase tag name,
//       name = aria-label, else text content, whitespace collapsed, cut to 60 chars
//       (e.g. 'button "Actions"', 'combobox "Status"'). Empty name -> `<role> <i>` (1-based).
//     Per control: remember URL and scroll; mark every element now in the DOM; click (timeout
//       3000); wait 400 ms and let finite animations end (up to 1 s). A click that throws ->
//       failed gets { control, error: <first line> } (never a finding by itself). If the URL
//       changed, the entry (in opened; shot is not called) is { control, navigated: <new url> }
//       and the page goes back to the remembered URL. Otherwise the POPUP is: the visible elements that were not in the DOM
//       before and whose parent was (new roots), plus the element named by the control's
//       aria-controls when it is visible; none -> popup: null. Elements marked data-mfqa-overlay (the
//       recording's click rings and cursor, capture.mjs) are never popups.
//       entry = { control, shot, popup: '<role> "<name>" W×H' | null, clipped: [string],
//                 covered: [string], stuck: boolean }
//       clipped (per popup root): its box cut by every ancestor whose overflow-x/-y is hidden,
//         clip, scroll or auto (both axes; a position:fixed element stops the walk), then by the
//         viewport (0..clientWidth, 0..innerHeight). Less than 99% of its area left ->
//         `<popup> cut off by <cover>` (the first ancestor that cut it, named like checks.mjs's
//         cover()) or `<popup> runs past the <bottom|right|top|left> of the screen`.
//       covered (per popup root): elementFromPoint at the centre and four corners (inset 2 px plus 0.3 × that
//         corner's border-radius, so the point is inside a rounded corner's curve; the radius is the larger of the
//         root's and a child's filling the same box) of
//         its VISIBLE box (the box left after clipping above), points inside the viewport only; a point whose top element is outside the popup root ->
//         `<popup> covered at <centre|top-left|top-right|bottom-left|bottom-right> by <cover>`,
//         once per covering element.
//       Then Escape, wait 200 ms. A popup root still visible -> stuck = true ("does not close on
//       Escape"); the tour then clicks the page at (1, 1) to try to close it. If the URL changed,
//       go back to it. Scroll positions restored.
//     hover (when hover): every visible, enabled element matching checks.mjs's target selector
//       with pointer-events not none, de-duplicated by control name, the first maxHover: read a
//       style signature (background-color, color, border-color, box-shadow, outline, opacity,
//       text-decoration-line, transform) and the count of visible [role="tooltip"]; hover it
//       (timeout 2000; a throw -> skip it); wait 150 ms, finish transitions; read again.
//       changed = signature differs or a tooltip appeared. Mouse back to (0, 0) after each.
//     After the tour: the URL, viewport size and scroll are as they were; nothing focused.
//
//   U7 (rework; tests: test/fingerprint.test.mjs): an opened entry with a popup gains fp = fingerprint.mjs
//     elementFingerprint(the control), read before the click: { role, name, landmark } of what a person sees on the page
//     (the popup itself is often put at the end of the body, out of every landmark). Absent when it cannot be read.
//
// Example: a page with a "Status" combobox whose listbox is cut by an overflow:hidden card ->
//   { opened: [{ control: 'combobox "Status"', shot: 'jobs__tour-0.png',
//                popup: 'listbox "Status" 200×240', clipped: ['listbox "Status" 200×240 cut off by div.card'],
//                covered: [], stuck: false }],
//     failed: [], hover: [{ control: 'combobox "Status"', changed: true }], skipped: 0 }

import { TARGETS } from './checks.mjs';
import { elementFingerprint } from './fingerprint.mjs';

export const POPUP_CONTROLS =
  '[aria-haspopup]:not([aria-haspopup="false"]), [role="combobox"], ' +
  'input[type="date"], input[type="datetime-local"], input[type="time"], input[type="month"], input[type="week"]';

// Everything the tour measures in the page, in one function so the helpers are written once (it runs
// in the browser, so it cannot import anything). `a.mode` picks the job; elements that must survive
// between calls live in arrays on window (__mfqaCtl, __mfqaHov, __mfqaRoots, __mfqaTourBefore, ...).
function probe(a) {
  const w = window;
  const round = Math.round;
  const tag = (el) => el.tagName.toLowerCase();
  const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const roleOf = (el) => el.getAttribute('role') || tag(el);
  const nameOf = (el) => collapse(el.getAttribute('aria-label') || el.textContent).slice(0, 60);
  const drawn = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    try {
      return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
    } catch {
      return true;
    }
  };
  const enabled = (el) => !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
  const cover = (el) => {
    const id =
      el.getAttribute('data-slot') ||
      el.getAttribute('data-testid') ||
      el.id ||
      (typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '');
    const t = collapse(el.textContent).slice(0, 30);
    return `${tag(el)}${id ? `.${id}` : ''}${t ? ` "${t}"` : ''}`;
  };
  const area = (b) => Math.max(0, b.r - b.l) * Math.max(0, b.b - b.t);
  const cuts = (v) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
  const POPUP_ROLES = '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tooltip"],[role="grid"],[role="tree"]';

  if (a.mode === 'list') {
    const hover = a.kind === 'hover';
    const set = new Set();
    const add = (sel) => {
      try {
        document.querySelectorAll(sel).forEach((e) => set.add(e));
      } catch {
        /* a selector that does not parse selects nothing */
      }
    };
    add(hover ? a.targets : a.popup);
    if (!hover) a.open.forEach(add);
    const els = [...set].sort((x, y) => (x.compareDocumentPosition(y) & 4 ? -1 : 1));
    const seen = new Set();
    const kept = [];
    const names = [];
    let i = 0;
    for (const el of els) {
      if (!hover && tag(el) === 'select') continue;
      if (!drawn(el) || !enabled(el)) continue;
      if (hover) {
        if (el.closest('.sr-only, [aria-hidden="true"]')) continue;
        if (getComputedStyle(el).pointerEvents === 'none') continue;
      } else if (a.skip.some((s) => { try { return el.matches(s); } catch { return false; } })) {
        continue;
      }
      i++;
      const nm = nameOf(el);
      const name = nm ? `${roleOf(el)} "${nm}"` : `${roleOf(el)} ${i}`;
      if (seen.has(name)) continue;
      seen.add(name);
      kept.push(el);
      names.push(name);
    }
    w[hover ? '__mfqaHov' : '__mfqaCtl'] = kept;
    return names;
  }

  if (a.mode === 'get') return w[a.key]?.[a.idx] ?? null;

  if (a.mode === 'mark') {
    w.__mfqaTourBefore = new WeakSet(document.querySelectorAll('*'));
    return null;
  }

  if (a.mode === 'scroll-save') {
    const boxes = [];
    for (const el of document.querySelectorAll('*')) if (el.scrollTop || el.scrollLeft) boxes.push([el, el.scrollLeft, el.scrollTop]);
    w[a.key] = boxes;
    return [w.scrollX, w.scrollY];
  }

  if (a.mode === 'scroll-restore') {
    w.scrollTo({ left: a.xy[0], top: a.xy[1], behavior: 'instant' });
    for (const [el, l, t] of w[a.key] ?? []) {
      if (el.isConnected) el.scrollTo({ left: l, top: t, behavior: 'instant' });
    }
    return null;
  }

  if (a.mode === 'blur') {
    document.activeElement?.blur?.();
    return null;
  }

  if (a.mode === 'sig') {
    const el = w.__mfqaHov[a.idx];
    const cs = getComputedStyle(el);
    const sig = [
      'backgroundColor',
      'color',
      'borderColor',
      'boxShadow',
      'outline',
      'opacity',
      'textDecorationLine',
      'transform',
    ].map((k) => cs[k]).join('|');
    let tips = 0;
    for (const t of document.querySelectorAll('[role="tooltip"]')) if (drawn(t)) tips++;
    return { sig, tips };
  }

  if (a.mode === 'roots-open') {
    return (w.__mfqaRoots ?? []).some((el) => el.isConnected && drawn(el));
  }

  if (a.mode === 'popups') {
    const before = w.__mfqaTourBefore;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let roots = [];
    if (before) {
      for (const el of document.querySelectorAll('*')) {
        const p = el.parentElement;
        if (before.has(el) || !p || el.hasAttribute('data-mfqa-overlay')) continue;
        if (!(before.has(p) || p === document.body || p === document.documentElement)) continue;
        if (drawn(el)) roots.push(el);
      }
    }
    const ctl = w.__mfqaCtl?.[a.idx];
    if (ctl && ctl.isConnected) {
      for (const id of (ctl.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)) {
        const t = document.getElementById(id);
        if (!t || !drawn(t)) continue;
        if (!roots.some((r) => r === t || r.contains(t))) {
          roots = roots.filter((r) => !t.contains(r));
          roots.push(t);
        }
        break;
      }
    }
    w.__mfqaRoots = roots;

    const label = (el) => {
      const inner = el.matches('[role]') ? el : el.querySelector(POPUP_ROLES) || el;
      let nm = nameOf(inner);
      const by = inner.getAttribute('aria-labelledby');
      if (!inner.getAttribute('aria-label') && by) {
        const t = collapse(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')).slice(0, 60);
        if (t) nm = t;
      }
      const r = el.getBoundingClientRect();
      return `${roleOf(inner)} "${nm}" ${round(r.width)}×${round(r.height)}`;
    };
    // A backdrop (an empty box over most of the screen) is part of the open state, not a popup of its own.
    const backdrop = (el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height >= 0.9 * vw * vh && !collapse(el.textContent);
    };

    // Each corner's used radius [rx, ry] in px: the larger of the popup's own and that of a child filling the
    // same box (a popover's rounded panel inside a square wrapper), clamped to half the box like CSS does.
    const cornerRadii = (el, box) => {
      const props = { tl: 'borderTopLeftRadius', tr: 'borderTopRightRadius', bl: 'borderBottomLeftRadius', br: 'borderBottomRightRadius' };
      const same = (n) => {
        const b = n.getBoundingClientRect();
        return Math.abs(b.left - box.left) <= 1 && Math.abs(b.top - box.top) <= 1
          && Math.abs(b.right - box.right) <= 1 && Math.abs(b.bottom - box.bottom) <= 1;
      };
      const layers = [el, ...[...el.children].filter(same)];
      const len = (t, whole) => (t.endsWith('%') ? (parseFloat(t) / 100) * whole : parseFloat(t)) || 0;
      const out = {};
      for (const [k, prop] of Object.entries(props)) {
        let rx = 0;
        let ry = 0;
        for (const n of layers) {
          const parts = getComputedStyle(n)[prop].trim().split(/\s+/);
          rx = Math.max(rx, len(parts[0] ?? '0', box.width));
          ry = Math.max(ry, len(parts[1] ?? parts[0] ?? '0', box.height));
        }
        out[k] = [Math.min(rx, box.width / 2), Math.min(ry, box.height / 2)];
      }
      return out;
    };

    const clipped = [];
    const covered = [];
    for (const el of roots) {
      const name = label(el);
      const r = el.getBoundingClientRect();
      const a0 = r.width * r.height;
      if (backdrop(el)) continue;
      const b = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      let cutter = null;
      // An absolutely positioned box is cut by its containing block and what lies above it, not by the
      // static ancestors in between.
      const stop = getComputedStyle(el).position === 'absolute' ? el.offsetParent : null;
      let skipping = !!stop && stop !== document.body && stop !== document.documentElement;
      if (stop === document.body || stop === document.documentElement) skipping = true;
      for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (n === stop) skipping = false;
        if (n !== el && !skipping) {
          const nr = n.getBoundingClientRect();
          const was = area(b);
          if (cuts(cs.overflowX)) {
            b.l = Math.max(b.l, nr.left);
            b.r = Math.min(b.r, nr.right);
          }
          if (cuts(cs.overflowY)) {
            b.t = Math.max(b.t, nr.top);
            b.b = Math.min(b.b, nr.bottom);
          }
          if (!cutter && area(b) < was - 0.5) cutter = n;
        }
        if (cs.position === 'fixed') break;
      }
      const a1 = area(b);
      const v = { l: Math.max(b.l, 0), t: Math.max(b.t, 0), r: Math.min(b.r, vw), b: Math.min(b.b, vh) };
      const a2 = area(v);
      if (a0 > 0 && a2 < 0.99 * a0) {
        if (cutter && a1 < a0) clipped.push(`${name} cut off by ${cover(cutter)}`);
        if (a2 < a1) {
          if (b.b > vh + 0.5) clipped.push(`${name} runs past the bottom of the screen`);
          if (b.r > vw + 0.5) clipped.push(`${name} runs past the right of the screen`);
          if (b.t < -0.5) clipped.push(`${name} runs past the top of the screen`);
          if (b.l < -0.5) clipped.push(`${name} runs past the left of the screen`);
        }
      }
      if (getComputedStyle(el).pointerEvents === 'none' || v.r - v.l < 4 || v.b - v.t < 4) continue;
      // A rounded corner paints nothing outside its curve: each corner point is moved in along the diagonal
      // until it is inside the curve (an ellipse corner rx×ry holds (rx·0.3, ry·0.3) from the box corner), so a
      // hit there is the popup's own paint, not the frame beneath the cut-away corner.
      const rad = cornerRadii(el, r);
      const inX = (k) => 2 + rad[k][0] * 0.3;
      const inY = (k) => 2 + rad[k][1] * 0.3;
      const points = [
        ['centre', (v.l + v.r) / 2, (v.t + v.b) / 2],
        ['top-left', v.l + inX('tl'), v.t + inY('tl')],
        ['top-right', v.r - inX('tr'), v.t + inY('tr')],
        ['bottom-left', v.l + inX('bl'), v.b - inY('bl')],
        ['bottom-right', v.r - inX('br'), v.b - inY('br')],
      ];
      const done = new Set();
      for (const [where, x, y] of points) {
        if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
        const top = document.elementFromPoint(x, y);
        if (!top || el.contains(top) || done.has(top)) continue;
        done.add(top);
        covered.push(`${name} covered at ${where} by ${cover(top)}`);
      }
    }
    const main = roots.find((el) => !backdrop(el)) ?? roots[0];
    return { popup: main ? label(main) : null, clipped, covered };
  }

  throw new Error(`probe: unknown mode ${a.mode}`);
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

// Wait until every running finite animation or transition has ended, for at most `ms`.
async function settle(page, ms) {
  await page
    .evaluate(async (limit) => {
      const running = document.getAnimations().filter((an) => {
        try {
          return an.playState === 'running' && Number.isFinite(an.effect.getComputedTiming().endTime);
        } catch {
          return false;
        }
      });
      await Promise.race([
        Promise.all(running.map((an) => an.finished.catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, limit)),
      ]);
    }, ms)
    .catch(() => {});
}

export async function tourPage(page, opts = {}) {
  const { shot, max = 30, open = [], skip = [], hover = true, maxHover = 40 } = opts;
  const result = { opened: [], failed: [], hover: [], skipped: 0 };
  const ev = (a) => page.evaluate(probe, a);
  const startUrl = page.url();
  const startScroll = await ev({ mode: 'scroll-save', key: '__mfqaScroll0' }).catch(() => [0, 0]);

  // Other tabs a control opens are closed again.
  const strays = [];
  const onPage = (p) => strays.push(p);
  page.context().on('page', onPage);
  const closeStrays = async () => {
    while (strays.length) await strays.pop().close().catch(() => {});
  };

  // Back to `url` (a navigation undone) with the window scrolled to `xy`.
  const goBackTo = async (url, xy) => {
    if (page.url() === url) return;
    await page.goBack({ timeout: 5000, waitUntil: 'load' }).catch(() => {});
    if (page.url() !== url) await page.goto(url, { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(100);
    await ev({ mode: 'scroll-restore', key: '__mfqaNone', xy }).catch(() => {});
  };

  try {
    const listArgs = { mode: 'list', kind: 'popup', popup: POPUP_CONTROLS, open, skip };
    const names = await ev(listArgs).catch(() => []);
    const planned = names.slice(0, max);
    result.skipped = names.length - planned.length;

    for (const control of planned) {
      const url = page.url();
      try {
        const fresh = await ev(listArgs);
        const idx = fresh.indexOf(control);
        if (idx < 0) {
          result.failed.push({ control, error: 'control is no longer on the page' });
          continue;
        }
        const handle = (await page.evaluateHandle(probe, { mode: 'get', key: '__mfqaCtl', idx })).asElement();
        const fp = await handle.evaluate(elementFingerprint).catch(() => null);
        const xy = await ev({ mode: 'scroll-save', key: '__mfqaScroll' });
        await ev({ mode: 'mark' });

        let clickError = null;
        try {
          await handle.click({ timeout: 3000 });
        } catch (e) {
          clickError = firstLine(e);
        }
        if (clickError) {
          result.failed.push({ control, error: clickError });
        } else {
          await page.waitForTimeout(400);
          await settle(page, 1000);
        }

        if (!clickError && page.url() !== url) {
          result.opened.push({ control, navigated: page.url() });
          await closeStrays();
          await goBackTo(url, xy);
          continue;
        }

        let entry = null;
        if (!clickError) {
          const found = await ev({ mode: 'popups', idx });
          let file = null;
          let shotError = null;
          try {
            file = await shot();
          } catch (e) {
            shotError = firstLine(e);
          }
          if (shotError) result.failed.push({ control, error: `shot: ${shotError}` });
          else entry = { control, shot: file, popup: found.popup, clipped: found.clipped, covered: found.covered, stuck: false, ...(fp ? { fp } : {}) };
        }

        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        if (entry && entry.popup !== null && (await ev({ mode: 'roots-open' }).catch(() => false))) {
          entry.stuck = true;
          await page.mouse.click(1, 1).catch(() => {});
          await page.waitForTimeout(200);
        }
        if (entry) result.opened.push(entry);
        await closeStrays();
        await goBackTo(url, xy);
        await ev({ mode: 'scroll-restore', key: '__mfqaScroll', xy }).catch(() => {});
      } catch (e) {
        result.failed.push({ control, error: firstLine(e) });
        await goBackTo(url, startScroll).catch(() => {});
      }
    }

    if (hover) {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      const targets = (await ev({ mode: 'list', kind: 'hover', targets: TARGETS, open: [], skip: [] }).catch(() => [])).slice(0, maxHover);
      for (let idx = 0; idx < targets.length; idx++) {
        try {
          const el = (await page.evaluateHandle(probe, { mode: 'get', key: '__mfqaHov', idx })).asElement();
          if (!el) continue;
          const before = await ev({ mode: 'sig', idx });
          try {
            await el.hover({ timeout: 2000 });
          } catch {
            await page.mouse.move(0, 0);
            continue;
          }
          await page.waitForTimeout(150);
          await settle(page, 1000);
          const after = await ev({ mode: 'sig', idx });
          result.hover.push({ control: targets[idx], changed: before.sig !== after.sig || after.tips > before.tips });
          await page.mouse.move(0, 0);
          if (after.tips > 0) await page.waitForTimeout(150);
        } catch {
          await page.mouse.move(0, 0).catch(() => {});
        }
      }
    }
  } finally {
    page.context().off('page', onPage);
    await closeStrays();
    await page.mouse.move(0, 0).catch(() => {});
    await goBackTo(startUrl, startScroll).catch(() => {});
    await ev({ mode: 'scroll-restore', key: '__mfqaScroll0', xy: startScroll }).catch(() => {});
    await ev({ mode: 'blur' }).catch(() => {});
  }
  return result;
}
