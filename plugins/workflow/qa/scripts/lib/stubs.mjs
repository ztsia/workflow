// Stubs (rework, design §6.1 rung 3): the real path with a deterministic stand-in for what varies — a model's answer, a
// payment provider, the clock — declared in qa.json `stubs` as env switches the sandbox sets on its stack verbs. The
// planner names the stubs a plan needs on the charter's `stubs:` line, and only stubs qa.json declares; the prepare
// check, the plan check and the run read that line from V/charter.md and bring their sandboxes up with them (base and
// head alike: the same seed, the same clock, the same stand-ins). Secrets never go in qa.json: profile.mjs refuses an
// env name that looks like one. Zero model calls; nothing names an app (D39).
//
// CONTRACT (tests: test/stubs.test.mjs)
//
//   qa.json: "stubs": { "<id>": { "for": "<what it stands in for>", "env": { "<ENV NAME>": "<switch value>" } } }
//     (schema/qa.schema.json; profile.mjs rule c; default {}).
//
//   The charter (V/charter.md, written by the verifier's plan phase) names them on one line under `security:`:
//     stubs: <id>[, <id>…] — <why>          ('stubs: none', or no line, when no row is on rung 3)
//   and each rung-3 row says which: `rung 3: stub <id> makes … fixed`.
//
//   charterStubs(text) -> [id]   the ids of the first line that starts 'stubs:' (the text before ' — ', split on
//     commas and spaces), each once, in order; 'none', no line or no text -> [].
//   resolveStubs(profile, ids) -> { ids: [declared, sorted, each once], unknown: [id not in profile.stubs, in order],
//     env: { NAME: value …, QA_STUBS: 'a,b' } ({} when no declared id), conflicts: [NAME two declared stubs set to
//     different values] }   the later id (sorted order) wins a conflict.
//   sameStubs(a, b) -> boolean   the same ids, order ignored (null/undefined = []).
//   withCharterStubs(text, ids) -> text   the charter with its 'stubs:' line naming only `ids` ('stubs: none' when
//     empty), what followed ' — ' kept; no such line -> the text unchanged.

const STUB_LINE = /^stubs:[ \t]*(.*)$/m;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function charterStubs(text) {
  const m = STUB_LINE.exec(String(text ?? ''));
  if (!m) return [];
  const list = m[1].split(' — ')[0].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 1 && list[0].toLowerCase() === 'none') return [];
  return [...new Set(list)];
}

export function resolveStubs(profile, ids = []) {
  const declared = isObject(profile?.stubs) ? profile.stubs : {};
  const wanted = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id))];
  const known = wanted.filter((id) => Object.hasOwn(declared, id) && isObject(declared[id])).sort();
  const unknown = wanted.filter((id) => !known.includes(id));
  const env = {};
  const conflicts = [];
  for (const id of known) {
    for (const [name, value] of Object.entries(isObject(declared[id].env) ? declared[id].env : {})) {
      if (Object.hasOwn(env, name) && env[name] !== String(value) && !conflicts.includes(name)) conflicts.push(name);
      env[name] = String(value);
    }
  }
  if (known.length) env.QA_STUBS = known.join(',');
  return { ids: known, unknown, env, conflicts };
}

export function sameStubs(a, b) {
  const x = [...new Set(a ?? [])].sort();
  const y = [...new Set(b ?? [])].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

export function withCharterStubs(text, ids) {
  const src = String(text ?? '');
  const m = STUB_LINE.exec(src);
  if (!m) return src;
  const rest = m[1].includes(' — ') ? ` — ${m[1].split(' — ').slice(1).join(' — ')}` : '';
  const line = `stubs: ${ids.length ? ids.join(', ') : 'none'}${rest}`;
  return src.slice(0, m.index) + line + src.slice(m.index + m[0].length);
}
