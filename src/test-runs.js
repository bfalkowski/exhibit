import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseJUnit } from './junit.js';

const run = promisify(execFile);
const LISTED = 20;

// A test run that could not give results. `status` is the requirement status it leads to:
// `missing` when the policy gives no test command, and `error` when the command could not run or
// wrote no JUnit file. `howToFix` says what to do, in plain words.
export class TestRunError extends Error {
  name = 'TestRunError';
  constructor(status, message, howToFix) {
    super(message);
    this.status = status;
    this.howToFix = howToFix;
  }
}

// Runs the test command on the base and on the head (spec 9.3).
//
// For each side it makes a clean git worktree of the commit, runs settings.test_command in it,
// and reads the JUnit XML at settings.test_results. When a test fails, it runs the command once
// more. It removes each worktree when the side is done, also when the run fails.
//
// It gives back { base, head }: for each side a Map from a test's name to its status, `passed`,
// `failed`, `skipped` or `flaky`. A test is flaky when its two runs disagree. The name is the
// test's file (relative to the worktree), its classname and its name, joined by " > ".
// It throws a TestRunError when a side cannot give results.
export async function runTestsOnBaseAndHead({ cwd, base, head, settings = {}, env = process.env }) {
  const command = settings.test_command;
  const results = settings.test_results;
  if (!command || !results) {
    throw new TestRunError('missing', 'the policy has no settings.test_command or no settings.test_results',
      'The policy needs tests-before-after, but evidence.yml does not say how to run the tests. Set settings.test_command to a command that runs the tests and writes JUnit XML, and settings.test_results to the path of that file.');
  }
  return {
    base: await runSide({ cwd, sha: base, side: 'base', command, results, env }),
    head: await runSide({ cwd, sha: head, side: 'head', command, results, env })
  };
}

async function runSide({ cwd, sha, side, command, results, env }) {
  const folder = await mkdtemp(join(tmpdir(), `exhibit-${side}-`));
  try {
    try {
      await run('git', ['worktree', 'add', '--detach', '--quiet', folder, sha], { cwd, encoding: 'utf8' });
    } catch (error) {
      const reason = String(error.stderr ?? '').trim().split('\n')[0] || error.message;
      throw new TestRunError('error', `could not make a worktree for the ${side}: ${reason}`, `Exhibit could not make a clean git worktree for the ${side} commit ${sha.slice(0, 7)}: ${reason}. Check that the commit is in the clone, and run exhibit check again.`);
    }
    const roots = [folder, await realpath(folder)];
    const first = await runOnce({ folder, roots, side, command, results, env });
    if (![...first.values()].includes('failed')) return first;
    const second = await runOnce({ folder, roots, side, command, results, env });
    return settle(first, second);
  } finally {
    await removeWorktree(cwd, folder);
  }
}

// One run of the test command, read from its JUnit file.
async function runOnce({ folder, roots, side, command, results, env }) {
  const file = resolve(folder, results);
  await rm(file, { force: true });
  await mkdir(dirname(file), { recursive: true });
  const exit = await shell(command, folder, env);

  if (exit.code === 127) {
    throw new TestRunError('error', `the test command could not run on the ${side}: the shell could not find it (exit code 127)`,
      `The test command "${command}" could not run on the ${side}: the shell could not find it (exit code 127). Check settings.test_command in evidence.yml, and that the tools it needs are installed.`);
  }
  let xml;
  try {
    xml = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new TestRunError('error', `the test command wrote no JUnit file at ${results} on the ${side} (${exitWords(exit)})`,
      `The test command "${command}" ran on the ${side} (${exitWords(exit)}), but it wrote no JUnit file at ${results}. Make the command write JUnit XML to settings.test_results, for example with node --test --test-reporter=junit --test-reporter-destination=${results}.`);
  }
  let cases;
  try {
    cases = parseJUnit(xml);
  } catch (error) {
    throw new TestRunError('error', `could not read ${results} on the ${side}: ${error.message}`, `Exhibit could not read ${results} on the ${side}: ${error.message}. Make the test command write JUnit XML there.`);
  }
  const tests = new Map();
  for (const item of cases) {
    const name = testName(item, roots);
    const old = tests.get(name);
    // Two test cases with one name: a failure wins over a pass, and a pass over a skip.
    if (!old || RANK[item.status] > RANK[old]) tests.set(name, item.status);
  }
  if (exit.code !== 0 && ![...tests.values()].includes('failed')) {
    throw new TestRunError('error', `the test command failed on the ${side} (${exitWords(exit)}), but ${results} names no failing test`,
      `The test command "${command}" failed on the ${side} (${exitWords(exit)}), but ${results} names no failing test, so Exhibit cannot tell what broke. Run the command in a clean checkout of the ${side} to see why it fails.`);
  }
  return tests;
}

const RANK = { skipped: 0, passed: 1, failed: 2 };

// A test whose two runs disagree is flaky. A test that is not in the second run keeps its first
// status.
function settle(first, second) {
  const tests = new Map();
  for (const [name, status] of first) {
    const again = second.get(name);
    const disagree = (status === 'failed' && again === 'passed') || (status === 'passed' && again === 'failed');
    tests.set(name, disagree ? 'flaky' : status);
  }
  return tests;
}

function testName(item, roots) {
  let file = item.file;
  if (file && isAbsolute(file)) {
    const root = roots.find((path) => file === path || file.startsWith(path + sep));
    if (root) file = relative(root, file).split(sep).join('/');
  }
  return [file, item.classname, item.name].filter((part) => part !== '').join(' > ');
}

// Runs the command in a shell. It drops NODE_TEST_CONTEXT, which node:test sets when Exhibit
// itself runs under node:test. With it, a node:test run in the command sends its results to that
// parent run and writes no JUnit file.
function shell(command, cwd, env) {
  const clean = { ...env };
  delete clean.NODE_TEST_CONTEXT;
  return new Promise((done) => {
    const child = spawn(command, { cwd, env: clean, shell: true, stdio: 'ignore' });
    child.on('error', () => done({ code: 127, signal: null }));
    child.on('close', (code, signal) => done({ code, signal }));
  });
}

function exitWords(exit) {
  return exit.signal ? `stopped by the signal ${exit.signal}` : `exit code ${exit.code}`;
}

async function removeWorktree(cwd, folder) {
  await run('git', ['worktree', 'remove', '--force', '--force', folder], { cwd }).catch(() => {});
  await rm(folder, { recursive: true, force: true });
  await run('git', ['worktree', 'prune'], { cwd }).catch(() => {});
}

// The tests-before-after collector (spec 8.1 and 9.3). It is `met` when every test passes on the
// head, apart from flaky ones, and `failed` when a test fails on the head. The gap names the
// failing tests. It gives back the flaky tests of both sides in `flaky_tests`.
export async function testsBeforeAfter(requirement, context) {
  let runs;
  try {
    runs = await context.testRuns();
  } catch (error) {
    if (!(error instanceof TestRunError)) throw error;
    return { status: error.status, details: { message: error.message }, how_to_fix: error.howToFix };
  }
  const flaky = [...new Set([...namesWith(runs.base, 'flaky'), ...namesWith(runs.head, 'flaky')])].sort();
  const failing = namesWith(runs.head, 'failed').sort();
  const details = { base: counts(runs.base), head: counts(runs.head), failed_on_head: failing };

  if (runs.head.size === 0) {
    return { status: 'missing', details, flaky_tests: flaky, how_to_fix: 'The test command ran on the head, but its JUnit file lists no tests. Check that settings.test_command finds the tests.' };
  }
  if (failing.length > 0) {
    const shown = failing.slice(0, LISTED).join('; ');
    const more = failing.length > LISTED ? `; and ${failing.length - LISTED} more` : '';
    return {
      status: 'failed',
      details,
      flaky_tests: flaky,
      how_to_fix: `${failing.length} ${failing.length === 1 ? 'test fails' : 'tests fail'} on the head, also when run again: ${shown}${more}. Fix the change so that ${failing.length === 1 ? 'it passes' : 'they pass'}, and run exhibit check again.`
    };
  }
  return { status: 'met', details, flaky_tests: flaky };
}

function namesWith(tests, status) {
  return [...tests].filter(([, value]) => value === status).map(([name]) => name);
}

function counts(tests) {
  const out = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const status of tests.values()) out[status] += 1;
  return out;
}
