import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExhibit, renderSummary } from '../src/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { shuffleBySeed } from '../src/mutant-order.js';
import { changedLines, describeMutation, failedInFirstRun, judge, mutationCollector, readOutcome, runStrykerProcess, testsThatReach } from '../src/mutation.js';
import { stringify as stringifyYaml } from 'yaml';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();
const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));

// The bug of Exhibit's PR 252, made small: a path check that took "starts with the root" also let
// "/repos/shopping" through when the root was "/repos/shop". The fix adds the "/" boundary.
const OLD_CODE = `export function inside(root, path) {
  return path.startsWith(root);
}
`;
const NEW_CODE = `export function inside(root, path) {
  return path === root || path.startsWith(root + '/');
}
`;
// A weak test: it passes on the new code, but it checks only one path inside the root.
const WEAK_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inside } from '../src/inside.js';
test('a path in the root is inside', () => {
  assert.equal(inside('/repos/shop', '/repos/shop/a'), true);
});
`;
// A strong test: it checks the root itself, a path inside, and the neighbor that the bug let in.
// It also runs a script of the repo directly, so it needs the script's execute bit in Stryker's
// copy of the repo.
const STRONG_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { inside } from '../src/inside.js';
test('the helper script runs', () => {
  assert.equal(execFileSync(new URL('./helper.js', import.meta.url).pathname, { encoding: 'utf8' }), 'ok');
});
test('the root and a path in it are inside', () => {
  assert.equal(inside('/repos/shop', '/repos/shop'), true);
  assert.equal(inside('/repos/shop', '/repos/shop/a'), true);
});
test('a neighbor that starts with the same letters is not inside', () => {
  assert.equal(inside('/repos/shop', '/repos/shopping'), false);
  assert.equal(inside('/repos/shop', '/repos/other'), false);
});
`;
// A script that a test runs directly, as Building58's tests run their fake gh.
const HELPER = `#!/usr/bin/env node
process.stdout.write('ok');
`;
const FAILING_TEST = WEAK_TEST.replace("'/repos/shop/a'), true", "'/repos/shop/a'), false");
// A test file that takes far longer than any budget in these tests. It writes its process ID to
// the folder PID_DIR, so the test can check that the process is gone after the run.
const SLOW_TEST = `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from '../src/inside.js';
writeFileSync(join(process.env.PID_DIR, String(process.pid)), '');
test('slow', async () => { inside('/a', '/a'); await new Promise((resolve) => setTimeout(resolve, 600000)); });
`;

// A test file that fails the first time it runs and passes after that, as a test does that fails
// now and then under load. It keeps a marker file in the folder FLAKY_DIR, outside the worktree,
// so Stryker's copy of the repo cannot hide it. It imports the changed file, so Exhibit picks it.
const FIRST_RUN_FAILS_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from '../src/inside.js';
test('fails on its first run only', () => {
  const marker = join(process.env.FLAKY_DIR, 'ran');
  const first = !existsSync(marker);
  writeFileSync(marker, '');
  assert.equal(first, false, 'the first run fails by chance');
});
`;

function policy({ min = 0.8, budget = 120, extra = '' } = {}) {
  return `version: 3
settings:
  mutation_test_files: ["test/*.test.js"]
  mutation_budget_seconds: ${budget}
${extra}default:
  risk: medium
  needs:
    - mutation: { min: ${min} }
`;
}

// A repo with the old code on main (tag start), and one branch for each head. Each branch makes
// the fix and adds a test. Dates and names are fixed, so the SHAs are the same each time.
function buildRepo(t, { policyText = policy(), heads }) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-mutation-'));
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
  const commit = (files, message) => {
    for (const [path, file] of Object.entries(files)) {
      const { text, mode = 0o644 } = typeof file === 'string' ? { text: file } : file;
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
      chmodSync(join(repo, path), mode);
      git('add', path);
    }
    tick += 1;
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit({ 'evidence.yml': policyText, 'package.json': '{ "type": "module", "private": true }\n', 'src/inside.js': OLD_CODE, 'src/twice.js': OLD_CODE, 'README.md': 'hi\n' }, 'start');
  git('tag', 'start');
  for (const [name, files] of Object.entries(heads)) {
    git('checkout', '-q', '-b', name, 'start');
    commit(files, name);
  }
  git('checkout', '-q', 'main');
  return { repo, home };
}

const exhibitCheck = ({ repo, home }, head, extra = {}) => spawnSync(process.execPath, [bin, 'check', '--base', 'start', '--head', head], { cwd: repo, encoding: 'utf8', env: gitEnv(home, extra) });
const read = (repo, file) => readFileSync(join(repo, '.exhibit', file), 'utf8');

test('a change with a weak test needs a person, with the surviving mutants listed, and the same change with a strong test meets the policy', async (t) => {
  const fixture = buildRepo(t, {
    heads: {
      weak: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': WEAK_TEST },
      strong: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': STRONG_TEST, 'test/helper.js': { text: HELPER, mode: 0o755 } }
    }
  });

  const weak = exhibitCheck(fixture, 'weak');
  assert.equal(weak.status, 1, weak.stderr + weak.stdout);
  const weakEvidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(weakEvidence), []);
  const item = weakEvidence.requirements[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.details.complete, true);
  assert.deepEqual(item.details.mutated, [{ path: 'src/inside.js', lines: [[2, 2]] }]);
  assert.deepEqual(item.details.test_files, ['test/inside.test.js']);
  assert.ok(item.details.survived > 0);
  assert.ok(item.details.catch_rate < 0.8);
  assert.equal(item.details.survivors.length, item.details.survived);
  // The mutant that brings PR 252's bug back: without the "/" the neighbor gets in again.
  assert.ok(item.details.survivors.some((mutant) => mutant.file === 'src/inside.js' && mutant.line === 2 && mutant.original === "'/'" && mutant.replacement === '""'), JSON.stringify(item.details.survivors));
  assert.match(weakEvidence.gaps[0].how_to_fix, /survived/);
  const summary = read(fixture.repo, 'summary.md');
  assert.match(summary, /mutation \(from default\): failed\. Catch rate /);
  assert.match(summary, /src\/inside\.js:2 StringLiteral: `'\/'` became `""`/);

  const strong = exhibitCheck(fixture, 'strong');
  assert.equal(strong.status, 0, strong.stderr + strong.stdout);
  const strongEvidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.equal(strongEvidence.verdict, 'meets_policy');
  assert.equal(strongEvidence.requirements[0].status, 'met');
  assert.equal(strongEvidence.requirements[0].details.survived, 0);
  assert.equal(strongEvidence.requirements[0].details.n, weakEvidence.requirements[0].details.n);
});

test('mutants marked as equivalent in the base policy drop out of a later run, also when their lines move', async (t) => {
  const first = buildRepo(t, { heads: { weak: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': WEAK_TEST } } });
  const weak = exhibitCheck(first, 'weak');
  assert.equal(weak.status, 1, weak.stderr + weak.stdout);
  const { survivors } = JSON.parse(read(first.repo, 'evidence.json')).requirements[0].details;
  assert.ok(survivors.length > 0);
  assert.ok(survivors.every((mutant) => mutant.line_text === "return path === root || path.startsWith(root + '/');"), JSON.stringify(survivors));

  // A person marks every survivor in the policy on main. The next change puts a comment line
  // above the code, so each mutant is one line lower than when it was marked.
  const marks = survivors.map(({ file, line_text: lineText, mutator, original, replacement }) => ({ file, line_text: lineText, mutator, original, replacement, reason: 'A person judged it.' }));
  const later = buildRepo(t, {
    policyText: `${policy()}${stringifyYaml({ equivalent_mutants: marks })}`,
    heads: { moved: { 'src/inside.js': `// Says if a path is in a folder.\n${NEW_CODE}`, 'test/inside.test.js': WEAK_TEST } }
  });
  const moved = exhibitCheck(later, 'moved');
  assert.equal(moved.status, 0, moved.stderr + moved.stdout);
  const evidence = JSON.parse(read(later.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(evidence), []);
  assert.equal(evidence.verdict, 'meets_policy');
  const { details } = evidence.requirements[0];
  assert.equal(details.survived, 0);
  assert.equal(details.equivalent, survivors.length);
  assert.deepEqual(details.equivalent_mutants.map(({ line, mutator, replacement }) => ({ line, mutator, replacement })), survivors.map(({ line, mutator, replacement }) => ({ line: line + 1, mutator, replacement })));
  assert.match(read(later.repo, 'summary.md'), /Marked as equivalent, so they do not count:\n {4}- src\/inside\.js:3 /);

  // A PR that marks its own survivors: the marks are only on the head, so they are not used, and
  // the change to the policy needs a person.
  const own = buildRepo(t, { heads: { selfmark: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': WEAK_TEST, 'evidence.yml': `${policy()}${stringifyYaml({ equivalent_mutants: marks })}` } } });
  const selfmark = exhibitCheck(own, 'selfmark');
  assert.equal(selfmark.status, 1, selfmark.stderr + selfmark.stdout);
  const ownEvidence = JSON.parse(read(own.repo, 'evidence.json'));
  assert.equal(ownEvidence.requirements[0].status, 'failed');
  assert.equal(ownEvidence.requirements[0].details.equivalent, 0);
  assert.equal(ownEvidence.requirements[0].details.survived, survivors.length);
  assert.deepEqual(ownEvidence.gaps.map((gap) => gap.type), ['mutation', 'policy-change']);
});

test('when Stryker fails, here because a test fails on the head, the verdict is error, never meets_policy', async (t) => {
  // min 0 would pass any catch rate, so only the error can stop meets_policy.
  const fixture = buildRepo(t, { policyText: policy({ min: 0 }), heads: { broken: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': FAILING_TEST } } });
  const run = exhibitCheck(fixture, 'broken');
  assert.equal(run.status, 2, run.stderr + run.stdout);
  const evidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.equal(evidence.verdict, 'error');
  assert.equal(evidence.requirements[0].status, 'error');
  // The test failed in Stryker's coverage run, so Exhibit ran Stryker a second time, and it failed
  // there again.
  // The gap names the test and both logs.
  const { how_to_fix: howToFix } = evidence.gaps[0];
  assert.match(howToFix, /test\/inside\.test\.js/);
  assert.match(howToFix, /a path in the root is inside/);
  assert.match(howToFix, /both times a test failed in Stryker's coverage run/);
  assert.match(howToFix, /\.exhibit\/mutation\/output\.log/);
  assert.match(howToFix, /\.exhibit\/mutation\/output-again\.log/);
  assert.deepEqual(evidence.requirements[0].details.failed_in_first_run.map((failure) => failure.test), ['test/inside.test.js']);
  assert.match(read(fixture.repo, 'mutation/output.log'), /failed/i);
  assert.match(read(fixture.repo, 'mutation/output-again.log'), /failed/i);
});

test('a test that fails only on Stryker\'s first run makes Exhibit run Stryker once more, and the test is flaky', async (t) => {
  const fixture = buildRepo(t, {
    heads: { flaky: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': STRONG_TEST, 'test/helper.js': { text: HELPER, mode: 0o755 }, 'test/flaky.test.js': FIRST_RUN_FAILS_TEST } }
  });
  const marks = join(fixture.home, 'flaky');
  mkdirSync(marks);
  const run = exhibitCheck(fixture, 'flaky', { FLAKY_DIR: marks });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const evidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(evidence), []);
  assert.equal(evidence.verdict, 'meets_policy');
  const item = evidence.requirements[0];
  assert.equal(item.status, 'met');
  assert.equal(item.details.complete, true);
  assert.equal(item.details.survived, 0);
  assert.equal(item.details.output, '.exhibit/mutation/output-again.log');
  assert.equal(item.details.first_output, '.exhibit/mutation/output.log');
  assert.deepEqual(item.details.failed_in_first_run.map((failure) => failure.test), ['test/flaky.test.js']);
  assert.match(item.details.failed_in_first_run[0].message, /fails on its first run only/);
  assert.deepEqual(evidence.flaky_tests, ['test/flaky.test.js']);
  assert.match(read(fixture.repo, 'mutation/output.log'), /One or more tests failed in the initial test run/);
  assert.match(read(fixture.repo, 'summary.md'), /these tests failed in Stryker's coverage run: test\/flaky\.test\.js\. So Exhibit ran Stryker a second time, and these counts come from the second run\. They passed there, so they are flaky\./);
});

test('the budget stops Stryker and every process it started', async (t) => {
  const fixture = buildRepo(t, { policyText: policy({ budget: 15 }), heads: { slow: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': SLOW_TEST } } });
  const pids = join(fixture.home, 'pids');
  mkdirSync(pids);
  const started = Date.now();
  const run = exhibitCheck(fixture, 'slow', { PID_DIR: pids });
  // The budget is 15 seconds, so that Stryker starts the slow test file before it runs out, also
  // when every test file of npm test runs at once. The slow test waits 10 minutes, far past it.
  assert.ok(Date.now() - started < 90000, `the run took ${Date.now() - started} ms`);
  // The slow test file started, and Exhibit stopped it with Stryker.
  const testPids = readdirSync(pids).map(Number);
  assert.ok(testPids.length > 0);
  for (const pid of testPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `the test process ${pid} is still running`);
  assert.equal(run.status, 1, run.stderr + run.stdout);
  const item = JSON.parse(read(fixture.repo, 'evidence.json')).requirements[0];
  assert.equal(item.status, 'missing');
  assert.equal(item.details.complete, false);
  assert.equal(item.details.n, 0);
  assert.match(JSON.parse(read(fixture.repo, 'evidence.json')).gaps[0].how_to_fix, /budget of 15 seconds/);
});

// Two changed files with eight changed lines each. Stryker makes two mutants on each line: one for
// the * and one for the arrow function, so 32 in all.
const eightLines = (name) => Array.from({ length: 8 }, (_, i) => `export const ${name}${i} = (x) => x * ${i + 2};\n`).join('');
// A test file that kills every mutant of both files. Each time it runs, it takes the next number
// in the folder RUN_DIR. Its first run is Stryker's coverage run. After that run and LIMIT more, it
// waits far past the budget, so only the next LIMIT mutants are killed, the same ones each time.
// The mutants whose test file waits can time out near the end of the budget, and count too. With
// the order of the code, the killed ones would all come from src/a.js.
const CUT_SHORT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as a from '../src/a.js';
import * as b from '../src/b.js';
let n = 0;
for (;;) {
  try { mkdirSync(join(process.env.RUN_DIR, String(n))); break; } catch { n += 1; }
}
test('both files', async () => {
  if (n > Number(process.env.LIMIT)) await new Promise((resolve) => setTimeout(resolve, 600000));
  for (let i = 0; i < 8; i += 1) {
    assert.equal(a['a' + i](3), 3 * (i + 2));
    assert.equal(b['b' + i](3), 3 * (i + 2));
  }
});
`;

test('a partial run tests mutants from every changed file, in an order that the seed fixes', async (t) => {
  const fixture = buildRepo(t, { heads: { both: { 'src/a.js': eightLines('a'), 'src/b.js': eightLines('b'), 'test/both.test.js': CUT_SHORT_TEST } } });
  execFileSync('git', ['checkout', '-q', 'both'], { cwd: fixture.repo, env: gitEnv(fixture.home) });
  const sample = async (seed) => {
    const runs = mkdtempSync(join(fixture.home, 'runs-'));
    const outcome = await runStrykerProcess({ root: fixture.repo, mutate: ['src/a.js:1-8', 'src/b.js:1-8'], testFiles: ['test/both.test.js'], budgetSeconds: 20, seed, logFile: join(runs, 'output.log'), env: gitEnv(fixture.home, { RUN_DIR: runs, LIMIT: '6' }) });
    assert.equal(outcome.complete, false, JSON.stringify(outcome));
    // Only the killed mutants are the same each time. The waiting test files time out about when
    // the budget runs out, so the timeouts in the sample depend on the speed of the machine.
    const killed = outcome.mutants.filter((mutant) => mutant.status === 'Killed');
    assert.equal(killed.length, 6, JSON.stringify(outcome.mutants.map((mutant) => mutant.status)));
    return killed.map((mutant) => `${relative(realpathSync(fixture.repo), mutant.fileName)}:${mutant.location.start.line}`).sort();
  };
  const seed = 'f'.repeat(40);
  const first = await sample(seed);
  // The 6 killed mutants come from both files, not only the first.
  assert.deepEqual([...new Set(first.map((place) => place.split(':')[0]))], ['src/a.js', 'src/b.js'], first.join(' '));
  // A second run with the same seed tests the same mutants first.
  assert.deepEqual(await sample(seed), first);
});

test('shuffleBySeed keeps every item, and the seed fixes the order', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const once = shuffleBySeed([...items], 'a'.repeat(40));
  assert.deepEqual([...once].sort((x, y) => x - y), items);
  assert.notDeepEqual(once, items);
  assert.deepEqual(shuffleBySeed([...items], 'a'.repeat(40)), once);
  assert.notDeepEqual(shuffleBySeed([...items], 'b'.repeat(40)), once);
  assert.deepEqual(shuffleBySeed([], 'a'), []);
  // Over many seeds, each of 4 items comes first about a quarter of the time.
  const first = [0, 0, 0, 0];
  for (let seed = 0; seed < 4000; seed += 1) first[shuffleBySeed([0, 1, 2, 3], String(seed))[0]] += 1;
  for (const count of first) assert.ok(count > 900 && count < 1100, first.join(' '));
});

// Mutants as the reporter gives them, for runs that do not start Stryker.
const mutants = (status, count) => Array.from({ length: count }, (_, i) => ({ file: 'src/a.js', line: i + 1, column: 1, mutator: 'BooleanLiteral', original: 'true', replacement: 'false', status }));
const ran = (list, complete) => ({ mutants: list, complete, budgetSeconds: 60, mutated: [], testFiles: [], testSelection: 'reach', output: '.exhibit/mutation/output.log' });

test('after a partial run the lower bound of the interval decides, and after a complete run the catch rate does', () => {
  // 10 of 10 killed: the interval is 0.69 to 1.
  assert.equal(judge(ran(mutants('Killed', 10), true), 0.7).status, 'met');
  const small = judge(ran(mutants('Killed', 10), false), 0.7);
  assert.equal(small.status, 'missing');
  assert.equal(small.details.catch_rate, 1);
  assert.deepEqual(small.details.interval_95, [0.6915, 1]);
  assert.match(small.how_to_fix, /too small to tell/);
  // 30 of 30 killed: the lower bound is 0.88, so a sample of 30 shows a min of 0.7.
  assert.equal(judge(ran(mutants('Killed', 30), false), 0.7).status, 'met');
  // 2 of 10 killed: even the upper bound, 0.56, is below 0.7.
  assert.equal(judge(ran([...mutants('Killed', 2), ...mutants('Survived', 8)], false), 0.7).status, 'failed');
  // A complete run that misses min fails.
  assert.equal(judge(ran([...mutants('Killed', 6), ...mutants('Survived', 4)], true), 0.7).status, 'failed');
});

test('timeouts count as killed, mutants with no coverage as survived and listed apart, and mutants that do not compile do not count', () => {
  const result = judge(ran([...mutants('Killed', 2), ...mutants('Timeout', 1), ...mutants('Survived', 1), ...mutants('NoCoverage', 1), ...mutants('CompileError', 3)], true), 0.5);
  assert.equal(result.status, 'met');
  assert.equal(result.details.n, 5);
  assert.equal(result.details.catch_rate, 0.6);
  assert.equal(result.details.not_valid, 3);
  assert.equal(result.details.survivors.length, 1);
  assert.equal(result.details.no_coverage_mutants.length, 1);
  assert.equal(result.details.timeout_mutants.length, 1);
});

// One mutant on the line "if (a > 0) return a;", and the mark that says it is equivalent.
const onLine = (status, line, lineText = 'if (a > 0) return a;') => ({ file: 'src/a.js', line, column: 5, line_text: lineText, mutator: 'EqualityOperator', original: 'a > 0', replacement: 'a >= 0', status });
const MARK = { file: 'src/a.js', line_text: 'if (a > 0) return a;', mutator: 'EqualityOperator', original: 'a > 0', replacement: 'a >= 0', reason: 'a is never 0 here.' };

test('a marked mutant that survived, or that no test reached, does not count, and is listed apart with the reason', () => {
  const list = [...mutants('Killed', 3), onLine('Survived', 7), onLine('NoCoverage', 12), ...mutants('Survived', 1)];
  const unmarked = judge(ran(list, true), 0.7);
  assert.equal(unmarked.status, 'failed');
  assert.equal(unmarked.details.n, 6);

  const result = judge(ran(list, true), 0.7, [MARK]);
  assert.equal(result.status, 'met');
  assert.equal(result.details.n, 4);
  assert.equal(result.details.survived, 1);
  assert.equal(result.details.no_coverage, 0);
  assert.equal(result.details.equivalent, 2);
  assert.equal(result.details.catch_rate, 0.75);
  assert.deepEqual(result.details.survivors.map((mutant) => mutant.line), [1]);
  assert.deepEqual(result.details.no_coverage_mutants, []);
  // The key has no line number, so the mark holds on line 7 and on line 12.
  assert.deepEqual(result.details.equivalent_mutants, [
    { file: 'src/a.js', line: 7, column: 5, line_text: 'if (a > 0) return a;', mutator: 'EqualityOperator', original: 'a > 0', replacement: 'a >= 0', status: 'Survived', reason: 'a is never 0 here.' },
    { file: 'src/a.js', line: 12, column: 5, line_text: 'if (a > 0) return a;', mutator: 'EqualityOperator', original: 'a > 0', replacement: 'a >= 0', status: 'NoCoverage', reason: 'a is never 0 here.' }
  ]);
});

test('a mark holds only for the same file, line text, mutator, code and replacement, and never for a killed mutant', () => {
  const others = [
    { ...onLine('Survived', 1), file: 'src/b.js' },
    onLine('Survived', 2, 'if (a > 0) return b;'),
    { ...onLine('Survived', 3), mutator: 'ConditionalExpression' },
    { ...onLine('Survived', 4), original: 'a' },
    { ...onLine('Survived', 5), replacement: 'a < 0' }
  ];
  const result = judge(ran([...others, onLine('Killed', 6), onLine('Timeout', 7)], true), 0.5, [MARK]);
  assert.equal(result.details.equivalent, 0);
  assert.deepEqual(result.details.equivalent_mutants, []);
  assert.equal(result.details.survived, 5);
  assert.equal(result.details.killed, 1);
  assert.equal(result.details.timeout, 1);
  assert.equal(result.details.n, 7);
});

test('when every mutant that would count is marked, the requirement is met and says why', () => {
  const result = judge(ran([onLine('Survived', 7)], true), 0.9, [MARK]);
  assert.equal(result.status, 'met');
  assert.equal(result.details.n, 0);
  assert.match(result.details.reason, /each one that survived is marked as equivalent/);
});

test('summary.md lists the marked mutants apart, with the reason', () => {
  const result = judge(ran([...mutants('Killed', 3), onLine('Survived', 7)], true), 0.7, [MARK]);
  const words = describeMutation(result.details);
  assert.match(words, /1 mutant marked as equivalent in the policy does not count\./);
  assert.match(words, / {2}- Marked as equivalent, so they do not count:\n {4}- src\/a\.js:7 EqualityOperator: `a > 0` became `a >= 0`\. Why: a is never 0 here\./);
  assert.doesNotMatch(describeMutation(judge(ran(mutants('Killed', 3), true), 0.7).details), /equivalent/);
});

// A repo for the collector with a stand-in for Stryker. Gives the context buildExhibit makes.
function collectorRepo(t, headFiles, settings = { mutation_test_files: ['test/*.test.js'] }) {
  const fixture = buildRepo(t, { heads: { change: headFiles } });
  const sha = (ref) => execFileSync('git', ['rev-parse', ref], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) }).trim();
  return { cwd: fixture.repo, base: sha('start'), head: sha('change'), settings, env: gitEnv(fixture.home) };
}

test('a partial run that the budget stopped is judged on its sample', async (t) => {
  const context = collectorRepo(t, { 'src/inside.js': NEW_CODE, 'test/inside.test.js': WEAK_TEST });
  let asked;
  const runStryker = async (options) => {
    asked = options;
    return { mutants: Array.from({ length: 30 }, () => ({ fileName: join(options.root, 'src/inside.js'), location: { start: { line: 2, column: 10 }, end: { line: 2, column: 22 } }, mutatorName: 'EqualityOperator', replacement: 'path !== root', status: 'Killed' })), complete: false, timedOut: true };
  };
  const result = await mutationCollector({ runStryker })({ params: { min: 0.8 } }, context);
  assert.deepEqual(asked.mutate, ['src/inside.js:2-2']);
  assert.deepEqual(asked.testFiles, ['test/inside.test.js']);
  // The policy sets no budget, so it is the default.
  assert.equal(asked.budgetSeconds, 600);
  // The head SHA fixes the random order of the mutants.
  assert.equal(asked.seed, context.head);
  // The head SHA fixes the order of the mutants.
  assert.equal(asked.seed, context.head);
  assert.equal(result.status, 'met');
  assert.equal(result.details.complete, false);
  assert.equal(result.details.n, 30);
});

test('a Stryker run that crashes, or exits before it is done, gives error through exhibit check', async (t) => {
  const context = collectorRepo(t, { 'src/inside.js': NEW_CODE, 'test/inside.test.js': WEAK_TEST });
  const crash = mutationCollector({ runStryker: async () => { throw new Error('Stryker crashed'); } });
  const stopped = mutationCollector({ runStryker: async () => ({ mutants: mutants('Killed', 3).map(() => ({})), complete: false, timedOut: false, code: 1, signal: null }) });
  for (const collector of [crash, stopped]) {
    const exhibit = await buildExhibit({
      policy: { settings: { ...context.settings, fix_signals: [] }, kinds: {}, default: { risk: 'medium', needs: [{ mutation: { min: 0 } }] } },
      policyFile: { path: 'evidence.yml', sha256: null },
      files: ['src/inside.js'],
      pr: { title: '', labels: [], branch: '' },
      signalsFrom: 'branch',
      repo: null,
      prNumber: null,
      base: context.base,
      head: context.head,
      cwd: context.cwd,
      env: context.env
    }, { collectors: { mutation: collector } });
    assert.equal(exhibit.verdict, 'error');
    assert.equal(exhibit.requirements[0].status, 'error');
    assert.deepEqual(checkExhibit(exhibit), []);
    assert.match(renderSummary(exhibit), /Exhibit failed/);
  }
});

test('Exhibit runs Stryker once more only when its first run failed a test', async (t) => {
  const context = collectorRepo(t, { 'src/inside.js': NEW_CODE, 'test/inside.test.js': WEAK_TEST });
  const killed = (options) => Array.from({ length: 3 }, () => ({ fileName: join(options.root, 'src/inside.js'), location: { start: { line: 2, column: 10 }, end: { line: 2, column: 22 } }, mutatorName: 'EqualityOperator', replacement: 'path !== root', status: 'Killed' }));
  const failure = { test: 'test/inside.test.js', message: 'a path in the root is inside' };
  const stand = (outcomes) => {
    const logs = [];
    const runStryker = async (options) => {
      logs.push(options.logFile.slice(context.cwd.length + 1));
      const outcome = outcomes[logs.length - 1];
      return { ...outcome, mutants: outcome.mutants ?? (outcome.complete ? killed(options) : []) };
    };
    return { logs, runStryker };
  };
  const failedFirstRun = { complete: false, timedOut: false, code: 1, signal: null, failedInFirstRun: [failure] };
  const done = { complete: true, timedOut: false, code: 0, signal: null, failedInFirstRun: [] };

  // The first run fails a test and the second passes: the test is flaky, and the second run counts.
  const flaky = stand([failedFirstRun, done]);
  const met = await mutationCollector({ runStryker: flaky.runStryker })({ params: { min: 0.8 } }, context);
  assert.deepEqual(flaky.logs, ['.exhibit/mutation/output.log', '.exhibit/mutation/output-again.log']);
  assert.equal(met.status, 'met');
  assert.deepEqual(met.flaky_tests, ['test/inside.test.js']);
  assert.deepEqual(met.details.failed_in_first_run, [failure]);

  // Both runs fail a test: error, and the gap names the test.
  const broken = stand([failedFirstRun, failedFirstRun]);
  const error = await mutationCollector({ runStryker: broken.runStryker })({ params: { min: 0.8 } }, context);
  assert.equal(broken.logs.length, 2);
  assert.equal(error.status, 'error');
  assert.match(error.how_to_fix, /test\/inside\.test\.js \(a path in the root is inside\)/);
  assert.equal(error.flaky_tests, undefined);

  // The second run is complete but made no mutant: its coverage run passed, so the test is flaky.
  const noMutants = stand([failedFirstRun, { ...done, mutants: [] }]);
  const empty = await mutationCollector({ runStryker: noMutants.runStryker })({ params: { min: 0.8 } }, context);
  assert.equal(noMutants.logs.length, 2);
  assert.equal(empty.status, 'met');
  assert.equal(empty.details.n, 0);
  assert.deepEqual(empty.flaky_tests, ['test/inside.test.js']);

  // The first run fails a test, and the second stops for another reason, such as a crash.
  const crashedAgain = stand([failedFirstRun, { complete: false, timedOut: false, code: 1, signal: null, failedInFirstRun: [] }]);
  const other = await mutationCollector({ runStryker: crashedAgain.runStryker })({ params: { min: 0.8 } }, context);
  assert.equal(crashedAgain.logs.length, 2);
  assert.equal(other.status, 'error');
  assert.match(other.how_to_fix, /test\/inside\.test\.js \(a path in the root is inside\)/);
  assert.match(other.how_to_fix, /exited with code 1 again, for another reason/);
  assert.equal(other.flaky_tests, undefined);

  // The budget stops the second run in its coverage run: no mutant is tested, so the test never
  // passed, and it is not flaky.
  const stoppedInCoverage = stand([failedFirstRun, { complete: false, timedOut: true, code: null, signal: 'SIGKILL', failedInFirstRun: [] }]);
  const sampleless = await mutationCollector({ runStryker: stoppedInCoverage.runStryker })({ params: { min: 0.8 } }, context);
  assert.equal(sampleless.status, 'missing');
  assert.equal(sampleless.flaky_tests, undefined);
  assert.deepEqual(sampleless.details.failed_in_first_run, [failure]);
  assert.doesNotMatch(describeMutation(sampleless.details), /flaky/);
  assert.match(describeMutation(sampleless.details), /these counts come from the second run\.$/m);

  // Stryker stops for another reason, such as a broken setup: no second run.
  const crashed = stand([{ complete: false, timedOut: false, code: 1, signal: null, failedInFirstRun: [] }]);
  const once = await mutationCollector({ runStryker: crashed.runStryker })({ params: { min: 0.8 } }, context);
  assert.equal(crashed.logs.length, 1);
  assert.equal(once.status, 'error');
  assert.doesNotMatch(once.how_to_fix, /both times/);
});

test('failedInFirstRun reads the failed test files from Stryker\'s log', () => {
  const log = [
    '12:00:01 (123) INFO DryRunExecutor Starting initial test run (tap test runner with "perTest" coverage analysis). This may take a while.',
    '12:00:09 (123) ERROR DryRunExecutor One or more tests failed in the initial test run:',
    '\ttest/review-desk.test.js',
    '\t\treviews wait: no session may be stopped, reviews wait: other',
    '\ttest/b.test.js',
    '\t\tb fails',
    '12:00:09 (123) ERROR Stryker There were failed tests in the initial test run.'
  ].join('\n');
  assert.deepEqual(failedInFirstRun(log), [
    { test: 'test/review-desk.test.js', message: 'reviews wait: no session may be stopped, reviews wait: other' },
    { test: 'test/b.test.js', message: 'b fails' }
  ]);
  assert.deepEqual(failedInFirstRun('12:00:09 (123) ERROR Stryker Could not load the test runner.\n'), []);
});

test('the collector does not run Stryker when nothing can be mutated, or the policy cannot say how', async (t) => {
  const never = mutationCollector({ runStryker: async () => assert.fail('Stryker should not run') });
  const docs = collectorRepo(t, { 'README.md': 'more\n', 'test/inside.test.js': WEAK_TEST });
  const met = await never({ params: { min: 0.9 } }, docs);
  assert.equal(met.status, 'met');
  assert.match(met.details.reason, /nothing to mutate/);

  const go = collectorRepo(t, { 'tool/run.go': 'package main\n', 'src/inside.js': NEW_CODE });
  const skipped = await never({ params: { min: 0.9 } }, go);
  assert.equal(skipped.status, 'skipped');
  assert.deepEqual(skipped.details.no_adapter, ['tool/run.go']);

  const noGlobs = collectorRepo(t, { 'src/inside.js': NEW_CODE }, {});
  const missing = await never({ params: { min: 0.9 } }, noGlobs);
  assert.equal(missing.status, 'missing');
  assert.match(missing.how_to_fix, /mutation_test_files/);
});

test('Stryker gets only the matched test files that it can run, so a Python file in mutation_test_files does not reach it', async (t) => {
  // No test imports src/twice.js, so Stryker gets every matched test file. py/conftest.py matches
  // the globs, as the mutmut adapter's left-out gap advises, but node cannot run it.
  const context = collectorRepo(t, { 'src/twice.js': NEW_CODE, 'test/inside.test.js': WEAK_TEST, 'py/conftest.py': 'import os\n' }, { mutation_test_files: ['test/*.test.js', 'py/conftest.py'] });
  let asked;
  const runStryker = async (options) => {
    asked = options;
    return { mutants: [], complete: true, timedOut: false, code: 0 };
  };
  const result = await mutationCollector({ runStryker })({ params: { min: 0.5 } }, context);
  assert.deepEqual(asked.testFiles, ['test/inside.test.js']);
  assert.deepEqual(result.details.test_files, ['test/inside.test.js']);
});

test('when the globs match only Python files, the gap says that Stryker needs JavaScript or TypeScript test files', async (t) => {
  const context = collectorRepo(t, { 'src/twice.js': NEW_CODE, 'py/tests/test_a.py': 'def test_a():\n    pass\n' }, { mutation_test_files: ['py/tests/*.py'] });
  const result = await mutationCollector({ runStryker: async () => assert.fail('Stryker should not run') })({ params: { min: 0.5 } }, context);
  assert.equal(result.status, 'missing');
  assert.match(result.details.reason, /No JavaScript or TypeScript file in the head matches settings\.mutation_test_files/);
  assert.match(result.how_to_fix, /Stryker needs JavaScript or TypeScript test files/);
});

test('a failing mutation_setup gives error and its log', async (t) => {
  const context = collectorRepo(t, { 'src/inside.js': NEW_CODE }, { mutation_test_files: ['test/*.test.js'], mutation_setup: 'echo no network; exit 3' });
  const result = await mutationCollector({ runStryker: async () => assert.fail('Stryker should not run') })({ params: { min: 0.5 } }, context);
  assert.equal(result.status, 'error');
  assert.match(result.how_to_fix, /exited with code 3/);
  assert.equal(readFileSync(join(context.cwd, '.exhibit/mutation/setup.log'), 'utf8'), 'no network\n');
});

test('changedLines gives the added and changed lines of the head, and leaves out deleted files and pure deletions', async (t) => {
  const context = collectorRepo(t, {
    'src/inside.js': '// a note\n' + NEW_CODE.replace('}\n', ''),
    'src/new.js': 'export const a = 1;\nexport const b = 2;\n',
    // An added line that starts with "++ " prints as "+++ i;", which looks like a file header.
    // The hunk after it must still count for src/twice.js.
    'src/twice.js': 'let i = 0;\n++ i;\nexport function inside(root, path) {\n  return path.startsWith(root);\n// b\n}\n',
    'README.md': ''
  });
  const lines = await changedLines(context.cwd, context.base, context.head);
  assert.deepEqual(Object.fromEntries(lines), { 'src/inside.js': [[1, 1], [3, 3]], 'src/new.js': [[1, 2]], 'src/twice.js': [[1, 2], [5, 5]] });
});

test('testsThatReach follows relative imports and requires, and file names in strings', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'exhibit-reach-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': "import { a } from './a.js';\n",
    'src/server.js': 'console.log(1);\n',
    'lib/c.cjs': "module.exports = require('../src/b');\n",
    'test/one.test.js': "import '../src/b.js';\n",
    'test/two.test.js': "const c = require('../lib/c.cjs');\n",
    'test/three.test.js': "spawn('node', [join(dir, '../src/server.js')]);\n",
    'test/four.test.js': "import { x } from './helper.js';\n",
    'test/helper.js': 'export const x = 1;\n'
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const tests = ['test/four.test.js', 'test/one.test.js', 'test/three.test.js', 'test/two.test.js'];
  assert.deepEqual(await testsThatReach(root, tests, ['src/a.js']), ['test/one.test.js', 'test/two.test.js']);
  assert.deepEqual(await testsThatReach(root, tests, ['src/server.js']), ['test/three.test.js']);
});

test('a run is complete when the done line is there and Stryker exited 0, or the budget ran out after the done line', () => {
  const mutant = JSON.stringify({ fileName: '/r/a.js', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }, mutatorName: 'X', replacement: 'y', status: 'Killed' });
  const done = `${mutant}\n{"done":true}\n`;
  assert.equal(readOutcome(done, { code: 0, signal: null, timedOut: false }).complete, true);
  // The budget ran out after the reporter wrote its done line, before Stryker exited.
  const late = readOutcome(done, { code: null, signal: 'SIGKILL', timedOut: true });
  assert.equal(late.complete, true);
  assert.equal(late.mutants.length, 1);
  // Stryker failed after its done line: not complete, so the collector gives error.
  assert.equal(readOutcome(done, { code: 1, signal: null, timedOut: false }).complete, false);
  // The budget cut the last line short: that line is left out, and the run is partial.
  const cut = readOutcome(`${mutant}\n${mutant.slice(0, 20)}`, { code: null, signal: 'SIGKILL', timedOut: true });
  assert.deepEqual([cut.mutants.length, cut.complete, cut.timedOut], [1, false, true]);
  // A broken line without a timeout is a fault.
  assert.throws(() => readOutcome(`${mutant.slice(0, 20)}\n`, { code: 0, signal: null, timedOut: false }), /not JSON/);
});

test('a status that Exhibit does not know throws, so an upgrade cannot count mutants wrong', () => {
  assert.throws(() => judge(ran(mutants('Exploded', 1), true), 0.5), /status "Exploded"/);
});

// Canary 5 of ticket 258, made small: daysLeft counts from the first day of the window, where it
// meant today. Each test asks on a first day, so every mutant dies. The good test also asks on a
// day inside the window.
const DAYS_CODE = `export function daysLeft(today, window) {
  if (today < window.from || today > window.to) return 0;
  const from = window.from, to = window.to;
  return to - from + 1;
}
`;
const daysTest = (cases) => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft } from '../src/days.js';
test('days left', () => {
${cases.map(([today, from, to, want]) => `  assert.equal(daysLeft(${today}, { from: ${from}, to: ${to} }), ${want});`).join('\n')}
});
`;

test('twin values: a test that asks only where the wrong name and the right value are equal makes a met requirement missing', async (t) => {
  const allKilled = async (options) => ({ mutants: [{ fileName: join(options.root, 'src/days.js'), location: { start: { line: 4, column: 10 }, end: { line: 4, column: 18 } }, mutatorName: 'ArithmeticOperator', replacement: 'to + from', status: 'Killed' }], complete: true, timedOut: false, code: 0 });
  const weak = collectorRepo(t, { 'src/days.js': DAYS_CODE, 'test/days.test.js': daysTest([[10, 10, 25, 16], [40, 40, 54, 15], [5, 10, 25, 0]]) });
  const missing = await mutationCollector({ runStryker: allKilled })({ params: { min: 0.8 } }, weak);
  assert.equal(missing.status, 'missing', JSON.stringify(missing));
  assert.deepEqual(missing.details.twin_values.map(({ file, line, used, twins }) => ({ file, line, used, twins })), [
    { file: 'src/days.js', line: 3, used: 'window.from', twins: ['today'] },
    { file: 'src/days.js', line: 4, used: 'from', twins: ['today'] }
  ]);
  assert.match(missing.how_to_fix, /src\/days\.js:4 `from` was always equal to `today`/);

  const good = collectorRepo(t, { 'src/days.js': DAYS_CODE, 'test/days.test.js': daysTest([[10, 10, 25, 16], [40, 40, 54, 15], [5, 10, 25, 0], [20, 10, 25, 6]]) });
  const met = await mutationCollector({ runStryker: allKilled })({ params: { min: 0.8 } }, good);
  assert.equal(met.status, 'met');
  assert.equal(met.details.twin_values, undefined);
});
