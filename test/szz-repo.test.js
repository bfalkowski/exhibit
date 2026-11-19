import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { checkHistoryLine } from '../src/history-schema.js';
import { buildSzzRepo, readAnswerKey } from './fixtures/szz-repo.js';
import { gitEnv } from './fixtures/git-env.js';

// Give git a clean env, as the builder does: see gitEnv.
function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) });
}

// The commit and its parents: one parent for a squash commit, two for a merge commit.
function parentsOf(dir, sha) {
  return git(dir, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ');
}

// The first commit on a PR's branch, oldest first from the PR's base.
function firstCommit(dir, pr) {
  return git(dir, ['rev-list', '--reverse', `${pr.base_sha}..refs/pull/${pr.number}/head`]).trim().split('\n')[0];
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

// Which PR made a commit: a commit the PR put on main (a squash commit or a rebased copy), or a
// commit on the branch of a merge commit.
function prOfCommit(dir, { history, onMain }, sha) {
  for (const pr of history) {
    if (onMain.get(pr.number).includes(sha)) return pr.number;
    const parents = parentsOf(dir, pr.merge_sha);
    if (parents.length === 3) {
      const branch = git(dir, ['rev-list', `${parents[1]}..${parents[2]}`]).trim().split('\n');
      if (branch.includes(sha)) return pr.number;
    }
  }
  return null;
}

// The commit that last touched each line a fix deleted, as { path, line, sha }.
// It blames the parent of the fix's first commit on main, as spec 9.2 says.
// `parent` can be another commit, to show what a wrong choice would blame.
function blamedCommits(dir, { onMain }, fix, parent = `${onMain.get(fix.number)[0]}^1`) {
  return deletedLines(dir, parent, fix.merge_sha).map(({ path, line }) => {
    const out = git(dir, ['blame', '--porcelain', '-L', `${line},${line}`, parent, '--', path]);
    return { path, line, sha: out.slice(0, 40) };
  });
}

// The PRs that last touched the lines a fix deleted. This is a bare blame with no filters,
// so it links the whitespace, move and comment cases too. SZZ must filter those out.
function blamedPrs(dir, built, fix, parent) {
  const prs = new Set(blamedCommits(dir, built, fix, parent).map(({ sha }) => prOfCommit(dir, built, sha)));
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
    assert.deepEqual(history.map((pr) => pr.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const pr of history) {
      for (const field of ['number', 'title', 'body', 'author', 'labels', 'merged_at', 'base_sha', 'merge_sha', 'files', 'classification']) {
        assert.ok(field in pr, `PR ${pr.number} has ${field}`);
      }
      assert.match(pr.base_sha, /^[0-9a-f]{40}$/);
      assert.match(pr.merge_sha, /^[0-9a-f]{40}$/);
      assert.equal(typeof pr.classification.fix, 'boolean');
      assert.deepEqual(checkHistoryLine(pr), [], `PR ${pr.number} passes the history schema`);
    }
  });

  await t.test('main is a chain of the commits each PR put there, and merge_sha is the last of them', () => {
    const firstParents = git(dir, ['rev-list', '--first-parent', '--reverse', 'main']).trim().split('\n');
    assert.deepEqual(firstParents.slice(1), history.flatMap((pr) => repo.onMain.get(pr.number)));
    for (const pr of history) assert.equal(repo.onMain.get(pr.number).at(-1), pr.merge_sha, `PR ${pr.number}`);
  });

  await t.test('PRs are merged all three ways, and refs/pull/N/head keeps each branch', () => {
    const ways = new Set();
    for (const pr of history) {
      const parents = parentsOf(dir, pr.merge_sha);
      const copies = repo.onMain.get(pr.number);
      const branch = git(dir, ['rev-list', '--reverse', `${pr.base_sha}..refs/pull/${pr.number}/head`]).trim().split('\n');
      const way = parents.length === 3 ? 'merge' : copies.length > 1 ? 'rebase' : 'squash';
      ways.add(way);
      const head = git(dir, ['rev-parse', `refs/pull/${pr.number}/head`]).trim();
      if (way === 'merge') assert.equal(parents[2], head);
      else assert.equal(git(dir, ['rev-parse', `${pr.merge_sha}^{tree}`]), git(dir, ['rev-parse', `${head}^{tree}`]));
      if (way === 'rebase') {
        // One new copy on main for each commit of the PR, with the same author and message.
        assert.equal(copies.length, branch.length);
        const show = (sha) => git(dir, ['log', '-1', '--format=%an %s', sha]);
        assert.deepEqual(copies.map(show), branch.map(show));
        for (const sha of copies) assert.ok(!branch.includes(sha), `PR ${pr.number}: ${sha} is a copy`);
      }
    }
    assert.deepEqual([...ways].sort(), ['merge', 'rebase', 'squash']);
  });

  await t.test('head_sha is the head commit, not the merge commit, and git merge-base needs only the line', () => {
    const squashed = history.filter((pr) => parentsOf(dir, pr.merge_sha).length === 2 && repo.onMain.get(pr.number).length === 1);
    assert.ok(squashed.length > 0, 'the fixture has a squash merge');
    for (const pr of history) {
      assert.equal(pr.head_sha, git(dir, ['rev-parse', `refs/pull/${pr.number}/head`]).trim(), `PR ${pr.number}`);
      // The merge-base of the PR's branch and the main branch just before the merge. Every PR
      // here left main at base_sha, so the two must be the same.
      assert.equal(git(dir, ['merge-base', pr.head_sha, `${pr.merge_sha}^1`]).trim(), pr.base_sha, `PR ${pr.number}`);
    }
    for (const pr of squashed) {
      assert.notEqual(pr.head_sha, pr.merge_sha, `PR ${pr.number}`);
      // A squash commit is not on the PR's branch at all.
      assert.throws(() => git(dir, ['merge-base', '--is-ancestor', pr.merge_sha, pr.head_sha]), undefined, `PR ${pr.number}`);
    }
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
    const fixes = history.filter((pr) => pr.classification.fix).map((pr) => pr.number);
    assert.deepEqual(key.fixes.map((f) => f.fix_pr).sort((a, b) => a - b), fixes);
  });

  await t.test("for each fix, the parent of its first commit on main is the main branch just before the fix, where spec 9.2 blames", () => {
    for (const fix of history.filter((pr) => pr.classification.fix)) {
      const before = history[history.indexOf(fix) - 1].merge_sha;
      const [, parent] = parentsOf(dir, repo.onMain.get(fix.number)[0]);
      assert.equal(parent, before, `PR ${fix.number}`);
    }
  });

  await t.test('the rebase-merged fix is a trap: blaming merge_sha^1 links the fix to itself', () => {
    const fix = key.fixes.find((f) => f.case === 'a fix merged with rebase and merge');
    const pr = byNumber.get(fix.fix_pr);
    assert.deepEqual(blamedPrs(dir, repo, pr, `${pr.merge_sha}^1`), [fix.fix_pr]);
  });

  await t.test("PR 7's tax.js line comes from the first of PR 3's two commits", () => {
    const tax = blamedCommits(dir, repo, byNumber.get(7)).filter(({ path }) => path === 'src/tax.js');
    assert.equal(tax.length, 1);
    const pr3 = byNumber.get(3);
    const commits = git(dir, ['rev-list', `${pr3.base_sha}..refs/pull/3/head`]).trim().split('\n');
    assert.equal(commits.length, 2);
    assert.equal(tax[0].sha, firstCommit(dir, pr3));
  });

  await t.test('each fix changes lines that blame points to the expected PRs', () => {
    for (const fix of key.fixes.filter((f) => f.introducing_prs.length > 0)) {
      assert.deepEqual(blamedPrs(dir, repo, byNumber.get(fix.fix_pr)), fix.introducing_prs, fix.case);
    }
    const cases = key.fixes.map((f) => f.introducing_prs.length);
    assert.ok(cases.includes(1) && cases.includes(2), 'a one-link case and a two-link case');
  });

  await t.test('each no-link case is a trap: a bare blame would still link a PR', () => {
    for (const fix of key.fixes.filter((f) => f.introducing_prs.length === 0)) {
      const linked = blamedPrs(dir, repo, byNumber.get(fix.fix_pr));
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

    // Every deleted line is added back. The fix also adds a line that exports receipt from its
    // new file, but an added line has nothing to blame.
    const moved = diff(noLink.get('moved lines only'));
    const added = changed(moved, '+');
    assert.ok(changed(moved, '-').length > 0);
    for (const row of changed(moved, '-')) assert.ok(added.includes(row), row);

    const comments = diff(noLink.get('comments only'));
    const rows = [...changed(comments, '-'), ...changed(comments, '+')];
    assert.ok(rows.length > 0);
    for (const row of rows) assert.match(row, /^\s*\/\//);
  });
});
