// The seven page checks: what can be measured on a screen is checked by script, on every capture,
// so nobody has to spot it. Zero model calls. Ported from Sen's checks.ts (workflow plugin branch
// workflow/qa-diff, examples/qa/checks.ts; read it with
//   git -C "/mnt/c/Users/Zhong Tai/Desktop/claude_skills" show origin/workflow/qa-diff:examples/qa/checks.ts)
// TypeScript -> plain JS, with these changes:
//   - axe is replaced by our own `contrast` check (qa is Node stdlib + playwright-core only,
//     decision 9); it measures what Sen used axe for (text contrast), nothing else of axe's.
//   - Sen's dev-panel handle ([data-dev-handle]) and "Simulated:" toast exceptions are dropped.
//   - The target size depends on the input: 48 px for touch, 24 px (WCAG 2.5.8) for a pointer;
//     the keyboard check runs on touch only (it simulates Android's on-screen keyboard).
//   - Each check's findings are capped (maxPerCheck), then one '… <n> more' line.
//
// CONTRACT (tests: test/checks.test.mjs — real headless browser, page.setContent, no server;
//           each check is proven to fire on a page built to break it and to stay quiet on the
//           same page fixed, as Sen's checks.spec.ts does)
//
//   CHECK_IDS = ['contrast', 'target', 'clipped', 'overlap', 'covered', 'keyboard', 'focus']
//   TARGETS = Sen's TARGETS selector string (interactive elements; tour.mjs hovers the same set)
//
//   runChecks(page, { touch = false, targetPx = touch ? 48 : 24, keyboardHeight = 508,
//                     focusStops = 30, maxTexts = 1500, maxPerCheck = 50, only = CHECK_IDS } = {})
//     -> Promise<[{ check, detail }]>
//     Runs the checks in `only`, in CHECK_IDS order, on the page as it is now, after calm()
//     (Sen's: finite animations finished or 3 s, then no view transition covering the targets,
//     up to 5 s). keyboard runs only when touch. keyboard and focus change the page, so they
//     run last; afterwards the viewport size, every scroll position and the window scroll are
//     what they were, and nothing is focused (activeElement blurred). Findings in check order,
//     each check's own findings in document order, no duplicate { check, detail }. More than
//     maxPerCheck findings of one check -> the first maxPerCheck, then { check, detail: '… <n> more' }.
//     A check that throws is reported as { check, detail: 'check failed: <first line>' } and the
//     others still run.
//     While a modal is open, the page behind it is left alone by every check but focus (a person can't
//     reach it until the modal closes; focus goes where Tab takes it): an element inside [inert], or,
//     when a modal is open, outside the topmost one. Open modal = a shown [role="dialog"][aria-modal="true"],
//     [role="alertdialog"] or <dialog> opened with showModal() (dialog:modal), not inside [inert] or
//     aria-hidden; the topmost is the last of them in document order. Inside it the checks run as ever.
//
//   The checks (detail formats exactly as below; <el> = Sen's label(): `tag "name" W×H` (× is U+00D7), name =
//   aria-label, else its <label>'s text, else placeholder, else text, else name attr; whitespace
//   collapsed, cut to 30 chars; W, H rounded px):
//     contrast  every shown element with its own non-blank text node(s), not inside :disabled or
//               [aria-disabled="true"]: text colour (alpha composited over the background) vs the
//               background painted behind it (Sen's behind(): backgrounds stacked up to the first
//               opaque one, white under all). Skipped when the element or an ancestor up to that
//               opaque one has a background-image other than none (the backdrop is unknown).
//               WCAG 2 contrast ratio; needs 4.5, or 3 when large (font-size >= 24px, or
//               >= 18.66px with font-weight >= 700). Ratio below -> 
//               `<el> contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1` (ratio floored to 1
//               decimal, colours as 6-digit lowercase hex of the composited sRGB).
//     target    Sen's smallTargets() with min = targetPx (a label around a checkbox is its box; a
//               ::after tap extension counts) -> `<el> under <targetPx> px`.
//               Pointer only (touch false): an INLINE target is exempt, as WCAG 2.5.8 exempts it —
//               an <a> (or [role="link"]) whose computed display is inline and whose parent element
//               has non-blank text outside it (it sits in a line of text). Touch keeps Sen's rule:
//               no exemption, a finger needs 48 px wherever the link is.
//     clipped   Sen's 'clipped' probe -> `<el> text cut off sideways (content N px in M px)` |
//               `<el> text cut off below (content N px in M px)` |
//               `<el> text runs past the right edge (x A to B of W)` (or left).
//     overlap   Sen's 'overlap' probe over targets and own-text lines (texts capped at maxTexts
//               elements, document order) -> `target <el> overlaps <el> by W×H` | `text <el> overlaps <el> by W×H`.
//     covered   Sen's coveredTargets() -> `<el> under <cover>` (cover = Sen's cover(): tag, then
//               .data-slot | .data-testid | .id | .first-class, then "text" when it has text).
//               Hit-tested where the target paints: an HTML box at its middle; an SVG shape, group or
//               <svg> root (0.6.0: a focusable chart whose middle holds an HTML label is not under it) at
//               points inside each of its shapes' fill (a 7x7 grid of the shape's
//               box, kept where isPointInFill) and along its outline (12 points, when it has a stroke
//               or the grid found no fill), from at most 40 shapes, leaving out pointer-events: none,
//               hidden ones and those inside defs, clipPath, mask, pattern, marker or symbol (text, use,
//               image: the middle of their box); an <svg> with no such shape: its middle. Covered only when no point
//               reaches the target (or a part of it, or a <label> for it); a hit on an ancestor (the
//               svg around a shape) is a point it doesn't paint, never a cover; the cover named is the
//               first point's that is neither.
//     keyboard  Sen's keyboard(): viewport height set to keyboardHeight, each of the first 6
//               fields focused, the field and its form's main button must be reachable ->
//               `<el> out of reach: T to B in a H px screen` | `<el> under <cover>`; each detail once.
//     focus     Sen's focus(): Tab up to focusStops times from the top; each focused control
//               must show a ring -> `<el> takes focus with no ring to see`. When its styles show no
//               ring (outline, shadow, border, ::before/::after), the screen is pictured around it
//               (its box and 6 px, scale css, animations off, caret hidden) focused and then blurred:
//               at least max(4, shorter side of its box) pixels changing by 10 of 255 on a channel
//               is a ring (an SVG stroke or filter, a ring drawn on a sibling or an overlay).
//
// Example: on `<button style="width:20px;height:20px">x</button>` with { touch: true }
//   -> [{ check: 'target', detail: 'button "x" 20×20 under 48 px', fp: { role: 'button', name: 'x', landmark: 'page' } }]
//
//   U7 (rework, design 2026-11-12 §8; tests: test/fingerprint.test.mjs): each finding about an element carries fp =
//   fingerprint.mjs elementFingerprint(that element) — { role, name, landmark } — installed on the page with FP_INSTALL
//   before the checks run (overlap: the first element of the pair). The '… <n> more' and 'check failed: …' rows have no
//   fp. Findings are deduplicated by detail, as before; the first one's fp is kept.

import { FP_INSTALL } from './fingerprint.mjs';
import { decodePng } from './png.mjs';

export const CHECK_IDS = ['contrast', 'target', 'clipped', 'overlap', 'covered', 'keyboard', 'focus'];
export const TARGETS =
  'a[href], button, input, select, textarea, [role="switch"], [role="radio"], [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
// What the keyboard check types into.
const FIELDS =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="hidden"]):not([type="range"]):not([type="color"]):not([type="image"]), textarea';
const KEYBOARD_FIELDS = 6;

// Everything the checks measure in the page, in one function so the helpers are written once (it runs in
// the browser, so it can't import anything). Returns lines for the findings, or a count.
const probe = (a) => {
  const w = window;
  const out = [];
  // A finding about an element, with its fingerprint (FP_INSTALL put the function on the page; none -> null).
  const fpOf = (el) => {
    try {
      return w.__mfqaFp ? w.__mfqaFp(el) : null;
    } catch {
      return null;
    }
  };
  const findingAt = (el, detail) => out.push({ detail, fp: fpOf(el) });
  const SKIP = '.sr-only, [aria-hidden="true"]';
  const round = (n) => Math.round(n);
  const tag = (el) => el.tagName.toLowerCase();
  const textOf = (el) => {
    const labelled = el.labels?.[0]?.textContent;
    const raw =
      el.getAttribute('aria-label') || labelled || el.placeholder || el.textContent || el.getAttribute('name') || '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 30);
  };
  const size = (r) => `${round(r.width)}×${round(r.height)}`;
  // `button "Save" 120×40`
  const label = (el) => `${tag(el)} "${textOf(el)}" ${size(el.getBoundingClientRect())}`;
  // What sits on top of a target: `div.toast "Saved"`, by the name the app gave it, else its first class.
  const cover = (el) => {
    const id =
      el.getAttribute('data-slot') ||
      el.getAttribute('data-testid') ||
      el.id ||
      (typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '');
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `${tag(el)}${id ? `.${id}` : ''}${t ? ` "${t}"` : ''}`;
  };
  // The open modal on top: the last shown [role=dialog][aria-modal=true], [role=alertdialog] or <dialog> opened
  // with showModal(), in document order (a nested one, or the one a portal added last). Null when none is open.
  let modal;
  const topModal = () => {
    if (modal !== undefined) return modal;
    const open = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')];
    try {
      open.push(...document.querySelectorAll('dialog:modal'));
    } catch {
      /* a browser without :modal */
    }
    const up = open.filter((m) => {
      const r = m.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        !m.closest('[inert]') &&
        !m.closest(SKIP) &&
        m.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
      );
    });
    up.sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    modal = up[up.length - 1] ?? null;
    return modal;
  };
  // The page behind an open modal can't be reached until the modal closes: what the app made inert (React
  // Aria's modals do), or what is outside the modal on top. The checks leave it alone; inside the modal they run.
  const behindModal = (el) => !!el.closest('[inert]') || (topModal() !== null && !topModal().contains(el));
  // `evenBehind`: an element behind a modal counts too (focus goes where Tab takes it)
  const shown = (el, evenBehind = false) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || el.closest(SKIP) || (!evenBehind && behindModal(el))) return false;
    // not drawn at all (display, visibility, opacity, or the inside of a closed <details>)
    return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  };
  const isTarget = (el) => shown(el) && !el.matches('[data-slot="toggle-group"]');
  const box = (r) => ('left' in r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : { l: r.l, t: r.t, r: r.r, b: r.b });
  // The box with the ancestors that cut it off applied: those that scroll or hide their overflow, sideways
  // and, when `down` is set, vertically too. Null when nothing of it is left to see. A fixed box ignores them.
  const clip = (el, from, down) => {
    const b = { ...from };
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (n !== el) {
        const r = n.getBoundingClientRect();
        const cuts = (v) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
        if (cuts(cs.overflowX)) {
          b.l = Math.max(b.l, r.left);
          b.r = Math.min(b.r, r.right);
        }
        if (down && cuts(cs.overflowY)) {
          b.t = Math.max(b.t, r.top);
          b.b = Math.min(b.b, r.bottom);
        }
      }
      if (cs.position === 'fixed') break;
    }
    return b.r > b.l && b.b > b.t ? b : null;
  };
  // Whether an element is a scroll container: it holds the page's content rather than being a control.
  const scrolls = (el) => {
    const cs = getComputedStyle(el);
    const by = (v) => v === 'auto' || v === 'scroll';
    return (
      (by(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
      (by(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)
    );
  };
  // The layer an element lives in: pinned (a fixed or sticky box around it), the content of the scroller it
  // sits in, or the page. What scrolls under what is pinned or floats above it is `covered`'s to find.
  const layers = new Map();
  const layer = (el) => {
    if (layers.has(el)) return layers.get(el);
    let found = 'page';
    for (let n = el; n; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') {
        found = 'pinned';
        break;
      }
      if (n !== el && scrolls(n)) {
        found = n;
        break;
      }
    }
    layers.set(el, found);
    return found;
  };
  // The boxes of the lines an element's own text is set in, each the height of the font: line spacing
  // tighter than the font (leading-none) overlaps the lines' own boxes, and the glyphs don't.
  const ownText = (el) => {
    const lines = [];
    const cs = getComputedStyle(el);
    const own = el.getBoundingClientRect();
    const hides = (v) => v === 'hidden' || v === 'clip';
    for (const n of el.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE || !n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const fs = parseFloat(cs.fontSize) || 0;
      for (const r of range.getClientRects()) {
        if (r.width === 0 || r.height === 0) continue;
        const mid = (r.top + r.bottom) / 2;
        const line = { l: r.left, t: Math.max(r.top, mid - fs / 2), r: r.right, b: Math.min(r.bottom, mid + fs / 2) };
        // lines a clamp or a hidden edge cuts off aren't seen (a clamped paragraph keeps its other lines' boxes)
        if (hides(cs.overflowY)) {
          line.t = Math.max(line.t, own.top);
          line.b = Math.min(line.b, own.bottom);
        }
        if (hides(cs.overflowX)) {
          line.l = Math.max(line.l, own.left);
          line.r = Math.min(line.r, own.right);
        }
        if (line.r > line.l && line.b > line.t) lines.push(line);
      }
    }
    return lines;
  };
  const touch = (x, y) => Math.min(x.r, y.r) - Math.max(x.l, y.l) > 2 && Math.min(x.b, y.b) - Math.max(x.t, y.t) > 2;
  const depth = (x, y) =>
    `${round(Math.min(x.r, y.r) - Math.max(x.l, y.l))}×${round(Math.min(x.b, y.b) - Math.max(x.t, y.t))}`;

  const targets = () => [...document.querySelectorAll(a.targets)].filter(isTarget);
  const scrollers = () =>
    [document.documentElement, ...document.querySelectorAll('*')].filter(
      (e) => e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth,
    );
  // `instant`: a page with scroll-behavior: smooth would otherwise still be moving when we read it back
  const scrollBack = (e, x, y) => e.scrollTo({ left: x, top: y, behavior: 'instant' });
  // not innerWidth: a phone's layout viewport widens to take in whatever sticks out sideways
  const screenWidth = () => document.documentElement.clientWidth;
  const inView = (r) => r.left >= -1 && r.top >= -1 && r.right <= screenWidth() + 1 && r.bottom <= window.innerHeight + 1;
  // Points on what a target paints, in the screen. An HTML box paints its box, so its middle stands for it. An
  // SVG shape paints its fill and its stroke, not its box (the middle of a ring's box is its hole), and a group
  // paints only its shapes: points inside each shape's fill and along its stroke, from the shapes a tap can hit.
  // An <svg> root is the same: a chart whose middle holds an HTML label (a donut's total) paints its rings, not
  // its middle. Shapes kept for a clip path, a mask or a marker paint nothing where they are.
  const SHAPES = 'path, circle, ellipse, rect, line, polyline, polygon, text, use, image';
  const UNDRAWN = 'defs, clipPath, clippath, mask, pattern, marker, symbol';
  const paints = (el) => {
    const r = el.getBoundingClientRect();
    const middle = [[(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
    if (!(el instanceof SVGElement)) return middle;
    const pts = [];
    const shapes = (el.matches(SHAPES) ? [el] : [...el.querySelectorAll(SHAPES)]).filter((s) => !s.closest(UNDRAWN)).slice(0, 40);
    for (const s of shapes) {
      const cs = getComputedStyle(s);
      if (cs.pointerEvents === 'none' || cs.visibility !== 'visible' || cs.display === 'none') continue;
      const m = s instanceof SVGGeometryElement ? s.getScreenCTM() : null;
      if (!m) {
        // text, use, image: their box
        const b = s.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) pts.push([(b.left + b.right) / 2, (b.top + b.bottom) / 2]);
        continue;
      }
      const at = (p) => {
        const q = new DOMPoint(p.x, p.y).matrixTransform(m);
        pts.push([q.x, q.y]);
      };
      const before = pts.length;
      const bb = s.getBBox();
      if (cs.fill !== 'none')
        for (let i = 0; i < 7; i++)
          for (let j = 0; j < 7; j++) {
            const p = new DOMPoint(bb.x + (bb.width * (i + 0.5)) / 7, bb.y + (bb.height * (j + 0.5)) / 7);
            if (s.isPointInFill(p)) at(p);
          }
      // along the outline: the stroke's middle, or a fill too thin for the grid to land in
      if ((cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0) || pts.length === before) {
        const len = s.getTotalLength();
        for (let k = 0; k < 12; k++) at(s.getPointAtLength((len * k) / 12));
      }
    }
    // an <svg> with no shape drawn in it (a CSS background, an icon font) paints its box: its middle stands for it
    if (el instanceof SVGSVGElement && !pts.length) return middle;
    return pts;
  };
  // What is on top of a target where it paints, when no point of it reaches the target or part of it; null when
  // one does; undefined when none of it is on the screen (not tested here). An ancestor hit (the svg around a
  // shape, the paragraph between a wrapped link's lines) is behind the target, not over it: nothing paints there.
  const coveredBy = (el) => {
    let found = null;
    let seen = false;
    for (const [x, y] of paints(el)) {
      if (x < 0 || y < 0 || x >= screenWidth() || y >= window.innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (!top) continue;
      seen = true;
      if (top === el || el.contains(top)) return null;
      // a label names its control, and a tap on it is a tap on the control
      const lab = top.closest('label');
      if (lab && (lab.contains(el) || lab.control === el)) return null;
      if (!top.contains(el)) found ??= top;
    }
    return seen ? found : undefined;
  };
  // The cover after trying again from where scrolling would put the target; null when it is free.
  const covering = (el) => {
    const first = coveredBy(el);
    if (first === null) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return coveredBy(el) || null;
  };

  if (a.kind === 'save') {
    w.__mfqaScroll = {
      win: [window.scrollX, window.scrollY],
      boxes: scrollers().map((e) => [e, e.scrollLeft, e.scrollTop]),
    };
    return 0;
  }
  if (a.kind === 'restore') {
    const s = w.__mfqaScroll;
    delete w.__mfqaScroll;
    for (const [e, x, y] of s?.boxes ?? []) scrollBack(e, x, y);
    if (s) scrollBack(window, s.win[0], s.win[1]);
    return 0;
  }

  // Any CSS colour as sRGB with alpha; the canvas knows oklch and colour-mix too.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const colours = new Map();
  const rgba = (c) => {
    if (colours.has(c)) return colours.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const got = [d[0], d[1], d[2], d[3] / 255];
    colours.set(c, got);
    return got;
  };
  // What is painted behind an element: backgrounds laid over each other up to the first opaque one, white
  // under all. `image` is set when one of those has a background-image: what is behind the text is unknown.
  const behinds = new Map();
  const behind = (e) => {
    if (!e) return { c: [255, 255, 255], image: false };
    const known = behinds.get(e);
    if (known) return known;
    const cs = getComputedStyle(e);
    const [r, g, b, al] = rgba(cs.backgroundColor);
    const image = cs.backgroundImage !== 'none';
    let got;
    if (al === 1) got = { c: [r, g, b], image };
    else {
      const under = behind(e.parentElement);
      got =
        al === 0
          ? { c: under.c, image: under.image || image }
          : {
              c: [r * al + under.c[0] * (1 - al), g * al + under.c[1] * (1 - al), b * al + under.c[2] * (1 - al)],
              image: under.image || image,
            };
    }
    behinds.set(e, got);
    return got;
  };

  if (a.kind === 'contrast') {
    const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const luminance = (c) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) continue;
      if (!shown(el) || el.closest(':disabled, [aria-disabled="true"]')) continue;
      const back = behind(el);
      if (back.image) continue;
      const cs = getComputedStyle(el);
      const [r, g, b, al] = rgba(cs.color);
      const bg = back.c.map(round);
      const fg = [r, g, b].map((v, k) => round(v * al + back.c[k] * (1 - al)));
      const lf = luminance(fg);
      const lb = luminance(bg);
      const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
      const fs = parseFloat(cs.fontSize) || 0;
      const large = fs >= 24 || (fs >= 18.66 && (parseInt(cs.fontWeight, 10) || 400) >= 700);
      const needs = large ? 3 : 4.5;
      if (ratio < needs)
        findingAt(el, `${label(el)} contrast ${(Math.floor(ratio * 10) / 10).toFixed(1)}:1 (${hex(fg)} on ${hex(bg)}), needs ${needs}:1`);
    }
    return out;
  }

  if (a.kind === 'target') {
    // a control drawn smaller keeps its target through an invisible ::after extension
    const need = a.targetPx - 0.5;
    for (const el of document.querySelectorAll(a.targets)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
      if (el.closest(SKIP) || behindModal(el)) continue;
      // a toggle group's own box holds its toggles, each a target of its own
      if (el.matches('[data-slot="toggle-group"]')) continue;
      // pointer only: a link set inline in a line of text is exempt (WCAG 2.5.8 "inline"); a finger still needs 48 px
      if (!a.touch && el.matches('a[href], [role="link"]') && cs.display === 'inline') {
        const around = [...(el.parentElement?.childNodes ?? [])].some((n) => n !== el && !n.contains?.(el) && (n.textContent ?? '').trim());
        if (around) continue;
      }
      // a checkbox in a row's <label> is tapped by the whole row: the label's box is the target
      const lbox = el.closest('label')?.getBoundingClientRect() ?? r;
      const tap = getComputedStyle(el, '::after');
      const wide = Math.max(lbox.width, tap.content !== 'none' ? parseFloat(tap.width) || 0 : 0);
      const high = Math.max(lbox.height, tap.content !== 'none' ? parseFloat(tap.height) || 0 : 0);
      if (wide < need || high < need) findingAt(el, `${label(el)} under ${a.targetPx} px`);
    }
    return out;
  }

  if (a.kind === 'clipped') {
    for (const el of document.querySelectorAll('body *')) {
      if (!shown(el)) continue;
      const lines = ownText(el);
      if (!lines.length) continue;
      const cs = getComputedStyle(el);
      const here = label(el);
      // cut off by its own box, unless it ends in an ellipsis or a line clamp on purpose
      const hidden = (v) => v === 'hidden' || v === 'clip';
      const onPurpose = cs.textOverflow === 'ellipsis' || cs.getPropertyValue('-webkit-line-clamp') !== 'none';
      if (!onPurpose) {
        if (hidden(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)
          findingAt(el, `${here} text cut off sideways (content ${el.scrollWidth} px in ${el.clientWidth} px)`);
        else if (hidden(cs.overflowY) && el.scrollHeight > el.clientHeight + 1)
          findingAt(el, `${here} text cut off below (content ${el.scrollHeight} px in ${el.clientHeight} px)`);
      }
      // past the screen's side, as far as a scroller or a hidden edge around it lets it show
      const all = lines.reduce((m, l) => ({
        l: Math.min(m.l, l.l),
        t: Math.min(m.t, l.t),
        r: Math.max(m.r, l.r),
        b: Math.max(m.b, l.b),
      }));
      const seen = clip(el, all, false);
      if (seen && (seen.l < -1 || seen.r > screenWidth() + 1))
        findingAt(el, `${here} text runs past the ${seen.l < -1 ? 'left' : 'right'} edge (x ${round(seen.l)} to ${round(seen.r)} of ${screenWidth()})`);
    }
    return out;
  }

  if (a.kind === 'overlap') {
    const seen = (el) => clip(el, box(el.getBoundingClientRect()), true);
    // the cheap test (do any two boxes touch) first: the rest only for the few pairs that do
    const hit = (kind, x, y, bx, by) => {
      let at = null;
      for (const p of bx) {
        for (const q of by) {
          if (touch(p, q)) {
            at = [p, q];
            break;
          }
        }
        if (at) break;
      }
      if (!at || x.contains(y) || y.contains(x)) return;
      // something that scrolls under a fixed bar, or has a button floating over it, is covered, not overlapped
      if (layer(x) !== layer(y)) return;
      findingAt(x, `${kind} ${label(x)} overlaps ${label(y)} by ${depth(at[0], at[1])}`);
    };
    // a scroll container with a tab stop (for the keyboard) holds controls; it isn't one
    // (nor is anything holding other controls, such as main or a card: its parts are what overlap)
    const ts = [];
    for (const el of targets()) {
      if (scrolls(el) || el.querySelector(a.targets)) continue;
      const b = seen(el);
      if (b) ts.push({ el, b });
    }
    for (let i = 0; i < ts.length; i++)
      for (let j = i + 1; j < ts.length; j++) hit('target', ts[i].el, ts[j].el, [ts[i].b], [ts[j].b]);
    const texts = [];
    for (const el of document.querySelectorAll('body *')) {
      if (texts.length >= a.maxTexts) break;
      if (!shown(el)) continue;
      const lines = ownText(el);
      if (lines.length > 0 && seen(el)) texts.push({ el, lines });
    }
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++)
        hit('text', texts[i].el, texts[j].el, texts[i].lines, texts[j].lines);
    return out;
  }

  if (a.kind === 'covered') {
    const saved = [window.scrollX, window.scrollY, scrollers().map((e) => [e, e.scrollLeft, e.scrollTop])];
    try {
      for (const el of targets()) {
        // a disabled control takes no taps (pointer-events: none), so nothing covers it
        if (getComputedStyle(el).pointerEvents === 'none') continue;
        const over = covering(el);
        if (over) findingAt(el, `${label(el)} under ${cover(over)}`);
      }
    } finally {
      for (const [e, x, y] of saved[2]) scrollBack(e, x, y);
      scrollBack(window, saved[0], saved[1]);
    }
    return out;
  }

  // the keyboard check
  const fields = () => [...document.querySelectorAll(a.fields)].filter(isTarget);
  if (a.kind === 'fields') return Math.min(fields().length, a.maxFields);
  if (a.kind === 'focusField') {
    fields()[a.i ?? 0]?.focus({ preventScroll: true });
    return 0;
  }
  if (a.kind === 'reach') {
    const field = fields()[a.i ?? 0];
    if (!field) return out;
    // In the screen once scrolled to, and not under something.
    const reach = (el) => {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (!inView(r)) findingAt(el, `${label(el)} out of reach: ${round(r.top)} to ${round(r.bottom)} in a ${window.innerHeight} px screen`);
      else if (getComputedStyle(el).pointerEvents !== 'none') {
        const over = coveredBy(el);
        if (over) findingAt(el, `${label(el)} under ${cover(over)}`);
      }
    };
    reach(field);
    // the form's main button: its submit, else the last one that can be pressed in the form or sheet
    const scope = field.form ?? field.closest('[role="dialog"], [role="alertdialog"]');
    const buttons = scope ? [...scope.querySelectorAll('button')].filter((b) => !b.disabled && shown(b)) : [];
    const main = scope?.querySelector('button[type="submit"]') ?? buttons[buttons.length - 1];
    if (main) reach(main);
    return out;
  }

  // the focus check: Tab from the top, and look at what is focused
  if (a.kind === 'tabReset') {
    // the browser carries on from where focus last was; focusing the body first starts it from the top
    document.activeElement?.blur();
    const had = document.body.getAttribute('tabindex');
    document.body.tabIndex = -1;
    document.body.focus({ preventScroll: true });
    if (had === null) document.body.removeAttribute('tabindex');
    else document.body.setAttribute('tabindex', had);
    scrollBack(window, 0, 0);
    w.__mfqaSeen = new Set();
    return 0;
  }
  // A transition would still be at its start: jump each to its end to read the look it is heading for.
  const finish = () => {
    for (const t of document.getAnimations())
      if (t instanceof CSSTransition)
        try {
          t.finish();
        } catch {
          /* one that can't finish isn't a ring */
        }
  };
  finish();
  // focus taken off the stop and given back, for the picture without it and the Tab after it
  if (a.kind === 'blurAt' || a.kind === 'focusAt') {
    const at = w.__mfqaAt;
    if (a.kind === 'blurAt') at?.blur();
    else at?.focus({ preventScroll: true });
    finish();
    return 0;
  }
  const el = document.activeElement;
  const seen = (w.__mfqaSeen ??= new Set());
  if (!el || el === document.body || seen.has(el)) return ['cycled'];
  seen.add(el);
  if (!shown(el, true)) return out;

  // A ring is drawn outside the control, over what is behind it, or inside it over the control itself.
  const differs = (node, c, inside) => {
    const bg = behind(inside || !node.parentElement ? node : node.parentElement).c;
    const [r, g, b, al] = rgba(c);
    if (al === 0) return false;
    // on top of the background, ten of 255 on any channel is a difference to see
    return (
      Math.max(
        Math.abs(r * al + bg[0] * (1 - al) - bg[0]),
        Math.abs(g * al + bg[1] * (1 - al) - bg[1]),
        Math.abs(b * al + bg[2] * (1 - al) - bg[2]),
      ) >= 10
    );
  };
  // An outline, or with `shadows` a shadow with some reach, in a colour that shows against what is behind it.
  const drawn = (node, cs, shadows) => {
    if (
      cs.outlineStyle !== 'none' &&
      parseFloat(cs.outlineWidth) >= 1 &&
      differs(node, cs.outlineColor, parseFloat(cs.outlineOffset) < 0)
    )
      return true;
    if (!shadows || cs.boxShadow === 'none') return false;
    // split the shadows at the commas outside brackets, and read each one's colour and reach
    const parts = [];
    let level = 0;
    let from = 0;
    [...cs.boxShadow].forEach((ch, k, all) => {
      if (ch === '(') level++;
      if (ch === ')') level--;
      if ((ch === ',' && level === 0) || k === all.length - 1) {
        parts.push(cs.boxShadow.slice(from, ch === ',' ? k : k + 1).trim());
        from = k + 1;
      }
    });
    return parts.some((sh) => {
      const colour = sh.match(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/)?.[0] ?? sh.split(' ')[0];
      const lengths =
        sh
          .replace(colour, '')
          .match(/-?[\d.]+px/g)
          ?.map(parseFloat) ?? [];
      return (lengths[2] ?? 0) >= 1 || (lengths[3] ?? 0) >= 1 ? differs(node, colour, /\binset\b/.test(sh)) : false;
    });
  };
  const pseudo = (node, shadows) =>
    ['::before', '::after'].some((p) => {
      const cs = getComputedStyle(node, p);
      return cs.content !== 'none' && drawn(node, cs, shadows);
    });
  // an outline on the control is a ring as it stands
  if (drawn(el, getComputedStyle(el), false) || pseudo(el, false)) return out;

  // Otherwise look at what changes when focus leaves: a shadow or a border a control always has (shadcn's
  // soft shadow, a card's edge) isn't a focus ring. A field can show focus by the edge of what wraps it (an
  // underline that darkens, a box that takes a ring), so the wrappers that hold the focus are looked at too.
  const wraps = [el];
  for (let n = el.parentElement; n && n !== document.body && wraps.length < 4; n = n.parentElement)
    if (n.matches(':focus-within')) wraps.push(n);
  const edges = (n) => {
    const cs = getComputedStyle(n);
    return ['Top', 'Right', 'Bottom', 'Left'].map(
      (side) =>
        `${cs.getPropertyValue(`border-${side.toLowerCase()}-style`)} ${cs.getPropertyValue(`border-${side.toLowerCase()}-width`)} ${cs.getPropertyValue(`border-${side.toLowerCase()}-color`)}`,
    );
  };
  const look = (n) => {
    const cs = getComputedStyle(n);
    const side = ['::before', '::after'].map((p) => {
      const ps = getComputedStyle(n, p);
      return `${ps.content} ${ps.outlineStyle} ${ps.outlineWidth} ${ps.outlineColor} ${ps.boxShadow}`;
    });
    return `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} ${cs.boxShadow} ${edges(n).join('|')} ${side.join('|')}`;
  };
  const focused = wraps.map(look);
  const focusedEdges = wraps.map(edges);
  el.blur();
  finish();
  const plain = wraps.map(look);
  const plainEdges = wraps.map(edges);
  el.focus({ preventScroll: true });
  finish();
  const ring = wraps.some((n, i) => {
    if (focused[i] === plain[i]) return false;
    if (drawn(n, getComputedStyle(n), true) || pseudo(n, true)) return true;
    return focusedEdges[i].some((e, k) => {
      if (e === plainEdges[i][k]) return false;
      const [style, width, ...colour] = e.split(' ');
      return style !== 'none' && parseFloat(width) >= 1 && differs(n, colour.join(' '), false);
    });
  });
  // No ring in the styles: the page's pixels around the control have the last word (focus()), since an SVG
  // shape shows focus by a stroke or a filter, and a ring can be drawn on a sibling or an overlay.
  if (!ring) {
    const r = el.getBoundingClientRect();
    w.__mfqaAt = el;
    out.push({ detail: `${label(el)} takes focus with no ring to see`, box: { x: r.left, y: r.top, w: r.width, h: r.height }, fp: fpOf(el) });
  }
  return out;
};

const lines = (page, o, kind, i) => page.evaluate(probe, { ...o, kind, i, targets: TARGETS, fields: FIELDS });

// The frame the browser draws after a layout change, twice, so the page has settled into it.
const frames = (page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

// Waits for what is moving to stop (a reveal, a sheet sliding in), up to three seconds, and for a view
// transition to hand the page back, up to five: a person can't tap a button under one either, but nothing is
// wrong with the page once it's over. Animations that never end (a spinner) are left out.
const calm = async (page) => {
  await page
    .evaluate(async () => {
      const ends = document
        .getAnimations()
        .filter((x) => x.effect?.getComputedTiming().endTime !== Infinity)
        .map((x) => x.finished.catch(() => undefined));
      await Promise.race([Promise.all(ends), new Promise((done) => setTimeout(done, 3000))]);
    })
    .catch(() => undefined);
  // under a view transition the whole page answers a tap as the root element
  await page
    .waitForFunction(
      (sel) =>
        ![...document.querySelectorAll(sel)].some((el) => {
          const r = el.getBoundingClientRect();
          const x = (r.left + r.right) / 2;
          const y = (r.top + r.bottom) / 2;
          return (
            r.width > 0 &&
            r.height > 0 &&
            x >= 0 &&
            y >= 0 &&
            x < innerWidth &&
            y < innerHeight &&
            document.elementFromPoint(x, y) === document.documentElement
          );
        }),
      TARGETS,
      { timeout: 5000 },
    )
    .catch(() => undefined);
};

// A field, and its form's main button, reachable with the keyboard open (Android shrinks the viewport).
async function keyboard(page, o) {
  const found = [];
  const n = await lines(page, o, 'fields');
  if (n === 0) return found;
  const was = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  try {
    await page.setViewportSize({ width: was.width, height: o.keyboardHeight });
    for (let i = 0; i < n; i++) {
      await lines(page, o, 'focusField', i);
      await frames(page);
      // each field of one form reaches the same button: say it once
      for (const f of await lines(page, o, 'reach', i)) if (!found.some((x) => x.detail === f.detail)) found.push(f);
    }
  } finally {
    await page.setViewportSize(was);
    await frames(page);
  }
  return found;
}

// Whether focus changes what the screen shows around a control: its box and RING_PAD px around it, pictured
// focused and then with focus taken off. A pixel that moved 10 of 255 on a channel has changed (the ten of
// focus's `differs`); a ring is at least as many changed pixels as the box's shorter side, and at least 4.
const RING_PAD = 6;
async function ringInPixels(page, o, box) {
  const view = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: innerHeight }));
  const x = Math.max(0, Math.floor(box.x - RING_PAD));
  const y = Math.max(0, Math.floor(box.y - RING_PAD));
  const width = Math.min(view.w, Math.ceil(box.x + box.w + RING_PAD)) - x;
  const height = Math.min(view.h, Math.ceil(box.y + box.h + RING_PAD)) - y;
  if (width < 1 || height < 1) return false;
  const shot = async () =>
    decodePng(await page.screenshot({ clip: { x, y, width, height }, scale: 'css', animations: 'disabled', caret: 'hide' }));
  const on = await shot();
  await lines(page, o, 'blurAt');
  let off;
  try {
    off = await shot();
  } finally {
    await lines(page, o, 'focusAt');
  }
  if (on.width !== off.width || on.height !== off.height) return false;
  let changed = 0;
  for (let i = 0; i < on.data.length; i += 4)
    if (
      Math.max(
        Math.abs(on.data[i] - off.data[i]),
        Math.abs(on.data[i + 1] - off.data[i + 1]),
        Math.abs(on.data[i + 2] - off.data[i + 2]),
      ) >= 10
    )
      changed++;
  return changed >= Math.max(4, Math.round(Math.min(box.w, box.h)));
}

// Tab through the page: every control that takes focus shows a ring.
async function focus(page, o) {
  const found = [];
  await lines(page, o, 'tabReset');
  for (let i = 0; i < o.focusStops; i++) {
    await page.keyboard.press('Tab');
    const stop = await lines(page, o, 'tabStep');
    if (stop[0] === 'cycled') break;
    for (const s of stop) if (!(await ringInPixels(page, o, s.box))) found.push({ detail: s.detail, fp: s.fp ?? null });
  }
  return found;
}

// Which checks actually ran, given runChecks' findings and the options it ran with: every wanted check except keyboard
// off a touch screen (it only types into fields on a phone-size one) and any whose run threw ('check failed: …').
// A check that ran and found nothing is in the list; that is how "no finding" is told from "never looked".
export function checksRan(found, opts = {}) {
  if ((found ?? []).some((f) => f.check === 'checks')) return [];
  const failed = new Set((found ?? []).filter((f) => String(f.detail).startsWith('check failed:')).map((f) => f.check));
  const only = opts.only ?? CHECK_IDS;
  return CHECK_IDS.filter((id) => only.includes(id) && !failed.has(id) && !(id === 'keyboard' && !opts.touch));
}

export async function runChecks(page, opts = {}) {
  const { touch = false, keyboardHeight = 508, focusStops = 30, maxTexts = 1500, maxPerCheck = 50 } = opts;
  const targetPx = opts.targetPx ?? (touch ? 48 : 24);
  const only = opts.only ?? CHECK_IDS;
  const o = { touch, targetPx, keyboardHeight, focusStops, maxTexts, maxFields: KEYBOARD_FIELDS };
  const runs = {
    contrast: () => lines(page, o, 'contrast'),
    target: () => lines(page, o, 'target'),
    clipped: () => lines(page, o, 'clipped'),
    overlap: () => lines(page, o, 'overlap'),
    covered: () => lines(page, o, 'covered'),
    keyboard: () => (touch ? keyboard(page, o) : []),
    focus: () => focus(page, o),
  };
  const wanted = CHECK_IDS.filter((id) => only.includes(id));
  const all = [];
  await calm(page);
  // The fingerprint function the probe reads (U7); a page that refuses it only loses the fingerprints.
  await page.evaluate(FP_INSTALL).catch(() => undefined);
  const disturbs = wanted.some((id) => id === 'keyboard' || id === 'focus');
  await page.evaluate(probe, { kind: 'save' }).catch(() => undefined);
  try {
    for (const check of wanted) {
      try {
        // Each detail once, with the fingerprint of the first element that gave it.
        const byDetail = new Map();
        for (const f of await runs[check]()) {
          const detail = typeof f === 'string' ? f : f.detail;
          if (!byDetail.has(detail)) byDetail.set(detail, typeof f === 'string' ? null : f.fp ?? null);
        }
        const details = [...byDetail.keys()];
        for (const detail of details.slice(0, maxPerCheck)) {
          const fp = byDetail.get(detail);
          all.push(fp ? { check, detail, fp } : { check, detail });
        }
        if (details.length > maxPerCheck) all.push({ check, detail: `… ${details.length - maxPerCheck} more` });
      } catch (err) {
        const first = String(err?.message ?? err).split('\n')[0];
        all.push({ check, detail: `check failed: ${first}` });
      }
    }
  } finally {
    // the page as it was: nothing focused (keyboard and focus moved it), every scroll position back
    if (disturbs) await page.evaluate(() => document.activeElement?.blur()).catch(() => undefined);
    await page.evaluate(probe, { kind: 'restore' }).catch(() => undefined);
  }
  return all;
}
