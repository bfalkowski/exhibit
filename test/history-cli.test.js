import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHistoryLine } from '../src/history-schema.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const preload = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/github/${name}.json`, import.meta.url));

// Runs `exhibit ...args` in a new empty folder, with a fetch that replays the named fixture.
// token: null runs it with no GITHUB_TOKEN at all.
function exhibit(args, { fixtureName = 'acme-widgets', token = 'test-token', cwd = mkdtempSync(join(tmpdir(), 'exhibit-')) } = {}) {
  const env = { ...process.env, EXHIBIT_TEST_FIXTURE: fixture(fixtureName) };
  delete env.GITHUB_TOKEN;
  if (token !== null) env.GITHUB_TOKEN = token;
  const run = spawnSync(process.execPath, ['--import', preload, bin, ...args], { cwd, env, encoding: 'utf8' });
  return { ...run, cwd, historyPath: join(cwd, '.exhibit', 'history.jsonl') };
}

const readLines = (path) => readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

test('exhibit history writes one schema-valid line for each merged PR, then exits 0', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5, 3, 1]);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.match(run.stdout, /5 merged PRs/);
});

test('--since keeps PRs merged on or after the date', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets', '--since', '2026-03-01']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readLines(run.historyPath).map((l) => l.number), [7, 4, 5]);
});

test('--limit keeps the newest N merged PRs', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets', '--limit', '2']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readLines(run.historyPath).map((l) => l.number), [7, 4]);
});

test('--json prints a short machine summary', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { prs: 5, output: '.exhibit/history.jsonl' });
});

test('a record that fails the schema gives exit 2, names the PR, and writes no file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-'));
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), 'old\n');
  const run = exhibit(['history', '--repo', 'acme/broken'], { fixtureName: 'acme-broken', cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /PR 1/);
  assert.match(run.stderr, /\/files\/0\/additions/);
  assert.equal(readFileSync(run.historyPath, 'utf8'), 'old\n', 'the old file stays as it was');
  assert.deepEqual(readdirSync(join(cwd, '.exhibit')), ['history.jsonl'], 'no temporary file is left');
});

test('a missing GITHUB_TOKEN gives exit 2 and says to set it', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets'], { token: null });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /GITHUB_TOKEN/);
  assert.ok(!existsSync(run.historyPath));
});

test('an unknown repo gives exit 2 and says to check the name', () => {
  const run = exhibit(['history', '--repo', 'acme/nothing-here'], { fixtureName: 'unknown-repo' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /404/);
  assert.match(run.stderr, /repo name/);
  assert.ok(!existsSync(run.historyPath));
});

test('an API 500 gives exit 2 and says to try again later', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets'], { fixtureName: 'server-error' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /500/);
  assert.match(run.stderr, /try again later/);
  assert.ok(!existsSync(run.historyPath));
});

test('bad arguments give exit 2 and say what is wrong', () => {
  for (const [args, message] of [
    [['history'], /--repo/],
    [['history', '--repo', 'not-a-repo'], /owner\/name/],
    [['history', '--repo', 'acme/widgets', '--since', 'last week'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-02-30'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-04-31T10:00:00Z'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-02-30T10:00:00+01:00'], /--since/],
    [['history', '--repo', 'acme/widgets', '--since', '2026-13-01'], /--since/],
    [['history', '--repo', 'acme/widgets', '--limit', '0'], /--limit/],
    [['history', '--repo', 'acme/widgets', '--frobnicate'], /frobnicate/]
  ]) {
    const run = exhibit(args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, message, args.join(' '));
  }
});

test('a folder that cannot be written gives exit 2 and a message, not a stack trace', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-'));
  writeFileSync(join(cwd, '.exhibit'), 'a plain file where the folder should be');
  const run = exhibit(['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /could not write \.exhibit\/history\.jsonl/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});
