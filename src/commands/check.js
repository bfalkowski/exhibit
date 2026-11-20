import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { buildExhibit, EXIT_CODES, renderSummary } from '../check.js';
import { checkExhibit } from '../exhibit-schema.js';
import { GITHUB_FORGE } from '../github.js';
import { readPolicy } from '../policy.js';
import { ToolError } from '../tool-error.js';

const run = promisify(execFile);
const OUTPUT = { evidence: '.exhibit/evidence.json', summary: '.exhibit/summary.md' };
const USAGE = 'Usage: exhibit check --base REF [--head REF] [--repo owner/name] [--json], or exhibit check --pr N --repo owner/name [--json]';

// `exhibit check --base REF [--head REF]`, or `exhibit check --pr N --repo owner/name`
// Classifies the change from base to head, works out what the policy needs, collects the evidence,
// and writes .exhibit/evidence.json and .exhibit/summary.md (spec 7, 8.2 and 9.8).
// It returns the exit code: 0 for meets_policy, 1 for needs_person, 2 for error.
//
// The changed paths come from git, from the merge base of base and head to head, so both commits
// must be in the clone. With --pr, the forge gives the base, the head, and the PR's title, labels
// and branch for the fix signals. Without it, only the local branch name is known.
//
// It removes the old evidence.json and summary.md first. So when the run fails before it can
// write them, no old file is left to be read as this run's verdict.
// Any failure that is not a verdict throws. The CLI then prints it and exits 2.
export async function check(argv, { env, cwd, fetch, stdout, collectors }) {
  // Remove the old files before anything can fail, a bad argument too.
  await Promise.all(Object.values(OUTPUT).map((file) => rm(join(cwd, file), { force: true })));
  // GitHub is the only forge today, so the command picks its module first and asks it the rest.
  const forgeModule = GITHUB_FORGE;
  const options = parseOptions(argv, forgeModule);

  const policy = await readPolicy(cwd);
  const policyFile = { path: 'evidence.yml', sha256: await fileHash(join(cwd, 'evidence.yml')) };

  let refs;
  if (options.pr !== null) {
    const token = env[forgeModule.tokenEnv];
    if (!token) throw new ToolError(`${forgeModule.tokenEnv} is not set. --pr reads the PR from ${forgeModule.displayName}, so set it to a token that can read the repo, for example ${forgeModule.tokenExample}.`);
    const forge = forgeModule.connect({ repo: options.repo, token, fetch });
    const pull = await forge.pull(options.pr);
    refs = {
      base: pull.base.sha,
      head: pull.head.sha,
      pr: { title: pull.title ?? '', labels: (pull.labels ?? []).map((label) => label.name), branch: pull.head.ref ?? '' },
      signalsFrom: 'pr',
      hint: `Fetch it first, for example with git fetch origin pull/${options.pr}/head ${pull.base.ref ?? ''}`.trimEnd() + '.'
    };
  } else {
    refs = { base: options.base, head: options.head, pr: { title: '', labels: [], branch: await localBranch(cwd, options) }, signalsFrom: 'branch', hint: 'Check the name, or fetch it first.' };
  }

  const base = await commitSha(cwd, refs.base, refs.hint);
  const head = await commitSha(cwd, refs.head, refs.hint);
  const files = (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`])).split('\0').filter((path) => path !== '');

  const exhibit = await buildExhibit({ policy, policyFile, files, pr: refs.pr, signalsFrom: refs.signalsFrom, repo: options.repo, prNumber: options.pr, base, head }, { collectors });
  const problems = checkExhibit(exhibit);
  if (problems.length > 0) throw new ToolError(`the exhibit does not fit its schema, so ${OUTPUT.evidence} was not written:\n  ${problems.join('\n  ')}\nReport this as an Exhibit issue.`);

  await writeTogether(cwd, [
    [OUTPUT.evidence, JSON.stringify(exhibit, null, 2) + '\n'],
    [OUTPUT.summary, renderSummary(exhibit)]
  ]);

  const code = EXIT_CODES[exhibit.verdict];
  if (options.json) {
    stdout.write(JSON.stringify({ verdict: exhibit.verdict, exit_code: code, gaps: exhibit.gaps.length, evidence: OUTPUT.evidence, summary: OUTPUT.summary }) + '\n');
  } else {
    const gaps = exhibit.gaps.length === 0 ? 'No gaps.' : `${exhibit.gaps.length} ${exhibit.gaps.length === 1 ? 'gap' : 'gaps'}, listed with how to fix ${exhibit.gaps.length === 1 ? 'it' : 'them'} in ${OUTPUT.summary}.`;
    stdout.write(`Verdict: ${exhibit.verdict}. ${gaps}\nWrote ${OUTPUT.evidence} and ${OUTPUT.summary}.\n`);
  }
  return code;
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
      options: { base: { type: 'string' }, head: { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' } },
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
  return { base: values.base, head: values.head ?? 'HEAD', pr, repo: values.repo ?? null, json: values.json === true };
}
