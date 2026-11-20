import { classifyFix } from './fix-signals.js';

const RISKS = ['low', 'medium', 'high'];

// Works out what a change needs (spec 8.1 rules and 9.1). `policy` is what readPolicy returns.
// `files` holds the paths the change touches. `pr` holds what is known about the PR: its title,
// its label names and its branch name. Without the forge, only the branch is known, and the title
// and labels are empty.
//
// It returns { classification, requirements }:
// - classification.kinds: the kinds whose globs match a changed path, sorted by name.
// - classification.risk: the highest risk among them, or default's risk when none matches.
// - classification.fix, fix_signal: from the fix signals. classification.feature: a `feature` label.
// - classification.merge_without_reading: `allowed` only when every matched kind says `allowed`.
// - classification.used_default: no kind matched, so default's rules apply. has_default says
//   whether the policy has a default at all. Without one, the risk is high and nothing is needed,
//   and the verdict code must not let that pass on its own.
// - classification.policy_changed: the change touches the policy file, `policyPath` in the repo,
//   which is evidence.yml at the top of the repo unless --policy names another file.
// - requirements: the union of the needs, in order: the kinds by name, then each kind's own order.
//   A need that two kinds share is one requirement, and `kinds` names both. A failing-before
//   whose `when` does not fit this change stays in the list with `not_needed`, the reason in
//   words, so the exhibit can show it as skipped (spec 8.1).
export function classifyChange(policy, files, pr, policyPath = 'evidence.yml') {
  const { fix, fix_signal: fixSignal } = classifyFix(pr, policy.settings.fix_signals);
  const feature = pr.labels.some((label) => label.toLowerCase() === 'feature');

  const matched = matchKinds(policy.kinds, files);
  const usedDefault = matched.length === 0;
  const rules = usedDefault ? (policy.default ? [['default', policy.default]] : []) : matched.map((name) => [name, policy.kinds[name]]);

  const risk = rules.length === 0 ? 'high' : rules.map(([, rule]) => rule.risk).reduce((a, b) => (RISKS.indexOf(b) > RISKS.indexOf(a) ? b : a));
  const allowed = rules.length > 0 && rules.every(([, rule]) => rule.merge_without_reading === 'allowed');

  const requirements = [];
  const byKey = new Map();
  for (const [name, rule] of rules) {
    for (const need of rule.needs) {
      const requirement = toRequirement(need);
      const reason = notNeeded(requirement, { fix, feature });
      if (reason) requirement.not_needed = reason;
      const key = JSON.stringify([requirement.type, sortKeys(requirement.params)]);
      const same = byKey.get(key);
      if (same) {
        if (!same.kinds.includes(name)) same.kinds.push(name);
        continue;
      }
      const item = { ...requirement, kinds: [name] };
      byKey.set(key, item);
      requirements.push(item);
    }
  }

  return {
    classification: {
      kinds: matched,
      risk,
      fix,
      fix_signal: fixSignal,
      feature,
      merge_without_reading: allowed ? 'allowed' : 'never',
      used_default: usedDefault,
      has_default: policy.default !== undefined,
      policy_changed: files.includes(policyPath)
    },
    requirements
  };
}

// Returns the names of the kinds in `kinds` (the policy's kinds) that a path in `paths` matches,
// sorted by name. An empty list means no kind matched, so default's rules apply. `exhibit check`
// and `exhibit history` both use it, so a PR gets the same kinds from each (spec 8.3).
export function matchKinds(kinds, paths) {
  return Object.keys(kinds).sort().filter((name) => paths.some((path) => kinds[name].match.some((glob) => matchesGlob(path, glob))));
}

// A need is a bare name, or { type: fields }. A probe with `author: hidden` is a check that the
// builder cannot see (spec 9.7). Every other check is the builder's.
function toRequirement(need) {
  if (typeof need === 'string') return { type: need, params: {}, author: 'builder' };
  const [type, fields] = Object.entries(need)[0];
  const params = { ...fields };
  const author = params.author === 'hidden' ? 'hidden' : 'builder';
  delete params.author;
  return { type, params, author };
}

// failing-before with `when` is needed only for a change of a kind it names (spec 8.1). For any
// other change this gives the reason in words. Otherwise it gives null.
function notNeeded(requirement, { fix, feature }) {
  if (requirement.type !== 'failing-before' || requirement.params.when === undefined) return null;
  const when = requirement.params.when;
  if ((fix && when.includes('fix')) || (feature && when.includes('feature'))) return null;
  const named = when.length === 0 ? 'no kind of change' : when.map((word) => `a ${word}`).join(' or ');
  return `The policy asks for it only on ${named}, and this change is not classified as one, so it is not needed. This does not stop meets_policy.`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

// Says whether the path `path` matches the glob `glob`. `*` matches any characters in one folder
// name, `**` as a whole folder name matches any number of folders, none too, and `?` matches one
// character that is not a slash. Every other character matches only itself.
export function matchesGlob(path, glob) {
  return globToRegExp(glob).test(path);
}

const cache = new Map();
function globToRegExp(glob) {
  let found = cache.get(glob);
  if (found) return found;
  let source = '';
  const parts = glob.split('/');
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === '**') {
      // "a/**" matches what is under a. "**/b" and "a/**/b" match b at any depth.
      source += last ? '.+' : '(?:[^/]+/)*';
      return;
    }
    source += part.split('').map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&'))).join('');
    if (!last) source += '/';
  });
  found = new RegExp(`^${source}$`, 'u');
  cache.set(glob, found);
  return found;
}
