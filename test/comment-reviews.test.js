import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentVerdict, quotedVerdict } from '../src/comment-reviews.js';

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

test('backticks, hyphens and equals signs may come between the word verdict and the verdict', () => {
  assert.equal(commentVerdict('Verdict: `merge`\n\nNothing blocks.'), 'merge');
  assert.equal(commentVerdict('Verdict - fix\n\nThe test fails.'), 'fix');
  assert.equal(commentVerdict('Verdict = fix\n\nThe test fails.'), 'fix');
  assert.equal(commentVerdict('## Review of b8ebe79 - `merge`\n\nNothing blocks.'), 'merge');
});

test('a verdict in a quoted line does not count', () => {
  assert.equal(commentVerdict('> Verdict: fix\n\nFixed in abc1234.'), null);
  assert.equal(commentVerdict('  > ## Review of b8ebe79: fix\n\nFixed in abc1234.'), null);
  assert.equal(commentVerdict('> Verdict: fix\n\nI checked it again. Verdict: merge.'), 'merge');
});

test('a GitHub alert box is a quote, but it is the comment\'s own text, so its verdict counts', () => {
  assert.equal(commentVerdict('> [!IMPORTANT]\n> Verdict: fix\n\nThe test fails.'), 'fix');
  assert.equal(commentVerdict('> [!note]\n> Verdict: merge'), 'merge');
  // A blank line ends the alert box. The quote after it is a quote of another comment.
  assert.equal(commentVerdict('> [!NOTE]\n> Thanks.\n\n> Verdict: fix\n\nFixed in abc1234.'), null);
});

test('quotedVerdict finds a verdict that only a quoted line gives, so the caller can warn', () => {
  assert.equal(quotedVerdict('> Verdict: fix\n\nFixed in abc1234.'), 'fix');
  assert.equal(quotedVerdict('> Verdict: fix\n\nI checked it again. Verdict: merge.'), null);
  assert.equal(quotedVerdict('> [!IMPORTANT]\n> Verdict: fix'), null);
  assert.equal(quotedVerdict('<!-- office:dev -->\n> Verdict: fix\n\nFixed.'), null);
  assert.equal(quotedVerdict('No verdict here.'), null);
  assert.equal(quotedVerdict(null), null);
});

test('a hyphen counts between the word verdict and the verdict only at the start of a line', () => {
  assert.equal(commentVerdict('The verdict - merge - waits on CI.'), null);
  assert.equal(commentVerdict('We wait on the review of b8ebe79 - fix first.'), null);
  assert.equal(commentVerdict('  **Verdict** - fix\n\nThe test fails.'), 'fix');
  assert.equal(commentVerdict('Notes first.\n### Verdict - merge'), 'merge');
});

test('a line right after a quote line, with no blank line between, is still in the quote', () => {
  assert.equal(commentVerdict('> Thanks for the review.\nVerdict: fix\n\nFixed in abc1234.'), null);
  // A heading or a code fence ends the quote, so this heading is the comment's own text.
  assert.equal(commentVerdict('> Thanks for the review.\n## Review of b8ebe79: merge'), 'merge');
});

test('a line inside a code fence is not a quote, even when it starts with >', () => {
  assert.equal(commentVerdict('```\n> Verdict: fix\n```'), 'fix');
  assert.equal(commentVerdict('~~~text\n> Verdict: merge\n~~~\n'), 'merge');
});
