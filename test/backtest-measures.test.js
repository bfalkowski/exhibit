import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, missUpper, sizeMatched } from '../src/backtest.js';
import { buildBacktestReport } from '../src/backtest-report.js';
import { parsePolicy } from '../src/policy.js';

const TESTS = '## Evidence\n\n- npm test: 10 of 10 pass.\n';
const NO_TESTS = '## Evidence\n\nI looked at it.\n';

// One history line with only the fields the backtest reads. Each file has `size` added lines.
function pr(number, { files, size = 1, body = null, fix = false, links = [], day = 10 }) {
  return {
    number,
    title: fix ? `Fix ${number}` : `Change ${number}`,
    body,
    labels: fix ? ['bug'] : [],
    merged_at: `2026-03-${String(day).padStart(2, '0')}T12:00:00Z`,
    head_sha: String(number).padStart(40, '0'),
    url: `https://github.com/acme/widgets/pull/${number}`,
    files: files.map((path) => ({ path, additions: size, deletions: 0 })),
    classification: { fix, fix_signal: fix ? 'label:bug' : null, kinds: [] },
    szz: fix ? { blamed_commit: 'a'.repeat(40), links: links.map((linked) => ({ pr: linked, confidence: 1, lines: [] })), unlinked_lines: [], dropped_lines: [], no_link_reason: null } : null
  };
}

function label(fixPr, introducing, category = 'Bug') {
  return { id: `D-${fixPr}`, fix_pr: fixPr, introducing_prs: introducing, rejected_prs: [], code: 'x', category, would_have_caught: 'x', labeled_by: 'person', szz_link_rejected: false, known_at_review: false, labeled_at: '2026-04-01T00:00:00Z' };
}

test('the size-matched example of spec 9.9 gives 2 of 11 over all clean PRs and 2 of 6 over the set', () => {
  const policy = parsePolicy('version: 3\nkinds:\n  core:\n    match: ["src/**"]\n    risk: high\n    needs: [tests-before-after]\n');
  // Introducing PRs 1 (40 lines) and 2 (300 lines). Both show a test run, so they meet the policy.
  const introducing = [pr(1, { files: ['src/a.js'], size: 40, body: TESTS }), pr(2, { files: ['src/b.js'], size: 300, body: TESTS })];
  // The clean PRs. The ones with 250 and 320 lines show no test run, so they are false demands.
  const sizes = [2, 3, 5, 8, 35, 45, 60, 250, 280, 320, 900];
  const clean = sizes.map((size, i) => pr(10 + i, { files: ['src/c.js'], size, body: size === 250 || size === 320 ? NO_TESTS : TESTS }));
  // Fix PRs, outside src/** so they match no kind, with no default: they are no-rule PRs of default.
  const fixes = [pr(30, { files: ['fix/a.txt'], fix: true, links: [1], body: TESTS }), pr(31, { files: ['fix/b.txt'], fix: true, links: [2], body: TESTS })];
  const result = backtest({ lines: [...introducing, ...clean, ...fixes], labels: [label(30, [1]), label(31, [2])], policy });

  const core = result.counts.kinds.find((row) => row.kind === 'core');
  assert.deepEqual([core.false_demands.k, core.false_demands.n], [2, 11]);
  assert.deepEqual([core.size_matched.false_demands.k, core.size_matched.false_demands.n], [2, 6]);
  // PR 1 takes 35, 45 and 60 lines. PR 2 takes 280, 320 and 250, in order of distance and then number.
  const byNumber = new Map(clean.map((line, i) => [line.number, sizes[i]]));
  assert.deepEqual(core.size_matched.prs.map((number) => byNumber.get(number)), [35, 45, 60, 280, 320, 250]);
  assert.equal(core.size_matched.short, false);
  assert.equal(core.size_matched.introducing, 2);

  const { markdown } = buildBacktestReport(result, { repo: 'acme/widgets' });
  assert.match(markdown, /\| core \| 2 \| 2 of 11, 18% \([^)]*\) \| 2 of 6, 33% \([^)]*\) \|/);
});

test('a tie on size goes to fewer files, then nearer in time, then the lower number, and a short set says so', () => {
  const verdicts = new Map();
  const line = (number, { size, files = 1, day = 10 }) => {
    verdicts.set(number, { verdict: 'meets_policy' });
    return { number, merged_at: `2026-03-${String(day).padStart(2, '0')}T00:00:00Z`, files: Array.from({ length: files }, () => ({ path: 'x', additions: size / files, deletions: 0 })) };
  };
  const introducing = [line(1, { size: 10, day: 10 })];
  const clean = [line(5, { size: 12, files: 2 }), line(6, { size: 8, day: 1 }), line(7, { size: 12, day: 9 }), line(4, { size: 8, day: 1 })];
  const result = sizeMatched(introducing, clean, verdicts);
  // All four are 2 lines away. 5 has two files, so it is last. 7 was merged nearer in time. 4 has a lower number than 6.
  assert.deepEqual(result.prs, [7, 4, 6]);
  assert.equal(result.short, false);

  const short = sizeMatched([...introducing, line(2, { size: 100 })], clean, verdicts);
  assert.deepEqual(short.prs, [7, 4, 6, 5]);
  assert.equal(short.short, true);

  const none = sizeMatched([], clean, verdicts);
  assert.deepEqual([none.introducing, none.false_demands, none.short], [0, null, false]);
});

// The policy of the ticket-267 example in spec 9.9, with two more kinds. ops needs a probe, and
// tooling needs a test run.
const SHARED_POLICY = parsePolicy(`
version: 3
kinds:
  docs:
    match: ["docs/**"]
    risk: low
    needs: [tests-before-after]
  ops:
    match: ["ops/**"]
    risk: medium
    needs:
      - probe: { name: check, run: "make check" }
  relay:
    match: ["relay/**"]
    risk: high
    needs: [tests-before-after]
  tooling:
    match: ["tools/**"]
    risk: low
    needs: [tests-before-after]
`);

function sharedResult() {
  const lines = [
    // PR 19 brought D-88. Its shared tests-before-after is missing. Its ops probe is met.
    pr(19, { files: ['relay/core.js', 'docs/relay.md', 'ops/run.sh'], body: '## Evidence\n\nRan `make check`: clean.\n' }),
    pr(30, { files: ['docs/setup.md'], body: NO_TESTS }),
    // No body, so tests-before-after is unknown.
    pr(41, { files: ['relay/queue.js'] }),
    pr(50, { files: ['ops/deploy.sh'], body: TESTS }),
    pr(60, { files: ['tools/lint.js'], body: NO_TESTS }),
    pr(88, { files: ['fix/x.txt'], fix: true, links: [19], body: TESTS })
  ];
  return backtest({ lines, labels: [label(88, [19])], policy: SHARED_POLICY });
}

test('a need that two kinds share gives each kind the whole catch, and a kind with 0 caught and 1 false demand does not pay', () => {
  const result = sharedResult();
  const pays = Object.fromEntries(result.counts.kinds.filter((row) => row.pays).map((row) => [row.kind, row.pays]));
  // docs and relay share PR 19's missing test run, so each gets 1 caught. PR 30 and PR 41 are a
  // false demand each for their own kind. PR 41 rests only on unknown.
  assert.deepEqual(pays.docs, { defects: 1, caught: 1, false_demands: 1, caught_unknown_only: 0, false_demands_unknown_only: 0, does_not_pay: false });
  assert.deepEqual(pays.relay, { defects: 1, caught: 1, false_demands: 1, caught_unknown_only: 0, false_demands_unknown_only: 1, does_not_pay: false });
  // ops matched D-88, but its own probe was met there: 0 caught. PR 50 shows no make check: 1 false demand.
  assert.deepEqual(pays.ops, { defects: 1, caught: 0, false_demands: 1, caught_unknown_only: 0, false_demands_unknown_only: 0, does_not_pay: true });
  // tooling matched no defect, and had 1 false demand.
  assert.deepEqual(pays.tooling, { defects: 0, caught: 0, false_demands: 1, caught_unknown_only: 0, false_demands_unknown_only: 0, does_not_pay: true });
  // The table's caught count is wider: ops caught PR 19 there, because of the other kinds' need.
  assert.equal(result.counts.kinds.find((row) => row.kind === 'ops').caught.k, 1);
  assert.equal(result.counts.all.pays, null);

  const { markdown } = buildBacktestReport(result, { repo: 'acme/widgets' });
  assert.match(markdown, /## Rules that do not pay/);
  assert.match(markdown, /\| ops \| 1 \| 0 \| 1 \| 0, 0 \| does not pay \|/);
  assert.match(markdown, /\| tooling \| 0 \| 0 \| 1 \| 0, 0 \| does not pay\. No defect of the test set matched it, so it had no chance to catch one\. \|/);
  assert.match(markdown, /\| relay \| 1 \| 1 \| 1 \| 0, 1 \| +\|$/m);
  // tooling has no introducing PR, so it has no size-matched set, and the note says why.
  assert.match(markdown, /\| tooling \| 0 \| 1 of 1, 100% \([^)]*\) \| none \| No introducing PR in the test set, so no size-matched set\. Only the rate over all clean PRs is shown\. \|/);
});

test("a defect in a kind's own source does not count for that kind, but does for a kind that shares the need", () => {
  const policy = parsePolicy(`
version: 3
kinds:
  docs:
    match: ["docs/**"]
    risk: low
    needs: [tests-before-after]
  relay:
    match: ["relay/**"]
    risk: high
    needs: [tests-before-after]
    source: [D-88]
`);
  const lines = [
    pr(19, { files: ['relay/core.js', 'docs/relay.md'], body: NO_TESTS }),
    pr(88, { files: ['fix/x.txt'], fix: true, links: [19], body: TESTS })
  ];
  const result = backtest({ lines, labels: [label(88, [19])], policy });
  const pays = Object.fromEntries(result.counts.kinds.filter((row) => row.pays).map((row) => [row.kind, row.pays]));
  assert.deepEqual([pays.relay.defects, pays.relay.caught], [0, 0]);
  assert.deepEqual([pays.docs.defects, pays.docs.caught], [1, 1]);

  // relay leaks, so the trust ladder numbers come again without it. Then PR 19 is only docs.
  const { markdown } = buildBacktestReport(result, { repo: 'acme/widgets' });
  const ladder = markdown.slice(markdown.indexOf('## Numbers for the trust ladder'), markdown.indexOf('## Each defect'));
  const [withAll, withoutLeaks] = ladder.split('Without the rules that leak:');
  assert.match(withAll, /\| relay \| 1 \| 0 of 1 \| 0 \| 100% \|/);
  assert.ok(withoutLeaks !== undefined, 'no ladder table without the rules that leak');
  assert.doesNotMatch(withoutLeaks, /\| relay \|/);
  assert.match(withoutLeaks, /\| docs \| 1 \| 0 of 1 \| 0 \| 100% \|/);
});

test('the trust ladder numbers: misses, skips and the upper bound of the miss rate (spec 9.10)', () => {
  assert.equal(missUpper(0, 0), null);
  assert.equal(missUpper(0, 30), 0.1);
  assert.equal(missUpper(0, 2), 1);
  const bound = missUpper(1, 10);
  assert.ok(bound > 0.44 && bound < 0.45, String(bound));

  const lines = [
    pr(19, { files: ['relay/core.js'], body: TESTS }),
    pr(41, { files: ['relay/queue.js'], body: TESTS }),
    pr(88, { files: ['fix/x.txt'], fix: true, links: [19], body: TESTS })
  ];
  const exhibits = new Map([[41, { requirements: [], skip: { status: 'recorded', by: 'octocat', reason: 'needs a phone', head: 'x' } }]]);
  const result = backtest({ lines, labels: [label(88, [19])], policy: SHARED_POLICY, exhibits });
  const relay = result.counts.kinds.find((row) => row.kind === 'relay');
  // PR 19 shows its test run, so the policy would have missed D-88: 1 miss of 1.
  assert.deepEqual([relay.missed.k, relay.missed.n, relay.skipped, relay.miss_upper], [1, 1, 1, 1]);
  const { markdown } = buildBacktestReport(result, { repo: 'acme/widgets' });
  assert.match(markdown, /## Numbers for the trust ladder/);
  assert.match(markdown, /\| relay \| 2 \| 1 of 1 \| 1 \| 100% \| 0 of 1, 0% \([^)]*\) \| 0 of 1, 0% \([^)]*\) \|/);
});
