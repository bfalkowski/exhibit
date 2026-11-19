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
// the forge's repo, or null. The forge decides which remote URLs point at its repo. Git runs
// from the top folder, because blame reads paths from where it runs.
export async function cloneRoot(dir, forge) {
  let root;
  let remotes;
  try {
    root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    remotes = await git(root, ['remote', '-v']);
  } catch {
    return null;
  }
  const matches = remotes.split('\n').some((row) => {
    const url = row.split(/\s+/)[1];
    return url ? forge.isRemote(url) : false;
  });
  return matches ? root : null;
}

// Returns a function that maps a commit SHA to the number of the PR that brought it to the main
// branch, or null when no merged PR holds it. It looks first at the merge SHAs in `lines` (a
// squash merge's one commit), then asks the forge which PRs hold the commit, and keeps each answer.
// A merge SHA decides only for a PR into the default branch. A PR squash merged into a release
// branch did not bring its commit to main, so the forge is asked about that commit.
export function createPrFinder({ lines, forge }) {
  const byMergeSha = new Map(lines.map((line) => [line.merge_sha, line]));
  const asked = new Map();
  let mainBranch = null;
  // The repo's default branch, asked for once, and only when a merge SHA or two merged PRs need it.
  const defaultBranch = () => (mainBranch ??= forge.defaultBranch());
  const find = async (sha) => {
    const line = byMergeSha.get(sha);
    if (line && line.base_ref === (await defaultBranch())) return line.number;
    return askForge(forge, sha, defaultBranch);
  };
  return (sha) => {
    if (!asked.has(sha)) asked.set(sha, find(sha));
    return asked.get(sha);
  };
}

async function askForge(forge, sha, defaultBranch) {
  // A commit the forge does not know, such as one that was never pushed, gives an empty list.
  const pulls = await forge.pullsForCommit(sha);
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
// `dir` must be the top folder of a clone of the forge's repo, as cloneRoot returns it.
// `known` holds every history line that maps a commit to its PR, `lines` when left out. An
// incremental run passes the whole file there, and only the lines SZZ must run on as `lines`.
export async function addSzz(lines, { dir, forge, warn = () => {}, known = lines }) {
  const findPr = createPrFinder({ lines: known, forge });
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
      const reportedAt = await bugReportDate(line, forge);
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

// SZZ blames the main branch just before the fix (mainBeforeFix), takes the lines the fix
// deleted or changed there, drops the ones that carry no bug, blames the rest, drops the lines
// whose commit came after the bug report, and groups what is left by the PR that last changed
// each line.
async function szzForFix(dir, fix, findPr, reportedAt) {
  const blamed = await mainBeforeFix(dir, fix, findPr);
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
async function bugReportDate(fix, forge) {
  let newest = null;
  for (const number of bugReportNumbers(fix.body)) {
    const issue = await forge.issue(number);
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
// - "moved": the same hunk adds it back with the very same text, or it is in a moved block. A
//   moved block is lines next to each other that another hunk, in any file, adds back next to
//   each other in the same order, with at most whitespace changed. The block needs two or more
//   lines with a letter or a digit. A blank line that no other hunk adds back is "whitespace".
//   In a Python file the indent at the start of a line is code for both rules.
// - "comment": it is only a comment, and the fix does not turn it back into code. Or only the
//   comment at its end changed: the same hunk adds a line with the same code.
// Each added line pairs with one deleted line at most. A renamed file keeps its old path.
export function countedLines(diff) {
  const hunks = parseHunks(diff);
  const added = hunks.flatMap((hunk, at) => {
    const comments = markComments(hunk.added, hunk.newPath);
    return hunk.added.map((text, i) => ({ at, text, key: squash(text, hunk.newPath), comment: comments[i], used: false }));
  });
  const deleted = hunks.flatMap((hunk, at) => {
    const comments = markComments(hunk.deleted.map((row) => row.text), hunk.oldPath);
    return hunk.deleted.map((row, i) => ({ at, path: hunk.oldPath, ...row, key: squash(row.text, hunk.oldPath), comment: comments[i], reason: null }));
  });

  // Finds an added line with the same text, give or take whitespace, in the same hunk or in
  // another one, and uses it up.
  // Returns the matched line, or undefined.
  const pair = (line, sameHunk) => {
    const match = added.find((row) => !row.used && row.key === line.key && (row.at === line.at) === sameHunk);
    if (match) match.used = true;
    return match;
  };
  // A line that the same hunk adds back with the very same text only changed its place.
  for (const line of deleted) {
    const match = line.key === '' ? undefined : pair(line, true);
    if (match) line.reason = match.text === line.text ? 'moved' : 'whitespace';
  }
  // Lines that another hunk adds back moved only as a block: lines next to each other that
  // another hunk adds back next to each other, in the same order. A short line such as "}" is
  // in many places, so one moved line, or a block with only one line of words, still counts.
  for (let i = 0; i < deleted.length;) {
    const block = movedBlock(deleted, added, i);
    if (block.filter((row) => hasWords(row.text)).length < 2) {
      i++;
      continue;
    }
    for (const [k, row] of block.entries()) {
      deleted[i + k].reason = 'moved';
      row.used = true;
    }
    i += block.length;
  }
  // A blank line outside a moved block that another hunk adds back moved too. Any other blank
  // line is whitespace.
  for (const line of deleted) {
    if (line.reason !== null || line.key !== '') continue;
    line.reason = pair(line, false) === undefined ? 'whitespace' : 'moved';
  }
  // The words of each added code line, with no whitespace at all. A comment's words have no
  // indent, so the indent of a Python line must not count here.
  const code = new Set(added.filter((row) => !row.comment && row.key !== '').map((row) => row.text.replace(/\s+/g, '')));
  for (const line of deleted) {
    if (line.reason === null && line.comment && !code.has(uncomment(line.text).replace(/\s+/g, ''))) line.reason = 'comment';
  }
  // A code line where only the comment at its end changed, such as "x = 1; // old note" to
  // "x = 1;": the same hunk adds a code line with the same code once the comments come off both
  // lines, give or take whitespace.
  const codeOf = (text, path) => squash(stripComments(text, path), path);
  for (const line of deleted) {
    if (line.reason !== null || line.comment) continue;
    const key = codeOf(line.text, line.path);
    if (key === '') continue;
    const match = added.find((row) => !row.used && !row.comment && row.at === line.at && codeOf(row.text, line.path) === key);
    if (match) {
      match.used = true;
      line.reason = 'comment';
    }
  }

  const counted = new Map();
  const dropped = [];
  for (const { path, line, text, reason } of deleted) {
    if (reason !== null) dropped.push({ path, line, text, reason });
    else counted.set(path, [...(counted.get(path) ?? []), line]);
  }
  return { counted, dropped };
}

// Finds the longest run of added lines, in one hunk other than the deleted line's, that matches
// the deleted lines from `start` on, line by line. Each matched line is unused, and each deleted
// line in the run is in the same hunk and is not dropped yet.
// Returns the matched added lines, or [] when no other hunk adds back the line at `start`.
function movedBlock(deleted, added, start) {
  const first = deleted[start];
  let best = [];
  if (first.reason !== null) return best;
  for (let j = 0; j < added.length; j++) {
    if (added[j].at === first.at) continue;
    let size = 0;
    while (true) {
      const from = deleted[start + size];
      const to = added[j + size];
      if (from === undefined || to === undefined || from.at !== first.at || from.reason !== null) break;
      if (to.at !== added[j].at || to.used || to.key !== from.key) break;
      size++;
    }
    if (size > best.length) best = added.slice(j, j + size);
  }
  return best;
}

// A line holds words when it has a letter or a digit, unlike "}" or "];".
const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);

// The text with whitespace taken out, so two lines that differ only in whitespace match. In
// Python the indent says which block a line is in, so it is code and stays.
const squash = (text, path) => {
  const words = text.replace(/\s+/g, '');
  const indent = words !== '' && commentStyle(path) === 'hash' ? /^\s*/.exec(text)[0] : '';
  return indent + words;
};

// The words inside a comment line, without its comment marks.
const uncomment = (text) => text.trim().replace(/^(\/\/+|\/\*+|\*+|#+)/, '').replace(/\*+\/$/, '');

// The line without its comments: a "//" or "#" comment to the end of the line, and in
// JavaScript a "/* */" comment. Text in quotes is code, so a "//" or "#" in a string stays. A
// comment mark counts only at the start of the line or after a space, so "http://a" stays too:
// a line can be part of a string that opened on an earlier line, which this cannot see.
function stripComments(text, path) {
  const style = commentStyle(path);
  if (style === null) return text;
  const quotes = style === 'slash' ? '\'"`' : '\'"';
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (quotes.includes(ch)) quote = ch;
    const spaced = i === 0 || /\s/.test(text[i - 1]);
    if (spaced && (style === 'hash' ? ch === '#' : text.startsWith('//', i))) break;
    if (spaced && style === 'slash' && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// Version 1 knows the comments of JavaScript and TypeScript, and of Python.
function commentStyle(path) {
  const ext = /\.([^./]+)$/.exec(path ?? '')?.[1]?.toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'slash';
  if (ext === 'py') return 'hash';
  return null;
}

// A row that ends a block comment that opened before it: it starts with "*/", or it starts
// with "*", ends with "*/" and has no "/*" before that "*/". So these rows do not count:
// "foo(); /* note */", which opens its own comment, and "const re = /a*/", a regex.
const closesBlock = (text) => {
  const rest = text.trim();
  if (rest.startsWith('*/')) return true;
  return rest.startsWith('*') && rest.endsWith('*/') && !rest.slice(0, -2).includes('/*');
};

// Says for each row of one side of a hunk whether it is only a comment. A hunk shows only the
// changed rows, so a block comment can open before the hunk. A row that starts with "*" counts
// as a row of such a block only when the row or a later row of the hunk closes the block, or
// when the row is a JSDoc tag such as "* @param". Code can start with "*" too, such as "* qty;"
// after a line that ends in "price".
function markComments(texts, path) {
  const style = commentStyle(path);
  if (style === 'hash') return texts.map((text) => text.trim().startsWith('#'));
  if (style !== 'slash') return texts.map(() => false);
  let inBlock = false;
  return texts.map((text, i) => {
    let rest = text.trim();
    if (!inBlock) {
      if (rest.startsWith('//')) return true;
      if (/^\*(\s|\/|$)/.test(rest)) {
        const end = rest.indexOf('*/');
        if (end !== -1) return rest.slice(end + 2).trim() === '';
        return /^\*\s*@\w/.test(rest) || texts.slice(i + 1).some(closesBlock);
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
