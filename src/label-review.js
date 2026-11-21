// The review page's state for `exhibit label --review` (spec 8.4). The page shows one escaped
// defect at a time, and the person can go back and forth. This module holds what the page knows
// and writes .exhibit/labels.jsonl on each action. It has no HTTP in it: src/review-server.js
// serves it. The lines it writes are built and checked by the same code as the terminal flow's
// lines (src/labels.js), so both flows write the same format.
import { readFile, rename, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { draftAgreement, draftAgreementText } from './draft-agreement.js';
import { ANSWER_LIMITS, LABELS, checkLabelLine, labelLine, prepareDefect, readLabeling } from './labels.js';
import { ToolError } from './tool-error.js';

// The most blamed lines that the page shows for one link. history.jsonl has them all.
const LINES_SHOWN = 20;
// The most characters in the plain line about the bug.
const WHAT_LENGTH = 300;

/**
 * Starts a review of the open escaped defects in `cwd`. It reads the files at once, and throws a
 * ToolError as labelDefects does when one is missing or does not fit its schema. Then it prepares
 * each defect in the background, in order: Claude's draft when `draft` is given, and the proposal
 * for known_at_review. `draft`, `issues` and `now` are as in labelDefects.
 *
 * Returns { cwd, prepared, state, answer, seen, summary, idle }:
 * - `prepared` settles when every defect is prepared. It rejects only on a bug.
 * - `state()` is what the page shows: the items, the categories used so far, and the summary.
 * - `answer(id, body)` acts on one defect. `body.action` is `save`, `skip` (not a bug, or skip it)
 *   or `later`. A save also has code, category, would_have_caught, rejected_prs, known_at_review,
 *   and draft: 'replaced' when the person threw Claude's draft away. A save adds a line to the
 *   labels file, or replaces the line this page wrote for that defect before. A skip or a later
 *   takes that line out again. It throws a ToolError for an answer it cannot write.
 * - `seen(id)` records that the page showed defect `id`, for `shown` in the summary.
 * - `summary()` is { run, drafts, draftsText, categories } (see below).
 * - `idle()` resolves when every answer given so far is written.
 */
export async function createReviewSession({ cwd, draft, issues, now = () => new Date() }) {
  const { history, labels, categories: fileCategories, open, relink } = await readLabeling(cwd);
  const byNumber = new Map(history.map((line) => [line.number, line]));
  const items = open.map((defect) => ({ defect, view: viewOf(defect, byNumber), prepared: null, state: 'open', line: null, saved: null, reply: null }));
  const categories = () => [...new Set([...fileCategories, ...items.filter((item) => item.saved !== null).map((item) => item.saved.category)])];

  const prepared = (async () => {
    // stopped: a draft failed in a way that every later draft would fail too.
    let stopped = false;
    for (const item of items) {
      item.prepared = await prepareDefect(item.defect, { history, draft: stopped ? undefined : draft, issues, categories: categories() });
      if (item.prepared.draftStopped !== null) stopped = true;
    }
  })();

  // The writes run one at a time, in the order the answers came.
  let writes = Promise.resolve();
  function serial(task) {
    const run = writes.then(task);
    writes = run.catch(() => {});
    return run;
  }

  function find(id) {
    const item = items.find((candidate) => candidate.defect.id === id);
    if (item === undefined) throw new ToolError(`there is no open defect ${id} on this page.`);
    return item;
  }

  // The ids of the defects the page showed.
  const shown = new Set();
  function seen(id) {
    shown.add(find(id).defect.id);
  }

  async function answer(id, body) {
    const item = find(id);
    const action = body?.action;
    if (!['save', 'skip', 'later'].includes(action)) throw new ToolError(`unknown action ${JSON.stringify(action)}. Use save, skip or later.`);
    // The person answers only a defect they see, so an answer counts it as shown too.
    shown.add(id);
    return serial(async () => {
      if (action !== 'save') {
        if (item.line !== null) await removeLine(cwd, id, item.line);
        Object.assign(item, { line: null, saved: null, reply: null, state: action === 'skip' ? 'skipped' : 'later' });
        return;
      }
      if (item.prepared === null) throw new ToolError(`${id} is still being prepared, so it cannot be saved yet. Wait for Claude's draft, then save it.`);
      const reply = cleanReply(body);
      const line = labelLine(item.defect, reply, { drafted: item.prepared.drafted, review: item.prepared.review, now });
      const problems = checkLabelLine(line);
      if (problems.length > 0) throw new ToolError(`the label for ${id} does not fit the labels schema, so it was not written: ${problems.join('; ')}`);
      const text = JSON.stringify(line);
      if (item.line === null) await appendLine(cwd, text);
      else await replaceLine(cwd, id, item.line, text);
      Object.assign(item, { line: text, saved: line, reply, state: 'saved' });
    });
  }

  // run: { shown, labeled, skipped, open, relinked, new_links }, as the terminal flow counts them:
  // `shown` counts the defects the page showed, `skipped` the defects left as skipped or for later,
  // and `open` every defect on the page still with no line. The page does not ask about the new
  // links of a labeled defect, so `relinked` is 0 and `new_links` counts those defects. With a drafter,
  // drafts: { run, file } and draftsText say how often the person kept Claude's draft (spec 9.11).
  // categories: categoryCounts of every line in the file.
  function summary() {
    const saved = items.filter((item) => item.saved !== null).map((item) => item.saved);
    const run = { shown: shown.size, labeled: saved.length, skipped: items.filter((item) => item.state === 'skipped' || item.state === 'later').length, open: items.length - saved.length, relinked: 0, new_links: relink.length };
    const all = [...labels, ...saved];
    const counts = { run, categories: categoryCounts(all) };
    if (draft === undefined) return counts;
    const drafts = { run: draftAgreement(saved), file: draftAgreement(all) };
    return { ...counts, drafts, draftsText: [draftAgreementText(drafts.run, 'in this run'), draftAgreementText(drafts.file, 'in the whole labels file')] };
  }

  function state() {
    return {
      items: items.map((item) => ({
        id: item.defect.id,
        fix_pr: item.defect.fix_pr,
        state: item.state,
        labeled_by: item.saved?.labeled_by ?? null,
        ...item.view,
        ready: item.prepared !== null,
        draft: item.prepared?.drafted ?? null,
        draftError: item.prepared?.draftError ?? null,
        draftStopped: item.prepared?.draftStopped ?? null,
        review: item.prepared?.review ?? null,
        answer: item.reply
      })),
      categories: categories(),
      limits: ANSWER_LIMITS,
      drafting: draft !== undefined,
      summary: summary()
    };
  }

  return { cwd, prepared, state, answer, seen, summary, idle: () => writes };
}

// The answer as the page sent it, made fit for a labels line: the texts trimmed, and a line break
// in the evidence made a space, because each field is one line.
function cleanReply(body) {
  const text = (value) => (typeof value === 'string' ? value.replace(/\s*[\r\n]+\s*/g, ' ').trim() : value);
  const rejected = body.rejected_prs ?? [];
  if (!Array.isArray(rejected) || !rejected.every(Number.isInteger)) throw new ToolError('rejected_prs must be a list of PR numbers.');
  if (![true, false, null, undefined].includes(body.known_at_review)) throw new ToolError('known_at_review must be true, false or null.');
  return {
    code: text(body.code),
    category: text(body.category),
    would_have_caught: text(body.would_have_caught),
    rejected_prs: rejected,
    ...(body.known_at_review === undefined ? {} : { known_at_review: body.known_at_review }),
    ...(body.draft === 'replaced' ? { draft: 'replaced' } : {})
  };
}

// What the page shows about one defect, from its history line.
function viewOf(defect, byNumber) {
  const { fix } = defect;
  const prUrl = (pr) => byNumber.get(pr)?.url ?? fix.url.replace(/\/pull\/\d+$/, `/pull/${pr}`);
  return {
    fix: { number: fix.number, title: fix.title, url: fix.url, merged_at: fix.merged_at, what: whatWentWrong(fix), body: fix.body ?? '', blamed_commit: fix.szz.blamed_commit },
    links: fix.szz.links.map((link) => ({
      pr: link.pr,
      confidence: link.confidence,
      found_by: link.found_by ?? 'blame',
      title: byNumber.get(link.pr)?.title ?? null,
      url: prUrl(link.pr),
      lines: link.lines.slice(0, LINES_SHOWN).map((line) => ({ path: line.path, line: line.line, text: line.text, commit: line.blame.commit, author: line.blame.author, date: line.blame.author_time, summary: line.blame.summary })),
      more: Math.max(0, link.lines.length - LINES_SHOWN)
    })),
    unlinked: fix.szz.unlinked_lines.length
  };
}

/**
 * One plain line about the bug, from the fix PR: the first sentence under a "Why" heading in its
 * body, or else the first sentence of its first paragraph, with the markdown marks taken out. A
 * heading line is never part of a paragraph, even with no blank line after it. With no text in the
 * body it is the PR title. It has at most 300 characters.
 */
export function whatWentWrong(fix) {
  const blocks = bodyBlocks(fix.body ?? '');
  const why = blocks.findIndex((block) => block.heading && /^#+\s*why\b/i.test(block.text));
  // The Why part ends at the next heading, or at the end of the body.
  const next = blocks.findIndex((block, i) => i > why && block.heading);
  const whyPart = why === -1 ? [] : blocks.slice(why + 1, next === -1 ? blocks.length : next);
  const first = whyPart.find((block) => !block.heading) ?? blocks.find((block) => !block.heading);
  if (first === undefined) return fix.title;
  const plain = first.text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = plain.split(/(?<=[.!?])\s+/)[0];
  return sentence.length > WHAT_LENGTH ? `${sentence.slice(0, WHAT_LENGTH - 1)}…` : sentence;
}

// A markdown heading: one to six # marks, then a space or the end of the line. "#148" is not one.
const HEADING = /^#{1,6}(?:\s|$)/;

// The body as blocks in order: each heading line on its own ({ heading: true, text }), and each
// run of other lines up to a blank line or a heading as one paragraph ({ heading: false, text }),
// with the list and quote marks at the start of each line taken off.
function bodyBlocks(body) {
  const blocks = [];
  let lines = [];
  const flush = () => {
    if (lines.length > 0) blocks.push({ heading: false, text: lines.join(' ') });
    lines = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || HEADING.test(line)) {
      flush();
      if (line !== '') blocks.push({ heading: true, text: line });
    } else {
      lines.push(line.replace(/^(?:[-*>]|\d+\.)\s+/, ''));
    }
  }
  flush();
  return blocks;
}

/**
 * Counts the labeled defects in each category, as `exhibit policy suggest` counts them (spec
 * 9.13), so the person sees which categories can become rules. A defect counts only when it has a
 * link that a person kept, and the first line for each defect wins, as in the report. A category is
 * `ready` with two or more counted defects from two or more different PRs. Otherwise it is
 * `waiting for a second defect` or `waiting for a second PR`. The categories with the most defects
 * come first. Returns [{ category, defects, counted, prs, rule }].
 */
export function categoryCounts(lines) {
  const first = new Map();
  for (const line of lines) if (!first.has(line.id)) first.set(line.id, line);
  const groups = new Map();
  for (const line of first.values()) {
    if (!groups.has(line.category)) groups.set(line.category, []);
    groups.get(line.category).push(line);
  }
  const counts = [...groups].map(([category, group]) => {
    const counted = group.filter((line) => line.introducing_prs.length > 0);
    const prs = [...new Set(counted.flatMap((line) => line.introducing_prs))].sort((a, b) => a - b);
    const rule = counted.length < 2 ? 'waiting for a second defect' : prs.length < 2 ? 'waiting for a second PR' : 'ready';
    return { category, defects: group.map((line) => line.id), counted: counted.map((line) => line.id), prs, rule };
  });
  return counts.sort((a, b) => b.defects.length - a.defects.length);
}

async function readLabelsText(cwd) {
  try {
    return await readFile(join(cwd, LABELS), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new ToolError(`could not read ${LABELS}: ${error.message}`);
  }
}

// Adds one line at the end, after a line break when the file's last line has none.
async function appendLine(cwd, text) {
  const before = await readLabelsText(cwd);
  try {
    await appendFile(join(cwd, LABELS), `${before === '' || before.endsWith('\n') ? '' : '\n'}${text}\n`);
  } catch (error) {
    throw new ToolError(`could not write ${LABELS}: ${error.message}`);
  }
}

const replaceLine = (cwd, id, old, text) => changeLine(cwd, id, old, [text]);
const removeLine = (cwd, id, old) => changeLine(cwd, id, old, []);

// Swaps the line this page wrote, `old`, for `rows`. It writes a new file and renames it over the
// old one, so a crash leaves the old file or the new one, never half of one. When `old` is not in
// the file any more, someone changed it by hand, so it writes nothing.
async function changeLine(cwd, id, old, rows) {
  const lines = (await readLabelsText(cwd)).split('\n');
  const index = lines.indexOf(old);
  if (index === -1) throw new ToolError(`the line for ${id} in ${LABELS} changed outside this page, so the page did not overwrite it. Check the file, then run exhibit label --review again.`);
  lines.splice(index, 1, ...rows);
  const path = join(cwd, LABELS);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, lines.join('\n'));
    await rename(temporary, path);
  } catch (error) {
    throw new ToolError(`could not write ${LABELS}: ${error.message}`);
  }
}
