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

// Says whether a PR is a fix, and which signal shows it. `pr` holds the PR's number, its title,
// its label names and its branch name. The first signal in the list that matches is recorded, so a person
// can see why the PR counts as a fix. Matching ignores case.
export function classifyFix(pr, signals) {
  const fixSignal = signals.find((signal) => matches(pr, signal)) ?? null;
  return { fix: fixSignal !== null, fix_signal: fixSignal };
}

function matches(pr, signal) {
  const colon = signal.indexOf(':');
  const type = signal.slice(0, colon);
  const value = signal.slice(colon + 1).toLowerCase();
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
