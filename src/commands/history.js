import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readFixSignals } from '../fix-signals.js';
import { createGitHubForge, isRepoName } from '../github.js';
import { LOOK_BACK_MS, updateHistory } from '../history.js';
import { checkHistoryLine } from '../history-schema.js';
import { buildReport } from '../report.js';
import { addSzz, cloneRoot } from '../szz.js';
import { ToolError } from '../tool-error.js';

const OUTPUT = '.exhibit/history.jsonl';
const REPORT = { markdown: '.exhibit/report.md', html: '.exhibit/report.html' };
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

// `exhibit history --repo owner/name [--since DATE] [--limit N] [--full] [--json]`
// Writes one line for each merged PR to .exhibit/history.jsonl, and marks fix PRs by the fix
// signals in evidence.yml, or the defaults. When the file is there from an earlier run, it reads
// only the PRs the file lacks and the PRs in the look-back window, and keeps the other lines
// (spec 8.3). --full, or an old file that does not fit the schema, reads every PR again. Every line must pass the schema before the file is
// written, so a failed run leaves no partial file and keeps an older one.
// A PR whose files list GitHub cut short gives a warning on stderr. The run still succeeds.
// Inside a clone of the repo, it runs SZZ on each fix PR and fills szz (spec 9.2). Outside a
// clone, every szz is null, and it says so in one line on stderr.
// Then it writes the report of escaped defects, as report.md and report.html (spec 8.5).
// Last it prints how many GitHub requests the run made.
export async function history(argv, { env, cwd, fetch, stdout, stderr }) {
  const options = parseOptions(argv);
  const token = env.GITHUB_TOKEN;
  if (!token) throw new ToolError('GITHUB_TOKEN is not set. Set it to a GitHub token that can read the repo, for example GITHUB_TOKEN=$(gh auth token).');

  // Read the fix signals before asking GitHub, so a bad evidence.yml fails fast.
  const fixSignals = await readFixSignals(cwd);
  const warn = (text) => stderr.write(`exhibit: warning: ${text}\n`);
  const forge = createGitHubForge({ repo: options.repo, token, fetch });
  const previous = options.full ? [] : await readPrevious(cwd, forge, (text) => stderr.write(`exhibit: note: ${text}\n`));
  const updated = await updateHistory({ forge, since: options.since, limit: options.limit, previous, fixSignals, warn });
  const read = keepSzz(updated.lines, previous);

  const root = await cloneRoot(cwd, forge);
  let lines;
  if (root) {
    // SZZ runs only on the lines with no szz yet. The commit-to-PR map still sees every line.
    const done = await addSzz(read.filter((line) => line.szz === undefined), { dir: root, forge, warn, known: read });
    const byNumber = new Map(done.map((line) => [line.number, line]));
    lines = read.map((line) => byNumber.get(line.number) ?? line);
  } else {
    lines = read.map((line) => ({ ...line, szz: line.szz ?? null }));
    stderr.write(`exhibit: note: SZZ did not run, because this folder is not a clone of ${options.repo}, so every szz is null. Run history inside a clone to link fix PRs to the PRs that added their lines.\n`);
  }

  const problems = lines.flatMap((line) => checkHistoryLine(line).map((problem) => `PR ${line.number} ${problem}`));
  if (problems.length > 0) {
    const shown = problems.slice(0, 10).join('\n  ');
    const more = problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : '';
    throw new ToolError(`GitHub sent data that does not fit the history schema, so ${OUTPUT} was not written:\n  ${shown}${more}\nReport this as an Exhibit issue, with the PR numbers.`);
  }

  await writeAtomically(cwd, OUTPUT, lines.map((line) => JSON.stringify(line) + '\n').join(''));
  const report = buildReport(lines, { repo: options.repo, szzRan: root !== null, fixSignals });
  await writeAtomically(cwd, REPORT.markdown, report.markdown);
  await writeAtomically(cwd, REPORT.html, report.html);

  // Inside a clone, a fix PR with szz: null is one that SZZ skipped, and warned about.
  const fixes = lines.filter((line) => line.classification.fix);
  const szz = root ? { fix_prs: fixes.length, linked: fixes.filter((line) => line.szz?.links.length > 0).length, skipped: fixes.filter((line) => line.szz === null).length } : null;
  const mode = previous.length > 0 ? 'incremental' : 'full';
  const requests = forge.requestCount();
  if (options.json) {
    stdout.write(JSON.stringify({ prs: lines.length, output: OUTPUT, szz, report: REPORT, mode, read: updated.read, requests }) + '\n');
  } else {
    const skipped = szz?.skipped > 0 ? ` (${szz.skipped} skipped)` : '';
    const found = szz ? ` SZZ found links for ${szz.linked} of ${szz.fix_prs} fix PRs${skipped}.` : '';
    const days = LOOK_BACK_MS / (24 * 60 * 60 * 1000);
    const readText = mode === 'full'
      ? `Read all ${updated.read} merged PRs from GitHub.`
      : `Read ${updated.read} of ${lines.length} merged PRs from GitHub: the PRs not in the old file, and the PRs merged in the ${days} days before its newest PR. Kept the other ${lines.length - updated.read} lines as they were.`;
    stdout.write(`Wrote ${lines.length} merged PRs from ${options.repo} to ${OUTPUT}.${found}\n${readText} Made ${requests} GitHub requests.\nWrote the report to ${REPORT.markdown} and ${REPORT.html}.\n`);
  }
}

// Returns the lines of the old history file, so the run reads only what is new. Returns [] when
// there is no file, or when the run must read every PR again: when the file is not JSON lines,
// when a line does not fit the schema, as in a file from an older version of Exhibit, or when the
// file holds PRs from another repo. `note` gets one line that says why.
async function readPrevious(cwd, forge, note) {
  let text;
  try {
    text = await readFile(join(cwd, OUTPUT), 'utf8');
  } catch (error) {
    // No file yet. ENOTDIR: .exhibit is not a folder, and the write says so later.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw new ToolError(`could not read ${OUTPUT}: ${error.message}`);
  }
  const again = (why) => {
    note(`history reads every merged PR again, because ${OUTPUT} ${why}.`);
    return [];
  };
  const lines = [];
  for (const [index, row] of text.split('\n').entries()) {
    if (row.trim() === '') continue;
    try {
      lines.push(JSON.parse(row));
    } catch {
      return again(`has a line that is not JSON (line ${index + 1})`);
    }
  }
  for (const line of lines) {
    const problems = checkHistoryLine(line);
    if (problems.length > 0) return again(`does not fit the history schema, as a file from an older version of Exhibit does (PR ${line.number ?? '?'} ${problems[0]})`);
  }
  const stranger = lines.find((line) => line.forge !== forge.name || !forge.isPullUrl(line.url));
  if (stranger) return again(`holds PRs from another repo (PR ${stranger.number} is ${stranger.url}), not ${forge.repo}`);
  return lines;
}

// Returns `lines` where a fix PR that was read again keeps its szz from the old file, so SZZ does
// not run on it again. A PR merged once does not change its code, so its SZZ result stays true.
// SZZ runs on a fix that the old file had as no fix, or with a null szz, as SZZ skipped it then.
function keepSzz(lines, previous) {
  const old = new Map(previous.map((line) => [line.number, line]));
  return lines.map((line) => {
    if (line.szz !== undefined) return line;
    const before = old.get(line.number);
    return before?.szz && line.classification.fix ? { ...line, szz: before.szz } : line;
  });
}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { repo: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, full: { type: 'boolean' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    throw new ToolError(`${error.message}. Usage: exhibit history --repo owner/name [--since YYYY-MM-DD] [--limit N] [--full] [--json]`);
  }

  if (values.repo === undefined) throw new ToolError('history needs --repo owner/name, for example --repo bfalkowski/Building58.');
  if (!isRepoName(values.repo)) throw new ToolError(`--repo must look like owner/name, not "${values.repo}".`);

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

  return { repo: values.repo, since, limit, full: values.full === true, json: values.json === true };
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

// Writes `text` to `name` in `cwd`, so a failed write leaves the older file as it was.
async function writeAtomically(cwd, name, text) {
  const path = join(cwd, name);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    // Best effort: when the folder itself is the problem, removing the temporary file fails too.
    await rm(temporary, { force: true }).catch(() => {});
    throw new ToolError(`could not write ${name}: ${error.message}`);
  }
}
