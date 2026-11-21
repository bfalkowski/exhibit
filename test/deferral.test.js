import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingIssues, DEFERRAL_PATTERNS, proposeKnownAtReview } from '../src/deferral.js';

const fix = (title, body = null) => ({ title, body });

test('a follow-up title that names the PR that SZZ blamed proposes true, with the sentence that matched', () => {
  assert.deepEqual(proposeKnownAtReview({ fix: fix('Follow-ups from the review of PR 46'), blamed: [46] }), {
    known_at_review: true,
    pr: 46,
    where: 'the fix PR title',
    sentence: 'Follow-ups from the review of PR 46'
  });
});

test('a follow-up title that names PR 46, when SZZ blamed only PR 50, does not propose true', () => {
  assert.deepEqual(proposeKnownAtReview({ fix: fix('Follow-ups from the review of PR 46'), blamed: [50] }), { known_at_review: null });
});

test('a fix with no follow-up sentence proposes null', () => {
  assert.deepEqual(proposeKnownAtReview({ fix: fix('Fix the discount math', 'The discount used the percent as money.'), blamed: [46] }), { known_at_review: null });
});

test('the body counts too, and only the sentence that matched is shown', () => {
  const body = 'This fixes the tax total. It follows up the review of PR #12, where the reviewer saw it.\n\nMore text.';
  assert.deepEqual(proposeKnownAtReview({ fix: fix('Fix tax total', body), blamed: [3, 12] }), {
    known_at_review: true,
    pr: 12,
    where: 'the fix PR body',
    sentence: 'It follows up the review of PR #12, where the reviewer saw it.'
  });
});

test('a linked issue counts, and is named', () => {
  const issues = [{ number: 80, title: 'Follow-ups from the review of PR 7', body: null }];
  assert.deepEqual(proposeKnownAtReview({ fix: fix('81: Small fixes'), blamed: [7], issues }), {
    known_at_review: true,
    pr: 7,
    where: 'the title of issue 80 that the fix PR closes',
    sentence: 'Follow-ups from the review of PR 7'
  });
});

test('the patterns match the close variants, and not other wording', () => {
  const matches = (text) => DEFERRAL_PATTERNS.some((pattern) => pattern.test(text));
  for (const text of [
    'Follow-ups from the review of PR 46',
    'Follow-up from review of PR 46',
    'follow up to the review of pull request #46',
    'Follow-ups for the review of #46',
    'Follows up the review of PR 46',
    'This follows up on the review of PR 46',
    'Following up the review of PR 46',
    'Review follow-ups for PR 46',
    'Follow-ups from PR 46 review',
    "Follow-ups from PR 46's review",
    'Follow-up to finding 1 in the review of PR #46 (T-250)',
    'Follow-ups from the T-204 review of PR 46',
    'Follow-up to PR 46 (T-232), review finding 1'
  ]) assert.ok(matches(text), text);
  for (const text of ['Fix the review page for PR 46', 'Review PR 46 again', 'Follow the steps in PR 46', 'Follow-up to PR 46: pin the first run after a settings change']) assert.ok(!matches(text), text);
});

test('closing words in the body name the issues the PR closes, in this repo only', () => {
  assert.deepEqual(closingIssues('Closes #80. Also fixes: #81, and resolved #82.\nSee #83. Fixes other/repo#84.'), [80, 81, 82]);
  assert.deepEqual(closingIssues(null), []);
});
