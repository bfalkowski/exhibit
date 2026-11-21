// Builds the recorded GitHub replies for acme/big, a repo with PRs that change many files.
//
// GitHub lists at most 3,000 files for one PR. A recorded file with 3,000 files would be large,
// so this script builds the replies in code and writes them to a temp file for replay-fetch.
//
// - PR 9 changed 3,412 files. The files list stops at 3,000, so its list is cut short.
// - PR 8 changed exactly 3,000 files. The list has all of them, so its list is complete.
// - PR 7 changed 2 files.
// writeShortListFixture builds one more repo, acme/short, for a list that stops early:
// - PR 6 changed 2,600 files, but its files list stops at 2,500, below the 3,000 that GitHub
//   says it lists. GraphQL may stop a list at another number one day, and the warning must
//   still fire.
// GraphQL gives each PR's count of changed files with the PR, and its files 100 to a page.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphqlReplies } from './graphql-replies.js';

const LISTED_AT_MOST = 3000;

// `listed` is how many files the files list holds. It is the most GitHub lists when left out.
function pr(number, changedFiles, listed = Math.min(changedFiles, LISTED_AT_MOST)) {
  const day = String(number).padStart(2, '0');
  const sha = (letter) => letter.repeat(39) + number;
  const files = [];
  for (let i = 0; i < listed; i++) files.push({ path: `src/file-${i}.js`, additions: 1, deletions: 0 });
  return {
    number,
    title: `PR ${number}`,
    body: `Body of #${number}.`,
    author: { __typename: 'User', login: `dev${number}` },
    mergedAt: `2026-04-${day}T12:00:00Z`,
    changedFiles,
    mergeSha: sha('a'),
    baseRef: 'main',
    baseSha: sha('b'),
    headRef: `topic-${number}`,
    headSha: sha('c'),
    labels: [],
    files,
    // No reviews, no comments and no CI results: these PRs are here for their files only.
    reviews: [],
    comments: [],
    ci: []
  };
}

// Writes the fixture to a new temp folder. Returns the path of the file, and `cleanup`, which
// removes the folder: call it when the test ends, for example with t.after(cleanup).
export function writeBigFixture() {
  return writeFixture('acme/big', [pr(9, 3412), pr(8, 3000), pr(7, 2)]);
}

// The same for acme/short.
export function writeShortListFixture() {
  return writeFixture('acme/short', [pr(6, 2600, 2500)]);
}

function writeFixture(repoName, pulls) {
  const replies = graphqlReplies(repoName, pulls.map((pull) => ({ ...pull, url: `https://github.com/${repoName}/pull/${pull.number}` })));
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-fixture-'));
  const path = join(dir, `${repoName.replace('/', '-')}.json`);
  writeFileSync(path, JSON.stringify(replies));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
