import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFix, DEFAULT_FIX_SIGNALS, readFixSignals } from '../src/fix-signals.js';
import { ToolError } from '../src/tool-error.js';

const pr = (fields) => ({ title: 'Add a page', labels: [], branch: 'topic', ...fields });
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

test('a PR with no matching signal is not a fix', () => {
  assert.deepEqual(classifyFix(pr({}), DEFAULT_FIX_SIGNALS), notFix);
});

// readFixSignals reads evidence.yml in a folder.
function folderWith(evidenceYml) {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-signals-'));
  if (evidenceYml !== undefined) writeFileSync(join(cwd, 'evidence.yml'), evidenceYml);
  return cwd;
}

test('readFixSignals uses the defaults when there is no evidence.yml', async () => {
  assert.deepEqual(await readFixSignals(folderWith()), DEFAULT_FIX_SIGNALS);
});

test('readFixSignals uses the defaults when evidence.yml has no settings.fix_signals', async () => {
  assert.deepEqual(await readFixSignals(folderWith('version: 3\nsettings:\n  test_command: npm test\n')), DEFAULT_FIX_SIGNALS);
  assert.deepEqual(await readFixSignals(folderWith('version: 3\n')), DEFAULT_FIX_SIGNALS);
  assert.deepEqual(await readFixSignals(folderWith('')), DEFAULT_FIX_SIGNALS);
});

test('readFixSignals uses a custom list in place of the defaults', async () => {
  const cwd = folderWith('settings:\n  fix_signals: [label:defect, title:hotfix]\n');
  assert.deepEqual(await readFixSignals(cwd), ['label:defect', 'title:hotfix']);
});

test('readFixSignals reads only fix_signals, so the rest of the file is not checked', async () => {
  const cwd = folderWith('version: banana\nsettings:\n  fix_signals:\n    - branch:bugfix/\n  mutation_budget_seconds: soon\nkinds: 7\n');
  assert.deepEqual(await readFixSignals(cwd), ['branch:bugfix/']);
});

test('readFixSignals refuses a malformed fix_signals with a tool error that says what is wrong', async () => {
  const cases = [
    ['settings:\n  fix_signals: label:bug\n', /must be a list/],
    ['settings:\n  fix_signals: []\n', /at least one signal/],
    ['settings:\n  fix_signals: [label:bug, 7]\n', /fix_signals\[1\].*not 7/],
    ['settings:\n  fix_signals: [bug]\n', /"bug".*label:, title: or branch:/],
    ['settings:\n  fix_signals: [issue:bug]\n', /"issue:bug".*label:, title: or branch:/],
    ['settings:\n  fix_signals: ["label:"]\n', /"label:".*needs a value/],
    ['settings:\n  fix_signals: ["label: bug"]\n', /"label: bug".*space/],
    ['settings:\n  fix_signals: ["title:fix "]\n', /"title:fix ".*space/],
    ['settings:\n  fix_signals: [label:bug\n', /evidence\.yml is not valid YAML/]
  ];
  for (const [text, message] of cases) {
    await assert.rejects(readFixSignals(folderWith(text)), (error) => error instanceof ToolError && message.test(error.message), text);
  }
});
