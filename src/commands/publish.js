import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkExhibit } from '../exhibit-schema.js';
import { GITHUB_FORGE } from '../github.js';
import { COMMENT_MARKER, renderComment } from '../pr-comment.js';
import { readPolicy } from '../policy.js';
import { DEFAULT_DATA_BRANCH, DEFAULT_LOCAL_PATH, exhibitPath, STORAGE_TARGETS, store } from '../storage.js';
import { ToolError } from '../tool-error.js';

const USAGE = 'Usage: exhibit publish --evidence FILE [--storage data-branch|local] [--data-branch NAME] [--remote NAME] [--local-path DIR] [--comment [--enforce]] [--json]';

// `exhibit publish --evidence FILE`
// Stores one exhibit, the evidence.json that exhibit check wrote (spec 7 and 9.12). exhibit check
// runs the PR's code, so it runs with a read-only token. Storing needs write access, so it is this
// separate step, which never runs code from the PR.
//
// The place comes from settings.storage in evidence.yml, or from --storage: data-branch (the
// default) commits the file to the data branch on the remote, and local writes it to a folder.
// Either way the file goes to prs/<number>/<head-sha>.json.
//
// It checks the file against schema/exhibit.schema.json first, and stores nothing when it does not
// pass. Any failure throws, and the CLI exits 2. It returns 0, the exit code, when the exhibit is
// stored, or was stored already.
//
// With --comment, it then posts a short summary of the exhibit as one comment on the PR, or
// updates the comment it posted on an earlier run (see src/pr-comment.js). Without --enforce, the
// comment says shadow mode: nothing waits on the verdict. The exhibit is stored before the
// comment is posted, so a failure to post exits 2 but keeps the stored exhibit.
export async function publish(argv, { cwd, env = {}, fetch, stdout }) {
  // GitHub is the only forge today, so the command picks its module first and asks it the rest.
  const forgeModule = GITHUB_FORGE;
  const options = parseOptions(argv);
  const { settings } = await readPolicy(cwd);
  const storage = options.storage ?? settings.storage ?? 'data-branch';

  const text = await readFile(resolve(cwd, options.evidence), 'utf8').catch((error) => {
    throw new ToolError(`could not read ${options.evidence}: ${error.message}`);
  });
  let exhibit;
  try {
    exhibit = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`${options.evidence} is not valid JSON, so nothing was stored: ${error.message}`);
  }
  const problems = checkExhibit(exhibit);
  if (problems.length > 0) throw new ToolError(`${options.evidence} does not fit the evidence.json schema, so nothing was stored:\n  ${problems.join('\n  ')}`);
  if (exhibit.pr === null) throw new ToolError(`${options.evidence} has no PR number, so it has no place under prs/. Run exhibit check with --pr N --repo owner/name.`);
  // Every check for --comment comes before the exhibit is stored, so a run that cannot post
  // changes nothing.
  let forge = null;
  if (options.comment) {
    if (exhibit.repo === null) throw new ToolError(`${options.evidence} names no repo, so --comment does not know where the PR is. Run exhibit check with --pr N --repo owner/name.`);
    const token = env[forgeModule.tokenEnv];
    if (!token) throw new ToolError(`${forgeModule.tokenEnv} is not set. --comment posts on the PR in ${forgeModule.displayName}, so set it to a token that can write PR comments, for example ${forgeModule.tokenExample}.`);
    forge = forgeModule.connect({ repo: exhibit.repo, token, fetch });
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
    const done = { created: 'Posted the comment', updated: 'Updated the comment', unchanged: 'The comment already says this. Nothing changed' }[comment.action];
    stdout.write(`${done} on PR ${exhibit.pr}: ${comment.url}\n`);
  }
  return 0;
}

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

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        evidence: { type: 'string' },
        storage: { type: 'string' },
        'data-branch': { type: 'string' },
        remote: { type: 'string' },
        'local-path': { type: 'string' },
        comment: { type: 'boolean' },
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
  if (values.enforce && !values.comment) throw new ToolError(`--enforce only changes what the PR comment says, so give it with --comment. ${USAGE}`);
  return {
    evidence: values.evidence,
    storage: values.storage,
    dataBranch: values['data-branch'],
    remote: values.remote ?? 'origin',
    localPath: values['local-path'],
    comment: values.comment === true,
    enforce: values.enforce === true,
    json: values.json === true
  };
}
