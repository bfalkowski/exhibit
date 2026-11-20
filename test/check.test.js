import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExhibit, EXIT_CODES, renderSummary } from '../src/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { testsBeforeAfter } from '../src/test-runs.js';

const SETTINGS = { fix_signals: ['label:bug', 'title:fix', 'branch:fix/'] };
const policyWith = (needs, kinds = {}) => ({ settings: SETTINGS, kinds, default: { risk: 'medium', needs } });

const met = async () => ({ status: 'met', details: {} });
const ALL_MET = { 'tests-before-after': met, 'failing-before': met, probe: met, mutation: met };

function input(policy, files = ['src/app.js'], extra = {}) {
  return {
    policy,
    policyFile: { path: 'evidence.yml', sha256: 'a'.repeat(64) },
    files,
    pr: { title: '', labels: [], branch: 'task/x' },
    signalsFrom: 'branch',
    repo: 'owner/name',
    prNumber: null,
    base: '1'.repeat(40),
    head: '2'.repeat(40),
    ...extra
  };
}

const options = (collectors) => ({ collectors, environment: { node: '20.x', os: 'linux' }, now: () => new Date('2026-11-19T10:00:00Z'), clock: () => 0 });

test('every requirement met gives meets_policy and exit 0', async () => {
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after', { probe: { name: 'p', run: 'x' } }])), options(ALL_MET));
  assert.equal(exhibit.verdict, 'meets_policy');
  assert.deepEqual(exhibit.gaps, []);
  assert.equal(EXIT_CODES[exhibit.verdict], 0);
  assert.deepEqual(checkExhibit(exhibit), []);
});

test('a skipped requirement gives needs_person, not meets_policy', async () => {
  const collectors = { ...ALL_MET, probe: async () => ({ status: 'skipped', details: {}, how_to_fix: 'Run it.' }) };
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after', { probe: { name: 'p', run: 'x' } }])), options(collectors));
  assert.equal(exhibit.verdict, 'needs_person');
  assert.equal(EXIT_CODES[exhibit.verdict], 1);
  assert.deepEqual(exhibit.gaps, [{ type: 'probe', name: 'p', status: 'skipped', how_to_fix: 'Run it.' }]);
});

test('a collector that throws gives verdict error and exit 2, never meets_policy', async () => {
  const collectors = { ...ALL_MET, 'tests-before-after': async () => { throw new Error('disk on fire'); } };
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after'])), options(collectors));
  assert.equal(exhibit.verdict, 'error');
  assert.equal(EXIT_CODES[exhibit.verdict], 2);
  assert.equal(exhibit.requirements[0].status, 'error');
  assert.match(exhibit.gaps[0].how_to_fix, /disk on fire/);
  assert.deepEqual(checkExhibit(exhibit), []);
});

test('a collector that gives back no valid status is an error too', async () => {
  const collectors = { ...ALL_MET, 'tests-before-after': async () => ({ status: 'great' }) };
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after'])), options(collectors));
  assert.equal(exhibit.verdict, 'error');
});

test('an error wins over a missing requirement', async () => {
  const collectors = { ...ALL_MET, 'tests-before-after': async () => ({ status: 'missing', details: {} }), mutation: async () => ({ status: 'error', details: {} }) };
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after', { mutation: { min: 0.5 } }])), options(collectors));
  assert.equal(exhibit.verdict, 'error');
});

test('a change to evidence.yml gives needs_person, with a gap that says why', async () => {
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after']), ['evidence.yml']), options(ALL_MET));
  assert.equal(exhibit.verdict, 'needs_person');
  assert.equal(exhibit.gaps.length, 1);
  assert.equal(exhibit.gaps[0].type, 'policy-change');
  assert.match(exhibit.gaps[0].how_to_fix, /evidence\.yml/);
});

test('the built-in collectors skip what is not built yet, so mutation can never give meets_policy', async () => {
  const exhibit = await buildExhibit(input(policyWith([{ mutation: { min: 0.7 } }, 'tests-before-after', 'failing-before', { probe: { name: 'p', run: 'x' } }])), { ...options(undefined), collectors: undefined });
  assert.equal(exhibit.verdict, 'needs_person');
  // tests-before-after is built. With no test command in the policy, its evidence is missing.
  assert.deepEqual(exhibit.requirements.map((item) => item.status), ['skipped', 'missing', 'skipped', 'skipped']);
  assert.match(exhibit.gaps[0].how_to_fix, /S6/);
  assert.match(exhibit.gaps[1].how_to_fix, /settings\.test_command/);
  assert.match(exhibit.gaps[2].how_to_fix, /not built yet/);
});

test('the tests run once, however many collectors ask, and flaky tests from collectors are listed', async () => {
  let runs = 0;
  const runTests = async () => {
    runs += 1;
    return { base: new Map([['t > a', 'passed']]), head: new Map([['t > a', 'passed'], ['t > b', 'flaky']]) };
  };
  const reuse = async (requirement, context) => {
    await context.testRuns();
    return { status: 'met', details: {}, flaky_tests: ['t > z'] };
  };
  const collectors = { ...ALL_MET, 'tests-before-after': testsBeforeAfter, 'failing-before': reuse };
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after', 'failing-before'])), { ...options(collectors), runTests });
  assert.equal(runs, 1);
  assert.deepEqual(exhibit.requirements.map((item) => item.status), ['met', 'met']);
  assert.deepEqual(exhibit.flaky_tests, ['t > b', 't > z']);
});

test('no matching kind and no default gives needs_person', async () => {
  const exhibit = await buildExhibit(input({ settings: SETTINGS, kinds: {} }), options(ALL_MET));
  assert.equal(exhibit.verdict, 'needs_person');
  assert.equal(exhibit.gaps[0].type, 'no-rule');
});

test('a kind that needs nothing gives meets_policy', async () => {
  const kinds = { notes: { match: ['notes/**'], risk: 'low', needs: [], merge_without_reading: 'allowed' } };
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after'], kinds), ['notes/a.md']), options(ALL_MET));
  assert.equal(exhibit.verdict, 'meets_policy');
  assert.deepEqual(exhibit.requirements, []);
});

test('checks_by_author counts the requirements of each author', async () => {
  const exhibit = await buildExhibit(input(policyWith(['tests-before-after', { probe: { name: 'h', run: 'x', author: 'hidden' } }])), options(ALL_MET));
  assert.deepEqual(exhibit.checks_by_author, { builder: 1, hidden: 1 });
});

test('the summary lists each gap with how to fix it, and says when only the branch was known', async () => {
  const exhibit = await buildExhibit(input(policyWith([{ mutation: { min: 0.7 } }]), ['evidence.yml']), options(undefined));
  const summary = renderSummary(exhibit);
  assert.match(summary, /needs_person/);
  assert.match(summary, /exit code 1/);
  assert.match(summary, /mutation: skipped\. /);
  assert.match(summary, /policy-change/);
  assert.match(summary, /only the branch name/i);
  assert.match(summary, /--pr/);
});

test('the summary does not speak of default rules when the policy has none', async () => {
  const exhibit = await buildExhibit(input({ settings: SETTINGS, kinds: {} }), options(ALL_MET));
  const summary = renderSummary(exhibit);
  assert.match(summary, /has no default, so no rule covers this change/);
  assert.doesNotMatch(summary, /default rules apply/);
});
