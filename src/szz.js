import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRevert, REVERT_SIGNAL, revertedWork } from './fix-signals.js';
import { GitHubReplyError } from './github.js';
import { JiraReplyError } from './jira.js';

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

// Runs git and returns what it printed, as text. With `input`, git reads it on stdin, and the
// output comes back as a Buffer, because some commands give sizes in bytes.
async function git(dir, args, input) {
  try {
    const running = run('git', [...PLAIN, ...args], { cwd: dir, encoding: input === undefined ? 'utf8' : 'buffer', maxBuffer: 512 * 1024 * 1024 });
    if (input !== undefined) {
      // When git exits before it reads all of the input, the write fails with EPIPE. With no
      // listener, that error ends the whole run. The exit of git gives the GitError below.
      running.child.stdin.on('error', () => {});
      running.child.stdin.end(input);
    }
    const { stdout } = await running;
    return stdout;
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0] || error.message;
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
// A merge SHA decides for a PR into the default branch. A PR squash merged into a release branch
// did not bring its commit to main, so the forge is asked about that commit. A PR merged before
// the default branch was renamed has the old name as its base_ref, so for any other base_ref the
// merge SHA still decides when `onMainLine` says the commit is on the default branch's first
// parent line in the clone.
export function createPrFinder({ lines, forge, onMainLine = async () => false }) {
  const byMergeSha = new Map(lines.map((line) => [line.merge_sha, line]));
  const asked = new Map();
  let mainBranch = null;
  // The repo's default branch, asked for once, and only when a merge SHA or two merged PRs need it.
  // A failed request is not kept, so the next fix asks again.
  const defaultBranch = () => {
    mainBranch ??= forge.defaultBranch();
    mainBranch.catch(() => { mainBranch = null; });
    return mainBranch;
  };
  const find = async (sha) => {
    const line = byMergeSha.get(sha);
    if (line) {
      const main = await defaultBranch();
      if (line.base_ref === main || (await onMainLine(sha, main))) return line.number;
    }
    return askForge(forge, sha, defaultBranch);
  };
  return (sha) => {
    if (!asked.has(sha)) {
      const answer = find(sha);
      answer.catch(() => asked.delete(sha));
      asked.set(sha, answer);
    }
    return asked.get(sha);
  };
}

async function askForge(forge, sha, defaultBranch) {
  // A commit the forge does not know, such as one that was never pushed, gives an empty list.
  const pulls = await forge.pullsForCommit(sha);
  const merged = pulls.filter((pr) => pr.mergedAt).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  if (merged.length < 2) return merged.length === 1 ? merged[0].number : null;
  // A commit can sit in more than one merged PR, such as a fix merged into a release branch and
  // then a PR that merges the release branch into main. Only a PR into the default branch brought
  // it to main, so the first of those wins. When none went there, the first PR merged wins.
  const main = await defaultBranch();
  return (merged.find((pr) => pr.baseRef === main) ?? merged[0]).number;
}

// Returns `lines` with `szz` set on each one (spec 9.2). A fix PR gets its links. A fix that the
// revert signal marked links the PRs it reverts, with no blame (revertLinks). A PR that is
// not a fix gets null. A revert that takes back only reverts that take a change out
// (takesOut) is a re-land, such as "Reland: add cache" after a click on Revert. It puts work
// back, so it comes back as no fix, with szz null, as a title 'Revert "Revert "' would (spec
// 9.1). A fix whose merge commit is not in the clone, where git fails, or where the forge fails
// for one of its requests, gets null and a warning. A shallow clone gives one warning first,
// because blame there can give old lines to the shallow boundary commit.
// `dir` must be the top folder of a clone of the forge's repo, as cloneRoot returns it.
// `known` holds every history line that maps a commit to its PR, `lines` when left out. An
// incremental run passes the whole file there, and only the lines SZZ must run on as `lines`.
// `tracker` is the connected tracker that the fix signals asked, such as Jira, or null. A fix
// found by its signal, such as jira:PAY-482, takes the issue's created date as its bug report
// date when the GitHub issues give none (step 5).
export async function addSzz(lines, { dir, forge, tracker = null, warn = () => {}, known = lines }) {
  const findPr = createPrFinder({ lines: known, forge, onMainLine: mainLineCheck(dir, forge) });
  const knownPrs = new Map(known.map((line) => [line.number, line]));
  const revertContext = { findPr, forge, knownPrs };
  revertContext.takesOut = createTakesOut(dir, revertContext);
  if ((await git(dir, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    warn('This clone is shallow, so blame can give old lines to the wrong commit and SZZ links can be wrong. Run git fetch --unshallow, then run history again.');
  }
  const out = [];
  for (const line of lines) {
    if (!line.classification?.fix) {
      out.push({ ...line, szz: null });
      continue;
    }
    const revert = line.classification.fix_signal === REVERT_SIGNAL;
    if (!revert && !(await hasCommit(dir, line.merge_sha))) {
      warn(`PR ${line.number}: SZZ skipped, because its merge commit ${line.merge_sha} is not in this clone. Run git fetch, then run history again.`);
      out.push({ ...line, szz: null });
      continue;
    }
    try {
      const szz = revert
        ? await revertLinks(dir, line, revertContext)
        : await szzForFix(dir, line, findPr, (await bugReportDate(line, forge)) ?? (await trackerReportDate(line, tracker)));
      if (szz.no_link_reason === REVERTS_A_REVERT) out.push({ ...line, classification: { ...line.classification, fix: false, fix_signal: null }, szz: null });
      else out.push({ ...line, szz });
    } catch (error) {
      if (!(error instanceof GitError) && !failsOneRequest(error)) throw error;
      warn(`PR ${line.number}: SZZ skipped, because ${error.message}`);
      out.push({ ...line, szz: null });
    }
  }
  return out;
}

// Returns a function that says whether a commit is on the first-parent line of the default
// branch in the clone: a commit that the default branch got on its own, such as a squash merge,
// and not one that came in through a merge commit. The tip is the default branch of a remote
// that points at the forge's repo, else the local branch with that name. Git lists the line
// once per run, when a merge SHA first needs it. With no such branch in the clone, or when git
// fails to list the line, no commit is on the line, so the forge is asked.
function mainLineCheck(dir, forge) {
  let line = null;
  return async (sha, branch) => {
    line ??= firstParentLine(dir, forge, branch);
    return (await line).has(sha);
  };
}

async function firstParentLine(dir, forge, branch) {
  try {
    const tip = await branchTip(dir, forge, branch);
    if (!tip) return new Set();
    return new Set((await git(dir, ['rev-list', '--first-parent', tip])).split('\n').filter(Boolean));
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return new Set();
  }
}

async function branchTip(dir, forge, branch) {
  const rows = (await git(dir, ['remote', '-v'])).split('\n').map((row) => row.split(/\s+/));
  const remotes = [...new Set(rows.filter(([name, url]) => name && url && forge.isRemote(url)).map(([name]) => name))];
  for (const ref of [...remotes.map((name) => `refs/remotes/${name}/${branch}`), `refs/heads/${branch}`]) {
    try {
      return (await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
  }
  return null;
}

// A GitHub reply that is a problem with one request, such as a 502. GitHubReplyError says
// which replies would fail every later request too: those stop the run.
const failsOneRequest = (error) => (error instanceof GitHubReplyError || error instanceof JiraReplyError) && !error.stopsRun;

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
  const diff = await git(dir, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/', blamed, fix.merge_sha]);
  const { counted, dropped } = countedLines(diff, await readFiles(dir, diff, blamed, fix.merge_sha));

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
    else if (byPr.has(pr)) byPr.get(pr).push(line);
    else byPr.set(pr, [line]);
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

// The no_link_reason of a revert for which SZZ found no PR in this repo: the body named none,
// named only PRs in other repos, or named work that neither the history nor the forge knows.
export const REVERT_NOT_FOUND = 'reverted change not found';
// What revertLinks says of a revert whose every found PR is itself a revert. It puts work back (a
// re-land), so the PR it takes back did not bring a bug. addSzz then makes the line no fix. A
// history file from before that rule can still hold it on a fix line.
export const REVERTS_A_REVERT = 'reverts a revert';

// A revert names the work it reverts, so SZZ blames no line: it links each reverted PR straight
// away, marked as found by revert. The PRs share the confidence evenly. The reverted PRs come
// from revertedPrs. A revert of a PR in another repo links nothing here.
// A found PR that takes a change out (takesOut) is not linked: a re-land with an edited title,
// such as "Reland: add cache", takes back a revert, not a bug. A found re-land is linked: a
// revert of it takes the change out again, so the re-land brought the bug back.
async function revertLinks(dir, fix, context) {
  const found = await revertedPrs(dir, fix, context);
  const reverts = [];
  for (const number of found) if (await context.takesOut(number)) reverts.push(number);
  for (const number of reverts) found.delete(number);
  const linked = [...found].sort((a, b) => a - b);
  return {
    blamed_commit: null,
    links: linked.map((pr) => ({ pr, confidence: 1 / linked.length, found_by: 'revert', lines: [] })),
    unlinked_lines: [],
    dropped_lines: [],
    no_link_reason: linked.length > 0 ? null : reverts.length > 0 ? REVERTS_A_REVERT : REVERT_NOT_FOUND
  };
}

// Returns the set of PRs that the body of the revert `line` names. A PR named by number counts
// when the history holds it, or when the forge says it is a PR. A commit maps to its PR as a
// blamed commit does (createPrFinder), after a short SHA is made full in the clone. The revert
// PR itself is never in the set.
async function revertedPrs(dir, line, { findPr, forge, knownPrs }) {
  const { prs, commits } = revertedWork(line.body, forge.repo);
  const found = new Set();
  for (const number of prs) {
    if (knownPrs.has(number) || (await forge.issue(number))?.isPull) found.add(number);
  }
  for (const sha of commits) {
    const full = await fullSha(dir, sha);
    const pr = full === null ? null : await findPr(full);
    if (pr !== null) found.add(pr);
  }
  found.delete(line.number);
  return found;
}

// Returns takesOut(number): whether the history line of PR `number` is a revert that takes a
// change out. A revert whose every reverted PR takes a change out puts the change back (a
// re-land), so it is not one. So in a chain of reverts, every second one takes out, and the
// others put back. The reverted PRs come from revertedPrs, as for the links, so a PR is a
// re-land here exactly when SZZ writes it as no fix. Each PR is decided once per run. A PR that
// the history does not hold is no revert. A revert that names no PR takes out. `path` holds the
// PRs above this one in the chain, and stops a loop.
function createTakesOut(dir, context) {
  const decided = new Map();
  const takesOut = async (number, path = new Set()) => {
    if (decided.has(number)) return decided.get(number);
    const line = context.knownPrs.get(number);
    if (line === undefined || !isRevert({ ...line, repo: context.forge.repo })) return false;
    if (path.has(number)) return true;
    const above = new Set([...path, number]);
    const named = await revertedPrs(dir, line, context);
    let out = named.size === 0;
    for (const pr of named) {
      if (!(await takesOut(pr, above))) {
        out = true;
        break;
      }
    }
    decided.set(number, out);
    return out;
  };
  return takesOut;
}

// git revert writes the whole SHA, but a person can shorten it. A short SHA is looked up in the
// clone. null when the clone does not hold it.
async function fullSha(dir, sha) {
  if (sha.length === 40) return sha;
  try {
    return (await git(dir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).trim();
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

// Reads the whole text of each JavaScript, TypeScript and Python file that the diff changes, at
// the commit before the fix and at the fix, in one git call. A hunk shows only the changed
// lines, and the file says whether a line is inside a block comment, or which Python block it
// is in. Returns { before, after }: each maps a path to its text. A path that git cannot read
// is left out, and the rules then guess from the hunk alone.
async function readFiles(dir, diff, before, after) {
  const wanted = new Map();
  for (const hunk of parseHunks(diff)) {
    for (const [side, path, commit] of [['before', hunk.oldPath, before], ['after', hunk.newPath, after]]) {
      // A path with a newline cannot go on one row of git's input.
      if (commentStyle(path) !== null && !path.includes('\n')) wanted.set(`${side}\n${path}`, { side, path, spec: `${commit}:${path}` });
    }
  }
  const files = { before: new Map(), after: new Map() };
  if (wanted.size === 0) return files;
  const list = [...wanted.values()];
  // For each object, `git cat-file --batch` prints "<sha> <type> <size>", a newline, the bytes
  // and a newline, or "<spec> missing" and a newline.
  const out = await git(dir, ['cat-file', '--batch'], list.map((file) => `${file.spec}\n`).join(''));
  let at = 0;
  for (const { side, path } of list) {
    const end = out.indexOf(10, at);
    const header = out.subarray(at, end).toString('utf8').split(' ');
    at = end + 1;
    if (header.length !== 3 || !/^\d+$/.test(header[2])) continue;
    const size = Number(header[2]);
    if (header[1] === 'blob') files[side].set(path, out.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return files;
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
// "Fixes #12", "closes: #7", "Fixes owner/name#12" or "Fixes https://github.com/owner/name/issues/12".
// Only issues in the forge's repo count. Case does not matter in the repo name. A name that is
// not the repo's current name, such as its name before a rename or a transfer, counts when the
// forge says it leads to the same repo (forge.sameRepo). GitHub follows that redirect and closes
// the issue, so SZZ reads it too.
export async function bugReportNumbers(body, forge) {
  const numbers = [];
  const name = '[\\w.-]+\\/[\\w.-]+';
  const closing = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+(?:#(\\d+)|(${name})#(\\d+)|https?:\\/\\/github\\.com\\/(${name})\\/issues\\/(\\d+))\\b`,
    'gi'
  );
  for (const [, short, refRepo, refNumber, urlRepo, urlNumber] of (body ?? '').matchAll(closing)) {
    const named = refRepo ?? urlRepo;
    if (named !== undefined && named.toLowerCase() !== forge.repo.toLowerCase() && !(await forge.sameRepo(named))) continue;
    const number = Number(short ?? refNumber ?? urlNumber);
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
  for (const number of await bugReportNumbers(fix.body, forge)) {
    const issue = await forge.issue(number);
    if (issue === null || issue.isPull || issue.createdAt === null) continue;
    if (newest === null || Date.parse(issue.createdAt) > Date.parse(newest)) newest = issue.createdAt;
  }
  return newest;
}

// Returns the created time of the tracker issue that marked `fix` as a fix, such as jira:PAY-482
// in its fix_signal, or null. The line's saved `ticket` holds it (spec 8.3). Else the fix signals
// asked the tracker for the issue already, and the tracker keeps each answer, so this sends no
// new request. A tracker with no token gives null.
async function trackerReportDate(fix, tracker) {
  const signal = fix.classification?.fix_signal ?? '';
  if (!tracker || !signal.startsWith(`${tracker.name}:`)) return null;
  if (fix.ticket?.issue === signal && fix.ticket.created_at) return fix.ticket.created_at;
  if (!tracker.canAsk) return null;
  const issue = await tracker.ticket(signal.slice(tracker.name.length + 1));
  return issue?.createdAt ?? null;
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
// When no line is left, but some lines with a letter or a digit moved inside their own file,
// those lines count: the fix changed only their place, so their place was the bug. A moved
// line with no letter or digit, such as "}" or a blank line, stays dropped.
// Each added line pairs with one deleted line at most. A renamed file keeps its old path.
// `files` holds the whole files before and after the fix, as readFiles returns them. With a
// file, the rules know whether a row is inside a block comment, and which block a Python line
// is in. Without it, they guess from the hunk alone.
export function countedLines(diff, { before = new Map(), after = new Map() } = {}) {
  const hunks = parseHunks(diff);
  const facts = new Map();
  // What the whole file says about each of its lines, or undefined when the file is not known.
  const factsOf = (side, files, path) => {
    const id = `${side}\n${path}`;
    if (!facts.has(id)) facts.set(id, files.has(path) ? lineFacts(files.get(path), path) : []);
    return facts.get(id);
  };
  const side = (rows, path, lineFact) => {
    const comments = markComments(rows.map((row) => row.text), path, rows.map((row) => lineFact[row.line]?.inBlock));
    return rows.map((row, i) => {
      const level = lineFact[row.line]?.level;
      const codeKey = squash(stripComments(row.text, path), path, level);
      return { ...row, level, key: squash(row.text, path, level), codeKey, comment: comments[i] };
    });
  };
  const added = hunks.flatMap((hunk, at) => {
    const rows = hunk.added.map((text, i) => ({ at, path: hunk.newPath, line: hunk.newStart + i, text, used: false }));
    return side(rows, hunk.newPath, factsOf('after', after, hunk.newPath));
  }).map((row, place) => ({ ...row, place }));
  const deleted = hunks.flatMap((hunk, at) => {
    const rows = hunk.deleted.map((row) => ({ at, path: hunk.oldPath, ...row, reason: null, movedInFile: false }));
    return side(rows, hunk.oldPath, factsOf('before', before, hunk.oldPath));
  });
  const index = indexByKey(added);
  const sameFile = (deletedAt, addedAt) => hunks[deletedAt].newPath !== null && hunks[deletedAt].newPath === hunks[addedAt].newPath;

  // Finds the first unused added line with the same text, with at most whitespace changed, in
  // the same hunk or in another one, and uses it up.
  // Returns the matched line, or undefined.
  const pair = (line, sameHunk) => {
    const byHunk = index.get(line.key);
    let match;
    if (byHunk && sameHunk) {
      match = byHunk.get(line.at)?.firstUnused();
    } else if (byHunk) {
      for (const [at, rows] of byHunk) {
        match = at === line.at ? undefined : rows.firstUnused();
        if (match) break;
      }
    }
    if (match) match.used = true;
    return match;
  };
  // A line that the same hunk adds back with the very same text only changed its place.
  for (const line of deleted) {
    const match = line.key === '' ? undefined : pair(line, true);
    if (match) line.reason = match.text === line.text ? 'moved' : 'whitespace';
    if (line.reason === 'moved') line.movedInFile = hasWords(line.text);
  }
  // Lines that another hunk adds back moved only as a block: lines next to each other that
  // another hunk adds back next to each other, in the same order. A short line such as "}" is
  // in many places, so one moved line, or a block with only one line of words, still counts.
  // A block can pass over a line that its own hunk adds back, so that line does not split the
  // block. That line keeps its reason, and its own hunk keeps the added line it paired with. The
  // block leaves that line's match in the other hunk unused, so another block can still take it.
  // The block does not move that line, so the line does not count toward its two lines with
  // words. Otherwise a block that moves one line could take an added line from a real block.
  const secondWordAt = secondWordLines(deleted);
  const runs = knownRuns(added.length);
  for (let i = 0; i < deleted.length;) {
    // A block starts at a line that no rule drops yet. When the block can not reach two lines
    // with words, it can not pass, so do not look for it.
    if (deleted[i].reason !== null || secondWordAt[i] === -1) {
      runs.forget();
      i++;
      continue;
    }
    const block = movedBlock(deleted, added, index, i, secondWordAt[i], runs);
    if (block.length === 0) {
      runs.step();
      i++;
      continue;
    }
    const inFile = sameFile(deleted[i].at, block[0].at);
    for (const [k, row] of block.entries()) {
      const line = deleted[i + k];
      if (line.reason !== null) continue;
      row.used = true;
      line.reason = 'moved';
      line.movedInFile = inFile && hasWords(line.text);
    }
    runs.forget();
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
  // lines, with at most whitespace changed. That code is each row's codeKey. Each side reads
  // its comments with its own path, so a rename from .py to .js reads "#" only on the old side.
  // The added code lines are indexed by hunk and codeKey, as above.
  const byCode = new Map();
  for (const row of added) {
    if (row.comment) continue;
    const id = `${row.at}\n${row.codeKey}`;
    if (!byCode.has(id)) byCode.set(id, hunkRows());
    byCode.get(id).rows.push(row);
  }
  for (const line of deleted) {
    if (line.reason !== null || line.comment || line.codeKey === '') continue;
    const match = byCode.get(`${line.at}\n${line.codeKey}`)?.firstUnused();
    if (match) {
      match.used = true;
      line.reason = 'comment';
    }
  }
  // A fix that only moves lines inside a file, such as an export moved above the code that
  // needs it, would get no link at all. Its moved lines are the change, so they count. A line
  // that is only a comment carries no bug, so it stays dropped even when it moved.
  if (deleted.every((line) => line.reason !== null)) {
    for (const line of deleted) if (line.movedInFile && !line.comment) line.reason = null;
  }

  const counted = new Map();
  const dropped = [];
  for (const { path, line, text, reason } of deleted) {
    if (reason !== null) dropped.push({ path, line, text, reason });
    else if (counted.has(path)) counted.get(path).push(line);
    else counted.set(path, [line]);
  }
  return { counted, dropped };
}

// Groups the added lines by key, then by hunk, in the order of the diff, so a deleted line looks
// only at the added lines with its key. A big generated file, such as a lockfile, has thousands
// of lines, and reading all of them for each deleted line is slow. Each group keeps a cursor
// past its used lines: a line that is used stays used.
// Returns Map(key => Map(hunk => { rows, firstUnused() })).
function indexByKey(added) {
  const index = new Map();
  for (const row of added) {
    if (!index.has(row.key)) index.set(row.key, new Map());
    const byHunk = index.get(row.key);
    if (!byHunk.has(row.at)) byHunk.set(row.at, hunkRows());
    byHunk.get(row.at).rows.push(row);
  }
  return index;
}

function hunkRows() {
  const rows = [];
  let next = 0;
  return {
    rows,
    firstUnused() {
      while (next < rows.length && rows[next].used) next++;
      return rows[next];
    }
  };
}

// Finds the longest run of added lines, in one hunk other than the deleted line's, that matches
// the deleted lines from `start` on, line by line, and reaches the deleted line at `secondWord`:
// the second line with words that the block moves. Only added lines with the key of the line at `start` can begin a
// run, so the index gives them. A run from added line j can reach `secondWord` only when the
// added line as far from j fits it, so the search walks no other run. `runs` holds the runs that
// the line before `start` found, and gets the runs of this call for the line after it.
// Returns the matched added lines, or [] when no such run exists.
function movedBlock(deleted, added, index, start, secondWord, runs) {
  const first = deleted[start];
  const reach = secondWord - start;
  let bestAt = 0;
  let bestSize = reach;
  for (const [at, { rows }] of index.get(first.key) ?? []) {
    if (at === first.at) continue;
    for (const { place: j } of rows) {
      let size = runs.get(j);
      if (size === 0) {
        if (!fits(deleted, added, start, j, reach)) continue;
        while (fits(deleted, added, start, j, size)) size++;
      }
      runs.keep(j, size);
      if (size > bestSize) {
        bestAt = j;
        bestSize = size;
      }
    }
  }
  return bestSize > reach ? added.slice(bestAt, bestAt + bestSize) : [];
}

// Says whether the deleted line `k` lines after `start` and the added line `k` lines after `j`
// can be in one run. Each line stays in the hunk of the first line on its side, the added line
// is unused, and the two lines have the same key. The deleted line can be one that its own hunk
// adds back.
function fits(deleted, added, start, j, k) {
  const from = deleted[start + k];
  const to = added[j + k];
  if (from === undefined || to === undefined) return false;
  return from.at === deleted[start].at && to.at === added[j].at && !to.used && to.key === from.key;
}

// Keeps the runs that one start line found, one line shorter, for the next start line, so that
// line does not walk them again. Without this, a long run of the same short line, such as "],",
// costs the cube of its length. Two typed arrays take turns, so the search makes no new array
// for each line. A run is known only while no line changes, so the caller forgets them all when
// it marks a block, or skips a start line.
function knownRuns(size) {
  let now = new Int32Array(size + 1);
  let next = new Int32Array(size + 1);
  return {
    // The length of the run from added line j for this start line, or 0 when it is not known.
    get: (j) => now[j],
    // Keeps the run of `length` lines from added line j for the next start line.
    keep(j, length) {
      if (length > 1) next[j + 1] = length - 1;
    },
    // Moves on to the next start line.
    step() {
      [now, next] = [next, now];
      next.fill(0);
    },
    forget() {
      now.fill(0);
      next.fill(0);
    }
  };
}

// For each deleted line, the place of the second line with words from it on in its hunk that no
// rule drops yet, or -1 when the rest of the hunk has fewer than two. A block needs two such
// lines: a line that its own hunk adds back does not count, because the block does not move it.
function secondWordLines(deleted) {
  const first = new Array(deleted.length);
  const second = new Array(deleted.length);
  for (let i = deleted.length - 1; i >= 0; i--) {
    const sameHunk = i + 1 < deleted.length && deleted[i + 1].at === deleted[i].at;
    const nextFirst = sameHunk ? first[i + 1] : -1;
    if (deleted[i].reason === null && hasWords(deleted[i].text)) {
      first[i] = i;
      second[i] = nextFirst;
    } else {
      first[i] = nextFirst;
      second[i] = sameHunk ? second[i + 1] : -1;
    }
  }
  return second;
}

// A line holds words when it has a letter or a digit, unlike "}" or "];".
const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);

// The text with whitespace taken out, so two lines that differ only in whitespace match. In
// Python the indent says which block a line is in, so it is code. With the file, `level` says
// how deep that block is, so a tab and four spaces at the same depth match, and a line inside
// brackets (level null) has no indent that counts. Without the file (level undefined), the
// indent stays as it is. In a JavaScript, TypeScript or Python file, whitespace inside a string
// stays too: 'Total:' and 'Total: ' print different text.
const squash = (text, path, level) => {
  const style = commentStyle(path);
  const words = style === null ? text.replace(/\s+/g, '') : squashCode(text, style);
  if (words === '' || style !== 'hash' || level === null) return words;
  return (level === undefined ? /^\s*/.exec(text)[0] : '\t'.repeat(level + 1)) + words;
};

// Takes the whitespace out of a line of code, except inside a string. Code inside ${ } in a
// template literal is code, so its whitespace goes too. A comment after the code, which starts
// after whitespace as in stripComments, ends the search, so its whitespace goes.
// In JavaScript a regex literal is code, as in stripComments, so a quote or a { in one, such as
// /'/ or /{/, opens nothing. Each line is read alone, so the next line of a string that spans
// lines reads as code. A quote mark that opens no string, such as an apostrophe in JSX text,
// opens one that the next quote mark ends, so the whitespace of a later real string can go. A
// division that reads as a regex, such as "x++ / 2", can do the same when a later string on the
// line has a "/" in it: the regex then ends inside that string.
function squashCode(text, style) {
  const quotes = style === 'slash' ? ['"', "'", '`'] : ['"', "'"];
  const comment = style === 'slash' ? '//' : '#';
  let out = '';
  // What the scan is inside, innermost last: a quote mark for a string, or, for code inside
  // ${ } in a template literal, the number of other { still open there.
  const inside = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const top = inside.at(-1);
    if (typeof top === 'string') {
      out += char;
      if (char === '\\') {
        // An escaped character, such as \' or \\, does not end the string.
        i++;
        out += text[i] ?? '';
      } else if (char === top) {
        inside.pop();
      } else if (top === '`' && text.startsWith('${', i)) {
        out += '{';
        i++;
        inside.push(0);
      }
      continue;
    }
    const spaced = i === 0 || /\s/.test(text[i - 1]);
    if (spaced && text.startsWith(comment, i)) return out + text.slice(i).replace(/\s+/g, '');
    if (/\s/.test(char)) continue;
    const regexEnd = style === 'slash' && char === '/' && opensRegex(text.slice(0, i)) ? endOfRegex(text, i) : -1;
    if (regexEnd !== -1) {
      out += text.slice(i, regexEnd + 1);
      i = regexEnd;
      continue;
    }
    out += char;
    if (quotes.includes(char)) inside.push(char);
    else if (top !== undefined && char === '{') inside[inside.length - 1] += 1;
    else if (top !== undefined && char === '}' && top > 0) inside[inside.length - 1] -= 1;
    else if (top !== undefined && char === '}') inside.pop();
  }
  return out;
}

// For each line of a whole file, by line number, what the hunk alone cannot show:
// - In JavaScript, `inBlock`: the line starts inside a block comment.
// - In Python, `level`: how deep the line's block is, 0 at the top. It is null for a line with
//   no indent that counts: a blank line, a comment line, or a line inside brackets, a
//   triple-quoted string or after a backslash at the end of the line before.
// Text in quotes is skipped, so a "/*" in a string such as 'src/**/*.js' opens nothing. A
// regex literal is read as code, so a "/*" in one, such as /[/*]/, is a rare wrong guess.
// A backtick in one, such as /`/, is a second: it reads as a template string that goes on
// until the next backtick. So a block comment after it can be missed, and its lines count. Or
// the next backtick opens a real template string, its text reads as code, and a "/*" in that
// text opens a block, so the code lines after it drop as a comment.
function lineFacts(text, path) {
  const rows = text.split('\n');
  return [undefined, ...(commentStyle(path) === 'hash' ? pythonLevels(rows) : blockStarts(rows))];
}

function blockStarts(rows) {
  const facts = [];
  let state = null;
  for (const row of rows) {
    facts.push({ inBlock: state === 'block' });
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (state === 'block') {
        if (row.startsWith('*/', i)) {
          state = null;
          i++;
        }
      } else if (state !== null) {
        if (ch === '\\') i++;
        else if (ch === state) state = null;
      } else if (row.startsWith('//', i)) {
        break;
      } else if (row.startsWith('/*', i)) {
        state = 'block';
        i++;
      } else if ('\'"`'.includes(ch)) {
        state = ch;
      }
    }
    // Only a template string goes on to the next line.
    if (state === '\'' || state === '"') state = null;
  }
  return facts;
}

function pythonLevels(rows) {
  const facts = [];
  const indents = [0];
  let depth = 0;
  let triple = null;
  let joined = false;
  for (const row of rows) {
    const words = row.trim();
    if (depth > 0 || triple !== null || joined || words === '' || words.startsWith('#')) {
      facts.push({ level: null });
    } else {
      const column = indentColumn(row);
      while (column < indents.at(-1)) indents.pop();
      if (column > indents.at(-1)) indents.push(column);
      facts.push({ level: indents.length - 1 });
    }
    let quote = null;
    let comment = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (triple !== null) {
        if (ch === '\\') i++;
        else if (row.startsWith(triple, i)) {
          triple = null;
          i += 2;
        }
      } else if (quote !== null) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '#') {
        comment = true;
        break;
      } else if (row.startsWith("'''", i) || row.startsWith('"""', i)) {
        triple = row.slice(i, i + 3);
        i += 2;
      } else if (ch === '\'' || ch === '"') {
        quote = ch;
      } else if ('([{'.includes(ch)) {
        depth++;
      } else if (')]}'.includes(ch)) {
        depth = Math.max(0, depth - 1);
      }
    }
    joined = !comment && triple === null && row.trimEnd().endsWith('\\');
  }
  return facts;
}

// The column where a Python line's code starts. As in Python, a tab moves to the next multiple
// of eight.
function indentColumn(row) {
  let column = 0;
  for (const ch of /^[ \t]*/.exec(row)[0]) column = ch === '\t' ? column + 8 - (column % 8) : column + 1;
  return column;
}

// The words inside a comment line, without its comment marks.
const uncomment = (text) => text.trim().replace(/^(\/\/+|\/\*+|\*+|#+)/, '').replace(/\*+\/$/, '');

// The line without its comments: a "//" or "#" comment to the end of the line, and in
// JavaScript a "/* */" comment. Text in quotes is code, so a "//" or "#" in a string stays. A
// comment mark counts only at the start of the line or after a space, so "http://a" stays too:
// a line can be part of a string that opened on an earlier line, which this cannot see.
// In JavaScript, a regex literal is code too, so the quote in "r = /'/; // n" opens no string.
// And a "//" in JSX text, with a closing tag after it on the line, such as
// "<p>Price // 10 USD</p>", is text. Other text that only looks like a comment, such as a "#"
// in a docstring or a "//" in a template literal that spans lines, is still read as a comment.
// A division that reads as a regex, such as "x++ / 2", can make a "//" in a later string read
// as a comment, when a later string or regex on the line has a "/" in it.
// The whitespace right before a comment that comes off goes too, so it cannot stop a match.
// Other whitespace at the end of the line stays: it can be text in a string that goes on to
// the next line.
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
    const regexEnd = style === 'slash' && ch === '/' && opensRegex(out) ? endOfRegex(text, i) : -1;
    if (regexEnd !== -1) {
      out += text.slice(i, regexEnd + 1);
      i = regexEnd;
      continue;
    }
    if (quotes.includes(ch)) quote = ch;
    const spaced = i === 0 || /\s/.test(text[i - 1]);
    const lineComment = style === 'hash' ? ch === '#' : text.startsWith('//', i) && !closingTag.test(text.slice(i + 2));
    if (spaced && lineComment) return out.trimEnd();
    if (spaced && style === 'slash' && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return out.trimEnd();
      out = out.trimEnd();
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// A JSX closing tag, such as "</p>", "</Foo.Bar>" or "</>".
const closingTag = /<\/([A-Za-z][\w.:-]*)?\s*>/;

// Whether a "/" after this code starts a regex literal, not a division: the code before it
// ends with nothing, with a mark such as "=", "(" or ",", or with a word such as "return".
// After "<" or ">" it is a division or a JSX tag, such as "</p>".
const opensRegex = (code) => /(^|[(,=:[!&|?{};+\-*%~^]|\b(return|typeof|case|void|delete|throw|yield|await|in|of|else|do))\s*$/.test(code);

// Where the regex literal that starts at `start` ends: the index of its last "/". A "/" in a
// class such as [/] or after a backslash does not end it. Returns -1 when the "/" starts a
// comment, or when no "/" ends the regex on this line.
function endOfRegex(text, start) {
  if (text[start + 1] === '/' || text[start + 1] === '*') return -1;
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i;
  }
  return -1;
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

// Says whether one of these rows closes a block comment that opened before the first of them.
// The look stops at the first row that opens a block with "/*": a "*/" after that row closes the
// new block, not the earlier one. So in " * qty;", "/* a", " * b */" the last row does not make
// " * qty;" a comment. A row that starts with "*" or "//" opens no block, even when its text
// names "/*", such as " * Use '/*' to open.": it is comment text or a block end.
function closesEarlierBlock(texts) {
  for (const text of texts) {
    if (closesBlock(text)) return true;
    if (opensBlock(text)) return false;
  }
  return false;
}

const opensBlock = (text) => {
  const rest = text.trim();
  return !rest.startsWith('*') && !rest.startsWith('//') && rest.includes('/*');
};

// Finds where a block comment ends in a row: the first "*/" with no "*" or "/" straight after it.
// A "*/" inside a glob such as "src/**/*.js" has a "*" after it, so it is comment text, not the end.
// Returns -1 when the row has no end.
function blockEnd(rest) {
  for (let i = rest.indexOf('*/'); i !== -1; i = rest.indexOf('*/', i + 1)) {
    if (!'*/'.includes(rest[i + 2] ?? ' ')) return i;
  }
  return -1;
}

// Says for each row of one side of a hunk whether it is only a comment. A hunk shows only the
// changed rows, so a block comment can open before the hunk. `starts` says for each row whether
// it starts inside a block comment, when the whole file is known. Without the file, a row that
// starts with "*" counts as a row of such a block only when the row or a later row of the hunk
// closes the block before any row that opens a new one, or when the row is a JSDoc tag such as
// "* @param". Code can start with "*" too, such as "* qty;" after a line that ends in "price".
function markComments(texts, path, starts = []) {
  const style = commentStyle(path);
  if (style === 'hash') return texts.map((text) => text.trim().startsWith('#'));
  if (style !== 'slash') return texts.map(() => false);
  let inBlock = false;
  return texts.map((text, i) => {
    let rest = text.trim();
    if (starts[i] !== undefined) inBlock = starts[i];
    if (!inBlock) {
      if (rest.startsWith('//')) return true;
      if (starts[i] === undefined && /^\*(\s|\/|$)/.test(rest)) {
        const end = blockEnd(rest);
        if (end !== -1) return rest.slice(end + 2).trim() === '';
        return /^\*\s*@\w/.test(rest) || closesEarlierBlock(texts.slice(i + 1));
      }
      if (!rest.startsWith('/*')) return false;
      rest = rest.slice(2);
    }
    // With the file, the first "*/" ends the block, as in JavaScript. Only the guess skips a glob.
    const end = starts[i] === undefined ? blockEnd(rest) : rest.indexOf('*/');
    inBlock = end === -1;
    if (inBlock) return true;
    const after = rest.slice(end + 2).trim();
    return after === '' || after.startsWith('//');
  });
}

// Reads a `git diff -U0` into hunks: { oldPath, newPath, newStart, deleted, added }. `deleted`
// holds { line, text } with the old line numbers, and `added` holds the added texts, the first
// at new line `newStart`. A hunk header "@@ -12,3 +12,1 @@" means old lines 12 to 14. A new file has a null oldPath, and a deleted
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
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(row);
    if (header) {
      hunk = { oldPath, newPath, newStart: Number(header[2]), deleted: [], added: [] };
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
