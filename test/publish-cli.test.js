import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExhibit } from '../src/exhibit-schema.js';
import { dropGitEnv, gitEnv } from './fixtures/git-env.js';

dropGitEnv();
const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const IDENTITY = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };

// An exhibit that passes the schema, for PR `pr` at the commit `head`.
function exhibit(pr, head) {
  return {
    exhibit_version: '0.1.0',
    policy: { path: 'evidence.yml', sha256: null },
    repo: 'acme/widgets',
    pr,
    base: 'a'.repeat(40),
    head,
    classification: {
      kinds: [], risk: 'medium', fix: false, fix_signal: null, feature: false,
      signals_from: 'pr', merge_without_reading: 'never', used_default: true, policy_changed: false
    },
    requirements: [],
    verdict: 'meets_policy',
    gaps: [],
    checks_by_author: { builder: 0, hidden: 0 },
    flaky_tests: [],
    environment: { node: '20.x', os: 'linux' },
    created_at: '2026-11-20T10:00:00Z'
  };
}

// A bare remote, and a clone of it with one commit on main. `clone()` makes one more clone, for a
// second run that publishes from another machine.
function buildFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(home);
  const remote = join(dir, 'remote.git');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(home, IDENTITY) });
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const repo = join(dir, 'repo');
  git(dir, 'clone', '-q', remote, repo);
  writeFileSync(join(repo, 'app.js'), 'export const a = 1;\n');
  git(repo, 'add', 'app.js');
  git(repo, 'commit', '-q', '-m', 'app');
  git(repo, 'push', '-q', 'origin', 'main');
  let clones = 0;
  const clone = () => {
    clones += 1;
    const path = join(dir, `clone-${clones}`);
    git(dir, 'clone', '-q', remote, path);
    return path;
  };
  const writeExhibit = (cwd, name, value) => {
    const path = join(cwd, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    return path;
  };
  return { dir, home, remote, repo, git, clone, writeExhibit };
}

const publishArgs = (file, extra = []) => [bin, 'publish', '--evidence', file, ...extra];
const runPublish = ({ home }, cwd, file, extra) => spawnSync(process.execPath, publishArgs(file, extra), { cwd, encoding: 'utf8', env: gitEnv(home, IDENTITY) });

// What git says about the clone's own state: the checked-out branch, its commit, the status of
// the working tree and index, and every ref other than the remote-tracking ones.
function localState({ git }, cwd) {
  return {
    branch: git(cwd, 'symbolic-ref', 'HEAD'),
    head: git(cwd, 'rev-parse', 'HEAD'),
    status: git(cwd, 'status', '--porcelain', '--untracked-files=all'),
    refs: git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter((line) => !line.startsWith('refs/remotes/')).join('\n')
  };
}

const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);

test('publish makes exhibit-data on the remote, writes prs/<pr>/<head>.json, and leaves the working tree and branch alone', (t) => {
  const fixture = buildFixture(t);
  const file = fixture.writeExhibit(fixture.dir, 'evidence.json', exhibit(12, HEAD_1));
  assert.deepEqual(checkExhibit(JSON.parse(readFileSync(file, 'utf8'))), []);
  const before = localState(fixture, fixture.repo);

  const run = runPublish(fixture, fixture.repo, file);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^Stored prs/12/${HEAD_1}\\.json on exhibit-data in commit [0-9a-f]{40}, pushed to origin\\.\\n$`));
  assert.deepEqual(localState(fixture, fixture.repo), before);
  const stored = fixture.git(fixture.remote, 'show', `exhibit-data:prs/12/${HEAD_1}.json`);
  assert.equal(stored, readFileSync(file, 'utf8'));
  // The data branch has no shared history with main: one commit, with no parent.
  assert.equal(fixture.git(fixture.remote, 'rev-list', '--count', 'exhibit-data').trim(), '1');
  assert.equal(fixture.git(fixture.remote, 'ls-tree', '-r', '--name-only', 'exhibit-data'), `prs/12/${HEAD_1}.json\n`);
});

test('two publishes that race on the same remote both land', async (t) => {
  const fixture = buildFixture(t);
  const one = fixture.clone();
  const two = fixture.clone();
  // Make the branch first, so both runs start from the same tip and one push must be refused.
  assert.equal(runPublish(fixture, fixture.repo, fixture.writeExhibit(fixture.dir, 'zero.json', exhibit(1, HEAD_1))).status, 0);
  const files = [
    fixture.writeExhibit(fixture.dir, 'one.json', exhibit(12, HEAD_1)),
    fixture.writeExhibit(fixture.dir, 'two.json', exhibit(13, HEAD_2))
  ];

  const results = await Promise.all([one, two].map((cwd, i) => new Promise((done) => {
    const child = spawn(process.execPath, publishArgs(files[i]), { cwd, env: gitEnv(fixture.home, IDENTITY) });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => done({ status, stderr }));
  })));

  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fixture.git(fixture.remote, 'ls-tree', '-r', '--name-only', 'exhibit-data'),
    [`prs/1/${HEAD_1}.json`, `prs/12/${HEAD_1}.json`, `prs/13/${HEAD_2}.json`].join('\n') + '\n'
  );
  assert.equal(fixture.git(fixture.remote, 'rev-list', '--count', 'exhibit-data').trim(), '3');
});

test('publishing the same exhibit twice makes one commit, and the second run exits 0', (t) => {
  const fixture = buildFixture(t);
  const file = fixture.writeExhibit(fixture.dir, 'evidence.json', exhibit(12, HEAD_1));

  const first = runPublish(fixture, fixture.repo, file);
  const tip = fixture.git(fixture.remote, 'rev-parse', 'exhibit-data');
  const second = runPublish(fixture, fixture.repo, file);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, `prs/12/${HEAD_1}.json on exhibit-data on origin already holds this exhibit. Nothing changed.\n`);
  assert.equal(fixture.git(fixture.remote, 'rev-parse', 'exhibit-data'), tip);
  assert.equal(fixture.git(fixture.remote, 'rev-list', '--count', 'exhibit-data').trim(), '1');
});

test('storage: local writes to the folder and makes no git change', (t) => {
  const fixture = buildFixture(t);
  writeFileSync(join(fixture.repo, 'evidence.yml'), 'settings:\n  storage: local\n  local_path: ../stored\n');
  const file = fixture.writeExhibit(fixture.dir, 'evidence.json', exhibit(12, HEAD_1));
  const before = localState(fixture, fixture.repo);
  const remoteRefs = fixture.git(fixture.remote, 'for-each-ref');

  const run = runPublish(fixture, fixture.repo, file);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `Wrote ../stored/prs/12/${HEAD_1}.json.\n`);
  assert.equal(readFileSync(join(fixture.dir, 'stored', 'prs', '12', `${HEAD_1}.json`), 'utf8'), readFileSync(file, 'utf8'));
  assert.deepEqual(localState(fixture, fixture.repo), before);
  assert.equal(fixture.git(fixture.remote, 'for-each-ref'), remoteRefs);
});

test('an evidence file that does not fit the schema gives exit 2 and stores nothing', (t) => {
  const fixture = buildFixture(t);
  const bad = { ...exhibit(12, HEAD_1), verdict: 'probably_fine' };
  const file = fixture.writeExhibit(fixture.dir, 'evidence.json', bad);
  const folder = join(fixture.dir, 'stored');

  const toBranch = runPublish(fixture, fixture.repo, file);
  const toFolder = runPublish(fixture, fixture.repo, file, ['--storage', 'local', '--local-path', folder]);

  for (const run of [toBranch, toFolder]) {
    assert.equal(run.status, 2);
    assert.match(run.stderr, /does not fit the evidence\.json schema, so nothing was stored:\n {2}\/verdict: must be meets_policy, needs_person or error, not "probably_fine"/);
  }
  assert.equal(fixture.git(fixture.remote, 'for-each-ref', 'refs/heads/exhibit-data'), '');
  assert.equal(existsSync(folder), false);
  assert.deepEqual(readdirSync(fixture.dir).sort(), ['evidence.json', 'home', 'remote.git', 'repo']);
});

test('a remote that refuses the push gives exit 2 at once, with git\'s reason', (t) => {
  const fixture = buildFixture(t);
  const hook = join(fixture.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "pushes from CI are not allowed" >&2\nexit 1\n', { mode: 0o755 });
  const file = fixture.writeExhibit(fixture.dir, 'evidence.json', exhibit(12, HEAD_1));

  const run = runPublish(fixture, fixture.repo, file);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /^exhibit: could not push prs\/12\/1{40}\.json on exhibit-data to origin: .*pushes from CI are not allowed/);
  assert.equal(fixture.git(fixture.remote, 'for-each-ref', 'refs/heads/exhibit-data'), '');
  assert.equal(fixture.git(fixture.repo, 'for-each-ref', 'refs/exhibit'), '');
});
