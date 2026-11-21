import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { backtest } from '../backtest.js';
import { buildBacktestReport, funnelLines, shareText } from '../backtest-report.js';
import { checkExhibit } from '../exhibit-schema.js';
import { checkHistoryLine } from '../history-schema.js';
import { checkLabelLine, HISTORY, LABELS, parseLines } from '../labels.js';
import { readPolicy } from '../policy.js';
import { BACKTEST_REPORT } from '../report.js';
import { readStoredExhibits } from '../storage.js';
import { ToolError } from '../tool-error.js';
import { writeTogether } from '../write-together.js';
import { parseSince } from './history.js';

const USAGE = 'Usage: exhibit backtest [--from YYYY-MM-DD] [--json]';

// `exhibit backtest [--from DATE] [--json]` (spec 7 and 9.9). It reads .exhibit/history.jsonl,
// .exhibit/labels.jsonl when it is there, evidence.yml, and the stored exhibits of the PRs. It
// works out what the policy would have said about each PR merged at or after --from, and writes
// the report to .exhibit/backtest.md and .exhibit/backtest.html, together (spec 8.5). It never
// writes the history report. It asks no forge and runs no PR's code.
export async function backtestCommand(argv, { cwd, stdout, stderr }) {
  const options = parseOptions(argv);
  const policy = await readPolicy(cwd);
  const lines = await readHistory(cwd);
  const labels = await readLabels(cwd);
  const heads = new Map(lines.map((line) => [line.number, line.head_sha]));
  const stored = await readStoredExhibits(cwd, policy.settings, heads, { check: checkExhibit });
  for (const path of stored.bad) stderr.write(`exhibit: warning: ${path} is not a valid exhibit, so the backtest reads that PR's body instead.\n`);

  const result = backtest({ lines, labels, policy, exhibits: stored.exhibits, from: options.from });
  const repo = repoOf(lines);
  const report = buildBacktestReport(result, { repo, fromText: options.fromText });
  await writeTogether(cwd, [[BACKTEST_REPORT.markdown, report.markdown], [BACKTEST_REPORT.html, report.html]]);

  const evidenceFrom = Object.fromEntries(['exhibit', 'body', 'none'].map((basis) => [basis, result.prs.filter((pr) => pr.basis === basis).length]));
  if (options.json) {
    // The PR list is long, so --json gives where its evidence came from, and the report the rest.
    const rest = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'prs'));
    stdout.write(JSON.stringify({ ...rest, evidence_from: evidenceFrom, labels: labels.length > 0 ? 'read' : 'none', report: BACKTEST_REPORT }) + '\n');
    return;
  }
  const set = result.from === null ? `all ${result.test_set} merged PRs in ${HISTORY}` : `the ${result.test_set} PRs merged at or after ${options.fromText}`;
  const out = [`Backtest of ${set}.`, 'Defects left at each step:', ...funnelLines(result.funnel).map((line) => `  ${line}`)];
  if (result.leaks.length > 0) out.push(`Rules that leak: ${result.leaks.map((leak) => `${leak.rule} (${leak.defects.join(', ')})`).join(', ')}. The report gives the counts with and without them.`);
  out.push('For each kind of change:');
  for (const row of [...result.counts.kinds, { ...result.counts.all, kind: 'all PRs' }]) {
    out.push(`  ${row.kind}: ${row.prs} ${row.prs === 1 ? 'PR' : 'PRs'}. Caught ${shareText(row.caught)}. Missed ${shareText(row.missed)}. False demands ${shareText(row.false_demands)}.`);
  }
  out.push(`Evidence came from ${evidenceFrom.exhibit} exhibits and ${evidenceFrom.body} PR bodies. ${evidenceFrom.none} ${evidenceFrom.none === 1 ? 'PR' : 'PRs'} had neither.`);
  out.push(`Wrote the report to ${BACKTEST_REPORT.markdown} and ${BACKTEST_REPORT.html}.`);
  stdout.write(out.join('\n') + '\n');
}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { from: { type: 'string' }, json: { type: 'boolean' }, rerun: { type: 'boolean' } }, allowPositionals: false }));
  } catch (error) {
    throw new ToolError(`${error.message}. ${USAGE}`);
  }
  if (values.rerun) throw new ToolError('--rerun is not built yet. Run exhibit backtest without it.');
  let from = null;
  if (values.from !== undefined) {
    from = parseSince(values.from);
    if (!from) throw new ToolError(`--from must be a real date like 2026-03-01 (UTC) or an ISO time, not "${values.from}".`);
  }
  return { from, fromText: values.from ?? null, json: values.json === true };
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
