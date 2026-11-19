import { ToolError } from './tool-error.js';

const API = 'https://api.github.com';

// When GitHub says to wait, the client waits and asks again, at most this many times.
const MAX_WAITS = 3;
// A wait longer than this fails instead, so a run never hangs for most of an hour.
const LONGEST_WAIT_MS = 15 * 60 * 1000;

// A small GitHub REST client. It takes the fetch function as a parameter, so tests can pass one
// that replays recorded responses. `getAll` follows the Link header's rel="next" URL exactly as
// GitHub gives it, until there is no next page, and returns the items of every page in order.
// Most lists come as a JSON list. A few, such as check runs, come as an object that holds the
// list in one field: pass that field's name as `listField`. `emptyOn` lists HTTP statuses that
// mean "nothing here", such as 422 for a commit GitHub does not know: they give an empty list.
// `getOne` returns the object at one path.
// `sleep` and `now` are parameters too, so tests can check a rate-limit wait without waiting.
export function createGitHub({ token, fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now }) {
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
  async function getJson(url, emptyOn = []) {
    let response = await request(url);
    for (let waits = 0; !response.ok && waits < MAX_WAITS; waits++) {
      const ms = rateLimitWait(response, now());
      if (ms === null || ms > LONGEST_WAIT_MS) break;
      await sleep(ms);
      response = await request(url);
    }
    if (emptyOn.includes(response.status)) return { reply: [], response };
    if (!response.ok) throw await apiError(response, url);
    try {
      return { reply: await response.json(), response };
    } catch {
      return { reply: undefined, response };
    }
  }

  async function get(url, listField, emptyOn) {
    const { reply, response } = await getJson(url, emptyOn);
    const items = listField === undefined ? reply : reply?.[listField];
    if (!Array.isArray(items)) throw notShaped(url, 'a JSON list');
    return { items, next: nextLink(response.headers.get('link')) };
  }

  async function getAll(path, { listField, emptyOn } = {}) {
    const items = [];
    for (let url = API + path; url; ) {
      const page = await get(url, listField, emptyOn);
      items.push(...page.items);
      url = page.next;
    }
    return items;
  }

  // Returns the one JSON object at `path`, such as a single PR.
  async function getOne(path) {
    const url = API + path;
    const { reply } = await getJson(url);
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw notShaped(url, 'a JSON object');
    return reply;
  }

  return { getAll, getOne };
}

function notShaped(url, shape) {
  return new ToolError(`GitHub sent a reply that is not ${shape} for ${new URL(url).pathname}. Try again later, and report it as an Exhibit issue if it keeps happening.`);
}

// Returns how many milliseconds GitHub asks us to wait before we ask again, or null when the
// reply is not a rate limit. GitHub says to wait in one of two ways: a retry-after header in
// seconds, or no requests left until the x-ratelimit-reset time (in Unix seconds).
function rateLimitWait(response, nowMs) {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const reset = response.headers.get('x-ratelimit-reset');
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset !== null && /^\d+$/.test(reset)) {
    // One second more, so the wait ends after the reset and not just before it.
    return Math.max(0, Number(reset) * 1000 - nowMs) + 1000;
  }
  return null;
}

function nextLink(header) {
  if (!header) return null;
  const match = header.split(',').map((part) => part.match(/<([^>]+)>\s*;\s*rel="next"/)).find(Boolean);
  return match ? match[1] : null;
}

async function apiError(response, url) {
  let detail = '';
  try {
    detail = (await response.json()).message ?? '';
  } catch {
    // The body was not JSON. The status alone says enough.
  }
  const what = `GitHub answered ${response.status}${detail ? ` (${detail})` : ''} for ${new URL(url).pathname}`;
  if (response.status === 401) return new ToolError(`${what}. GITHUB_TOKEN was refused: make a new token and set it.`);
  if (response.status === 403 || response.status === 429) {
    return new ToolError(`${what}. The token may lack access, or the rate limit is used up: check the token, or wait and try again.`);
  }
  if (response.status === 404) return new ToolError(`${what}. Check the repo name, and that GITHUB_TOKEN can read that repo.`);
  if (response.status >= 500) return new ToolError(`${what}. GitHub had a problem: try again later.`);
  return new ToolError(`${what}.`);
}
