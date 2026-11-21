import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubForge, GitHubReplyError } from '../src/github.js';
import { createJiraTracker } from '../src/jira.js';
import { checkHistoryLine } from '../src/history-schema.js';
import { addSzz, cloneRoot, createPrFinder } from '../src/szz.js';
import { ToolError } from '../src/tool-error.js';
import { replayFetch } from '../test-support/replay-fetch.js';
import { buildSzzRepo, readAnswerKey } from './fixtures/szz-repo.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';
import { commitPullsFetch, writeHistoryReplay } from './fixtures/github/szz-replies.js';

const REPO = 'fixture/shop';
// cloneRoot asks only the forge's remote rule, so this forge never fetches.
const SHOP_FORGE = createGitHubForge({ repo: REPO, token: 't', fetch: async () => { throw new Error('cloneRoot must not fetch'); } });

// src/szz.js runs git in this process with process.env. Drop the env that a git hook sets, so
// git reads the fixture repo and not the repo that runs the hook.
dropGitEnv();

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) }).trim();
}

// Builds the fixture repo, runs SZZ on its history with a GitHub that answers from the repo's
// own PR refs, and returns the lines with szz filled.
async function szzOnFixture(t) {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const fetch = commitPullsFetch(repo, REPO);
  const forge = createGitHubForge({ repo: REPO, token: 't', fetch });
  const lines = await addSzz(repo.history, { dir: repo.dir, forge });
  return { repo, lines, fetch, byNumber: new Map(lines.map((line) => [line.number, line])) };
}

const linkedPrs = (line) => line.szz.links.map((link) => link.pr).sort((a, b) => a - b);

test('SZZ on the fixture repo', async (t) => {
  const { repo, lines, fetch, byNumber } = await szzOnFixture(t);
  const key = readAnswerKey();

  for (const fix of key.fixes.filter((f) => f.introducing_prs.length > 0)) {
    await t.test(`finds every expected link: PR ${fix.fix_pr}, ${fix.case}`, () => {
      assert.deepEqual(linkedPrs(byNumber.get(fix.fix_pr)), fix.introducing_prs);
    });
  }

  // Whitespace-only, comment-only and moved lines carry no bug, so these fixes give no link,
  // and szz says why.
  for (const fix of key.fixes.filter((f) => f.introducing_prs.length === 0)) {
    await t.test(`makes no link: PR ${fix.fix_pr}, ${fix.case}`, () => {
      const { szz } = byNumber.get(fix.fix_pr);
      assert.deepEqual(szz.links, []);
      assert.deepEqual(szz.unlinked_lines, []);
      assert.equal(szz.no_link_reason, fix.case);
      assert.ok(szz.dropped_lines.length > 0);
    });
  }

  await t.test('a fix with links has no no_link_reason and drops nothing here', () => {
    for (const number of [6, 7]) {
      assert.equal(byNumber.get(number).szz.no_link_reason, null);
      assert.deepEqual(byNumber.get(number).szz.dropped_lines, []);
    }
  });

  await t.test('finds links through squash merges and through merge commits', () => {
    // PR 2 is a squash merge: its commit is a merge SHA in the history. PR 1 and PR 3 are merge
    // commits: blame points to a commit on their branch, so the API maps it.
    const pr1 = byNumber.get(6).szz.links[0];
    const pr2 = byNumber.get(7).szz.links.find((link) => link.pr === 2);
    const pr3 = byNumber.get(7).szz.links.find((link) => link.pr === 3);
    assert.equal(pr2.lines[0].blame.commit, byNumber.get(2).merge_sha);
    assert.notEqual(pr1.lines[0].blame.commit, byNumber.get(1).merge_sha);
    assert.notEqual(pr3.lines[0].blame.commit, byNumber.get(3).merge_sha);
  });

  await t.test('asks the API only for commits that are not merge SHAs, once each', () => {
    const asked = fetch.calls.map((call) => call.key);
    assert.equal(new Set(asked).size, asked.length);
    const mergeShas = new Set(repo.history.map((pr) => pr.merge_sha));
    for (const key of asked) assert.ok(!mergeShas.has(key.split('/')[5]), key);
  });

  await t.test('the two-PR fix gives two links whose confidence scores add up to 1', () => {
    const links = byNumber.get(7).szz.links;
    assert.equal(links.length, 2);
    assert.equal(links.reduce((sum, link) => sum + link.confidence, 0), 1);
    assert.deepEqual(links.map((link) => link.confidence), [0.5, 0.5]);
  });

  await t.test('a one-PR fix gives one link with confidence 1', () => {
    assert.deepEqual(byNumber.get(6).szz.links.map((link) => [link.pr, link.confidence]), [[1, 1]]);
  });

  await t.test('each link carries its lines and the blame output for them', () => {
    const [line] = byNumber.get(6).szz.links[0].lines;
    const blamed = git(repo.dir, ['rev-parse', `${byNumber.get(6).merge_sha}^1`]);
    assert.equal(byNumber.get(6).szz.blamed_commit, blamed);
    assert.deepEqual(line, {
      path: 'src/cart.js',
      line: 4,
      text: '    sum += item.price;',
      blame: {
        commit: git(repo.dir, ['rev-list', '-n', '1', 'refs/pull/1/head']),
        original_path: 'src/cart.js',
        original_line: 4,
        author: 'ana',
        author_time: line.blame.author_time,
        summary: 'Add cart subtotal'
      }
    });
    assert.match(line.blame.author_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // The blame output agrees with git blame run by hand.
    const out = git(repo.dir, ['blame', '--porcelain', '-L', '4,4', blamed, '--', 'src/cart.js']);
    assert.equal(out.slice(0, 40), line.blame.commit);
  });

  await t.test('a rebase-merged fix is blamed at the parent of its first commit on main', () => {
    const fix = byNumber.get(12);
    const [first] = repo.onMain.get(12);
    assert.equal(repo.onMain.get(12).length, 2);
    assert.equal(fix.szz.blamed_commit, git(repo.dir, ['rev-parse', `${first}^1`]));
    assert.deepEqual(fix.szz.links.map((link) => [link.pr, link.confidence]), [[1, 0.5], [11, 0.5]]);
    // PR 11 was rebase-merged too: its line is blamed on its copy on main, not its branch.
    assert.equal(fix.szz.links[1].lines[0].blame.commit, repo.onMain.get(11)[0]);
    assert.deepEqual(fix.szz.unlinked_lines, []);
  });

  await t.test("to find a rebase fix's first commit, asks GitHub about its earlier copy on main", () => {
    // PR 12's walk asks about its first copy on main. The next parent is PR 11's merge_sha, so
    // the walk stops there with no request.
    const asked = fetch.calls.map((call) => call.key.split('/')[5]);
    assert.ok(asked.includes(repo.onMain.get(12)[0]));
  });

  await t.test("a PR from a fork: SZZ asks the repo the PR merged into, not the fork", () => {
    const fix = byNumber.get(14);
    const [link] = fix.szz.links;
    assert.equal(link.pr, 13);
    // The line was written on the fork's branch, so its commit is not a merge SHA, and SZZ must
    // ask the forge which PR holds it.
    const forkCommit = git(repo.dir, ['rev-list', '-n', '1', 'refs/pull/13/head']);
    assert.equal(repo.forks.get(13), 'dee/shop');
    assert.equal(link.lines[0].blame.commit, forkCommit);
    assert.ok(fetch.calls.some((call) => call.key === `/repos/${REPO}/commits/${forkCommit}/pulls?per_page=100`));
    // The fetch throws on any request to a fork. This checks that nothing hid such a throw.
    assert.deepEqual(fetch.forkCalls, []);
  });

  await t.test('PRs that are not fixes get szz: null', () => {
    for (const line of lines.filter((l) => !l.classification.fix)) assert.equal(line.szz, null, `PR ${line.number}`);
  });

  await t.test('every line passes the schema', () => {
    for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  });
});

// Both test fetches for the fixture repo, the one SZZ tests use and the replay file the CLI tests
// use, throw on any request to the fork's repo dee/shop. A repo whose name only starts with the
// fork's name, such as dee/shopping, is not the fork.
test('the test fetches throw on a request to the fork, and only to the fork', async (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const replay = writeHistoryReplay(repo, REPO);
  t.after(replay.cleanup);
  const fetches = { commitPullsFetch: commitPullsFetch(repo, REPO), replayFetch: replayFetch(replay.path) };
  const forkError = /^Error: The test asked a fork's repo: \/repos\/dee\/shop\b.*\. Ask fixture\/shop, the repo the PR merged into\.$/i;
  for (const [name, fetch] of Object.entries(fetches)) {
    await t.test(`${name}: the repo itself, a path under it, and the name in capitals`, async () => {
      for (const path of ['/repos/dee/shop', '/repos/dee/shop/commits/abc/pulls?per_page=100', '/repos/Dee/Shop']) {
        await assert.rejects(fetch(`https://api.github.com${path}`), (error) => forkError.test(String(error)), `${name} ${path}`);
      }
    });
    await t.test(`${name}: a repo whose name only starts with the fork's name gets no fork error`, async () => {
      const outcome = await fetch('https://api.github.com/repos/dee/shopping').then((reply) => `answered ${reply.status}`, String);
      // Look for the fork message alone, without the path, so any fork error fails this check.
      assert.doesNotMatch(outcome, /asked a fork's repo/);
    });
  }
});

// The commits SZZ asked GitHub about, by the "pull requests for a commit" requests.
const askedShas = (fetch) => fetch.calls.map((call) => /\/commits\/([0-9a-f]{40})\/pulls/.exec(call.key)?.[1]).filter(Boolean);

test('the walk to a squash fix\'s first commit', async (t) => {
  // Building the fixture repo takes seconds, so the subtests share one build. SZZ only reads
  // the repo. Each subtest makes its own fetch, so its list of requests starts empty.
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());

  await t.test('asks GitHub nothing when the parent is a merge SHA in the history', async () => {
    // Only the squash fixes 7 and 9 count as fixes here. Their parents are the merge SHAs of PR 6
    // and PR 8, so the walk costs no request. Fix 9 moves lines only, so it blames nothing. Fix 7
    // blames one line on PR 2's merge SHA and one on a commit on PR 3's branch: only that one
    // goes to GitHub.
    const history = repo.history.map((pr) => ({ ...pr, classification: { ...pr.classification, fix: pr.number === 7 || pr.number === 9 } }));
    const fetch = commitPullsFetch(repo, REPO);
    const lines = await addSzz(history, { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }) });
    const fix9 = lines.find((line) => line.number === 9);
    assert.deepEqual(fix9.szz.links, []);
    assert.deepEqual(fix9.szz.unlinked_lines, []);
    const fix7 = lines.find((line) => line.number === 7);
    const pr3 = fix7.szz.links.find((link) => link.pr === 3);
    assert.deepEqual(askedShas(fetch), [pr3.lines[0].blame.commit]);
  });

  await t.test('asks GitHub once about the parent, and stops there, when the parent is not a merge SHA in the history', async () => {
    // With only PR 9 in the history, its parent (PR 8's merge commit) is not a known merge SHA.
    // GitHub says it belongs to PR 8, not PR 9, so the walk stops after one request.
    const fix9 = repo.history.find((pr) => pr.number === 9);
    const fetch = commitPullsFetch(repo, REPO);
    const [line] = await addSzz([fix9], { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }) });
    const parent = git(repo.dir, ['rev-parse', `${fix9.merge_sha}^1`]);
    assert.equal(parent, repo.history.find((pr) => pr.number === 8).merge_sha);
    assert.deepEqual(askedShas(fetch), [parent]);
    assert.equal(line.szz.blamed_commit, parent);
  });

  await t.test('an incremental run passes the whole file as known, so SZZ on PR 9 alone asks GitHub nothing', async () => {
    // The same fix as above, but the commit-to-PR map sees every line, as in an incremental run
    // where only PR 9 is new. PR 8's merge SHA is then known, so the walk costs no request.
    const fix9 = repo.history.find((pr) => pr.number === 9);
    const fetch = commitPullsFetch(repo, REPO);
    const lines = await addSzz([fix9], { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }), known: repo.history });
    assert.deepEqual(lines.map((line) => line.number), [9]);
    assert.deepEqual(askedShas(fetch), []);
    assert.equal(lines[0].szz.blamed_commit, repo.history.find((pr) => pr.number === 8).merge_sha);
  });
});

// After a repo renames its default branch, such as from master to main, the PRs merged before
// keep base_ref "master". Fix 7 blames a line on PR 2's squash commit. Here PR 2 has base_ref
// "master", and GitHub lists no PR for its commit.
test('a merge SHA from before a default branch rename', async (t) => {
  async function run(t, defaultBranch) {
    const repo = buildSzzRepo();
    t.after(() => repo.cleanup());
    const history = repo.history.map((pr) => (pr.number === 2 ? { ...pr, base_ref: 'master' } : pr));
    const pr2Sha = history.find((pr) => pr.number === 2).merge_sha;
    const replies = commitPullsFetch(repo, REPO);
    const calls = [];
    const fetch = async (url, init) => {
      const { pathname } = new URL(url);
      calls.push(pathname);
      const body = pathname === `/repos/${REPO}` ? { full_name: REPO, default_branch: defaultBranch }
        : pathname.includes(`/commits/${pr2Sha}/pulls`) ? [] : null;
      if (body === null) return replies(url, init);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const lines = await addSzz(history, { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }) });
    const asked = calls.some((path) => path.includes(`/commits/${pr2Sha}/pulls`));
    return { fix7: lines.find((line) => line.number === 7), asked };
  }

  await t.test('links to its PR with no pulls request, when the commit is on the first-parent line of the default branch in the clone', async (t) => {
    const { fix7, asked } = await run(t, 'main');
    assert.deepEqual(fix7.szz.links.map((link) => link.pr), [2, 3]);
    assert.deepEqual(fix7.szz.unlinked_lines, []);
    assert.equal(asked, false);
  });

  await t.test('asks GitHub when the clone has no branch with the default branch name', async (t) => {
    const { fix7, asked } = await run(t, 'trunk');
    assert.equal(asked, true);
    assert.deepEqual(fix7.szz.links.map((link) => link.pr), [3]);
    assert.equal(fix7.szz.unlinked_lines.length, 1);
  });
});

// PR 2 has base_ref "master" as above, so its merge SHA needs the first-parent line. Here git
// fails to list that line. SZZ then asks GitHub, as it did before the line was checked, and
// GitHub lists PR 2 for its commit.
test('when git cannot list the first-parent line of the default branch, SZZ asks GitHub', async (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const history = repo.history.map((pr) => (pr.number === 2 ? { ...pr, base_ref: 'master' } : pr));
  const pr2Sha = history.find((pr) => pr.number === 2).merge_sha;
  const fetch = commitPullsFetch(repo, REPO);
  gitThatFailsOn(t, '--first-parent', 'rev-list broke');
  const warnings = [];
  const lines = await addSzz(history, { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }), warn: (text) => warnings.push(text) });
  const fix7 = lines.find((line) => line.number === 7);
  assert.deepEqual(warnings, []);
  assert.deepEqual(fix7.szz.links.map((link) => link.pr), [2, 3]);
  assert.ok(fetch.calls.some((call) => call.key.includes(`/commits/${pr2Sha}/pulls`)), 'GitHub is asked about PR 2\'s commit');
  for (const line of lines.filter((l) => l.classification?.fix)) assert.notEqual(line.szz, null, `PR ${line.number}`);
});

test('SZZ gives szz: null and a warning when the fix merge commit is not in the clone', async (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const missing = { ...repo.history.find((pr) => pr.number === 6), merge_sha: 'f'.repeat(40) };
  const warnings = [];
  const forge = createGitHubForge({ repo: REPO, token: 't', fetch: commitPullsFetch(repo, REPO) });
  const [line] = await addSzz([missing], { dir: repo.dir, forge, warn: (text) => warnings.push(text) });
  assert.equal(line.szz, null);
  assert.deepEqual(warnings, [`PR 6: SZZ skipped, because its merge commit ${'f'.repeat(40)} is not in this clone. Run git fetch, then run history again.`]);
});

// Runs SZZ on fix PR 6 with a body that links issues, and a GitHub that also answers for them.
// PR 1 added the line that PR 6 fixes, in a commit written at 2026-01-05T10:00:00Z. `repos`
// gives GitHub's reply for each repo path, such as an old name that leads to this repo.
async function szzWithIssues(t, body, issues, repos = {}) {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const pulls = commitPullsFetch(repo, REPO);
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname in repos) return new Response(JSON.stringify(repos[pathname]), { status: 200, headers: { 'content-type': 'application/json' } });
    const number = /\/issues\/(\d+)$/.exec(pathname)?.[1];
    if (number === undefined) return pulls(url, init);
    const issue = issues[number];
    return new Response(JSON.stringify(issue ?? { message: 'Not Found' }), { status: issue ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  const fix6 = { ...repo.history.find((pr) => pr.number === 6), body };
  const [line] = await addSzz([fix6], { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }) });
  return line;
}

test('SZZ drops lines newer than the bug report that the fix links', async (t) => {
  await t.test('a report from before the commit drops the line, and szz says why', async (t) => {
    const { szz } = await szzWithIssues(t, 'Fixes #50', { 50: { number: 50, created_at: '2026-01-05T09:30:00Z' } });
    assert.deepEqual(szz.links, []);
    assert.deepEqual(szz.dropped_lines.map((l) => [l.path, l.line, l.reason]), [['src/cart.js', 4, 'newer than the bug report']]);
    assert.equal(szz.no_link_reason, 'lines newer than the bug report only');
  });

  await t.test('a report from after the commit keeps the link', async (t) => {
    const { szz } = await szzWithIssues(t, 'Closes #50', { 50: { number: 50, created_at: '2026-01-05T11:00:00Z' } });
    assert.deepEqual(szz.links.map((link) => [link.pr, link.confidence]), [[1, 1]]);
    assert.deepEqual(szz.dropped_lines, []);
  });

  await t.test('a report named by the repo\'s old name, after a rename or a transfer, drops the line too', async (t) => {
    // GitHub redirects the old name to the repo, so both replies have the same id.
    const renamed = { [`/repos/${REPO}`]: { id: 9, full_name: REPO, default_branch: 'main' }, '/repos/oldowner/shop': { id: 9, full_name: REPO } };
    const issue = { 50: { number: 50, created_at: '2026-01-05T09:30:00Z' } };
    for (const body of ['Fixes oldowner/shop#50', 'Fixes https://github.com/oldowner/shop/issues/50']) {
      const { szz } = await szzWithIssues(t, body, issue, renamed);
      assert.deepEqual(szz.dropped_lines.map((l) => [l.path, l.line, l.reason]), [['src/cart.js', 4, 'newer than the bug report']], body);
    }
    // Another repo has another id, so its issue 50 gives no date.
    const { szz } = await szzWithIssues(t, 'Fixes other/shop#50', issue, { ...renamed, '/repos/other/shop': { id: 10, full_name: 'other/shop' } });
    assert.deepEqual(szz.links.map((link) => link.pr), [1]);
  });

  await t.test('a linked PR, or an issue GitHub does not know, gives no date', async (t) => {
    const { szz } = await szzWithIssues(t, 'Fixes #51, fixes #52', { 51: { number: 51, created_at: '2026-01-01T00:00:00Z', pull_request: {} } });
    assert.deepEqual(szz.links.map((link) => link.pr), [1]);
  });
});

test('SZZ takes the Jira issue\'s created date as the bug report date, when the fix links no GitHub issue', async (t) => {
  // PR 6 fixes a line that PR 1 added in a commit written at 2026-01-05T10:00:00Z. Its fix_signal
  // says the tracker:jira signal found it, by the Bug SHOP-6.
  async function run(t, created, body = null, { token = 't', ticket } = {}) {
    const repo = buildSzzRepo();
    t.after(() => repo.cleanup());
    const pulls = commitPullsFetch(repo, REPO);
    const json = (status, reply) => new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
    const fetch = async (url, init) => {
      const { pathname } = new URL(url);
      if (pathname === '/rest/api/2/issue/SHOP-6') return json(200, { key: 'SHOP-6', fields: { issuetype: { name: 'Bug' }, created } });
      if (pathname.endsWith('/issues/50')) return json(200, { number: 50, created_at: '2026-01-05T11:00:00Z' });
      return pulls(url, init);
    };
    const tracker = createJiraTracker({ settings: { site: 'https://shop.atlassian.net' }, token, fetch });
    const fix6 = { ...repo.history.find((pr) => pr.number === 6), body, classification: { fix: true, fix_signal: 'jira:SHOP-6' }, ...(ticket ? { ticket } : {}) };
    const [line] = await addSzz([fix6], { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }), tracker });
    return line;
  }

  await t.test('an issue created before the commit drops the line', async (t) => {
    const { szz } = await run(t, '2026-01-05T09:30:00.000+0000');
    assert.deepEqual(szz.links, []);
    assert.deepEqual(szz.dropped_lines.map((l) => [l.path, l.line, l.reason]), [['src/cart.js', 4, 'newer than the bug report']]);
  });

  await t.test('an issue created after the commit keeps the link', async (t) => {
    const { szz } = await run(t, '2026-01-05T10:30:00.000+0000');
    assert.deepEqual(szz.links.map((link) => [link.pr, link.confidence]), [[1, 1]]);
  });

  await t.test('a GitHub issue that the body links wins over the Jira date', async (t) => {
    const { szz } = await run(t, '2026-01-05T09:30:00.000+0000', 'Fixes #50');
    assert.deepEqual(szz.links.map((link) => link.pr), [1]);
  });

  await t.test('the created date that the line saved in ticket counts, with no Jira request and no token', async (t) => {
    const ticket = { issue: 'jira:SHOP-6', type: 'Bug', created_at: '2026-01-05T09:30:00.000Z', found_field: null, found: [] };
    // Jira would say the issue is newer, so only the saved date drops the line.
    const { szz } = await run(t, '2026-01-05T10:30:00.000+0000', null, { token: undefined, ticket });
    assert.deepEqual(szz.dropped_lines.map((l) => [l.path, l.line, l.reason]), [['src/cart.js', 4, 'newer than the bug report']]);
  });
});

test('a GitHub error for one fix skips that fix, unless the token or the rate limit is the problem', async (t) => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // Runs SZZ on fix PR 6, which links issue 50, with a GitHub that answers `status` for `failing`.
  async function run(t, failing, status) {
    const repo = buildSzzRepo();
    t.after(() => repo.cleanup());
    const pulls = commitPullsFetch(repo, REPO);
    const fetch = async (url, init) => {
      const { pathname } = new URL(url);
      if (failing.test(pathname)) return json(status, { message: 'Server Error' });
      return pathname.endsWith('/issues/50') ? json(200, { number: 50, created_at: '2026-02-01T00:00:00Z' }) : pulls(url, init);
    };
    const fix6 = { ...repo.history.find((pr) => pr.number === 6), body: 'Fixes #50' };
    const warnings = [];
    const lines = await addSzz([fix6], { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch, sleep: async () => {} }), warn: (text) => warnings.push(text) });
    return { line: lines[0], warnings };
  }

  await t.test('a 500 on the linked-issue request gives szz: null and a warning', async (t) => {
    const { line, warnings } = await run(t, /\/issues\/50$/, 500);
    assert.equal(line.szz, null);
    assert.deepEqual(warnings, ['PR 6: SZZ skipped, because GitHub answered 500 (Server Error) for /repos/fixture/shop/issues/50. GitHub had a problem: try again later.']);
  });

  await t.test('a 502 on the commit-to-PR request gives szz: null and a warning', async (t) => {
    const { line, warnings } = await run(t, /\/pulls$/, 502);
    assert.equal(line.szz, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^PR 6: SZZ skipped, because GitHub answered 502 \(Server Error\) for \/repos\/fixture\/shop\/commits\/[0-9a-f]{40}\/pulls\./);
  });

  for (const status of [401, 403, 429]) {
    await t.test(`a ${status} stops the run, because every later request would fail too`, async (t) => {
      await assert.rejects(run(t, /\/issues\/50$/, status), (error) => error instanceof ToolError && error.message.includes(`GitHub answered ${status}`));
    });
  }
});

test('commit-to-PR mapping', async (t) => {
  const recorded = fileURLToPath(new URL('./fixtures/github/building58-commit-pulls.json', import.meta.url));
  const repo = 'bfalkowski/Building58';
  const replay = () => {
    const fetch = replayFetch(recorded);
    return { fetch, forge: createGitHubForge({ repo, token: 't', fetch }) };
  };

  await t.test('a merge SHA in the history of a PR into the default branch maps to that PR, with no request for its pulls', async () => {
    const { fetch, forge: gh } = replay();
    const find = createPrFinder({ lines: [{ number: 41, base_ref: 'main', merge_sha: 'a'.repeat(40) }], forge: gh });
    assert.equal(await find('a'.repeat(40)), 41);
    assert.deepEqual(fetch.calls.map((call) => call.key), ['/repos/bfalkowski/Building58']);
  });

  await t.test('any other commit maps through the API to the merged PR that holds it', async () => {
    const { fetch, forge: gh } = replay();
    const find = createPrFinder({ lines: [], forge: gh });
    assert.equal(await find('18ce79d6f068f5fc57cf63497ea5f398356eab68'), 82);
    assert.equal(await find('18ce79d6f068f5fc57cf63497ea5f398356eab68'), 82);
    assert.equal(fetch.calls.length, 1, 'the answer is kept, so the API is asked once');
  });

  await t.test('a commit GitHub does not know (422) maps to no PR', async () => {
    const { forge: gh } = replay();
    const find = createPrFinder({ lines: [], forge: gh });
    assert.equal(await find('0000000000000000000000000000000000000001'), null);
  });

  await t.test('one merged PR wins with no request for the default branch', async () => {
    const { fetch, forge: gh } = replay();
    const find = createPrFinder({ lines: [], forge: gh });
    assert.equal(await find('18ce79d6f068f5fc57cf63497ea5f398356eab68'), 82);
    assert.deepEqual(fetch.calls.map((call) => call.key), ['/repos/bfalkowski/Building58/commits/18ce79d6f068f5fc57cf63497ea5f398356eab68/pulls?per_page=100']);
  });
});

// A commit can sit in merged PRs on different base branches, such as a fix merged into a release
// branch and then a PR that merges the release branch into main. Only the PR into the default
// branch brought the commit to main.
test('commit-to-PR mapping across base branches', async (t) => {
  const recorded = fileURLToPath(new URL('./fixtures/github/release-flow-commit-pulls.json', import.meta.url));
  const repo = 'fixture/release-flow';
  const replay = () => {
    const fetch = replayFetch(recorded);
    return { fetch, forge: createGitHubForge({ repo, token: 't', fetch }) };
  };

  await t.test('the merged PR into the default branch wins, even when a PR into another branch merged first', async () => {
    const { forge: gh } = replay();
    const find = createPrFinder({ lines: [], forge: gh });
    assert.equal(await find('1'.repeat(40)), 31);
  });

  await t.test('when no merged PR went to the default branch, the first one merged wins', async () => {
    const { forge: gh } = replay();
    const find = createPrFinder({ lines: [], forge: gh });
    assert.equal(await find('2'.repeat(40)), 40);
  });

  // The lines a real history run has: PR 30 is in the history too, and 1111111 is its squash
  // commit on release. The merge SHA must not decide before the base branch is checked.
  await t.test('a merge SHA of a PR into another branch does not decide: the PR into the default branch wins', async () => {
    const { forge: gh } = replay();
    const lines = [
      { number: 31, base_ref: 'main', merge_sha: '3'.repeat(40) },
      { number: 30, base_ref: 'release', merge_sha: '1'.repeat(40) }
    ];
    const find = createPrFinder({ lines, forge: gh });
    assert.equal(await find('1'.repeat(40)), 31);
    assert.equal(await find('3'.repeat(40)), 31);
  });

  await t.test('the default branch is asked for once', async () => {
    const { fetch, forge: gh } = replay();
    const find = createPrFinder({ lines: [], forge: gh });
    await find('1'.repeat(40));
    await find('2'.repeat(40));
    assert.equal(fetch.calls.filter((call) => call.key === '/repos/fixture/release-flow').length, 1);
  });

  // A fake forge that fails its first request of one kind with a 502 and answers the next ones.
  const flakyForge = () => {
    const calls = { defaultBranch: 0, pullsForCommit: 0 };
    const fail = () => new GitHubReplyError('GitHub answered 502 (Bad Gateway) for /repos/fixture/shop. GitHub had a problem: try again later.', 502);
    const forge = {
      defaultBranch: async () => {
        calls.defaultBranch += 1;
        if (calls.defaultBranch === 1) throw fail();
        return 'main';
      },
      pullsForCommit: async () => {
        calls.pullsForCommit += 1;
        if (calls.pullsForCommit === 1) throw fail();
        return [{ number: 7, baseRef: 'main', mergedAt: '2026-01-02T00:00:00Z' }];
      }
    };
    return { calls, forge };
  };

  await t.test('a failed request for the default branch is not kept, so the next lookup asks again', async () => {
    const { calls, forge } = flakyForge();
    const find = createPrFinder({ lines: [{ number: 41, base_ref: 'main', merge_sha: 'a'.repeat(40) }], forge });
    await assert.rejects(find('a'.repeat(40)), (error) => error instanceof GitHubReplyError && error.status === 502);
    assert.equal(await find('a'.repeat(40)), 41);
    assert.equal(calls.defaultBranch, 2);
  });

  await t.test('a failed request for the pulls of a commit is not kept, so the next lookup asks again', async () => {
    const { calls, forge } = flakyForge();
    const find = createPrFinder({ lines: [], forge });
    await assert.rejects(find('b'.repeat(40)), (error) => error instanceof GitHubReplyError && error.status === 502);
    assert.equal(await find('b'.repeat(40)), 7);
    assert.equal(await find('b'.repeat(40)), 7);
    assert.equal(calls.pullsForCommit, 2, 'the answer that came is kept');
  });
});

// A repo where PR 30 is squash merged into a release branch, and PR 31 is a merge commit that
// brings release into main. Fix PR 32 on main then changes the line that PR 30 added.
function repoWithReleaseBranch(t) {
  const dir = tempDir(t, 'exhibit-release-');
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  const commit = (...args) => git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', ...args]);
  const write = (text) => {
    writeFileSync(join(dir, 'a.js'), text);
    git(dir, ['add', 'a.js']);
  };
  write('one;\ntwo;\n');
  commit('-m', 'Add a.js (#1)');
  git(dir, ['checkout', '--quiet', '-b', 'release']);
  write('one;\nTWO;\n');
  commit('-m', 'Change two (#30)');
  const squash = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '--quiet', 'main']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '--quiet', '--no-ff', '-m', 'Merge release into main (#31)', 'release']);
  const merge = git(dir, ['rev-parse', 'HEAD']);
  write('one;\n2;\n');
  commit('-m', 'Fix two (#32)');
  return { dir, squash, merge, fix: git(dir, ['rev-parse', 'HEAD']) };
}

test('a merge SHA of a PR squash merged into a release branch does not decide in the clone: GitHub is asked', async (t) => {
  const { dir, squash, merge, fix } = repoWithReleaseBranch(t);
  const asked = [];
  const forge = {
    repo: REPO,
    isRemote: () => false,
    defaultBranch: async () => 'main',
    issue: async () => null,
    pullsForCommit: async (sha) => {
      asked.push(sha);
      return sha === squash ? [
        { number: 30, baseRef: 'release', mergedAt: '2026-01-02T00:00:00Z' },
        { number: 31, baseRef: 'main', mergedAt: '2026-01-03T00:00:00Z' }
      ] : [];
    }
  };
  const lines = [
    { number: 30, base_ref: 'release', merge_sha: squash },
    { number: 31, base_ref: 'main', merge_sha: merge },
    { number: 32, base_ref: 'main', merge_sha: fix, classification: { fix: true } }
  ];
  const [line] = await addSzz([lines[2]], { dir, forge, known: lines });
  assert.deepEqual(asked, [squash]);
  assert.deepEqual(line.szz.links.map((link) => [link.pr, link.confidence]), [[31, 1]]);
});

// Makes a folder in the system temp folder, and removes it when test t ends.
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cloneRoot', async (t) => {
  await t.test('gives the top folder when a remote points at the repo on GitHub, in any URL form', async (t) => {
    for (const url of ['https://github.com/Fixture/Shop.git', 'git@github.com:fixture/shop.git', 'ssh://git@github.com/fixture/shop', 'https://github.com/fixture/shop/']) {
      const dir = realpathSync(tempDir(t, 'exhibit-clone-'));
      git(dir, ['init', '--quiet']);
      git(dir, ['remote', 'add', 'origin', url]);
      assert.equal(await cloneRoot(dir, SHOP_FORGE), dir, url);
    }
  });

  await t.test('gives the top folder from a folder inside the clone', async (t) => {
    const dir = realpathSync(tempDir(t, 'exhibit-clone-'));
    git(dir, ['init', '--quiet']);
    git(dir, ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git']);
    mkdirSync(join(dir, 'src'));
    assert.equal(await cloneRoot(join(dir, 'src'), SHOP_FORGE), dir);
  });

  await t.test('gives null for another repo, a repo with no remote, and a folder that is not a repo', async (t) => {
    const other = tempDir(t, 'exhibit-clone-');
    git(other, ['init', '--quiet']);
    assert.equal(await cloneRoot(other, SHOP_FORGE), null);
    git(other, ['remote', 'add', 'origin', 'https://github.com/fixture/shopping.git']);
    assert.equal(await cloneRoot(other, SHOP_FORGE), null);
    assert.equal(await cloneRoot(tempDir(t, 'exhibit-plain-'), SHOP_FORGE), null);
  });
});

// A repo with one commit, then a fix commit that changes a file and moves a submodule pointer.
function repoWithSubmoduleBump(t) {
  const dir = tempDir(t, 'exhibit-sub-');
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  const commit = (message) => git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', message]);
  writeFileSync(join(dir, 'a.js'), 'one;\ntwo;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`]);
  commit('Add a.js and sub');
  writeFileSync(join(dir, 'a.js'), 'one;\nTWO;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['update-index', '--cacheinfo', `160000,${'2'.repeat(40)},sub`]);
  commit('Fix a.js and bump sub');
  return dir;
}

const noPrs = () => createGitHubForge({ repo: REPO, token: 't', fetch: async () => new Response('{"message":"No commit found"}', { status: 422 }) });

test('a fix that moves a submodule pointer blames only its file lines', async (t) => {
  const dir = repoWithSubmoduleBump(t);
  const fix = { number: 3, merge_sha: git(dir, ['rev-parse', 'HEAD']), classification: { fix: true } };
  const warnings = [];
  const [line] = await addSzz([fix], { dir, forge: noPrs(), warn: (text) => warnings.push(text) });
  assert.deepEqual(warnings, []);
  assert.deepEqual(line.szz.unlinked_lines.map((l) => [l.path, l.line, l.text]), [['a.js', 2, 'two;']]);
});

test('in a shallow clone, a fix whose parent is missing gets szz: null and a warning, and the run goes on', async (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const shallow = tempDir(t, 'exhibit-shallow-');
  git(shallow, ['clone', '--quiet', '--depth', '1', `file://${repo.dir}`, '.']);
  // The newest fix is the clone's one commit, so its parent is missing.
  const newest = repo.history.at(-1);
  // Fetch an older fix that has links, with all of its history. The clone stays shallow at the
  // newest fix. PR 7 links PR 2 and PR 3.
  const older = repo.history.find((pr) => pr.number === 7);
  git(shallow, ['fetch', '--quiet', 'origin', older.merge_sha]);
  assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']), 'true');

  const warnings = [];
  const forge = createGitHubForge({ repo: REPO, token: 't', fetch: commitPullsFetch(repo, REPO) });
  const lines = await addSzz([newest, older], { dir: shallow, forge, warn: (text) => warnings.push(text) });
  assert.equal(lines[0].szz, null);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^This clone is shallow, so blame can give old lines to the wrong commit and SZZ links can be wrong\. Run git fetch --unshallow, then run history again\.$/);
  assert.match(warnings[1], new RegExp(`^PR ${newest.number}: SZZ skipped, because git failed: .+`));

  // The fix after the skipped one still gets the same links as in the full clone.
  const [full] = await addSzz([older], { dir: repo.dir, forge });
  assert.ok(full.szz.links.length > 0);
  assert.deepEqual(lines[1].szz, full.szz);
});

// A repo with one commit, then a fix commit that changes a JSDoc text row whose block opens and
// closes outside the hunk, turns the tabs of a Python function into spaces, and makes one real
// change in each file. The JavaScript file has a space in its name.
function repoWithCommentAndIndentFix(t) {
  const dir = tempDir(t, 'exhibit-rules-');
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  const commit = (message) => git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', message]);
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    git(dir, ['add', '.']);
  };
  write({
    'pad label.js': '/**\n * Pads a label.\n */\nexport const pad = (s) => s.padEnd(4);\n',
    'total.py': 'def total(xs):\n\tt = 0\n\tfor x in xs:\n\t\tt += x\n\treturn t\n'
  });
  commit('Add pad and total');
  write({
    'pad label.js': '/**\n * Pads a label on the right.\n */\nexport const pad = (s) => s.padEnd(8);\n',
    'total.py': 'def total(xs):\n    t = 0\n    for x in xs:\n        t += x * 2\n    return t\n'
  });
  commit('Fix pad and total');
  return dir;
}

test('SZZ reads the files to drop a JSDoc text row and a Python line that only changed tabs to spaces', async (t) => {
  const dir = repoWithCommentAndIndentFix(t);
  const fix = { number: 3, merge_sha: git(dir, ['rev-parse', 'HEAD']), classification: { fix: true } };
  const [line] = await addSzz([fix], { dir, forge: noPrs() });
  assert.deepEqual(line.szz.unlinked_lines.map((l) => [l.path, l.line]), [['pad label.js', 4], ['total.py', 4]]);
  assert.deepEqual(line.szz.dropped_lines.map((l) => [l.path, l.line, l.reason]), [
    ['pad label.js', 2, 'comment'],
    ['total.py', 2, 'whitespace'],
    ['total.py', 3, 'whitespace'],
    ['total.py', 5, 'whitespace']
  ]);
});

// A repo whose fix changes 400 JavaScript files with long names, so the list of files that SZZ
// sends to git cat-file is over 100 KB: more than a pipe holds before git reads it.
function repoWithManyChangedFiles(t) {
  const dir = tempDir(t, 'exhibit-many-');
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  const commit = (message) => git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', message]);
  const names = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(3, '0')}-${'x'.repeat(150)}.js`);
  const write = (text) => {
    for (const name of names) writeFileSync(join(dir, name), text);
    git(dir, ['add', '.']);
  };
  write('one;\n');
  commit('Add the files');
  write('two;\n');
  commit('Fix the files');
  return dir;
}

// Puts a git first on PATH that fails at once, without reading its input, when one of its
// arguments is `arg`, and runs the real git for every other command.
function gitThatFailsOn(t, arg, message) {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = tempDir(t, 'exhibit-fake-git-');
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = ${arg} ]; then echo 'fatal: ${message}' >&2; exit 128; fi
done
exec '${realGit}' "$@"
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(() => { process.env.PATH = path; });
}

test('when git cat-file fails before it reads a long file list, SZZ skips the fix with a warning, and the run goes on', async (t) => {
  const dir = repoWithManyChangedFiles(t);
  const fix = { number: 3, merge_sha: git(dir, ['rev-parse', 'HEAD']), classification: { fix: true } };
  gitThatFailsOn(t, '--batch', 'cat-file broke');
  const warnings = [];
  const [line] = await addSzz([fix], { dir, forge: noPrs(), warn: (text) => warnings.push(text) });
  assert.equal(line.szz, null);
  assert.deepEqual(warnings, ['PR 3: SZZ skipped, because git failed: git cat-file: fatal: cat-file broke']);
});
