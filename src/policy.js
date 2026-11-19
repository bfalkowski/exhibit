import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_FIX_SIGNALS } from './fix-signals.js';
import { schemaProblems } from './json-schema.js';
import { ToolError } from './tool-error.js';

const POLICY = 'evidence.yml';
const schema = JSON.parse(readFileSync(new URL('../schema/evidence.schema.json', import.meta.url), 'utf8'));
const ITEM_TYPES = ['tests-before-after', 'failing-before', 'mutation', 'probe'];
const SIGNAL_TYPES = ['label', 'title', 'title_after_key', 'branch'];

// Reads the policy, evidence.yml, in `cwd` and checks it against schema/evidence.schema.json
// (spec 8.1). Every command reads the policy with this one function, so they all see it the same
// way. It returns the policy with settings.fix_signals filled in: the defaults when there is no
// file, or when the file does not set them. A file that is not valid YAML, or that breaks a rule
// of the schema, is a ToolError, so the run exits 2. The message names each bad field.
export async function readPolicy(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, POLICY), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return withDefaults({});
    throw new ToolError(`could not read ${POLICY}: ${error.message}`);
  }

  let policy;
  try {
    policy = parse(text);
  } catch (error) {
    throw new ToolError(`${POLICY} is not valid YAML: ${error.message}`);
  }
  // An empty file, or one with only comments, is an empty policy.
  if (policy === null || policy === undefined) policy = {};

  // fix_signals keep the messages they had before the rest of the file was checked.
  const signals = isMapping(policy) && isMapping(policy.settings) ? policy.settings.fix_signals : undefined;
  if (signals !== undefined && signals !== null) checkSignals(signals);

  const problems = schemaProblems(schema, policy);
  if (problems.length > 0) throw new ToolError(problems.map(describe).join('\n'));
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
  if (result.default === null) delete result.default;
  return result;
}

// Turns one schema problem into a sentence that names the field, such as
// "evidence.yml kinds.relay-core.risk must be low, medium or high, not "extreme".".
function describe({ path, what }) {
  return `${POLICY}${path.length === 0 ? '' : ` ${fieldName(path)}`} ${needsItemMessage(path, what) ?? what}.`;
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

function checkSignals(signals) {
  const where = `${POLICY} settings.fix_signals`;
  if (!Array.isArray(signals)) throw new ToolError(`${where} must be a list like [label:bug, title:fix, branch:fix/], not ${JSON.stringify(signals)}.`);
  if (signals.length === 0) throw new ToolError(`${where} needs at least one signal. Leave it out to use the defaults [${DEFAULT_FIX_SIGNALS.join(', ')}].`);
  signals.forEach((signal, i) => {
    const at = `${where}[${i}]`;
    if (typeof signal !== 'string') throw new ToolError(`${at} must be text like label:bug, not ${JSON.stringify(signal)}.`);
    const type = signal.slice(0, signal.indexOf(':'));
    if (!signal.includes(':') || !SIGNAL_TYPES.includes(type)) throw new ToolError(`${at} is "${signal}". A signal must start with label:, title:, title_after_key: or branch:.`);
    const value = signal.slice(type.length + 1);
    if (/[\r\n]/.test(value)) throw new ToolError(`${at} is ${JSON.stringify(signal)}. A signal must be on one line.`);
    if (value.trim() === '') throw new ToolError(`${at} is "${signal}", which needs a value after the colon.`);
    // A space at the start of the value can never match. A space at the end is easy to miss,
    // and only a title could match it: GitHub trims the spaces from a label name when it
    // creates or renames the label, and git refuses a space in a branch name. So refuse
    // both, with a message that shows the fix.
    if (value !== value.trim()) throw new ToolError(`${at} is "${signal}". Remove the space before or after the value, as in ${type}:${value.trim()}.`);
  });
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
