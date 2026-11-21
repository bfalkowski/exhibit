import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJUnit } from '../src/junit.js';
import { readPolicy } from '../src/policy.js';

// The test command in the Building58 setup note runs each test file with a time limit of its own,
// as Building58's relay/test/run.js does. These tests run the real command on a small copy of
// Building58's layout, with a limit of 2 seconds in place of 600.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const FILES = {
  'relay/test/pass.test.js': 'import test from "node:test";\ntest("adds", () => {});\n',
  'relay/test/fail.test.js': 'import test from "node:test";\nimport assert from "node:assert";\ntest("breaks", () => assert.equal(1, 2));\n',
  // Its test passes, but it leaves a timer running, so the file never ends. It writes its pid
  // first, so the test can check that the limit stopped it.
  'relay/test/hang.test.js': 'import test from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("starts a timer", () => { writeFileSync("hang.pid", String(process.pid)); setInterval(() => {}, 1000); });\n'
};

function runCommand(seconds, files = FILES) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exhibit-b58-')));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'b58', version: '1.0.0', type: 'module' }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'b58', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'b58', version: '1.0.0' } } }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return readPolicy(join(root, 'examples', 'building58')).then((policy) => {
    const env = { ...process.env, TEST_FILE_SECONDS: String(seconds) };
    // This file runs under node --test. A child node --test that sees this variable reports to it.
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const result = spawnSync('/bin/sh', ['-c', policy.settings.test_command], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    return { dir, result, ms: Date.now() - started, junit: readFileSync(join(dir, policy.settings.test_results), 'utf8') };
  });
}

test('building58: a file that never ends fails after its time limit, and the other files still give results', async () => {
  const { dir, result, ms, junit } = await runCommand(2);
  try {
    assert.equal(result.error, undefined, 'the command ended by itself');
    assert.notEqual(result.status, 0);
    assert.ok(ms < 30_000, `took ${ms} ms`);
    const cases = parseJUnit(junit).map(({ name, status }) => `${name}: ${status}`).sort();
    assert.deepEqual(cases, ['adds: passed', 'breaks: failed', 'relay/test/hang.test.js ran past its time limit of 2 seconds: failed']);
    const late = parseJUnit(junit).find((item) => item.name.includes('time limit'));
    assert.equal(late.file, join(dir, 'relay/test/hang.test.js'));
    assert.match(result.stderr, /relay\/test\/hang\.test\.js ran past its time limit of 2 seconds/);
    // The limit stops the test process that holds the timer, not only node --test above it.
    const pid = Number(readFileSync(join(dir, 'hang.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    // If the limit did not work, stop the file here, so a failing test leaves nothing running.
    try { process.kill(Number(readFileSync(join(dir, 'hang.pid'), 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

// run.js reads the limit with Math.max(1, Number(value) || 600), so a value that is not a number,
// or 0, gives 600. Here the files end at once, so with 600 they pass, and with a broken limit of
// NaN or 0 seconds each file would fail at once.
for (const value of ['abc', '0']) {
  test(`building58: TEST_FILE_SECONDS=${value} gives the limit of 600 seconds, as in run.js`, async () => {
    const files = { 'relay/test/pass.test.js': FILES['relay/test/pass.test.js'] };
    const { dir, result, junit } = await runCommand(value, files);
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(parseJUnit(junit).map(({ name, status }) => `${name}: ${status}`), ['adds: passed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
