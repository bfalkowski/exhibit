// Deferrals (spec 8.4). Some fixes close a finding that a reviewer saw and left for a later
// ticket, such as "Follow-ups from the review of PR 46". That is a deferral, not an escaped
// defect: the review worked, and a person chose to fix it later. exhibit label proposes
// known_at_review: true for such a fix, and the person confirms or changes it.

// A PR number, written as "PR 46", "PR #46", "pull request 46" or "#46". Group 1 is the number.
const PR = String.raw`(?:(?:PR|pull request)\s*#?|#)(\d+)`;
const FOLLOW_UPS = String.raw`follow[- ]?ups?`;

// The wordings that say a fix follows up the review of a PR. Only these and nothing else: other
// wording gives no proposal, and the person can still set known_at_review by hand.
export const DEFERRAL_PATTERNS = [
  // "Follow-ups from the review of PR 46", "Follow-up to finding 1 in the review of PR #46",
  // "Follow-ups from the T-204 review of PR 46": at most two words between "the" and "review".
  new RegExp(String.raw`\b${FOLLOW_UPS}\s+(?:from|to|for|of|on)\s+(?:findings?\s+[\d, and]+?\s+(?:in|from|of)\s+)?(?:the\s+)?(?:[\w-]+\s+){0,2}?review\s+(?:of|on|for)\s+${PR}\b`, 'i'),
  // "Follows up the review of PR 46", "Following up on the review of PR 46"
  new RegExp(String.raw`\bfollow(?:s|ing|ed)?\s+up\s+(?:on\s+|to\s+)?(?:the\s+)?review\s+(?:of|on|for)\s+${PR}\b`, 'i'),
  // "Review follow-ups for PR 46"
  new RegExp(String.raw`\breview\s+${FOLLOW_UPS}\s+(?:for|from|on|of)\s+${PR}\b`, 'i'),
  // "Follow-ups from PR 46 review", "Follow-up to PR 46 (T-232), review finding 1": the word
  // "review" within 40 characters after the PR number.
  new RegExp(String.raw`\b${FOLLOW_UPS}\s+(?:from|to|for|of|on)\s+${PR}\b[^\r\n]{0,40}?\breview\b`, 'i')
];

// GitHub's closing words, before "#N" in a PR body: close, closes, closed, fix, fixes, fixed,
// resolve, resolves, resolved. A closing word for an issue in another repo ("owner/repo#N") is
// left out, because Exhibit reads issues of this repo only.
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi;

// The numbers of the issues that a PR body closes with closing words, in the order they come.
export function closingIssues(body) {
  if (!body) return [];
  return [...new Set([...body.matchAll(CLOSING)].map((match) => Number(match[1])))];
}

/**
 * Proposes known_at_review for one escaped defect. `fix` is its fix PR, with `title` and `body`.
 * `blamed` are the PRs that SZZ linked to it. `issues` are the issues that the fix PR closes,
 * each with `number`, `title` and `body`.
 *
 * Returns { known_at_review: true, pr, where, sentence } when the fix PR title or body, or a
 * linked issue's title or body, says it follows up the review of PR `pr`, and SZZ blamed that PR.
 * `sentence` is the sentence that matched, and `where` says where it is. Otherwise it returns
 * { known_at_review: null }: Exhibit does not know.
 */
export function proposeKnownAtReview({ fix, blamed, issues = [] }) {
  const places = [
    ['the fix PR title', fix.title],
    ['the fix PR body', fix.body],
    ...issues.flatMap((issue) => [
      [`the title of issue ${issue.number} that the fix PR closes`, issue.title],
      [`the body of issue ${issue.number} that the fix PR closes`, issue.body]
    ])
  ];
  for (const [where, text] of places) {
    for (const sentence of sentences(text)) {
      for (const pattern of DEFERRAL_PATTERNS) {
        const pr = Number(pattern.exec(sentence)?.[1]);
        if (blamed.includes(pr)) return { known_at_review: true, pr, where, sentence };
      }
    }
  }
  return { known_at_review: null };
}

// The sentences of `text`: split at line breaks, and after a full stop, question mark or
// exclamation mark that comes before a space.
function sentences(text) {
  if (!text) return [];
  return text.split(/\r?\n|(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== '');
}
