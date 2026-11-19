import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, schemaProblems } from '../src/json-schema.js';

test('enum lists the allowed values and shows the bad one', () => {
  assert.deepEqual(checkSchema({ enum: ['low', 'medium', 'high'] }, 'extreme'), ['/: must be low, medium or high, not "extreme"']);
  assert.deepEqual(checkSchema({ enum: [3] }, 3), []);
});

test('if, then and else pick the rules by what the value is', () => {
  const schema = { if: { type: 'string' }, then: { enum: ['a'] }, else: { type: 'object', required: ['x'] } };
  assert.deepEqual(checkSchema(schema, 'a'), []);
  assert.deepEqual(checkSchema(schema, 'b'), ['/: must be a, not "b"']);
  assert.deepEqual(checkSchema(schema, {}), ['/: misses the field x']);
  assert.deepEqual(checkSchema(schema, 7), ['/: must be object, not integer']);
});

test('additionalProperties can be a schema that each other field must pass', () => {
  const schema = { type: 'object', additionalProperties: { type: 'integer' } };
  assert.deepEqual(checkSchema(schema, { a: 1, b: 'two' }), ['/b: must be integer, not string']);
});

test('minItems, minLength, minProperties and maxProperties', () => {
  assert.deepEqual(checkSchema({ minItems: 1 }, []), ['/: must have at least 1 item']);
  assert.deepEqual(checkSchema({ minLength: 1 }, ''), ['/: must have at least 1 character']);
  assert.deepEqual(checkSchema({ minProperties: 1 }, {}), ['/: must have at least 1 field']);
  assert.deepEqual(checkSchema({ maxProperties: 1 }, { a: 1, b: 2 }), ['/: must have at most 1 field, not 2']);
});

test('schemaProblems gives the path as a list of keys and list places', () => {
  const schema = { type: 'object', properties: { needs: { type: 'array', items: { type: 'string' } } } };
  assert.deepEqual(schemaProblems(schema, { needs: ['a', 7] }), [{ path: ['needs', 1], what: 'must be string, not integer' }]);
});

test('NaN and infinity are not numbers, so a range check cannot miss them', () => {
  const schema = { type: 'number', minimum: 0, maximum: 1 };
  assert.deepEqual(checkSchema(schema, Number.NaN), ['/: must be number, not NaN']);
  assert.deepEqual(checkSchema(schema, -Infinity), ['/: must be number, not infinity']);
});
