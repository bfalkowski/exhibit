import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { history } from '../src/commands/history.js';
import { checkHistoryLine } from '../src/history-schema.js';
import { replayFetch } from '../test-support/replay-fetch.js';
import { graphqlReplies } from './fixtures/github/graphql-replies.js';
import { buildSzzRepo } from './fixtures/szz-repo.js';
import { writeHistoryReplay } from './fixtures/github/szz-replies.js';
import { gitEnv } from './fixtures/git-env.js';

// These tests run `exhibit history` twice in the same folder, as a person does from day to day.
// Between the runs, the recorded GitHub replies change: a new merge, or a late review. The
// replay fetch records every URL that each run asks for, so a test can check what a run read.

const REPO = 'acme/days';

const madeFolders = [];
function newFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-incremental-'));
  madeFolders.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of madeFolders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// One merged PR. `day` is the day of November 2026 it was merged on.
function pull(number, day) {
  const sha = (letter) => letter.repeat(38) + String(number).padStart(2, '0');
  const at = `2026-11-${String(day).padStart(2, '0')}T12:00:00Z`;
  return {
    number,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    state: 'closed',
    title: `Change ${number}`,
    body: `Body of #${number}.`,
    user: { login: `dev${number}`, type: 'User' },
    labels: [],
    created_at: at,
    closed_at: at,
    merged_at: at,
    merge_commit_sha: sha('a'),
    base: { ref: 'main', sha: sha('b') },
    head: { ref: `topic-${number}`, sha: sha('c') }
  };
}

// The GitHub of acme/days: its merged PRs, and the reviews of each PR by number.
// The PRs: 1 on November 1, 2 on November 5, 3 on November 10, 4 on November 14.
function repo() {
  return { pulls: [pull(4, 14), pull(3, 10), pull(2, 5), pull(1, 1)], reviews: {} };
}

// Writes the recorded replies for `gh` to a new file, and returns a fetch that replays it.
// Each PR has two files, and a page holds one item, so history asks for the second page of a
// PR's files when it reads that PR, and only then. So a test sees which PRs a run read.
function replies(gh) {
  const recorded = graphqlReplies(REPO, gh.pulls.map((pr) => ({
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    body: pr.body,
    author: { __typename: 'User', login: pr.user.login },
    mergedAt: pr.merged_at,
    mergeSha: pr.merge_commit_sha,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    labels: [],
    files: [{ path: `src/f${pr.number}.js`, additions: 1, deletions: 0 }, { path: `test/f${pr.number}.test.js`, additions: 2, deletions: 0 }],
    reviews: (gh.reviews[pr.number] ?? []).map((review) => ({ state: review.state, submittedAt: review.submitted_at, author: { __typename: 'User', login: review.user.login } })),
    comments: [],
    ci: []
  })), { itemsPerPage: 1 });
  const path = join(newFolder(), 'replies.json');
  writeFileSync(path, JSON.stringify(recorded));
  return replayFetch(path);
}

// Runs `exhibit history --repo acme/days ...args` in `cwd`, in this process. Returns what it
// printed and every URL path it asked GitHub for.
async function run(cwd, gh, args = []) {
  const fetch = replies(gh);
  let stdout = '';
  let stderr = '';
  await history(['--repo', REPO, ...args], {
    // The reply cache goes in a new folder, so a test never touches the real cache.
    env: { GITHUB_TOKEN: 't', XDG_CACHE_HOME: newFolder() },
    cwd,
    fetch,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) }
  });
  return { stdout, stderr, asked: fetch.calls.map((call) => call.key) };
}

const readLines = (cwd) => readFileSync(join(cwd, '.exhibit', 'history.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

// The PR numbers whose files a run asked for, one each, smallest first: the PRs it read.
function prsAsked(asked) {
  const numbers = new Set();
  for (const key of asked) {
    const match = key.match(/^graphql Pull\w+ .*"number":(\d+),/);
    if (match) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

test('a second run with no new merges asks only about the PRs in the look-back window', async () => {
  const cwd = newFolder();
  const gh = repo();
  const first = await run(cwd, gh);
  assert.deepEqual(prsAsked(first.asked), [1, 2, 3, 4]);

  const second = await run(cwd, gh);
  // The newest merge is November 14, so the window starts on November 7: PRs 3 and 4.
  // One query reads every merged PR. Then one asks for the rest of each read PR's files.
  assert.deepEqual(prsAsked(second.asked), [3, 4]);
  assert.equal(second.asked.length, 3);
  assert.deepEqual(readLines(cwd).map((line) => line.number), [4, 3, 2, 1]);
});

test('every run prints how many GitHub requests and GraphQL queries it made, in text and in --json', async () => {
  const cwd = newFolder();
  const gh = repo();
  const first = await run(cwd, gh);
  // 1 query for the list, then 1 for the second page of files of each of the 4 PRs. Each costs 1 point.
  assert.match(first.stdout, /\nMade 0 GitHub REST requests\. 0 got a 304 and came from the cache in .*\nMade 5 GitHub GraphQL queries, which used 5 points of the GraphQL rate limit\.\n$/);
  assert.match(first.stdout, /Read all 4 merged PRs/);

  const second = await run(cwd, gh, ['--json']);
  const summary = JSON.parse(second.stdout);
  assert.deepEqual([summary.github.requests, summary.github.graphql], [0, { queries: 3, points: 3 }]);
  assert.equal(summary.github.graphql.queries, second.asked.length);
  assert.deepEqual({ mode: summary.mode, prs: summary.prs, read: summary.read }, { mode: 'incremental', prs: 4, read: 2 });
});

test('a new merge after the first run adds exactly one line, and the file stays newest first', async () => {
  const cwd = newFolder();
  const gh = repo();
  await run(cwd, gh);
  const before = readLines(cwd);

  gh.pulls.unshift(pull(5, 18));
  const second = await run(cwd, gh);
  const after = readLines(cwd);
  assert.deepEqual(after.map((line) => line.number), [5, 4, 3, 2, 1]);
  assert.deepEqual(after.slice(1), before);
  for (const line of after) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  // The window now starts on November 7, from the newest line in the old file (November 14).
  assert.deepEqual(prsAsked(second.asked), [3, 4, 5]);
});

test('a late review on a PR inside the window shows up after the second run', async () => {
  const cwd = newFolder();
  const gh = repo();
  await run(cwd, gh);
  assert.deepEqual(readLines(cwd).find((line) => line.number === 3).reviews.list, []);

  gh.reviews[3] = [{ state: 'CHANGES_REQUESTED', user: { login: 'late' }, submitted_at: '2026-11-15T09:00:00Z' }];
  // A late review on PR 1, outside the window, is not read: its line stays as it was.
  gh.reviews[1] = [{ state: 'APPROVED', user: { login: 'later' }, submitted_at: '2026-11-15T09:00:00Z' }];
  await run(cwd, gh);
  const lines = readLines(cwd);
  assert.deepEqual(lines.find((line) => line.number === 3).reviews, {
    change_request_rounds: 1,
    list: [{ state: 'CHANGES_REQUESTED', author: 'late', source: 'review' }]
  });
  assert.deepEqual(lines.find((line) => line.number === 1).reviews.list, []);
});

test('--full reads every PR again and rewrites the whole file', async () => {
  const cwd = newFolder();
  const gh = repo();
  await run(cwd, gh);
  gh.reviews[1] = [{ state: 'APPROVED', user: { login: 'later' }, submitted_at: '2026-11-15T09:00:00Z' }];

  const second = await run(cwd, gh, ['--full', '--json']);
  assert.deepEqual(prsAsked(second.asked), [1, 2, 3, 4]);
  assert.equal(JSON.parse(second.stdout).mode, 'full');
  assert.deepEqual(readLines(cwd).find((line) => line.number === 1).reviews.list, [{ state: 'APPROVED', author: 'later', source: 'review' }]);
});

test('a file from an older schema version forces a full run, with one line that says why', async () => {
  const cwd = newFolder();
  const gh = repo();
  await run(cwd, gh);
  // A file from before ticket 78 has no head_sha, forge or url.
  const old = readLines(cwd).map((line) => {
    const rest = { ...line };
    for (const field of ['head_sha', 'forge', 'url']) delete rest[field];
    return rest;
  });
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), old.map((line) => JSON.stringify(line) + '\n').join(''));

  const second = await run(cwd, gh);
  assert.deepEqual(prsAsked(second.asked), [1, 2, 3, 4]);
  const notes = second.stderr.split('\n').filter((text) => text.includes('reads every merged PR again'));
  assert.equal(notes.length, 1, second.stderr);
  assert.match(notes[0], /older version of Exhibit/);
  for (const line of readLines(cwd)) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
});

test('a file from another repo forces a full run', async () => {
  const cwd = newFolder();
  const gh = repo();
  await run(cwd, gh);
  const other = readLines(cwd).map((line) => ({ ...line, url: line.url.replace(REPO, 'acme/other') }));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), other.map((line) => JSON.stringify(line) + '\n').join(''));

  const second = await run(cwd, gh);
  assert.deepEqual(prsAsked(second.asked), [1, 2, 3, 4]);
  assert.match(second.stderr, /reads every merged PR again.*another repo/);
  assert.ok(readLines(cwd).every((line) => line.url.includes(REPO)));
});

test('a file that is not JSON lines forces a full run', async () => {
  const cwd = newFolder();
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), 'not json\n');
  const run1 = await run(cwd, repo());
  assert.deepEqual(prsAsked(run1.asked), [1, 2, 3, 4]);
  assert.match(run1.stderr, /reads every merged PR again/);
});

test('--limit on an existing file keeps the newest N, and reads only the ones the file lacks or the window holds', async () => {
  const cwd = newFolder();
  const gh = repo();
  await run(cwd, gh, ['--limit', '2']);
  assert.deepEqual(readLines(cwd).map((line) => line.number), [4, 3]);

  // Without --limit, the file grows to every merged PR. PRs 1 and 2 are not in the file, so
  // they are read. PRs 3 and 4 are in the window, so they are read again.
  const second = await run(cwd, gh);
  assert.deepEqual(readLines(cwd).map((line) => line.number), [4, 3, 2, 1]);
  assert.deepEqual(prsAsked(second.asked), [1, 2, 3, 4]);

  // With --limit 1 again, the file holds PR 4 only, and only PR 4 is read.
  const third = await run(cwd, gh, ['--limit', '1']);
  assert.deepEqual(readLines(cwd).map((line) => line.number), [4]);
  assert.deepEqual(prsAsked(third.asked), [4]);
});

test('--since on an existing file keeps the PRs merged at or after it, and drops the older lines', async () => {
  const cwd = newFolder();
  const gh = repo();
  await run(cwd, gh);
  const second = await run(cwd, gh, ['--since', '2026-11-05']);
  assert.deepEqual(readLines(cwd).map((line) => line.number), [4, 3, 2]);
  assert.deepEqual(prsAsked(second.asked), [3, 4]);
});

test('the window is seven days before the newest merge in the file', async () => {
  const cwd = newFolder();
  const gh = { pulls: [pull(4, 14), pull(3, 7), pull(2, 6)], reviews: {} };
  await run(cwd, gh);
  const second = await run(cwd, gh);
  // November 7 at 12:00 is exactly seven days before November 14 at 12:00, so PR 3 is in it.
  assert.deepEqual(prsAsked(second.asked), [3, 4]);
});

test('a fix line kept with szz null gets SZZ once a later run is inside a clone', (t) => {
  const shop = buildSzzRepo();
  t.after(() => shop.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/shop.git'], { cwd: shop.dir, env: gitEnv(shop.dir) });
  const replay = writeHistoryReplay(shop, 'fixture/shop');
  t.after(replay.cleanup);
  const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
  const preload = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
  const run = (cwd) => spawnSync(process.execPath, ['--import', preload, bin, 'history', '--repo', 'fixture/shop', '--json', '--no-cache'], { cwd, env: gitEnv(cwd, { EXHIBIT_TEST_FIXTURE: replay.path, GITHUB_TOKEN: 'test-token' }), encoding: 'utf8' });

  // The first run is outside a clone, so every line gets szz: null.
  const outside = newFolder();
  const first = run(outside);
  assert.equal(first.status, 0, first.stderr);
  const lines = readFileSync(join(outside, '.exhibit/history.jsonl'), 'utf8').trim().split('\n').map((row) => JSON.parse(row));
  assert.ok(lines.every((line) => line.szz === null));

  // The fixture's PRs are an hour apart, so all of them sit in the 7-day window. Moving the old
  // file a year ahead puts every PR before the window, so the next run keeps every line, as on a
  // repo with more than a week of history.
  const ahead = lines.map((line) => ({ ...line, merged_at: line.merged_at.replace(/^2026/, '2027') }));
  mkdirSync(join(shop.dir, '.exhibit'), { recursive: true });
  writeFileSync(join(shop.dir, '.exhibit/history.jsonl'), ahead.map((line) => JSON.stringify(line)).join('\n') + '\n');

  const second = run(shop.dir);
  assert.equal(second.status, 0, second.stderr);
  const out = JSON.parse(second.stdout);
  assert.equal(out.read, 0);
  assert.deepEqual(out.szz, { fix_prs: 7, linked: 4, skipped: 0 });
});
