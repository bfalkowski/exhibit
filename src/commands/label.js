import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL, createDrafter } from '../claude.js';
import { draftAgreementText } from '../draft-agreement.js';
import { ANSWER_LIMITS, LABELS, QUIT, SKIP, labelDefects } from '../labels.js';
import { ToolError } from '../tool-error.js';

const USAGE = 'Usage: exhibit label [--json] [--claude]';
// Its presence means the note about what --claude sends was shown in this repo.
const NOTICE_SHOWN = '.exhibit/claude-notice-shown';
// What each too-long answer is called in the message that asks again.
const ANSWER_NAMES = { code: 'A code', category: 'A category', would_have_caught: 'The evidence' };

// `word` for 1, and `words` for any other count: plural(2, 'defect') is 'defects'.
function plural(n, word, words = `${word}s`) {
  return n === 1 ? word : words;
}

// `exhibit label [--json] [--claude]`
// Shows each escaped defect in .exhibit/history.jsonl that has no label yet, with its SZZ
// evidence. The person keeps or rejects each SZZ link, then gives a code, a category and the
// evidence that would have caught it. Each answer goes to .exhibit/labels.jsonl at once (spec
// 8.4). With --json, the defects and the questions go to stderr, and stdout gets only the summary
// at the end. With --claude, Claude drafts a code and a category for each defect first (spec 9.11),
// with ANTHROPIC_API_KEY and the model in EXHIBIT_CLAUDE_MODEL.
export async function label(argv, { cwd, env = {}, fetch, stdin, stdout, stderr, now }) {
  const options = parseOptions(argv);
  const screen = options.json ? stderr : stdout;
  let draft;
  if (options.claude) {
    if (!env.ANTHROPIC_API_KEY) throw new ToolError('exhibit label --claude needs ANTHROPIC_API_KEY. Set it, or run exhibit label without --claude.');
    draft = withNotice(createDrafter({ apiKey: env.ANTHROPIC_API_KEY, model: env.EXHIBIT_CLAUDE_MODEL || DEFAULT_MODEL, fetch }), { cwd, screen });
  }
  const keyboard = createKeyboard({ input: stdin, output: screen });
  let summary;
  try {
    summary = await labelDefects({ cwd, ask: keyboard.ask, draft, now });
  } finally {
    keyboard.close();
  }

  if (options.json) {
    stdout.write(JSON.stringify({ ...summary, output: LABELS }) + '\n');
    return;
  }
  if (summary.shown === 0) {
    stdout.write(`Every escaped defect has a code already. The labels are in ${LABELS}.\n${draftsText(summary.drafts)}`);
    return;
  }
  const left = summary.open === 0
    ? 'Every escaped defect has a code now.'
    : `${summary.open} still ${plural(summary.open, 'has', 'have')} no code. Run exhibit label again to label ${plural(summary.open, 'it', 'them')}.`;
  stdout.write(`\nLabeled ${summary.labeled} escaped ${plural(summary.labeled, 'defect')}. Skipped ${summary.skipped}. ${left}\nThe labels are in ${LABELS}.\n${draftsText(summary.drafts)}`);
}

// With --claude, how often the person kept Claude's draft, in this run and in the whole file.
function draftsText(drafts) {
  if (drafts === undefined) return '';
  return `${draftAgreementText(drafts.run, 'in this run')}\n${draftAgreementText(drafts.file, 'in the whole labels file')}\n`;
}

// Says once in each repo, before the first draft, what --claude sends to Anthropic.
function withNotice(draft, { cwd, screen }) {
  let checked = false;
  return async (input) => {
    if (!checked) {
      checked = true;
      const marker = join(cwd, NOTICE_SHOWN);
      if (!existsSync(marker)) {
        screen.write('exhibit label --claude sends each defect\'s fix PR title and body, its changed lines, and what git blame says about them (commit, author and message, and the titles of the linked PRs) to Anthropic\'s API. This note shows once in each repo.\n');
        writeFileSync(marker, 'exhibit label --claude showed its note about Anthropic\'s API in this repo.\n');
      }
    }
    return draft(input);
  };
}

// The answer source for a person at a keyboard, or for answers piped to stdin. The lines are read
// through one iterator, so a line that comes before its question waits for it.
function createKeyboard({ input, output }) {
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  let introduced = false;

  // Returns the trimmed answer, or null when the person quits: q, or the end of the input.
  // An empty answer is asked again, unless `emptyOk` is set. With `field`, an answer longer than
  // that field's limit in the labels schema is asked again too, so the person types only that one.
  // With `check`, an answer that `check` gives a message for is asked again with that message.
  async function question(text, { emptyOk = false, field, check } = {}) {
    for (;;) {
      output.write(`${text}\n> `);
      const { value, done } = await lines.next();
      if (done) {
        output.write('\n');
        return null;
      }
      const answer = value.trim();
      if (answer.toLowerCase() === 'q') return null;
      if (answer === '' && !emptyOk) {
        output.write('Please type an answer.\n');
        continue;
      }
      const problem = (field && tooLong(answer, field)) || (check && answer !== '' && check(answer));
      if (!problem) return answer;
      output.write(`${problem}\n`);
    }
  }

  async function ask(defect, { categories, text, position, open, draft, draftError, draftStopped }) {
    if (!introduced) {
      output.write(`${open} escaped ${plural(open, 'defect has', 'defects have')} no code yet. For each one, keep or reject each SZZ link, then type what went wrong, its category, and the evidence that would have caught it. ` +
        `Each label is saved as soon as you give it. Type s to skip a defect for now, or q at any question to quit.\n`);
      introduced = true;
    }
    output.write(`\n${defect.id}, ${position} of ${open} with no code yet\n${text}\n`);
    if (draftStopped) {
      output.write(`Claude could not draft ${defect.id}: ${draftError}. ${draftStopped} Drafting is stopped for the rest of this run, so label this defect and the rest by hand. The labels already written stay.\n`);
    } else if (draftError) {
      output.write(`Claude could not draft ${defect.id}: ${draftError}. Label it by hand.\n`);
    }
    const rejected = [];
    for (const link of defect.links) {
      const choice = await keepOrReject(link);
      if (choice === null) return QUIT;
      if (choice === 's') return SKIP;
      if (choice === 'r') rejected.push(link.pr);
    }
    if (rejected.length > 0 && rejected.length === defect.links.length) {
      output.write('You rejected every link, so this bug has no known introducing PR. It is still a real bug: give it a code, or s to skip it.\n');
    }
    const answer = draft ? await fromDraft(draft, categories) : await byHand(categories);
    if (answer === QUIT || answer === SKIP) return answer;
    const caught = await question('Would have caught it: the evidence that would have caught this bug.', { field: 'would_have_caught' });
    if (caught === null) return QUIT;
    output.write(`Saved ${defect.id}.\n`);
    return { ...answer, would_have_caught: caught, rejected_prs: rejected };
  }

  // Asks for the code and the category with no draft. Returns { code, category }, SKIP or QUIT.
  async function byHand(categories) {
    const code = await question('Code: what went wrong, in a few words. Or s to skip.', { field: 'code' });
    if (code === null) return QUIT;
    if (code.toLowerCase() === 's') return SKIP;
    const category = await pickCategory(categories, null);
    if (category === null) return QUIT;
    return { code, category };
  }

  // Shows Claude's draft, marked as a draft, and asks what to do with it. Returns
  // { code, category, draft }, SKIP or QUIT.
  async function fromDraft(draft, categories) {
    output.write(`Claude's draft, not saved yet:\n  Code: ${draft.code}\n  Category: ${draft.category}\n`);
    let choice;
    for (;;) {
      const answer = await question('c to confirm the draft, e to edit it, or t to throw it away and type your own. Or s to skip this defect.');
      if (answer === null) return QUIT;
      choice = answer.toLowerCase();
      if (['c', 'e', 't', 's'].includes(choice)) break;
      output.write('Please type c, e, t or s.\n');
    }
    if (choice === 's') return SKIP;
    if (choice === 'c') return { code: draft.code, category: draft.category, draft: 'confirmed' };
    if (choice === 't') {
      const answer = await byHand(categories);
      return typeof answer === 'string' ? answer : { ...answer, draft: 'replaced' };
    }
    const typed = await question(`Code. Press Enter to keep the draft's code, or type a new one.\n  ${draft.code}`, { emptyOk: true, field: 'code' });
    if (typed === null) return QUIT;
    const category = await pickCategory(categories, draft.category);
    if (category === null) return QUIT;
    return { code: typed === '' ? draft.code : typed, category, draft: 'edited' };
  }

  // Asks for the category from the list used so far. With `kept`, an empty answer keeps it.
  // An answer of only digits picks from the list, and a number that is not in the list is asked
  // again. So a new category cannot be only digits.
  async function pickCategory(categories, kept) {
    const list = categories.length === 0 ? 'No categories yet, so type a new one.' : `Pick a number, or type a new one:\n${categories.map((name, i) => `  ${i + 1}. ${name}`).join('\n')}`;
    const keep = kept === null ? '' : `\nPress Enter to keep the draft's category: ${kept}`;
    const picked = await question(`Category. ${list}${keep}`, { emptyOk: kept !== null, field: 'category', check: (answer) => notInList(answer, categories) });
    if (picked === null) return null;
    if (picked === '') return kept;
    return /^\d+$/.test(picked) ? categories[Number(picked) - 1] : picked;
  }

  // Returns k to keep the link, r to reject it, s to skip the defect, or null to quit.
  async function keepOrReject(link) {
    for (;;) {
      const evidence = link.found_by === 'revert' ? ', evidence: revert' : '';
      const answer = await question(`Link to PR ${link.pr}, confidence ${Math.round(link.confidence * 100)}%${evidence}: k to keep it, or r to reject it as a false link. Or s to skip this defect.`);
      if (answer === null) return null;
      const choice = answer.toLowerCase();
      if (choice === 'k' || choice === 'r' || choice === 's') return choice;
      output.write('Please type k, r or s.\n');
    }
  }

  return { ask, close: () => reader.close() };
}

// The message for an answer longer than `field` may be in the labels schema, or null. It counts
// characters as the schema does, so an emoji counts as one.
function tooLong(answer, field) {
  const length = [...answer].length;
  const limit = ANSWER_LIMITS[field];
  return length > limit ? `That answer has ${length} characters. ${ANSWER_NAMES[field]} can have at most ${limit}. Please type a shorter one.` : null;
}

// The message for a category answer that is only digits but names no category in the list, or null.
function notInList(answer, categories) {
  if (!/^\d+$/.test(answer) || categories[Number(answer) - 1] !== undefined) return null;
  if (categories.length === 0) return `There are no categories yet, so ${answer} is not one. Type a new category in words.`;
  return `There is no category ${answer}. Pick a number from 1 to ${categories.length}, or type a new category in words.`;
}

function parseOptions(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, claude: { type: 'boolean' } }, strict: true, allowPositionals: false });
    return { json: values.json === true, claude: values.claude === true };
  } catch (error) {
    throw new ToolError(`${error.message}. ${USAGE}`);
  }
}
