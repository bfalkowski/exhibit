import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheFolder, UNUSED_DAYS } from '../src/github-cache.js';
import { checkHistoryLine } from '../src/history-schema.js';
import { writeBigFixture } from './fixtures/github/acme-big.js';
import { buildSzzRepo } from './fixtures/szz-repo.js';
import { writeHistoryReplay } from './fixtures/github/szz-replies.js';
import { gitEnv } from './fixtures/git-env.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const preload = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
const fullDisk = fileURLToPath(new URL('../test-support/preload-full-disk.js', import.meta.url));
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
// failWrite: a write to a path that holds this text fails, as on a full disk.
// moreEnv: more env variables, such as JIRA_API_TOKEN.
// history runs git inside a clone, so it gets a clean env: see gitEnv.
function exhibit(t, args, { fixtureName = 'acme-widgets', fixturePath = fixture(fixtureName), token = 'test-token', cwd = newFolder(t), failWrite, moreEnv = {} } = {}) {
  const env = gitEnv(cwd, { EXHIBIT_TEST_FIXTURE: fixturePath, ...moreEnv });
  if (token !== null) env.GITHUB_TOKEN = token;
  const preloads = failWrite === undefined ? ['--import', preload] : ['--import', preload, '--import', fullDisk];
  if (failWrite !== undefined) env.EXHIBIT_TEST_FULL_DISK = failWrite;
  const run = spawnSync(process.execPath, [...preloads, bin, ...args], { cwd, env, encoding: 'utf8' });
  return { ...run, cwd, historyPath: join(cwd, '.exhibit', 'history.jsonl') };
}

const notAClone = (repo) => `exhibit: note: SZZ did not run, because this folder is not a clone of ${repo}, so every szz is null. Run history inside a clone to link fix PRs to the PRs that added their lines.\n`;
// With no evidence.yml, every PR's kinds is empty, and history says so in this one line.
const NO_POLICY = 'exhibit: note: there is no evidence.yml, so the kinds of every PR in .exhibit/history.jsonl are empty, which means default.\n';
const QUOTED_VERDICT_WARNING = 'exhibit: warning: PR 5: the comment by dev5 at 2026-02-20T10:00:00Z gives the verdict fix only in a quoted line, so it does not count as a review.\n';
const REPORT = { markdown: '.exhibit/report.md', html: '.exhibit/report.html' };
const WROTE_REPORT = 'Wrote the report to .exhibit/report.md and .exhibit/report.html.\n';
// Each run gets HOME = its own folder, so its reply cache is in that folder, and starts empty.
const cacheOf = (cwd) => cacheFolder({ env: {}, home: cwd });
const restRequests = (n) => `${n} GitHub REST ${n === 1 ? 'request' : 'requests'}`;
const graphqlQueries = (n) => `Made ${n} GitHub GraphQL ${n === 1 ? 'query' : 'queries'}, which used ${n} ${n === 1 ? 'point' : 'points'} of the GraphQL rate limit.\n`;
// Every recorded GraphQL reply costs 1 point, so the points equal the queries.
const madeRequests = (cwd, requests, queries, notModified = 0) => `Made ${restRequests(requests)}. ${notModified} got a 304 and came from the cache in ${cacheOf(cwd)}.\n` + graphqlQueries(queries);
const githubCounts = (cwd, requests, queries, notModified = 0) => ({ requests, not_modified: notModified, cache: cacheOf(cwd), graphql: { queries, points: queries } });
// The funnel outside a clone, with no labels file: SZZ did not run, so it stops at the fix PRs.
const outsideClone = (prs, fixes) => ({ merged_prs: prs, fix_prs: fixes, szz_linked: null, labeled: null, kept: null, labels: 'none' });
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

test('a title_after_tag signal is recorded in classification, and the line passes the schema', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\nsettings:\n  fix_signals: [title_after_tag:rename]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.deepEqual(lines.filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [[4, 'title_after_tag:rename']]);
});

test('a pr: signal marks the PR with that number as a fix, next to the other signals', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\nsettings:\n  fix_signals: [label:bug, title:fix, branch:fix/, pr:3, pr:5]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  // PR 5 has the label bug, and label:bug comes first in the list.
  assert.deepEqual(lines.filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [[5, 'label:bug'], [3, 'pr:3']]);
});

test('a pr: signal that is not a PR number gives exit 2 with a message, and writes no file', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'settings:\n  fix_signals: [label:bug, pr:abc]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /evidence\.yml settings\.fix_signals\[1\] is "pr:abc"\. A pr: signal needs a PR number of 1 or more, with no leading zero, as in pr:96\./);
  assert.ok(!existsSync(run.historyPath));
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
  assert.equal(run.stderr, NO_POLICY + 'exhibit: warning: PR 9 changed 3412 files, but GitHub listed only the first 3000, so its files field is cut short.\n' + notAClone('acme/big'));
  // 1 query for the PRs, and 29 more pages of 100 files for each of PRs 9 and 8.
  assert.deepEqual(JSON.parse(run.stdout), { prs: 3, output: '.exhibit/history.jsonl', szz: null, funnel: outsideClone(3, 0), report: REPORT, github: githubCounts(run.cwd, 0, 59), mode: 'full', read: 3 });
  assert.deepEqual(readLines(run.historyPath).map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
});

test('outside a clone, history writes szz: null on every line and says so in one line', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  // The fixture's PR 5 has a reply that quotes a verdict, so a warning comes first.
  assert.equal(run.stderr, NO_POLICY + QUOTED_VERDICT_WARNING + notAClone('acme/widgets'));
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
  assert.equal(run.stderr, NO_POLICY);
  // The fixture repo holds a history file whose lines are all in the look-back window, so the
  // run reads every PR again, and SZZ runs on the fixes, whose szz is null there.
  assert.equal(run.stdout, 'Wrote 14 merged PRs from fixture/shop to .exhibit/history.jsonl. SZZ found links for 4 of 7 fix PRs.\nRead 14 of 14 merged PRs from GitHub: the PRs not in the old file, and the PRs merged in the 7 days before its newest PR. Kept the other 0 lines as they were.\n' + WROTE_REPORT + madeRequests(repo.dir, 6, 1));

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
  assert.deepEqual(JSON.parse(run.stdout), { prs: 14, output: '.exhibit/history.jsonl', szz: { fix_prs: 7, linked: 4, skipped: 0 }, funnel: { merged_prs: 14, fix_prs: 7, szz_linked: 4, labeled: null, kept: null, labels: 'none' }, report: REPORT, github: githubCounts(repo.dir, 6, 1), mode: 'incremental', read: 14 });
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
  // 1 GraphQL query for the PRs, with all their lists, and no REST request. The first run made
  // 6 REST requests for SZZ. Each fix had a szz, so SZZ does not run again.
  assert.deepEqual(JSON.parse(first.stdout).github, githubCounts(repo.dir, 6, 1));
  assert.deepEqual(JSON.parse(second.stdout).github, githubCounts(repo.dir, 0, 1));
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
  assert.equal(text.stdout, 'Wrote 14 merged PRs from fixture/shop to .exhibit/history.jsonl. SZZ found links for 0 of 7 fix PRs (7 skipped).\nRead all 14 merged PRs from GitHub.\n' + WROTE_REPORT + madeRequests(shallow, 0, 1));
  assert.equal(text.stderr.match(/SZZ skipped/g).length, 7);

  const json = exhibit(t, ['history', '--repo', 'fixture/shop', '--json'], { fixturePath, cwd: shallow });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { prs: 14, output: '.exhibit/history.jsonl', szz: { fix_prs: 7, linked: 0, skipped: 7 }, funnel: { merged_prs: 14, fix_prs: 7, szz_linked: 0, labeled: null, kept: null, labels: 'none' }, report: REPORT, github: githubCounts(shallow, 0, 1), mode: 'incremental', read: 14 });
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
  // 2 pages of PRs, then the second pages of PR 7's files, reviews, comments and CI results, and of PR 4's CI results.
  assert.deepEqual(JSON.parse(run.stdout), { prs: 5, output: '.exhibit/history.jsonl', szz: null, funnel: outsideClone(5, 1), report: REPORT, github: githubCounts(run.cwd, 0, 7), mode: 'full', read: 5 });
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
  assert.equal(run.stderr, 'exhibit: GITHUB_TOKEN is not set. Set it to a GitHub token that can read the repo, for example GITHUB_TOKEN=$(gh auth token).\n');
  assert.ok(!existsSync(run.historyPath));
});

test('an unknown repo gives exit 2 and says to check the name', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/nothing-here'], { fixtureName: 'unknown-repo' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^exhibit: GitHub's GraphQL API answered with an error \(Could not resolve to a Repository with the name 'acme\/nothing-here'\.\)\. Check the repo name, and that GITHUB_TOKEN can read that repo\.\n/m);
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

test('when the first or the last write fails, the run keeps all three old files, so they still match', (t) => {
  const cwd = newFolder(t);
  const first = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(first.status, 0, first.stderr);
  const names = ['history.jsonl', 'report.md', 'report.html'];
  const before = names.map((name) => readFileSync(join(cwd, '.exhibit', name), 'utf8'));
  // The same run with --limit 2 would write new files, but the disk is full when report.html is written.
  const run = exhibit(t, ['history', '--repo', 'acme/widgets', '--full', '--limit', '2'], { cwd, failWrite: 'report.html' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /could not write \.exhibit\/report\.html: ENOSPC/);
  assert.deepEqual(names.map((name) => readFileSync(join(cwd, '.exhibit', name), 'utf8')), before, 'no file changed');
  assert.deepEqual(readdirSync(join(cwd, '.exhibit')).sort(), [...names].sort(), 'no temporary file is left');

  // The same run again, but the disk is full when history.jsonl, the first file, is written.
  const firstFails = exhibit(t, ['history', '--repo', 'acme/widgets', '--full', '--limit', '2'], { cwd, failWrite: 'history.jsonl' });
  assert.equal(firstFails.status, 2);
  assert.match(firstFails.stderr, /could not write \.exhibit\/history\.jsonl: ENOSPC/);
  assert.deepEqual(names.map((name) => readFileSync(join(cwd, '.exhibit', name), 'utf8')), before, 'no file changed when the first write fails');
  assert.deepEqual(readdirSync(join(cwd, '.exhibit')).sort(), [...names].sort(), 'no temporary file is left when the first write fails');
});

// Builds the shop fixture repo as a clone of fixture/shop, and writes a copy of its replay file
// where every REST 200 reply has an ETag. GraphQL replies have no ETag: GitHub gives none for a
// POST. So only SZZ's REST requests can get a 304. Returns the clone's folder and the file.
function shopWithETags(t) {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const recorded = JSON.parse(readFileSync(replay.path, 'utf8'));
  for (const [key, reply] of Object.entries(recorded)) {
    if (key.startsWith('/') && reply.status === 200) reply.headers = { ...reply.headers, etag: `W/"${key}"` };
  }
  const fixturePath = join(newFolder(t), 'shop-etags.json');
  writeFileSync(fixturePath, JSON.stringify(recorded));
  return { cwd: repo.dir, fixturePath };
}

test('a second run gets a 304 for every REST request, writes the same history, and says so', (t) => {
  const { cwd, fixturePath } = shopWithETags(t);
  const first = exhibit(t, ['history', '--repo', 'fixture/shop'], { fixturePath, cwd });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.endsWith(madeRequests(cwd, 6, 1)), first.stdout);
  const history = readFileSync(first.historyPath, 'utf8');

  // --full, so the second run reads every PR and runs SZZ again, as the first did (spec 8.3).
  const second = exhibit(t, ['history', '--repo', 'fixture/shop', '--full', '--json'], { fixturePath, cwd });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).github, githubCounts(cwd, 6, 1, 6));
  assert.equal(readFileSync(second.historyPath, 'utf8'), history);
});

test('a run removes the cache entries that no run has used for 30 days', (t) => {
  const { cwd, fixturePath } = shopWithETags(t);
  const first = exhibit(t, ['history', '--repo', 'fixture/shop'], { fixturePath, cwd });
  assert.equal(first.status, 0, first.stderr);
  const folder = cacheOf(cwd);
  const used = readdirSync(folder);
  assert.equal(used.length, 6);
  // An entry that no run has read or written for UNUSED_DAYS + 10 days.
  const stale = join(folder, `${'a'.repeat(64)}.json`);
  writeFileSync(stale, '{}');
  const then = new Date(Date.now() - (UNUSED_DAYS + 10) * 24 * 60 * 60 * 1000);
  utimesSync(stale, then, then);

  const second = exhibit(t, ['history', '--repo', 'fixture/shop', '--full'], { fixturePath, cwd });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.endsWith(madeRequests(cwd, 6, 1, 6)), second.stdout);
  assert.deepEqual(readdirSync(folder).sort(), used.sort());
});

test('a run that fails still removes the cache entries that no run has used for 30 days', (t) => {
  const cwd = newFolder(t);
  const folder = cacheOf(cwd);
  mkdirSync(folder, { recursive: true });
  const stale = join(folder, `${'a'.repeat(64)}.json`);
  const fresh = join(folder, `${'b'.repeat(64)}.json`);
  writeFileSync(stale, '{}');
  writeFileSync(fresh, '{}');
  const then = new Date(Date.now() - (UNUSED_DAYS + 10) * 24 * 60 * 60 * 1000);
  utimesSync(stale, then, then);

  const run = exhibit(t, ['history', '--repo', 'acme/broken'], { fixtureName: 'acme-broken', cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /does not fit the history schema/);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test('--no-cache gets no 304s and writes no cache folder', (t) => {
  const { cwd, fixturePath } = shopWithETags(t);
  // --full, so each run reads every PR and runs SZZ, and only the cache could save a request (spec 8.3).
  for (let run = 0; run < 2; run++) {
    const text = exhibit(t, ['history', '--repo', 'fixture/shop', '--no-cache', '--full'], { fixturePath, cwd });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\nMade 6 GitHub REST requests\. The cache was off\.\nMade 1 GitHub GraphQL query, which used 1 point of the GraphQL rate limit\.\n$/);
  }
  const json = exhibit(t, ['history', '--repo', 'fixture/shop', '--no-cache', '--full', '--json'], { fixturePath, cwd });
  assert.deepEqual(JSON.parse(json.stdout).github, { requests: 6, not_modified: 0, cache: null, graphql: { queries: 1, points: 1 } });
  assert.equal(existsSync(cacheOf(cwd)), false);
});

test('a run that fails says how many GitHub requests it made', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/broken'], { fixtureName: 'acme-broken' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /does not fit the history schema/);
  assert.match(run.stderr, /exhibit: note: this run made 0 GitHub REST requests, and 0 got a 304\. It made 1 GitHub GraphQL query, which used 1 point\.\n/);
});

// The history files that the REST version of history wrote from the same fixture repos, before
// history moved to GraphQL. The GraphQL replies must give the same file, byte for byte.
// One change: the shop fixture's REST replies gave each empty PR body as "". GitHub's REST API
// gives null for a PR with no description, and GraphQL gives "", which the forge turns into null.
// So shop.jsonl has null where the REST run wrote "".
const restHistory = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/github/rest-history/${name}.jsonl`, import.meta.url)), 'utf8');

test('the history file from GraphQL equals the one from REST, outside a clone', (t) => {
  const run = exhibit(t, ['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(run.historyPath, 'utf8'), restHistory('acme-widgets'));
});

test('the history file from GraphQL equals the one from REST, inside a clone with SZZ', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const run = exhibit(t, ['history', '--repo', 'fixture/shop'], { fixturePath: replay.path, cwd: repo.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(run.historyPath, 'utf8'), restHistory('shop'));
});

test('a policy that breaks the schema gives exit 2 with a message that names the field, and writes no file', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\nkinds:\n  relay-core:\n    match: ["relay/**"]\n    risk: extreme\n    needs: [tests-before-after]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^exhibit: evidence\.yml kinds\.relay-core\.risk must be low, medium or high, not "extreme"\.$/m);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
  assert.ok(!existsSync(run.historyPath));
});

// The acme/widgets fixture, with Jira keys in some titles and branches, and the Jira replies from
// test/fixtures/jira/acme.json in the same file, so one replay serves both. PR 4 names the Bug
// PAY-482, PR 3's branch names the Story PAY-483, PR 1 names PAY-404, which Jira does not know,
// and PR 7 names PAY-503, which Jira answers with a 503. PR 5 has the label bug, so the signal
// label:bug before tracker:jira matches it, and Jira is not asked.
// `titles` and `jiraReplies` replace those, for a test that needs other ones.
function jiraFixture(t, { titles = { 4: 'PAY-482: Rename the widget table', 1: 'PAY-404: First commit of widgets', 7: 'PAY-503: Add the widget cache' }, jiraReplies = {} } = {}) {
  const replies = JSON.parse(readFileSync(fixture('acme-widgets'), 'utf8'));
  for (const reply of Object.values(replies)) {
    for (const pr of reply.body?.data?.repository?.pullRequests?.nodes ?? []) {
      if (titles[pr.number]) pr.title = titles[pr.number];
      if (pr.number === 3) pr.headRefName = 'PAY-483-readme';
    }
  }
  Object.assign(replies, JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/jira/acme.json', import.meta.url)), 'utf8')), jiraReplies);
  const dir = newFolder(t);
  const path = join(dir, 'acme-jira.json');
  writeFileSync(path, JSON.stringify(replies));
  return path;
}

const JIRA_POLICY = 'version: 3\nsettings:\n  fix_signals: [label:bug, tracker:jira]\n  jira:\n    site: https://acme.atlassian.net\n';
const JIRA_TOKEN = 'secret-jira-token-5f2e';

test('tracker:jira marks a PR whose Jira issue is a Bug, warns for a 5xx, and counts the Jira requests', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), JIRA_POLICY);
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t), moreEnv: { JIRA_API_TOKEN: JIRA_TOKEN } });
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.deepEqual(lines.filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [[4, 'jira:PAY-482'], [5, 'label:bug']]);
  assert.match(run.stderr, /^exhibit: warning: PR 7: the tracker:jira signal could not check PAY-503, so it does not match\. Jira answered 503 \(Service Unavailable\) for \/rest\/api\/2\/issue\/PAY-503\. Jira had a problem: try again later\.$/m);
  assert.match(run.stdout, /^Made 4 Jira requests\. 1 named an issue that Jira does not know\.$/m);

  // No token in any output, the history file or the report.
  const written = [run.stdout, run.stderr, ...['.exhibit/history.jsonl', REPORT.markdown, REPORT.html].map((name) => readFileSync(join(cwd, name), 'utf8'))];
  for (const text of written) assert.ok(!text.includes(JIRA_TOKEN));

  const json = exhibit(t, ['history', '--repo', 'acme/widgets', '--json', '--full'], { cwd, fixturePath: jiraFixture(t), moreEnv: { JIRA_API_TOKEN: JIRA_TOKEN } });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).jira, { requests: 4, not_found: 1 });
});

test('with tracker:jira and no JIRA_API_TOKEN, the signal matches nothing, the run succeeds, and one line says so', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), JIRA_POLICY);
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t) });
  assert.equal(run.status, 0, run.stderr);
  const notice = 'exhibit: note: JIRA_API_TOKEN is not set, so the tracker:jira fix signal matched no PR. Set it to a Jira API token, and for Jira Cloud set JIRA_EMAIL to the email of its account.\n';
  assert.equal(run.stderr.split(notice).length - 1, 1, run.stderr);
  assert.deepEqual(readLines(run.historyPath).filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [[5, 'label:bug']]);
  assert.doesNotMatch(run.stdout, /Jira request/);

  // --json gives jira: null with tracker:jira and no token. Without tracker:jira it has no jira
  // field at all: the test "--json prints a short machine summary" checks the whole object.
  const json = exhibit(t, ['history', '--repo', 'acme/widgets', '--json', '--full'], { cwd, fixturePath: jiraFixture(t) });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).jira, null);
});

// PR 1 is merged before the look-back window, so a second run keeps its line. Here it names the
// Bug PAY-482, PR 3's branch names the Story PAY-483, PR 7 names PAY-503, and PR 4 names the
// Defect PAY-484. PR 4 and PR 7 are in the window, so a second run reads them again.
const KEPT_JIRA = { titles: { 1: 'PAY-482: First commit of widgets', 4: 'PAY-484: Rename the widget table', 7: 'PAY-503: Add the widget cache' } };
const jiraFixes = (path) => readLines(path).filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]);
// PAY-503 as a Bug, for a first run that Jira answers.
const PAY_503_BUG = { '/rest/api/2/issue/PAY-503?fields=issuetype,created': { status: 200, headers: {}, body: { key: 'PAY-503', fields: { issuetype: { name: 'Bug' }, created: '2026-03-04T08:00:00.000+0000' } } } };

test('a kept line keeps the Jira answer that its line saved, so a plain run asks Jira only for the PRs it reads', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), JIRA_POLICY);
  const env = { JIRA_API_TOKEN: JIRA_TOKEN };
  const first = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t, KEPT_JIRA), moreEnv: env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Made 4 Jira requests\. 0 named an issue that Jira does not know\.$/m);
  const lines = readLines(first.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.deepEqual(lines.find((l) => l.number === 1).ticket, { issue: 'jira:PAY-482', type: 'Bug', created_at: '2026-01-05T09:30:00.000Z', found_field: null, found: [] });
  assert.equal(lines.find((l) => l.number === 3).ticket.type, 'Story');
  assert.equal(lines.find((l) => l.number === 7).ticket, undefined, 'a 503 saves no answer');
  assert.equal(lines.find((l) => l.number === 5).ticket, undefined, 'label:bug matched first, so Jira was not asked');

  // PRs 1 and 3 are kept, and their saved answers classify them. Only PRs 4 and 7 ask Jira.
  const second = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t, KEPT_JIRA), moreEnv: env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^Made 2 Jira requests\. 0 named an issue that Jira does not know\.$/m);
  assert.deepEqual(jiraFixes(second.historyPath), [[5, 'label:bug'], [1, 'jira:PAY-482']]);
  assert.doesNotMatch(second.stderr, /classified another way/);

  // --full asks Jira again for every PR.
  const full = exhibit(t, ['history', '--repo', 'acme/widgets', '--full'], { cwd, fixturePath: jiraFixture(t, KEPT_JIRA), moreEnv: env });
  assert.match(full.stdout, /^Made 4 Jira requests\./m);
});

test('with no JIRA_API_TOKEN, a line keeps the Jira answer that the old file saved, and one note says so', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), JIRA_POLICY);
  const first = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t, { ...KEPT_JIRA, jiraReplies: PAY_503_BUG }), moreEnv: { JIRA_API_TOKEN: JIRA_TOKEN } });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(jiraFixes(first.historyPath), [[7, 'jira:PAY-503'], [5, 'label:bug'], [1, 'jira:PAY-482']]);
  const saved = readLines(first.historyPath).map((l) => [l.number, l.ticket]);

  // PR 1 is kept, and PR 7 is read again, in the window: both keep their answers.
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t, KEPT_JIRA) });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(jiraFixes(run.historyPath), [[7, 'jira:PAY-503'], [5, 'label:bug'], [1, 'jira:PAY-482']]);
  assert.deepEqual(readLines(run.historyPath).map((l) => [l.number, l.ticket]), saved);
  const notice = 'exhibit: note: JIRA_API_TOKEN is not set, so Exhibit did not ask Jira. 4 PRs keep the Jira answer saved in .exhibit/history.jsonl, and the tracker:jira fix signal matched no other PR. Set it to a Jira API token, and for Jira Cloud set JIRA_EMAIL to the email of its account.\n';
  assert.equal(run.stderr.split(notice).length - 1, 1, run.stderr);
  assert.doesNotMatch(run.stderr, /classified another way/);
  assert.doesNotMatch(run.stdout, /Jira request/);
});

test('a PR that is read keeps the Jira answer that its line saved when Jira answers 5xx, with a warning', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), JIRA_POLICY);
  const env = { JIRA_API_TOKEN: JIRA_TOKEN };
  const first = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t, { ...KEPT_JIRA, jiraReplies: PAY_503_BUG }), moreEnv: env });
  assert.equal(first.status, 0, first.stderr);
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd, fixturePath: jiraFixture(t, KEPT_JIRA), moreEnv: env });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(jiraFixes(run.historyPath), [[7, 'jira:PAY-503'], [5, 'label:bug'], [1, 'jira:PAY-482']]);
  assert.match(run.stderr, /^exhibit: warning: PR 7: the tracker:jira signal could not check PAY-503, so the PR keeps the answer saved in the history file \(jira:PAY-503\)\. Jira answered 503 /m);
  assert.doesNotMatch(run.stderr, /classified another way/);
});

test('tracker:jira with no settings.jira gives exit 2 with a message, and writes no file', (t) => {
  const cwd = newFolder(t);
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\nsettings:\n  fix_signals: [tracker:jira]\n');
  const run = exhibit(t, ['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /settings\.fix_signals has tracker:jira, so settings needs jira: \{ site: /);
  assert.equal(existsSync(run.historyPath), false);
});

// Runs history inside a clone of the fixture shop repo, with `labels` as the text of
// .exhibit/labels.jsonl, or no labels file when it is undefined.
function shopRunWithLabels(t, labels, args = []) {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const labelsPath = join(repo.dir, '.exhibit', 'labels.jsonl');
  if (labels !== undefined) writeFileSync(labelsPath, labels);
  const run = exhibit(t, ['history', '--repo', 'fixture/shop', ...args], { fixturePath: replay.path, cwd: repo.dir });
  return { ...run, labelsPath, markdown: existsSync(join(repo.dir, REPORT.markdown)) ? readFileSync(join(repo.dir, REPORT.markdown), 'utf8') : '' };
}

// Fix PR 12 keeps both its links. Fix PR 7 has both its links rejected.
const SHOP_LABELS = [
  { id: 'D-012', fix_pr: 12, introducing_prs: [1, 11], rejected_prs: [], code: 'Discount math', category: 'arithmetic', would_have_caught: 'A test', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-21T10:00:00.000Z' },
  { id: 'D-007', fix_pr: 7, introducing_prs: [], rejected_prs: [2, 3], code: 'Total off', category: 'arithmetic', would_have_caught: 'A test', labeled_by: 'person', szz_link_rejected: true, known_at_review: null, labeled_at: '2026-11-21T10:00:00.000Z' }
].map((line) => JSON.stringify(line) + '\n').join('');

test('history counts the labels in the funnel, in report.md and in --json, and leaves labels.jsonl as it was', (t) => {
  const run = shopRunWithLabels(t, SHOP_LABELS, ['--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).funnel, { merged_prs: 14, fix_prs: 7, szz_linked: 4, labeled: 2, kept: 1, labels: 'read' });
  assert.match(run.markdown, /- Defects labeled with exhibit label: 2\n- Defects with at least one link that a person kept: 1\n/);
  assert.equal(readFileSync(run.labelsPath, 'utf8'), SHOP_LABELS);
});

test('with no labels file, history says "not labeled yet" for the last two steps, and writes no labels file', (t) => {
  const run = shopRunWithLabels(t, undefined, ['--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).funnel, { merged_prs: 14, fix_prs: 7, szz_linked: 4, labeled: null, kept: null, labels: 'none' });
  assert.match(run.markdown, /- Defects labeled with exhibit label: not labeled yet\n- Defects with at least one link that a person kept: not labeled yet\n/);
  assert.equal(existsSync(run.labelsPath), false);
});

test('a labels line that fails its schema makes the report say the labels could not be read, and the run still succeeds', (t) => {
  const bad = SHOP_LABELS + JSON.stringify({ id: 'D-006', fix_pr: 6 }) + '\n';
  const run = shopRunWithLabels(t, bad);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^exhibit: warning: the report does not count the labels, because \.exhibit\/labels\.jsonl line 3 does not fit the labels schema\./m);
  assert.match(run.markdown, /- Defects labeled with exhibit label: the labels could not be read\n/);
  assert.match(run.markdown, /Exhibit could not read the labels, so it does not count them: \.exhibit\/labels\.jsonl line 3 does not fit the labels schema\./);
  assert.equal(readFileSync(run.labelsPath, 'utf8'), bad);
});
