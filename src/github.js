import { ToolError } from './tool-error.js';

const API = 'https://api.github.com';

// A small GitHub REST client. It takes the fetch function as a parameter, so tests can pass one
// that replays recorded responses. `getAll` follows the Link header's rel="next" URL exactly as
// GitHub gives it, until there is no next page, and returns the items of every page in order.
// `getOne` returns the object at one path.
export function createGitHub({ token, fetch }) {
  // Sends one GET and returns the parsed JSON body and the response, or throws a ToolError.
  async function request(url) {
    let response;
    try {
      response = await fetch(url, {
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
    if (!response.ok) throw await apiError(response, url);
    try {
      return { body: await response.json(), response };
    } catch {
      return { body: undefined, response };
    }
  }

  async function getAll(path) {
    const items = [];
    for (let url = API + path; url; ) {
      const { body, response } = await request(url);
      if (!Array.isArray(body)) throw notShaped(url, 'a JSON list');
      items.push(...body);
      url = nextLink(response.headers.get('link'));
    }
    return items;
  }

  // Returns the one JSON object at `path`, such as a single PR.
  async function getOne(path) {
    const url = API + path;
    const { body } = await request(url);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw notShaped(url, 'a JSON object');
    return body;
  }

  return { getAll, getOne };
}

function notShaped(url, shape) {
  return new ToolError(`GitHub sent a reply that is not ${shape} for ${new URL(url).pathname}. Try again later, and report it as an Exhibit issue if it keeps happening.`);
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
