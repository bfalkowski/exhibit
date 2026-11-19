// Labels for escaped defects (spec 8.4). A person gives each escaped defect a code, a category
// and the evidence that would have caught it. Each label is one line of .exhibit/labels.jsonl.
import { readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  if (problems.length === 0 && line.id !== defectId(line.fix_pr)) problems.push(`/id: must be ${defectId(line.fix_pr)}, the id of fix PR ${line.fix_pr}`);
  return problems;
}

/**
 * Asks about each escaped defect that has no label yet, and writes each answer to labels.jsonl
 * as soon as it comes, so quitting halfway keeps the work done so far.
 *
 * `ask(defect, { categories, text, position, open })` is the answer source: a person at a
 * keyboard, or a script in a test. `defect` has `id`, `fix_pr` and `introducing_prs`. `text` shows
 * the defect with its SZZ evidence. `categories` are the categories used so far. It returns
 * { code, category, would_have_caught }, or 'skip', or 'quit'.
 *
 * Returns { shown, labeled, skipped, open }: `open` counts the defects still without a label.
 */
export async function labelDefects({ cwd, ask, now = () => new Date() }) {
  const history = await readHistory(cwd);
  const { labels, endsWithBreak } = await readLabels(cwd);
  const done = new Set(labels.map((label) => label.id));
  const categories = [...new Set(labels.map((label) => label.category))];
  const defects = escapedDefects(history).map((fix) => ({ id: defectId(fix.number), fix_pr: fix.number, introducing_prs: fix.szz.links.map((link) => link.pr), fix }));
  const open = defects.filter((defect) => !done.has(defect.id));

  let shown = 0;
  let labeled = 0;
  let skipped = 0;
  let needsBreak = !endsWithBreak;
  for (const defect of open) {
    shown += 1;
    const text = `${defectText(defect.fix, history)}The fix PR: ${defect.fix.url}\n`;
    const reply = await ask({ id: defect.id, fix_pr: defect.fix_pr, introducing_prs: defect.introducing_prs }, { categories: [...categories], text, position: shown, open: open.length });
    if (reply === 'quit') break;
    if (reply === 'skip') {
      skipped += 1;
      continue;
    }
    const line = {
      id: defect.id,
      fix_pr: defect.fix_pr,
      introducing_prs: defect.introducing_prs,
      code: reply.code,
      category: reply.category,
      would_have_caught: reply.would_have_caught,
      labeled_by: 'person',
      szz_link_rejected: false,
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
