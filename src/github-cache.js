import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The reply cache: GitHub replies saved with their ETag, so the next request for the same URL can
// send If-None-Match. GitHub answers 304 when nothing changed, and a 304 does not count against
// the rate limit. All runs on the machine share one folder, so one run fills it for the next.

// Returns the cache folder: "exhibit/github" in the user's cache folder. That is
// $XDG_CACHE_HOME when it is set, ~/Library/Caches on macOS, %LOCALAPPDATA% on Windows, and
// ~/.cache elsewhere.
export function cacheFolder({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  let base;
  if (env.XDG_CACHE_HOME) base = env.XDG_CACHE_HOME;
  else if (platform === 'darwin') base = join(home, 'Library', 'Caches');
  else if (platform === 'win32' && env.LOCALAPPDATA) base = env.LOCALAPPDATA;
  else base = join(home, '.cache');
  return join(base, 'exhibit', 'github');
}

// Makes the cache for one token in the folder `dir`. Each entry is one file, and its name is a
// SHA-256 hash of a hash of the token and the URL. So two tokens never share an entry, and no
// file name or file holds the token.
// read(url) returns { etag, body, headers } or null. A missing, broken or partly written entry
// gives null, so the client asks GitHub again with no If-None-Match. A read that returns an entry
// sets the file time to now, so removeOldEntries sees that a run still uses it.
// write(url, entry) saves an entry. It writes a temporary file and renames it, so a reader never
// sees half a file. A write that fails is ignored: the cache only saves requests, so it never
// stops a run.
export function createReplyCache({ dir, token }) {
  const tokenKey = sha256(`exhibit token\n${token}`);
  let folderMade = false;
  const pathOf = (url) => join(dir, `${sha256(`${tokenKey}\n${url}`)}.json`);

  async function read(url) {
    let entry;
    try {
      entry = JSON.parse(await readFile(pathOf(url), 'utf8'));
    } catch {
      return null;
    }
    const fits = entry !== null && typeof entry === 'object' && entry.url === url && typeof entry.etag === 'string' && entry.etag !== '' &&
      typeof entry.body === 'string' && entry.headers !== null && typeof entry.headers === 'object' &&
      Object.values(entry.headers).every((value) => typeof value === 'string');
    if (!fits) return null;
    const now = new Date();
    await utimes(pathOf(url), now, now).catch(() => {});
    return { etag: entry.etag, body: entry.body, headers: entry.headers };
  }

  async function write(url, { etag, body, headers }) {
    const path = pathOf(url);
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // Only this user can read the cache: it can hold replies about private repos. mkdir sets the
      // mode only on a new folder, so chmod also narrows a folder that was there before.
      if (!folderMade) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
        folderMade = true;
      }
      await writeFile(temporary, JSON.stringify({ url, etag, headers, body }), { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  return { read, write };
}

// An entry that no run has read or written for this long is removed.
export const UNUSED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// An entry file is a SHA-256 hash and ".json". A temporary file is an entry name and ".tmp".
const CACHE_FILE = /^[0-9a-f]{64}\.json(\..*\.tmp)?$/;

// Removes the files in the cache folder `dir` that no run has read or written for UNUSED_DAYS
// days: entries, and temporary files that a stopped run left behind. The file time tells when a
// run last used a file. It leaves files that the cache did not write. Without this the folder
// grows by one file for each URL and token. A removed entry only costs one full request the next
// time. Returns how many files it removed. It never fails: a missing folder or a file that
// another run removed first is skipped.
export async function removeOldEntries(dir, { now = Date.now() } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.filter((name) => CACHE_FILE.test(name))) {
    const path = join(dir, name);
    try {
      if (now - (await stat(path)).mtimeMs < UNUSED_DAYS * DAY_MS) continue;
      await rm(path);
      removed++;
    } catch {
      // Another run removed or replaced it first.
    }
  }
  return removed;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
