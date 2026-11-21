import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { classifyWithTracker, ticketKey } from '../src/fix-signals.js';
import { createJiraTracker, JiraReplyError } from '../src/jira.js';
import { buildReport, escapedDefects } from '../src/report.js';
import { ToolError } from '../src/tool-error.js';
import { replayFetch } from '../test-support/replay-fetch.js';

// Jira replies in the shape of Jira's REST API v2 "get issue", keyed by path and query, so no test
// reaches the network. Exhibit's developer has no Jira site, so the replies were written from
// Jira's documented reply shape, not recorded from a live site.
const REPLIES = fileURLToPath(new URL('./fixtures/jira/acme.json', import.meta.url));
const SITE = 'https://acme.atlassian.net';
const SIGNALS = ['label:bug', 'tracker:jira'];

function jira(settings = {}, { email } = {}) {
  const fetch = replayFetch(REPLIES);
  const tracker = createJiraTracker({ settings: { site: SITE, ...settings }, token: 'secret-jira-token', email, fetch });
  return { tracker, fetch };
}

const pr = (title, { branch = 'topic', labels = [] } = {}) => ({ number: 9, title, labels, branch });
const classify = async (title, settings, options) => (await classifyWithTracker(pr(title, options), SIGNALS, jira(settings).tracker)).classification;

test('a key whose Jira issue is a Bug matches, and fix_signal names the issue', async () => {
  assert.deepEqual(await classify('PAY-482: Crash on empty cart'), { fix: true, fix_signal: 'jira:PAY-482' });
});

test('a key whose Jira issue is a Story does not match', async () => {
  assert.deepEqual(await classify('PAY-483: Add a coupon field'), { fix: false, fix_signal: null });
});

test('settings.jira.issue_types replaces the default list of bug types', async () => {
  const settings = { issue_types: ['Defect'] };
  assert.deepEqual(await classify('PAY-484: Rounding is off', settings), { fix: true, fix_signal: 'jira:PAY-484' });
  assert.deepEqual(await classify('PAY-482: Crash on empty cart', settings), { fix: false, fix_signal: null });
});

test('an unknown key (404) does not match and gives no problem', async () => {
  const { tracker } = jira();
  const result = await classifyWithTracker(pr('PAY-404: Something'), SIGNALS, tracker);
  assert.deepEqual(result, { classification: { fix: false, fix_signal: null }, problem: null });
  assert.deepEqual(tracker.counts(), { requests: 1, not_found: 1 });
});

test('a Jira 5xx does not match and gives a problem for that PR, as a GitHub 5xx does in SZZ', async () => {
  const result = await classifyWithTracker(pr('PAY-503: Something'), SIGNALS, jira().tracker);
  assert.deepEqual(result.classification, { fix: false, fix_signal: null });
  assert.equal(result.problem, 'the tracker:jira signal could not check PAY-503, so it does not match. Jira answered 503 (Service Unavailable) for /rest/api/2/issue/PAY-503. Jira had a problem: try again later.');
});

test('a refused Jira token stops the run, and the message holds no token', async () => {
  await assert.rejects(classifyWithTracker(pr('PAY-401: Something'), SIGNALS, jira().tracker), (error) => {
    assert.ok(error instanceof JiraReplyError && error.stopsRun);
    assert.match(error.message, /^Jira answered 401 .* Jira refused JIRA_API_TOKEN/);
    assert.doesNotMatch(error.message, /secret-jira-token/);
    return true;
  });
});

test('a 200 reply with no issue type or created date stops the run, as a wrong site or a login page gives it for every key', async () => {
  const fetch = async () => new Response('<html>Log in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const tracker = createJiraTracker({ settings: { site: SITE }, token: 't', fetch });
  await assert.rejects(classifyWithTracker(pr('PAY-1: x'), SIGNALS, tracker), (error) => error instanceof ToolError && !(error instanceof JiraReplyError) &&
    error.message === 'Jira sent a reply with no issue type or created date for /rest/api/2/issue/PAY-1. Check settings.jira.site in evidence.yml.');
});

test('a Jira site that cannot be reached stops the run with a ToolError', async () => {
  const tracker = createJiraTracker({ settings: { site: SITE }, token: 't', fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  await assert.rejects(classifyWithTracker(pr('PAY-1: x'), SIGNALS, tracker), (error) => error instanceof ToolError && /could not reach Jira at https:\/\/acme\.atlassian\.net/.test(error.message));
});

test('each key is asked for once per tracker, and a signal before tracker:jira that matches asks nothing', async () => {
  const { tracker, fetch } = jira();
  await classifyWithTracker(pr('PAY-482: one'), SIGNALS, tracker);
  await classifyWithTracker({ ...pr('PAY-482: two'), number: 10 }, SIGNALS, tracker);
  const labelled = await classifyWithTracker(pr('PAY-483: three', { labels: ['bug'] }), SIGNALS, tracker);
  assert.deepEqual(labelled.classification, { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(fetch.calls.map((call) => call.key), ['/rest/api/2/issue/PAY-482?fields=issuetype,created']);
});

test('with no tracker, as with no token, tracker:jira matches nothing and the other signals still work', async () => {
  assert.deepEqual((await classifyWithTracker(pr('PAY-482: Crash'), SIGNALS, null)).classification, { fix: false, fix_signal: null });
  assert.deepEqual((await classifyWithTracker(pr('PAY-482: Crash', { labels: ['bug'] }), SIGNALS, null)).classification, { fix: true, fix_signal: 'label:bug' });
});

test('the token goes in a header: Bearer alone, or Basic with JIRA_EMAIL for Jira Cloud', async () => {
  const bearer = jira();
  await bearer.tracker.ticket('PAY-482');
  assert.equal(bearer.fetch.calls[0].headers.authorization, 'Bearer secret-jira-token');
  const basic = jira({}, { email: 'dev@acme.test' });
  await basic.tracker.ticket('PAY-482');
  assert.equal(basic.fetch.calls[0].headers.authorization, `Basic ${Buffer.from('dev@acme.test:secret-jira-token').toString('base64')}`);
});

test('the issue created date comes back in UTC, from Jira\'s +0000 or -0500 form', async () => {
  const { tracker } = jira({ issue_types: ['Defect', 'Bug'] });
  assert.equal((await tracker.ticket('PAY-482')).createdAt, '2026-01-05T09:30:00.000Z');
  assert.equal((await tracker.ticket('PAY-484')).createdAt, '2026-01-07T16:00:00.000Z');
});

test('with the "where found" setting, a QA-found bug is a fix but not an escaped defect', async () => {
  const settings = { found_field: 'customfield_10042', escaped_values: ['Production'] };
  const production = await classify('PAY-482: Crash in checkout', settings);
  const qa = await classify('PAY-485: Crash on the QA site', settings);
  const unknown = await classify('PAY-486: Crash somewhere', settings);
  assert.deepEqual(production, { fix: true, fix_signal: 'jira:PAY-482', escaped: true });
  assert.deepEqual(qa, { fix: true, fix_signal: 'jira:PAY-485', escaped: false });
  // No value in the field: Exhibit cannot tell, so it counts the bug as escaped, as before.
  assert.deepEqual(unknown, { fix: true, fix_signal: 'jira:PAY-486' });

  const link = { links: [{ pr: 1, confidence: 1, lines: [] }] };
  const lines = [[11, production], [12, qa], [13, unknown]].map(([number, classification]) => ({ number, merged_at: `2026-02-${number}T00:00:00Z`, classification, szz: link }));
  assert.deepEqual(escapedDefects(lines).map((line) => line.number), [13, 11]);
  // The report lists the QA-found bug in its own part, not as an escaped defect.
  const { markdown } = buildReport([{ ...lines[1], title: 'PR 12' }], { repo: 'acme/widgets', szzRan: true, fixSignals: SIGNALS });
  assert.doesNotMatch(markdown, /^## Escaped defects/m);
  assert.match(markdown, /^## Fix PRs whose bug was found before release \(1\)\n\n.*\n\n- PR 12 \(PR 12\): jira:PAY-485$/m);
});

test('ticketKey finds the key at the start of the title, else at the start of the branch', () => {
  const key = (title, branch = 'topic') => ticketKey({ title, branch });
  assert.equal(key('PAY-482: Crash'), 'PAY-482');
  assert.equal(key('[pay-482] Crash'), 'PAY-482');
  assert.equal(key('#79, PAY-482: Crash'), 'PAY-482');
  assert.equal(key('Crash in PAY-482'), null);
  assert.equal(key('#79: Crash'), null);
  assert.equal(key('Crash', 'PAY-482-crash'), 'PAY-482');
  assert.equal(key('Crash', 'PAY-482/crash'), 'PAY-482');
  assert.equal(key('Crash', 'PAY-482'), 'PAY-482');
  assert.equal(key('Crash', 'PAY-4821x'), null);
  assert.equal(key('Crash', 'fix/PAY-482'), null);
  assert.equal(key('PAY-1: Crash', 'PAY-2-crash'), 'PAY-1');
  assert.equal(key('ZOOKEEPER-5076. Upgrade JDK'), 'ZOOKEEPER-5076');
  assert.equal(key('PAY-482.Crash'), null);
});

test('revert and tracker:jira in one list: the first signal that matches wins, and a revert first asks Jira nothing', async () => {
  // A revert PR whose branch names a Jira key. GitHub's Revert button writes the title.
  const revertPr = (branch) => ({ number: 9, title: 'Revert "Add a coupon field"', body: 'Reverts acme/shop#8', labels: [], branch, repo: 'acme/shop' });

  const first = jira();
  const revertFirst = await classifyWithTracker(revertPr('PAY-482-revert'), ['revert', 'tracker:jira'], first.tracker);
  assert.deepEqual(revertFirst.classification, { fix: true, fix_signal: 'revert' });
  assert.equal(first.fetch.calls.length, 0);

  const bug = jira();
  const jiraFirst = await classifyWithTracker(revertPr('PAY-482-revert'), ['tracker:jira', 'revert'], bug.tracker);
  assert.deepEqual(jiraFirst.classification, { fix: true, fix_signal: 'jira:PAY-482' });
  assert.equal(bug.fetch.calls.length, 1);

  // PAY-483 is a Story, so tracker:jira does not match, and revert after it does.
  const story = jira();
  const storyFirst = await classifyWithTracker(revertPr('PAY-483-revert'), ['tracker:jira', 'revert'], story.tracker);
  assert.deepEqual(storyFirst.classification, { fix: true, fix_signal: 'revert' });
  assert.equal(story.fetch.calls.length, 1);
});
