// Builds the backtest report (spec 8.5 and 9.9) from what src/backtest.js returns. The first
// screen shows the funnel. src/report.js renders the blocks, so backtest.md and backtest.html hold
// the same facts.
import { MATCHES_PER_INTRODUCING_PR } from './backtest.js';
import { heading, item, list, paragraph, renderReport, table } from './report.js';

/**
 * Returns { markdown, html } for the backtest `result` of `repo`. `fromText` is the --from value
 * as the person typed it, or null.
 */
export function buildBacktestReport(result, { repo, fromText = null }) {
  const blocks = [heading(1, `Backtest of the policy on ${repo}`)];
  blocks.push(paragraph(testSetText(result, fromText)));
  blocks.push(...funnelBlocks(result.funnel));
  blocks.push(...leakBlocks(result));
  blocks.push(heading(2, 'Caught, missed and false demands for each kind of change'));
  blocks.push(countsTable(result.counts));
  if (result.counts_without_leaks) {
    blocks.push(paragraph('Without the rules that leak:'));
    blocks.push(countsTable(result.counts_without_leaks));
  }
  if (result.counts_before_rerun) {
    blocks.push(paragraph('Before the rerun, from the exhibits and the PR bodies only:'));
    blocks.push(countsTable(result.counts_before_rerun));
  }
  blocks.push(paragraph(
    'Each share has its count and its 95% interval. A defect counts once for each of its kept introducing PRs in the test set, under each kind that the PR matches. ' +
    'Caught means the policy would have given that PR needs_person. Strong means a requirement that is missing, not unknown, comes from a rule whose source names a defect of the same category. ' +
    'Missed means meets_policy. A false demand is a clean PR that would have been needs_person. A clean PR has no SZZ link from any fix, or every link to it was rejected. ' +
    'A PR with an SZZ link that nobody labeled yet is in no rate. An unknown requirement counts as not met, as a skipped one does in exhibit check, and the last column counts the needs_person verdicts that rest only on unknown requirements.'
  ));
  if (result.deferrals.length > 0) {
    blocks.push(paragraph(`${plural(result.deferrals.length, 'deferral')} left out: ${result.deferrals.join(', ')}. Review saw each one and left it for a later ticket, so it is never a policy miss, and its introducing PR is not a clean PR either.`));
  }
  blocks.push(...sizeMatchedBlocks(result.counts));
  blocks.push(...paysBlocks(result.counts));
  blocks.push(...ladderBlocks(result));
  blocks.push(...replayBlocks(result));
  if (result.rerun) blocks.push(...rerunBlocks(result));
  blocks.push(...basisBlocks(result.prs, result.rerun !== undefined));
  return renderReport(`Backtest of the policy on ${repo}`, blocks);
}

function testSetText(result, fromText) {
  if (result.from === null) {
    return `No --from was given, so the test set is all ${plural(result.test_set, 'merged PR')} in the history. A rule learned from these PRs will look better than it is, so read the leak check.`;
  }
  return `The test set is the ${plural(result.test_set, 'PR')} merged at or after ${fromText ?? result.from}.`;
}

// The funnel (spec 9.9, measure 3): how many defects are left at each step, and why the others
// were lost. It covers all the history, not only the test set.
export function funnelLines(funnel) {
  const { lost } = funnel;
  const why = (parts) => {
    const said = parts.filter(([count]) => count > 0).map(([count, text]) => text(count));
    return said.length === 0 ? '' : ` (${said.join(', ')})`;
  };
  return [
    `Fix PRs found: ${funnel.fix_prs}`,
    `Fix PRs with an SZZ link: ${funnel.szz_linked}${why([
      [lost.no_link, (n) => `${plural(n, 'fix PR')} had no SZZ link`],
      [lost.found_before_release, (n) => `${n} found ${n === 1 ? 'its bug' : 'their bugs'} before release`]
    ])}`,
    `Defects with a link that a person kept: ${funnel.kept}${why([
      [lost.not_labeled, (n) => `${plural(n, 'defect')} ${n === 1 ? 'is' : 'are'} not labeled yet`],
      [lost.all_rejected, (n) => `${n} had every link rejected`],
      [lost.deferrals, (n) => `${n} ${n === 1 ? 'is a deferral' : 'are deferrals'}`]
    ])}`,
    `Defects named in a rule's source: ${funnel.in_source}${why([[lost.in_no_rule, (n) => `${plural(n, 'defect')} ${n === 1 ? 'is' : 'are'} in no rule`]])}`,
    `Defects that the policy would have flagged: ${funnel.flagged}${why([
      [lost.meets_policy, (n) => `${n} would have got meets_policy on every kept introducing PR`],
      [lost.not_in_history, (n) => `${n} ${n === 1 ? 'has' : 'have'} no kept introducing PR in the history`]
    ])}`
  ];
}

function funnelBlocks(funnel) {
  return [
    heading(2, 'Defects left at each step'),
    list(funnelLines(funnel).map((line) => item(line))),
    paragraph("The last step shows whether a rule still flags the bug it came from. It is not a test of the policy, because the rule learned from those defects. The test is the caught and missed counts on the test set, below.")
  ];
}

function leakBlocks(result) {
  const blocks = [heading(2, 'Leak check')];
  if (result.leaks.length === 0) {
    blocks.push(paragraph("No rule's source names a defect that the test set counts, so no rule leaks."));
    return blocks;
  }
  blocks.push(paragraph('These rules learned from defects that the test set counts, so they would catch them for free. The counts are given with and without them.'));
  blocks.push(list(result.leaks.map((leak) => item(`${leak.rule}: ${leak.defects.join(', ')}`))));
  return blocks;
}

function countsTable(counts) {
  const header = ['Kind', 'PRs', 'Defects', 'Caught', 'Strong catch', 'Missed', 'Clean PRs', 'False demands', 'Not labeled', 'Unknown only'];
  const row = (r) => [r.kind, String(r.prs), String(r.defects), shareText(r.caught), shareText(r.strong), shareText(r.missed), String(r.clean), shareText(r.false_demands), String(r.unlabeled), String(r.unknown_only)];
  return table(header, [...counts.kinds.map(row), row({ ...counts.all, kind: 'all PRs' })]);
}

// "3 of 4, 75% (19% to 99%)", or "none" when there is nothing to count.
export function shareText(share) {
  if (share === null) return 'none';
  return `${share.k} of ${share.n}, ${percent(share.rate)} (${percent(share.low)} to ${percent(share.high)})`;
}

// Measure 1 (spec 9.9): false demands over all clean PRs, and over the size-matched set.
function sizeMatchedBlocks(counts) {
  const rows = [...counts.kinds, { ...counts.all, kind: 'all PRs' }];
  return [
    heading(2, 'False demands on size-matched clean PRs'),
    paragraph(
      'Small PRs are easy to pass, and most clean PRs are small, so a false-demand rate over all clean PRs looks better than it is. ' +
      `So for each introducing PR of a kind, lowest number first, Exhibit takes the ${MATCHES_PER_INTRODUCING_PR} clean PRs of that kind whose changed lines are closest, each clean PR at most once. ` +
      'A tie goes to the PR with fewer changed files, then the one merged nearer in time, then the lower number.'
    ),
    table(['Kind', 'Introducing PRs', 'False demands, all clean PRs', 'False demands, size-matched', 'Note'],
      rows.map((row) => [row.kind, String(row.size_matched.introducing), shareText(row.false_demands), shareText(row.size_matched.false_demands), sizeMatchedNote(row.size_matched)]))
  ];
}

function sizeMatchedNote(matched) {
  if (matched.introducing === 0) return 'No introducing PR in the test set, so no size-matched set. Only the rate over all clean PRs is shown.';
  if (matched.short) return `Fewer than ${MATCHES_PER_INTRODUCING_PR} clean PRs for each introducing PR, so the set holds every clean PR.`;
  return '';
}

// Measure 4 (spec 9.9): for each kind and default, the catches and the false demands that come
// from its own requirements. A need that two kinds share counts whole for each of them.
function paysBlocks(counts) {
  const rows = counts.kinds.filter((row) => row.pays);
  const blocks = [heading(2, 'Rules that do not pay')];
  blocks.push(paragraph(
    "For each kind, caught counts the defects of the kind that a requirement of this kind did not meet, and false demands counts the clean PRs of the kind that a requirement of this kind did not meet. " +
    "A requirement that two kinds share counts whole for each of them. A defect in the kind's own source is a leak, so it is not counted. " +
    'Not met is missing or unknown. A kind with 0 caught and at least 1 false demand does not pay. Exhibit never removes or changes a rule: a person reads the mark and decides.'
  ));
  blocks.push(table(['Kind', 'Defects of the kind', 'Caught', 'False demands', 'Only unknown (caught, false demands)', 'Mark'],
    rows.map((row) => [row.kind, String(row.pays.defects), String(row.pays.caught), String(row.pays.false_demands), `${row.pays.caught_unknown_only}, ${row.pays.false_demands_unknown_only}`, paysMark(row.pays)])));
  return blocks;
}

function paysMark(pays) {
  if (pays.does_not_pay) return pays.defects === 0 ? 'does not pay. No defect of the test set matched it, so it had no chance to catch one.' : 'does not pay';
  if (pays.defects === 0) return 'No defect of the test set matched it, so it had no chance to catch one.';
  return '';
}

// The numbers for the trust ladder (spec 9.10). Exhibit only reports them. It never changes a rung.
function ladderBlocks(result) {
  const blocks = [heading(2, 'Numbers for the trust ladder')];
  blocks.push(paragraph(
    'For each kind of change: its PRs, its policy misses (a deferral is never one), the PRs whose exhibit has a recorded skip, the upper bound of the miss rate (3/n with no miss, the Clopper-Pearson bound otherwise), ' +
    'and the false-demand rate over the size-matched clean PRs, which is the rate a rung uses, with the rate over all clean PRs next to it. Exhibit only reports these numbers. It never changes a rung. ' +
    'Exhibit has no record of blind sample results yet, so they are not shown.'
  ));
  blocks.push(ladderTable(result.counts));
  if (result.counts_without_leaks) {
    blocks.push(paragraph('Without the rules that leak:'));
    blocks.push(ladderTable(result.counts_without_leaks));
  }
  return blocks;
}

function ladderTable(counts) {
  const rows = [...counts.kinds, { ...counts.all, kind: 'all PRs' }];
  return table(['Kind', 'PRs', 'Policy misses', 'Skipped PRs', 'Miss rate at most', 'False demands, size-matched', 'False demands, all clean PRs'],
    rows.map((row) => [row.kind, String(row.prs), row.missed === null ? 'none' : `${row.missed.k} of ${row.missed.n}`, String(row.skipped), row.miss_upper === null ? 'none' : percent(row.miss_upper),
      row.size_matched.introducing === 0 ? 'no set: no introducing PR' : shareText(row.size_matched.false_demands), shareText(row.false_demands)]));
}

function replayBlocks(result) {
  const blocks = [heading(2, 'Each defect, replayed')];
  if (result.replayed.length === 0) {
    blocks.push(paragraph('No labeled escaped defect has a kept introducing PR in the test set.'));
    return blocks;
  }
  blocks.push(list(result.replayed.map((line) => {
    const said = `${line.id} (${line.category}), introducing PR ${line.pr}: ${verdictText(line)}`;
    return item(line.without === null ? said : `${said} Without the rules that leak: ${verdictText(line.without)}`);
  })));
  return blocks;
}

function verdictText({ verdict, missing, strong, no_commits: noCommits }) {
  if (noCommits) return `${verdict}, from the exhibit or body only. Not counted: its commits are not in the clone, so it could not run again.`;
  if (verdict === 'meets_policy') return 'meets_policy, so missed.';
  return `needs_person, caught. Missing: ${missing.join(', ')}. ${strong ? 'A strong catch.' : 'Not a strong catch.'}`;
}

// The rerun (spec 9.9): how many PRs ran, and each PR that gave an error, that the budget did
// not reach, or whose commits are not in the clone. Those PRs keep the status from the exhibit or
// the body, and are listed here apart, so a reader does not take them for a result.
function rerunBlocks(result) {
  const { rerun } = result;
  const prs = result.prs.filter((pr) => pr.rerun);
  const withStatus = (status) => prs.filter((pr) => pr.rerun.status === status);
  const blocks = [heading(2, 'The rerun')];
  blocks.push(paragraph(
    `Exhibit ran the cheap requirements (tests-before-after, failing-before and probes) again on the base_sha and head_sha of each PR, with the collectors of exhibit check, in ${rerun.seconds} seconds, with a budget of ${rerun.budget_minutes} minutes. ` +
    'Mutation ran only after that, one PR at a time, while the budget still held a whole mutation run. ' +
    `A rerun that gave met, missing or failed gives the status. An error or a skip tells nothing, so the exhibit or the body still gives it. The logs of each PR are in ${rerun.logs}/<number>.`
  ));
  blocks.push(list([
    item(`Ran: ${withStatus('ran').length}`),
    item(`Gave an error: ${withStatus('error').length}`),
    item(`Not reached in the budget: ${withStatus('not_reached').length}`),
    item(`A commit not in the clone: ${withStatus('no_commits').length}`),
    item(`Nothing to run, because the exhibit gave every requirement or the policy asks for none: ${withStatus('nothing_to_run').length}`)
  ]));
  const errors = withStatus('error');
  if (errors.length > 0) {
    blocks.push(paragraph('PRs whose rerun gave an error:'));
    blocks.push(list(errors.map((pr) => item(`PR ${pr.number}: ${pr.rerun.errors.join('; ')}`))));
  }
  const named = (status, text) => {
    const these = withStatus(status);
    if (these.length > 0) blocks.push(paragraph(`${text}: ${these.map((pr) => pr.number).join(', ')}.`));
  };
  named('not_reached', 'PRs the budget did not reach. Give a larger --budget to run them');
  named('no_commits', 'PRs whose base or head commit is not in the clone, so they did not run. They are in no rate: not caught, not missed and not a false demand. Fetch them, for example with git fetch origin pull/N/head, and run again');
  const noMutation = prs.filter((pr) => pr.rerun.mutation === 'not_reached').map((pr) => pr.number);
  if (noMutation.length > 0) blocks.push(paragraph(`PRs whose mutation requirement did not run, because the budget could not hold one more mutation run: ${noMutation.join(', ')}.`));
  return blocks;
}

function basisBlocks(prs, reran) {
  const count = (basis) => prs.filter((pr) => pr.basis === basis).length;
  return [
    heading(2, 'Where the evidence came from'),
    list([
      item(`From the PR's exhibit: ${count('exhibit')}`),
      ...(reran ? [item(`From the rerun: ${count('rerun')}`)] : []),
      item(`From the evidence section of the PR body: ${count('body')}`),
      item(`No exhibit${reran ? ', no rerun' : ''} and no evidence section, so every requirement is unknown: ${count('none')}`)
    ]),
    paragraph(
      (reran ? 'A rerun result comes from a real run. ' : '') +
      `A body only claims. Exhibit runs nothing ${reran ? 'for a body' : 'here'}, so a requirement that the body shows counts as met only in that sense. ` +
      'An evidence section starts at a heading whose words start with "evidence". tests-before-after needs a test command in it, such as npm test or the policy\'s test_command. ' +
      'failing-before needs a line that says a test failed before. mutation needs a line that names mutation with a percent of at least min, and with no percent it is unknown. ' +
      'A probe needs its run command in it. With an evidence section, a requirement it does not show is missing. With no exhibit and no evidence section, it is unknown.'
    )
  ];
}

const percent = (value) => `${Math.round(value * 100)}%`;

function plural(count, one) {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}
