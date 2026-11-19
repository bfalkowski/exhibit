// Some rooms post their reviews as PR comments, not as GitHub reviews. A comment like that counts
// as a review when it gives a verdict, merge or fix (spec 8.3). Two forms give one:
//   - the word "verdict", then merge or fix: "Verdict: fix", "**Verdict:** merge", "verdict merge"
//   - a review heading with the verdict after the commit: "## Review of b8ebe79: merge"
// The first verdict in the comment counts.
const VERDICT = /\bverdict\b[\s:*_]*(merge|fix)\b|\breview of [0-9a-f]{7,40}\b[\s:*_]*(merge|fix)\b/i;

// The room marks its own notes, and the Dev's replies to a review, with an HTML comment such as
// <!-- office:dev --> at the start. A Dev's reply often repeats the verdict ("Verdict merge, so I
// push nothing"), so a comment that starts with such a marker is never a review.
const ROOM_NOTE = /^\s*<!-- office:/;

// Returns 'merge' or 'fix' when the comment body is a review with that verdict, or null.
export function commentVerdict(body) {
  if (typeof body !== 'string' || ROOM_NOTE.test(body)) return null;
  const match = body.match(VERDICT);
  if (!match) return null;
  return (match[1] ?? match[2]).toLowerCase();
}

// Returns the history list entry for each comment that is a review, in the order of the comments.
// A fix verdict asks for changes, so it gets the state CHANGES_REQUESTED and counts as a round.
// A merge verdict gets the state APPROVED.
export function commentReviews(comments) {
  const reviews = [];
  for (const comment of comments) {
    const verdict = commentVerdict(comment.body);
    if (verdict === null) continue;
    reviews.push({
      state: verdict === 'fix' ? 'CHANGES_REQUESTED' : 'APPROVED',
      author: comment.user?.login ?? null,
      source: 'comment',
      at: comment.created_at
    });
  }
  return reviews;
}
