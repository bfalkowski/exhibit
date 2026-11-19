import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../src/github.js';
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
