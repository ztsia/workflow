// Docs evidence (0.6.0): a criterion that the docs say something ("docs list the new kinds") is checked by script
// against the files of the head commit, so it is never left UNVERIFIABLE because the judge may not read the docs.
// Deterministic, zero model calls, no sandbox: the texts are read from git at the head and base commits, never from
// the checkout.
//
// CONTRACT (tests: test/docs.test.mjs — checkDocs with an injected reader; runQa 'docs' with a real git repo)
//
//   A doc expectation is an expectations.json entry with a `doc` key (the verifier's plan writes it):
//     { name, doc: { file, contains }, criterion? }
//     file      a path relative to the repo root ('/'-separated; no leading '/', no '..').
//     contains  a text, '/re/flags', or a non-empty list of them: every one must be in the file. A plain text
//               matches the file as written or with every run of whitespace made one space (a wrapped line
//               still matches); '/re/flags' is a regex over the file as written.
//     criterion the charter or acceptance-criterion id it proves; shown first in the detail.
//
//   docEntries(list) -> the entries of list that have a `doc` key (list not an array -> []).
//   docProblem(entry) -> string | null   'no name' | 'doc must be { file, contains }' | 'doc.file missing' |
//     'doc.file must be relative to the repo root' | 'doc.contains missing' | 'doc.contains: <regex error>'.
//   checkDocs({ entries, head, base = null, read }) -> [DocRecord]
//     read(sha, file) -> the file's text at that commit, or null when it is not there.
//     One record per entry, in order:
//       a problem                 -> unverifiable 'not run: <problem>'
//       file at head, all found   -> met '<n> of <n> text(s) found at head <head 12>'
//       file at head, some absent -> NOT MET 'missing at head <head 12>: "<first missing>"[ (+<k> more)]'
//       file not at head, at base -> NOT MET '<file> is gone at head (it is on base)'
//       in neither                -> unverifiable '<file> is in neither head <12> nor base <12>: check the path'
//     A met or NOT MET record whose file is at base gains ' · base: <k> of <n> already there' (k = texts the
//     base file holds; 'none of them there (new with this PR)' when k is 0); file not at base: ' · base: no such
//     file (new with this PR)'. base null: no base note. The note never changes the result.
//     DocRecord = { id: 'exp:<name>', name, criterion, file, contains: [text], result, why, detail, head, base,
//                   found: [text], missing: [text] }
//     detail = '[<criterion> · ]doc <file>: <why>'.
//   docExpectations(records) -> [{ name, result, detail }]   what buildResults appends to expectations.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const short = (sha) => (sha ? String(sha).slice(0, 12) : 'none');

export function docEntries(list) {
  return Array.isArray(list) ? list.filter((e) => isObject(e) && e.doc !== undefined) : [];
}

function regexOf(text) {
  const s = String(text);
  const slash = s.lastIndexOf('/');
  if (s.startsWith('/') && slash > 0) return new RegExp(s.slice(1, slash), s.slice(slash + 1));
  return null;
}

const containsOf = (doc) => (Array.isArray(doc?.contains) ? doc.contains : doc?.contains === undefined ? [] : [doc.contains]);

export function docProblem(entry) {
  if (!isText(entry?.name)) return 'no name';
  const d = entry.doc;
  if (!isObject(d)) return 'doc must be { file, contains }';
  if (!isText(d.file)) return 'doc.file missing';
  if (d.file.startsWith('/') || /^[A-Za-z]:/.test(d.file) || d.file.split(/[\\/]/).includes('..')) return 'doc.file must be relative to the repo root';
  const list = containsOf(d);
  if (!list.length || !list.every(isText)) return 'doc.contains missing';
  for (const t of list) {
    try {
      regexOf(t);
    } catch (error) {
      return `doc.contains: ${error.message}`;
    }
  }
  return null;
}

const squash = (s) => String(s).replace(/\s+/g, ' ');

// Whether a file's text holds one wanted text (see the contract).
function holds(text, want) {
  const re = regexOf(want);
  if (re) {
    re.lastIndex = 0;
    return re.test(text);
  }
  return text.includes(want) || squash(text).includes(squash(want).trim());
}

export function checkDocs({ entries = [], head, base = null, read } = {}) {
  return entries.map((entry) => {
    const name = isText(entry?.name) ? entry.name : JSON.stringify(entry);
    const file = isObject(entry?.doc) && typeof entry.doc.file === 'string' ? entry.doc.file.replace(/^\.\//, '') : null;
    const contains = isObject(entry?.doc) ? containsOf(entry.doc).map(String) : [];
    const record = {
      id: `exp:${name}`, name, criterion: entry?.criterion ?? null, file, contains, result: 'unverifiable', why: '', detail: '',
      head: head ?? null, base: base ?? null, found: [], missing: [],
    };
    const finish = (result, why) => {
      const lead = record.criterion ? `${record.criterion} · ` : '';
      Object.assign(record, { result, why, detail: `${lead}doc ${file ?? '?'}: ${why}`.replace(/\s*\n\s*/g, ' ') });
      return record;
    };
    const problem = docProblem(entry);
    if (problem) return finish('unverifiable', `not run: ${problem}`);
    const atHead = read(head, file);
    const atBase = base ? read(base, file) : null;
    const baseNote = () => {
      if (!base) return '';
      if (atBase === null) return ' · base: no such file (new with this PR)';
      const k = contains.filter((t) => holds(atBase, t)).length;
      return k ? ` · base: ${k} of ${contains.length} already there` : ' · base: none of them there (new with this PR)';
    };
    if (atHead === null) {
      if (atBase !== null) return finish('NOT MET', `${file} is gone at head (it is on base)`);
      return finish('unverifiable', `${file} is in neither head ${short(head)} nor base ${short(base)}: check the path`);
    }
    record.found = contains.filter((t) => holds(atHead, t));
    record.missing = contains.filter((t) => !holds(atHead, t));
    if (record.missing.length) {
      const more = record.missing.length > 1 ? ` (+${record.missing.length - 1} more)` : '';
      return finish('NOT MET', `missing at head ${short(head)}: "${record.missing[0]}"${more}${baseNote()}`);
    }
    return finish('met', `${contains.length} of ${contains.length} text(s) found at head ${short(head)}${baseNote()}`);
  });
}

export function docExpectations(records) {
  return (records ?? []).map((r) => ({ name: r.name, result: r.result, detail: r.detail }));
}
