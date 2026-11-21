import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';

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
// `outDir` is the folder for this probe's files, and `outPath` is the same folder as the exhibit
// names it, such as .exhibit/probes/link-check. The command's output goes to output.log there,
// and each artifact that exists is copied there under its own path. A hidden probe (`hidden`) keeps
// nothing: its output goes nowhere and its artifacts are not copied, so the exhibit holds only its
// status (spec 9.7).
export async function runProbe({ name, run, artifacts = [], hidden = false }, { worktree, outDir, outPath, timeoutSeconds }) {
  if (!hidden) await mkdir(outDir, { recursive: true });
  const outcome = await runInGroup(run, { cwd: worktree, logFile: hidden ? null : join(outDir, 'output.log'), timeoutMs: timeoutSeconds * 1000 });

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
      // A folder artifact can hold symbolic links. Copy only the entries whose real path is inside
      // the worktree, so a link cannot bring a file from elsewhere on the machine.
      const filter = async (entry) => (await insideRoot(root, entry)) !== null;
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

// Why the probe failed, in words that follow "and", or null when it is met.
function failure(outcome, missing, timeoutSeconds) {
  if (outcome.timedOut) return `timed out: it ran past the time limit of ${timeoutSeconds} seconds, so Exhibit stopped it`;
  if (outcome.code === null) return `was stopped by the signal ${outcome.signal}`;
  if (outcome.code !== 0) return `exited with code ${outcome.code}`;
  if (missing.length > 0) return `exited 0, but did not write ${missing.length === 1 ? 'the artifact' : 'the artifacts'} ${missing.join(', ')}`;
  return null;
}

// The process groups that runInGroup has started and not yet killed. Each one is a function that
// kills its group.
const liveGroups = new Set();
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

// A group of its own does not get the SIGINT that Ctrl-C sends to Exhibit's group, so Exhibit
// kills every live group itself when it gets SIGINT or SIGTERM. Then it sends the signal to
// itself again with no listener left, so it ends by that signal, as it did before.
function onStopSignal(signal) {
  for (const kill of liveGroups) kill();
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
// Then it kills the whole group. When Exhibit gets SIGINT or SIGTERM, as from Ctrl-C, while the
// group runs, it kills the group and then ends by that signal. Gives back { code, signal, timedOut }. With `args`, `command` is
// a program that runs with those arguments, and no shell. `env` is the env of the command, and the
// env of Exhibit when it is left out. The output goes to `logFile`, or nowhere when it is null.
export async function runInGroup(command, { cwd, logFile, timeoutMs, env = process.env, args = null }) {
  const log = logFile === null ? null : await open(logFile, 'w');
  try {
    const output = log === null ? 'ignore' : log.fd;
    const options = { cwd, env, detached: true, stdio: ['ignore', output, output] };
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
  const inside = relative(root, real);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return real;
}
