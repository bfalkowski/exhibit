import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPolicy } from '../src/policy.js';
import { classifyChange } from '../src/classify.js';

// Exhibit's own evidence.yml, which its workflow checks every Exhibit PR against (spec 13, S5).
// readPolicy is how every command reads a policy, so a file it reads is a valid policy.

const root = fileURLToPath(new URL('..', import.meta.url));
const NOT_FIX = { title: '192: Add a page', labels: [], branch: 'task/x' };
const FIX = { title: '192: Add a page', labels: ['bug'], branch: 'task/x' };

// readPolicy gives an empty policy for a file that is not there, so check that it is there first.
async function ownPolicy() {
  assert.ok(existsSync(join(root, 'evidence.yml')));
  return readPolicy(root);
}

function needs(policy, files, pr = NOT_FIX) {
  const { classification, requirements } = classifyChange(policy, files, pr);
  return { kinds: classification.kinds, risk: classification.risk, needs: requirements.map((r) => `${r.type === 'probe' ? `probe:${r.params.name}` : r.type}${r.not_needed ? ' (not needed)' : ''}`) };
}

test('evidence.yml is a valid policy, with a test command that writes JUnit where the policy reads it', async () => {
  const policy = await ownPolicy();
  assert.equal(policy.version, 3);
  assert.deepEqual(Object.keys(policy.kinds).sort(), ['docs', 'source', 'tooling']);
  assert.match(policy.settings.test_command, /--test-reporter-destination=\.exhibit\/junit\.xml /);
  assert.equal(policy.settings.test_results, '.exhibit/junit.xml');
});

test('a change to the code needs the tests, and a fix also needs a test that failed before', async () => {
  const policy = await ownPolicy();
  for (const file of ['src/check.js', 'bin/exhibit.js', 'action.yml', 'schema/evidence.schema.json', 'package-lock.json']) {
    assert.deepEqual(needs(policy, [file]), { kinds: ['source'], risk: 'high', needs: ['tests-before-after', 'failing-before (not needed)'] }, file);
  }
  assert.deepEqual(needs(policy, ['src/check.js'], FIX).needs, ['tests-before-after', 'failing-before']);
});

test('a change to a test, a script, a workflow or an example needs the tests', async () => {
  const policy = await ownPolicy();
  for (const file of ['test/check.test.js', 'scripts/check-links.js', '.github/workflows/exhibit.yml', 'examples/pull-request.yml']) {
    assert.deepEqual(needs(policy, [file]), { kinds: ['tooling'], risk: 'medium', needs: ['tests-before-after'] }, file);
  }
});

test('a change to the docs needs the link probe, and the tests too when it also changes a test', async () => {
  const policy = await ownPolicy();
  assert.deepEqual(needs(policy, ['README.md', 'docs/spec.md']), { kinds: ['docs'], risk: 'low', needs: ['probe:links'] });
  assert.deepEqual(needs(policy, ['README.md', 'test/check.test.js']).needs, ['probe:links', 'tests-before-after']);
});

test('any other file uses the default, which needs the tests', async () => {
  const policy = await ownPolicy();
  assert.deepEqual(needs(policy, ['.gitignore']), { kinds: [], risk: 'medium', needs: ['tests-before-after'] });
});
