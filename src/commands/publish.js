import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkExhibit } from '../exhibit-schema.js';
import { readPolicy } from '../policy.js';
import { DEFAULT_DATA_BRANCH, DEFAULT_LOCAL_PATH, exhibitPath, STORAGE_TARGETS, store } from '../storage.js';
import { ToolError } from '../tool-error.js';

const USAGE = 'Usage: exhibit publish --evidence FILE [--storage data-branch|local] [--data-branch NAME] [--remote NAME] [--local-path DIR] [--json]';

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
export async function publish(argv, { cwd, stdout }) {
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

  const path = exhibitPath(exhibit);
  const target = storage === 'data-branch'
    ? { kind: 'data-branch', cwd, remote: options.remote, branch: options.dataBranch ?? settings.data_branch ?? DEFAULT_DATA_BRANCH, message: `Exhibit for PR ${exhibit.pr} at ${exhibit.head.slice(0, 12)}` }
    : { kind: 'local', cwd, folder: options.localPath ?? settings.local_path ?? DEFAULT_LOCAL_PATH };
  const result = await store(target, path, text);

  if (options.json) {
    stdout.write(JSON.stringify({ storage, path, where: result.where, changed: result.changed, commit: result.commit }) + '\n');
  } else if (storage === 'data-branch') {
    stdout.write(result.changed
      ? `Stored ${result.where} in commit ${result.commit}, pushed to ${options.remote}.\n`
      : `${result.where} on ${options.remote} already holds this exhibit. Nothing changed.\n`);
  } else {
    stdout.write(result.changed ? `Wrote ${result.where}.\n` : `${result.where} already holds this exhibit. Nothing changed.\n`);
  }
  return 0;
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
  return {
    evidence: values.evidence,
    storage: values.storage,
    dataBranch: values['data-branch'],
    remote: values.remote ?? 'origin',
    localPath: values['local-path'],
    json: values.json === true
  };
}
