import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the node:test runner runs this file', () => {
  assert.equal(1 + 1, 2);
});
