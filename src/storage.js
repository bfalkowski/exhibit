import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ToolError } from './tool-error.js';

// The places an exhibit can be stored (spec 9.12). A CI artifact or a bucket can come later as one
// more entry here.
export const STORAGE_TARGETS = ['data-branch', 'local'];
export const DEFAULT_DATA_BRANCH = 'exhibit-data';
export const DEFAULT_LOCAL_PATH = '.exhibit/out';
// How many times a push is tried. A push fails when another run pushed first. Each try fetches
// the branch again and puts the commit on top of the new tip.
export const PUSH_TRIES = 5;

// Where one exhibit goes, inside the data branch or the local folder: prs/<number>/<head-sha>.json.
export function exhibitPath(exhibit) {
  return `prs/${exhibit.pr}/${exhibit.head}.json`;
}

// Stores `text` at `path` in the target. Every write of an exhibit goes through this one function.
// `target` is { kind: 'data-branch', cwd, remote, branch, message } or { kind: 'local', cwd, folder }.
// It returns { changed, where, commit }. `changed` is false when the same text was already
// there, so storing the same exhibit twice changes nothing. `commit` is the data branch's commit,
// or null for a folder.
export async function store(target, path, text) {
  if (target.kind === 'data-branch') return storeOnDataBranch(target, path, text);
  if (target.kind === 'local') return storeInFolder(target, path, text);
  throw new Error(`storage: unknown target ${target.kind}`);
}

async function storeInFolder({ cwd, folder }, path, text) {
  const file = resolve(cwd, folder, path);
  const where = join(folder, path);
  const old = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw new ToolError(`could not read ${where}: ${error.message}`);
  });
  if (old === text) return { changed: false, where, commit: null };
  const temp = `${file}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temp, text);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw new ToolError(`could not write ${where}: ${error.message}`);
  }
  return { changed: true, where, commit: null };
}

// Commits the file to the data branch on the remote, and pushes it. It uses only git's plumbing:
// a blob, a tree made in a temporary index, and a commit. So it never touches the working tree,
// the index or the checked-out branch. It makes the branch, with no shared history, when the
// remote does not have it.
//
// Two runs can publish at the same time. The push of the later one is refused, because the branch
// moved. It then fetches the branch again, puts its commit on the new tip, and pushes again, up to
// PUSH_TRIES times. A push that fails while the branch did not move is not a race, such as a
// remote that refuses pushes, so it stops at once.
async function storeOnDataBranch({ cwd, remote, branch, message }, path, text) {
  const ref = `refs/heads/${branch}`;
  await git(cwd, ['check-ref-format', ref]).catch(() => {
    throw new ToolError(`"${branch}" is not a valid branch name for the data branch.`);
  });
  const where = `${path} on ${branch}`;
  const env = await withIdentity(cwd);
  const blob = (await git(cwd, ['hash-object', '-w', '--stdin'], { input: text })).trim();
  // Each run fetches into its own ref, so two runs in one clone do not change each other's tip.
  const fetched = `refs/exhibit/publish/${process.pid}-${randomUUID()}`;
  try {
    let builtOn;
    let refusal = '';
    for (let tries = 1; tries <= PUSH_TRIES; tries += 1) {
      const tip = await fetchTip(cwd, remote, ref, fetched);
      if (tries > 1 && tip === builtOn) throw new ToolError(`could not push ${where} to ${remote}: ${refusal}`);
      if (tip !== null && (await blobAt(cwd, tip, path)) === blob) return { changed: false, where, commit: tip };
      const commit = await commitOnTop(cwd, env, tip, path, blob, message);
      builtOn = tip;
      refusal = await push(cwd, remote, commit, ref);
      if (refusal === null) return { changed: true, where, commit };
      // Wait a short, random time, so two runs that collide do not collide again.
      await sleep(100 * tries + Math.floor(Math.random() * 200));
    }
    throw new ToolError(`could not push ${where} to ${remote} after ${PUSH_TRIES} tries, because other runs kept pushing first. The last refusal: ${refusal}`);
  } finally {
    await git(cwd, ['update-ref', '-d', fetched]).catch(() => {});
  }
}

// The tip of the branch on the remote, fetched into the ref `into`, or null when the remote has no
// such branch.
async function fetchTip(cwd, remote, ref, into) {
  try {
    await git(cwd, ['ls-remote', '--exit-code', remote, ref]);
  } catch (error) {
    if (error.exitCode === 2) return null;
    throw new ToolError(`could not read the remote ${remote}: ${error.reason}`);
  }
  await git(cwd, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, `+${ref}:${into}`]).catch((error) => {
    throw new ToolError(`could not fetch ${ref} from ${remote}: ${error.reason}`);
  });
  return (await git(cwd, ['rev-parse', '--verify', into])).trim();
}

async function blobAt(cwd, commit, path) {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`])).trim();
  } catch {
    return null;
  }
}

// A commit with the tree of `parent` plus the file, made in a temporary index. With no parent,
// the tree holds only the file.
async function commitOnTop(cwd, env, parent, path, blob, message) {
  const index = join(tmpdir(), `exhibit-index-${process.pid}-${randomUUID()}`);
  const withIndex = { ...env, GIT_INDEX_FILE: index };
  try {
    await git(cwd, parent === null ? ['read-tree', '--empty'] : ['read-tree', parent], { env: withIndex });
    await git(cwd, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env: withIndex });
    const tree = (await git(cwd, ['write-tree'], { env: withIndex })).trim();
    return (await git(cwd, ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent]), '-m', message], { env })).trim();
  } finally {
    await rm(index, { force: true });
  }
}

// Pushes the commit to the branch, never with force. Returns null when it worked, or git's reason.
async function push(cwd, remote, commit, ref) {
  try {
    await git(cwd, ['push', '--quiet', remote, `${commit}:${ref}`]);
    return null;
  } catch (error) {
    return error.reason;
  }
}

// The env for git commit-tree. A CI runner often has no user.name or user.email, and then git
// refuses to commit. So when git cannot name the author or the committer, the commit is made by
// "Exhibit".
async function withIdentity(cwd) {
  try {
    await git(cwd, ['var', 'GIT_AUTHOR_IDENT']);
    await git(cwd, ['var', 'GIT_COMMITTER_IDENT']);
    return process.env;
  } catch {
    const name = 'Exhibit';
    const email = 'exhibit@users.noreply.github.com';
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, ...process.env };
  }
}

// Runs git and gives its output. A failure rejects with an Error that has `exitCode` and `reason`,
// the first lines git wrote to stderr.
function git(cwd, args, { input, env = process.env } = {}) {
  return new Promise((done, fail) => {
    // stdin is a pipe only when there is input. A git command that reads no input can exit
    // before a write to its stdin, and the write then fails with EPIPE.
    const child = spawn('git', args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (exitCode) => {
      if (exitCode === 0) return done(stdout);
      const reason = stderr.trim().split('\n').slice(0, 3).join(' ') || `git ${args[0]} exited ${exitCode}`;
      fail(Object.assign(new Error(`git ${args[0]} failed: ${reason}`), { exitCode, reason }));
    });
    if (input !== undefined) {
      // A failed write shows as git's own exit code in 'close', so the error is not needed here.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
