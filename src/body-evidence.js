// Reads the evidence that a PR body claims, for the backtest (spec 9.9). Most merged PRs have no
// exhibit, because Exhibit did not run when they merged. Many bodies have an evidence section
// that says what the builder ran. This module finds that section and says, for one requirement,
// whether the section shows it.
//
// A body only claims. Exhibit does not run anything here, so a requirement that the section shows
// is `met` only in this sense: the builder said they did it.

// The commands that run a test suite. A section that names one of them, or the policy's own
// test_command, shows a test run.
const TEST_COMMANDS = ['npm test', 'npm run test', 'node --test', 'yarn test', 'pnpm test', 'pytest', 'go test', 'cargo test'];
// The words of a failing-before claim (ticket 363): a test failed, and it was before the change.
const FAILED = /\bfail(?:s|ed|ing|ures?)?\b|\btim(?:ed|es) out\b/g;
const BEFORE = /\bbefore\b|\b(?:on|against) main\b|\bold\b|\bred\b|\bwithout (?:the|this|that|it)\b/;
// A word that denies the claim after it in its clause, as in "I did not run pytest".
const DENIAL = /\b(?:not|no|never|none|nothing|cannot)\b|n['’]t\b/;
// A count of 0 before a failure word, with at most one word of the same clause between them, as
// in "0 fail", "zero failures" or "0 tests failed". It denies only that word, so "exit code 0
// from npm test" still names a test run. The 0 of a version such as "22.0" is not a count.
const NONE_FAILED = /(?<![\w.])(?:0|zero)\s+(?:[^\s.,;:!?(]+\s+)?$/;
// Quoted text, such as a test's name or an error message. A before word in it, as in
// 'fails at "the old Lead"', is not the builder's claim.
const QUOTED = /"[^"]*"|“[^”]*”|`[^`]*`/g;
const CLAUSE_END = /[.,;:!?(\n]/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
// A fence opens with 3 or more backticks or tildes. Only a run of the same mark, at least as long,
// with nothing after it but spaces, closes it, so a ``` line inside a ```` fence stays in the fence.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Returns the text of the body's evidence sections, joined, or null when the body has none.
 * An evidence section starts at a markdown heading whose words start with "evidence", in any
 * case, such as "## Evidence" or "### Evidence from a real run". It ends at the next heading of
 * the same level or a higher one. A `#` line inside a code fence is not a heading.
 */
export function evidenceSection(body) {
  if (typeof body !== 'string') return null;
  const parts = [];
  let level = 0;
  // fence: the run of marks that opened the code fence we are in, or null.
  let fence = null;
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const mark = FENCE.exec(line);
    let inFence = fence !== null;
    if (fence === null && mark && !(mark[1][0] === '`' && mark[2].includes('`'))) {
      fence = mark[1];
      inFence = true;
    } else if (fence !== null && mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && mark[2].trim() === '') {
      fence = null;
    }
    const heading = !inFence && !mark ? HEADING.exec(line) : null;
    if (heading) {
      const depth = heading[1].length;
      if (current !== null && depth <= level) {
        parts.push(current.join('\n'));
        current = null;
      }
      if (current === null && /^[*_\s]*evidence\b/i.test(heading[2])) {
        level = depth;
        current = [];
        continue;
      }
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) parts.push(current.join('\n'));
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * Says whether the evidence section `section` shows the requirement `requirement` ({ type,
 * params }). Returns `met`, `missing`, or `unknown` when the section names the evidence but does
 * not say enough to tell. `settings` are the policy's settings, for test_command.
 *
 * A command counts only as whole words, so "make" is not found in "remake". A command or a
 * failure counts only when its clause has no "not", "no", "never", "none", "nothing", "cannot"
 * or "n't" (or "n’t") before it, so "I did not run pytest" names no test run. A clause ends at
 * . , ; : ! ? ( or a line break. A failure word after "0" or "zero", with at most one word of the
 * same clause between, as in "0 fail" or "0 tests failed", does not count either.
 *
 * - tests-before-after: the section names a test run: the policy's test_command, or one of
 *   TEST_COMMANDS.
 * - failing-before: one line of the section says a test failed, and says it was before the
 *   change. Failed is a form of "fail" ("failure" too) or "timed out". Before is "before", "on
 *   main", "against main", "old", "red", or "without the", "this", "that" or "it", outside quotes
 *   and backticks. So "The test failed before the change" and "With the old code put back, it
 *   fails" both count, and "every file 0 fail, as on main" does not.
 * - mutation: a line names mutation (mutation, mutant, Stryker or mutmut) and gives a percent. It
 *   is met when any percent on such a line is at least `min`, as in "went from 40% to 90%". With
 *   mutation lines but no percent on them, it is unknown.
 * - probe: the section holds the probe's `run` text, or the last command in it, after the last &&.
 */
export function bodyStatus(requirement, section, settings = {}) {
  const text = section.toLowerCase();
  const lines = text.split('\n');
  if (requirement.type === 'tests-before-after') {
    const commands = [...TEST_COMMANDS, ...(typeof settings.test_command === 'string' ? [settings.test_command.toLowerCase().trim()] : [])];
    return commands.some((command) => claims(text, command)) ? 'met' : 'missing';
  }
  if (requirement.type === 'failing-before') {
    return lines.some((line) => BEFORE.test(line.replace(QUOTED, '')) && [...line.matchAll(FAILED)].some((match) => !denied(line, match.index) && !NONE_FAILED.test(line.slice(0, match.index)))) ? 'met' : 'missing';
  }
  if (requirement.type === 'mutation') {
    const named = lines.filter((line) => /\b(mutation|mutants?|stryker|mutmut)\b/.test(line));
    if (named.length === 0) return 'missing';
    const rates = named.flatMap((line) => [...line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]) / 100));
    if (rates.length === 0) return 'unknown';
    return rates.some((rate) => rate >= requirement.params.min) ? 'met' : 'missing';
  }
  if (requirement.type === 'probe') {
    const run = String(requirement.params.run ?? '').toLowerCase().trim();
    const last = run.split('&&').at(-1).trim();
    return claims(text, run) || claims(text, last) ? 'met' : 'missing';
  }
  return 'unknown';
}

// Says whether the clause of `text` before `index` holds a word that denies what is at `index`.
function denied(text, index) {
  let start = index;
  while (start > 0 && !CLAUSE_END.test(text[start - 1])) start -= 1;
  return DENIAL.test(text.slice(start, index));
}

// Says whether `text` names `phrase` as whole words, at least once in a clause that does not deny it.
function claims(text, phrase) {
  if (phrase === '') return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${/^\w/.test(phrase) ? '(?<!\\w)' : ''}${escaped}${/\w$/.test(phrase) ? '(?!\\w)' : ''}`, 'g');
  return [...text.matchAll(pattern)].some((match) => !denied(text, match.index));
}
