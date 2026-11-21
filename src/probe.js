import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';

// The time limit for one probe when the policy does not set settings.probe_timeout_seconds.
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 600;

// Runs one probe (spec 9.6) and gives back { status, details, how_to_fix }.
//
// The command runs with sh in `worktree`, the head worktree, in a process group of its own. When
// it runs past `timeoutSeconds`, Exhibit kills the whole group, so no process of the probe is
// left running. It kills the group after a normal exit too, so a server the probe started and
// left behind does not keep running.
//
// The probe is `met` when the command exits 0 and writes every declared artifact. Otherwise it is
// `failed`, and how_to_fix says why: the exit code, the artifacts that are missing, or the time
// limit.
//
// `env` is the env of the command, and the env of Exhibit when it is left out. It is the run's env,
// the same one the test command gets (spec 9.6), with one change: TMPDIR, TMP, TEMP and HOME all
// name a fresh, empty folder of this probe's own, which Exhibit removes after the probe. So a file
// that one probe writes to its temporary folder or its home folder does not reach a later probe,
// and a hidden probe's file cannot reach the exhibit through a later probe's artifacts or output.
//
// `outDir` is the folder for this probe's files, and `outPath` is the same folder as the exhibit
// names it, such as .exhibit/probes/link-check. The command's output goes to output.log there,
// and each artifact that exists is copied there under its own path. A hidden probe (`hidden`) keeps
// nothing: its output goes nowhere and its artifacts are not copied, so the exhibit holds only its
// status (spec 9.7).
export async function runProbe({ name, run, artifacts = [], hidden = false }, { worktree, outDir, outPath, timeoutSeconds, env = process.env }) {
  if (!hidden) await mkdir(outDir, { recursive: true });
  const own = await mkdtemp(join(tmpdir(), 'exhibit-probe-'));
  let outcome;
  try {
    const probeEnv = { ...env, TMPDIR: own, TMP: own, TEMP: own, HOME: own };
    outcome = await runInGroup(run, { cwd: worktree, env: probeEnv, logFile: hidden ? null : join(outDir, 'output.log'), timeoutMs: timeoutSeconds * 1000 });
  } finally {
    await removeAll(own);
  }

  const root = await realpath(worktree);
  const found = [];
  const missing = [];
  for (const path of artifacts) {
    const source = await artifactSource(root, path);
    if (source === null) missing.push(path);
    else found.push({ path, source });
  }
  const copied = [];
  if (!hidden) {
    for (const { path, source } of found) {
      const name = posix.normalize(path);
      const filter = (entry) => keepInCopy(root, source, entry);
      await cp(source, join(outDir, 'artifacts', name), { recursive: true, dereference: true, filter });
      copied.push({ path, copy: `${outPath}/artifacts/${name}` });
    }
  }

  const details = {
    exit_code: outcome.code,
    timed_out: outcome.timedOut,
    timeout_seconds: timeoutSeconds,
    ...(hidden ? {} : { output: `${outPath}/output.log`, artifacts: copied }),
    missing_artifacts: missing
  };
  const why = failure(outcome, missing, timeoutSeconds);
  if (why === null) return { status: 'met', details };
  const read = hidden
    ? 'It is a hidden check, so its output is not in the exhibit. Ask a maintainer to read it.'
    : `Read its output in ${outPath}/output.log.`;
  return { status: 'failed', details, how_to_fix: `The probe ${name} ran "${run}" in the head worktree and ${why}. ${read} Fix the change, and run exhibit check again.` };
}

// Removes `folder` and all it holds. A probe can leave a folder that it may not write to, as Go
// does with its module cache. Then rm fails with EACCES, so this gives each folder inside back
// its owner's rights and tries once more.
async function removeAll(folder) {
  try {
    await rm(folder, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
    await allowWrites(folder);
    await rm(folder, { recursive: true, force: true });
  }
}

// Gives `folder` and every folder under it read, write and search rights for its owner. It does
// not follow symbolic links.
async function allowWrites(folder) {
  await chmod(folder, 0o700);
  for (const entry of await readdir(folder)) {
    const path = join(folder, entry);
    if ((await lstat(path)).isDirectory()) await allowWrites(path);
  }
}

// Why the probe failed, in words that follow "and", or null when it is met.
function failure(outcome, missing, timeoutSeconds) {
  if (outcome.timedOut) return `timed out: it ran past the time limit of ${timeoutSeconds} seconds, so Exhibit stopped it`;
  if (outcome.code === null) return `was stopped by the signal ${outcome.signal}`;
  if (outcome.code !== 0) return `exited with code ${outcome.code}`;
  if (missing.length > 0) return `exited 0, but did not write ${missing.length === 1 ? 'the artifact' : 'the artifacts'} ${missing.join(', ')}`;
  return null;
}

// The process groups that runInGroup has started and not yet killed: probes, test runs,
// settings.mutation_setup and Stryker. Each one is a function that kills its group.
const liveGroups = new Set();
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
let stopping = false;

// Kills every process group that runInGroup started and that may still run, for a signal handler
// that stops Exhibit (spec 9.6). After it, runInGroup starts no new command, and a call that waits
// for a command never returns, so no probe goes on to read a worktree that is being removed. Call
// it only when Exhibit is about to exit.
export function stopAllGroups() {
  stopping = true;
  for (const kill of liveGroups) kill();
}

// True after stopAllGroups, so the caller can stop too, and write nothing for a stopped run.
export function stopped() {
  return stopping;
}

// A group of its own does not get the SIGINT that Ctrl-C sends to Exhibit's group, or the SIGHUP
// that a closing terminal sends. So Exhibit kills every live group itself when it gets SIGINT,
// SIGTERM or SIGHUP. Then it sends the signal to itself again with no listener left, so it ends
// by that signal, as it did before. exhibit check adds a listener of its own while the collectors
// run, which removes the head worktree and then exits (src/commands/check.js), so there the
// signal sent again changes nothing.
function onStopSignal(signal) {
  stopAllGroups();
  liveGroups.clear();
  for (const name of STOP_SIGNALS) process.removeListener(name, onStopSignal);
  process.kill(process.pid, signal);
}

function watchGroup(kill) {
  if (liveGroups.size === 0) for (const name of STOP_SIGNALS) process.on(name, onStopSignal);
  liveGroups.add(kill);
}

function unwatchGroup(kill) {
  if (!liveGroups.delete(kill) || liveGroups.size > 0) return;
  for (const name of STOP_SIGNALS) process.removeListener(name, onStopSignal);
}

// Runs `command` with sh in a new process group, and waits until it exits or the time runs out.
// Then it kills the whole group. When Exhibit gets SIGINT, SIGTERM or SIGHUP while the group
// runs, as from Ctrl-C or a closing terminal, it kills the group and then ends by that signal.
// Gives back { code, signal, timedOut }. With `args`, `command` is a program that runs with those
// arguments, and no shell. `env` is the env of the command, and the env of Exhibit when it is
// left out. The output goes to `logFile`, or nowhere when it is null.
//
// It drops NODE_TEST_CONTEXT from the env. node:test sets it when Exhibit itself runs under
// node:test. With it, a node:test run in the command sends its results to that parent run and
// writes no JUnit file. Probes, test runs and mutation runs all start here, so all get the same
// env.
export async function runInGroup(command, { cwd, logFile, timeoutMs, env = process.env, args = null }) {
  if (stopping) return new Promise(() => {});
  const log = logFile === null ? null : await open(logFile, 'w');
  try {
    // The stop can come while the log file opens. Check again, so no command starts after it.
    if (stopping) return await new Promise(() => {});
    const output = log === null ? 'ignore' : log.fd;
    const clean = { ...env };
    delete clean.NODE_TEST_CONTEXT;
    const options = { cwd, env: clean, detached: true, stdio: ['ignore', output, output] };
    const child = args === null ? spawn(command, { ...options, shell: '/bin/sh' }) : spawn(command, args, options);
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        // ESRCH: the group has no process left. EPERM: on macOS, the group holds only zombies that
        // the system has not yet cleaned up, so no live process is left either.
        if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
      }
    };
    if (child.pid !== undefined) watchGroup(killGroup);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    try {
      const { code, signal } = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      if (stopping) await new Promise(() => {});
      return { code, signal, timedOut };
    } finally {
      clearTimeout(timer);
      unwatchGroup(killGroup);
      if (child.pid !== undefined) killGroup();
    }
  } finally {
    await log?.close();
  }
}

// The real path of an artifact when it exists inside the worktree, or null. A path that leaves
// the worktree, by "..", an absolute path or a symbolic link, counts as missing, so a probe cannot
// copy a file from elsewhere on the machine into the exhibit.
// `root` is the real path of the worktree.
async function artifactSource(root, path) {
  if (isAbsolute(path)) return null;
  const real = await insideRoot(root, join(root, path));
  return real === root ? null : real;
}

// Whether the copy of a folder artifact keeps `entry`, a path that cp reached under `source`, the
// artifact's real path. A folder artifact can hold symbolic links, and cp follows them. So it keeps
// only an entry whose real path is inside the worktree, so a link cannot bring a file from
// elsewhere on the machine. And it leaves out an entry whose real path is a folder that holds the
// entry, such as rep/up -> .. or a link to the worktree root, because cp would copy that folder
// into itself until it fails with ELOOP. An entry that cannot be read, or a link that leads nowhere,
// is left out too.
async function keepInCopy(root, source, entry) {
  const real = await insideRoot(root, entry);
  if (real === null) return false;
  if (entry === source) return true;
  for (let folder = dirname(entry); ; folder = dirname(folder)) {
    if (holds(real, await realpath(folder))) return false;
    if (folder === source || folder === dirname(folder)) return true;
  }
}

// Whether `folder` is `path` or a folder above it. Both are real paths.
function holds(folder, path) {
  const inside = relative(folder, path);
  return !(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside));
}

// The real path of `path` when it exists, can be read, and is inside `root` or is `root`. Otherwise
// null.
async function insideRoot(root, path) {
  let real;
  try {
    real = await realpath(path);
    await access(real, constants.R_OK);
  } catch {
    return null;
  }
  return holds(root, real) ? real : null;
}
