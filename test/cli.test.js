import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/exhibit.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('exhibit --version prints the version from package.json and exits 0', () => {
  const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(out, pkg.version + '\n');
});

test('exhibit -v is the short form of --version', () => {
  const out = execFileSync(process.execPath, [bin, '-v'], { encoding: 'utf8' });
  assert.equal(out, pkg.version + '\n');
});

test('package.json names bin/exhibit.js as the exhibit command', () => {
  assert.equal(pkg.bin.exhibit, 'bin/exhibit.js');
});

test('exhibit with an unknown command exits 2 and says so', () => {
  const run = spawnSync(process.execPath, [bin, 'nope'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /nope/);
});
