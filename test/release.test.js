import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { versionProblems } from '../scripts/check-version.js';

// The release workflow (docs/spec.md section 10, "Releases"). A person pushes a version tag such
// as v0.1.0, and the workflow makes a GitHub release that the field repos pin (spec 12).

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
const script = join(root, 'scripts/check-version.js');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the release workflow runs on a pushed version tag only, never on a branch or a PR', () => {
  assert.deepEqual(Object.keys(workflow.on), ['push']);
  assert.deepEqual(workflow.on.push, { tags: ['v[0-9]+.[0-9]+.[0-9]+'] });
});

test('the release workflow grants nothing by default, and its one job may only write contents', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ['release']);
  // contents: write makes the release and moves the major tag. Nothing else is needed.
  assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write' });
  const checkout = workflow.jobs.release.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
});

test('the release job checks the version, lints, tests and builds before it makes the release', () => {
  const runs = workflow.jobs.release.steps.map((step) => step.run ?? step.uses);
  const at = (pattern) => {
    const index = runs.findIndex((run) => pattern.test(run));
    assert.ok(index >= 0, `no step matches ${pattern}`);
    return index;
  };
  const release = at(/gh release create/);
  for (const before of [/check-version\.js "\$TAG"$/m, /^npm run lint$/, /^npm test$/, /npm ci --omit=dev --ignore-scripts/]) {
    assert.ok(at(before) < release, `${before} runs after the release is made`);
  }
  assert.ok(at(/git\/refs\/tags/) > release, 'the major tag moves before the release is made');
});

test('versionProblems gives nothing when the tag, package.json and exhibit --version agree', () => {
  assert.deepEqual(versionProblems({ tag: 'v0.1.0', packageVersion: '0.1.0', cliVersion: '0.1.0' }), []);
});

test('versionProblems names each version that differs from the tag', () => {
  assert.deepEqual(versionProblems({ tag: 'v0.2.0', packageVersion: '0.1.0', cliVersion: '0.1.0' }), [
    'package.json has version 0.1.0, but the tag is v0.2.0. Set "version": "0.2.0" in package.json, or push the tag v0.1.0.',
    'exhibit --version prints 0.1.0, but the tag is v0.2.0.'
  ]);
  assert.deepEqual(versionProblems({ tag: 'v0.1.0', packageVersion: '0.1.0', cliVersion: '' }), ['exhibit --version prints "", but the tag is v0.1.0.']);
});

test('versionProblems refuses a tag that is not v and three numbers', () => {
  for (const tag of ['0.1.0', 'v0.1', 'v0', 'v0.1.0-rc.1', 'main', '']) {
    assert.deepEqual(versionProblems({ tag, packageVersion: '0.1.0', cliVersion: '0.1.0' }), [`The tag "${tag}" is not a version tag such as v1.2.3.`], tag);
  }
});

test('the script exits 0 for the tag of this package.json, and runs the real CLI to check', () => {
  const run = spawnSync(process.execPath, [script, `v${version}`], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `The tag v${version}, package.json and exhibit --version all say ${version}.\n`);
});

test('the script exits 1, with the reason, for a tag that differs from package.json', () => {
  const run = spawnSync(process.execPath, [script, 'v99.0.0'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^::error::package\.json has version \S+, but the tag is v99\.0\.0\./m);
  assert.match(run.stderr, /^::error::exhibit --version prints \S+, but the tag is v99\.0\.0\.$/m);
});

test('the script exits 2 without a tag', () => {
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage: node scripts\/check-version\.js <tag> \[<exhibit folder>\]/);
});
