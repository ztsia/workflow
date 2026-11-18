// An overlay folder: QA files kept apart from the branch's own qa/ (its screen-map entries, its route rows and PAGES
// rows, the data its screens need). A run that is given one (profile.overlay) reads qa/ with it on top. The qa CLI
// itself sets none: a branch's overlay is its own qa/ (qa/map/, qa/routes.table.*, qa/seed.json, sad paths in
// qa/map/verify-<slug>.json). Zero model calls; every rule is general.
//
// CONTRACT (tests: test/scope.test.mjs 'overlay')
//
//   Layout of an overlay folder <dir>:
//     <dir>/map/*.json        map files in the shared map's format, holding ONLY the entries added or changed
//                             (and the flows they need that are new or changed); *.sources.json are skipped as in map/
//     <dir>/routes.json       { "routes": [row], "pages": [page] } (or a bare array of rows): rows for every route
//                             added or changed, PAGES rows for every page added (routes.mjs row and page shapes)
//     <dir>/seed-needs.md     the data the screens need that the seed does not make (a builder writes the seed)
//
//   routesFile(abs) -> { routes: [row], pages: [page], errors: [string] }   the JSON side/overlay file: a bare array is
//     rows; an object gives routes and pages (each missing -> []); a missing file -> all empty; bad JSON or a wrong
//     shape -> errors ['<basename>: <message>'] and nothing else.
//   mergeBy(list, extra, keyOf) -> list   extra replaces the entry of list with the same key (in place), the rest of
//     extra is appended in its order; neither input is changed.
//   seedNeeds(dir) -> string | null   the text of <dir>/seed-needs.md, trimmed; null when missing or empty.
//
//   map.mjs loadMap merges <profile.overlay>/map when profile.overlay is set (see its OVERLAY note); routes.mjs
//   loadRouteTable / loadPages merge <profile.overlay>/routes.json. profile.overlay is set only by a caller of the
//   library, never written in qa.json.

import fs from 'node:fs';
import path from 'node:path';

export const OVERLAY_ROUTES = 'routes.json';
export const OVERLAY_SEED_NEEDS = 'seed-needs.md';

export function routesFile(abs) {
  const empty = { routes: [], pages: [], errors: [] };
  if (!abs || !fs.existsSync(abs)) return empty;
  const name = path.basename(abs);
  try {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (Array.isArray(data)) return { routes: data, pages: [], errors: [] };
    if (data === null || typeof data !== 'object') throw new Error('expected an array of rows or { "routes": [rows], "pages": [pages] }');
    const routes = data.routes ?? [];
    const pages = data.pages ?? [];
    if (!Array.isArray(routes) || !Array.isArray(pages)) throw new Error('"routes" and "pages" must be arrays');
    return { routes, pages, errors: [] };
  } catch (e) {
    return { ...empty, errors: [`${name}: ${e.message}`] };
  }
}

export function mergeBy(list, extra, keyOf) {
  const out = [...list];
  const at = new Map();
  out.forEach((item, i) => {
    const k = keyOf(item);
    if (k !== null && k !== undefined && !at.has(k)) at.set(k, i);
  });
  for (const item of extra) {
    const k = keyOf(item);
    if (k !== null && k !== undefined && at.has(k)) out[at.get(k)] = item;
    else {
      if (k !== null && k !== undefined) at.set(k, out.length);
      out.push(item);
    }
  }
  return out;
}

export function seedNeeds(dir) {
  if (!dir) return null;
  try {
    const text = fs.readFileSync(path.join(dir, OVERLAY_SEED_NEEDS), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}
