import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { backtest, requirementName, testSetOf, withoutRules } from '../backtest.js';
import { buildBacktestReport, funnelLines, shareText } from '../backtest-report.js';
import { COLLECTORS } from '../check.js';
import { checkExhibit } from '../exhibit-schema.js';
import { checkHistoryLine } from '../history-schema.js';
import { checkLabelLine, HISTORY, LABELS, parseLines } from '../labels.js';
import { readPolicy } from '../policy.js';
import { DEFAULT_PROBE_TIMEOUT_SECONDS } from '../probe.js';
import { BACKTEST_REPORT } from '../report.js';
import { prsWithoutCommits, RERUN_DIR, rerun } from '../rerun.js';
import { readStoredExhibits } from '../storage.js';
import { ToolError } from '../tool-error.js';
import { worktreeOnDemand } from '../worktree.js';
import { writeTogether } from '../write-together.js';
import { onStopSignal, probeCollector } from './check.js';
import { parseSince } from './history.js';

const USAGE = 'Usage: exhibit backtest [--from YYYY-MM-DD] [--rerun [--budget MINUTES]] [--json]';
// The time budget of a rerun when --budget is not given.
export const DEFAULT_RERUN_BUDGET_MINUTES = 60;

// `exhibit backtest [--from DATE] [--json]` (spec 7 and 9.9). It reads .exhibit/history.jsonl,
// .exhibit/labels.jsonl when it is there, evidence.yml, and the stored exhibits of the PRs. It
// works out what the policy would have said about each PR merged at or after --from, and writes
// the report to .exhibit/backtest.md and .exhibit/backtest.html, together (spec 8.5). It never
// writes the history report. It asks no forge. It runs no PR's code, except with --rerun.
//
// With --rerun, it first runs the cheap requirements again on each test-set PR's base_sha and
// head_sha, with the collectors of exhibit check (src/rerun.js), within the time budget --budget
// (in minutes). Each PR's logs go to .exhibit/rerun/<number>. It prints a line on stderr for each
// PR it ran. The report then gives the counts before and after the rerun.
export async function backtestCommand(argv, { cwd, env = process.env, stdout, stderr, clock = () => performance.now() }) {
  const options = parseOptions(argv);
  const policy = await readPolicy(cwd);
  const lines = await readHistory(cwd);
  const labels = await readLabels(cwd);
  const heads = new Map(lines.map((line) => [line.number, line.head_sha]));
  const stored = await readStoredExhibits(cwd, policy.settings, heads, { check: checkExhibit });
  for (const path of stored.bad) stderr.write(`exhibit: warning: ${path} is not a valid exhibit, so the backtest reads that PR's body instead.\n`);

  const before = backtest({ lines, labels, policy, exhibits: stored.exhibits, from: options.from });
  let result = before;
  let rerunInfo = null;
  if (options.rerun) {
    const testSet = testSetOf(lines, options.from);
    // A defect on a PR that cannot run again makes no leak (spec 9.9). Find those PRs first, so the
    // rerun runs the policy without the same leaking rules that the report uses after it.
    const leakNoCommits = await prsWithoutCommits({ cwd, lines: testSet, policy, exhibits: stored.exhibits });
    const { leaks } = backtest({ lines, labels, policy, exhibits: stored.exhibits, from: options.from, leakNoCommits });
    const policies = leaks.length === 0 ? [policy] : [policy, withoutRules(policy, leaks.map((leak) => leak.rule))];
    const started = clock();
    const reruns = await rerunWithStop({ cwd, env, lines: testSet, policies, exhibits: stored.exhibits, budgetSeconds: options.budgetMinutes * 60, clock, stderr });
    rerunInfo = { budget_minutes: options.budgetMinutes, seconds: Math.round((clock() - started) / 1000), logs: RERUN_DIR };
    result = { ...backtest({ lines, labels, policy, exhibits: stored.exhibits, from: options.from, reruns, leakNoCommits }), counts_before_rerun: before.counts, rerun: rerunInfo };
  }
  const repo = repoOf(lines);
  const report = buildBacktestReport(result, { repo, fromText: options.fromText });
  await writeTogether(cwd, [[BACKTEST_REPORT.markdown, report.markdown], [BACKTEST_REPORT.html, report.html]]);

  const evidenceFrom = Object.fromEntries(['exhibit', ...(options.rerun ? ['rerun'] : []), 'body', 'none'].map((basis) => [basis, result.prs.filter((pr) => pr.basis === basis).length]));
  const rerunCounts = options.rerun ? rerunStatusCounts(result.prs) : null;
  if (options.json) {
    // The PR list is long, so --json gives where its evidence came from, and the report the rest.
    const rest = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'prs'));
    const reruns = options.rerun ? { ...rerunCounts, prs: result.prs.filter((pr) => pr.rerun.status !== 'nothing_to_run').map((pr) => ({ number: pr.number, ...pr.rerun })) } : null;
    stdout.write(JSON.stringify({ ...rest, ...(options.rerun ? { rerun: { ...rerunInfo, ...reruns } } : {}), evidence_from: evidenceFrom, labels: labels.length > 0 ? 'read' : 'none', report: BACKTEST_REPORT }) + '\n');
    return;
  }
  const set = result.from === null ? `all ${result.test_set} merged PRs in ${HISTORY}` : `the ${result.test_set} PRs merged at or after ${options.fromText}`;
  const out = [`Backtest of ${set}.`, 'Defects left at each step:', ...funnelLines(result.funnel).map((line) => `  ${line}`)];
  if (result.leaks.length > 0) out.push(`Rules that leak: ${result.leaks.map((leak) => `${leak.rule} (${leak.defects.join(', ')})`).join(', ')}. The report gives the counts with and without them.`);
  out.push('For each kind of change:');
  for (const row of [...result.counts.kinds, { ...result.counts.all, kind: 'all PRs' }]) {
    out.push(`  ${row.kind}: ${row.prs} ${row.prs === 1 ? 'PR' : 'PRs'}. Caught ${shareText(row.caught)}. Missed ${shareText(row.missed)}. False demands ${shareText(row.false_demands)}.`);
  }
  if (options.rerun) {
    const all = before.counts.all;
    out.push(`  all PRs before the rerun: Caught ${shareText(all.caught)}. Missed ${shareText(all.missed)}. False demands ${shareText(all.false_demands)}.`);
    out.push(rerunLine(rerunCounts, rerunInfo));
    out.push(`Evidence came from ${evidenceFrom.exhibit} exhibits, ${evidenceFrom.rerun} reruns and ${evidenceFrom.body} PR bodies. ${evidenceFrom.none} ${evidenceFrom.none === 1 ? 'PR' : 'PRs'} had none of these.`);
  } else {
    out.push(`Evidence came from ${evidenceFrom.exhibit} exhibits and ${evidenceFrom.body} PR bodies. ${evidenceFrom.none} ${evidenceFrom.none === 1 ? 'PR' : 'PRs'} had neither.`);
  }
  out.push(`Wrote the report to ${BACKTEST_REPORT.markdown} and ${BACKTEST_REPORT.html}.`);
  stdout.write(out.join('\n') + '\n');
}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { from: { type: 'string' }, json: { type: 'boolean' }, rerun: { type: 'boolean' }, budget: { type: 'string' } }, allowPositionals: false }));
  } catch (error) {
    throw new ToolError(`${error.message}. ${USAGE}`);
  }
  let budgetMinutes = DEFAULT_RERUN_BUDGET_MINUTES;
  if (values.budget !== undefined) {
    if (!values.rerun) throw new ToolError(`--budget is the time budget of --rerun, so give it only with --rerun. ${USAGE}`);
    if (!/^[1-9]\d*$/.test(values.budget)) throw new ToolError(`--budget must be a whole number of minutes, 1 or more, not "${values.budget}".`);
    budgetMinutes = Number(values.budget);
  }
  let from = null;
  if (values.from !== undefined) {
    from = parseSince(values.from);
    if (!from) throw new ToolError(`--from must be a real date like 2026-03-01 (UTC) or an ISO time, not "${values.from}".`);
  }
  return { from, fromText: values.from ?? null, json: values.json === true, rerun: values.rerun === true, budgetMinutes };
}

// Runs src/rerun.js with the collectors of exhibit check. Each PR's probes share a worktree of its
// head, made when the first probe asks for it, and removed after the PR. A Ctrl-C, SIGTERM or
// SIGHUP stops every test run and probe, removes that worktree, and ends Exhibit, as in exhibit
// check (spec 9.6).
async function rerunWithStop({ cwd, env, lines, policies, exhibits, budgetSeconds, clock, stderr }) {
  const timeoutSeconds = policies[0].settings.probe_timeout_seconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;
  let current = null;
  const stop = onStopSignal(() => (current ? current.remove() : Promise.resolve()));
  try {
    return await rerun({
      cwd,
      env,
      lines,
      policies,
      exhibits,
      budgetSeconds,
      clock,
      collectorsFor: (head) => {
        const headWorktree = worktreeOnDemand(cwd, head);
        current = headWorktree;
        return { collectors: { ...COLLECTORS, probe: probeCollector({ cwd, headWorktree, timeoutSeconds }) }, done: () => headWorktree.remove() };
      },
      onPr: (number, result) => {
        const said = result.requirements.map((item) => `${requirementName(item)} ${item.status}`).join(', ');
        stderr.write(`exhibit: rerun of PR ${number}: ${said} (${Math.round(result.seconds)} s).\n`);
      }
    });
  } finally {
    stop.off();
  }
}

// How many test-set PRs got each rerun status.
function rerunStatusCounts(prs) {
  const count = (status) => prs.filter((pr) => pr.rerun.status === status).length;
  return { ran: count('ran'), error: count('error'), not_reached: count('not_reached'), no_commits: count('no_commits'), nothing_to_run: count('nothing_to_run') };
}

function rerunLine(counts, info) {
  const parts = [`${counts.ran} ran`, `${counts.error} gave an error`, `${counts.not_reached} not reached in the budget of ${info.budget_minutes} minutes`, `${counts.no_commits} with a commit that is not in the clone`, `${counts.nothing_to_run} with nothing to run`];
  return `Rerun in ${info.seconds} s: ${parts.join(', ')}. The logs are in ${info.logs}.`;
}

async function readHistory(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, HISTORY), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ToolError(`there is no ${HISTORY} in this folder. Run exhibit history first, inside a clone of the repo.`);
    throw new ToolError(`could not read ${HISTORY}: ${error.message}`);
  }
  return parseLines(text, HISTORY, checkHistoryLine, 'the history schema. Run exhibit history again to write it new');
}

// The labels are optional: with no file, no defect has a kept link yet. A file that is there must
// be valid, because the counts rest on it.
async function readLabels(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, LABELS), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw new ToolError(`could not read ${LABELS}: ${error.message}`);
  }
  return parseLines(text, LABELS, checkLabelLine, 'the labels schema. Fix or remove that line, then run exhibit backtest again');
}

// owner/name from the first line's web page, such as https://github.com/owner/name/pull/4.
function repoOf(lines) {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(lines[0]?.url ?? '');
  return match ? match[1] : 'this repo';
}
