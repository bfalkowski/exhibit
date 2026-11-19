// GitHub API replies for the fixture repo that szz-repo.js builds. Its SHAs are known only after
// the build, so the replies are made from the built repo and not recorded in a file.
//
// "Pull requests for a commit" lists the PR whose branch holds the commit, and the PR that put the
// commit on main (a squash commit or a rebased copy), as GitHub does. A commit GitHub does not
// know gets a 422.
//
// A PR from a fork has its head in the fork's repo. GitHub keeps its commits in the repo the PR
// merged into, at refs/pull/N/head, so that repo is the one to ask. The fetch fails the test when
// it is asked about a fork's repo.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv } from '../git-env.js';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) }).trim();
}

// Maps each "pull requests for a commit" path to its recorded reply.
function commitPullsReplies({ dir, history, onMain, forks }, repo) {
  const prsOf = new Map();
  const add = (sha, pr) => prsOf.set(sha, [...(prsOf.get(sha) ?? []), pr]);
  const replies = { [`/repos/${repo}`]: { status: 200, headers: {}, body: { full_name: repo, default_branch: 'main' } } };
  for (const pr of history) {
    const branch = git(dir, ['rev-list', `${pr.base_sha}..refs/pull/${pr.number}/head`]).split('\n');
    for (const sha of branch) add(sha, pr);
    for (const sha of onMain.get(pr.number)) if (!branch.includes(sha)) add(sha, pr);
  }
  for (const [sha, prs] of prsOf) {
    replies[`/repos/${repo}/commits/${sha}/pulls?per_page=100`] = {
      status: 200,
      headers: {},
      body: prs.map((pr) => ({
        number: pr.number,
        state: 'closed',
        merged_at: pr.merged_at,
        merge_commit_sha: pr.merge_sha,
        base: { ref: 'main', sha: pr.base_sha, repo: { full_name: repo } },
        head: { ref: `pr-${pr.number}`, sha: pr.head_sha, repo: { full_name: forks.get(pr.number) ?? repo } }
      }))
    };
  }
  return replies;
}

/**
 * A fetch that answers "pull requests for a commit" for the built fixture repo. It throws on a
 * request to a fork's repo, and keeps that request in `fetch.forkCalls`, so a test can check that
 * no caller hid the throw.
 */
export function commitPullsFetch(built, repo) {
  const replies = commitPullsReplies(built, repo);
  const forkPaths = [...new Set(built.forks.values())].map((fork) => `/repos/${fork}/`.toLowerCase());
  const calls = [];
  const forkCalls = [];
  async function fetch(url) {
    const { pathname, search } = new URL(url);
    const key = pathname + search;
    if (forkPaths.some((path) => pathname.toLowerCase().startsWith(path))) {
      forkCalls.push({ key });
      throw new Error(`The test asked a fork's repo: ${key}. Ask ${repo}, the repo the PR merged into.`);
    }
    calls.push({ key });
    const reply = replies[key] ?? { status: 422, body: { message: `No commit found for SHA: ${pathname.split('/')[5]}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }
  fetch.calls = calls;
  fetch.forkCalls = forkCalls;
  return fetch;
}

/**
 * Writes a replay file (the format of test-support/replay-fetch.js) that serves the whole
 * fixture repo as GitHub would: the PR list, each PR's files, reviews, comments, check runs and
 * commit statuses, and "pull requests for a commit". Returns the path of the file, and `cleanup`,
 * which removes its folder: call it when the test ends, for example with t.after(cleanup).
 */
export function writeHistoryReplay(built, repo) {
  const replies = commitPullsReplies(built, repo);
  const newestFirst = [...built.history].reverse();
  replies[`/repos/${repo}/pulls?state=closed&per_page=100`] = {
    status: 200,
    headers: {},
    body: newestFirst.map((pr) => ({
      number: pr.number,
      html_url: pr.url,
      title: pr.title,
      body: pr.body,
      user: { login: pr.author },
      labels: pr.labels.map((name) => ({ name })),
      merged_at: pr.merged_at,
      merge_commit_sha: pr.merge_sha,
      base: { ref: 'main', sha: pr.base_sha },
      head: { ref: `pr-${pr.number}`, sha: pr.head_sha, repo: { full_name: built.forks.get(pr.number) ?? repo } }
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
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-replay-'));
  const path = join(dir, 'shop.json');
  writeFileSync(path, JSON.stringify(replies));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
