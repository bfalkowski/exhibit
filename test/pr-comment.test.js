import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../src/commands/publish.js';
import { renderErrorSummary } from '../src/check.js';
import { COMMENT_MARKER, renderComment, renderErrorComment } from '../src/pr-comment.js';

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
// `viewer`. `calls` lists each request as "METHOD path". The comments list comes in pages of
// `pageSize`, and the cursor of a page is the index of the comment after it. A client that drops
// the cursor would ask for the first page forever, so a fake that is asked for more than
// MOST_PAGES_ASKED pages fails, and the test does not hang.
const MOST_PAGES_ASKED = 20;
function fakeGitHub({ viewer = 'github-actions[bot]', comments = [], pageSize = 100 } = {}) {
  let nextId = 9000000001;
  let pagesAsked = 0;
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const rest = (comment) => ({ ...RECORDED_COMMENT, id: comment.id, url: `https://api.github.com/repos/acme/widgets/issues/comments/${comment.id}`, html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${comment.id}`, user: { ...RECORDED_COMMENT.user, login: comment.author }, body: comment.body });
  async function fetch(url, init = {}) {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${pathname}`);
    if (method === 'POST' && pathname === '/graphql') {
      const { variables } = JSON.parse(init.body);
      const { after, ...pr } = variables;
      pagesAsked += 1;
      if (pagesAsked > MOST_PAGES_ASKED) throw new Error('fake GitHub: asked for too many pages of comments');
      assert.deepEqual(pr, { owner: 'acme', name: 'widgets', number: 7 });
      const start = after === null ? 0 : Number(after);
      const end = start + pageSize;
      const pageInfo = { hasNextPage: end < comments.length, endCursor: String(end) };
      const nodes = comments.slice(start, end).map((comment) => ({ fullDatabaseId: String(comment.id), url: rest(comment).html_url, body: comment.body, viewerDidAuthor: comment.author === viewer }));
      return reply(200, { data: { rateLimit: { cost: 1 }, repository: { pullRequest: { comments: { pageInfo, nodes } } } } });
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

test('our comment on the second page of comments is found and updated, not posted again', async (t) => {
  const { write, run } = setup(t);
  const others = [1, 2, 3].map((id) => ({ id, author: 'someone', body: `Comment ${id}.\n` }));
  const ours = { id: 4, author: 'github-actions[bot]', body: `${COMMENT_MARKER}\nAn older summary.\n` };
  const github = fakeGitHub({ comments: [...others, ours], pageSize: 2 });
  write(forPr7(NEEDS_PERSON));

  const { code } = await run(github);

  assert.equal(code, 0);
  assert.deepEqual(github.calls, ['POST /graphql', 'POST /graphql', 'PATCH /repos/acme/widgets/issues/comments/4']);
  assert.equal(github.comments.length, 4);
  assert.match(github.comments[3].body, /^<!-- exhibit:pr-summary -->\n### Exhibit: needs a person\n/);
});

test('without --comment, publish sends nothing to GitHub', async (t) => {
  const { write, run } = setup(t);
  const github = fakeGitHub();
  write(forPr7(NEEDS_PERSON));

  const { code } = await run(github, []);

  assert.equal(code, 0);
  assert.deepEqual(github.calls, []);
});

// When exhibit check fails before it has a verdict, it writes summary.md and no evidence.json.
// Publish then posts the reason from summary.md, so the PR says why there is no verdict.
const REASON = 'evidence.yml kinds.x: needs must be a list.\n\nSee docs/spec.md section 8.1.';

test('the comment for a check with no verdict gives the reason from summary.md in a code block', () => {
  assert.equal(renderErrorComment(REASON, { enforce: false }), [
    COMMENT_MARKER,
    '### Exhibit: Exhibit failed',
    '',
    'Verdict: **error**. exhibit check stopped before it had a verdict, so it wrote no exhibit, and nothing was stored.',
    '',
    'Shadow mode: nothing waits on this.',
    '',
    'The reason:',
    '',
    '```text',
    'evidence.yml kinds.x: needs must be a list.',
    '',
    'See docs/spec.md section 8.1.',
    '```',
    '',
    'The check job\'s summary says the same. Fix the cause, then run the check again.',
    ''
  ].join('\n'));
  // A reason with backticks cannot close the block early.
  assert.match(renderErrorComment('a ```b``` c', { enforce: true }), /\n````text\na ```b``` c\n````\n/);
  assert.match(renderErrorComment(null, { enforce: true }), /\nExhibit found no reason to show: there is no summary\.md with one beside the evidence file\. The check job's log says what went wrong\.\n/);
});

// A folder with only the summary.md that a failed check wrote, and a run of exhibit publish in it.
function setupFailedCheck(t, summary = renderErrorSummary(REASON, { shadow: true })) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-comment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.exhibit'));
  if (summary !== null) writeFileSync(join(dir, '.exhibit', 'summary.md'), summary);
  const run = async (github, extra) => {
    let out = '';
    const stdout = { write: (text) => { out += text; } };
    const code = await publish(['--evidence', '.exhibit/evidence.json', '--storage', 'local', ...extra], { cwd: dir, env: { GITHUB_TOKEN: 'test-token' }, fetch: github.fetch, stdout });
    return { code, out };
  };
  return { dir, run };
}

test('with no evidence.json, --comment --pr --repo posts the error and its reason, stores nothing, and exits 0', async (t) => {
  const { dir, run } = setupFailedCheck(t);
  const github = fakeGitHub();

  const { code, out } = await run(github, ['--comment', '--pr', '7', '--repo', 'acme/widgets']);

  assert.equal(code, 0);
  assert.deepEqual(github.calls, ['POST /graphql', 'POST /repos/acme/widgets/issues/7/comments']);
  assert.equal(github.comments[0].body, renderErrorComment(REASON, { enforce: false }));
  assert.equal(out, 'exhibit check wrote no .exhibit/evidence.json, so nothing was stored. .exhibit/summary.md says why.\nPosted the comment on PR 7: https://github.com/acme/widgets/pull/7#issuecomment-9000000001\n');
  assert.deepEqual(readdirSync(join(dir, '.exhibit')), ['summary.md']);
});

test('with no evidence.json, the error replaces the comment of an earlier verdict, and the next verdict replaces it again', async (t) => {
  const { write, run: runWithEvidence } = setup(t);
  const github = fakeGitHub();
  write(forPr7(NEEDS_PERSON));
  await runWithEvidence(github);

  const { run } = setupFailedCheck(t);
  const failed = await run(github, ['--comment', '--enforce', '--pr', '7', '--repo', 'acme/widgets', '--json']);
  assert.equal(failed.code, 0);
  assert.deepEqual(JSON.parse(failed.out), { storage: 'local', path: null, where: null, changed: false, commit: null, comment: { action: 'updated', url: 'https://github.com/acme/widgets/pull/7#issuecomment-9000000001' } });
  assert.equal(github.comments.length, 1);
  assert.equal(github.comments[0].body, renderErrorComment(REASON, { enforce: true }));

  await runWithEvidence(github);
  assert.equal(github.comments.length, 1);
  assert.match(github.comments[0].body, /^<!-- exhibit:pr-summary -->\n### Exhibit: needs a person\n/);
});

test('with no evidence.json and no summary.md, the comment says there is no reason to show', async (t) => {
  const { run } = setupFailedCheck(t, null);
  const github = fakeGitHub();
  const { code } = await run(github, ['--comment', '--pr', '7', '--repo', 'acme/widgets']);
  assert.equal(code, 0);
  assert.equal(github.comments[0].body, renderErrorComment(null, { enforce: false }));
});

test('with no evidence.json, publish without --comment, or without --pr and --repo, exits 2 with a plain message and sends nothing', async (t) => {
  const { run } = setupFailedCheck(t);
  const github = fakeGitHub();
  const why = 'exhibit check wrote no .exhibit/evidence.json, so there is no exhibit, and nothing was stored. The check failed before it had a verdict. .exhibit/summary.md says why: in GitHub Actions, read the check job\'s summary, or summary.md in the workflow artifact named exhibit.';
  await assert.rejects(run(github, []), { message: why });
  await assert.rejects(run(github, ['--comment']), { message: `${why} To post the error on the PR, give --pr N and --repo owner/name.` });
  await assert.rejects(run(github, ['--comment', '--pr', '7']), { message: `${why} To post the error on the PR, give --pr N and --repo owner/name.` });
  assert.deepEqual(github.calls, []);
});

test('--pr and --repo must match the exhibit when there is one', async (t) => {
  const { write, run } = setup(t);
  const github = fakeGitHub();
  write(forPr7(NEEDS_PERSON));
  await assert.rejects(run(github, ['--comment', '--pr', '8', '--repo', 'acme/widgets']), { message: 'evidence.json is the exhibit for PR 7 in acme/widgets, not for PR 8 in acme/widgets, so nothing was stored.' });
  await assert.rejects(run(github, ['--pr', '7', '--repo', 'acme/gadgets']), { message: 'evidence.json is the exhibit for PR 7 in acme/widgets, not for PR 7 in acme/gadgets, so nothing was stored.' });
  await assert.rejects(run(github, ['--pr', 'seven']), { message: /^--pr must be a PR number, such as 12, not "seven"\./ });
  await assert.rejects(run(github, ['--repo', 'widgets']), { message: /^--repo must look like owner\/name, not "widgets"\./ });
  const same = await run(github, ['--comment', '--pr', '7', '--repo', 'Acme/Widgets']);
  assert.equal(same.code, 0);
  assert.deepEqual(github.calls, ['POST /graphql', 'POST /repos/acme/widgets/issues/7/comments']);
});
