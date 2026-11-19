import { readFileSync } from 'node:fs';

// A fetch that replays recorded GitHub API responses from a fixture file instead of using the
// network. The file maps a request to { status, headers, body }. A REST request's key is its path
// and query. A GraphQL query's key is made by graphqlKey: the query's name and its variables. A
// reply with an etag header answers 304 to a request that sends that ETag in If-None-Match. A
// request with no recorded response throws, so a test never passes by accident on a request
// nobody recorded.
export function replayFetch(fixturePath) {
  const recorded = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const calls = [];
  async function fetch(url, init = {}) {
    const key = requestKey(url, init);
    calls.push({ key, headers: { ...init.headers } });
    const reply = recorded[key];
    if (!reply) throw new Error(`replay-fetch: no recorded response for ${key} in ${fixturePath}`);
    // Like GitHub, a request whose If-None-Match equals the reply's ETag gets a 304 with no body.
    const etag = reply.headers?.etag;
    if (etag !== undefined && init.headers?.['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers }
    });
  }
  fetch.calls = calls;
  return fetch;
}

// The fixture key of a GraphQL query, such as `graphql MergedPulls {"owner":"acme","name":"widgets","after":null}`.
export function graphqlKey(name, variables) {
  return `graphql ${name} ${JSON.stringify(variables)}`;
}

function requestKey(url, init) {
  const { pathname, search } = new URL(url);
  if (init.method !== 'POST' || pathname !== '/graphql') return pathname + search;
  const { query, variables } = JSON.parse(init.body);
  return graphqlKey(/^\s*query\s+(\w+)/.exec(query)[1], variables);
}
