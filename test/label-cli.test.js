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
// The shop fixture's PRs 1 to 12, with its escaped defects D-012, D-007 and D-006. The fixture
// can gain PRs, so the tests pin this part of it.
const shopText = () => readFileSync(SHOP_HISTORY, 'utf8').trimEnd().split('\n').filter((line) => JSON.parse(line).number <= 12).map((line) => line + '\n').join('');

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
  const noLinks = shopText().trimEnd().split('\n').map((line) => JSON.stringify({ ...JSON.parse(line), szz: null }) + '\n').join('');
  const cwd = withHistory(t, noLinks);
  const run = label(cwd);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /has no SZZ links/);
  assert.match(run.stderr, RUN_HISTORY_FIRST);
  assert.equal(existsSync(join(cwd, '.exhibit', 'labels.jsonl')), false);
});

test('typed answers are written as labels, and --json prints the summary', (t) => {
  const cwd = withHistory(t, shopText());
  // D-012: an empty answer and an unknown one are asked again, then it keeps the link to PR 1 and
  // rejects the link to PR 11. D-007: skipped. D-006: keeps its link and picks category 1.
  const typed = ['', 'x', 'k', 'r', 'Percent taken as money', 'arithmetic', 'A test with a 10% discount', 's', 'k', 'Tax rounded too early', '1', 'A rounding test'].join('\n') + '\n';
  const run = label(cwd, ['--json'], typed);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { shown: 3, labeled: 2, skipped: 1, open: 1, output: '.exhibit/labels.jsonl' });
  // Under --json the defects and the questions go to stderr, so stdout holds only the summary.
  assert.match(run.stderr, /D-012, 1 of 3 with no code yet/);
  assert.match(run.stderr, /Please type an answer/);
  assert.match(run.stderr, /Please type k, r or s/);
  assert.match(run.stderr, /Link to PR 11, confidence 50%: k to keep it, or r to reject it/);
  assert.match(run.stderr, /1\. arithmetic/);
  const lines = readLabels(cwd);
  assert.deepEqual(lines.map((l) => [l.id, l.introducing_prs, l.rejected_prs, l.szz_link_rejected, l.code, l.category, l.would_have_caught, l.labeled_by]), [
    ['D-012', [1], [11], true, 'Percent taken as money', 'arithmetic', 'A test with a 10% discount', 'person'],
    ['D-006', [1], [], false, 'Tax rounded too early', 'arithmetic', 'A rounding test', 'person']
  ]);
  for (const line of lines) assert.deepEqual(checkLabelLine(line), [], line.id);
});

test('the end of the typed input quits and keeps the labels given so far', (t) => {
  const cwd = withHistory(t, shopText());
  const run = label(cwd, [], 'k\nk\nPercent taken as money\narithmetic\nA test\nhalf an answer\n');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Labeled 1 escaped defect\. Skipped 0\. 2 still have no code\. Run exhibit label again to label them\./);
  assert.deepEqual(readLabels(cwd).map((l) => l.id), ['D-012']);
});

test('a label that fails the schema exits 2, and the file keeps its earlier lines', (t) => {
  const cwd = withHistory(t, shopText());
  const run = label(cwd, [], `k\nk\nfirst\nx\na test\nk\nk\n${'y'.repeat(201)}\nx\na test\n`);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /the label for D-007 does not fit the labels schema, so it was not written/);
  assert.deepEqual(readLabels(cwd).map((l) => l.code), ['first']);
});

// The fixture repo with a remote, and `history(args)` to run exhibit history in it with replayed
// GitHub replies. `shownIds()` runs exhibit label, skips every defect, and returns the ids it showed.
function fixtureRepo(t) {
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
  const shownIds = () => [...label(repo.dir, [], 's\n'.repeat(20)).stdout.matchAll(/^(D-\d+), /gm)].map((m) => m[1]);
  return { dir: repo.dir, history, shownIds };
}

test('running exhibit history twice on the fixture repo gives the same defect ids, and keeps the labels', (t) => {
  const repo = fixtureRepo(t);
  const { history, shownIds } = repo;

  history([]);
  const first = shownIds();
  assert.ok(first.includes('D-012') && first.includes('D-007') && first.includes('D-006'), first.join(' '));
  history(['--full']);
  assert.deepEqual(shownIds(), first);

  // Label the first defect shown, keeping its one link, then quit.
  assert.equal(first[0], 'D-014');
  const labeled = label(repo.dir, [], 'k\nA code\na category\nA test\nq\n');
  assert.equal(labeled.status, 0, labeled.stderr);
  history(['--full']);
  // The labeled defect keeps its label after the new history, so label shows only the others.
  assert.deepEqual(shownIds(), first.slice(1));
  assert.deepEqual(readLabels(repo.dir).map((l) => l.id), [first[0]]);
});

test('after exhibit history runs again on the fixture repo, a labeled defect keeps its rejected link', (t) => {
  const { dir, history, shownIds } = fixtureRepo(t);
  history([]);
  // Skip D-014. For D-012, keep the link to PR 1, reject the link to PR 11, and label it.
  const run = label(dir, [], 's\nk\nr\nPercent taken as money\narithmetic\nA test with a 10% discount\nq\n');
  assert.equal(run.status, 0, run.stderr);
  const before = readFileSync(join(dir, '.exhibit', 'labels.jsonl'), 'utf8');
  const [line] = readLabels(dir);
  assert.deepEqual([line.id, line.introducing_prs, line.rejected_prs, line.szz_link_rejected], ['D-012', [1], [11], true]);

  history(['--full']);
  // SZZ still links fix PR 12 to PR 11 in the new history.
  const fix = readFileSync(join(dir, '.exhibit', 'history.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)).find((l) => l.number === 12);
  assert.deepEqual(fix.szz.links.map((link) => link.pr), [1, 11]);
  // But the label keeps the rejection, and label does not ask about D-012 again.
  assert.equal(readFileSync(join(dir, '.exhibit', 'labels.jsonl'), 'utf8'), before);
  assert.equal(shownIds().includes('D-012'), false);
});

test('label refuses an unknown option with exit 2', (t) => {
  const run = label(newFolder(t), ['--claude']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage: exhibit label \[--json\]/);
});
