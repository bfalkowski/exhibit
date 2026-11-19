import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHistoryLine } from '../src/history-schema.js';
import { writeBigFixture } from './fixtures/github/acme-big.js';
import { buildSzzRepo } from './fixtures/szz-repo.js';
import { writeHistoryReplay } from './fixtures/szz-github.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const preload = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/github/${name}.json`, import.meta.url));

// Runs `exhibit ...args` in a new empty folder, with a fetch that replays the named fixture.
// token: null runs it with no GITHUB_TOKEN at all.
// fixturePath: a fixture file built by a test, in place of a named one.
function exhibit(args, { fixtureName = 'acme-widgets', fixturePath = fixture(fixtureName), token = 'test-token', cwd = mkdtempSync(join(tmpdir(), 'exhibit-')) } = {}) {
  const env = { ...process.env, EXHIBIT_TEST_FIXTURE: fixturePath };
  delete env.GITHUB_TOKEN;
  if (token !== null) env.GITHUB_TOKEN = token;
  const run = spawnSync(process.execPath, ['--import', preload, bin, ...args], { cwd, env, encoding: 'utf8' });
  return { ...run, cwd, historyPath: join(cwd, '.exhibit', 'history.jsonl') };
}

const notAClone = (repo) => `exhibit: note: SZZ did not run, because this folder is not a clone of ${repo}, so every szz is null. Run history inside a clone to link fix PRs to the PRs that added their lines.\n`;
const readLines = (path) => readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

test('exhibit history writes one schema-valid line for each merged PR, then exits 0', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  assert.deepEqual(lines.map((l) => l.number), [7, 4, 5, 3, 1]);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.match(run.stdout, /5 merged PRs/);
});

test('history marks fix PRs with the default signals when there is no evidence.yml', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  const fixes = readLines(run.historyPath).filter((l) => l.classification.fix);
  assert.deepEqual(fixes.map((l) => [l.number, l.classification.fix_signal]), [[5, 'label:bug']]);
});

test('a custom fix_signals list in evidence.yml replaces the defaults', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-'));
  writeFileSync(join(cwd, 'evidence.yml'), 'version: 3\nsettings:\n  fix_signals: [title:rename]\n');
  const run = exhibit(['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 0, run.stderr);
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  assert.deepEqual(lines.filter((l) => l.classification.fix).map((l) => [l.number, l.classification.fix_signal]), [[4, 'title:rename']]);
});

test('a malformed fix_signals gives exit 2 with a message, and writes no file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'exhibit-'));
  writeFileSync(join(cwd, 'evidence.yml'), 'settings:\n  fix_signals: [bug]\n');
  const run = exhibit(['history', '--repo', 'acme/widgets'], { cwd });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /evidence\.yml settings\.fix_signals\[0\] is "bug"/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
  assert.ok(!existsSync(run.historyPath));
});

test('a PR with more files than GitHub lists gives a warning on stderr that names it, and still exits 0', (t) => {
  const big = writeBigFixture();
  t.after(big.cleanup);
  const run = exhibit(['history', '--repo', 'acme/big', '--json'], { fixturePath: big.path });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, 'exhibit: warning: PR 9 changed 3412 files, but GitHub listed only the first 3000, so its files field is cut short.\n' + notAClone('acme/big'));
  assert.deepEqual(JSON.parse(run.stdout), { prs: 3, output: '.exhibit/history.jsonl', szz: null });
  assert.deepEqual(readLines(run.historyPath).map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
});

test('a failed request for the file count gives a warning, not a failed run', (t) => {
  const big = writeBigFixture({ unreadable: [9] });
  t.after(big.cleanup);
  const run = exhibit(['history', '--repo', 'acme/big'], { fixturePath: big.path });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^exhibit: warning: PR 9 has 3000 files listed, the most GitHub lists, so its files field may be cut short\. Exhibit could not read how many files it changed: GitHub answered 500/);
  assert.deepEqual(readLines(run.historyPath).map((l) => [l.number, l.files.length]), [[9, 3000], [8, 3000], [7, 2]]);
});

test('outside a clone, history writes szz: null on every line and says so in one line', () => {
  const run = exhibit(['history', '--repo', 'acme/widgets']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, notAClone('acme/widgets'));
  for (const line of readLines(run.historyPath)) assert.equal(line.szz, null, `PR ${line.number}`);
});

test('inside a clone of the repo, history links each fix PR to the PRs that added its lines', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir });
  const run = exhibit(['history', '--repo', 'fixture/shop'], { fixturePath: writeHistoryReplay(repo, 'fixture/shop'), cwd: repo.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, 'Wrote 12 merged PRs from fixture/shop to .exhibit/history.jsonl. SZZ found links for 6 of 6 fix PRs.\n');

  // Read the links back from the file history wrote.
  const lines = readLines(run.historyPath);
  for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  const fix7 = lines.find((line) => line.number === 7);
  assert.deepEqual(fix7.szz.links.map((link) => [link.pr, link.confidence]), [[2, 0.5], [3, 0.5]]);
  const [discount] = fix7.szz.links[0].lines;
  assert.equal(discount.path, 'src/discount.js');
  assert.equal(discount.text, '  return total - percent;');
  assert.equal(discount.blame.commit, lines.find((line) => line.number === 2).merge_sha);
  assert.equal(discount.blame.summary, 'Add discounts (#2)');
  assert.equal(lines.find((line) => line.number === 1).szz, null, 'a PR that is not a fix');
  // PR 12 was merged with "rebase and merge". Its links skip its own first commit.
  const fix12 = lines.find((line) => line.number === 12);
  assert.deepEqual(fix12.szz.links.map((link) => [link.pr, link.confidence]), [[1, 0.5], [11, 0.5]]);
});

test('--json gives the SZZ counts inside a clone', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/shop.git'], { cwd: repo.dir });
  const run = exhibit(['history', '--repo', 'fixture/shop', '--json'], { fixturePath: writeHistoryReplay(repo, 'fixture/shop'), cwd: repo.dir });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { prs: 12, output: '.exhibit/history.jsonl', szz: { fix_prs: 6, linked: 6, skipped: 0 } });
});

test('the summary counts the fix PRs that SZZ skipped, in text and in --json', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  // A clone of depth 1 holds only the newest commit, so SZZ skips every fix.
  const shallow = mkdtempSync(join(tmpdir(), 'exhibit-shallow-'));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${repo.dir}`, '.'], { cwd: shallow });
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/fixture/shop.git'], { cwd: shallow });
  const fixturePath = writeHistoryReplay(repo, 'fixture/shop');

  const text = exhibit(['history', '--repo', 'fixture/shop'], { fixturePath, cwd: shallow });
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, 'Wrote 12 merged PRs from fixture/shop to .exhibit/history.jsonl. SZZ found links for 0 of 6 fix PRs (6 skipped).\n');
  assert.equal(text.stderr.match(/SZZ skipped/g).length, 6);

  const json = exhibit(['history', '--repo', 'fixture/shop', '--json'], { fixturePath, cwd: shallow });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { prs: 12, output: '.exhibit/history.jsonl', szz: { fix_prs: 6, linked: 0, skipped: 6 } });
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
  assert.deepEqual(JSON.parse(run.stdout), { prs: 5, output: '.exhibit/history.jsonl', szz: null });
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
