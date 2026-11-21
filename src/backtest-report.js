// Builds the backtest report (spec 8.5 and 9.9) from what src/backtest.js returns. The first
// screen shows the funnel. src/report.js renders the blocks, so backtest.md and backtest.html hold
// the same facts.
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
  blocks.push(paragraph(
    'Each share has its count and its 95% interval. A defect counts once for each of its kept introducing PRs in the test set, under each kind that the PR matches. ' +
    'Caught means the policy would have given that PR needs_person. Strong means a requirement that is missing, not unknown, comes from a rule whose source names a defect of the same category. ' +
    'Missed means meets_policy. A false demand is a clean PR that would have been needs_person. A clean PR has no SZZ link from any fix, or every link to it was rejected. ' +
    'A PR with an SZZ link that nobody labeled yet is in no rate. An unknown requirement counts as not met, as a skipped one does in exhibit check, and the last column counts the needs_person verdicts that rest only on unknown requirements.'
  ));
  if (result.deferrals.length > 0) {
    blocks.push(paragraph(`${plural(result.deferrals.length, 'deferral')} left out: ${result.deferrals.join(', ')}. Review saw each one and left it for a later ticket, so it is never a policy miss, and its introducing PR is not a clean PR either.`));
  }
  blocks.push(...replayBlocks(result));
  blocks.push(...basisBlocks(result.prs));
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

function verdictText({ verdict, missing, strong }) {
  if (verdict === 'meets_policy') return 'meets_policy, so missed.';
  return `needs_person, caught. Missing: ${missing.join(', ')}. ${strong ? 'A strong catch.' : 'Not a strong catch.'}`;
}

function basisBlocks(prs) {
  const count = (basis) => prs.filter((pr) => pr.basis === basis).length;
  return [
    heading(2, 'Where the evidence came from'),
    list([
      item(`From the PR's exhibit: ${count('exhibit')}`),
      item(`From the evidence section of the PR body: ${count('body')}`),
      item(`No exhibit and no evidence section, so every requirement is unknown: ${count('none')}`)
    ]),
    paragraph(
      'A body only claims. Exhibit runs nothing here, so a requirement that the body shows counts as met only in that sense. ' +
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
