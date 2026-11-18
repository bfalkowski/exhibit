import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { buildSzzRepo, readAnswerKey } from './fixtures/szz-repo.js';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

// Every ref and every commit, with its tree, parents, author and dates.
// Equal SHAs mean equal content, order and dates.
function snapshot(dir) {
  return {
    refs: git(dir, ['for-each-ref', '--format=%(refname) %(objectname)']),
    log: git(dir, ['log', '--all', '--topo-order', '--format=%H %T %P|%an|%aI|%cI|%s'])
  };
}

// The lines a PR deleted, as { path, line } on the PR's base side.
function deletedLines(dir, from, to) {
  const out = git(dir, ['diff', '-U0', '--no-renames', from, to]);
  const lines = [];
  let path = null;
  for (const row of out.split('\n')) {
    if (row.startsWith('--- ')) path = row === '--- /dev/null' ? null : row.slice(6);
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(row);
    if (hunk && path) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) lines.push({ path, line: start + i });
    }
  }
  return lines;
}

// Which PR made a commit: the squash commit itself, or a commit on the branch of a merge commit.
function prOfCommit(dir, history, sha) {
  for (const pr of history) {
    if (pr.merge_sha === sha) return pr.number;
    const parents = git(dir, ['rev-list', '--parents', '-n', '1', pr.merge_sha]).trim().split(' ');
    if (parents.length === 3) {
      const branch = git(dir, ['rev-list', `${parents[1]}..${parents[2]}`]).trim().split('\n');
      if (branch.includes(sha)) return pr.number;
    }
  }
  return null;
}

// The PRs that last touched the lines a fix deleted. This is a bare blame with no filters,
// so it links the whitespace, move and comment cases too. SZZ must filter those out.
function blamedPrs(dir, history, fix) {
  const parent = `${fix.merge_sha}^1`;
  const prs = new Set();
  for (const { path, line } of deletedLines(dir, parent, fix.merge_sha)) {
    const out = git(dir, ['blame', '--porcelain', '-L', `${line},${line}`, parent, '--', path]);
    prs.add(prOfCommit(dir, history, out.slice(0, 40)));
  }
  return [...prs].sort((a, b) => a - b);
}

test('the helper builds the same repo and records every time', (t) => {
  const first = buildSzzRepo();
  const second = buildSzzRepo();
  t.after(() => {
    first.cleanup();
    second.cleanup();
  });
  assert.notEqual(first.dir, second.dir);
  assert.deepEqual(snapshot(second.dir), snapshot(first.dir));
  assert.deepEqual(second.history, first.history);
  assert.equal(
    readFileSync(second.historyPath, 'utf8'),
    readFileSync(first.historyPath, 'utf8')
  );
});

test('cleanup removes the temp directory', () => {
  const repo = buildSzzRepo();
  assert.ok(existsSync(repo.dir));
  repo.cleanup();
  assert.equal(existsSync(repo.dir), false);
});

test('the fixture repo and its records match the answer key', async (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const key = readAnswerKey();
  const { dir, history } = repo;
  const byNumber = new Map(history.map((pr) => [pr.number, pr]));

  await t.test('history.jsonl holds one record per line, in merge order', () => {
    const rows = readFileSync(repo.historyPath, 'utf8').trim().split('\n').map((r) => JSON.parse(r));
    assert.deepEqual(rows, history);
    assert.deepEqual(history.map((pr) => pr.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const pr of history) {
      for (const field of ['number', 'title', 'body', 'author', 'labels', 'merged_at', 'base_sha', 'merge_sha', 'files', 'classification']) {
        assert.ok(field in pr, `PR ${pr.number} has ${field}`);
      }
      assert.match(pr.base_sha, /^[0-9a-f]{40}$/);
      assert.match(pr.merge_sha, /^[0-9a-f]{40}$/);
      assert.equal(typeof pr.classification.is_fix, 'boolean');
    }
  });

  await t.test('main is a chain of merge commits and squash commits, one per PR', () => {
    const firstParents = git(dir, ['rev-list', '--first-parent', '--reverse', 'main']).trim().split('\n');
    assert.deepEqual(firstParents.slice(1), history.map((pr) => pr.merge_sha));
  });

  await t.test('PRs are merged both ways, and refs/pull/N/head keeps each branch', () => {
    const ways = new Set();
    for (const pr of history) {
      const parents = git(dir, ['rev-list', '--parents', '-n', '1', pr.merge_sha]).trim().split(' ');
      const way = parents.length === 3 ? 'merge' : 'squash';
      ways.add(way);
      const head = git(dir, ['rev-parse', `refs/pull/${pr.number}/head`]).trim();
      if (way === 'merge') assert.equal(parents[2], head);
      else assert.equal(git(dir, ['rev-parse', `${pr.merge_sha}^{tree}`]), git(dir, ['rev-parse', `${head}^{tree}`]));
    }
    assert.deepEqual([...ways].sort(), ['merge', 'squash']);
  });

  await t.test('a merge-commit PR had a stale base, so its merge joins two lines of work', () => {
    const pr3 = byNumber.get(3);
    assert.notEqual(git(dir, ['rev-parse', `${pr3.merge_sha}^1`]).trim(), pr3.base_sha);
    assert.equal(git(dir, ['merge-base', `${pr3.merge_sha}^1`, `${pr3.merge_sha}^2`]).trim(), pr3.base_sha);
  });

  await t.test('files in each record match the PR diff', () => {
    for (const pr of history) {
      const head = `refs/pull/${pr.number}/head`;
      const out = git(dir, ['diff', '--numstat', `${pr.base_sha}...${head}`]).trim().split('\n');
      const files = out.map((row) => {
        const [additions, deletions, path] = row.split('\t');
        return { path, additions: Number(additions), deletions: Number(deletions) };
      });
      assert.deepEqual(pr.files, files, `PR ${pr.number}`);
    }
  });

  await t.test('the answer key names every fix PR, and only fix PRs', () => {
    const fixes = history.filter((pr) => pr.classification.is_fix).map((pr) => pr.number);
    assert.deepEqual(key.fixes.map((f) => f.fix_pr).sort((a, b) => a - b), fixes);
  });

  await t.test('each fix changes lines that blame points to the expected PRs', () => {
    for (const fix of key.fixes.filter((f) => f.introducing_prs.length > 0)) {
      assert.deepEqual(blamedPrs(dir, history, byNumber.get(fix.fix_pr)), fix.introducing_prs, fix.case);
    }
    const cases = key.fixes.map((f) => f.introducing_prs.length);
    assert.ok(cases.includes(1) && cases.includes(2), 'a one-link case and a two-link case');
  });

  await t.test('each no-link case is a trap: a bare blame would still link a PR', () => {
    for (const fix of key.fixes.filter((f) => f.introducing_prs.length === 0)) {
      const linked = blamedPrs(dir, history, byNumber.get(fix.fix_pr));
      assert.ok(linked.length > 0 && !linked.includes(null), fix.case);
    }
  });

  await t.test('the no-link fixes change only whitespace, only move lines, or only comments', () => {
    const noLink = new Map(key.fixes.filter((f) => f.introducing_prs.length === 0).map((f) => [f.case, f.fix_pr]));
    assert.deepEqual([...noLink.keys()].sort(), ['comments only', 'moved lines only', 'whitespace only']);

    const diff = (n, flags = []) => {
      const pr = byNumber.get(n);
      return git(dir, ['diff', '-U0', ...flags, `${pr.merge_sha}^1`, pr.merge_sha]);
    };
    const changed = (text, sign) => text.split('\n')
      .filter((r) => r.startsWith(sign) && !r.startsWith(sign.repeat(3)))
      .map((r) => r.slice(1));

    const ws = noLink.get('whitespace only');
    assert.notEqual(diff(ws), '');
    assert.equal(diff(ws, ['-w']), '');

    const moved = diff(noLink.get('moved lines only'));
    assert.ok(changed(moved, '-').length > 0);
    assert.deepEqual(changed(moved, '-').sort(), changed(moved, '+').sort());

    const comments = diff(noLink.get('comments only'));
    const rows = [...changed(comments, '-'), ...changed(comments, '+')];
    assert.ok(rows.length > 0);
    for (const row of rows) assert.match(row, /^\s*\/\//);
  });
});
