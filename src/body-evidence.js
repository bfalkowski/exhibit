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
 * - tests-before-after: the section names a test run: the policy's test_command, or one of
 *   TEST_COMMANDS.
 * - failing-before: one line of the section has a form of "fail" and the word "before", as in
 *   "The test failed before the change and passes after it".
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
    return commands.some((command) => command !== '' && text.includes(command)) ? 'met' : 'missing';
  }
  if (requirement.type === 'failing-before') {
    return lines.some((line) => /\bfail(s|ed|ing)?\b/.test(line) && /\bbefore\b/.test(line)) ? 'met' : 'missing';
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
    return (run !== '' && text.includes(run)) || (last !== '' && text.includes(last)) ? 'met' : 'missing';
  }
  return 'unknown';
}
