// The small local server for `exhibit label --review` (spec 8.4). It serves the review page and
// passes each answer to the review session (src/label-review.js), which writes the labels file.
//
// It listens on 127.0.0.1 only. Every path starts with a random token, so another page in the
// browser cannot guess the address. It answers only when the Host header names 127.0.0.1 or
// localhost, so a web site cannot reach it through a DNS name that points at this machine. And it
// takes only JSON posts, which a plain form on another site cannot send.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ToolError } from './tool-error.js';

const PAGE = new URL('./review-page.html', import.meta.url);
// The most bytes one answer can have. A label has at most about 800 characters.
const BODY_LIMIT = 100_000;

/**
 * Starts the server for `session` on a free port. Returns { url, finished, close }. `url` is the
 * page's address, with the token. `finished` resolves when the person presses Finish on the page,
 * and rejects when handling a request hits a bug. `close()` stops the server.
 */
export async function startReviewServer(session, { port = 0 } = {}) {
  const page = readFileSync(PAGE, 'utf8');
  const token = randomBytes(16).toString('hex');
  let finish;
  let fail;
  const finished = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      send(response, 500, { error: 'Exhibit hit a bug. The terminal says what it was.' });
      fail(error);
    });
  });

  async function handle(request, response) {
    const { port: bound } = server.address();
    if (![`127.0.0.1:${bound}`, `localhost:${bound}`].includes(request.headers.host)) return send(response, 403, { error: 'This page answers only on 127.0.0.1 or localhost.' });
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const prefix = `/${token}/`;
    if (!path.startsWith(prefix)) return send(response, 404, { error: 'Not found.' });
    const route = `${request.method} ${path.slice(prefix.length)}`;
    if (route === 'GET ') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(page);
    }
    if (route === 'GET api/state') return send(response, 200, session.state());
    if (route !== 'POST api/answer' && route !== 'POST api/finish') return send(response, 404, { error: 'Not found.' });
    if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) return send(response, 415, { error: 'Send the answer as JSON.' });
    const body = await readJson(request);
    if (body === null) return send(response, 400, { error: 'The answer is not JSON, or it is too long.' });
    if (route === 'POST api/finish') {
      send(response, 200, session.summary());
      finish();
      return undefined;
    }
    try {
      await session.answer(body.id, body);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return send(response, 400, { error: error.message, state: session.state() });
    }
    return send(response, 200, session.state());
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/${token}/`,
    finished,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

// The request body as JSON, or null when it is not JSON or is longer than BODY_LIMIT.
async function readJson(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > BODY_LIMIT) return null;
  }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
