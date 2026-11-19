// Builds a small git repo with planted bugs and the fixes for them, for SZZ tests.
//
// The repo is built from SCRIPT below, in a new temp directory, with only `git`.
// Dates, names and git settings are fixed, so every build gives the same commit SHAs.
// The answer key in szz-answer-key.json says which introducing PRs SZZ must find for each fix.
//
// Each PR is kept at refs/pull/N/head, as on GitHub. PRs are merged in one of two ways:
// - 'merge': a merge commit on main, with the PR branch as its second parent.
// - 'squash': one new commit on main with all of the PR's changes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const START = Date.UTC(2026, 0, 5, 9, 0, 0);
const STEP = 60 * 60 * 1000;

const lines = (...rows) => rows.join('\n') + '\n';

const CART_V1 = lines(
  'export function subtotal(items) {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price;',
  '  }',
  '  return sum;',
  '}',
  '',
  'export function itemCount(items) {',
  '  return items.length;',
  '}'
);

const DISCOUNT_V1 = lines(
  'export function applyDiscount(total, percent) {',
  '  return total - percent;',
  '}'
);

const DISCOUNT_V2 = lines(
  'export function applyDiscount(total, percent) {',
  '  if (percent <= 0) return total;',
  '  return total - percent;',
  '}'
);

const TAX_V1 = lines(
  'export function addTax(total, rate) {',
  '  const tax = total * rate;',
  '  return Math.round(total + tax);',
  '}'
);

const TAX_V2 = lines(
  'export const DEFAULT_RATE = 0.2;',
  '',
  'export function addTax(total, rate = DEFAULT_RATE) {',
  '  const tax = total * rate;',
  '  return Math.round(total + tax);',
  '}'
);

const MONEY = [
  '// Turns cents into a string like "12.50".',
  'export function money(cents) {',
  '  return (cents / 100).toFixed(2);',
  '}'
];
const PAD = (indent, comment = '// Pads a label to a fixed width.') => [
  comment,
  'export function pad(label, width) {',
  `${indent}return label.padEnd(width);`,
  '}'
];
const RECEIPT = [
  '// Joins receipt lines.',
  'export function receipt(rows) {',
  "  return rows.join('\\n');",
  '}'
];
const HEADER = ['// Formats money for receipts.', ''];

// The pad body starts with four spaces. PR 8 fixes only that.
const FORMAT_V1 = lines(...HEADER, ...MONEY, '', ...PAD('    '), '', ...RECEIPT);
const FORMAT_V2 = lines(...HEADER, ...MONEY, '', ...PAD('  '), '', ...RECEIPT);
const FORMAT_V3 = lines(...HEADER, ...RECEIPT, '', ...MONEY, '', ...PAD('  '));
const FORMAT_V4 = lines(
  ...HEADER,
  ...RECEIPT,
  '',
  '// Turns cents into a string such as "12.50".',
  ...MONEY.slice(1),
  '',
  ...PAD('  ', '// Pads a label on the right to a fixed width.')
);

const SHOP = lines(
  "export { subtotal, itemCount } from './cart.js';",
  "export { applyDiscount } from './discount.js';",
  "export { addTax } from './tax.js';",
  "export { money, pad, receipt } from './format.js';"
);

// Each PR: who wrote it, how it merges, whether it is a fix, and its commits.
// Each commit maps file paths to their new full text.
const PRS = {
  1: { title: 'Add cart subtotal', author: 'ana', way: 'merge', fix: false,
    commits: [{ message: 'Add cart subtotal', files: { 'src/cart.js': CART_V1 } }] },
  2: { title: 'Add discounts', author: 'ben', way: 'squash', fix: false,
    commits: [
      { message: 'Add applyDiscount', files: { 'src/discount.js': DISCOUNT_V1 } },
      { message: 'Skip zero discounts', files: { 'src/discount.js': DISCOUNT_V2 } }
    ] },
  3: { title: 'Add tax', author: 'cy', way: 'merge', fix: false,
    commits: [
      { message: 'Add addTax', files: { 'src/tax.js': TAX_V1 } },
      { message: 'Add a default tax rate', files: { 'src/tax.js': TAX_V2 } }
    ] },
  4: { title: 'Add receipt formatting', author: 'ana', way: 'merge', fix: false,
    commits: [{ message: 'Add money, pad and receipt', files: { 'src/format.js': FORMAT_V1 } }] },
  5: { title: 'Add the shop entry point', author: 'ben', way: 'squash', fix: false,
    commits: [{ message: 'Add src/shop.js', files: { 'src/shop.js': SHOP } }] },
  6: { title: 'Fix subtotal to count quantity', author: 'cy', way: 'merge', fix: true,
    commits: [{ message: 'Multiply price by quantity',
      files: { 'src/cart.js': CART_V1.replace('sum += item.price;', 'sum += item.price * item.qty;') } }] },
  7: { title: 'Fix discount and tax math', author: 'ana', way: 'squash', fix: true,
    commits: [
      { message: 'Take the discount as a percent',
        files: { 'src/discount.js': DISCOUNT_V2.replace('total - percent;', 'total - (total * percent) / 100;') } },
      { message: 'Keep cents when adding tax',
        files: { 'src/tax.js': TAX_V2.replace('Math.round(total + tax);', 'total + tax;') } }
    ] },
  8: { title: 'Fix indentation in pad', author: 'ben', way: 'merge', fix: true,
    commits: [{ message: 'Indent pad with two spaces', files: { 'src/format.js': FORMAT_V2 } }] },
  9: { title: 'Fix the order of receipt helpers', author: 'cy', way: 'squash', fix: true,
    commits: [{ message: 'Move receipt to the top', files: { 'src/format.js': FORMAT_V3 } }] },
  10: { title: 'Fix comments in format.js', author: 'ana', way: 'merge', fix: true,
    commits: [{ message: 'Say more in the comments', files: { 'src/format.js': FORMAT_V4 } }] }
};

// The order of events. PR 3 opens before PR 2 merges, so its merge joins two lines of work.
const SCRIPT = [
  ['open', 1], ['merge', 1],
  ['open', 2], ['open', 3], ['merge', 2], ['merge', 3],
  ['open', 4], ['merge', 4],
  ['open', 5], ['merge', 5],
  ['open', 6], ['merge', 6],
  ['open', 7], ['merge', 7],
  ['open', 8], ['merge', 8],
  ['open', 9], ['merge', 9],
  ['open', 10], ['merge', 10]
];

const BASE_FILES = {
  'README.md': lines('# Shop', '', 'A tiny shop. Exhibit uses it as a test fixture for SZZ.'),
  '.gitignore': lines('.exhibit/')
};

/**
 * Builds the fixture repo in a new temp directory.
 * @returns {{ dir: string, historyPath: string, history: object[], cleanup: () => void }}
 *   `history` holds the records also written to `<dir>/.exhibit/history.jsonl`.
 *   Call `cleanup` to remove the directory.
 */
export function buildSzzRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-szz-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const history = build(dir);
    const historyPath = join(dir, '.exhibit', 'history.jsonl');
    mkdirSync(dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, history.map((pr) => JSON.stringify(pr) + '\n').join(''));
    return { dir, historyPath, history, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Reads the answer key: for each fix PR, the introducing PRs that SZZ must find. */
export function readAnswerKey() {
  return JSON.parse(readFileSync(new URL('./szz-answer-key.json', import.meta.url), 'utf8'));
}

function build(dir) {
  let tick = 0;
  // Ignore the user's and the system's git config, so hooks, signing and templates
  // cannot change the commits.
  const run = (args, author = 'maintainer') => {
    const date = `@${(START + tick * STEP) / 1000} +0000`;
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: `${author}@example.com`,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author,
        GIT_COMMITTER_EMAIL: `${author}@example.com`,
        GIT_COMMITTER_DATE: date
      }
    }).trim();
  };
  const commit = (message, files, author) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    run(['add', '--all']);
    run(['commit', '--quiet', '-m', message], author);
    tick++;
  };

  run(['init', '--quiet', '--initial-branch=main', '--template=']);
  commit('Initial commit', BASE_FILES);

  const opened = new Map();
  const history = [];
  for (const [event, number] of SCRIPT) {
    const pr = PRS[number];
    const branch = `pr-${number}`;
    if (event === 'open') {
      const base = run(['rev-parse', 'main']);
      run(['switch', '--quiet', '-c', branch, base]);
      for (const c of pr.commits) commit(c.message, c.files, pr.author);
      run(['update-ref', `refs/pull/${number}/head`, branch]);
      run(['switch', '--quiet', 'main']);
      opened.set(number, base);
      continue;
    }

    const head = run(['rev-parse', branch]);
    if (pr.way === 'merge') {
      run(['merge', '--quiet', '--no-ff', '-m', `Merge pull request #${number} from fixture/${branch}`, branch], 'maintainer');
    } else {
      run(['merge', '--quiet', '--squash', branch]);
      // A squash merge leaves a draft message file. Drop it, so the commit uses only -m.
      unlinkSync(join(dir, '.git', 'SQUASH_MSG'));
      run(['commit', '--quiet', '-m', `${pr.title} (#${number})`], 'maintainer');
    }
    const mergedAt = new Date(START + tick * STEP).toISOString().replace('.000Z', 'Z');
    tick++;
    run(['branch', '--quiet', '-D', branch]);

    history.push({
      number,
      title: pr.title,
      body: '',
      author: pr.author,
      labels: pr.fix ? ['bug'] : [],
      merged_at: mergedAt,
      base_sha: opened.get(number),
      merge_sha: run(['rev-parse', 'main']),
      files: diffFiles(run(['diff', '--numstat', `${opened.get(number)}...${head}`])),
      classification: { fix: pr.fix === true, fix_signal: pr.fix ? 'label:bug' : null }
    });
  }
  return history;
}

function diffFiles(numstat) {
  return numstat.split('\n').map((row) => {
    const [additions, deletions, path] = row.split('\t');
    return { path, additions: Number(additions), deletions: Number(deletions) };
  });
}
