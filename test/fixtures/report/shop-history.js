// The history that `exhibit history` writes for the fixture repo (test/fixtures/szz-repo.js), with
// szz filled. The report tests read it from shop-history.jsonl, a fixed file, so they need no git.
// test/report.test.js checks that the file is still what SZZ gives on the fixture repo.
//
// To write the file again after a change to SZZ or to the fixture repo:
//   node test/fixtures/report/shop-history.js > test/fixtures/report/shop-history.jsonl

import { pathToFileURL } from 'node:url';
import { createGitHubForge } from '../../../src/github.js';
import { addSzz } from '../../../src/szz.js';
import { buildSzzRepo } from '../szz-repo.js';
import { commitPullsFetch } from '../github/szz-replies.js';

export const SHOP_REPO = 'fixture/shop';
export const SHOP_HISTORY = new URL('./shop-history.jsonl', import.meta.url);

/** Builds the fixture repo, runs SZZ on it, and returns the history file's text. */
export async function shopHistoryText() {
  const repo = buildSzzRepo();
  try {
    const forge = createGitHubForge({ repo: SHOP_REPO, token: 't', fetch: commitPullsFetch(repo, SHOP_REPO) });
    const lines = await addSzz(repo.history, { dir: repo.dir, forge });
    return lines.map((line) => JSON.stringify(line) + '\n').join('');
  } finally {
    repo.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(await shopHistoryText());
