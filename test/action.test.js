import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { readPolicy } from '../src/policy.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

// The GitHub Action (spec 10) must stay a thin wrapper: action.yml maps inputs to CLI flags, and
// the CLI's exit code is the step's exit code. These tests read action.yml and run its own shell
// script, with a stand-in node that records its arguments, or with the real CLI on a small repo.

dropGitEnv();
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const action = parse(readFileSync(join(root, 'action.yml'), 'utf8'));
// The example that another repo copies, Exhibit's own workflow, which runs on Exhibit's PRs, and
// the workflow in each field repo's setup note (spec 12). The same checks hold for each one.
const FIELD_REPOS = ['building58', 'edd-platform'];
const WORKFLOWS = ['examples/pull-request.yml', '.github/workflows/exhibit.yml', ...FIELD_REPOS.map((repo) => `examples/${repo}/exhibit.yml`)];
const readWorkflow = (path) => parse(readFileSync(join(root, path), 'utf8'));
const preload = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
const runStep = action.runs.steps.find((step) => step.name.startsWith('Run exhibit'));
const summaryStep = action.runs.steps.find((step) => step.name === 'Show the summary');

test('action.yml is a composite action with exactly the inputs of spec 10, and the token', () => {
  assert.equal(action.runs.using, 'composite');
  assert.deepEqual(Object.keys(action.inputs), ['command', 'policy', 'data-branch', 'comment', 'enforce', 'token']);
  assert.equal(action.inputs.command.default, 'check');
  assert.equal(action.inputs.enforce.default, 'false');
  assert.equal(action.inputs.token.default, '${{ github.token }}');
});

test('each input reaches the run step only as an env variable, never pasted into the script', () => {
  assert.deepEqual(runStep.env, {
    INPUT_COMMAND: '${{ inputs.command }}',
    INPUT_POLICY: '${{ inputs.policy }}',
    INPUT_DATA_BRANCH: '${{ inputs.data-branch }}',
    INPUT_COMMENT: '${{ inputs.comment }}',
    INPUT_ENFORCE: '${{ inputs.enforce }}',
    GITHUB_TOKEN: '${{ inputs.token }}',
    PR_NUMBER: '${{ github.event.pull_request.number }}'
  });
  // An expression in a script is pasted in before bash runs, so a value could become a command.
  for (const step of action.runs.steps) assert.doesNotMatch(step.run ?? '', /\$\{\{/, step.name);
});

test('no step decides anything: the steps are install, run, summary and upload, and each condition is only the command', () => {
  assert.deepEqual(action.runs.steps.map((step) => step.name), ['Install Exhibit', 'Run exhibit ${{ inputs.command }}', 'Show the summary', 'Upload the exhibit']);
  assert.equal(action.runs.steps[0].run, 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund');
  assert.equal(summaryStep.run, 'cat .exhibit/summary.md >> "$GITHUB_STEP_SUMMARY"');
  const conditions = action.runs.steps.map((step) => step.if ?? null);
  assert.deepEqual(conditions, [null, null, "${{ !cancelled() && inputs.command == 'check' }}", "${{ !cancelled() && inputs.command == 'check' }}"]);
  const upload = action.runs.steps[3];
  assert.equal(upload.uses, 'actions/upload-artifact@v4');
  assert.deepEqual(upload.with.path.trim().split('\n'), ['.exhibit/evidence.json', '.exhibit/summary.md', '.exhibit/probes/']);
  // The run step ends by handing over to the CLI, so its exit code is the step's exit code.
  assert.match(runStep.run.trimEnd(), /\nexec node "\$GITHUB_ACTION_PATH\/bin\/exhibit\.js" "\$\{args\[@\]\}"$/);
});

// Runs the run step's script with bash. `node` is the first `node` on PATH, so a test can put a
// stand-in there.
function runScript(script, { inputs = {}, env = {}, cwd, pathDir }) {
  const all = { command: 'check', policy: 'evidence.yml', 'data-branch': '', comment: 'false', enforce: 'false', ...inputs };
  return spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      INPUT_COMMAND: all.command,
      INPUT_POLICY: all.policy,
      INPUT_DATA_BRANCH: all['data-branch'],
      INPUT_COMMENT: all.comment,
      INPUT_ENFORCE: all.enforce,
      GITHUB_TOKEN: 'test-token',
      PR_NUMBER: '7',
      GITHUB_REPOSITORY: 'owner/name',
      GITHUB_ACTION_PATH: root,
      ...env,
      // Last, so the stand-in node always comes first.
      PATH: `${pathDir}${delimiter}${env.PATH ?? process.env.PATH}`,
      // A real token could reach GitHub if the stand-in were missed. This one is refused offline.
      HTTPS_PROXY: 'http://127.0.0.1:9'
    }
  });
}

// A stand-in node that writes its arguments to a file, one on each line, and exits with STUB_EXIT.
function stubNode(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-action-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = join(dir, 'args');
  writeFileSync(join(dir, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nexit "\${STUB_EXIT:-0}"\n`);
  chmodSync(join(dir, 'node'), 0o755);
  const map = (inputs, env = {}) => {
    rmSync(args, { force: true });
    const run = runScript(runStep.run, { inputs, env, cwd: dir, pathDir: dir });
    return { run, argv: existsSync(args) ? readFileSync(args, 'utf8').trimEnd().split('\n') : null };
  };
  return map;
}

const bin = join(root, 'bin', 'exhibit.js');

test('check maps policy to --policy and enforce false to --shadow, with the PR from the event', (t) => {
  const map = stubNode(t);
  assert.deepEqual(map({}).argv, [bin, 'check', '--pr', '7', '--repo', 'owner/name', '--policy', 'evidence.yml', '--shadow']);
  assert.deepEqual(map({ enforce: 'true', policy: 'ci/policy.yml' }).argv, [bin, 'check', '--pr', '7', '--repo', 'owner/name', '--policy', 'ci/policy.yml']);
  // comment and data-branch are for publish. check does not take them.
  assert.deepEqual(map({ comment: 'true', 'data-branch': 'store' }).argv, [bin, 'check', '--pr', '7', '--repo', 'owner/name', '--policy', 'evidence.yml', '--shadow']);
});

test('publish maps data-branch, comment and enforce to their flags, each on its own', (t) => {
  const map = stubNode(t);
  const base = [bin, 'publish', '--evidence', '.exhibit/evidence.json', '--policy', 'evidence.yml'];
  assert.deepEqual(map({ command: 'publish' }).argv, base);
  assert.deepEqual(map({ command: 'publish', 'data-branch': 'store', comment: 'true', enforce: 'true' }).argv, [...base, '--data-branch', 'store', '--comment', '--enforce']);
  assert.deepEqual(map({ command: 'publish', enforce: 'true' }).argv, [...base, '--enforce']);
  // A value with spaces or a $ stays one argument, and nothing in it runs.
  assert.deepEqual(map({ command: 'publish', policy: 'my policy $(touch x).yml' }).argv, [bin, 'publish', '--evidence', '.exhibit/evidence.json', '--policy', 'my policy $(touch x).yml']);
});

test('the step exits with the exit code of the CLI', (t) => {
  const map = stubNode(t);
  for (const code of [0, 1, 2]) assert.equal(map({ enforce: 'true' }, { STUB_EXIT: String(code) }).run.status, code);
});

test('a bad command, comment or enforce fails the step with exit 2 and runs nothing', (t) => {
  const map = stubNode(t);
  for (const [inputs, message] of [
    [{ command: 'trace' }, 'The input command must be check or publish, not "trace".'],
    [{ enforce: 'yes' }, 'The input enforce must be true or false, not "yes".'],
    [{ command: 'publish', comment: 'True' }, 'The input comment must be true or false, not "True".']
  ]) {
    const { run, argv } = map(inputs);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, `::error::${message}\n`);
    assert.equal(argv, null);
  }
});

// The real CLI, through the real script. A repo whose policy needs a probe that fails, so the
// verdict is needs_person, and a recorded GitHub reply for PR 7.
function realRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-action-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const binDir = join(dir, 'bin');
  for (const path of [home, repo, binDir]) mkdirSync(path);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv(home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }) });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'evidence.yml'), 'version: 3\nkinds:\n  notes:\n    match: ["notes/**"]\n    risk: low\n    needs:\n      - probe: { name: lint, run: "exit 1" }\n');
  git('add', '.');
  git('commit', '-q', '-m', 'policy');
  const base = git('rev-parse', 'HEAD').trim();
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'notes', 'one.md'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'notes');
  const head = git('rev-parse', 'HEAD').trim();
  const fixture = join(dir, 'github.json');
  const pull = { number: 7, title: 'Add notes', body: null, labels: [], base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'notes' } };
  writeFileSync(fixture, JSON.stringify({ '/repos/owner/name/pulls/7': { status: 200, body: pull } }));
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\nexec '${process.execPath}' --import '${preload}' "$@"\n`);
  chmodSync(join(binDir, 'node'), 0o755);
  const stepSummary = join(dir, 'step-summary.md');
  const env = { ...gitEnv(home), EXHIBIT_TEST_FIXTURE: fixture, GITHUB_STEP_SUMMARY: stepSummary };
  const runAction = (inputs) => {
    rmSync(stepSummary, { force: true });
    const run = runScript(runStep.run, { inputs, env, cwd: repo, pathDir: binDir });
    // The summary step runs after the run step, whatever its exit code.
    const shown = runScript(summaryStep.run, { inputs, env, cwd: repo, pathDir: binDir });
    assert.equal(shown.status, 0, shown.stderr);
    return { status: run.status, stderr: run.stderr, summary: readFileSync(stepSummary, 'utf8') };
  };
  return { repo, runAction };
}

test('shadow mode: needs_person and error both pass the step, and the job summary shows the verdict', (t) => {
  const { repo, runAction } = realRepo(t);
  const needsPerson = runAction({ enforce: 'false' });
  assert.equal(needsPerson.status, 0, needsPerson.stderr);
  assert.match(needsPerson.summary, /^# Exhibit check: needs a person\n\nVerdict: \*\*needs_person\*\* \(exit code 0\)\.\n\nShadow mode/);
  assert.match(needsPerson.summary, /probe lint/);

  writeFileSync(join(repo, 'evidence.yml'), 'kinds:\n  x:\n    risk: extreme\n');
  const error = runAction({ enforce: 'false' });
  assert.equal(error.status, 0, error.stderr);
  assert.match(error.summary, /^# Exhibit check: Exhibit failed\n\nVerdict: \*\*error\*\* \(exit code 0\)\.\n\nShadow mode/);
  assert.match(error.summary, /evidence\.yml kinds\.x/);
});

test('enforce mode: needs_person and error both fail the step, and the job summary shows the verdict', (t) => {
  const { repo, runAction } = realRepo(t);
  const needsPerson = runAction({ enforce: 'true' });
  assert.equal(needsPerson.status, 1, needsPerson.stderr);
  assert.match(needsPerson.summary, /^# Exhibit check: needs a person\n\nVerdict: \*\*needs_person\*\* \(exit code 1\)\.\n\nBase /);

  writeFileSync(join(repo, 'evidence.yml'), 'kinds:\n  x:\n    risk: extreme\n');
  const error = runAction({ enforce: 'true' });
  assert.equal(error.status, 2);
  assert.match(error.summary, /^# Exhibit check: Exhibit failed\n\nVerdict: \*\*error\*\* \(exit code 2\)\.\n\nExhibit could not finish/);
});

// The workflows: two jobs, split by trust (spec 10).
for (const path of WORKFLOWS) {
  const workflow = readWorkflow(path);

  test(`${path}: the workflow runs on pull_request only, never pull_request_target, and grants nothing by default`, () => {
    assert.deepEqual(Object.keys(workflow.on), ['pull_request']);
    assert.deepEqual(workflow.permissions, {});
    assert.deepEqual(Object.keys(workflow.jobs), ['check', 'publish']);
  });

  test(`${path}: the check job can only read`, () => {
    const { check } = workflow.jobs;
    assert.deepEqual(check.permissions, { contents: 'read' });
    const checkout = check.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with['persist-credentials'], false);
    assert.deepEqual(exhibitStep(check).with, { command: 'check', enforce: false });
  });

  test(`${path}: the publish job writes, but never checks out or runs the PR head, and is skipped for a fork`, () => {
    const { publish } = workflow.jobs;
    assert.deepEqual(publish.permissions, { contents: 'write', 'pull-requests': 'write' });
    assert.deepEqual(publish.needs, 'check');
    assert.equal(publish.if, '${{ !cancelled() && github.event.pull_request.head.repo.full_name == github.repository }}');
    // Only three steps, none of them a script: the base commit, the artifact, and the released Exhibit.
    assert.deepEqual(publish.steps.map((step) => step.uses.replace(/@.*/, '')), ['actions/checkout', 'actions/download-artifact', 'bfalkowski/exhibit']);
    assert.ok(publish.steps.every((step) => step.run === undefined));
    assert.deepEqual(publish.steps[0].with, { ref: '${{ github.event.pull_request.base.sha }}' });
    assert.deepEqual(publish.steps[1].with, { name: 'exhibit', path: '.exhibit' });
    assert.deepEqual(exhibitStep(publish).with, { command: 'publish', comment: true, enforce: false });
    // The same released Exhibit in both jobs, and never ./, which is the PR's own copy.
    assert.equal(exhibitStep(publish).uses, exhibitStep(workflow.jobs.check).uses);
    // The same mode in both jobs, or a failed check comes with a comment that says shadow mode.
    assert.equal(exhibitStep(publish).with.enforce, exhibitStep(workflow.jobs.check).with.enforce);
  });

  test(`${path}: for a PR from a fork, the check job summary says why the publish job is skipped`, () => {
    const note = workflow.jobs.check.steps.find((step) => step.name === 'Say why the publish job is skipped');
    assert.equal(note.if, 'github.event.pull_request.head.repo.full_name != github.repository');
    assert.match(note.run, /This PR comes from a fork\..*publish job is skipped/);
    assert.match(note.run, />> "\$GITHUB_STEP_SUMMARY"/);
  });

  test(`${path}: both jobs run Exhibit from a fixed commit SHA or a release tag, never a branch or ./`, () => {
    for (const job of Object.values(workflow.jobs)) {
      assert.match(exhibitStep(job).uses, /^bfalkowski\/exhibit@([0-9a-f]{40}|v\d+\.\d+\.\d+)$/);
      for (const step of job.steps) assert.ok(!step.uses?.startsWith('./'), step.uses);
    }
  });
}

test('the example pins the same Exhibit as Exhibit\'s own workflow, so a copy gets the release that runs here', () => {
  const [example, own] = WORKFLOWS.map(readWorkflow);
  assert.equal(exhibitStep(example.jobs.check).uses, exhibitStep(own.jobs.check).uses);
});

// The field repos install published releases only (spec 12), so their setup notes pin a release
// tag that names one version. Never v0: it moves, so the check job and the publish job of one
// run could get different code.
for (const repo of FIELD_REPOS) {
  test(`examples/${repo}: the setup note's workflow pins an exact release, and its policy is valid`, async () => {
    const workflow = readWorkflow(`examples/${repo}/exhibit.yml`);
    for (const job of Object.values(workflow.jobs)) assert.match(exhibitStep(job).uses, /^bfalkowski\/exhibit@v\d+\.\d+\.\d+$/);
    const policy = await readPolicy(join(root, 'examples', repo));
    assert.equal(policy.version, 3);
    assert.equal(policy.settings.test_results, '.exhibit/junit.xml');
    assert.ok(Object.keys(policy.kinds).length > 0);
    const note = readFileSync(join(root, 'examples', repo, 'README.md'), 'utf8');
    assert.match(note, /\(exhibit\.yml\)/);
    assert.match(note, /\(evidence\.yml\)/);
  });
}

function exhibitStep(job) {
  const steps = job.steps.filter((step) => step.uses?.startsWith('bfalkowski/exhibit@'));
  assert.equal(steps.length, 1);
  return steps[0];
}
