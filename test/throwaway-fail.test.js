import { test } from 'node:test';
import assert from 'node:assert/strict';

test('throwaway: this test fails on purpose', () => {
  assert.equal(1, 2);
});
