import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLabelLine } from '../src/labels.js';
import { buildSzzRepo } from './fixtures/szz-repo.js';
import { writeHistoryReplay } from './fixtures/github/szz-replies.js';
import { gitEnv } from './fixtures/git-env.js';
import { SHOP_HISTORY } from './fixtures/report/shop-history.js';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const preload = fileURLToPath(new URL('../test-support/preload-replay-fetch.js', import.meta.url));
const RUN_HISTORY_FIRST = /Run exhibit history first/;

function newFolder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-label-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withHistory(t, text) {
  const cwd = newFolder(t);
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit', 'history.jsonl'), text);
  return cwd;
}

// Runs `exhibit label ...args` in `cwd`, with `input` as the typed answers.
const label = (cwd, args = [], input = '') => spawnSync(process.execPath, [bin, 'label', ...args], { cwd, input, encoding: 'utf8' });
const readLabels = (cwd) => readFileSync(join(cwd, '.exhibit', 'labels.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

test('label with no history file exits 2 and says to run exhibit history first', (t) => {
  const run = label(newFolder(t));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^exhibit: there is no \.exhibit\/history\.jsonl in this folder\. Run exhibit history first/);
});

test('label on a history with no SZZ links exits 2 and says to run exhibit history first', (t) => {
  const noLinks = readFileSync(SHOP_HISTORY, 'utf8').trimEnd().split('\n').map((line) => JSON.stringify({ ...JSON.parse(line), szz: null }) + '\n').join('');
  const cwd = withHistory(t, noLinks);
  const run = label(cwd);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /has no SZZ links/);
  assert.match(run.stderr, RUN_HISTORY_FIRST);
  assert.equal(existsSync(join(cwd, '.exhibit', 'labels.jsonl')), false);
});

test('typed answers are written as labels, and --json prints the summary', (t) => {
  const cwd = withHistory(t, readFileSync(SHOP_HISTORY, 'utf8'));
  // D-012: an empty answer is asked again. D-007: skipped. D-006: picks category 1 from the list.
  const typed = ['', 'Percent taken as money', 'arithmetic', 'A test with a 10% discount', 's', 'Tax rounded too early', '1', 'A rounding test'].join('\n') + '\n';
  const run = label(cwd, ['--json'], typed);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { shown: 3, labeled: 2, skipped: 1, open: 1, output: '.exhibit/labels.jsonl' });
  // Under --json the defects and the questions go to stderr, so stdout holds only the summary.
  assert.match(run.stderr, /D-012, 1 of 3 with no code yet/);
  assert.match(run.stderr, /Please type an answer/);
  assert.match(run.stderr, /1\. arithmetic/);
  const lines = readLabels(cwd);
  assert.deepEqual(lines.map((l) => [l.id, l.code, l.category, l.would_have_caught, l.labeled_by]), [
    ['D-012', 'Percent taken as money', 'arithmetic', 'A test with a 10% discount', 'person'],
    ['D-006', 'Tax rounded too early', 'arithmetic', 'A rounding test', 'person']
  ]);
  for (const line of lines) assert.deepEqual(checkLabelLine(line), [], line.id);
});

test('the end of the typed input quits and keeps the labels given so far', (t) => {
  const cwd = withHistory(t, readFileSync(SHOP_HISTORY, 'utf8'));
  const run = label(cwd, [], 'Percent taken as money\narithmetic\nA test\nhalf an answer\n');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Labeled 1 escaped defect\. Skipped 0\. 2 still have no code\. Run exhibit label again to label them\./);
  assert.deepEqual(readLabels(cwd).map((l) => l.id), ['D-012']);
});

test('a label that fails the schema exits 2, and the file keeps its earlier lines', (t) => {
  const cwd = withHistory(t, readFileSync(SHOP_HISTORY, 'utf8'));
  const run = label(cwd, [], `first\nx\na test\n${'y'.repeat(201)}\nx\na test\n`);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /the label for D-007 does not fit the labels schema, so it was not written/);
  assert.deepEqual(readLabels(cwd).map((l) => l.code), ['first']);
});

test('running exhibit history twice on the fixture repo gives the same defect ids, and keeps the labels', (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git'], { cwd: repo.dir, env: gitEnv(repo.dir) });
  const replay = writeHistoryReplay(repo, 'fixture/shop');
  t.after(replay.cleanup);
  const history = (args) => {
    const env = gitEnv(repo.dir, { EXHIBIT_TEST_FIXTURE: replay.path, GITHUB_TOKEN: 'test-token' });
    const run = spawnSync(process.execPath, ['--import', preload, bin, 'history', '--repo', 'fixture/shop', ...args], { cwd: repo.dir, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  // Skips every defect, so it writes nothing, and returns the ids it showed.
  const shownIds = () => [...label(repo.dir, [], 's\ns\ns\n').stdout.matchAll(/^(D-\d+), /gm)].map((m) => m[1]);

  history([]);
  const first = shownIds();
  assert.deepEqual(first, ['D-012', 'D-007', 'D-006']);
  history(['--full']);
  assert.deepEqual(shownIds(), first);

  const labeled = label(repo.dir, [], 'Percent taken as money\narithmetic\nA test\nq\n');
  assert.equal(labeled.status, 0, labeled.stderr);
  history(['--full']);
  // D-012 keeps its label after the new history, so label shows only the other two.
  assert.deepEqual(shownIds(), ['D-007', 'D-006']);
  assert.deepEqual(readLabels(repo.dir).map((l) => l.id), ['D-012']);
});

test('label refuses an unknown option with exit 2', (t) => {
  const run = label(newFolder(t), ['--claude']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage: exhibit label \[--json\]/);
});
