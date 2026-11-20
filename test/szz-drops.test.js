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
    { at: 12, deleted: ['export function receipt(rows) {', "  return rows.join('\\n');", '}'] },
    { at: 30, deleted: ['  return total;'], added: ['  return total + tax;'] }
  ] }));
  assert.deepEqual(counted(result), [['f.js', [30]]]);
  assert.deepEqual(dropped(result), [['f.js', 12, 'moved'], ['f.js', 13, 'moved'], ['f.js', 14, 'moved']]);
});

test('moved: a block moved to another file, with new indent, is dropped', () => {
  const result = countedLines(diff(
    { path: 'a.js', hunks: [{ at: 7, deleted: ['  const tax = total * rate;', '  return total + tax;'] }] },
    { path: 'b.js', hunks: [{ at: 2, added: ['    const tax = total * rate;', '    return total + tax;'] }] }
  ));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 7, 'moved'], ['a.js', 8, 'moved']]);
});

test('moved: one moved line counts, because a real fix can delete it in one place and add it in another', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 2, added: ['  if (rows.length === 0) return null;'] },
    { at: 9, deleted: ['  return null;'] },
    { at: 20, added: ['  return null;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [9]]]);
  assert.deepEqual(result.dropped, []);
});

test('moved: short lines such as "}" do not pair with the same text in unrelated places', () => {
  // The case from the real run: eslint-suppressions.json, where "count": 4 and } are in many places.
  const result = countedLines(diff({ path: 'eslint-suppressions.json', hunks: [
    { at: 3, deleted: ['    "no-restricted-syntax": {', '      "count": 4', '    }', '  },'] },
    { at: 30, added: ['    "max-lines": {', '      "count": 4', '    }', '  },'] }
  ] }));
  assert.deepEqual(counted(result), [['eslint-suppressions.json', [3, 4, 5, 6]]]);
  assert.deepEqual(result.dropped, []);
});

test('moved: lines that other hunks add back, but not next to each other, count', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 2, added: ['  const tax = total * rate;'] },
    { at: 9, deleted: ['  const tax = total * rate;', '  return total + tax;'] },
    { at: 20, added: ['  return total + tax;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [9, 10]]]);
});

test('moved: a moved block keeps its blank lines and closing braces', () => {
  const block = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}'];
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, added: block },
    { at: 40, deleted: ['x = 1;', ...block] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [40]]]);
  assert.deepEqual(dropped(result).map(([, line, reason]) => [line, reason]), [41, 42, 43, 44, 45, 46, 47].map((line) => [line, 'moved']));
});

test('moved: a line that is added back changed is not moved', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, added: ['return total - percent / 100;'] },
    { at: 9, deleted: ['return total - percent;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [9]]]);
});

test('moved: a fix that only moves lines inside one file counts the moved lines, because their place was the bug', () => {
  // The case from the real run: chalk/chalk PR 569 moves five export lines up the file.
  const exports = ['export const modifierNames = Object.keys(styles.modifier);', 'export const colorNames = [...foregroundColorNames];'];
  const result = countedLines(diff({ path: 'index.js', hunks: [
    { at: 68, added: [...exports, ''] },
    { at: 219, deleted: ['', ...exports] }
  ] }));
  assert.deepEqual(counted(result), [['index.js', [220, 221]]]);
  assert.deepEqual(dropped(result), [['index.js', 219, 'moved']]);
});

test('moved: a line with no letter or digit, such as "});", does not count when it moves inside one file', () => {
  // The case from the review of PR 99: only "});" moves, and the other line changes whitespace.
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 2, deleted: ['});', '  x=1;'], added: ['  x = 1;', '});'] }] }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 2, 'moved'], ['a.js', 3, 'whitespace']]);
});

test('moved: when lines with words move inside one file, a moved "}" next to them stays dropped', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, added: ['run(a);', 'run(b);', '}'] },
    { at: 9, deleted: ['run(a);', 'run(b);', '}'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [9, 10]]]);
  assert.deepEqual(dropped(result), [['a.js', 11, 'moved']]);
});

test('moved: a comment line that moves inside its hunk stays dropped, because a comment carries no bug', () => {
  // The case from the review of PR 99: "// note" moves, and "x=1;" only changes whitespace.
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 1, deleted: ['// note', 'x=1;'], added: ['x = 1;', '// note'] }] }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 1, 'moved'], ['a.js', 2, 'whitespace']]);
  // A comment line in a moved block stays dropped too, and the code lines with it count.
  const block = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, added: ['// set up', 'run(a);', 'run(b);'] },
    { at: 9, deleted: ['// set up', 'run(a);', 'run(b);'] }
  ] }));
  assert.deepEqual(counted(block), [['a.js', [10, 11]]]);
  assert.deepEqual(dropped(block), [['a.js', 9, 'moved']]);
});

test('moved: a move inside one file is still dropped when the fix changes other lines too', () => {
  const block = ['const tax = total * rate;', 'return total + tax;'];
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 2, added: block },
    { at: 9, deleted: [...block, 'x = 1;'], added: ['x = 2;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [11]]]);
  assert.deepEqual(dropped(result), [['a.js', 9, 'moved'], ['a.js', 10, 'moved']]);
});

test('moved: a fix that only moves lines to another file still counts no line', () => {
  const block = ['const tax = total * rate;', 'return total + tax;'];
  const result = countedLines(diff(
    { path: 'a.js', hunks: [{ at: 7, deleted: block }] },
    { path: 'b.js', hunks: [{ at: 2, added: block }] }
  ));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 7, 'moved'], ['a.js', 8, 'moved']]);
});

test('whitespace: a space inside a string is code in JavaScript, TypeScript and Python', () => {
  for (const [path, before, after] of [
    ['a.js', "  print('Total:' + n);", "  print('Total: ' + n);"],
    ['a.ts', '  label = `Total:${n}`;', '  label = `Total: ${n}`;'],
    ['a.py', '    print("Total:", n)', '    print("Total: ", n)'],
    ['a.py', "    s = 'it\\'s:'", "    s = 'it\\'s: '"]
  ]) {
    const result = countedLines(diff({ path, hunks: [{ at: 3, deleted: [before], added: [after] }] }));
    assert.deepEqual(counted(result), [[path, [3]]], `${path}: ${before}`);
  }
});

test('whitespace: a space outside a string, or in a comment after the code, is still whitespace', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{
    at: 3,
    deleted: ["  print('Total: '+n); // don't", "  x = 'a';"],
    added: ["  print( 'Total: ' + n );  //  don't", "  x  =  'a';"]
  }] }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 3, 'whitespace'], ['a.js', 4, 'whitespace']]);
});

test('whitespace: whitespace inside ${ } in a template literal is code, not string text', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{
    at: 3,
    deleted: ['  s = `${ a }`;', '  t = `x ${ f({ k: 1 }) } y`;'],
    added: ['  s = `${a}`;', '  t = `x ${f({k: 1})} y`;']
  }] }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 3, 'whitespace'], ['a.js', 4, 'whitespace']]);
  // The text around ${ } is still string text.
  const text = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: ['  t = `x ${a}y`;'], added: ['  t = `x ${a} y`;'] }] }));
  assert.deepEqual(counted(text), [['a.js', [3]]]);
});

test('whitespace: a quote mark in a regex opens no string, so the whitespace in a later string is code', () => {
  // The cases from the review of PR 99. The quote in /'/ and the { in /{/ are regex text.
  for (const [before, after] of [
    ["  x = /'/.test(s) ? 'a b' : c;", "  x = /'/.test(s) ? 'ab' : c;"],
    ['  s = `${ a.replace(/{/, \'\') } y z`;', '  s = `${ a.replace(/{/, \'\') } yz`;']
  ]) {
    const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: [before], added: [after] }] }));
    assert.deepEqual(counted(result), [['a.js', [3]]], before);
  }
  // Whitespace outside the strings is still whitespace.
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: ["  x = /'/.test(s) ? 'a b' : c;"], added: ["  x=/'/.test(s)?'a b':c;"] }] }));
  assert.deepEqual(dropped(result), [['a.js', 3, 'whitespace']]);
  // A space inside a regex is part of the regex, so it counts.
  const regex = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: ['  r = / a/;'], added: ['  r = /a/;'] }] }));
  assert.deepEqual(counted(regex), [['a.js', [3]]]);
});

test('whitespace: a division that reads as a regex can drop a change in a later string that has a "/" in it', () => {
  // A known limit (spec 9.2), pinned so that a change to opensRegex shows here. The regex that
  // "/ 2" starts ends inside 'a / b', so the strings after it read the wrong way round.
  for (const before of ["  y = obj.of / 2 + 'a / b' + 'c d';", "  y = x++ / 2 + 'a / b' + 'c d';"]) {
    const after = before.replace("'c d'", "'cd'");
    const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: [before], added: [after] }] }));
    assert.deepEqual(dropped(result), [['a.js', 3, 'whitespace']], before);
  }
  // A plain division reads right, so the change counts.
  const plain = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: ["  y = a / 2 + 'c d';"], added: ["  y = a / 2 + 'cd';"] }] }));
  assert.deepEqual(counted(plain), [['a.js', [3]]]);
});

test('whitespace: in a file of another kind, a space inside quotes is whitespace, as before', () => {
  const result = countedLines(diff({ path: 'a.rb', hunks: [{ at: 3, deleted: ["puts 'Total:'"], added: ["puts 'Total: '"] }] }));
  assert.deepEqual(dropped(result), [['a.rb', 3, 'whitespace']]);
});

test('a fix that rewrites a big generated file, such as a lockfile, is fast', () => {
  const size = 20000;
  const deleted = Array.from({ length: size }, (_, i) => `    "integrity": "sha512-old${i}",`);
  const added = Array.from({ length: size }, (_, i) => `    "integrity": "sha512-new${i}",`);
  const start = Date.now();
  const result = countedLines(diff({ path: 'package-lock.json', hunks: [{ at: 1, deleted, added }] }));
  assert.equal(result.counted.get('package-lock.json').length, size);
  // Before the added lines had an index, this took about 26 seconds.
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
});

test('moved: a long run of a short line with no words, deleted in one hunk and added in another, is fast', () => {
  const size = 2000;
  const run = Array.from({ length: size }, () => '  ],');
  const start = Date.now();
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 1, deleted: run }, { at: 5000, added: run }] }));
  // No block reaches two lines with words, so no line is moved and each "]," is a real change.
  assert.equal(result.counted.get('a.js').length, size);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
});

test('moved: a long run of a short line is fast when two lines with words follow it but are not added back', () => {
  const size = 2000;
  const run = Array.from({ length: size }, () => '  ],');
  const start = Date.now();
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 1, deleted: [...run, 'a();', 'b();'] }, { at: 5000, added: run }] }));
  assert.equal(result.counted.get('a.js').length, size + 2);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
});

test('moved: a line that the same hunk adds back does not split a moved block', () => {
  const block = ['a();', 'b();', 'c();', 'd();'];
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 10, deleted: block, added: ['b();'] },
    { at: 40, added: block },
    { at: 60, deleted: ['x = 1;'], added: ['x = 2;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [60]]]);
  assert.deepEqual(dropped(result), [10, 11, 12, 13].map((line) => ['a.js', line, 'moved']));
});

test('moved: a block passes over a line that its own hunk adds back, and that line keeps its reason', () => {
  // The hunk adds back "b();" with only whitespace changed. Lines 10 and 12 still count: one line
  // of words on each side of line 11 is not a block.
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 10, deleted: ['a();', 'b();', 'c();'], added: ['  b();'] },
    { at: 40, added: ['a();', 'b();', 'c();'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [10, 12]]]);
  assert.deepEqual(dropped(result), [['a.js', 11, 'whitespace']]);
});

test('moved: when a fix only moves a block that its own hunk partly adds back, all its lines count', () => {
  const block = ['a();', 'b();', 'c();', 'd();'];
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 10, deleted: block, added: ['b();'] }, { at: 40, added: block }] }));
  assert.deepEqual(counted(result), [['a.js', [10, 11, 12, 13]]]);
});

test('moved: a line that a block passes over leaves the added line of the other hunk to another block', () => {
  // Line 11 pairs with the "b();" that its own hunk adds back. So the block from line 30 gets the
  // "b();" of hunk 20, and line 10 alone moves only one line with words, so it counts.
  const hunks = [
    { at: 10, deleted: ['a();', 'b();'], added: ['b();'] },
    { at: 20, added: ['a();', 'b();', 'c();'] },
    { at: 30, deleted: ['b();', 'c();'] }
  ];
  const withChange = countedLines(diff({ path: 'a.js', hunks: [...hunks, { at: 40, deleted: ['x = 1;'], added: ['x = 2;'] }] }));
  assert.deepEqual(counted(withChange), [['a.js', [10, 40]]]);
  assert.deepEqual(dropped(withChange), [11, 30, 31].map((line) => ['a.js', line, 'moved']));
  const alone = countedLines(diff({ path: 'a.js', hunks }));
  assert.deepEqual(counted(alone), [['a.js', [10]]]);
});

test('moved: a line that a block passes over does not count toward its two lines with words', () => {
  // The block at line 30 moves only one line with words, "c();", so it does not take the "c();"
  // of hunk 20 from the real block at line 40.
  const result = countedLines(diff(
    { path: 'a.js', hunks: [
      { at: 20, added: ['c();', 'a();', 'a();'] },
      { at: 30, deleted: ['c();', 'a();'], added: ['a();'] },
      { at: 40, deleted: ['c();', 'a();'] }
    ] },
    { path: 'z.js', hunks: [{ at: 1, deleted: ['x = 1;'], added: ['x = 2;'] }] }
  ));
  assert.deepEqual(counted(result), [['a.js', [30]], ['z.js', [1]]]);
  assert.deepEqual(dropped(result), [['a.js', 31, 'moved'], ['a.js', 40, 'moved'], ['a.js', 41, 'moved']]);
});

test('moved: a re-indent in one hunk stays whitespace when another hunk deletes a copy of the lines', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 10, deleted: ['  load(user);', '  save(user);'], added: ['    load(user);', '    save(user);'] },
    { at: 40, deleted: ['  load(user);', '  save(user);'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [40, 41]]]);
  assert.deepEqual(dropped(result), [['a.js', 10, 'whitespace'], ['a.js', 11, 'whitespace']]);
});

test('moved: lines that their own hunk adds back with new whitespace stay whitespace when another hunk adds them too', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 10, deleted: ['  a();', '  b();'], added: ['a();', 'b();'] },
    { at: 40, added: ['  a();', '  b();'] }
  ] }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 10, 'whitespace'], ['a.js', 11, 'whitespace']]);
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
  assert.deepEqual(bugReportNumbers('Fixes #12.\nAlso closes #7, and resolved: #30', 'owner/repo'), [12, 7, 30]);
  assert.deepEqual(bugReportNumbers('FIX #4 and Close #4', 'owner/repo'), [4]);
  assert.deepEqual(bugReportNumbers('See #12. Prefix #3. other/repo#9 fixes other/repo#5', 'owner/repo'), []);
  assert.deepEqual(bugReportNumbers(null, 'owner/repo'), []);
});

test('bugReportNumbers reads a full issue URL when it names this repo', () => {
  const body = 'Fixes https://github.com/Owner/Repo/issues/12\nCloses https://github.com/owner/other/issues/9\nresolves: https://github.com/owner/repo/issues/12 and fixes https://github.com/owner/repo/pull/3';
  assert.deepEqual(bugReportNumbers(body, 'owner/repo'), [12]);
  assert.deepEqual(bugReportNumbers('Fixes #4, closes https://github.com/owner/repo/issues/5.', 'owner/repo'), [4, 5]);
});

test('bugReportNumbers reads owner/name#12 when it names this repo', () => {
  const body = 'Fixes Owner/Repo#12\nCloses owner/other#9 and fixes other/repo#8\nresolves: owner/repo#12, closes owner/repo#5.';
  assert.deepEqual(bugReportNumbers(body, 'owner/repo'), [12, 5]);
  // A repo name with dots and dashes, and a mix of all three forms.
  assert.deepEqual(bugReportNumbers('fixes my-org/my.repo#3, closes #4, fixes https://github.com/my-org/my.repo/issues/6', 'my-org/my.repo'), [3, 4, 6]);
  // The words must close the issue: a bare mention does not count.
  assert.deepEqual(bugReportNumbers('See owner/repo#7. Prefixes owner/repo#2', 'owner/repo'), []);
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

test('whitespace: in Python the indent is code, so a fix that only moves a line out of a block counts', () => {
  const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 5, deleted: ['        return total'], added: ['    return total'] }] }));
  assert.deepEqual(counted(result), [['a.py', [5]]]);
  // Whitespace after the indent still does not count.
  const inside = countedLines(diff({ path: 'a.py', hunks: [{ at: 5, deleted: ['    x = a+b'], added: ['    x = a + b'] }] }));
  assert.deepEqual(dropped(inside), [['a.py', 5, 'whitespace']]);
});

test('whitespace: a line that the same hunk adds back exactly is a moved line, not whitespace', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, deleted: ['unlock();', 'save();'], added: ['save();', 'unlock();'] },
    { at: 9, deleted: ['  return total;'], added: ['  return total + tax;'] }
  ] }));
  assert.deepEqual(dropped(result), [['a.js', 1, 'moved'], ['a.js', 2, 'moved']]);
});

test('moved: a fix that only swaps two lines in one hunk counts them, because their order was the bug', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 1, deleted: ['unlock();', 'save();'], added: ['save();', 'unlock();'] }] }));
  assert.deepEqual(counted(result), [['a.js', [1, 2]]]);
});

test('comments: a code line that starts with the * operator counts', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 5, deleted: ['  * qty;'], added: ['  * qty * rate;'] }] }));
  assert.deepEqual(counted(result), [['a.js', [5]]]);
});

test('comments: a * row counts as a comment when the hunk closes the block or the row is a JSDoc tag', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 2, deleted: [' * Pads a label.', ' * @param width the size', ' */'], added: [' * Pads a label on the right.'] },
    { at: 9, deleted: [' * @returns the label'] },
    { at: 12, deleted: [' * Old words. */'] }
  ] }));
  assert.deepEqual(counted(result), []);
  assert.ok(result.dropped.every((d) => d.reason === 'comment'));
});

test('comments: an indented Python comment that the fix turns back into code counts', () => {
  for (const [old, now] of [['    # return total', '    return total'], ['# return total', 'return total'], ['        # check(x)', '    check(x)']]) {
    const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 5, deleted: [old], added: [now] }] }));
    assert.deepEqual(counted(result), [['a.py', [5]]], old);
  }
});

test('comments: a * row with a "*/" later in the hunk that does not close a block counts', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 5, deleted: ['  * qty;', 'const re = /a*/;'], added: ['  * qty * rate;', 'const re = /b*/;'] }] }));
  assert.deepEqual(counted(result), [['a.js', [5, 6]]]);
});

test('comments: a * row before a line that opens and closes its own comment counts', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 5, deleted: ['  * qty;', '  foo(); /* note */'], added: ['  * qty * rate;', '  foo(); /* new note */'] }] }));
  assert.deepEqual(counted(result), [['a.js', [5]]]);
});

test('comments: a * row before a regex that ends in "*/" with no semicolon counts', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 5, deleted: ['  * qty', 'const re = /a*/'], added: ['  * qty * rate', 'const re = /b*/'] }] }));
  assert.deepEqual(counted(result), [['a.js', [5, 6]]]);
});

test('comments: a line where only the trailing comment changed is dropped', () => {
  const result = countedLines(diff(
    { path: 'a.js', hunks: [{ at: 2, deleted: ['x = 1; // old note', 'y = 2; /* old */'], added: ['x = 1;', 'y = 2; /* new */'] }] },
    { path: 'a.ts', hunks: [{ at: 7, deleted: ['let z = 3;'], added: ['let z = 3; // why z is 3'] }] },
    { path: 'a.py', hunks: [{ at: 4, deleted: ['    total = 0  # start at zero'], added: ['    total = 0'] }] }
  ));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 2, 'comment'], ['a.js', 3, 'comment'], ['a.ts', 7, 'comment'], ['a.py', 4, 'comment']]);
});

test('comments: a line whose code changed with its trailing comment counts', () => {
  const result = countedLines(diff(
    { path: 'a.js', hunks: [{ at: 1, deleted: ['x = 1; // old note'], added: ['x = 2;'] }] },
    // In Python the indent is code, so a line that leaves its block counts.
    { path: 'a.py', hunks: [{ at: 4, deleted: ['    total = 0  # start'], added: ['total = 0'] }] }
  ));
  assert.deepEqual(counted(result), [['a.js', [1]], ['a.py', [4]]]);
});

test('comments: a // or # inside a string is code, not a comment', () => {
  // With the quotes ignored, each pair would be the same code with a changed comment.
  const result = countedLines(diff(
    { path: 'a.js', hunks: [{ at: 1, deleted: ["url = 'a // b';", 'path = "x /* y */ z";', 'tag = `a // b`;'], added: ["url = 'a // c';", 'path = "x /* q */ z";', 'tag = `a // c`;'] }] },
    { path: 'a.py', hunks: [{ at: 1, deleted: ["tag = 'a # b'", 'say = "it\\"s # 1"'], added: ["tag = 'a # c'", 'say = "it\\"s # 2"'] }] }
  ));
  assert.deepEqual(counted(result), [['a.js', [1, 2, 3]], ['a.py', [1, 2]]]);
});

test('comments: a trailing comment pairs only with a line in the same hunk', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [
    { at: 1, deleted: ['x = 1; // old note'] },
    { at: 9, added: ['x = 1;'] }
  ] }));
  assert.deepEqual(counted(result), [['a.js', [1]]]);
});

test('comments: a // in JSX text before a closing tag is text, not a comment', () => {
  // "// 10 USD</p>" ends with a closing tag, so it is the text of the element.
  const result = countedLines(diff(
    { path: 'a.jsx', hunks: [{ at: 3, deleted: ['  <p>Price // 10 USD</p>'], added: ['  <p>Price // 20 USD</p>'] }] },
    { path: 'b.tsx', hunks: [{ at: 8, deleted: ['  <b>a // b</b> // old note'], added: ['  <b>a // b</b> // new note'] }] }
  ));
  assert.deepEqual(counted(result), [['a.jsx', [3]]]);
  assert.deepEqual(dropped(result), [['b.tsx', 8, 'comment']]);
});

test('comments: a quote inside a regex literal does not hide the comment after it', () => {
  const result = countedLines(diff({ path: 'a.js', hunks: [{
    at: 1,
    deleted: ["r = /'/; // n", 's = x.split(/"/) // why', 'q = a / b; // c', "t = /'/;"],
    added: ["r = /'/;", 's = x.split(/"/)', 'q = a / b;', 't = /"/;']
  }] }));
  assert.deepEqual(dropped(result), [['a.js', 1, 'comment'], ['a.js', 2, 'comment'], ['a.js', 3, 'comment']]);
  assert.deepEqual(counted(result), [['a.js', [4]]]);
});

test('comments: trailing whitespace inside a string that goes on to the next line counts', () => {
  // No comment comes off these lines, so their end is string text, and its spaces are code.
  const result = countedLines(diff(
    { path: 'a.js', hunks: [{ at: 1, deleted: ['s = `abc  '], added: ['s = `abc '] }] },
    { path: 'a.py', hunks: [{ at: 1, deleted: ['s = """abc  '], added: ['s = """abc '] }] }
  ));
  assert.deepEqual(counted(result), [['a.js', [1]], ['a.py', [1]]]);
  assert.deepEqual(result.dropped, []);
});

test('comments: a rename that changes the language reads each side with its own comments', () => {
  // The old line is Python and the new line is JavaScript, so "// why" is a comment only on
  // the new side, and "# old" only on the old side, so "# new" is code.
  const result = countedLines(diff({ path: 'new.js', from: 'old.py', hunks: [{
    at: 1,
    deleted: ['x = 1', 'y = 2  # old'],
    added: ['x = 1  // why', 'y = 2  # new']
  }] }));
  assert.deepEqual(dropped(result), [['old.py', 1, 'comment']]);
  assert.deepEqual(counted(result), [['old.py', [2]]]);
});

// The whole files before and after the fix, as SZZ reads them at blamed_commit and merge_sha.
const files = (before, after) => ({ before: new Map(Object.entries(before)), after: new Map(Object.entries(after)) });

test('comments: with the file, a JSDoc text row whose block opens and closes outside the hunk is a comment', () => {
  const before = '/**\n * Pads a label.\n */\nexport const pad = (s) => s;\n';
  const after = '/**\n * Pads a label on the right.\n */\nexport const pad = (s) => s;\n';
  const hunks = [{ at: 2, deleted: [' * Pads a label.'], added: [' * Pads a label on the right.'] }];
  // Without the file, the row looks like code that starts with the * operator.
  assert.deepEqual(counted(countedLines(diff({ path: 'a.js', hunks }))), [['a.js', [2]]]);
  const result = countedLines(diff({ path: 'a.js', hunks }), files({ 'a.js': before }, { 'a.js': after }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.js', 2, 'comment']]);
});

test('comments: with the file, a row that starts with the * operator outside a block counts', () => {
  const before = 'const total = price\n  * qty;\n';
  const after = 'const total = price\n  * qty * rate;\n';
  const hunks = [{ at: 2, deleted: ['  * qty;'], added: ['  * qty * rate;'] }];
  // A "*/" later in the hunk does not make it a comment when the file shows no open block.
  const result = countedLines(diff({ path: 'a.js', hunks }), files({ 'a.js': before }, { 'a.js': after }));
  assert.deepEqual(counted(result), [['a.js', [2]]]);
});

test('comments: with the file, a block row with no * and a "/*" inside a string are read right', () => {
  const before = "const glob = 'src/**/*.js';\n/*\n  Old words.\n*/\nlet n = 1;\n";
  const after = "const glob = 'src/**/*.js';\n/*\n  New words.\n*/\nlet n = 1;\n";
  const result = countedLines(diff({ path: 'a.js', hunks: [{ at: 3, deleted: ['  Old words.'], added: ['  New words.'] }] }), files({ 'a.js': before }, { 'a.js': after }));
  assert.deepEqual(dropped(result), [['a.js', 3, 'comment']]);
});

test('whitespace: with the file, a Python line that keeps its block level is whitespace, tabs or spaces', () => {
  const before = 'def total(xs):\n\tt = 0\n\treturn t\n';
  const after = 'def total(xs):\n    t = 0\n    return t\n';
  const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 2, deleted: ['\tt = 0', '\treturn t'], added: ['    t = 0', '    return t'] }] }), files({ 'a.py': before }, { 'a.py': after }));
  assert.deepEqual(counted(result), []);
  assert.deepEqual(dropped(result), [['a.py', 2, 'whitespace'], ['a.py', 3, 'whitespace']]);
});

test('whitespace: with the file, a Python line that changes its block level counts', () => {
  const before = 'def f(xs):\n    for x in xs:\n        go(x)\n        done()\n';
  const after = 'def f(xs):\n    for x in xs:\n        go(x)\n    done()\n';
  const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 4, deleted: ['        done()'], added: ['    done()'] }] }), files({ 'a.py': before }, { 'a.py': after }));
  assert.deepEqual(counted(result), [['a.py', [4]]]);
});

test('whitespace: with the file, the indent of a Python line inside brackets is not code', () => {
  const before = 'x = call(a,\n         b)\n';
  const after = 'x = call(a,\n    b)\n';
  const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 2, deleted: ['         b)'], added: ['    b)'] }] }), files({ 'a.py': before }, { 'a.py': after }));
  assert.deepEqual(dropped(result), [['a.py', 2, 'whitespace']]);
});

test('comments: with the file, an indented Python comment that the fix turns back into code counts', () => {
  const before = 'def f():\n    # return total\n';
  const after = 'def f():\n    return total\n';
  const result = countedLines(diff({ path: 'a.py', hunks: [{ at: 2, deleted: ['    # return total'], added: ['    return total'] }] }), files({ 'a.py': before }, { 'a.py': after }));
  assert.deepEqual(counted(result), [['a.py', [2]]]);
});
