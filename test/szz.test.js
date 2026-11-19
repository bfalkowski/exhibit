import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHub } from '../src/github.js';
import { checkHistoryLine } from '../src/history-schema.js';
import { addSzz, cloneRoot, createPrFinder, parseRemovedLines } from '../src/szz.js';
import { replayFetch } from '../test-support/replay-fetch.js';
import { buildSzzRepo, readAnswerKey } from './fixtures/szz-repo.js';
import { commitPullsFetch } from './fixtures/szz-github.js';

const REPO = 'fixture/shop';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

// Builds the fixture repo, runs SZZ on its history with a GitHub that answers from the repo's
// own PR refs, and returns the lines with szz filled.
async function szzOnFixture(t) {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const fetch = commitPullsFetch(repo, REPO);
  const github = createGitHub({ token: 't', fetch });
  const lines = await addSzz(repo.history, { dir: repo.dir, repo: REPO, github });
  return { repo, lines, fetch, byNumber: new Map(lines.map((line) => [line.number, line])) };
}

const linkedPrs = (line) => line.szz.links.map((link) => link.pr).sort((a, b) => a - b);

test('SZZ on the fixture repo', async (t) => {
  const { repo, lines, fetch, byNumber } = await szzOnFixture(t);
  const key = readAnswerKey();

  for (const fix of key.fixes.filter((f) => f.introducing_prs.length > 0)) {
    await t.test(`finds every expected link: PR ${fix.fix_pr}, ${fix.case}`, () => {
      assert.deepEqual(linkedPrs(byNumber.get(fix.fix_pr)), fix.introducing_prs);
    });
  }

  // Ticket 8 drops whitespace-only, comment-only and moved lines. Until it lands, these fixes
  // still give links.
  for (const fix of key.fixes.filter((f) => f.introducing_prs.length === 0)) {
    await t.test(`makes no link: PR ${fix.fix_pr}, ${fix.case}`, { todo: 'ticket 8 drops these lines' }, () => {
      assert.deepEqual(linkedPrs(byNumber.get(fix.fix_pr)), []);
    });
  }

  await t.test('finds links through squash merges and through merge commits', () => {
    // PR 2 is a squash merge: its commit is a merge SHA in the history. PR 1 and PR 3 are merge
    // commits: blame points to a commit on their branch, so the API maps it.
    const pr1 = byNumber.get(6).szz.links[0];
    const pr2 = byNumber.get(7).szz.links.find((link) => link.pr === 2);
    const pr3 = byNumber.get(7).szz.links.find((link) => link.pr === 3);
    assert.equal(pr2.lines[0].blame.commit, byNumber.get(2).merge_sha);
    assert.notEqual(pr1.lines[0].blame.commit, byNumber.get(1).merge_sha);
    assert.notEqual(pr3.lines[0].blame.commit, byNumber.get(3).merge_sha);
  });

  await t.test('asks the API only for commits that are not merge SHAs, once each', () => {
    const asked = fetch.calls.map((call) => call.key);
    assert.equal(new Set(asked).size, asked.length);
    const mergeShas = new Set(repo.history.map((pr) => pr.merge_sha));
    for (const key of asked) assert.ok(!mergeShas.has(key.split('/')[5]), key);
  });

  await t.test('the two-PR fix gives two links whose confidence scores add up to 1', () => {
    const links = byNumber.get(7).szz.links;
    assert.equal(links.length, 2);
    assert.equal(links.reduce((sum, link) => sum + link.confidence, 0), 1);
    assert.deepEqual(links.map((link) => link.confidence), [0.5, 0.5]);
  });

  await t.test('a one-PR fix gives one link with confidence 1', () => {
    assert.deepEqual(byNumber.get(6).szz.links.map((link) => [link.pr, link.confidence]), [[1, 1]]);
  });

  await t.test('each link carries its lines and the blame output for them', () => {
    const [line] = byNumber.get(6).szz.links[0].lines;
    const blamed = git(repo.dir, ['rev-parse', `${byNumber.get(6).merge_sha}^1`]);
    assert.equal(byNumber.get(6).szz.blamed_commit, blamed);
    assert.deepEqual(line, {
      path: 'src/cart.js',
      line: 4,
      text: '    sum += item.price;',
      blame: {
        commit: git(repo.dir, ['rev-list', '-n', '1', 'refs/pull/1/head']),
        original_path: 'src/cart.js',
        original_line: 4,
        author: 'ana',
        author_time: line.blame.author_time,
        summary: 'Add cart subtotal'
      }
    });
    assert.match(line.blame.author_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // The blame output agrees with git blame run by hand.
    const out = git(repo.dir, ['blame', '--porcelain', '-L', '4,4', blamed, '--', 'src/cart.js']);
    assert.equal(out.slice(0, 40), line.blame.commit);
  });

  await t.test('a rebase-merged fix is blamed at the parent of its first commit on main', () => {
    const fix = byNumber.get(12);
    const [first] = repo.onMain.get(12);
    assert.equal(repo.onMain.get(12).length, 2);
    assert.equal(fix.szz.blamed_commit, git(repo.dir, ['rev-parse', `${first}^1`]));
    assert.deepEqual(fix.szz.links.map((link) => [link.pr, link.confidence]), [[1, 0.5], [11, 0.5]]);
    // PR 11 was rebase-merged too: its line is blamed on its copy on main, not its branch.
    assert.equal(fix.szz.links[1].lines[0].blame.commit, repo.onMain.get(11)[0]);
    assert.deepEqual(fix.szz.unlinked_lines, []);
  });

  await t.test("to find a fix's first commit, asks GitHub only about commits that are not merge SHAs", () => {
    // PR 12's walk asks about its first copy on main. The next parent is PR 11's merge_sha, so
    // the walk stops there with no request. A squash fix's parent is a merge SHA too.
    const asked = fetch.calls.map((call) => call.key.split('/')[5]);
    assert.ok(asked.includes(repo.onMain.get(12)[0]));
    for (const n of [7, 9]) assert.ok(!asked.includes(byNumber.get(n).merge_sha), `PR ${n}`);
  });

  await t.test('PRs that are not fixes get szz: null', () => {
    for (const line of lines.filter((l) => !l.classification.fix)) assert.equal(line.szz, null, `PR ${line.number}`);
  });

  await t.test('every line passes the schema', () => {
    for (const line of lines) assert.deepEqual(checkHistoryLine(line), [], `PR ${line.number}`);
  });
});

test('SZZ gives szz: null and a warning when the fix merge commit is not in the clone', async (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const missing = { ...repo.history.find((pr) => pr.number === 6), merge_sha: 'f'.repeat(40) };
  const warnings = [];
  const github = createGitHub({ token: 't', fetch: commitPullsFetch(repo, REPO) });
  const [line] = await addSzz([missing], { dir: repo.dir, repo: REPO, github, warn: (text) => warnings.push(text) });
  assert.equal(line.szz, null);
  assert.deepEqual(warnings, [`PR 6: SZZ skipped, because its merge commit ${'f'.repeat(40)} is not in this clone. Run git fetch, then run history again.`]);
});

test('commit-to-PR mapping', async (t) => {
  const recorded = fileURLToPath(new URL('./fixtures/github/building58-commit-pulls.json', import.meta.url));
  const repo = 'bfalkowski/Building58';
  const github = () => {
    const fetch = replayFetch(recorded);
    return { fetch, github: createGitHub({ token: 't', fetch }) };
  };

  await t.test('a merge SHA in the history maps to its PR with no API request', async () => {
    const { fetch, github: gh } = github();
    const find = createPrFinder({ lines: [{ number: 41, merge_sha: 'a'.repeat(40) }], repo, github: gh });
    assert.equal(await find('a'.repeat(40)), 41);
    assert.equal(fetch.calls.length, 0);
  });

  await t.test('any other commit maps through the API to the merged PR that holds it', async () => {
    const { fetch, github: gh } = github();
    const find = createPrFinder({ lines: [], repo, github: gh });
    assert.equal(await find('18ce79d6f068f5fc57cf63497ea5f398356eab68'), 82);
    assert.equal(await find('18ce79d6f068f5fc57cf63497ea5f398356eab68'), 82);
    assert.equal(fetch.calls.length, 1, 'the answer is kept, so the API is asked once');
  });

  await t.test('a commit GitHub does not know (422) maps to no PR', async () => {
    const { github: gh } = github();
    const find = createPrFinder({ lines: [], repo, github: gh });
    assert.equal(await find('0000000000000000000000000000000000000001'), null);
  });

  await t.test('only merged PRs count, and the first one merged wins', async () => {
    const pulls = [
      { number: 9, merged_at: null },
      { number: 8, merged_at: '2026-02-01T00:00:00Z' },
      { number: 7, merged_at: '2026-01-01T00:00:00Z' }
    ];
    const fetch = async () => new Response(JSON.stringify(pulls), { status: 200, headers: { 'content-type': 'application/json' } });
    const find = createPrFinder({ lines: [], repo, github: createGitHub({ token: 't', fetch }) });
    assert.equal(await find('b'.repeat(40)), 7);
  });
});

test('cloneRoot', async (t) => {
  await t.test('gives the top folder when a remote points at the repo on GitHub, in any URL form', async () => {
    for (const url of ['https://github.com/Fixture/Shop.git', 'git@github.com:fixture/shop.git', 'ssh://git@github.com/fixture/shop', 'https://github.com/fixture/shop/']) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exhibit-clone-')));
      git(dir, ['init', '--quiet']);
      git(dir, ['remote', 'add', 'origin', url]);
      assert.equal(await cloneRoot(dir, REPO), dir, url);
    }
  });

  await t.test('gives the top folder from a folder inside the clone', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exhibit-clone-')));
    git(dir, ['init', '--quiet']);
    git(dir, ['remote', 'add', 'origin', 'https://github.com/fixture/shop.git']);
    mkdirSync(join(dir, 'src'));
    assert.equal(await cloneRoot(join(dir, 'src'), REPO), dir);
  });

  await t.test('gives null for another repo, a repo with no remote, and a folder that is not a repo', async () => {
    const other = mkdtempSync(join(tmpdir(), 'exhibit-clone-'));
    git(other, ['init', '--quiet']);
    assert.equal(await cloneRoot(other, REPO), null);
    git(other, ['remote', 'add', 'origin', 'https://github.com/fixture/shopping.git']);
    assert.equal(await cloneRoot(other, REPO), null);
    assert.equal(await cloneRoot(mkdtempSync(join(tmpdir(), 'exhibit-plain-')), REPO), null);
  });
});

test('parseRemovedLines reads a deleted line that starts with "-- " as a line, not a file header', () => {
  const diff = [
    'diff --git a/q.sql b/q.sql',
    'index 1111111..2222222 100644',
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -2 +1,0 @@',
    '--- old comment',
    '@@ -7 +6 @@',
    '-select 1;',
    '+select 2;',
    'diff --git a/b.js b/b.js',
    'index 3333333..4444444 100644',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    ''
  ].join('\n');
  assert.deepEqual([...parseRemovedLines(diff)], [['q.sql', [2, 7]], ['b.js', [1]]]);
});

// A repo with one commit, then a fix commit that changes a file and moves a submodule pointer.
function repoWithSubmoduleBump() {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-sub-'));
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  const commit = (message) => git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', message]);
  writeFileSync(join(dir, 'a.js'), 'one;\ntwo;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`]);
  commit('Add a.js and sub');
  writeFileSync(join(dir, 'a.js'), 'one;\nTWO;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['update-index', '--cacheinfo', `160000,${'2'.repeat(40)},sub`]);
  commit('Fix a.js and bump sub');
  return dir;
}

const noPrs = () => createGitHub({ token: 't', fetch: async () => new Response('{"message":"No commit found"}', { status: 422 }) });

test('a fix that moves a submodule pointer blames only its file lines', async () => {
  const dir = repoWithSubmoduleBump();
  const fix = { number: 3, merge_sha: git(dir, ['rev-parse', 'HEAD']), classification: { fix: true } };
  const warnings = [];
  const [line] = await addSzz([fix], { dir, repo: REPO, github: noPrs(), warn: (text) => warnings.push(text) });
  assert.deepEqual(warnings, []);
  assert.deepEqual(line.szz.unlinked_lines.map((l) => [l.path, l.line, l.text]), [['a.js', 2, 'two;']]);
});

test('in a shallow clone, a fix whose parent is missing gets szz: null and a warning, and the run goes on', async (t) => {
  const repo = buildSzzRepo();
  t.after(() => repo.cleanup());
  const shallow = mkdtempSync(join(tmpdir(), 'exhibit-shallow-'));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  git(shallow, ['clone', '--quiet', '--depth', '1', `file://${repo.dir}`, '.']);
  // The newest fix is the clone's one commit, so its parent is missing.
  const newest = repo.history.at(-1);
  // Fetch an older fix with all of its history. The clone stays shallow at the newest fix.
  const older = repo.history.find((pr) => pr.number === 9);
  git(shallow, ['fetch', '--quiet', 'origin', older.merge_sha]);
  assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']), 'true');

  const warnings = [];
  const github = createGitHub({ token: 't', fetch: commitPullsFetch(repo, REPO) });
  const lines = await addSzz([newest, older], { dir: shallow, repo: REPO, github, warn: (text) => warnings.push(text) });
  assert.equal(lines[0].szz, null);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^This clone is shallow, so blame can give old lines to the wrong commit and SZZ links can be wrong\. Run git fetch --unshallow, then run history again\.$/);
  assert.match(warnings[1], /^PR 12: SZZ skipped, because git failed: .+/);

  // The fix after the skipped one still gets the same links as in the full clone.
  const [full] = await addSzz([older], { dir: repo.dir, repo: REPO, github });
  assert.ok(full.szz.links.length > 0);
  assert.deepEqual(lines[1].szz, full.szz);
});
