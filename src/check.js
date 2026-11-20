import { readFileSync } from 'node:fs';
import { classifyChange } from './classify.js';
import { runTestsOnBaseAndHead, testsBeforeAfter } from './test-runs.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const STATUSES = ['met', 'missing', 'failed', 'skipped', 'error'];

// The exit code of exhibit check for each verdict (spec 7 and 9.8).
export const EXIT_CODES = Object.freeze({ meets_policy: 0, needs_person: 1, error: 2 });

// A collector gets one requirement and the run's context, and gives back { status, details,
// how_to_fix }, and `flaky_tests` when it ran tests. These are the built-in ones. The other
// evidence collectors come in later tickets. Until each one lands, it says `skipped`, so a
// requirement it cannot check never passes on its own.
const notBuilt = (what) => async () => ({
  status: 'skipped',
  details: { reason: 'not built yet' },
  how_to_fix: `Exhibit cannot collect ${what} yet: this collector is not built yet, and a later S4 ticket builds it. Until then a person must check it.`
});

export const COLLECTORS = Object.freeze({
  'tests-before-after': testsBeforeAfter,
  'failing-before': notBuilt('failing-before (a test that fails on the base and passes on the head)'),
  probe: notBuilt('probes'),
  mutation: async () => ({
    status: 'skipped',
    details: { reason: 'mutation comes in slice S6' },
    how_to_fix: 'Exhibit cannot run mutation tests yet: they come in slice S6. Until then a policy that needs mutation never gives meets_policy, so a person must judge how strong the tests are.'
  })
});

// Builds the exhibit, the content of evidence.json (spec 8.2), for one change.
//
// `change` holds the policy (as readPolicy returns it), `policyFile` ({ path, sha256 }), the
// changed paths `files`, what is known of the PR (`pr`: title, labels, branch), where the fix
// signals came from (`signalsFrom`: `pr` or `branch`), `repo`, `prNumber`, and the `base` and
// `head` SHAs, and `cwd`, the clone, and `env` for the test command.
//
// Each collector gets a context: `cwd`, `env`, `base`, `head`, the policy's `settings`, and
// `testRuns()`, which runs the tests on the base and the head the first time it is called and
// gives back the same per-test results after that. So a later collector, such as failing-before,
// uses the same results and does not run the tests again. `runTests` makes those results.
//
// Each requirement goes to the collector for its type. A collector that throws, or gives back no
// valid status, makes that requirement `error`, and the verdict `error`. The verdict is
// `meets_policy` only when every requirement is `met` and nothing else needs a person: a change
// to evidence.yml always needs a person (spec 15), and so does a change that no rule covers.
//
// `clock` gives milliseconds for duration_ms, and `now` the time for created_at. These and
// `environment` are the only parts of the result that can differ between two runs on the same
// commits.
export async function buildExhibit(change, { collectors = COLLECTORS, runTests = runTestsOnBaseAndHead, clock = () => performance.now(), now = () => new Date(), environment = currentEnvironment() } = {}) {
  const files = [...new Set(change.files)].sort();
  const { classification, requirements } = classifyChange(change.policy, files, change.pr);
  const { has_default: hasDefault, ...shown } = classification;

  let testRuns;
  const context = {
    cwd: change.cwd,
    env: change.env ?? process.env,
    base: change.base,
    head: change.head,
    settings: change.policy?.settings ?? {},
    testRuns: () => (testRuns ??= runTests({ cwd: change.cwd, base: change.base, head: change.head, settings: change.policy?.settings ?? {}, env: change.env ?? process.env }))
  };

  const collected = [];
  const gaps = [];
  const flaky = new Set();
  for (const requirement of requirements) {
    const started = clock();
    const result = await collect(collectors, requirement, context);
    for (const name of result.flaky_tests) flaky.add(name);
    const item = {
      type: requirement.type,
      params: requirement.params,
      kinds: requirement.kinds,
      status: result.status,
      details: result.details,
      author: requirement.author,
      duration_ms: Math.max(0, Math.round(clock() - started))
    };
    collected.push(item);
    if (item.status !== 'met') {
      gaps.push({
        type: item.type,
        ...(item.type === 'probe' ? { name: item.params.name } : {}),
        status: item.status,
        how_to_fix: result.how_to_fix ?? defaultHowToFix(item)
      });
    }
  }

  if (classification.policy_changed) {
    gaps.push({
      type: 'policy-change',
      status: 'missing',
      how_to_fix: 'This change edits evidence.yml, the policy that Exhibit checks changes against. A change to the policy always needs a person, so that a builder cannot change the rules to pass its own PR. Ask a maintainer to review the policy change.'
    });
  }
  if (classification.used_default && !hasDefault) {
    gaps.push({
      type: 'no-rule',
      status: 'missing',
      how_to_fix: 'No kind in evidence.yml matches the changed files, and evidence.yml has no default, so the policy says nothing about this change. Add a default, or a kind that matches these files, or ask a person to review it.'
    });
  }

  const statuses = collected.map((item) => item.status);
  const verdict = statuses.includes('error') ? 'error' : gaps.length === 0 ? 'meets_policy' : 'needs_person';

  return {
    exhibit_version: pkg.version,
    policy: change.policyFile,
    repo: change.repo,
    pr: change.prNumber,
    base: change.base,
    head: change.head,
    classification: { ...shown, signals_from: change.signalsFrom },
    requirements: collected,
    verdict,
    gaps,
    checks_by_author: {
      builder: collected.filter((item) => item.author === 'builder').length,
      hidden: collected.filter((item) => item.author === 'hidden').length
    },
    flaky_tests: [...flaky].sort(),
    environment,
    created_at: now().toISOString()
  };
}

// Runs one collector. Any throw, or a reply with no valid status, is an `error`: Exhibit failed,
// so the requirement must not count as met.
async function collect(collectors, requirement, context) {
  const collector = collectors[requirement.type];
  try {
    if (typeof collector !== 'function') throw new Error(`no collector for ${requirement.type}`);
    const result = await collector(requirement, context);
    if (!result || !STATUSES.includes(result.status)) throw new Error(`the ${requirement.type} collector gave back no valid status (${JSON.stringify(result?.status)})`);
    return { status: result.status, details: result.details ?? {}, how_to_fix: result.how_to_fix, flaky_tests: result.flaky_tests ?? [] };
  } catch (error) {
    return {
      status: 'error',
      details: { message: error.message },
      flaky_tests: [],
      how_to_fix: `Exhibit failed while it collected this evidence: ${error.message}. Fix the cause and run exhibit check again. If the cause is in Exhibit, report it as an Exhibit issue.`
    };
  }
}

function defaultHowToFix(item) {
  const what = item.type === 'probe' ? `the probe ${item.params.name}` : item.type;
  if (item.status === 'failed') return `The evidence for ${what} failed. Fix the change so that it passes, and run exhibit check again.`;
  if (item.status === 'error') return `Exhibit failed while it collected ${what}. Run exhibit check again.`;
  return `The evidence for ${what} is ${item.status}. Add it, and run exhibit check again.`;
}

// The Node major version and the OS. Only the major version, so two runs on the same machine
// give the same text.
function currentEnvironment() {
  return { node: `${process.versions.node.split('.')[0]}.x`, os: process.platform };
}

const VERDICT_WORDS = {
  meets_policy: 'meets the policy',
  needs_person: 'needs a person',
  error: 'Exhibit failed'
};

// The summary.md for an exhibit: the verdict, the change, each requirement, and each gap with how
// to fix it, in plain words. It holds no time, so two runs on the same commits give the same file.
export function renderSummary(exhibit) {
  const c = exhibit.classification;
  const lines = [];
  lines.push(`# Exhibit check: ${VERDICT_WORDS[exhibit.verdict]}`, '');
  lines.push(`Verdict: **${exhibit.verdict}** (exit code ${EXIT_CODES[exhibit.verdict]}).`, '');
  const pr = exhibit.pr === null ? '' : ` PR ${exhibit.pr}${exhibit.repo ? ` in ${exhibit.repo}` : ''}.`;
  lines.push(`Base ${exhibit.base.slice(0, 7)}, head ${exhibit.head.slice(0, 7)}.${pr}`, '');

  lines.push('## The change', '');
  if (c.kinds.length > 0) lines.push(`- Kinds of change: ${c.kinds.join(', ')}.`);
  else if (exhibit.gaps.some((gap) => gap.type === 'no-rule')) lines.push('- No kind of change matched the changed files, and the policy has no default, so no rule covers this change.');
  else lines.push('- No kind of change matched the changed files, so the default rules apply.');
  lines.push(`- Risk: ${c.risk}.`);
  lines.push(`- Fix: ${c.fix ? `yes, from the signal ${c.fix_signal}` : 'no'}. Feature: ${c.feature ? 'yes' : 'no'}.`);
  if (c.signals_from === 'branch') {
    lines.push('- Exhibit knew only the branch name, not the PR\'s title or labels, so a fix or feature that only they show was not seen. Run exhibit check with --pr N to read them from the forge.');
  }
  lines.push(`- Merge without reading: ${c.merge_without_reading}.`, '');

  lines.push('## Requirements', '');
  if (exhibit.requirements.length === 0) lines.push('The policy asks for no evidence for this change.');
  for (const item of exhibit.requirements) {
    const name = item.type === 'probe' ? ` ${item.params.name}` : '';
    const hidden = item.author === 'hidden' ? ', hidden check' : '';
    lines.push(`- ${item.type}${name} (from ${item.kinds.join(', ')}${hidden}): ${item.status}.`);
  }
  lines.push('');

  lines.push('## Gaps', '');
  if (exhibit.gaps.length === 0) lines.push('None. Every requirement is met.');
  exhibit.gaps.forEach((gap, i) => {
    const name = gap.name ? ` ${gap.name}` : '';
    lines.push(`${i + 1}. ${gap.type}${name}: ${gap.status}. ${gap.how_to_fix}`);
  });
  if (exhibit.gaps.some((gap) => gap.status === 'skipped')) {
    lines.push('', 'A skipped requirement counts as not met: the verdict is meets_policy only when every requirement is met.');
  }
  return lines.join('\n') + '\n';
}
