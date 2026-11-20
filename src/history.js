import { commentReviews, quotedVerdictWarnings } from './comment-reviews.js';
import { classifyWithTracker, DEFAULT_FIX_SIGNALS } from './fix-signals.js';
import { ToolError } from './tool-error.js';

// How many PRs ask for their files, reviews, comments and CI results at the same time.
const PRS_AT_ONCE = 8;

// The look-back window of an incremental run (spec 8.3): the PRs merged in the last 7 days
// before the newest line in the old file are read again, for late reviews, comments and CI.
export const LOOK_BACK_MS = 7 * 24 * 60 * 60 * 1000;

// Reads the merged PRs of the forge's repo and returns one history line for each, newest merge
// first. It reads every PR. See updateHistory for the options.
export async function readHistory(options) {
  return (await updateHistory({ ...options, previous: [] })).lines;
}

// Returns { lines, read }: one history line for each merged PR, newest merge first, and how
// many of them it read from the forge. `forge` is the forge for the repo, as a forge module's
// connect function makes it, such as GITHUB_FORGE.connect in src/github.js.
// `since` (a Date) keeps PRs merged at or after it. `limit` keeps the newest N. The forge gets
// both, so it can stop its list of merged PRs early. It may list more PRs than these two options
// keep, and they pick from the list.
// `previous` holds the lines of the old history file, which must pass the schema. A kept PR that
// has a line there is not read again, and keeps that line as it is, unless it was merged in the
// look-back window: at or after LOOK_BACK_MS before the newest merge in `previous`. A PR with no
// line there is read. So an empty `previous` reads every kept PR.
// Only the PRs that are read ask for their files, reviews, comments and CI results.
// `fixSignals` (spec 9.1, the defaults when left out) fills `classification` on every line, kept
// lines too, so a change to the signals reaches the whole file with no extra request. A kept
// line is classified from its own title, body and labels, and from the branch name in the list of
// merged PRs, as a line does not hold its branch name. The lines that are
// read fill the spec 8.3 fields this version knows: the later fields (evidence_section, szz,
// exhibit) are left out. The schema requires szz, so the history command
// (src/commands/history.js) adds szz to each line that has none before it checks and writes the
// lines.
// `tracker` is a connected tracker, such as Jira, for the tracker:jira signal, or null. Each PR
// asks it at most once, kept lines too (see classifyWithTracker in src/fix-signals.js).
// `warn` gets one text for each PR whose files list the forge cut short, one for each comment
// whose only verdict is in a quoted line, and one for each PR whose ticket the tracker could not
// read, in the order of the lines.
export async function updateHistory({ forge, since, limit, previous, fixSignals = DEFAULT_FIX_SIGNALS, tracker = null, warn = () => {} }) {
  let merged = await forge.mergedPulls({ since, limit });
  if (since) merged = merged.filter((pr) => new Date(pr.mergedAt) >= since);
  merged.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number);
  if (limit !== undefined) merged = merged.slice(0, limit);

  const old = new Map(previous.map((line) => [line.number, line]));
  const windowStart = previous.length === 0 ? null : Math.max(...previous.map((line) => Date.parse(line.merged_at))) - LOOK_BACK_MS;
  const toRead = merged.filter((pr) => !old.has(pr.number) || Date.parse(pr.mergedAt) >= windowStart);

  const classify = async (pr) => {
    const { classification, problem } = await classifyWithTracker({ number: pr.number, title: pr.title, body: pr.body, labels: pr.labels, branch: pr.headRef, repo: forge.repo }, fixSignals, tracker);
    return { classification, warnings: problem ? [`PR ${pr.number}: ${problem}`] : [] };
  };

  const read = await mapInBatches(toRead, PRS_AT_ONCE, async (pr) => {
    const [files, reviews, comments, ci, classified] = await Promise.all([
      forge.pullFiles(pr.number),
      forge.pullReviews(pr.number),
      // The PR's comments, where some rooms post their reviews (spec 8.3).
      forge.pullComments(pr.number),
      // The CI results on the PR's last head commit: the CI result the PR was merged with.
      forge.ciResults(pr.headSha),
      classify(pr)
    ]);
    const filesWarning = await checkFilesComplete(forge, pr.number, files.length);
    return {
      number: pr.number,
      line: toHistoryLine(forge, pr, files, reviews, comments, ci, classified.classification),
      warnings: [...(filesWarning ? [filesWarning] : []), ...quotedVerdictWarnings(pr.number, comments), ...classified.warnings]
    };
  });
  const fresh = new Map(read.map((one) => [one.number, one]));
  // A kept line is classified again from its own title, body and labels, and from the branch name in
  // the list of merged PRs, as a line does not hold its branch name. It keeps its szz: the history
  // command sets szz to null on a line that is no fix.
  const kept = await mapInBatches(merged.filter((pr) => !fresh.has(pr.number)), PRS_AT_ONCE, async (pr) => {
    const line = old.get(pr.number);
    const { classification, warnings } = await classify({ ...pr, title: line.title, body: line.body, labels: line.labels });
    return { number: pr.number, line: { ...line, classification }, warnings };
  });
  const byNumber = new Map([...fresh, ...kept.map((one) => [one.number, one])]);
  const lines = merged.map((pr) => byNumber.get(pr.number));
  for (const { warnings } of lines) for (const warning of warnings) warn(warning);
  return { lines: lines.map(({ line }) => line), read: read.length };
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
    return `PR ${number} has ${listed} files listed, the most ${forge.displayName} lists, so its files field may be cut short. Exhibit could not read how many files it changed: ${error.message}`;
  }
  if (!(changed > listed)) return null;
  return `PR ${number} changed ${changed} files, but ${forge.displayName} listed only the first ${listed}, so its files field is cut short.`;
}

function toHistoryLine(forge, pr, files, reviews, comments, ci, classification) {
  const list = inTimeOrder(
    reviews.map((review) => ({ state: review.state, author: review.author, source: 'review', at: review.at })),
    commentReviews(comments)
  ).map(({ state, author, source }) => ({ state, author, source }));
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    labels: pr.labels,
    merged_at: pr.mergedAt,
    base_ref: pr.baseRef,
    base_sha: pr.baseSha,
    // The PR's last head commit, not the merge commit. With it, git merge-base can find where the
    // PR's branch left the base branch from this line alone (spec 16, question 8).
    head_sha: pr.headSha,
    merge_sha: pr.mergeSha,
    forge: forge.name,
    url: pr.url,
    files: files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
    reviews: {
      // A change request that was later dismissed has the state DISMISSED, so it is not a round.
      // A comment review with the verdict fix has the state CHANGES_REQUESTED, so it is a round.
      change_request_rounds: list.filter((review) => review.state === 'CHANGES_REQUESTED').length,
      list
    },
    // The history line keeps the name and conclusion of each CI result (spec 8.3).
    ci: ci.map(({ name, conclusion }) => ({ name, conclusion })),
    classification
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
