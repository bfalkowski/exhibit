import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ToolError } from './tool-error.js';

// The signals spec 8.1 and 9.1 use when evidence.yml does not set settings.fix_signals.
export const DEFAULT_FIX_SIGNALS = Object.freeze(['label:bug', 'title:fix', 'branch:fix/']);

const POLICY = 'evidence.yml';
const TYPES = ['label', 'title', 'branch'];
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

// Says whether a PR is a fix, and which signal shows it. `pr` holds the PR's title, its label
// names and its branch name. The first signal in the list that matches is recorded, so a person
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
  if (type === 'branch') return pr.branch.toLowerCase().startsWith(value);
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

// Returns the fix signals for the repo in `cwd`: settings.fix_signals from its evidence.yml, or
// the defaults when there is no file or the file does not set them. It reads only that setting.
// A malformed list is a ToolError, so the run exits 2.
export async function readFixSignals(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, POLICY), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [...DEFAULT_FIX_SIGNALS];
    throw new ToolError(`could not read ${POLICY}: ${error.message}`);
  }

  let policy;
  try {
    policy = parse(text);
  } catch (error) {
    throw new ToolError(`${POLICY} is not valid YAML: ${error.message}`);
  }

  const signals = isMapping(policy) && isMapping(policy.settings) ? policy.settings.fix_signals : undefined;
  if (signals === undefined || signals === null) return [...DEFAULT_FIX_SIGNALS];
  checkSignals(signals);
  return signals;
}

function checkSignals(signals) {
  const where = `${POLICY} settings.fix_signals`;
  if (!Array.isArray(signals)) throw new ToolError(`${where} must be a list like [label:bug, title:fix, branch:fix/], not ${JSON.stringify(signals)}.`);
  if (signals.length === 0) throw new ToolError(`${where} needs at least one signal. Leave it out to use the defaults [${DEFAULT_FIX_SIGNALS.join(', ')}].`);
  signals.forEach((signal, i) => {
    const at = `${where}[${i}]`;
    if (typeof signal !== 'string') throw new ToolError(`${at} must be text like label:bug, not ${JSON.stringify(signal)}.`);
    const type = signal.slice(0, signal.indexOf(':'));
    if (!signal.includes(':') || !TYPES.includes(type)) throw new ToolError(`${at} is "${signal}". A signal must start with label:, title: or branch:.`);
    const value = signal.slice(type.length + 1);
    if (value.trim() === '') throw new ToolError(`${at} is "${signal}", which needs a value after the colon.`);
    // A space at the start of the value can never match. A space at the end is easy to miss,
    // and only a title could match it. So refuse both, with a message that shows the fix.
    if (value !== value.trim()) throw new ToolError(`${at} is "${signal}". Remove the space before or after the value, as in ${type}:${value.trim()}.`);
  });
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
