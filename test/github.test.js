import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, createGitHubForge } from '../src/github.js';
import { ToolError } from '../src/tool-error.js';

// A fetch that gives the replies in order, and a sleep that records how long it was asked to wait.
function scripted(replies) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const { status, headers = {}, body } = replies.shift();
    return new Response(JSON.stringify(body), { status, headers });
  };
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  return { fetch, sleep, calls, waits };
}

test('getAll reads the list out of an object reply when told which field holds it', async () => {
  const s = scripted([{ status: 200, body: { total_count: 1, check_runs: [{ name: 'test' }] } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  assert.deepEqual(await github.getAll('/x', { listField: 'check_runs' }), [{ name: 'test' }]);
});

test('a 429 with retry-after waits that many seconds, then asks again', async () => {
  const s = scripted([
    { status: 429, headers: { 'retry-after': '7' }, body: { message: 'slow down' } },
    { status: 200, body: [1, 2] }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  assert.deepEqual(await github.getAll('/x'), [1, 2]);
  assert.deepEqual(s.waits, [7000]);
  assert.equal(s.calls.length, 2);
});

test('getOne waits on a 429 with retry-after, then asks again and returns the object', async () => {
  const s = scripted([
    { status: 429, headers: { 'retry-after': '2' }, body: { message: 'slow down' } },
    { status: 200, body: { number: 9, title: 'Add a thing' } }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  assert.deepEqual(await github.getOne('/repos/o/r/pulls/9'), { number: 9, title: 'Add a thing' });
  assert.deepEqual(s.waits, [2000]);
  assert.equal(s.calls.length, 2);
});

test('getOne does not wait an hour for a retry-after: it fails with a tool error', async () => {
  const s = scripted([{ status: 429, headers: { 'retry-after': '3600' }, body: { message: 'slow down' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(github.getOne('/repos/o/r/pulls/9'), (error) => error instanceof ToolError && /429/.test(error.message) && /rate limit/.test(error.message));
  assert.deepEqual(s.waits, []);
  assert.equal(s.calls.length, 1);
});

test('a 403 with no requests left waits until the reset time, then asks again', async () => {
  const s = scripted([
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' }, body: { message: 'rate limit' } },
    { status: 200, body: [1] }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, now: () => 990_000 });
  assert.deepEqual(await github.getAll('/x'), [1]);
  assert.deepEqual(s.waits, [11_000], 'ten seconds to the reset, plus one');
});

test('a 403 that is not a rate limit fails at once', async () => {
  const s = scripted([{ status: 403, body: { message: 'Resource not accessible' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(github.getAll('/x'), (error) => error instanceof ToolError && /403/.test(error.message));
  assert.deepEqual(s.waits, []);
});

test('it stops after three waits and says the rate limit is used up', async () => {
  const limited = { status: 429, headers: { 'retry-after': '1' }, body: {} };
  const s = scripted([limited, limited, limited, limited]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(github.getAll('/x'), (error) => error instanceof ToolError && /429/.test(error.message) && /rate limit/.test(error.message));
  assert.equal(s.waits.length, 3);
});

test('it does not wait longer than 15 minutes for a reset', async () => {
  const s = scripted([{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5000' }, body: {} }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, now: () => 0 });
  await assert.rejects(github.getAll('/x'), (error) => error instanceof ToolError && /rate limit/.test(error.message));
  assert.deepEqual(s.waits, []);
});

test('a 403 for a secondary rate limit with no wait headers waits one minute, then asks again', async () => {
  const s = scripted([
    { status: 403, headers: { 'x-ratelimit-remaining': '4000' }, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } },
    { status: 200, body: [1] }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0 });
  assert.deepEqual(await github.getAll('/x'), [1]);
  assert.deepEqual(s.waits, [60_000]);
});

test('it stops after three waits for a secondary rate limit', async () => {
  const limited = { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } };
  const s = scripted([limited, limited, limited, limited]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0 });
  await assert.rejects(github.getAll('/x'), (error) => error instanceof ToolError && /403/.test(error.message) && /secondary rate limit/.test(error.message));
  assert.deepEqual(s.waits, [60_000, 120_000, 240_000]);
});

test('a retry-after given as an HTTP date waits until that time, then asks again', async () => {
  const s = scripted([
    { status: 429, headers: { 'retry-after': 'Thu, 19 Nov 2026 10:00:30 GMT' }, body: {} },
    { status: 200, body: [1] }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, now: () => Date.parse('2026-11-19T10:00:00Z') });
  assert.deepEqual(await github.getAll('/x'), [1]);
  assert.deepEqual(s.waits, [30_000]);
});

test('a retry-after date that has passed asks again at once', async () => {
  const s = scripted([
    { status: 429, headers: { 'retry-after': 'Thu, 19 Nov 2026 09:59:00 GMT' }, body: {} },
    { status: 200, body: [1] }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, now: () => Date.parse('2026-11-19T10:00:00Z') });
  assert.deepEqual(await github.getAll('/x'), [1]);
  assert.deepEqual(s.waits, [0]);
});

test('a retry-after that is not whole seconds or an HTTP date is no retry-after', async () => {
  // Date.parse('1.5') gives a date in 2001. Read as a date, it would make the client ask again at once.
  const s = scripted([{ status: 429, headers: { 'retry-after': '1.5' }, body: { message: 'slow down' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, now: () => Date.parse('2026-11-19T10:00:00Z') });
  await assert.rejects(github.getAll('/x'), (error) => error instanceof ToolError && /429/.test(error.message));
  assert.deepEqual(s.waits, []);
});

test('each wait for a secondary rate limit is twice the one before, plus a random spread', async () => {
  const limited = { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } };
  const s = scripted([limited, limited, limited, { status: 200, body: [1] }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0.5 });
  assert.deepEqual(await github.getAll('/x'), [1]);
  // 60, 120 and 240 seconds, each plus half of the most spread: a quarter of that wait.
  assert.deepEqual(s.waits, [67_500, 135_000, 270_000]);
});

test('a 403 that is not a rate limit names the permission the request needs', async () => {
  const s = scripted([{ status: 403, body: { message: 'Resource not accessible by personal access token' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(
    github.getAll('/repos/o/r/commits/abc/status', { listField: 'statuses', permission: 'Commit statuses: read' }),
    (error) => error instanceof ToolError && /403/.test(error.message) && /"Commit statuses: read"/.test(error.message)
  );
});

test('a rate limit that is still there after three waits does not blame a missing permission', async () => {
  const limited = { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } };
  const s = scripted([limited, limited, limited, limited]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0 });
  await assert.rejects(
    github.getAll('/x', { permission: 'Pull requests: read' }),
    (error) => error instanceof ToolError && /secondary rate limit/.test(error.message) && !/permission/.test(error.message)
  );
});

test('a 403 rate limit that asks for too long a wait does not blame a missing permission', async () => {
  const s = scripted([{ status: 403, headers: { 'retry-after': '3600' }, body: { message: 'API rate limit exceeded' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(github.getAll('/x', { permission: 'Pull requests: read' }), (error) => error instanceof ToolError && !/permission/.test(error.message));
});

test('a 429 never blames a missing permission', async () => {
  const s = scripted([{ status: 429, headers: { 'retry-after': '1.5' }, body: { message: 'slow down' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(github.getAll('/x', { permission: 'Pull requests: read' }), (error) => error instanceof ToolError && !/permission/.test(error.message));
});

test('only secondary-limit waits count toward the longer wait', async () => {
  const s = scripted([
    { status: 429, headers: { 'retry-after': '5' }, body: {} },
    { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } },
    { status: 200, body: [1] }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0 });
  assert.deepEqual(await github.getAll('/x'), [1]);
  assert.deepEqual(s.waits, [5_000, 60_000]);
});

test('the GitHub forge gives CI results in one shape: check runs first, then commit statuses, each with a URL', async () => {
  const { fileURLToPath } = await import('node:url');
  const { replayFetch } = await import('../test-support/replay-fetch.js');
  const fetch = replayFetch(fileURLToPath(new URL('./fixtures/github/acme-widgets.json', import.meta.url)));
  const forge = createGitHubForge({ repo: 'acme/widgets', token: 't', fetch });
  assert.deepEqual(await forge.ciResults('c'.repeat(39) + '4'), [
    { name: 'test', conclusion: 'success', url: 'https://github.com/acme/widgets/runs/41' },
    { name: 'buildkite/widgets', conclusion: 'success', url: 'https://buildkite.com/acme/widgets/builds/401' },
    { name: 'deploy/preview', conclusion: 'error', url: 'https://buildkite.com/acme/widgets/builds/402' },
    { name: 'ci/legacy', conclusion: null, url: 'https://buildkite.com/acme/widgets/builds/403' }
  ]);
  // A check run with no html_url gives a null URL.
  assert.deepEqual((await forge.ciResults('c'.repeat(39) + '1')), [{ name: 'test', conclusion: null, url: null }]);
});
