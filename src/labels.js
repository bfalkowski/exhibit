// Labels for escaped defects (spec 8.4). A person gives each escaped defect a code, a category
// and the evidence that would have caught it. Each label is one line of .exhibit/labels.jsonl.
import { readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DraftError } from './claude.js';
import { closingIssues, proposeKnownAtReview } from './deferral.js';
import { draftAgreement } from './draft-agreement.js';
import { checkHistoryLine } from './history-schema.js';
import { checkSchema } from './json-schema.js';
import { defectText, escapedDefects } from './report.js';
import { ToolError } from './tool-error.js';
import { writeTogether } from './write-together.js';

export const HISTORY = '.exhibit/history.jsonl';
export const LABELS = '.exhibit/labels.jsonl';

const schema = JSON.parse(readFileSync(new URL('../schema/labels-line.schema.json', import.meta.url), 'utf8'));

// The replies that an answer source gives to skip a defect or to quit. The keyboard in
// src/commands/label.js gives them, and labelDefects reads them, so both use these names.
export const SKIP = 'skip';
export const QUIT = 'quit';

// The most characters that each typed answer can have. They come from the schema's patterns,
// such as ^\S[^\r\n]{0,199}$ for code, so the keyboard can ask again before the schema check.
export const ANSWER_LIMITS = Object.fromEntries(['code', 'category', 'would_have_caught'].map((field) => [field, longest(schema.properties[field].pattern)]));

// A pattern that ends in {0,n}$ allows one first character and then at most n more: n + 1 in all.
function longest(pattern) {
  const match = /\{0,(\d+)\}\$$/.exec(pattern);
  if (match === null) throw new Error(`the labels schema pattern ${pattern} has no length limit`);
  return Number(match[1]) + 1;
}

// The id of the escaped defect that fix PR `fixPr` fixed, such as D-004 for PR 4. A PR number
// never changes, so the id stays the same when exhibit history runs again, and policy rules can
// cite it in `source` (spec 8.1).
export function defectId(fixPr) {
  return `D-${String(fixPr).padStart(3, '0')}`;
}

// Returns the problems with one labels line, or an empty list when it passes the schema.
export function checkLabelLine(line) {
  const problems = checkSchema(schema, line);
  if (problems.length > 0) return problems;
  if (line.id !== defectId(line.fix_pr)) problems.push(`/id: must be ${defectId(line.fix_pr)}, the id of fix PR ${line.fix_pr}`);
  const rejected = (line.rejected_prs ?? []).length > 0;
  if (line.szz_link_rejected !== rejected) problems.push(`/szz_link_rejected: must be ${rejected}, because rejected_prs is ${rejected ? 'not empty' : 'empty'}`);
  if (line.labeled_by !== 'person' && line.claude_draft === undefined) problems.push(`/claude_draft: a ${line.labeled_by} label must keep the draft in claude_draft`);
  const matches = line.claude_draft !== undefined && line.code === line.claude_draft.code && line.category === line.claude_draft.category;
  if (line.labeled_by === 'claude_draft_confirmed' && line.claude_draft !== undefined && !matches) problems.push('/code: a claude_draft_confirmed label must have the code and category of its draft');
  return problems;
}

/**
 * Asks about each escaped defect that has no label yet, and writes each answer to labels.jsonl
 * as soon as it comes, so quitting halfway keeps the work done so far.
 *
 * `ask(defect, { categories, text, position, open })` is the answer source: a person at a
 * keyboard, or a script in a test. `defect` has `id`, `fix_pr`, `introducing_prs` and `links`,
 * which holds `pr` and `confidence` for each SZZ link, and `found_by: 'revert'` for a link that
 * SZZ found from a revert with no blame. `text` shows the defect with its SZZ evidence. `categories` are the categories used so far. It returns
 * { code, category, would_have_caught, rejected_prs }, or SKIP, or QUIT. `rejected_prs` names
 * the links the person rejected. It can name every link: the defect is then a real bug with no
 * known introducing PR.
 *
 * Exhibit proposes `known_at_review` for each defect (src/deferral.js), and the answer source gets
 * it in `context.review`: { known_at_review: true, pr, where, sentence } for a deferral, or
 * { known_at_review: null }. The reply's `known_at_review` is true, false or null. A reply that
 * leaves it out keeps the proposal.
 *
 * `issues(numbers, fix)` is optional: GitHub, or a script in a test. It gets the numbers of the
 * issues that the fix PR body closes with closing words, and the fix PR's history line. It returns
 * each issue's { number, title, body }, and leaves out an issue it cannot read,
 * so a follow-up ticket's words count too. Without it, only the fix PR's title and body count.
 *
 * `draft({ id, title, body, text, categories })` is optional: Claude, or a script in a test. It
 * returns { code, category, model } before the defect is shown, and the answer source gets it in
 * `context.draft`. When it throws a DraftError, `context.draft` is null and `context.draftError`
 * holds the message, so the person labels that defect by hand. When that DraftError has
 * `stopsDrafting` (a 401, 403 or 404: a bad key or a wrong model), `context.draftStopped` holds
 * what to fix, and no later defect in this run is sent: each gets `draft`, `draftError` and
 * `draftStopped` as null, and the person labels it by hand. With a draft, the reply also says
 * `draft: 'confirmed' | 'edited' | 'replaced'`. A replaced draft is always the person's own label,
 * even when they type the draft's words again. Otherwise a reply with the draft's code and
 * category is claude_draft_confirmed, and any other change is claude_draft_edited. The line keeps the draft in `claude_draft` in all three cases.
 *
 * `askLinks(defect, { text, label, position, count })` is optional: the answer source for a defect
 * that has a line already, when SZZ now links it to a PR that the line neither keeps nor rejects
 * (a new link). `defect.links` holds only the new links, `text` shows only their evidence, and
 * `label` is the defect's first line. It returns { rejected_prs }, or SKIP, or QUIT. The new links
 * that it keeps go to the end of `introducing_prs`, the rejected ones to the end of `rejected_prs`,
 * in the same line, and the other fields stay. These defects come after the defects with no line.
 * Without `askLinks`, they are only counted.
 *
 * Returns { shown, labeled, skipped, open, relinked, new_links }: `open` counts the defects still
 * without a label, `relinked` the labeled defects whose new links the person answered, and
 * `new_links` the labeled defects that still have a new link. `shown` counts both kinds.
 * With a drafter it also returns `drafts`: { run, file }, how often the person kept Claude's draft
 * in the lines this run wrote and in the whole file (spec 9.11). A skipped defect has no line, so
 * its draft is not counted.
 */
export async function labelDefects({ cwd, ask, askLinks, draft, issues, now = () => new Date() }) {
  const { history, labels, endsWithBreak, categories, open, relink } = await readLabeling(cwd);

  let shown = 0;
  let labeled = 0;
  let skipped = 0;
  // needsBreak: add a line break before the next line, so it does not join the file's last line.
  let needsBreak = !endsWithBreak;
  const written = [];
  // stopped: a draft failed in a way that every later draft would fail too.
  let stopped = false;
  let quit = false;
  for (const defect of open) {
    shown += 1;
    const prepared = await prepareDefect(defect, { history, draft: stopped ? undefined : draft, issues, categories });
    if (prepared.draftStopped !== null) stopped = true;
    const { text, drafted, draftError, draftStopped, review } = prepared;
    const reply = await ask(publicDefect(defect), { categories: [...categories], text, position: shown, open: open.length, draft: drafted, draftError, draftStopped, review });
    if (reply === QUIT) {
      quit = true;
      break;
    }
    if (reply === SKIP) {
      skipped += 1;
      continue;
    }
    const line = labelLine(defect, reply, { drafted, review, now });
    const problems = checkLabelLine(line);
    if (problems.length > 0) {
      throw new ToolError(`the label for ${defect.id} does not fit the labels schema, so it was not written:\n  ${problems.join('\n  ')}\n` +
        `${LABELS} keeps the ${labels.length + labeled} labels written before it. Run exhibit label again to label ${defect.id}.`);
    }
    await appendLine(cwd, `${needsBreak ? '\n' : ''}${JSON.stringify(line)}\n`);
    needsBreak = false;
    written.push(line);
    labeled += 1;
    if (!categories.includes(line.category)) categories.push(line.category);
  }
  let relinked = 0;
  for (const [index, defect] of relink.entries()) {
    if (quit || askLinks === undefined) break;
    shown += 1;
    const reply = await askLinks(publicDefect(defect), { text: newLinksText(defect, history), label: defect.label, position: index + 1, count: relink.length });
    if (reply === QUIT) break;
    if (reply === SKIP) continue;
    const line = withNewLinks(defect, reply.rejected_prs ?? []);
    const problems = checkLabelLine(line);
    if (problems.length > 0) throw new ToolError(`the new links of ${defect.id} do not fit the labels schema, so they were not written:\n  ${problems.join('\n  ')}`);
    await replaceFirstLine(cwd, defect.label, line);
    relinked += 1;
  }
  const summary = { shown, labeled, skipped, open: open.length - labeled, relinked, new_links: relink.length - relinked };
  if (draft === undefined) return summary;
  return { ...summary, drafts: { run: draftAgreement(written), file: draftAgreement([...labels, ...written]) } };
}

/**
 * Reads the history and the labels file, for labelDefects and for the review page
 * (src/label-review.js). Returns { history, labels, endsWithBreak, categories, open, relink }.
 * `categories` are the categories in the labels file, in the order they first come. `open` are
 * the escaped defects with no line in the file yet, newest fix first. Each has `id`, `fix_pr`,
 * `introducing_prs`, `links` and `fix`, its history line. `relink` are the escaped defects whose
 * first line neither keeps nor rejects one of their SZZ links, newest fix first, in the same
 * shape, but `links` and `introducing_prs` hold only those new links, and `label` is the first
 * line. It throws a ToolError when a file is missing or does not fit its schema, as labelDefects
 * does.
 */
export async function readLabeling(cwd) {
  const history = await readHistory(cwd);
  // endsWithBreak: the file ends in a line break.
  const { labels, endsWithBreak } = await readLabels(cwd);
  // Each defect counts by its first line, as in the report and the backtest.
  const first = new Map();
  for (const label of labels) if (!first.has(label.id)) first.set(label.id, label);
  const categories = [...new Set(labels.map((label) => label.category))];
  const defects = escapedDefects(history).map((fix) => ({ id: defectId(fix.number), fix_pr: fix.number, introducing_prs: fix.szz.links.map((link) => link.pr), links: fix.szz.links.map(({ pr, confidence, found_by: foundBy }) => ({ pr, confidence, ...(foundBy ? { found_by: foundBy } : {}) })), fix }));
  const relink = defects.flatMap((defect) => {
    const label = first.get(defect.id);
    if (label === undefined) return [];
    const answered = new Set([...label.introducing_prs, ...(label.rejected_prs ?? [])]);
    const links = defect.links.filter((link) => !answered.has(link.pr));
    return links.length === 0 ? [] : [{ ...defect, introducing_prs: links.map((link) => link.pr), links, label }];
  });
  return { history, labels, endsWithBreak, categories, open: defects.filter((defect) => !first.has(defect.id)), relink };
}

// The defect's text with the evidence of its new links only, and the fix PR's web page.
function newLinksText(defect, history) {
  const kept = new Set(defect.introducing_prs);
  const fix = { ...defect.fix, szz: { ...defect.fix.szz, links: defect.fix.szz.links.filter((link) => kept.has(link.pr)) } };
  return `${defectText(fix, history)}The fix PR: ${defect.fix.url}\n`;
}

/**
 * The first line of a labeled defect with its new links answered: `rejected` names the new links
 * the person rejected, and the others are kept. The kept ones go to the end of `introducing_prs`,
 * the rejected ones to the end of `rejected_prs`, and `szz_link_rejected` follows. The code, the
 * category and the other fields stay as the person gave them. It throws a ToolError when
 * `rejected` names a PR that is not a new link.
 */
export function withNewLinks(defect, rejected) {
  const unknown = rejected.find((pr) => !defect.introducing_prs.includes(pr));
  if (unknown !== undefined) throw new ToolError(`PR ${unknown} is not a new link of ${defect.id}, so it cannot be rejected. Its new links are PRs ${defect.introducing_prs.join(', ')}.`);
  const rejectedPrs = [...(defect.label.rejected_prs ?? []), ...defect.introducing_prs.filter((pr) => rejected.includes(pr))];
  return {
    ...defect.label,
    introducing_prs: [...defect.label.introducing_prs, ...defect.introducing_prs.filter((pr) => !rejected.includes(pr))],
    rejected_prs: rejectedPrs,
    szz_link_rejected: rejectedPrs.length > 0
  };
}

// Puts `line` in place of the first line for its defect, `old`. It writes a new file and renames
// it over the old one, so a crash leaves the old file or the new one. When that line is no longer
// `old`, someone changed the file during the run, so it writes nothing.
async function replaceFirstLine(cwd, old, line) {
  let text;
  try {
    text = await readFile(join(cwd, LABELS), 'utf8');
  } catch (error) {
    throw new ToolError(`could not read ${LABELS}: ${error.message}`);
  }
  const rows = text.split('\n');
  const index = rows.findIndex((row) => parsedId(row) === old.id);
  if (index === -1 || JSON.stringify(JSON.parse(rows[index])) !== JSON.stringify(old)) {
    throw new ToolError(`the line for ${old.id} in ${LABELS} changed during this run, so its new links were not written. Check the file, then run exhibit label again.`);
  }
  rows[index] = JSON.stringify(line);
  await writeTogether(cwd, [[LABELS, rows.join('\n')]]);
}

// The id in one row of the labels file, or null for a blank row or a row that is not JSON.
function parsedId(row) {
  try {
    return row.trim() === '' ? null : JSON.parse(row)?.id ?? null;
  } catch {
    return null;
  }
}

// The defect as the answer source sees it: without its history line.
export function publicDefect(defect) {
  return { id: defect.id, fix_pr: defect.fix_pr, introducing_prs: defect.introducing_prs, links: defect.links };
}

/**
 * Gets what the person needs before they label one defect: its `text` with the SZZ evidence,
 * Claude's draft when there is a drafter, and Exhibit's proposal for known_at_review. Returns
 * { text, drafted, draftError, draftStopped, review }, as labelDefects passes them to `ask`.
 */
export async function prepareDefect(defect, { history, draft, issues, categories }) {
  const text = `${defectText(defect.fix, history)}The fix PR: ${defect.fix.url}\n`;
  const { drafted, draftError, draftStopped } = await askForDraft(draft, { id: defect.id, title: defect.fix.title, body: defect.fix.body, text, categories: [...categories] });
  const closed = closingIssues(defect.fix.body);
  const review = proposeKnownAtReview({ fix: defect.fix, blamed: defect.introducing_prs, issues: issues === undefined || closed.length === 0 ? [] : await issues(closed, defect.fix) });
  return { text, drafted, draftError, draftStopped, review };
}

/**
 * The labels line for one defect from the person's `reply`: { code, category, would_have_caught,
 * rejected_prs, known_at_review, draft }, as labelDefects describes it. `drafted` is Claude's draft
 * or null, and `review` is Exhibit's proposal for known_at_review. It throws a ToolError when
 * `rejected_prs` names a PR that is not a link of the defect. The caller checks the line against
 * the schema with checkLabelLine before it writes it.
 */
export function labelLine(defect, reply, { drafted, review, now = () => new Date() }) {
  const rejected = reply.rejected_prs ?? [];
  const unknown = rejected.find((pr) => !defect.introducing_prs.includes(pr));
  if (unknown !== undefined) throw new ToolError(`PR ${unknown} is not a link of ${defect.id}, so it cannot be rejected. Its links are PRs ${defect.introducing_prs.join(', ')}.`);
  return {
    id: defect.id,
    fix_pr: defect.fix_pr,
    introducing_prs: defect.introducing_prs.filter((pr) => !rejected.includes(pr)),
    rejected_prs: defect.introducing_prs.filter((pr) => rejected.includes(pr)),
    code: reply.code,
    category: reply.category,
    would_have_caught: reply.would_have_caught,
    labeled_by: labeledBy(drafted, reply),
    ...(drafted === null ? {} : { claude_draft: drafted }),
    szz_link_rejected: rejected.length > 0,
    known_at_review: reply.known_at_review === undefined ? review.known_at_review : reply.known_at_review,
    labeled_at: now().toISOString()
  };
}

// Returns { drafted, draftError, draftStopped }. All three are null when there is no drafter.
async function askForDraft(draft, input) {
  if (draft === undefined) return { drafted: null, draftError: null, draftStopped: null };
  try {
    return { drafted: await draft(input), draftError: null, draftStopped: null };
  } catch (error) {
    if (!(error instanceof DraftError)) throw error;
    return { drafted: null, draftError: error.message, draftStopped: error.stopsDrafting ?? null };
  }
}

function labeledBy(drafted, reply) {
  // The person threw the draft away, so they did not accept it, even if they typed the same words.
  if (drafted === null || reply.draft === 'replaced') return 'person';
  return reply.code === drafted.code && reply.category === drafted.category ? 'claude_draft_confirmed' : 'claude_draft_edited';
}

async function readHistory(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, HISTORY), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ToolError(`there is no ${HISTORY} in this folder. Run exhibit history first, inside a clone of the repo, so SZZ can find the escaped defects.`);
    throw new ToolError(`could not read ${HISTORY}: ${error.message}`);
  }
  const lines = parseLines(text, HISTORY, (line) => checkHistoryLine(line), 'the history schema. Run exhibit history again to write it new');
  if (escapedDefects(lines).length === 0) {
    throw new ToolError(`${HISTORY} has no SZZ links, so there is no escaped defect to label. Run exhibit history first, inside a clone of the repo, so SZZ can link each fix PR to the PR that brought its bug.`);
  }
  return lines;
}

async function readLabels(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, LABELS), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { labels: [], endsWithBreak: true };
    throw new ToolError(`could not read ${LABELS}: ${error.message}`);
  }
  const labels = parseLines(text, LABELS, checkLabelLine, 'the labels schema. Fix or remove that line, then run exhibit label again');
  return { labels, endsWithBreak: text === '' || text.endsWith('\n') };
}

/**
 * Reads labels.jsonl only to count it, for the funnel in the history report (spec 8.5). It never
 * writes the file. Returns { state: 'none' } when there is no file, { state: 'read', lines }, or
 * { state: 'unreadable', problem } when the file cannot be read, or a line is not JSON or fails
 * the labels schema. It does not throw for those, so the history run still succeeds.
 */
export async function readLabelsToCount(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, LABELS), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'none' };
    return { state: 'unreadable', problem: `could not read ${LABELS}: ${error.message}` };
  }
  try {
    return { state: 'read', lines: parseLines(text, LABELS, checkLabelLine, 'the labels schema. Fix or remove that line, then run exhibit history again') };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { state: 'unreadable', problem: error.message };
  }
}

// Parses JSON lines, and refuses the file at the first line that is not JSON or fails `check`.
export function parseLines(text, name, check, fix) {
  const lines = [];
  for (const [index, row] of text.split('\n').entries()) {
    if (row.trim() === '') continue;
    let line;
    try {
      line = JSON.parse(row);
    } catch {
      throw new ToolError(`${name} line ${index + 1} is not JSON, so it does not fit ${fix}.`);
    }
    const problems = check(line);
    if (problems.length > 0) throw new ToolError(`${name} line ${index + 1} does not fit ${fix}. The first problem: ${problems[0]}`);
    lines.push(line);
  }
  return lines;
}

async function appendLine(cwd, text) {
  try {
    await appendFile(join(cwd, LABELS), text);
  } catch (error) {
    throw new ToolError(`could not write ${LABELS}: ${error.message}`);
  }
}
