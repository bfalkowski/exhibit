// Some rooms post their reviews as PR comments, not as GitHub reviews. A comment like that counts
// as a review when it gives a verdict, merge or fix (spec 8.3). Two forms give one:
//   - the word "verdict", then merge or fix: "Verdict: fix", "**Verdict:** merge", "verdict merge"
//   - a review heading with the verdict after the commit: "## Review of b8ebe79: merge"
// Spaces, colons, *, _, backticks and equals signs may come before the verdict, as in
// "Verdict: `merge`" or "Verdict = fix". A hyphen may come there too, as in "Verdict - fix", but
// only when the phrase starts the line. In prose a hyphen is often a dash, and "The verdict -
// merge - waits on CI." is not a verdict. The first verdict in the comment counts.
const PHRASE = String.raw`(?:verdict|review of [0-9a-f]{7,40})\b`;
const SEPARATOR = '[\\s:*_`=]*';
const SEPARATOR_WITH_HYPHEN = '[\\s:*_`=-]*';
const VERDICT = new RegExp(
  String.raw`^[ \t>#*_]*${PHRASE}${SEPARATOR_WITH_HYPHEN}(merge|fix)\b|\b${PHRASE}${SEPARATOR}(merge|fix)\b`,
  'im'
);

// A line that starts with ">", after any spaces, quotes another comment, such as the review a
// reply answers. Its verdict is not this comment's verdict. Markdown keeps a line that comes
// right after a quote line in the quote (a "lazy" line), until a blank line, a heading or a code
// fence ends it.
const QUOTE = /^\s*>/;
const ENDS_QUOTE = /^\s*(?:#|```|~~~)/;

// A GitHub alert box, such as "> [!IMPORTANT]", is a quote in markdown, but it holds the
// comment's own text. So the lines of an alert box are not quoted lines.
const ALERT = /^\s*>\s*\[!(?:note|tip|important|warning|caution)\]\s*$/i;

// A line in a code fence is code, not a quote, even when it starts with ">".
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// The room marks its own notes, and the Dev's replies to a review, with an HTML comment such as
// <!-- office:dev --> at the start. A Dev's reply often repeats the verdict ("Verdict merge, so I
// push nothing"), so a comment that starts with such a marker is never a review.
const ROOM_NOTE = /^\s*<!-- office:/;

// Splits the body into the comment's own lines and the lines that quote another comment.
function splitQuotes(body) {
  const own = [];
  const quoted = [];
  let fence = null;
  let quote = null;
  for (const line of body.split('\n')) {
    if (fence) {
      own.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (QUOTE.test(line)) {
      quote ??= ALERT.test(line) ? 'alert' : 'quote';
    } else if (quote && (line.trim() === '' || ENDS_QUOTE.test(line))) {
      quote = null;
    }
    if (quote === 'quote') {
      quoted.push(line);
      continue;
    }
    if (!quote) fence = line.match(FENCE)?.[1] ?? null;
    own.push(line);
  }
  return { own: own.join('\n'), quoted: quoted.join('\n') };
}

// A fence closes on a line of the same mark, at least as long, and nothing after it.
function closesFence(line, fence) {
  const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
  return close !== undefined && close[0] === fence[0] && close.length >= fence.length;
}

function verdictIn(text) {
  const match = text.match(VERDICT);
  return match ? (match[1] ?? match[2]).toLowerCase() : null;
}

// Returns 'merge' or 'fix' when the comment body is a review with that verdict, or null.
export function commentVerdict(body) {
  if (typeof body !== 'string' || ROOM_NOTE.test(body)) return null;
  return verdictIn(splitQuotes(body).own);
}

// Returns 'merge' or 'fix' when only a quoted line of the comment gives a verdict, or null. Such
// a comment is not a review. Most are replies that quote a review. But a review that quotes its
// own verdict is lost, so the caller warns about each one, and a person can check it.
export function quotedVerdict(body) {
  if (typeof body !== 'string' || ROOM_NOTE.test(body)) return null;
  const { own, quoted } = splitQuotes(body);
  return verdictIn(own) === null ? verdictIn(quoted) : null;
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

// Returns a warning for each comment whose only verdict is in a quoted line (spec 8.3).
export function quotedVerdictWarnings(number, comments) {
  const warnings = [];
  for (const comment of comments) {
    const verdict = quotedVerdict(comment.body);
    if (verdict === null) continue;
    const author = comment.user?.login ?? 'a deleted account';
    warnings.push(`PR ${number}: the comment by ${author} at ${comment.created_at} gives the verdict ${verdict} only in a quoted line, so it does not count as a review.`);
  }
  return warnings;
}
