// GitHub API replies for the fixture repo that szz-repo.js builds. Its SHAs are known only after
// the build, so the replies are made from the built repo and not recorded in a file.
//
// "Pull requests for a commit" lists the PR whose branch holds the commit, and the PR that put the
// commit on main (a squash commit or a rebased copy), as GitHub does. A commit GitHub does not
// know gets a 422.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv } from './git-env.js';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) }).trim();
}

// Maps each "pull requests for a commit" path to its recorded reply.
function commitPullsReplies({ dir, history, onMain }, repo) {
  const prsOf = new Map();
  const add = (sha, pr) => prsOf.set(sha, [...(prsOf.get(sha) ?? []), pr]);
  const replies = {};
  for (const pr of history) {
    const branch = git(dir, ['rev-list', `${pr.base_sha}..refs/pull/${pr.number}/head`]).split('\n');
    for (const sha of branch) add(sha, pr);
    for (const sha of onMain.get(pr.number)) if (!branch.includes(sha)) add(sha, pr);
  }
  for (const [sha, prs] of prsOf) {
    replies[`/repos/${repo}/commits/${sha}/pulls?per_page=100`] = {
      status: 200,
      headers: {},
      body: prs.map((pr) => ({ number: pr.number, state: 'closed', merged_at: pr.merged_at, merge_commit_sha: pr.merge_sha }))
    };
  }
  return replies;
}

/** A fetch that answers "pull requests for a commit" for the built fixture repo. */
export function commitPullsFetch(built, repo) {
  const replies = commitPullsReplies(built, repo);
  const calls = [];
  async function fetch(url) {
    const { pathname, search } = new URL(url);
    const key = pathname + search;
    calls.push({ key });
    const reply = replies[key] ?? { status: 422, body: { message: `No commit found for SHA: ${pathname.split('/')[5]}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }
  fetch.calls = calls;
  return fetch;
}

/**
 * Writes a replay file (the format of test-support/replay-fetch.js) that serves the whole
 * fixture repo as GitHub would: the PR list, each PR's files, reviews, comments, check runs and
 * commit statuses, and "pull requests for a commit". Returns its path.
 */
export function writeHistoryReplay(built, repo) {
  const replies = commitPullsReplies(built, repo);
  const newestFirst = [...built.history].reverse();
  replies[`/repos/${repo}/pulls?state=closed&per_page=100`] = {
    status: 200,
    headers: {},
    body: newestFirst.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      user: { login: pr.author },
      labels: pr.labels.map((name) => ({ name })),
      merged_at: pr.merged_at,
      merge_commit_sha: pr.merge_sha,
      base: { ref: 'main', sha: pr.base_sha },
      head: { ref: `pr-${pr.number}`, sha: git(built.dir, ['rev-parse', `refs/pull/${pr.number}/head`]) }
    }))
  };
  for (const pr of built.history) {
    const head = git(built.dir, ['rev-parse', `refs/pull/${pr.number}/head`]);
    replies[`/repos/${repo}/pulls/${pr.number}/files?per_page=100`] = {
      status: 200,
      headers: {},
      body: pr.files.map((file) => ({ filename: file.path, additions: file.additions, deletions: file.deletions }))
    };
    replies[`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`] = { status: 200, headers: {}, body: [] };
    replies[`/repos/${repo}/issues/${pr.number}/comments?per_page=100`] = { status: 200, headers: {}, body: [] };
    replies[`/repos/${repo}/commits/${head}/check-runs?per_page=100`] = { status: 200, headers: {}, body: { total_count: 0, check_runs: [] } };
    replies[`/repos/${repo}/commits/${head}/status?per_page=100`] = { status: 200, headers: {}, body: { state: 'pending', statuses: [], total_count: 0 } };
  }
  const path = join(mkdtempSync(join(tmpdir(), 'exhibit-replay-')), 'shop.json');
  writeFileSync(path, JSON.stringify(replies));
  return path;
}
