import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Settings that make diff and blame print the same way in every clone, whatever its config says.
const PLAIN = [
  '-c', 'core.quotePath=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'blame.ignoreRevsFile=',
  '-c', 'blame.markUnblamableLines=false',
  '-c', 'blame.markIgnoredLines=false'
];

// A git command that failed. SZZ catches it for one fix PR, warns, and goes on with the others.
class GitError extends Error {}

async function git(dir, args) {
  try {
    const { stdout } = await run('git', [...PLAIN, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const reason = (error.stderr ?? '').trim().split('\n')[0] || error.message;
    throw new GitError(`git failed: git ${args[0]}: ${reason}`);
  }
}

// Returns the top folder of the git clone that holds `dir`, when one of its remotes points at
// `repo` ("owner/name") on GitHub, or null. Any URL form counts: https, ssh, or scp-like
// (git@github.com:owner/name.git). Git runs from the top folder, because blame reads paths
// from where it runs.
export async function cloneRoot(dir, repo) {
  let root;
  let remotes;
  try {
    root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    remotes = await git(root, ['remote', '-v']);
  } catch {
    return null;
  }
  const want = repo.toLowerCase();
  const matches = remotes.split('\n').some((row) => {
    const url = row.split(/\s+/)[1];
    const match = url ? /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url) : null;
    return match !== null && match[1].toLowerCase() === want;
  });
  return matches ? root : null;
}

// Returns a function that maps a commit SHA to the number of the PR that brought it to the main
// branch, or null when no merged PR holds it. It looks first at the merge SHAs in `lines` (a
// squash merge's one commit), then asks GitHub which PRs hold the commit, and keeps each answer.
export function createPrFinder({ lines, repo, github }) {
  const byMergeSha = new Map(lines.map((line) => [line.merge_sha, line.number]));
  const asked = new Map();
  let mainBranch = null;
  // The repo's default branch, asked for once and only when a commit sits in two merged PRs.
  const defaultBranch = () => (mainBranch ??= github.getOne(`/repos/${repo}`).then((reply) => reply.default_branch));
  return (sha) => {
    if (byMergeSha.has(sha)) return Promise.resolve(byMergeSha.get(sha));
    if (!asked.has(sha)) asked.set(sha, askGitHub(github, repo, sha, defaultBranch));
    return asked.get(sha);
  };
}

async function askGitHub(github, repo, sha, defaultBranch) {
  // GitHub answers 422 for a commit it does not know, such as one that was never pushed. A 404
  // means the same here: the repo itself was read a moment before.
  const pulls = await github.getAll(`/repos/${repo}/commits/${sha}/pulls?per_page=100`, { emptyOn: [404, 422] });
  const merged = pulls.filter((pr) => pr.merged_at).sort((a, b) => a.merged_at.localeCompare(b.merged_at));
  if (merged.length < 2) return merged.length === 1 ? merged[0].number : null;
  // A commit can sit in more than one merged PR, such as a fix merged into a release branch and
  // then a PR that merges the release branch into main. Only a PR into the default branch brought
  // it to main, so the first of those wins. When none went there, the first PR merged wins.
  const main = await defaultBranch();
  return (merged.find((pr) => pr.base?.ref === main) ?? merged[0]).number;
}

// Returns `lines` with `szz` set on each one (spec 9.2). A fix PR gets its links. A PR that is
// not a fix gets null. A fix whose merge commit is not in the clone, or where git fails, gets
// null and a warning. A shallow clone gives one warning first, because blame there can give
// old lines to the shallow boundary commit.
// `dir` must be the top folder of a clone of `repo`, as cloneRoot returns it.
export async function addSzz(lines, { dir, repo, github, warn = () => {} }) {
  const findPr = createPrFinder({ lines, repo, github });
  if ((await git(dir, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    warn('This clone is shallow, so blame can give old lines to the wrong commit and SZZ links can be wrong. Run git fetch --unshallow, then run history again.');
  }
  const out = [];
  for (const line of lines) {
    if (!line.classification?.fix) {
      out.push({ ...line, szz: null });
      continue;
    }
    if (!(await hasCommit(dir, line.merge_sha))) {
      warn(`PR ${line.number}: SZZ skipped, because its merge commit ${line.merge_sha} is not in this clone. Run git fetch, then run history again.`);
      out.push({ ...line, szz: null });
      continue;
    }
    try {
      out.push({ ...line, szz: await szzForFix(dir, line, findPr) });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      warn(`PR ${line.number}: SZZ skipped, because ${error.message}`);
      out.push({ ...line, szz: null });
    }
  }
  return out;
}

async function hasCommit(dir, sha) {
  try {
    await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// SZZ blames the main branch just before the fix, takes the lines the fix deleted or changed
// there, and groups them by the PR that last changed each one.
async function szzForFix(dir, fix, findPr) {
  const blamed = await mainBeforeFix(dir, fix, findPr);
  const removed = parseRemovedLines(await git(dir, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/', blamed, fix.merge_sha]));

  const blamedLines = [];
  for (const [path, numbers] of removed) {
    blamedLines.push(...(await blameLines(dir, blamed, path, numbers)));
  }

  const byPr = new Map();
  const unlinked = [];
  for (const line of blamedLines) {
    const pr = await findPr(line.blame.commit);
    if (pr === null) unlinked.push(line);
    else byPr.set(pr, [...(byPr.get(pr) ?? []), line]);
  }
  const links = [...byPr]
    .map(([pr, prLines]) => ({ pr, confidence: prLines.length / blamedLines.length, lines: prLines }))
    .sort((a, b) => b.confidence - a.confidence || a.pr - b.pr);
  return { blamed_commit: blamed, links, unlinked_lines: unlinked };
}

// Returns the commit on the main branch just before the fix. A merge commit or a squash commit
// puts the fix on main as one commit, so that is the first parent of merge_sha. "Rebase and
// merge" copies each of the fix's commits onto main, and merge_sha is only the last copy. So
// walk back along main while the parent commit belongs to the fix PR too. For a merge commit or
// a squash commit, the parent is another PR's commit, so the walk stops at once.
async function mainBeforeFix(dir, fix, findPr) {
  let first = fix.merge_sha;
  for (;;) {
    const parents = (await git(dir, ['rev-list', '--parents', '-n', '1', first])).trim().split(' ').slice(1);
    if (parents.length !== 1) break;
    if ((await findPr(parents[0])) !== fix.number) break;
    first = parents[0];
  }
  return (await git(dir, ['rev-parse', `${first}^1`])).trim();
}

// Reads a `git diff -U0` and returns, for each old file path, the old line numbers the diff
// deleted or changed. A hunk header "@@ -12,3 +12,1 @@" means old lines 12 to 14.
// A new file (--- /dev/null) has no old lines. A rename keeps the old path.
// A "--- " row is a file header only before the file's first hunk. Inside a hunk it is a deleted
// line that starts with "-- ", such as a SQL comment.
export function parseRemovedLines(diff) {
  const removed = new Map();
  let path = null;
  let inHeader = false;
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      inHeader = true;
      path = null;
      continue;
    }
    if (inHeader && row.startsWith('--- ')) {
      // Git ends the path with a tab when it holds a space.
      const name = unquote(row.slice(4).replace(/\t$/, ''));
      path = name === '/dev/null' ? null : name.replace(/^a\//, '');
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(row);
    if (!hunk) continue;
    inHeader = false;
    if (path === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const numbers = removed.get(path) ?? [];
    for (let i = 0; i < count; i++) numbers.push(start + i);
    removed.set(path, numbers);
  }
  return removed;
}

// Git puts a path in double quotes, with C escapes, when it holds a tab, a newline, a quote or a
// backslash. core.quotePath=false keeps other characters as they are.
function unquote(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  const body = text.slice(1, -1);
  const escapes = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i]));
    } else if (/[0-7]/.test(body[i + 1])) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[body[i + 1]] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Blames the given line numbers of `path` at `commit`, in one git call, and returns each line
// with its text and the blame output for it.
async function blameLines(dir, commit, path, numbers) {
  const ranges = toRanges(numbers).flatMap(([from, to]) => ['-L', `${from},${to}`]);
  const out = await git(dir, ['blame', '--line-porcelain', ...ranges, commit, '--', path]);
  return parseLinePorcelain(out).map((entry) => ({
    path,
    line: entry.finalLine,
    text: entry.text,
    blame: {
      commit: entry.commit,
      original_path: entry.filename,
      original_line: entry.originalLine,
      author: entry.author,
      author_time: new Date(entry.authorTime * 1000).toISOString().replace('.000Z', 'Z'),
      summary: entry.summary
    }
  }));
}

function toRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

// `git blame --line-porcelain` prints, for every line, a header row "<sha> <orig> <final> [n]",
// then "key value" rows, then the line's text after a tab.
function parseLinePorcelain(out) {
  const entries = [];
  let entry = null;
  for (const row of out.split('\n')) {
    if (entry === null) {
      const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(row);
      if (header) entry = { commit: header[1], originalLine: Number(header[2]), finalLine: Number(header[3]) };
      continue;
    }
    if (row.startsWith('\t')) {
      entries.push({ ...entry, text: row.slice(1) });
      entry = null;
      continue;
    }
    const space = row.indexOf(' ');
    const key = space === -1 ? row : row.slice(0, space);
    const value = space === -1 ? '' : row.slice(space + 1);
    if (key === 'author') entry.author = value;
    else if (key === 'author-time') entry.authorTime = Number(value);
    else if (key === 'summary') entry.summary = value;
    else if (key === 'filename') entry.filename = unquote(value);
  }
  return entries;
}
