import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { check } from '../src/commands/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { runTestsOnBaseAndHead } from '../src/test-runs.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();

// Node 20's JUnit reporter writes no file for a test, so a test's name starts with its file only
// on later Node versions. These helpers accept both.
const NAME = (file, name) => new RegExp(`^(${file.replace(/[.]/g, '\\.')} > )?test > ${name}$`);
const statusOf = (tests, name) => [...tests].find(([key]) => key.endsWith(`test > ${name}`))?.[1];

const NODE_TESTS = `"${process.execPath}" --test --test-reporter=junit --test-reporter-destination=.exhibit/junit.xml`;
const policy = (command = NODE_TESTS, results = '.exhibit/junit.xml') => `version: 3
settings:
  test_command: ${JSON.stringify(command)}
  test_results: ${JSON.stringify(results)}
default:
  risk: medium
  needs:
    - tests-before-after
`;

const MATH_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';
test('add sums two numbers', () => assert.equal(add(2, 3), 5));
test('add keeps zero', () => assert.equal(add(0, 0), 0));
`;

// This test fails on its first run in a folder and passes after that. It leaves a mark file
// beside the test the first time.
const FLAKY_TEST = `import { test } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
test('passes the second time', () => {
  const mark = new URL('./flaky.mark', import.meta.url);
  if (!existsSync(mark)) { writeFileSync(mark, 'ran'); throw new Error('first run'); }
});
`;

// A repo with the policy, src/math.js and its tests on main (tag start), and one branch for each
// case: good (a change that keeps the tests passing), broken (a change that breaks one test), and
// flaky (adds a test that fails on its first run only).
function buildRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-tests-'));
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
  git('init', '-q', '-b', 'main');
  commit({
    'evidence.yml': policy(),
    '.gitignore': '.exhibit/\n',
    'package.json': '{ "type": "module" }\n',
    'src/math.js': 'export const add = (a, b) => a + b;\n',
    'test/math.test.js': MATH_TEST
  }, 'start');
  git('tag', 'start');
  git('checkout', '-q', '-b', 'good');
  commit({ 'src/math.js': '// Adds two numbers.\nexport const add = (a, b) => b + a;\n' }, 'good');
  git('checkout', '-q', '-b', 'broken', 'start');
  commit({ 'src/math.js': 'export const add = (a, b) => (a === 0 ? b : a + b + 1);\n' }, 'broken');
  git('checkout', '-q', '-b', 'flaky', 'start');
  commit({ 'test/flaky.test.js': FLAKY_TEST }, 'flaky');
  git('checkout', '-q', 'main');
  // Commits `text` as the policy on top of start, and moves the tag start there, because exhibit
  // check reads the policy from the base commit (spec 8.1). The branches keep their changed files.
  const setBasePolicy = (text) => {
    git('checkout', '-q', '--detach', 'start');
    commit({ 'evidence.yml': text }, 'base policy');
    git('tag', '-f', 'start');
    git('checkout', '-q', 'main');
  };
  // Makes the branch `name` from start, with `files` committed on it.
  const branch = (name, files) => {
    git('checkout', '-q', '-b', name, 'start');
    commit(files, name);
    git('checkout', '-q', 'main');
  };
  return { repo, home, git, setBasePolicy, branch };
}

async function runCheck(repo, head) {
  const code = await check(['--base', 'start', '--head', head], { env: { PATH: process.env.PATH }, cwd: repo, stdout: { write() {} } });
  const evidence = JSON.parse(readFileSync(join(repo, '.exhibit', 'evidence.json'), 'utf8'));
  assert.deepEqual(checkExhibit(evidence), []);
  const summary = readFileSync(join(repo, '.exhibit', 'summary.md'), 'utf8');
  return { code, evidence, summary, requirement: evidence.requirements.find((item) => item.type === 'tests-before-after'), gap: evidence.gaps.find((item) => item.type === 'tests-before-after') };
}

// The repo's worktrees, from git. Only the repo itself must be left.
function assertNoWorktreeLeft({ git }) {
  const listed = git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
  assert.equal(listed.length, 1, `worktrees left behind:\n${listed.join('\n')}`);
  for (const line of git('worktree', 'list', '--porcelain', '-z').split('\0')) {
    if (line.startsWith('worktree ')) assert.ok(existsSync(line.slice('worktree '.length)));
  }
}

test('every test passing on the head gives met', async (t) => {
  const fixture = buildRepo(t);
  const { code, evidence, requirement } = await runCheck(fixture.repo, 'good');
  assert.equal(requirement.status, 'met');
  assert.deepEqual(requirement.details, { base: { passed: 2, failed: 0, skipped: 0, flaky: 0 }, head: { passed: 2, failed: 0, skipped: 0, flaky: 0 }, failed_on_head: [] });
  assert.equal(evidence.verdict, 'meets_policy');
  assert.equal(code, 0);
  assertNoWorktreeLeft(fixture);
});

test('a test that fails on the head gives failed, and the gap names it', async (t) => {
  const fixture = buildRepo(t);
  const { code, evidence, requirement, gap } = await runCheck(fixture.repo, 'broken');
  assert.equal(requirement.status, 'failed');
  assert.equal(requirement.details.failed_on_head.length, 1);
  assert.match(requirement.details.failed_on_head[0], NAME('test/math.test.js', 'add sums two numbers'));
  assert.ok(gap.how_to_fix.includes(`1 test fails on the head, also when run again: ${requirement.details.failed_on_head[0]}.`), gap.how_to_fix);
  assert.equal(evidence.verdict, 'needs_person');
  assert.equal(code, 1);
  assertNoWorktreeLeft(fixture);
});

test('a test that fails once and then passes is flaky, and does not fail the requirement', async (t) => {
  const fixture = buildRepo(t);
  const { evidence, requirement } = await runCheck(fixture.repo, 'flaky');
  assert.equal(requirement.status, 'met');
  assert.equal(evidence.flaky_tests.length, 1);
  assert.match(evidence.flaky_tests[0], NAME('test/flaky.test.js', 'passes the second time'));
  assert.deepEqual(requirement.details.head, { passed: 2, failed: 0, skipped: 0, flaky: 1 });
  assert.equal(evidence.verdict, 'meets_policy');
  assertNoWorktreeLeft(fixture);
});

test('a test command that writes no JUnit file gives error, and verdict error', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(policy(NODE_TESTS, '.exhibit/elsewhere.xml'));
  const { code, evidence, requirement, gap } = await runCheck(fixture.repo, 'good');
  assert.equal(requirement.status, 'error');
  assert.match(gap.how_to_fix, /wrote no JUnit file at \.exhibit\/elsewhere\.xml/);
  assert.equal(evidence.verdict, 'error');
  assert.equal(code, 2);
  assertNoWorktreeLeft(fixture);
});

test('each run of the test command writes its output to a log in .exhibit/tests', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(policy(`echo "out from $(git rev-parse --short HEAD)"; echo "err line" >&2; ${NODE_TESTS}`));
  const sha = (ref) => fixture.git('rev-parse', '--short', ref).trim();
  const logs = join(fixture.repo, '.exhibit', 'tests');
  // A log from an earlier check that this run does not write must not stay behind.
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'base-again.log'), 'old');
  const { requirement } = await runCheck(fixture.repo, 'broken');
  assert.equal(requirement.status, 'failed');
  // A test fails on the head, so the head runs twice. The base passes, so it runs once.
  assert.equal(readFileSync(join(logs, 'base-first.log'), 'utf8').split('\n').slice(0, 2).join('\n'), `out from ${sha('start')}\nerr line`);
  assert.equal(existsSync(join(logs, 'base-again.log')), false);
  for (const run of ['first', 'again']) {
    assert.equal(readFileSync(join(logs, `head-${run}.log`), 'utf8').split('\n').slice(0, 2).join('\n'), `out from ${sha('broken')}\nerr line`);
  }
});

test('the gap of a test command that fails names the log with its output', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(policy('echo "why it broke"; exit 3'));
  const { requirement, gap } = await runCheck(fixture.repo, 'good');
  assert.equal(requirement.status, 'error');
  // The command fails on both sides. The head's error is the one that counts, and the base's
  // error is kept in details.
  assert.match(gap.how_to_fix, /Read its output in \.exhibit\/tests\/head-first\.log\./);
  assert.match(requirement.details.base_error.how_to_fix, /Read its output in \.exhibit\/tests\/base-first\.log\./);
  assert.equal(readFileSync(join(fixture.repo, '.exhibit', 'tests', 'base-first.log'), 'utf8'), 'why it broke\n');
  // The summary does not say that only the head counts, since the head gave no results either.
  const summary = readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8');
  assert.match(summary, /tests-before-after \(from default\): error\. The tests gave no results on the base either: the test command wrote no JUnit file at \.exhibit\/junit\.xml on the base \(exit code 3\)\./);
  assert.doesNotMatch(summary, /only the head counts/);
});

test('the gap of a second run that fails names the log of that run', async (t) => {
  const fixture = buildRepo(t);
  // A test fails on the head, so the head runs again. The second run finds the mark of the first
  // one, and exits with no JUnit file.
  fixture.setBasePolicy(policy(`if [ -f .exhibit/ran ]; then echo "second run broke"; exit 3; fi; touch .exhibit/ran; ${NODE_TESTS}`));
  const { requirement, gap } = await runCheck(fixture.repo, 'broken');
  assert.equal(requirement.status, 'error');
  assert.match(gap.how_to_fix, /on the head \(exit code 3\).*Read its output in \.exhibit\/tests\/head-again\.log\./);
  assert.equal(readFileSync(join(fixture.repo, '.exhibit', 'tests', 'head-again.log'), 'utf8'), 'second run broke\n');
});

test('the run of the base with the PR\'s test files writes its own log, and its gap names it', async (t) => {
  const fixture = buildRepo(t);
  // Only the base with the PR's test files has changes that git has staged: Exhibit checks out
  // the PR's test files there. So only that run fails.
  const command = `if ! git diff --cached --quiet; then echo "base with the PR tests"; exit 4; fi; ${NODE_TESTS}`;
  fixture.setBasePolicy(policy(command).replace('    - tests-before-after\n', '    - tests-before-after\n    - failing-before\n'));
  const { evidence } = await runCheck(fixture.repo, 'flaky');
  const gap = evidence.gaps.find((item) => item.type === 'failing-before');
  // A run on the base that gives no results is no error of Exhibit: failing-before cannot check,
  // so a person must.
  assert.equal(gap.status, 'missing');
  assert.equal(evidence.verdict, 'needs_person');
  assert.match(gap.how_to_fix, /Read its output in \.exhibit\/tests\/base-pr-tests-first\.log\./);
  assert.equal(readFileSync(join(fixture.repo, '.exhibit', 'tests', 'base-pr-tests-first.log'), 'utf8'), 'base with the PR tests\n');
});

test('a log that Exhibit cannot open is thrown as it is, not read as a command the shell could not find', async (t) => {
  const fixture = buildRepo(t);
  // A folder in the place of the log, so opening it to write fails.
  mkdirSync(join(fixture.repo, '.exhibit', 'tests', 'base-first.log'), { recursive: true });
  const sha = (ref) => fixture.git('rev-parse', ref).trim();
  await assert.rejects(
    runTestsOnBaseAndHead({ cwd: fixture.repo, base: sha('start'), head: sha('good'), settings: { test_command: NODE_TESTS, test_results: '.exhibit/junit.xml' } }),
    (error) => error.code === 'EISDIR' && error.name !== 'TestRunError'
  );
  assertNoWorktreeLeft(fixture);
});

test('a test command that is not found gives error, and verdict error', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(policy('exhibit-no-such-test-command --run'));
  const { code, evidence, requirement, gap } = await runCheck(fixture.repo, 'good');
  assert.equal(requirement.status, 'error');
  assert.match(gap.how_to_fix, /could not run on the head: the shell could not find it \(exit code 127\)/);
  assert.equal(evidence.verdict, 'error');
  assert.equal(code, 2);
  assertNoWorktreeLeft(fixture);
});

// Adds the branch hang, with a test that never ends, and sets the base policy's time limit to
// `seconds`. node --test runs each test file in a child process. The hanging test writes the pid
// of that child to the file that this gives back, so a test can see that Exhibit stopped the
// children too, not only the shell.
function addHangBranch(fixture, seconds) {
  const pidFile = join(dirname(fixture.repo), 'hang.pid');
  const HANG_TEST = `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('never ends', () => new Promise(() => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
}));
`;
  fixture.git('checkout', '-q', '-b', 'hang', 'start');
  writeFileSync(join(fixture.repo, 'test', 'hang.test.js'), HANG_TEST);
  fixture.git('add', 'test/hang.test.js');
  fixture.git('commit', '-q', '-m', 'hang');
  fixture.git('checkout', '-q', 'main');
  fixture.setBasePolicy(policy().replace('settings:\n', `settings:\n  test_timeout_seconds: ${seconds}\n`));
  return pidFile;
}

// Waits until `check` gives true, for at most `ms` milliseconds.
async function waitFor(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`waited ${ms} ms for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

test('a test that never ends hits the time limit: Exhibit stops it and its children, gives error, and removes the worktrees', async (t) => {
  const fixture = buildRepo(t);
  const pidFile = addHangBranch(fixture, 5);

  const started = Date.now();
  const { code, evidence, requirement, gap } = await runCheck(fixture.repo, 'hang');
  assert.ok(Date.now() - started < 60_000, 'exhibit check stopped soon after the time limit');
  assert.equal(requirement.status, 'error');
  assert.match(requirement.details.message, /ran past the time limit of 5 seconds on the head/);
  assert.match(gap.how_to_fix, /ran past the time limit of 5 seconds \(settings\.test_timeout_seconds\) on the head/);
  assert.match(gap.how_to_fix, /raise settings\.test_timeout_seconds in evidence\.yml/);
  assert.equal(evidence.verdict, 'error');
  assert.equal(code, 2);
  assertNoWorktreeLeft(fixture);

  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `the test process ${pid} still runs`);
});

// A terminal runs exhibit check in a process group of its own. Ctrl-C sends SIGINT to that
// group, and closing the terminal sends SIGHUP. The test command runs in a group of its own, so
// it does not get those signals, and Exhibit must stop it itself.
for (const [why, signal] of [['Ctrl-C', 'SIGINT'], ['kill', 'SIGTERM'], ['closing the terminal', 'SIGHUP']]) {
  test(`${why} (${signal}) on exhibit check stops the test command and its children too`, async (t) => {
    const fixture = buildRepo(t);
    const pidFile = addHangBranch(fixture, 600);
    const bin = new URL('../bin/exhibit.js', import.meta.url).pathname;
    // Exhibit ends by the signal before it removes its worktrees, so the temp folder is the
    // fixture's folder, which the test removes.
    const env = gitEnv(fixture.home, { TMPDIR: dirname(fixture.repo) });
    const exhibit = spawn(process.execPath, [bin, 'check', '--base', 'start', '--head', 'hang'], { cwd: fixture.repo, env, detached: true, stdio: 'ignore' });
    const exited = new Promise((done) => exhibit.once('exit', (code, signal) => done({ code, signal })));
    t.after(() => {
      if (exhibit.exitCode === null && exhibit.signalCode === null) process.kill(-exhibit.pid, 'SIGKILL');
    });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 60_000, 'the hanging test to start');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    t.after(() => {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    });

    process.kill(-exhibit.pid, signal);
    const exit = await exited;
    assert.equal(exit.signal, signal, 'exhibit check still ends by the signal, as before');
    await waitFor(() => !alive(pid), 5_000, `the test process ${pid} to stop`);
  });
}

test('a policy with no test command gives missing, so a person must check the tests', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy('version: 3\ndefault:\n  risk: low\n  needs: [tests-before-after]\n');
  const { evidence, requirement, gap } = await runCheck(fixture.repo, 'good');
  assert.equal(requirement.status, 'missing');
  assert.match(gap.how_to_fix, /settings\.test_command/);
  assert.equal(evidence.verdict, 'needs_person');
  assertNoWorktreeLeft(fixture);
});

test('a results path outside the worktree gives error, and Exhibit touches no file there', async (t) => {
  const fixture = buildRepo(t);
  const outside = join(dirname(fixture.repo), 'keep.xml');
  writeFileSync(outside, 'keep');
  for (const results of ['../keep.xml', outside, './', 'a/..//']) {
    fixture.setBasePolicy(policy(NODE_TESTS, results));
    const { code, requirement, gap } = await runCheck(fixture.repo, 'good');
    assert.equal(requirement.status, 'error');
    assert.match(gap.how_to_fix, /not a file inside the repo/);
    assert.equal(code, 2);
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
  }
  assertNoWorktreeLeft(fixture);
});

test('the base run does not see the head, or changes in the checkout', async (t) => {
  const fixture = buildRepo(t);
  // An edit in the checkout that is not committed breaks every test. Each worktree is clean, so
  // neither run sees it.
  writeFileSync(join(fixture.repo, 'src', 'math.js'), 'export const add = () => -1;\n');
  const sha = (ref) => fixture.git('rev-parse', ref).trim();
  const runs = await runTestsOnBaseAndHead({ cwd: fixture.repo, base: sha('start'), head: sha('broken'), settings: { test_command: NODE_TESTS, test_results: '.exhibit/junit.xml' } });
  assert.equal(statusOf(runs.base, 'add sums two numbers'), 'passed');
  assert.equal(statusOf(runs.head, 'add sums two numbers'), 'failed');
  assert.equal(statusOf(runs.base, 'add keeps zero'), 'passed');
  assert.equal(statusOf(runs.head, 'add keeps zero'), 'passed');
  assertNoWorktreeLeft(fixture);
});

// The PR adds the test tools: the base policy runs scripts/test.sh, which only the head has. So
// the command cannot run on the base (sh exits 127), and runs on the head.
const TOOLS = { 'scripts/test.sh': `${NODE_TESTS}\n` };
const NO_BASE_RESULTS = /^the test command (could not run on the base: the shell could not find it \(exit code 127\)|wrote no JUnit file at \.exhibit\/junit\.xml on the base \(exit code 2\))$/;

test('a test command that cannot run on the base only: tests-before-after is judged by the head, and keeps the base error', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(policy('sh scripts/test.sh'));
  fixture.branch('tools', TOOLS);
  const { code, evidence, summary, requirement } = await runCheck(fixture.repo, 'tools');
  assert.equal(requirement.status, 'met');
  assert.equal(requirement.details.base, null);
  assert.deepEqual(requirement.details.head, { passed: 2, failed: 0, skipped: 0, flaky: 0 });
  assert.match(requirement.details.base_error.message, NO_BASE_RESULTS);
  assert.match(requirement.details.base_error.how_to_fix, /Read its output in \.exhibit\/tests\/base-first\.log\./);
  assert.equal(evidence.verdict, 'meets_policy');
  assert.equal(code, 0);
  assert.match(summary, /tests-before-after \(from default\): met\. The tests gave no results on the base, so only the head counts: the test command (could not run|wrote no JUnit file)/);
  assertNoWorktreeLeft(fixture);
});

test('a test that fails on the head still gives failed when the base gives no results', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(policy('sh scripts/test.sh'));
  fixture.branch('tools-broken', { ...TOOLS, 'src/math.js': 'export const add = (a, b) => a + b + 1;\n' });
  const { evidence, requirement, gap } = await runCheck(fixture.repo, 'tools-broken');
  assert.equal(requirement.status, 'failed');
  assert.equal(requirement.details.failed_on_head.length, 2);
  assert.match(requirement.details.base_error.message, /on the base/);
  assert.match(gap.how_to_fix, /2 tests fail on the head/);
  assert.equal(evidence.verdict, 'needs_person');
});

test('a base that gives no results leaves failing-before missing: it says it cannot check, and runs no more tests', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(policy('sh scripts/test.sh').replace('    - tests-before-after\n', '    - tests-before-after\n    - failing-before\n'));
  fixture.branch('tools-and-test', { ...TOOLS, 'test/zero.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add keeps a number', () => assert.equal(add(0, 7), 7));\n" });
  const { code, evidence, summary } = await runCheck(fixture.repo, 'tools-and-test');
  const requirement = evidence.requirements.find((item) => item.type === 'failing-before');
  const gap = evidence.gaps.find((item) => item.type === 'failing-before');
  assert.equal(requirement.status, 'missing');
  assert.match(requirement.details.base_error.message, NO_BASE_RESULTS);
  assert.match(gap.how_to_fix, /The tests gave no results on the base, so Exhibit cannot show that a test fails there/);
  assert.match(gap.how_to_fix, /The test command "sh scripts\/test\.sh" (could not run|ran) on the base/);
  assert.match(gap.how_to_fix, /Read its output in \.exhibit\/tests\/base-first\.log\./);
  assert.equal(evidence.requirements.find((item) => item.type === 'tests-before-after').status, 'met');
  assert.equal(evidence.verdict, 'needs_person');
  assert.equal(code, 1);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'tests', 'base-pr-tests-first.log')), false);
  assert.match(summary, /failing-before \(from default\): missing\./);
  assertNoWorktreeLeft(fixture);
});

test('the base and head runs give the base error, not a throw, when only the base cannot run', async (t) => {
  const fixture = buildRepo(t);
  fixture.branch('tools', TOOLS);
  const sha = (ref) => fixture.git('rev-parse', ref).trim();
  const runs = await runTestsOnBaseAndHead({ cwd: fixture.repo, base: sha('start'), head: sha('tools'), settings: { test_command: 'sh scripts/test.sh', test_results: '.exhibit/junit.xml' } });
  assert.equal(runs.base, null);
  assert.equal(runs.baseError.name, 'TestRunError');
  assert.match(runs.baseError.message, /on the base/);
  assert.equal(statusOf(runs.head, 'add sums two numbers'), 'passed');
  assertNoWorktreeLeft(fixture);
});

test('a base run past the time limit is a base with no results: tests-before-after is judged by the head', async (t) => {
  const fixture = buildRepo(t);
  // Only the head has scripts/test.sh, so the command hangs on the base and runs the tests on the
  // head. The head has the same limit, so it gets 3 seconds, to pass on a busy machine too.
  fixture.setBasePolicy(policy('if [ ! -f scripts/test.sh ]; then sleep 600; fi; sh scripts/test.sh').replace('settings:\n', 'settings:\n  test_timeout_seconds: 3\n'));
  fixture.branch('tools', TOOLS);
  const started = Date.now();
  const { code, evidence, requirement } = await runCheck(fixture.repo, 'tools');
  assert.ok(Date.now() - started < 60_000, 'exhibit check stopped the base soon after the time limit');
  assert.equal(requirement.status, 'met');
  assert.equal(requirement.details.base, null);
  assert.match(requirement.details.base_error.message, /ran past the time limit of 3 seconds on the base/);
  assert.equal(evidence.verdict, 'meets_policy');
  assert.equal(code, 0);
  assertNoWorktreeLeft(fixture);
});
