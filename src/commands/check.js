import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { buildExhibit, COLLECTORS, EXIT_CODES, renderErrorSummary, renderSummary } from '../check.js';
import { MUTATION_DIR } from '../mutation.js';
import { checkExhibit } from '../exhibit-schema.js';
import { GITHUB_FORGE } from '../github.js';
import { DEFAULT_POLICY, policyPath, readPolicy } from '../policy.js';
import { DEFAULT_PROBE_TIMEOUT_SECONDS, runProbe } from '../probe.js';
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
// It returns the exit code: 0 for meets_policy, 1 for needs_person, 2 for error.
//
// The changed paths come from git, from the merge base of base and head to head, so both commits
// must be in the clone. With --pr, the forge gives the base, the head, and the PR's title, body,
// labels and branch for the fix signals. Without it, only the local branch name is known.
//
// --policy FILE reads the policy from that path in the repo, in place of evidence.yml.
//
// It removes the old evidence.json, summary.md, probe files and mutation logs first. So when the run fails before
// it can write them, no old file is left to be read as this run's verdict. Any failure that is not
// a verdict then writes a summary.md that says the verdict is error and why, and throws. The CLI
// prints it and exits 2.
//
// --shadow is shadow mode (spec 10): the run is the same, and the files say the same verdict, but
// the exit code is 0 for every verdict, error too. A failure that is not a verdict is printed here
// and gives 0 as well. So a CI step in shadow mode never fails on Exhibit, and summary.md shows
// what went wrong.
export async function check(argv, { env, cwd, fetch, stdout, stderr = process.stderr, collectors }) {
  // Remove the old files before anything can fail, a bad argument too.
  await Promise.all([...Object.values(OUTPUT), PROBES, MUTATION_DIR].map((file) => rm(join(cwd, file), { recursive: true, force: true })));
  // Read before the other arguments, so a bad argument in shadow mode gives 0 too.
  const shadow = argv.includes('--shadow');
  try {
    return await runCheck(argv, { env, cwd, fetch, stdout, collectors, shadow });
  } catch (error) {
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

  const policy = await readPolicy(cwd, options.policy);
  const policyFile = { path: options.policy, sha256: await fileHash(join(cwd, options.policy)) };

  let refs;
  if (options.pr !== null) {
    const token = env[forgeModule.tokenEnv];
    if (!token) throw new ToolError(`${forgeModule.tokenEnv} is not set. --pr reads the PR from ${forgeModule.displayName}, so set it to a token that can read the repo, for example ${forgeModule.tokenExample}.`);
    const forge = forgeModule.connect({ repo: options.repo, token, fetch });
    const pull = await forge.pull(options.pr);
    refs = {
      base: pull.baseSha,
      head: pull.headSha,
      pr: { title: pull.title ?? '', body: pull.body, labels: pull.labels, branch: pull.headRef ?? '', repo: options.repo },
      signalsFrom: 'pr',
      hint: `Fetch it first, for example with git fetch origin pull/${options.pr}/head ${pull.baseRef ?? ''}`.trimEnd() + '.'
    };
  } else {
    refs = { base: options.base, head: options.head, pr: { title: '', labels: [], branch: await localBranch(cwd, options) }, signalsFrom: 'branch', hint: 'Check the name, or fetch it first.' };
  }

  const base = await commitSha(cwd, refs.base, refs.hint);
  const head = await commitSha(cwd, refs.head, refs.hint);
  const files = (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`])).split('\0').filter((path) => path !== '');

  // The head worktree for probes is made only when a probe asks for it, and removed at the end.
  const headWorktree = worktreeOnDemand(cwd, head);
  let exhibit;
  try {
    const timeoutSeconds = policy.settings.probe_timeout_seconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;
    const all = collectors ?? { ...COLLECTORS, probe: probeCollector({ cwd, headWorktree, timeoutSeconds }) };
    exhibit = await buildExhibit({ cwd, env, policy, policyFile, files, pr: refs.pr, signalsFrom: refs.signalsFrom, repo: options.repo, prNumber: options.pr, base, head }, { collectors: all });
  } finally {
    await headWorktree.remove();
  }
  const problems = checkExhibit(exhibit);
  if (problems.length > 0) throw new ToolError(`the exhibit does not fit its schema, so ${OUTPUT.evidence} was not written:\n  ${problems.join('\n  ')}\nReport this as an Exhibit issue.`);

  await writeTogether(cwd, [
    [OUTPUT.evidence, JSON.stringify(exhibit, null, 2) + '\n'],
    [OUTPUT.summary, renderSummary(exhibit, { shadow })]
  ]);

  const code = shadow ? 0 : EXIT_CODES[exhibit.verdict];
  if (options.json) {
    stdout.write(JSON.stringify({ verdict: exhibit.verdict, exit_code: code, gaps: exhibit.gaps.length, evidence: OUTPUT.evidence, summary: OUTPUT.summary }) + '\n');
  } else {
    const gaps = exhibit.gaps.length === 0 ? 'No gaps.' : `${exhibit.gaps.length} ${exhibit.gaps.length === 1 ? 'gap' : 'gaps'}, listed with how to fix ${exhibit.gaps.length === 1 ? 'it' : 'them'} in ${OUTPUT.summary}.`;
    stdout.write(`Verdict: ${exhibit.verdict}. ${gaps}\nWrote ${OUTPUT.evidence} and ${OUTPUT.summary}.\n`);
    if (shadow) stdout.write('Shadow mode: nothing waits on this verdict, so the exit code is 0.\n');
  }
  return code;
}

// The collector for probe requirements. Each probe runs in the head worktree, made clean again
// before each probe, so no probe sees the files of the one before it. Each keeps its files in its
// own folder under .exhibit/probes, named after the probe.
function probeCollector({ cwd, headWorktree, timeoutSeconds }) {
  const used = new Set();
  return async (requirement) => {
    const folder = folderName(requirement.params.name, used);
    const outPath = `${PROBES}/${folder}`;
    return runProbe(
      { ...requirement.params, hidden: requirement.author === 'hidden' },
      { worktree: await headWorktree.fresh(), outDir: join(cwd, outPath), outPath, timeoutSeconds }
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

async function fileHash(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ToolError(`could not read ${path}: ${error.message}`);
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
  return { base: values.base, head: values.head ?? 'HEAD', pr, repo: values.repo ?? null, policy: policyPath(values.policy ?? DEFAULT_POLICY), json: values.json === true };
}
