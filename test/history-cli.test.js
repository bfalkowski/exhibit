import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheFolder } from '../src/github-cache.js';
import { checkHistoryLine } from '../src/history-schema.js';
import { writeBigFixture } from './fixtures/github/acme-big.js';
import { buildSzzRepo } from './fixtures/szz-repo.js';
import { writeHistoryReplay } from './fixtures/github/szz-replies.js';
import { gitEnv } from './fixtures/git-env.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const preload = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/github/${name}.json`, import.meta.url));

// Makes a new empty folder. The folder is removed when test t ends.
function newFolder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs `exhibit ...args` for test t in a new empty folder, with a fetch that replays the named fixture.
// token: null runs it with no GITHUB_TOKEN at all.
// fixturePath: a fixture file built by a test, in place of a named one.
// history runs git inside a clone, so it gets a clean env: see gitEnv.
function exhibit(t, args, { fixtureName = 'acme-widgets', fixturePath = fixture(fixtureName), token = 'test-token', cwd = newFolder(t) } = {}) {
  const env = gitEnv(cwd, { EXHIBIT_TEST_FIXTURE: fixturePath });
  if (token !== null) env.GITHUB_TOKEN = token;
  const run = spawnSync(process.execPath, ['--import', preload, bin, ...args], { cwd, env, encoding: 'utf8' });
  return { ...run, cwd, historyPath: join(cwd, '.exhibit', 'history.jsonl') };
}

const notAClone = (repo) => `exhibit: note: SZZ did not run, because this folder is not a clone of ${repo}, so every szz is null. Run history inside a clone to link fix PRs to the PRs that added their lines.\n`;
const QUOTED_VERDICT_WARNING = 'exhibit: warning: PR 5: the comment by dev5 at 2026-02-20T10:00:00Z gives the verdict fix only in a quoted line, so it does not count as a review.\n';
const REPORT = { markdown: '.exhibit/report.md', html: '.exhibit/report.html' };
const WROTE_REPORT = 'Wrote the report to .exhibit/report.md and .exhibit/report.html.\n';
// Each run gets HOME = its own folder, so its reply cache is in that folder, and starts empty.
const cacheOf = (cwd) => cacheFolder({ env: {}, home: cwd });
const madeRequests = (cwd, requests, notModified = 0) => `Made ${requests} GitHub requests. ${notModified} got a 304 and came from the cache in ${cacheOf(cwd)}.\n`;
const githubCounts = (cwd, requests, notModified = 0) => ({ requests, not_modified: notModified, cache: cacheOf(cwd) });
const readLines = (path) => readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

test('exhibit history writes one schema-valid line for each merged PR, then exits 0', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5, 3, 1]);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.match(run.stdout, /5 merged PRs/);
});

test('history marks fix PRs with the default signals when there is no evidence.yml', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  const fixes = readLines(run.historyPath).filter((l) => l.classification.fix);
  assert.deepEqual(fixes.map((l) => [l.number, l.classification.fix_signal]), [[5, 'label:bug']]);
});

test('a custom fix_signals list in evidence.yml replaces the defaults', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\nsettings:\n  fix_signals: [title:rename]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.deepEqual(lines.filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [[4, 'title:rename']]);
});

test('a title_after_key signal is recorded in classification, and the line passes the schema', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\nsettings:\n  fix_signals: [title_after_key:rename]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.deepEqual(lines.filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [[4, 'title_after_key:rename']]);
});

test('a title_after_key signal with no value gives exit 2 with a message, and writes no file', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'settings:\n  fix_signals: [label:bug, "title_after_key:"]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /evidence\.yml settings\.fix_signals\[1\] is "title_after_key:", which needs a value/);
  assert.ok(!existsSync(run.historyPath));
});

test('a malformed fix_signals gives exit 2 with a message, and writes no file', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'settings:\n  fix_signals: [bug]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /evidence\.yml settings\.fix_signals\[0\] is "bug"/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
  assert.ok(!existsSync(run.historyPath));
});

test('a PR with more files than GitHub lists gives a warning on stderr that names it, and still exits 0', (t) => {
  const big = writeBigFixture();
  t.after(big.cleanup);
  const run = exhibit(t, ['history', '--repo', 'acme/big', '--json'], { fixturePath: big.path });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, 'exhibit: warning: PR 9 changed 3412 files, but GitHub listed only the first 3000, so its files field is cut short.\n' + notAClone('acme/big'));
  assert.deepEqual(JSON.parse(run.stdout), { prs: 3, output: '.exhibit/history.jsonl', szz: null, report: REPORT, github: githubCounts(run.cwd, 76), mode: 'full', read: 3 });
  assert.deepEqual(readLines(run.historyPath).map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
});

test('a failed request for the file count gives a warning, not a failed run', (t) => {
  const big = writeBigFixture({ unreadable: [9] });
  t.after(big.cleanup);
  const run = exhibit(t, ['history', '--repo', 'acme/big'], { fixturePath: big.path });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^exhibit: warning: PR 9 has 3000 files listed, the most GitHub lists, so its files field may be cut short\. Exhibit could not read how many files it changed: GitHub answered 500/);
  assert.deepEqual(readLines(run.historyPath).map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
});

test('a rate limit on the request for the file count gives a warning, no wait, and exit 0', (t) => {
  const big = writeBigFixture({ countReplies: { 9: { status: 403, headers: { 'retry-after': '3600' }, body: { message: 'API rate limit exceeded' } } } });
  t.after(big.cleanup);
  const run = exhibit(t, ['history', '--repo', 'acme/big', '--json'], { fixturePath: big.path });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.stderr,
    'exhibit: warning: PR 9 has 3000 files listed, the most GitHub lists, so its files field may be cut short. Exhibit could not read how many files it changed: GitHub answered 403 (API rate limit exceeded) for /repos/acme/big/pulls/9. The token may lack access, or the rate limit is used up: check the token, or wait and try again.\n' + notAClone('acme/big')
  );
  // 76 requests, as in the run with no rate limit: the count request went once and was not asked again.
  assert.deepEqual(JSON.parse(run.stdout), { prs: 3, output: '.exhibit/history.jsonl', szz: null, report: REPORT, github: githubCounts(run.cwd, 76), mode: 'full', read: 3 });
  assert.deepEqual(readLines(run.historyPath).map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
});

test('outside a clone, history writes szz: null on every line and says so in one line', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  // The fixture's PR 5 has a reply that quotes a verdict, so a warning comes first.
  assert.equal(run.stderr, QUOTED_VERDICT_WARNING + notAClone('acme/widgets'));
  for (const line of readLines(run.historyPath)) assert.equal(line.szz, null, `PR ${line.number}`);
});

test('inside a clone of the repo, history links each fix PR to the PRs that added its lines', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const run = exhibit(t, ['history', '--repo', 'fixture/shop'], { fixturePath: replay.path, cwd: repo.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  // The fixture repo holds a history file whose lines are all in the look-back window, so the
  // run reads every PR again, and SZZ runs on the fixes, whose szz is null there.
  assert.equal(run.stdout, 'Wrote 14 merged PRs from fixture/shop to .exhibit/history.jsonl. SZZ found links for 4 of 7 fix PRs.\nRead 14 of 14 merged PRs from GitHub: the PRs not in the old file, and the PRs merged in the 7 days before its newest PR. Kept the other 0 lines as they were.\n' + WROTE_REPORT + madeRequests(repo.dir, 77));

  // Read the links back from the file history wrote.
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  // PR 7 is a squash merge: its head commit is on its branch, and its merge commit is not.
  const squash7 = lines.find((line) => line.number === 7);
  assert.deepEqual([squash7.head_sha, squash7.forge, squash7.url], [execFileSync('git', ['rev-parse', 'refs/pull/7/head'], { cwd: repo.dir, env: gitEnv(repo.dir), encoding: 'utf8' }).trim(), 'github', 'https://github.com/fixture/shop/pull/7']);
  assert.notEqual(squash7.head_sha, squash7.merge_sha);
  const fix7 = lines.find((line) => line.number === 7);
  assert.deepEqual(fix7.szz.links.map((link) => [link.pr, link.confidence]), [[2, 0.5], [3, 0.5]]);
  const [discount] = fix7.szz.links[0].lines;
  assert.equal(discount.path, 'src/discount.js');
  assert.equal(discount.text, '  return total - percent;');
  assert.equal(discount.blame.commit, lines.find((line) => line.number === 2).merge_sha);
  assert.equal(discount.blame.summary, 'Add discounts (#2)');
  assert.equal(lines.find((line) => line.number === 1).szz, null, 'a PR that is not a fix');
  // PR 12 was merged with "rebase and merge". Its links skip its own first commit.
  const fix12 = lines.find((line) => line.number === 12);
  assert.deepEqual(fix12.szz.links.map((link) => [link.pr, link.confidence]), [[1, 0.5], [11, 0.5]]);
  const fix8 = lines.find((line) => line.number === 8);
  assert.deepEqual(fix8.szz.links, []);
  assert.equal(fix8.szz.no_link_reason, 'whitespace only');
});

test('inside a clone, history writes report.md and report.html with the escaped defects', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const run = exhibit(t, ['history', '--repo', 'fixture/shop'], { fixturePath: replay.path, cwd: repo.dir });
  assert.equal(run.status, 0, run.stderr);
  const markdown = readFileSync(join(repo.dir, REPORT.markdown), 'utf8');
  const html = readFileSync(join(repo.dir, REPORT.html), 'utf8');
  assert.match(markdown, /^# Escaped defects in fixture\/shop\n\nExhibit read 14 merged PRs\. 7 of them are fix PRs\. SZZ linked 4 of them/);
  assert.deepEqual([...markdown.matchAll(/^### Fix PR (\d+):/gm)].map((m) => Number(m[1])), [14, 12, 7, 6]);
  assert.deepEqual([...html.matchAll(/<h3>Fix PR (\d+):/g)].map((m) => Number(m[1])), [14, 12, 7, 6]);
});

test('outside a clone, the report says that SZZ did not run', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  const markdown = readFileSync(join(run.cwd, REPORT.markdown), 'utf8');
  assert.match(markdown, /SZZ did not run, because history ran outside a clone of the repo\./);
  assert.doesNotMatch(markdown, /^### Fix PR/m);
});

test('a run that fails writes no report', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { fixtureName: 'acme-broken' });
  assert.equal(run.status, 2);
  assert.equal(existsSync(join(run.cwd, REPORT.markdown)), false);
  assert.equal(existsSync(join(run.cwd, REPORT.html)), false);
});

test('--json gives the SZZ counts inside a clone', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const run = exhibit(t, ['history', '--repo', 'fixture/shop', '--json'], { fixturePath: replay.path, cwd: repo.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { prs: 14, output: '.exhibit/history.jsonl', szz: { fix_prs: 7, linked: 4, skipped: 0 }, report: REPORT, github: githubCounts(repo.dir, 77), mode: 'incremental', read: 14 });
});

test('a second run inside a clone keeps the SZZ result of each fix it reads again, and asks GitHub nothing for SZZ', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const first = exhibit(t, ['history', '--repo', 'fixture/shop', '--json'], { fixturePath: replay.path, cwd: repo.dir });
  assert.equal(first.status, 0, first.stderr);
  const before = readLines(first.historyPath);

  const second = exhibit(t, ['history', '--repo', 'fixture/shop', '--json'], { fixturePath: replay.path, cwd: repo.dir });
  assert.equal(second.status, 0, second.stderr);
  // 1 request for the list, and 5 for each of the 14 PRs in the window. The first run made 6
  // more, for SZZ. Each fix had a szz, so SZZ does not run again.
  assert.equal(JSON.parse(second.stdout).github.requests, 71);
  assert.deepEqual(readLines(second.historyPath), before);
});

test('the summary counts the fix PRs that SZZ skipped, in text and in --json', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  // A clone of depth 1 holds only the newest commit, so SZZ skips every fix.
  const shallow = mkdtempSync(join(tmpdir(), 'exhibit-shallow-'));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${repo.dir}`, '.'], { cwd: shallow, env: gitEnv(shallow) });
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/fixture/shop.git'], { cwd: shallow, env: gitEnv(shallow) });
  const { path: fixturePath, cleanup } = writeHistoryReplay(repo, 'fixture/shop');
  t.after(cleanup);

  const text = exhibit(t, ['history', '--repo', 'fixture/shop'], { fixturePath, cwd: shallow });
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, 'Wrote 14 merged PRs from fixture/shop to .exhibit/history.jsonl. SZZ found links for 0 of 7 fix PRs (7 skipped).\nRead all 14 merged PRs from GitHub.\n' + WROTE_REPORT + madeRequests(shallow, 71));
  assert.equal(text.stderr.match(/SZZ skipped/g).length, 7);

  const json = exhibit(t, ['history', '--repo', 'fixture/shop', '--json'], { fixturePath, cwd: shallow });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { prs: 14, output: '.exhibit/history.jsonl', szz: { fix_prs: 7, linked: 0, skipped: 7 }, report: REPORT, github: githubCounts(shallow, 71), mode: 'incremental', read: 14 });
});

test('--since keeps PRs merged on or after the date', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets', '--since', '2026-03-01']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readLines(run.historyPath).map((l) => l.number), [7, 4, 5]);
});

test('--limit keeps the newest N merged PRs', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets', '--limit', '2']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readLines(run.historyPath).map((l) => l.number), [7, 4]);
});

test('--json prints a short machine summary', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { prs: 5, output: '.exhibit/history.jsonl', szz: null, report: REPORT, github: githubCounts(run.cwd, 31), mode: 'full', read: 5 });
});

test('a record that fails the schema gives exit 2, names the PR, and writes no file', (t) => {
  const cwd = newFolder(t);
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), 'old\n');
  const run = exhibit(t, ['history', '--repo', 'acme/broken'], { fixtureName: 'acme-broken', cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /PR 1/);
  assert.match(run.stderr, /\/files\/0\/additions/);
  assert.equal(readFileSync(run.historyPath, 'utf8'), 'old\n', 'the old file stays as it was');
  assert.deepEqual(readdirSync(join(cwd, '.exhibit')), ['history.jsonl'], 'no temporary file is left');
});

test('a missing GITHUB_TOKEN gives exit 2 and says to set it', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { token: null });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /GITHUB_TOKEN/);
  assert.ok(!existsSync(run.historyPath));
});

test('an unknown repo gives exit 2 and says to check the name', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/nothing-here'], { fixtureName: 'unknown-repo' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /404/);
  assert.match(run.stderr, /repo name/);
  assert.ok(!existsSync(run.historyPath));
});

test('an API 500 gives exit 2 and says to try again later', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { fixtureName: 'server-error' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /500/);
  assert.match(run.stderr, /try again later/);
  assert.ok(!existsSync(run.historyPath));
});

test('bad arguments give exit 2 and say what is wrong', (t) => {
  for (const [args, message] of [
    [['history'], /--repo/],
    [['history', '--repo', 'not-a-repo'], /owner\/name/],
    [['history', '--repo', 'acme/widgets', '--since', 'last week'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-02-30'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-04-31T10:00:00Z'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-02-30T10:00:00+01:00'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-13-01'], /--since/],
    [['history', '--repo', 'acme/widgets', '--limit', '0'], /--limit/],
    [['history', '--repo', 'acme/widgets', '--frobnicate'], /frobnicate/]
  ]) {
    const run = exhibit(t, args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, message, args.join(' '));
  }
});

test('a folder that cannot be written gives exit 2 and a message, not a stack trace', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, '.exhibit'), 'a plain file where the folder should be');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /could not write \.exhibit\/history\.jsonl/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

// Writes a copy of the acme-widgets fixture where every 200 reply has an ETag, in `dir`.
function widgetsWithETags(dir) {
  const recorded = JSON.parse(readFileSync(fixture('acme-widgets'), 'utf8'));
  for (const [key, reply] of Object.entries(recorded)) {
    if (reply.status === 200) reply.headers = { ...reply.headers, etag: `W/"${key}"` };
  }
  const path = join(dir, 'acme-widgets-etags.json');
  writeFileSync(path, JSON.stringify(recorded));
  return path;
}

test('a second run gets a 304 for every request, writes the same history, and says so', (t) => {
  const cwd = newFolder(t);
  const fixturePath = widgetsWithETags(newFolder(t));
  const first = exhibit(t, ['history', '--repo', 'acme/widgets'], { fixturePath, cwd });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.endsWith(madeRequests(cwd, 31)), first.stdout);
  const history = readFileSync(first.historyPath, 'utf8');

  // --full, so the second run asks for every reply again, as the first did (spec 8.3).
  const second = exhibit(t, ['history', '--repo', 'acme/widgets', '--full', '--json'], { fixturePath, cwd });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).github, githubCounts(cwd, 31, 31));
  assert.equal(readFileSync(second.historyPath, 'utf8'), history);
});

test('--no-cache gets no 304s and writes no cache folder', (t) => {
  const cwd = newFolder(t);
  const fixturePath = widgetsWithETags(newFolder(t));
  // --full, so each run asks for every reply, and only the cache could save a request (spec 8.3).
  for (let run = 0; run < 2; run++) {
    const text = exhibit(t, ['history', '--repo', 'acme/widgets', '--no-cache', '--full'], { fixturePath, cwd });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\nMade 31 GitHub requests\. The cache was off\.\n$/);
  }
  const json = exhibit(t, ['history', '--repo', 'acme/widgets', '--no-cache', '--full', '--json'], { fixturePath, cwd });
  assert.deepEqual(JSON.parse(json.stdout).github, { requests: 31, not_modified: 0, cache: null });
  assert.equal(existsSync(cacheOf(cwd)), false);
});

test('a run that fails says how many GitHub requests it made', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/broken'], { fixtureName: 'acme-broken' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /does not fit the history schema/);
  assert.match(run.stderr, /exhibit: note: this run made [1-9]\d* GitHub requests, and 0 got a 304\.\n/);
});
