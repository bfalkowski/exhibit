import { REVERT_NOT_FOUND } from './szz.js';

// Builds the history report (spec 8.5): report.md and a self-contained report.html, from the
// history lines. Both files come from one list of blocks, so they always hold the same facts.

// Where each command writes its report (spec 8.5). Backtest has its own names, so a backtest
// run never writes over the history report.
export const HISTORY_REPORT = { markdown: '.exhibit/report.md', html: '.exhibit/report.html' };
export const BACKTEST_REPORT = { markdown: '.exhibit/backtest.md', html: '.exhibit/backtest.html' };

// The rule for weak history (spec 8.5). The history is weak when it has fewer than `minFixPrs`
// fix PRs, when SZZ linked none of them or did not run, when every linked defect is a deferral,
// or when fewer than half of the escaped defects have a link with a confidence of
// `strongConfidence` or more.
export const WEAK_HISTORY = { minFixPrs: 10, strongConfidence: 0.5 };

// The most lines the report shows for one link. history.jsonl has them all.
const LINES_SHOWN = 5;

// The labels file, as history read it, only to count (spec 8.5). `state` is 'none' when there is
// no file, 'read' with its `lines`, or 'unreadable' with the `problem`.
const NO_LABELS = { state: 'none' };

/**
 * Returns { markdown, html } for the history `lines` of `repo`.
 * `szzRan` is false when history ran outside a clone, so every szz is null.
 * `fixSignals` are the signals that marked the fix PRs, for the advice when there are none.
 * `labels` is the labels file, for the last steps of the funnel: see NO_LABELS.
 */
export function buildReport(lines, { repo, szzRan, fixSignals, labels = NO_LABELS }) {
  const blocks = reportBlocks(lines, { repo, szzRan, fixSignals, labels });
  const title = `Escaped defects in ${repo}`;
  return { markdown: toMarkdown(blocks), html: toHtml(title, blocks) };
}

// The escaped defects: the fix PRs that SZZ linked to at least one introducing PR, newest fix
// first. A fix whose tracker says the bug was found before release (classification.escaped is
// false) is not one. The report lists them, and `exhibit label` labels this same list.
export function escapedDefects(lines) {
  return lines.filter((line) => line.classification.fix && line.classification.escaped !== false && line.szz?.links.length > 0).sort(newestFirst);
}

// Says whether the tracker found the fix's bug before release, so it is no escaped defect.
const caughtBeforeRelease = (line) => line.classification.escaped === false;

// One escaped defect as plain text for a terminal, with the same facts as its part of the report.
// `lines` are all the history lines, for the titles of the introducing PRs.
export function defectText(fix, lines) {
  return toText(defectBlocks(fix, new Map(lines.map((line) => [line.number, line]))));
}

/**
 * The funnel (spec 8.5): how many defects are left at each step, so a reader sees where they drop
 * out. Returns { merged_prs, fix_prs, szz_linked, labeled, kept, labels }. `labeled` counts the
 * escaped defects with a line in the labels file, and `kept` those of them with at least one link
 * that the person kept. A label for a defect that is no longer in the history is not counted.
 * `szz_linked`, `labeled` and `kept` are null when SZZ did not run, and the last two are null when
 * there are no labels to count. `labels` is the state of the labels file.
 */
export function funnel(lines, { szzRan, labels = NO_LABELS }) {
  const defects = szzRan ? escapedDefects(lines) : [];
  const counts = { merged_prs: lines.length, fix_prs: lines.filter((line) => line.classification.fix).length, szz_linked: szzRan ? defects.length : null, labeled: null, kept: null, labels: labels.state };
  if (!szzRan || labels.state !== 'read') return counts;
  const fixPrs = new Set(defects.map((fix) => fix.number));
  // Each defect counts once, by its first line, as in exhibit label. A second line for the same
  // fix PR can come from a merge of two label files or a hand edit, and the schema allows it.
  const first = new Map();
  for (const label of labels.lines) if (fixPrs.has(label.fix_pr) && !first.has(label.fix_pr)) first.set(label.fix_pr, label);
  const labeled = [...first.values()];
  return { ...counts, labeled: labeled.length, kept: labeled.filter((label) => label.introducing_prs.length > 0).length };
}

function funnelBlocks(counts, labels) {
  const or = (count, why) => (count === null ? why : String(count));
  const noLabels = counts.szz_linked === null ? 'SZZ did not run' : labels.state === 'unreadable' ? 'the labels could not be read' : 'not labeled yet';
  const blocks = [heading(2, 'Defects left at each step'), list([
    item(`Merged PRs read: ${counts.merged_prs}`),
    item(`Fix PRs: ${counts.fix_prs}`),
    item(`Fix PRs with an SZZ link: ${or(counts.szz_linked, 'SZZ did not run')}`),
    item(`Defects labeled with exhibit label: ${or(counts.labeled, noLabels)}`),
    item(`Defects with at least one link that a person kept: ${or(counts.kept, noLabels)}`)
  ])];
  if (labels.state === 'unreadable') blocks.push(paragraph(`Exhibit could not read the labels, so it does not count them: ${labels.problem}`));
  return blocks;
}

function reportBlocks(lines, { repo, szzRan, fixSignals, labels }) {
  const byNumber = new Map(lines.map((line) => [line.number, line]));
  const fixes = lines.filter((line) => line.classification.fix).sort(newestFirst);
  const defects = szzRan ? escapedDefects(lines) : [];
  const caught = fixes.filter(caughtBeforeRelease);
  const noLink = szzRan ? fixes.filter((line) => !caughtBeforeRelease(line) && !(line.szz?.links.length > 0)) : [];
  const skipped = szzRan ? fixes.filter((line) => line.szz === null).length : 0;
  const deferredPrs = deferrals(labels);
  const deferred = defects.filter((fix) => deferredPrs.has(fix.number));
  // A deferral is no escaped defect, so the rule for weak history counts only the others.
  const escaped = defects.filter((fix) => !deferredPrs.has(fix.number));
  const strong = escaped.filter((line) => line.szz.links[0].confidence >= WEAK_HISTORY.strongConfidence).length;

  const blocks = [heading(1, `Escaped defects in ${repo}`)];
  blocks.push(paragraph(summary({ prs: lines.length, fixes: fixes.length, defects: defects.length, deferred: deferred.length, skipped, szzRan, repo })));
  blocks.push(...funnelBlocks(funnel(lines, { szzRan, labels }), labels));

  blocks.push(heading(2, 'How sure Exhibit is'));
  const reasons = weakReasons({ fixes: fixes.length, linked: defects.length, escaped: escaped.length, strong, szzRan, fixSignals });
  if (reasons.length > 0) {
    const lead = defects.length > 0 ? 'The history is weak, so read these links as leads, not answers.' : 'The history is weak, so Exhibit does not guess what got through.';
    blocks.push(paragraph(lead), list(reasons.map((reason) => item(reason))));
  } else {
    blocks.push(paragraph(
      `Exhibit is fairly sure of these links. The history has ${fixes.length} fix PRs, and ${strong} of the ${escaped.length} escaped defects ${strong === 1 ? 'has' : 'have'} a link that holds at least half of the fix's counted lines. ` +
      'SZZ is still a guess from git blame, so read the lines under each defect before you act on it.'
    ));
  }
  blocks.push(paragraph(
    `Exhibit calls the history weak when it has fewer than ${WEAK_HISTORY.minFixPrs} fix PRs, when SZZ links none of them or did not run, ` +
    `when every linked defect is a deferral, or when fewer than half of the escaped defects have a link with a confidence of ${WEAK_HISTORY.strongConfidence} or more.`
  ));

  if (escaped.length > 0) {
    blocks.push(heading(2, `Escaped defects (${escaped.length})`));
    for (const fix of escaped) blocks.push(...defectBlocks(fix, byNumber));
  }
  if (deferred.length > 0) {
    blocks.push(heading(2, `Deferred at review (${deferred.length})`));
    blocks.push(paragraph('For each of these, the label says review saw the bug and left it for a later ticket. That is a deferral: the review worked, and a person chose to fix it later. So it is not an escaped defect, and never a policy miss.'));
    for (const fix of deferred) blocks.push(...defectBlocks(fix, byNumber));
  }
  if (noLink.length > 0) {
    blocks.push(heading(2, `Fix PRs with no escaped defect found (${noLink.length})`));
    blocks.push(list(noLink.map((fix) => item(`PR ${fix.number} (${fix.title}): ${whyNoLink(fix)}`))));
  }
  if (caught.length > 0) {
    blocks.push(heading(2, `Fix PRs whose bug was found before release (${caught.length})`));
    blocks.push(paragraph('The tracker says where each bug was found, and these were found before release, so they are not escaped defects.'));
    blocks.push(list(caught.map((fix) => item(`PR ${fix.number} (${fix.title}): ${fix.classification.fix_signal}`))));
  }
  return blocks;
}

// The fix PRs whose label says review saw the bug and left it for a later ticket
// (known_at_review: true). Each fix PR counts by its first line, as in the funnel.
function deferrals(labels) {
  const first = new Map();
  if (labels.state === 'read') for (const label of labels.lines) if (!first.has(label.fix_pr)) first.set(label.fix_pr, label);
  return new Set([...first.values()].filter((label) => label.known_at_review === true).map((label) => label.fix_pr));
}

function summary({ prs, fixes, defects, deferred, skipped, szzRan, repo }) {
  const read = `Exhibit read ${prs} merged PRs.`;
  if (fixes === 0) return `${read} None of them is a fix PR, so there are no escaped defects to find.`;
  const counted = `${read} ${fixes === 1 ? '1 of them is a fix PR.' : `${fixes} of them are fix PRs.`}`;
  if (!szzRan) return `${counted} SZZ did not run, because history ran outside a clone of the repo. So this report cannot show escaped defects. Run exhibit history inside a clone of ${repo}.`;
  const skip = skipped > 0 ? ` SZZ skipped ${skipped} of them.` : '';
  if (defects === 0) return `${counted} SZZ linked none of the ${fixes} fix PRs to the PR that brought the bug.${skip}`;
  const linked = `${counted} SZZ linked ${defects} of them to the PRs that brought their bugs.`;
  if (deferred === 0) return `${linked} These are the escaped defects below.${skip}`;
  const left = defects - deferred;
  return `${linked} Review saw ${deferred} of them and left ${deferred === 1 ? 'it' : 'them'} for a later ticket, so ${left} ${left === 1 ? 'is an escaped defect' : 'are escaped defects'}.${skip}`;
}

// The reasons the history is weak, in plain words, or an empty list when it is not weak.
// `linked` counts the fix PRs with an SZZ link, and `escaped` those of them that are no deferral.
function weakReasons({ fixes, linked, escaped, strong, szzRan, fixSignals }) {
  if (fixes === 0) return [`There are no fix PRs. Check that the fix signals match how this repo marks a fix. They are now ${joinWords(fixSignals)}.`];
  const reasons = [];
  if (fixes < WEAK_HISTORY.minFixPrs) reasons.push(`Only ${fixes} fix ${fixes === 1 ? 'PR' : 'PRs'}. Exhibit needs at least ${WEAK_HISTORY.minFixPrs} to say how often bugs get through.`);
  if (!szzRan) reasons.push('SZZ did not run, so there are no links to judge.');
  else if (linked === 0) reasons.push('SZZ linked no fix PR to the PR that brought its bug.');
  else if (escaped === 0) reasons.push('Every linked defect is a deferral, so there are no escaped defects to judge.');
  else if (strong * 2 < escaped) reasons.push(`Only ${strong} of ${escaped} escaped defects ${strong === 1 ? 'has' : 'have'} a link that holds at least half of the fix's counted lines.`);
  return reasons;
}

function defectBlocks(fix, byNumber) {
  const { links, unlinked_lines: unlinked, blamed_commit: blamed } = fix.szz;
  const counted = links.reduce((sum, link) => sum + link.lines.length, 0) + unlinked.length;
  const items = links.map((link) => {
    const title = byNumber.get(link.pr)?.title;
    const name = title === undefined ? `Introducing PR ${link.pr}` : `Introducing PR ${link.pr}: ${title}`;
    const confidence = `confidence ${Math.round(link.confidence * 100)}%`;
    // A revert names the PR it reverts, so the revert is the evidence, in place of blame lines.
    if (link.found_by === 'revert') return item(`${name}, ${confidence}, evidence: revert. PR ${fix.number} reverts it.`);
    return item(`${name}, ${confidence} (${link.lines.length} of ${counted} counted lines)`, lineItems(link.lines));
  });
  if (unlinked.length > 0) items.push(item(`Lines from commits that are in no merged PR (${unlinked.length} of ${counted} counted lines)`, lineItems(unlinked)));
  const how = blamed === null
    ? paragraph(`Merged on ${fix.merged_at.slice(0, 10)}. It is a revert, so SZZ ran no git blame: the revert names the PR it takes back.`)
    : paragraph(`Merged on ${fix.merged_at.slice(0, 10)}. SZZ ran git blame on `, { code: blamed.slice(0, 7) }, ', the main branch just before the fix.');
  return [heading(3, `Fix PR ${fix.number}: ${fix.title}`), how, list(items)];
}

// One item for each line, with what git blame said about it under it.
function lineItems(lines) {
  const shown = lines.slice(0, LINES_SHOWN).map((line) => {
    const { blame } = line;
    const moved = blame.original_path !== line.path || blame.original_line !== line.line;
    const blameParts = [
      'blame: commit ', { code: blame.commit.slice(0, 7) },
      ` by ${blame.author ?? 'an unknown author'} on ${blame.author_time.slice(0, 10)}: ${blame.summary}`,
      ...(moved ? ['. It was first at ', { code: blame.original_path }, ` line ${blame.original_line}.`] : [])
    ];
    const text = line.text.trim();
    return item([{ code: line.path }, ` line ${line.line}: `, text === '' ? '(a blank line)' : { code: text }], [item(blameParts)]);
  });
  if (lines.length > LINES_SHOWN) shown.push(item(`and ${lines.length - LINES_SHOWN} more lines. .exhibit/history.jsonl has them all.`));
  return shown;
}

function whyNoLink(fix) {
  const { szz } = fix;
  if (szz === null) return 'SZZ skipped it. The warning from exhibit history says why.';
  if (szz.no_link_reason === REVERT_NOT_FOUND) return 'It is a revert, but Exhibit found no PR in this repo that it names.';
  if (szz.no_link_reason) return `SZZ dropped every line it changed: ${szz.no_link_reason}.`;
  if (szz.unlinked_lines.length > 0) return `SZZ found its ${szz.unlinked_lines.length} ${szz.unlinked_lines.length === 1 ? 'line' : 'lines'} only in commits that are in no merged PR.`;
  return 'SZZ found no line that it deleted or changed, so there was nothing to blame.';
}

const newestFirst = (a, b) => b.merged_at.localeCompare(a.merged_at) || b.number - a.number;

function joinWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// The blocks. Parts are plain strings, or { code } for code.
const toParts = (parts) => parts.flat();
const heading = (level, ...parts) => ({ type: 'heading', level, parts: toParts(parts) });
const paragraph = (...parts) => ({ type: 'paragraph', parts: toParts(parts) });
const list = (items) => ({ type: 'list', items });
const item = (parts, items = []) => ({ parts: toParts([parts]), items });

function toMarkdown(blocks) {
  const inline = (parts) => parts.map((part) => (typeof part === 'string' ? markdownText(part) : markdownCode(part.code))).join('');
  const listLines = (items, depth) => items.flatMap((entry) => [`${'  '.repeat(depth)}- ${inline(entry.parts)}`, ...listLines(entry.items, depth + 1)]);
  return blocks.map((block) => {
    if (block.type === 'heading') return `${'#'.repeat(block.level)} ${inline(block.parts)}`;
    if (block.type === 'paragraph') return inline(block.parts);
    return listLines(block.items, 0).join('\n');
  }).join('\n\n') + '\n';
}

function toText(blocks) {
  // A PR title could hold control characters that a terminal acts on, so they are shown as "?".
  const control = (code) => (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code < 0xa0);
  const plain = (text) => [...text].map((char) => (control(char.codePointAt(0)) ? '?' : char)).join('');
  const inline = (parts) => plain(parts.map((part) => (typeof part === 'string' ? part : part.code)).join(''));
  const listLines = (items, depth) => items.flatMap((entry) => [`${'  '.repeat(depth)}- ${inline(entry.parts)}`, ...listLines(entry.items, depth + 1)]);
  return blocks.map((block) => (block.type === 'list' ? listLines(block.items, 0).join('\n') : inline(block.parts))).join('\n') + '\n';
}

// Text from the history, such as a PR title, is plain text, not markdown.
const markdownText = (text) => text.replace(/[\\`*_[\]<>&~]/g, '\\$&');

// A code span needs more backticks around it than any run of backticks inside it.
function markdownCode(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest > 0 ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toHtml(title, blocks) {
  const inline = (parts) => parts.map((part) => (typeof part === 'string' ? escapeHtml(part) : `<code>${escapeHtml(part.code)}</code>`)).join('');
  const listHtml = (items) => `<ul>\n${items.map((entry) => `<li>${inline(entry.parts)}${entry.items.length > 0 ? `\n${listHtml(entry.items)}` : ''}</li>\n`).join('')}</ul>`;
  const body = blocks.map((block) => {
    if (block.type === 'heading') return `<h${block.level}>${inline(block.parts)}</h${block.level}>`;
    if (block.type === 'paragraph') return `<p>${inline(block.parts)}</p>`;
    return listHtml(block.items);
  }).join('\n');
  // The policy stops the page from loading anything, so it works with no network.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

const STYLE = `
:root { color-scheme: light dark; --text: #1f2328; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; --page: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --text: #e6edf3; --muted: #9198a1; --line: #3d444d; --code: #151b23; --page: #0d1117; } }
body { margin: 0; background: var(--page); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6em; margin: 0 0 12px; }
h2 { font-size: 1.25em; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.05em; margin: 20px 0 4px; }
ul { padding-left: 22px; }
li { margin: 4px 0; }
li li { color: var(--muted); }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
`;
