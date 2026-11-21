import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { label } from '../src/commands/label.js';
import { checkLabelLine } from '../src/labels.js';
import { createReviewSession } from '../src/label-review.js';
import { startReviewServer } from '../src/review-server.js';
import { SHOP_HISTORY } from './fixtures/report/shop-history.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const shopText = () => readFileSync(SHOP_HISTORY, 'utf8').trimEnd().split('\n').filter((line) => JSON.parse(line).number <= 12).map((line) => line + '\n').join('');
const ANSWER = { action: 'save', code: 'Count ignored quantity', category: 'Arithmetic', would_have_caught: 'A test with two of one item', rejected_prs: [11], known_at_review: false };

function folderWithHistory(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-review-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), shopText());
  return cwd;
}

const readLabels = (cwd) => readFileSync(join(cwd, '.exhibit', 'labels.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
const post = (url, body, headers = { 'content-type': 'application/json' }) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

async function started(t) {
  const cwd = folderWithHistory(t);
  const session = await createReviewSession({ cwd, now: () => new Date('2026-11-21T10:00:00Z') });
  await session.prepared;
  const server = await startReviewServer(session);
  t.after(() => server.close());
  return { cwd, server };
}

// A GET with a Host header of our choice, which fetch does not allow.
function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the server listens on 127.0.0.1, serves the page under its token, and answers state as JSON', async (t) => {
  const { server } = await started(t);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Exhibit: label escaped defects<\/title>/);
  const state = await (await fetch(`${server.url}api/state`)).json();
  assert.deepEqual(state.items.map((item) => item.id), ['D-012', 'D-007', 'D-006']);
});

test('the server refuses a request without the token, from another host name, or not as JSON', async (t) => {
  const { cwd, server } = await started(t);
  const origin = new URL(server.url).origin;
  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal((await fetch(`${origin}/api/state`)).status, 404);
  assert.equal(await getWithHost(server.url, `evil.example:${new URL(server.url).port}`), 403);
  // A plain form on another site sends text/plain or a form type, never JSON.
  assert.equal((await post(`${server.url}api/answer`, { id: 'D-012', ...ANSWER }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${server.url}api/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status, 400);
  assert.equal(existsSync(join(cwd, '.exhibit', 'labels.jsonl')), false);
});

test('an answer is written at once, and a bad one gets its reason with status 400', async (t) => {
  const { cwd, server } = await started(t);
  const saved = await post(`${server.url}api/answer`, { id: 'D-012', ...ANSWER });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).items[0].state, 'saved');
  assert.deepEqual(readLabels(cwd).map((line) => line.id), ['D-012']);
  const bad = await post(`${server.url}api/answer`, { id: 'D-007', ...ANSWER, rejected_prs: [99] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /PR 99 is not a link of D-007/);
});

test('Finish on the page ends the server\'s run with the summary', async (t) => {
  const { server } = await started(t);
  await post(`${server.url}api/answer`, { id: 'D-012', ...ANSWER });
  const reply = await post(`${server.url}api/finish`, {});
  assert.equal(reply.status, 200);
  assert.deepEqual((await reply.json()).run, { shown: 1, labeled: 1, skipped: 0, open: 2, relinked: 0, new_links: 0 });
  await server.finished;
});

test('exhibit label --review opens the page, writes what the page sends, and prints the summary after Finish', async (t) => {
  const cwd = folderWithHistory(t);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.GITHUB_TOKEN;
  const child = spawn(process.execPath, [bin, 'label', '--review', '--no-open', '--json'], { cwd, env });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const found = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\//.exec(stderr);
      if (found) resolve(found[0]);
    });
    child.on('exit', () => reject(new Error(`exhibit exited before it printed the address: ${stderr}`)));
  });
  assert.match(stderr, /^3 escaped defects have no code yet\. Label them on the review page:/);
  // The page says when it shows a defect: here D-012, D-007 and D-006, but D-006 gets no answer.
  for (const id of ['D-012', 'D-007', 'D-006']) assert.equal((await post(`${url}api/seen`, { id })).status, 200);
  assert.equal((await post(`${url}api/answer`, { id: 'D-012', ...ANSWER })).status, 200);
  assert.equal((await post(`${url}api/answer`, { id: 'D-007', action: 'skip' })).status, 200);
  await post(`${url}api/finish`, {});
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { shown: 3, labeled: 1, skipped: 1, open: 2, relinked: 0, new_links: 0, output: '.exhibit/labels.jsonl' });
  const lines = readLabels(cwd);
  assert.equal(lines.length, 1);
  assert.deepEqual(checkLabelLine(lines[0]), []);
});

test('Ctrl+C stops the page and prints the summary; the browser opener gets the address', async (t) => {
  const cwd = folderWithHistory(t);
  const signals = new EventEmitter();
  const opened = [];
  let out = '';
  let err = '';
  const stdout = { write: (text) => { out += text; } };
  const stderr = { write: (text) => { err += text; } };
  const run = label(['--review', '--json'], { cwd, env: {}, stdout, stderr, signals, openBrowser: (url) => opened.push(url) });
  while (opened.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await post(`${opened[0]}api/seen`, { id: 'D-012' });
  await post(`${opened[0]}api/answer`, { id: 'D-012', ...ANSWER });
  signals.emit('SIGINT');
  await run;
  // One defect was shown and labeled, as the terminal flow would count a quit after one label.
  assert.deepEqual(JSON.parse(out), { shown: 1, labeled: 1, skipped: 0, open: 2, relinked: 0, new_links: 0, output: '.exhibit/labels.jsonl' });
  assert.match(err, /review page/);
  // The server is closed.
  await assert.rejects(fetch(`${opened[0]}api/state`));
});

test('after Finish, the command leaves no SIGINT listener behind', async (t) => {
  const cwd = folderWithHistory(t);
  const signals = new EventEmitter();
  const opened = [];
  const run = label(['--review'], { cwd, env: {}, stdout: { write() {} }, signals, openBrowser: (url) => opened.push(url) });
  while (opened.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.listenerCount('SIGINT'), 1);
  await post(`${opened[0]}api/finish`, {});
  await run;
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('--review with every defect labeled starts no page, and --no-open needs --review', async (t) => {
  const cwd = folderWithHistory(t);
  const lines = ['D-012', 'D-007', 'D-006'].map((id) => JSON.stringify({ id, fix_pr: Number(id.slice(2)), introducing_prs: [], rejected_prs: [], code: 'x', category: 'y', would_have_caught: 'z', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-01T00:00:00.000Z' }));
  writeFileSync(join(cwd, '.exhibit', 'labels.jsonl'), lines.join('\n') + '\n');
  let out = '';
  const opened = [];
  await label(['--review'], { cwd, env: {}, stdout: { write: (text) => { out += text; } }, signals: new EventEmitter(), openBrowser: (url) => opened.push(url) });
  assert.deepEqual(opened, []);
  assert.match(out, /^Every escaped defect has a code already/);
  // Those lines keep and reject no link, so each SZZ link is new. The page does not ask about new
  // links, so it says where to answer them.
  assert.match(out, /3 labeled defects have new SZZ links that nobody kept or rejected yet\. Run exhibit label without --review to answer them\./);
  await assert.rejects(label(['--no-open'], { cwd, env: {}, stdout: { write() {} } }), /--no-open works only with --review/);
});
