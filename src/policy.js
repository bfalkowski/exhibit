import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_FIX_SIGNALS, REVERT_SIGNAL } from './fix-signals.js';
import { schemaProblems } from './json-schema.js';
import { ToolError } from './tool-error.js';

// The policy's path in the repo when --policy does not give another one.
export const DEFAULT_POLICY = 'evidence.yml';
const schema = JSON.parse(readFileSync(new URL('../schema/evidence.schema.json', import.meta.url), 'utf8'));
const ITEM_TYPES = ['tests-before-after', 'failing-before', 'mutation', 'probe'];
const SIGNAL_TYPES = ['label', 'title', 'title_after_key', 'branch', 'pr', 'tracker'];
// The trackers a tracker: signal can name (spec 9.1).
const TRACKERS = ['jira'];
// A PR number: digits with no leading zero, so pr:96 is the only way to write PR 96.
const PR_NUMBER = /^[1-9]\d*$/;

// Reads the policy, evidence.yml or the repo path `path`, in `cwd` and checks it against schema/evidence.schema.json
// (spec 8.1). Every command reads the policy with this one function, so they all see it the same
// way. It returns the policy with settings.fix_signals filled in: the defaults when there is no
// file, or when the file does not set them. A file that is not valid YAML, or that breaks a rule
// of the schema, is a ToolError, so the run exits 2. The message names each bad field.
export async function readPolicy(cwd, path = DEFAULT_POLICY) {
  let text;
  try {
    text = await readFile(join(cwd, path), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return withDefaults({});
    throw new ToolError(`could not read ${path}: ${error.message}`);
  }
  return parsePolicy(text, path);
}

// Checks the text of a policy file as readPolicy does, and returns the same result. `text` is
// null when there is no file. exhibit check uses it for the policy in the base commit (spec 8.1).
export function parsePolicy(text, path = DEFAULT_POLICY) {
  if (text === null) return withDefaults({});
  let policy;
  try {
    policy = parse(text);
  } catch (error) {
    throw new ToolError(`${path} is not valid YAML: ${error.message}`);
  }
  // An empty file, or one with only comments, is an empty policy.
  if (policy === null || policy === undefined) policy = {};

  // fix_signals keep the messages they had before the rest of the file was checked.
  const signals = isMapping(policy) && isMapping(policy.settings) ? policy.settings.fix_signals : undefined;
  if (signals !== undefined && signals !== null) checkSignals(signals, path);

  const problems = schemaProblems(schema, policy);
  if (problems.length > 0) throw new ToolError(problems.map((problem) => describe(problem, path)).join('\n'));
  checkJira(policy.settings ?? {}, path);
  return withDefaults(policy);
}

// A key with nothing under it, such as "kinds:", is YAML null. It means the same as no key.
function withDefaults(policy) {
  const settings = policy.settings ?? {};
  const result = {
    ...policy,
    settings: { ...settings, fix_signals: settings.fix_signals ?? [...DEFAULT_FIX_SIGNALS] },
    kinds: policy.kinds ?? {}
  };
  if (result.version === null) delete result.version;
  if (result.default === null) delete result.default;
  for (const rules of [...Object.values(result.kinds), result.default ?? { needs: [] }]) {
    rules.needs = rules.needs.map(bareWhenEmpty);
  }
  return result;
}

// "- failing-before:" with nothing after the colon is YAML { failing-before: null }. Give it as
// the bare name, so a reader of needs sees only two shapes: a name, or a name with its fields.
function bareWhenEmpty(item) {
  if (item === null || typeof item !== 'object') return item;
  const [type, fields] = Object.entries(item)[0];
  return fields === null ? type : item;
}

// Turns one schema problem into a sentence that names the field, such as
// "evidence.yml kinds.relay-core.risk must be low, medium or high, not "extreme".".
function describe({ path, what }, file) {
  return `${file}${path.length === 0 ? '' : ` ${fieldName(path)}`} ${needsItemMessage(path, what) ?? what}.`;
}

// ['kinds', 'relay-core', 'needs', 2, 'probe'] → "kinds.relay-core.needs[2].probe".
function fieldName(path) {
  return path.map((part, i) => (typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${part}`)).join('');
}

// The schema can only say that an evidence item does not match. Say which item types there are.
function needsItemMessage(path, what) {
  if (path.at(-2) !== 'needs' || typeof path.at(-1) !== 'number') return null;
  const types = 'The types are tests-before-after, failing-before, mutation and probe';
  const unknownKey = /^has a field the schema does not allow: (.*)$/.exec(what);
  if (unknownKey) return `has the unknown item type ${JSON.stringify(unknownKey[1])}. ${types}`;
  const bareName = /^must be .*, not (".*")$/.exec(what);
  if (!bareName) return null;
  const name = JSON.parse(bareName[1]);
  if (name === 'mutation') return 'is a bare mutation, which needs a min, as in mutation: { min: 0.8 }';
  if (name === 'probe') return 'is a bare probe, which needs a name and a run, as in probe: { name: link-check, run: "npm run check-links" }';
  if (!ITEM_TYPES.includes(name)) return `has the unknown item type ${bareName[1]}. ${types}`;
  return null;
}

function checkSignals(signals, file) {
  const where = `${file} settings.fix_signals`;
  if (!Array.isArray(signals)) throw new ToolError(`${where} must be a list like [label:bug, title:fix, branch:fix/], not ${JSON.stringify(signals)}.`);
  if (signals.length === 0) throw new ToolError(`${where} needs at least one signal. Leave it out to use the defaults [${DEFAULT_FIX_SIGNALS.join(', ')}].`);
  signals.forEach((signal, i) => {
    const at = `${where}[${i}]`;
    if (typeof signal !== 'string') throw new ToolError(`${at} must be text like label:bug, not ${JSON.stringify(signal)}.${spaceHint(signal)}`);
    // The revert signal is one word with no value (spec 9.1).
    if (signal === REVERT_SIGNAL) return;
    const type = signal.slice(0, signal.indexOf(':'));
    if (!signal.includes(':') || !SIGNAL_TYPES.includes(type)) throw new ToolError(`${at} is "${signal}". A signal must start with label:, title:, title_after_key:, branch:, pr: or tracker:, or be the word revert.`);
    const value = signal.slice(type.length + 1);
    if (/[\r\n]/.test(value)) throw new ToolError(`${at} is ${JSON.stringify(signal)}. A signal must be on one line.`);
    if (value.trim() === '') throw new ToolError(`${at} is "${signal}", which needs a value after the colon.`);
    // A space at the start of the value can never match. A space at the end is easy to miss,
    // and only a title could match it: GitHub trims the spaces from a label name when it
    // creates or renames the label, and git refuses a space in a branch name. So refuse
    // both, with a message that shows the fix.
    if (value !== value.trim()) throw new ToolError(`${at} is "${signal}". Remove the space before or after the value, as in ${type}:${value.trim()}.`);
    if (type === 'pr' && !PR_NUMBER.test(value)) throw new ToolError(`${at} is "${signal}". A pr: signal needs a PR number of 1 or more, with no leading zero, as in pr:96.`);
    // A repeated pr: signal does no harm, as the first match wins, but it is most often a typo
    // for another number, so that PR would be missed. So refuse it, and name both places.
    const first = signals.indexOf(signal);
    if (type === 'pr' && first < i) throw new ToolError(`${at} is "${signal}", the same as settings.fix_signals[${first}]. Name each PR once.`);
    if (type === 'tracker' && !TRACKERS.includes(value)) throw new ToolError(`${at} is "${signal}". A tracker: signal names a tracker Exhibit knows: ${TRACKERS.map((name) => `tracker:${name}`).join(', ')}.`);
  });
}

// The tracker:jira signal needs settings.jira.site, and the "where found" field needs the values
// that count as escaped, and the other way round. The schema cannot say these rules.
function checkJira(settings, file) {
  const signals = settings.fix_signals ?? [];
  if (signals.includes('tracker:jira') && !settings.jira) {
    throw new ToolError(`${file} settings.fix_signals has tracker:jira, so settings needs jira: { site: https://your-site.atlassian.net }.`);
  }
  const jira = settings.jira;
  if (!jira) return;
  if (jira.found_field !== undefined && jira.escaped_values === undefined) {
    throw new ToolError(`${file} settings.jira.found_field needs escaped_values: the values that mean a bug got out to users, such as [Production].`);
  }
  if (jira.escaped_values !== undefined && jira.found_field === undefined) {
    throw new ToolError(`${file} settings.jira.escaped_values needs found_field: the Jira field that says where a bug was found, such as customfield_10042.`);
  }
}

// In a YAML list, "pr: 96" with a space after the colon is a mapping, not text. Returns a hint
// that shows the signal with no space, or '' for any other value.
function spaceHint(value) {
  if (!isMapping(value)) return '';
  const entries = Object.entries(value);
  if (entries.length !== 1) return '';
  const [type, rest] = entries[0];
  return SIGNAL_TYPES.includes(type) ? ` Write it with no space after the colon, as in ${type}:${rest}.` : '';
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The value of --policy as a path in the repo, with "/" between folders and no "./" at the start,
// so it can be compared with the changed paths from git. A path outside the repo is refused: the
// exhibit records the policy as a repo path, and a change to it must show as a policy change.
export function policyPath(value) {
  const path = posix.normalize(String(value).replaceAll('\\', '/'));
  if (value === '' || isAbsolute(value) || path === '.' || path === '..' || path.startsWith('../') || path.endsWith('/')) {
    throw new ToolError(`--policy must be the path of a file in the repo, such as evidence.yml or .github/evidence.yml, not "${value}".`);
  }
  return path;
}
