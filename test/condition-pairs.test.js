import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChange } from '../src/classify.js';
import { addRecorder, conditionPairsCollector, describeCase, describeConditionPairs, readSeen, runTestFileProcess, untried } from '../src/condition-pairs.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { parsePolicy } from '../src/policy.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();
const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));

// Runs code that addRecorder gave back, with a recorder that writes nothing, and gives back what
// the module exports. Each call gets its own globalThis recorder, so the test sees what it saw.
async function load(text) {
  delete globalThis.__exhibitPairs;
  const module = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  return { module, recorder: globalThis.__exhibitPairs };
}

// Canary 4 of Building58, made small. The fix puts a target that is not in the list last. It is
// off by one: "before" such a target gives the place before the last.
const OLD_CODE = `export function place(list, target, after) {
  const i = list.indexOf(target);
  return i + (after ? 1 : 0);
}
`;
const ONE_WAY_FIX = `export function place(list, target, after) {
  const i = list.indexOf(target);
  // A target that is not in the list puts it last.
  return (i < 0 ? list.length - 1 : i) + (after ? 1 : 0);
}
`;
const RIGHT_FIX = `export function place(list, target, after) {
  const i = list.indexOf(target);
  // A target that is not in the list puts it last.
  return i < 0 ? list.length : i + (after ? 1 : 0);
}
`;
const OLD_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { place } from '../src/place.js';

test('before and after a target in the list', () => {
  assert.equal(place(['a', 'b'], 'a', false), 0);
  assert.equal(place(['a', 'b'], 'a', true), 1);
});
`;
// The canary's new test: it tries only "after".
const AFTER_ONLY_TEST = `${OLD_TEST}
test('after a target that is not in the list goes last', () => {
  assert.equal(place(['a', 'b'], 'x', true), 2);
});
`;
const BOTH_WAYS_TEST = `${AFTER_ONLY_TEST}
test('before a target that is not in the list goes last', () => {
  assert.equal(place(['a', 'b'], 'x', false), 2);
});
`;

test('addRecorder wraps only the conditions that start on a changed line inside a function, and keeps every line number', () => {
  const { text, conditions } = addRecorder(ONE_WAY_FIX, 'src/place.js', [[3, 4]]);
  assert.deepEqual(conditions, [
    { id: 'src/place.js#1', file: 'src/place.js', line: 4, column: 11, code: 'i < 0', at: ONE_WAY_FIX.indexOf('i < 0'), statement: [ONE_WAY_FIX.indexOf('return ('), ONE_WAY_FIX.indexOf('0);') + 3] },
    { id: 'src/place.js#2', file: 'src/place.js', line: 4, column: 43, code: 'after', at: ONE_WAY_FIX.indexOf('after ?'), statement: [ONE_WAY_FIX.indexOf('return ('), ONE_WAY_FIX.indexOf('0);') + 3] }
  ]);
  assert.equal(text.split('\n').length, ONE_WAY_FIX.split('\n').length);
  assert.equal(text.split('\n')[2], ONE_WAY_FIX.split('\n')[2]);
  assert.match(text.split('\n')[3], /__exhibitPairs\.d\(__exhibitFrame, "src\/place\.js#1", \(i < 0\)\)/);

  const untouched = addRecorder(ONE_WAY_FIX, 'src/place.js', [[2, 2]]);
  assert.deepEqual(untouched, { text: ONE_WAY_FIX, conditions: [] });
});

test('the recorded code gives the same results, and records each condition and each pair in one call', async () => {
  const { text } = addRecorder(ONE_WAY_FIX, 'src/place.js', [[1, 5]]);
  const { module, recorder } = await load(text);
  assert.equal(module.place(['a', 'b'], 'a', false), 0);
  assert.equal(module.place(['a', 'b'], 'x', true), 2);
  assert.equal(typeof recorder.d, 'function');
});

test('addRecorder splits && and ||, handles an arrow with an expression body in parentheses, and keeps the directive and the #! line first', async () => {
  const code = `#!/usr/bin/env node
'use strict';
const pick = (a, b) => (a && b ? { both: true } : { both: false });
const top = 1 > 0 ? 'yes' : 'no';
function loop(n) {
  let count = 0;
  for (let i = 0; i < n || count < 0; i += 1) if ((i % 2 === 0)) count += 1;
  return count;
}
module.exports = { pick, top, loop };
`;
  const { text, conditions } = addRecorder(code, 'src/pick.js', [[1, 10]]);
  assert.deepEqual(conditions.map((condition) => [condition.line, condition.code]), [[3, 'a'], [3, 'b'], [7, 'i < n'], [7, 'count < 0'], [7, 'i % 2 === 0']]);
  const lines = text.split('\n');
  assert.equal(lines.length, code.split('\n').length);
  assert.equal(lines[0], '#!/usr/bin/env node');
  assert.ok(lines[1].startsWith("'use strict';var __exhibitPairs"), lines[1]);
  const run = new Function('module', 'require', lines.slice(1).join('\n'));
  const module = {};
  delete globalThis.__exhibitPairs;
  run(module, () => ({}));
  assert.deepEqual(module.exports.pick(1, 1), { both: true });
  assert.deepEqual(module.exports.pick(1, 0), { both: false });
  assert.equal(module.exports.top, 'yes');
  assert.equal(module.exports.loop(5), 3);
});

test('addRecorder leaves out a condition in a default value of a parameter, which runs before the body', () => {
  const code = 'export function f(a = globalThis.x ? 1 : 2) {\n  return a > 1 ? a : 0;\n}\n';
  const { conditions } = addRecorder(code, 'src/f.js', [[1, 3]]);
  assert.deepEqual(conditions.map((condition) => condition.code), ['a > 1']);
});

test('addRecorder throws on code that does not parse', () => {
  assert.throws(() => addRecorder('function (', 'src/bad.js', [[1, 1]]));
});

test('untried names a pair that went one way, but not a pair of two statements, a repeated condition, or a condition that went one way in every test', () => {
  // Line 3: `(i < 0 ? a : b) + (after ? 1 : 0);`, one statement from 0 to 40. Line 4: `if (ready) ...`,
  // its own statement. Line 5: `v && v.posted ? 1 : 0; v && v.posted ? 2 : 0;`, one statement.
  const at = (n, line, code, start, statement) => ({ id: `a.js#${n}`, file: 'a.js', line, column: 1, code, at: start, statement });
  const conditions = [at(1, 3, 'i < 0', 1, [0, 40]), at(2, 3, 'after', 20, [0, 40]), at(3, 4, 'ready', 45, [41, 60]),
    at(4, 5, 'v', 61, [61, 120]), at(5, 5, 'v', 90, [61, 120]), at(6, 5, 'never', 100, [61, 120])];
  const both = (n) => [`a.js#${n}=true`, `a.js#${n}=false`];
  const seen = new Set([...both(1), ...both(2), ...both(3), ...both(4), ...both(5), 'a.js#6=true',
    'a.js#1=false>a.js#2=true', 'a.js#1=false>a.js#2=false', 'a.js#1=true>a.js#2=true',
    'a.js#1=true>a.js#3=true', 'a.js#4=true>a.js#5=true', 'a.js#4=true>a.js#6=true']);
  const cases = untried(conditions, seen);
  assert.deepEqual(cases.map((item) => [item.condition.code, item.value, item.first.code, item.first_value]), [['after', true, 'i < 0', true]]);

  // `if (missing || found) log(missing ? 'a' : 'b');`: the second `missing` repeats the first, so
  // it is always false when `found` ran, and that is no case to try.
  const repeat = [at(1, 1, 'missing', 4, [0, 50]), at(2, 1, 'found', 15, [0, 50]), at(3, 1, 'missing', 30, [26, 48])];
  const repeatSeen = new Set([...both(1), ...both(2), ...both(3), 'a.js#1=false>a.js#2=true', 'a.js#1=false>a.js#2=false', 'a.js#2=true>a.js#3=false', 'a.js#1=true>a.js#3=true', 'a.js#1=false>a.js#3=false']);
  assert.deepEqual(untried(repeat, repeatSeen), []);
  assert.equal(describeCase(cases[0]), 'a.js:3 `after` is always true when `i < 0` is true. No test tries `after` false with `i < 0` true.');
  assert.equal(describeCase({ ...cases[0], first: { ...cases[0].first, line: 2 } }), 'a.js:3 `after` is always true when `i < 0` (line 2) is true. No test tries `after` false with `i < 0` true.');
});

test('a pair from the turn before in a loop does not count: the if in a do-while body runs before the test', async () => {
  const code = `export function run(n) {
  let k = 0, even = 0;
  do { if (k % 2 === 0) even += 1; k = k * 2 + 1; } while (k < n);
  return even;
}
`;
  const { text, conditions } = addRecorder(code, 'src/run.js', [[3, 3]]);
  assert.deepEqual(conditions.map((condition) => condition.code), ['k % 2 === 0', 'k < n']);
  const out = join(mkdtempSync(join(tmpdir(), 'exhibit-pairs-loop-')), 'seen.jsonl');
  const file = join(dirname(out), 'run.mjs');
  writeFileSync(file, `${text}\nrun(5);\n`);
  execFileSync(process.execPath, [file], { env: { PATH: process.env.PATH, EXHIBIT_PAIRS_OUT: out } });
  const seen = readSeen(readFileSync(out, 'utf8'));
  // k goes 0, 1, 3, 7: the if is true only on the first turn, before the loop test ran. So after
  // `k < n` was true, the if was always false on the next turn. That pair mixes two turns, and it
  // is not a case to try.
  assert.ok(seen.has('src/run.js#2=true>src/run.js#1=false') && !seen.has('src/run.js#2=true>src/run.js#1=true'), JSON.stringify([...seen]));
  assert.deepEqual(untried(conditions, seen), []);
  rmSync(dirname(out), { recursive: true, force: true });
});

test('the summary line names the test files that failed twice, also when no case is left untried', () => {
  const failed = [{ test: 'test/a.test.js', log: '.exhibit/condition-pairs/test-1-again.log' }];
  const conditions = [{ id: 'a', file: 'a.js', line: 1, column: 1, code: 'x' }];
  assert.equal(describeConditionPairs({ conditions, untried: [], failed, reason: 'A test file failed twice.' }), ' These test files failed twice, so a case may not be recorded: test/a.test.js.');
  assert.equal(describeConditionPairs({ conditions, untried: [] }), ' No pair of the 1 changed conditions leaves a case that no test tries.');
});

test('readSeen joins the lines of many processes', () => {
  assert.deepEqual([...readSeen('["a=true"]\n\n["a=false","a=true>b=true"]\n')], ['a=true', 'a=false', 'a=true>b=true']);
});

test('the policy takes condition-pairs bare or with when, and refuses another field or kind of change', () => {
  const policy = (item) => `version: 3\ndefault:\n  risk: low\n  needs:\n    - ${item}\n`;
  assert.deepEqual(parsePolicy(policy('condition-pairs')).default.needs, ['condition-pairs']);
  assert.deepEqual(parsePolicy(policy('condition-pairs: { when: [fix] }')).default.needs, [{ 'condition-pairs': { when: ['fix'] } }]);
  assert.throws(() => parsePolicy(policy('condition-pairs: { min: 1 }')), /condition-pairs/);
  assert.throws(() => parsePolicy(policy('condition-pairs: { when: [bug] }')), /when/);
  assert.throws(() => parsePolicy(policy('conditions-pairs')), /The types are tests-before-after, failing-before, mutation, condition-pairs and probe/);
});

test('condition-pairs with when is not needed on a change that is not of that kind', () => {
  const policy = parsePolicy('version: 3\ndefault:\n  risk: low\n  needs:\n    - condition-pairs: { when: [fix] }\n');
  const notFix = classifyChange(policy, ['src/place.js'], { title: 'Add place', labels: [], branch: 'feature/place' });
  assert.match(notFix.requirements[0].not_needed, /only on a fix/);
  const fix = classifyChange(policy, ['src/place.js'], { title: 'Fix place', labels: [], branch: 'fix/place' });
  assert.equal(fix.requirements[0].not_needed, undefined);
});

// A repo with the old code and its test on main (tag start), and one branch for each head.
function buildRepo(t, { heads, policyText = POLICY, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-pairs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  let tick = 0;
  const git = (...args) => {
    const date = `2026-01-05T09:${String(tick).padStart(2, '0')}:00Z`;
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv(home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) });
  };
  const commit = (changes, message) => {
    for (const [path, text] of Object.entries(changes)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    tick += 1;
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit({ 'evidence.yml': policyText, 'package.json': '{ "type": "module", "private": true }\n', 'src/place.js': OLD_CODE, 'test/place.test.js': OLD_TEST, ...files }, 'start');
  git('tag', 'start');
  for (const [name, changes] of Object.entries(heads)) {
    git('checkout', '-q', '-b', name, 'start');
    commit(changes, name);
  }
  git('checkout', '-q', 'main');
  return { repo, home, git };
}

const POLICY = `version: 3
settings:
  mutation_test_files: ["test/*.test.js"]
  fix_signals: [branch:fix/]
default:
  risk: medium
  needs:
    - condition-pairs: { when: [fix] }
`;

const exhibitCheck = ({ repo, home }, head) => spawnSync(process.execPath, [bin, 'check', '--base', 'start', '--head', head], { cwd: repo, encoding: 'utf8', env: gitEnv(home) });
const read = (repo, file) => readFileSync(join(repo, '.exhibit', file), 'utf8');

test('canary 4 made small: a fix whose test tries only "after" needs a person, and the gap names the case no test tries', async (t) => {
  const fixture = buildRepo(t, {
    heads: {
      'fix/one-way': { 'src/place.js': ONE_WAY_FIX, 'test/place.test.js': AFTER_ONLY_TEST },
      'fix/right': { 'src/place.js': RIGHT_FIX, 'test/place.test.js': BOTH_WAYS_TEST },
      'feature/one-way': { 'src/place.js': ONE_WAY_FIX, 'test/place.test.js': AFTER_ONLY_TEST }
    }
  });

  const oneWay = exhibitCheck(fixture, 'fix/one-way');
  assert.equal(oneWay.status, 1, oneWay.stderr + oneWay.stdout);
  const evidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(evidence), []);
  const item = evidence.requirements[0];
  assert.equal(item.type, 'condition-pairs');
  assert.equal(item.status, 'missing');
  assert.deepEqual(item.details.test_files, ['test/place.test.js']);
  assert.equal(item.details.test_selection, 'reach');
  assert.deepEqual(item.details.untried, [
    { file: 'src/place.js', line: 4, column: 43, code: 'after', value: true, under: { file: 'src/place.js', line: 4, column: 11, code: 'i < 0', value: true } }
  ]);
  assert.match(evidence.gaps[0].how_to_fix, /No test tries `after` false with `i < 0` true\./);
  const summary = read(fixture.repo, 'summary.md');
  assert.match(summary, /- condition-pairs \(from default\): missing\. 1 case of the 2 changed conditions that no test tries\./);
  assert.match(read(fixture.repo, 'condition-pairs/seen.jsonl'), /src\/place\.js#1=true>src\/place\.js#2=true/);

  const right = exhibitCheck(fixture, 'fix/right');
  assert.equal(right.status, 0, right.stderr + right.stdout);
  const met = JSON.parse(read(fixture.repo, 'evidence.json')).requirements[0];
  assert.equal(met.status, 'met');
  assert.deepEqual(met.details.untried, []);
  assert.match(read(fixture.repo, 'summary.md'), /No pair of the 2 changed conditions leaves a case that no test tries\./);

  const feature = exhibitCheck(fixture, 'feature/one-way');
  assert.equal(feature.status, 0, feature.stderr + feature.stdout);
  assert.equal(JSON.parse(read(fixture.repo, 'evidence.json')).requirements[0].status, 'skipped');
});

// Runs the collector on `head` of a repo, with a fake test runner when given.
async function collect(fixture, head, { settings = { mutation_test_files: ['test/*.test.js'] }, runTestFile } = {}) {
  const collector = runTestFile ? conditionPairsCollector({ runTestFile }) : conditionPairsCollector();
  return collector({ type: 'condition-pairs', params: {} }, { cwd: fixture.repo, base: 'start', head, settings, env: gitEnv(fixture.home) });
}

test('a test file that fails once is flaky, and one that fails twice makes the requirement missing', async (t) => {
  const fixture = buildRepo(t, { heads: { 'fix/one-way': { 'src/place.js': ONE_WAY_FIX, 'test/place.test.js': AFTER_ONLY_TEST } } });
  let calls = 0;
  // The first run fails without running the tests. The second runs them for real.
  const once = await collect(fixture, 'fix/one-way', { runTestFile: async (options) => ((calls += 1) === 1 ? { passed: false, why: 'exited with code 1' } : runTestFileProcess(options)) });
  assert.equal(once.status, 'missing');
  assert.deepEqual(once.flaky_tests, ['test/place.test.js']);
  assert.equal(calls, 2);

  const twice = await collect(fixture, 'fix/one-way', { runTestFile: async () => ({ passed: false, why: 'exited with code 1' }) });
  assert.equal(twice.status, 'missing');
  assert.deepEqual(twice.details.failed, [{ test: 'test/place.test.js', log: '.exhibit/condition-pairs/test-1-again.log' }]);
  assert.match(twice.how_to_fix, /test\/place\.test\.js \(exited with code 1, \.exhibit\/condition-pairs\/test-1-again\.log\)/);
});

test('code that the recorder cannot go in is skipped, no test globs is missing, and no changed code is met', async (t) => {
  const fixture = buildRepo(t, {
    heads: {
      'fix/ts': { 'src/place.ts': 'export const a = 1;\n', 'src/place.js': ONE_WAY_FIX },
      'fix/docs': { 'README.md': 'more\n' },
      'fix/no-condition': { 'src/place.js': OLD_CODE.replace('list.indexOf(target)', 'list.indexOf(target) + 0') }
    }
  });
  const ts = await collect(fixture, 'fix/ts');
  assert.equal(ts.status, 'skipped');
  assert.deepEqual(ts.details.other_code, ['src/place.ts']);

  const docs = await collect(fixture, 'fix/docs');
  assert.equal(docs.status, 'met');
  assert.match(docs.details.reason, /no added or changed lines of JavaScript/);

  const noCondition = await collect(fixture, 'fix/no-condition');
  assert.equal(noCondition.status, 'met');
  assert.match(noCondition.details.reason, /No condition starts on a changed line/);
});

test('changed JavaScript with no settings.mutation_test_files is missing', async (t) => {
  const fixture = buildRepo(t, { heads: { 'fix/one-way': { 'src/place.js': ONE_WAY_FIX } } });
  const result = await collect(fixture, 'fix/one-way', { settings: {} });
  assert.equal(result.status, 'missing');
  assert.match(result.how_to_fix, /settings\.mutation_test_files/);
});
