import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { LABELS, labelDefects } from '../labels.js';
import { ToolError } from '../tool-error.js';

const USAGE = 'Usage: exhibit label [--json]';

// `exhibit label [--json]`
// Shows each escaped defect in .exhibit/history.jsonl that has no label yet, with its SZZ
// evidence. The person keeps or rejects each SZZ link, then gives a code, a category and the
// evidence that would have caught it. Each answer goes to .exhibit/labels.jsonl at once (spec
// 8.4). With --json, the defects and the questions go to stderr, and stdout gets only the summary
// at the end.
export async function label(argv, { cwd, stdin, stdout, stderr, now }) {
  const options = parseOptions(argv);
  const screen = options.json ? stderr : stdout;
  const keyboard = createKeyboard({ input: stdin, output: screen });
  let summary;
  try {
    summary = await labelDefects({ cwd, ask: keyboard.ask, now });
  } finally {
    keyboard.close();
  }

  if (options.json) {
    stdout.write(JSON.stringify({ ...summary, output: LABELS }) + '\n');
    return;
  }
  if (summary.shown === 0) {
    stdout.write(`Every escaped defect has a code already. The labels are in ${LABELS}.\n`);
    return;
  }
  const left = summary.open === 0
    ? 'Every escaped defect has a code now.'
    : `${summary.open} still ${summary.open === 1 ? 'has' : 'have'} no code. Run exhibit label again to label ${summary.open === 1 ? 'it' : 'them'}.`;
  stdout.write(`\nLabeled ${summary.labeled} escaped ${summary.labeled === 1 ? 'defect' : 'defects'}. Skipped ${summary.skipped}. ${left}\nThe labels are in ${LABELS}.\n`);
}

// The answer source for a person at a keyboard, or for answers piped to stdin. The lines are read
// through one iterator, so a line that comes before its question waits for it.
function createKeyboard({ input, output }) {
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  let introduced = false;

  // Returns the trimmed answer, or null when the person quits: q, or the end of the input.
  // An empty answer is asked again.
  async function question(text) {
    for (;;) {
      output.write(`${text}\n> `);
      const { value, done } = await lines.next();
      if (done) {
        output.write('\n');
        return null;
      }
      const answer = value.trim();
      if (answer.toLowerCase() === 'q') return null;
      if (answer !== '') return answer;
      output.write('Please type an answer.\n');
    }
  }

  async function ask(defect, { categories, text, position, open }) {
    if (!introduced) {
      output.write(`${open} escaped ${open === 1 ? 'defect has' : 'defects have'} no code yet. For each one, keep or reject each SZZ link, then type what went wrong, its category, and the evidence that would have caught it. ` +
        `Each label is saved as soon as you give it. Type s to skip a defect for now, or q at any question to quit.\n`);
      introduced = true;
    }
    output.write(`\n${defect.id}, ${position} of ${open} with no code yet\n${text}\n`);
    const rejected = [];
    for (const link of defect.links) {
      const choice = await keepOrReject(link);
      if (choice === null) return 'quit';
      if (choice === 's') return 'skip';
      if (choice === 'r') rejected.push(link.pr);
    }
    if (rejected.length > 0 && rejected.length === defect.links.length) {
      output.write('You rejected every link, so this bug has no known introducing PR. It is still a real bug: give it a code, or s to skip it.\n');
    }
    const code = await question('Code: what went wrong, in a few words. Or s to skip.');
    if (code === null) return 'quit';
    if (code.toLowerCase() === 's') return 'skip';
    const list = categories.length === 0 ? 'No categories yet, so type a new one.' : `Pick a number, or type a new one:\n${categories.map((name, i) => `  ${i + 1}. ${name}`).join('\n')}`;
    const picked = await question(`Category. ${list}`);
    if (picked === null) return 'quit';
    const category = /^\d+$/.test(picked) && categories[Number(picked) - 1] !== undefined ? categories[Number(picked) - 1] : picked;
    const caught = await question('Would have caught it: the evidence that would have caught this bug.');
    if (caught === null) return 'quit';
    output.write(`Saved ${defect.id}.\n`);
    return { code, category, would_have_caught: caught, rejected_prs: rejected };
  }

  // Returns k to keep the link, r to reject it, s to skip the defect, or null to quit.
  async function keepOrReject(link) {
    for (;;) {
      const answer = await question(`Link to PR ${link.pr}, confidence ${Math.round(link.confidence * 100)}%: k to keep it, or r to reject it as a false link. Or s to skip this defect.`);
      if (answer === null) return null;
      const choice = answer.toLowerCase();
      if (choice === 'k' || choice === 'r' || choice === 's') return choice;
      output.write('Please type k, r or s.\n');
    }
  }

  return { ask, close: () => reader.close() };
}

function parseOptions(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, strict: true, allowPositionals: false });
    return { json: values.json === true };
  } catch (error) {
    throw new ToolError(`${error.message}. ${USAGE}`);
  }
}
