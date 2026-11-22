// The backtest (spec 9.9): would the policy have caught the bugs that got through, and how often
// would it have asked for evidence on PRs that were fine? It reads the history, the labels and the
// policy, and works out what the policy would have said about each PR. It runs nothing itself:
// with --rerun, src/rerun.js runs the cheap requirements first, and gives this code the results.
import { bodyStatus, evidenceSection } from './body-evidence.js';
import { classifyChange } from './classify.js';
import { clopperPearson } from './interval.js';
import { DEFAULT_POLICY } from './policy.js';
import { escapedDefects } from './report.js';

// The name a PR is counted under when it matches no kind, so the policy's default applies.
export const DEFAULT_KIND = 'default';

/**
 * Runs the backtest. It returns plain data, which the report and --json both show.
 *
 * - `lines`: the history lines (spec 8.3).
 * - `labels`: the labels lines (spec 8.4), or [] when there is no labels file.
 * - `policy`: what readPolicy returns.
 * - `exhibits`: a Map from PR number to the PR's exhibit at its head commit (spec 8.2), for the
 *   PRs that have one.
 * - `from`: a Date, or null. The test set is the PRs merged at or after it, or every PR with null.
 * - `reruns`: a Map from PR number to what src/rerun.js gave for it, or null with no --rerun.
 * - `leakNoCommits`: a Set of PR numbers whose defects make no leak, or null to use the PRs that
 *   `reruns` marks `no_commits`. The command gives the set it found before the rerun
 *   (prsWithoutCommits in src/rerun.js), so the leaks here are the ones that picked the rerun's
 *   policies, and the table without them uses only requirements that the rerun ran.
 */
export function backtest({ lines, labels, policy, exhibits = new Map(), from = null, reruns = null, leakNoCommits = null }) {
  const testSet = testSetOf(lines, from);
  // A PR whose base or head is not in the clone could not run again, so it is in no rate (spec 9.9).
  const noCommits = new Set([...(reruns ?? new Map())].filter(([, result]) => result.status === 'no_commits').map(([number]) => number));
  const roles = prRoles(lines, labels);
  const counted = roles.defects.filter((defect) => defect.introducing_prs.some((pr) => testSet.some((line) => line.number === pr)));
  // A leak is a defect that a rate counts, so a defect whose only introducing PRs in the test set
  // have no commits in the clone makes no leak. `counted` keeps it, for its replayed line.
  const noLeak = leakNoCommits ?? noCommits;
  const leaks = findLeaks(policy, counted.filter((defect) => defect.introducing_prs.some((pr) => !noLeak.has(pr) && testSet.some((line) => line.number === pr))));
  const without = leaks.length === 0 ? null : withoutRules(policy, leaks.map((leak) => leak.rule));
  const categories = sourceCategories(roles.defects);

  const run = (rules) => {
    const verdicts = new Map(lines.map((line) => [line.number, judge(line, rules, exhibits.get(line.number) ?? null, reruns?.get(line.number) ?? null)]));
    return { verdicts, counts: countByKind(testSet, verdicts, roles, rules, categories, noCommits, exhibits) };
  };
  const withAll = run(policy);
  const withoutLeaks = without === null ? null : run(without);

  const replayed = [];
  for (const defect of counted) {
    for (const pr of defect.introducing_prs) {
      if (!testSet.some((line) => line.number === pr)) continue;
      const replay = (result, rules) => {
        const verdict = result.verdicts.get(pr);
        return { verdict: verdict.verdict, missing: verdict.missing, strong: isStrong(verdict, defect, rules, categories) };
      };
      replayed.push({ id: defect.id, category: defect.category, pr, ...replay(withAll, policy), without: withoutLeaks === null ? null : replay(withoutLeaks, without), ...(reruns === null ? {} : { no_commits: noCommits.has(pr) }) });
    }
  }

  return {
    from: from === null ? null : from.toISOString(),
    test_set: testSet.length,
    deferrals: roles.deferrals.filter((defect) => defect.introducing_prs.some((pr) => testSet.some((line) => line.number === pr))).map((defect) => defect.id),
    funnel: funnel(lines, labels, policy, withAll.verdicts),
    leaks,
    counts: withAll.counts,
    counts_without_leaks: withoutLeaks === null ? null : withoutLeaks.counts,
    replayed,
    prs: testSet.map((line) => ({ number: line.number, ...withAll.verdicts.get(line.number), role: roles.roleOf(line.number), rerun: reruns === null ? null : rerunSummary(reruns.get(line.number)) }))
  };
}

/**
 * What the policy `rules` would have said about one history line. Returns { kinds, verdict,
 * requirements, missing, basis, unknown_only }:
 * - kinds: the kinds the PR matches, or [default] when it matches none.
 * - requirements: each requirement the policy needs, with its `status` and `from`: `exhibit`
 *   when the PR's exhibit has the same requirement, `rerun` when --rerun ran it and it gave met,
 *   missing or failed, `body` when the body has an evidence section, or `none` when there is
 *   neither. Then the status is `unknown`. A rerun that gave error or skipped tells nothing, so
 *   the body or none gives the status then.
 * - verdict: needs_person when a requirement is not met, or when the PR changes the policy file,
 *   or when no rule covers it, as exhibit check gives it (spec 9.8). An unknown requirement
 *   counts as not met: Exhibit could not tell, so a person would have had to read it. Otherwise
 *   meets_policy.
 * - missing: the requirements that are not met, as short names such as tests-before-after or
 *   probe manual, then policy-change or no-rule.
 * - basis: `exhibit`, `rerun`, `body` or `none`, as for `from`, for the PR as a whole. `rerun`
 *   when the PR has no exhibit and a rerun gave at least one requirement.
 * - unknown_only: needs_person only because of unknown requirements.
 */
export function judge(line, rules, exhibit, rerun = null) {
  const files = line.files.map((file) => file.path);
  const fixed = { fix: line.classification.fix, fix_signal: line.classification.fix_signal };
  // history.jsonl does not say which files a PR added, so only the feature label marks a feature.
  const { classification, requirements } = classifyChange(rules, files, { title: line.title, labels: line.labels, branch: '' }, DEFAULT_POLICY, [], fixed);
  const section = typeof line.evidence_section === 'string' ? line.evidence_section : evidenceSection(line.body);
  const judged = requirements.filter((requirement) => !requirement.not_needed).map((requirement) => {
    const found = exhibit?.requirements?.find((item) => item.type === requirement.type && sameParams(item.params, requirement.params));
    if (found) return { ...requirement, status: found.status === 'met' ? 'met' : ['missing', 'failed'].includes(found.status) ? 'missing' : 'unknown', from: 'exhibit' };
    const ran = rerun?.requirements?.find((item) => item.type === requirement.type && sameParams(item.params, requirement.params) && ['met', 'missing', 'failed'].includes(item.status));
    if (ran) return { ...requirement, status: ran.status === 'met' ? 'met' : 'missing', from: 'rerun' };
    if (section !== null) return { ...requirement, status: bodyStatus(requirement, section, rules.settings), from: 'body' };
    return { ...requirement, status: 'unknown', from: 'none' };
  });
  const notMet = judged.filter((requirement) => requirement.status !== 'met');
  const gaps = [];
  if (classification.policy_changed) gaps.push('policy-change');
  if (classification.used_default && !classification.has_default) gaps.push('no-rule');
  const verdict = notMet.length === 0 && gaps.length === 0 ? 'meets_policy' : 'needs_person';
  const basis = exhibit ? 'exhibit' : judged.some((requirement) => requirement.from === 'rerun') ? 'rerun' : section !== null ? 'body' : 'none';
  return {
    kinds: classification.kinds.length === 0 ? [DEFAULT_KIND] : classification.kinds,
    verdict,
    requirements: judged.map(({ type, params, kinds, status, from }) => ({ type, params, kinds, status, from })),
    missing: [...notMet.map(requirementName), ...gaps],
    basis,
    unknown_only: verdict === 'needs_person' && gaps.length === 0 && notMet.every((requirement) => requirement.status === 'unknown')
  };
}

/**
 * The test set: the PRs merged at or after `from` (a Date), or every PR with null, by PR number.
 * The rerun runs this same set, so it must come from here.
 */
export function testSetOf(lines, from) {
  return lines.filter((line) => from === null || new Date(line.merged_at) >= from).sort(byNumber);
}

// What the report and --json say about one PR's rerun: its status, run time and errors.
function rerunSummary(result) {
  if (!result) return null;
  return { status: result.status, seconds: Math.round(result.seconds), errors: result.errors, mutation: result.mutation };
}

// tests-before-after, failing-before, mutation 0.85, probe restart-run.
export function requirementName(requirement) {
  if (requirement.type === 'probe') return `probe ${requirement.params.name}`;
  if (requirement.type === 'mutation') return `mutation ${requirement.params.min}`;
  return requirement.type;
}

/**
 * Sorts the PRs by what the labels say about them (spec 9.9, measure 1):
 * - An introducing PR has a link that a person kept, from a defect that is not a deferral.
 * - A deferral's introducing PR brought a bug that review saw, so it is neither clean nor counted.
 * - A clean PR has no SZZ link from any fix, or every link to it was rejected.
 * - Any other PR has an SZZ link that nobody has labeled yet: it is `unlabeled`, in no rate.
 * A kept link wins. Each fix PR counts by its first labels line, as in exhibit label.
 */
function prRoles(lines, labels) {
  const first = new Map();
  for (const label of labels) if (!first.has(label.fix_pr)) first.set(label.fix_pr, label);
  const fixes = new Map(escapedDefects(lines).map((fix) => [fix.number, fix]));
  const labeled = [...first.values()].filter((label) => fixes.has(label.fix_pr));
  const deferrals = labeled.filter((label) => label.known_at_review === true);
  const defects = labeled.filter((label) => label.known_at_review !== true && label.introducing_prs.length > 0).sort((a, b) => a.fix_pr - b.fix_pr);

  const introducing = new Set(defects.flatMap((defect) => defect.introducing_prs));
  const deferred = new Set(deferrals.flatMap((defect) => defect.introducing_prs));
  // Every PR that a fix's SZZ linked, less the links a person rejected.
  const linked = new Set();
  for (const line of lines) {
    if (!line.classification.fix || !(line.szz?.links.length > 0)) continue;
    const label = first.get(line.number);
    for (const link of line.szz.links) if (!(label?.rejected_prs ?? []).includes(link.pr)) linked.add(link.pr);
  }
  const roleOf = (pr) => {
    if (introducing.has(pr)) return 'introducing';
    if (deferred.has(pr)) return 'deferral';
    return linked.has(pr) ? 'unlabeled' : 'clean';
  };
  return { defects, deferrals, roleOf };
}

// A rule leaks when its `source` names a defect that the test set counts (spec 9.9). Returns
// [{ rule, defects }], with the kinds by name, then default.
function findLeaks(policy, counted) {
  const ids = new Set(counted.map((defect) => defect.id));
  const rules = [...Object.keys(policy.kinds).sort().map((name) => [name, policy.kinds[name]]), ...(policy.default ? [[DEFAULT_KIND, policy.default]] : [])];
  return rules.map(([rule, body]) => ({ rule, defects: (body.source ?? []).filter((id) => ids.has(id)).sort() })).filter((leak) => leak.defects.length > 0);
}

// The policy with the named rules taken out. A kind is removed, so its PRs fall to the other kinds
// they match, or to default. A default that leaks keeps its risk but asks for nothing, so a PR
// that matches no kind is not stopped by a rule that has no default.
export function withoutRules(policy, names) {
  const kinds = Object.fromEntries(Object.entries(policy.kinds).filter(([name]) => !names.includes(name)));
  const result = { ...policy, kinds };
  if (policy.default && names.includes(DEFAULT_KIND)) result.default = { ...policy.default, needs: [], source: [] };
  return result;
}

// For each category, the rules whose `source` names a labeled defect of that category.
function sourceCategories(defects) {
  const byId = new Map(defects.map((defect) => [defect.id, defect.category]));
  return (rules) => {
    const map = new Map();
    const all = [...Object.entries(rules.kinds), ...(rules.default ? [[DEFAULT_KIND, rules.default]] : [])];
    for (const [name, body] of all) {
      for (const id of body.source ?? []) {
        const category = byId.get(id);
        if (category === undefined) continue;
        if (!map.has(category)) map.set(category, new Set());
        map.get(category).add(name);
      }
    }
    return map;
  };
}

// A strong catch: a requirement that is missing belongs to a rule whose `source` names a defect of
// the same category as this one (spec 9.9). So the policy would have stopped the PR for the reason
// it was built to catch this kind of bug. An unknown requirement only means Exhibit could not
// tell, so it never makes a catch strong.
function isStrong(verdict, defect, rules, categories) {
  if (verdict.verdict !== 'needs_person') return false;
  const ruleNames = categories(rules).get(defect.category);
  if (!ruleNames) return false;
  return verdict.requirements.some((requirement) => requirement.status === 'missing' && requirement.kinds.some((kind) => ruleNames.has(kind)));
}

/**
 * The counts for each kind of change, then for all PRs, in the test set. A PR that matches two
 * kinds counts in both rows, and once in the row for all PRs. Each row has:
 * - prs: the test-set PRs of the kind.
 * - defects: the pairs of a counted defect and one of its kept introducing PRs of this kind. A
 *   defect with two introducing PRs counts twice. caught, strong and missed are shares of it.
 * - clean, and false_demands: the clean PRs that would have been needs_person.
 * - unlabeled: PRs with an SZZ link that nobody labeled yet, in no rate.
 * - deferral_prs: introducing PRs of a deferral, in no rate.
 * - unknown_only: needs_person verdicts that rest only on unknown requirements.
 * - no_commits: PRs that --rerun could not run, because a commit is not in the clone. They are
 *   in no rate: not in defects, and not in clean.
 * - size_matched: false demands on the clean PRs whose size is close to the introducing PRs'
 *   (measure 1, sizeMatched below).
 * - pays: caught and false demands from this kind's own requirements (measure 4, paysOf below),
 *   or null in the row for all PRs.
 * - skipped: PRs whose exhibit has a skip with status recorded (spec 9.10).
 * - miss_upper: the upper bound of the miss rate (spec 9.10), or null with no defect.
 */
function countByKind(testSet, verdicts, roles, rules, categories, noCommits = new Set(), exhibits = new Map()) {
  const pairs = [];
  for (const defect of roles.defects) {
    for (const pr of defect.introducing_prs) if (!noCommits.has(pr) && testSet.some((line) => line.number === pr)) pairs.push({ defect, pr });
  }
  const row = (kind, inKind) => {
    const prs = testSet.filter((line) => inKind(line.number));
    const mine = pairs.filter((pair) => inKind(pair.pr));
    const caught = mine.filter((pair) => verdicts.get(pair.pr).verdict === 'needs_person');
    const strong = caught.filter((pair) => isStrong(verdicts.get(pair.pr), pair.defect, rules, categories));
    const clean = prs.filter((line) => roles.roleOf(line.number) === 'clean' && !noCommits.has(line.number));
    const demands = clean.filter((line) => verdicts.get(line.number).verdict === 'needs_person');
    const missed = mine.length - caught.length;
    const introducing = testSet.filter((line) => mine.some((pair) => pair.pr === line.number));
    return {
      kind,
      prs: prs.length,
      defects: mine.length,
      caught: share(caught.length, mine.length),
      strong: share(strong.length, mine.length),
      missed: share(missed, mine.length),
      clean: clean.length,
      false_demands: share(demands.length, clean.length),
      unlabeled: prs.filter((line) => roles.roleOf(line.number) === 'unlabeled').length,
      deferral_prs: prs.filter((line) => roles.roleOf(line.number) === 'deferral').length,
      unknown_only: prs.filter((line) => verdicts.get(line.number).unknown_only).length,
      no_commits: prs.filter((line) => noCommits.has(line.number)).length,
      size_matched: sizeMatched(introducing, clean, verdicts),
      pays: kind === 'all' ? null : paysOf(kind, mine, clean, verdicts, rules),
      skipped: prs.filter((line) => exhibits.get(line.number)?.skip?.status === 'recorded').length,
      miss_upper: missUpper(missed, mine.length)
    };
  };
  const kinds = [...new Set(testSet.flatMap((line) => verdicts.get(line.number).kinds))].sort((a, b) => (a === DEFAULT_KIND) - (b === DEFAULT_KIND) || a.localeCompare(b));
  return {
    kinds: kinds.map((kind) => row(kind, (pr) => verdicts.get(pr).kinds.includes(kind))),
    all: row('all', () => true)
  };
}

// The clean PRs that each introducing PR picks for the size-matched set (spec 9.9, measure 1).
export const MATCHES_PER_INTRODUCING_PR = 3;

// A PR's size: its changed lines, the sum of additions and deletions over its files.
export function prSize(line) {
  return line.files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
}

/**
 * Measure 1 (spec 9.9): false demands on the clean PRs whose size is close to the size of the
 * introducing PRs. Small PRs are easy to pass, and most clean PRs are small, so the rate over all
 * clean PRs looks better than it is. Each introducing PR, lowest number first, takes the 3 clean
 * PRs closest in size that no PR took before it. On a tie it takes the PR with fewer changed
 * files, then the one merged nearer in time to it, then the lower number. Returns:
 * - introducing: how many introducing PRs picked.
 * - prs: the numbers of the clean PRs in the set, in the order they were taken.
 * - false_demands: the share of the set that would have been needs_person, or null with no set.
 * - short: true when there were fewer than 3 clean PRs for each introducing PR, so the set holds
 *   every clean PR.
 */
export function sizeMatched(introducing, clean, verdicts) {
  const left = [...clean];
  const taken = [];
  for (const pr of [...introducing].sort(byNumber)) {
    const size = prSize(pr);
    const time = Date.parse(pr.merged_at);
    const key = (line) => [Math.abs(prSize(line) - size), line.files.length, Math.abs(Date.parse(line.merged_at) - time), line.number];
    left.sort((a, b) => compareKeys(key(a), key(b)));
    taken.push(...left.splice(0, MATCHES_PER_INTRODUCING_PR));
  }
  const demands = taken.filter((line) => verdicts.get(line.number).verdict === 'needs_person').length;
  return {
    introducing: introducing.length,
    prs: taken.map((line) => line.number),
    false_demands: share(demands, taken.length),
    short: introducing.length > 0 && clean.length < MATCHES_PER_INTRODUCING_PR * introducing.length
  };
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Measure 4 (spec 9.9): does this kind's own needs ever stop a bug? A requirement is this kind's
 * when its `kinds` names the kind, so a need that two kinds share gives each kind the whole count
 * (ticket 267). Not met is missing or unknown, as for the verdict. Returns:
 * - defects: the defect pairs of this kind, less the defects in the kind's own source (a leak).
 * - caught: those pairs where a requirement of this kind was not met.
 * - false_demands: the clean PRs of this kind where a requirement of this kind was not met.
 * - caught_unknown_only, false_demands_unknown_only: how many of each rest only on unknown
 *   requirements of this kind.
 * - does_not_pay: 0 caught and at least 1 false demand.
 */
function paysOf(kind, pairs, clean, verdicts, rules) {
  const body = kind === DEFAULT_KIND ? rules.default : rules.kinds[kind];
  const source = new Set(body?.source ?? []);
  const notMet = (pr) => verdicts.get(pr).requirements.filter((requirement) => requirement.kinds.includes(kind) && requirement.status !== 'met');
  const onlyUnknown = (pr) => notMet(pr).every((requirement) => requirement.status === 'unknown');
  const defects = pairs.filter((pair) => !source.has(pair.defect.id));
  const caught = defects.filter((pair) => notMet(pair.pr).length > 0);
  const demands = clean.filter((line) => notMet(line.number).length > 0);
  return {
    defects: defects.length,
    caught: caught.length,
    false_demands: demands.length,
    caught_unknown_only: caught.filter((pair) => onlyUnknown(pair.pr)).length,
    false_demands_unknown_only: demands.filter((line) => onlyUnknown(line.number)).length,
    does_not_pay: caught.length === 0 && demands.length > 0
  };
}

// The upper bound of the miss rate (spec 9.10): 3/n when there are no misses (the rule of three,
// at most 1), and the high end of the Clopper-Pearson interval otherwise. Null when n is 0.
export function missUpper(misses, n) {
  if (n === 0) return null;
  if (misses === 0) return Math.min(1, 3 / n);
  return clopperPearson(misses, n).high;
}

// k of n with its 95% interval (src/interval.js), or null when n is 0.
export function share(k, n) {
  if (n === 0) return null;
  const { low, high } = clopperPearson(k, n);
  return { k, n, rate: k / n, low, high };
}

/**
 * The funnel (spec 9.9, measure 3), over all the history, with why defects were lost at each step.
 * Returns { fix_prs, szz_linked, kept, in_source, flagged, lost: { ... } }.
 */
function funnel(lines, labels, policy, verdicts) {
  const fixes = lines.filter((line) => line.classification.fix);
  const linked = escapedDefects(lines);
  const first = new Map();
  for (const label of labels) if (!first.has(label.fix_pr)) first.set(label.fix_pr, label);
  const labeled = linked.map((fix) => first.get(fix.number)).filter(Boolean);
  const deferred = labeled.filter((label) => label.known_at_review === true);
  const allRejected = labeled.filter((label) => label.known_at_review !== true && label.introducing_prs.length === 0);
  const kept = labeled.filter((label) => label.known_at_review !== true && label.introducing_prs.length > 0);
  const sources = new Set([...Object.values(policy.kinds), ...(policy.default ? [policy.default] : [])].flatMap((rule) => rule.source ?? []));
  const inSource = kept.filter((label) => sources.has(label.id));
  const flagged = inSource.filter((label) => label.introducing_prs.some((pr) => verdicts.get(pr)?.verdict === 'needs_person'));
  const notInHistory = inSource.filter((label) => !flagged.includes(label) && label.introducing_prs.every((pr) => !verdicts.has(pr)));
  return {
    fix_prs: fixes.length,
    szz_linked: linked.length,
    kept: kept.length,
    in_source: inSource.length,
    flagged: flagged.length,
    lost: {
      found_before_release: fixes.filter((line) => line.classification.escaped === false).length,
      no_link: fixes.filter((line) => line.classification.escaped !== false && !(line.szz?.links.length > 0)).length,
      not_labeled: linked.length - labeled.length,
      all_rejected: allRejected.length,
      deferrals: deferred.length,
      in_no_rule: kept.length - inSource.length,
      not_in_history: notInHistory.length,
      meets_policy: inSource.length - flagged.length - notInHistory.length
    },
    unflagged: inSource.filter((label) => !flagged.includes(label)).map((label) => label.id)
  };
}

function sameParams(a = {}, b = {}) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

const byNumber = (a, b) => a.number - b.number;
