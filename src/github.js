import { ToolError } from './tool-error.js';

const API = 'https://api.github.com';
const GRAPHQL = `${API}/graphql`;

// The token permissions that Exhibit's requests need (spec 8.3). Pass one as `permission`.
export const PERMISSIONS = {
  pullRequests: 'Pull requests: read',
  pullRequestsWrite: 'Pull requests: write',
  checks: 'Checks: read',
  commitStatuses: 'Commit statuses: read'
};

// When GitHub says to wait, the client waits and asks again, at most this many times.
const MAX_WAITS = 3;
// A wait longer than this fails instead, so a run never hangs for most of an hour.
const LONGEST_WAIT_MS = 15 * 60 * 1000;
// GitHub's docs say to wait at least one minute after a secondary rate limit that names no time,
// and to wait longer each time the limit comes back. So the waits are 1, 2 and 4 minutes.
const SECONDARY_LIMIT_WAIT_MS = 60 * 1000;
// Each secondary-limit wait gets a random extra of up to this part of it, so requests that hit
// the limit together do not all ask again at the same moment.
const SECONDARY_LIMIT_SPREAD = 0.25;
// The reply headers that the cache saves: the client reads the next page from link.
const SAVED_HEADERS = ['content-type', 'link'];
// The one form of HTTP date that GitHub sends, as in "Thu, 19 Nov 2026 10:00:30 GMT".
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// A small GitHub client, for the REST API and the GraphQL API. It takes the fetch function as a
// parameter, so tests can pass one that replays recorded responses. `getAll` follows the Link
// header's rel="next" URL exactly as GitHub gives it, until there is no next page, and returns the
// items of every page in order.
// Most lists come as a JSON list. A few, such as check runs, come as an object that holds the
// list in one field: pass that field's name as `listField`. `emptyOn` lists HTTP statuses that
// mean "nothing here", such as 422 for a commit GitHub does not know: they give an empty list.
// `permission` names the token permission that the request needs, such as "Checks: read". A 403
// that is not a rate limit then says which permission a fine-grained token may lack.
// `getOne` returns the object at one path, or null for a status in its `emptyOn`.
// `graphql` sends one GraphQL query and returns its `data`. The query must ask for
// `rateLimit { cost }`, so the client can add up the points it used. A reply with errors throws a
// ToolError, and a reply that says the rate limit is used up waits as a REST reply does.
// `sleep`, `now` and `random` are parameters too, so tests can check a rate-limit wait without waiting.
// `cache` is a reply cache from src/github-cache.js, or undefined for none. With a cache, a
// request for a URL that has an entry sends If-None-Match, and a 304 reply gives the saved body.
// A 200 reply with an ETag replaces the entry. GitHub's ETag covers the body only, not the Link
// header, so after a full page from the cache with no next page, the client asks for the next page
// number too (see `get`).
// GraphQL queries are POST requests, which have no ETag, so they never use the cache.
// `counts()` returns how many REST requests went to GitHub, how many of them got a 304, how many
// GraphQL queries went, and how many GraphQL points they used.
export function createGitHub({ token, fetch, cache, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, random = Math.random }) {
  const counts = { requests: 0, not_modified: 0, queries: 0, points: 0 };

  // A response that the client made from a saved entry, after a 304.
  const fromCache = new WeakSet();

  const headers = () => ({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'exhibit'
  });

  // Sends one request, and adds one to counts[counter] when it reached GitHub.
  async function send(url, init, counter) {
    try {
      const response = await fetch(url, init);
      counts[counter]++;
      return response;
    } catch (error) {
      throw new ToolError(`could not reach GitHub (${error.message}). Check the network and try again.`);
    }
  }

  async function request(url) {
    const saved = cache ? await cache.read(url) : null;
    const init = { headers: headers() };
    if (saved) init.headers['if-none-match'] = saved.etag;
    const response = await send(url, init, 'requests');
    if (saved && response.status === 304) {
      counts.not_modified++;
      const cached = new Response(saved.body, { status: 200, headers: saved.headers });
      fromCache.add(cached);
      return cached;
    }
    const etag = response.headers.get('etag');
    if (!cache || response.status !== 200 || !etag) return response;
    // Only the headers that the client reads from a 200 are saved.
    const body = await response.text();
    const kept = {};
    for (const name of SAVED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) kept[name] = value;
    }
    await cache.write(url, { etag, body, headers: kept });
    return new Response(body, { status: 200, headers: response.headers });
  }

  // Calls `ask` for a response, and calls it again when GitHub says to wait, at most MAX_WAITS
  // times. Returns the last response, and `limited`: true when it is still a rate limit.
  // `limitedReply(response)` says whether a reply is a rate limit even though it is OK, as a
  // GraphQL reply can be.
  async function withWaits(ask, limitedReply = async () => false) {
    let response = await ask();
    for (let waits = 0, secondaryWaits = 0; ; waits++) {
      const wait = await rateLimitWait(response, now(), secondaryWaits, random, await limitedReply(response));
      if (wait === null) return { response, limited: false };
      if (waits === MAX_WAITS || wait.ms > LONGEST_WAIT_MS) return { response, limited: true };
      if (wait.secondary) secondaryWaits++;
      await sleep(wait.ms);
      response = await ask();
    }
  }

  // Sends one GET, waits and asks again when GitHub says to, and returns the parsed JSON reply
  // (undefined when it is not JSON) and the response. A reply that is not OK throws a ToolError.
  // A reply that is still a rate limit when the waits end says so, and does not blame a missing
  // permission.
  async function getJson(url, emptyOn = [], permission) {
    const { response, limited } = await withWaits(() => request(url));
    if (emptyOn.includes(response.status)) return { reply: [], response };
    if (!response.ok) throw await apiError(response, url, permission, limited);
    try {
      return { reply: await response.json(), response };
    } catch {
      return { reply: undefined, response };
    }
  }

  // Returns one page of a list: its items, and the URL of the next page or null.
  // A 304 says the body is the same, but not the Link header. When a full last page gets a new
  // page after it, the full page does not change, so it gets a 304, and its saved Link has no
  // next page. So after a full page from the cache with no next page, the next page is the same
  // URL with the next page number. That request uses the cache as well: once its empty reply is
  // saved, it gets a 304 until a new item comes. A page that is not full is the last one.
  async function get(url, listField, emptyOn, permission) {
    const { reply, response } = await getJson(url, emptyOn, permission);
    const items = listField === undefined ? reply : reply?.[listField];
    if (!Array.isArray(items)) throw notShaped(url, 'a JSON list');
    const next = nextLink(response.headers.get('link'));
    if (next === null && fromCache.has(response) && items.length > 0 && items.length >= pageSize(url)) return { items, next: pageAfter(url) };
    return { items, next };
  }

  async function getAll(path, { listField, emptyOn, permission } = {}) {
    const items = [];
    for (let url = API + path; url; ) {
      const page = await get(url, listField, emptyOn, permission);
      items.push(...page.items);
      url = page.next;
    }
    return items;
  }

  // Returns the one JSON object at `path`, such as a single PR. A status in `emptyOn` gives null.
  async function getOne(path, { emptyOn = [], permission } = {}) {
    const url = API + path;
    const { reply, response } = await getJson(url, emptyOn, permission);
    if (emptyOn.includes(response.status)) return null;
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw notShaped(url, 'a JSON object');
    return reply;
  }

  // Sends one GraphQL query with its variables, and returns the reply's `data`. `permission`
  // lists the token permissions the query needs, for the message of a refused request.
  async function graphql(query, variables, { permission } = {}) {
    const init = { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) };
    const { response, limited } = await withWaits(() => send(GRAPHQL, init, 'queries'), async (reply) => reply.ok && graphqlRateLimited(await jsonOf(reply.clone())));
    if (!response.ok) throw await apiError(response, GRAPHQL, permission, limited);
    const reply = await jsonOf(response);
    const cost = reply?.data?.rateLimit?.cost;
    if (Number.isInteger(cost)) counts.points += cost;
    if (Array.isArray(reply?.errors) && reply.errors.length > 0) throw graphqlError(reply.errors, permission);
    if (reply?.data === null || typeof reply?.data !== 'object') throw notShaped(GRAPHQL, 'a GraphQL reply with data');
    return reply.data;
  }

  // Sends one REST request that changes something, such as a POST or a PATCH, with the JSON body
  // `body`, and returns the JSON object of the reply. It never uses the cache. It waits and asks
  // again when GitHub says to, as a GET does, because GitHub did not act on a refused request.
  async function write(method, path, body, { permission } = {}) {
    const url = API + path;
    const init = { method, headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const { response, limited } = await withWaits(() => send(url, init, 'requests'));
    if (!response.ok) throw await apiError(response, url, permission, limited);
    const reply = await jsonOf(response);
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw notShaped(url, 'a JSON object');
    return reply;
  }

  return { getAll, getOne, graphql, write, counts: () => ({ ...counts }) };
}

// Returns the parsed JSON body of a response, or undefined when it is not JSON.
async function jsonOf(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

// GitHub answers a GraphQL query with 200 when the rate limit is used up, and says so in an error
// of the type RATE_LIMITED.
function graphqlRateLimited(reply) {
  return Array.isArray(reply?.errors) && reply.errors.some((error) => error?.type === 'RATE_LIMITED');
}

// A GraphQL reply with errors. Its status is the HTTP status that the first error's type stands
// for, so `stopsRun` works as for a REST reply.
const GRAPHQL_ERROR_STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, RATE_LIMITED: 429 };

function graphqlError(errors, permission) {
  const status = GRAPHQL_ERROR_STATUS[errors[0]?.type] ?? 200;
  const detail = [...new Set(errors.map((error) => String(error?.message ?? error?.type ?? 'no message')))].join('; ');
  return new GitHubReplyError(`GitHub's GraphQL API answered with an error (${detail}).${status === 200 ? '' : advice(status, permission)}`, status);
}

function notShaped(url, shape) {
  return new ToolError(`GitHub sent a reply that is not ${shape} for ${new URL(url).pathname}. Try again later, and report it as an Exhibit issue if it keeps happening.`);
}

// Returns how long GitHub asks us to wait before we ask again, or null when the reply is not a
// rate limit. `ms` is the wait in milliseconds, and `secondary` is true for a secondary limit.
// GitHub says to wait in one of three ways:
// - a retry-after header, in whole seconds or as an HTTP date. Any other value counts as no
//   retry-after: Date.parse reads "1.5" as a date in 2001, which would mean no wait at all;
// - no requests left until the x-ratelimit-reset time (in Unix seconds);
// - a message that names a secondary rate limit, with neither header. Then we wait one minute,
//   twice that after the second limit, and so on, plus a random spread. `secondaryWaits` is how
//   many secondary-limit waits this request has had before.
// A GraphQL reply that is a rate limit has the status 200: `limitedReply` is true for one, and
// then the same headers say how long to wait.
async function rateLimitWait(response, nowMs, secondaryWaits, random, limitedReply = false) {
  if (!limitedReply && response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return { ms: Number(retryAfter) * 1000, secondary: false };
  if (retryAfter !== null && HTTP_DATE.test(retryAfter)) return { ms: Math.max(0, Date.parse(retryAfter) - nowMs), secondary: false };
  const reset = response.headers.get('x-ratelimit-reset');
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset !== null && /^\d+$/.test(reset)) {
    // One second more, so the wait ends after the reset and not just before it.
    return { ms: Math.max(0, Number(reset) * 1000 - nowMs) + 1000, secondary: false };
  }
  if (/secondary rate limit/i.test(await messageOf(response.clone()))) {
    const wait = SECONDARY_LIMIT_WAIT_MS * 2 ** secondaryWaits;
    return { ms: wait + Math.floor(random() * SECONDARY_LIMIT_SPREAD * wait), secondary: true };
  }
  return null;
}

// Returns the message field of a JSON error reply, or '' when there is none.
async function messageOf(response) {
  try {
    return String((await response.json())?.message ?? '');
  } catch {
    // The body was not JSON. The status alone says enough.
    return '';
  }
}

// GitHub gives 30 items on a page when the URL names no per_page.
function pageSize(url) {
  const perPage = new URL(url).searchParams.get('per_page');
  return perPage !== null && /^\d+$/.test(perPage) ? Number(perPage) : 30;
}

// The same URL with the next page number. A URL that names no page is page 1.
function pageAfter(url) {
  const next = new URL(url);
  const page = next.searchParams.get('page');
  next.searchParams.set('page', String((page !== null && /^\d+$/.test(page) ? Number(page) : 1) + 1));
  return next.href;
}

function nextLink(header) {
  if (!header) return null;
  const match = header.split(',').map((part) => part.match(/<([^>]+)>\s*;\s*rel="next"/)).find(Boolean);
  return match ? match[1] : null;
}

// A reply from GitHub that is not OK. `status` is its HTTP status, so a caller can tell a problem
// with one request, such as a 502, from one that stops every request, such as a refused token.
export class GitHubReplyError extends ToolError {
  constructor(message, status) {
    super(message);
    this.status = status;
  }

  // True when every later request would fail too: a refused token (401), a missing permission
  // (403) or a rate limit (403 or 429). Then a caller stops instead of going on.
  get stopsRun() {
    return [401, 403, 429].includes(this.status);
  }
}

// `limited` is true when the reply is still a rate limit after the waits.
async function apiError(response, url, permission, limited = false) {
  const detail = await messageOf(response);
  const what = `GitHub answered ${response.status}${detail ? ` (${detail})` : ''} for ${new URL(url).pathname}`;
  return new GitHubReplyError(`${what}.${advice(response.status, permission, limited)}`, response.status);
}

// `permission` is one permission, or a list of them. `limited` is true for a known rate limit.
function advice(status, permission, limited = false) {
  if (status === 401) return ' GITHUB_TOKEN was refused: make a new token and set it.';
  // A 429 is always a rate limit. A 403 is one only when the waits said so.
  if (status === 429 || (status === 403 && limited)) return " GitHub's rate limit is used up: wait and try again.";
  if (status === 403) {
    const needs = permission ? ` A fine-grained GITHUB_TOKEN needs ${permissionWords(permission)} for this request.` : '';
    return ` The token may lack access, or the rate limit is used up: check the token, or wait and try again.${needs}`;
  }
  if (status === 404) return ' Check the repo name, and that GITHUB_TOKEN can read that repo.';
  if (status >= 500) return ' GitHub had a problem: try again later.';
  return '';
}

// "the permission "A"", or "the permissions "A", "B" and "C"".
function permissionWords(permission) {
  const names = [permission].flat().map((name) => `"${name}"`);
  if (names.length === 1) return `the permission ${names[0]}`;
  return `the permissions ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// A GitHub repo name is owner/name, and each part uses only letters, digits, _, . and -.
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// The GitHub forge module's static rules: what a command asks before it has a forge. A command
// picks the module first, then asks it everything: whether --repo is a repo name, which env
// variable holds the token, and how to connect. Another forge, such as GitLab, gives an object
// with the same fields.
export const GITHUB_FORGE = {
  // The forge's name in a history line's forge field.
  name: 'github',
  // The forge's name in messages for people.
  displayName: 'GitHub',
  // The env variable that holds the token, and an example of how to set it.
  tokenEnv: 'GITHUB_TOKEN',
  tokenExample: 'GITHUB_TOKEN=$(gh auth token)',

  // Returns true when `text` is a GitHub repo name, such as bfalkowski/Building58.
  isRepoName(text) {
    return REPO_NAME.test(text);
  },

  // Makes the forge for the repo `repo` ("owner/name"). See createGitHubForge.
  connect(options) {
    return createGitHubForge(options);
  }
};

// How many merged PRs one GraphQL query reads, with the first page of each PR's lists.
const PULLS_PER_QUERY = 50;
// How many items of one list (files, reviews, comments, labels, CI results) one query reads.
const ITEMS_PER_PAGE = 100;

// The fields of one GraphQL query. An author is a user, a bot or another kind of account, and is
// null when the account was deleted.
const AUTHOR = 'author { __typename login }';
const CI_RESULT = '__typename ... on CheckRun { databaseId name conclusion url } ... on StatusContext { context state targetUrl }';
// The lists inside one PR, each with the fields of one item.
const PULL_LISTS = {
  labels: 'name',
  files: 'path additions deletions',
  reviews: `state submittedAt ${AUTHOR}`,
  comments: `body createdAt ${AUTHOR}`
};

// One page of a list, from the cursor `$after` when `paged` is true.
function listPage(field, item, paged = false) {
  return `${field}(first: ${ITEMS_PER_PAGE}${paged ? ', after: $after' : ''}) { pageInfo { hasNextPage endCursor } nodes { ${item} } }`;
}

// A PR with the first page of each list. The CI results are on the PR's last commit: its check
// runs and its commit statuses together, in GitHub's status check rollup.
const PULL = `number url title body mergedAt updatedAt changedFiles ${AUTHOR} mergeCommit { oid }
  baseRefName baseRefOid headRefName headRefOid
  ${Object.entries(PULL_LISTS).map(([field, item]) => listPage(field, item)).join('\n  ')}
  commits(last: 1) { nodes { commit { oid statusCheckRollup { ${listPage('contexts', CI_RESULT)} } } } }`;

const REPO_VARIABLES = '$owner: String!, $name: String!';

const MERGED_PULLS = `query MergedPulls(${REPO_VARIABLES}, $after: String) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: ${PULLS_PER_QUERY}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL} }
    }
  }
}`;

// The merged PRs, the PR updated last first. With --since or --limit, history reads this list
// and stops early (see mergedPulls).
const RECENT_MERGED_PULLS = `query RecentMergedPulls(${REPO_VARIABLES}, $after: String) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, orderBy: { field: UPDATED_AT, direction: DESC }, first: ${PULLS_PER_QUERY}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL} }
    }
  }
}`;

const ONE_PULL = `query Pull(${REPO_VARIABLES}, $number: Int!) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PULL} } }
}`;

// The query for the next page of one list in one PR, such as PullFiles.
function pullListQuery(field) {
  const name = `Pull${field[0].toUpperCase()}${field.slice(1)}`;
  return `query ${name}(${REPO_VARIABLES}, $number: Int!, $after: String) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${listPage(field, PULL_LISTS[field], true)} } }
}`;
}

// The CI results on one commit, from the cursor `$after`, or from the start when it is null.
const COMMIT_CI = `query CommitCi(${REPO_VARIABLES}, $oid: GitObjectID!, $after: String) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { statusCheckRollup { ${listPage('contexts', CI_RESULT, true)} } } } }
}`;

// The comments on one PR, from the cursor `$after`, with what upsertComment needs to find its own
// comment. viewerDidAuthor is true for a comment that the token's own account wrote. A comment's
// id is past 2^31 on GitHub, so it comes as fullDatabaseId, a string, and not as the Int databaseId.
const OWN_COMMENTS = `query PullCommentsForUpsert(${REPO_VARIABLES}, $number: Int!, $after: String) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${listPage('comments', 'fullDatabaseId url body viewerDidAuthor', true)} } }
}`;

const NO_ITEMS = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

// The GitHub forge: every request that history, SZZ, check and publish send to GitHub, as one method each, for
// the one repo `repo` ("owner/name"). Only this module builds GitHub API paths and queries, so
// another forge, such as GitLab, can come later as a second module with the same methods. The
// other options go to createGitHub.
// History's methods use the GraphQL API: one query reads up to 50 merged PRs, with the first page
// of each PR's labels, files, reviews, comments and CI results. The REST API needs one request
// for each PR and each of those lists. mergedPulls keeps what it read, so pullFiles, pullReviews,
// pullComments, pullFileCount and ciResults read from it, and send a query only for a list with
// more than one page, or for a PR or commit that mergedPulls did not read.
// SZZ's methods (defaultBranch, sameRepo, pullsForCommit and issue) use the REST API, with the reply cache.
// The methods return small forge-neutral shapes, not GitHub's own objects, so history and SZZ
// read the same fields from any forge, and a caller does not depend on which API gave them:
// - mergedPulls, pullsForCommit and pull give PRs: { number, title, body, author, labels,
//   mergedAt, baseRef, baseSha, headRef, headSha, mergeSha, url }. body is null when empty,
//   author is a login or null for a deleted account, labels are names, and mergedAt and mergeSha
//   are null for a PR that was not merged.
// - pullFiles: { path, additions, deletions }.
// - pullReviews: { state, author, at }, where at is null for a review that is still pending.
// - pullComments: { body, author, at }.
// - ciResults: { name, conclusion, url }, check runs first, then commit statuses.
// - issue: { createdAt, isPull }, or null.
// - defaultBranch: the branch name.
// - sameRepo: true or false.
// - upsertComment, for exhibit publish --comment: { action, url }.
export function createGitHubForge({ repo, ...client }) {
  const github = createGitHub(client);
  const base = `/repos/${repo}`;
  const [owner, name] = repo.split('/');
  const pullRequests = { permission: PERMISSIONS.pullRequests };
  // The permissions that the GraphQL queries for history need.
  const forHistory = { permission: [PERMISSIONS.pullRequests, PERMISSIONS.checks, PERMISSIONS.commitStatuses] };

  // Answers that need one request at most per run: this repo's own reply, and sameRepo's answer
  // for each name, lower case. A request that fails is not kept, so the next call asks again.
  const answers = new Map();
  async function once(key, ask) {
    if (!answers.has(key)) answers.set(key, ask());
    try {
      return await answers.get(key);
    } catch (error) {
      answers.delete(key);
      throw error;
    }
  }
  const thisRepo = () => once('repo', () => github.getOne(base));

  // What GraphQL gave for each PR, by number, and the first page of CI results for each commit.
  const pulls = new Map();
  const ciPages = new Map();

  function keep(pull) {
    pulls.set(pull.number, pull);
    const commit = pull.commits.nodes[0]?.commit;
    if (commit) ciPages.set(commit.oid, commit.statusCheckRollup?.contexts ?? NO_ITEMS);
  }

  async function pull(number) {
    if (!pulls.has(number)) {
      const found = (await github.graphql(ONE_PULL, { owner, name, number }, forHistory)).repository?.pullRequest;
      if (!found) throw new ToolError(`GitHub has no PR ${number} in ${repo}.`);
      keep(found);
    }
    return pulls.get(number);
  }

  // Returns every item of the list `field` of PR `number`, paging until the list is complete.
  async function pullList(number, field) {
    const found = await pull(number);
    const items = await allItems(found[field], async (after) => {
      const data = await github.graphql(pullListQuery(field), { owner, name, number, after }, forHistory);
      return data.repository?.pullRequest?.[field];
    });
    // Later calls get the whole list with no more queries.
    found[field] = { pageInfo: NO_ITEMS.pageInfo, nodes: items };
    return items;
  }

  return {
    name: GITHUB_FORGE.name,
    displayName: GITHUB_FORGE.displayName,
    repo,

    // How many REST requests went to GitHub so far, how many of them got a 304 from the cache, how
    // many GraphQL queries went, and how many GraphQL points they used:
    // { requests, not_modified, queries, points }.
    counts: github.counts,

    // GitHub lists at most this many files for one PR. A shorter list is complete.
    mostFilesListed: 3000,

    // Returns true when the git remote URL `url` points at this repo on github.com. Any URL form
    // counts: https, ssh, or scp-like (git@github.com:owner/name.git).
    isRemote(url) {
      const match = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);
      return match !== null && match[1].toLowerCase() === repo.toLowerCase();
    },

    // Returns true when `url` is the web page of a PR in this repo, as a history line's url is.
    isPullUrl(url) {
      return typeof url === 'string' && url.toLowerCase().startsWith(`https://github.com/${repo}/pull/`.toLowerCase());
    },

    // The PRs that were merged. `since` (a Date) and `limit` are history's options: history keeps
    // the PRs merged at or after `since`, and of those the newest `limit` by merge time. With
    // neither, it reads every merged PR, in the order GitHub lists them. With either, it reads
    // the PRs updated last first, and stops when no later page can hold a PR that history keeps
    // (see noneLeftToKeep). So it may return more PRs than history keeps, but never fewer.
    async mergedPulls({ since, limit } = {}) {
      const byUpdate = Boolean(since) || limit !== undefined;
      const query = byUpdate ? RECENT_MERGED_PULLS : MERGED_PULLS;
      const merged = [];
      const seen = new Set();
      async function readPage(after) {
        const data = await github.graphql(query, { owner, name, after }, forHistory);
        const page = data.repository?.pullRequests;
        if (!Array.isArray(page?.nodes)) throw notShaped(GRAPHQL, 'a list of PRs');
        for (const found of page.nodes) {
          if (seen.has(found.number)) continue;
          seen.add(found.number);
          keep(found);
          merged.push(fromGraphqlPull(found, await pullList(found.number, 'labels')));
        }
        return page;
      }

      let pages = 0;
      let firstNewest;
      for (let after = null, more = true; more; ) {
        const page = await readPage(after);
        pages += 1;
        if (pages === 1) firstNewest = newestUpdate(page.nodes);
        ({ hasNextPage: more, endCursor: after } = page.pageInfo);
        if (byUpdate && more && noneLeftToKeep(merged, oldestUpdate(page.nodes), since, limit)) break;
      }
      // A PR that someone updated while the pages were read moves to the top of the list, so the
      // later pages do not hold it. Read from the top again, down to a page that ends more than
      // ORDER_MARGIN_MS before the newest update on the first page, to find it. This is most often
      // one or two queries. When the first page had no update times, the first pass did not stop
      // early and read the whole list, so there is nothing to find.
      if (byUpdate && pages > 1 && Number.isFinite(firstNewest)) {
        for (let after = null, more = true; more; ) {
          const page = await readPage(after);
          ({ hasNextPage: more, endCursor: after } = page.pageInfo);
          if (oldestUpdate(page.nodes) + ORDER_MARGIN_MS < firstNewest) break;
        }
      }
      return merged;
    },

    pullFiles: async (number) => (await pullList(number, 'files')).map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
    pullReviews: async (number) => (await pullList(number, 'reviews')).map((review) => ({ state: review.state, author: fromAuthor(review.author), at: review.submittedAt })),
    // A PR's comments are the comments of the issue with the same number.
    pullComments: async (number) => (await pullList(number, 'comments')).map((comment) => ({ body: comment.body, author: fromAuthor(comment.author), at: comment.createdAt })),

    // How many files the PR changed. GraphQL gives it with the PR, so it costs no request.
    pullFileCount: async (number) => (await pull(number)).changedFiles,

    // The CI results on a commit, such as a PR's last head commit. Some CI services post check
    // runs, and some post the older commit statuses, so the list holds both, check runs first.
    async ciResults(headSha) {
      const ask = async (after) => {
        const data = await github.graphql(COMMIT_CI, { owner, name, oid: headSha, after }, forHistory);
        return data.repository?.object?.statusCheckRollup?.contexts ?? NO_ITEMS;
      };
      const first = ciPages.get(headSha) ?? await ask(null);
      const results = await allItems(first, ask);
      // The REST API lists the newest check run first, and so does this list.
      const checkRuns = results.filter((result) => result.__typename === 'CheckRun').sort((a, b) => b.databaseId - a.databaseId);
      // GitHub adds an EXPECTED status for a required check that has not posted yet. The REST
      // API does not list it, so it is left out here too.
      const statuses = results.filter((result) => result.__typename === 'StatusContext' && result.state !== 'EXPECTED');
      return [...checkRuns.map(fromCheckRun), ...statuses.map(fromStatus)];
    },

    // One PR, for exhibit check --pr.
    pull: async (number) => fromRestPull(await github.getOne(`${base}/pulls/${number}`, pullRequests)),

    async defaultBranch() {
      return (await thisRepo()).default_branch;
    },

    // Returns true when the repo name `named` ("owner/name") leads to this repo, as the repo's
    // old name does after a rename or a transfer. GitHub answers GET /repos/{old name} with a
    // redirect to the repo, and fetch follows it. The id stays the same after a rename or a
    // transfer, so the two replies are one repo when their ids match. A name that GitHub does not
    // know, or a repo the token cannot read (404), is not this repo. Each name costs one request
    // at most, in any case.
    async sameRepo(named) {
      const key = named.toLowerCase();
      if (key === repo.toLowerCase()) return true;
      return once(`same ${key}`, async () => {
        const found = await github.getOne(`/repos/${named}`, { emptyOn: [404] });
        return found !== null && found.id === (await thisRepo()).id;
      });
    },

    // The PRs that hold the commit `sha`. GitHub answers 422 for a commit it does not know, such
    // as one that was never pushed. A 404 means the same here: the repo itself was read before.
    // Both give an empty list.
    pullsForCommit: async (sha) => (await github.getAll(`${base}/commits/${sha}/pulls?per_page=100`, { emptyOn: [404, 422], ...pullRequests })).map(fromRestPull),

    // Posts `body` as a comment on PR `number`, or updates the comment that this method posted
    // before, so the PR holds one such comment. That comment is the first one that the token's own
    // account wrote and whose body starts with `marker`. A comment by anyone else is never changed,
    // even when it starts with the marker. Returns { action, url }, where action is created,
    // updated, or unchanged when the comment already holds `body`.
    async upsertComment(number, marker, body) {
      const ask = async (after) => (await github.graphql(OWN_COMMENTS, { owner, name, number, after }, pullRequests)).repository?.pullRequest?.comments;
      const first = await ask(null);
      if (first === undefined || first === null) throw new ToolError(`GitHub has no PR ${number} in ${repo}.`);
      const own = (await allItems(first, ask)).find((comment) => comment.viewerDidAuthor === true && typeof comment.body === 'string' && comment.body.startsWith(marker));
      const write = { permission: PERMISSIONS.pullRequestsWrite };
      if (own === undefined) {
        const made = await github.write('POST', `${base}/issues/${number}/comments`, { body }, write);
        return { action: 'created', url: made.html_url };
      }
      // GitHub keeps a comment's line ends as \r\n when it was edited in the browser, and as sent
      // otherwise. The comparison ignores that difference.
      if (own.body.replace(/\r\n/g, '\n') === body) return { action: 'unchanged', url: own.url };
      if (!/^\d+$/.test(own.fullDatabaseId)) throw notShaped(GRAPHQL, 'a comment with an id');
      const changed = await github.write('PATCH', `${base}/issues/comments/${own.fullDatabaseId}`, { body }, write);
      return { action: 'updated', url: changed.html_url };
    },

    // The web page of the file `path` in this repo at the commit `commit`.
    fileUrl(commit, path) {
      return `https://github.com/${repo}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
    },

    // The issue (or PR) with the number `number`, or null when GitHub does not know it or it was
    // deleted. GitHub lists a PR as an issue too, and marks it with a pull_request field.
    async issue(number) {
      const found = await github.getOne(`${base}/issues/${number}`, { emptyOn: [404, 410] });
      if (found === null) return null;
      return { createdAt: typeof found.created_at === 'string' ? found.created_at : null, isPull: Boolean(found.pull_request) };
    }
  };
}

// The newest and the oldest update time of the PRs `nodes`, in milliseconds. A page with no
// update times gives NaN, and a comparison with NaN is false, so the list does not stop early.
const newestUpdate = (nodes) => Math.max(...nodes.map((found) => Date.parse(found.updatedAt)));
const oldestUpdate = (nodes) => Math.min(...nodes.map((found) => Date.parse(found.updatedAt)));

// GitHub's list "ordered by UPDATED_AT" is not always in the order of the updatedAt it gives. On
// cli/cli, a PR came after another PR that it was updated 2.2 hours later than (spec 8.3). So the
// stops below allow a PR on a later page to be updated, and merged, up to this long after the
// oldest update time on the page before. GitHub does not document how far off its order can be,
// so this margin is a guess, made large against the one case seen.
export const ORDER_MARGIN_MS = 24 * 60 * 60 * 1000;

// Returns true when no PR after the page whose oldest update time is `oldest` can be one that
// history keeps. `merged` holds the PRs read so far. Each later PR was updated at or before
// `oldest` plus ORDER_MARGIN_MS, and a merge updates the PR, so it was merged by then too. Call
// that time `latest`. A later PR is not kept when `latest` is before `since`. And it is not kept
// when `limit` PRs that history keeps were merged after `latest`, because those PRs come first.
function noneLeftToKeep(merged, oldest, since, limit) {
  const latest = oldest + ORDER_MARGIN_MS;
  if (since && latest < since.getTime()) return true;
  if (limit === undefined) return false;
  const newer = merged.filter((pr) => {
    const at = Date.parse(pr.mergedAt);
    return at > latest && (!since || at >= since.getTime());
  });
  return newer.length >= limit;
}

// Returns every item of a GraphQL list, from its first page `page` on. `nextPage(cursor)` asks
// for the page after the cursor.
async function allItems(page, nextPage) {
  const items = [];
  for (;;) {
    if (!Array.isArray(page?.nodes)) throw notShaped(GRAPHQL, 'a list');
    items.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) return items;
    page = await nextPage(page.pageInfo.endCursor);
  }
}

// A PR from GraphQL, in the forge-neutral shape. GraphQL gives an empty body as "", and the REST
// API as null: both give null.
function fromGraphqlPull(found, labels) {
  return {
    number: found.number,
    title: found.title,
    body: found.body === '' ? null : found.body,
    author: fromAuthor(found.author),
    labels: labels.map((label) => label.name),
    mergedAt: found.mergedAt,
    baseRef: found.baseRefName,
    baseSha: found.baseRefOid,
    headRef: found.headRefName,
    headSha: found.headRefOid,
    mergeSha: found.mergeCommit?.oid ?? null,
    url: found.url
  };
}

// A PR from the REST API, in the same shape.
function fromRestPull(found) {
  return {
    number: found.number,
    title: found.title ?? null,
    body: found.body === '' ? null : found.body ?? null,
    author: found.user?.login ?? null,
    labels: (found.labels ?? []).map((label) => label.name),
    mergedAt: found.merged_at ?? null,
    baseRef: found.base?.ref ?? null,
    baseSha: found.base?.sha ?? null,
    headRef: found.head?.ref ?? null,
    headSha: found.head?.sha ?? null,
    // GitHub gives an open PR a merge_commit_sha of a test merge, so only a merged PR keeps it.
    mergeSha: found.merged_at ? found.merge_commit_sha ?? null : null,
    url: found.html_url ?? null
  };
}

// An author's login from GraphQL, or null for a deleted account. GraphQL gives a bot's login
// without the "[bot]" that the REST API adds, as in "dependabot" for "dependabot[bot]". The login
// keeps the "[bot]", as the history file always had it.
function fromAuthor(author) {
  if (!author) return null;
  return author.__typename === 'Bot' ? `${author.login}[bot]` : author.login;
}

// GraphQL gives a check run's conclusion and a status's state in capitals, as in SUCCESS. The
// REST API gives them in small letters.
function fromCheckRun(run) {
  return { name: run.name, conclusion: run.conclusion?.toLowerCase() ?? null, url: run.url ?? null };
}

// A commit status has a state: success, failure, error or pending. A pending status has not
// finished, so its conclusion is null, as for a check run that has not finished.
function fromStatus(status) {
  const state = status.state.toLowerCase();
  return { name: status.context, conclusion: state === 'pending' ? null : state, url: status.targetUrl ?? null };
}
