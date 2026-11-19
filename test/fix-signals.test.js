import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFix, DEFAULT_FIX_SIGNALS } from '../src/fix-signals.js';

const pr = (fields) => ({ number: 1, title: 'Add a page', labels: [], branch: 'topic', ...fields });
const notFix = { fix: false, fix_signal: null };

test('the default signals are the ones in the spec', () => {
  assert.deepEqual(DEFAULT_FIX_SIGNALS, ['label:bug', 'title:fix', 'branch:fix/']);
});

test('label: matches a label with the same name, in any case, and nothing else', () => {
  const signals = ['label:bug'];
  assert.deepEqual(classifyFix(pr({ labels: ['bug'] }), signals), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(pr({ labels: ['docs', 'BUG'] }), signals), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(pr({ labels: ['bug-report'] }), signals), notFix);
  assert.deepEqual(classifyFix(pr({ labels: ['debug'] }), signals), notFix);
  assert.deepEqual(classifyFix(pr({ labels: [] }), signals), notFix);
});

test('title: matches a title that starts with the word, in any case', () => {
  const signals = ['title:fix'];
  for (const title of ['fix: crash on start', 'Fix the crash', 'fix(cli): crash', 'FIX!: crash', 'fix']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title:fix' }, title);
  }
});

test('title: is a prefix, not "contains", and the word must end where the prefix ends', () => {
  const signals = ['title:fix'];
  for (const title of ['Add prefix fixer', 'Quick fix for the crash', 'Fixture repo for tests', 'fixes']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: matches the word after a leading ticket key', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['T-170: Fix the crash', 'KEY-123: fix the parser', '[KEY-123] fix the parser', '(KEY-123) Fix the parser', 'key-9 fix(cli): crash', '  T-1:fix']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title_after_key:fix' }, title);
  }
});

test('title_after_key: keeps the word rule of title:, so a longer word or a later word does not match', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['T-170: Add prefix fixer', 'T-170: Improve fixtures', 'T-170: Fixture repo', 'T-186: Land the T-128 fixes', 'T-170 Quick fix', '[KEY-123]: Add a page']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: matches a title with no key the same way as title: does', () => {
  const titles = ['fix: crash on start', 'Fix the crash', 'fix(cli): crash', 'FIX!: crash', 'fix', 'Add prefix fixer', 'Quick fix for the crash', 'Fixture repo for tests', 'fixes'];
  for (const title of titles) {
    const plain = classifyFix(pr({ title }), ['title:fix']);
    const afterKey = classifyFix(pr({ title }), ['title_after_key:fix']);
    assert.deepEqual(afterKey, { fix: plain.fix, fix_signal: plain.fix ? 'title_after_key:fix' : null }, title);
  }
});

test('title_after_key: skips only a key of letters, a hyphen and digits', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['79: Fix the crash', 'Docs: fix a typo', 'T-: fix', '-170: fix', 'T-170Fix the crash']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: skips a key followed by a dash, a spaced colon or a comma, and more than one key', () => {
  const signals = ['title_after_key:fix'];
  const titles = ['T-170 - Fix the crash', '[T-170] - Fix the crash', 'T-170 : Fix the crash', 'T-170, T-171: Fix', 'T-170: [T-171] Fix', '#79: Fix the crash', '[#79] fix the crash'];
  for (const title of titles) {
    assert.deepEqual(classifyFix(pr({ title }), signals), { fix: true, fix_signal: 'title_after_key:fix' }, title);
  }
});

test('title_after_key: a bare key still needs a mark or a space after it, and a dash needs a space before it', () => {
  const signals = ['title_after_key:fix'];
  for (const title of ['#79Fix the crash', 'T-170-Fix the crash', 'T-170, Add a fix', '#: fix', 'T-170 - Add prefix fixer']) {
    assert.deepEqual(classifyFix(pr({ title }), signals), notFix, title);
  }
});

test('title_after_key: a word shaped like a key is skipped as a key, so "FIX-12: Add a page" is not a fix', () => {
  for (const title of ['FIX-12: Add a page', 'fix-12: crash']) {
    assert.deepEqual(classifyFix(pr({ title }), ['title_after_key:fix']), notFix, title);
    assert.deepEqual(classifyFix(pr({ title }), ['title:fix']), { fix: true, fix_signal: 'title:fix' }, title);
  }
});

test('branch: matches a branch that starts with the prefix, in any case', () => {
  const signals = ['branch:fix/'];
  assert.deepEqual(classifyFix(pr({ branch: 'fix/crash' }), signals), { fix: true, fix_signal: 'branch:fix/' });
  assert.deepEqual(classifyFix(pr({ branch: 'Fix/Crash' }), signals), { fix: true, fix_signal: 'branch:fix/' });
  assert.deepEqual(classifyFix(pr({ branch: 'hotfix/crash' }), signals), notFix);
  assert.deepEqual(classifyFix(pr({ branch: 'fixes' }), signals), notFix);
});

test('when more than one signal matches, the first in the list is recorded', () => {
  const both = pr({ title: 'Fix the crash', labels: ['bug'], branch: 'fix/crash' });
  assert.deepEqual(classifyFix(both, DEFAULT_FIX_SIGNALS), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(both, ['branch:fix/', 'title:fix']), { fix: true, fix_signal: 'branch:fix/' });
});

test('pr: matches the PR with that number, and no other', () => {
  const signals = ['pr:96', 'pr:99'];
  assert.deepEqual(classifyFix(pr({ number: 96 }), signals), { fix: true, fix_signal: 'pr:96' });
  assert.deepEqual(classifyFix(pr({ number: 99 }), signals), { fix: true, fix_signal: 'pr:99' });
  for (const number of [9, 960, 97, 1]) assert.deepEqual(classifyFix(pr({ number }), signals), notFix, `PR ${number}`);
});

test('pr: adds to the other signals, and the first match in the list is recorded', () => {
  const labelled = pr({ number: 96, labels: ['bug'] });
  assert.deepEqual(classifyFix(labelled, ['label:bug', 'pr:96']), { fix: true, fix_signal: 'label:bug' });
  assert.deepEqual(classifyFix(labelled, ['pr:96', 'label:bug']), { fix: true, fix_signal: 'pr:96' });
  // A PR that only the label marks is still a fix when the list also has pr: signals.
  assert.deepEqual(classifyFix(pr({ number: 5, labels: ['bug'] }), ['pr:96', 'label:bug']), { fix: true, fix_signal: 'label:bug' });
});

test('a PR with no matching signal is not a fix', () => {
  assert.deepEqual(classifyFix(pr({}), DEFAULT_FIX_SIGNALS), notFix);
});
