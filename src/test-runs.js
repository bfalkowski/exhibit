import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseJUnit } from './junit.js';
import { runInGroup } from './probe.js';

const run = promisify(execFile);
const LISTED = 20;

// The time limit for one run of the test command when the policy does not set
// settings.test_timeout_seconds: 30 minutes.
export const DEFAULT_TEST_TIMEOUT_SECONDS = 1800;

// The folder in the clone for the output of each run of the test command, such as
// .exhibit/tests/head-first.log.
export const TESTS_DIR = '.exhibit/tests';

// A test run that could not give results. `status` is the requirement status it leads to:
// `missing` when the policy gives no test command, and `error` when the command could not run,
// wrote no JUnit file, or ran past the time limit settings.test_timeout_seconds. `howToFix` says
// what to do, in plain words. When the head fails and the base failed first, `baseError` holds
// the base's error.
export class TestRunError extends Error {
  name = 'TestRunError';
  baseError = null;
  constructor(status, message, howToFix) {
    super(message);
    this.status = status;
    this.howToFix = howToFix;
  }
}

// The run on the base with the PR's test files gave no results because the command failed:
// it wrote no JUnit file, or the file names no failing test. Only the PR's test files differ from
// the plain base run, which gave results, so they broke the command. Most often a new test does
// not compile or load on the base, for example when it uses a function or type that the base lacks
// (spec 9.4). `message` says what the command did, and names the log of the run. `tests` holds
// the results that the JUnit file gave, like one side of runTestsOnBaseAndHead, with no failed
// test. It is empty when the command wrote no JUnit file. A test there ran on the base, so only a
// PR test file with no result there did not load.
export class NothingLoaded {
  constructor(message, tests = new Map()) {
    this.message = message;
    this.tests = tests;
  }
}

// A run on the base, or on the base with the PR's test files, that ran past the time limit
// settings.test_timeout_seconds (spec 9.3 and 9.4). Exhibit stopped it, so the tests that had not
// finished have no result. `tests` holds the results of the tests that finished, like one side of
// runTestsOnBaseAndHead. They come from the JUnit file when the stopped run left one that Exhibit
// can read. Most runners write that file only at the end, so it is often empty. A test with no
// result counts as failed there: it hung, or it waited behind a test that hung. `message` and
// `howToFix` say what happened, and name the log of the run.
export class TimedOut {
  constructor(message, howToFix, tests = new Map()) {
    this.message = message;
    this.howToFix = howToFix;
    this.tests = tests;
  }
}

// The base's error as it goes in a requirement's details: its message and what to do.
export function baseErrorDetails(error) {
  return { message: error.message, how_to_fix: error.howToFix };
}

// Runs the test command on the base and on the head (spec 9.3).
//
// For each side it makes a clean git worktree of the commit, runs settings.test_command in it,
// and reads the JUnit XML at settings.test_results. When a test fails, it runs the command once
// more. Each run has the time limit settings.test_timeout_seconds. When a run passes it, Exhibit
// stops the command and every process it started. It removes each worktree when the side is done,
// also when the run fails or is stopped. The output of each run goes to a log in TESTS_DIR in the
// clone: base-first.log, base-again.log, head-first.log and head-again.log.
//
// It gives back { base, head, baseError, baseTimedOut }: for each side a Map from a test's name to its status,
// `passed`, `failed`, `skipped` or `flaky`. A test is flaky when its two runs disagree. The name is
// the test's file (relative to the worktree), its classname and its name, joined by " > ". A part
// that the JUnit file leaves out is left out.
//
// The base can fail to give results when the PR changes the test tools: the base has no such
// tools yet. That says nothing about the head, so Exhibit still runs the head. Then `base` is null
// and `baseError` is the TestRunError of the base. Otherwise `baseError` is null.
// A base run past the time limit gives no error: `base` holds the tests that finished, and
// `baseTimedOut` is the TimedOut of the base. Otherwise `baseTimedOut` is null. A head run past
// the time limit is a head that cannot give results.
// It throws a TestRunError when the settings are wrong, or when the head cannot give results.
export async function runTestsOnBaseAndHead({ cwd, base, head, settings = {}, env = process.env }) {
  const { command, results, timeoutSeconds } = checkSettings(settings);
  let baseTests = null;
  let baseError = null;
  let baseTimedOut = null;
  try {
    baseTests = await runSide({ cwd, sha: base, side: 'base', command, results, timeoutSeconds, env, mayHang: true });
    if (baseTests instanceof TimedOut) {
      baseTimedOut = baseTests;
      baseTests = baseTimedOut.tests;
    }
  } catch (error) {
    if (!(error instanceof TestRunError)) throw error;
    baseError = error;
  }
  try {
    const headTests = await runSide({ cwd, sha: head, side: 'head', command, results, timeoutSeconds, env });
    return { base: baseTests, head: headTests, baseError, baseTimedOut };
  } catch (error) {
    if (error instanceof TestRunError && baseError) error.baseError = baseError;
    throw error;
  }
}

// Runs the test command on the base code with the PR's test files (spec 9.4). It makes a clean
// worktree of the base, puts in each path of `paths` as it is on the head, removes each one that
// the head does not have, and then runs the tests as runTestsOnBaseAndHead does. So a test that
// the PR added or changed runs against the old code. It gives back one Map, like one side of
// runTestsOnBaseAndHead. When the command fails and gives no failing test, on both runs with the
// same results, it gives back a NothingLoaded instead. When a run passes the time limit, it gives
// back a TimedOut. It throws a TestRunError when the run cannot
// give results for any other reason, and when only one run stops that way, or the two runs that
// stop give different results: the run is then flaky. Its logs are
// base-pr-tests-first.log and base-pr-tests-again.log.
export async function runTestsOnBaseWithPrTests({ cwd, base, head, paths, settings = {}, env = process.env }) {
  const { command, results, timeoutSeconds } = checkSettings(settings);
  return runSide({ cwd, sha: base, side: 'base with the PR\'s test files', tag: 'base-pr-tests', command, results, timeoutSeconds, env, mayHang: true, overlay: { sha: head, paths } });
}

function checkSettings(settings) {
  const command = settings.test_command;
  const results = settings.test_results;
  if (!command || !results) {
    throw new TestRunError('missing', 'the policy has no settings.test_command or no settings.test_results',
      'The policy needs evidence from the tests, but evidence.yml does not say how to run them. Set settings.test_command to a command that runs the tests and writes JUnit XML, and settings.test_results to the path of that file.');
  }
  // Exhibit removes the results file before each run, so it must be a file in the worktree. The
  // path is resolved against a stand-in root, so "./" and "a/..//" count as the root itself.
  const root = resolve(sep, 'worktree');
  const inside = relative(root, resolve(root, results));
  if (isAbsolute(results) || inside === '' || inside === '..' || inside.startsWith('..' + sep)) {
    throw new TestRunError('error', `settings.test_results is not a path in the worktree: ${results}`,
      `settings.test_results in evidence.yml is "${results}", which is not a file inside the repo. Exhibit removes that file before each run, so it must be a path in the repo, such as .exhibit/junit.xml. Change it, and run exhibit check again.`);
  }
  return { command, results, timeoutSeconds: settings.test_timeout_seconds ?? DEFAULT_TEST_TIMEOUT_SECONDS };
}

// One side: a Map, or with `overlay` a NothingLoaded, or with `mayHang` a TimedOut.
async function runSide({ cwd, sha, side, tag = side, command, results, timeoutSeconds, env, overlay, mayHang = false }) {
  const logs = join(cwd, TESTS_DIR);
  await mkdir(logs, { recursive: true });
  const log = (run) => ({ file: join(logs, `${tag}-${run}.log`), shown: `${TESTS_DIR}/${tag}-${run}.log` });
  const folder = await mkdtemp(join(tmpdir(), `exhibit-${tag}-`));
  try {
    try {
      await run('git', ['worktree', 'add', '--detach', '--quiet', folder, sha], { cwd, encoding: 'utf8' });
    } catch (error) {
      const reason = String(error.stderr ?? '').trim().split('\n')[0] || error.message;
      throw new TestRunError('error', `could not make a worktree for the ${side}: ${reason}`, `Exhibit could not make a clean git worktree for the ${side} commit ${sha.slice(0, 7)}: ${reason}. Check that the commit is in the clone, and run exhibit check again.`);
    }
    if (overlay) await putFiles(folder, overlay);
    const roots = [folder, await realpath(folder)];
    // Only the run with the PR's test files can give back a NothingLoaded.
    const once = (run) => runOnce({ folder, roots, side, command, results, timeoutSeconds, env, log: log(run), mayNotLoad: Boolean(overlay), mayHang });
    const first = await once('first');
    // A run past the time limit counts as a failing run, so the command runs once more.
    if (first instanceof Map && ![...first.values()].includes('failed')) return first;
    const second = await once('again');
    if (first instanceof NothingLoaded || second instanceof NothingLoaded) {
      // A run that stops counts only when the other run stops the same way, with the same results.
      if (first instanceof NothingLoaded && second instanceof NothingLoaded && sameTests(first.tests, second.tests)) return first;
      const words = `on its first run ${runWords(first)}, and on its second run ${runWords(second)}`;
      throw new TestRunError('error', `the two runs of the test command on the ${side} differ, so it is flaky: ${words}`,
        `The two runs of the test command "${command}" on the ${side} differ: ${words}. So Exhibit cannot tell whether the PR's tests load on the base. Read the output in ${log('first').shown} and ${log('again').shown} to see why the runs differ.`);
    }
    return settle(first, second);
  } finally {
    await removeWorktree(cwd, folder);
  }
}

// Makes each path in the worktree `folder` what it is at the commit `sha`: git checks out the
// paths that the commit has, and Exhibit removes the others.
async function putFiles(folder, { sha, paths }) {
  if (paths.length === 0) return;
  const { stdout } = await run('git', ['ls-tree', '-r', '-z', '--name-only', sha, '--', ...paths], { cwd: folder, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const there = new Set(stdout.split('\0').filter((path) => path !== ''));
  const kept = paths.filter((path) => there.has(path));
  if (kept.length > 0) await run('git', ['checkout', sha, '--', ...kept], { cwd: folder });
  await Promise.all(paths.filter((path) => !there.has(path)).map((path) => rm(join(folder, path), { force: true })));
}

// One run of the test command, read from its JUnit file. The command's output goes to `log.file`,
// and each how_to_fix names it as `log.shown`. With `mayNotLoad`, a command that fails and writes
// no JUnit file, or a file that names no failing test, gives back a NothingLoaded, not an error.
// With `mayHang`, a run past the time limit gives back a TimedOut, not an error.
async function runOnce({ folder, roots, side, command, results, timeoutSeconds, env, log, mayNotLoad = false, mayHang = false }) {
  const file = resolve(folder, results);
  await rm(file, { force: true });
  await mkdir(dirname(file), { recursive: true });
  const exit = await shell(command, folder, env, timeoutSeconds, log.file);
  const read = `Read its output in ${log.shown}`;

  if (exit.timedOut && mayHang) {
    const tests = await finishedTests(file, roots);
    const finished = tests.size === 0 ? 'it left no JUnit file that names a test' : `its JUnit file names ${tests.size} ${tests.size === 1 ? 'test' : 'tests'} that finished`;
    return new TimedOut(`the test command ran past the time limit of ${timeoutSeconds} seconds on the ${side}, so Exhibit stopped it, and ${finished}. Read its output in ${log.shown}`,
      `The test command "${command}" ran past the time limit of ${timeoutSeconds} seconds (settings.test_timeout_seconds) on the ${side}, so Exhibit stopped it and every process it started. A test may hang there, for example one that waits for a server or for input. ${read} to see where it stops. If the tests only need more time, raise settings.test_timeout_seconds in evidence.yml.`,
      tests);
  }
  if (exit.timedOut) {
    throw new TestRunError('error', `the test command ran past the time limit of ${timeoutSeconds} seconds on the ${side}, so Exhibit stopped it`,
      `The test command "${command}" ran past the time limit of ${timeoutSeconds} seconds (settings.test_timeout_seconds) on the ${side}, so Exhibit stopped it and every process it started. A test may hang, for example one that waits for a server or for input. ${read} to see where it stops. If the tests only need more time, raise settings.test_timeout_seconds in evidence.yml.`);
  }

  if (exit.code === 127) {
    throw new TestRunError('error', `the test command could not run on the ${side}: the shell could not find it (exit code 127)`,
      `The test command "${command}" could not run on the ${side}: the shell could not find it (exit code 127). ${read}. Check settings.test_command in evidence.yml, and that the tools it needs are installed.`);
  }
  let xml;
  try {
    xml = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (mayNotLoad && exit.code !== 0) return new NothingLoaded(`the test command failed on the ${side} (${exitWords(exit)}) and wrote no JUnit file at ${results}. Read its output in ${log.shown}`);
    throw new TestRunError('error', `the test command wrote no JUnit file at ${results} on the ${side} (${exitWords(exit)})`,
      `The test command "${command}" ran on the ${side} (${exitWords(exit)}), but it wrote no JUnit file at ${results}. ${read}. Make the command write JUnit XML to settings.test_results, for example with node --test --test-reporter=junit --test-reporter-destination=${results}.`);
  }
  let cases;
  try {
    cases = parseJUnit(xml);
  } catch (error) {
    throw new TestRunError('error', `could not read ${results} on the ${side}: ${error.message}`, `Exhibit could not read ${results} on the ${side}: ${error.message}. ${read}. Make the test command write JUnit XML there.`);
  }
  const tests = toTests(cases, roots);
  if (exit.code !== 0 && ![...tests.values()].includes('failed')) {
    if (mayNotLoad) return new NothingLoaded(`the test command failed on the ${side} (${exitWords(exit)}), but ${results} names no failing test. Read its output in ${log.shown}`, tests);
    throw new TestRunError('error', `the test command failed on the ${side} (${exitWords(exit)}), but ${results} names no failing test`,
      `The test command "${command}" failed on the ${side} (${exitWords(exit)}), but ${results} names no failing test, so Exhibit cannot tell what broke. ${read} to see why it fails.`);
  }
  return tests;
}

const RANK = { skipped: 0, passed: 1, failed: 2 };

function toTests(cases, roots) {
  const tests = new Map();
  for (const item of cases) {
    const name = testName(item, roots);
    const old = tests.get(name);
    // Two test cases with one name: a failure wins over a pass, and a pass over a skip.
    if (!old || RANK[item.status] > RANK[old]) tests.set(name, item.status);
  }
  return tests;
}

// The tests that finished in a run that Exhibit stopped: the ones its JUnit file names. A file
// that is not there, or that Exhibit cannot read, for example one cut off while it was written,
// names none.
async function finishedTests(file, roots) {
  try {
    return toTests(parseJUnit(await readFile(file, 'utf8')), roots);
  } catch {
    return new Map();
  }
}

function sameTests(a, b) {
  return a.size === b.size && [...a].every(([name, status]) => b.get(name) === status);
}

// What one run of the test command on the base with the PR's test files gave, in words.
function runWords(result) {
  if (result instanceof TimedOut) return `it ran past the time limit with results for ${result.tests.size} ${result.tests.size === 1 ? 'test' : 'tests'}`;
  if (!(result instanceof NothingLoaded)) return `it gave results for ${result.size} ${result.size === 1 ? 'test' : 'tests'}`;
  if (result.tests.size === 0) return 'it failed and gave no results';
  return `it failed with results for ${result.tests.size} ${result.tests.size === 1 ? 'test' : 'tests'} and no failing test`;
}

// A test whose two runs disagree is flaky. A test that is not in the second run keeps its first
// status. A run past the time limit (a TimedOut) has no result for a test that had not finished:
// that test counts as failed there, so it is flaky when it passed on the other run, and keeps the
// other run's result when that is a fail or a skip. When either run passed the time limit, the
// result is a TimedOut too, with the words of the run that passed it, so the side still counts as
// one that hung.
function settle(first, second) {
  const hungFirst = first instanceof TimedOut;
  const hungSecond = second instanceof TimedOut;
  const one = hungFirst ? first.tests : first;
  const two = hungSecond ? second.tests : second;
  const names = hungFirst || hungSecond ? new Set([...one.keys(), ...two.keys()]) : one.keys();
  const tests = new Map();
  for (const name of names) {
    const status = one.get(name);
    const again = two.get(name);
    if (status === undefined && hungFirst) tests.set(name, again === 'passed' ? 'flaky' : again);
    else if (again === undefined && hungSecond) tests.set(name, status === 'passed' ? 'flaky' : status);
    else {
      const disagree = (status === 'failed' && again === 'passed') || (status === 'passed' && again === 'failed');
      tests.set(name, disagree ? 'flaky' : status ?? again);
    }
  }
  const hung = hungFirst ? first : hungSecond ? second : null;
  return hung ? new TimedOut(hung.message, hung.howToFix, tests) : tests;
}

function testName(item, roots) {
  let file = item.file;
  if (file && isAbsolute(file)) {
    const root = roots.find((path) => file === path || file.startsWith(path + sep));
    if (root) file = relative(root, file).split(sep).join('/');
  }
  return [file, item.classname, item.name].filter((part) => part !== '').join(' > ');
}

// Runs the command in a shell, in a process group of its own, as a probe runs (spec 9.6). When it
// runs past `timeoutSeconds`, Exhibit kills the whole group, so no process of the tests keeps
// running, and gives back timedOut: true. It kills the group after a normal exit too. The
// command's standard output and standard error go to `logFile`. runInGroup drops
// NODE_TEST_CONTEXT from `env`.
async function shell(command, cwd, env, timeoutSeconds, logFile) {
  try {
    return await runInGroup(command, { cwd, env, logFile, timeoutMs: timeoutSeconds * 1000 });
  } catch (error) {
    // The shell itself could not start. Count it as a command the shell could not find. Any other
    // error, such as one from opening the log, is not about the command, so it goes up as it is.
    if (!String(error.syscall ?? '').startsWith('spawn')) throw error;
    return { code: 127, signal: null, timedOut: false };
  }
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
// failing tests. It gives back the flaky tests of both sides in `flaky_tests`. Only the head
// decides the status, so when the base gives no results, details.base is null and
// details.base_error says why. When the base run passed the time limit, details.base counts only
// the tests that finished there, and details.base_timed_out says so.
export async function testsBeforeAfter(requirement, context) {
  let runs;
  try {
    runs = await context.testRuns();
  } catch (error) {
    if (!(error instanceof TestRunError)) throw error;
    const details = { message: error.message, ...(error.baseError ? { base_error: baseErrorDetails(error.baseError) } : {}) };
    return { status: error.status, details, how_to_fix: error.howToFix };
  }
  const base = runs.base ?? new Map();
  const flaky = [...new Set([...namesWith(base, 'flaky'), ...namesWith(runs.head, 'flaky')])].sort();
  const failing = namesWith(runs.head, 'failed').sort();
  const details = { base: runs.base ? counts(runs.base) : null, head: counts(runs.head), failed_on_head: failing };
  if (runs.baseError) details.base_error = baseErrorDetails(runs.baseError);
  if (runs.baseTimedOut) details.base_timed_out = baseErrorDetails(runs.baseTimedOut);

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
  // No test passed on the head, only skipped or flaky ones, or none at all: the run shows
  // nothing, so a person must check the tests.
  if (details.head.passed === 0) {
    return { status: 'missing', details, flaky_tests: flaky, how_to_fix: 'The test command ran on the head, but no test passed there: its JUnit file lists no tests, or only skipped or flaky ones. Check that settings.test_command finds the tests.' };
  }
  return { status: 'met', details, flaky_tests: flaky };
}

// A line for summary.md that says the base gave no results, so only the head counts. When the
// head gave no results too (status `error`), the gap gives the head's error, so this line only
// says that the base failed as well.
export function describeBaseError(details, status) {
  if (details.base_timed_out) return ` The tests ran past the time limit on the base, so its counts give only the tests that finished: ${details.base_timed_out.message}.`;
  if (!details.base_error) return '';
  if (status === 'error') return ` The tests gave no results on the base either: ${details.base_error.message}.`;
  return ` The tests gave no results on the base, so only the head counts: ${details.base_error.message}.`;
}

function namesWith(tests, status) {
  return [...tests].filter(([, value]) => value === status).map(([name]) => name);
}

function counts(tests) {
  const out = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const status of tests.values()) out[status] += 1;
  return out;
}
