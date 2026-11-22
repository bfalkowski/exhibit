// The signals spec 8.1 and 9.1 use when evidence.yml does not set settings.fix_signals.
export const DEFAULT_FIX_SIGNALS = Object.freeze(['label:bug', 'title:fix', 'branch:fix/']);

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
// One or more ticket keys at the start of a title, such as "T-170: ", "KEY-123 ", "[KEY-123] ",
// "(KEY-123): ", "T-170 - ", "T-170, T-171: ", "ZOOKEEPER-123. ", "#79: " or "192: ". A key is
// letters and digits, a hyphen and digits, or "#" and digits. After a key in brackets, a colon, a
// comma or a dash may follow. A bare key needs a colon, a comma, a period and a space, or a space
// after it, so "T-170Fix" and "T-170.Fix" keep their key, and a dash after a bare key needs a space
// before it, so "T-170-Fix" keeps its key too. A ticket number alone, such as "192", is a key only
// bare and with a colon after it, so "79 fixes" and "1.2: fix" keep their number. Titles are
// lowercase by the time they get here.
const KEY = '(?:[a-z][a-z0-9_]*-\\d+|#\\d+)';
const BRACKETED = `(?:\\[${KEY}\\]|\\(${KEY}\\))\\s*(?:[:,-]\\s*)?`;
const BARE = `${KEY}(?:\\s*[:,]\\s*|\\.\\s+|\\s+-\\s*|\\s+)`;
const NUMBER = '\\d+\\s*:\\s*';
const LEADING_KEY = new RegExp(`^(?:${BRACKETED}|${BARE}|${NUMBER})+`);

// One tag that title_after_tag skips after the keys, such as "s3a: " in "HADOOP-20089. S3A: Fix",
// "(3.4) " in "HDFS-17906. (3.4) Fix" or "[table-planner] " in "[FLINK-41350][table-planner] Fix".
// A tag is text in square brackets or parentheses, or one word and a colon and a space. The word
// starts with a letter and holds letters, digits, "-", "_", "." and "/", but no space.
const TAG = /^(?:\[([^\]]+)\]\s*|\(([^)]+)\)\s*|([a-z][a-z0-9_./-]*):\s+)/;
// The Conventional Commits types (www.conventionalcommits.org) other than fix, and "tests" as
// well as "test". As a tag, in any form, such a word says what kind of change the PR is, not
// where, so "T-170: Docs: fix a typo" and "T-170: [docs] fix a typo" are docs changes, and
// title_after_tag does not skip their tag. A fix tag is a fix: see afterTagStartsWith.
const CHANGE_TYPES = new Set(['build', 'chore', 'ci', 'docs', 'feat', 'perf', 'refactor', 'revert', 'style', 'test', 'tests']);

// A Jira issue key, such as PAY-482: letters and digits, a hyphen, and digits.
const ISSUE_KEY = /[a-z][a-z0-9_]*-\d+/;
// A key at the start of a branch name, such as PAY-482-fix-crash or PAY-482/crash.
const BRANCH_KEY = /^([a-z][a-z0-9_]*-\d+)(?![a-z0-9_])/;

// The signal for a revert PR (spec 9.1). It has no value: it is the one word.
export const REVERT_SIGNAL = 'revert';

// Says whether a PR is a fix, and which signal shows it. `pr` holds the PR's number, its title,
// its body, its label names, its branch name and its repo ("owner/name", or absent when unknown). The first signal in the list that matches is
// recorded, so a person can see why the PR counts as a fix. Matching ignores case.
// `ticket` is the tracker's answer for the PR's ticket, as classifyWithTracker gets it: { signal,
// bug, escaped }, or null. A tracker signal, such as tracker:jira, matches only when the ticket
// is a bug, and then fix_signal is the ticket's own signal, such as jira:PAY-482. With a ticket
// that says where the bug was found, the classification gets `escaped` too.
export function classifyFix(pr, signals, ticket = null) {
  const matched = signals.find((signal) => matches(pr, signal, ticket)) ?? null;
  if (matched === null) return { fix: false, fix_signal: null };
  if (signalType(matched) !== 'tracker') return { fix: true, fix_signal: matched };
  return { fix: true, fix_signal: ticket.signal, ...(ticket.escaped === null ? {} : { escaped: ticket.escaped }) };
}

// Classifies `pr` as classifyFix does, and asks `tracker` about the PR's ticket when it must: when
// the signals hold tracker:<name>, no signal before it matches, and the PR names a ticket key.
// `tracker` is a connected tracker module, such as JIRA_TRACKER.connect in src/jira.js, or null
// when the signals hold no tracker signal. A tracker with no token (canAsk false) asks nothing.
// `saved` is the ticket record that the PR's line in the old history file holds, or undefined
// (spec 8.3). It counts only when it names the same issue that the PR names now. With `reuse`
// true, as for a line the run keeps, a saved record answers, and the tracker is not asked. Else
// the tracker is asked, and the saved record answers only when the tracker cannot.
// Returns { classification, problem, ticket, unanswered }. ticket is the record for the PR's line to save:
// the new answer, the saved one, or null when there is none. problem is null, or a text that
// says why the tracker could not answer for one request, such as a 503. Then the saved record
// answers, or else the tracker signal does not match this PR, and the caller warns and goes on.
// No token gives no problem: the history command says so in one note. An error that stops every
// later request, such as a refused token, is thrown. unanswered is null, or { signal, key,
// reason } when the tracker had to answer for the PR's key and could not, with no token or for
// one request, and no saved answer stood in. Then the PR may be a fix that the signals do not
// show, so exhibit check makes it a gap (spec 9.1).
export async function classifyWithTracker(pr, signals, tracker, { saved, reuse = false } = {}) {
  const none = { classification: classifyFix(pr, signals), problem: null, ticket: null, unanswered: null };
  const at = signals.findIndex((signal) => signalType(signal) === 'tracker');
  if (!tracker || at === -1 || signals[at] !== `tracker:${tracker.name}`) return none;
  const key = ticketKey(pr);
  if (key === null) return none;
  const old = saved?.issue === `${tracker.name}:${key}` ? saved : null;
  const oldAnswer = old ? tracker.saved(old) : undefined;
  const fromOld = () => ({ classification: classifyFix(pr, signals, ticketOf(tracker, oldAnswer)), ticket: old, unanswered: null });
  // The signal before tracker:jira matched, so the tracker is not asked, and an old record stays.
  if (signals.slice(0, at).some((signal) => matches(pr, signal, null))) return { ...none, ticket: old };
  if (oldAnswer !== undefined && (reuse || !tracker.canAsk)) return { ...fromOld(), problem: null };
  if (!tracker.canAsk) return { ...none, unanswered: { signal: signals[at], key, reason: `${tracker.tokenEnv} is not set.` } };
  let found;
  try {
    found = await tracker.ticket(key);
  } catch (error) {
    if (error.stopsRun !== false) throw error;
    if (oldAnswer !== undefined) return { ...fromOld(), problem: `the ${signals[at]} signal could not check ${key}, so the PR keeps the answer saved in the history file (${old.issue}). ${error.message}` };
    return { ...none, problem: `the ${signals[at]} signal could not check ${key}, so it does not match. ${error.message}`, unanswered: { signal: signals[at], key, reason: error.message } };
  }
  return { classification: classifyFix(pr, signals, ticketOf(tracker, found)), problem: null, ticket: tracker.record(key, found), unanswered: null };
}

// The tracker's answer as classifyFix takes it, or null when the tracker does not know the issue.
const ticketOf = (tracker, found) => (found === null ? null : { signal: `${tracker.name}:${found.key}`, bug: found.bug, escaped: found.escaped });

// Returns the ticket key that a PR names, in capitals, such as PAY-482, or null. The key comes
// from the start of the title, where title_after_key finds keys, and else from the start of the
// branch name. A key of the form #79 is a GitHub number, not a tracker key, so it is skipped.
export function ticketKey(pr) {
  const leading = LEADING_KEY.exec(pr.title.trim().toLowerCase())?.[0] ?? '';
  const fromTitle = ISSUE_KEY.exec(leading)?.[0];
  if (fromTitle) return fromTitle.toUpperCase();
  const fromBranch = BRANCH_KEY.exec((pr.branch ?? '').toLowerCase())?.[1];
  return fromBranch ? fromBranch.toUpperCase() : null;
}

// The part before the colon, such as tracker in tracker:jira. revert has no colon, so it is ''.
const signalType = (signal) => (signal.includes(':') ? signal.slice(0, signal.indexOf(':')) : '');

function matches(pr, signal, ticket) {
  if (signal === REVERT_SIGNAL) return isRevert(pr);
  const colon = signal.indexOf(':');
  const type = signal.slice(0, colon);
  const value = signal.slice(colon + 1).toLowerCase();
  if (type === 'tracker') return ticket?.bug === true;
  if (type === 'label') return pr.labels.some((label) => label.toLowerCase() === value);
  if (type === 'title') return startsWithWord(pr.title.trim().toLowerCase(), value);
  if (type === 'title_after_key') return startsWithWord(pr.title.trim().toLowerCase().replace(LEADING_KEY, ''), value);
  if (type === 'title_after_tag') return startsWithWord(pr.title.trim().toLowerCase().replace(LEADING_KEY, ''), value) || afterTagStartsWith(pr.title, value);
  if (type === 'branch') return pr.branch.toLowerCase().startsWith(value);
  if (type === 'pr') return String(pr.number) === value;
  return false;
}

// Says whether the title, after its keys and one tag, starts with the word `value`, or the tag
// itself does. So "T-170: [fix] crash" matches fix, as "T-170: fix: crash" does by the key rule.
// A tag counts only after a key, so "S3A: Fix" and "[table] Fix" with no key do not match.
function afterTagStartsWith(title, value) {
  const lower = title.trim().toLowerCase();
  const keys = LEADING_KEY.exec(lower)?.[0] ?? '';
  if (keys === '') return false;
  const rest = lower.slice(keys.length);
  const tag = TAG.exec(rest);
  if (tag === null) return false;
  const text = (tag[1] ?? tag[2] ?? tag[3]).trim();
  if (startsWithWord(text, value)) return true;
  if (CHANGE_TYPES.has(text)) return false;
  return startsWithWord(rest.slice(tag[0].length), value);
}

// A title prefix is a word at the start: "fix" matches "fix: x", "Fix x" and "fix(cli): x",
// but not "Fixture x". When the prefix ends in a letter or digit, the title must not go on
// with another one.
function startsWithWord(title, prefix) {
  if (!title.startsWith(prefix)) return false;
  const next = title.charAt(prefix.length);
  return !(WORD_CHARACTER.test(prefix.at(-1)) && WORD_CHARACTER.test(next));
}

// GitHub's Revert button writes the title 'Revert "<title>"' and the body "Reverts owner/name#N".
// `git revert` writes the same title, and "This reverts commit <sha>." in the body.
const REVERTS_PR = /^[ \t]*reverts[ \t]+([\w.-]+\/[\w.-]+)#(\d+)\b/gim;
const REVERTS_COMMIT = /^[ \t]*this reverts commit ([0-9a-f]{7,40})\b/gim;

// Says whether a PR reverts earlier work: its title starts with 'Revert "', or its body names
// a reverted PR in the PR's own repo, or a reverted commit. A line that names another repo's PR,
// as in copied release notes, does not count. The PR's own repo is `pr.repo`, and the names in
// `pr.oldNames` that lead to it, as withOldNames finds them. When `pr.repo` is unknown, any repo
// counts. A revert of a revert puts the reverted work back (a re-land), so it is no fix. GitHub's
// button and older git write 'Revert "Revert "', and newer git writes 'Reapply "'.
export function isRevert(pr) {
  const title = (pr.title ?? '').trim().toLowerCase();
  if (title.startsWith('revert "revert "') || title.startsWith('reapply "')) return false;
  if (title.startsWith('revert "')) return true;
  const { prs, commits } = revertedWork(pr.body, pr.repo ?? null, pr.oldNames);
  return prs.length + commits.length > 0;
}

// Returns the work that a revert PR's body names: the numbers of the reverted PRs in `repo`
// ("owner/name", any case), and the reverted commits, each once, in the order of the body.
// `oldNames` are other names, in lower case, that lead to `repo`, as after a rename or a
// transfer. A PR named by one of them counts too. With `repo` null, every named PR counts.
export function revertedWork(body, repo, oldNames = []) {
  const prs = [];
  const commits = [];
  const names = repo === null ? null : [repo.toLowerCase(), ...oldNames];
  for (const [, name, number] of (body ?? '').matchAll(REVERTS_PR)) {
    if (names !== null && !names.includes(name.toLowerCase())) continue;
    if (!prs.includes(Number(number))) prs.push(Number(number));
  }
  for (const [, sha] of (body ?? '').matchAll(REVERTS_COMMIT)) {
    if (!commits.includes(sha.toLowerCase())) commits.push(sha.toLowerCase());
  }
  return { prs, commits };
}

// Returns the names in the "Reverts owner/name#N" lines of `body` that are not `forge.repo` but
// lead to it, as the repo's old name does after a rename or a transfer, in lower case. GitHub's
// Revert button writes the name the repo had at the time, so an older revert keeps the old name.
// The forge decides (forge.sameRepo), and asks GitHub once for each name in a run.
export async function oldRepoNames(body, forge) {
  const names = [];
  for (const [, name] of (body ?? '').matchAll(REVERTS_PR)) {
    const key = name.toLowerCase();
    if (key === forge.repo.toLowerCase() || names.includes(key)) continue;
    if (await forge.sameRepo(name)) names.push(key);
  }
  return names;
}

// Returns `pr` with `oldNames` from oldRepoNames, for the revert signal, when the answer may need
// them: `signals` holds revert, the title does not decide, and the body names no PR or commit by
// the current name. Else it returns `pr` as it is, and asks the forge nothing.
export async function withOldNames(pr, signals, forge) {
  const title = (pr.title ?? '').trim().toLowerCase();
  if (!signals.includes(REVERT_SIGNAL) || title.startsWith('revert "') || title.startsWith('reapply "') || isRevert(pr)) return pr;
  return { ...pr, oldNames: await oldRepoNames(pr.body, forge) };
}
