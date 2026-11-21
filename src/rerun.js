// `exhibit backtest --rerun` (spec 9.9): runs the cheap requirements again on each PR's own base
// and head, with the same collectors as exhibit check, so the backtest has real results in place
// of unknown ones. Mutation runs only in a second pass, while the time budget still holds a whole
// mutation run.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { judge, requirementName } from './backtest.js';
import { buildExhibit } from './check.js';
import { DEFAULT_MUTATION_BUDGET_SECONDS, MUTATION_DIR } from './mutation.js';
import { DEFAULT_POLICY } from './policy.js';
import { TESTS_DIR } from './test-runs.js';

const run = promisify(execFile);

// The requirement types that a rerun runs in its first pass. Each one runs the test command or a
// probe command, under its own time limit. Mutation runs Stryker for up to
// settings.mutation_budget_seconds on each PR, so it waits for the second pass.
export const CHEAP = Object.freeze(['tests-before-after', 'failing-before', 'probe']);

// Where a rerun keeps the logs of each PR: .exhibit/rerun/<number>/tests, probes and mutation.
export const RERUN_DIR = '.exhibit/rerun';
const PROBES_DIR = '.exhibit/probes';
const LOG_DIRS = [TESTS_DIR, PROBES_DIR, MUTATION_DIR];

/**
 * Runs the requirements again for each PR in `lines`, in that order. Returns a Map from PR number to
 * { status, seconds, requirements, errors, mutation }:
 * - status: `ran`; `error` when a collector failed for this PR; `not_reached` when the time budget
 *   ran out first; `no_commits` when the base or the head is not in the clone; `nothing_to_run`
 *   when the PR's exhibit already gives every requirement, or the policy asks for nothing.
 * - requirements: [{ type, params, status, details }] as exhibit check gives them.
 * - errors: one message for each requirement whose status is error.
 * - mutation: `ran`, `not_reached` (the budget could not hold one more mutation run) or null when
 *   the PR needs no mutation, or its commits are not in the clone.
 *
 * `policies` is the policy, and the policy without the rules that leak when there is one, so the
 * PR gets every requirement that either one asks for. Each requirement runs once.
 * `exhibits` is the Map of stored exhibits: a requirement that a PR's exhibit already gives is not
 * run again. `budgetSeconds` is the time budget of the whole rerun. A PR that has started finishes.
 * `collectors` is what exhibit check uses, with the probe collector, for the PR's head:
 * `collectorsFor(head)` gives { collectors, done }, and done() is awaited after the PR.
 * `onPr(number, result)` is called after each run on a PR, for progress lines. `clock` gives
 * milliseconds, and `hasCommit(cwd, sha)` says whether the clone has a commit.
 */
export async function rerun({ cwd, env, lines, policies, exhibits = new Map(), budgetSeconds, collectorsFor, clock = () => performance.now(), hasCommit = commitInClone, onPr = () => {} }) {
  const started = clock();
  const elapsed = () => (clock() - started) / 1000;
  const mutationSeconds = policies[0].settings?.mutation_budget_seconds ?? DEFAULT_MUTATION_BUDGET_SECONDS;
  await rm(join(cwd, RERUN_DIR), { recursive: true, force: true });
  await Promise.all(LOG_DIRS.map((dir) => rm(join(cwd, dir), { recursive: true, force: true })));

  const results = new Map();
  const caches = new Map();
  for (const line of lines) {
    const wanted = wantedRequirements(line, policies, exhibits.get(line.number) ?? null);
    const result = { status: 'nothing_to_run', seconds: 0, requirements: [], errors: [], mutation: wanted.some((item) => item.type === 'mutation') ? 'not_reached' : null };
    results.set(line.number, result);
    if (!wanted.some((item) => CHEAP.includes(item.type)) && result.mutation === null) continue;
    if (!(await hasCommit(cwd, line.base_sha)) || !(await hasCommit(cwd, line.head_sha))) {
      result.status = 'no_commits';
      result.mutation = null;
      continue;
    }
    if (!wanted.some((item) => CHEAP.includes(item.type))) continue;
    if (elapsed() >= budgetSeconds) {
      result.status = 'not_reached';
      continue;
    }
    const cache = new Map();
    caches.set(line.number, cache);
    const at = clock();
    await collectFor({ cwd, env, line, policies, wanted, cache, collectorsFor, pass: 'cheap' });
    result.seconds = (clock() - at) / 1000;
    fill(result, cache);
    onPr(line.number, result);
  }

  // The second pass: mutation, one PR at a time, while a whole mutation run still fits.
  for (const line of lines) {
    const result = results.get(line.number);
    if (result.mutation !== 'not_reached') continue;
    if (budgetSeconds - elapsed() < mutationSeconds) continue;
    const wanted = wantedRequirements(line, policies, exhibits.get(line.number) ?? null);
    const cache = caches.get(line.number) ?? new Map();
    const at = clock();
    await collectFor({ cwd, env, line, policies, wanted, cache, collectorsFor, pass: 'mutation' });
    result.seconds += (clock() - at) / 1000;
    result.mutation = 'ran';
    fill(result, cache);
    onPr(line.number, result);
  }
  // A PR that needs only mutation, and that the budget could not hold, was not reached.
  for (const result of results.values()) if (result.status === 'nothing_to_run' && result.mutation === 'not_reached') result.status = 'not_reached';
  return results;
}

// The requirements that `policies` ask of the PR and that its exhibit does not give, each once.
function wantedRequirements(line, policies, exhibit) {
  const wanted = new Map();
  for (const rules of policies) {
    for (const requirement of judge(line, rules, exhibit).requirements) {
      if (requirement.from !== 'exhibit') wanted.set(keyOf(requirement), requirement);
    }
  }
  return [...wanted.values()];
}

// The test-set PRs that a rerun with `policy` would mark `no_commits`: PRs that want a requirement
// to run, but whose base or head is not in the clone. The command finds them before the rerun, so
// the leaks that pick the rerun's policies are the same leaks that the report uses after it (spec
// 9.9). A rerun with more policies marks these PRs too, and maybe more.
export async function prsWithoutCommits({ cwd, lines, policy, exhibits = new Map(), hasCommit = commitInClone }) {
  const missing = new Set();
  for (const line of lines) {
    const wanted = wantedRequirements(line, [policy], exhibits.get(line.number) ?? null);
    if (!wanted.some((item) => CHEAP.includes(item.type) || item.type === 'mutation')) continue;
    if (!(await hasCommit(cwd, line.base_sha)) || !(await hasCommit(cwd, line.head_sha))) missing.add(line.number);
  }
  return missing;
}

// Runs exhibit check's buildExhibit for the PR with each policy. A requirement that is not wanted
// in this pass, or that ran already, is not run: it gets the cached result, or `skipped`. So each
// requirement runs once, and the tests run once for all the requirements that share them.
async function collectFor({ cwd, env, line, policies, wanted, cache, collectorsFor, pass }) {
  const wantedKeys = new Set(wanted.filter((item) => (pass === 'cheap' ? CHEAP.includes(item.type) : item.type === 'mutation')).map(keyOf));
  const { collectors, done } = collectorsFor(line.head_sha);
  const wrapped = Object.fromEntries([...CHEAP, 'mutation'].map((type) => [type, async (requirement, context) => {
    const key = keyOf(requirement);
    if (cache.has(key)) return cache.get(key);
    if (!wantedKeys.has(key)) return { status: 'skipped', details: { reason: 'not run in this pass' } };
    if (typeof collectors[type] !== 'function') throw new Error(`no collector for ${type}`);
    return collectors[type](requirement, context);
  }]));
  try {
    for (const rules of policies) {
      const exhibit = await buildExhibit({
        cwd,
        env,
        policy: rules,
        policyFile: { path: DEFAULT_POLICY, sha256: null },
        files: line.files.map((file) => file.path),
        added: [],
        pr: { number: line.number, title: line.title, body: line.body, labels: line.labels, branch: '' },
        fixed: { fix: line.classification.fix, fix_signal: line.classification.fix_signal },
        signalsFrom: 'pr',
        repo: null,
        prNumber: line.number,
        base: line.base_sha,
        head: line.head_sha,
        skip: null
      }, { collectors: wrapped });
      for (const item of exhibit.requirements) {
        const key = keyOf(item);
        if (wantedKeys.has(key) && !cache.has(key)) cache.set(key, { status: item.status, details: item.details });
      }
    }
  } finally {
    await done();
    await keepLogs(cwd, line.number);
  }
}

function fill(result, cache) {
  result.requirements = [...cache.entries()].map(([key, value]) => ({ ...JSON.parse(key), status: value.status, details: value.details }));
  result.errors = result.requirements.filter((item) => item.status === 'error').map((item) => `${requirementName(item)}: ${item.details?.message ?? item.details?.reason ?? 'error'}`);
  result.status = result.errors.length > 0 ? 'error' : 'ran';
}

// Moves the logs that exhibit check's collectors wrote into .exhibit/rerun/<number>, so the next PR
// does not write over them. Only a folder that this pass wrote moves, so the mutation pass keeps
// the test and probe logs of the first pass.
async function keepLogs(cwd, number) {
  const target = join(cwd, RERUN_DIR, String(number));
  for (const dir of LOG_DIRS) {
    const from = join(cwd, dir);
    if (!existsSync(from)) continue;
    const to = join(target, dir.split('/').pop());
    await mkdir(target, { recursive: true });
    await rm(to, { recursive: true, force: true });
    await rename(from, to);
  }
}

// The type and params of a requirement, with the keys in order, as one text.
function keyOf(requirement) {
  return JSON.stringify({ type: requirement.type, params: sortKeys(requirement.params ?? {}) });
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

async function commitInClone(cwd, sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return false;
  try {
    await run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}
