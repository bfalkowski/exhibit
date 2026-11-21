import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readErrorReason } from '../check.js';
import { checkExhibit } from '../exhibit-schema.js';
import { GITHUB_FORGE } from '../github.js';
import { COMMENT_MARKER, renderComment, renderErrorComment } from '../pr-comment.js';
import { DEFAULT_POLICY, policyPath, readPolicy } from '../policy.js';
import { DEFAULT_DATA_BRANCH, DEFAULT_LOCAL_PATH, exhibitPath, STORAGE_TARGETS, store } from '../storage.js';
import { ToolError } from '../tool-error.js';

const USAGE = 'Usage: exhibit publish --evidence FILE [--policy FILE] [--storage data-branch|local] [--data-branch NAME] [--remote NAME] [--local-path DIR] [--comment] [--pr N] [--repo owner/name] [--head SHA] [--enforce] [--json]';

// `exhibit publish --evidence FILE`
// Stores one exhibit, the evidence.json that exhibit check wrote (spec 7 and 9.12). exhibit check
// runs the PR's code, so it runs with a read-only token. Storing needs write access, so it is this
// separate step, which never runs code from the PR.
//
// The place comes from settings.storage in evidence.yml (or the file --policy names), or from --storage: data-branch (the
// default) commits the file to the data branch on the remote, and local writes it to a folder.
// Either way the file goes to prs/<number>/<head-sha>.json.
//
// It checks the file against schema/exhibit.schema.json first, and stores nothing when it does not
// pass. Any failure throws, and the CLI exits 2. It returns 0, the exit code, when the exhibit is
// stored, or was stored already.
//
// With --comment, it then posts a short summary of the exhibit as one comment on the PR, or
// updates the comment it posted on an earlier run (see src/pr-comment.js). Without --enforce, the
// comment says shadow mode: nothing waits on the verdict. Without --comment, --enforce changes
// nothing, so the GitHub Action can pass each of its inputs on its own. The exhibit is stored before the
// comment is posted, so a failure to post exits 2 but keeps the stored exhibit.
//
// When exhibit check fails before it has a verdict, it writes summary.md and no evidence.json.
// Then publish stores nothing. With --comment, --pr N and --repo owner/name, it posts the verdict
// error and the reason from the summary.md beside the evidence file, in the same one comment, and
// returns 0. It reads no policy then. Without them, it exits 2 and says where to read why. When there is an exhibit,
// --pr, --repo and --head must match it, or it stores nothing. The Action passes them from the PR
// event, so an exhibit for another PR or commit is not stored.
export async function publish(argv, { cwd, env = {}, fetch, stdout }) {
  // GitHub is the only forge today, so the command picks its module first and asks it the rest.
  const forgeModule = GITHUB_FORGE;
  const options = parseOptions(argv, forgeModule);
  const text = await readFile(resolve(cwd, options.evidence), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw new ToolError(`could not read ${options.evidence}: ${error.message}`);
  });
  // With no exhibit, nothing is stored, so the policy's storage settings are not read. The usual
  // reason for no exhibit is a bad policy, and the publish job checks out the same base commit.
  if (text === null) return publishNoExhibit(forgeModule, options, { cwd, env, fetch, stdout });
  const { settings } = await readPolicy(cwd, options.policy, { given: options.policyGiven });
  const storage = options.storage ?? settings.storage ?? 'data-branch';
  let exhibit;
  try {
    exhibit = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`${options.evidence} is not valid JSON, so nothing was stored: ${error.message}`);
  }
  const problems = checkExhibit(exhibit);
  if (problems.length > 0) throw new ToolError(`${options.evidence} does not fit the evidence.json schema, so nothing was stored:\n  ${problems.join('\n  ')}`);
  if (exhibit.pr === null) throw new ToolError(`${options.evidence} has no PR number, so it has no place under prs/. Run exhibit check with --pr N --repo owner/name.`);
  refuseOtherEvent(exhibit, options);
  // Every check for --comment comes before the exhibit is stored, so a run that cannot post
  // changes nothing.
  let forge = null;
  if (options.comment) {
    if (exhibit.repo === null && options.repo === null) throw new ToolError(`${options.evidence} names no repo, so --comment does not know where the PR is. Run exhibit check with --pr N --repo owner/name.`);
    const token = env[forgeModule.tokenEnv];
    if (!token) throw new ToolError(`${forgeModule.tokenEnv} is not set. --comment posts on the PR in ${forgeModule.displayName}, so set it to a token that can write PR comments, for example ${forgeModule.tokenExample}.`);
    forge = forgeModule.connect({ repo: exhibit.repo ?? options.repo, token, fetch });
  }

  const path = exhibitPath(exhibit);
  const target = storage === 'data-branch'
    ? { kind: 'data-branch', cwd, remote: options.remote, branch: options.dataBranch ?? settings.data_branch ?? DEFAULT_DATA_BRANCH, message: `Exhibit for PR ${exhibit.pr} at ${exhibit.head.slice(0, 12)}` }
    : { kind: 'local', cwd, folder: options.localPath ?? settings.local_path ?? DEFAULT_LOCAL_PATH };
  const result = await store(target, path, text);

  if (options.json) {
    const comment = forge === null ? null : await postComment(forge, exhibit, options, storage, path, result, cwd);
    stdout.write(JSON.stringify({ storage, path, where: result.where, changed: result.changed, commit: result.commit, comment }) + '\n');
    return 0;
  }
  if (storage === 'data-branch') {
    stdout.write(result.changed
      ? `Stored ${result.where} in commit ${result.commit}, pushed to ${options.remote}.\n`
      : `${result.where} on ${options.remote} already holds this exhibit. Nothing changed.\n`);
  } else {
    stdout.write(result.changed ? `Wrote ${result.where}.\n` : `${result.where} already holds this exhibit. Nothing changed.\n`);
  }
  if (forge !== null) {
    const comment = await postComment(forge, exhibit, options, storage, path, result, cwd);
    stdout.write(`${COMMENT_DONE[comment.action]} on PR ${exhibit.pr}: ${comment.url}\n`);
  }
  return 0;
}

// The run when exhibit check wrote no evidence.json, because it failed before it had a verdict.
// It stores nothing. With --comment, --pr and --repo, it posts the error and the reason from
// summary.md as the one PR comment, and returns 0. Otherwise it throws, and says where to read why.
async function publishNoExhibit(forgeModule, options, { cwd, env, fetch, stdout }) {
  const summaryFile = join(dirname(options.evidence), 'summary.md');
  const why = `exhibit check wrote no ${options.evidence}, so there is no exhibit, and nothing was stored. The check failed before it had a verdict. ${summaryFile} says why: in GitHub Actions, read the check job's summary, or summary.md in the workflow artifact named exhibit.`;
  if (!options.comment) throw new ToolError(why);
  if (options.pr === null || options.repo === null) throw new ToolError(`${why} To post the error on the PR, give --pr N and --repo owner/name.`);
  const token = env[forgeModule.tokenEnv];
  if (!token) throw new ToolError(`${forgeModule.tokenEnv} is not set. --comment posts on the PR in ${forgeModule.displayName}, so set it to a token that can write PR comments, for example ${forgeModule.tokenExample}.`);
  const forge = forgeModule.connect({ repo: options.repo, token, fetch });

  const summary = await readFile(resolve(cwd, summaryFile), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw new ToolError(`could not read ${summaryFile}: ${error.message}`);
  });
  const reason = summary === null ? null : readErrorReason(summary);
  let comment;
  try {
    comment = await forge.upsertComment(options.pr, COMMENT_MARKER, renderErrorComment(reason, { enforce: options.enforce }));
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    throw new ToolError(`exhibit check wrote no ${options.evidence}, and the comment on PR ${options.pr} that says so was not posted: ${error.message}`);
  }
  if (options.json) {
    stdout.write(JSON.stringify({ storage: options.storage ?? null, path: null, where: null, changed: false, commit: null, comment }) + '\n');
    return 0;
  }
  stdout.write(`exhibit check wrote no ${options.evidence}, so nothing was stored.${reason === null ? '' : ` ${summaryFile} says why.`}\n`);
  stdout.write(`${COMMENT_DONE[comment.action]} on PR ${options.pr}: ${comment.url}\n`);
  return 0;
}

// Throws when --pr, --repo or --head names another PR, repo or head than the exhibit does. In the
// GitHub Action they come from the PR event, and the exhibit comes from the check job, which runs
// the PR's code. That code can rewrite the file. This catches a file for another PR or commit. It
// cannot catch a file for the right PR and head with a made-up verdict (spec 9.12).
// An exhibit with no repo does not match a --repo.
function refuseOtherEvent(exhibit, options) {
  const otherPr = options.pr !== null && options.pr !== exhibit.pr;
  const otherRepo = options.repo !== null && (exhibit.repo === null || options.repo.toLowerCase() !== exhibit.repo.toLowerCase());
  const otherHead = options.head !== null && options.head !== exhibit.head;
  if (!otherPr && !otherRepo && !otherHead) return;
  const at = options.head === null ? '' : ` at ${exhibit.head}`;
  const found = `PR ${exhibit.pr} in ${exhibit.repo ?? 'no named repo'}${at}`;
  const given = `PR ${options.pr ?? exhibit.pr} in ${options.repo ?? exhibit.repo ?? 'no named repo'}${options.head === null ? '' : ` at ${options.head}`}`;
  const why = options.head === null ? '' : ' Its head, PR and repo must be the ones of the PR event. A push to the PR while the check ran, or a step in the check job that rewrote the file, can cause this.';
  throw new ToolError(`${options.evidence} is the exhibit for ${found}, not for ${given}, so nothing was stored.${why}`);
}

const COMMENT_DONE = { created: 'Posted the comment', updated: 'Updated the comment', unchanged: 'The comment already says this. Nothing changed' };

// Posts or updates the PR comment, and returns { action, url }. A failure says that the exhibit
// is stored, so a person knows that only the comment is missing.
async function postComment(forge, exhibit, options, storage, path, result, cwd) {
  const link = storage === 'data-branch' && (await remotePointsAt(forge, cwd, options.remote)) ? forge.fileUrl(result.commit, path) : null;
  const body = renderComment(exhibit, { enforce: options.enforce, link, where: result.where });
  try {
    return await forge.upsertComment(exhibit.pr, COMMENT_MARKER, body);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    throw new ToolError(`the exhibit is stored at ${result.where}, but the comment on PR ${exhibit.pr} was not posted: ${error.message}`);
  }
}

// True when the git remote `remote` is the PR's repo on the forge, so the stored file has a web
// page there. A remote that git cannot name counts as false.
function remotePointsAt(forge, cwd, remote) {
  return new Promise((done) => {
    execFile('git', ['remote', 'get-url', remote], { cwd }, (error, stdout) => done(!error && forge.isRemote(stdout.trim())));
  });
}

function parseOptions(argv, forgeModule) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        evidence: { type: 'string' },
        policy: { type: 'string' },
        storage: { type: 'string' },
        'data-branch': { type: 'string' },
        remote: { type: 'string' },
        'local-path': { type: 'string' },
        comment: { type: 'boolean' },
        pr: { type: 'string' },
        repo: { type: 'string' },
        head: { type: 'string' },
        enforce: { type: 'boolean' },
        json: { type: 'boolean' }
      },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    throw new ToolError(`${error.message}. ${USAGE}`);
  }
  if (values.evidence === undefined) throw new ToolError(`give --evidence FILE, such as .exhibit/evidence.json. ${USAGE}`);
  if (values.storage !== undefined && !STORAGE_TARGETS.includes(values.storage)) throw new ToolError(`--storage must be ${STORAGE_TARGETS.join(' or ')}, not "${values.storage}".`);
  for (const name of ['data-branch', 'remote']) {
    if (values[name] !== undefined && (values[name] === '' || values[name].startsWith('-'))) throw new ToolError(`--${name} must be a name that does not start with "-", not "${values[name]}".`);
  }
  if (values['local-path'] === '') throw new ToolError('--local-path must not be empty.');
  if (values.pr !== undefined && !/^[1-9]\d*$/.test(values.pr)) throw new ToolError(`--pr must be a PR number, such as 12, not "${values.pr}".`);
  if (values.repo !== undefined && !forgeModule.isRepoName(values.repo)) throw new ToolError(`--repo must look like owner/name, not "${values.repo}".`);
  // A full SHA, so a short one or a branch name cannot match by chance. git uses 40 hex digits,
  // or 64 in a SHA-256 repo, as the exhibit schema does.
  if (values.head !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(values.head)) throw new ToolError(`--head must be a full commit SHA of 40 or 64 hex digits, not "${values.head}". ${USAGE}`);
  return {
    evidence: values.evidence,
    policy: policyPath(values.policy ?? DEFAULT_POLICY),
    policyGiven: values.policy !== undefined,
    storage: values.storage,
    dataBranch: values['data-branch'],
    remote: values.remote ?? 'origin',
    localPath: values['local-path'],
    comment: values.comment === true,
    pr: values.pr === undefined ? null : Number(values.pr),
    repo: values.repo ?? null,
    head: values.head === undefined ? null : values.head.toLowerCase(),
    enforce: values.enforce === true,
    json: values.json === true
  };
}
