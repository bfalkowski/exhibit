import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './fixtures/git-env.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const IDENTITY = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '2026-01-05T09:00:00Z', GIT_COMMITTER_DATE: '2026-01-05T09:00:00Z' };

const POLICY = `version: 3
settings:
  test_command: "sh run-tests.sh"
  test_results: "out/junit.xml"
default:
  risk: medium
  needs:
    - tests-before-after
    - probe: { name: ready, run: "test -f ready.txt" }
`;

// The test command: one test, which fails when broken.txt is there. With crash.txt it writes no
// results, so exhibit check's collector gives error.
const RUN_TESTS = `mkdir -p out
if [ -f crash.txt ]; then exit 1; fi
r=''
if [ -f broken.txt ]; then r='<failure message="broken"/>'; fi
printf '<testsuites><testsuite name="s"><testcase classname="c" name="works">%s</testcase></testsuite></testsuites>' "$r" > out/junit.xml
`;

// A repo with a base commit and one head commit for each PR. PR 4's head is not in the clone.
// PR 5 is a fix whose SZZ link to PR 2 a person kept. No PR body has an evidence section, so
// without --rerun every requirement is unknown.
function buildRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-rerun-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv(home, IDENTITY) }).trim();
  const commitWith = (files, message) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
    git('add', ...Object.keys(files));
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const base = commitWith({ 'evidence.yml': POLICY, 'run-tests.sh': RUN_TESTS, '.gitignore': 'out/\n.exhibit/\n' }, 'base');
  const branch = (name, files) => {
    git('checkout', '-q', '-b', name, base);
    const sha = commitWith(files, name);
    git('checkout', '-q', 'main');
    return sha;
  };
  const heads = {
    1: branch('ready', { 'ready.txt': 'yes\n' }),
    2: branch('broken', { 'broken.txt': 'yes\n' }),
    3: branch('crash', { 'ready.txt': 'yes\n', 'crash.txt': 'yes\n' }),
    4: 'f'.repeat(40),
    5: branch('fix', { 'ready.txt': 'yes\n', 'fixed.txt': 'yes\n' })
  };
  const lines = [5, 4, 3, 2, 1].map((number) => historyLine(number, base, heads[number]));
  mkdirSync(join(repo, '.exhibit'));
  writeFileSync(join(repo, '.exhibit/history.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const label = { id: 'D-005', fix_pr: 5, introducing_prs: [2], rejected_prs: [], code: 'x', category: 'Broken', would_have_caught: 'x', labeled_by: 'person', szz_link_rejected: false, known_at_review: false, labeled_at: '2026-03-01T00:00:00Z' };
  writeFileSync(join(repo, '.exhibit/labels.jsonl'), JSON.stringify(label) + '\n');
  return { repo, home };
}

function historyLine(number, base, head) {
  const fix = number === 5;
  return {
    number,
    title: fix ? 'Fix the broken test' : `Change ${number}`,
    body: null,
    author: 'a',
    labels: fix ? ['bug'] : [],
    merged_at: `2026-02-0${number}T12:00:00Z`,
    base_ref: 'main',
    base_sha: base,
    head_sha: head,
    merge_sha: head,
    forge: 'github',
    url: `https://github.com/acme/widgets/pull/${number}`,
    files: [{ path: `file-${number}.txt`, additions: 1, deletions: 0 }],
    reviews: { change_request_rounds: 0, list: [] },
    ci: [],
    classification: { kinds: [], fix, fix_signal: fix ? 'label:bug' : null },
    szz: fix ? { blamed_commit: 'a'.repeat(40), links: [{ pr: 2, confidence: 1, lines: [] }], unlinked_lines: [], dropped_lines: [], no_link_reason: null } : null
  };
}

const backtest = ({ repo, home }, args) => spawnSync(process.execPath, [bin, 'backtest', ...args], { cwd: repo, encoding: 'utf8', env: gitEnv(home) });

test('--rerun turns unknown requirements into met or missing, and the counts change to match', (t) => {
  const fixture = buildRepo(t);
  const plain = backtest(fixture, ['--json']);
  assert.equal(plain.status, 0, plain.stderr);
  const before = JSON.parse(plain.stdout);
  // With no evidence, every PR is needs_person on unknown requirements alone.
  assert.equal(before.counts.all.unknown_only, 5);
  assert.deepEqual([before.counts.all.caught.k, before.counts.all.caught.n], [1, 1]);
  assert.deepEqual([before.counts.all.false_demands.k, before.counts.all.false_demands.n], [4, 4]);
  assert.deepEqual(before.evidence_from, { exhibit: 0, body: 0, none: 5 });

  const run = backtest(fixture, ['--rerun', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const after = JSON.parse(run.stdout);
  assert.deepEqual(after.rerun.prs.map((pr) => [pr.number, pr.status]), [[1, 'ran'], [2, 'ran'], [3, 'error'], [4, 'no_commits'], [5, 'ran']]);
  assert.match(after.rerun.prs[2].errors[0], /^tests-before-after: /);
  assert.deepEqual([after.rerun.ran, after.rerun.error, after.rerun.no_commits, after.rerun.not_reached], [3, 1, 1, 0]);
  // PR 2 is still caught, now by a missing requirement. PRs 1 and 5 meet the policy, so two false
  // demands are gone. PR 3 (error) and PR 4 (no commits) keep their unknown requirements.
  assert.deepEqual([after.counts.all.caught.k, after.counts.all.caught.n], [1, 1]);
  assert.deepEqual([after.counts.all.false_demands.k, after.counts.all.false_demands.n], [2, 4]);
  assert.equal(after.counts.all.unknown_only, 2);
  assert.deepEqual(after.counts_before_rerun, before.counts);
  assert.deepEqual(after.evidence_from, { exhibit: 0, rerun: 4, body: 0, none: 1 });
  assert.deepEqual(after.replayed.map((line) => [line.pr, line.verdict, line.missing]), [[2, 'needs_person', ['tests-before-after', 'probe ready']]]);

  const report = readFileSync(join(fixture.repo, '.exhibit/backtest.md'), 'utf8');
  assert.match(report, /## The rerun/);
  assert.match(report, /PR 3: tests-before-after: /);
  assert.match(report, /commit is not in the clone, so they did not run\. .*: 4\./);
  assert.match(report, /Before the rerun, from the exhibits and the PR bodies only:/);
  // Each PR's logs are kept apart, and no worktree is left behind.
  assert.ok(existsSync(join(fixture.repo, '.exhibit/rerun/2/tests/head-first.log')));
  assert.ok(existsSync(join(fixture.repo, '.exhibit/rerun/1/probes/ready/output.log')));
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) }).trim().split('\n').length, 1);
});

test('without --json, --rerun prints a line for each PR it ran, and the counts before and after', (t) => {
  const fixture = buildRepo(t);
  const run = backtest(fixture, ['--rerun', '--budget', '5', '--from', '2026-02-02']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^exhibit: rerun of PR 2: tests-before-after failed, probe ready failed \(\d+ s\)\.$/m);
  assert.match(run.stdout, /^ {2}all PRs before the rerun: Caught 1 of 1/m);
  assert.match(run.stdout, /^Rerun in \d+ s: 2 ran, 1 gave an error, 0 not reached in the budget of 5 minutes, 1 with a commit that is not in the clone, 0 with nothing to run\. The logs are in \.exhibit\/rerun\.$/m);
});

test('--budget needs --rerun and a whole number of minutes', (t) => {
  const fixture = buildRepo(t);
  assert.equal(backtest(fixture, ['--budget', '5']).stderr, 'exhibit: --budget is the time budget of --rerun, so give it only with --rerun. Usage: exhibit backtest [--from YYYY-MM-DD] [--rerun [--budget MINUTES]] [--json]\n');
  assert.equal(backtest(fixture, ['--rerun', '--budget', '0']).stderr, 'exhibit: --budget must be a whole number of minutes, 1 or more, not "0".\n');
});
