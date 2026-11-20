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

test('a list item or a thematic break right after a quote line ends the quote', () => {
  assert.equal(commentVerdict('> nit: foo\n- Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> quote\n* list\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> quote\n1. Verdict: merge'), 'merge');
  assert.equal(commentVerdict('> quote\n---\nVerdict: fix'), 'fix');
  // A line that starts with # but is not a heading stays in the quote, as markdown shows it.
  assert.equal(commentVerdict('> Thanks.\n#123 is related. Verdict: fix'), null);
  // A thematic break needs three of the same mark. GitHub keeps "-*-" in the quote.
  assert.equal(commentVerdict('> quote\n-*-\nVerdict: fix'), null);
  assert.equal(commentVerdict('> quote\n- - -\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> quote\n_ _ _\nVerdict: fix'), 'fix');
});

test('a hyphen verdict in a list item counts', () => {
  assert.equal(commentVerdict('- Verdict - fix'), 'fix');
  assert.equal(commentVerdict('1. Verdict - merge'), 'merge');
  assert.equal(commentVerdict('- **Verdict** - fix'), 'fix');
  assert.equal(commentVerdict('2) Verdict - fix'), 'fix');
  // A hyphen counts only when the phrase starts the line, so a heading with more words before it is not a verdict.
  assert.equal(commentVerdict('## Code review of b8ebe79 - merge'), null);
});

test('a nested quote inside an alert box is still a quote', () => {
  assert.equal(commentVerdict('> [!NOTE]\n> ok\n> > Verdict: fix'), null);
  assert.equal(quotedVerdict('> [!NOTE]\n> ok\n> > Verdict: fix'), 'fix');
});

test('a line right after a nested quote in an alert box stays in the nested quote', () => {
  // GitHub shows "Verdict: fix" in the nested quote here, with or without the ">".
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n> Verdict: fix'), null);
  assert.equal(quotedVerdict('> [!NOTE]\n> > quoted\n> Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\nVerdict: fix'), null);
  // A blank line, a heading or a list item in the alert box ends the nested quote.
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n>\n> Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n> # Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n> - Verdict: fix'), 'fix');
});

test('a lazy line goes on a quote only when the quote ends in a paragraph', () => {
  // GitHub shows "Verdict: fix" outside the quote here, because the quote ends in a blank quote
  // line, a heading or a thematic break.
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n> >\n> Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> > # Quoted heading\n> Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> > ---\n> Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> # Quoted heading\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> quoted\n>\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> ---\nVerdict: fix'), 'fix');
  // A list item with text is a paragraph, so the line stays in the quote.
  assert.equal(commentVerdict('> - item\nVerdict: fix'), null);
  assert.equal(commentVerdict('> [!NOTE]\n> > - item\n> Verdict: fix'), null);
  // A "> >" line is in the nested quote, even after a blank "> >" line.
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n> >\n> > Verdict: fix'), null);
  // A backtick fence has no backtick after its marks, so "```x```" is inline code in the text.
  assert.equal(commentVerdict('> ```x``` is a quoted word\nVerdict: fix'), null);
  assert.equal(commentVerdict('> [!NOTE]\n> > ```x``` said\n> Verdict: fix'), null);
  assert.equal(commentVerdict('> quoted\n```x``` Verdict: fix'), null);
  assert.equal(commentVerdict('> ```js\n> code\n> ```\nVerdict: fix'), 'fix');
  // A fence may have more than three backticks.
  assert.equal(commentVerdict('> ````\n> code\n> ````\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> ````js\n> code\n> ````\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> > ````\n> > code\n> > ````\n> Verdict: fix'), 'fix');
});

test('a lazy line does not go on a quote that ends in code, a setext heading or an empty list item', () => {
  // GitHub shows "Verdict: fix" outside the quote here, because a lazy line needs an open
  // paragraph, and the quote ends in code, a heading or an empty list item.
  assert.equal(commentVerdict('> ```\n> code\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> ~~~\n> code\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('>     indented code\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> quoted\n> ===\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> quoted\n> --\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> -\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> 1.\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> > ```\n> > code\n> Verdict: fix'), 'fix');
  assert.equal(commentVerdict('> [!NOTE]\n> >     indented code\n> Verdict: fix'), 'fix');
  // A line of text after the code, or right under a line of text, is a paragraph again.
  assert.equal(commentVerdict('> ```\n> code\n> ```\n> text\nVerdict: fix'), null);
  assert.equal(commentVerdict('>     indented code\n> text\nVerdict: fix'), null);
  assert.equal(commentVerdict('> quoted\n>     more text\nVerdict: fix'), null);
  assert.equal(commentVerdict('> ===\nVerdict: fix'), null);
  assert.equal(commentVerdict('> quoted\n> *\nVerdict: fix'), null);
  // A line of "=" or "-" with fewer ">" than the text above it is lazy text, not a heading.
  assert.equal(commentVerdict('> > quoted\n> ===\nVerdict: fix'), null);
  assert.equal(commentVerdict('> > quoted\n> --\nVerdict: fix'), null);
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n> ===\n> Verdict: fix'), null);
  assert.equal(commentVerdict('> > quoted\n>     more\nVerdict: fix'), null);
  // But an empty list item with fewer ">" still ends the paragraph.
  assert.equal(commentVerdict('> > quoted\n> -\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> > quoted\n> *\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> > quoted\n> 1.\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> - item\n> -\nVerdict: fix'), 'fix');
  // A lazy line stays in the nested quote, so a "=" or "-" line after it is lazy text too.
  assert.equal(commentVerdict('> > quoted\n> more\n> ===\nVerdict: fix'), null);
  assert.equal(commentVerdict('> > quoted\n> more\n> --\nVerdict: fix'), null);
  assert.equal(commentVerdict('> [!NOTE]\n> > quoted\n> more\n> ===\n> Verdict: fix'), null);
  assert.equal(commentVerdict('> > quoted\n> more\n> -\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> > > quoted\n> > ===\nVerdict: fix'), null);
  // Back at the paragraph's own count of ">", a "=" line is a setext underline again.
  assert.equal(commentVerdict('> > quoted\n> more\n> > ===\nVerdict: fix'), 'fix');
  assert.equal(commentVerdict('> > quoted\n> more\n>     code\nVerdict: fix'), null);
  // One tab after ">" does not reach four columns, so the line is text, not code.
  assert.equal(commentVerdict('>\tquoted\nVerdict: fix'), null);
  assert.equal(commentVerdict('> \tquoted\nVerdict: fix'), null);
});

test('a line that starts with inline code is text, not a code fence', () => {
  // A backtick fence has no backtick after its marks, so the next line is a quote, not code.
  assert.equal(commentVerdict('```x``` said\n> Verdict: fix'), null);
  assert.equal(quotedVerdict('```x``` said\n> Verdict: fix'), 'fix');
});
