import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHistoryLine } from '../src/history-schema.js';

const good = () => ({
  number: 7,
  title: 'Add the widget cache',
  body: null,
  author: 'dev7',
  labels: ['feature'],
  merged_at: '2026-03-05T12:00:00Z',
  base_sha: 'b'.repeat(40),
  merge_sha: 'a'.repeat(40),
  files: [{ path: 'src/cache.js', additions: 120, deletions: 0 }]
});

test('a line with the fields this version fills passes', () => {
  assert.deepEqual(checkHistoryLine(good()), []);
});

test('the fields later tickets fill may be absent or null', () => {
  const line = { ...good(), reviews: null, ci: null, classification: null, evidence_section: null, szz: null, exhibit: null };
  assert.deepEqual(checkHistoryLine(line), []);
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
