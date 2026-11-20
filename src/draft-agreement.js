// How often the person keeps Claude's draft unchanged (spec 9.11). The share measures the drafter,
// so the person can decide how far to trust the drafts. It is worked out from `labeled_by` and
// `claude_draft` in labels lines alone, so it is the same each time it is worked out.
import { clopperPearson } from './interval.js';

// With fewer drafts than this, the kept share is weak.
export const FEW_DRAFTS = 10;

/**
 * Counts Claude's drafts in `lines`, which are labels lines (spec 8.4). A line has a draft when it
 * has `claude_draft`. The draft was kept when the line is claude_draft_confirmed, edited when it
 * is claude_draft_edited, and replaced when it is person: the person threw it away with t.
 *
 * Returns { shown, kept, edited, replaced, kept_share }. `kept_share` is null with no drafts.
 * Otherwise it is { kept, n, rate, low, high, weak }: low and high are the 95% interval.
 */
export function draftAgreement(lines) {
  const drafted = lines.filter((line) => line.claude_draft !== undefined);
  const count = (labeledBy) => drafted.filter((line) => line.labeled_by === labeledBy).length;
  const shown = drafted.length;
  const kept = count('claude_draft_confirmed');
  const agreement = { shown, kept, edited: count('claude_draft_edited'), replaced: count('person'), kept_share: null };
  if (shown === 0) return agreement;
  const { low, high } = clopperPearson(kept, shown);
  return { ...agreement, kept_share: { kept, n: shown, rate: kept / shown, low, high, weak: shown < FEW_DRAFTS } };
}

// The counts in plain words. `where` says which labels they count, such as "in this run".
export function draftAgreementText(agreement, where) {
  const { shown, kept, edited, replaced, kept_share: share } = agreement;
  if (share === null) return `Claude's drafts ${where}: none, so there is no kept share yet.`;
  const percent = (value) => `${Math.round(value * 100)}%`;
  const weak = share.weak ? ` With fewer than ${FEW_DRAFTS} drafts, this number is weak.` : '';
  return `Claude's drafts ${where}: ${shown} shown. ${kept} kept unchanged, ${edited} edited, ${replaced} replaced. ` +
    `The person kept ${percent(share.rate)} of the drafts unchanged (${share.kept} of ${share.n}, 95% interval ${percent(share.low)} to ${percent(share.high)}).${weak}`;
}
