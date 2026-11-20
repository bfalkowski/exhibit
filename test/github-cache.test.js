import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub } from '../src/github.js';
import { cacheFolder, createReplyCache, removeOldEntries, UNUSED_DAYS } from '../src/github-cache.js';

// Makes a new empty cache folder. The folder is removed when the test that made it ends.
const madeFolders = [];
function newFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-cache-'));
  madeFolders.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of madeFolders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fetch that acts like GitHub for recorded replies. `replies` maps a path to { etag, body, link }.
// A request whose If-None-Match equals the reply's ETag gets a 304 with no body, as from GitHub.
// Every request is recorded with its headers.
function recorded(replies) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ path: pathname + search, headers: { ...init.headers } });
    const { etag, body, link } = replies[pathname + search];
    if (init.headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag, 'content-type': 'application/json', ...(link ? { link } : {}) } });
  };
  return { fetch, calls };
}

const TOKEN = 'ghp_secretTokenThatMustNotBeSaved1234';

function client(fetch, dir, token = TOKEN) {
  return createGitHub({ token, fetch, cache: createReplyCache({ dir, token }) });
}

test('the second request for a URL sends If-None-Match, gets a 304, and returns the saved body', async () => {
  const dir = newFolder();
  const github = recorded({ '/repos/o/r/pulls/9': { etag: 'W/"v1"', body: { number: 9, title: 'Add a thing' } } });

  assert.deepEqual(await client(github.fetch, dir).getOne('/repos/o/r/pulls/9'), { number: 9, title: 'Add a thing' });
  const second = client(github.fetch, dir);
  assert.deepEqual(await second.getOne('/repos/o/r/pulls/9'), { number: 9, title: 'Add a thing' });

  assert.equal(github.calls[0].headers['if-none-match'], undefined);
  assert.equal(github.calls[1].headers['if-none-match'], 'W/"v1"');
  assert.deepEqual(second.counts(), { requests: 1, not_modified: 1, queries: 0, points: 0 });
});

test('a list served from the cache still follows the saved Link header to the next page', async () => {
  const dir = newFolder();
  const github = recorded({
    '/x?page=1': { etag: '"p1"', body: [1, 2], link: '<https://api.github.com/x?page=2>; rel="next"' },
    '/x?page=2': { etag: '"p2"', body: [3] }
  });
  assert.deepEqual(await client(github.fetch, dir).getAll('/x?page=1'), [1, 2, 3]);
  const second = client(github.fetch, dir);
  assert.deepEqual(await second.getAll('/x?page=1'), [1, 2, 3]);
  assert.deepEqual(second.counts(), { requests: 2, not_modified: 2, queries: 0, points: 0 });
});

test('a 200 with a new ETag replaces the saved entry', async () => {
  const dir = newFolder();
  const replies = { '/repos/o/r': { etag: '"old"', body: { default_branch: 'main' } } };
  const github = recorded(replies);
  await client(github.fetch, dir).getOne('/repos/o/r');

  replies['/repos/o/r'] = { etag: '"new"', body: { default_branch: 'trunk' } };
  assert.deepEqual(await client(github.fetch, dir).getOne('/repos/o/r'), { default_branch: 'trunk' }, 'the old ETag no longer matches, so GitHub sends 200');
  const third = client(github.fetch, dir);
  assert.deepEqual(await third.getOne('/repos/o/r'), { default_branch: 'trunk' });

  assert.deepEqual(github.calls.map((call) => call.headers['if-none-match']), [undefined, '"old"', '"new"']);
  assert.deepEqual(third.counts(), { requests: 1, not_modified: 1, queries: 0, points: 0 });
});

test('a broken or partly written entry is ignored: the client asks again with no If-None-Match, and the run succeeds', async () => {
  const dir = newFolder();
  const github = recorded({ '/repos/o/r': { etag: '"v1"', body: { default_branch: 'main' } } });
  await client(github.fetch, dir).getOne('/repos/o/r');
  const [file] = readdirSync(dir);

  for (const broken of ['{"url":"https://api.github.com/repos/o/r","etag":"\\"v1\\"","bo', '', '[]', '{"etag":"\\"v1\\""}']) {
    writeFileSync(join(dir, file), broken);
    const again = client(github.fetch, dir);
    assert.deepEqual(await again.getOne('/repos/o/r'), { default_branch: 'main' }, JSON.stringify(broken));
    assert.equal(github.calls.at(-1).headers['if-none-match'], undefined, JSON.stringify(broken));
    assert.deepEqual(again.counts(), { requests: 1, not_modified: 0, queries: 0, points: 0 });
  }
  // The last fetch wrote a whole entry again, so the next request gets a 304.
  const fixed = client(github.fetch, dir);
  await fixed.getOne('/repos/o/r');
  assert.deepEqual(fixed.counts(), { requests: 1, not_modified: 1, queries: 0, points: 0 });
});

test('with no cache, the client sends no If-None-Match and writes nothing', async () => {
  const dir = newFolder();
  const github = recorded({ '/repos/o/r': { etag: '"v1"', body: { default_branch: 'main' } } });
  const noCache = createGitHub({ token: TOKEN, fetch: github.fetch });
  await noCache.getOne('/repos/o/r');
  await noCache.getOne('/repos/o/r');
  assert.deepEqual(github.calls.map((call) => call.headers['if-none-match']), [undefined, undefined]);
  assert.deepEqual(noCache.counts(), { requests: 2, not_modified: 0, queries: 0, points: 0 });
  assert.deepEqual(readdirSync(dir), []);
});

test('two tokens get separate entries, and no file in the cache holds a token', async () => {
  const dir = newFolder();
  const other = 'second-secret-token-5678';
  const github = recorded({ '/repos/o/r': { etag: '"v1"', body: { default_branch: 'main' } } });

  await client(github.fetch, dir, TOKEN).getOne('/repos/o/r');
  const second = client(github.fetch, dir, other);
  await second.getOne('/repos/o/r');

  assert.equal(github.calls[1].headers['if-none-match'], undefined, 'the second token does not get the first token\'s entry');
  assert.deepEqual(second.counts(), { requests: 1, not_modified: 0, queries: 0, points: 0 });
  const files = readdirSync(dir);
  assert.equal(files.length, 2);
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const token of [TOKEN, other]) {
      assert.ok(!name.includes(token) && !text.includes(token), `${name} holds a token`);
    }
  }
});

test('the cache folder is exhibit/github in the user\'s cache folder', () => {
  assert.equal(cacheFolder({ env: { XDG_CACHE_HOME: '/c' }, platform: 'darwin', home: '/h' }), join('/c', 'exhibit', 'github'));
  assert.equal(cacheFolder({ env: {}, platform: 'darwin', home: '/h' }), join('/h', 'Library', 'Caches', 'exhibit', 'github'));
  assert.equal(cacheFolder({ env: {}, platform: 'linux', home: '/h' }), join('/h', '.cache', 'exhibit', 'github'));
  assert.equal(cacheFolder({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32', home: '/h' }), join('C:\\L', 'exhibit', 'github'));
});

// GitHub's ETag covers the body only, not the Link header. So when a full last page gets a new
// page after it, the full page still answers 304, and its saved Link has no rel="next".
test('a full last page served from the cache is asked again with no If-None-Match, so a new page after it is not missed', async () => {
  const dir = newFolder();
  const replies = { '/c?per_page=2': { etag: '"body-1-2"', body: [1, 2] } };
  const github = recorded(replies);
  assert.deepEqual(await client(github.fetch, dir).getAll('/c?per_page=2'), [1, 2]);

  // A third comment goes on page 2. Page 1 has the same body, so the same ETag, and a new Link.
  replies['/c?per_page=2'] = { etag: '"body-1-2"', body: [1, 2], link: '<https://api.github.com/c?per_page=2&page=2>; rel="next"' };
  replies['/c?per_page=2&page=2'] = { etag: '"body-3"', body: [3] };
  const second = client(github.fetch, dir);
  assert.deepEqual(await second.getAll('/c?per_page=2'), [1, 2, 3]);
  assert.deepEqual(github.calls.slice(1).map((call) => [call.path, call.headers['if-none-match']]), [
    ['/c?per_page=2', '"body-1-2"'],
    ['/c?per_page=2', undefined],
    ['/c?per_page=2&page=2', undefined]
  ]);
  assert.deepEqual(second.counts(), { requests: 3, not_modified: 1, queries: 0, points: 0 });

  // Page 1 now has a saved rel="next", so the next run trusts its 304s.
  const third = client(github.fetch, dir);
  assert.deepEqual(await third.getAll('/c?per_page=2'), [1, 2, 3]);
  assert.deepEqual(third.counts(), { requests: 2, not_modified: 2, queries: 0, points: 0 });
});

test('a last page that is not full is trusted on a 304', async () => {
  const dir = newFolder();
  const github = recorded({ '/c?per_page=3': { etag: '"a"', body: [1, 2] } });
  await client(github.fetch, dir).getAll('/c?per_page=3');
  const second = client(github.fetch, dir);
  assert.deepEqual(await second.getAll('/c?per_page=3'), [1, 2]);
  assert.deepEqual(second.counts(), { requests: 1, not_modified: 1, queries: 0, points: 0 });
});

test('the cache narrows a folder that was there before to the user alone, and each file too', { skip: process.platform === 'win32' }, async () => {
  const dir = join(newFolder(), 'github');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const github = recorded({ '/repos/o/r': { etag: '"v1"', body: { default_branch: 'main' } } });
  await client(github.fetch, dir).getOne('/repos/o/r');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const name of readdirSync(dir)) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
});

test('a request that never reached GitHub is not counted', async () => {
  const github = createGitHub({ token: TOKEN, fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(github.getOne('/repos/o/r'), /could not reach GitHub/);
  assert.deepEqual(github.counts(), { requests: 0, not_modified: 0, queries: 0, points: 0 });
});

const DAY = 24 * 60 * 60 * 1000;
// Sets the file time of `path` to `days` days before now.
function ageBy(path, days) {
  const then = new Date(Date.now() - days * DAY);
  utimesSync(path, then, then);
}

test('a run that reads an entry marks it as used, so its file time is now', async () => {
  const dir = newFolder();
  const github = recorded({ '/repos/o/r': { etag: '"v1"', body: { default_branch: 'main' } } });
  await client(github.fetch, dir).getOne('/repos/o/r');
  const [file] = readdirSync(dir);
  ageBy(join(dir, file), UNUSED_DAYS + 10);

  const second = client(github.fetch, dir);
  await second.getOne('/repos/o/r');
  assert.deepEqual(second.counts(), { requests: 1, not_modified: 1, queries: 0, points: 0 }, 'the entry was read, not written again');
  assert.ok(Date.now() - statSync(join(dir, file)).mtimeMs < DAY, 'the read moved the file time to now');
});

test('removeOldEntries removes the entries that no run has used for 30 days, and keeps the rest', async () => {
  const dir = newFolder();
  const github = recorded({
    '/old': { etag: '"o"', body: { n: 1 } },
    '/new': { etag: '"n"', body: { n: 2 } }
  });
  const first = client(github.fetch, dir);
  await first.getOne('/old');
  const [oldFile] = readdirSync(dir);
  await first.getOne('/new');
  const [newFile] = readdirSync(dir).filter((name) => name !== oldFile);
  ageBy(join(dir, oldFile), UNUSED_DAYS + 1);
  ageBy(join(dir, newFile), UNUSED_DAYS - 1);
  // A temporary file that a stopped run left behind, and a file that the cache did not write.
  writeFileSync(join(dir, `${oldFile}.123.abc.tmp`), '{"url":');
  ageBy(join(dir, `${oldFile}.123.abc.tmp`), UNUSED_DAYS + 1);
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  ageBy(join(dir, 'notes.txt'), UNUSED_DAYS + 1);

  assert.equal(await removeOldEntries(dir), 2);
  assert.deepEqual(readdirSync(dir).sort(), [newFile, 'notes.txt'].sort());

  // The removed entry costs one full request, and is saved again.
  const second = client(github.fetch, dir);
  assert.deepEqual(await second.getOne('/old'), { n: 1 });
  assert.equal(github.calls.at(-1).headers['if-none-match'], undefined);
  assert.equal(readdirSync(dir).length, 3);
});

test('removeOldEntries on a folder that is not there removes nothing and does not fail', async () => {
  const dir = join(newFolder(), 'github');
  assert.equal(await removeOldEntries(dir), 0);
  assert.equal(existsSync(dir), false);
});

test('removeOldEntries removes an entry that is exactly 30 days old, and keeps one that is 1 second younger', async () => {
  const dir = newFolder();
  // A whole second, so the file times hold it exactly.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const files = { exact: 'a', younger: 'b', older: 'c' };
  const ages = { exact: UNUSED_DAYS * DAY, younger: UNUSED_DAYS * DAY - 1000, older: UNUSED_DAYS * DAY + 1000 };
  for (const [name, letter] of Object.entries(files)) {
    const path = join(dir, `${letter.repeat(64)}.json`);
    writeFileSync(path, '{}');
    const then = new Date(now - ages[name]);
    utimesSync(path, then, then);
  }

  assert.equal(await removeOldEntries(dir, { now }), 2);
  assert.deepEqual(readdirSync(dir), [`${files.younger.repeat(64)}.json`]);
});
