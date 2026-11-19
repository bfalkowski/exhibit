import { commentReviews } from './comment-reviews.js';
import { classifyFix, DEFAULT_FIX_SIGNALS } from './fix-signals.js';
import { createGitHub, PERMISSIONS } from './github.js';
import { ToolError } from './tool-error.js';

// How many PRs ask for their files, reviews, comments, check runs and commit statuses at the same
// time.
const PRS_AT_ONCE = 8;

// GitHub lists at most this many files for one PR. A shorter list is complete.
const LISTED_FILES_AT_MOST = 3000;

// Reads the merged PRs of `repo` ("owner/name") and returns one history line for each, newest
// merge first. `since` (a Date) keeps PRs merged at or after it. `limit` keeps the newest N.
// Only the kept PRs ask for their files, reviews, comments, check runs and commit statuses.
// `fixSignals` (spec 9.1, the defaults when left out) fills `classification`. The lines fill the spec 8.3 fields this version
// knows: the later fields (evidence_section, szz, exhibit) are left out. The schema requires szz,
// so the history command (src/commands/history.js) adds szz to each line before it checks and
// writes the lines.
// `warn` gets one text for each PR whose files list GitHub cut short, in the order of the lines.
export async function readHistory({ repo, token, fetch, since, limit, fixSignals = DEFAULT_FIX_SIGNALS, warn = () => {} }) {
  const github = createGitHub({ token, fetch });
  const pulls = await github.getAll(`/repos/${repo}/pulls?state=closed&per_page=100`, { permission: PERMISSIONS.pullRequests });

  let merged = pulls.filter((pr) => pr.merged_at !== null);
  if (since) merged = merged.filter((pr) => new Date(pr.merged_at) >= since);
  merged.sort((a, b) => b.merged_at.localeCompare(a.merged_at) || b.number - a.number);
  if (limit !== undefined) merged = merged.slice(0, limit);

  const read = await mapInBatches(merged, PRS_AT_ONCE, async (pr) => {
    const [files, reviews, comments, checkRuns, statuses] = await Promise.all([
      github.getAll(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`, { permission: PERMISSIONS.pullRequests }),
      github.getAll(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`, { permission: PERMISSIONS.pullRequests }),
      // The PR's comments, where some rooms post their reviews (spec 8.3).
      github.getAll(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`, { permission: PERMISSIONS.pullRequests }),
      // The check runs and commit statuses on the PR's last head commit: the CI result the PR was
      // merged with. Some CI services post check runs, and some post the older commit statuses.
      github.getAll(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, { listField: 'check_runs', permission: PERMISSIONS.checks }),
      // The combined status: GitHub gives only the newest status for each context.
      github.getAll(`/repos/${repo}/commits/${pr.head.sha}/status?per_page=100`, { listField: 'statuses', permission: PERMISSIONS.commitStatuses })
    ]);
    const ci = [...checkRuns.map(fromCheckRun), ...statuses.map(fromStatus)];
    return { line: toHistoryLine(pr, files, reviews, comments, ci, fixSignals), warning: await checkFilesComplete(github, repo, pr.number, files.length) };
  });
  for (const { warning } of read) if (warning) warn(warning);
  return read.map(({ line }) => line);
}

// Returns a warning when GitHub listed fewer files than the PR changed, or null. The list of PRs
// has no changed_files count, so only a PR whose list reached GitHub's limit is asked for it.
// The count is only for this warning. So when that request fails, the run goes on, and the
// warning says that the count is unknown and the list may be cut short.
async function checkFilesComplete(github, repo, number, listed) {
  if (listed < LISTED_FILES_AT_MOST) return null;
  let changed;
  try {
    ({ changed_files: changed } = await github.getOne(`/repos/${repo}/pulls/${number}`, { permission: PERMISSIONS.pullRequests }));
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return `PR ${number} has ${listed} files listed, the most GitHub lists, so its files field may be cut short. Exhibit could not read how many files it changed: ${error.message}`;
  }
  if (!(changed > listed)) return null;
  return `PR ${number} changed ${changed} files, but GitHub listed only the first ${listed}, so its files field is cut short.`;
}

function toHistoryLine(pr, files, reviews, comments, ci, fixSignals) {
  const labels = pr.labels.map((label) => label.name);
  const list = inTimeOrder(
    reviews.map((review) => ({ state: review.state, author: review.user?.login ?? null, source: 'review', at: review.submitted_at })),
    commentReviews(comments)
  ).map(({ state, author, source }) => ({ state, author, source }));
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user?.login ?? null,
    labels,
    merged_at: pr.merged_at,
    base_ref: pr.base.ref,
    base_sha: pr.base.sha,
    merge_sha: pr.merge_commit_sha,
    files: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })),
    reviews: {
      // A change request that was later dismissed has the state DISMISSED, so it is not a round.
      // A comment review with the verdict fix has the state CHANGES_REQUESTED, so it is a round.
      change_request_rounds: list.filter((review) => review.state === 'CHANGES_REQUESTED').length,
      list
    },
    ci,
    classification: classifyFix({ title: pr.title, labels, branch: pr.head.ref }, fixSignals)
  };
}

// Merges two lists that are each oldest first into one list, oldest first, by their `at` times.
// GitHub gives no time for a review that is still pending, so it keeps its place before the next
// comment. At the same time, the review comes first.
function inTimeOrder(reviews, comments) {
  const merged = [];
  let c = 0;
  for (const review of reviews) {
    while (c < comments.length && review.at && comments[c].at < review.at) merged.push(comments[c++]);
    merged.push(review);
  }
  return merged.concat(comments.slice(c));
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
