import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ToolError } from './tool-error.js';

const run = promisify(execFile);

// A clean git worktree of the commit `sha` from the clone in `cwd`, made only when a collector
// first asks for it. `path()` makes it, or gives the one already made. `remove()` removes it, and
// does nothing when it was never made.
//
// The worktree is a fresh checkout in a temporary folder. It has no files that git ignores, such
// as node_modules, so a command that needs them must install them first.
export function worktreeOnDemand(cwd, sha) {
  let made = null;
  return {
    path() {
      made ??= add(cwd, sha);
      return made.then(({ path }) => path);
    },
    async remove() {
      if (made === null) return;
      const { dir, path } = await made.catch(() => ({}));
      if (dir === undefined) return;
      await git(cwd, ['worktree', 'remove', '--force', path]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
      await git(cwd, ['worktree', 'prune']).catch(() => {});
    }
  };
}

async function add(cwd, sha) {
  const dir = await mkdtemp(join(tmpdir(), 'exhibit-worktree-'));
  const path = join(dir, 'head');
  try {
    await git(cwd, ['worktree', 'add', '--detach', '--quiet', path, sha]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, path };
}

async function git(cwd, args) {
  try {
    await run('git', args, { cwd, encoding: 'utf8' });
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0] || error.message;
    throw new ToolError(`git ${args.slice(0, 2).join(' ')} failed: ${reason}`);
  }
}
