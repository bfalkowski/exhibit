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
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;

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
  let fence = null;
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fence === null && fenceMark) fence = fenceMark;
    else if (fence !== null && fenceMark === fence) fence = null;
    const heading = fence === null && !fenceMark ? HEADING.exec(line) : null;
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
 * - tests-before-after: the section names a test run: the policy's test_command, or one of
 *   TEST_COMMANDS.
 * - failing-before: one line of the section has a form of "fail" and the word "before", as in
 *   "The test failed before the change and passes after it".
 * - mutation: a line names mutation (mutation, mutant, Stryker or mutmut) and gives a percent. It
 *   is met when the first percent on such a line is at least `min`. A mutation line with no
 *   percent is unknown.
 * - probe: the section holds the probe's `run` text, or the last command in it, after the last &&.
 */
export function bodyStatus(requirement, section, settings = {}) {
  const text = section.toLowerCase();
  const lines = text.split('\n');
  if (requirement.type === 'tests-before-after') {
    const commands = [...TEST_COMMANDS, ...(typeof settings.test_command === 'string' ? [settings.test_command.toLowerCase().trim()] : [])];
    return commands.some((command) => command !== '' && text.includes(command)) ? 'met' : 'missing';
  }
  if (requirement.type === 'failing-before') {
    return lines.some((line) => /\bfail(s|ed|ing)?\b/.test(line) && /\bbefore\b/.test(line)) ? 'met' : 'missing';
  }
  if (requirement.type === 'mutation') {
    const named = lines.filter((line) => /\b(mutation|mutants?|stryker|mutmut)\b/.test(line));
    if (named.length === 0) return 'missing';
    const rates = named.map((line) => /(\d+(?:\.\d+)?)\s*%/.exec(line)).filter(Boolean).map((match) => Number(match[1]) / 100);
    if (rates.length === 0) return 'unknown';
    return rates[0] >= requirement.params.min ? 'met' : 'missing';
  }
  if (requirement.type === 'probe') {
    const run = String(requirement.params.run ?? '').toLowerCase().trim();
    const last = run.split('&&').at(-1).trim();
    return (run !== '' && text.includes(run)) || (last !== '' && text.includes(last)) ? 'met' : 'missing';
  }
  return 'unknown';
}
