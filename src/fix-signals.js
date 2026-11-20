// The signals spec 8.1 and 9.1 use when evidence.yml does not set settings.fix_signals.
export const DEFAULT_FIX_SIGNALS = Object.freeze(['label:bug', 'title:fix', 'branch:fix/']);

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
// One or more ticket keys at the start of a title, such as "T-170: ", "KEY-123 ", "[KEY-123] ",
// "(KEY-123): ", "T-170 - ", "T-170, T-171: " or "#79: ". A key is letters and digits, a hyphen
// and digits, or "#" and digits. After a key in brackets, a colon, a comma or a dash may follow.
// A bare key needs a colon, a comma or a space after it, so "T-170Fix" keeps its key, and a dash
// after a bare key needs a space before it, so "T-170-Fix" keeps its key too. Titles are
// lowercase by the time they get here.
const KEY = '(?:[a-z][a-z0-9_]*-\\d+|#\\d+)';
const BRACKETED = `(?:\\[${KEY}\\]|\\(${KEY}\\))\\s*(?:[:,-]\\s*)?`;
const BARE = `${KEY}(?:\\s*[:,]\\s*|\\s+-\\s*|\\s+)`;
const LEADING_KEY = new RegExp(`^(?:${BRACKETED}|${BARE})+`);

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
// when there is no token, so the tracker signal matches nothing.
// Returns { classification, problem }. problem is null, or a text that says why the tracker could
// not answer for one request, such as a 503. Then the tracker signal does not match this PR, and
// the caller warns and goes on. An error that stops every later request, such as a refused
// token, is thrown.
export async function classifyWithTracker(pr, signals, tracker) {
  const at = signals.findIndex((signal) => signalType(signal) === 'tracker');
  const before = at === -1 ? signals : signals.slice(0, at);
  if (!tracker || at === -1 || signals[at] !== `tracker:${tracker.name}` || before.some((signal) => matches(pr, signal, null))) {
    return { classification: classifyFix(pr, signals), problem: null };
  }
  const key = ticketKey(pr);
  if (key === null) return { classification: classifyFix(pr, signals), problem: null };
  let found;
  try {
    found = await tracker.ticket(key);
  } catch (error) {
    if (error.stopsRun !== false) throw error;
    return { classification: classifyFix(pr, signals), problem: `the ${signals[at]} signal could not check ${key}, so it does not match. ${error.message}` };
  }
  const ticket = found === null ? null : { signal: `${tracker.name}:${found.key}`, bug: found.bug, escaped: found.escaped };
  return { classification: classifyFix(pr, signals, ticket), problem: null };
}

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
  if (type === 'branch') return pr.branch.toLowerCase().startsWith(value);
  if (type === 'pr') return String(pr.number) === value;
  return false;
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
// as in copied release notes, does not count. When `pr.repo` is unknown, any repo counts. A
// revert of a revert puts the reverted work back (a re-land), so it is no fix. GitHub's button
// and older git write 'Revert "Revert "', and newer git writes 'Reapply "'.
export function isRevert(pr) {
  const title = (pr.title ?? '').trim().toLowerCase();
  if (title.startsWith('revert "revert "') || title.startsWith('reapply "')) return false;
  if (title.startsWith('revert "')) return true;
  const { prs, commits } = revertedWork(pr.body, pr.repo ?? null);
  return prs.length + commits.length > 0;
}

// Returns the work that a revert PR's body names: the numbers of the reverted PRs in `repo`
// ("owner/name", any case), and the reverted commits, each once, in the order of the body.
// With `repo` null, every named PR counts.
export function revertedWork(body, repo) {
  const prs = [];
  const commits = [];
  for (const [, name, number] of (body ?? '').matchAll(REVERTS_PR)) {
    if (repo !== null && name.toLowerCase() !== repo.toLowerCase()) continue;
    if (!prs.includes(Number(number))) prs.push(Number(number));
  }
  for (const [, sha] of (body ?? '').matchAll(REVERTS_COMMIT)) {
    if (!commits.includes(sha.toLowerCase())) commits.push(sha.toLowerCase());
  }
  return { prs, commits };
}
