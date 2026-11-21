import { baseErrorDetails, NothingLoaded, TestRunError } from './test-runs.js';

const LISTED = 20;

// Says whether a changed path is a test file: a file named like a test (`*.test.*`, `*.spec.*`,
// `test_*.py`, `*_test.*`), or a file in a folder named test, tests, __tests__ or spec. Files in
// those folders, such as helpers and fixtures, count too, because a new test can need them.
export function isTestPath(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  if (/\.(test|spec)\.[^/]+$/.test(name) || /^test_.*\.py$/.test(name) || /_test\.[^/.]+$/.test(name)) return true;
  return parts.slice(0, -1).some((folder) => ['test', 'tests', '__tests__', 'spec'].includes(folder));
}

// The failing-before collector (spec 8.1 and 9.4). It proves that a test in the PR would have
// caught the problem: the test fails on the old code and passes on the new.
//
// The PR's test files are the changed files that look like tests (isTestPath), or that the head's
// JUnit file names as a test's file. Exhibit runs the tests on the base code with those files
// put in as they are on the head (context.baseWithPrTests). A test qualifies when:
// - the PR added or changed it: its file is one of the PR's test files, or its name is not in the
//   plain base run, or its status there differs from the run with the PR's test files. Only the
//   PR's test files differ between those two runs, so a test whose result changed is the PR's.
// - it fails in the run with the PR's test files, or its file could not load there. A file that
//   cannot load, for example because it imports a module the base lacks, shows as one failed test
//   case named after the file, as node:test writes it. The tests in that file then do not run.
//   Many tools stop the whole command instead, such as `tsc && node --test`, or Go, where one test
//   file that does not compile stops its package. When that run fails and gives no failing test
//   (a NothingLoaded), a PR test file counts as not loaded when the JUnit file has no result from
//   it. A test that is there ran on the base, and counts as in any run. A test that is not there
//   is the PR's only when its file is a PR test file, or the plain base run does not have it.
//   Without a file in the names (Node 20), a PR test that is not there counts only when no PR
//   test is there: else Exhibit cannot tell which file stopped, so a person must check.
// - it passes on the head.
// - it is not flaky in any of the three runs.
//
// It is `met` with the qualifying tests listed, and `missing` when no test qualifies. It is also
// `missing` when a run on the base gives no results, for example because the PR changes the test
// tools: then Exhibit cannot show that a test fails on the base, so a person must check. The gap
// says why the base run failed. A head that gives no results is `error`, as for
// tests-before-after.
export async function failingBefore(requirement, context) {
  let runs;
  let overlay;
  let testFiles;
  try {
    runs = await context.testRuns();
    testFiles = prTestFiles(context.files, runs.head);
    if (runs.baseError && testFiles.length > 0) return cannotCheck(runs.baseError, testFiles);
    if (testFiles.length > 0) {
      try {
        overlay = await context.baseWithPrTests(testFiles);
      } catch (error) {
        if (error instanceof TestRunError && error.status === 'error') return cannotCheck(error, testFiles);
        throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof TestRunError)) throw error;
    return { status: error.status, details: { message: error.message }, how_to_fix: error.howToFix };
  }

  if (testFiles.length === 0) {
    return {
      status: 'missing',
      details: { test_files: [], tests: [], passed_on_base: [], did_not_load_on_base: [] },
      flaky_tests: [],
      how_to_fix: 'The change adds or changes no test file, so no test shows that it fixes or adds anything. Add a test that fails without the change and passes with it, and run exhibit check again.'
    };
  }

  const nothingLoaded = overlay instanceof NothingLoaded ? overlay : null;
  if (nothingLoaded) overlay = nothingLoaded.tests;
  const flaky = new Set([...namesWith(runs.base, 'flaky'), ...namesWith(runs.head, 'flaky'), ...namesWith(overlay, 'flaky')]);
  const fileOf = (name) => testFiles.find((file) => name.startsWith(`${file} > `));
  const didNotLoad = nothingLoaded
    ? testFiles.filter((file) => ![...overlay.keys()].some((name) => fileOf(name) === file))
    : testFiles.filter((file) => [...overlay].some(([name, status]) => status === 'failed' && namesFile(name, file)));
  // With nothing loaded, a test with no file counts as not loaded only when no PR test ran.
  const prTestRan = nothingLoaded !== null && [...overlay.keys()].some((name) => fileOf(name) !== undefined || !runs.base.has(name));

  const tests = [];
  const passedOnBase = [];
  for (const [name, status] of [...runs.head].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (status !== 'passed' || flaky.has(name)) continue;
    const file = fileOf(name);
    const onBase = overlay.get(name);
    // With nothing loaded, a test that has no result there gives nothing to compare with the
    // plain base run.
    const theirs = file !== undefined || !runs.base.has(name) || (!(nothingLoaded && onBase === undefined) && runs.base.get(name) !== onBase);
    if (!theirs) continue;
    if (onBase === 'failed') {
      tests.push({ name, on_base: 'failed' });
    } else if (onBase === undefined && didNotLoad.length > 0 && (file === undefined ? !prTestRan : didNotLoad.includes(file))) {
      // Without a file in the test's name (Node 20's reporter gives none), Exhibit cannot tell
      // which file the test is in, so it names every PR test file that did not load.
      tests.push({ name, on_base: 'did_not_load', files: file === undefined ? didNotLoad : [file] });
    } else if (onBase === 'passed') {
      passedOnBase.push(name);
    }
  }

  const flakyHere = [...flaky].sort();
  const details = { test_files: testFiles, tests, passed_on_base: passedOnBase, did_not_load_on_base: didNotLoad };
  if (nothingLoaded) details.base_with_pr_tests_error = nothingLoaded.message;
  if (tests.length > 0) return { status: 'met', details, flaky_tests: flakyHere };

  const shown = passedOnBase.slice(0, LISTED).join('; ');
  const more = passedOnBase.length > LISTED ? `; and ${passedOnBase.length - LISTED} more` : '';
  const why = passedOnBase.length > 0
    ? `${passedOnBase.length} ${passedOnBase.length === 1 ? 'test that the change adds or changes passes' : 'tests that the change adds or changes pass'} on the base too, so ${passedOnBase.length === 1 ? 'it does' : 'they do'} not show the problem: ${shown}${more}.`
    : 'No test that the change adds or changes fails on the base and passes on the head.';
  return {
    status: 'missing',
    details,
    flaky_tests: flakyHere,
    how_to_fix: `${why} Add a test that fails without the change and passes with it, and run exhibit check again. A flaky test never counts.`
  };
}

// failing-before when a run on the base gave no results: `missing`, with the base's error.
function cannotCheck(error, testFiles) {
  return {
    status: 'missing',
    details: { test_files: testFiles, tests: [], passed_on_base: [], did_not_load_on_base: [], base_error: baseErrorDetails(error) },
    flaky_tests: [],
    how_to_fix: `The tests gave no results on the base, so Exhibit cannot show that a test fails there and passes on the head. ${error.howToFix} If the change adds or changes the test tools, the base cannot run the tests, so a person must check that a test in the change shows the problem.`
  };
}

// The changed files that are test files, sorted: by their name (isTestPath), or because the
// head's JUnit file names them as the file of a test.
function prTestFiles(files, head) {
  const changed = new Set(files);
  const named = new Set();
  for (const name of head.keys()) {
    const file = name.split(' > ')[0];
    if (changed.has(file)) named.add(file);
  }
  return [...changed].filter((path) => isTestPath(path) || named.has(path)).sort();
}

// A failed test case that stands for a whole file is named after the file. The last part of the
// name is its path, relative or absolute.
function namesFile(name, file) {
  const last = name.split(' > ').at(-1);
  return last === file || last.endsWith(`/${file}`);
}

function namesWith(tests, status) {
  return [...tests].filter(([, value]) => value === status).map(([name]) => name);
}

// A line for summary.md that names the tests found, and why each counts.
export function describeTests(details) {
  const tests = details.tests ?? [];
  if (tests.length === 0) return '';
  const words = tests.slice(0, LISTED).map((test) => test.on_base === 'failed'
    ? `${test.name} (fails on the base)`
    : `${test.name} (its file did not load on the base: ${test.files.join(', ')})`);
  const more = tests.length > LISTED ? `, and ${tests.length - LISTED} more` : '';
  return ` Tests that fail on the base and pass on the head: ${words.join('; ')}${more}.`;
}
