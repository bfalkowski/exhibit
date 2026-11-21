import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGitHubForge } from '../src/github.js';
import { checkHistoryLine } from '../src/history-schema.js';
import { addSzz, REVERT_NOT_FOUND } from '../src/szz.js';
import { replayFetch } from '../test-support/replay-fetch.js';
import { buildSzzRepo } from './fixtures/szz-repo.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';
import { commitPullsFetch } from './fixtures/github/szz-replies.js';

const REPO = 'fixture/shop';

// src/szz.js runs git in this process with process.env. Drop the env that a git hook sets.
dropGitEnv();

// Runs git in the fixture repo as its maintainer, at a fixed time, so the SHAs are the same each run.
function git(dir, args) {
  const date = '@1767700000 +0000';
  const who = { GIT_AUTHOR_NAME: 'maintainer', GIT_AUTHOR_EMAIL: 'maintainer@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: 'maintainer', GIT_COMMITTER_EMAIL: 'maintainer@example.com', GIT_COMMITTER_DATE: date };
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir, who) }).trim();
}

// A history line for a revert PR that is on main as `mergeSha`.
function revertLine(number, { title, body, mergeSha, baseSha }) {
  return {
    number, title, body, author: 'ana', labels: [], merged_at: `2026-02-0${number - 14}T09:00:00Z`, base_ref: 'main',
    base_sha: baseSha, head_sha: mergeSha, merge_sha: mergeSha, forge: 'github', url: `https://github.com/${REPO}/pull/${number}`,
    files: [], reviews: { change_request_rounds: 0, list: [] }, ci: [],
    classification: { fix: true, fix_signal: 'revert' }, szz: null
  };
}

// Builds the fixture repo and adds two reverts on main:
// - PR 15, from GitHub's Revert button: it takes back PR 5 (a squash merge), and its body is
//   "Reverts fixture/shop#5".
// - PR 16, from `git revert -m 1` of PR 10's merge commit: its body is git's "This reverts
//   commit <sha>" line.
// Each revert really deletes lines on main, so a blame would have found lines to link.
function fixtureWithReverts(t) {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const byNumber = new Map(repo.history.map((line) => [line.number, line]));
  const { dir } = repo;

  const before15 = git(dir, ['rev-parse', 'main']);
  git(dir, ['revert', '--no-edit', byNumber.get(5).merge_sha]);
  git(dir, ['commit', '--quiet', '--amend', '-m', 'Revert "Add the shop entry point" (#15)']);
  const pr15 = revertLine(15, { title: 'Revert "Add the shop entry point"', body: 'Reverts fixture/shop#5', mergeSha: git(dir, ['rev-parse', 'main']), baseSha: before15 });

  const before16 = git(dir, ['rev-parse', 'main']);
  git(dir, ['revert', '--no-edit', '-m', '1', byNumber.get(10).merge_sha]);
  const pr16 = revertLine(16, {
    title: git(dir, ['log', '-1', '--format=%s']),
    body: git(dir, ['log', '-1', '--format=%b']),
    mergeSha: git(dir, ['rev-parse', 'main']),
    baseSha: before16
  });
  return { repo, lines: [...repo.history, pr15, pr16] };
}

const revertLink = (pr, confidence = 1) => ({ pr, confidence, found_by: 'revert', lines: [] });

test('SZZ links a revert PR to the PR it reverts, with no blame', async (t) => {
  const { repo, lines } = fixtureWithReverts(t);
  const fetch = commitPullsFetch(repo, REPO);
  const warnings = [];
  const done = await addSzz(lines, { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch }), warn: (text) => warnings.push(text) });
  const byNumber = new Map(done.map((line) => [line.number, line]));

  await t.test('a GitHub-button revert links the PR its body names, with confidence 1 and the revert mark', () => {
    assert.deepEqual(byNumber.get(15).szz, { blamed_commit: null, links: [revertLink(5)], unlinked_lines: [], dropped_lines: [], no_link_reason: null });
  });

  await t.test('a git revert links the PR whose merge commit its body names, with confidence 1 and the revert mark', () => {
    assert.match(byNumber.get(16).body, new RegExp(`^This reverts commit ${byNumber.get(10).merge_sha}, reversing`));
    assert.deepEqual(byNumber.get(16).szz, { blamed_commit: null, links: [revertLink(10)], unlinked_lines: [], dropped_lines: [], no_link_reason: null });
  });

  await t.test('runs no blame for a revert: no blamed commit, no lines, and no question to GitHub about a commit', () => {
    // A blame of the lines that the revert deletes would have asked GitHub about the commits on
    // PR 10's branch. The reverts ask nothing beyond what the other fixes ask.
    const without = commitPullsFetch(repo, REPO);
    return addSzz(repo.history, { dir: repo.dir, forge: createGitHubForge({ repo: REPO, token: 't', fetch: without }) }).then(() => {
      assert.deepEqual(fetch.calls.map((call) => call.key).sort(), without.calls.map((call) => call.key).sort());
      assert.deepEqual(warnings, []);
    });
  });

  await t.test('every line passes the schema', () => {
    for (const line of done) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  });
});

test('a revert needs no merge commit in the clone, because it runs no git blame', async (t) => {
  const { repo, lines } = fixtureWithReverts(t);
  const pr15 = { ...lines.at(-2), merge_sha: 'f'.repeat(40) };
  const warnings = [];
  const forge = createGitHubForge({ repo: REPO, token: 't', fetch: commitPullsFetch(repo, REPO) });
  const [done] = await addSzz([pr15], { dir: repo.dir, forge, warn: (text) => warnings.push(text), known: [...repo.history, pr15] });
  assert.deepEqual(done.szz.links, [revertLink(5)]);
  assert.deepEqual(warnings, []);
});

test('a revert that names more than one PR links each one, and splits the confidence evenly', async (t) => {
  const { repo, lines } = fixtureWithReverts(t);
  const byNumber = new Map(repo.history.map((line) => [line.number, line]));
  // PR 5 by number, PR 10 by its merge commit, PR 2 by its squash commit, and PR 5 again by its
  // squash commit, which counts once.
  const body = `Reverts fixture/shop#5\n\nThis reverts commit ${byNumber.get(10).merge_sha}.\nThis reverts commit ${byNumber.get(2).merge_sha.slice(0, 7)}.\nThis reverts commit ${byNumber.get(5).merge_sha}.`;
  const revert = { ...lines.at(-2), body };
  const forge = createGitHubForge({ repo: REPO, token: 't', fetch: commitPullsFetch(repo, REPO) });
  const [done] = await addSzz([revert], { dir: repo.dir, forge, known: [...repo.history, revert] });
  assert.deepEqual(done.szz.links, [revertLink(2, 1 / 3), revertLink(5, 1 / 3), revertLink(10, 1 / 3)]);
  assert.deepEqual(checkHistoryLine(done), []);
});

test('a re-land with an edited title is no fix: it links nothing, and its szz is null', async (t) => {
  const { repo, lines } = fixtureWithReverts(t);
  const pr15 = lines.at(-2);
  // PR 17 clicks Revert on PR 15, then renames the title, so only the body says what it reverts.
  const reland = { ...pr15, number: 17, title: 'Reland: add the shop entry point', body: 'Reverts fixture/shop#15', merged_at: '2026-02-03T09:00:00Z', url: `https://github.com/${REPO}/pull/17`, classification: { kinds: ['api'], fix: true, fix_signal: 'revert' } };
  const forge = createGitHubForge({ repo: REPO, token: 't', fetch: commitPullsFetch(repo, REPO) });
  const [done] = await addSzz([reland], { dir: repo.dir, forge, known: [...lines, reland] });
  // It puts PR 5 back, as a title 'Revert "Revert "' does, so it is no fix (spec 9.1). It keeps its kinds.
  assert.deepEqual(done.classification, { kinds: ['api'], fix: false, fix_signal: null });
  assert.equal(done.szz, null);
  assert.deepEqual(checkHistoryLine(done), []);

  await t.test('a revert that names a revert and a plain PR links only the plain PR', async () => {
    const both = { ...reland, body: 'Reverts fixture/shop#15\nReverts fixture/shop#2' };
    const [line] = await addSzz([both], { dir: repo.dir, forge, known: [...lines, both] });
    assert.deepEqual(line.szz.links, [revertLink(2)]);
  });

  await t.test('a revert of a re-land is a fix, and links the re-land, and a revert of that is a re-land', async () => {
    // PR 18 clicks Revert on the re-land PR 17: the change broke again, so PR 17 brought the bug back.
    const revertOfReland = { ...reland, number: 18, title: 'Revert "Reland: add the shop entry point"', body: 'Reverts fixture/shop#17', url: `https://github.com/${REPO}/pull/18` };
    // PR 19 clicks Revert on PR 18, and a person renames the title: it puts the change back once more.
    const again = { ...reland, number: 19, title: 'Reland again: add the shop entry point', body: 'Reverts fixture/shop#18', url: `https://github.com/${REPO}/pull/19` };
    const known = [...lines, reland, revertOfReland, again];
    const [fix, relandAgain] = await addSzz([revertOfReland, again], { dir: repo.dir, forge, known });
    assert.deepEqual(fix.classification, { kinds: ['api'], fix: true, fix_signal: 'revert' });
    assert.deepEqual(fix.szz.links, [revertLink(17)]);
    assert.deepEqual([relandAgain.classification.fix, relandAgain.szz], [false, null]);
  });

  await t.test('a re-land that names its revert by a branch commit is a re-land in the chain too', async () => {
    // PR 10 is a merge-commit PR. Here it is a revert of PR 5. PR 17 re-lands it by `git revert`
    // of one commit on PR 10's branch, not its merge commit, so only the forge maps that commit
    // to PR 10. PR 18 reverts PR 17, so it takes the change out again.
    const byNumber = new Map(lines.map((line) => [line.number, line]));
    const pr10 = { ...byNumber.get(10), title: 'Revert "Add the shop entry point"', body: 'Reverts fixture/shop#5' };
    const branchCommit = git(repo.dir, ['rev-parse', `${pr10.merge_sha}^2`]);
    const relandByCommit = { ...reland, body: `This reverts commit ${branchCommit}.` };
    const revertOfReland = { ...reland, number: 18, title: 'Revert "Reland: add the shop entry point"', body: 'Reverts fixture/shop#17', url: `https://github.com/${REPO}/pull/18` };
    const known = [...lines.filter((line) => line.number !== 10), pr10, relandByCommit, revertOfReland];
    const [landed, fix] = await addSzz([relandByCommit, revertOfReland], { dir: repo.dir, forge, known });
    assert.deepEqual([landed.classification.fix, landed.szz], [false, null]);
    assert.deepEqual([fix.classification.fix, fix.szz?.links], [true, [revertLink(17)]]);
  });

  await t.test('a revert of a re-land that names it by its merge commit links it too', async () => {
    // The re-land is on main as PR 5's squash commit would be, so the history maps that commit to PR 17.
    const relandOnMain = { ...reland, merge_sha: 'f'.repeat(40) };
    const revertOfReland = { ...reland, number: 18, title: 'Take back the re-land', body: `This reverts commit ${'f'.repeat(40)}.`, url: `https://github.com/${REPO}/pull/18` };
    const [fix] = await addSzz([revertOfReland], { dir: repo.dir, forge, known: [...lines, relandOnMain, revertOfReland] });
    assert.deepEqual([fix.classification.fix, fix.szz?.links], [true, [revertLink(17)]]);
  });
});

test('a reverted PR that the history and the forge do not know gives no link, and says so', async (t) => {
  // The replies are GitHub's own, recorded from timonrieger/homelab: a 404 for an issue number it
  // does not have, and a 422 for a commit it does not know.
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const fetch = replayFetch(fileURLToPath(new URL('./fixtures/github/revert-not-found.json', import.meta.url)));
  const forge = createGitHubForge({ repo: 'timonrieger/homelab', token: 't', fetch });
  const revert = {
    ...revertLine(15, { title: 'Revert "Add a page"', body: 'Reverts timonrieger/homelab#99999\n\nThis reverts commit 0000000000000000000000000000000000000001.', mergeSha: 'e'.repeat(40), baseSha: 'd'.repeat(40) }),
    url: 'https://github.com/timonrieger/homelab/pull/15'
  };
  const [done] = await addSzz([revert], { dir: repo.dir, forge });
  assert.deepEqual(done.szz, { blamed_commit: null, links: [], unlinked_lines: [], dropped_lines: [], no_link_reason: REVERT_NOT_FOUND });
  assert.equal(REVERT_NOT_FOUND, 'reverted change not found');
  assert.deepEqual(fetch.calls.map((call) => call.key), [
    '/repos/timonrieger/homelab/issues/99999',
    '/repos/timonrieger/homelab/commits/0000000000000000000000000000000000000001/pulls?per_page=100'
  ]);
  assert.deepEqual(checkHistoryLine(done), []);

  await t.test('a title-only revert, and a revert of a PR in another repo, give no link either', async () => {
    for (const body of [null, 'Reverts other/repo#5']) {
      const [line] = await addSzz([{ ...revert, body }], { dir: repo.dir, forge });
      assert.equal(line.szz.no_link_reason, REVERT_NOT_FOUND, String(body));
    }
  });
});
