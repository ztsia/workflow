// Rework U9 (design §12): where a verification's report goes and how to see it. publish.mjs (the publish set, the
// local/cloud and account decision, the Report line, the PR comment) and the CLI that drives it: `qa report build`
// (publish.json and the artifact pages), `report where`, `report url`, `report line`, `report comment`. Every CLI test
// runs in its own temp git repo with a throwaway HOME and no QA_* / CLAUDE_CODE_REMOTE from the shell;
// `gh` is a fake that records its calls (never a real comment), and nothing is ever published.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { buildResults } from '../scripts/lib/summary.mjs';
import { parseVerdict, parseReportLine } from '../scripts/lib/verdict.mjs';
import { validateVerdict } from '../scripts/lib/report.mjs';
import {
  COMMENT_MARKER, LIMITS, commentBody, decideReport, launchAccount, linkPart, localLine, mediaItems, notPublishedLine, packParts,
  placeOf, publishedShots, recordUrl, sessionAccount, urlLine, whereAmI, withReportLine,
} from '../scripts/lib/publish.mjs';
import { exampleRun } from './fixtures/run-example.mjs';

const CLI = fileURLToPath(new URL('../scripts/qa.mjs', import.meta.url));
const SLUG = 'feat-x';
const SHA = 'a'.repeat(40);
const DETAIL = 'scr:desktop/detail__default';
const LIST = 'scr:desktop/list__default';
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const tmp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const read = (file) => fs.readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(read(file));

// ── fixtures ──────────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=qa test', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = tmp('mfqa-publish-');
  git(['init', '-q'], dir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
  write(path.join(dir, 'qa.json'), '{}\n');
  write(path.join(dir, 'src', 'detail', 'Detail.tsx'), 'export const a = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'one'], dir);
  return { dir, sha: git(['rev-parse', 'HEAD'], dir), home: tmp('mfqa-home-') };
}

// The step 5 example verdict, plus a Minor finding on a screen that did NOT change (list__default is 'same').
function verdictMd(sha, { extra = '', outcome = 'REJECT' } = {}) {
  return `# ${outcome} — feat-x
head: ${sha}
base: ${'b'.repeat(40)}
maps: cccccccccccc
criteria: 2 pass · 0 fail · 0 unverifiable

## Criteria
- [exp:title-renamed] PASS — title-renamed: 1 element(s): 1 right
- [ch:1] PASS — archive is offered: the Archive button appears for an open record

## Expectations
- [unx:desktop/detail__default/1] explained — the spec adds an Archive button to the detail header

## Findings
- Major [tour:desktop/detail__default/1] new: listbox "Status" 200×240 cut off by div.card — files: src/detail/StatusSelect.tsx
- Major [chk:desktop/detail__default/1] contrast: span.muted contrast 2.8:1 (#999999 on #ffffff), needs 4.5:1 — files: src/detail/Detail.css
- Major [con:desktop/detail__default/1] console: TypeError: x is undefined — files: src/detail/Detail.tsx
- Minor [scr:desktop/detail__default] the Archive button sits under the fold on a short window
- Minor [scr:desktop/list__default] the list header wraps on a short window

## Spec cases
- none (the runner ran data only)

## Gaps
- none

## Standing
- 2 standing item(s), never gating — qa/standing.md

## Notes
- lived-in: not run in this step

cost: plan $0.41 · eyes $0.62 · judge $0.18 · runner 0 · total $1.21
${extra}`;
}

const CHARTER_MD = '# Charter — feat-x\nsecurity: no — nothing sensitive\n\n- [ch:1] archive is offered on an open record — axis: happy path — by: spec\n';
const EYES_MD = `# Eyes — feat-x\n\n## [${DETAIL}] detail\nFirst look: the title.\nVerdict: look again — the Archive button sits under the fold on a short window\n`;

// A valid run under V with screenshots in <repo>/run: detail (changed, in eyes) and list (same) on both sides.
function writeRun(repo, { videos = [], verdict = verdictMd(repo.sha) } = {}) {
  const V = path.join(repo.dir, 'qa', SLUG);
  const results = buildResults(exampleRun());
  results.head.sha = repo.sha;
  results.report = path.join(repo.dir, 'run', 'compare', 'index.html');
  results.videos = videos;
  write(path.join(V, 'results.json'), JSON.stringify(results, null, 2));
  write(path.join(V, 'verdict.md'), verdict);
  write(path.join(V, 'eyes.md'), EYES_MD);
  write(path.join(V, 'charter.md'), CHARTER_MD);
  write(path.join(V, 'summary.md'), '# qa run — feat-x: findings (exit 1)\n');
  write(path.join(V, 'run.json'), '{}\n');
  const run = path.join(repo.dir, 'run');
  write(path.join(run, 'head', 'desktop', 'detail__default.png'), 'H'.repeat(1000));
  write(path.join(run, 'base', 'desktop', 'detail__default.png'), 'B'.repeat(700));
  write(path.join(run, 'head', 'desktop', 'list__default.png'), 'h'.repeat(300));
  write(path.join(run, 'base', 'desktop', 'list__default.png'), 'b'.repeat(300));
  return V;
}

// The CLI with nothing of the developer's shell: a throwaway HOME, and no QA_* or CLAUDE_CODE_REMOTE.
function cli(repo, args, extra = {}, input = undefined) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('QA_') && k !== 'CLAUDE_CODE_REMOTE') env[k] = v;
  Object.assign(env, { HOME: repo.home, USERPROFILE: repo.home }, extra);
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, env, encoding: 'utf8', timeout: 60000, input });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const lastLine = (text) => text.trimEnd().split('\n').pop();
// Every local file a page points at (src= and href=, not a URL, a hash or data:).
const localRefs = (html) => [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|#|data:|mailto:)/.test(u));

// ── the publish set (pure) ────────────────────────────────────────────────────

describe('publish set', () => {
  it('publishedShots keeps only new and changed screens (new, changed, gone, a pixel change, or one eyes looked at)', () => {
    const results = {
      eyes: ['scr:desktop/e'],
      screens: [
        { id: 'scr:desktop/n', status: 'new' }, { id: 'scr:desktop/c', status: 'changed' }, { id: 'scr:desktop/g', status: 'gone' },
        { id: 'scr:desktop/s', status: 'same' }, { id: 'scr:desktop/d', status: 'drift', pixel: { changed: false } },
        { id: 'scr:desktop/p', status: 'drift', pixel: { changed: true } }, { id: 'scr:desktop/e', status: 'same' },
      ],
    };
    const shots = Object.fromEntries(['n', 'c', 'g', 's', 'd', 'p', 'e'].map((k) => [`scr:desktop/${k}`, { after: `shots/desktop/after/${k}.png` }]));
    assert.deepEqual(Object.keys(publishedShots(results, shots)), ['scr:desktop/n', 'scr:desktop/c', 'scr:desktop/g', 'scr:desktop/p', 'scr:desktop/e']);
  });

  it('mediaItems: every picture first (branch, then base), then every video, each with a label', () => {
    const items = mediaItems({
      shots: { [DETAIL]: { before: 'shots/desktop/before/detail__default.png', after: 'shots/desktop/after/detail__default.png' } },
      videos: [{ id: 'vid:desktop/detail', viewport: 'desktop', screen: 'detail', src: 'shots/video/desktop/detail.webm' }],
    });
    assert.deepEqual(items.map((i) => [i.path, i.kind]), [
      ['shots/desktop/after/detail__default.png', 'image'], ['shots/desktop/before/detail__default.png', 'image'], ['shots/video/desktop/detail.webm', 'video'],
    ]);
    assert.match(items[0].label, /scr:desktop\/detail__default · branch/);
    assert.match(items[1].label, /scr:desktop\/detail__default · base/);
    assert.match(items[2].label, /vid:desktop\/detail/);
  });

  it('packParts: in order, a part closes before the next file passes the bytes (less the page\'s room) or the file count; an oversized file is left out', () => {
    const limits = { ...LIMITS, fileBytes: 50, publishBytes: 100, publishFiles: 3, pageReserve: 10 };
    const it = (path, bytes) => ({ path, bytes, kind: 'image', label: path });
    const { parts, left } = packParts([it('a', 30), it('b', 30), it('c', 30), it('d', 60), it('e', 10)], limits);
    assert.deepEqual(parts.map((p) => p.map((x) => x.path)), [['a', 'b'], ['c', 'e']], 'two files at most beside the page');
    assert.deepEqual(left.map((x) => x.path), ['d']);
    assert.match(left[0].why, /per-file limit/);
    const bytes = packParts([it('a', 40), it('b', 40), it('c', 40)], { ...limits, publishFiles: 255 });
    assert.deepEqual(bytes.parts.map((p) => p.map((x) => x.path)), [['a', 'b'], ['c']], '40+40 fits in 90; a third would pass it');
    assert.deepEqual(packParts([], limits).parts, [[]], 'part 1 always exists: it holds the report');
  });

  it('placeOf: a file on a later part links there (its URL once known, #part-<n> before), a left-out one says why', () => {
    const parts = [[{ path: 'a' }], [{ path: 'b' }], [{ path: 'c' }]];
    const left = [{ path: 'd', why: 'over the 15 MB per-file limit' }];
    const place = placeOf({ parts, left, urls: ['https://claude.ai/code/artifact/one', 'https://claude.ai/code/artifact/two'] });
    assert.equal(place.a, undefined, 'part 1 files render in place');
    assert.deepEqual(place.b, { part: 2, href: 'https://claude.ai/code/artifact/two' });
    assert.deepEqual(place.c, { part: 3, href: '#part-3' });
    assert.deepEqual(place.d, { left: 'over the 15 MB per-file limit' });
  });
});

describe('report build writes the publish set', () => {
  it('publish.json: only the new and changed screens go up, at full size, each with its size; the page renders with exactly those files', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    const r = cli(repo, ['report', 'build', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(V, 'shots', 'desktop', 'after', 'list__default.png')), 'the local report keeps every cited screen');

    const pub = readJson(path.join(V, 'publish.json'));
    assert.equal(pub.slug, SLUG);
    assert.equal(pub.head, repo.sha);
    assert.equal(pub.verdict, 'REJECT');
    assert.equal(pub.artifacts.length, 1);
    const [a] = pub.artifacts;
    assert.equal(a.part, 1);
    assert.equal(a.page, path.join(V, 'artifact-1.html'));
    assert.equal(a.url, null);
    assert.deepEqual(a.files, {
      'shots/desktop/after/detail__default.png': path.join(V, 'shots', 'desktop', 'after', 'detail__default.png'),
      'shots/desktop/before/detail__default.png': path.join(V, 'shots', 'desktop', 'before', 'detail__default.png'),
    });
    assert.deepEqual(a.list.map((f) => [f.path, f.bytes, f.type]), [
      ['shots/desktop/after/detail__default.png', 1000, 'image/png'], ['shots/desktop/before/detail__default.png', 700, 'image/png'],
    ]);
    assert.equal(read(a.files['shots/desktop/after/detail__default.png']), 'H'.repeat(1000), 'copied byte for byte, never re-encoded');
    assert.equal(pub.total.files, 2);
    assert.equal(pub.total.bytes, 1700);
    assert.deepEqual(pub.left, []);
    assert.equal(a.capabilities, null, 'no video: no assets capability needed');

    const page = read(a.page);
    assert.deepEqual([...new Set(localRefs(page))].sort(), Object.keys(a.files).sort(), 'every file the page shows goes up, and nothing else');
    assert.doesNotMatch(page, /list__default\.png/, 'an unchanged screen is never published');
  });

  it('the artifact page meets the page contract: a fragment with a stable short title, theme tokens for both modes, a phone-width gutter', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG]).status, 0);
    const page = read(path.join(V, 'artifact-1.html'));
    assert.doesNotMatch(page, /<!doctype|<html|<head>|<body/i, 'the publisher wraps the page in its own skeleton');
    assert.match(page, /^<title>feat-x QA report<\/title>/, 'a name, stable across rounds (no verdict word, no explainer)');
    assert.match(page, /<meta name="claude:viewport-fit-sides" content="cover">/);
    assert.match(page, /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{[^}]*color-scheme: dark/);
    assert.match(page, /:root\[data-theme="dark"\] \{[^}]*color-scheme: dark/);
    assert.match(page, /body \{[^}]*background: var\(--bg\)/);
    assert.match(page, /padding-left: max\(16px, env\(safe-area-inset-left, 0px\)\)/);
    assert.match(page, /padding-right: max\(16px, env\(safe-area-inset-right, 0px\)\)/);
    assert.match(page, /REJECT/, 'the verdict is on the page');
    const local = read(path.join(V, 'report.html'));
    assert.match(local, /^<!doctype html>/, 'report.html stays a whole document, for opening from disk');
  });

  it('a recorded journey goes up as its webm, and that artifact declares the assets capability', () => {
    const repo = makeRepo();
    const src = path.join(tmp('mfqa-video-'), 'detail.webm');
    write(src, 'webm bytes');
    const V = writeRun(repo, { videos: [{ id: 'vid:desktop/detail', viewport: 'desktop', screen: 'detail', file: src, checkpoints: [{ state: 'default', atMs: 1200 }] }] });
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG]).status, 0);
    const [a] = readJson(path.join(V, 'publish.json')).artifacts;
    assert.deepEqual(a.capabilities, { assets: {} });
    const video = a.list.find((f) => f.path === 'shots/video/desktop/detail.webm');
    assert.ok(video, JSON.stringify(a.list));
    assert.equal(video.type, 'video/webm');
    assert.equal(video.bytes, 10);
    assert.deepEqual([...new Set(localRefs(read(a.page)))].sort(), Object.keys(a.files).sort());
  });

  it('past the per-publish limit the set splits into a second artifact; the first page links to it, and report url fills the link', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    const limits = JSON.stringify({ publishBytes: 1500, pageReserve: 100, fileBytes: 1200 });
    const r = cli(repo, ['report', 'build', '--slug', SLUG], { QA_PUBLISH_LIMITS: limits });
    assert.equal(r.status, 0, r.out);
    const pub = readJson(path.join(V, 'publish.json'));
    assert.deepEqual(pub.artifacts.map((a) => [a.part, Object.keys(a.files)]), [
      [1, ['shots/desktop/after/detail__default.png']], [2, ['shots/desktop/before/detail__default.png']],
    ]);
    const one = read(pub.artifacts[0].page);
    const two = read(pub.artifacts[1].page);
    assert.match(one, /<a class="part" data-part="2" href="#part-2"[^>]*>/, 'part 1 links to part 2 before its URL is known');
    assert.match(two, /^<title>feat-x QA report part 2<\/title>/);
    assert.match(two, /<img src="shots\/desktop\/before\/detail__default\.png"/);
    for (const a of pub.artifacts) assert.deepEqual([...new Set(localRefs(read(a.page)))].sort(), Object.keys(a.files).sort(), `part ${a.part}`);

    const url = 'https://claude.ai/code/artifact/part-two';
    const rec = cli(repo, ['report', 'url', url, '--part', '2', '--slug', SLUG]);
    assert.equal(rec.status, 0, rec.out);
    assert.match(read(pub.artifacts[0].page), new RegExp(`data-part="2" href="${url}"`));
    assert.doesNotMatch(read(path.join(V, 'verdict.md')), /^Report:/m, 'part 2 writes no Report line: part 1 is the report');
    assert.deepEqual(readJson(path.join(V, 'published.json')).parts, [null, url]);
  });
});

// ── where the report goes ─────────────────────────────────────────────────────

describe('where the report goes', () => {
  it('decideReport: local never publishes; cloud publishes unless both accounts are known and differ', () => {
    assert.deepEqual(pick(decideReport({ where: 'local', session: 'u1', launcher: 'u2' })), { where: 'local', publish: false });
    assert.deepEqual(pick(decideReport({ where: 'cloud', session: null, launcher: 'u2' })), { where: 'cloud', publish: true });
    assert.deepEqual(pick(decideReport({ where: 'cloud', session: 'u1', launcher: null })), { where: 'cloud', publish: true });
    assert.deepEqual(pick(decideReport({ where: 'cloud', session: 'u1', launcher: 'u1' })), { where: 'cloud', publish: true });
    const no = decideReport({ where: 'cloud', session: 'u1', launcher: 'u2' });
    assert.deepEqual(pick(no), { where: 'cloud', publish: false });
    assert.equal(no.reason, 'not your account');
    for (const d of [decideReport({ where: 'cloud', session: null, launcher: null }), no]) assert.ok(d.why.length > 10, 'every decision says why');
  });

  it('whereAmI: QA_WHERE, else CLAUDE_CODE_REMOTE, else local', () => {
    const home = tmp('mfqa-where-');
    assert.equal(whereAmI({ env: { QA_WHERE: 'cloud' }, home }), 'cloud');
    assert.equal(whereAmI({ env: {}, home }), 'local');
    assert.equal(whereAmI({ env: { CLAUDE_CODE_REMOTE: 'true' }, home }), 'cloud');
    assert.equal(whereAmI({ env: { CLAUDE_CODE_REMOTE: 'true', QA_WHERE: 'local' }, home }), 'local');
  });

  it('sessionAccount: QA_ACCOUNT, else ~/.claude.json oauthAccount.accountUuid, else null; launchAccount reads the launch record', () => {
    const home = tmp('mfqa-acct-');
    assert.equal(sessionAccount({ env: {}, home }), null);
    write(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-1' } }));
    assert.equal(sessionAccount({ env: {}, home }), 'uuid-1');
    assert.equal(sessionAccount({ env: { QA_ACCOUNT: 'uuid-2' }, home }), 'uuid-2');
    assert.equal(launchAccount(JSON.stringify({ pr: 'x', where: 'cloud', account: 'uuid-3' })), 'uuid-3');
    assert.equal(launchAccount(null), null);
    assert.equal(launchAccount('not json'), null);
  });

  it('report where, local: writes "Report: on <host> at <report.html>" as the last line, and the verdict stays valid', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG]).status, 0);
    const r = cli(repo, ['report', 'where', '--slug', SLUG, '--json'], { QA_WHERE: 'local' });
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.equal(j.where, 'local');
    assert.equal(j.publish, false);
    const want = `Report: on ${os.hostname()} at ${path.join(V, 'report.html')}`;
    assert.equal(j.line, want);
    assert.equal(lastLine(read(path.join(V, 'verdict.md'))), want);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG, '--check']).stdout.trim(), 'valid');
    // Run twice: still one Report line.
    cli(repo, ['report', 'where', '--slug', SLUG], { QA_WHERE: 'local' });
    assert.equal(read(path.join(V, 'verdict.md')).match(/^Report:/gm).length, 1);
  });

  it('report where, cloud: the publish steps, last part first, and no line yet', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG], { QA_PUBLISH_LIMITS: JSON.stringify({ publishBytes: 1500, pageReserve: 100, fileBytes: 1200 }) }).status, 0);
    const before = read(path.join(V, 'verdict.md'));
    for (const extra of [{ QA_ACCOUNT: 'me-uuid' }, {}]) {
      const r = cli(repo, ['report', 'where', '--slug', SLUG, '--json'], { QA_WHERE: 'cloud', ...extra });
      assert.equal(r.status, 0, r.out);
      const j = JSON.parse(r.stdout);
      assert.equal(j.publish, true, j.why);
      assert.equal(j.line, null);
      assert.deepEqual(j.artifacts.map((a) => a.part), [2, 1], 'part 2 first, so part 1 can link to it');
      const one = j.artifacts[1];
      assert.equal(one.file_path, path.join(V, 'artifact-1.html'));
      assert.equal(one.url, null, 'a first publish');
      assert.equal(typeof one.icon, 'string');
      assert.match(one.description, /feat-x/);
      assert.match(one.then, /qa report url <url> --part 1 --slug feat-x$/);
      assert.equal(read(path.join(V, 'verdict.md')), before, 'nothing written until a URL is recorded');
    }
  });

  it('report where, cloud, with a publish set from an earlier head: refuses to publish it and says so in the Report line', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG]).status, 0);
    const pub = readJson(path.join(V, 'publish.json'));
    write(path.join(V, 'publish.json'), JSON.stringify({ ...pub, head: 'c'.repeat(40) }));
    const r = cli(repo, ['report', 'where', '--slug', SLUG, '--json'], { QA_WHERE: 'cloud' });
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(r.stdout).publish, false);
    assert.match(lastLine(read(path.join(V, 'verdict.md'))), /^Report: NOT PUBLISHED — .*qa report build/);
  });
});

function pick(d) { return { where: d.where, publish: d.publish }; }

// ── the Report line ───────────────────────────────────────────────────────────

describe('the Report line', () => {
  it('its three forms parse, and parseVerdict still reads the cost line above it', () => {
    assert.deepEqual(parseReportLine('Report: https://claude.ai/code/artifact/abc'), { kind: 'url', url: 'https://claude.ai/code/artifact/abc' });
    assert.deepEqual(parseReportLine('Report: NOT PUBLISHED — not your account'), { kind: 'not-published', reason: 'not your account' });
    assert.deepEqual(parseReportLine('Report: on laptop-1 at /home/u/p/qa/x/report.html'), { kind: 'local', host: 'laptop-1', path: '/home/u/p/qa/x/report.html' });
    assert.equal(parseReportLine('cost: plan $0'), null);
    const v = parseVerdict(verdictMd(SHA, { extra: 'Report: https://claude.ai/code/artifact/abc\n' }));
    assert.match(v.cost, /^cost: /);
    assert.deepEqual(v.report, { kind: 'url', url: 'https://claude.ai/code/artifact/abc' });
    assert.deepEqual(v.errors, []);
    assert.equal(parseVerdict(verdictMd(SHA)).report, null);
  });

  it('the line builders, and withReportLine keeps exactly one Report line, last', () => {
    assert.equal(urlLine('https://x/y'), 'Report: https://x/y');
    assert.equal(notPublishedLine('not your account'), 'Report: NOT PUBLISHED — not your account');
    assert.equal(localLine('h1', '/a/report.html'), 'Report: on h1 at /a/report.html');
    const once = withReportLine(verdictMd(SHA), localLine('h1', '/a/report.html'));
    const twice = withReportLine(once, urlLine('https://x/y'));
    assert.equal(twice.match(/^Report:/gm).length, 1);
    assert.equal(lastLine(twice), 'Report: https://x/y');
    assert.match(twice, /cost: plan \$0\.41[^\n]*\nReport: https:\/\/x\/y\n$/, 'directly under the cost line, file ending in a newline');
  });

  it('a verdict with a Report line still validates (R1 cost, R2 no unreadable line)', () => {
    const results = buildResults(exampleRun());
    results.head.sha = SHA;
    const md = withReportLine(verdictMd(SHA), urlLine('https://claude.ai/code/artifact/abc'));
    const problems = validateVerdict({ verdictMd: md, results, eyesMd: EYES_MD, charterMd: CHARTER_MD });
    assert.deepEqual(problems.filter((p) => p.rule === 'R1' || p.rule === 'R2'), []);
  });

  it('report url (part 1) writes "Report: <url>" and V/published.json; a new URL replaces the line and retires the old one', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG]).status, 0);
    const u1 = 'https://claude.ai/code/artifact/one';
    const r = cli(repo, ['report', 'url', u1, '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.equal(lastLine(read(path.join(V, 'verdict.md'))), `Report: ${u1}`);
    const rec = readJson(path.join(V, 'published.json'));
    assert.deepEqual(rec.parts, [u1]);
    assert.equal(rec.head, repo.sha);
    const u2 = 'https://claude.ai/code/artifact/two';
    assert.equal(cli(repo, ['report', 'url', u2, '--slug', SLUG]).status, 0);
    assert.equal(read(path.join(V, 'verdict.md')).match(/^Report:/gm).length, 1);
    assert.equal(lastLine(read(path.join(V, 'verdict.md'))), `Report: ${u2}`);
    assert.deepEqual(readJson(path.join(V, 'published.json')), { ...readJson(path.join(V, 'published.json')), parts: [u2], retired: [u1] });
    assert.equal(cli(repo, ['report', 'url', 'not a url', '--slug', SLUG]).status, 64);
  });

  it('round 2 republishes the same artifact: report build puts the recorded URL in publish.json (from V)', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG]).status, 0);
    const u1 = 'https://claude.ai/code/artifact/one';
    assert.equal(cli(repo, ['report', 'url', u1, '--slug', SLUG]).status, 0);
    assert.equal(cli(repo, ['report', 'build', '--slug', SLUG]).status, 0);
    assert.equal(readJson(path.join(V, 'publish.json')).artifacts[0].url, u1);
  });

  it('report line --not-published "<why>": the line when the Artifact tool is missing or refused', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    const r = cli(repo, ['report', 'line', '--not-published', 'the Artifact tool is not available in this session', '--slug', SLUG]);
    assert.equal(r.status, 0, r.out);
    assert.equal(lastLine(read(path.join(V, 'verdict.md'))), 'Report: NOT PUBLISHED — the Artifact tool is not available in this session');
    assert.equal(cli(repo, ['report', 'line', '--slug', SLUG]).status, 64);
  });

  it('recordUrl and linkPart (pure)', () => {
    const one = recordUrl(null, { slug: SLUG, part: 2, url: 'https://x/2', head: SHA, at: 't' });
    assert.deepEqual(one.parts, [null, 'https://x/2']);
    const two = recordUrl(one, { slug: SLUG, part: 2, url: 'https://x/2b', head: SHA, at: 't2' });
    assert.deepEqual(two.parts, [null, 'https://x/2b']);
    assert.deepEqual(two.retired, ['https://x/2']);
    assert.equal(recordUrl(two, { slug: SLUG, part: 2, url: 'https://x/2b', head: SHA, at: 't3' }).retired.length, 1, 'the same URL again retires nothing');
    const html = '<a class="part" data-part="2" href="#part-2" target="_blank" rel="noopener">x</a><a class="part" data-part="3" href="#part-3">y</a>';
    assert.equal(linkPart(html, 2, 'https://x/2'), html.replace('#part-2', 'https://x/2'));
  });
});

// ── the PR comment ────────────────────────────────────────────────────────────

const NEEDS = `# NEEDS YOU — feat-x
head: ${SHA}
base: ${'b'.repeat(40)}
maps: cccccccccccc
criteria: 1 pass · 0 fail · 1 unverifiable · 1 blocked · 0 waived

## Criteria
- [ch:1] PASS — archive is offered: the Archive button appears
- [ch:2] UNVERIFIABLE — the export reaches the bank: no sandbox key — would prove it: a run with a test key
- [ch:3] UNVERIFIABLE — the copy reads well: not judged — advisory
- [ch:4] BLOCKED — the list loads: the capture timed out twice

## Expectations
- none

## Findings
- Blocker [fail:head/desktop/list__default] the list answered 500
- Major [chk:desktop/detail__default/1] contrast 2.8:1 — gates: corroborated on a changed screen
- Minor [scr:desktop/detail__default] the button sits under the fold

## Spec cases
- none

## Gaps
- [gap:capture] BLOCKED — the list capture timed out twice

## Standing
- none

## Notes
- none

cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0
`;

describe('the PR comment', () => {
  it('commentBody: the marker, the outcome, the counts, the gating rows, what needs the user, what was blocked, the report link', () => {
    const body = commentBody({ verdictMd: withReportLine(NEEDS, urlLine('https://claude.ai/code/artifact/abc')), slug: SLUG });
    assert.ok(body.startsWith(COMMENT_MARKER), 'the hidden marker first, so the next round finds it');
    assert.match(body, /NEEDS YOU/);
    assert.match(body, /1 pass · 0 fail · 1 unverifiable · 1 blocked · 0 waived/);
    assert.match(body, /\[fail:head\/desktop\/list__default\]/, 'a Blocker gates');
    assert.match(body, /\[chk:desktop\/detail__default\/1\]/, 'a row ending "— gates" gates');
    assert.doesNotMatch(body, /\[scr:desktop\/detail__default\]/, 'a Minor without gates is in the report, not the comment');
    assert.match(body, /\[ch:2\][^\n]*would prove it: a run with a test key/);
    assert.doesNotMatch(body, /\[ch:3\]/, 'an advisory row never needs the user');
    assert.match(body, /\[ch:4\]/);
    assert.match(body, /\[gap:capture\]/);
    assert.match(body, /https:\/\/claude\.ai\/code\/artifact\/abc/);
    const local = commentBody({ verdictMd: withReportLine(NEEDS, localLine('laptop-1', '/p/qa/feat-x/report.html')), slug: SLUG });
    assert.match(local, /report on laptop-1/);
    const none = commentBody({ verdictMd: withReportLine(NEEDS, notPublishedLine('not your account')), slug: SLUG });
    assert.match(none, /not published — not your account/);
  });

  it('commentBody: a round-cap NEEDS YOU puts the capped criteria and the cap line under Needs you, not Gating', () => {
    const md = `# NEEDS YOU — ${SLUG}
head: ${'a'.repeat(40)}
base: ${'b'.repeat(40)}
maps: cccccccccccc
criteria: 1 pass · 2 fail · 0 unverifiable · 0 blocked · 0 waived

## Criteria
- [exp:e-beta] FAIL — e-beta: 0 of 1 right
- [ch:1] PASS — alpha shows A: exp:e-alpha met
- [ch:2] FAIL — beta shows B: exp:e-beta NOT MET

## Expectations
- none

## Findings
- none

## Spec cases
- none

## Gaps
- [gap:cap] Round cap: ch:2 rejected 3 times — the user decides (fix differently, change the spec, or waive)

## Standing
- none

## Notes
- none

cost: plan $0 · eyes $0 · judge $0 · runner 0 · total $0
`;
    const body = commentBody({ verdictMd: md, slug: SLUG });
    const section = (name) => body.split(`**${name}**\n`)[1]?.split('\n\n')[0] ?? '';
    assert.match(section('Gating'), /^- none$/, body);
    assert.match(section('Needs you'), /\[ch:2\][^\n]*beta shows B/, body);
    assert.match(section('Needs you'), /\[gap:cap\]`? Round cap: ch:2 rejected 3 times/, body);
    assert.match(section('Needs you'), /\[exp:e-beta\]/, 'the expectation the capped criterion cites goes with it');
    // A REJECT beside the cap: the other failing criterion still gates.
    const both = commentBody({ verdictMd: md.replace(`# NEEDS YOU — ${SLUG}`, `# REJECT — ${SLUG}`).replace('- [ch:1] PASS — alpha shows A: exp:e-alpha met', '- [ch:1] FAIL — alpha shows A: exp:e-alpha NOT MET'), slug: SLUG });
    assert.match(both.split('**Gating**\n')[1].split('\n\n')[0], /\[ch:1\]/);
    assert.doesNotMatch(both.split('**Gating**\n')[1].split('\n\n')[0], /\[ch:2\]/);
  });

  // A fake gh: records each call; `pr view` answers PR 7 (FAKE_GH_NO_PR: none); `api` lists, posts and edits one
  // comment kept in <state>/comment.json, and lists its id only when its body carries the marker.
  function fakeGh() {
    const dir = tmp('mfqa-gh-');
    const file = path.join(dir, 'gh');
    write(file, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const state = process.env.FAKE_GH_STATE;
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(path.join(state, 'calls.log'), JSON.stringify({ args, input }) + '\\n');
const saved = path.join(state, 'comment.json');
if (args[0] === 'pr' && args[1] === 'view') {
  if (process.env.FAKE_GH_NO_PR) { console.error('no pull requests found for branch "main"'); process.exit(1); }
  console.log(JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7' })); process.exit(0);
}
if (args[0] === 'api') {
  const i = args.indexOf('-X'); const method = i >= 0 ? args[i + 1] : 'GET';
  if (method === 'GET') { if (fs.existsSync(saved) && JSON.parse(fs.readFileSync(saved, 'utf8')).body.includes('<!-- qa:report -->')) console.log('99'); process.exit(0); }
  const body = JSON.parse(input).body;
  fs.writeFileSync(saved, JSON.stringify({ id: 99, body, method }));
  console.log(JSON.stringify({ id: 99, html_url: 'https://github.com/o/r/pull/7#issuecomment-99' })); process.exit(0);
}
process.exit(2);
`);
    fs.chmodSync(file, 0o755);
    return { gh: file, state: dir, calls: () => read(path.join(dir, 'calls.log')).trim().split('\n').map((l) => JSON.parse(l)) };
  }

  it('report comment posts ONE comment, then edits that same comment on the next round', () => {
    const repo = makeRepo();
    const V = writeRun(repo);
    write(path.join(V, 'verdict.md'), withReportLine(read(path.join(V, 'verdict.md')), urlLine('https://claude.ai/code/artifact/abc')));
    const g = fakeGh();
    const env = { QA_GH: g.gh, FAKE_GH_STATE: g.state };
    const first = cli(repo, ['report', 'comment', '--slug', SLUG], env);
    assert.equal(first.status, 0, first.out);
    assert.match(first.stdout, /comment: posted https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-99/);
    let calls = g.calls();
    assert.deepEqual(calls[0].args.slice(0, 2), ['pr', 'view'], 'the PR comes from the branch');
    const post = calls.find((c) => c.args.includes('POST'));
    assert.ok(post.args.some((a) => /repos\/\{owner\}\/\{repo\}\/issues\/7\/comments$/.test(a)), JSON.stringify(post.args));
    assert.ok(JSON.parse(post.input).body.startsWith(COMMENT_MARKER));

    const second = cli(repo, ['report', 'comment', '--slug', SLUG], env);
    assert.equal(second.status, 0, second.out);
    assert.match(second.stdout, /comment: edited /);
    calls = g.calls();
    const patch = calls.find((c) => c.args.includes('PATCH'));
    assert.ok(patch, 'the second round edits');
    assert.ok(patch.args.some((a) => /repos\/\{owner\}\/\{repo\}\/issues\/comments\/99$/.test(a)), JSON.stringify(patch.args));
    assert.equal(calls.filter((c) => c.args.includes('POST')).length, 1, 'never a second comment');
    assert.match(JSON.parse(read(path.join(g.state, 'comment.json'))).body, /artifact\/abc/);
  });

  it('report comment --pr <n> skips the branch lookup', () => {
    const repo = makeRepo();
    writeRun(repo);
    const g = fakeGh();
    const r = cli(repo, ['report', 'comment', '--slug', SLUG, '--pr', '12'], { QA_GH: g.gh, FAKE_GH_STATE: g.state });
    assert.equal(r.status, 0, r.out);
    const calls = g.calls();
    assert.ok(!calls.some((c) => c.args[0] === 'pr'), 'no gh pr view');
    assert.ok(calls.some((c) => c.args.some((a) => /issues\/12\/comments$/.test(a))));
  });

  it('no PR for the branch, or no gh at all: it says why and exits 0 (never blocks)', () => {
    const repo = makeRepo();
    writeRun(repo);
    const g = fakeGh();
    const noPr = cli(repo, ['report', 'comment', '--slug', SLUG], { QA_GH: g.gh, FAKE_GH_STATE: g.state, FAKE_GH_NO_PR: '1' });
    assert.equal(noPr.status, 0, noPr.out);
    assert.match(noPr.stdout, /^no comment: no pull request/m);
    const noGh = cli(repo, ['report', 'comment', '--slug', SLUG], { QA_GH: path.join(repo.dir, 'no-such-gh') });
    assert.equal(noGh.status, 0, noGh.out);
    assert.match(noGh.stdout, /^no comment: gh /m);
  });
});
