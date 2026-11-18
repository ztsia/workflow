// Fingerprints (rework U7, design 2026-11-12 §8): what a page-check or tour finding is ABOUT, not where it was seen.
// A finding is about one element; its fingerprint is the check, the element's role and accessible name, and the
// nearest landmark around it. Not the screen: the same sidebar link failing contrast on six screens is one
// fingerprint, so qa/standing.md can hold it once (a Standing note on any screen) and a run can see it is shared chrome.
// Everything is read from the DOM and the accessibility semantics HTML and ARIA define; nothing names an app (D39).
//
// CONTRACT (tests: test/fingerprint.test.mjs — the browser part in a real headless browser, page.setContent)
//
//   LANDMARKS (exported, frozen): ['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region',
//     'search', 'dialog', 'alertdialog'] — the ARIA landmark roles, plus the two dialog roles (a modal is the region a
//     person is in while it is open, though ARIA does not call it a landmark).
//
//   elementFingerprint(el) -> { role, name, landmark }       runs in the browser; self-contained (no outer names)
//     role of a node: its role attribute's first token (none, presentation and generic count as no role), else the
//       implicit role HTML gives its tag: a[href]/area[href] link; button, summary, input type button/submit/reset/image
//       button; input checkbox/radio/range/number/search; other inputs textbox (combobox with a list); select combobox
//       (listbox when multiple or size > 1); textarea textbox; h1–h6 heading; img (alt not '') img; nav navigation;
//       main main; aside complementary; header banner and footer contentinfo unless inside article, aside, main, nav or
//       section; section region and form form only when named (aria-label or aria-labelledby); search search; dialog
//       dialog; li listitem; ul/ol list; table table; tr row; td cell; th columnheader; p paragraph; option option;
//       article article; fieldset and details group; progress progressbar; meter meter; figure figure. Else none.
//     The subject: el itself when it has a role that is not a landmark; else the nearest ancestor that has one, climbing
//       until a landmark or the body (a contrast finding on the span inside a link is about the link). None found: el,
//       with role 'text' and its own text (its text nodes, else all its text) as the name. Shadow roots are crossed
//       through their host.
//     name of the subject: aria-label; else the text of the aria-labelledby ids; else its <label>s' text; else alt
//       (img, area, input image); else value (input button/submit/reset); else its text (textContent, so SVG text too);
//       else title, else placeholder. Whitespace collapsed, cut to 80 characters.
//     landmark: the nearest ancestor-or-self of el whose role is in LANDMARKS: '<role>' or '<role> "<name>"' when it
//       has an aria-label or aria-labelledby name (a landmark is never named by its text). None: 'page'.
//
//   FP_INSTALL — a string expression; page.evaluate(FP_INSTALL) defines window.__mfqaFp = elementFingerprint, so a page
//     probe that cannot import (checks.mjs) reads `window.__mfqaFp?.(el)`. CDP evaluation, so a page's CSP never blocks it.
//
//   Fingerprint = { check, role, name, landmark }: check is the page check id (contrast, target, …) or 'tour:<kind>'
//     (tour:clipped, tour:covered, tour:stuck) for a tour problem, whose element is the control that opened the popup.
//
//   fingerprintText(fp) -> '<check> on <role> "<name>" in <landmark>'   (a '"' or '\' in the name written '\"', '\\')
//     e.g. 'contrast on link "Support" in navigation "Primary"'. This is how a standing row carries it.
//   parseFingerprint(text) -> Fingerprint | null      the inverse; anything else (an old standing row's text) -> null.
//   fingerprintKey(fp) -> string     what two fingerprints are compared by: fingerprintText with every run of digits
//     made '#' and whitespace collapsed (a count in a name moves; compare.mjs matches findings the same way).
//   fingerprintId(fp) -> 'st-' + the first 8 hex of sha1('fp|' + fingerprintKey(fp))   a standing row's id for it.
//
//   Reading them off a capture record (compare.mjs keeps the after record on each pair):
//   tourKind(problem) -> 'clipped' | 'covered' | 'stuck'   (summary.mjs re-exports it: ' does not close on Escape'
//     stuck, ' covered at ' covered, else clipped — tour.mjs's problem texts)
//   checkFingerprint(finding) -> Fingerprint | null   a record's check finding { check, detail, fp } -> { check, ...fp }
//   tourFingerprint(record, problem) -> Fingerprint | null   the opened entry of record.tour whose clipped or covered
//     line is the problem (or whose '<control> does not close on Escape' it is): { check: 'tour:<kind>', ...entry.fp }

import crypto from 'node:crypto';

export const LANDMARKS = Object.freeze(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search', 'dialog', 'alertdialog']);

// Runs in the browser (page.evaluate / ElementHandle.evaluate, or as window.__mfqaFp): everything it needs is inside.
export function elementFingerprint(el) {
  const LANDMARK = ['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search', 'dialog', 'alertdialog'];
  const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const cut = (s) => collapse(s).slice(0, 80);
  const tag = (n) => String(n.tagName || '').toLowerCase();
  const up = (n) => n.parentElement ?? (n.getRootNode?.() instanceof ShadowRoot ? n.getRootNode().host : null);
  const byIds = (n) => collapse((n.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map((id) => n.ownerDocument.getElementById(id)?.textContent ?? '').join(' '));
  const label = (n) => collapse(n.getAttribute('aria-label')) || byIds(n);
  const sectioned = (n) => {
    for (let p = up(n); p; p = up(p)) if (['article', 'aside', 'main', 'nav', 'section'].includes(tag(p))) return true;
    return false;
  };
  const implicit = (n) => {
    const t = tag(n);
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'input') {
      const type = (n.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      const map = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', button: 'button', submit: 'button', reset: 'button', image: 'button' };
      return map[type] ?? (n.hasAttribute('list') ? 'combobox' : 'textbox');
    }
    switch (t) {
      case 'a': case 'area': return n.hasAttribute('href') ? 'link' : null;
      case 'button': case 'summary': return 'button';
      case 'select': return n.multiple || n.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return n.getAttribute('alt') === '' ? null : 'img';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'header': return sectioned(n) ? null : 'banner';
      case 'footer': return sectioned(n) ? null : 'contentinfo';
      case 'section': return label(n) ? 'region' : null;
      case 'form': return label(n) ? 'form' : null;
      case 'search': return 'search';
      case 'dialog': return 'dialog';
      case 'li': return 'listitem';
      case 'ul': case 'ol': return 'list';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'p': return 'paragraph';
      case 'option': return 'option';
      case 'article': return 'article';
      case 'fieldset': case 'details': return 'group';
      case 'progress': return 'progressbar';
      case 'meter': return 'meter';
      case 'figure': return 'figure';
      default: return null;
    }
  };
  const roleOf = (n) => {
    const own = collapse(n.getAttribute?.('role')).split(' ')[0].toLowerCase();
    if (own && !['none', 'presentation', 'generic'].includes(own)) return own;
    return implicit(n);
  };
  const nameOf = (n) => {
    const t = tag(n);
    const named = label(n);
    if (named) return cut(named);
    const labels = n.labels ? collapse([...n.labels].map((l) => l.textContent).join(' ')) : '';
    if (labels) return cut(labels);
    if (t === 'img' || t === 'area' || (t === 'input' && (n.getAttribute('type') || '').toLowerCase() === 'image')) {
      const alt = collapse(n.getAttribute('alt'));
      if (alt) return cut(alt);
    }
    if (t === 'input' && ['button', 'submit', 'reset'].includes((n.getAttribute('type') || '').toLowerCase())) {
      const v = collapse(n.value);
      if (v) return cut(v);
    }
    const text = t === 'input' || t === 'select' || t === 'textarea' ? '' : collapse(n.textContent);
    if (text) return cut(text);
    return cut(n.getAttribute('title') || n.getAttribute('placeholder') || '');
  };
  const top = (n) => !n || n === n.ownerDocument.body || n === n.ownerDocument.documentElement;

  let subject = null;
  let role = 'text';
  for (let n = el; !top(n); n = up(n)) {
    const r = roleOf(n);
    if (r && LANDMARK.includes(r)) break;
    if (r) {
      subject = n;
      role = r;
      break;
    }
  }
  // No role up to the landmark: the element's own text (its text nodes; a landmark's own line is not all its text).
  const own = () => cut([...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ')) || cut(el.textContent);
  const name = subject ? nameOf(subject) : own();
  let landmark = 'page';
  for (let n = el; !top(n); n = up(n)) {
    const r = roleOf(n);
    if (!r || !LANDMARK.includes(r)) continue;
    const named = cut(label(n));
    landmark = named ? `${r} "${named.replace(/[\\"]/g, (c) => `\\${c}`)}"` : r;
    break;
  }
  return { role, name, landmark };
}

export const FP_INSTALL = `window.__mfqaFp = ${elementFingerprint.toString()}`;

const quote = (s) => String(s ?? '').replace(/[\\"]/g, (c) => `\\${c}`);

export function fingerprintText(fp) {
  return `${fp.check} on ${fp.role} "${quote(fp.name)}" in ${fp.landmark}`;
}

const TEXT = /^(\S+) on (\S+) "((?:[^"\\]|\\.)*)" in (\S.*)$/;
export function parseFingerprint(text) {
  const m = TEXT.exec(String(text ?? '').trim());
  if (!m) return null;
  return { check: m[1], role: m[2], name: m[3].replace(/\\(.)/g, '$1'), landmark: m[4] };
}

export const fingerprintKey = (fp) => fingerprintText(fp).replace(/\d+/g, '#').replace(/\s+/g, ' ');

export const fingerprintId = (fp) => `st-${crypto.createHash('sha1').update(`fp|${fingerprintKey(fp)}`).digest('hex').slice(0, 8)}`;

export function tourKind(problem) {
  const p = String(problem);
  if (p.includes(' does not close on Escape')) return 'stuck';
  if (p.includes(' covered at ')) return 'covered';
  return 'clipped';
}

export const checkFingerprint = (f) => (f?.fp ? { check: f.check, ...f.fp } : null);

export function tourFingerprint(record, problem) {
  for (const o of record?.tour?.opened ?? []) {
    if (!o?.fp) continue;
    const mine = [...(o.clipped ?? []), ...(o.covered ?? [])].includes(problem) || (o.stuck && `${o.control} does not close on Escape` === problem);
    if (mine) return { check: `tour:${tourKind(problem)}`, ...o.fp };
  }
  return null;
}
