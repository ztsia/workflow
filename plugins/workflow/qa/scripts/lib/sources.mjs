// Which source files each screen runs (decision 15): V8 coverage collected while a full run walks
// the head, mapped back to source files through the built bundle's source maps, and stored beside
// the map as qa/map/<area>.sources.json. affected.mjs reads it. Works for any bundled web app that
// ships source maps; a build without them gives no sources (every screen then counts as affected).
// A screen's own `sources: [glob]` in the map always wins over the recorded list.
//
// CONTRACT (tests: test/sources.test.mjs — decodeMappings/coveredSources on hand-made maps; one test
// with a real headless browser on a node:http server serving a bundle + its .map)
//
//   decodeMappings(mappings) -> [[genCol, srcIdx, srcLine, srcCol] …][]   per generated line (0-based),
//     the segments of a source map v3 `mappings` string (base64 VLQ, fields relative as the spec
//     says; a 1-field segment is [genCol] only). Pure.
//
//   coveredSources({ source, map, ranges }) -> [source path]
//     source: the script text; map: the parsed source map; ranges: [{ start, end }] covered byte
//     (UTF-16 offset) ranges. Converts each mapping segment's (genLine, genCol) to an offset in
//     source (line starts from source's '\n's) and collects map.sources[srcIdx] for segments whose
//     offset falls inside a range. Paths: (map.sourceRoot ?? '') + source, then any 'webpack://',
//     '/@fs' or leading '../' and './' runs stripped. Sorted, unique. Pure.
//
//   coveredRanges(entry) -> [{ start, end }]   from one Playwright JS coverage entry
//     ({ url, source, functions: [{ functionName, ranges: [{ startOffset, endOffset, count }] }] }):
//     every function whose ranges[0].count > 0 EXCEPT the script's top-level one (functionName ''
//     and ranges[0].startOffset 0 and ranges[0].endOffset === source.length — module scope runs
//     for every module in a bundle and would mark them all), as ranges[0] minus its nested ranges
//     with count 0. Pure.
//
//   repoFile(p, { exists }) -> string | null   a covered source path as a repo-relative file:
//     null when it contains 'node_modules/' or starts with '\0' or 'vite/' or is virtual ('virtual:',
//     'commonjs-'); else the path itself when exists(path) is true, else null.
//
//   screenSources(entries, { origin, fetchText, exists }) -> Promise<[file]>
//     entries: Playwright coverage entries of one screen. Only entries whose url starts with origin.
//     Per entry: the last '//# sourceMappingURL=<u>' in source; none -> skipped; u resolved against
//     entry.url; a data: URL decoded (base64 JSON) else fetchText(url) parsed as JSON (a failure ->
//     skipped). coveredSources(…coveredRanges(entry)) -> repoFile each -> sorted unique union.
//
//   startCoverage(page) / stopCoverage(page) -> Promise<entries>
//     page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false }) /
//     page.coverage.stopJSCoverage(). (Chromium only; another browser -> start resolves, stop -> [].)
//
//   readSources(mapDir) -> { screenName: [file] }   every <mapDir>/*.sources.json's `screens`,
//     merged in name order (a later file wins on the same screen). Missing dir or bad JSON file ->
//     that file skipped.
//
//   writeSources(mapDir, { area, screens, sha }) -> file path
//     <mapDir>/<area>.sources.json = { "$comment": "written by qa run --full: the source files
//     each screen ran; affected runs read it. Regenerated, never edited.", "sha": sha,
//     "screens": { …existing screens of that file, …screens } } with keys sorted, 2-space JSON and
//     a trailing newline. Returns the path.
//
// Example. A bundle 'app.js' whose map has sources ['../src/a.ts', '../src/b.ts'] and whose
// covered function lies wholly in code mapped from src/b.ts -> coveredSources gives ['src/b.ts'].

import fs from 'node:fs';
import path from 'node:path';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = Object.fromEntries([...B64].map((c, i) => [c, i]));

// Source map v3 `mappings`: lines split by ';', segments by ',', each segment a run of base64 VLQ numbers
// (5 data bits per digit, bit 5 = continuation, bit 0 of the value = sign). The generated column restarts
// on every line; source index, source line and source column carry over across the whole string.
export function decodeMappings(mappings) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineText of String(mappings ?? '').split(';')) {
    const segments = [];
    let genCol = 0;
    for (const segText of lineText.split(',')) {
      if (segText === '') continue;
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const ch of segText) {
        const digit = B64_INDEX[ch];
        if (digit === undefined) throw new Error(`invalid VLQ character "${ch}"`);
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value % 2 === 1 ? -(value - 1) / 2 : value / 2);
        value = 0;
        shift = 0;
      }
      genCol += fields[0];
      if (fields.length < 4) {
        segments.push([genCol]);
        continue;
      }
      srcIdx += fields[1];
      srcLine += fields[2];
      srcCol += fields[3];
      segments.push([genCol, srcIdx, srcLine, srcCol]);
    }
    lines.push(segments);
  }
  return lines;
}

function normalizeSource(p) {
  let out = p;
  for (;;) {
    const next = out.replace(/^webpack:\/\//, '').replace(/^\/@fs/, '').replace(/^(?:\.\.?\/)+/, '');
    if (next === out) return out;
    out = next;
  }
}

export function coveredSources({ source, map, ranges }) {
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const found = new Set();
  for (const [line, segments] of decodeMappings(map.mappings).entries()) {
    if (line >= lineStarts.length) break;
    for (const seg of segments) {
      if (seg.length < 4) continue;
      const offset = lineStarts[line] + seg[0];
      if (!ranges.some((r) => offset >= r.start && offset < r.end)) continue;
      const name = map.sources?.[seg[1]];
      if (typeof name === 'string') found.add(normalizeSource((map.sourceRoot ?? '') + name));
    }
  }
  return [...found].sort();
}

export function coveredRanges(entry) {
  const out = [];
  for (const fn of entry.functions ?? []) {
    const [first, ...nested] = fn.ranges ?? [];
    if (!first || first.count <= 0) continue;
    if (fn.functionName === '' && first.startOffset === 0 && first.endOffset === entry.source?.length) continue;
    const holes = nested.filter((r) => r.count === 0).sort((a, b) => a.startOffset - b.startOffset);
    let at = first.startOffset;
    for (const hole of holes) {
      if (hole.startOffset > at) out.push({ start: at, end: Math.min(hole.startOffset, first.endOffset) });
      at = Math.max(at, hole.endOffset);
    }
    if (at < first.endOffset) out.push({ start: at, end: first.endOffset });
  }
  return out;
}

export function repoFile(p, { exists }) {
  if (p.includes('node_modules/') || p.startsWith('\0') || p.startsWith('vite/')) return null;
  if (p.startsWith('virtual:') || p.startsWith('commonjs-')) return null;
  return exists(p) ? p : null;
}

function inlineMap(url) {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  const data = url.slice(comma + 1);
  return head.split(';').includes('base64') ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
}

export async function screenSources(entries, { origin, fetchText, exists }) {
  const files = new Set();
  for (const entry of entries ?? []) {
    if (typeof entry.url !== 'string' || !entry.url.startsWith(origin)) continue;
    const markers = [...String(entry.source ?? '').matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)];
    if (markers.length === 0) continue;
    let map;
    try {
      const ref = markers[markers.length - 1][1];
      map = JSON.parse(ref.startsWith('data:') ? inlineMap(ref) : await fetchText(new URL(ref, entry.url).href));
    } catch {
      continue;
    }
    if (map === null || typeof map !== 'object') continue;
    for (const p of coveredSources({ source: entry.source, map, ranges: coveredRanges(entry) })) {
      const file = repoFile(p, { exists });
      if (file !== null) files.add(file);
    }
  }
  return [...files].sort();
}

export async function startCoverage(page) {
  await page.coverage?.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
}

export async function stopCoverage(page) {
  return (await page.coverage?.stopJSCoverage()) ?? [];
}

function readScreens(file) {
  try {
    const screens = JSON.parse(fs.readFileSync(file, 'utf8'))?.screens;
    return screens !== null && typeof screens === 'object' && !Array.isArray(screens) ? screens : null;
  } catch {
    return null;
  }
}

export function readSources(mapDir) {
  let names;
  try {
    names = fs.readdirSync(mapDir).filter((n) => n.endsWith('.sources.json')).sort();
  } catch {
    return {};
  }
  const out = {};
  for (const name of names) Object.assign(out, readScreens(path.join(mapDir, name)) ?? {});
  return out;
}

export function writeSources(mapDir, { area, screens, sha }) {
  const file = path.join(mapDir, `${area}.sources.json`);
  const merged = { ...(readScreens(file) ?? {}), ...screens };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  const doc = {
    $comment: 'written by qa run --full: the source files each screen ran; affected runs read it. Regenerated, never edited.',
    sha,
    screens: sorted,
  };
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}
