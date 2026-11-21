import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, judge, share } from '../src/backtest.js';
import { buildBacktestReport } from '../src/backtest-report.js';
import { bodyStatus, evidenceSection } from '../src/body-evidence.js';
import { parsePolicy } from '../src/policy.js';

// The fixture policy. core learned from D-010 and D-011, both "Cache key" bugs.
const POLICY = parsePolicy(`
version: 3
kinds:
  core:
    match: ["src/**"]
    risk: high
    needs:
      - tests-before-after
      - failing-before: { when: [fix] }
    source: [D-010, D-011]
  docs:
    match: ["docs/**"]
    risk: low
    needs:
      - probe: { name: links, run: "npm run check-links" }
default:
  risk: medium
  needs: [tests-before-after]
`);

const TESTS = '## Evidence\n\n- npm test: 10 of 10 pass.\n';
const TESTS_AND_FAILING = '## Evidence\n\n- npm test passes.\n- The new test failed before the fix and passes after it.\n';

// One history line with only the fields the backtest reads.
function pr(number, { day, files, body = null, fix = false, links = [] }) {
  return {
    number,
    title: fix ? `Fix ${number}` : `Change ${number}`,
    body,
    labels: fix ? ['bug'] : [],
    merged_at: `2026-${day}T12:00:00Z`,
    head_sha: String(number).padStart(40, '0'),
    url: `https://github.com/acme/widgets/pull/${number}`,
    files: files.map((path) => ({ path, additions: 1, deletions: 1 })),
    classification: { fix, fix_signal: fix ? 'label:bug' : null, kinds: [] },
    szz: fix ? { blamed_commit: 'a'.repeat(40), links: links.map((linked) => ({ pr: linked, confidence: 1, lines: [] })), unlinked_lines: [], dropped_lines: [], no_link_reason: null } : null
  };
}

const LINES = [
  pr(1, { day: '01-01', files: ['src/a.js'], body: TESTS }),
  pr(2, { day: '02-02', files: ['src/b.js'], body: TESTS }),
  pr(3, { day: '02-03', files: ['src/c.js', 'docs/x.md'] }),
  pr(4, { day: '02-04', files: ['src/d.js'], body: '## Evidence\n\nI ran it by hand.\n' }),
  pr(5, { day: '02-05', files: ['docs/y.md'], body: '## Evidence\n\n`npm run check-links` passes.\n' }),
  pr(6, { day: '02-06', files: ['README.txt'], body: TESTS }),
  pr(7, { day: '02-07', files: ['src/e.js'], body: '## Evidence\n\nI looked at it.\n' }),
  pr(8, { day: '02-08', files: ['other/z.txt'] }),
  pr(9, { day: '02-09', files: ['src/f.js'], body: TESTS }),
  pr(10, { day: '02-10', files: ['src/a.js'], body: TESTS_AND_FAILING, fix: true, links: [1] }),
  pr(11, { day: '02-11', files: ['src/b.js'], body: TESTS, fix: true, links: [2, 4] }),
  pr(12, { day: '02-12', files: ['src/c.js'], fix: true, links: [3] }),
  pr(13, { day: '02-13', files: ['src/g.js'], body: TESTS_AND_FAILING, fix: true, links: [9] }),
  pr(14, { day: '02-14', files: ['other/w.txt'], body: TESTS, fix: true, links: [8] }),
  pr(15, { day: '02-15', files: ['src/h.js'], body: TESTS_AND_FAILING, fix: true, links: [5] }),
  pr(16, { day: '02-16', files: ['src/i.js'], body: TESTS_AND_FAILING, fix: true, links: [] })
];

function label(fixPr, { introducing, rejected = [], category, known = null }) {
  return { id: `D-${String(fixPr).padStart(3, '0')}`, fix_pr: fixPr, introducing_prs: introducing, rejected_prs: rejected, code: 'x', category, would_have_caught: 'x', labeled_by: 'person', szz_link_rejected: rejected.length > 0, known_at_review: known, labeled_at: '2026-03-01T00:00:00Z' };
}

// Fix PR 14 has no label, so its link to PR 8 is not labeled yet.
const LABELS = [
  label(10, { introducing: [1], category: 'Cache key', known: false }),
  label(11, { introducing: [2, 4], category: 'Cache key' }),
  label(12, { introducing: [3], category: 'Typo', known: false }),
  label(13, { introducing: [9], category: 'Typo', known: true }),
  label(15, { introducing: [], rejected: [5], category: 'Typo' })
];

const counts = (row) => ({
  kind: row.kind, prs: row.prs, defects: row.defects,
  caught: row.caught && [row.caught.k, row.caught.n], strong: row.strong && [row.strong.k, row.strong.n], missed: row.missed && [row.missed.k, row.missed.n],
  clean: row.clean, false_demands: row.false_demands && [row.false_demands.k, row.false_demands.n],
  unlabeled: row.unlabeled, deferral_prs: row.deferral_prs, unknown_only: row.unknown_only
});

test('the backtest counts match a hand count on a fixture history (spec 9.9)', () => {
  const result = backtest({ lines: LINES, labels: LABELS, policy: POLICY, from: new Date('2026-02-01T00:00:00Z') });

  // The hand count. The test set is PRs 2 to 16. With the policy as it is:
  // - meets_policy: 2, 5, 6, 9, 10, 13, 14, 15, 16 (each body shows what its kinds need).
  // - needs_person: 3 and 12 (no evidence section, so unknown), 8 (the same, default), 4 and 7
  //   (an evidence section with no test run), 11 (a fix with no test that failed before).
  // - Introducing PRs: 2 and 4 (D-011), 3 (D-012). PR 1 (D-010) is before --from.
  // - A deferral's PR: 9 (D-013). Not labeled yet: 8 (fix 14 has no label).
  // - Clean: 5, 6, 7, 10, 11, 12, 13, 14, 15 (its only link was rejected), 16.
  // core (src/**): PRs 2, 3, 4, 7, 9, 10, 11, 12, 13, 15, 16. Defects: D-011 at 2 (missed) and
  // at 4 (caught, strong: core's source names D-010, a "Cache key" bug), D-012 at 3 (caught, not
  // strong: no rule learned from a "Typo" bug). False demands: 7, 11 and 12 of 7 clean.
  // docs: PRs 3 and 5. D-012 at 3 is caught. PR 5 is clean and meets the policy.
  // default: PRs 6, 8 and 14. No defect. 6 and 14 are clean and meet it. 8 is not labeled.
  assert.equal(result.test_set, 15);
  assert.deepEqual(result.counts.kinds.map(counts), [
    { kind: 'core', prs: 11, defects: 3, caught: [2, 3], strong: [1, 3], missed: [1, 3], clean: 7, false_demands: [3, 7], unlabeled: 0, deferral_prs: 1, unknown_only: 2 },
    { kind: 'docs', prs: 2, defects: 1, caught: [1, 1], strong: [0, 1], missed: [0, 1], clean: 1, false_demands: [0, 1], unlabeled: 0, deferral_prs: 0, unknown_only: 1 },
    { kind: 'default', prs: 3, defects: 0, caught: null, strong: null, missed: null, clean: 2, false_demands: [0, 2], unlabeled: 1, deferral_prs: 0, unknown_only: 1 }
  ]);
  assert.deepEqual(counts(result.counts.all), { kind: 'all', prs: 15, defects: 3, caught: [2, 3], strong: [1, 3], missed: [1, 3], clean: 10, false_demands: [3, 10], unlabeled: 1, deferral_prs: 1, unknown_only: 3 });
  assert.deepEqual(result.deferrals, ['D-013']);

  // The leak check: core's source names D-011, a defect that the test set counts. D-010 is not
  // counted, because its introducing PR 1 is before --from.
  assert.deepEqual(result.leaks, [{ rule: 'core', defects: ['D-011'] }]);
  // Without core, src/** falls to default, which asks only for a test run. PR 3 matches docs, so
  // default does not apply to it. PR 11 now meets the policy, and no catch is strong.
  assert.deepEqual(counts(result.counts_without_leaks.all), { kind: 'all', prs: 15, defects: 3, caught: [2, 3], strong: [0, 3], missed: [1, 3], clean: 10, false_demands: [2, 10], unlabeled: 1, deferral_prs: 1, unknown_only: 3 });
  assert.deepEqual(result.counts_without_leaks.kinds.map((row) => [row.kind, row.prs]), [['docs', 2], ['default', 13]]);

  // Measure 2: each counted defect at each kept introducing PR in the test set.
  assert.deepEqual(result.replayed, [
    { id: 'D-011', category: 'Cache key', pr: 2, verdict: 'meets_policy', missing: [], strong: false, without: { verdict: 'meets_policy', missing: [], strong: false } },
    { id: 'D-011', category: 'Cache key', pr: 4, verdict: 'needs_person', missing: ['tests-before-after'], strong: true, without: { verdict: 'needs_person', missing: ['tests-before-after'], strong: false } },
    { id: 'D-012', category: 'Typo', pr: 3, verdict: 'needs_person', missing: ['tests-before-after', 'probe links'], strong: false, without: { verdict: 'needs_person', missing: ['probe links'], strong: false } }
  ]);

  // Measure 3, the funnel, over all the history: 7 fix PRs (10 to 16), 6 with a link (not 16),
  // 3 kept (14 not labeled, 15 all rejected, 13 a deferral), 2 in a source (D-010, D-011), and
  // 1 flagged: D-011 at PR 4. D-010's PR 1 shows a test run, so it meets the policy.
  assert.deepEqual(result.funnel, {
    fix_prs: 7, szz_linked: 6, kept: 3, in_source: 2, flagged: 1,
    lost: { found_before_release: 0, no_link: 1, not_labeled: 1, all_rejected: 1, deferrals: 1, in_no_rule: 1, not_in_history: 0, meets_policy: 1 },
    unflagged: ['D-010']
  });
});

test('with no --from, the test set is every PR, and a rule that learned from it leaks', () => {
  const result = backtest({ lines: LINES, labels: LABELS, policy: POLICY });
  assert.equal(result.test_set, 16);
  assert.deepEqual(result.leaks, [{ rule: 'core', defects: ['D-010', 'D-011'] }]);
});

test('with no labels, no PR with an SZZ link is clean or counted', () => {
  const result = backtest({ lines: LINES, labels: [], policy: POLICY, from: new Date('2026-02-01T00:00:00Z') });
  assert.equal(result.counts.all.defects, 0);
  // 2, 3, 4, 5, 8 and 9 have links that nobody labeled.
  assert.equal(result.counts.all.unlabeled, 6);
  assert.equal(result.counts.all.clean, 9);
  assert.deepEqual(result.funnel.lost.not_labeled, 6);
});

test('an unknown requirement never makes a catch strong', () => {
  // PR 4 brought D-011, a "Cache key" bug, and core learned from that category. With no body,
  // its tests-before-after is unknown: still caught, but not strong.
  const lines = LINES.map((line) => (line.number === 4 ? { ...line, body: null } : line));
  const result = backtest({ lines, labels: LABELS, policy: POLICY, from: new Date('2026-02-01T00:00:00Z') });
  const pr4 = result.replayed.find((line) => line.pr === 4);
  assert.deepEqual([pr4.verdict, pr4.missing, pr4.strong], ['needs_person', ['tests-before-after'], false]);
  assert.deepEqual([result.counts.all.caught.k, result.counts.all.strong.k], [2, 0]);
});

test("a PR's exhibit wins over its body for the requirements they share", () => {
  const line = pr(7, { day: '02-07', files: ['src/e.js'], body: '## Evidence\n\nI looked at it.\n' });
  const exhibit = { requirements: [{ type: 'tests-before-after', params: {}, status: 'met' }] };
  const judged = judge(line, POLICY, exhibit);
  assert.equal(judged.verdict, 'meets_policy');
  assert.equal(judged.basis, 'exhibit');
  assert.deepEqual(judged.requirements.map((requirement) => [requirement.type, requirement.status, requirement.from]), [['tests-before-after', 'met', 'exhibit']]);
  const failed = judge(line, POLICY, { requirements: [{ type: 'tests-before-after', params: {}, status: 'failed' }] });
  assert.deepEqual(failed.missing, ['tests-before-after']);
});

test('a change to evidence.yml, or a change no rule covers, is needs_person, as in exhibit check', () => {
  assert.deepEqual(judge(pr(20, { day: '03-01', files: ['evidence.yml'], body: TESTS }), POLICY, null).missing, ['policy-change']);
  const noDefault = parsePolicy('version: 3\nkinds:\n  core:\n    match: ["src/**"]\n    risk: high\n    needs: []\n');
  assert.deepEqual(judge(pr(21, { day: '03-01', files: ['other.txt'], body: TESTS }), noDefault, null).missing, ['no-rule']);
});

test('evidenceSection reads the sections whose heading starts with evidence, up to the next heading of its level', () => {
  assert.equal(evidenceSection(null), null);
  assert.equal(evidenceSection('## Why\n\nBecause.\n'), null);
  const body = '## Why\nno npm test here\n## Evidence from a real run\nran npm test\n### Detail\nmore\n```\n# not a heading\n```\n## Blast radius\nnone\n# EVIDENCE\nlast\n';
  assert.equal(evidenceSection(body), 'ran npm test\n### Detail\nmore\n```\n# not a heading\n```\nlast\n');
});

test('a short fence inside a longer fence does not end it, so a # line in it is no heading (spec 9.9)', () => {
  const body = '## Evidence\n````md\n```\n## Not a heading\n```\n````\nnpm test passes\n## Blast radius\nnone\n';
  const section = evidenceSection(body);
  assert.equal(section, '````md\n```\n## Not a heading\n```\n````\nnpm test passes');
  assert.equal(bodyStatus({ type: 'tests-before-after', params: {} }, section), 'met');
  // A ~~~ line does not close a backtick fence, and a fence line with text after it does not close one.
  // A backtick run with a backtick after it is inline code, not a fence, so the next heading still ends the section.
  assert.equal(evidenceSection('## Evidence\n```npm test``` ran\n## Next\nx\n'), '```npm test``` ran');
  // A closing fence may have spaces after it.
  assert.equal(evidenceSection('## Evidence\n```\n## x\n```   \nnpm test\n## Next\n'), '```\n## x\n```   \nnpm test');
  assert.equal(evidenceSection('## Evidence\n```\n~~~\n## x\n``` not a close\n## y\n```\nnpm test\n'), '```\n~~~\n## x\n``` not a close\n## y\n```\nnpm test\n');
});

test('bodyStatus maps a section to met, missing or unknown for each type of requirement', () => {
  const tests = { type: 'tests-before-after', params: {} };
  assert.equal(bodyStatus(tests, 'Ran `node --test` and all pass.'), 'met');
  assert.equal(bodyStatus(tests, 'Ran make check.', { test_command: 'make check' }), 'met');
  assert.equal(bodyStatus(tests, 'Looked at it.'), 'missing');
  const failing = { type: 'failing-before', params: {} };
  assert.equal(bodyStatus(failing, '- With the old code the test fails. Before: no second nudge.\n'), 'met');
  assert.equal(bodyStatus(failing, 'The test failed.\nIt passed before.'), 'missing');
  const mutation = { type: 'mutation', params: { min: 0.8 } };
  assert.equal(bodyStatus(mutation, 'Stryker: 85% of mutants killed.'), 'met');
  assert.equal(bodyStatus(mutation, 'Mutation score 70%.'), 'missing');
  assert.equal(bodyStatus(mutation, 'I ran mutation testing.'), 'unknown');
  assert.equal(bodyStatus(mutation, 'Mutation score went from 40% to 90%.'), 'met');
  assert.equal(bodyStatus(mutation, 'Mutation score went from 40% to 60%.'), 'missing');
  assert.equal(bodyStatus(mutation, 'npm test passes.'), 'missing');
  const probe = { type: 'probe', params: { name: 'manual', run: 'npm ci && node relay/test/run.js relay/test/manual.test.js' } };
  assert.equal(bodyStatus(probe, 'Ran `node relay/test/run.js relay/test/manual.test.js`: clean.'), 'met');
  assert.equal(bodyStatus(probe, 'Checked the manual by hand.'), 'missing');
});

// Ticket 363: the rules read real PR bodies, so prose must not count as a claim, and the common
// ways that real bodies say "it failed before" must count.
test('bodyStatus does not count a command or a failure that a "not" or "no" denies', () => {
  const tests = { type: 'tests-before-after', params: {} };
  assert.equal(bodyStatus(tests, 'I did not run pytest.'), 'missing');
  assert.equal(bodyStatus(tests, "I didn't run npm test, and never ran go test."), 'missing');
  assert.equal(bodyStatus(tests, 'I did not run the browser tests. npm test: 40 of 40 pass.'), 'met');
  assert.equal(bodyStatus(tests, 'Not checked by hand, but npm test passes.'), 'met');
  // A command must stand as whole words.
  assert.equal(bodyStatus(tests, 'Ran pytests.py by hand.'), 'missing');
  assert.equal(bodyStatus(tests, 'Ran make checker.', { test_command: 'make check' }), 'missing');
  assert.equal(bodyStatus(tests, 'npm run test:browser: 28 of 28 pass.'), 'met');
  const probe = { type: 'probe', params: { name: 'app', run: 'cd app && make' } };
  assert.equal(bodyStatus(probe, 'We did not make any probe run.'), 'missing');
  assert.equal(bodyStatus(probe, 'The remake script is new.'), 'missing');
  assert.equal(bodyStatus(probe, 'Ran `make`: built clean.'), 'met');
  const failing = { type: 'failing-before', params: {} };
  assert.equal(bodyStatus(failing, 'No test failed before or after.'), 'missing');
  assert.equal(bodyStatus(failing, 'It never failed before the change.'), 'missing');
  assert.equal(bodyStatus(failing, 'Nothing changed, and before the change no test failed.'), 'missing');
});

test('bodyStatus counts the ways real bodies say a test failed before the change', () => {
  const failing = { type: 'failing-before', params: {} };
  assert.equal(bodyStatus(failing, 'The test shows a failure before the fix.'), 'met');
  assert.equal(bodyStatus(failing, 'On main it fails: radius 7.0.'), 'met');
  assert.equal(bodyStatus(failing, 'It fails on main ("Activity is not on the Floor").'), 'met');
  assert.equal(bodyStatus(failing, 'With the old relay/autopilot.js put back, it fails at the first step.'), 'met');
  assert.equal(bodyStatus(failing, 'The new assertion fails without the code it guards.'), 'met');
  assert.equal(bodyStatus(failing, 'Red first: I ran the new test. It failed on the first case.'), 'met');
  assert.equal(bodyStatus(failing, 'Before the change, the first case timed out waiting for the prompt.'), 'met');
  // "red" must be the word, and a pass on the old code is no failure.
  assert.equal(bodyStatus(failing, 'The red bar is gone. The new test also passes on main.'), 'missing');
  assert.equal(bodyStatus(failing, 'npm test passes without failures.'), 'missing');
  // From PR 98 and PR 100 of the Building58 history: a count of 0, and a before word in a test's name.
  assert.equal(bodyStatus(failing, '`npm test`: exit 0, every file 0 fail (one file skips 2 tests, as on main).'), 'missing');
  assert.equal(bodyStatus(failing, 'With both opened by hand, the test fails at "the old Lead".'), 'missing');
  assert.equal(bodyStatus(failing, 'I ran both against main and both failed.'), 'met');
});

test('share gives k of n with its 95% interval, and null for n = 0', () => {
  assert.equal(share(0, 0), null);
  const { k, n, rate, low, high } = share(2, 3);
  assert.deepEqual([k, n, rate], [2, 3, 2 / 3]);
  assert.ok(low > 0.09 && low < 0.1 && high > 0.99 && high < 1);
});

test('the report shows the funnel first, the leak, the counts with and without it, and each defect', () => {
  const result = backtest({ lines: LINES, labels: LABELS, policy: POLICY, from: new Date('2026-02-01T00:00:00Z') });
  const { markdown, html } = buildBacktestReport(result, { repo: 'acme/widgets', fromText: '2026-02-01' });
  const firstHeading = markdown.split('\n').filter((line) => line.startsWith('## '))[0];
  assert.equal(firstHeading, '## Defects left at each step');
  assert.match(markdown, /- Fix PRs with an SZZ link: 6 \(1 fix PR had no SZZ link\)/);
  assert.match(markdown, /- Defects with a link that a person kept: 3 \(1 defect is not labeled yet, 1 had every link rejected, 1 is a deferral\)/);
  assert.match(markdown, /- core: D-011/);
  assert.match(markdown, /\| core \| 11 \| 3 \| 2 of 3, 67% \(9% to 99%\) \|/);
  assert.match(markdown, /Without the rules that leak:/);
  assert.match(markdown, /- D-011 \(Cache key\), introducing PR 4: needs\\_person, caught\. Missing: tests-before-after\. A strong catch\. Without the rules that leak: needs\\_person, caught\. Missing: tests-before-after\. Not a strong catch\./);
  assert.match(html, /<td>core<\/td><td>11<\/td>/);
  assert.match(html, /Content-Security-Policy/);
});
