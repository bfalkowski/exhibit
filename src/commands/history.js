import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readFixSignals } from '../fix-signals.js';
import { readHistory } from '../history.js';
import { checkHistoryLine } from '../history-schema.js';
import { ToolError } from '../tool-error.js';

const OUTPUT = '.exhibit/history.jsonl';
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

// `exhibit history --repo owner/name [--since DATE] [--limit N] [--json]`
// Writes one line for each merged PR to .exhibit/history.jsonl, and marks fix PRs by the fix
// signals in evidence.yml, or the defaults. Every line must pass the schema before the file is
// written, so a failed run leaves no partial file and keeps an older one.
// A PR whose files list GitHub cut short gives a warning on stderr. The run still succeeds.
export async function history(argv, { env, cwd, fetch, stdout, stderr }) {
  const options = parseOptions(argv);
  const token = env.GITHUB_TOKEN;
  if (!token) throw new ToolError('GITHUB_TOKEN is not set. Set it to a GitHub token that can read the repo, for example GITHUB_TOKEN=$(gh auth token).');

  // Read the fix signals before asking GitHub, so a bad evidence.yml fails fast.
  const fixSignals = await readFixSignals(cwd);
  const warn = (text) => stderr.write(`exhibit: warning: ${text}\n`);
  const lines = await readHistory({ repo: options.repo, token, fetch, since: options.since, limit: options.limit, fixSignals, warn });

  const problems = lines.flatMap((line) => checkHistoryLine(line).map((problem) => `PR ${line.number} ${problem}`));
  if (problems.length > 0) {
    const shown = problems.slice(0, 10).join('\n  ');
    const more = problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : '';
    throw new ToolError(`GitHub sent data that does not fit the history schema, so ${OUTPUT} was not written:\n  ${shown}${more}\nReport this as an Exhibit issue, with the PR numbers.`);
  }

  await writeAtomically(join(cwd, OUTPUT), lines.map((line) => JSON.stringify(line) + '\n').join(''));

  if (options.json) stdout.write(JSON.stringify({ prs: lines.length, output: OUTPUT }) + '\n');
  else stdout.write(`Wrote ${lines.length} merged PRs from ${options.repo} to ${OUTPUT}.\n`);
}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { repo: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    throw new ToolError(`${error.message}. Usage: exhibit history --repo owner/name [--since YYYY-MM-DD] [--limit N] [--json]`);
  }

  if (values.repo === undefined) throw new ToolError('history needs --repo owner/name, for example --repo bfalkowski/Building58.');
  if (!REPO_NAME.test(values.repo)) throw new ToolError(`--repo must look like owner/name, not "${values.repo}".`);

  let since;
  if (values.since !== undefined) {
    since = parseSince(values.since);
    if (!since) throw new ToolError(`--since must be a real date like 2026-03-01 (UTC) or an ISO time, not "${values.since}".`);
  }

  let limit;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!/^\d+$/.test(values.limit) || limit < 1) throw new ToolError(`--limit must be a whole number of 1 or more, not "${values.limit}".`);
  }

  return { repo: values.repo, since, limit, json: values.json === true };
}

// Returns the Date for a --since value, or null when it is not a real date. new Date() rolls a
// day that does not exist (2026-02-30) over into the next month. Whether a day exists does not
// depend on the time or the offset, so the date part is checked by itself, for every input.
function parseSince(text) {
  if (!DATE.test(text)) return null;
  const day = text.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) return null;
  const since = new Date(text.includes('T') ? text : `${day}T00:00:00Z`);
  return Number.isNaN(since.getTime()) ? null : since;
}

async function writeAtomically(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    // Best effort: when the folder itself is the problem, removing the temporary file fails too.
    await rm(temporary, { force: true }).catch(() => {});
    throw new ToolError(`could not write ${OUTPUT}: ${error.message}`);
  }
}
