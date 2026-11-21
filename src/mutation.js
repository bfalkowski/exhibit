import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { matchesGlob } from './classify.js';
import { isTestPath } from './failing-before.js';
import { clopperPearson } from './interval.js';
import { DEFAULT_PROBE_TIMEOUT_SECONDS, runInGroup } from './probe.js';
import { ToolError } from './tool-error.js';
import { worktreeOnDemand } from './worktree.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// The time budget of one mutation run when the policy does not set settings.mutation_budget_seconds.
export const DEFAULT_MUTATION_BUDGET_SECONDS = 600;
// The folder for the mutation run's logs, beside evidence.json.
export const MUTATION_DIR = '.exhibit/mutation';
const LISTED = 20;
// The files the Stryker adapter mutates: JavaScript and TypeScript.
const STRYKER_FILE = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;
// Code in a language that no adapter covers yet. A change to such a file cannot be checked, so the
// requirement is skipped, never met. Other files, such as docs and config, hold no code to mutate.
const NO_ADAPTER = /\.(py|go|rb|java|kt|scala|rs|cs|php|swift|c|cc|cpp|h|hpp)$/;
const STRYKER_BIN = join(dirname(require.resolve('@stryker-mutator/core/package.json')), 'bin', 'stryker.js');
const TAP_RUNNER = fileURLToPath(import.meta.resolve('@stryker-mutator/tap-runner'));
const REPORTER = fileURLToPath(new URL('./stryker-reporter.js', import.meta.url));

// The statuses that Stryker gives a mutant, and how Exhibit counts each one (spec 9.5). A timeout
// counts as killed. A mutant that no test reaches counts as survived, and is listed apart. A
// mutant that does not compile or breaks the code at load is not a valid mutant, so it does not
// count. Neither does one that Stryker ignored.
const COUNTED = { Killed: 'killed', Timeout: 'timeout', Survived: 'survived', NoCoverage: 'no_coverage', CompileError: 'not_valid', RuntimeError: 'not_valid', Ignored: 'ignored' };

// The mutation collector (spec 8.1 and 9.5). It runs Stryker on the lines that the change added or
// changed, on the head commit, and gives the catch rate: killed mutants divided by killed plus
// survived ones.
//
// One run serves every mutation requirement of a check, because only `min` differs between them.
export function mutationCollector({ runStryker = runStrykerProcess } = {}) {
  const runs = new WeakMap();
  return async (requirement, context) => {
    if (!runs.has(context)) runs.set(context, mutationRun(context, { runStryker }));
    return judge(await runs.get(context), requirement.params.min);
  };
}

// Does the run for one check, and gives back either `{ fixed }`, a result that does not depend on
// `min`, or what judge needs: `{ mutants, complete, budgetSeconds, mutated, testFiles, testSelection }`.
//
// 1. The changed lines are the lines of the head that `git diff` shows as added, from the merge
//    base of base and head. A test file is never mutated: one that isTestPath names, or that
//    settings.mutation_test_files matches.
// 2. A changed code file in a language that no adapter covers makes the requirement skipped.
//    With no changed JavaScript or TypeScript line, it is met: there is nothing to mutate.
// 3. In a clean worktree of the head, it runs settings.mutation_setup, such as `npm ci`.
// 4. It picks the test files that reach a changed file (testsThatReach), and runs Stryker with
//    only those, and with per-test coverage, so each mutant runs only the test files that ran its
//    line. When no test file reaches the changed files, it gives Stryker every test file.
// 5. Stryker stops when settings.mutation_budget_seconds runs out.
async function mutationRun({ cwd, base, head, settings, env }, { runStryker }) {
  const testGlobs = settings.mutation_test_files ?? [];
  const isTest = (path) => isTestPath(path) || testGlobs.some((glob) => matchesGlob(path, glob));
  const mutated = [];
  const noAdapter = [];
  for (const [path, ranges] of await changedLines(cwd, base, head)) {
    if (isTest(path)) continue;
    if (STRYKER_FILE.test(path)) mutated.push({ path, lines: ranges });
    else if (NO_ADAPTER.test(path)) noAdapter.push(path);
  }
  if (noAdapter.length > 0) {
    return fixed('skipped', { reason: `Exhibit has a mutation adapter only for JavaScript and TypeScript, and this change has code in ${noAdapter.join(', ')}.`, no_adapter: noAdapter },
      `Exhibit cannot mutate ${noAdapter.join(', ')}: it has a mutation adapter only for JavaScript and TypeScript (Stryker). The mutmut adapter for Python comes later. Until then a person must judge how strong the tests are.`);
  }
  if (mutated.length === 0) {
    return fixed('met', { reason: 'The change has no added or changed lines of JavaScript or TypeScript outside the tests, so there is nothing to mutate.', ...counts([]), mutated: [] });
  }
  if (testGlobs.length === 0) {
    return fixed('missing', { reason: 'The policy has no settings.mutation_test_files.', mutated },
      'The policy needs mutation evidence, but evidence.yml does not say where the tests are. Set settings.mutation_test_files to globs of the test files, such as ["test/**/*.test.js"], and settings.mutation_setup to the command that installs what they need, such as "npm ci".');
  }

  const budgetSeconds = settings.mutation_budget_seconds ?? DEFAULT_MUTATION_BUDGET_SECONDS;
  const outDir = join(cwd, MUTATION_DIR);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const worktree = worktreeOnDemand(cwd, head);
  try {
    const root = await worktree.fresh();
    if (settings.mutation_setup) {
      const timeoutSeconds = settings.probe_timeout_seconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;
      const setup = await runInGroup(settings.mutation_setup, { cwd: root, env, logFile: join(outDir, 'setup.log'), timeoutMs: timeoutSeconds * 1000 });
      if (setup.timedOut || setup.code !== 0) {
        const why = setup.timedOut ? `ran past the time limit of ${timeoutSeconds} seconds (settings.probe_timeout_seconds)` : setup.code === null ? `was stopped by the signal ${setup.signal}` : `exited with code ${setup.code}`;
        return fixed('error', { reason: `settings.mutation_setup ${why}.`, setup_log: `${MUTATION_DIR}/setup.log`, mutated },
          `Exhibit ran settings.mutation_setup ("${settings.mutation_setup}") in the head worktree, and it ${why}, so Stryker could not run. Read ${MUTATION_DIR}/setup.log, fix the command or the change, and run exhibit check again.`);
      }
    }
    const allTests = (await gitLines(root, ['ls-files', '-z'])).filter((path) => testGlobs.some((glob) => matchesGlob(path, glob))).sort();
    if (allTests.length === 0) {
      return fixed('missing', { reason: 'No file in the head matches settings.mutation_test_files.', mutated },
        `No file in the head commit matches settings.mutation_test_files (${testGlobs.join(', ')}), so no test can kill a mutant. Fix the globs in evidence.yml, or add tests.`);
    }
    const reaching = await testsThatReach(root, allTests, mutated.map((file) => file.path));
    const testFiles = reaching.length > 0 ? reaching : allTests;
    const outcome = await runStryker({
      root,
      mutate: mutated.flatMap(({ path, lines }) => lines.map(([from, to]) => `${path}:${from}-${to}`)),
      testFiles,
      budgetSeconds,
      logFile: join(outDir, 'output.log'),
      env
    });
    const output = `${MUTATION_DIR}/output.log`;
    if (!outcome.complete && !outcome.timedOut) {
      const why = outcome.code === null ? `was stopped by the signal ${outcome.signal}` : `exited with code ${outcome.code}`;
      return fixed('error', { reason: `Stryker ${why} before it finished.`, output, mutated, test_files: testFiles },
        `Stryker ${why} before it had tested every mutant, so Exhibit has no catch rate. A failing test on the head stops it, and so does a broken setup. Read ${output}, fix the cause, and run exhibit check again.`);
    }
    return {
      mutants: await describeMutants(root, outcome.mutants),
      complete: outcome.complete,
      budgetSeconds,
      mutated,
      testFiles,
      testSelection: reaching.length > 0 ? 'reach' : 'all',
      output
    };
  } finally {
    await worktree.remove();
  }
}

function fixed(status, details, howToFix) {
  return { fixed: { status, details, ...(howToFix ? { how_to_fix: howToFix } : {}) } };
}

// The requirement's result for a run and the policy's `min`.
//
// After a complete run, the catch rate is the rate of every mutant on the changed lines, so it is
// met when the catch rate reaches min. After a partial run, the mutants are a sample, so it is met
// only when the lower bound of the 95% interval reaches min. It is failed when the upper bound is
// below min too, and missing when the interval holds min: the sample is too small to tell.
//
// Stryker tests the mutants file by file, in the order of the code, so a partial sample comes
// from the first changed lines more than from the last. The interval holds only as well as those
// mutants stand for the rest.
export function judge(runResult, min) {
  if (runResult.fixed) return runResult.fixed;
  const { mutants, complete, budgetSeconds } = runResult;
  const tally = counts(mutants);
  const details = {
    ...tally,
    complete,
    budget_seconds: budgetSeconds,
    mutated: runResult.mutated,
    test_files: runResult.testFiles,
    test_selection: runResult.testSelection,
    output: runResult.output,
    survivors: listed(mutants, 'Survived'),
    no_coverage_mutants: listed(mutants, 'NoCoverage'),
    timeout_mutants: listed(mutants, 'Timeout')
  };
  const { n, killed, timeout } = tally;
  const partial = complete ? '' : ` The budget of ${budgetSeconds} seconds ran out after ${n} mutants, so they are a sample.`;
  if (n === 0) {
    if (complete) return { status: 'met', details: { ...details, reason: 'Stryker made no mutant on the changed lines.' } };
    return { status: 'missing', details, how_to_fix: `The budget of ${budgetSeconds} seconds (settings.mutation_budget_seconds) ran out before Stryker had tested one mutant, so Exhibit has no catch rate. Raise the budget, or make the tests that reach the changed files faster, and run exhibit check again.` };
  }
  const rate = (killed + timeout) / n;
  const { low, high } = clopperPearson(killed + timeout, n);
  const shown = `${n - killed - timeout} of ${n} mutants on the changed lines survived, so the catch rate is ${fixedRate(rate)}, with the 95% interval ${fixedRate(low)} to ${fixedRate(high)}.${partial}`;
  const survivorsHelp = 'For each surviving mutant listed in summary.md, add a test that fails on the mutant and passes on the code. A survivor that cannot change what the code does (an equivalent mutant) needs a person to judge it.';
  if (complete ? rate >= min : low >= min) return { status: 'met', details };
  if (complete || high < min) {
    return { status: 'failed', details, how_to_fix: `${shown} The policy's min is ${min}. ${survivorsHelp}` };
  }
  return { status: 'missing', details, how_to_fix: `${shown} The policy's min is ${min}, and the interval holds it, so the sample is too small to tell. Raise settings.mutation_budget_seconds so that Stryker tests more mutants, or make the tests that reach the changed files faster. ${survivorsHelp}` };
}

// The counts of a set of mutants, with the catch rate and its 95% interval, rounded to 4 places.
// The interval rounds outward, so it never looks narrower than it is.
function counts(mutants) {
  const tally = { killed: 0, timeout: 0, survived: 0, no_coverage: 0, not_valid: 0, ignored: 0 };
  for (const mutant of mutants) tally[COUNTED[mutant.status] ?? 'not_valid'] += 1;
  const n = tally.killed + tally.timeout + tally.survived + tally.no_coverage;
  if (n === 0) return { ...tally, n, catch_rate: null, interval_95: null };
  const { low, high } = clopperPearson(tally.killed + tally.timeout, n);
  return { ...tally, n, catch_rate: Math.round(((tally.killed + tally.timeout) / n) * 1e4) / 1e4, interval_95: [Math.floor(low * 1e4) / 1e4, Math.ceil(high * 1e4) / 1e4] };
}

function fixedRate(value) {
  return value.toFixed(2);
}

// The mutants with one status, as { file, line, mutator, original, replacement }, sorted.
function listed(mutants, status) {
  return mutants
    .filter((mutant) => mutant.status === status)
    .map(({ file, line, column, mutator, original, replacement }) => ({ file, line, column, mutator, original, replacement }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.mutator.localeCompare(b.mutator) || a.replacement.localeCompare(b.replacement));
}

// Gives each mutant from Stryker its path relative to the repo, its line and column, and the code
// it replaced, read from the head worktree. Long code is cut short, and runs of white space become
// one space, so each mutant fits on one line of summary.md.
async function describeMutants(root, mutants) {
  const roots = [root, await realpath(root)];
  const texts = new Map();
  const described = [];
  for (const mutant of mutants) {
    const file = toRepoPath(roots, mutant.fileName);
    if (!texts.has(file)) texts.set(file, await readFile(join(root, file), 'utf8').then((text) => text.split('\n'), () => []));
    const lines = texts.get(file);
    const { start, end } = mutant.location;
    // Stryker's lines and columns start at 1, and the end column is just past the code.
    const original = lines.slice(start.line - 1, end.line).map((text, i, all) => text.slice(i === 0 ? start.column - 1 : 0, i === all.length - 1 ? end.column - 1 : undefined)).join('\n');
    described.push({ file, line: start.line, column: start.column, mutator: mutant.mutatorName, original: oneLine(original), replacement: oneLine(mutant.replacement), status: mutant.status });
  }
  return described;
}

function toRepoPath(roots, fileName) {
  for (const root of roots) {
    const inside = relative(root, fileName);
    if (!inside.startsWith('..') && !isAbsolute(inside)) return inside.split(sep).join('/');
  }
  return fileName;
}

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// The lines that the change added or changed, for each file of the head: a Map from the path to a
// list of [first, last] line ranges, from `git diff -U0` between the merge base and the head. A
// file that the change deleted has no lines on the head, so it is not in the Map. The prefixes
// are set, so a user's diff.noprefix cannot change what git prints.
export async function changedLines(cwd, base, head) {
  const diff = await gitText(cwd, ['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `${base}...${head}`]);
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = target === '/dev/null' ? null : unquote(target).replace(/^b\//, '');
      continue;
    }
    const hunk = current !== null && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const from = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    if (!files.has(current)) files.set(current, []);
    files.get(current).push([from, from + count - 1]);
  }
  return files;
}

// git quotes a path with unusual characters, such as "b/a\tb.js", in C style.
function unquote(path) {
  if (!path.startsWith('"')) return path;
  const bytes = [];
  const text = path.slice(1, -1);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\') {
      bytes.push(...Buffer.from(text[i]));
      continue;
    }
    const next = text[i + 1];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The test files, of `tests`, that reach one of the `targets`: the test file loads a target through
// a chain of relative `import` or `require` calls, or a file in that chain names a target's file
// name in a string, as a test does that starts a server with `node relay/server.js`. A test that
// reaches no changed file cannot kill a mutant there, so Stryker does not run it, and its first
// run with every test file stays short. Paths are relative to `root`.
export async function testsThatReach(root, tests, targets) {
  const wanted = new Set(targets);
  const names = [...new Set(targets.map((path) => posix.basename(path)))];
  const memo = new Map();
  const reaches = async (path, seen) => {
    if (wanted.has(path)) return true;
    if (memo.has(path)) return memo.get(path);
    if (seen.has(path)) return false;
    seen.add(path);
    let text;
    try {
      text = await readFile(join(root, path), 'utf8');
    } catch {
      memo.set(path, false);
      return false;
    }
    let found = names.some((name) => ['\'', '"', '`'].some((quote) => text.includes(`${name}${quote}`)));
    for (const next of found ? [] : await relativeImports(root, path, text)) {
      if (await reaches(next, seen)) {
        found = true;
        break;
      }
    }
    memo.set(path, found);
    return found;
  };
  const result = [];
  for (const test of tests) if (await reaches(test, new Set())) result.push(test);
  return result;
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '/index.js', '/index.ts'];

// The files that `path` loads with a relative import or require, as paths relative to `root`.
async function relativeImports(root, path, text) {
  const found = [];
  for (const match of text.matchAll(IMPORT)) {
    const target = posix.normalize(posix.join(posix.dirname(path), match[2]));
    if (target.startsWith('..')) continue;
    for (const extension of EXTENSIONS) {
      const candidate = target + extension;
      if (STRYKER_FILE.test(candidate) && (await isFile(join(root, candidate)))) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

async function isFile(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// Runs Stryker in `root` on the `mutate` ranges, such as "src/a.js:3-5", with the tap test runner
// on `testFiles`, and per-test coverage. The tap runner runs each test file with node in a process
// of its own, and per-test coverage records which test files ran each mutant's code, so a mutant
// runs only those files. A test file counts as one test.
//
// It stops Stryker, with every process it started, when `budgetSeconds` runs out. Exhibit's
// reporter writes each mutant to a file as soon as it is done, so a stopped run still gives the
// mutants it finished. Gives back { mutants, complete, timedOut, code, signal }. `complete` is
// true when Stryker exited 0 and wrote its done line.
async function runStrykerProcess({ root, mutate, testFiles, budgetSeconds, logFile, env }) {
  const dir = await mkdtemp(join(tmpdir(), 'exhibit-stryker-'));
  try {
    const resultsFile = join(dir, 'mutants.jsonl');
    const configFile = join(dir, 'stryker.config.json');
    await writeFile(resultsFile, '');
    await writeFile(configFile, JSON.stringify({
      testRunner: 'tap',
      tap: { testFiles },
      coverageAnalysis: 'perTest',
      mutate,
      reporters: ['exhibit'],
      plugins: [TAP_RUNNER, REPORTER],
      tempDirName: '.stryker-tmp',
      cleanTempDir: 'always',
      incremental: false,
      // Exhibit runs no type checker. Stryker's default adds a "@ts-nocheck" line to test and source
      // files in its sandbox, and the file it writes then loses its execute bit, so a test that runs
      // a script of the repo directly, as Building58's fake gh does, fails.
      disableTypeChecks: false,
      // A timeout counts as killed, so a test that is only slow must not count as one. On a busy
      // machine, Stryker's defaults (1.5 times the normal time, plus 5 seconds, with a test process
      // on each core but one) made mutants that change nothing time out. Half the cores, and 2.5
      // times the normal time plus 15 seconds, leave room for a busy machine. A real endless
      // loop still ends as a timeout, only later.
      concurrency: '50%',
      timeoutFactor: 2.5,
      timeoutMS: 15000,
      fileLogLevel: 'off',
      allowConsoleColors: false
    }, null, 2));
    const outcome = await runInGroup(process.execPath, {
      args: [STRYKER_BIN, 'run', configFile],
      cwd: root,
      env: { ...env, EXHIBIT_MUTANTS_FILE: resultsFile, FORCE_COLOR: '0' },
      logFile,
      timeoutMs: budgetSeconds * 1000
    });
    // A kill can stop the reporter in the middle of its last line, so a last line that is cut
    // short is left out. Any other bad line is a fault, and throws.
    const texts = (await readFile(resultsFile, 'utf8')).split('\n');
    const lines = texts.flatMap((line, i) => {
      if (line === '') return [];
      try {
        return [JSON.parse(line)];
      } catch (error) {
        if (i === texts.length - 1 && outcome.timedOut) return [];
        throw new ToolError(`Exhibit's Stryker reporter wrote a line that is not JSON: ${error.message}`);
      }
    });
    const done = lines.some((line) => line.done === true);
    return {
      mutants: lines.filter((line) => line.done !== true),
      complete: done && outcome.code === 0,
      timedOut: outcome.timedOut && !done,
      code: outcome.code,
      signal: outcome.signal
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function gitText(cwd, args) {
  try {
    const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0] || error.message;
    throw new ToolError(`git ${args[0]} failed: ${reason}`);
  }
}

async function gitLines(cwd, args) {
  return (await gitText(cwd, args)).split('\0').filter((path) => path !== '');
}

// The words for a mutation requirement's line in summary.md: the catch rate with its n and
// interval, and each surviving mutant with its file, line and change. Mutants that no test reached
// are listed apart.
export function describeMutation(details) {
  if (typeof details.reason === 'string' && details.n === undefined) return ` ${details.reason}`;
  if (details.n === undefined) return '';
  const parts = [];
  if (details.n === 0) parts.push(` ${details.reason ?? 'No mutant was tested.'}`);
  else {
    const kept = details.killed + details.timeout;
    parts.push(` Catch rate ${details.catch_rate} (${kept} of ${details.n} mutants killed, ${details.timeout} of them by a timeout; 95% interval ${details.interval_95[0]} to ${details.interval_95[1]}).`);
  }
  if (details.complete === false) parts.push(` The budget of ${details.budget_seconds} seconds ran out, so this is a sample.`);
  if (details.not_valid > 0) parts.push(` ${details.not_valid} mutants did not compile or broke the code at load, so they do not count.`);
  const lines = [parts.join('')];
  const show = (title, mutants) => {
    if (!mutants?.length) return;
    lines.push(`  - ${title}:`);
    for (const mutant of mutants.slice(0, LISTED)) {
      lines.push(`    - ${mutant.file}:${mutant.line} ${mutant.mutator}: \`${mutant.original}\` became \`${mutant.replacement}\``);
    }
    if (mutants.length > LISTED) lines.push(`    - and ${mutants.length - LISTED} more, listed in evidence.json.`);
  };
  show('Survived, though a test ran the line', details.survivors);
  show('Survived, because no test ran the line', details.no_coverage_mutants);
  show('Killed by a timeout, so check that the mutant really makes the tests hang', details.timeout_mutants);
  return lines.join('\n');
}

export const mutation = mutationCollector();
