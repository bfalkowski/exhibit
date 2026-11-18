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
    ]
  });
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
});

test('readHistory keeps a PR merged at exactly the since time', async () => {
  const fetch = replayFetch(fixture('acme-widgets'));
  const lines = await readHistory({ repo: 'acme/widgets', token: 't0ken', fetch, since: new Date('2026-03-01T09:00:00Z') });
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5]);
});
