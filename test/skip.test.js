import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/commands/check.js';
import { publish } from '../src/commands/publish.js';
import { exitCode, renderSummary } from '../src/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { renderComment } from '../src/pr-comment.js';
import { readSkip, skipReason } from '../src/skip.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();

const HEAD = '3333333abcdef333333333333333333333333333';
const NEEDS_PERSON = JSON.parse(readFileSync(new URL('./fixtures/pr-comment/needs-person.json', import.meta.url), 'utf8'));
const RECORDED = { status: 'recorded', by: 'builder-bot[bot]', reason: 'The probe needs a real phone.', head: HEAD };
const withSkip = (skip, verdict = 'needs_person') => ({ ...NEEDS_PERSON, verdict, skip });

test('the reason is the text after "Exhibit skip:" on the first line that has some', () => {
  assert.equal(skipReason('Some text.\n\nExhibit skip: no phone on CI.\nMore.'), 'no phone on CI.');
  assert.equal(skipReason('  Exhibit skip:   spaces around  \r\nnext'), 'spaces around');
  // A line with nothing after the colon gives no reason, so a later line can.
  assert.equal(skipReason('Exhibit skip:\nExhibit skip: the second line'), 'the second line');
  assert.equal(skipReason('Exhibit skip:   '), null);
  // The words must start the line, with this case.
  assert.equal(skipReason('See Exhibit skip: in the docs'), null);
  assert.equal(skipReason('exhibit skip: lower case'), null);
  assert.equal(skipReason(null), null);
});

test('readSkip records both parts, says which part is missing, and asks who labelled only when there is a label', async () => {
  let asked = 0;
  const labelAddedBy = async () => { asked += 1; return 'octocat'; };
  const body = 'Exhibit skip: the probe needs a real phone.';
  assert.deepEqual(await readSkip({ labels: ['bug', 'exhibit-skip'], body }, { head: HEAD, labelAddedBy }), { status: 'recorded', by: 'octocat', reason: 'the probe needs a real phone.', head: HEAD });
  assert.deepEqual(await readSkip({ labels: ['exhibit-skip'], body: 'No reason here.' }, { head: HEAD, labelAddedBy }), { status: 'no-reason', by: 'octocat', reason: null, head: HEAD });
  assert.equal(asked, 2);
  assert.deepEqual(await readSkip({ labels: [], body }, { head: HEAD, labelAddedBy }), { status: 'no-label', by: null, reason: 'the probe needs a real phone.', head: HEAD });
  assert.equal(await readSkip({ labels: ['bug'], body: null }, { head: HEAD, labelAddedBy }), null);
  assert.equal(asked, 2);
});

test('the exit code: a full skip turns needs_person into 0 in enforce mode, and nothing else changes', () => {
  const noReason = { ...RECORDED, status: 'no-reason', reason: null };
  const noLabel = { ...RECORDED, status: 'no-label', by: null };
  const cases = [
    // [verdict, skip, enforce code, shadow code]
    ['needs_person', RECORDED, 0, 0],
    ['needs_person', noReason, 1, 0],
    ['needs_person', noLabel, 1, 0],
    ['needs_person', null, 1, 0],
    ['needs_person', undefined, 1, 0],
    ['error', RECORDED, 2, 0],
    ['meets_policy', RECORDED, 0, 0]
  ];
  for (const [verdict, skip, enforce, shadow] of cases) {
    const exhibit = { verdict, skip };
    assert.equal(exitCode(exhibit), enforce, `${verdict} with ${skip?.status ?? skip} in enforce mode`);
    assert.equal(exitCode(exhibit, { shadow: true }), shadow, `${verdict} with ${skip?.status ?? skip} in shadow mode`);
  }
});

test('summary.md names the skip, its reason and who added the label, and keeps the verdict', () => {
  const summary = renderSummary(withSkip(RECORDED));
  assert.match(summary, /^# Exhibit check: needs a person\n\nVerdict: \*\*needs_person\*\* \(exit code 0\)\.\n\nSkip, read at head commit 3333333: the label exhibit-skip was added by builder-bot\[bot\]\. Reason: The probe needs a real phone\.\n\nThe verdict stays needs_person, but the skip lets the PR through\. It is recorded and counted\.\n/);
  assert.match(renderSummary(withSkip(RECORDED), { shadow: true }), /\(exit code 0\)[\s\S]*Shadow mode, so the skip changes nothing\./);
  assert.match(renderSummary(withSkip(RECORDED, 'error')), /\(exit code 2\)[\s\S]*A skip does not let an error through/);
  assert.match(renderSummary(withSkip({ ...RECORDED, by: null })), /added by someone the forge does not name/);
});

test('summary.md says why half a skip changes nothing', () => {
  const noReason = renderSummary(withSkip({ ...RECORDED, status: 'no-reason', reason: null }));
  assert.match(noReason, /\(exit code 1\)/);
  assert.match(noReason, /has the label exhibit-skip, but its body has no line that starts with "Exhibit skip:" and gives a reason\. A label with no reason is not a skip/);
  const noLabel = renderSummary(withSkip({ ...RECORDED, status: 'no-label', by: null }));
  assert.match(noLabel, /\(exit code 1\)/);
  assert.match(noLabel, /does not have the label exhibit-skip\. A reason with no label is not a skip/);
  // No skip, no line.
  assert.doesNotMatch(renderSummary(withSkip(null)), /skip/i);
});

test('the schema allows the skip record, and still checks it and the rest of the exhibit', () => {
  assert.deepEqual(checkExhibit(withSkip(RECORDED)), []);
  assert.deepEqual(checkExhibit(withSkip(null)), []);
  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, status: 'no-reason', reason: null })), []);
  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, status: 'no-label', by: null })), []);
  // An exhibit from before skips has no skip field, and still passes.
  assert.deepEqual(checkExhibit(NEEDS_PERSON), []);

  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, status: 'maybe' })), ['/skip/status: must be recorded, no-reason or no-label, not "maybe"']);
  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, reason: null })), ['/skip/reason: must be string, not null']);
  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, status: 'no-reason' })), ['/skip/reason: must be null, not string']);
  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, status: 'no-label' })), ['/skip/by: must be null, not string']);
  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, head: 'main' })), ['/skip/head: does not match ^[0-9a-f]{40}([0-9a-f]{24})?$']);
  assert.deepEqual(checkExhibit(withSkip({ ...RECORDED, verdict: 'skipped' })), ['/skip: has a field the schema does not allow: verdict']);
  // A skip does not loosen the rest: a bad verdict is still a problem.
  assert.deepEqual(checkExhibit({ ...withSkip(RECORDED), verdict: 'skipped' }), ['/verdict: must be meets_policy, needs_person or error, not "skipped"']);
});

test('the PR comment shows the skip, with the reason as inline code so it cannot mention anyone', () => {
  const skip = { ...RECORDED, reason: 'ping @octocat with `code` and **bold**' };
  const body = renderComment(withSkip(skip), { enforce: true, link: null, where: 'x' });
  assert.match(body, /\n\nSkip, read at head commit 3333333: the label exhibit-skip was added by builder-bot\[bot\]\. Reason: ``ping @octocat with `code` and \*\*bold\*\*`` The verdict stays needs_person, but the skip lets the PR through\. It is recorded and counted\.\n\n/);
  assert.match(renderComment(withSkip(RECORDED), { enforce: false, link: null, where: 'x' }), /Shadow mode: nothing waits on this\.\n\nSkip, read at head commit [^\n]* Shadow mode, so the skip changes nothing\./);
  assert.match(renderComment(withSkip({ ...RECORDED, status: 'no-reason', reason: null }), { enforce: true, link: null, where: 'x' }), /A label with no reason is not a skip/);
  // An exhibit with no skip gets the same comment as before.
  assert.equal(renderComment(withSkip(null), { enforce: true, link: null, where: 'x' }), renderComment(NEEDS_PERSON, { enforce: true, link: null, where: 'x' }));
});

// A repo with a base commit and a head commit that changes src/, which the default rules cover
// and which needs tests-before-after, so the verdict is needs_person.
function buildRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-skip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, 'src'), { recursive: true });
  const env = gitEnv(home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'evidence.yml'), 'version: 3\ndefault:\n  risk: medium\n  needs:\n    - tests-before-after\n');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const a = 2;\n');
  git('commit', '-q', '-am', 'head');
  return { dir, repo, base, head: git('rev-parse', 'HEAD') };
}

// A GitHub that answers the PR and its issue events. `calls` lists each path asked.
function fakeGitHub({ base, head, labels, body, events = [] }) {
  const calls = [];
  const reply = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch = async (url) => {
    const { pathname, search } = new URL(url);
    calls.push(pathname + search);
    if (pathname === '/repos/owner/name/pulls/7') return reply({ number: 7, title: 'Change the app', body, labels: labels.map((name) => ({ name })), base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'task/app' } });
    if (pathname === '/repos/owner/name/issues/7/events') return reply(events);
    throw new Error(`fake GitHub: no reply for ${pathname}`);
  };
  return { fetch, calls };
}

// The label events as GitHub's REST API gives them, oldest first: added, taken off, added again.
const LABEL_EVENTS = [
  { event: 'labeled', actor: { login: 'first-person' }, label: { name: 'exhibit-skip' } },
  { event: 'unlabeled', actor: { login: 'first-person' }, label: { name: 'exhibit-skip' } },
  { event: 'labeled', actor: { login: 'someone-else' }, label: { name: 'bug' } },
  { event: 'labeled', actor: { login: 'builder-bot[bot]' }, label: { name: 'exhibit-skip' } }
];

async function runCheck(fixture, github, extra = []) {
  let out = '';
  const code = await check(['--pr', '7', '--repo', 'owner/name', ...extra], { env: { GITHUB_TOKEN: 'test-token' }, cwd: fixture.repo, fetch: github.fetch, stdout: { write: (text) => { out += text; } }, stderr: { write() {} } });
  const read = (name) => readFileSync(join(fixture.repo, '.exhibit', name), 'utf8');
  return { code, out, evidence: JSON.parse(read('evidence.json')), summary: read('summary.md') };
}

test('check --pr in enforce mode: a needs_person PR with the label and a reason exits 0, and the exhibit records the skip', async (t) => {
  const fixture = buildRepo(t);
  const github = fakeGitHub({ ...fixture, labels: ['exhibit-skip'], body: 'Text.\nExhibit skip: the probe needs a real phone.\n', events: LABEL_EVENTS });

  const { code, out, evidence, summary } = await runCheck(fixture, github);

  assert.equal(code, 0);
  assert.equal(evidence.verdict, 'needs_person');
  assert.deepEqual(evidence.skip, { status: 'recorded', by: 'builder-bot[bot]', reason: 'the probe needs a real phone.', head: fixture.head });
  assert.deepEqual(checkExhibit(evidence), []);
  assert.deepEqual(github.calls, ['/repos/owner/name/pulls/7', '/repos/owner/name/issues/7/events?per_page=100']);
  assert.match(summary, /Verdict: \*\*needs_person\*\* \(exit code 0\)\.\n\nSkip, read at head commit [0-9a-f]{7}: the label exhibit-skip was added by builder-bot\[bot\][^\n]*Reason: the probe needs a real phone\./);
  assert.match(out, /^Verdict: needs_person\. [^\n]*\nWrote [^\n]*\nThe PR carries a skip, so the exit code is 0\. Reason: the probe needs a real phone\.\n$/);
});

test('check --pr: a label with no reason, or a reason with no label, still exits 1, and the summary says why', async (t) => {
  const fixture = buildRepo(t);
  const labelOnly = await runCheck(fixture, fakeGitHub({ ...fixture, labels: ['exhibit-skip'], body: 'No reason.', events: LABEL_EVENTS }));
  assert.equal(labelOnly.code, 1);
  assert.equal(labelOnly.evidence.skip.status, 'no-reason');
  assert.match(labelOnly.summary, /A label with no reason is not a skip/);

  const github = fakeGitHub({ ...fixture, labels: [], body: 'Exhibit skip: no label on this one.' });
  const reasonOnly = await runCheck(fixture, github);
  assert.equal(reasonOnly.code, 1);
  assert.deepEqual(reasonOnly.evidence.skip, { status: 'no-label', by: null, reason: 'no label on this one.', head: fixture.head });
  assert.match(reasonOnly.summary, /A reason with no label is not a skip/);
  // With no label, there is no one to ask about.
  assert.deepEqual(github.calls, ['/repos/owner/name/pulls/7']);

  const none = await runCheck(fixture, fakeGitHub({ ...fixture, labels: ['bug'], body: null }));
  assert.equal(none.code, 1);
  assert.equal(none.evidence.skip, null);
});

test('check --pr: a skip does not let verdict error through, and in shadow mode it changes nothing', async (t) => {
  const fixture = buildRepo(t);
  const skipped = { ...fixture, labels: ['exhibit-skip'], body: 'Exhibit skip: no phone.', events: LABEL_EVENTS };
  const broken = { 'tests-before-after': async () => { throw new Error('disk on fire'); } };
  let out = '';
  const code = await check(['--pr', '7', '--repo', 'owner/name'], { env: { GITHUB_TOKEN: 'test-token' }, cwd: fixture.repo, fetch: fakeGitHub(skipped).fetch, stdout: { write: (text) => { out += text; } }, collectors: broken });
  assert.equal(code, 2);
  assert.doesNotMatch(out, /carries a skip/);
  const summary = readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8');
  assert.match(summary, /A skip does not let an error through/);

  const shadow = await runCheck(fixture, fakeGitHub(skipped), ['--shadow']);
  assert.equal(shadow.code, 0);
  assert.equal(shadow.evidence.skip.status, 'recorded');
  assert.match(shadow.summary, /Shadow mode, so the skip changes nothing\./);
  assert.doesNotMatch(shadow.out, /carries a skip/);
});

test('exhibit publish writes the skip to the data branch with the exhibit, and shows it in the comment', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-skip-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = gitEnv(home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
  const remote = join(dir, 'remote.git');
  const repo = join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
  git(repo, 'push', '-q', 'origin', 'main');

  const exhibit = { ...withSkip(RECORDED), pr: 7 };
  const text = JSON.stringify(exhibit, null, 2) + '\n';
  writeFileSync(join(dir, 'evidence.json'), text);
  const posted = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/graphql') return reply(200, { data: { rateLimit: { cost: 1 }, repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    if (init.method === 'POST' && pathname === '/repos/acme/widgets/issues/7/comments') {
      posted.push(JSON.parse(init.body).body);
      return reply(201, { id: 1, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' });
    }
    throw new Error(`fake GitHub: no reply for ${pathname}`);
  };

  // publish runs git with this process's env, so the user's git config, such as commit signing,
  // is kept out for the call, as gitEnv does for a child process.
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const code = await publish(['--evidence', join(dir, 'evidence.json'), '--comment', '--enforce'], { cwd: repo, env: { GITHUB_TOKEN: 'test-token' }, fetch, stdout: { write() {} } });

  assert.equal(code, 0);
  const stored = git(remote, 'show', `exhibit-data:prs/7/${HEAD}.json`);
  assert.equal(stored, text);
  assert.deepEqual(JSON.parse(stored).skip, RECORDED);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Skip, read at head commit 3333333: the label exhibit-skip was added by builder-bot\[bot\]\. Reason: `The probe needs a real phone\.` The verdict stays needs_person, but the skip lets the PR through\./);
});
