import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judge } from '../src/backtest.js';
import { parsePolicy } from '../src/policy.js';
import { CHEAP, rerun } from '../src/rerun.js';

const POLICY = parsePolicy(`
version: 3
settings:
  mutation_budget_seconds: 30
default:
  risk: medium
  needs:
    - tests-before-after
    - probe: { name: ready, run: "test -f ready.txt" }
    - mutation: { min: 0.5 }
`);

function line(number) {
  return {
    number,
    title: `Change ${number}`,
    body: null,
    labels: [],
    merged_at: '2026-02-01T12:00:00Z',
    base_sha: 'b'.repeat(40),
    head_sha: String(number).padStart(40, '0'),
    url: `https://github.com/acme/widgets/pull/${number}`,
    files: [{ path: `src/${number}.js`, additions: 1, deletions: 1 }],
    classification: { fix: false, fix_signal: null, kinds: [] },
    szz: null
  };
}

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-rerun-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A clock that moves on `step` seconds each time a collector runs, and collectors that give
// `statusOf(pr, type)`. A status of 'throw' throws, as a broken collector does.
function fakeRun(statusOf, step = 10) {
  let now = 0;
  const calls = [];
  const collectorsFor = (head) => {
    const pr = Number(head);
    const one = (type) => async () => {
      now += step * 1000;
      calls.push(`${pr} ${type}`);
      const status = statusOf(pr, type);
      if (status === 'throw') throw new Error(`the ${type} run broke`);
      return { status, details: {} };
    };
    return { collectors: { 'tests-before-after': one('tests-before-after'), 'failing-before': one('failing-before'), probe: one('probe'), mutation: one('mutation') }, done: async () => {} };
  };
  return { collectorsFor, clock: () => now, calls };
}

test('the cheap requirements are tests-before-after, failing-before and probes, not mutation', () => {
  assert.deepEqual([...CHEAP], ['tests-before-after', 'failing-before', 'probe']);
});

test('a collector error on one PR gives that PR error, and the next PR still runs', async (t) => {
  const lines = [line(1), line(2), line(3)];
  const fake = fakeRun((pr, type) => (pr === 2 && type === 'tests-before-after' ? 'throw' : 'met'), 1);
  const results = await rerun({ cwd: folder(t), env: {}, lines, policies: [POLICY], budgetSeconds: 1000, collectorsFor: fake.collectorsFor, clock: fake.clock, hasCommit: async () => true });

  assert.equal(results.get(1).status, 'ran');
  assert.equal(results.get(2).status, 'error');
  assert.deepEqual(results.get(2).errors, ['tests-before-after: the tests-before-after run broke']);
  assert.equal(results.get(3).status, 'ran');
  // An error tells nothing, so judge reads the body (none here) and the requirement is unknown.
  const judged = judge(lines[1], POLICY, null, results.get(2));
  assert.deepEqual(judged.requirements.map((item) => [item.type, item.status, item.from]), [['tests-before-after', 'unknown', 'none'], ['probe', 'met', 'rerun'], ['mutation', 'met', 'rerun']]);
});

test('the budget stops the rerun before a PR, a PR that started finishes, and mutation runs only while a whole run fits', async (t) => {
  const lines = [line(1), line(2), line(3)];
  // Each collector takes 10 seconds. The budget is 50: PR 1 takes 20 (tests and probe), PR 2 takes
  // 20 more, so PR 3 starts at 40 and finishes at 60. Then 0 seconds are left, less than the
  // mutation budget of 30, so mutation does not run.
  const fake = fakeRun(() => 'met');
  const results = await rerun({ cwd: folder(t), env: {}, lines, policies: [POLICY], budgetSeconds: 50, collectorsFor: fake.collectorsFor, clock: fake.clock, hasCommit: async () => true });
  assert.deepEqual(fake.calls, ['1 tests-before-after', '1 probe', '2 tests-before-after', '2 probe', '3 tests-before-after', '3 probe']);
  assert.deepEqual([1, 2, 3].map((pr) => [results.get(pr).status, results.get(pr).mutation]), [['ran', 'not_reached'], ['ran', 'not_reached'], ['ran', 'not_reached']]);

  // With a budget of 70, 30 seconds are left after the cheap pass: room for one mutation run with
  // its budget of 30 seconds. That run takes 10, so 20 are left, too few for a second one.
  const more = fakeRun(() => 'met');
  const wider = await rerun({ cwd: folder(t), env: {}, lines: lines.slice(0, 2), policies: [POLICY], budgetSeconds: 70, collectorsFor: more.collectorsFor, clock: more.clock, hasCommit: async () => true });
  assert.deepEqual(more.calls, ['1 tests-before-after', '1 probe', '2 tests-before-after', '2 probe', '1 mutation']);
  assert.equal(wider.get(1).mutation, 'ran');
  assert.equal(wider.get(2).mutation, 'not_reached');
  // The second pass does not run the cheap requirements again.
  assert.deepEqual(wider.get(1).requirements.map((item) => item.type).sort(), ['mutation', 'probe', 'tests-before-after']);

  const short = fakeRun(() => 'met');
  const none = await rerun({ cwd: folder(t), env: {}, lines, policies: [POLICY], budgetSeconds: 15, collectorsFor: short.collectorsFor, clock: short.clock, hasCommit: async () => true });
  assert.deepEqual([1, 2, 3].map((pr) => none.get(pr).status), ['ran', 'not_reached', 'not_reached']);
});

test('a PR whose commits are not in the clone runs nothing, and one whose exhibit gives everything has nothing to run', async (t) => {
  const lines = [line(1), line(2)];
  const exhibit = { requirements: ['tests-before-after', 'mutation'].map((type) => ({ type, params: type === 'mutation' ? { min: 0.5 } : {}, status: 'met' })).concat({ type: 'probe', params: { name: 'ready', run: 'test -f ready.txt' }, status: 'met' }) };
  const fake = fakeRun(() => 'met');
  const results = await rerun({ cwd: folder(t), env: {}, lines, policies: [POLICY], exhibits: new Map([[2, exhibit]]), budgetSeconds: 1000, collectorsFor: fake.collectorsFor, clock: fake.clock, hasCommit: async (cwd, sha) => sha !== line(1).head_sha });
  assert.equal(results.get(1).status, 'no_commits');
  assert.equal(results.get(1).mutation, null);
  assert.equal(results.get(2).status, 'nothing_to_run');
  assert.deepEqual(fake.calls, []);
});

test('judge takes met, missing and failed from a rerun, and the rerun wins over the body', () => {
  const body = { ...line(4), body: '## Evidence\n\n- npm test passes.\n- `test -f ready.txt` passes.\n' };
  const rerunResult = { requirements: [
    { type: 'tests-before-after', params: {}, status: 'failed' },
    { type: 'probe', params: { name: 'ready', run: 'test -f ready.txt' }, status: 'met' },
    { type: 'mutation', params: { min: 0.5 }, status: 'skipped' }
  ] };
  const before = judge(body, POLICY, null);
  assert.deepEqual(before.requirements.map((item) => [item.status, item.from]), [['met', 'body'], ['met', 'body'], ['missing', 'body']]);
  const after = judge(body, POLICY, null, rerunResult);
  assert.deepEqual(after.requirements.map((item) => [item.status, item.from]), [['missing', 'rerun'], ['met', 'rerun'], ['missing', 'body']]);
  assert.equal(after.basis, 'rerun');
  assert.deepEqual(after.missing, ['tests-before-after', 'mutation 0.5']);
});
