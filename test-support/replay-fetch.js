import { readFileSync } from 'node:fs';

// A fetch that replays recorded GitHub API responses from a fixture file instead of using the
// network. The file maps a request to { status, headers, body }. A REST request's key is its path
// and query. A GraphQL query's key is made by graphqlKey: the query's name and its variables. A
// reply with an etag header answers 304 to a request that sends that ETag in If-None-Match. A
// request with no recorded response throws, so a test never passes by accident on a request
// nobody recorded. A file can also name fork repos under FORK_REPOS_KEY: see forkGuard.
export function replayFetch(fixturePath) {
  const { [FORK_REPOS_KEY]: forkRepos, ...recorded } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const guard = forkRepos ? forkGuard(forkRepos) : () => {};
  const calls = [];
  async function fetch(url, init = {}) {
    const key = requestKey(url, init);
    guard(new URL(url).pathname, key);
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

// The key in a replay file that holds { forks, repo }: the fork repos that the test must not ask,
// and the repo to ask in their place. It is not a request key, as those start with "/" or "graphql".
export const FORK_REPOS_KEY = 'fork repos';

// A PR from a fork has its head in the fork's repo, but GitHub keeps its commits in the repo the
// PR merged into, so that repo is the one to ask. This returns a check that throws on a request
// to a fork's repo: to the repo itself, such as /repos/dee/shop, or to a path under it. A repo
// whose name only starts with the fork's name, such as /repos/dee/shopping, passes. GitHub repo
// names ignore case, so the check does too.
export function forkGuard({ forks, repo }) {
  const prefixes = forks.map((fork) => `/repos/${fork}`.toLowerCase());
  return (pathname, key) => {
    const path = pathname.toLowerCase();
    if (prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      throw new Error(`The test asked a fork's repo: ${key}. Ask ${repo}, the repo the PR merged into.`);
    }
  };
}

// The fixture key of a GraphQL query, such as `graphql MergedPulls {"owner":"acme","name":"widgets","after":null,"first":50}`.
export function graphqlKey(name, variables) {
  return `graphql ${name} ${JSON.stringify(variables)}`;
}

function requestKey(url, init) {
  const { pathname, search } = new URL(url);
  if (init.method !== 'POST' || pathname !== '/graphql') return pathname + search;
  const { query, variables } = JSON.parse(init.body);
  return graphqlKey(/^\s*query\s+(\w+)/.exec(query)[1], variables);
}
