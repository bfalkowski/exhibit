import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTogether } from '../src/write-together.js';
import { BACKTEST_REPORT, HISTORY_REPORT } from '../src/report.js';

function newFolder(t) {
  const folder = mkdtempSync(join(tmpdir(), 'exhibit-together-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test('writeTogether writes every file, and makes the folder when it is missing', async (t) => {
  const cwd = newFolder(t);
  await writeTogether(cwd, [['.exhibit/a.md', 'new a\n'], ['.exhibit/b.html', 'new b\n']]);
  assert.equal(readFileSync(join(cwd, '.exhibit/a.md'), 'utf8'), 'new a\n');
  assert.equal(readFileSync(join(cwd, '.exhibit/b.html'), 'utf8'), 'new b\n');
  assert.deepEqual(readdirSync(join(cwd, '.exhibit')).sort(), ['a.md', 'b.html']);
});

test('when one write fails, writeTogether changes none of the files and leaves no temporary file', async (t) => {
  const cwd = newFolder(t);
  mkdirSync(join(cwd, '.exhibit'));
  writeFileSync(join(cwd, '.exhibit/a.md'), 'old a\n');
  // A file where a folder must go: the write of the second file fails after the first one worked.
  writeFileSync(join(cwd, '.exhibit/blocked'), 'not a folder\n');
  await assert.rejects(
    writeTogether(cwd, [['.exhibit/a.md', 'new a\n'], ['.exhibit/blocked/b.html', 'new b\n']]),
    /could not write \.exhibit\/blocked\/b\.html/
  );
  assert.equal(readFileSync(join(cwd, '.exhibit/a.md'), 'utf8'), 'old a\n');
  assert.deepEqual(readdirSync(join(cwd, '.exhibit')).sort(), ['a.md', 'blocked']);
});

test('backtest has its own report paths, so it never writes over the history report (spec 8.5)', () => {
  assert.deepEqual(HISTORY_REPORT, { markdown: '.exhibit/report.md', html: '.exhibit/report.html' });
  assert.deepEqual(BACKTEST_REPORT, { markdown: '.exhibit/backtest.md', html: '.exhibit/backtest.html' });
  const history = new Set(Object.values(HISTORY_REPORT));
  assert.deepEqual(Object.values(BACKTEST_REPORT).filter((path) => history.has(path)), []);
});
