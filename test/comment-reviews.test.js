import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentVerdict } from '../src/comment-reviews.js';

// Each text below is the start of a real review or reply on bfalkowski/Building58, cut short.

test('a verdict line gives the verdict, wherever it is in the comment', () => {
  assert.equal(commentVerdict('Review of e5219fb. Verdict: merge. Nothing blocks.\n\nThe code does what the description says.'), 'merge');
  assert.equal(commentVerdict('Review of 1ef0575. Verdict: fix (one blocking finding).\n\nWhat I ran: npm test.'), 'fix');
  assert.equal(commentVerdict('## Review of 67cfbb2\n\nVerdict: merge. I found no bug.'), 'merge');
  assert.equal(commentVerdict('## Review: nothing blocks\n\nThe PR adds one test file.\n\nVerdict: merge.\n'), 'merge');
});

test('the verdict may have no colon, other case, or bold marks', () => {
  assert.equal(commentVerdict('## Review of d332462: verdict merge\n\nNothing blocks.'), 'merge');
  assert.equal(commentVerdict('**Verdict:** FIX\n\nOne finding blocks.'), 'fix');
});

test('a review heading with the verdict after the commit gives the verdict', () => {
  assert.equal(commentVerdict('## Review of b8ebe79: merge\n\nNothing blocks.'), 'merge');
  assert.equal(commentVerdict('## Review of 057f543: fix\n\nThe test fails.'), 'fix');
});

test('the first verdict in the comment counts', () => {
  assert.equal(commentVerdict('Verdict: fix.\n\nAn earlier review said verdict: merge, but this commit breaks paging.'), 'fix');
});

test('a comment that starts with an office marker is a room note, not a review', () => {
  assert.equal(commentVerdict('<!-- office:dev -->\nThanks, Jade. Verdict merge, so I push nothing.'), null);
  assert.equal(commentVerdict('  <!-- office:told-dev -->\nThe room told the Dev about 1 new comment. Verdict: fix'), null);
});

test('a comment with no verdict is not a review', () => {
  assert.equal(commentVerdict('CI note: the first run failed one browser test, then passed.'), null);
  assert.equal(commentVerdict('Review fixes are in e10c7b3. All ten findings from the code review are fixed.'), null);
  assert.equal(commentVerdict('Per the merge verdict, I am not pushing for these findings.'), null);
  assert.equal(commentVerdict('The verdict: mergeable later.'), null);
  assert.equal(commentVerdict(''), null);
  assert.equal(commentVerdict(null), null);
});
