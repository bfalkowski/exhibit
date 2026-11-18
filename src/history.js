import { createGitHub } from './github.js';

// How many PRs ask for their files at the same time.
const FILE_REQUESTS_AT_ONCE = 8;

// Reads the merged PRs of `repo` ("owner/name") and returns one history line for each, newest
// merge first. `since` (a Date) keeps PRs merged at or after it. `limit` keeps the newest N.
// Only the kept PRs ask for their files. The lines fill the spec 8.3 fields this version knows:
// the later fields (reviews, ci, classification, evidence_section, szz, exhibit) are left out.
export async function readHistory({ repo, token, fetch, since, limit }) {
  const github = createGitHub({ token, fetch });
  const pulls = await github.getAll(`/repos/${repo}/pulls?state=closed&per_page=100`);

  let merged = pulls.filter((pr) => pr.merged_at !== null);
  if (since) merged = merged.filter((pr) => new Date(pr.merged_at) >= since);
  merged.sort((a, b) => b.merged_at.localeCompare(a.merged_at) || b.number - a.number);
  if (limit !== undefined) merged = merged.slice(0, limit);

  return mapInBatches(merged, FILE_REQUESTS_AT_ONCE, async (pr) => {
    const files = await github.getAll(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`);
    return toHistoryLine(pr, files);
  });
}

function toHistoryLine(pr, files) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user?.login ?? null,
    labels: pr.labels.map((label) => label.name),
    merged_at: pr.merged_at,
    base_sha: pr.base.sha,
    merge_sha: pr.merge_commit_sha,
    files: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions }))
  };
}

async function mapInBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}
