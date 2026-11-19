import { readFileSync } from 'node:fs';

// A fetch that replays recorded GitHub API responses from a fixture file instead of using the
// network. The file maps a request's path and query to { status, headers, body }. A request with
// no recorded response throws, so a test never passes by accident on a request nobody recorded.
export function replayFetch(fixturePath) {
  const recorded = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const calls = [];
  async function fetch(url, init = {}) {
    const { pathname, search } = new URL(url);
    const key = pathname + search;
    calls.push({ key, headers: { ...init.headers } });
    const reply = recorded[key];
    if (!reply) throw new Error(`replay-fetch: no recorded response for ${key} in ${fixturePath}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers }
    });
  }
  fetch.calls = calls;
  return fetch;
}
