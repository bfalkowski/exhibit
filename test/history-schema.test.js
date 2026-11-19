import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkHistoryLine } from '../src/history-schema.js';

const schema = JSON.parse(readFileSync(new URL('../schema/history-line.schema.json', import.meta.url), 'utf8'));

const good = () => ({
  number: 7,
  title: 'Add the widget cache',
  body: null,
  author: 'dev7',
  labels: ['feature'],
  merged_at: '2026-03-05T12:00:00Z',
  base_ref: 'main',
  base_sha: 'b'.repeat(40),
  merge_sha: 'a'.repeat(40),
  files: [{ path: 'src/cache.js', additions: 120, deletions: 0 }],
  reviews: { change_request_rounds: 1, list: [{ state: 'CHANGES_REQUESTED', author: 'rev1', source: 'review' }, { state: 'APPROVED', author: null, source: 'comment' }] },
  ci: [{ name: 'test', conclusion: 'success' }, { name: 'lint', conclusion: null }],
  classification: { fix: false, fix_signal: null },
  szz: null
});

test('a line with the fields this version fills passes', () => {
  assert.deepEqual(checkHistoryLine(good()), []);
});

test('the fields later tickets fill may be absent or null', () => {
  const line = { ...good(), evidence_section: null, szz: null, exhibit: null };
  assert.deepEqual(checkHistoryLine(line), []);
});

test('classification must say whether the PR is a fix and which signal matched', () => {
  assert.deepEqual(checkHistoryLine({ ...good(), classification: { fix: true, fix_signal: 'title:fix' } }), []);
  const { classification, ...without } = good();
  assert.ok(classification);
  assert.deepEqual(checkHistoryLine(without), ['/: misses the field classification']);
  assert.deepEqual(checkHistoryLine({ ...good(), classification: null }), ['/classification: must be object, not null']);
  assert.deepEqual(checkHistoryLine({ ...good(), classification: { fix: 'yes', fix_signal: 'bug' } }).sort(), [
    '/classification/fix: must be boolean, not string',
    '/classification/fix_signal: does not match ^(label|title|branch):.+$'
  ]);
});

test('a line missing reviews or ci fails', () => {
  for (const field of ['reviews', 'ci']) {
    const line = good();
    delete line[field];
    assert.deepEqual(checkHistoryLine(line), [`/: misses the field ${field}`]);
  }
});

test('reviews and ci may not be null', () => {
  const line = { ...good(), reviews: null, ci: null };
  assert.deepEqual(checkHistoryLine(line).sort(), ['/ci: must be array, not null', '/reviews: must be object, not null']);
});

test('a review state must be one GitHub uses, and the rounds a count', () => {
  const line = good();
  line.reviews.list[0].state = 'LGTM';
  line.reviews.change_request_rounds = -1;
  assert.equal(checkHistoryLine(line).length, 2);
});

test('each review says whether it came from the reviews list or from a PR comment', () => {
  const line = good();
  delete line.reviews.list[0].source;
  line.reviews.list[1].source = 'chat';
  assert.deepEqual(checkHistoryLine(line), ['/reviews/list/0: misses the field source', '/reviews/list/1/source: does not match ^(review|comment)$']);
});

test('each problem names where it is', () => {
  const line = good();
  line.files[0].additions = 'lots';
  delete line.merge_sha;
  line.extra = 1;
  assert.deepEqual(checkHistoryLine(line).sort(), [
    '/: has a field the schema does not allow: extra',
    '/: misses the field merge_sha',
    '/files/0/additions: must be integer, not string'
  ]);
});

test('a sha must be 40 hex characters and merged_at a UTC time', () => {
  const line = { ...good(), base_sha: 'abc', merged_at: 'yesterday' };
  assert.equal(checkHistoryLine(line).length, 2);
});

test('counts and the PR number may not be negative', () => {
  const line = good();
  line.files[0].deletions = -1;
  assert.deepEqual(checkHistoryLine(line), ['/files/0/deletions: must be at least 0']);
});

test('the checker refuses a schema keyword it does not know, so no rule is skipped', async () => {
  const { checkSchema } = await import('../src/json-schema.js');
  assert.throws(() => checkSchema({ type: 'string', maxLength: 3 }, 'abcd'), /maxLength/);
});

test('szz holds links, each with a confidence from 0 to 1 and lines that carry their blame output', () => {
  const line = { path: 'src/a.js', line: 3, text: 'x;', blame: { commit: 'c'.repeat(40), original_path: 'src/a.js', original_line: 2, author: 'ana', author_time: '2026-01-05T09:00:00Z', summary: 'Add a' } };
  const szz = { blamed_commit: 'd'.repeat(40), links: [{ pr: 4, confidence: 1, lines: [line] }], unlinked_lines: [], dropped_lines: [], no_link_reason: null };
  assert.deepEqual(checkHistoryLine({ ...good(), szz }), []);
  assert.deepEqual(checkHistoryLine({ ...good(), szz: { ...szz, links: [{ pr: 4, confidence: 1.5, lines: [line] }] } }), ['/szz/links/0/confidence: must be at most 1']);
  const noBlame = { ...line };
  delete noBlame.blame;
  assert.deepEqual(checkHistoryLine({ ...good(), szz: { ...szz, unlinked_lines: [noBlame] } }), ['/szz/unlinked_lines/0: misses the field blame']);
});

test('szz lists the dropped lines with a reason, and says why a fix has no links', () => {
  const dropped = { path: 'src/a.js', line: 3, text: '  x;', reason: 'whitespace' };
  const szz = { blamed_commit: 'd'.repeat(40), links: [], unlinked_lines: [], dropped_lines: [dropped], no_link_reason: 'whitespace only' };
  assert.deepEqual(checkHistoryLine({ ...good(), szz }), []);
  for (const reason of ['comments only', 'moved lines only', 'whitespace, comments and moved lines only', 'lines newer than the bug report only']) {
    assert.deepEqual(checkHistoryLine({ ...good(), szz: { ...szz, no_link_reason: reason } }), [], reason);
  }
  assert.equal(checkHistoryLine({ ...good(), szz: { ...szz, no_link_reason: 'refactor only' } }).length, 1);
  assert.equal(checkHistoryLine({ ...good(), szz: { ...szz, dropped_lines: [{ ...dropped, reason: 'refactor' }] } }).length, 1);
  const noDropped = { ...szz };
  delete noDropped.dropped_lines;
  assert.deepEqual(checkHistoryLine({ ...good(), szz: noDropped }), ['/szz: misses the field dropped_lines']);
});

test('every line has szz, and the schema describes a line the same way in links and unlinked_lines', () => {
  const line = good();
  delete line.szz;
  assert.deepEqual(checkHistoryLine(line), ['/: misses the field szz']);
  const szz = schema.properties.szz.properties;
  assert.deepEqual(szz.links.items.properties.lines.items, szz.unlinked_lines.items);
});
