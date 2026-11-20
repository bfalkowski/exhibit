import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolError } from '../src/tool-error.js';
import { checkLabelLine, defectId, labelDefects } from '../src/labels.js';
import { DraftError } from '../src/claude.js';
import { SHOP_HISTORY } from './fixtures/report/shop-history.js';

const NOW = new Date('2026-11-19T10:00:00Z');
// The shop fixture's PRs 1 to 12, with its escaped defects D-012, D-007 and D-006. The fixture
// can gain PRs, so the tests pin this part of it.
const shopText = () => readFileSync(SHOP_HISTORY, 'utf8').trimEnd().split('\n').filter((line) => JSON.parse(line).number <= 12).map((line) => line + '\n').join('');

// A new folder with .exhibit/history.jsonl holding `text`. It is removed when test t ends.
function folderWithHistory(t, text = shopText()) {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-label-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), text);
  return cwd;
}

const labelsPath = (cwd) => join(cwd, '.exhibit', 'labels.jsonl');
const readLabels = (cwd) => readFileSync(labelsPath(cwd), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

// An answer source that gives `answers` in order, and records what it was asked.
function scripted(answers) {
  const asked = [];
  const ask = async (defect, context) => {
    asked.push({ id: defect.id, links: defect.links, categories: context.categories, text: context.text });
    if (asked.length > answers.length) throw new Error(`asked about ${defect.id}, but the script has no answer left`);
    return answers[asked.length - 1];
  };
  return { ask, asked };
}

// A history with five escaped defects: PR 7 of the shop fixture, copied as fix PRs 101 to 105.
function fiveDefects() {
  const lines = shopText().trimEnd().split('\n').map((line) => JSON.parse(line));
  const fix = lines.find((line) => line.number === 7);
  const copies = [101, 102, 103, 104, 105].map((number, i) => ({ ...fix, number, url: `https://github.com/fixture/shop/pull/${number}`, merged_at: `2026-02-0${i + 1}T10:00:00Z` }));
  return [...lines.filter((line) => line.number !== 7 && line.classification.fix === false), ...copies].map((line) => JSON.stringify(line) + '\n').join('');
}

const answer = (code, category, caught) => ({ code, category, would_have_caught: caught });

test('a defect id is D- and the fix PR number, with zeros to make at least three digits', () => {
  assert.equal(defectId(4), 'D-004');
  assert.equal(defectId(58), 'D-058');
  assert.equal(defectId(1234), 'D-1234');
});

test('scripted answers give the expected labels file', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask, asked } = scripted([
    answer('Discount math used percent as money', 'arithmetic', 'A test with a 10% discount on 50'),
    'skip',
    answer('Tax rounded before the total', 'arithmetic', 'A test that pins the rounding')
  ]);

  const summary = await labelDefects({ cwd, ask, now: () => NOW });

  // The fixture's escaped defects, newest fix first, as the report lists them.
  assert.deepEqual(asked.map((a) => a.id), ['D-012', 'D-007', 'D-006']);
  assert.deepEqual(summary, { shown: 3, labeled: 2, skipped: 1, open: 1 });
  assert.deepEqual(readLabels(cwd), [
    { id: 'D-012', fix_pr: 12, introducing_prs: [1, 11], rejected_prs: [], code: 'Discount math used percent as money', category: 'arithmetic', would_have_caught: 'A test with a 10% discount on 50', labeled_by: 'person', szz_link_rejected: false, labeled_at: '2026-11-19T10:00:00.000Z' },
    { id: 'D-006', fix_pr: 6, introducing_prs: [1], rejected_prs: [], code: 'Tax rounded before the total', category: 'arithmetic', would_have_caught: 'A test that pins the rounding', labeled_by: 'person', szz_link_rejected: false, labeled_at: '2026-11-19T10:00:00.000Z' }
  ]);
  for (const line of readLabels(cwd)) assert.deepEqual(checkLabelLine(line), [], line.id);
});

test('each defect shows the fix PR, its introducing PRs with confidence, and the blame for each line', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask, asked } = scripted(['quit']);
  await labelDefects({ cwd, ask, now: () => NOW });
  const [{ text }] = asked;
  assert.match(text, /^Fix PR 12: /);
  assert.match(text, /Introducing PR 1: .*, confidence 50% \(1 of 2 counted lines\)/);
  assert.match(text, /Introducing PR 11: .*, confidence 50%/);
  assert.match(text, /blame: commit [0-9a-f]{7} by /);
  assert.match(text, /The fix PR: https:\/\/github\.com\/fixture\/shop\/pull\/12\n$/);
});

test('the categories used so far are offered: from the file, then new ones from this run', async (t) => {
  const cwd = folderWithHistory(t);
  await labelDefects({ cwd, ask: scripted([answer('a', 'arithmetic', 'b'), 'quit']).ask, now: () => NOW });
  const { ask, asked } = scripted([answer('c', 'state', 'd'), answer('e', 'arithmetic', 'f')]);
  await labelDefects({ cwd, ask, now: () => NOW });
  assert.deepEqual(asked.map((a) => a.categories), [['arithmetic'], ['arithmetic', 'state']]);
});

test('quitting after two of five defects leaves two lines, and the next run shows only the other three', async (t) => {
  const cwd = folderWithHistory(t, fiveDefects());
  const first = scripted([answer('one', 'cat', 'test one'), answer('two', 'cat', 'test two'), 'quit']);
  const summary = await labelDefects({ cwd, ask: first.ask, now: () => NOW });
  assert.deepEqual(first.asked.map((a) => a.id), ['D-105', 'D-104', 'D-103']);
  assert.deepEqual(summary, { shown: 3, labeled: 2, skipped: 0, open: 3 });
  assert.deepEqual(readLabels(cwd).map((line) => line.id), ['D-105', 'D-104']);

  const second = scripted(['skip', 'skip', 'skip']);
  assert.deepEqual(await labelDefects({ cwd, ask: second.ask, now: () => NOW }), { shown: 3, labeled: 0, skipped: 3, open: 3 });
  assert.deepEqual(second.asked.map((a) => a.id), ['D-103', 'D-102', 'D-101']);
});

test('with every defect labeled, label asks nothing', async (t) => {
  const cwd = folderWithHistory(t);
  await labelDefects({ cwd, ask: scripted([answer('a', 'x', 'b'), answer('c', 'x', 'd'), answer('e', 'x', 'f')]).ask, now: () => NOW });
  const again = scripted([]);
  assert.deepEqual(await labelDefects({ cwd, ask: again.ask, now: () => NOW }), { shown: 0, labeled: 0, skipped: 0, open: 0 });
});

test('a line that fails the labels schema is refused, and the file keeps its earlier lines', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask } = scripted([answer('first', 'x', 'a test'), answer('', 'x', 'a test')]);
  await assert.rejects(labelDefects({ cwd, ask, now: () => NOW }), (error) => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /D-007 does not fit the labels schema, so it was not written/);
    assert.match(error.message, /\/code: does not match/);
    return true;
  });
  assert.deepEqual(readLabels(cwd).map((line) => line.code), ['first']);
});

test('a code longer than 200 characters is refused', async (t) => {
  const cwd = folderWithHistory(t);
  await assert.rejects(labelDefects({ cwd, ask: scripted([answer('x'.repeat(201), 'x', 'y')]).ask, now: () => NOW }), ToolError);
});

test('a labels file with a broken line is refused, and stays as it was', async (t) => {
  const cwd = folderWithHistory(t);
  const broken = '{"id":"D-012","fix_pr":12}\n';
  writeFileSync(labelsPath(cwd), broken);
  await assert.rejects(labelDefects({ cwd, ask: scripted([]).ask, now: () => NOW }), /\.exhibit\/labels\.jsonl line 1 does not fit the labels schema/);
  assert.equal(readFileSync(labelsPath(cwd), 'utf8'), broken);
});

test('a new line starts on its own line when the file does not end with a line break', async (t) => {
  const cwd = folderWithHistory(t);
  await labelDefects({ cwd, ask: scripted([answer('a', 'x', 'b'), 'quit']).ask, now: () => NOW });
  writeFileSync(labelsPath(cwd), readFileSync(labelsPath(cwd), 'utf8').trimEnd());
  await labelDefects({ cwd, ask: scripted([answer('c', 'x', 'd'), 'quit']).ask, now: () => NOW });
  assert.deepEqual(readLabels(cwd).map((line) => line.id), ['D-012', 'D-007']);
});

test('the labels schema checks that the id matches fix_pr', () => {
  const line = { id: 'D-012', fix_pr: 12, introducing_prs: [1], code: 'a', category: 'b', would_have_caught: 'c', labeled_by: 'person', szz_link_rejected: false, labeled_at: '2026-11-19T10:00:00.000Z' };
  assert.deepEqual(checkLabelLine(line), []);
  assert.deepEqual(checkLabelLine({ ...line, id: 'D-013' }), ['/id: must be D-012, the id of fix PR 12']);
  assert.deepEqual(checkLabelLine({ ...line, labeled_by: 'robot' }), ['/labeled_by: does not match ^(person|claude_draft_confirmed|claude_draft_edited)$']);
});

test('no history file, or a history with no SZZ links, says to run exhibit history first', async (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'exhibit-label-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  await assert.rejects(labelDefects({ cwd: empty, ask: scripted([]).ask }), /Run exhibit history first/);
  const noLinks = shopText().trimEnd().split('\n').map((line) => JSON.stringify({ ...JSON.parse(line), szz: null }) + '\n').join('');
  await assert.rejects(labelDefects({ cwd: folderWithHistory(t, noLinks), ask: scripted([]).ask }), /has no SZZ links.*Run exhibit history first/s);
});

test('rejecting one of two links leaves one introducing PR and records the other as rejected', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask, asked } = scripted([{ ...answer('Discount math used percent as money', 'arithmetic', 'A test with a 10% discount on 50'), rejected_prs: [11] }, 'quit']);
  await labelDefects({ cwd, ask, now: () => NOW });
  // Each defect comes with its links, so the person can keep or reject each one.
  assert.deepEqual(asked[0].links, [{ pr: 1, confidence: 0.5 }, { pr: 11, confidence: 0.5 }]);
  const [line] = readLabels(cwd);
  assert.deepEqual([line.introducing_prs, line.rejected_prs, line.szz_link_rejected], [[1], [11], true]);
  assert.deepEqual(checkLabelLine(line), []);
});

test('rejecting every link still saves the defect, with no introducing PR', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask } = scripted([{ ...answer('Discount math used percent as money', 'arithmetic', 'A test with a 10% discount on 50'), rejected_prs: [1, 11] }, 'quit']);
  assert.deepEqual(await labelDefects({ cwd, ask, now: () => NOW }), { shown: 2, labeled: 1, skipped: 0, open: 2 });
  const [line] = readLabels(cwd);
  assert.deepEqual([line.id, line.introducing_prs, line.rejected_prs, line.szz_link_rejected], ['D-012', [], [1, 11], true]);
  assert.deepEqual(checkLabelLine(line), []);
});

test('a rejected PR that is not a link of the defect is refused', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask } = scripted([{ ...answer('a', 'b', 'c'), rejected_prs: [99] }]);
  await assert.rejects(labelDefects({ cwd, ask, now: () => NOW }), /PR 99 is not a link of D-012/);
});

test('the labels schema checks that szz_link_rejected matches rejected_prs', () => {
  const line = { id: 'D-012', fix_pr: 12, introducing_prs: [1], rejected_prs: [11], code: 'a', category: 'b', would_have_caught: 'c', labeled_by: 'person', szz_link_rejected: true, labeled_at: '2026-11-19T10:00:00.000Z' };
  assert.deepEqual(checkLabelLine(line), []);
  assert.deepEqual(checkLabelLine({ ...line, szz_link_rejected: false }), ['/szz_link_rejected: must be true, because rejected_prs is not empty']);
  assert.deepEqual(checkLabelLine({ ...line, rejected_prs: [] }), ['/szz_link_rejected: must be false, because rejected_prs is empty']);
  // A line written before S3 has no rejected_prs, and still passes.
  const old = { ...line, szz_link_rejected: false };
  delete old.rejected_prs;
  assert.deepEqual(checkLabelLine(old), []);
});

// A drafter that gives `drafts` in order, and records what it was given. A draft that is an Error
// is thrown, as the Claude client throws a DraftError when the API fails.
function drafter(drafts) {
  const given = [];
  const draft = async (input) => {
    given.push(input);
    const next = drafts[given.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { draft, given };
}

const DRAFT = { code: 'Discount applied the percent as money', category: 'arithmetic', model: 'claude-opus-5-5' };

test('with a drafter, each defect is drafted from what the person reads, and the answer source sees the draft', async (t) => {
  const cwd = folderWithHistory(t);
  const { draft, given } = drafter([DRAFT]);
  const seen = [];
  const ask = async (defect, context) => {
    seen.push(context);
    return 'quit';
  };
  await labelDefects({ cwd, ask, draft, now: () => NOW });
  assert.equal(given[0].id, 'D-012');
  assert.match(given[0].title, /\S/);
  assert.ok('body' in given[0]);
  assert.equal(given[0].text, seen[0].text);
  assert.deepEqual(given[0].categories, []);
  assert.deepEqual(seen[0].draft, DRAFT);
  // Quitting with the draft on screen writes nothing.
  assert.equal(existsSync(labelsPath(cwd)), false);
});

test('confirming the draft gives claude_draft_confirmed and keeps the draft', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask } = scripted([{ code: DRAFT.code, category: DRAFT.category, would_have_caught: 'A 10% discount test', draft: 'confirmed' }, 'quit']);
  await labelDefects({ cwd, ask, draft: drafter([DRAFT]).draft, now: () => NOW });
  const [line] = readLabels(cwd);
  assert.equal(line.labeled_by, 'claude_draft_confirmed');
  assert.deepEqual(line.claude_draft, DRAFT);
  assert.deepEqual(checkLabelLine(line), []);
});

test('editing the draft gives claude_draft_edited and keeps the draft, so the change can be seen', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask } = scripted([{ code: 'Discount took 10 off, not 10%', category: DRAFT.category, would_have_caught: 'A 10% discount test', draft: 'edited' }, 'quit']);
  await labelDefects({ cwd, ask, draft: drafter([DRAFT]).draft, now: () => NOW });
  const [line] = readLabels(cwd);
  assert.deepEqual([line.labeled_by, line.code, line.claude_draft], ['claude_draft_edited', 'Discount took 10 off, not 10%', DRAFT]);
  assert.deepEqual(checkLabelLine(line), []);
});

test('replacing the draft gives person and keeps the draft', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask } = scripted([{ code: 'Wrong unit for the discount', category: 'units', would_have_caught: 'A 10% discount test', draft: 'replaced' }, 'quit']);
  await labelDefects({ cwd, ask, draft: drafter([DRAFT]).draft, now: () => NOW });
  const [line] = readLabels(cwd);
  assert.deepEqual([line.labeled_by, line.code, line.claude_draft], ['person', 'Wrong unit for the discount', DRAFT]);
  assert.deepEqual(checkLabelLine(line), []);
});

test('an API error on one defect keeps the earlier labels, and the person labels that defect by hand', async (t) => {
  const cwd = folderWithHistory(t);
  const { draft } = drafter([DRAFT, new DraftError('the Anthropic API answered 529: Overloaded')]);
  const { ask, asked } = scripted([
    { code: DRAFT.code, category: DRAFT.category, would_have_caught: 'a test', draft: 'confirmed' },
    answer('Stock went below zero', 'state', 'A test that sells the last item twice'),
    'quit'
  ]);
  const seen = [];
  const spy = async (defect, context) => {
    seen.push(context);
    return ask(defect, context);
  };
  await labelDefects({ cwd, ask: spy, draft, now: () => NOW });
  assert.deepEqual(asked.map((a) => a.id), ['D-012', 'D-007', 'D-006']);
  assert.equal(seen[1].draft, null);
  assert.match(seen[1].draftError, /529/);
  const lines = readLabels(cwd);
  assert.deepEqual(lines.map((l) => [l.id, l.labeled_by, 'claude_draft' in l]), [['D-012', 'claude_draft_confirmed', true], ['D-007', 'person', false]]);
  for (const line of lines) assert.deepEqual(checkLabelLine(line), [], line.id);
});

test('the labels schema checks that a Claude label has its draft, and that a confirmed label matches it', () => {
  const line = { id: 'D-012', fix_pr: 12, introducing_prs: [1], rejected_prs: [], code: DRAFT.code, category: DRAFT.category, would_have_caught: 'c', labeled_by: 'claude_draft_confirmed', claude_draft: DRAFT, szz_link_rejected: false, labeled_at: '2026-11-19T10:00:00.000Z' };
  assert.deepEqual(checkLabelLine(line), []);
  const noDraft = { ...line };
  delete noDraft.claude_draft;
  assert.deepEqual(checkLabelLine(noDraft), ['/claude_draft: a claude_draft_confirmed label must keep the draft in claude_draft']);
  assert.deepEqual(checkLabelLine({ ...line, code: 'other' }), ['/code: a claude_draft_confirmed label must have the code and category of its draft']);
  assert.deepEqual(checkLabelLine({ ...line, claude_draft: { ...DRAFT, model: '' } }).length, 1);
});
