import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../src/commands/check.js';
import { checkExhibit } from '../src/exhibit-schema.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();
const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));

const POLICY = `version: 3
kinds:
  notes:
    match: ["notes/**"]
    risk: low
    needs: []
    merge_without_reading: allowed
default:
  risk: medium
  needs:
    - tests-before-after
    - mutation: { min: 0.7 }
`;

// A repo with three commits on main: the policy, then a change to notes/ (branch notes), then a
// change to src/ (branch fix/src). Dates and names are fixed, so the SHAs are the same each time.
function buildRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-check-'));
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
  const commit = (path, text, message) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
    git('add', path);
    tick += 1;
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit('evidence.yml', POLICY, 'policy');
  commit('src/app.js', 'export const a = 1;\n', 'app');
  git('tag', 'start');
  git('checkout', '-q', '-b', 'notes');
  commit('notes/one.md', 'one\n', 'notes');
  git('checkout', '-q', '-b', 'fix/src', 'start');
  commit('src/app.js', 'export const a = 2;\n', 'fix app');
  git('checkout', '-q', '-b', 'policy', 'start');
  commit('evidence.yml', POLICY.replace('0.7', '0.1'), 'weaker policy');
  git('checkout', '-q', 'main');
  return { repo, home };
}

const exhibitCheck = ({ repo, home }, args) => spawnSync(process.execPath, [bin, 'check', ...args], { cwd: repo, encoding: 'utf8', env: gitEnv(home) });
const readEvidence = (repo) => JSON.parse(readFileSync(join(repo, '.exhibit', 'evidence.json'), 'utf8'));

test('check exits 0 for meets_policy and writes evidence.json and summary.md', (t) => {
  const fixture = buildRepo(t);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Verdict: meets_policy/);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.verdict, 'meets_policy');
  assert.deepEqual(evidence.classification.kinds, ['notes']);
  assert.deepEqual(checkExhibit(evidence), []);
  assert.match(readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8'), /meets_policy/);
});

test('check exits 1 for needs_person, and evidence.json passes the schema', (t) => {
  const fixture = buildRepo(t);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'fix/src']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.verdict, 'needs_person');
  assert.equal(evidence.classification.used_default, true);
  // Only the branch name is known, and fix/ marks a fix.
  assert.equal(evidence.classification.fix, true);
  assert.equal(evidence.classification.fix_signal, 'branch:fix/');
  assert.equal(evidence.classification.signals_from, 'branch');
  assert.deepEqual(evidence.requirements.map((item) => [item.type, item.status]), [['tests-before-after', 'missing'], ['mutation', 'skipped']]);
  assert.deepEqual(checkExhibit(evidence), []);
});

test('check exits 1 for a change to evidence.yml', (t) => {
  const fixture = buildRepo(t);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'policy']);
  assert.equal(run.status, 1, run.stderr);
  assert.ok(readEvidence(fixture.repo).gaps.some((gap) => gap.type === 'policy-change'));
});

test('check exits 2 when Exhibit fails, and leaves no old verdict behind', (t) => {
  const fixture = buildRepo(t);
  assert.equal(exhibitCheck(fixture, ['--base', 'start', '--head', 'notes']).status, 0);
  const run = exhibitCheck(fixture, ['--base', 'no-such-ref']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no-such-ref is not a commit/);
  assert.match(run.stderr, /verdict: error/);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'evidence.json')), false);
});

test('check exits 2 on a bad policy', (t) => {
  const fixture = buildRepo(t);
  writeFileSync(join(fixture.repo, 'evidence.yml'), 'kinds:\n  x:\n    risk: extreme\n');
  const run = exhibitCheck(fixture, ['--base', 'start']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /evidence\.yml/);
});

test('a collector that throws gives verdict error and exit 2 from the command', async (t) => {
  const fixture = buildRepo(t);
  const out = [];
  const collectors = { 'tests-before-after': async () => { throw new Error('the test runner broke'); }, mutation: async () => ({ status: 'met' }) };
  const code = await check(['--base', 'start', '--head', 'fix/src'], { env: {}, cwd: fixture.repo, stdout: { write: (text) => out.push(text) }, collectors });
  assert.equal(code, 2);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.verdict, 'error');
  assert.match(evidence.gaps[0].how_to_fix, /the test runner broke/);
  assert.match(out.join(''), /Verdict: error/);
});

test('two runs on the same commits give the same files, apart from timing fields', (t) => {
  const fixture = buildRepo(t);
  const strip = (evidence) => ({ ...evidence, created_at: null, requirements: evidence.requirements.map((item) => ({ ...item, duration_ms: null })) });
  const runOnce = () => {
    assert.equal(exhibitCheck(fixture, ['--base', 'start', '--head', 'fix/src']).status, 1);
    return { evidence: strip(readEvidence(fixture.repo)), summary: readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8') };
  };
  const first = runOnce();
  const second = runOnce();
  assert.deepEqual(second, first);
});

test('check --pr needs --repo, and leaves out --base', (t) => {
  const fixture = buildRepo(t);
  assert.match(exhibitCheck(fixture, ['--pr', '3']).stderr, /--pr needs --repo/);
  assert.match(exhibitCheck(fixture, ['--pr', '3', '--repo', 'o/n', '--base', 'x']).stderr, /leave out --base/);
  assert.equal(exhibitCheck(fixture, []).status, 2);
});

test('check --pr with no GITHUB_TOKEN says to set it, and asks the forge nothing', async (t) => {
  const fixture = buildRepo(t);
  const fetch = async () => assert.fail('check asked the forge without a token');
  await assert.rejects(
    check(['--pr', '7', '--repo', 'owner/name'], { env: {}, cwd: fixture.repo, fetch, stdout: { write() {} } }),
    { message: 'GITHUB_TOKEN is not set. --pr reads the PR from GitHub, so set it to a token that can read the repo, for example GITHUB_TOKEN=$(gh auth token).' }
  );
});

test('check --pr reads the base, the head, the title and the labels from the forge', async (t) => {
  const fixture = buildRepo(t);
  const sha = (ref) => execFileSync('git', ['rev-parse', ref], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) }).trim();
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    const pull = { number: 7, title: 'Fix the app', labels: [{ name: 'Feature' }], base: { sha: sha('start'), ref: 'main' }, head: { sha: sha('fix/src'), ref: 'task/app' } };
    return new Response(JSON.stringify(pull), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const code = await check(['--pr', '7', '--repo', 'owner/name'], { env: { GITHUB_TOKEN: 'test-token' }, cwd: fixture.repo, fetch, stdout: { write() {} } });
  assert.equal(code, 1);
  assert.deepEqual(asked, ['https://api.github.com/repos/owner/name/pulls/7']);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.pr, 7);
  assert.equal(evidence.repo, 'owner/name');
  assert.equal(evidence.head, sha('fix/src'));
  assert.deepEqual([evidence.classification.fix, evidence.classification.fix_signal, evidence.classification.feature, evidence.classification.signals_from], [true, 'title:fix', true, 'pr']);
  assert.deepEqual(checkExhibit(evidence), []);
});

test('check --pr passes the body and the repo to the revert signal', async (t) => {
  const fixture = buildRepo(t);
  writeFileSync(join(fixture.repo, 'evidence.yml'), POLICY.replace('version: 3\n', 'version: 3\nsettings:\n  fix_signals: [revert]\n'));
  const sha = (ref) => execFileSync('git', ['rev-parse', ref], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) }).trim();
  const signalFor = async (body) => {
    const fetch = async () => {
      const pull = { number: 7, title: 'Take back the app change', body, labels: [], base: { sha: sha('start'), ref: 'main' }, head: { sha: sha('fix/src'), ref: 'task/app' } };
      return new Response(JSON.stringify(pull), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await check(['--pr', '7', '--repo', 'Owner/Name'], { env: { GITHUB_TOKEN: 'test-token' }, cwd: fixture.repo, fetch, stdout: { write() {} } });
    const { fix, fix_signal: fixSignal } = readEvidence(fixture.repo).classification;
    return [fix, fixSignal];
  };
  // A plain title: only the body says it is a revert, and it names the PR's own repo.
  assert.deepEqual(await signalFor('Reverts owner/name#6'), [true, 'revert']);
  // A body that names only another repo's PR is no revert.
  assert.deepEqual(await signalFor('Reverts lodash/lodash#5000'), [false, null]);
});

test('a bad argument removes the old evidence.json too, so no old verdict is left', (t) => {
  const fixture = buildRepo(t);
  mkdirSync(join(fixture.repo, '.exhibit'));
  writeFileSync(join(fixture.repo, '.exhibit', 'evidence.json'), '{"verdict":"meets_policy"}\n');
  writeFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'old\n');
  const run = exhibitCheck(fixture, ['--pr', 'abc']);
  assert.equal(run.status, 2);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'evidence.json')), false);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'summary.md')), false);
});

// A policy in the working tree whose notes kind needs the given probes. The notes branch has
// notes/one.md, and start does not, so a probe that reads it shows it ran in the head worktree.
function withProbes(fixture, probes, settings = '') {
  const needs = probes.map((probe) => `      - probe: ${JSON.stringify(probe)}`).join('\n');
  writeFileSync(join(fixture.repo, 'evidence.yml'), `version: 3\n${settings}kinds:\n  notes:\n    match: ["notes/**"]\n    risk: low\n    needs:\n${needs}\n`);
}

const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((name) => join(dir, name)) : []);

test('a probe runs in the head worktree, and summary.md links its output and artifacts', (t) => {
  const fixture = buildRepo(t);
  withProbes(fixture, [{ name: 'copy notes', run: 'mkdir -p out && cp notes/one.md out/copy.md', artifacts: ['out/copy.md'] }]);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes']);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const evidence = readEvidence(fixture.repo);
  assert.deepEqual(checkExhibit(evidence), []);
  const [probe] = evidence.requirements;
  assert.equal(probe.status, 'met');
  assert.deepEqual(probe.details.artifacts, [{ path: 'out/copy.md', copy: '.exhibit/probes/copy-notes/artifacts/out/copy.md' }]);
  assert.equal(readFileSync(join(fixture.repo, probe.details.artifacts[0].copy), 'utf8'), 'one\n');
  const summary = readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8');
  assert.match(summary, /- probe copy notes \(from notes\): met\. Output: \[output\.log\]\(probes\/copy-notes\/output\.log\)\. Artifacts: \[out\/copy\.md\]\(probes\/copy-notes\/artifacts\/out\/copy\.md\)\./);
  // Each link in summary.md points to a file beside it.
  for (const [, target] of summary.matchAll(/\]\(([^)]+)\)/g)) assert.ok(existsSync(join(fixture.repo, '.exhibit', decodeURI(target))), target);
  // The head worktree is gone after the run.
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) });
  assert.equal(worktrees.match(/^worktree /gm).length, 1);
});

test('a hidden probe counts as hidden, and its output is not in the exhibit', (t) => {
  const fixture = buildRepo(t);
  withProbes(fixture, [
    { name: 'shown', run: 'true' },
    { name: 'secret suite', run: 'echo secret-$((40 + 2)); echo secret-$((40 + 2)) > report.txt; exit 1', artifacts: ['report.txt'], author: 'hidden' }
  ]);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.deepEqual(evidence.checks_by_author, { builder: 1, hidden: 1 });
  assert.deepEqual(evidence.requirements.map((item) => [item.params.name, item.author, item.status]), [['shown', 'builder', 'met'], ['secret suite', 'hidden', 'failed']]);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'probes', 'secret-suite')), false);
  for (const file of filesUnder(join(fixture.repo, '.exhibit'))) {
    if (statSync(file).isFile()) assert.doesNotMatch(readFileSync(file, 'utf8'), /secret-42/, file);
  }
  assert.doesNotMatch(run.stdout + run.stderr, /secret-42/);
});

test('the time limit comes from settings.probe_timeout_seconds, and old probe files are removed', (t) => {
  const fixture = buildRepo(t);
  mkdirSync(join(fixture.repo, '.exhibit', 'probes', 'old'), { recursive: true });
  writeFileSync(join(fixture.repo, '.exhibit', 'probes', 'old', 'output.log'), 'old\n');
  withProbes(fixture, [{ name: 'slow', run: 'sleep 30' }], 'settings:\n  probe_timeout_seconds: 1\n');
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.deepEqual([evidence.requirements[0].status, evidence.requirements[0].details.timeout_seconds], ['failed', 1]);
  assert.match(evidence.gaps[0].how_to_fix, /timed out/);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'probes', 'old')), false);
});

test('each probe starts in a clean head worktree, so it cannot see the files of the probe before it', (t) => {
  const fixture = buildRepo(t);
  withProbes(fixture, [
    { name: 'hidden one', run: 'echo secret-$((40 + 2)) > h.txt; echo changed >> notes/one.md', artifacts: ['h.txt'], author: 'hidden' },
    { name: 'builder', run: 'test ! -e h.txt && cat notes/one.md', artifacts: ['h.txt'] }
  ]);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  const builder = evidence.requirements[1];
  // The builder probe did not write h.txt, so it is not met by the hidden probe's file.
  assert.equal(builder.status, 'failed');
  assert.deepEqual([builder.details.exit_code, builder.details.missing_artifacts], [0, ['h.txt']]);
  // The tracked file is back to the head's version too.
  assert.equal(readFileSync(join(fixture.repo, builder.details.output), 'utf8'), 'one\n');
  for (const file of filesUnder(join(fixture.repo, '.exhibit'))) {
    if (statSync(file).isFile()) assert.doesNotMatch(readFileSync(file, 'utf8'), /secret-42/, file);
  }
});
