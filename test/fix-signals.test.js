import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFix, DEFAULT_FIX_SIGNALS, readFixSignals } from '../src/fix-signals.js';
import { ToolError } from '../src/tool-error.js';

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

// readFixSignals reads evidence.yml in a folder.
// The folder is removed when test t ends.
function folderWith(t, evidenceYml) {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-signals-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  if (evidenceYml !== undefined) writeFileSync(join(cwd, 'evidence.yml'), evidenceYml);
  return cwd;
}

test('readFixSignals uses the defaults when there is no evidence.yml', async (t) => {
  assert.deepEqual(await readFixSignals(folderWith(t)), DEFAULT_FIX_SIGNALS);
});

test('readFixSignals uses the defaults when evidence.yml has no settings.fix_signals', async (t) => {
  assert.deepEqual(await readFixSignals(folderWith(t, 'version: 3\nsettings:\n  test_command: npm test\n')), DEFAULT_FIX_SIGNALS);
  assert.deepEqual(await readFixSignals(folderWith(t, 'version: 3\n')), DEFAULT_FIX_SIGNALS);
  assert.deepEqual(await readFixSignals(folderWith(t, '')), DEFAULT_FIX_SIGNALS);
});

test('readFixSignals uses a custom list in place of the defaults', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:defect, title:hotfix]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:defect', 'title:hotfix']);
});

test('readFixSignals accepts title_after_key: like the other types', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:bug, title_after_key:fix, branch:fix/]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:bug', 'title_after_key:fix', 'branch:fix/']);
});

test('readFixSignals accepts pr: with a PR number, like the other types', async (t) => {
  const cwd = folderWith(t, 'settings:\n  fix_signals: [label:bug, title:fix, branch:fix/, pr:96, pr:99, pr:1]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:bug', 'title:fix', 'branch:fix/', 'pr:96', 'pr:99', 'pr:1']);
});

test('readFixSignals refuses a pr: value that is not a PR number, with a message for each', async (t) => {
  const cases = [
    ['settings:\n  fix_signals: ["pr:"]\n', /fix_signals\[0\] is "pr:", which needs a value after the colon\./],
    ['settings:\n  fix_signals: [label:bug, pr:abc]\n', /fix_signals\[1\] is "pr:abc"\. A pr: signal needs a PR number of 1 or more, as in pr:96\./],
    ['settings:\n  fix_signals: ["pr:-3"]\n', /"pr:-3"\. A pr: signal needs a PR number of 1 or more, as in pr:96\./],
    ['settings:\n  fix_signals: ["pr:0"]\n', /"pr:0"\. A pr: signal needs a PR number of 1 or more/],
    ['settings:\n  fix_signals: ["pr:9.5"]\n', /"pr:9\.5"\. A pr: signal needs a PR number/],
    ['settings:\n  fix_signals: ["pr:#96"]\n', /"pr:#96"\. A pr: signal needs a PR number/],
    ['settings:\n  fix_signals: ["pr:096"]\n', /"pr:096"\. A pr: signal needs a PR number of 1 or more, as in pr:96\./],
    ['settings:\n  fix_signals: ["pr: 96"]\n', /"pr: 96"\. Remove the space before or after the value, as in pr:96\./],
    // Without quotes, YAML reads "pr: 96" in a list as a mapping, not as text.
    ['settings:\n  fix_signals: [pr: 96]\n', /fix_signals\[0\] must be text like label:bug, not \{"pr":96\}\. Write it with no space after the colon, as in pr:96\./]
  ];
  for (const [text, message] of cases) {
    await assert.rejects(readFixSignals(folderWith(t, text)), (error) => error instanceof ToolError && message.test(error.message), text);
  }
});

test('readFixSignals reads only fix_signals, so the rest of the file is not checked', async (t) => {
  const cwd = folderWith(t, 'version: banana\nsettings:\n  fix_signals:\n    - branch:bugfix/\n  mutation_budget_seconds: soon\nkinds: 7\n');
  assert.deepEqual(await readFixSignals(cwd), ['branch:bugfix/']);
});

test('readFixSignals refuses a malformed fix_signals with a tool error that says what is wrong', async (t) => {
  const cases = [
    ['settings:\n  fix_signals: label:bug\n', /must be a list/],
    ['settings:\n  fix_signals: []\n', /at least one signal/],
    ['settings:\n  fix_signals: [label:bug, 7]\n', /fix_signals\[1\].*not 7/],
    ['settings:\n  fix_signals: [bug]\n', /"bug".*label:, title:, title_after_key:, branch: or pr:/],
    ['settings:\n  fix_signals: [issue:bug]\n', /"issue:bug".*label:, title:, title_after_key:, branch: or pr:/],
    ['settings:\n  fix_signals: ["title_after_key:"]\n', /"title_after_key:".*needs a value/],
    ['settings:\n  fix_signals: ["title_after_key: fix"]\n', /"title_after_key: fix".*space/],
    ['settings:\n  fix_signals: ["label:"]\n', /"label:".*needs a value/],
    ['settings:\n  fix_signals: ["label: bug"]\n', /"label: bug".*space/],
    ['settings:\n  fix_signals: ["title:fix "]\n', /"title:fix ".*space/],
    ['settings:\n  fix_signals: [label:bug\n', /evidence\.yml is not valid YAML/]
  ];
  for (const [text, message] of cases) {
    await assert.rejects(readFixSignals(folderWith(t, text)), (error) => error instanceof ToolError && message.test(error.message), text);
  }
});
