// Builds the recorded GitHub replies for acme/big, a repo with PRs that change many files.
//
// GitHub lists at most 3,000 files for one PR. A recorded file with 3,000 files would be large,
// so this script builds the replies in code and writes them to a temp file for replay-fetch.
//
// - PR 9 changed 3,412 files. The files list stops at 3,000, so its list is cut short.
// - PR 8 changed exactly 3,000 files. The list has all of them, so its list is complete.
// - PR 7 changed 2 files.
// GraphQL gives each PR's count of changed files with the PR, and its files 100 to a page.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphqlReplies } from './graphql-replies.js';

const LISTED_AT_MOST = 3000;

function pr(number, changedFiles) {
  const day = String(number).padStart(2, '0');
  const sha = (letter) => letter.repeat(39) + number;
  const files = [];
  for (let i = 0; i < Math.min(changedFiles, LISTED_AT_MOST); i++) files.push({ path: `src/file-${i}.js`, additions: 1, deletions: 0 });
  return {
    number,
    url: `https://github.com/acme/big/pull/${number}`,
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
  const replies = graphqlReplies('acme/big', [pr(9, 3412), pr(8, 3000), pr(7, 2)]);
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-fixture-'));
  const path = join(dir, 'acme-big.json');
  writeFileSync(path, JSON.stringify(replies));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
