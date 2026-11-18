// Metrics (decisions 3, 7): what each screen cost a person (time) and a phone (bytes, CPU, memory),
// on head and on base, judged against human limits and against the base, plus the server's own share from Server-Timing. Every number is what a person waits or a
// phone pays, never a cause. A flag never fails a run on its own: the judge answers each one.
//
// CONTRACT (tests: test/metrics.test.mjs — pure functions; collectMetrics against a real headless
// page on a node:http fixture server, like test/capture.test.mjs)
//
//   METRICS (exported, frozen) name -> { unit, human?, says }:
//     'screen.readyMs'    ms     human 1000         'opened until ready (network quiet, nothing changing)'
//     'screen.bytes'      bytes  human 1_500_000    'bytes over the network to open it'
//     'screen.requests'   count                     'requests to open it'
//     'screen.longTaskMs' ms     human 200          'main thread blocked past 50 ms per task'
//     'screen.heapBytes'  bytes  human 100_000_000  'JS heap once ready'
//     'server.appMs'      ms     human 1000         'server time over the requests that opened it (Server-Timing app)'
//     'server.dbMs'       ms                        'database time over those requests (Server-Timing db)'
//     'server.queries'    count                     'database queries over those requests (Server-Timing db-queries)'
//   WORSE = 1.25; FLOOR = { ms: 100, bytes: 20_000, count: 3 }
//   limitsFor(overrides = {}) -> { name: number | null }   defaults' human (null when none); an
//     override number replaces it; an override null drops it. Unknown override names are ignored.
//   judge(metric, head, base, limits = limitsFor()) -> { kind: 'ok'|'over'|'worse'|'standing', limit?, base? }
//     human = limits[metric] ?? null; unit = METRICS[metric].unit;
//     worse(head, base) = head > base * WORSE && head - base > FLOOR[unit].
//     head > human: base given, base > human and !worse -> { kind: 'standing', limit, base };
//                   else { kind: 'over', limit: human }
//     else base given and worse -> { kind: 'worse', base }; else { kind: 'ok' }.
//     base undefined or null = no base number.
//
//   flatten(m) -> { name: number }   a record's metrics object (below) to METRICS names:
//     readyMs -> screen.readyMs, bytes, requests, longTaskMs, heapBytes likewise; server.appMs ->
//     server.appMs, server.dbMs, server.queries; null or non-finite values are left out.
//
//   compareMetrics(before, after, limits) -> { flags: [{ metric, kind, head, base, limit }], standing: n } | null
//     before/after: record.metrics objects (null when either record has none -> null). Every
//     METRICS name present in after: judge(name, after, before value). kind 'over'|'worse' -> a
//     flag (limit null for worse; base null when before lacks it); 'standing' -> counted. Flags in
//     METRICS order.
//
//   collectMetrics(page) -> Promise<{ start(): void, read(): Promise<Metrics> }>   (capture.mjs uses it)
//     Installs once per page, before any navigation: an init script with a PerformanceObserver for
//     'longtask' (buffered) summing max(0, duration - 50) into window.__mfqaLong (reset on each
//     document); page.on('response') counting requests and bytes (Number(content-length) when the
//     header is there, else 0 — no body reads) and, for each response with a server-timing header,
//     adding parseServerTiming's app, db and db-queries (routes.mjs) into running sums.
//     start() zeroes the counters and stamps t0 = Date.now() (capture calls it right before the
//     screen's last goto, reload, back or forward step, or at the screen's first step when it has
//     none of those). read() -> Metrics = { readyMs: Date.now() - t0 (capture calls it right after
//     settle, before the snapshot), bytes, requests, longTaskMs: window.__mfqaLong (0 when the
//     observer is unsupported), heapBytes: performance.memory?.usedJSHeapSize ?? null,
//     server: { appMs, dbMs, queries } when any response carried server-timing, else null }.
//     Numbers rounded to integers (ms) / whole bytes.
//
//   metricsLine(flag) -> string   the text summary.md and the draft use after '- [<id>] ':
//     over:  '<metric> <head><u> over <limit><u>[ (base <base><u>)]'
//     worse: '<metric> <head><u> vs base <base><u> (+<pct>%)'      pct = round((head/base - 1) * 100);
//            base 0 -> '(from none)' in place of the percentage
//     <u>: ms -> ' ms'; bytes -> ' KB' with head/base/limit shown as round(n / 1000); count -> ''.
//
// Example: judge('screen.readyMs', 1800, 900) -> { kind: 'over', limit: 1000 };
// judge('screen.readyMs', 1800, 1500) -> { kind: 'standing', limit: 1000, base: 1500 };
// judge('server.queries', 40, 4) -> { kind: 'worse', base: 4 } (an N+1 you can see);
// metricsLine({ metric: 'screen.bytes', kind: 'over', head: 2_400_000, base: 900_000, limit: 1_500_000 })
//   -> 'screen.bytes 2400 KB over 1500 KB (base 900 KB)'.

export const METRICS = Object.freeze({
  'screen.readyMs': { unit: 'ms', human: 1000, says: 'opened until ready (network quiet, nothing changing)' },
  'screen.bytes': { unit: 'bytes', human: 1_500_000, says: 'bytes over the network to open it' },
  'screen.requests': { unit: 'count', says: 'requests to open it' },
  'screen.longTaskMs': { unit: 'ms', human: 200, says: 'main thread blocked past 50 ms per task' },
  'screen.heapBytes': { unit: 'bytes', human: 100_000_000, says: 'JS heap once ready' },
  'server.appMs': { unit: 'ms', human: 1000, says: 'server time over the requests that opened it (Server-Timing app)' },
  'server.dbMs': { unit: 'ms', says: 'database time over those requests (Server-Timing db)' },
  'server.queries': { unit: 'count', says: 'database queries over those requests (Server-Timing db-queries)' },
});
export const WORSE = 1.25;
export const FLOOR = Object.freeze({ ms: 100, bytes: 20_000, count: 3 });

// The limits in force: the defaults with the overrides (a null drops a human limit).
export function limitsFor(overrides = {}) {
  const out = {};
  for (const [name, m] of Object.entries(METRICS)) {
    const o = overrides?.[name];
    out[name] = o === null ? null : Number.isFinite(o) ? o : (m.human ?? null);
  }
  return out;
}

const worse = (unit, head, base) => head > base * WORSE && head - base > FLOOR[unit];
const hasBase = (base) => base !== undefined && base !== null;

// One number on the branch against its human limit and the base's number, if the base has one.
export function judge(metric, head, base, limits = limitsFor()) {
  const human = limits[metric] ?? null;
  const unit = METRICS[metric].unit;
  if (human !== null && head > human) {
    if (hasBase(base) && base > human && !worse(unit, head, base)) return { kind: 'standing', limit: human, base };
    return { kind: 'over', limit: human };
  }
  if (hasBase(base) && worse(unit, head, base)) return { kind: 'worse', base };
  return { kind: 'ok' };
}

// A record's metrics object -> { 'screen.readyMs': n, ... }, leaving out what is null or not finite.
export function flatten(m) {
  const out = {};
  if (!m) return out;
  const put = (name, value) => {
    if (Number.isFinite(value)) out[name] = value;
  };
  put('screen.readyMs', m.readyMs);
  put('screen.bytes', m.bytes);
  put('screen.requests', m.requests);
  put('screen.longTaskMs', m.longTaskMs);
  put('screen.heapBytes', m.heapBytes);
  put('server.appMs', m.server?.appMs);
  put('server.dbMs', m.server?.dbMs);
  put('server.queries', m.server?.queries);
  return out;
}

export function compareMetrics(before, after, limits = limitsFor()) {
  if (!before || !after) return null;
  const head = flatten(after);
  const base = flatten(before);
  const flags = [];
  let standing = 0;
  for (const metric of Object.keys(METRICS)) {
    if (!(metric in head)) continue;
    const j = judge(metric, head[metric], base[metric], limits);
    if (j.kind === 'standing') standing += 1;
    else if (j.kind === 'over' || j.kind === 'worse') {
      flags.push({ metric, kind: j.kind, head: head[metric], base: base[metric] ?? null, limit: j.limit ?? null });
    }
  }
  return { flags, standing };
}

// 'app;dur=12.5, db;dur=3' -> { app: 12.5, db: 3 } (a private copy of routes.mjs parseServerTiming).
function parseServerTiming(header) {
  const out = {};
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    const dur = params.map((p) => /^dur=(.+)$/.exec(p)?.[1]).find((d) => d !== undefined);
    if (name && Number.isFinite(Number(dur)) && dur !== '') out[name] = Number(dur);
  }
  return out;
}

const LONG_TASK_INIT = () => {
  window.__mfqaLong = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__mfqaLong += Math.max(0, e.duration - 50);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* longtask unsupported */
  }
};

export async function collectMetrics(page) {
  await page.addInitScript(LONG_TASK_INIT);
  let t0 = Date.now();
  let requests = 0;
  let bytes = 0;
  let seen = false;
  const server = { appMs: 0, dbMs: 0, queries: 0 };
  page.on('response', (response) => {
    requests += 1;
    let headers = {};
    try {
      headers = response.headers();
    } catch {
      return;
    }
    bytes += Number(headers['content-length']) || 0;
    if (headers['server-timing']) {
      const t = parseServerTiming(headers['server-timing']);
      seen = true;
      server.appMs += t.app ?? 0;
      server.dbMs += t.db ?? 0;
      server.queries += t['db-queries'] ?? 0;
    }
  });
  return {
    start() {
      requests = 0;
      bytes = 0;
      seen = false;
      server.appMs = 0;
      server.dbMs = 0;
      server.queries = 0;
      t0 = Date.now();
      page.evaluate(() => { window.__mfqaLong = 0; }).catch(() => {});
    },
    async read() {
      const readyMs = Date.now() - t0;
      const page_ = await page
        .evaluate(() => ({ long: window.__mfqaLong ?? 0, heap: performance.memory?.usedJSHeapSize ?? null }))
        .catch(() => ({ long: 0, heap: null }));
      return {
        readyMs: Math.round(readyMs),
        bytes: Math.round(bytes),
        requests,
        longTaskMs: Math.round(page_.long),
        heapBytes: page_.heap === null ? null : Math.round(page_.heap),
        server: seen ? { appMs: Math.round(server.appMs), dbMs: Math.round(server.dbMs), queries: Math.round(server.queries) } : null,
      };
    },
  };
}

export function metricsLine(flag) {
  const unit = METRICS[flag.metric].unit;
  const show = (n) => (unit === 'bytes' ? `${Math.round(n / 1000)} KB` : unit === 'ms' ? `${n} ms` : `${n}`);
  if (flag.kind === 'worse') {
    const grew = flag.base > 0 ? `+${Math.round((flag.head / flag.base - 1) * 100)}%` : 'from none';
    return `${flag.metric} ${show(flag.head)} vs base ${show(flag.base)} (${grew})`;
  }
  const base = flag.base === null || flag.base === undefined ? '' : ` (base ${show(flag.base)})`;
  return `${flag.metric} ${show(flag.head)} over ${show(flag.limit)}${base}`;
}
