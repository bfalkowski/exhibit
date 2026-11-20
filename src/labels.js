// Labels for escaped defects (spec 8.4). A person gives each escaped defect a code, a category
// and the evidence that would have caught it. Each label is one line of .exhibit/labels.jsonl.
import { readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DraftError } from './claude.js';
import { checkHistoryLine } from './history-schema.js';
import { checkSchema } from './json-schema.js';
import { defectText, escapedDefects } from './report.js';
import { ToolError } from './tool-error.js';

export const HISTORY = '.exhibit/history.jsonl';
export const LABELS = '.exhibit/labels.jsonl';

const schema = JSON.parse(readFileSync(new URL('../schema/labels-line.schema.json', import.meta.url), 'utf8'));

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
 * { code, category, would_have_caught, rejected_prs }, or 'skip', or 'quit'. `rejected_prs` names
 * the links the person rejected. It can name every link: the defect is then a real bug with no
 * known introducing PR.
 *
 * `draft({ id, title, body, text, categories })` is optional: Claude, or a script in a test. It
 * returns { code, category, model } before the defect is shown, and the answer source gets it in
 * `context.draft`. When it throws a DraftError, `context.draft` is null and `context.draftError`
 * holds the message, so the person labels that defect by hand. With a draft, the reply also says
 * `draft: 'confirmed' | 'edited' | 'replaced'`. A replaced draft is always the person's own label,
 * even when they type the draft's words again. Otherwise a reply with the draft's code and
 * category is claude_draft_confirmed, and any other change is claude_draft_edited. The line keeps the draft in `claude_draft` in all three cases.
 *
 * Returns { shown, labeled, skipped, open }: `open` counts the defects still without a label.
 */
export async function labelDefects({ cwd, ask, draft, now = () => new Date() }) {
  const history = await readHistory(cwd);
  const { labels, endsWithBreak } = await readLabels(cwd);
  const done = new Set(labels.map((label) => label.id));
  const categories = [...new Set(labels.map((label) => label.category))];
  const defects = escapedDefects(history).map((fix) => ({ id: defectId(fix.number), fix_pr: fix.number, introducing_prs: fix.szz.links.map((link) => link.pr), links: fix.szz.links.map(({ pr, confidence, found_by: foundBy }) => ({ pr, confidence, ...(foundBy ? { found_by: foundBy } : {}) })), fix }));
  const open = defects.filter((defect) => !done.has(defect.id));

  let shown = 0;
  let labeled = 0;
  let skipped = 0;
  let needsBreak = !endsWithBreak;
  for (const defect of open) {
    shown += 1;
    const text = `${defectText(defect.fix, history)}The fix PR: ${defect.fix.url}\n`;
    const { drafted, draftError } = await askForDraft(draft, { id: defect.id, title: defect.fix.title, body: defect.fix.body, text, categories: [...categories] });
    const reply = await ask({ id: defect.id, fix_pr: defect.fix_pr, introducing_prs: defect.introducing_prs, links: defect.links }, { categories: [...categories], text, position: shown, open: open.length, draft: drafted, draftError });
    if (reply === 'quit') break;
    if (reply === 'skip') {
      skipped += 1;
      continue;
    }
    const rejected = reply.rejected_prs ?? [];
    const unknown = rejected.find((pr) => !defect.introducing_prs.includes(pr));
    if (unknown !== undefined) throw new ToolError(`PR ${unknown} is not a link of ${defect.id}, so it cannot be rejected. Its links are PRs ${defect.introducing_prs.join(', ')}.`);
    const line = {
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
      labeled_at: now().toISOString()
    };
    const problems = checkLabelLine(line);
    if (problems.length > 0) {
      throw new ToolError(`the label for ${defect.id} does not fit the labels schema, so it was not written:\n  ${problems.join('\n  ')}\n` +
        `${LABELS} keeps the ${labels.length + labeled} labels written before it. Run exhibit label again to label ${defect.id}.`);
    }
    await appendLine(cwd, `${needsBreak ? '\n' : ''}${JSON.stringify(line)}\n`);
    needsBreak = false;
    labeled += 1;
    if (!categories.includes(line.category)) categories.push(line.category);
  }
  return { shown, labeled, skipped, open: open.length - labeled };
}

// Returns { drafted, draftError }. Both are null when there is no drafter.
async function askForDraft(draft, input) {
  if (draft === undefined) return { drafted: null, draftError: null };
  try {
    return { drafted: await draft(input), draftError: null };
  } catch (error) {
    if (!(error instanceof DraftError)) throw error;
    return { drafted: null, draftError: error.message };
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

// Parses JSON lines, and refuses the file at the first line that is not JSON or fails `check`.
function parseLines(text, name, check, fix) {
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
