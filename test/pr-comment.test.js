import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../src/commands/publish.js';
import { COMMENT_MARKER, renderComment } from '../src/pr-comment.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MEETS_POLICY = JSON.parse(fixture('pr-comment/meets-policy.json'));
const NEEDS_PERSON = JSON.parse(fixture('pr-comment/needs-person.json'));
// A reply that GitHub sent to a POST of an issue comment, recorded with gh api.
const RECORDED_COMMENT = JSON.parse(fixture('github/pr-comment-reply.json'));

test('the comment for an exhibit that meets the policy matches the stored text', () => {
  const link = `https://github.com/acme/widgets/blob/${'c'.repeat(40)}/prs/7/${MEETS_POLICY.head}.json`;
  assert.equal(renderComment(MEETS_POLICY, { enforce: true, link, where: 'unused' }), fixture('pr-comment/meets-policy.md'));
});

test('the comment for needs_person in shadow mode shows the first 10 of 12 gaps, then a count of the rest', () => {
  const where = `prs/8/${NEEDS_PERSON.head}.json on exhibit-data`;
  assert.equal(renderComment(NEEDS_PERSON, { enforce: false, link: null, where }), fixture('pr-comment/needs-person.md'));
});

// A GitHub that keeps the comments of PR 7 in acme/widgets, and answers the requests that
// upsertComment sends, in the shapes of GitHub's recorded replies. The token's account is
// `viewer`. `calls` lists each request as "METHOD path".
function fakeGitHub({ viewer = 'github-actions[bot]', comments = [] } = {}) {
  let nextId = 9000000001;
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const rest = (comment) => ({ ...RECORDED_COMMENT, id: comment.id, url: `https://api.github.com/repos/acme/widgets/issues/comments/${comment.id}`, html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${comment.id}`, user: { ...RECORDED_COMMENT.user, login: comment.author }, body: comment.body });
  async function fetch(url, init = {}) {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${pathname}`);
    if (method === 'POST' && pathname === '/graphql') {
      const { variables } = JSON.parse(init.body);
      assert.deepEqual(variables, { owner: 'acme', name: 'widgets', number: 7, after: null });
      const nodes = comments.map((comment) => ({ fullDatabaseId: String(comment.id), url: rest(comment).html_url, body: comment.body, viewerDidAuthor: comment.author === viewer }));
      return reply(200, { data: { rateLimit: { cost: 1 }, repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
    }
    if (method === 'POST' && pathname === '/repos/acme/widgets/issues/7/comments') {
      const comment = { id: nextId++, author: viewer, body: JSON.parse(init.body).body };
      comments.push(comment);
      return reply(201, rest(comment));
    }
    const patch = /^\/repos\/acme\/widgets\/issues\/comments\/(\d+)$/.exec(pathname);
    if (method === 'PATCH' && patch) {
      const comment = comments.find((found) => String(found.id) === patch[1]);
      // GitHub refuses an edit of another account's comment. The test fails if Exhibit asks.
      assert.equal(comment.author, viewer, 'Exhibit tried to edit a comment it did not write');
      comment.body = JSON.parse(init.body).body;
      return reply(200, rest(comment));
    }
    throw new Error(`fake GitHub: no reply for ${method} ${pathname}`);
  }
  return { fetch, calls, comments };
}

// A folder with an evidence.json for PR 7, and a run of exhibit publish --storage local in it.
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-comment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (value) => writeFileSync(join(dir, 'evidence.json'), JSON.stringify(value, null, 2) + '\n');
  const run = async (github, extra = ['--comment']) => {
    let out = '';
    const stdout = { write: (text) => { out += text; } };
    const code = await publish(['--evidence', 'evidence.json', '--storage', 'local', ...extra], { cwd: dir, env: { GITHUB_TOKEN: 'test-token' }, fetch: github.fetch, stdout });
    return { code, out };
  };
  return { write, run };
}

const forPr7 = (exhibit) => ({ ...exhibit, pr: 7 });

test('the first run with --comment posts one comment that starts with the marker', async (t) => {
  const { write, run } = setup(t);
  const github = fakeGitHub();
  write(forPr7(NEEDS_PERSON));

  const { code, out } = await run(github);

  assert.equal(code, 0);
  assert.deepEqual(github.calls, ['POST /graphql', 'POST /repos/acme/widgets/issues/7/comments']);
  assert.equal(github.comments.length, 1);
  assert.equal(github.comments[0].body, renderComment(forPr7(NEEDS_PERSON), { enforce: false, link: null, where: `.exhibit/out/prs/7/${NEEDS_PERSON.head}.json` }));
  assert.match(out, /^Wrote \.exhibit\/out\/prs\/7\/[0-9a-f]{40}\.json\.\nPosted the comment on PR 7: https:\/\/github\.com\/acme\/widgets\/pull\/7#issuecomment-9000000001\n$/);
});

test('a second run updates the same comment, and a run with nothing new leaves it alone', async (t) => {
  const { write, run } = setup(t);
  const github = fakeGitHub();
  write(forPr7(NEEDS_PERSON));
  await run(github);

  write({ ...forPr7(MEETS_POLICY), head: NEEDS_PERSON.head });
  const second = await run(github, ['--comment', '--enforce']);

  assert.equal(second.code, 0);
  assert.equal(github.comments.length, 1);
  assert.match(github.comments[0].body, /^<!-- exhibit:pr-summary -->\n### Exhibit: meets the policy\n/);
  assert.doesNotMatch(github.comments[0].body, /Shadow mode/);
  assert.deepEqual(github.calls.slice(2), ['POST /graphql', 'PATCH /repos/acme/widgets/issues/comments/9000000001']);
  assert.match(second.out, /\nUpdated the comment on PR 7: https:\/\/github\.com\/acme\/widgets\/pull\/7#issuecomment-9000000001\n$/);

  const third = await run(github, ['--comment', '--enforce']);
  assert.equal(third.code, 0);
  assert.deepEqual(github.calls.slice(4), ['POST /graphql']);
  assert.match(third.out, /\nThe comment already says this\. Nothing changed on PR 7: /);
});

test('a comment by someone else that starts with the marker is left alone, and so is our own comment without it', async (t) => {
  const { write, run } = setup(t);
  const copy = `${COMMENT_MARKER}\n### Exhibit: meets the policy\n\nLooks the same, but someone else wrote it.\n`;
  const review = '## Review\n\nA comment by the same account, without the marker.\n';
  const github = fakeGitHub({ comments: [{ id: 5, author: 'mallory', body: copy }, { id: 6, author: 'github-actions[bot]', body: review }] });
  write(forPr7(NEEDS_PERSON));

  const { code } = await run(github);

  assert.equal(code, 0);
  assert.deepEqual(github.calls, ['POST /graphql', 'POST /repos/acme/widgets/issues/7/comments']);
  assert.equal(github.comments.length, 3);
  assert.equal(github.comments[0].body, copy);
  assert.equal(github.comments[1].body, review);
  assert.ok(github.comments[2].body.startsWith(COMMENT_MARKER));
});

test('without --comment, publish sends nothing to GitHub', async (t) => {
  const { write, run } = setup(t);
  const github = fakeGitHub();
  write(forPr7(NEEDS_PERSON));

  const { code } = await run(github, []);

  assert.equal(code, 0);
  assert.deepEqual(github.calls, []);
});
