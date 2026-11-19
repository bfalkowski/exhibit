import { classifyFix, DEFAULT_FIX_SIGNALS } from './fix-signals.js';
import { createGitHub } from './github.js';

// How many PRs ask for their files, reviews, check runs and commit statuses at the same time.
const PRS_AT_ONCE = 8;

// GitHub lists at most this many files for one PR. A shorter list is complete.
const LISTED_FILES_AT_MOST = 3000;

// Reads the merged PRs of `repo` ("owner/name") and returns one history line for each, newest
// merge first. `since` (a Date) keeps PRs merged at or after it. `limit` keeps the newest N.
// Only the kept PRs ask for their files, reviews, check runs and commit statuses. `fixSignals` (spec 9.1, the
// defaults when left out) fills `classification`. The lines fill the spec 8.3 fields this version
// knows: the later fields (evidence_section, szz, exhibit) are left out.
// `warn` gets one text for each PR whose files list GitHub cut short, in the order of the lines.
export async function readHistory({ repo, token, fetch, since, limit, fixSignals = DEFAULT_FIX_SIGNALS, warn = () => {} }) {
  const github = createGitHub({ token, fetch });
  const pulls = await github.getAll(`/repos/${repo}/pulls?state=closed&per_page=100`);

  let merged = pulls.filter((pr) => pr.merged_at !== null);
  if (since) merged = merged.filter((pr) => new Date(pr.merged_at) >= since);
  merged.sort((a, b) => b.merged_at.localeCompare(a.merged_at) || b.number - a.number);
  if (limit !== undefined) merged = merged.slice(0, limit);

  const read = await mapInBatches(merged, PRS_AT_ONCE, async (pr) => {
    const [files, reviews, checkRuns, statuses] = await Promise.all([
      github.getAll(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`),
      github.getAll(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`),
      // The check runs and commit statuses on the PR's last head commit: the CI result the PR was
      // merged with. Some CI services post check runs, and some post the older commit statuses.
      github.getAll(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, { listField: 'check_runs' }),
      // The combined status: GitHub gives only the newest status for each context.
      github.getAll(`/repos/${repo}/commits/${pr.head.sha}/status?per_page=100`, { listField: 'statuses' })
    ]);
    return { line: toHistoryLine(pr, files, reviews, [...checkRuns.map(fromCheckRun), ...statuses.map(fromStatus)], fixSignals), warning: await checkFilesComplete(github, repo, pr.number, files.length) };
  });
  for (const { warning } of read) if (warning) warn(warning);
  return read.map(({ line }) => line);
}

// Returns a warning when GitHub listed fewer files than the PR changed, or null. The list of PRs
// has no changed_files count, so only a PR whose list reached GitHub's limit is asked for it.
async function checkFilesComplete(github, repo, number, listed) {
  if (listed < LISTED_FILES_AT_MOST) return null;
  const { changed_files: changed } = await github.getOne(`/repos/${repo}/pulls/${number}`);
  if (!(changed > listed)) return null;
  return `PR ${number} changed ${changed} files, but GitHub listed only the first ${listed}, so its files field is cut short.`;
}

function toHistoryLine(pr, files, reviews, ci, fixSignals) {
  const labels = pr.labels.map((label) => label.name);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user?.login ?? null,
    labels,
    merged_at: pr.merged_at,
    base_sha: pr.base.sha,
    merge_sha: pr.merge_commit_sha,
    files: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })),
    reviews: {
      // A change request that was later dismissed has the state DISMISSED, so it is not a round.
      change_request_rounds: reviews.filter((review) => review.state === 'CHANGES_REQUESTED').length,
      list: reviews.map((review) => ({ state: review.state, author: review.user?.login ?? null }))
    },
    ci,
    classification: classifyFix({ title: pr.title, labels, branch: pr.head.ref }, fixSignals)
  };
}

function fromCheckRun(run) {
  return { name: run.name, conclusion: run.conclusion };
}

// A commit status has a state: success, failure, error or pending. A pending status has not
// finished, so its conclusion is null, as for a check run that has not finished.
function fromStatus(status) {
  return { name: status.context, conclusion: status.state === 'pending' ? null : status.state };
}

async function mapInBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}
