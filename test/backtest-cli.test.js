import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './fixtures/git-env.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const replay = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
const fullDisk = fileURLToPath(new URL('../test-support/preload-full-disk.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/github/acme-widgets.json', import.meta.url));
const IDENTITY = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };

function newFolder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-backtest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs `exhibit ...args` in `cwd`, with a fetch that replays the acme/widgets fixture. failWrite:
// a write to a path that holds this text fails, as on a full disk.
function exhibit(cwd, args, { failWrite } = {}) {
  const env = gitEnv(cwd, { EXHIBIT_TEST_FIXTURE: fixture, GITHUB_TOKEN: 'test-token', ...IDENTITY });
  const preloads = ['--import', replay];
  if (failWrite !== undefined) {
    preloads.push('--import', fullDisk);
    env.EXHIBIT_TEST_FULL_DISK = failWrite;
  }
  return spawnSync(process.execPath, [...preloads, bin, ...args], { cwd, env, encoding: 'utf8' });
}

const read = (cwd, name) => readFileSync(join(cwd, name));

test('exhibit backtest leaves the history report byte for byte the same (ticket 259)', (t) => {
  const cwd = newFolder(t);
  const history = exhibit(cwd, ['history', '--repo', 'acme/widgets']);
  assert.equal(history.status, 0, history.stderr);
  const before = { md: read(cwd, '.exhibit/report.md'), html: read(cwd, '.exhibit/report.html'), lines: read(cwd, '.exhibit/history.jsonl') };

  const run = exhibit(cwd, ['backtest']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Backtest of all \d+ merged PRs in \.exhibit\/history\.jsonl\.\n/);
  assert.match(run.stdout, /Wrote the report to \.exhibit\/backtest\.md and \.exhibit\/backtest\.html\.\n$/);
  assert.ok(read(cwd, '.exhibit/backtest.md').toString().startsWith('# Backtest of the policy on acme/widgets\n'));
  assert.match(read(cwd, '.exhibit/backtest.html').toString(), /<title>Backtest of the policy on acme\/widgets<\/title>/);

  assert.ok(read(cwd, '.exhibit/report.md').equals(before.md), 'report.md changed');
  assert.ok(read(cwd, '.exhibit/report.html').equals(before.html), 'report.html changed');
  assert.ok(read(cwd, '.exhibit/history.jsonl').equals(before.lines), 'history.jsonl changed');
});

test('a backtest write that fails changes no backtest file and leaves no temporary file (ticket 259)', (t) => {
  const cwd = newFolder(t);
  assert.equal(exhibit(cwd, ['history', '--repo', 'acme/widgets']).status, 0);
  assert.equal(exhibit(cwd, ['backtest']).status, 0);
  const files = readdirSync(join(cwd, '.exhibit')).sort();
  const old = { md: read(cwd, '.exhibit/backtest.md'), html: read(cwd, '.exhibit/backtest.html') };

  // A later run with --from writes another report. The second file's write fails, after the first
  // one worked.
  const run = exhibit(cwd, ['backtest', '--from', '2026-02-01'], { failWrite: 'backtest.html' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^exhibit: could not write \.exhibit\/backtest\.html: ENOSPC/);
  assert.ok(read(cwd, '.exhibit/backtest.md').equals(old.md), 'backtest.md changed');
  assert.ok(read(cwd, '.exhibit/backtest.html').equals(old.html), 'backtest.html changed');
  assert.deepEqual(readdirSync(join(cwd, '.exhibit')).sort(), files);
});

test('exhibit backtest reads the exhibit of a PR from the data branch, and --json gives the counts', (t) => {
  const cwd = newFolder(t);
  assert.equal(exhibit(cwd, ['history', '--repo', 'acme/widgets']).status, 0);
  const lines = read(cwd, '.exhibit/history.jsonl').toString().trim().split('\n').map((line) => JSON.parse(line));
  const target = lines[0];
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd, IDENTITY) });
  // The exhibit goes on a data branch of its own, as exhibit publish stores it (spec 9.12).
  git('init', '-q', '-b', 'exhibit-data');
  const stored = {
    exhibit_version: '0.1.0', policy: { path: 'evidence.yml', sha256: null }, repo: 'acme/widgets', pr: target.number, base: target.base_sha, head: target.head_sha,
    classification: { kinds: [], risk: 'medium', fix: false, fix_signal: null, feature: false, signals_from: 'pr', merge_without_reading: 'never', used_default: true, policy_changed: false },
    requirements: [{ type: 'tests-before-after', params: {}, kinds: ['default'], status: 'met', details: {}, author: 'builder', duration_ms: 1 }],
    verdict: 'meets_policy', gaps: [], checks_by_author: { builder: 1, hidden: 0 }, flaky_tests: [], environment: { node: '20.x', os: 'linux' }, created_at: '2026-11-20T10:00:00Z'
  };
  const path = `prs/${target.number}/${target.head_sha}.json`;
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify(stored), encoding: 'utf8', env: gitEnv(cwd) }).trim();
  git('update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
  git('commit', '-q', '-m', 'exhibit');
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\ndefault:\n  risk: medium\n  needs: [tests-before-after]\n');

  const run = exhibit(cwd, ['backtest', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.evidence_from.exhibit, 1);
  assert.equal(result.evidence_from.exhibit + result.evidence_from.body + result.evidence_from.none, lines.length);
  assert.equal(result.test_set, lines.length);
  assert.deepEqual(result.report, { markdown: '.exhibit/backtest.md', html: '.exhibit/backtest.html' });
  assert.equal(result.labels, 'none');
});

test('exhibit backtest exits 2 with a plain message for a bad --from, a bad --budget, or no history', (t) => {
  const cwd = newFolder(t);
  const none = exhibit(cwd, ['backtest']);
  assert.equal(none.status, 2);
  assert.equal(none.stderr, 'exhibit: there is no .exhibit/history.jsonl in this folder. Run exhibit history first, inside a clone of the repo.\n');
  const bad = exhibit(cwd, ['backtest', '--from', '2026-02-30']);
  assert.equal(bad.stderr, 'exhibit: --from must be a real date like 2026-03-01 (UTC) or an ISO time, not "2026-02-30".\n');
  const budget = exhibit(cwd, ['backtest', '--rerun', '--budget', 'soon']);
  assert.equal(budget.stderr, 'exhibit: --budget must be a whole number of minutes, 1 or more, not "soon".\n');
});
