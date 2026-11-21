import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { buildExhibit, COLLECTORS, exitCode, renderErrorSummary, renderSummary } from '../check.js';
import { MUTATION_DIR } from '../mutation.js';
import { TESTS_DIR } from '../test-runs.js';
import { checkExhibit } from '../exhibit-schema.js';
import { classifyWithTracker } from '../fix-signals.js';
import { GITHUB_FORGE } from '../github.js';
import { connectTracker } from '../jira.js';
import { DEFAULT_POLICY, missingPolicy, parsePolicy, policyPath } from '../policy.js';
import { DEFAULT_PROBE_TIMEOUT_SECONDS, runProbe, stopAllGroups, stopped } from '../probe.js';
import { readSkip, SKIP_LABEL, skipApplies } from '../skip.js';
import { describeError, ToolError } from '../tool-error.js';
import { worktreeOnDemand } from '../worktree.js';

const run = promisify(execFile);
const OUTPUT = { evidence: '.exhibit/evidence.json', summary: '.exhibit/summary.md' };
// The folder for each probe's output and artifacts (spec 9.6).
const PROBES = '.exhibit/probes';
const USAGE = 'Usage: exhibit check --base REF [--head REF] [--repo owner/name] [--policy FILE] [--shadow] [--json], or exhibit check --pr N --repo owner/name [--policy FILE] [--shadow] [--json]';

// `exhibit check --base REF [--head REF]`, or `exhibit check --pr N --repo owner/name`
// Classifies the change from base to head, works out what the policy needs, collects the evidence,
// and writes .exhibit/evidence.json and .exhibit/summary.md (spec 7, 8.2 and 9.8).
// It returns the exit code: 0 for meets_policy, 1 for needs_person, 2 for error, and 0 for
// needs_person with a skip.
//
// The changed paths come from git, from the merge base of base and head to head, so both commits
// must be in the clone. With --pr, the forge gives the base, the head, and the PR's title, body,
// labels and branch for the fix signals. Without it, only the local branch name is known.
// With --pr and tracker:jira in the fix signals, it asks Jira whether the PR's ticket is a bug
// (spec 9.1), with the token in JIRA_API_TOKEN. With no token, or when Jira could not answer for
// that ticket, the signal does not match, and summary.md says why in one line. A refused token
// or a rate limit stops the run with the verdict error.
//
// The policy comes from the base commit, not from the files on disk (spec 8.1). --policy FILE
// reads it from that path in the repo, in place of evidence.yml.
//
// It removes the old evidence.json, summary.md, probe files, test logs and mutation logs first. So when the run fails before
// it can write them, no old file is left to be read as this run's verdict. Any failure that is not
// a verdict then writes a summary.md that says the verdict is error and why, and throws. The CLI
// prints it and exits 2.
//
// With --pr, a PR can carry a skip (src/skip.js): the label exhibit-skip and a line in its body
// that gives the reason. The exhibit records it, with who added the label, and the verdict stays
// the same. Without --shadow, a skip on needs_person gives exit code 0 (spec 9.8).
//
// --shadow is shadow mode (spec 10): the run is the same, and the files say the same verdict, but
// the exit code is 0 for every verdict, error too. A failure that is not a verdict is printed here
// and gives 0 as well. So a CI step in shadow mode never fails on Exhibit, and summary.md shows
// what went wrong.
export async function check(argv, { env, cwd, fetch, stdout, stderr = process.stderr, collectors }) {
  // Remove the old files before anything can fail, a bad argument too.
  await Promise.all([...Object.values(OUTPUT), PROBES, TESTS_DIR, MUTATION_DIR].map((file) => rm(join(cwd, file), { recursive: true, force: true })));
  // Read before the other arguments, so a bad argument in shadow mode gives 0 too.
  const shadow = argv.includes('--shadow');
  try {
    return await runCheck(argv, { env, cwd, fetch, stdout, collectors, shadow });
  } catch (error) {
    // A stop came (spec 9.6). The signal handler ends the run, so write no summary for it.
    if (stopped()) return waitForever();
    const message = describeError(error);
    await mkdir(join(cwd, '.exhibit'), { recursive: true })
      .then(() => writeFile(join(cwd, OUTPUT.summary), renderErrorSummary(message, { shadow })))
      // The error that stopped the run says more than one about the summary, so it wins.
      .catch(() => {});
    if (!shadow) throw error;
    stderr.write(`exhibit: ${message}\nexhibit: verdict: error\nexhibit: shadow mode, so the exit code is 0. ${OUTPUT.summary} says why.\n`);
    return 0;
  }
}

async function runCheck(argv, { env, cwd, fetch, stdout, collectors, shadow }) {
  // GitHub is the only forge today, so the command picks its module first and asks it the rest.
  const forgeModule = GITHUB_FORGE;
  const options = parseOptions(argv, forgeModule);

  let refs;
  if (options.pr !== null) {
    const token = env[forgeModule.tokenEnv];
    if (!token) throw new ToolError(`${forgeModule.tokenEnv} is not set. --pr reads the PR from ${forgeModule.displayName}, so set it to a token that can read the repo, for example ${forgeModule.tokenExample}.`);
    const forge = forgeModule.connect({ repo: options.repo, token, fetch });
    const pull = await forge.pull(options.pr);
    const prNumber = options.pr;
    refs = {
      base: pull.baseSha,
      head: pull.headSha,
      pr: { number: options.pr, title: pull.title ?? '', body: pull.body, labels: pull.labels, branch: pull.headRef ?? '', repo: options.repo },
      signalsFrom: 'pr',
      hint: `Fetch it first, for example with git fetch origin pull/${options.pr}/head ${pull.baseRef ?? ''}`.trimEnd() + '.',
      labelAddedBy: () => forge.labelAddedBy(prNumber, SKIP_LABEL)
    };
  } else {
    refs = { base: options.base, head: options.head, pr: { number: null, title: '', labels: [], branch: await localBranch(cwd, options) }, signalsFrom: 'branch', hint: 'Check the name, or fetch it first.' };
  }

  const base = await commitSha(cwd, refs.base, refs.hint);
  const head = await commitSha(cwd, refs.head, refs.hint);
  // Only a PR can carry a skip: without --pr, Exhibit knows no labels and no body.
  const skip = refs.labelAddedBy ? await readSkip(refs.pr, { head, labelAddedBy: refs.labelAddedBy }) : null;
  const { policy, policyFile } = await policyAtBase(cwd, { base, head }, options.policy, options.policyGiven);
  const files = (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`])).split('\0').filter((path) => path !== '');
  // The new files, for the feature rule (spec 9.1). Here git looks for renames, so a file that
  // only moves is not a new file.
  const added = (await git(cwd, ['diff', '--name-only', '--find-renames', '--diff-filter=A', '-z', `${base}...${head}`])).split('\0').filter((path) => path !== '');
  // Only with --pr: without it, the title is unknown, and the branch alone is no PR (spec 9.1).
  const notes = [];
  let fixed;
  if (options.pr !== null) {
    const { tracker, note } = connectTracker(policy.settings, { env, fetch });
    if (note) notes.push(note);
    const { classification, problem } = await classifyWithTracker(refs.pr, policy.settings.fix_signals, tracker);
    if (problem) notes.push(problem);
    fixed = classification;
  }

  // The head worktree for probes is made only when a probe asks for it, and removed at the end.
  const headWorktree = worktreeOnDemand(cwd, head);
  const stopOnSignal = onStopSignal(() => headWorktree.remove());
  let exhibit;
  try {
    const timeoutSeconds = policy.settings.probe_timeout_seconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;
    const all = collectors ?? { ...COLLECTORS, probe: probeCollector({ cwd, headWorktree, timeoutSeconds }) };
    exhibit = await buildExhibit({ cwd, env, policy, policyFile, files, added, pr: refs.pr, fixed, signalsFrom: refs.signalsFrom, repo: options.repo, prNumber: options.pr, base, head, skip }, { collectors: all });
  } finally {
    stopOnSignal.off();
    await headWorktree.remove();
  }
  // A stop can come after the last probe has ended, while the other collectors still finish. The
  // signal handler then removes the head worktree and exits, so this run writes nothing (spec 9.6).
  if (stopped()) return waitForever();
  const problems = checkExhibit(exhibit);
  if (problems.length > 0) throw new ToolError(`the exhibit does not fit its schema, so ${OUTPUT.evidence} was not written:\n  ${problems.join('\n  ')}\nReport this as an Exhibit issue.`);

  await writeTogether(cwd, [
    [OUTPUT.evidence, JSON.stringify(exhibit, null, 2) + '\n'],
    [OUTPUT.summary, renderSummary(exhibit, { shadow, notes })]
  ]);

  const code = exitCode(exhibit, { shadow });
  if (options.json) {
    stdout.write(JSON.stringify({ verdict: exhibit.verdict, exit_code: code, gaps: exhibit.gaps.length, evidence: OUTPUT.evidence, summary: OUTPUT.summary }) + '\n');
  } else {
    const gaps = exhibit.gaps.length === 0 ? 'No gaps.' : `${exhibit.gaps.length} ${exhibit.gaps.length === 1 ? 'gap' : 'gaps'}, listed with how to fix ${exhibit.gaps.length === 1 ? 'it' : 'them'} in ${OUTPUT.summary}.`;
    stdout.write(`Verdict: ${exhibit.verdict}. ${gaps}\nWrote ${OUTPUT.evidence} and ${OUTPUT.summary}.\n`);
    if (shadow) stdout.write('Shadow mode: nothing waits on this verdict, so the exit code is 0.\n');
    else if (skipApplies(exhibit)) stdout.write(`The PR carries a skip, so the exit code is 0. Reason: ${exhibit.skip.reason}\n`);
  }
  return code;
}

// While the collectors run, a Ctrl-C (SIGINT), a SIGTERM or a closing terminal (SIGHUP) stops
// Exhibit in a clean way (spec 9.6). A probe, a test run, settings.mutation_setup and Stryker each
// run in a process group of their own, so the signal does not reach them. src/probe.js kills those
// groups on its own, but it then ends Exhibit by the signal at once, and no finally block runs. So
// this handler kills every group that runInGroup started (stopAllGroups), and runs `cleanUp`,
// which removes the head worktree of the probes. Then it removes its listeners and sends the
// signal to Exhibit again, so Exhibit ends by that signal, and a shell shows the usual code: 130
// for SIGINT, 143 for SIGTERM and 129 for SIGHUP. A second signal while it cleans up changes
// nothing. `off()` removes the handlers.
export function onStopSignal(cleanUp) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let stopping = false;
  const off = () => signals.forEach((signal) => process.off(signal, handler));
  function handler(signal) {
    if (stopping) return;
    stopping = true;
    stopAllGroups();
    cleanUp()
      .catch(() => {})
      .finally(() => {
        off();
        process.kill(process.pid, signal);
      });
  }
  for (const signal of signals) process.on(signal, handler);
  return { off };
}

// A promise that never settles. After a stop, the run waits on it, and the signal handler exits.
function waitForever() {
  return new Promise(() => {});
}

// The collector for probe requirements. Each probe runs in the head worktree, made clean again
// before each probe, so no probe sees the files of the one before it. Each keeps its files in its
// own folder under .exhibit/probes, named after the probe. Each gets the run's env, as the test
// command does.
export function probeCollector({ cwd, headWorktree, timeoutSeconds }) {
  const used = new Set();
  return async (requirement, context) => {
    const folder = folderName(requirement.params.name, used);
    const outPath = `${PROBES}/${folder}`;
    return runProbe(
      { ...requirement.params, hidden: requirement.author === 'hidden' },
      { worktree: await headWorktree.fresh(), outDir: join(cwd, outPath), outPath, timeoutSeconds, env: context.env }
    );
  };
}

// A folder name from a probe name: letters, digits, dot, dash and underscore only, never "." or
// "..", and not one that an earlier probe in this run took. Case does not count, because on
// macOS a folder named A is the same folder as a.
function folderName(name, used) {
  let base = name.replace(/[^A-Za-z0-9._-]/g, '-');
  if (/^\.*$/.test(base)) base = `probe${base}`;
  let folder = base;
  for (let i = 2; used.has(folder.toLowerCase()); i += 1) folder = `${base}-${i}`;
  used.add(folder.toLowerCase());
  return folder;
}

// The branch name for the fix signals, when only git is known: the --head ref when it names a
// local branch, or the checked-out branch when the head is HEAD. Otherwise no branch is known.
async function localBranch(cwd, options) {
  try {
    if (options.head !== 'HEAD') {
      await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${options.head}`]);
      return options.head;
    }
    return (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
  } catch {
    return '';
  }
}

async function commitSha(cwd, ref, hint) {
  // A ref that starts with "-" would reach git as an option.
  if (ref.startsWith('-')) throw new ToolError(`${ref} is not a commit name.`);
  try {
    return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  } catch {
    throw new ToolError(`${ref} is not a commit in this clone. ${hint}`);
  }
}

async function git(cwd, args) {
  try {
    const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0] || error.message;
    throw new ToolError(`git ${args[0]} failed: ${reason}`);
  }
}

// The policy as the base commit has it, not as the files on disk have it, so a change cannot
// change the rules that check it (spec 8.1 and 15). A change to the policy file is still a
// policy-change gap. It returns the policy, as parsePolicy gives it, and policyFile: the path and
// the SHA-256 of the file's bytes in the base commit, or null when the base has no such file.
// A file that --policy names must be in the base or the head commit. Only in the head, the PR
// adds the policy, so it gets the policy-change gap. In neither, the path is most likely a typo.
async function policyAtBase(cwd, { base, head }, path, given) {
  const short = base.slice(0, 7);
  let bytes = null;
  const entry = await treeEntry(cwd, base, path);
  if (entry !== null) {
    if (entry.type !== 'blob') throw new ToolError(`${path} in the base commit ${short} is a ${entry.type === 'tree' ? 'folder' : entry.type}, not a file. Give --policy the path of the policy file.`);
    // A link is refused, not followed. A change to the file it points to would not show as a
    // change to the policy file, so the policy-change gap would miss it (spec 8.1).
    if (entry.mode === '120000') throw new ToolError(`${path} in the base commit ${short} is a symlink. Exhibit does not follow it. Give --policy the path of the real file.`);
    bytes = await gitBytes(cwd, ['cat-file', 'blob', entry.blob]);
  } else {
    // git finds no file at a path that goes through a linked folder. Say that the link is the
    // cause, so the run does not go on as if the base had no policy.
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const folder = parts.slice(0, i).join('/');
      const parent = await treeEntry(cwd, base, folder);
      if (parent === null) break;
      if (parent.mode === '120000') throw new ToolError(`${folder} in the base commit ${short} is a symlink, so ${path} goes through it. Exhibit does not follow it. Give --policy the path of the real file.`);
    }
    if (given && (await treeEntry(cwd, head, path)) === null) {
      throw new ToolError(missingPolicy(path, `neither the base commit ${short} nor the head commit ${head.slice(0, 7)} has such a file`));
    }
  }
  try {
    const policy = parsePolicy(bytes === null ? null : bytes.toString('utf8'), path);
    return { policy, policyFile: { path, sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') } };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    throw new ToolError(`${error.message}\nExhibit reads ${path} from the base commit ${short}, not from the files on disk. Fix the policy on the base branch.`);
  }
}

// The entry at `path` in `commit`: its mode, type and blob, or null when there is none. ls-tree
// reads the path as it is, with no globs, and --full-tree reads it from the top of the repo.
async function treeEntry(cwd, commit, path) {
  const line = (await git(cwd, ['ls-tree', '-z', '--full-tree', commit, '--', path])).split('\0').find((item) => item.endsWith(`\t${path}`));
  if (line === undefined) return null;
  const [mode, type, blob] = line.slice(0, line.indexOf('\t')).split(' ');
  return { mode, type, blob };
}

async function gitBytes(cwd, args) {
  try {
    const { stdout } = await run('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0] || error.message;
    throw new ToolError(`git ${args[0]} failed: ${reason}`);
  }
}

// Writes each file to a temporary file first, and renames them only when every write worked.
async function writeTogether(cwd, files) {
  await mkdir(join(cwd, '.exhibit'), { recursive: true }).catch((error) => {
    throw new ToolError(`could not make the folder .exhibit: ${error.message}`);
  });
  const temps = files.map(([path]) => join(cwd, `${path}.tmp-${process.pid}`));
  try {
    await Promise.all(files.map(([, text], i) => writeFile(temps[i], text)));
    for (const [i, [path]] of files.entries()) await rename(temps[i], join(cwd, path));
  } catch (error) {
    await Promise.all(temps.map((temp) => rm(temp, { force: true })));
    throw new ToolError(`could not write ${files.map(([path]) => path).join(' and ')}: ${error.message}`);
  }
}

function parseOptions(argv, forgeModule) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { base: { type: 'string' }, head: { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' }, policy: { type: 'string' }, shadow: { type: 'boolean' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    throw new ToolError(`${error.message}. ${USAGE}`);
  }
  if (values.repo !== undefined && !forgeModule.isRepoName(values.repo)) throw new ToolError(`--repo must look like owner/name, not "${values.repo}".`);
  let pr = null;
  if (values.pr !== undefined) {
    if (!/^[1-9]\d*$/.test(values.pr)) throw new ToolError(`--pr must be a PR number, such as 12, not "${values.pr}".`);
    if (values.base !== undefined || values.head !== undefined) throw new ToolError(`--pr takes the base and head from the PR, so leave out --base and --head. ${USAGE}`);
    if (values.repo === undefined) throw new ToolError(`--pr needs --repo owner/name. ${USAGE}`);
    pr = Number(values.pr);
  } else if (values.base === undefined) {
    throw new ToolError(`give --base REF, the commit the change starts from, such as main, or --pr N. ${USAGE}`);
  }
  return { base: values.base, head: values.head ?? 'HEAD', pr, repo: values.repo ?? null, policy: policyPath(values.policy ?? DEFAULT_POLICY), policyGiven: values.policy !== undefined, json: values.json === true };
}
