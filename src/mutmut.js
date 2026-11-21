import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInGroup } from './probe.js';
import { ToolError } from './tool-error.js';

// The mutmut adapter (spec 9.5): it mutates the changed lines of Python files.
//
// mutmut runs in the project's own Python, because it runs the project's tests with pytest in its
// own process. Exhibit runs its driver, src/mutmut-driver.py, with that Python. The driver uses
// parts of mutmut that are not its public interface, so it needs this version exactly.
export const MUTMUT_VERSION = '3.8.1';
// The command that starts the project's Python when the policy does not set settings.mutation_python.
export const DEFAULT_MUTATION_PYTHON = 'python3';
export const PYTHON_FILE = /\.py$/;
const DRIVER = fileURLToPath(new URL('./mutmut-driver.py', import.meta.url));
// A folder with one of these files is a Python project. mutmut runs in it.
const PROJECT_FILES = ['pyproject.toml', 'setup.cfg', 'setup.py'];

// mutmut's status for each exit code (STATUS_BY_EXIT_CODE in mutmut/stats.py), given as the
// Stryker status that Exhibit counts the same way. mutmut kills a mutant's test run when it uses
// too much CPU time, and calls that a timeout. "no tests" means no test ran the mutant's
// function. A crash (mutmut's "segfault") and "caught by type check" make the mutant not valid,
// as Stryker's RuntimeError and CompileError do. Exit code 2 ("check was interrupted by user")
// and no exit code ("not checked") mean that mutmut did not finish testing the mutant.
const STATUS_BY_EXIT_CODE = new Map([
  [1, 'Killed'], [3, 'Killed'],
  [0, 'Survived'],
  [5, 'NoCoverage'], [33, 'NoCoverage'],
  [24, 'Timeout'], [-24, 'Timeout'], [36, 'Timeout'], [152, 'Timeout'], [255, 'Timeout'],
  [-9, 'RuntimeError'], [-11, 'RuntimeError'],
  [37, 'CompileError'],
  [34, 'Ignored']
]);
const NOT_TESTED = new Set([null, 2]);

// The status of a mutant that mutmut gave `exitCode`, or null when mutmut did not finish it.
// mutmut calls any other exit code "suspicious". Exhibit counts such a mutant as survived, so it
// errs toward needs_person.
export function mutmutStatus(exitCode) {
  if (NOT_TESTED.has(exitCode)) return null;
  return STATUS_BY_EXIT_CODE.get(exitCode) ?? 'Survived';
}

// The Python project of each changed file, in the head worktree `root`: the nearest folder above
// the file that has a pyproject.toml, setup.cfg or setup.py, or the repo's root when no folder has
// one. Gives a Map from the project's folder ('' for the root) to its files, with paths relative
// to the project, each with its changed lines.
export async function pythonProjects(root, files) {
  const projects = new Map();
  for (const { path, lines } of files) {
    let dir = posix.dirname(path);
    while (dir !== '.' && !(await hasProjectFile(join(root, dir)))) dir = posix.dirname(dir);
    const project = dir === '.' ? '' : dir;
    if (!projects.has(project)) projects.set(project, []);
    projects.get(project).push({ path: project === '' ? path : path.slice(project.length + 1), lines });
  }
  return projects;
}

async function hasProjectFile(dir) {
  for (const name of PROJECT_FILES) {
    try {
      await access(join(dir, name));
      return true;
    } catch {
      // Not there: try the next name.
    }
  }
  return false;
}

// Runs mutmut, through the driver, in the project folder `project` of the head worktree `root`, on
// the changed lines of `files` ([{ path, lines }], paths relative to the project). `python` is a
// shell command that starts the project's Python. mutmut runs half as many test processes as the
// machine has cores, as Stryker does.
//
// It stops the driver, with every process it started, when `budgetSeconds` runs out. mutmut writes
// each mutant's result to its .meta file as soon as it has it, so a stopped run still gives the
// mutants it finished. Gives back what readMutmutOutcome gives.
export async function runMutmutProcess({ root, project, files, python, budgetSeconds, logFile, env }) {
  const dir = await mkdtemp(join(tmpdir(), 'exhibit-mutmut-'));
  try {
    const request = join(dir, 'request.json');
    const out = join(dir, 'out.jsonl');
    await writeFile(out, '');
    await writeFile(request, JSON.stringify({
      files: Object.fromEntries(files.map(({ path, lines }) => [path, lines])),
      out,
      max_children: Math.max(1, Math.floor(availableParallelism() / 2))
    }));
    const cwd = join(root, project);
    // The paths go in through the environment, so the shell never has to quote them.
    const outcome = await runInGroup(`${python} "$EXHIBIT_MUTMUT_DRIVER" "$EXHIBIT_MUTMUT_REQUEST"`, {
      cwd,
      env: { ...env, EXHIBIT_MUTMUT_DRIVER: DRIVER, EXHIBIT_MUTMUT_REQUEST: request, PYTHONUNBUFFERED: '1' },
      logFile,
      timeoutMs: budgetSeconds * 1000
    });
    const metas = {};
    for (const { path } of files) metas[path] = await readFile(join(cwd, 'mutants', `${path}.meta`), 'utf8').catch(() => null);
    return readMutmutOutcome(await readFile(out, 'utf8'), metas, outcome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// What a mutmut run gave: the driver's JSON lines `text`, mutmut's .meta file of each changed file
// (`metas`, by path, null when there is none), and the `outcome` of the process
// ({ code, signal, timedOut }). Gives back { mutants, complete, timedOut, code, signal }, and also
// `error` when the driver could not run mutmut, or `leftOut` and `sourcePaths` when mutmut would
// not mutate some changed files. Each mutant has its file, line, column, mutator, original,
// replacement and status, and only the mutants that mutmut finished are there.
//
// The run is complete when the driver wrote its done line, the process exited 0 or the budget ran
// out after the done line, and mutmut finished every mutant. A kill can cut the last line of the
// driver, or a .meta file that mutmut was writing, short. Exhibit leaves those out. Any other bad
// line or file is a fault, and throws. So does a .meta file whose mutants are not the ones the
// driver listed: Exhibit would then name the wrong code for a mutant.
export function readMutmutOutcome(text, metas, outcome) {
  const texts = text.split('\n');
  const lines = texts.flatMap((line, i) => {
    if (line === '') return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      if (i === texts.length - 1 && outcome.timedOut) return [];
      throw new ToolError(`Exhibit's mutmut driver wrote a line that is not JSON: ${error.message}`);
    }
  });
  const done = lines.some((line) => line.done === true);
  const base = { timedOut: outcome.timedOut && !done, code: outcome.code, signal: outcome.signal };
  const error = lines.find((line) => typeof line.error === 'string');
  if (error) return { ...base, mutants: [], complete: false, error: error.error };
  const leftOut = lines.find((line) => Array.isArray(line.left_out));
  if (leftOut) return { ...base, mutants: [], complete: false, leftOut: leftOut.left_out, sourcePaths: leftOut.source_paths };
  const listed = lines.find((line) => Array.isArray(line.mutants))?.mutants ?? [];

  const exitCodes = new Map();
  for (const [path, metaText] of Object.entries(metas)) {
    if (metaText === null) continue;
    let meta;
    try {
      meta = JSON.parse(metaText);
    } catch (error) {
      if (outcome.timedOut) continue;
      throw new ToolError(`mutmut's file mutants/${path}.meta is not JSON: ${error.message}`);
    }
    const names = Object.keys(meta.exit_code_by_key ?? {}).sort();
    const expected = listed.filter((mutant) => mutant.file === path).map((mutant) => mutant.name).sort();
    if (names.join('\n') !== expected.join('\n')) {
      throw new ToolError(`mutmut made other mutants in ${path} than Exhibit's mutmut driver listed, so Exhibit cannot tell which code each one changed. mutmut has ${names.length}, the driver listed ${expected.length}. Report this as an Exhibit issue.`);
    }
    for (const name of names) exitCodes.set(name, meta.exit_code_by_key[name]);
  }
  const mutants = [];
  let untested = 0;
  for (const { name, file, line, column, mutator, original, replacement } of listed) {
    const status = mutmutStatus(exitCodes.get(name) ?? null);
    if (status === null) untested += 1;
    else mutants.push({ file, line, column, mutator, original, replacement, status });
  }
  return { ...base, mutants, complete: done && (outcome.code === 0 || outcome.timedOut) && untested === 0 };
}
