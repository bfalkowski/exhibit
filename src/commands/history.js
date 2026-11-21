import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { REVERT_SIGNAL } from '../fix-signals.js';
import { GITHUB_FORGE } from '../github.js';
import { cacheFolder, createReplyCache, removeOldEntries } from '../github-cache.js';
import { LOOK_BACK_MS, updateHistory } from '../history.js';
import { connectTracker, JIRA_TRACKER } from '../jira.js';
import { readLabelsToCount } from '../labels.js';
import { checkHistoryLine } from '../history-schema.js';
import { DEFAULT_POLICY, readPolicy } from '../policy.js';
import { buildReport, funnel, HISTORY_REPORT } from '../report.js';
import { addSzz, cloneRoot, REVERTS_A_REVERT } from '../szz.js';
import { ToolError } from '../tool-error.js';
import { writeTogether } from '../write-together.js';

const OUTPUT = '.exhibit/history.jsonl';
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

// `exhibit history --repo owner/name [--since DATE] [--limit N] [--full] [--no-cache] [--json]`
// Writes one line for each merged PR to .exhibit/history.jsonl, and marks fix PRs by the fix
// signals in evidence.yml, or the defaults. A bad evidence.yml stops the run before it asks
// GitHub. When the file is there from an earlier run, it reads
// only the PRs the file lacks and the PRs in the look-back window, and keeps the other lines
// (spec 8.3). --full, or an old file that does not fit the schema, reads every PR again.
// Every line must pass the schema before the file is
// written, so a failed run leaves no partial file and keeps an older one.
// A PR whose files list GitHub cut short gives a warning on stderr. The run still succeeds.
// Inside a clone of the repo, it runs SZZ on each fix PR and fills szz (spec 9.2). Outside a
// clone, every szz is null, and it says so in one line on stderr.
// It also writes the report of escaped defects, as report.md and report.html (spec 8.5). It writes
// the three files together: when one write fails, none of the three changes. It reads
// .exhibit/labels.jsonl, when it is there, only to count the labels in the report's funnel. A
// labels file it cannot read gives a warning, and the run still succeeds.
// It reads the PRs with GitHub's GraphQL API, and SZZ asks the REST API. REST replies go through
// the shared reply cache (spec 8.6), unless --no-cache turns it off. At the end it says how many
// REST requests went to GitHub and how many got a 304, and how many GraphQL queries went and how
// many points they used. A run that fails says it too, on stderr.
// At the end, also after a run that fails, it removes the cache entries that no run has used for
// 30 days (spec 8.6).
// With tracker:jira in the fix signals, it asks Jira about the ticket of each PR it reads (spec
// 9.1), with the token in JIRA_API_TOKEN, and says how many Jira requests it made. A kept line
// takes the Jira answer that its line saved, with no request (spec 8.3). With no token, a line
// with a saved answer keeps it, the signal matches no other PR, the run still succeeds, and it
// says so in one line on stderr.
// It writes the kinds of change that each PR's files match in evidence.yml (spec 8.3). With no
// kinds in the policy, every PR's kinds is empty, which means default, and it says so in one line.
export async function history(argv, { env, cwd, fetch, stdout, stderr }) {
  // GitHub is the only forge today, so the command picks its module first and asks it the rest.
  const forgeModule = GITHUB_FORGE;
  const options = parseOptions(argv, forgeModule);
  const token = env[forgeModule.tokenEnv];
  if (!token) throw new ToolError(`${forgeModule.tokenEnv} is not set. Set it to a ${forgeModule.displayName} token that can read the repo, for example ${forgeModule.tokenExample}.`);

  // Read and check the policy before asking GitHub, so a bad evidence.yml fails fast.
  const policy = await readPolicy(cwd);
  const fixSignals = policy.settings.fix_signals;
  const kinds = policy.kinds;
  if (Object.keys(kinds).length === 0) {
    const why = (await exists(join(cwd, DEFAULT_POLICY))) ? `${DEFAULT_POLICY} names no kinds` : `there is no ${DEFAULT_POLICY}`;
    stderr.write(`exhibit: note: ${why}, so the kinds of every PR in ${OUTPUT} are empty, which means default.\n`);
  }
  const warn = (text) => stderr.write(`exhibit: warning: ${text}\n`);
  // Without a token, history still reads the Jira answers saved in the old file (spec 8.3), so it
  // takes a tracker that cannot ask, and says so in its own note after the PRs are classified.
  const connected = connectTracker(policy.settings, { env, fetch });
  const tracker = connected.note ? JIRA_TRACKER.connect({ settings: policy.settings.jira, fetch }) : connected.tracker;
  const folder = options.cache ? cacheFolder({ env }) : null;
  const cache = folder ? createReplyCache({ dir: folder, token }) : undefined;
  const forge = forgeModule.connect({ repo: options.repo, token, fetch, cache });
  try {
    await run(options, { cwd, forge, tracker, fixSignals, kinds, folder, warn, stdout, stderr });
  } catch (error) {
    const { requests, not_modified: notModified, queries, points } = forge.counts();
    if (requests > 0 || queries > 0) {
      stderr.write(`exhibit: note: this run made ${plural(requests, 'GitHub REST request')}, and ${notModified} got a 304. It made ${plural(queries, 'GitHub GraphQL query', 'queries')}, which used ${plural(points, 'point')}.\n`);
    }
    if (tracker?.canAsk && tracker.counts().requests > 0) stderr.write(`exhibit: note: this run made ${plural(tracker.counts().requests, 'Jira request')}.\n`);
    throw error;
  } finally {
    // After the run, so the entries this run read have a new file time and stay (spec 8.6).
    if (folder) await removeOldEntries(folder);
  }
}

// The one note for a run with tracker:jira and no token. It says how many lines kept the Jira
// answer that the old history file saved, when there are any.
function noTokenNote(lines) {
  const saved = lines.filter((line) => line.ticket).length;
  const what = saved === 0
    ? 'so the tracker:jira fix signal matched no PR'
    : `so Exhibit did not ask Jira. ${saved === 1 ? '1 PR keeps' : `${saved} PRs keep`} the Jira answer saved in ${OUTPUT}, and the tracker:jira fix signal matched no other PR`;
  return `exhibit: note: ${JIRA_TRACKER.tokenEnv} is not set, ${what}. Set it to a Jira API token, and for Jira Cloud set ${JIRA_TRACKER.emailEnv} to the email of its account.\n`;
}
async function run(options, { cwd, forge, tracker, fixSignals, kinds, folder, warn, stdout, stderr }) {
  const previous = options.full ? [] : await readPrevious(cwd, forge, (text) => stderr.write(`exhibit: note: ${text}\n`));
  const updated = await updateHistory({ forge, since: options.since, limit: options.limit, previous, fixSignals, kinds, tracker, warn });
  if (tracker && !tracker.canAsk) stderr.write(noTokenNote(updated.lines));
  const read = keepSzz(updated.lines, previous);
  const kindChanges = kindsChanges(read, previous);
  if (kindChanges.length > 0) stderr.write(`exhibit: note: ${kindChanges}\n`);

  const root = await cloneRoot(cwd, forge);
  let lines;
  if (root) {
    // SZZ runs on the lines with no szz yet, and on fix lines whose szz is null because SZZ did
    // not run for them before, such as after a first run outside a clone. The commit-to-PR map
    // still sees every line.
    const done = await addSzz(read.filter((line) => line.szz === undefined || (line.szz === null && line.classification.fix)), { dir: root, forge, tracker, warn, known: read });
    const byNumber = new Map(done.map((line) => [line.number, line]));
    lines = read.map((line) => byNumber.get(line.number) ?? line);
  } else {
    lines = read.map((line) => ({ ...line, szz: line.szz ?? null }));
    stderr.write(`exhibit: note: SZZ did not run, because this folder is not a clone of ${options.repo}, so every szz is null. Run history inside a clone to link fix PRs to the PRs that added their lines.\n`);
  }

  // After SZZ, because SZZ makes a re-land no fix (spec 9.1), and the fix signals alone mark it
  // as a revert on each run.
  const changes = classificationChanges(lines, previous);
  if (changes.length > 0) stderr.write(`exhibit: note: ${changes}\n`);

  const problems = lines.flatMap((line) => checkHistoryLine(line).map((problem) => `PR ${line.number} ${problem}`));
  if (problems.length > 0) {
    const shown = problems.slice(0, 10).join('\n  ');
    const more = problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : '';
    throw new ToolError(`GitHub sent data that does not fit the history schema, so ${OUTPUT} was not written:\n  ${shown}${more}\nReport this as an Exhibit issue, with the PR numbers.`);
  }

  // The labels are read only to count them in the funnel. History never writes labels.jsonl.
  const labels = await readLabelsToCount(cwd);
  if (labels.state === 'unreadable') warn(`the report does not count the labels, because ${labels.problem}`);
  const report = buildReport(lines, { repo: options.repo, szzRan: root !== null, fixSignals, labels });
  await writeTogether(cwd, [
    [OUTPUT, lines.map((line) => JSON.stringify(line) + '\n').join('')],
    [HISTORY_REPORT.markdown, report.markdown],
    [HISTORY_REPORT.html, report.html]
  ]);

  // Inside a clone, a fix PR with szz: null is one that SZZ skipped, and warned about.
  const fixes = lines.filter((line) => line.classification.fix);
  const szz = root ? { fix_prs: fixes.length, linked: fixes.filter((line) => line.szz?.links.length > 0).length, skipped: fixes.filter((line) => line.szz === null).length } : null;
  const { requests, not_modified: notModified, queries, points } = forge.counts();
  const github = { requests, not_modified: notModified, cache: folder, graphql: { queries, points } };
  const mode = previous.length > 0 ? 'incremental' : 'full';
  // Only with tracker:jira in the fix signals: the Jira requests, or null when there was no token.
  const usesJira = fixSignals.includes(`tracker:${JIRA_TRACKER.name}`);
  const jira = tracker?.canAsk ? tracker.counts() : null;
  if (options.json) {
    stdout.write(JSON.stringify({ prs: lines.length, output: OUTPUT, szz, funnel: funnel(lines, { szzRan: root !== null, labels }), report: HISTORY_REPORT, github, mode, read: updated.read, ...(usesJira ? { jira } : {}) }) + '\n');
  } else {
    const skipped = szz?.skipped > 0 ? ` (${szz.skipped} skipped)` : '';
    const found = szz ? ` SZZ found links for ${szz.linked} of ${szz.fix_prs} fix PRs${skipped}.` : '';
    const cached = folder ? `${notModified} got a 304 and came from the cache in ${folder}.` : 'The cache was off.';
    const days = LOOK_BACK_MS / (24 * 60 * 60 * 1000);
    const readText = mode === 'full'
      ? `Read all ${updated.read} merged PRs from GitHub.`
      : `Read ${updated.read} of ${lines.length} merged PRs from GitHub: the PRs not in the old file, and the PRs merged in the ${days} days before its newest PR. Kept the other ${lines.length - updated.read} lines as they were.`;
    stdout.write(`Wrote ${lines.length} merged PRs from ${options.repo} to ${OUTPUT}.${found}\n${readText}\nWrote the report to ${HISTORY_REPORT.markdown} and ${HISTORY_REPORT.html}.\n` +
      `Made ${plural(requests, 'GitHub REST request')}. ${cached}\n` +
      `Made ${plural(queries, 'GitHub GraphQL query', 'queries')}, which used ${plural(points, 'point')} of the GraphQL rate limit.\n` +
      (jira ? `Made ${plural(jira.requests, 'Jira request')}. ${jira.not_found} named an issue that Jira does not know.\n` : ''));
  }
}

// "1 point", "2 points". `many` is the plural of the last word, when it is not that word with "s".
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : one.replace(/\S+$/, (word) => many ?? `${word}s`)}`;
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
    if (problems.length === 0) continue;
    // A problem at the top of the line starts with "/: ". A person does not know that "/" means
    // the whole line, so the note leaves it out: "PR 137 misses the field base_ref".
    const problem = problems[0].replace(/^\/: /, '');
    return again(`does not fit the history schema, as a file from an older version of Exhibit does (PR ${line.number ?? '?'} ${problem})`);
  }
  const stranger = lines.find((line) => line.forge !== forge.name || !forge.isPullUrl(line.url));
  if (stranger) return again(`holds PRs from another repo (PR ${stranger.number} is ${stranger.url}), not ${forge.repo}`);
  return lines;
}

// Returns `lines` where a fix PR that was read again keeps its szz from the old file, so SZZ does
// not run on it again. A PR merged once does not change its code, so its SZZ result stays true.
// SZZ runs on a fix that the old file had as no fix, or with a null szz, as SZZ skipped it then.
// A kept line that the fix signals no longer mark as a fix gets szz null, as every other PR
// that is no fix has. An szz found by blame no longer fits a fix that the revert signal now
// marks, and a revert's szz no longer fits a fix that another signal now marks, so SZZ runs
// on that line again. A revert's links come from its body, and a line takes the body that the
// forge holds now, so SZZ also runs again on a revert whose body differs from the old file.
function keepSzz(lines, previous) {
  const old = new Map(previous.map((line) => [line.number, line]));
  return lines.map((line) => {
    if (!line.classification.fix && line.szz) return { ...line, szz: null };
    const before = old.get(line.number);
    const newBody = line.classification.fix_signal === REVERT_SIGNAL && before !== undefined && before.body !== line.body;
    const fits = (szz) => fitsSignal(szz, line) && !newBody;
    if (line.szz) return fits(line.szz) ? line : { ...line, szz: undefined };
    if (line.szz !== undefined) return line;
    return before?.szz && line.classification.fix && fits(before.szz) ? { ...line, szz: before.szz } : line;
  });
}

// SZZ blames no commit for a revert (spec 9.2), so its blamed_commit is null. An szz that says
// "reverts a revert" comes from a file written before SZZ made a re-land no fix, so SZZ runs
// again and makes the line no fix.
const fitsSignal = (szz, line) => (szz.blamed_commit === null) === (line.classification.fix_signal === REVERT_SIGNAL) && szz.no_link_reason !== REVERTS_A_REVERT;

// Returns one text that lists the PRs whose classification differs from their line in the old
// file, or '' when none does. The fix signals in evidence.yml classify every line on each run, so
// this is how a person sees what a change to the signals did. A PR can also change with the same
// signals, such as when a person adds the label bug to it on GitHub, so the text does not say why.
function classificationChanges(lines, previous) {
  const old = new Map(previous.map((line) => [line.number, line.classification]));
  const changed = lines.filter((line) => {
    const before = old.get(line.number);
    return before && (before.fix !== line.classification.fix || before.fix_signal !== line.classification.fix_signal);
  });
  if (changed.length === 0) return '';
  const said = changed.slice(0, 10).map(({ number, classification: { fix, fix_signal: signal } }) => {
    if (!fix) return `PR ${number} is no longer a fix`;
    return old.get(number).fix ? `PR ${number} is a fix by ${signal} now` : `PR ${number} is now a fix (${signal})`;
  });
  const more = changed.length > 10 ? `, and ${changed.length - 10} more` : '';
  const count = changed.length === 1 ? `1 PR in ${OUTPUT} is` : `${changed.length} PRs in ${OUTPUT} are`;
  return `${count} classified another way than in the old file: ${said.join(', ')}${more}.`;
}

// Returns one text that lists the PRs whose kinds differ from their line in the old file, or ''
// when none does. The kinds in evidence.yml match every line again on each run, kept lines too, so
// no line keeps old kinds. This is how a person sees what a change to the kinds did. A line from a
// file written before history had kinds gets them with no note.
function kindsChanges(lines, previous) {
  const old = new Map(previous.map((line) => [line.number, line.classification.kinds]));
  const changed = lines.filter((line) => {
    const before = old.get(line.number);
    return before && before.join() !== line.classification.kinds.join();
  });
  if (changed.length === 0) return '';
  const named = (list) => (list.length === 0 ? 'default' : list.join(', '));
  const said = changed.slice(0, 10).map(({ number, classification }) => `PR ${number} from ${named(old.get(number))} to ${named(classification.kinds)}`);
  const more = changed.length > 10 ? `, and ${changed.length - 10} more` : '';
  return `the kinds in ${DEFAULT_POLICY} now give ${changed.length} PR${changed.length === 1 ? '' : 's'} in ${OUTPUT} other kinds: ${said.join('; ')}${more}.`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseOptions(argv, forgeModule) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { repo: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' }, full: { type: 'boolean' }, json: { type: 'boolean' }, 'no-cache': { type: 'boolean' } },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    throw new ToolError(`${error.message}. Usage: exhibit history --repo owner/name [--since YYYY-MM-DD] [--limit N] [--full] [--no-cache] [--json]`);
  }

  if (values.repo === undefined) throw new ToolError('history needs --repo owner/name, for example --repo bfalkowski/Building58.');
  if (!forgeModule.isRepoName(values.repo)) throw new ToolError(`--repo must look like owner/name, not "${values.repo}".`);

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

  return { repo: values.repo, since, limit, full: values.full === true, json: values.json === true, cache: values['no-cache'] !== true };
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

