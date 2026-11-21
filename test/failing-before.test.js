import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildExhibit } from '../src/check.js';
import { check } from '../src/commands/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { isTestPath } from '../src/failing-before.js';
import { NothingLoaded, TestRunError } from '../src/test-runs.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();

// Node 20's JUnit reporter writes no file for a test, so a test's name starts with its file only
// on later Node versions. This accepts both.
const NAME = (file, name) => new RegExp(`^(${file.replace(/[.]/g, '\\.')} > )?test > ${name}$`);

const NODE_TESTS = `"${process.execPath}" --test --test-reporter=junit --test-reporter-destination=.exhibit/junit.xml test/*.test.js`;
// A step that runs before the tests and stops the command when a test imports a file that is not
// there, as `tsc && node --test` stops when a new test uses types that the base lacks. It writes no
// JUnit file then.
const CHECK_IMPORTS = `import { existsSync, readdirSync, readFileSync } from 'node:fs';
for (const name of readdirSync('test')) {
  for (const [, path] of readFileSync('test/' + name, 'utf8').matchAll(/from '(\\.\\.\\/[^']+)'/g)) {
    if (!existsSync(new URL(path, 'file://' + process.cwd() + '/test/'))) {
      console.error('test/' + name + ': cannot find ' + path);
      process.exit(2);
    }
  }
}
`;
const CHECKED_TESTS = `"${process.execPath}" scripts/check-imports.js && ${NODE_TESTS}`;
const POLICY = (command) => `version: 3
settings:
  test_command: ${JSON.stringify(command)}
  test_results: ".exhibit/junit.xml"
default:
  risk: medium
  needs:
    - tests-before-after
    - failing-before: { when: [fix, feature] }
`;

const header = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
// On the base, double has a bug: it adds one too many. Each fix branch fixes it.
const BUGGY = 'export const add = (a, b) => a + b;\nexport const double = (a) => a + a + 1;\n';
const FIXED = 'export const add = (a, b) => a + b;\nexport const double = (a) => a + a;\n';
const MATH_TEST = `${header}import { add, double } from '../src/math.js';
test('add sums two numbers', () => assert.equal(add(2, 3), 5));
test('double gives a number', () => assert.equal(typeof double(2), 'number'));
`;

// A test that fails on its first run in a folder and passes after that, whatever the code does.
const FLAKY_TEST = `${header}import { existsSync, writeFileSync } from 'node:fs';
test('double is checked once', () => {
  const mark = new URL('./flaky.mark', import.meta.url);
  if (!existsSync(mark)) { writeFileSync(mark, 'ran'); throw new Error('first run'); }
});
`;

// A repo with the bug on main (tag start), and one branch for each case. A branch whose name
// starts with fix/ is a fix by the default fix signals.
// `command` is the policy's test command.
function buildRepo(t, command = NODE_TESTS) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-failing-before-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv(home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }) });
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    git('commit', '-q', '-m', message);
  };
  const branch = (name, files) => {
    git('checkout', '-q', '-b', name, 'start');
    commit(files, name);
  };
  git('init', '-q', '-b', 'main');
  commit({
    'evidence.yml': POLICY(command),
    'scripts/check-imports.js': CHECK_IMPORTS,
    '.gitignore': '.exhibit/\nflaky.mark\n',
    'package.json': '{ "type": "module" }\n',
    'README.md': 'Math.\n',
    'src/math.js': BUGGY,
    'test/math.test.js': MATH_TEST
  }, 'start');
  git('tag', 'start');
  branch('fix/new-test', { 'src/math.js': FIXED, 'test/double.test.js': `${header}import { double } from '../src/math.js';\ntest('double doubles', () => assert.equal(double(2), 4));\n` });
  branch('fix/weak-test', { 'src/math.js': FIXED, 'test/double.test.js': `${header}import { double } from '../src/math.js';\ntest('double is a function', () => assert.equal(typeof double, 'function'));\n` });
  branch('fix/changed-test', { 'src/math.js': FIXED, 'test/math.test.js': MATH_TEST.replace("assert.equal(typeof double(2), 'number')", 'assert.equal(double(2), 4)') });
  branch('fix/new-module', { 'src/half.js': 'export const half = (a) => a / 2;\n', 'test/half.test.js': `${header}import { half } from '../src/half.js';\ntest('half halves', () => assert.equal(half(4), 2));\n` });
  branch('fix/flaky', { 'src/math.js': FIXED, 'test/flaky.test.js': FLAKY_TEST });
  branch('notes', { 'README.md': 'Math, with notes.\n' });
  git('checkout', '-q', 'main');
  return { repo, git };
}

async function runCheck(repo, head) {
  const code = await check(['--base', 'start', '--head', head], { env: { PATH: process.env.PATH }, cwd: repo, stdout: { write() {} } });
  const evidence = JSON.parse(readFileSync(join(repo, '.exhibit', 'evidence.json'), 'utf8'));
  assert.deepEqual(checkExhibit(evidence), []);
  const summary = readFileSync(join(repo, '.exhibit', 'summary.md'), 'utf8');
  return {
    code,
    evidence,
    summary,
    requirement: evidence.requirements.find((item) => item.type === 'failing-before'),
    gap: evidence.gaps.find((item) => item.type === 'failing-before')
  };
}

function assertNoWorktreeLeft({ git }) {
  const listed = git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
  assert.equal(listed.length, 1, `worktrees left behind:\n${listed.join('\n')}`);
  for (const line of listed) assert.ok(existsSync(line.slice('worktree '.length)));
}

test('a fix with a new test that fails on the base gives met, and lists the test', async (t) => {
  const fixture = buildRepo(t);
  const { code, evidence, summary, requirement } = await runCheck(fixture.repo, 'fix/new-test');
  assert.equal(evidence.classification.fix, true);
  assert.equal(requirement.status, 'met');
  assert.equal(requirement.details.tests.length, 1);
  assert.match(requirement.details.tests[0].name, NAME('test/double.test.js', 'double doubles'));
  assert.equal(requirement.details.tests[0].on_base, 'failed');
  assert.deepEqual(requirement.details.test_files, ['test/double.test.js']);
  assert.equal(evidence.verdict, 'meets_policy');
  assert.equal(code, 0);
  assert.match(summary, /failing-before \(from default\): met\. Tests that fail on the base and pass on the head: .*double doubles \(fails on the base\)\./);
  assertNoWorktreeLeft(fixture);
});

test('a fix whose new test passes on the base too gives missing, with a gap that asks for a test that fails without the change', async (t) => {
  const fixture = buildRepo(t);
  const { code, evidence, requirement, gap } = await runCheck(fixture.repo, 'fix/weak-test');
  assert.equal(requirement.status, 'missing');
  assert.deepEqual(requirement.details.tests, []);
  assert.equal(requirement.details.passed_on_base.length, 1);
  assert.match(requirement.details.passed_on_base[0], NAME('test/double.test.js', 'double is a function'));
  assert.match(gap.how_to_fix, /1 test that the change adds or changes passes on the base too/);
  assert.match(gap.how_to_fix, /Add a test that fails without the change and passes with it/);
  assert.equal(evidence.verdict, 'needs_person');
  assert.equal(code, 1);
  assertNoWorktreeLeft(fixture);
});

test('a changed existing test that fails on the base qualifies', async (t) => {
  const fixture = buildRepo(t);
  const { evidence, requirement } = await runCheck(fixture.repo, 'fix/changed-test');
  assert.equal(requirement.status, 'met');
  assert.equal(requirement.details.tests.length, 1);
  assert.match(requirement.details.tests[0].name, NAME('test/math.test.js', 'double gives a number'));
  // The test that the PR did not change passes on the base, as it did before.
  assert.ok(!requirement.details.tests.some((item) => /add sums/.test(item.name)));
  assert.equal(evidence.verdict, 'meets_policy');
});

test('a new test file that cannot load on the base counts, and the summary says why', async (t) => {
  const fixture = buildRepo(t);
  const { evidence, summary, requirement } = await runCheck(fixture.repo, 'fix/new-module');
  assert.equal(requirement.status, 'met');
  assert.deepEqual(requirement.details.did_not_load_on_base, ['test/half.test.js']);
  assert.equal(requirement.details.tests.length, 1);
  assert.match(requirement.details.tests[0].name, NAME('test/half.test.js', 'half halves'));
  assert.equal(requirement.details.tests[0].on_base, 'did_not_load');
  assert.deepEqual(requirement.details.tests[0].files, ['test/half.test.js']);
  assert.match(summary, /half halves \(its file did not load on the base: test\/half\.test\.js\)/);
  assert.equal(evidence.verdict, 'meets_policy');
});

test('a new test file that stops the test command before it writes JUnit on the base counts as did not load', async (t) => {
  const fixture = buildRepo(t, CHECKED_TESTS);
  const { evidence, summary, requirement } = await runCheck(fixture.repo, 'fix/new-module');
  // The plain base and head runs give results, so only the run with the PR's test files stops.
  assert.equal(evidence.requirements.find((item) => item.type === 'tests-before-after').status, 'met');
  assert.equal(requirement.status, 'met');
  assert.deepEqual(requirement.details.did_not_load_on_base, ['test/half.test.js']);
  assert.match(requirement.details.base_with_pr_tests_error, /the test command failed on the base with the PR's test files \(exit code 2\) and wrote no JUnit file/);
  // Only the PR's test counts. The tests in test/math.test.js are not the PR's.
  assert.equal(requirement.details.tests.length, 1);
  assert.match(requirement.details.tests[0].name, NAME('test/half.test.js', 'half halves'));
  assert.equal(requirement.details.tests[0].on_base, 'did_not_load');
  assert.deepEqual(requirement.details.tests[0].files, ['test/half.test.js']);
  assert.match(summary, /half halves \(its file did not load on the base: test\/half\.test\.js\)/);
  assert.equal(evidence.verdict, 'meets_policy');
  assert.equal(readFileSync(join(fixture.repo, '.exhibit', 'tests', 'base-pr-tests-first.log'), 'utf8'), 'test/half.test.js: cannot find ../src/half.js\n');
  assertNoWorktreeLeft(fixture);
});

test('a test command that stops the run on the base with the PR\'s tests only once is flaky there, so a person must check', async (t) => {
  // Only the base with the PR's test files has changes that git has staged. There the command
  // stops before it writes JUnit on its first run only.
  const fixture = buildRepo(t, `if ! git diff --cached --quiet && [ ! -e stop.mark ]; then touch stop.mark; exit 2; fi; ${NODE_TESTS}`);
  const { evidence, requirement, gap } = await runCheck(fixture.repo, 'fix/new-test');
  assert.equal(requirement.status, 'missing');
  assert.deepEqual(requirement.details.tests, []);
  assert.match(requirement.details.base_error.message, /gave no results on its first run but did on its second/);
  assert.match(gap.how_to_fix, /base-pr-tests-first\.log/);
  assert.equal(evidence.verdict, 'needs_person');
});

// With test results made by hand: when the run with the PR's tests gives nothing, only the PR's
// tests count. A test in a file the PR did not change is not the PR's, and neither is a test with
// no file that the plain base run has too.
test('when nothing loads on the base with the PR\'s tests, only the PR\'s tests that pass on the head count', async () => {
  const policy = { settings: { fix_signals: ['branch:fix/'], test_command: 'x', test_results: 'r.xml' }, kinds: {}, default: { risk: 'low', needs: ['failing-before'] } };
  const runTests = async () => ({
    base: new Map([['old.test.js > a', 'passed'], ['test > b', 'passed']]),
    head: new Map([['old.test.js > a', 'passed'], ['test > b', 'passed'], ['new.test.js > c', 'passed'], ['new.test.js > d', 'failed'], ['test > e', 'passed']])
  });
  const runBaseWithPrTests = async () => new NothingLoaded('the test command failed on the base with the PR\'s test files (exit code 2) and wrote no JUnit file at r.xml');
  const exhibit = await buildExhibit({
    policy, policyFile: { path: 'evidence.yml', sha256: null }, files: ['new.test.js', 'src/a.js'], pr: { title: '', labels: [], branch: 'fix/x' },
    signalsFrom: 'branch', repo: null, prNumber: null, base: '1'.repeat(40), head: '2'.repeat(40)
  }, { runTests, runBaseWithPrTests, environment: { node: '20.x', os: 'linux' }, now: () => new Date(0), clock: () => 0 });
  const [requirement] = exhibit.requirements;
  assert.equal(requirement.status, 'met');
  assert.deepEqual(requirement.details.tests, [
    { name: 'new.test.js > c', on_base: 'did_not_load', files: ['new.test.js'] },
    { name: 'test > e', on_base: 'did_not_load', files: ['new.test.js'] }
  ]);
  assert.deepEqual(requirement.details.did_not_load_on_base, ['new.test.js']);
  assert.deepEqual(requirement.details.passed_on_base, []);
});

test('a change that is neither fix nor feature skips failing-before with the reason, and can still meet the policy', async (t) => {
  const fixture = buildRepo(t);
  const { code, evidence, summary, requirement } = await runCheck(fixture.repo, 'notes');
  assert.equal(evidence.classification.fix, false);
  assert.equal(requirement.status, 'skipped');
  assert.match(requirement.details.reason, /only on a fix or a feature/);
  assert.deepEqual(evidence.gaps, []);
  assert.equal(evidence.verdict, 'meets_policy');
  assert.equal(code, 0);
  assert.deepEqual(evidence.checks_by_author, { builder: 1, hidden: 0 });
  assert.match(summary, /failing-before \(from default\): skipped\. The policy asks for it only on a fix or a feature/);
});

test('a flaky test never qualifies', async (t) => {
  const fixture = buildRepo(t);
  const { evidence, requirement } = await runCheck(fixture.repo, 'fix/flaky');
  assert.equal(requirement.status, 'missing');
  assert.deepEqual(requirement.details.tests, []);
  assert.ok(evidence.flaky_tests.some((name) => NAME('test/flaky.test.js', 'double is checked once').test(name)), evidence.flaky_tests.join('\n'));
  assert.equal(evidence.verdict, 'needs_person');
});

// The same rule with test results made by hand: a test that passes on the head and fails on the
// base with the PR's tests still does not count when it was flaky in the plain base run.
test('a test that is flaky in any run does not qualify, even when it fails on the base with the PR\'s tests', async () => {
  const policy = { settings: { fix_signals: ['branch:fix/'], test_command: 'x', test_results: 'r.xml' }, kinds: {}, default: { risk: 'low', needs: ['failing-before'] } };
  const runTests = async () => ({ base: new Map([['t.test.js > a', 'flaky'], ['t.test.js > b', 'passed']]), head: new Map([['t.test.js > a', 'passed'], ['t.test.js > b', 'passed']]) });
  const runBaseWithPrTests = async () => new Map([['t.test.js > a', 'failed'], ['t.test.js > b', 'failed']]);
  const exhibit = await buildExhibit({
    policy, policyFile: { path: 'evidence.yml', sha256: null }, files: ['t.test.js'], pr: { title: '', labels: [], branch: 'fix/x' },
    signalsFrom: 'branch', repo: null, prNumber: null, base: '1'.repeat(40), head: '2'.repeat(40)
  }, { runTests, runBaseWithPrTests, environment: { node: '20.x', os: 'linux' }, now: () => new Date(0), clock: () => 0 });
  assert.deepEqual(exhibit.requirements[0].details.tests, [{ name: 't.test.js > b', on_base: 'failed' }]);
  assert.deepEqual(exhibit.flaky_tests, ['t.test.js > a']);
});

test('two failing-before requirements share one run on the base with the PR\'s tests', async () => {
  const policy = { settings: { fix_signals: ['branch:fix/'], test_command: 'x', test_results: 'r.xml' }, kinds: {}, default: { risk: 'low', needs: [{ 'failing-before': { when: ['fix'] } }, 'failing-before'] } };
  const runTests = async () => ({ base: new Map(), head: new Map([['t.test.js > a', 'passed']]) });
  let runs = 0;
  const runBaseWithPrTests = async () => {
    runs += 1;
    return new Map([['t.test.js > a', 'failed']]);
  };
  const exhibit = await buildExhibit({
    policy, policyFile: { path: 'evidence.yml', sha256: null }, files: ['t.test.js'], pr: { title: '', labels: [], branch: 'fix/x' },
    signalsFrom: 'branch', repo: null, prNumber: null, base: '1'.repeat(40), head: '2'.repeat(40)
  }, { runTests, runBaseWithPrTests, environment: { node: '20.x', os: 'linux' }, now: () => new Date(0), clock: () => 0 });
  assert.deepEqual(exhibit.requirements.map((item) => item.status), ['met', 'met']);
  assert.equal(runs, 1);
});

test('a change with no test file gives missing and runs no extra test run', async () => {
  const policy = { settings: { fix_signals: ['branch:fix/'], test_command: 'x', test_results: 'r.xml' }, kinds: {}, default: { risk: 'low', needs: ['failing-before'] } };
  const runTests = async () => ({ base: new Map([['t > a', 'passed']]), head: new Map([['t > a', 'passed']]) });
  const runBaseWithPrTests = async () => assert.fail('no test file changed, so this must not run');
  const exhibit = await buildExhibit({
    policy, policyFile: { path: 'evidence.yml', sha256: null }, files: ['src/a.js'], pr: { title: '', labels: [], branch: 'fix/x' },
    signalsFrom: 'branch', repo: null, prNumber: null, base: '1'.repeat(40), head: '2'.repeat(40)
  }, { runTests, runBaseWithPrTests, environment: { node: '20.x', os: 'linux' }, now: () => new Date(0), clock: () => 0 });
  assert.equal(exhibit.requirements[0].status, 'missing');
  assert.match(exhibit.gaps[0].how_to_fix, /adds or changes no test file/);
});

test('test files are found by name and by folder', () => {
  for (const path of ['test/a.js', 'src/a.test.js', 'src/a.spec.ts', 'pkg/tests/x.py', 'test_a.py', 'a_test.go', 'src/__tests__/a.js', 'test/fixtures/data.json']) assert.ok(isTestPath(path), path);
  for (const path of ['src/a.js', 'docs/testing.md', 'test-support/x.js', 'src/latest.js', 'contest/a.js']) assert.ok(!isTestPath(path), path);
});

test('a change with no test file gives the no-test-file gap, also when the base gives no results', async () => {
  const policy = { settings: { fix_signals: ['branch:fix/'], test_command: 'x', test_results: 'r.xml' }, kinds: {}, default: { risk: 'low', needs: ['failing-before'] } };
  const baseError = new TestRunError('error', 'the test command could not run on the base', 'Check settings.test_command.');
  const runTests = async () => ({ base: null, head: new Map([['t > a', 'passed']]), baseError });
  const runBaseWithPrTests = async () => assert.fail('no test file changed, so this must not run');
  const exhibit = await buildExhibit({
    policy, policyFile: { path: 'evidence.yml', sha256: null }, files: ['src/a.js'], pr: { title: '', labels: [], branch: 'fix/x' },
    signalsFrom: 'branch', repo: null, prNumber: null, base: '1'.repeat(40), head: '2'.repeat(40)
  }, { runTests, runBaseWithPrTests, environment: { node: '20.x', os: 'linux' }, now: () => new Date(0), clock: () => 0 });
  assert.equal(exhibit.requirements[0].status, 'missing');
  assert.match(exhibit.gaps[0].how_to_fix, /adds or changes no test file/);
  assert.equal(exhibit.verdict, 'needs_person');
});
