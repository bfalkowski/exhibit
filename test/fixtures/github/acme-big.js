// Builds the recorded GitHub replies for acme/big, a repo with PRs that change many files.
//
// GitHub lists at most 3,000 files for one PR. A recorded file with 3,000 files would be large,
// so this script builds the replies in code and writes them to a temp file for replay-fetch.
//
// - PR 9 changed 3,412 files. The files list stops at 3,000, so its list is cut short.
// - PR 8 changed exactly 3,000 files. The list has all of them, so its list is complete.
// - PR 7 changed 2 files. Its list is short, so nobody needs to ask for the PR itself.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_SIZE = 100;
const LISTED_AT_MOST = 3000;

function pr(number, changedFiles) {
  const day = String(number).padStart(2, '0');
  const sha = (letter) => letter.repeat(39) + number;
  return {
    number,
    html_url: `https://github.com/acme/big/pull/${number}`,
    state: 'closed',
    title: `PR ${number}`,
    body: `Body of #${number}.`,
    user: { login: `dev${number}`, type: 'User' },
    labels: [],
    created_at: `2026-04-${day}T00:00:00Z`,
    closed_at: `2026-04-${day}T12:00:00Z`,
    merged_at: `2026-04-${day}T12:00:00Z`,
    merge_commit_sha: sha('a'),
    base: { ref: 'main', sha: sha('b') },
    head: { ref: `topic-${number}`, sha: sha('c') },
    changed_files: changedFiles
  };
}

// The list endpoint leaves out changed_files. Only the reply for one PR has it.
function listed(pull) {
  const rest = { ...pull };
  delete rest.changed_files;
  return rest;
}

// Records the pages of one PR's files list, as GitHub sends them: 100 files a page, and at most
// 3,000 files in all, with a Link header to the next page.
function recordFiles(replies, number, changedFiles) {
  const count = Math.min(changedFiles, LISTED_AT_MOST);
  const pages = Math.ceil(count / PAGE_SIZE);
  for (let page = 1; page <= pages; page++) {
    const key = page === 1 ? `/repos/acme/big/pulls/${number}/files?per_page=100` : `/repositories/5151/pulls/${number}/files?per_page=100&page=${page}`;
    const first = (page - 1) * PAGE_SIZE;
    const body = [];
    for (let i = first; i < Math.min(first + PAGE_SIZE, count); i++) {
      body.push({ filename: `src/file-${i}.js`, status: 'added', additions: 1, deletions: 0, changes: 1 });
    }
    const headers = page < pages ? { link: `<https://api.github.com/repositories/5151/pulls/${number}/files?per_page=100&page=${page + 1}>; rel="next"` } : {};
    replies[key] = { status: 200, headers, body };
  }
}

// Writes the fixture to a new temp folder. Returns the path of the file, and `cleanup`, which
// removes the folder: call it when the test ends, for example with t.after(cleanup).
// `unreadable` lists PR numbers whose reply for the PR itself is a 500, as when GitHub has a problem.
// `countReplies` maps a PR number to the reply for the PR itself, such as a rate limit. It wins
// over `unreadable`.
export function writeBigFixture({ unreadable = [], countReplies = {} } = {}) {
  const pulls = [pr(9, 3412), pr(8, 3000), pr(7, 2)];
  const replies = {
    '/repos/acme/big/pulls?state=closed&per_page=100': { status: 200, headers: {}, body: pulls.map(listed) }
  };
  for (const pull of pulls) {
    recordFiles(replies, pull.number, pull.changed_files);
    // No reviews, no comments and no check runs: these PRs are here for their files only.
    replies[`/repos/acme/big/pulls/${pull.number}/reviews?per_page=100`] = { status: 200, headers: {}, body: [] };
    replies[`/repos/acme/big/issues/${pull.number}/comments?per_page=100`] = { status: 200, headers: {}, body: [] };
    replies[`/repos/acme/big/commits/${pull.head.sha}/check-runs?per_page=100`] = { status: 200, headers: {}, body: { total_count: 0, check_runs: [] } };
    replies[`/repos/acme/big/commits/${pull.head.sha}/status?per_page=100`] = { status: 200, headers: {}, body: { state: 'pending', statuses: [], total_count: 0 } };
    // PR 7 has no reply for itself on purpose: a request for it fails the test.
    if (pull.changed_files >= LISTED_AT_MOST) {
      replies[`/repos/acme/big/pulls/${pull.number}`] = countReplies[pull.number] ?? (unreadable.includes(pull.number)
        ? { status: 500, headers: {}, body: { message: 'Server Error' } }
        : { status: 200, headers: {}, body: pull });
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-fixture-'));
  const path = join(dir, 'acme-big.json');
  writeFileSync(path, JSON.stringify(replies));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
