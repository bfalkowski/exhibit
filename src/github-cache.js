import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
// gives null, so the client asks GitHub again with no If-None-Match.
// write(url, entry) saves an entry. It writes a temporary file and renames it, so a reader never
// sees half a file. A write that fails is ignored: the cache only saves requests, so it never
// stops a run.
export function createReplyCache({ dir, token }) {
  const tokenKey = sha256(`exhibit token\n${token}`);
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
    return fits ? { etag: entry.etag, body: entry.body, headers: entry.headers } : null;
  }

  async function write(url, { etag, body, headers }) {
    const path = pathOf(url);
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // Only this user can read the cache: it can hold replies about private repos.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ url, etag, headers, body }), { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  return { read, write };
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
