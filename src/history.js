import { commentReviews, quotedVerdictWarnings } from './comment-reviews.js';
import { classifyFix, DEFAULT_FIX_SIGNALS } from './fix-signals.js';
import { ToolError } from './tool-error.js';

// How many PRs ask for their files, reviews, comments and CI results at the same time.
const PRS_AT_ONCE = 8;

// Reads the merged PRs of the forge's repo and returns one history line for each, newest merge
// first. `forge` is the forge module for the repo, such as createGitHubForge in src/github.js.
// `since` (a Date) keeps PRs merged at or after it. `limit` keeps the newest N.
// Only the kept PRs ask for their files, reviews, comments and CI results.
// `fixSignals` (spec 9.1, the defaults when left out) fills `classification`. The lines fill the spec 8.3 fields this version
// knows: the later fields (evidence_section, szz, exhibit) are left out. The schema requires szz,
// so the history command (src/commands/history.js) adds szz to each line before it checks and
// writes the lines.
// `warn` gets one text for each PR whose files list the forge cut short, and one for each comment
// whose only verdict is in a quoted line, in the order of the lines.
export async function readHistory({ forge, since, limit, fixSignals = DEFAULT_FIX_SIGNALS, warn = () => {} }) {
  let merged = await forge.mergedPulls();
  if (since) merged = merged.filter((pr) => new Date(pr.merged_at) >= since);
  merged.sort((a, b) => b.merged_at.localeCompare(a.merged_at) || b.number - a.number);
  if (limit !== undefined) merged = merged.slice(0, limit);

  const read = await mapInBatches(merged, PRS_AT_ONCE, async (pr) => {
    const [files, reviews, comments, ci] = await Promise.all([
      forge.pullFiles(pr.number),
      forge.pullReviews(pr.number),
      // The PR's comments, where some rooms post their reviews (spec 8.3).
      forge.pullComments(pr.number),
      // The CI results on the PR's last head commit: the CI result the PR was merged with.
      forge.ciResults(pr.head.sha)
    ]);
    const filesWarning = await checkFilesComplete(forge, pr.number, files.length);
    return {
      line: toHistoryLine(pr, files, reviews, comments, ci, fixSignals),
      warnings: [...(filesWarning ? [filesWarning] : []), ...quotedVerdictWarnings(pr.number, comments)]
    };
  });
  for (const { warnings } of read) for (const warning of warnings) warn(warning);
  return read.map(({ line }) => line);
}

// Returns a warning when the forge listed fewer files than the PR changed, or null. Only a PR
// whose list reached the forge's limit is asked for its count of changed files.
// The count is only for this warning. So when that request fails, the run goes on, and the
// warning says that the count is unknown and the list may be cut short.
async function checkFilesComplete(forge, number, listed) {
  if (listed < forge.mostFilesListed) return null;
  let changed;
  try {
    changed = await forge.pullFileCount(number);
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
    // The history line keeps the name and conclusion of each CI result (spec 8.3).
    ci: ci.map(({ name, conclusion }) => ({ name, conclusion })),
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

async function mapInBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}
