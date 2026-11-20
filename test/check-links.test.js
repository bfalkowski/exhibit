import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokenLinks, linksIn } from '../scripts/check-links.js';

// scripts/check-links.js is the docs probe in evidence.yml. It finds links in the docs that point
// to a file that is not there.

const script = fileURLToPath(new URL('../scripts/check-links.js', import.meta.url));

function folder(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test('linksIn finds markdown links and html href and src, and leaves out web links and anchors', () => {
  const text = '[a](docs/spec.md) [b](https://x.org/y) [c](#words) [d](spec.md#words "title") <a href="index.html?x=1">e</a> <img src="pic.png"> <a href="mailto:a@example.com">f</a>';
  assert.deepEqual(linksIn(text), ['docs/spec.md', 'spec.md', 'index.html', 'pic.png']);
});

test('brokenLinks reads each link from the folder of its file, and names each missing target', (t) => {
  const dir = folder(t, {
    'README.md': '[spec](docs/spec.md) [gone](docs/gone.md)',
    'docs/spec.md': '[page](index.html) [up](../README.md) [lost](../lost.md)',
    'docs/index.html': '<a href="spec.md">spec</a>'
  });
  assert.deepEqual(brokenLinks(dir, ['README.md', 'docs']), [
    'README.md links to docs/gone.md, which is not there.',
    'docs/spec.md links to ../lost.md, which is not there.'
  ]);
});

test('the script exits 0 when every link works, and 1 with each broken link when one does not', (t) => {
  const good = folder(t, { 'README.md': '[spec](docs/spec.md)', 'docs/spec.md': 'text' });
  const ok = spawnSync(process.execPath, [script, 'README.md', 'docs'], { cwd: good, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'Every link works: 1 link in 2 files.\n');

  const bad = folder(t, { 'README.md': '[spec](docs/spec.md)' });
  const fail = spawnSync(process.execPath, [script, 'README.md'], { cwd: bad, encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.equal(fail.stderr, 'README.md links to docs/spec.md, which is not there.\n');
});

test('the links in this repo\'s own docs all work', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(brokenLinks(root, ['README.md', 'CLAUDE.md', 'docs']), []);
});
