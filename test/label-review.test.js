import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftError } from '../src/claude.js';
import { categoryCounts, createReviewSession, whatWentWrong } from '../src/label-review.js';
import { checkLabelLine } from '../src/labels.js';
import { ToolError } from '../src/tool-error.js';
import { SHOP_HISTORY } from './fixtures/report/shop-history.js';

const NOW = new Date('2026-11-21T10:00:00Z');
const now = () => NOW;
// The shop fixture's PRs 1 to 12, with its escaped defects D-012, D-007 and D-006.
const shopText = () => readFileSync(SHOP_HISTORY, 'utf8').trimEnd().split('\n').filter((line) => JSON.parse(line).number <= 12).map((line) => line + '\n').join('');

function folderWithHistory(t, text = shopText()) {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-review-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), text);
  return cwd;
}

const labelsPath = (cwd) => join(cwd, '.exhibit', 'labels.jsonl');
const readLabels = (cwd) => readFileSync(labelsPath(cwd), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
const ANSWER = { code: 'Count ignored quantity', category: 'Arithmetic', would_have_caught: 'A test with two of one item', rejected_prs: [], known_at_review: false };

// A drafter that gives each reply in turn: a draft, or an error to throw.
function drafter(replies) {
  const seen = [];
  return {
    seen,
    draft: async (input) => {
      seen.push(input);
      const reply = replies[seen.length - 1];
      if (reply instanceof Error) throw reply;
      return reply;
    }
  };
}

test('the page lists each open defect, newest fix first, with its evidence and empty fields when there is no drafter', async (t) => {
  const session = await createReviewSession({ cwd: folderWithHistory(t), now });
  await session.prepared;
  const { items, categories } = session.state();
  assert.deepEqual(items.map((item) => item.id), ['D-012', 'D-007', 'D-006']);
  assert.deepEqual(categories, []);
  const first = items[0];
  assert.equal(first.state, 'open');
  assert.equal(first.ready, true);
  assert.equal(first.draft, null);
  assert.equal(first.fix.title, 'Fix item count and the stock check');
  assert.equal(first.fix.url, 'https://github.com/fixture/shop/pull/12');
  assert.deepEqual(first.links.map((link) => [link.pr, link.confidence]), [[1, 0.5], [11, 0.5]]);
  // Each link has its PR's title, a link to it, and the blamed lines for the small diff.
  assert.match(first.links[0].url, /\/pull\/1$/);
  assert.equal(typeof first.links[0].title, 'string');
  assert.equal(first.links[0].lines.length, 1);
  assert.deepEqual(Object.keys(first.links[0].lines[0]).sort(), ['author', 'commit', 'date', 'line', 'path', 'summary', 'text']);
  assert.deepEqual(first.review, { known_at_review: null });
  // Nothing is written until the person acts.
  assert.equal(existsSync(labelsPath(session.cwd)), false);
});

test('a save writes the same labels line as the terminal flow, at once', async (t) => {
  const cwd = folderWithHistory(t);
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  await session.answer('D-012', { action: 'save', ...ANSWER, rejected_prs: [11] });
  const lines = readLabels(cwd);
  assert.deepEqual(lines, [{
    id: 'D-012', fix_pr: 12, introducing_prs: [1], rejected_prs: [11], code: 'Count ignored quantity', category: 'Arithmetic',
    would_have_caught: 'A test with two of one item', labeled_by: 'person', szz_link_rejected: true, known_at_review: false, labeled_at: NOW.toISOString()
  }]);
  assert.deepEqual(checkLabelLine(lines[0]), []);
  const { items, categories } = session.state();
  assert.equal(items[0].state, 'saved');
  assert.deepEqual(categories, ['Arithmetic']);
});

test('Back and a new answer replace the line the page wrote, so each defect has one line', async (t) => {
  const cwd = folderWithHistory(t);
  writeFileSync(labelsPath(cwd), '');
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  await session.answer('D-012', { action: 'save', ...ANSWER });
  await session.answer('D-007', { action: 'save', ...ANSWER, code: 'Tax rounded early' });
  await session.answer('D-012', { action: 'save', ...ANSWER, code: 'Stock check off by one' });
  assert.deepEqual(readLabels(cwd).map((line) => [line.id, line.code]), [['D-012', 'Stock check off by one'], ['D-007', 'Tax rounded early']]);
  // Skip after a save takes the line out again: the file says what the page says.
  await session.answer('D-012', { action: 'skip' });
  assert.deepEqual(readLabels(cwd).map((line) => line.id), ['D-007']);
  assert.equal(session.state().items[0].state, 'skipped');
});

test('skip and later write nothing, and the defect stays open for the next run', async (t) => {
  const cwd = folderWithHistory(t);
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  await session.answer('D-012', { action: 'skip' });
  await session.answer('D-007', { action: 'later' });
  assert.equal(existsSync(labelsPath(cwd)), false);
  assert.deepEqual(session.state().items.map((item) => item.state), ['skipped', 'later', 'open']);
  // Two defects were answered, so two were shown. Open counts every defect with no line.
  assert.deepEqual(session.summary().run, { shown: 2, labeled: 0, skipped: 2, open: 3 });
});

test('shown counts the defects the page showed, as the terminal flow counts them', async (t) => {
  const cwd = folderWithHistory(t);
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  assert.equal(session.summary().run.shown, 0);
  session.seen('D-012');
  session.seen('D-012');
  assert.equal(session.summary().run.shown, 1);
  // An answer counts its defect as shown, even when the page did not say it showed it.
  await session.answer('D-007', { action: 'later' });
  assert.deepEqual(session.summary().run, { shown: 2, labeled: 0, skipped: 1, open: 3 });
  assert.throws(() => session.seen('D-999'), /no open defect D-999/);
});

test('lines written before the page are kept, their defects are not shown, and their categories are in the pick list', async (t) => {
  const cwd = folderWithHistory(t);
  const old = { id: 'D-006', fix_pr: 6, introducing_prs: [1], rejected_prs: [], code: 'Subtotal ignored quantity', category: 'Arithmetic', would_have_caught: 'A quantity test', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-01T00:00:00.000Z' };
  // No line break at the end: the page must not join its line to this one.
  writeFileSync(labelsPath(cwd), JSON.stringify(old));
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  assert.deepEqual(session.state().items.map((item) => item.id), ['D-012', 'D-007']);
  assert.deepEqual(session.state().categories, ['Arithmetic']);
  await session.answer('D-007', { action: 'save', ...ANSWER, category: 'Rounding' });
  await session.answer('D-007', { action: 'save', ...ANSWER, category: 'Arithmetic' });
  assert.deepEqual(readLabels(cwd).map((line) => [line.id, line.category]), [['D-006', 'Arithmetic'], ['D-007', 'Arithmetic']]);
  assert.equal(readFileSync(labelsPath(cwd), 'utf8').split('\n')[0], JSON.stringify(old));
});

test('an answer that does not fit the schema writes nothing and says why', async (t) => {
  const cwd = folderWithHistory(t);
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  await assert.rejects(session.answer('D-012', { action: 'save', ...ANSWER, would_have_caught: '' }), (error) => error instanceof ToolError && /would_have_caught/.test(error.message));
  await assert.rejects(session.answer('D-012', { action: 'save', ...ANSWER, rejected_prs: [99] }), /PR 99 is not a link of D-012/);
  await assert.rejects(session.answer('D-999', { action: 'skip' }), /no open defect D-999/);
  await assert.rejects(session.answer('D-012', { action: 'maybe' }), /unknown action/);
  assert.equal(existsSync(labelsPath(cwd)), false);
});

test('a line break typed in the evidence becomes a space, and the answers are trimmed', async (t) => {
  const cwd = folderWithHistory(t);
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  await session.answer('D-012', { action: 'save', ...ANSWER, code: '  Count ignored quantity ', would_have_caught: 'A test with\n two of one item\n' });
  assert.equal(readLabels(cwd)[0].code, 'Count ignored quantity');
  assert.equal(readLabels(cwd)[0].would_have_caught, 'A test with two of one item');
});

test('a line the page wrote that someone changed by hand is not overwritten', async (t) => {
  const cwd = folderWithHistory(t);
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  await session.answer('D-012', { action: 'save', ...ANSWER });
  writeFileSync(labelsPath(cwd), readFileSync(labelsPath(cwd), 'utf8').replace('Count ignored quantity', 'Changed by hand'));
  await assert.rejects(session.answer('D-012', { action: 'save', ...ANSWER, code: 'New' }), /changed outside this page/);
  assert.equal(readLabels(cwd)[0].code, 'Changed by hand');
});

test('drafts: an unchanged draft is confirmed, a changed one is edited, a thrown-away one is the person\'s, and the agreement counts them', async (t) => {
  const cwd = folderWithHistory(t);
  const make = (code) => ({ code, category: 'Arithmetic', model: 'claude-test' });
  const { draft, seen } = drafter([make('A'), make('B'), make('C')]);
  const session = await createReviewSession({ cwd, draft, now });
  await session.prepared;
  assert.deepEqual(session.state().items.map((item) => item.draft?.code), ['A', 'B', 'C']);
  // Each draft sees the categories in the file, as the terminal flow sends them.
  assert.deepEqual(seen[0].categories, []);
  await session.answer('D-012', { action: 'save', ...ANSWER, code: 'A', category: 'Arithmetic' });
  await session.answer('D-007', { action: 'save', ...ANSWER, code: 'B, edited', category: 'Arithmetic' });
  await session.answer('D-006', { action: 'save', ...ANSWER, code: 'C', category: 'Arithmetic', draft: 'replaced' });
  assert.deepEqual(readLabels(cwd).map((line) => line.labeled_by), ['claude_draft_confirmed', 'claude_draft_edited', 'person']);
  assert.deepEqual(readLabels(cwd).map((line) => line.claude_draft.code), ['A', 'B', 'C']);
  const { drafts } = session.summary();
  assert.equal(drafts.run.shown, 3);
  assert.equal(drafts.run.kept, 1);
  assert.equal(drafts.file.shown, 3);
});

test('a draft that fails leaves that defect to label by hand, and a stopping failure stops the later drafts', async (t) => {
  const cwd = folderWithHistory(t);
  const { draft, seen } = drafter([new DraftError('the Anthropic API answered 401: no', { stopsDrafting: 'Check ANTHROPIC_API_KEY.' })]);
  const session = await createReviewSession({ cwd, draft, now });
  await session.prepared;
  const items = session.state().items;
  assert.equal(seen.length, 1);
  assert.equal(items[0].draft, null);
  assert.equal(items[0].draftError, 'the Anthropic API answered 401: no');
  assert.equal(items[0].draftStopped, 'Check ANTHROPIC_API_KEY.');
  assert.deepEqual(items.slice(1).map((item) => [item.ready, item.draft, item.draftError]), [[true, null, null], [true, null, null]]);
});

test('a save waits for the defect\'s draft, so the line keeps the draft the page showed', async (t) => {
  const cwd = folderWithHistory(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const draft = async () => {
    await gate;
    return { code: 'A', category: 'Arithmetic', model: 'claude-test' };
  };
  const session = await createReviewSession({ cwd, draft, now });
  assert.equal(session.state().items[0].ready, false);
  await assert.rejects(session.answer('D-012', { action: 'save', ...ANSWER }), /still being prepared/);
  release();
  await session.prepared;
  await session.answer('D-012', { action: 'save', ...ANSWER, code: 'A' });
  assert.equal(readLabels(cwd)[0].labeled_by, 'claude_draft_confirmed');
});

test('the review proposal comes from a follow-up sentence in the fix PR, and an empty known_at_review keeps it', async (t) => {
  const lines = shopText().trimEnd().split('\n').map((line) => JSON.parse(line));
  const fix = lines.find((line) => line.number === 12);
  fix.body = 'Follow-ups from the review of PR 11.';
  const cwd = folderWithHistory(t, lines.map((line) => JSON.stringify(line) + '\n').join(''));
  const session = await createReviewSession({ cwd, now });
  await session.prepared;
  assert.equal(session.state().items[0].review.known_at_review, true);
  const rest = { ...ANSWER };
  delete rest.known_at_review;
  await session.answer('D-012', { action: 'save', ...rest });
  assert.equal(readLabels(cwd)[0].known_at_review, true);
});

test('categoryCounts says which categories have two counted defects from two PRs, as policy suggest counts them (spec 9.13)', () => {
  const line = (id, category, prs) => ({ id, fix_pr: Number(id.slice(2)), category, introducing_prs: prs });
  const counts = categoryCounts([
    line('D-001', 'Race', [10]),
    line('D-002', 'Race', [11]),
    line('D-003', 'Race', []),
    line('D-004', 'Cache key', [20]),
    line('D-005', 'Cache key', [20]),
    line('D-006', 'Docs', [30]),
    // A second line for D-001 does not count again: the first line wins, as in the report.
    line('D-001', 'Docs', [40])
  ]);
  assert.deepEqual(counts, [
    { category: 'Race', defects: ['D-001', 'D-002', 'D-003'], counted: ['D-001', 'D-002'], prs: [10, 11], rule: 'ready' },
    { category: 'Cache key', defects: ['D-004', 'D-005'], counted: ['D-004', 'D-005'], prs: [20], rule: 'waiting for a second PR' },
    { category: 'Docs', defects: ['D-006'], counted: ['D-006'], prs: [30], rule: 'waiting for a second defect' }
  ]);
});

test('whatWentWrong gives one plain line from the fix PR body', () => {
  assert.equal(whatWentWrong({ title: 'T', body: '## Why\n\nThe **merge** hold ignored a note. It was bad.\n\n## What changed\n\n- x' }), 'The merge hold ignored a note.');
  assert.equal(whatWentWrong({ title: 'Fix the count', body: '' }), 'Fix the count');
  assert.equal(whatWentWrong({ title: 'Fix the count', body: null }), 'Fix the count');
  assert.equal(whatWentWrong({ title: 'T', body: 'First paragraph with [a link](http://x) and `code`.\n\nSecond.' }), 'First paragraph with a link and code.');
  assert.equal(whatWentWrong({ title: 'T', body: 'x'.repeat(400) }).length, 300);
});

test('whatWentWrong reads the text under a heading that has no blank line after it', () => {
  const what = (body) => whatWentWrong({ title: 'The title', body });
  assert.equal(what('## Why\nThe Board read failed.\n\n## How\nWe added backoff.'), 'The Board read failed.');
  assert.equal(what('Ticket 148.\n\n## Why\nThe Board read failed.'), 'The Board read failed.');
  // The sentence under the heading, not the next paragraph.
  assert.equal(what('## Why\nX.\n\nY.'), 'X.');
  // With no Why heading, a heading line is left out and the text under it is kept.
  assert.equal(what('## Summary\nThe count was off.'), 'The count was off.');
  // An empty Why part does not take a sentence from the next part.
  assert.equal(what('Ticket 148.\n\n## Why\n\n## How\nWe added backoff.'), 'Ticket 148.');
  // A list under the heading is read without its marks.
  assert.equal(what('## Why\n- The cache key was wrong.\n- More.'), 'The cache key was wrong.');
});
