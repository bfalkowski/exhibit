import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGitHubForge } from '../src/github.js';
import { readHistory } from '../src/history.js';
import { replayFetch } from '../test-support/replay-fetch.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/github/${name}.json`, import.meta.url));

test('readHistory follows every page and returns each merged PR once, newest merge first', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch }) });
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5, 3, 1]);
});

test('readHistory leaves out PRs that were closed without merging', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  const numbers = lines.map((l) => l.number);
  assert.ok(!numbers.includes(6));
  assert.ok(!numbers.includes(2));
});

test('readHistory fills the spec 8.3 fields, with files from every page of the files list', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  const pr7 = lines.find((l) => l.number === 7);
  assert.deepEqual(pr7, {
    number: 7,
    title: 'Add the widget cache',
    body: 'Body of #7.',
    author: 'dev7',
    labels: ['feature', 'cache'],
    merged_at: '2026-03-05T12:00:00Z',
    base_ref: 'main',
    base_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb7',
    merge_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7',
    files: [
      { path: 'src/cache.js', additions: 120, deletions: 0 },
      { path: 'src/widget.js', additions: 8, deletions: 3 },
      { path: 'test/cache.test.js', additions: 64, deletions: 0 }
    ],
    reviews: {
      change_request_rounds: 3,
      list: [
        { state: 'CHANGES_REQUESTED', author: 'rev3', source: 'comment' },
        { state: 'CHANGES_REQUESTED', author: 'rev1', source: 'review' },
        { state: 'COMMENTED', author: 'dev7', source: 'review' },
        { state: 'CHANGES_REQUESTED', author: 'rev1', source: 'review' },
        { state: 'APPROVED', author: 'rev2', source: 'review' },
        { state: 'APPROVED', author: 'rev3', source: 'comment' }
      ]
    },
    ci: [
      { name: 'lint', conclusion: 'success' },
      { name: 'test', conclusion: 'failure' },
      { name: 'Secret scan', conclusion: 'success' }
    ],
    classification: { fix: false, fix_signal: null }
  });
});

test('a PR with no reviews gets an empty list and zero rounds', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  assert.deepEqual(lines.find((l) => l.number === 5).reviews, { change_request_rounds: 0, list: [] });
});

test('a PR with two change requests and one approval gets two rounds from its reviews', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  const fromReviews = lines.find((l) => l.number === 7).reviews.list.filter((r) => r.source === 'review');
  assert.equal(fromReviews.filter((r) => r.state === 'CHANGES_REQUESTED').length, 2);
});

test('a review posted as a PR comment with the verdict fix is a round', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  assert.deepEqual(lines.find((l) => l.number === 1).reviews, {
    change_request_rounds: 1,
    list: [{ state: 'CHANGES_REQUESTED', author: 'rev3', source: 'comment' }]
  });
});

test('comment reviews come from every page, in time order with the reviews, and other comments are left out', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch }) });
  const pr7 = lines.find((l) => l.number === 7).reviews;
  // The Dev's reply says "Verdict fix" but starts with an office marker, and the CI note has no
  // verdict, so neither is in the list.
  assert.deepEqual(pr7.list.filter((r) => r.source === 'comment'), [
    { state: 'CHANGES_REQUESTED', author: 'rev3', source: 'comment' },
    { state: 'APPROVED', author: 'rev3', source: 'comment' }
  ]);
  assert.equal(pr7.change_request_rounds, 3);
  assert.ok(fetch.calls.some((c) => c.key === '/repositories/4242/issues/7/comments?per_page=100&page=2'));
});

test('a dismissed change request is not a round, and a deleted reviewer is null', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  assert.equal(lines.find((l) => l.number === 4).reviews.change_request_rounds, 0);
  assert.deepEqual(lines.find((l) => l.number === 3).reviews.list, [{ state: 'APPROVED', author: null, source: 'review' }]);
});

test('a PR with no check runs gets an empty ci list', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  assert.deepEqual(lines.find((l) => l.number === 5).ci, []);
});

test('ci has the check runs from every page, read from the head commit', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch }) });
  assert.deepEqual(lines.find((l) => l.number === 7).ci.map((c) => c.name), ['lint', 'test', 'Secret scan']);
  assert.ok(fetch.calls.some((c) => c.key === `/repos/acme/widgets/commits/${'c'.repeat(39)}7/check-runs?per_page=100`));
});

test('ci also has the commit statuses on the head commit, after the check runs', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch }) });
  assert.deepEqual(lines.find((l) => l.number === 4).ci, [
    { name: 'test', conclusion: 'success' },
    { name: 'buildkite/widgets', conclusion: 'success' },
    { name: 'deploy/preview', conclusion: 'error' },
    { name: 'ci/legacy', conclusion: null }
  ]);
  assert.ok(fetch.calls.some((c) => c.key === `/repos/acme/widgets/commits/${'c'.repeat(39)}4/status?per_page=100`));
});

test('a check run that has not finished has a null conclusion', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  assert.deepEqual(lines.find((l) => l.number === 1).ci, [{ name: 'test', conclusion: null }]);
});

test('readHistory keeps a null body and a deleted author as null', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  assert.equal(lines.find((l) => l.number === 5).body, null);
  assert.equal(lines.find((l) => l.number === 3).author, null);
});

test('readHistory sends the token on every request', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch }) });
  assert.ok(fetch.calls.length > 0);
  for (const call of fetch.calls) assert.equal(call.headers.authorization, 'Bearer t0ken');
});

test('readHistory with since and limit asks for the files of the kept PRs only', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch }), since: new Date('2026-03-01T00:00:00Z'), limit: 2 });
  assert.deepEqual(lines.map((l) => l.number), [7, 4]);
  const fileCalls = fetch.calls.filter((c) => c.key.includes('/files'));
  assert.deepEqual(fileCalls.map((c) => c.key.match(/pulls\/(\d+)/)[1]).sort(), ['4', '7', '7']);
  const otherCalls = fetch.calls.filter((c) => c.key.includes('/reviews') || c.key.includes('/comments') || c.key.includes('/check-runs'));
  assert.ok(otherCalls.every((c) => /(pulls\/|issues\/|c{39})[47]\b/.test(c.key)), otherCalls.map((c) => c.key).join(', '));
});

test('readHistory keeps a PR merged at exactly the since time', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch }), since: new Date('2026-03-01T09:00:00Z') });
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5]);
});

test('readHistory turns a GitHub reply that is not a list into a tool error', async () => {
  const { ToolError } = await import('../src/tool-error.js');
  const notJson = async () => new Response('<html>oops</html>', { status: 200 });
  const notList = async () => new Response('{"message":"hi"}', { status: 200 });
  for (const fetch of [notJson, notList]) {
    await assert.rejects(readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't', fetch }) }), (error) => error instanceof ToolError && /not a JSON list/.test(error.message));
  }
});

test('readHistory marks fix PRs with the default signals when it gets none', async () => {
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }) });
  assert.deepEqual(lines.map((l) => [l.number, l.classification]), [
    [7, { fix: false, fix_signal: null }],
    [4, { fix: false, fix_signal: null }],
    [5, { fix: true, fix_signal: 'label:bug' }],
    [3, { fix: false, fix_signal: null }],
    [1, { fix: false, fix_signal: null }]
  ]);
});

test('readHistory matches a branch signal against the PR head branch', async () => {
  const fixSignals = ['branch:topic-4', 'title:update'];
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }), fixSignals });
  assert.deepEqual(lines.filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [
    [4, 'branch:topic-4'],
    [3, 'title:update']
  ]);
});

test('readHistory warns when a PR changed more files than GitHub listed, and only then asks for the PR', async (t) => {
  const { writeBigFixture } = await import('./fixtures/github/acme-big.js');
  const big = writeBigFixture();
  t.after(big.cleanup);
  const fetch = replayFetch(big.path);
  const warnings = [];
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/big', token: 't', fetch }), warn: (text) => warnings.push(text) });

  assert.deepEqual(lines.map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
  assert.deepEqual(warnings, ['PR 9 changed 3412 files, but GitHub listed only the first 3000, so its files field is cut short.']);
  const prCalls = fetch.calls.filter((c) => /\/pulls\/\d+$/.test(c.key)).map((c) => c.key);
  assert.deepEqual(prCalls.sort(), ['/repos/acme/big/pulls/8', '/repos/acme/big/pulls/9']);
});

test('readHistory warns that the count is unknown, and goes on, when the request for one PR fails', async (t) => {
  const { writeBigFixture } = await import('./fixtures/github/acme-big.js');
  const big = writeBigFixture({ unreadable: [9] });
  t.after(big.cleanup);
  const warnings = [];
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/big', token: 't', fetch: replayFetch(big.path) }), warn: (text) => warnings.push(text) });

  assert.deepEqual(lines.map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
  assert.deepEqual(warnings, [
    'PR 9 has 3000 files listed, the most GitHub lists, so its files field may be cut short. Exhibit could not read how many files it changed: GitHub answered 500 (Server Error) for /repos/acme/big/pulls/9. GitHub had a problem: try again later.'
  ]);
});

test('getOne turns a reply that is not a JSON object into a tool error', async () => {
  const { createGitHub } = await import('../src/github.js');
  const { ToolError } = await import('../src/tool-error.js');
  for (const text of ['[]', 'null', '<html>oops</html>']) {
    const github = createGitHub({ token: 't', fetch: async () => new Response(text, { status: 200 }) });
    await assert.rejects(github.getOne('/repos/acme/big/pulls/9'), (error) => error instanceof ToolError && /not a JSON object/.test(error.message), text);
  }
});

test('readHistory warns about a comment whose only verdict is in a quoted line, and leaves it out', async () => {
  const warnings = [];
  const lines = await readHistory({ forge: createGitHubForge({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) }), warn: (text) => warnings.push(text) });
  assert.deepEqual(lines.find((l) => l.number === 5).reviews, { change_request_rounds: 0, list: [] });
  assert.deepEqual(warnings, [
    'PR 5: the comment by dev5 at 2026-02-20T10:00:00Z gives the verdict fix only in a quoted line, so it does not count as a review.'
  ]);
});
