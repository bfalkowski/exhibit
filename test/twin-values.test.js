import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMutation, withTwinValues } from '../src/mutation.js';
import { inputsAndCopies, keepTwins, lineTwins, namedPaths, twinValues } from '../src/twin-values.js';

// The line of canary 5 (ticket 258): it counts from the window's first day, `from`, where it
// meant today, `date`. Each test asked on a first day, where the two are equal.
const CANARY_LINE = '    return dayNum(to[0], to[1], to[2]) - dayNum(from[0], from[1], from[2]) + 1;';
const firstDays = [
  { 'date.y': 2026, 'date.m': 11, 'date.d': 12, 'from[0]': 2026, 'from[1]': 11, 'from[2]': 12, 'to[0]': 2026, 'to[1]': 11, 'to[2]': 27, 'h.year': 2026 },
  { 'date.y': 2026, 'date.m': 12, 'date.d': 11, 'from[0]': 2026, 'from[1]': 12, 'from[2]': 11, 'to[0]': 2026, 'to[1]': 12, 'to[2]': 25, 'h.year': 2026 }
];

test('namedPaths gives each name of a line, with its first field, and not a field on its own', () => {
  assert.deepEqual([...namedPaths('a.b(c[2], d?.e) + f . g + h[i]')].sort(), ['a', 'a.b', 'c', 'c[2]', 'd', 'd.e', 'f', 'f.g', 'h', 'i'].sort());
  assert.ok(namedPaths(CANARY_LINE).has('from[2]'));
  assert.ok(!namedPaths(CANARY_LINE).has('date.d'));
});

test('a value that the line reads is a twin of one it does not read when they were equal each time and changed', () => {
  // from[2] and date.d were 12 and then 11. from[0] was 2026 each time, so it says nothing.
  assert.deepEqual(lineTwins(firstDays, CANARY_LINE), [
    { used: 'from[1]', twins: ['date.m'], values: [11, 12] },
    { used: 'from[2]', twins: ['date.d'], values: [12, 11] },
    { used: 'to[1]', twins: ['date.m'], values: [11, 12] }
  ]);
  // A test on a day inside the window, Nov 20, tells `from` and `date` apart.
  const inside = { ...firstDays[0], 'date.d': 20 };
  assert.deepEqual(lineTwins([...firstDays, inside], CANARY_LINE).map((twin) => twin.used), ['from[1]', 'to[1]']);
  // One run of the line shows no change, so it gives no twin.
  assert.deepEqual(lineTwins(firstDays.slice(0, 1), CANARY_LINE), []);
});

test('two paths that end in the same name are a copy, not twins, and a path the line names is never a twin', () => {
  const samples = [{ count: 2, 'opts.count': 2, 't.y': 2026, 'date.y': 2026 }, { count: 3, 'opts.count': 3, 't.y': 2027, 'date.y': 2027 }];
  assert.deepEqual(lineTwins(samples, 'return count + t.y;'), []);
  assert.deepEqual(lineTwins([{ a: 1, b: 1 }, { a: 2, b: 2 }], 'return a + b;'), []);
  assert.deepEqual(lineTwins([{ a: 1, b: 1 }, { a: 2, b: 2 }], 'return a;'), [{ used: 'a', twins: ['b'], values: [1, 2] }]);
  // A path that a run did not have is not compared.
  assert.deepEqual(lineTwins([{ a: 1, b: 1 }, { a: 2 }], 'return a;'), []);
});

test('a twin must be an input of a function around the line, and the name the line reads must not be copied from it', () => {
  const code = `function daysLeft(date) {
  const h = holidayOn(date);
  const from = h.from.split('-').map(Number), to = h.to.split('-').map(Number);
  return to[2] - from[2] + 1;
}
function writeLine(w) {
  const ms = Number(w.inMs), s = Math.ceil(ms / 1000);
  for (const [k, { v }] of Object.entries(w)) use(k, v);
  return s;
}
`;
  const inDays = inputsAndCopies(code, 4);
  assert.deepEqual([...inDays.inputs], ['date']);
  // from is set from h, and h from date: only the straight copy counts, so from[2] and date.d stay twins.
  assert.deepEqual([...inDays.copies.get('from')].sort(), ['Number', 'h']);
  const twin = { used: 'from[2]', twins: ['date.d', 'h.year'], values: [12, 11] };
  assert.deepEqual(keepTwins([twin], inDays), [{ ...twin, twins: ['date.d'] }]);
  // ms is a copy of w.inMs, so the two are equal on purpose.
  const inWrite = inputsAndCopies(code, 7);
  assert.deepEqual([...inWrite.inputs], ['w']);
  assert.deepEqual(keepTwins([{ used: 'ms', twins: ['w.inMs'], values: [900, 5] }], inWrite), []);
  assert.deepEqual([...inWrite.copies.get('k')], ['Object', 'w']);
  assert.deepEqual([...inWrite.copies.get('v')], ['Object', 'w']);
  // A file that does not parse leaves every twin in.
  assert.equal(inputsAndCopies('function (', 1), null);
  assert.deepEqual(keepTwins([twin], null), [twin]);
});

test('twinValues joins the runs of each changed line across test files, and leaves out other lines', () => {
  const recorded = [
    [{ url: '/r/src/days.js', line: 5, samples: [firstDays[0]] }, { url: '/r/src/days.js', line: 9, samples: firstDays }],
    [{ url: 'file:///r/src/days.js', line: 5, samples: [firstDays[1]] }]
  ];
  const texts = new Map([['src/days.js', ['function daysLeft(date) {', '', '', '', CANARY_LINE, '', '', '', CANARY_LINE, '}']]]);
  const found = twinValues(recorded, [{ path: 'src/days.js', lines: [[4, 6]] }], texts, (url) => url.replace(/^(file:\/\/)?\/r\//, ''));
  assert.deepEqual(found.map(({ file, line, used }) => `${file}:${line} ${used}`), ['src/days.js:5 from[1]', 'src/days.js:5 from[2]', 'src/days.js:5 to[1]']);
  assert.equal(found[0].line_text, CANARY_LINE.trim());
});

test('twin values make a met requirement missing, and a requirement with a gap keeps it, with both named', () => {
  const twins = [{ file: 'office/holidays.js', line: 82, line_text: CANARY_LINE.trim(), used: 'from[2]', twins: ['date.d'], values: [12, 11] }];
  const met = { status: 'met', details: { n: 9, killed: 9, timeout: 0, catch_rate: 1, interval_95: [0.66, 1] } };
  assert.equal(withTwinValues(met, []), met);
  const missing = withTwinValues(met, twins);
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.details.twin_values, twins);
  assert.match(missing.how_to_fix, /office\/holidays\.js:82 `from\[2\]` was always equal to `date\.d`/);
  const failed = withTwinValues({ status: 'failed', details: met.details, how_to_fix: 'Kill the survivors.' }, twins);
  assert.equal(failed.status, 'failed');
  assert.match(failed.how_to_fix, /^Kill the survivors\. Each time the tests ran/);
  const summary = describeMutation(missing.details);
  assert.match(summary, /Twin values/);
  assert.match(summary, /office\/holidays\.js:82 `from\[2\]` and `date\.d` \(values 12, 11\): `return dayNum/);
});
