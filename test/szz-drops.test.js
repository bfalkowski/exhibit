import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugReportNumbers, countedLines, dropNewerLines } from '../src/szz.js';

// Builds a `git diff -U0` text. Each file is { path, hunks }, and each hunk is
// { at, deleted, added }: `at` is the first old line number, and `deleted` and `added` are the
// texts of the lines.
function diff(...files) {
  const rows = [];
  for (const { path, from = path, hunks } of files) {
    rows.push(`diff --git a/${from} b/${path}`, 'index 1111111..2222222 100644', `--- a/${from}`, `+++ b/${path}`);
    for (const { at, deleted = [], added = [] } of hunks) {
      const old = deleted.length === 0 ? `${at - 1},0` : `${at},${deleted.length}`;
      rows.push(`@@ -${old} +${at},${added.length} @@`, ...deleted.map((t) => `-${t}`), ...added.map((t) => `+${t}`));
    }
  }
  return rows.join('\n') + '\n';
}

const counted = (result) => [...result.counted].map(([path, numbers]) => [path, numbers]);
const dropped = (result) => result.dropped.map(({ path, line, reason }) => [path, line, reason]);

test('a real change counts', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 4, deleted: ['  sum += x;'], added: ['  sum += x * n;'] }] }));
  assert.deepEqual(counted(result), [['a.js', [4]]]);
  assert.deepEqual(result.dropped, []);
});

test('whitespace: a line that differs from the old one only in whitespace is dropped', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 10, deleted: ['    return a+b;'], added: ['  return a + b;'] }] }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(result.dropped, [{ path: 'a.js', line: 10, text: '    return a+b;', reason: 'whitespace' }]);
});

test('whitespace: a deleted blank line is dropped', () => {
  const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 3, deleted: ['', '   '] }] }));
  assert.deepEqual(dropped(result), [['a.py', 3, 'whitespace'], ['a.py', 4, 'whitespace']]);
});

test('whitespace: a fix that mixes a real change with whitespace keeps only the real lines', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{
    at: 5,
    deleted: ['    if (a) {', '    total = price;', '    }'],
    added: ['  if (a) {', '  total = price * qty;', '  }']
  }] }));
  assert.deepEqual(counted(result), [['a.js', [6]]]);
  assert.deepEqual(dropped(result), [['a.js', 5, 'whitespace'], ['a.js', 7, 'whitespace']]);
});

test('whitespace: each added line pairs with one deleted line only', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 1, deleted: ['  x++;', '  x++;'], added: ['x++;'] }] }));
  assert.deepEqual(counted(result), [['a.js', [2]]]);
  assert.deepEqual(dropped(result), [['a.js', 1, 'whitespace']]);
});

test('moved: a line deleted in one place and added unchanged in another is dropped', () => {
  const result = countedLines(diff({ path: 'f.js', hunks: [
    { at: 3, added: ['export function receipt(rows) {', "  return rows.join('\\n');", '}'] },
    { at: 12, deleted: ['export function receipt(rows) {', "  return rows.join('\\n');", '}'] }
  ] }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['f.js', 12, 'moved'], ['f.js', 13, 'moved'], ['f.js', 14, 'moved']]);
});

test('moved: a line moved to another file, with new indent, is dropped', () => {
  const result = countedLines(diff(
    { path: 'a.js', hunks: [{ at: 7, deleted: ['  const tax = total * rate;'] }] },
    { path: 'b.js', hunks: [{ at: 2, added: ['    const tax = total * rate;'] }] }
  ));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 7, 'moved']]);
});

test('moved: a line that is added back changed is not moved', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, added: ['return total - percent / 100;'] },
    { at: 9, deleted: ['return total - percent;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [9]]]);
});

test('comments: JavaScript and TypeScript line and block comments are dropped', () => {
  for (const path of ['a.js', 'a.ts', 'a.tsx', 'a.mjs']) {
    const result = countedLines(diff({ path, hunks: [
      { at: 1, deleted: ['// Turns cents into a string like "12.50".'], added: ['// Turns cents into a string such as "12.50".'] },
      { at: 5, deleted: ['/**', ' * Pads a label.', ' */'], added: ['/** Pads a label on the right. */'] },
      { at: 20, deleted: ['/* one', 'two', 'three */'] },
      { at: 30, deleted: ['  /* old */'] }
    ] }));
    assert.deepEqual(counted(result), [], path);
    assert.deepEqual(result.dropped.map((d) => d.line), [1, 5, 6, 7, 20, 21, 22, 30], path);
    assert.ok(result.dropped.every((d) => d.reason === 'comment'), path);
  }
});

test('comments: Python # comments are dropped', () => {
  const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 2, deleted: ['    # sum the prices'], added: ['    # add up the prices'] }] }));
  assert.deepEqual(dropped(result), [['a.py', 2, 'comment']]);
});

test('comments: a line with code before or after the comment counts', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, deleted: ['x = 1; // one'], added: ['x = 2; // two'] },
    { at: 4, deleted: ['/* a */ y = 1;'], added: ['y = 2;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [1, 4]]]);
});

test('comments: a commented-out line that the fix turns back into code counts', () => {
  // The PR that commented the line out may have brought the bug, so blame it.
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: ['  // check(input);'], added: ['  check(input);'] }] }));
  assert.deepEqual(counted(result), [['a.js', [3]]]);
});

test('comments: only JavaScript, TypeScript and Python know comments', () => {
  const result = countedLines(diff(
    { path: 'a.rb', hunks: [{ at: 1, deleted: ['# old'], added: ['# new'] }] },
    { path: 'a.py', hunks: [{ at: 1, deleted: ['// not a comment in Python'], added: ['x'] }] }
  ));
  assert.deepEqual(counted(result), [['a.rb', [1]], ['a.py', [1]]]);
});

test('a renamed file keeps its old path, and a new file has no old lines', () => {
  const result = countedLines(diff(
    { path: 'new.js', from: 'old.js', hunks: [{ at: 2, deleted: ['a();'], added: ['b();'] }] }
  ) + [
    'diff --git a/n.js b/n.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/n.js',
    '@@ -0,0 +1 @@',
    '+c();',
    ''
  ].join('\n'));
  assert.deepEqual(counted(result), [['old.js', [2]]]);
});

test('a deleted line that starts with "-- " is a line, not a file header', () => {
  const text = [
    'diff --git a/q.sql b/q.sql',
    'index 1111111..2222222 100644',
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -2 +1,0 @@',
    '--- old comment',
    '@@ -7 +6 @@',
    '-select 1;',
    '+select 2;',
    'diff --git a/b.js b/b.js',
    'index 3333333..4444444 100644',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    ''
  ].join('\n');
  assert.deepEqual(counted(countedLines(text)), [['q.sql', [2, 7]], ['b.js', [1]]]);
});

test('bugReportNumbers reads the GitHub closing words that link an issue in this repo', () => {
  assert.deepEqual(bugReportNumbers('Fixes #12.\nAlso closes #7, and resolved: #30'), [12, 7, 30]);
  assert.deepEqual(bugReportNumbers('FIX #4 and Close #4'), [4]);
  assert.deepEqual(bugReportNumbers('See #12. Prefix #3. other/repo#9 fixes other/repo#5'), []);
  assert.deepEqual(bugReportNumbers(null), []);
});

test('newer than the bug report: a line whose commit came after the report is dropped', () => {
  const at = (time, line) => ({ path: 'a.js', line, text: `line ${line}`, blame: { author_time: time } });
  const older = at('2026-01-05T09:00:00Z', 1);
  const same = at('2026-01-06T00:00:00Z', 2);
  const newer = at('2026-01-07T00:00:00Z', 3);
  const result = dropNewerLines([older, same, newer], '2026-01-06T00:00:00Z');
  assert.deepEqual(result.kept, [older, same]);
  assert.deepEqual(result.dropped, [{ path: 'a.js', line: 3, text: 'line 3', reason: 'newer than the bug report' }]);
  assert.deepEqual(dropNewerLines([older, newer], null), { kept: [older, newer], dropped: [] });
});
