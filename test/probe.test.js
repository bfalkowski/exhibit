import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProbe } from '../src/probe.js';

// A worktree folder for the probe to run in, and an output folder, both removed after the test.
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exhibit-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree);
  return { dir, worktree, outDir: join(dir, 'out', 'probes', 'p'), outPath: '.exhibit/probes/p' };
}

const probe = (fields) => ({ name: 'p', artifacts: [], ...fields });

test('a probe that exits 0 and writes its artifacts is met, and its output and artifacts are kept', async (t) => {
  const where = setup(t);
  const result = await runProbe(probe({ run: 'echo hello; mkdir -p logs && echo done > logs/run.log', artifacts: ['logs/run.log'] }), { ...where, timeoutSeconds: 10 });
  assert.equal(result.status, 'met');
  assert.deepEqual(result.details, {
    exit_code: 0,
    timed_out: false,
    timeout_seconds: 10,
    output: '.exhibit/probes/p/output.log',
    artifacts: [{ path: 'logs/run.log', copy: '.exhibit/probes/p/artifacts/logs/run.log' }],
    missing_artifacts: []
  });
  assert.equal(readFileSync(join(where.outDir, 'output.log'), 'utf8'), 'hello\n');
  assert.equal(readFileSync(join(where.outDir, 'artifacts', 'logs', 'run.log'), 'utf8'), 'done\n');
});

test('a probe that exits 1 is failed, and how_to_fix gives the exit code and the output file', async (t) => {
  const where = setup(t);
  const result = await runProbe(probe({ run: 'echo broken >&2; exit 1' }), { ...where, timeoutSeconds: 10 });
  assert.equal(result.status, 'failed');
  assert.equal(result.details.exit_code, 1);
  assert.match(result.how_to_fix, /exited with code 1/);
  assert.match(result.how_to_fix, /\.exhibit\/probes\/p\/output\.log/);
  assert.equal(readFileSync(join(where.outDir, 'output.log'), 'utf8'), 'broken\n');
});

test('a probe that exits 0 but does not write an artifact is failed, and the gap names it', async (t) => {
  const where = setup(t);
  const result = await runProbe(probe({ run: 'echo one > one.log', artifacts: ['one.log', 'shots/home.png'] }), { ...where, timeoutSeconds: 10 });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.details.missing_artifacts, ['shots/home.png']);
  assert.match(result.how_to_fix, /did not write the artifact shots\/home\.png/);
  // The artifact it did write is still kept, to help find the cause.
  assert.ok(existsSync(join(where.outDir, 'artifacts', 'one.log')));
});

test('an artifact path outside the worktree counts as missing', async (t) => {
  const where = setup(t);
  const result = await runProbe(probe({ run: 'echo x > ../outside.log', artifacts: ['../outside.log'] }), { ...where, timeoutSeconds: 10 });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.details.missing_artifacts, ['../outside.log']);
});

test('a folder artifact does not copy a symbolic link that leads outside the worktree', async (t) => {
  const where = setup(t);
  const secret = join(where.dir, 'secret.txt');
  writeFileSync(secret, 'TOP-SECRET\n');
  const run = `mkdir -p rep && echo fine > rep/ok.txt && ln -s '${secret}' rep/leak && ln -s ok.txt rep/same`;
  const result = await runProbe(probe({ run, artifacts: ['rep'] }), { ...where, timeoutSeconds: 10 });
  assert.equal(result.status, 'met');
  const copy = join(where.outDir, 'artifacts', 'rep');
  assert.equal(readFileSync(join(copy, 'ok.txt'), 'utf8'), 'fine\n');
  // A link to a file inside the worktree is copied as that file.
  assert.equal(readFileSync(join(copy, 'same'), 'utf8'), 'fine\n');
  assert.equal(existsSync(join(copy, 'leak')), false);
});

test('a probe that runs past the time limit is failed, and the gap says it timed out', async (t) => {
  const where = setup(t);
  const started = Date.now();
  const result = await runProbe(probe({ run: 'sleep 30' }), { ...where, timeoutSeconds: 0.5 });
  assert.ok(Date.now() - started < 10_000, 'it did not wait for the sleep');
  assert.equal(result.status, 'failed');
  assert.equal(result.details.timed_out, true);
  assert.match(result.how_to_fix, /timed out/);
});

test('a probe that times out leaves no process running', async (t) => {
  const where = setup(t);
  const pidFile = join(where.dir, 'child.pid');
  // The shell starts a child in the background and waits. Both must be gone after the time limit.
  const result = await runProbe(probe({ run: `sleep 30 & echo $! > '${pidFile}'; wait` }), { ...where, timeoutSeconds: 0.5 });
  assert.equal(result.details.timed_out, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.equal(await gone(pid), true, `process ${pid} is still running`);
});

test('a hidden probe keeps no output and no artifacts', async (t) => {
  const where = setup(t);
  const result = await runProbe(probe({ run: 'echo secret-$((40 + 2)); echo x > a.log; exit 1', artifacts: ['a.log'], hidden: true }), { ...where, timeoutSeconds: 10 });
  assert.equal(result.status, 'failed');
  assert.equal(existsSync(where.outDir), false);
  assert.equal('output' in result.details, false);
  assert.equal('artifacts' in result.details, false);
  // The command prints secret-42. That output is nowhere in the result.
  assert.doesNotMatch(JSON.stringify(result), /secret-42/);
  assert.match(result.how_to_fix, /hidden check/);
});

// True when no process has this pid, within 2 seconds. A killed process can take a moment to be
// reaped by its new parent.
async function gone(pid) {
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
