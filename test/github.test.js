import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGitHub, createGitHubForge, GitHubReplyError, GITHUB_FORGE, PERMISSIONS } from '../src/github.js';
import { ToolError } from '../src/tool-error.js';
import { replayFetch } from '../test-support/replay-fetch.js';

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

test('a write that is still a secondary rate limit after three waits says the rate limit is used up, not to check the token', async () => {
  const limited = { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } };
  const s = scripted([limited, limited, limited, limited]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0 });
  await assert.rejects(github.write('POST', '/x', { body: 'text' }, { permission: 'Pull requests: write' }), (error) => {
    assert.equal(error.message, 'GitHub answered 403 (You have exceeded a secondary rate limit.) for /x. GitHub\'s rate limit is used up: wait and try again.');
    return true;
  });
  assert.deepEqual(s.waits, [60_000, 120_000, 240_000]);
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

test('a 403 rate limit that asks for too long a wait does not blame a missing permission', async () => {
  const s = scripted([{ status: 403, headers: { 'retry-after': '3600' }, body: { message: 'API rate limit exceeded' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(github.getAll('/x', { permission: PERMISSIONS.pullRequests }), (error) => error instanceof ToolError && !/permission/.test(error.message));
});

test('a rate limit that is still there after the waits says so, and does not tell you to check the token', async () => {
  const limited = { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } };
  const s = scripted([limited, limited, limited, limited]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0 });
  await assert.rejects(
    github.getAll('/x', { permission: PERMISSIONS.pullRequests }),
    (error) => error instanceof ToolError && error.message === "GitHub answered 403 (You have exceeded a secondary rate limit.) for /x. GitHub's rate limit is used up: wait and try again."
  );
});

test('a 429 says the rate limit is used up, even when it names no wait', async () => {
  const s = scripted([{ status: 429, body: { message: 'slow down' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(
    github.getAll('/x'),
    (error) => error instanceof ToolError && error.message === "GitHub answered 429 (slow down) for /x. GitHub's rate limit is used up: wait and try again."
  );
});

test('a 403 that is not a rate limit keeps the text that names both causes', async () => {
  const s = scripted([{ status: 403, body: { message: 'Resource not accessible' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(
    github.getAll('/x', { permission: PERMISSIONS.pullRequests }),
    (error) => error instanceof ToolError && error.message === 'GitHub answered 403 (Resource not accessible) for /x. The token may lack access, or the rate limit is used up: check the token, or wait and try again. A fine-grained GITHUB_TOKEN needs the permission "Pull requests: read" for this request.'
  );
});

test('a 429 never blames a missing permission', async () => {
  const s = scripted([{ status: 429, headers: { 'retry-after': '1.5' }, body: { message: 'slow down' } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(github.getAll('/x', { permission: PERMISSIONS.pullRequests }), (error) => error instanceof ToolError && !/permission/.test(error.message));
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

const widgets = () => replayFetch(fileURLToPath(new URL('./fixtures/github/acme-widgets.json', import.meta.url)));

test('the GitHub forge module holds its static rules: the repo name check, the token and how to connect', () => {
  assert.equal(GITHUB_FORGE.name, 'github');
  assert.equal(GITHUB_FORGE.displayName, 'GitHub');
  assert.equal(GITHUB_FORGE.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(GITHUB_FORGE.tokenExample, 'GITHUB_TOKEN=$(gh auth token)');
  assert.equal(GITHUB_FORGE.isRepoName('bfalkowski/Building58'), true);
  assert.equal(GITHUB_FORGE.isRepoName('not a repo'), false);
  const forge = GITHUB_FORGE.connect({ repo: 'acme/widgets', token: 't', fetch: widgets() });
  assert.equal(forge.name, 'github');
  assert.equal(forge.displayName, 'GitHub');
  assert.equal(forge.repo, 'acme/widgets');
});

test('the GitHub forge gives CI results in one shape: check runs first, then commit statuses, each with a URL', async () => {
  const forge = createGitHubForge({ repo: 'acme/widgets', token: 't', fetch: widgets() });
  await forge.mergedPulls();
  assert.deepEqual(await forge.ciResults('c'.repeat(39) + '4'), [
    { name: 'test', conclusion: 'success', url: 'https://github.com/acme/widgets/runs/41' },
    { name: 'buildkite/widgets', conclusion: 'success', url: 'https://buildkite.com/acme/widgets/builds/401' },
    { name: 'deploy/preview', conclusion: 'error', url: 'https://buildkite.com/acme/widgets/builds/402' },
    { name: 'ci/legacy', conclusion: null, url: 'https://buildkite.com/acme/widgets/builds/403' }
  ]);
  // A check run with no URL gives a null URL.
  assert.deepEqual((await forge.ciResults('c'.repeat(39) + '1')), [{ name: 'test', conclusion: null, url: null }]);
});

test('the GitHub forge gives PRs, files, reviews and comments in forge-neutral shapes', async () => {
  const forge = createGitHubForge({ repo: 'acme/widgets', token: 't', fetch: await widgets() });
  const merged = await forge.mergedPulls();
  assert.deepEqual(merged[0], {
    number: 7,
    title: 'Add the widget cache',
    body: 'Body of #7.',
    author: 'dev7',
    labels: ['feature', 'cache'],
    mergedAt: '2026-03-05T12:00:00Z',
    baseRef: 'main',
    baseSha: 'b'.repeat(39) + '7',
    headRef: 'topic-7',
    headSha: 'c'.repeat(39) + '7',
    mergeSha: 'a'.repeat(39) + '7',
    url: 'https://github.com/acme/widgets/pull/7'
  });
  // An empty body is null, and a deleted account is a null author.
  assert.deepEqual([merged[1].body, merged[3].author], [null, null]);
  assert.deepEqual((await forge.pullFiles(7))[0], { path: 'src/cache.js', additions: 120, deletions: 0 });
  assert.deepEqual((await forge.pullReviews(7))[0], { state: 'CHANGES_REQUESTED', author: 'rev1', at: '2026-03-01T00:00:00Z' });
  const comments = await forge.pullComments(7);
  assert.deepEqual(Object.keys(comments[0]), ['body', 'author', 'at']);
  assert.deepEqual([comments[0].author, comments[0].at, comments[3].author], ['rev3', '2026-02-28T10:00:00Z', null]);
});

test('the GitHub forge gives the PRs of a commit, one PR and an issue in forge-neutral shapes', async () => {
  const restPull = {
    number: 9, title: 'Fix it', body: null, user: { login: 'dev9' }, labels: [{ name: 'bug' }], merged_at: '2026-04-01T00:00:00Z',
    base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'fix-9', sha: 'c'.repeat(40) }, merge_commit_sha: 'a'.repeat(40),
    html_url: 'https://github.com/acme/widgets/pull/9'
  };
  const replies = {
    '/repos/acme/widgets/commits/abc/pulls': [restPull, { ...restPull, number: 10, user: null, merged_at: null, merge_commit_sha: 'd'.repeat(40) }],
    '/repos/acme/widgets/pulls/9': restPull,
    '/repos/acme/widgets/issues/50': { number: 50, created_at: '2026-01-05T09:30:00Z' },
    '/repos/acme/widgets/issues/51': { number: 51, created_at: '2026-01-06T09:30:00Z', pull_request: {} }
  };
  const fetch = async (url) => {
    const reply = replies[new URL(url).pathname];
    return new Response(JSON.stringify(reply ?? { message: 'Not Found' }), { status: reply ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  const forge = createGitHubForge({ repo: 'acme/widgets', token: 't', fetch });
  const nine = {
    number: 9, title: 'Fix it', body: null, author: 'dev9', labels: ['bug'], mergedAt: '2026-04-01T00:00:00Z',
    baseRef: 'main', baseSha: 'b'.repeat(40), headRef: 'fix-9', headSha: 'c'.repeat(40), mergeSha: 'a'.repeat(40),
    url: 'https://github.com/acme/widgets/pull/9'
  };
  assert.deepEqual(await forge.pullsForCommit('abc'), [nine, { ...nine, number: 10, author: null, mergedAt: null, mergeSha: null }]);
  assert.deepEqual(await forge.pull(9), nine);
  assert.deepEqual(await forge.issue(50), { createdAt: '2026-01-05T09:30:00Z', isPull: false });
  assert.deepEqual(await forge.issue(51), { createdAt: '2026-01-06T09:30:00Z', isPull: true });
  assert.equal(await forge.issue(52), null);
});

test('sameRepo says whether a repo name leads to this repo, as an old name does after a rename or a transfer', async () => {
  // GitHub answers GET /repos/{old name} with a redirect to the repo, and fetch follows it, so the
  // reply is the renamed repo. The id stays the same after a rename or a transfer.
  const replies = {
    '/repos/acme/widgets': { id: 7, full_name: 'acme/widgets', default_branch: 'main' },
    '/repos/oldacme/widgets': { id: 7, full_name: 'acme/widgets' },
    '/repos/acme/gadgets': { id: 8, full_name: 'acme/gadgets' }
  };
  const asked = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const reply = replies[path];
    return new Response(JSON.stringify(reply ?? { message: 'Not Found' }), { status: reply ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  const forge = createGitHubForge({ repo: 'acme/widgets', token: 't', fetch });
  assert.equal(await forge.sameRepo('oldacme/widgets'), true);
  assert.equal(await forge.sameRepo('acme/gadgets'), false);
  // A name GitHub does not know, or a private repo the token cannot read, is not this repo.
  assert.equal(await forge.sameRepo('gone/widgets'), false);
  // Each name costs one request at most, in any case, and this repo is read once, for defaultBranch too.
  assert.equal(await forge.sameRepo('OldAcme/Widgets'), true);
  assert.equal(await forge.sameRepo('acme/gadgets'), false);
  assert.equal(await forge.defaultBranch(), 'main');
  assert.deepEqual(asked, ['/repos/oldacme/widgets', '/repos/acme/widgets', '/repos/acme/gadgets', '/repos/gone/widgets']);
});

test('sameRepo: a repo the token cannot read is another repo, and only a refused token or a rate limit stops the run', async () => {
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  // A reset far away, so the client does not wait for it and the reply stays a rate limit.
  const farReset = String(Math.floor(Date.now() / 1000) + 3600);
  let flaky = 0;
  const replies = {
    '/repos/acme/widgets': () => json(200, { id: 7, full_name: 'acme/widgets' }),
    '/repos/samlorg/private': () => json(403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-ratelimit-remaining': '4999' }),
    '/repos/blocked/repo': () => json(451, { message: 'Repository access blocked' }),
    '/repos/limited/repo': () => json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': farReset }),
    '/repos/many/requests': () => json(429, { message: 'Too many requests' }, { 'retry-after': '3600' }),
    '/repos/refused/token': () => json(401, { message: 'Bad credentials' }),
    // A 502 first, then the old name of this repo.
    '/repos/oldacme/widgets': () => (flaky++ === 0 ? json(502, { message: 'Server Error' }) : json(200, { id: 7, full_name: 'acme/widgets' }))
  };
  const asked = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    return replies[path]();
  };
  const forge = createGitHubForge({ repo: 'acme/widgets', token: 't', fetch, sleep: async () => {} });
  // A private repo behind SAML SSO (403, not a rate limit) and a repo blocked for legal reasons
  // (451) are other repos. The answer is kept, so a second mention sends no request.
  assert.equal(await forge.sameRepo('samlorg/private'), false);
  assert.equal(await forge.sameRepo('blocked/repo'), false);
  assert.equal(await forge.sameRepo('samlorg/private'), false);
  assert.deepEqual(asked, ['/repos/samlorg/private', '/repos/blocked/repo']);
  // A rate limit (a 403 with no requests left, or a 429) and a refused token still stop the run.
  for (const [name, status] of [['limited/repo', 403], ['many/requests', 429], ['refused/token', 401]]) {
    await assert.rejects(forge.sameRepo(name), (error) => error instanceof GitHubReplyError && error.status === status && error.stopsRun, name);
  }
  // A 502 is another repo for now, but that answer is not kept: the next call asks again.
  asked.length = 0;
  assert.equal(await forge.sameRepo('oldacme/widgets'), false);
  assert.equal(await forge.sameRepo('oldacme/widgets'), true);
  assert.deepEqual(asked, ['/repos/oldacme/widgets', '/repos/oldacme/widgets', '/repos/acme/widgets']);
  // An error on this repo's own reply is not an answer about the name: it is thrown.
  const own = createGitHubForge({ repo: 'acme/widgets', token: 't', sleep: async () => {}, fetch: async (url) => (new URL(url).pathname === '/repos/acme/widgets'
    ? json(403, { message: 'Resource not accessible by integration' }, { 'x-ratelimit-remaining': '4999' })
    : json(200, { id: 7, full_name: 'acme/widgets' })) });
  await assert.rejects(own.sameRepo('oldacme/widgets'), (error) => error instanceof GitHubReplyError && error.status === 403);
});

test('a PR whose files, reviews, comments and CI results need more than one page gets them all', async () => {
  const fetch = widgets();
  const forge = createGitHubForge({ repo: 'acme/widgets', token: 't', fetch });
  await forge.mergedPulls();
  // The fixture has 2 items on a page. PR 7 has 3 files, 4 reviews, 4 comments and 3 check runs.
  assert.deepEqual((await forge.pullFiles(7)).map((file) => file.path), ['src/cache.js', 'src/widget.js', 'test/cache.test.js']);
  assert.deepEqual((await forge.pullReviews(7)).map((review) => review.state), ['CHANGES_REQUESTED', 'COMMENTED', 'CHANGES_REQUESTED', 'APPROVED']);
  assert.equal((await forge.pullComments(7)).length, 4);
  // GraphQL lists check runs oldest first. The REST API lists them newest first, and so does the forge.
  assert.deepEqual((await forge.ciResults('c'.repeat(39) + '7')).map((result) => result.name), ['lint', 'test', 'Secret scan']);
  const names = fetch.calls.map((call) => call.key.split(' ')[1]);
  assert.deepEqual(names, ['MergedPulls', 'MergedPulls', 'PullFiles', 'PullReviews', 'PullComments', 'CommitCi']);
  // A second call reads the list it kept, with no query.
  await forge.pullFiles(7);
  assert.equal(fetch.calls.length, 6);
  assert.deepEqual(forge.counts(), { requests: 0, not_modified: 0, queries: 6, points: 6 });
});

// A GraphQL reply that says the rate limit is used up. GitHub sends it with the status 200.
const graphqlLimited = (reset) => ({
  status: 200,
  headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
  body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] }
});

test('a GraphQL reply that says the rate limit is used up waits until the reset, then asks again', async () => {
  const s = scripted([graphqlLimited(1000), { status: 200, body: { data: { rateLimit: { cost: 2 }, viewer: { login: 'me' } } } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, now: () => 990_000 });
  assert.deepEqual(await github.graphql('query Me { rateLimit { cost } viewer { login } }', {}), { rateLimit: { cost: 2 }, viewer: { login: 'me' } });
  assert.deepEqual(s.waits, [11_000], 'ten seconds to the reset, plus one');
  assert.deepEqual(github.counts(), { requests: 0, not_modified: 0, queries: 2, points: 2 });
});

test('a GraphQL rate limit that asks for too long a wait fails with a plain message, and does not wait', async () => {
  const s = scripted([graphqlLimited(5000)]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, now: () => 0 });
  await assert.rejects(
    github.graphql('query Me { rateLimit { cost } }', {}, { permission: [PERMISSIONS.pullRequests] }),
    (error) => error instanceof ToolError && error.message === "GitHub's GraphQL API answered with an error (API rate limit exceeded for user ID 1.). GitHub's rate limit is used up: wait and try again." && error.stopsRun
  );
  assert.deepEqual(s.waits, []);
});

test('a GraphQL reply with an error fails with its message, and a FORBIDDEN error names the permissions', async () => {
  const s = scripted([{ status: 200, body: { data: { rateLimit: { cost: 1 }, repository: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] } }]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep });
  await assert.rejects(
    github.graphql('query Q { rateLimit { cost } }', {}, { permission: [PERMISSIONS.pullRequests, PERMISSIONS.checks, PERMISSIONS.commitStatuses] }),
    (error) => error instanceof ToolError && /Resource not accessible by personal access token/.test(error.message) && /the permissions "Pull requests: read", "Checks: read" and "Commit statuses: read"/.test(error.message)
  );
  assert.equal(github.counts().points, 1, 'a reply with errors still counts its points');
});

test('a GraphQL secondary rate limit waits one minute, then asks again', async () => {
  const s = scripted([
    { status: 403, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } },
    { status: 200, body: { data: { rateLimit: { cost: 1 } } } }
  ]);
  const github = createGitHub({ token: 't', fetch: s.fetch, sleep: s.sleep, random: () => 0 });
  assert.deepEqual(await github.graphql('query Q { rateLimit { cost } }', {}), { rateLimit: { cost: 1 } });
  assert.deepEqual(s.waits, [60_000]);
});
