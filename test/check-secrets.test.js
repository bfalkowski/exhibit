import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLine } from '../scripts/check-secrets.js';

const script = fileURLToPath(new URL('../scripts/check-secrets.js', import.meta.url));
// Built at run time, so this file holds no string the scan would find.
const githubToken = 'gh' + 'p_' + 'a'.repeat(36);
const awsKey = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';

test('checkLine finds a token and names its kind', () => {
  assert.equal(checkLine('const t = "' + githubToken + '";'), 'a GitHub token');
  assert.equal(checkLine(awsKey), 'an AWS access key');
  assert.equal(checkLine('password = "' + 'hunter2hunter2' + '"'), 'a password or key being assigned');
});

test('checkLine passes code, placeholders and allowed lines', () => {
  assert.equal(checkLine('const apiKey = process.env.API_KEY;'), null);
  assert.equal(checkLine('password: "changeme123"'), null);
  assert.equal(checkLine(githubToken + ' // secret-check: allow'), null);
});

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-secrets-'));
  execFileSync('git', ['init', '-q', dir]);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  execFileSync('git', ['-C', dir, 'add', '.']);
  return dir;
}

test('--all exits 1 and names the file and line, without printing the secret', (t) => {
  const dir = repoWith({ 'a.js': 'ok\nconst t = "' + githubToken + '";\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [script, '--all'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /a\.js:2: a GitHub token/);
  assert.ok(!run.stderr.includes(githubToken));
});

test('--all exits 1 for a tracked .env file', (t) => {
  const dir = repoWith({ '.env': 'X=1\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [script, '--all'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\.env: a file that holds secrets/);
});

test('--all exits 0 on a clean repo', (t) => {
  const dir = repoWith({ 'a.js': 'export const x = 1;\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [script, '--all'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
