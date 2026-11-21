import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExhibit, renderSummary } from '../src/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { mutationCollector } from '../src/mutation.js';
import { MUTMUT_VERSION, mutmutStatus, pythonProjects, readMutmutOutcome } from '../src/mutmut.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();
const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));

// The Python that has mutmut and pytest: EXHIBIT_TEST_MUTMUT_PYTHON, as CI sets it, or python3.
// The tests that run mutmut for real skip when python3 has no mutmut 3.8.1. When
// EXHIBIT_TEST_MUTMUT_PYTHON is set, they never skip, so CI cannot pass without running them.
const PYTHON = process.env.EXHIBIT_TEST_MUTMUT_PYTHON ?? 'python3';
const hasMutmut = spawnSync(PYTHON, ['-c', `import importlib.metadata as m; assert m.version('mutmut') == '${MUTMUT_VERSION}'; import pytest`], { encoding: 'utf8' }).status === 0;
const skipWithoutMutmut = hasMutmut || process.env.EXHIBIT_TEST_MUTMUT_PYTHON ? false : `python3 has no mutmut ${MUTMUT_VERSION} and pytest. Set EXHIBIT_TEST_MUTMUT_PYTHON to a Python that has them.`;

// The same bug as in test/mutation.test.js, in Python: "starts with the root" also let
// "/repos/shopping" through when the root was "/repos/shop". The fix adds the "/" boundary.
// The function twice does not change, so mutmut must not mutate it.
const UNCHANGED = `def twice(x):
    return x * 2


`;
const OLD_CODE = `${UNCHANGED}def inside(root, path):
    return path.startswith(root)
`;
// The fix on line 6, and a new function on lines 9 and 10 that the weak test never calls.
const NEW_CODE = `${UNCHANGED}def inside(root, path):
    return path == root or path.startswith(root + "/")


def label(path):
    return "in:" + path
`;
const WEAK_TEST = `from shop.inside import inside


def test_a_path_in_the_root_is_inside():
    assert inside("/repos/shop", "/repos/shop/a")
`;
const STRONG_TEST = `from shop.inside import inside, label


def test_the_root_and_a_path_in_it_are_inside():
    assert inside("/repos/shop", "/repos/shop")
    assert inside("/repos/shop", "/repos/shop/a")


def test_a_neighbor_that_starts_with_the_same_letters_is_not_inside():
    assert not inside("/repos/shop", "/repos/shopping")
    assert not inside("/repos/shop", "/repos/other")


def test_label():
    assert label("a") == "in:a"


# State that lives as long as the test process, as an in-memory store does. The test passes in a
# fresh process only. If mutmut ran the tests in a process that had run them before, it would fail.
_RUNS = []


def test_runs_in_a_fresh_process():
    _RUNS.append(1)
    assert len(_RUNS) == 1
`;
const FAILING_TEST = WEAK_TEST.replace('assert inside', 'assert not inside');
// A test that takes far longer than any budget in these tests. It writes its process ID to the
// folder PID_DIR, so the test can check that the process is gone after the run.
const SLOW_TEST = `import os
import time

from shop.inside import inside


def test_slow():
    open(os.path.join(os.environ["PID_DIR"], str(os.getpid())), "w").close()
    inside("/a", "/a")
    time.sleep(600)
`;

function policy({ min = 0.9, budget = 120 } = {}) {
  return `version: 3
settings:
  mutation_python: "${PYTHON}"
  mutation_budget_seconds: ${budget}
default:
  risk: medium
  needs:
    - mutation: { min: ${min} }
`;
}

// A repo with a Python project in the folder py, as edd-platform has its API in apps/api. The old
// code is on main (tag start), with one branch for each head.
function buildRepo(t, { policyText = policy(), heads }) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-mutmut-'));
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
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', path);
    }
    tick += 1;
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit({ 'evidence.yml': policyText, 'py/pyproject.toml': '[project]\nname = "shop"\nversion = "0.1.0"\n', 'py/shop/__init__.py': '', 'py/shop/inside.py': OLD_CODE, 'README.md': 'hi\n' }, 'start');
  git('tag', 'start');
  for (const [name, files] of Object.entries(heads)) {
    git('checkout', '-q', '-b', name, 'start');
    commit(files, name);
  }
  git('checkout', '-q', 'main');
  const sha = (ref) => git('rev-parse', ref).trim();
  return { repo, home, sha };
}

const exhibitCheck = ({ repo, home }, head, extra = {}) => spawnSync(process.execPath, [bin, 'check', '--base', 'start', '--head', head], { cwd: repo, encoding: 'utf8', env: gitEnv(home, extra) });
const read = (repo, file) => readFileSync(join(repo, '.exhibit', file), 'utf8');

test('on a Python change, a weak test needs a person with its survivors listed, and a strong test meets the policy', { skip: skipWithoutMutmut }, (t) => {
  const fixture = buildRepo(t, {
    heads: {
      weak: { 'py/shop/inside.py': NEW_CODE, 'py/tests/test_inside.py': WEAK_TEST },
      strong: { 'py/shop/inside.py': NEW_CODE, 'py/tests/test_inside.py': STRONG_TEST }
    }
  });

  const weak = exhibitCheck(fixture, 'weak');
  assert.equal(weak.status, 1, weak.stderr + weak.stdout);
  const weakEvidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(weakEvidence), []);
  assert.equal(weakEvidence.verdict, 'needs_person');
  const item = weakEvidence.requirements[0];
  assert.equal(item.status, 'failed');
  assert.equal(item.details.complete, true);
  // Only the changed lines are mutated, not the unchanged function twice on lines 1 and 2.
  assert.deepEqual(item.details.mutated, [{ path: 'py/shop/inside.py', lines: [[6, 10]] }]);
  assert.deepEqual(item.details.mutmut, [{ project: 'py', output: '.exhibit/mutation/mutmut-py.log', complete: true }]);
  assert.ok(item.details.n > 0);
  for (const mutant of [...item.details.survivors, ...item.details.no_coverage_mutants]) assert.ok([6, 10].includes(mutant.line), JSON.stringify(mutant));
  // The mutant that brings the bug back in another way: "!=" lets a path through that is not the root.
  assert.ok(item.details.survivors.some((mutant) => mutant.file === 'py/shop/inside.py' && mutant.line === 6 && mutant.replacement.includes('!=')), JSON.stringify(item.details.survivors));
  // No test calls label, so its mutants count as survived, and are listed apart.
  assert.ok(item.details.no_coverage > 0);
  assert.ok(item.details.no_coverage_mutants.every((mutant) => mutant.line === 10), JSON.stringify(item.details.no_coverage_mutants));
  assert.equal(item.details.catch_rate, (item.details.killed + item.details.timeout) / item.details.n);
  assert.ok(item.details.catch_rate < 0.9);
  assert.match(weakEvidence.gaps[0].how_to_fix, /survived/);
  const summary = read(fixture.repo, 'summary.md');
  assert.match(summary, /mutation \(from default\): failed\. Catch rate /);
  assert.match(summary, /Survived, though a test ran the line:\n {4}- py\/shop\/inside\.py:6 /);
  assert.match(summary, /Survived, because no test ran the line:\n {4}- py\/shop\/inside\.py:10 /);
  assert.match(read(fixture.repo, 'mutation/mutmut-py.log'), /Running mutation testing/);

  const strong = exhibitCheck(fixture, 'strong');
  assert.equal(strong.status, 0, strong.stderr + strong.stdout);
  const strongEvidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(strongEvidence), []);
  assert.equal(strongEvidence.verdict, 'meets_policy');
  assert.equal(strongEvidence.requirements[0].status, 'met');
  assert.equal(strongEvidence.requirements[0].details.survived, 0);
  assert.equal(strongEvidence.requirements[0].details.no_coverage, 0);
  assert.equal(strongEvidence.requirements[0].details.n, item.details.n);
});

test('when mutmut fails, here because a test fails on the head, the verdict is error, never meets_policy', { skip: skipWithoutMutmut }, (t) => {
  // min 0 would pass any catch rate, so only the error can stop meets_policy.
  const fixture = buildRepo(t, { policyText: policy({ min: 0 }), heads: { broken: { 'py/shop/inside.py': NEW_CODE, 'py/tests/test_inside.py': FAILING_TEST } } });
  const run = exhibitCheck(fixture, 'broken');
  assert.equal(run.status, 2, run.stderr + run.stdout);
  const evidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(evidence), []);
  assert.equal(evidence.verdict, 'error');
  assert.equal(evidence.requirements[0].status, 'error');
  assert.match(evidence.gaps[0].how_to_fix, /mutmut exited with code 1 in py before it had tested every mutant/);
  assert.match(evidence.gaps[0].how_to_fix, /\.exhibit\/mutation\/mutmut-py\.log/);
  assert.match(read(fixture.repo, 'mutation/mutmut-py.log'), /test_a_path_in_the_root_is_inside/);
});

test('the budget stops mutmut and every process it started', { skip: skipWithoutMutmut }, (t) => {
  const fixture = buildRepo(t, { policyText: policy({ budget: 15 }), heads: { slow: { 'py/shop/inside.py': NEW_CODE, 'py/tests/test_inside.py': SLOW_TEST } } });
  const pids = join(fixture.home, 'pids');
  mkdirSync(pids);
  const started = Date.now();
  const run = exhibitCheck(fixture, 'slow', { PID_DIR: pids });
  assert.ok(Date.now() - started < 90000, `the run took ${Date.now() - started} ms`);
  // The slow test started, and Exhibit stopped it with mutmut.
  const testPids = readdirSync(pids).map(Number);
  assert.ok(testPids.length > 0);
  for (const pid of testPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `the test process ${pid} is still running`);
  assert.equal(run.status, 1, run.stderr + run.stdout);
  const evidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.deepEqual(checkExhibit(evidence), []);
  const item = evidence.requirements[0];
  assert.equal(item.status, 'missing');
  assert.equal(item.details.complete, false);
  assert.equal(item.details.n, 0);
  assert.match(evidence.gaps[0].how_to_fix, /budget of 15 seconds/);
});

test('a Python without mutmut, or a command that starts no Python, gives error', async (t) => {
  const fixture = buildRepo(t, { heads: { change: { 'py/shop/inside.py': NEW_CODE, 'py/tests/test_inside.py': WEAK_TEST } } });
  const context = (python) => ({ cwd: fixture.repo, base: fixture.sha('start'), head: fixture.sha('change'), settings: { mutation_python: python }, env: gitEnv(fixture.home) });
  // A Python with no mutmut in it: the driver says so.
  const plain = spawnSync('python3', ['-I', '-c', 'import mutmut'], { env: gitEnv(fixture.home) }).status !== 0;
  if (plain) {
    const noMutmut = await mutationCollector()({ params: { min: 0 } }, context('python3 -I'));
    assert.equal(noMutmut.status, 'error');
    assert.match(noMutmut.how_to_fix, /mutmut is not installed/);
    assert.match(noMutmut.how_to_fix, /settings\.mutation_python/);
  }
  const missing = await mutationCollector()({ params: { min: 0 } }, context('no-such-python-here'));
  assert.equal(missing.status, 'error');
  assert.match(missing.how_to_fix, /mutmut exited with code 127/);
  assert.match(missing.how_to_fix, /"no-such-python-here"/);
});

// A mutant as the driver lists it.
const listed = (name, line, file = 'shop/a.py') => ({ name, file, line, column: 5, mutator: 'swap_op', original: 'a == b', replacement: 'a != b' });
const meta = (codes) => JSON.stringify({ exit_code_by_key: codes, hash_by_function_name: {}, type_check_error_by_key: {}, durations_by_key: {}, estimated_durations_by_key: {} });
const driverText = (...lines) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

test('mutmut\'s exit codes count as Exhibit counts Stryker\'s statuses: timeouts as killed, no tests as not covered', () => {
  assert.equal(mutmutStatus(1), 'Killed');
  assert.equal(mutmutStatus(0), 'Survived');
  assert.equal(mutmutStatus(33), 'NoCoverage');
  for (const code of [24, -24, 36, 152, 255]) assert.equal(mutmutStatus(code), 'Timeout');
  assert.equal(mutmutStatus(-11), 'RuntimeError');
  assert.equal(mutmutStatus(37), 'CompileError');
  assert.equal(mutmutStatus(34), 'Ignored');
  // mutmut calls any other code suspicious. It counts as survived, so it errs toward needs_person.
  assert.equal(mutmutStatus(4), 'Survived');
  // Not finished.
  assert.equal(mutmutStatus(null), null);
  assert.equal(mutmutStatus(2), null);
});

test('a mutmut run is complete when the driver wrote its done line, mutmut exited 0, and every mutant has a result', () => {
  const mutants = [listed('shop.a.x_f__mutmut_1', 3), listed('shop.a.x_f__mutmut_2', 4)];
  const done = readMutmutOutcome(driverText({ mutants }, { done: true }), { 'shop/a.py': meta({ 'shop.a.x_f__mutmut_1': 1, 'shop.a.x_f__mutmut_2': 0 }) }, { code: 0, signal: null, timedOut: false });
  assert.equal(done.complete, true);
  assert.deepEqual(done.mutants.map((mutant) => [mutant.line, mutant.status]), [[3, 'Killed'], [4, 'Survived']]);
  assert.deepEqual(done.mutants[0], { file: 'shop/a.py', line: 3, column: 5, mutator: 'swap_op', original: 'a == b', replacement: 'a != b', status: 'Killed' });

  // The budget ran out: the driver's last line and the .meta file can be cut short. The mutants
  // that have a result are a sample.
  const cut = readMutmutOutcome(driverText({ mutants }) + '{"do', { 'shop/a.py': meta({ 'shop.a.x_f__mutmut_1': 1, 'shop.a.x_f__mutmut_2': null }) }, { code: null, signal: 'SIGKILL', timedOut: true });
  assert.equal(cut.complete, false);
  assert.equal(cut.timedOut, true);
  assert.deepEqual(cut.mutants.map((mutant) => mutant.status), ['Killed']);
  const cutMeta = readMutmutOutcome(driverText({ mutants }), { 'shop/a.py': '{"exit_code_by' }, { code: null, signal: 'SIGKILL', timedOut: true });
  assert.deepEqual(cutMeta.mutants, []);

  // mutmut exited 1 before its done line: not complete, and not stopped by the budget.
  const failed = readMutmutOutcome(driverText({ mutants }), { 'shop/a.py': meta({ 'shop.a.x_f__mutmut_1': null, 'shop.a.x_f__mutmut_2': null }) }, { code: 1, signal: null, timedOut: false });
  assert.equal(failed.complete, false);
  assert.equal(failed.timedOut, false);
});

test('a mutmut run whose .meta file names other mutants than the driver listed, or a bad line, throws', () => {
  const mutants = [listed('shop.a.x_f__mutmut_1', 3)];
  assert.throws(() => readMutmutOutcome(driverText({ mutants }, { done: true }), { 'shop/a.py': meta({ 'shop.a.x_f__mutmut_1': 1, 'shop.a.x_f__mutmut_2': 1 }) }, { code: 0, signal: null, timedOut: false }), /other mutants in shop\/a\.py/);
  assert.throws(() => readMutmutOutcome('{"mutants\n', {}, { code: 0, signal: null, timedOut: false }), /not JSON/);
  assert.throws(() => readMutmutOutcome(driverText({ mutants }), { 'shop/a.py': '{' }, { code: 0, signal: null, timedOut: false }), /is not JSON/);
});

test('pythonProjects finds the nearest folder with a pyproject.toml, setup.cfg or setup.py', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'exhibit-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['apps/api/pyproject.toml', 'apps/api/pkg/a.py', 'libs/one/setup.cfg', 'libs/one/one/b.py', 'scripts/c.py']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  return pythonProjects(root, [
    { path: 'apps/api/pkg/a.py', lines: [[1, 2]] },
    { path: 'libs/one/one/b.py', lines: [[3, 3]] },
    { path: 'scripts/c.py', lines: [[4, 4]] }
  ]).then((projects) => {
    assert.deepEqual([...projects], [
      ['apps/api', [{ path: 'pkg/a.py', lines: [[1, 2]] }]],
      ['libs/one', [{ path: 'one/b.py', lines: [[3, 3]] }]],
      ['', [{ path: 'scripts/c.py', lines: [[4, 4]] }]]
    ]);
  });
});

// A stand-in for mutmut that gives `codes` for the mutants of py/shop/inside.py.
const fakeMutmut = (calls, outcome) => async (options) => {
  calls.push(options);
  return outcome;
};
const mutmutMutants = (statuses) => statuses.map((status, i) => ({ file: 'shop/inside.py', line: 2, column: i + 1, mutator: 'swap_op', original: 'a', replacement: 'b', status }));

test('the mutmut part needs no settings.mutation_test_files, gets the budget, and its partial run is judged on its sample', async (t) => {
  const fixture = buildRepo(t, { heads: { change: { 'py/shop/inside.py': NEW_CODE, 'py/tests/test_inside.py': WEAK_TEST } } });
  const context = { cwd: fixture.repo, base: fixture.sha('start'), head: fixture.sha('change'), settings: { mutation_budget_seconds: 30 }, env: gitEnv(fixture.home) };
  const calls = [];
  const runMutmut = fakeMutmut(calls, { mutants: mutmutMutants([...Array(29).fill('Killed'), 'Survived']), complete: false, timedOut: true, code: null, signal: 'SIGKILL' });
  const result = await mutationCollector({ runMutmut, runStryker: async () => assert.fail('Stryker should not run') })({ params: { min: 0.8 } }, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project, 'py');
  assert.deepEqual(calls[0].files, [{ path: 'shop/inside.py', lines: [[6, 10]] }]);
  assert.equal(calls[0].python, 'python3');
  assert.equal(calls[0].budgetSeconds, 30);
  assert.equal(result.status, 'met');
  assert.equal(result.details.complete, false);
  assert.equal(result.details.n, 30);
  assert.equal(result.details.mutmut[0].complete, false);
  // 29 of 30 killed: the lower bound of the interval, 0.83, reaches 0.8.
  assert.equal(result.details.catch_rate, 0.9667);
  // The mutant's file is relative to the repo, not to the project.
  assert.deepEqual(result.details.survivors.map((mutant) => mutant.file), ['py/shop/inside.py']);
});

test('a change with JavaScript and Python runs Stryker and mutmut, and counts their mutants together', async (t) => {
  const fixture = buildRepo(t, { heads: { change: { 'py/shop/inside.py': NEW_CODE, 'src/inside.js': 'export const a = 1;\n', 'test/inside.test.js': "import '../src/inside.js';\n" } } });
  const context = { cwd: fixture.repo, base: fixture.sha('start'), head: fixture.sha('change'), settings: { mutation_test_files: ['test/*.test.js'] }, env: gitEnv(fixture.home) };
  const runStryker = async (options) => ({ mutants: [{ fileName: join(options.root, 'src/inside.js'), location: { start: { line: 1, column: 18 }, end: { line: 1, column: 19 } }, mutatorName: 'NumberLiteral', replacement: '0', status: 'Survived' }], complete: true, timedOut: false, code: 0 });
  const runMutmut = fakeMutmut([], { mutants: mutmutMutants(['Killed', 'Killed', 'Timeout']), complete: true, timedOut: false, code: 0 });
  const result = await mutationCollector({ runStryker, runMutmut })({ params: { min: 0.7 } }, context);
  assert.equal(result.status, 'met');
  assert.equal(result.details.n, 4);
  assert.equal(result.details.catch_rate, 0.75);
  assert.deepEqual(result.details.survivors.map((mutant) => mutant.file), ['src/inside.js']);
  assert.deepEqual(result.details.timeout_mutants.map((mutant) => mutant.file), ['py/shop/inside.py']);
  assert.deepEqual(result.details.test_files, ['test/inside.test.js']);
  assert.equal(result.details.output, '.exhibit/mutation/output.log');
  assert.deepEqual(result.details.mutmut, [{ project: 'py', output: '.exhibit/mutation/mutmut-py.log', complete: true }]);
});

test('a mutmut run that crashes, stops, or leaves out a changed file never meets the policy', async (t) => {
  const fixture = buildRepo(t, { heads: { change: { 'py/shop/inside.py': NEW_CODE } } });
  const context = { cwd: fixture.repo, base: fixture.sha('start'), head: fixture.sha('change'), settings: {}, env: gitEnv(fixture.home) };
  const collectors = [
    mutationCollector({ runMutmut: async () => { throw new Error('mutmut crashed'); } }),
    mutationCollector({ runMutmut: fakeMutmut([], { mutants: mutmutMutants(['Killed']), complete: false, timedOut: false, code: 1, signal: null }) }),
    mutationCollector({ runMutmut: fakeMutmut([], { mutants: [], complete: false, timedOut: false, code: 3, signal: null, error: 'mutmut is not installed.' }) })
  ];
  for (const collector of collectors) {
    const exhibit = await buildExhibit({
      policy: { settings: { fix_signals: [] }, kinds: {}, default: { risk: 'medium', needs: [{ mutation: { min: 0 } }] } },
      policyFile: { path: 'evidence.yml', sha256: null },
      files: ['py/shop/inside.py'],
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
    assert.match(renderSummary(exhibit), /Exhibit failed|mutmut/);
  }

  const leftOut = await mutationCollector({ runMutmut: fakeMutmut([], { mutants: [], complete: false, timedOut: false, code: 4, signal: null, leftOut: ['shop/inside.py'], sourcePaths: ['other'] }) })({ params: { min: 0 } }, context);
  assert.equal(leftOut.status, 'missing');
  assert.deepEqual(leftOut.details.left_out, ['py/shop/inside.py']);
  assert.match(leftOut.how_to_fix, /source_paths are other/);
  assert.match(leftOut.how_to_fix, /add it to settings\.mutation_test_files/);
});

test('settings.mutation_test_files leaves a Python file out of mutation, as the left-out gap says', async (t) => {
  const fixture = buildRepo(t, { heads: { change: { 'py/shop/inside.py': NEW_CODE, 'py/conftest.py': 'import os\n' } } });
  const context = { cwd: fixture.repo, base: fixture.sha('start'), head: fixture.sha('change'), settings: { mutation_test_files: ['py/conftest.py'] }, env: gitEnv(fixture.home) };
  const calls = [];
  const result = await mutationCollector({ runMutmut: fakeMutmut(calls, { mutants: mutmutMutants(['Killed']), complete: true, timedOut: false, code: 0 }) })({ params: { min: 0.5 } }, context);
  assert.deepEqual(calls[0].files.map((file) => file.path), ['shop/inside.py']);
  assert.deepEqual(result.details.mutated.map((file) => file.path), ['py/shop/inside.py']);
});
