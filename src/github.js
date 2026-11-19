import { ToolError } from './tool-error.js';

const API = 'https://api.github.com';

// The token permissions that Exhibit's requests need (spec 8.3). Pass one as `permission`.
export const PERMISSIONS = {
  pullRequests: 'Pull requests: read',
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
// The one form of HTTP date that GitHub sends, as in "Thu, 19 Nov 2026 10:00:30 GMT".
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// A small GitHub REST client. It takes the fetch function as a parameter, so tests can pass one
// that replays recorded responses. `getAll` follows the Link header's rel="next" URL exactly as
// GitHub gives it, until there is no next page, and returns the items of every page in order.
// Most lists come as a JSON list. A few, such as check runs, come as an object that holds the
// list in one field: pass that field's name as `listField`. `emptyOn` lists HTTP statuses that
// mean "nothing here", such as 422 for a commit GitHub does not know: they give an empty list.
// `permission` names the token permission that the request needs, such as "Checks: read". A 403
// that is not a rate limit then says which permission a fine-grained token may lack.
// `getOne` returns the object at one path.
// `sleep`, `now` and `random` are parameters too, so tests can check a rate-limit wait without waiting.
export function createGitHub({ token, fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, random = Math.random }) {
  async function request(url) {
    try {
      return await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'exhibit'
        }
      });
    } catch (error) {
      throw new ToolError(`could not reach GitHub (${error.message}). Check the network and try again.`);
    }
  }

  // Sends one GET, waits and asks again when GitHub says to, and returns the parsed JSON reply
  // (undefined when it is not JSON) and the response. A reply that is not OK throws a ToolError.
  // A reply that is still a rate limit when the waits end does not blame a missing permission.
  async function getJson(url, emptyOn = [], permission) {
    let response = await request(url);
    let limited = false;
    for (let waits = 0, secondaryWaits = 0; !response.ok; waits++) {
      const wait = await rateLimitWait(response, now(), secondaryWaits, random);
      limited = wait !== null;
      if (!limited || waits === MAX_WAITS || wait.ms > LONGEST_WAIT_MS) break;
      if (wait.secondary) secondaryWaits++;
      await sleep(wait.ms);
      response = await request(url);
    }
    if (emptyOn.includes(response.status)) return { reply: [], response };
    if (!response.ok) throw await apiError(response, url, limited ? undefined : permission);
    try {
      return { reply: await response.json(), response };
    } catch {
      return { reply: undefined, response };
    }
  }

  async function get(url, listField, emptyOn, permission) {
    const { reply, response } = await getJson(url, emptyOn, permission);
    const items = listField === undefined ? reply : reply?.[listField];
    if (!Array.isArray(items)) throw notShaped(url, 'a JSON list');
    return { items, next: nextLink(response.headers.get('link')) };
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

  // Returns the one JSON object at `path`, such as a single PR.
  async function getOne(path, { permission } = {}) {
    const url = API + path;
    const { reply } = await getJson(url, [], permission);
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw notShaped(url, 'a JSON object');
    return reply;
  }

  return { getAll, getOne };
}

function notShaped(url, shape) {
  return new ToolError(`GitHub sent a reply that is not ${shape} for ${new URL(url).pathname}. Try again later, and report it as an Exhibit issue if it keeps happening.`);
}

// Returns how long GitHub asks us to wait before we ask again, or null when the reply is not a
// rate limit. `ms` is the wait in milliseconds, and `secondary` is true for a secondary limit. GitHub says to wait in one of three ways:
// - a retry-after header, in whole seconds or as an HTTP date. Any other value counts as no
//   retry-after: Date.parse reads "1.5" as a date in 2001, which would mean no wait at all;
// - no requests left until the x-ratelimit-reset time (in Unix seconds);
// - a message that names a secondary rate limit, with neither header. Then we wait one minute,
//   twice that after the second limit, and so on, plus a random spread. `secondaryWaits` is how
//   many secondary-limit waits this request has had before.
async function rateLimitWait(response, nowMs, secondaryWaits, random) {
  if (response.status !== 403 && response.status !== 429) return null;
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

function nextLink(header) {
  if (!header) return null;
  const match = header.split(',').map((part) => part.match(/<([^>]+)>\s*;\s*rel="next"/)).find(Boolean);
  return match ? match[1] : null;
}

async function apiError(response, url, permission) {
  const detail = await messageOf(response);
  const what = `GitHub answered ${response.status}${detail ? ` (${detail})` : ''} for ${new URL(url).pathname}`;
  if (response.status === 401) return new ToolError(`${what}. GITHUB_TOKEN was refused: make a new token and set it.`);
  if (response.status === 403 || response.status === 429) {
    // A 429 is always a rate limit, so only a 403 can mean a missing permission.
    const needs = permission && response.status === 403 ? ` A fine-grained GITHUB_TOKEN needs the permission "${permission}" for this request.` : '';
    return new ToolError(`${what}. The token may lack access, or the rate limit is used up: check the token, or wait and try again.${needs}`);
  }
  if (response.status === 404) return new ToolError(`${what}. Check the repo name, and that GITHUB_TOKEN can read that repo.`);
  if (response.status >= 500) return new ToolError(`${what}. GitHub had a problem: try again later.`);
  return new ToolError(`${what}.`);
}
