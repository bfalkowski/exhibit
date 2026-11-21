import { VERDICT_WORDS } from './check.js';
import { describeSkip } from './skip.js';

// The PR comment that `exhibit publish --comment` posts (spec 9.12). A reviewer reads the verdict
// and the gaps on the PR, without opening CI.

// The first line of the comment. It is hidden on the PR page. Exhibit finds its own comment again
// by this line, and only in a comment that the same account wrote.
export const COMMENT_MARKER = '<!-- exhibit:pr-summary -->';

// The comment shows at most this many gaps, then a count of the rest, so it stays short.
export const MOST_GAPS_SHOWN = 10;

// The comment text for an exhibit: the verdict, the head commit, the kinds and the risk, each gap
// with how to fix it, and where the full exhibit is. A skip, or half of one, gets a line of its
// own after the verdict. `enforce` false is shadow mode, and the
// comment says that nothing waits on the verdict. `link` is the web page of the full exhibit, or
// null. `where` names the stored file, for the line when there is no link.
export function renderComment(exhibit, { enforce, link, where }) {
  const c = exhibit.classification;
  const lines = [COMMENT_MARKER, `### Exhibit: ${VERDICT_WORDS[exhibit.verdict]}`, ''];
  lines.push(`Verdict: **${exhibit.verdict}** at head commit \`${exhibit.head.slice(0, 7)}\`.`);
  if (!enforce) lines.push('', 'Shadow mode: nothing waits on this.');
  lines.push('');
  const skip = describeSkip(exhibit, { enforce, quote: codeSpan });
  if (skip.length > 0) lines.push(skip.join(' '), '');
  const noRule = exhibit.gaps.some((gap) => gap.type === 'no-rule');
  const kinds = c.kinds.length > 0 ? c.kinds.join(', ') : `none matched, so ${noRule ? 'no rule covers this change' : 'the default rules apply'}`;
  lines.push(`Kinds of change: ${kinds}. Risk: ${c.risk}.`, '');

  if (exhibit.gaps.length === 0) {
    lines.push('No gaps. Every requirement is met.');
  } else {
    lines.push(`**Gaps (${exhibit.gaps.length})**`, '');
    exhibit.gaps.slice(0, MOST_GAPS_SHOWN).forEach((gap, i) => {
      const name = gap.name ? ` ${gap.name}` : '';
      lines.push(`${i + 1}. ${gap.type}${name}: ${gap.status}. ${oneLine(gap.how_to_fix)}`);
    });
    const rest = exhibit.gaps.length - MOST_GAPS_SHOWN;
    if (rest > 0) lines.push('', `And ${rest} more ${rest === 1 ? 'gap' : 'gaps'}. The full exhibit lists them all.`);
  }
  lines.push('');
  lines.push(link === null ? `The full exhibit is stored at ${where}.` : `[The full exhibit](${link})`);
  return lines.join('\n') + '\n';
}

// A gap's text on one line, so it stays inside its list item.
function oneLine(text) {
  return text.replace(/\s*\n\s*/g, ' ');
}

// `text` as inline code, so that a reason from the PR body cannot add markup or mention anyone in
// a comment that the token's account posts. The run of backticks around it is longer than any run
// inside it, as Markdown asks.
function codeSpan(text) {
  const flat = oneLine(text);
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}
