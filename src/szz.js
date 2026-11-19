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
  return (sha) => {
    if (byMergeSha.has(sha)) return Promise.resolve(byMergeSha.get(sha));
    if (!asked.has(sha)) asked.set(sha, askGitHub(github, repo, sha));
    return asked.get(sha);
  };
}

async function askGitHub(github, repo, sha) {
  // GitHub answers 422 for a commit it does not know, such as one that was never pushed. A 404
  // means the same here: the repo itself was read a moment before.
  const pulls = await github.getAll(`/repos/${repo}/commits/${sha}/pulls?per_page=100`, { emptyOn: [404, 422] });
  // A commit can sit in more than one PR, such as a release PR that copies main to another
  // branch. The first PR merged brought it in.
  const merged = pulls.filter((pr) => pr.merged_at).sort((a, b) => a.merged_at.localeCompare(b.merged_at));
  return merged.length > 0 ? merged[0].number : null;
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
      const reportedAt = await bugReportDate(line, { repo, github });
      out.push({ ...line, szz: await szzForFix(dir, line, findPr, reportedAt) });
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

// The fix landed on the main branch as one commit: a merge commit or a squash commit. Its first
// parent is the main branch just before the fix. SZZ takes the lines the fix deleted or changed
// on that side, drops the ones that carry no bug, blames the rest there, drops the lines whose
// commit came after the bug report, and groups what is left by the PR that last changed each line.
async function szzForFix(dir, fix, findPr, reportedAt) {
  const blamed = (await git(dir, ['rev-parse', `${fix.merge_sha}^1`])).trim();
  const { counted, dropped } = countedLines(await git(dir, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/', blamed, fix.merge_sha]));

  const blamedLines = [];
  for (const [path, numbers] of counted) {
    blamedLines.push(...(await blameLines(dir, blamed, path, numbers)));
  }
  const { kept, dropped: newer } = dropNewerLines(blamedLines, reportedAt);
  const droppedLines = [...dropped, ...newer];

  const byPr = new Map();
  const unlinked = [];
  for (const line of kept) {
    const pr = await findPr(line.blame.commit);
    if (pr === null) unlinked.push(line);
    else byPr.set(pr, [...(byPr.get(pr) ?? []), line]);
  }
  const links = [...byPr]
    .map(([pr, prLines]) => ({ pr, confidence: prLines.length / kept.length, lines: prLines }))
    .sort((a, b) => b.confidence - a.confidence || a.pr - b.pr);
  return {
    blamed_commit: blamed,
    links,
    unlinked_lines: unlinked,
    dropped_lines: droppedLines,
    no_link_reason: kept.length === 0 ? noLinkReason(droppedLines) : null
  };
}

// The reasons a line is dropped, in the order no_link_reason names them, with the words for each.
const REASONS = [
  ['whitespace', 'whitespace'],
  ['comment', 'comments'],
  ['moved', 'moved lines'],
  ['newer than the bug report', 'lines newer than the bug report']
];

// Says why a fix with no lines left has no links, such as "whitespace only" or
// "whitespace and moved lines only". null when the fix deleted or changed no lines at all.
function noLinkReason(dropped) {
  const words = REASONS.filter(([reason]) => dropped.some((line) => line.reason === reason)).map(([, word]) => word);
  if (words.length === 0) return null;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return `${list} only`;
}

// Returns the numbers of the issues that a PR body links with GitHub's closing words, such as
// "Fixes #12" or "closes: #7". Only issues in the same repo count.
export function bugReportNumbers(body) {
  const numbers = [];
  for (const match of (body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)) {
    const number = Number(match[1]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

// Returns when the fix's bug was reported: the newest creation time of the issues its body
// links, or null when it links none. A linked number that is a PR, or that GitHub does not
// know, gives no date. With more than one report, a commit can have brought the bug only when
// it came before the newest one.
async function bugReportDate(fix, { repo, github }) {
  let newest = null;
  for (const number of bugReportNumbers(fix.body)) {
    const issue = await github.getOne(`/repos/${repo}/issues/${number}`, { emptyOn: [404, 410] });
    if (issue === null || issue.pull_request || typeof issue.created_at !== 'string') continue;
    if (newest === null || Date.parse(issue.created_at) > Date.parse(newest)) newest = issue.created_at;
  }
  return newest;
}

// Splits blamed lines by the bug report date (spec 9.2, step 5). A line whose commit was
// written after the bug was reported cannot have brought the bug, so it is dropped.
// With no date, every line is kept.
export function dropNewerLines(blamedLines, reportedAt) {
  if (reportedAt === null) return { kept: blamedLines, dropped: [] };
  const limit = Date.parse(reportedAt);
  const kept = [];
  const dropped = [];
  for (const line of blamedLines) {
    if (Date.parse(line.blame.author_time) > limit) {
      dropped.push({ path: line.path, line: line.line, text: line.text, reason: 'newer than the bug report' });
    } else {
      kept.push(line);
    }
  }
  return { kept, dropped };
}

// Reads a fix's `git diff -U0` and returns the lines it deleted or changed, split in two
// (spec 9.2, steps 1 and 2):
// - `counted`: for each old file path, the old line numbers that SZZ blames.
// - `dropped`: the lines that carry no bug, each with { path, line, text, reason }.
// A line is dropped for one of three reasons, checked in this order:
// - "whitespace": the same hunk adds it back with only whitespace changed.
// - "moved": another hunk, in any file, adds it back with at most whitespace changed.
//   A blank line that no other hunk adds back is "whitespace".
// - "comment": it is only a comment, and the fix does not turn it back into code.
// Each added line pairs with one deleted line at most. A renamed file keeps its old path.
export function countedLines(diff) {
  const hunks = parseHunks(diff);
  const added = hunks.flatMap((hunk, at) => {
    const comments = markComments(hunk.added, hunk.newPath);
    return hunk.added.map((text, i) => ({ at, key: squash(text), comment: comments[i], used: false }));
  });
  const deleted = hunks.flatMap((hunk, at) => {
    const comments = markComments(hunk.deleted.map((row) => row.text), hunk.oldPath);
    return hunk.deleted.map((row, i) => ({ at, path: hunk.oldPath, ...row, key: squash(row.text), comment: comments[i], reason: null }));
  });

  // Finds an added line with the same text, give or take whitespace, in the same hunk or in
  // another one, and uses it up.
  const pair = (line, sameHunk) => {
    const match = added.find((row) => !row.used && row.key === line.key && (row.at === line.at) === sameHunk);
    if (match) match.used = true;
    return match !== undefined;
  };
  for (const line of deleted) {
    if (line.key !== '' && pair(line, true)) line.reason = 'whitespace';
  }
  // A blank line that another hunk adds back moved with the block around it.
  for (const line of deleted) {
    if (line.reason === null && pair(line, false)) line.reason = 'moved';
    else if (line.reason === null && line.key === '') line.reason = 'whitespace';
  }
  const code = new Set(added.filter((row) => !row.comment && row.key !== '').map((row) => row.key));
  for (const line of deleted) {
    if (line.reason === null && line.comment && !code.has(squash(uncomment(line.text)))) line.reason = 'comment';
  }

  const counted = new Map();
  const dropped = [];
  for (const { path, line, text, reason } of deleted) {
    if (reason !== null) dropped.push({ path, line, text, reason });
    else counted.set(path, [...(counted.get(path) ?? []), line]);
  }
  return { counted, dropped };
}

// The text with all whitespace taken out, so two lines that differ only in whitespace match.
const squash = (text) => text.replace(/\s+/g, '');

// The words inside a comment line, without its comment marks.
const uncomment = (text) => text.trim().replace(/^(\/\/+|\/\*+|\*+|#+)/, '').replace(/\*+\/$/, '');

// Version 1 knows the comments of JavaScript and TypeScript, and of Python.
function commentStyle(path) {
  const ext = /\.([^./]+)$/.exec(path ?? '')?.[1]?.toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'slash';
  if (ext === 'py') return 'hash';
  return null;
}

// Says for each row of one side of a hunk whether it is only a comment. A hunk shows only the
// changed rows, so a row inside a block comment that opens before the hunk counts only when it
// starts with "*", as JSDoc rows do.
function markComments(texts, path) {
  const style = commentStyle(path);
  if (style === 'hash') return texts.map((text) => text.trim().startsWith('#'));
  if (style !== 'slash') return texts.map(() => false);
  let inBlock = false;
  return texts.map((text) => {
    let rest = text.trim();
    if (!inBlock) {
      if (rest.startsWith('//')) return true;
      if (/^\*(\s|\/|$)/.test(rest)) {
        const end = rest.indexOf('*/');
        return end === -1 || rest.slice(end + 2).trim() === '';
      }
      if (!rest.startsWith('/*')) return false;
      rest = rest.slice(2);
    }
    const end = rest.indexOf('*/');
    inBlock = end === -1;
    if (inBlock) return true;
    const after = rest.slice(end + 2).trim();
    return after === '' || after.startsWith('//');
  });
}

// Reads a `git diff -U0` into hunks: { oldPath, newPath, deleted, added }. `deleted` holds
// { line, text } with the old line numbers, and `added` holds the added texts. A hunk header
// "@@ -12,3 +12,1 @@" means old lines 12 to 14. A new file has a null oldPath, and a deleted
// file a null newPath.
// A "--- " row is a file header only before the file's first hunk. Inside a hunk it is a deleted
// line that starts with "-- ", such as a SQL comment.
function parseHunks(diff) {
  const hunks = [];
  let oldPath = null;
  let newPath = null;
  let hunk = null;
  let next = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      hunk = null;
      oldPath = null;
      newPath = null;
      continue;
    }
    if (hunk === null && row.startsWith('--- ')) {
      oldPath = headerPath(row, 'a/');
      continue;
    }
    if (hunk === null && row.startsWith('+++ ')) {
      newPath = headerPath(row, 'b/');
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? /.exec(row);
    if (header) {
      hunk = { oldPath, newPath, deleted: [], added: [] };
      hunks.push(hunk);
      next = Number(header[1]);
      continue;
    }
    if (hunk === null) continue;
    if (row.startsWith('-') && oldPath !== null) hunk.deleted.push({ line: next++, text: row.slice(1) });
    else if (row.startsWith('+')) hunk.added.push(row.slice(1));
  }
  return hunks;
}

function headerPath(row, prefix) {
  // Git ends the path with a tab when it holds a space.
  const name = unquote(row.slice(4).replace(/\t$/, ''));
  return name === '/dev/null' ? null : name.replace(new RegExp(`^${prefix}`), '');
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
