import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolError } from '../src/tool-error.js';
import { checkLabelLine, defectId, labelDefects } from '../src/labels.js';
import { SHOP_HISTORY } from './fixtures/report/shop-history.js';

const NOW = new Date('2026-11-19T10:00:00Z');
const shopText = () => readFileSync(SHOP_HISTORY, 'utf8');

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
    asked.push({ id: defect.id, categories: context.categories, text: context.text });
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
    { id: 'D-012', fix_pr: 12, introducing_prs: [1, 11], code: 'Discount math used percent as money', category: 'arithmetic', would_have_caught: 'A test with a 10% discount on 50', labeled_by: 'person', szz_link_rejected: false, labeled_at: '2026-11-19T10:00:00.000Z' },
    { id: 'D-006', fix_pr: 6, introducing_prs: [1], code: 'Tax rounded before the total', category: 'arithmetic', would_have_caught: 'A test that pins the rounding', labeled_by: 'person', szz_link_rejected: false, labeled_at: '2026-11-19T10:00:00.000Z' }
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
