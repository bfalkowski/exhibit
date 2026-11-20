import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkLabelLine } from '../src/labels.js';
import { draftAgreement, draftAgreementText } from '../src/draft-agreement.js';
import { clopperPearson } from '../src/interval.js';

// 12 labels: 7 drafts kept unchanged, 2 edited, 1 replaced, and 2 labels typed with no draft.
const fixture = readFileSync(new URL('./fixtures/labels/drafts.jsonl', import.meta.url), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} is not near ${expected}`);

test('the fixture labels fit the labels schema', () => {
  for (const line of fixture) assert.deepEqual(checkLabelLine(line), [], line.id);
});

test('a fixed labels file gives the counts, the kept share and its 95% interval', () => {
  const agreement = draftAgreement(fixture);
  assert.deepEqual({ ...agreement, kept_share: undefined }, { shown: 10, kept: 7, edited: 2, replaced: 1, kept_share: undefined });
  const { kept, n, rate, low, high, weak } = agreement.kept_share;
  assert.deepEqual([kept, n, weak], [7, 10, false]);
  near(rate, 0.7);
  // R: binom.test(7, 10)$conf.int gives 0.3475471 0.9332605.
  near(low, 0.3475471);
  near(high, 0.9332605);
  assert.equal(draftAgreementText(agreement, 'in the whole labels file'),
    'Claude\'s drafts in the whole labels file: 10 shown. 7 kept unchanged, 2 edited, 1 replaced. The person kept 70% of the drafts unchanged (7 of 10, 95% interval 34% to 94%).');
});

test('with fewer than 10 drafts the kept share is weak, and the text says so', () => {
  const agreement = draftAgreement(fixture.slice(0, 9));
  assert.equal(agreement.kept_share.n, 9);
  assert.equal(agreement.kept_share.weak, true);
  assert.match(draftAgreementText(agreement, 'in this run'), /\(7 of 9, 95% interval .*\)\. With fewer than 10 drafts, this number is weak\.$/);
});

test('a labels file with no Claude drafts says there are none, and does not show 0%', () => {
  const agreement = draftAgreement(fixture.filter((line) => line.claude_draft === undefined));
  assert.deepEqual(agreement, { shown: 0, kept: 0, edited: 0, replaced: 0, kept_share: null });
  const text = draftAgreementText(agreement, 'in the whole labels file');
  assert.equal(text, 'Claude\'s drafts in the whole labels file: none, so there is no kept share yet.');
  assert.doesNotMatch(text, /0%/);
});

test('the Clopper-Pearson interval matches known values at the edges', () => {
  // R: binom.test(0, 10) gives 0 to 0.3084971, and binom.test(10, 10) gives 0.6915029 to 1.
  const none = clopperPearson(0, 10);
  assert.equal(none.low, 0);
  near(none.high, 0.3084971);
  const all = clopperPearson(10, 10);
  near(all.low, 0.6915029);
  assert.equal(all.high, 1);
  // R: binom.test(1, 1) gives 0.025 to 1.
  near(clopperPearson(1, 1).low, 0.025);
});

test('the Clopper-Pearson interval stays right at the edges of a large n', () => {
  // R: binom.test(1, 200) gives 0.0001266 to 0.0275, and binom.test(199, 200) gives 0.9725 to 0.9999.
  // With 1 success the low end has a closed form, 1 - 0.975^(1/n), and with n - 1 the high end is
  // 0.975^(1/n).
  const one = clopperPearson(1, 200);
  near(one.low, 1 - 0.975 ** (1 / 200));
  assert.ok(Math.abs(one.high - 0.0275) < 1e-3, `${one.high}`);
  const most = clopperPearson(199, 200);
  assert.ok(Math.abs(most.low - 0.9725) < 1e-3, `${most.low}`);
  near(most.high, 0.975 ** (1 / 200));
  // R: binom.test(124, 125) gives a low end of about 0.956.
  assert.ok(Math.abs(clopperPearson(124, 125).low - 0.956) < 1e-3);
});

test('the Clopper-Pearson interval holds the share and is symmetric, for every k up to n = 300', () => {
  for (const n of [1, 2, 10, 131, 300]) {
    for (let k = 0; k <= n; k += 1) {
      const { low, high } = clopperPearson(k, n);
      const mirror = clopperPearson(n - k, n);
      assert.ok(low <= k / n && k / n <= high, `${k} of ${n}: ${low} to ${high}`);
      assert.ok(Math.abs(low - (1 - mirror.high)) < 1e-9, `${k} of ${n} is not the mirror of ${n - k} of ${n}`);
    }
  }
});
