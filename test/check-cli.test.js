import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // Commits `text` as the policy on top of start, and moves the tag start to that commit, so
  // --base start reads it (spec 8.1). The branches above still start from the old commit, so the
  // changed files of each branch stay the same.
  const setBasePolicy = (text, path = 'evidence.yml') => {
    git('checkout', '-q', '--detach', 'start');
    commit(path, text, 'base policy');
    git('tag', '-f', 'start');
    git('checkout', '-q', 'main');
  };
  return { repo, home, setBasePolicy };
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
  // The policy has no test command and no mutation_test_files, so both are missing.
  assert.deepEqual(evidence.requirements.map((item) => [item.type, item.status]), [['tests-before-after', 'missing'], ['mutation', 'missing']]);
  assert.deepEqual(checkExhibit(evidence), []);
});

test('a PR that adds a file under a source path is a feature, and one that only changes a file is not', (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy('version: 3\nsettings:\n  source_paths: ["src/**"]\ndefault:\n  risk: medium\n  needs:\n    - failing-before: { when: [feature] }\n');
  const git = (...args) => execFileSync('git', args, { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }) });
  git('checkout', '-q', '-b', 'new-src', 'start');
  mkdirSync(join(fixture.repo, 'src'), { recursive: true });
  writeFileSync(join(fixture.repo, 'src', 'b.js'), 'export const b = 1;\n');
  git('add', 'src/b.js');
  git('commit', '-q', '-m', 'add b');
  git('checkout', '-q', '-b', 'moved-src', 'start');
  git('mv', 'src/app.js', 'src/moved.js');
  git('commit', '-q', '-m', 'move app');
  // git pairs a removed and a new file as a rename only when they are at least 50% alike. This
  // move also rewrites the whole file, so git sees a new file.
  git('checkout', '-q', '-b', 'moved-and-rewritten', 'start');
  git('mv', 'src/app.js', 'src/main.js');
  writeFileSync(join(fixture.repo, 'src', 'main.js'), 'import { run } from "node:test";\nrun();\n');
  git('add', 'src/main.js');
  git('commit', '-q', '-m', 'move and rewrite app');
  // A file outside the source paths that moves into src with no change.
  git('checkout', '-q', '-b', 'with-lib', 'start');
  mkdirSync(join(fixture.repo, 'lib'), { recursive: true });
  writeFileSync(join(fixture.repo, 'lib', 'util.js'), 'export const util = 1;\n');
  git('add', 'lib/util.js');
  git('commit', '-q', '-m', 'add lib');
  git('checkout', '-q', '-b', 'into-src');
  git('mv', 'lib/util.js', 'src/util.js');
  git('commit', '-q', '-m', 'move util into src');
  git('checkout', '-q', 'main');

  exhibitCheck(fixture, ['--base', 'start', '--head', 'new-src']);
  const added = readEvidence(fixture.repo);
  assert.equal(added.classification.feature, true);
  // failing-before { when: [feature] } is needed, so it has no reason to skip.
  assert.equal(added.requirements[0].details.reason, undefined);
  assert.deepEqual(checkExhibit(added), []);

  // The fix/src branch only changes src/app.js, so failing-before is not needed.
  exhibitCheck(fixture, ['--base', 'start', '--head', 'fix/src']);
  const changed = readEvidence(fixture.repo);
  assert.equal(changed.classification.feature, false);
  assert.match(changed.requirements[0].details.reason, /only on a feature/);

  // A file that moves inside src is not a new file.
  exhibitCheck(fixture, ['--base', 'start', '--head', 'moved-src']);
  assert.equal(readEvidence(fixture.repo).classification.feature, false);

  // A file that moves and changes more than half of its content counts as a new file (spec 9.1).
  exhibitCheck(fixture, ['--base', 'start', '--head', 'moved-and-rewritten']);
  assert.equal(readEvidence(fixture.repo).classification.feature, true);

  // A file that moves into a source path from outside it, with no change, is a rename, not a new file.
  exhibitCheck(fixture, ['--base', 'with-lib', '--head', 'into-src']);
  assert.equal(readEvidence(fixture.repo).classification.feature, false);
});

test('check exits 1 for a change to evidence.yml', (t) => {
  const fixture = buildRepo(t);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'policy']);
  assert.equal(run.status, 1, run.stderr);
  assert.ok(readEvidence(fixture.repo).gaps.some((gap) => gap.type === 'policy-change'));
});

// The review of PR 163, finding 2: a policy on disk that is not committed must not change the rules.
test('the policy comes from the base commit, so an edit on disk does not change the verdict', (t) => {
  const fixture = buildRepo(t);
  const before = exhibitCheck(fixture, ['--base', 'start', '--head', 'fix/src']);
  assert.equal(before.status, 1, before.stderr);
  const expected = readEvidence(fixture.repo);
  // A weaker policy on disk that asks for nothing, as an edit that is not committed.
  writeFileSync(join(fixture.repo, 'evidence.yml'), 'default: { risk: low, needs: [] }\n');
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'fix/src']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.verdict, 'needs_person');
  assert.deepEqual(evidence.requirements.map((item) => item.type), ['tests-before-after', 'mutation']);
  // The hash is of the policy in the base commit, not of the file on disk.
  assert.equal(evidence.policy.sha256, createHash('sha256').update(POLICY).digest('hex'));
  assert.deepEqual(evidence.policy, expected.policy);
});

test('with no policy in the base commit, a policy on disk is not read', (t) => {
  const fixture = buildRepo(t);
  // A base with no evidence.yml, then one commit that changes a file.
  const git = (...args) => execFileSync('git', args, { cwd: fixture.repo, env: gitEnv(fixture.home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }) });
  git('rm', '-q', 'evidence.yml');
  git('commit', '-q', '-m', 'no policy');
  writeFileSync(join(fixture.repo, 'src', 'app.js'), 'export const a = 3;\n');
  git('commit', '-q', '-am', 'change app');
  // The reviewer's run: an untracked evidence.yml that asks for nothing.
  writeFileSync(join(fixture.repo, 'evidence.yml'), 'default: { risk: low, needs: [] }\n');
  const run = exhibitCheck(fixture, ['--base', 'HEAD~1']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.policy.sha256, null);
  assert.ok(evidence.gaps.some((gap) => gap.type === 'no-rule'));
});

// The review of PR 284, finding 1: a policy that is a symlink in the base commit.
test('a policy that is a symlink in the base commit is refused, and --policy can name the real file', (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(POLICY, '.github/evidence.yml');
  const git = (...args) => execFileSync('git', args, { cwd: fixture.repo, env: gitEnv(fixture.home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }) });
  git('checkout', '-q', '--detach', 'start');
  git('rm', '-q', 'evidence.yml');
  symlinkSync('.github/evidence.yml', join(fixture.repo, 'evidence.yml'));
  git('add', 'evidence.yml');
  git('commit', '-q', '-m', 'link the policy');
  git('tag', '-f', 'start');
  git('checkout', '-q', 'main');
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes']);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /evidence\.yml in the base commit [0-9a-f]{7} is a symlink\. Exhibit does not follow it\. Give --policy the path of the real file\./);
  assert.doesNotMatch(run.stderr, /must be object/);
  const real = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes', '--policy', '.github/evidence.yml']);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(readEvidence(fixture.repo).classification.kinds, ['notes']);
});

// The review of PR 284 by Nadia, finding 2: a folder in the policy path that is a symlink.
test('a policy path that goes through a linked folder is refused, and does not read as no policy', (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(POLICY, 'config/evidence.yml');
  const git = (...args) => execFileSync('git', args, { cwd: fixture.repo, env: gitEnv(fixture.home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }) });
  git('checkout', '-q', '--detach', 'start');
  symlinkSync('config', join(fixture.repo, '.github'));
  git('add', '.github');
  git('commit', '-q', '-m', 'link the folder');
  git('tag', '-f', 'start');
  git('checkout', '-q', 'main');
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes', '--policy', '.github/evidence.yml']);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /\.github in the base commit [0-9a-f]{7} is a symlink, so \.github\/evidence\.yml goes through it\. Exhibit does not follow it\. Give --policy the path of the real file\./);
  assert.equal(exhibitCheck(fixture, ['--base', 'start', '--head', 'notes', '--policy', 'config/evidence.yml']).status, 0);
});

// The review of PR 220, finding 4: a --policy path with a typo read as an empty policy, so the
// run gave needs_person and the gap "No kind in .github/evidnce.yml matches the changed files".
test('a --policy file that neither the base nor the head commit has exits 2 and says the file is missing', (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(POLICY, '.github/evidence.yml');
  for (const path of ['.github/evidnce.yml', 'nowhere/evidence.yml']) {
    const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes', '--policy', path]);
    assert.equal(run.status, 2, run.stderr);
    const message = new RegExp(`--policy names ${path.replaceAll('.', '\\.')}, but neither the base commit [0-9a-f]{7} nor the head commit [0-9a-f]{7} has such a file\\. Check the path\\.`);
    assert.match(run.stderr, message);
    assert.equal(existsSync(join(fixture.repo, '.exhibit', 'evidence.json')), false);
    const summary = readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8');
    assert.match(summary, /error/);
    assert.match(summary, message);
  }
  // The real path still works.
  assert.equal(exhibitCheck(fixture, ['--base', 'start', '--head', 'notes', '--policy', '.github/evidence.yml']).status, 0);
});

// The review of PR 324, finding 1: a repo that starts to use Exhibit adds its policy at the
// --policy path in the same PR. That PR is a policy change, not a typo.
test('a --policy file that only the head commit has is the policy change, with an empty policy from the base', (t) => {
  const fixture = buildRepo(t);
  const git = (...args) => execFileSync('git', args, { cwd: fixture.repo, env: gitEnv(fixture.home, { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' }) });
  git('checkout', '-q', '-b', 'adds-policy', 'start');
  mkdirSync(join(fixture.repo, '.github'));
  writeFileSync(join(fixture.repo, '.github', 'evidence.yml'), POLICY);
  git('add', '.github');
  git('commit', '-q', '-m', 'add the policy');
  git('checkout', '-q', 'main');
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'adds-policy', '--policy', '.github/evidence.yml']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.deepEqual(evidence.policy, { path: '.github/evidence.yml', sha256: null });
  assert.equal(evidence.classification.policy_changed, true);
  assert.ok(evidence.gaps.some((gap) => gap.type === 'policy-change'));
});

test('the policy is read from the top of the repo, also when exhibit check runs in a subfolder', (t) => {
  const fixture = buildRepo(t);
  const run = spawnSync(process.execPath, [bin, 'check', '--base', 'start', '--head', 'notes'], { cwd: join(fixture.repo, 'src'), encoding: 'utf8', env: gitEnv(fixture.home) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(join(fixture.repo, 'src', '.exhibit', 'evidence.json'), 'utf8')).policy.sha256, createHash('sha256').update(POLICY).digest('hex'));
});

test('a change to the policy is checked by the policy in the base commit, and still needs a person', (t) => {
  const fixture = buildRepo(t);
  // The policy branch weakens the default mutation min from 0.7 to 0.1.
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'policy']);
  assert.equal(run.status, 1, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.policy.sha256, createHash('sha256').update(POLICY).digest('hex'));
  assert.equal(evidence.requirements.find((item) => item.type === 'mutation').params.min, 0.7);
  assert.ok(evidence.gaps.some((gap) => gap.type === 'policy-change'));
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
  fixture.setBasePolicy('kinds:\n  x:\n    risk: extreme\n');
  const run = exhibitCheck(fixture, ['--base', 'start']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /evidence\.yml kinds\.x/);
  // The message says where the policy came from, so a person fixes the right copy.
  assert.match(run.stderr, /Exhibit reads evidence\.yml from the base commit [0-9a-f]{7}, not from the files on disk/);
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
  fixture.setBasePolicy(POLICY.replace('version: 3\n', 'version: 3\nsettings:\n  fix_signals: [revert]\n'));
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

test('check --pr N marks the PR as a fix when fix_signals has pr:N', async (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(POLICY.replace('version: 3\n', 'version: 3\nsettings:\n  fix_signals: [pr:7]\n'));
  const sha = (ref) => execFileSync('git', ['rev-parse', ref], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) }).trim();
  const fetch = async () => {
    const pull = { number: 7, title: 'Change the app', labels: [], base: { sha: sha('start'), ref: 'main' }, head: { sha: sha('fix/src'), ref: 'task/app' } };
    return new Response(JSON.stringify(pull), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await check(['--pr', '7', '--repo', 'owner/name'], { env: { GITHUB_TOKEN: 'test-token' }, cwd: fixture.repo, fetch, stdout: { write() {} } });
  const { fix, fix_signal: fixSignal } = readEvidence(fixture.repo).classification;
  assert.deepEqual([fix, fixSignal], [true, 'pr:7']);
});

test('check without --pr knows no PR number, so a pr:N signal does not match', (t) => {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(POLICY.replace('version: 3\n', 'version: 3\nsettings:\n  fix_signals: [pr:7]\n'));
  exhibitCheck(fixture, ['--base', 'start', '--head', 'fix/src']);
  const { fix, fix_signal: fixSignal } = readEvidence(fixture.repo).classification;
  assert.deepEqual([fix, fixSignal], [false, null]);
});

test('a bad argument removes the old evidence.json too, and summary.md says error and why', (t) => {
  const fixture = buildRepo(t);
  mkdirSync(join(fixture.repo, '.exhibit'));
  writeFileSync(join(fixture.repo, '.exhibit', 'evidence.json'), '{"verdict":"meets_policy"}\n');
  writeFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'old\n');
  const run = exhibitCheck(fixture, ['--pr', 'abc']);
  assert.equal(run.status, 2);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'evidence.json')), false);
  const summary = readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8');
  assert.match(summary, /^# Exhibit check: Exhibit failed\n\nVerdict: \*\*error\*\* \(exit code 2\)\./);
  assert.match(summary, /wrote no evidence\.json/);
  assert.match(summary, /\n {4}--pr must be a PR number, such as 12, not "abc"\.\n/);
  assert.doesNotMatch(summary, /Shadow mode/);
});

// Shadow mode (spec 10): the same run and the same files, but exit 0 for every verdict.
test('--shadow gives exit 0 for needs_person, and the files still say needs_person', (t) => {
  const fixture = buildRepo(t);
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'fix/src', '--shadow']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Verdict: needs_person\..*\n.*\nShadow mode: nothing waits on this verdict, so the exit code is 0\.\n$/);
  assert.equal(readEvidence(fixture.repo).verdict, 'needs_person');
  const summary = readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8');
  assert.match(summary, /^# Exhibit check: needs a person\n\nVerdict: \*\*needs_person\*\* \(exit code 0\)\.\n\nShadow mode: nothing waits on this verdict, so the check exits 0 whatever it is\.\n/);
});

test('--shadow gives exit 0 for verdict error, and so does a failure before a verdict', async (t) => {
  const fixture = buildRepo(t);
  const collectors = { 'tests-before-after': async () => { throw new Error('the test runner broke'); }, mutation: async () => ({ status: 'met' }) };
  const code = await check(['--base', 'start', '--head', 'fix/src', '--shadow'], { env: {}, cwd: fixture.repo, stdout: { write() {} }, collectors });
  assert.equal(code, 0);
  assert.equal(readEvidence(fixture.repo).verdict, 'error');
  assert.match(readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8'), /Verdict: \*\*error\*\* \(exit code 0\)\.\n\nShadow mode/);

  // A commit that is not in the clone: no verdict, but the step must not fail in shadow mode,
  // and the summary must show the error, so a broken setup is not hidden.
  const run = exhibitCheck(fixture, ['--shadow', '--base', 'no-such-ref']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /no-such-ref is not a commit/);
  assert.match(run.stderr, /verdict: error\nexhibit: shadow mode, so the exit code is 0\./);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'evidence.json')), false);
  const summary = readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8');
  assert.match(summary, /^# Exhibit check: Exhibit failed\n\nVerdict: \*\*error\*\* \(exit code 0\)\.\n\nShadow mode/);
  assert.match(summary, /no-such-ref is not a commit/);
});

test('--shadow gives exit 0 for a bad argument too, and summary.md says why', (t) => {
  const fixture = buildRepo(t);
  const run = exhibitCheck(fixture, ['--shadow', '--pr', 'abc']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8'), /--pr must be a PR number/);
});

test('--policy reads the policy from another path, and a change to that file is a policy change', (t) => {
  const fixture = buildRepo(t);
  // The notes kind lives only in the other file. With evidence.yml, notes match the default.
  fixture.setBasePolicy(POLICY, 'ci/policy.yml');
  fixture.setBasePolicy('version: 3\n');
  const run = exhibitCheck(fixture, ['--base', 'start', '--head', 'notes', '--policy', './ci//policy.yml']);
  assert.equal(run.status, 0, run.stderr);
  const evidence = readEvidence(fixture.repo);
  assert.equal(evidence.policy.path, 'ci/policy.yml');
  assert.match(evidence.policy.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(evidence.classification.kinds, ['notes']);
  // The policy branch changes evidence.yml, which is not the policy now.
  assert.equal(exhibitCheck(fixture, ['--base', 'start', '--head', 'policy', '--policy', 'ci/policy.yml']).status, 1);
  assert.equal(readEvidence(fixture.repo).classification.policy_changed, false);
  // A bad policy names the file it came from.
  fixture.setBasePolicy('kinds:\n  x:\n    risk: extreme\n', 'ci/policy.yml');
  assert.match(exhibitCheck(fixture, ['--base', 'start', '--policy', 'ci/policy.yml']).stderr, /ci\/policy\.yml kinds\.x/);
});

test('--policy must be a file in the repo', (t) => {
  const fixture = buildRepo(t);
  for (const value of ['../evidence.yml', '/etc/evidence.yml', '', '.', 'ci/']) {
    const run = exhibitCheck(fixture, ['--base', 'start', `--policy=${value}`]);
    assert.equal(run.status, 2, value);
    assert.match(run.stderr, /--policy must be the path of a file in the repo/, value);
  }
});

// A policy in the base commit whose notes kind needs the given probes. The notes branch has
// notes/one.md, and start does not, so a probe that reads it shows it ran in the head worktree.
function withProbes(fixture, probes, settings = '') {
  const needs = probes.map((probe) => `      - probe: ${JSON.stringify(probe)}`).join('\n');
  fixture.setBasePolicy(`version: 3\n${settings}kinds:\n  notes:\n    match: ["notes/**"]\n    risk: low\n    needs:\n${needs}\n`);
}

const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((name) => join(dir, name)) : []);

test('a probe runs in the head worktree, and summary.md names its output and artifacts and says where they are', (t) => {
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
  assert.match(summary, /- probe copy notes \(from notes\): met\. Output: `\.exhibit\/probes\/copy-notes\/output\.log`\. Artifacts: `\.exhibit\/probes\/copy-notes\/artifacts\/out\/copy\.md`\./);
  assert.match(summary, /\n\nThe probe files are in \.exhibit in the repo\. In GitHub Actions, they are in the workflow artifact named exhibit\.\n/);
  // No relative links: in the GitHub job summary, they lead nowhere. Each path names a real file.
  assert.doesNotMatch(summary, /\]\(/);
  for (const [, path] of summary.matchAll(/`(\.exhibit\/probes\/[^`]+)`/g)) assert.ok(existsSync(join(fixture.repo, path)), path);
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

// Waits until `check()` is true, and fails after `ms` milliseconds.
async function waitFor(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`waited ${ms} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// A probe runs in a process group of its own, so a Ctrl-C in the terminal reaches Exhibit, not the
// probe. Exhibit must stop the probe and remove the head worktree itself.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`${signal} while a probe runs stops the probe, removes the head worktree, and ends by the signal`, async (t) => {
    const fixture = buildRepo(t);
    // The file is outside the worktree, so it is still there when the worktree is gone.
    const pidFile = join(dirname(fixture.repo), 'sleep.pid');
    withProbes(fixture, [{ name: 'sleeper', run: `sleep 47 & echo $! > ${pidFile}; wait` }]);
    const child = spawn(process.execPath, [bin, 'check', '--base', 'start', '--head', 'notes'], { cwd: fixture.repo, env: gitEnv(fixture.home), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', (status, signalName) => resolve({ status, signalName })));
    t.after(() => child.kill('SIGKILL'));
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 20000, 'the probe to start');
    const sleepPid = Number(readFileSync(pidFile, 'utf8').trim());
    t.after(() => {
      if (isRunning(sleepPid)) process.kill(sleepPid, 'SIGKILL');
    });
    assert.equal(isRunning(sleepPid), true);

    child.kill(signal);
    const { status, signalName } = await exited;
    // Exhibit ends by the signal, as src/probe.js makes it do, so a shell shows 128 plus its number.
    assert.deepEqual({ status, signalName }, { status: null, signalName: signal });
    await waitFor(() => !isRunning(sleepPid), 5000, 'the sleep process to stop');
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) });
    assert.equal(worktrees.match(/^worktree /gm).length, 1, worktrees);
  });
}

// A stop can come after the last probe has ended, while the collectors still finish. The handler
// is then still removing the head worktree, and the run must not write an exhibit (spec 9.6). A
// real signal hits this case only by chance, so here a collector calls stopAllGroups, as the
// handler does, and the run goes on. stopAllGroups sets state that lasts for the whole process,
// so the run is in a process of its own, which exits after 1 second.
test('after a stop, check writes no evidence.json or summary.md, even when the collectors finish', (t) => {
  const fixture = buildRepo(t);
  const checkModule = fileURLToPath(new URL('../src/commands/check.js', import.meta.url));
  const probeModule = fileURLToPath(new URL('../src/probe.js', import.meta.url));
  const script = `
    import { check } from ${JSON.stringify(checkModule)};
    import { stopAllGroups } from ${JSON.stringify(probeModule)};
    const collectors = {
      'tests-before-after': async () => { stopAllGroups(); return { status: 'met' }; },
      mutation: async () => ({ status: 'met' })
    };
    check(['--base', 'start', '--head', 'fix/src'], { env: {}, cwd: ${JSON.stringify(fixture.repo)}, stdout: process.stdout, collectors });
    setTimeout(() => process.exit(0), 1000);
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) });
  assert.equal(out, '');
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'evidence.json')), false);
  assert.equal(existsSync(join(fixture.repo, '.exhibit', 'summary.md')), false);
});

test('a probe gets the env that check() gets, without NODE_TEST_CONTEXT, as the test command does', async (t) => {
  const fixture = buildRepo(t);
  withProbes(fixture, [{ name: 'env', run: 'echo "mark=${PROBE_MARK-unset} context=${NODE_TEST_CONTEXT-unset} outside=${ONLY_IN_EXHIBIT-unset}"' }]);
  // A variable in Exhibit's own env that the env given to check() does not have.
  process.env.ONLY_IN_EXHIBIT = 'yes';
  t.after(() => delete process.env.ONLY_IN_EXHIBIT);
  const env = { PATH: process.env.PATH, PROBE_MARK: 'from-check', NODE_TEST_CONTEXT: 'child-v8' };
  const code = await check(['--base', 'start', '--head', 'notes'], { env, cwd: fixture.repo, stdout: { write() {} } });
  assert.equal(code, 0);
  const [probe] = readEvidence(fixture.repo).requirements;
  assert.equal(readFileSync(join(fixture.repo, probe.details.output), 'utf8'), 'mark=from-check context=unset outside=unset\n');
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

// A base policy whose fix signal is tracker:jira, and whose src kind needs failing-before only on
// a fix. The forge gives PR 7, whose title names the Jira issue PAY-482. Jira answers from
// test/fixtures/jira/acme.json, where PAY-482 is a Bug, and with a 503 for PAY-503.
const JIRA_POLICY = `version: 3
settings:
  fix_signals: [label:bug, tracker:jira]
  jira:
    site: https://acme.atlassian.net
kinds:
  src:
    match: ["src/**"]
    risk: medium
    needs:
      - failing-before: { when: [fix] }
`;
const JIRA_REPLIES = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/jira/acme.json', import.meta.url)), 'utf8'));

async function checkWithJira(t, { title, env, jiraStatus = null }) {
  const fixture = buildRepo(t);
  fixture.setBasePolicy(JIRA_POLICY);
  const sha = (ref) => execFileSync('git', ['rev-parse', ref], { cwd: fixture.repo, encoding: 'utf8', env: gitEnv(fixture.home) }).trim();
  const asked = [];
  const fetch = async (url, options) => {
    const { origin, pathname, search } = new URL(String(url));
    asked.push({ url: `${origin}${pathname}`, authorization: options?.headers?.authorization });
    if (origin === 'https://api.github.com') {
      const pull = { number: 7, title, labels: [], base: { sha: sha('start'), ref: 'main' }, head: { sha: sha('fix/src'), ref: 'task/app' } };
      return new Response(JSON.stringify(pull), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (jiraStatus) return new Response('{}', { status: jiraStatus, headers: { 'content-type': 'application/json' } });
    const reply = JIRA_REPLIES[`${pathname}${search}`];
    if (!reply) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(reply.body), { status: reply.status, statusText: reply.statusText, headers: { 'content-type': 'application/json' } });
  };
  const collectors = { 'failing-before': async () => ({ status: 'met', details: {} }) };
  const code = await check(['--pr', '7', '--repo', 'acme/widgets'], { env: { GITHUB_TOKEN: 'test-token', ...env }, cwd: fixture.repo, fetch, stdout: { write() {} }, collectors }).catch((error) => error);
  if (code instanceof Error) return { error: code, asked, summary: readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8') };
  const evidence = readEvidence(fixture.repo);
  return { code, asked, evidence, summary: readFileSync(join(fixture.repo, '.exhibit', 'summary.md'), 'utf8') };
}

test('check --pr asks Jira for tracker:jira, so a fix that only Jira shows needs failing-before', async (t) => {
  const { code, asked, evidence, summary } = await checkWithJira(t, { title: 'PAY-482: Change the app', env: { JIRA_API_TOKEN: 'secret-jira-token' } });
  assert.deepEqual(asked.map((a) => a.url), ['https://api.github.com/repos/acme/widgets/pulls/7', 'https://acme.atlassian.net/rest/api/2/issue/PAY-482']);
  assert.equal(asked[1].authorization, 'Bearer secret-jira-token');
  assert.deepEqual([evidence.classification.fix, evidence.classification.fix_signal], [true, 'jira:PAY-482']);
  assert.deepEqual(evidence.requirements.map((r) => [r.type, r.status]), [['failing-before', 'met']]);
  assert.equal(code, 0);
  assert.match(summary, /^- Fix: yes, from the signal jira:PAY-482\. Feature: no\.$/m);
  assert.doesNotMatch(summary, /secret-jira-token/);
  assert.deepEqual(checkExhibit(evidence), []);
});

test('check --pr with tracker:jira and no JIRA_API_TOKEN asks no Jira, and summary.md says so in one line', async (t) => {
  const { asked, evidence, summary } = await checkWithJira(t, { title: 'PAY-482: Change the app', env: {} });
  assert.deepEqual(asked.map((a) => a.url), ['https://api.github.com/repos/acme/widgets/pulls/7']);
  assert.deepEqual([evidence.classification.fix, evidence.classification.fix_signal], [false, null]);
  assert.equal(evidence.requirements[0].status, 'skipped');
  assert.match(summary, /^- JIRA_API_TOKEN is not set, so the tracker:jira fix signal matched no PR\. Set it to a Jira API token, and for Jira Cloud set JIRA_EMAIL to the email of its account\.$/m);
});

test('check --pr says in summary.md when Jira could not answer for the PR\'s issue', async (t) => {
  const { evidence, summary } = await checkWithJira(t, { title: 'PAY-503: Change the app', env: { JIRA_API_TOKEN: 'secret-jira-token' } });
  assert.deepEqual([evidence.classification.fix, evidence.classification.fix_signal], [false, null]);
  assert.match(summary, /^- The tracker:jira signal could not check PAY-503, so it does not match\. Jira answered 503 /m);
});

test('check --pr stops with the verdict error when Jira refuses the token', async (t) => {
  const { error, summary } = await checkWithJira(t, { title: 'PAY-482: Change the app', env: { JIRA_API_TOKEN: 'secret-jira-token' }, jiraStatus: 401 });
  assert.match(error.message, /Jira answered 401/);
  assert.match(summary, /^Verdict: \*\*error\*\*/m);
  assert.doesNotMatch(summary, /secret-jira-token/);
});
