import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExhibit, renderSummary } from '../src/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { changedLines, judge, mutationCollector, readOutcome, testsThatReach } from '../src/mutation.js';
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

test('when Stryker fails, here because a test fails on the head, the verdict is error, never meets_policy', async (t) => {
  // min 0 would pass any catch rate, so only the error can stop meets_policy.
  const fixture = buildRepo(t, { policyText: policy({ min: 0 }), heads: { broken: { 'src/inside.js': NEW_CODE, 'test/inside.test.js': FAILING_TEST } } });
  const run = exhibitCheck(fixture, 'broken');
  assert.equal(run.status, 2, run.stderr + run.stdout);
  const evidence = JSON.parse(read(fixture.repo, 'evidence.json'));
  assert.equal(evidence.verdict, 'error');
  assert.equal(evidence.requirements[0].status, 'error');
  assert.match(evidence.gaps[0].how_to_fix, /\.exhibit\/mutation\/output\.log/);
  assert.match(read(fixture.repo, 'mutation/output.log'), /failed/i);
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

test('the collector does not run Stryker when nothing can be mutated, or the policy cannot say how', async (t) => {
  const never = mutationCollector({ runStryker: async () => assert.fail('Stryker should not run') });
  const docs = collectorRepo(t, { 'README.md': 'more\n', 'test/inside.test.js': WEAK_TEST });
  const met = await never({ params: { min: 0.9 } }, docs);
  assert.equal(met.status, 'met');
  assert.match(met.details.reason, /nothing to mutate/);

  const python = collectorRepo(t, { 'tool/run.py': 'print(1)\n', 'src/inside.js': NEW_CODE });
  const skipped = await never({ params: { min: 0.9 } }, python);
  assert.equal(skipped.status, 'skipped');
  assert.deepEqual(skipped.details.no_adapter, ['tool/run.py']);

  const noGlobs = collectorRepo(t, { 'src/inside.js': NEW_CODE }, {});
  const missing = await never({ params: { min: 0.9 } }, noGlobs);
  assert.equal(missing.status, 'missing');
  assert.match(missing.how_to_fix, /mutation_test_files/);
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
