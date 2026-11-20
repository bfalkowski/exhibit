import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, matchesGlob } from '../src/classify.js';

// A policy shaped as readPolicy returns it: kinds filled in, bare names for bare items.
const POLICY = {
  version: 3,
  settings: { fix_signals: ['label:bug', 'title:fix', 'branch:fix/'] },
  kinds: {
    'relay-core': {
      match: ['relay/supervisor.js', 'relay/session-host.js'],
      risk: 'high',
      needs: ['tests-before-after', { 'failing-before': { when: ['fix', 'feature'] } }, { mutation: { min: 0.85 } }],
      merge_without_reading: 'never'
    },
    manual: {
      match: ['docs/manual/**'],
      risk: 'low',
      needs: [{ probe: { name: 'link-check', run: 'npm run check-links' } }],
      merge_without_reading: 'allowed'
    },
    notes: {
      match: ['notes/*.md'],
      risk: 'low',
      needs: [],
      merge_without_reading: 'allowed'
    }
  },
  default: { risk: 'medium', needs: ['tests-before-after', { mutation: { min: 0.7 } }] }
};

const NOT_FIX = { title: 'Add a page', labels: [], branch: 'task/page' };
const types = (result) => result.requirements.map((item) => item.type);

test('a change that matches one kind gets that kind, its risk and its needs', () => {
  const result = classifyChange(POLICY, ['docs/manual/install.md'], NOT_FIX);
  assert.deepEqual(result.classification.kinds, ['manual']);
  assert.equal(result.classification.risk, 'low');
  assert.equal(result.classification.merge_without_reading, 'allowed');
  assert.deepEqual(result.requirements, [
    { type: 'probe', params: { name: 'link-check', run: 'npm run check-links' }, author: 'builder', kinds: ['manual'] }
  ]);
});

test('a change that matches two kinds gets the union of their needs and the highest risk', () => {
  const result = classifyChange(POLICY, ['docs/manual/install.md', 'relay/supervisor.js'], NOT_FIX);
  assert.deepEqual(result.classification.kinds, ['manual', 'relay-core']);
  assert.equal(result.classification.risk, 'high');
  // failing-before stays, marked not needed: this change is neither a fix nor a feature.
  assert.deepEqual(types(result), ['probe', 'tests-before-after', 'failing-before', 'mutation']);
  assert.match(result.requirements[2].not_needed, /only on a fix or a feature/);
  assert.equal(result.requirements[1].not_needed, undefined);
});

test('the same need from two kinds is one requirement that names both kinds', () => {
  const policy = { ...POLICY, kinds: { a: { match: ['a/**'], risk: 'low', needs: ['tests-before-after'] }, b: { match: ['b/**'], risk: 'medium', needs: ['tests-before-after'] } } };
  const result = classifyChange(policy, ['b/x.js', 'a/x.js'], NOT_FIX);
  assert.deepEqual(result.requirements, [{ type: 'tests-before-after', params: {}, author: 'builder', kinds: ['a', 'b'] }]);
  assert.equal(result.classification.risk, 'medium');
});

test('a change that matches no kind uses default', () => {
  const result = classifyChange(POLICY, ['src/app.js'], NOT_FIX);
  assert.deepEqual(result.classification.kinds, []);
  assert.equal(result.classification.used_default, true);
  assert.equal(result.classification.risk, 'medium');
  assert.equal(result.classification.merge_without_reading, 'never');
  assert.deepEqual(types(result), ['tests-before-after', 'mutation']);
  assert.deepEqual(result.requirements[1].kinds, ['default']);
});

test('a file that matches no kind sends nothing to default when another file matches a kind', () => {
  const result = classifyChange(POLICY, ['src/app.js', 'docs/manual/a.md'], NOT_FIX);
  assert.deepEqual(result.classification.kinds, ['manual']);
  assert.equal(result.classification.used_default, false);
});

test('merge_without_reading is allowed only when every matched kind allows it', () => {
  assert.equal(classifyChange(POLICY, ['docs/manual/a.md', 'notes/n.md'], NOT_FIX).classification.merge_without_reading, 'allowed');
  assert.equal(classifyChange(POLICY, ['docs/manual/a.md', 'relay/supervisor.js'], NOT_FIX).classification.merge_without_reading, 'never');
  // A kind that does not say is not a kind that allows it.
  const policy = { ...POLICY, kinds: { ...POLICY.kinds, quiet: { match: ['quiet/**'], risk: 'low', needs: [] } } };
  assert.equal(classifyChange(policy, ['docs/manual/a.md', 'quiet/q.js'], NOT_FIX).classification.merge_without_reading, 'never');
});

test('failing-before with when is needed only for a change of that kind, fix or feature', () => {
  const fix = classifyChange(POLICY, ['relay/supervisor.js'], { title: 'Fix the restart', labels: [], branch: 'x' });
  assert.equal(fix.classification.fix, true);
  assert.equal(fix.classification.fix_signal, 'title:fix');
  assert.deepEqual(types(fix), ['tests-before-after', 'failing-before', 'mutation']);
  assert.deepEqual(fix.requirements[1].params, { when: ['fix', 'feature'] });

  const feature = classifyChange(POLICY, ['relay/supervisor.js'], { title: 'Add restart', labels: ['Feature'], branch: 'x' });
  assert.equal(feature.classification.feature, true);
  assert.deepEqual(types(feature), ['tests-before-after', 'failing-before', 'mutation']);
  assert.equal(fix.requirements[1].not_needed, undefined);
  assert.equal(feature.requirements[1].not_needed, undefined);
});

test('a failing-before with no when applies to every change', () => {
  const policy = { kinds: {}, settings: POLICY.settings, default: { risk: 'low', needs: ['failing-before'] } };
  assert.deepEqual(types(classifyChange(policy, ['a.js'], NOT_FIX)), ['failing-before']);
});

test('a hidden probe has the author hidden', () => {
  const policy = { kinds: {}, settings: POLICY.settings, default: { risk: 'low', needs: [{ probe: { name: 'suite', run: 'x', author: 'hidden' } }] } };
  assert.equal(classifyChange(policy, ['a.js'], NOT_FIX).requirements[0].author, 'hidden');
});

test('a change to evidence.yml is marked, even when it also matches a kind', () => {
  assert.equal(classifyChange(POLICY, ['evidence.yml', 'docs/manual/a.md'], NOT_FIX).classification.policy_changed, true);
  assert.equal(classifyChange(POLICY, ['docs/manual/a.md'], NOT_FIX).classification.policy_changed, false);
  // Only the policy at the top of the repo is the policy.
  assert.equal(classifyChange(POLICY, ['docs/evidence.yml'], NOT_FIX).classification.policy_changed, false);
});

test('a policy with no default gives risk high and no requirements when no kind matches', () => {
  const result = classifyChange({ settings: POLICY.settings, kinds: POLICY.kinds }, ['src/app.js'], NOT_FIX);
  assert.equal(result.classification.used_default, true);
  assert.equal(result.classification.has_default, false);
  assert.equal(result.classification.risk, 'high');
  assert.deepEqual(result.requirements, []);
});

test('globs: * stays in one folder, ** crosses folders, ? is one character', () => {
  assert.equal(matchesGlob('notes/a.md', 'notes/*.md'), true);
  assert.equal(matchesGlob('notes/deep/a.md', 'notes/*.md'), false);
  assert.equal(matchesGlob('docs/manual/a/b.md', 'docs/manual/**'), true);
  assert.equal(matchesGlob('docs/manual', 'docs/manual/**'), false);
  assert.equal(matchesGlob('x.js', '**/x.js'), true);
  assert.equal(matchesGlob('a/b/x.js', '**/x.js'), true);
  assert.equal(matchesGlob('src/a/b/c.test.js', 'src/**/*.test.js'), true);
  assert.equal(matchesGlob('src/c.test.js', 'src/**/*.test.js'), true);
  assert.equal(matchesGlob('a1.js', 'a?.js'), true);
  assert.equal(matchesGlob('a/.js', 'a?.js'), false);
  assert.equal(matchesGlob('a+b.js', 'a+b.js'), true);
  assert.equal(matchesGlob('aab.js', 'a+b.js'), false);
});
