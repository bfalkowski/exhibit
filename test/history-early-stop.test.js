import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubForge } from '../src/github.js';
import { readHistory } from '../src/history.js';
import { replayFetch } from '../test-support/replay-fetch.js';
import { graphqlReplies } from './fixtures/github/graphql-replies.js';

// With --since or --limit, history lists the merged PRs updated last first, and stops when no
// later page can hold a PR it keeps (spec 8.3). GitHub's order can be off, so a later PR may be
// updated up to one day (ORDER_MARGIN_MS) after the oldest update on the page before. A page
// holds two PRs here, so the list has four pages, updated last first:
//   page 1: PR 16 (merged Nov 20, updated Nov 21), PR 15 (merged and updated Nov 19)
//   page 2: PR 14 (merged Nov 17, updated Nov 18), PR 13 (merged Nov 10, updated Nov 16)
//   page 3: PR 12 (merged Nov 5, updated Nov 14), PR 11 (merged and updated Nov 2)
//   page 4: PR 10 and PR 9, merged and updated in October
const REPO = 'acme/stops';
const day = (text) => `2026-${text}${text.includes('T') ? '' : 'T12:00:00'}Z`;
const PULLS = [
  [16, '11-20', '11-21'], [15, '11-19', '11-19'],
  [14, '11-17', '11-18'], [13, '11-10', '11-16'],
  [12, '11-05', '11-14'], [11, '11-02', '11-02'],
  [10, '10-20', '10-20'], [9, '10-10', '10-10']
];

function pull([number, merged, updated, sorted]) {
  return {
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    body: null,
    author: { __typename: 'User', login: 'dev' },
    mergedAt: day(merged),
    updatedAt: day(updated),
    sortedAt: sorted && day(sorted),
    mergeSha: 'a'.repeat(38) + String(number),
    baseRef: 'main',
    baseSha: 'b'.repeat(38) + String(number),
    headRef: `task/${number}`,
    headSha: 'c'.repeat(38) + String(number),
    labels: [],
    files: [{ path: `src/f${number}.js`, additions: 1, deletions: 0 }],
    reviews: [],
    comments: [],
    ci: []
  };
}

// A fetch that replays `recorded`, the replies of graphqlReplies.
function replay(recorded) {
  const file = join(mkdtempSync(join(tmpdir(), 'exhibit-stops-')), 'replies.json');
  writeFileSync(file, JSON.stringify(recorded));
  return replayFetch(file);
}

// The cursors of the RecentMergedPulls queries the run sent, in order. null is the first page.
const pagesAsked = (fetch) => fetch.calls
  .filter((call) => call.key.startsWith('graphql RecentMergedPulls '))
  .map((call) => JSON.parse(call.key.slice('graphql RecentMergedPulls '.length)).after);

const read = (fetch, options) => readHistory({ forge: createGitHubForge({ repo: REPO, token: 't', fetch }), ...options });

test('--since stops the list after the first page whose PRs were all updated more than a day before it', async () => {
  const fetch = replay(graphqlReplies(REPO, PULLS.map(pull), { pullsPerPage: 2 }));
  const lines = await read(fetch, { since: new Date(day('11-15')) });
  assert.deepEqual(lines.map((line) => line.number), [16, 15, 14]);
  // Page 2 holds PR 13, updated after --since, so page 3 is read too. Every PR on page 3 was
  // updated more than a day before --since, so page 4 is not read. Then page 1 is read again,
  // for a PR updated while the pages were read.
  assert.deepEqual(pagesAsked(fetch), [null, 'recent-1', 'recent-2', null]);
  assert.ok(!fetch.calls.some((call) => call.key.startsWith('graphql MergedPulls ')), 'the list in GitHub order is not read');
});

test('--limit alone stops the list once N kept PRs were merged after every later PR was updated', async () => {
  const fetch = replay(graphqlReplies(REPO, PULLS.map(pull), { pullsPerPage: 2 }));
  const lines = await read(fetch, { limit: 2 });
  assert.deepEqual(lines.map((line) => line.number), [16, 15]);
  // After page 1, a later PR may be merged as late as Nov 20, one day after Nov 19, so it could
  // still be first or second. After page 2, PRs 16 and 15 were merged after Nov 17, one day after
  // Nov 16, and every later PR was merged by then.
  assert.deepEqual(pagesAsked(fetch), [null, 'recent-1', null]);
});

test('--since and --limit together stop at the earlier of the two stops', async () => {
  const fetch = replay(graphqlReplies(REPO, PULLS.map(pull), { pullsPerPage: 2 }));
  const lines = await read(fetch, { since: new Date(day('10-01')), limit: 1 });
  assert.deepEqual(lines.map((line) => line.number), [16]);
  // After page 1, a later PR may be merged as late as Nov 20 at noon, when PR 16 was merged, so
  // the run reads page 2. After page 2, PR 16 was merged after Nov 17, so the run stops. It read
  // more than one page, so it reads page 1 again.
  assert.deepEqual(pagesAsked(fetch), [null, 'recent-1', null]);
});

test('a PR that GitHub lists lower than its update time is still kept, within the margin', async () => {
  // GitHub lists PR 18 on page 3, below PR 13, although PR 18 was merged and updated on Nov 15,
  // after PR 13's last update on Nov 14 at noon. This is the kind of order seen on cli/cli.
  //   page 2: PR 14 (updated Nov 18), PR 13 (merged Nov 10, updated Nov 14 at noon)
  //   page 3: PR 18 (merged and updated Nov 15 at 06:00, but listed as if updated Nov 14), PR 11
  const pulls = [
    [16, '11-20', '11-21'], [15, '11-19', '11-19'],
    [14, '11-17', '11-18'], [13, '11-10', '11-14'],
    [18, '11-15T06:00:00', '11-15T06:00:00', '11-14T00:00:00'], [11, '11-02', '11-02'],
    [10, '10-20', '10-20'], [9, '10-10', '10-10']
  ];
  const fetch = replay(graphqlReplies(REPO, pulls.map(pull), { pullsPerPage: 2 }));
  const lines = await read(fetch, { since: new Date(day('11-15T00:00:00')) });
  // Every PR on page 2 was updated before --since, but less than a day before it, so the run
  // reads page 3 and finds PR 18.
  assert.deepEqual(lines.map((line) => line.number), [16, 15, 14, 18]);
  assert.deepEqual(pagesAsked(fetch), [null, 'recent-1', 'recent-2', null]);
});

test('the run finds a PR that someone updated while it read the pages, and that moved to the top', async () => {
  // PR 17 was merged on Nov 12 and is on page 3. After page 1 is read, someone comments on it, so
  // GitHub lists it first, and the later pages no longer hold it.
  const moved = [17, '11-12', '11-13'];
  const before = graphqlReplies(REPO, [...PULLS.slice(0, 4), moved, ...PULLS.slice(4)].map(pull), { pullsPerPage: 2 });
  const after = graphqlReplies(REPO, [[17, '11-12', '11-22'], ...PULLS].map(pull), { pullsPerPage: 2 });
  const firstPage = 'graphql RecentMergedPulls {"owner":"acme","name":"stops","after":null}';
  const fetchBefore = replay(before);
  const fetchAfter = replay(after);
  let pages = 0;
  const calls = [];
  const fetch = async (url, init) => {
    const isPage = JSON.parse(init.body).query.includes('query RecentMergedPulls');
    if (isPage) pages += 1;
    const replayed = isPage && pages === 1 ? fetchBefore : fetchAfter;
    const reply = await replayed(url, init);
    calls.push(replayed.calls.at(-1));
    return reply;
  };
  const lines = await read(fetch, { since: new Date(day('11-11')) });
  assert.deepEqual(lines.map((line) => line.number), [16, 15, 14, 17]);
  assert.equal(fetchBefore.calls[0].key, firstPage);
  // The first pass reads pages 1 to 4 and stops: page 4 ends with a PR updated more than a day
  // before --since. The second read of the top finds PR 17 on page 1. Page 1 ends with PR 16,
  // updated when the first page was read, so it reads page 2 too, and stops there.
  assert.deepEqual(pagesAsked({ calls }), [null, 'recent-1', 'recent-2', 'recent-3', null, 'recent-1']);
});
