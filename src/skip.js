// A skip is how a PR says why it was not verified, so that enforce mode lets it through
// (spec 9.8 and 10). It has two parts, and needs both: the PR label SKIP_LABEL, and a line in
// the PR body that starts with SKIP_LINE and gives a reason. A skip never changes the verdict.
// The exhibit records it apart from the verdict, so that every skip can be counted (spec 9.10).

export const SKIP_LABEL = 'exhibit-skip';
export const SKIP_LINE = 'Exhibit skip:';

// The reason from the first line of `body` that starts with SKIP_LINE and has text after it, or
// null. Spaces before SKIP_LINE are allowed, and the reason is trimmed.
export function skipReason(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith(SKIP_LINE)) continue;
    const reason = text.slice(SKIP_LINE.length).trim();
    if (reason !== '') return reason;
  }
  return null;
}

// The skip record for the exhibit, or null when the PR has neither part. `pr` holds the PR's
// labels and body. `labelAddedBy()` asks the forge who added the label, and is called only when
// the label is there. `head` is the head commit that the check ran on. The label and the body
// line stay on the PR after a push, so a skip also covers later commits until someone removes
// the label.
//
// `status` says which parts are there: `recorded` for both, `no-reason` for the label alone,
// `no-label` for the reason alone. Only `recorded` is a skip. The other two are kept, so the
// summary says what is missing.
export async function readSkip(pr, { head, labelAddedBy }) {
  const labelled = (pr.labels ?? []).includes(SKIP_LABEL);
  const reason = skipReason(pr.body);
  if (!labelled && reason === null) return null;
  const by = labelled ? await labelAddedBy() : null;
  const status = !labelled ? 'no-label' : reason === null ? 'no-reason' : 'recorded';
  return { status, by, reason, head };
}

// True when the skip lets the PR through in enforce mode: a full skip on a needs_person verdict.
// A skip never lets an error through, because then Exhibit itself failed.
export function skipApplies(exhibit) {
  return exhibit.verdict === 'needs_person' && exhibit.skip?.status === 'recorded';
}

// The lines about the skip for summary.md and the PR comment, or none when there is no skip.
// `enforce` is false in shadow mode. `quote` formats the reason for the place it goes.
export function describeSkip(exhibit, { enforce, quote = (text) => text }) {
  const skip = exhibit.skip;
  if (!skip) return [];
  if (skip.status === 'no-reason') {
    return [`The PR has the label ${SKIP_LABEL}, but its body has no line that starts with "${SKIP_LINE}" and gives a reason. A label with no reason is not a skip, so it changes nothing. Add the line to the PR body to skip.`];
  }
  if (skip.status === 'no-label') {
    return [`The PR body says why it is skipped, but the PR does not have the label ${SKIP_LABEL}. A reason with no label is not a skip, so it changes nothing. Add the label to skip.`];
  }
  const by = skip.by === null ? 'someone the forge does not name' : skip.by;
  const lines = [`Skip: the label ${SKIP_LABEL} was added by ${by}, at head commit ${skip.head.slice(0, 7)}. Reason: ${quote(skip.reason)}`];
  if (!enforce) lines.push('Shadow mode, so the skip changes nothing. It is recorded and counted.');
  else if (exhibit.verdict === 'needs_person') lines.push('The verdict stays needs_person, but the skip lets the PR through. It is recorded and counted.');
  else if (exhibit.verdict === 'error') lines.push('A skip does not let an error through: Exhibit itself failed, so the check still fails.');
  else lines.push('The verdict is meets_policy, so the skip was not needed. It is recorded and counted.');
  return lines;
}
