import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubForge, GitHubReplyError } from '../src/github.js';
import { readHistory } from '../src/history.js';
import { graphqlKey, replayFetch } from '../test-support/replay-fetch.js';
import { graphqlReplies } from './fixtures/github/graphql-replies.js';

// One query for 50 PRs, each with up to 100 files, reviews, comments and CI results, can take
// longer than GitHub's GraphQL time limit on a large repo. GitHub then answers 502 or 504. So the
// list of merged PRs asks again for 25 PRs, then for 10, before the run fails (spec 11).
const REPO = 'acme/large';
const OWNER_AND_NAME = { owner: 'acme', name: 'large' };

function pull(number) {
  const sha = (letter) => letter.repeat(38) + String(number).padStart(2, '0');
  return {
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    body: null,
    author: { __typename: 'User', login: 'dev' },
    mergedAt: new Date(Date.UTC(2026, 9, 1) + number * 3600 * 1000).toISOString(),
    mergeSha: sha('a'),
    baseRef: 'main',
    baseSha: sha('b'),
    headRef: `task/${number}`,
    headSha: sha('c'),
    labels: [],
    files: [{ path: `src/f${number}.js`, additions: 1, deletions: 0 }],
    reviews: [],
    comments: [],
    ci: []
  };
}

// PRs 1 to `count`, newest first.
const pulls = (count) => Array.from({ length: count }, (_, i) => pull(count - i));

// The reply GitHub sends when a query takes too long: a 502, or a 504, with an HTML-free body.
const timedOut = (status) => ({ status, headers: {}, body: { message: status === 502 ? 'Bad Gateway' : 'Gateway Timeout' } });

const pageKey = (after, first) => graphqlKey('MergedPulls', { ...OWNER_AND_NAME, after, first });

function replay(recorded) {
  const file = join(mkdtempSync(join(tmpdir(), 'exhibit-smaller-')), 'replies.json');
  writeFileSync(file, JSON.stringify(recorded));
  return replayFetch(file);
}

// The MergedPulls pages the run asked for, in order, as [after, first].
const pagesAsked = (fetch) => fetch.calls
  .filter((call) => call.key.startsWith('graphql MergedPulls '))
  .map((call) => {
    const { after, first } = JSON.parse(call.key.slice('graphql MergedPulls '.length));
    return [after, first];
  });

const read = (fetch) => readHistory({ forge: createGitHubForge({ repo: REPO, token: 't', fetch }) });

test('after a 502 for 50 PRs, the list asks again for 25 PRs and reads every page with 25', async () => {
  const recorded = graphqlReplies(REPO, pulls(30), { first: 25 });
  recorded[pageKey(null, 50)] = timedOut(502);
  const fetch = replay(recorded);
  const lines = await read(fetch);
  assert.deepEqual(lines.map((line) => line.number), pulls(30).map((one) => one.number));
  assert.deepEqual(pagesAsked(fetch), [[null, 50], [null, 25], ['pulls-1', 25]]);
});

test('after a 502 and then a 504, the list asks for 10 PRs', async () => {
  const recorded = graphqlReplies(REPO, pulls(12), { first: 10 });
  recorded[pageKey(null, 50)] = timedOut(502);
  recorded[pageKey(null, 25)] = timedOut(504);
  const fetch = replay(recorded);
  const lines = await read(fetch);
  assert.equal(lines.length, 12);
  assert.deepEqual(pagesAsked(fetch), [[null, 50], [null, 25], [null, 10], ['pulls-1', 10]]);
});

test('a 502 on a later page asks again from the same cursor with fewer PRs', async () => {
  // Page 1 holds PRs 60 to 11. Page 2, after the cursor pulls-1, gets a 502 for 50 PRs, and then
  // holds PRs 10 to 1 when asked for 25.
  const recorded = graphqlReplies(REPO, pulls(60), { first: 50 });
  recorded[pageKey('pulls-1', 50)] = timedOut(502);
  const rest = graphqlReplies(REPO, pulls(10), { first: 25 });
  recorded[pageKey('pulls-1', 25)] = rest[pageKey(null, 25)];
  const fetch = replay(recorded);
  const lines = await read(fetch);
  assert.equal(lines.length, 60);
  assert.deepEqual(pagesAsked(fetch), [[null, 50], ['pulls-1', 50], ['pulls-1', 25]]);
});

test('when 10 PRs time out too, the run fails with the 502', async () => {
  const recorded = {
    [pageKey(null, 50)]: timedOut(502),
    [pageKey(null, 25)]: timedOut(502),
    [pageKey(null, 10)]: timedOut(502)
  };
  const fetch = replay(recorded);
  await assert.rejects(read(fetch), (error) => error instanceof GitHubReplyError && error.status === 502 && /GitHub answered 502 \(Bad Gateway\)/.test(error.message));
  assert.deepEqual(pagesAsked(fetch), [[null, 50], [null, 25], [null, 10]]);
});

test('a 500 is not a time limit, so the list does not ask again with fewer PRs', async () => {
  const fetch = replay({ [pageKey(null, 50)]: { status: 500, headers: {}, body: { message: 'Server Error' } } });
  await assert.rejects(read(fetch), (error) => error instanceof GitHubReplyError && error.status === 500);
  assert.deepEqual(pagesAsked(fetch), [[null, 50]]);
});

test('with --limit, the list updated last first asks again with fewer PRs too', async () => {
  const recorded = graphqlReplies(REPO, pulls(5), { first: 25 });
  recorded[graphqlKey('RecentMergedPulls', { ...OWNER_AND_NAME, after: null, first: 50 })] = timedOut(504);
  const fetch = replay(recorded);
  const forge = createGitHubForge({ repo: REPO, token: 't', fetch });
  const lines = await readHistory({ forge, limit: 3 });
  assert.deepEqual(lines.map((line) => line.number), [5, 4, 3]);
  const asked = fetch.calls.filter((call) => call.key.startsWith('graphql RecentMergedPulls ')).map((call) => JSON.parse(call.key.slice('graphql RecentMergedPulls '.length)).first);
  assert.deepEqual(asked, [50, 25]);
});
