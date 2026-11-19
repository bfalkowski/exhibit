import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readHistory } from '../src/history.js';
import { replayFetch } from '../test-support/replay-fetch.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/github/${name}.json`, import.meta.url));

test('readHistory follows every page and returns each merged PR once, newest merge first', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch });
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5, 3, 1]);
});

test('readHistory leaves out PRs that were closed without merging', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  const numbers = lines.map((l) => l.number);
  assert.ok(!numbers.includes(6));
  assert.ok(!numbers.includes(2));
});

test('readHistory fills the spec 8.3 fields, with files from every page of the files list', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  const pr7 = lines.find((l) => l.number === 7);
  assert.deepEqual(pr7, {
    number: 7,
    title: 'Add the widget cache',
    body: 'Body of #7.',
    author: 'dev7',
    labels: ['feature', 'cache'],
    merged_at: '2026-03-05T12:00:00Z',
    base_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb7',
    merge_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7',
    files: [
      { path: 'src/cache.js', additions: 120, deletions: 0 },
      { path: 'src/widget.js', additions: 8, deletions: 3 },
      { path: 'test/cache.test.js', additions: 64, deletions: 0 }
    ],
    reviews: {
      change_request_rounds: 2,
      list: [
        { state: 'CHANGES_REQUESTED', author: 'rev1' },
        { state: 'COMMENTED', author: 'dev7' },
        { state: 'CHANGES_REQUESTED', author: 'rev1' },
        { state: 'APPROVED', author: 'rev2' }
      ]
    },
    ci: [
      { name: 'lint', conclusion: 'success' },
      { name: 'test', conclusion: 'failure' },
      { name: 'Secret scan', conclusion: 'success' }
    ]
  });
});

test('a PR with no reviews gets an empty list and zero rounds', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  assert.deepEqual(lines.find((l) => l.number === 5).reviews, { change_request_rounds: 0, list: [] });
});

test('a PR with two change requests and one approval gets two rounds', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  assert.equal(lines.find((l) => l.number === 7).reviews.change_request_rounds, 2);
});

test('a dismissed change request is not a round, and a deleted reviewer is null', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  assert.equal(lines.find((l) => l.number === 4).reviews.change_request_rounds, 0);
  assert.deepEqual(lines.find((l) => l.number === 3).reviews.list, [{ state: 'APPROVED', author: null }]);
});

test('a PR with no check runs gets an empty ci list', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  assert.deepEqual(lines.find((l) => l.number === 5).ci, []);
});

test('ci has the check runs from every page, read from the head commit', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch });
  assert.deepEqual(lines.find((l) => l.number === 7).ci.map((c) => c.name), ['lint', 'test', 'Secret scan']);
  assert.ok(fetch.calls.some((c) => c.key === `/repos/acme/widgets/commits/${'c'.repeat(39)}7/check-runs?per_page=100`));
});

test('a check run that has not finished has a null conclusion', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  assert.deepEqual(lines.find((l) => l.number === 1).ci, [{ name: 'test', conclusion: null }]);
});

test('readHistory keeps a null body and a deleted author as null', async () => {
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch: replayFetch(fixture('acme-widgets')) });
  assert.equal(lines.find((l) => l.number === 5).body, null);
  assert.equal(lines.find((l) => l.number === 3).author, null);
});

test('readHistory sends the token on every request', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch });
  assert.ok(fetch.calls.length > 0);
  for (const call of fetch.calls) assert.equal(call.headers.authorization, 'Bearer t0ken');
});

test('readHistory with since and limit asks for the files of the kept PRs only', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch, since: new Date('2026-03-01T00:00:00Z'), limit: 2 });
  assert.deepEqual(lines.map((l) => l.number), [7, 4]);
  const fileCalls = fetch.calls.filter((c) => c.key.includes('/files'));
  assert.deepEqual(fileCalls.map((c) => c.key.match(/pulls\/(\d+)/)[1]).sort(), ['4', '7', '7']);
  const otherCalls = fetch.calls.filter((c) => c.key.includes('/reviews') || c.key.includes('/check-runs'));
  assert.ok(otherCalls.every((c) => /(pulls\/|c{39})[47]\b/.test(c.key)), otherCalls.map((c) => c.key).join(', '));
});

test('readHistory keeps a PR merged at exactly the since time', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch, since: new Date('2026-03-01T09:00:00Z') });
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5]);
});

test('readHistory turns a GitHub reply that is not a list into a tool error', async () => {
  const { ToolError } = await import('../src/tool-error.js');
  const notJson = async () => new Response('<html>oops</html>', { status: 200 });
  const notList = async () => new Response('{"message":"hi"}', { status: 200 });
  for (const fetch of [notJson, notList]) {
    await assert.rejects(readHistory({ repo: 'acme/widgets', token: 't', fetch }), (error) => error instanceof ToolError && /not a JSON list/.test(error.message));
  }
});

test('readHistory warns when a PR changed more files than GitHub listed, and only then asks for the PR', async () => {
  const { writeBigFixture } = await import('./fixtures/github/acme-big.js');
  const fetch = replayFetch(writeBigFixture());
  const warnings = [];
  const lines = await readHistory({ repo: 'acme/big', token: 't', fetch, warn: (text) => warnings.push(text) });

  assert.deepEqual(lines.map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
  assert.deepEqual(warnings, ['PR 9 changed 3412 files, but GitHub listed only the first 3000, so its files field is cut short.']);
  const prCalls = fetch.calls.filter((c) => /\/pulls\/\d+$/.test(c.key)).map((c) => c.key);
  assert.deepEqual(prCalls.sort(), ['/repos/acme/big/pulls/8', '/repos/acme/big/pulls/9']);
});

test('getOne turns a reply that is not a JSON object into a tool error', async () => {
  const { createGitHub } = await import('../src/github.js');
  const { ToolError } = await import('../src/tool-error.js');
  for (const text of ['[]', 'null', '<html>oops</html>']) {
    const github = createGitHub({ token: 't', fetch: async () => new Response(text, { status: 200 }) });
    await assert.rejects(github.getOne('/repos/acme/big/pulls/9'), (error) => error instanceof ToolError && /not a JSON object/.test(error.message), text);
  }
});
