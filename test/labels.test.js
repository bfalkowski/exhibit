import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolError } from '../src/tool-error.js';
import { ANSWER_LIMITS, checkLabelLine, defectId, labelDefects } from '../src/labels.js';
import { fileURLToPath } from 'node:url';
import { DraftError, createDrafter } from '../src/claude.js';
import { replayFetch } from '../test-support/replay-fetch.js';
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
  assert.deepEqual(summary, { shown: 3, labeled: 2, skipped: 1, open: 1, relinked: 0, new_links: 0 });
  assert.deepEqual(readLabels(cwd), [
    { id: 'D-012', fix_pr: 12, introducing_prs: [1, 11], rejected_prs: [], code: 'Discount math used percent as money', category: 'arithmetic', would_have_caught: 'A test with a 10% discount on 50', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-19T10:00:00.000Z' },
    { id: 'D-006', fix_pr: 6, introducing_prs: [1], rejected_prs: [], code: 'Tax rounded before the total', category: 'arithmetic', would_have_caught: 'A test that pins the rounding', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-19T10:00:00.000Z' }
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
  assert.deepEqual(summary, { shown: 3, labeled: 2, skipped: 0, open: 3, relinked: 0, new_links: 0 });
  assert.deepEqual(readLabels(cwd).map((line) => line.id), ['D-105', 'D-104']);

  const second = scripted(['skip', 'skip', 'skip']);
  assert.deepEqual(await labelDefects({ cwd, ask: second.ask, now: () => NOW }), { shown: 3, labeled: 0, skipped: 3, open: 3, relinked: 0, new_links: 0 });
  assert.deepEqual(second.asked.map((a) => a.id), ['D-103', 'D-102', 'D-101']);
});

test('with every defect labeled, label asks nothing', async (t) => {
  const cwd = folderWithHistory(t);
  await labelDefects({ cwd, ask: scripted([answer('a', 'x', 'b'), answer('c', 'x', 'd'), answer('e', 'x', 'f')]).ask, now: () => NOW });
  const again = scripted([]);
  assert.deepEqual(await labelDefects({ cwd, ask: again.ask, now: () => NOW }), { shown: 0, labeled: 0, skipped: 0, open: 0, relinked: 0, new_links: 0 });
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

test('the answer limits are the lengths that the labels schema allows', () => {
  assert.deepEqual(ANSWER_LIMITS, { code: 200, category: 60, would_have_caught: 500 });
  const line = (fields) => ({ id: 'D-004', fix_pr: 4, introducing_prs: [1], code: 'c', category: 'c', would_have_caught: 'c', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-01-01T00:00:00Z', ...fields });
  for (const [field, limit] of Object.entries(ANSWER_LIMITS)) {
    assert.deepEqual(checkLabelLine(line({ [field]: 'x'.repeat(limit) })), [], field);
    assert.notDeepEqual(checkLabelLine(line({ [field]: 'x'.repeat(limit + 1) })), [], field);
  }
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
  const line = { id: 'D-012', fix_pr: 12, introducing_prs: [1], code: 'a', category: 'b', would_have_caught: 'c', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-19T10:00:00.000Z' };
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
  assert.deepEqual(await labelDefects({ cwd, ask, now: () => NOW }), { shown: 2, labeled: 1, skipped: 0, open: 2, relinked: 0, new_links: 0 });
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
  const line = { id: 'D-012', fix_pr: 12, introducing_prs: [1], rejected_prs: [11], code: 'a', category: 'b', would_have_caught: 'c', labeled_by: 'person', szz_link_rejected: true, known_at_review: null, labeled_at: '2026-11-19T10:00:00.000Z' };
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

for (const [status, reason] of [[401, /ANTHROPIC_API_KEY/], [403, /ANTHROPIC_API_KEY/], [404, /EXHIBIT_CLAUDE_MODEL/]]) {
  test(`a ${status} stops drafting for the rest of the run, and the person labels the next defects by hand`, async (t) => {
    const cwd = folderWithHistory(t);
    const calls = [];
    const draft = async (input) => {
      calls.push(input.id);
      if (calls.length === 1) return DRAFT;
      throw new DraftError(`the Anthropic API answered ${status}: no`, { stopsDrafting: status === 404 ? 'Check EXHIBIT_CLAUDE_MODEL.' : 'Check ANTHROPIC_API_KEY.' });
    };
    const { ask } = scripted([
      { code: DRAFT.code, category: DRAFT.category, would_have_caught: 'a test', draft: 'confirmed' },
      answer('Stock went below zero', 'state', 'A test that sells the last item twice'),
      answer('Tax used the wrong base', 'arithmetic', 'A test with tax'),
      'quit'
    ]);
    const seen = [];
    const spy = async (defect, context) => {
      seen.push(context);
      return ask(defect, context);
    };
    await labelDefects({ cwd, ask: spy, draft, now: () => NOW });
    // D-012 drafted, D-007 failed and stopped drafting, D-006 and on were never sent.
    assert.deepEqual(calls, ['D-012', 'D-007']);
    assert.match(seen[1].draftError, new RegExp(String(status)));
    assert.match(seen[1].draftStopped, reason);
    for (const context of seen.slice(2)) assert.deepEqual([context.draft, context.draftError, context.draftStopped], [null, null, null]);
    // The label written before the failure stays.
    assert.deepEqual(readLabels(cwd).map((l) => [l.id, l.labeled_by]), [['D-012', 'claude_draft_confirmed'], ['D-007', 'person'], ['D-006', 'person']]);
  });
}

test('with the recorded 401 reply, exhibit sends one request, and the next defect is labeled by hand', async (t) => {
  const cwd = folderWithHistory(t);
  const fetch = replayFetch(fileURLToPath(new URL('./fixtures/anthropic/bad-key.json', import.meta.url)));
  // The SDK's own retries stay on, as in a real run.
  const draft = createDrafter({ apiKey: 'bad-key', fetch });
  const { ask, asked } = scripted([answer('Count ignored the quantity', 'arithmetic', 'a test'), answer('Stock went below zero', 'state', 'a test'), 'quit']);
  const seen = [];
  const spy = async (defect, context) => {
    seen.push(context);
    return ask(defect, context);
  };
  await labelDefects({ cwd, ask: spy, draft, now: () => NOW });
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(asked.map((a) => a.id), ['D-012', 'D-007', 'D-006']);
  assert.match(seen[0].draftError, /401/);
  assert.match(seen[0].draftStopped, /ANTHROPIC_API_KEY/);
  assert.deepEqual([seen[1].draft, seen[1].draftError, seen[1].draftStopped], [null, null, null]);
  assert.deepEqual(readLabels(cwd).map((l) => [l.id, l.labeled_by, 'claude_draft' in l]), [['D-012', 'person', false], ['D-007', 'person', false]]);
});

test('the labels schema checks that a Claude label has its draft, and that a confirmed label matches it', () => {
  const line = { id: 'D-012', fix_pr: 12, introducing_prs: [1], rejected_prs: [], code: DRAFT.code, category: DRAFT.category, would_have_caught: 'c', labeled_by: 'claude_draft_confirmed', claude_draft: DRAFT, szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-19T10:00:00.000Z' };
  assert.deepEqual(checkLabelLine(line), []);
  const noDraft = { ...line };
  delete noDraft.claude_draft;
  assert.deepEqual(checkLabelLine(noDraft), ['/claude_draft: a claude_draft_confirmed label must keep the draft in claude_draft']);
  assert.deepEqual(checkLabelLine({ ...line, code: 'other' }), ['/code: a claude_draft_confirmed label must have the code and category of its draft']);
  assert.deepEqual(checkLabelLine({ ...line, claude_draft: { ...DRAFT, model: '' } }).length, 1);
});

test('replacing the draft with the same words still gives person, because the person did not accept it', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask } = scripted([{ code: DRAFT.code, category: DRAFT.category, would_have_caught: 'A 10% discount test', draft: 'replaced' }, 'quit']);
  await labelDefects({ cwd, ask, draft: drafter([DRAFT]).draft, now: () => NOW });
  const [line] = readLabels(cwd);
  assert.deepEqual([line.labeled_by, line.code, line.claude_draft], ['person', DRAFT.code, DRAFT]);
  assert.deepEqual(checkLabelLine(line), []);
});

// The shop history with fix PR 12 given `title`, and its SZZ links moved to the PRs in `blamed`.
function followUpHistory({ title, blamed, body = null }) {
  return shopText().trimEnd().split('\n').map((row) => {
    const line = JSON.parse(row);
    if (line.number !== 12) return row + '\n';
    const links = line.szz.links.slice(0, blamed.length).map((link, i) => ({ ...link, pr: blamed[i] }));
    return JSON.stringify({ ...line, title, body, szz: { ...line.szz, links } }) + '\n';
  }).join('');
}

// An answer source that labels the first defect with `reply`, records its context, then quits.
function firstOnly(reply) {
  const seen = [];
  return { seen, ask: async (defect, context) => (seen.push(context), seen.length === 1 ? { ...answer('Left for later', 'deferral', 'The review that saw it'), ...reply } : 'quit') };
}

test('a fix PR titled "Follow-ups from the review of PR 46" with an SZZ link to PR 46 proposes known_at_review true, with the sentence', async (t) => {
  const cwd = folderWithHistory(t, followUpHistory({ title: 'Follow-ups from the review of PR 46', blamed: [46] }));
  const { ask, seen } = firstOnly({});
  await labelDefects({ cwd, ask, now: () => NOW });
  assert.deepEqual(seen[0].review, { known_at_review: true, pr: 46, where: 'the fix PR title', sentence: 'Follow-ups from the review of PR 46' });
  const [line] = readLabels(cwd);
  assert.deepEqual([line.id, line.known_at_review], ['D-012', true]);
  assert.deepEqual(checkLabelLine(line), []);
});

test('the person can change the proposed true to false', async (t) => {
  const cwd = folderWithHistory(t, followUpHistory({ title: 'Follow-ups from the review of PR 46', blamed: [46] }));
  const { ask, seen } = firstOnly({ known_at_review: false });
  await labelDefects({ cwd, ask, now: () => NOW });
  assert.equal(seen[0].review.known_at_review, true);
  const [line] = readLabels(cwd);
  assert.equal(line.known_at_review, false);
  assert.deepEqual(checkLabelLine(line), []);
});

test('a follow-up title that names PR 46, when SZZ blamed only PR 50, does not propose true', async (t) => {
  const cwd = folderWithHistory(t, followUpHistory({ title: 'Follow-ups from the review of PR 46', blamed: [50] }));
  const { ask, seen } = firstOnly({});
  await labelDefects({ cwd, ask, now: () => NOW });
  assert.deepEqual(seen[0].review, { known_at_review: null });
  assert.equal(readLabels(cwd)[0].known_at_review, null);
});

test('a fix with no follow-up sentence proposes null, and the person can set it', async (t) => {
  const cwd = folderWithHistory(t);
  const { ask, seen } = firstOnly({});
  await labelDefects({ cwd, ask, now: () => NOW });
  assert.deepEqual(seen[0].review, { known_at_review: null });
  assert.equal(readLabels(cwd)[0].known_at_review, null);
  const set = folderWithHistory(t);
  await labelDefects({ cwd: set, ask: firstOnly({ known_at_review: true }).ask, now: () => NOW });
  assert.equal(readLabels(set)[0].known_at_review, true);
});

test('an issue that the fix PR closes counts, when the answer source can read it', async (t) => {
  const cwd = folderWithHistory(t, followUpHistory({ title: '81: Small fixes', body: 'Closes #80.', blamed: [7, 11] }));
  const asked = [];
  const issues = async (numbers) => (asked.push(numbers), [{ number: 80, title: 'Follow-ups from the review of PR 7', body: null }]);
  const { ask, seen } = firstOnly({});
  await labelDefects({ cwd, ask, issues, now: () => NOW });
  assert.deepEqual(asked, [[80]]);
  assert.equal(seen[0].review.where, 'the title of issue 80 that the fix PR closes');
  assert.equal(readLabels(cwd)[0].known_at_review, true);
});

test('every labels line needs known_at_review: true, false or null', () => {
  const line = { id: 'D-012', fix_pr: 12, introducing_prs: [1], rejected_prs: [], code: 'a', category: 'b', would_have_caught: 'c', labeled_by: 'person', szz_link_rejected: false, known_at_review: null, labeled_at: '2026-11-19T10:00:00.000Z' };
  for (const known of [true, false, null]) assert.deepEqual(checkLabelLine({ ...line, known_at_review: known }), []);
  const missing = { ...line };
  delete missing.known_at_review;
  assert.deepEqual(checkLabelLine(missing), ['/: misses the field known_at_review']);
  assert.equal(checkLabelLine({ ...line, known_at_review: 'yes' }).length, 1);
});

// A labels line for the shop fixture, as exhibit label writes it, with `introducing` kept and
// `rejected` rejected.
const shopLabel = (fixPr, introducing, rejected = []) => ({ id: defectId(fixPr), fix_pr: fixPr, introducing_prs: introducing, rejected_prs: rejected, code: `Code ${fixPr}`, category: 'arithmetic', would_have_caught: 'A test', labeled_by: 'person', szz_link_rejected: rejected.length > 0, known_at_review: null, labeled_at: '2026-11-01T10:00:00.000Z' });
const writeLabels = (cwd, lines) => writeFileSync(labelsPath(cwd), lines.map((line) => JSON.stringify(line) + '\n').join(''));

// An answer source for the new links of a labeled defect, that gives `answers` in order.
function scriptedLinks(answers) {
  const asked = [];
  const askLinks = async (defect, context) => {
    asked.push({ id: defect.id, links: defect.links.map((link) => link.pr), label: context.label, text: context.text, position: context.position, count: context.count });
    if (asked.length > answers.length) throw new Error(`asked about the new links of ${defect.id}, but the script has no answer left`);
    return answers[asked.length - 1];
  };
  return { askLinks, asked };
}

test('a labeled defect with a new SZZ link is shown again with only that link, and the answer goes into the same line', async (t) => {
  const cwd = folderWithHistory(t);
  // D-012 was labeled when SZZ linked it only to PR 1. SZZ now links it to PR 11 too.
  writeLabels(cwd, [shopLabel(12, [1]), shopLabel(7, [2, 3]), shopLabel(6, [1])]);
  const before = readLabels(cwd);
  const { ask, asked: askedOpen } = scripted([]);
  const { askLinks, asked } = scriptedLinks([{ rejected_prs: [] }]);

  const summary = await labelDefects({ cwd, ask, askLinks, now: () => NOW });

  assert.deepEqual(askedOpen, []);
  assert.deepEqual(asked.map((a) => [a.id, a.links, a.position, a.count]), [['D-012', [11], 1, 1]]);
  assert.deepEqual(asked[0].label, before[0]);
  // The text shows only the new link's evidence.
  assert.match(asked[0].text, /PR 11/);
  assert.doesNotMatch(asked[0].text, /PR 1\b/);
  assert.deepEqual(summary, { shown: 1, labeled: 0, skipped: 0, open: 0, relinked: 1, new_links: 0 });
  // The same line, in the same place, with the new link kept. The other fields stay.
  assert.deepEqual(readLabels(cwd), [{ ...before[0], introducing_prs: [1, 11] }, before[1], before[2]]);
});

test('a rejected new link goes to rejected_prs, and szz_link_rejected becomes true', async (t) => {
  const cwd = folderWithHistory(t);
  writeLabels(cwd, [shopLabel(12, [1]), shopLabel(7, [2, 3]), shopLabel(6, [1])]);
  const before = readLabels(cwd);
  const { askLinks } = scriptedLinks([{ rejected_prs: [11] }]);

  await labelDefects({ cwd, ask: scripted([]).ask, askLinks, now: () => NOW });

  const [line] = readLabels(cwd);
  assert.deepEqual(line, { ...before[0], rejected_prs: [11], szz_link_rejected: true });
  assert.deepEqual(checkLabelLine(line), []);
});

test('a link that the label kept or rejected is not new, and a kept PR that SZZ no longer links stays', async (t) => {
  const cwd = folderWithHistory(t);
  // D-012 rejected PR 11 and kept PR 1. D-007 kept PR 9, which SZZ no longer links, and has no
  // answer for PRs 2 and 3. D-006 was written before rejected_prs existed.
  const old = shopLabel(6, [1]);
  delete old.rejected_prs;
  writeLabels(cwd, [shopLabel(12, [1], [11]), shopLabel(7, [9]), old]);
  const before = readLabels(cwd);
  const { askLinks, asked } = scriptedLinks([{ rejected_prs: [3] }]);

  const summary = await labelDefects({ cwd, ask: scripted([]).ask, askLinks, now: () => NOW });

  assert.deepEqual(asked.map((a) => [a.id, a.links]), [['D-007', [2, 3]]]);
  assert.equal(summary.relinked, 1);
  assert.deepEqual(readLabels(cwd), [before[0], { ...before[1], introducing_prs: [9, 2], rejected_prs: [3], szz_link_rejected: true }, before[2]]);
});

test('defects with no line come first, then the labeled defects with new links, and q stops both', async (t) => {
  const cwd = folderWithHistory(t);
  writeLabels(cwd, [shopLabel(12, [1])]);
  const { ask, asked: askedOpen } = scripted([answer('A code', 'arithmetic', 'A test'), 'quit']);
  const { askLinks, asked } = scriptedLinks([]);

  const summary = await labelDefects({ cwd, ask, askLinks, now: () => NOW });

  assert.deepEqual(askedOpen.map((a) => a.id), ['D-007', 'D-006']);
  assert.deepEqual(asked, []);
  assert.deepEqual(summary, { shown: 2, labeled: 1, skipped: 0, open: 1, relinked: 0, new_links: 1 });
  assert.deepEqual(readLabels(cwd).map((line) => line.id), ['D-012', 'D-007']);
});

test('a skip or a quit at a new link leaves the line as it was, and the next run asks again', async (t) => {
  const cwd = folderWithHistory(t);
  writeLabels(cwd, [shopLabel(12, [1]), shopLabel(7, []), shopLabel(6, [1])]);
  const text = readFileSync(labelsPath(cwd), 'utf8');

  const first = await labelDefects({ cwd, ask: scripted([]).ask, askLinks: scriptedLinks(['skip', 'quit']).askLinks, now: () => NOW });
  assert.deepEqual(first, { shown: 2, labeled: 0, skipped: 0, open: 0, relinked: 0, new_links: 2 });
  assert.equal(readFileSync(labelsPath(cwd), 'utf8'), text);

  const { askLinks, asked } = scriptedLinks(['quit']);
  await labelDefects({ cwd, ask: scripted([]).ask, askLinks, now: () => NOW });
  assert.deepEqual(asked.map((a) => a.id), ['D-012']);
});

test('without an answer source for new links, the labeled defects are only counted', async (t) => {
  const cwd = folderWithHistory(t);
  writeLabels(cwd, [shopLabel(12, [1]), shopLabel(7, [2, 3]), shopLabel(6, [1])]);
  const summary = await labelDefects({ cwd, ask: scripted([]).ask, now: () => NOW });
  assert.deepEqual(summary, { shown: 0, labeled: 0, skipped: 0, open: 0, relinked: 0, new_links: 1 });
});

test('only the first line of a defect gets the new links, as only the first line counts', async (t) => {
  const cwd = folderWithHistory(t);
  writeLabels(cwd, [shopLabel(12, [1]), shopLabel(7, [2, 3]), shopLabel(6, [1]), { ...shopLabel(12, [1, 11]), code: 'A second line' }]);
  const before = readLabels(cwd);
  const { askLinks, asked } = scriptedLinks([{ rejected_prs: [] }]);

  await labelDefects({ cwd, ask: scripted([]).ask, askLinks, now: () => NOW });

  assert.deepEqual(asked.map((a) => [a.id, a.links]), [['D-012', [11]]]);
  assert.deepEqual(readLabels(cwd), [{ ...before[0], introducing_prs: [1, 11] }, before[1], before[2], before[3]]);
});

test('when the line changed while the person answered, the answer is not written and the change stays', async (t) => {
  const cwd = folderWithHistory(t);
  writeLabels(cwd, [shopLabel(12, [1]), shopLabel(7, [2, 3]), shopLabel(6, [1])]);
  let edited;
  const askLinks = async () => {
    // Someone edits the line by hand while the question is on screen.
    writeLabels(cwd, [{ ...shopLabel(12, [1]), code: 'Edited by hand' }, shopLabel(7, [2, 3]), shopLabel(6, [1])]);
    edited = readFileSync(labelsPath(cwd), 'utf8');
    return { rejected_prs: [] };
  };

  await assert.rejects(labelDefects({ cwd, ask: scripted([]).ask, askLinks, now: () => NOW }), (error) => error instanceof ToolError && /D-012 .*changed/.test(error.message));
  assert.equal(readFileSync(labelsPath(cwd), 'utf8'), edited);
});

test('a new link answer that rejects a PR that is not a new link is refused', async (t) => {
  const cwd = folderWithHistory(t);
  writeLabels(cwd, [shopLabel(12, [1]), shopLabel(7, [2, 3]), shopLabel(6, [1])]);
  const text = readFileSync(labelsPath(cwd), 'utf8');
  const { askLinks } = scriptedLinks([{ rejected_prs: [1] }]);
  await assert.rejects(labelDefects({ cwd, ask: scripted([]).ask, askLinks, now: () => NOW }), (error) => error instanceof ToolError && /PR 1 is not a new link of D-012/.test(error.message));
  assert.equal(readFileSync(labelsPath(cwd), 'utf8'), text);
});
