import { parse } from '@babel/parser';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { matchesGlob } from './classify.js';
import { isTestPath } from './failing-before.js';
import { changedLines, testsThatReach } from './mutation.js';
import { DEFAULT_PROBE_TIMEOUT_SECONDS, runInGroup } from './probe.js';
import { worktreeOnDemand } from './worktree.js';

const run = promisify(execFile);

// Condition pairs (spec 9.14). Mutation changes the code that is there, and a test kills the
// mutant when it sees the change. It cannot find a case that no test tries, when the code gets
// that case wrong and every test agrees with the code. Canary 4 on Building58 was such a case:
//
//   const at = (i < 0 ? group.length - 1 : i) + (after ? 1 : 0);
//
// Its one new test tried `i < 0` with `after` true. No test tried `i < 0` with `after` false, and
// there the code was wrong. So this module records, for each condition on the changed lines,
// which way it went, and which way each earlier condition of the same function call went. A
// condition that goes both ways in the tests, but only one way under an earlier condition of the
// same statement, is a case no test tries (untried).
//
// A condition is the test of an `if`, a `? :`, a `while`, a `do ... while` or a `for`. When that
// test joins parts with && or ||, each part is a condition of its own.

// The files Exhibit can add the recording calls to. TypeScript needs a build step, and Python
// another tool, so they are not covered yet.
export const PAIRS_FILE = /\.(js|mjs|cjs)$/;

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const TESTED = { IfStatement: 'test', ConditionalExpression: 'test', WhileStatement: 'test', DoWhileStatement: 'test', ForStatement: 'test' };
const CUT = 80;
// The node types that are statements, such as an `if`, a `return` or a `const`.
const STATEMENT = /(Statement|Declaration)$/;
const LISTED = 20;
// Code in a language that the recorder cannot go in yet: TypeScript, JSX files, Python and the
// languages that mutation has no adapter for either.
const OTHER_CODE = /\.(ts|mts|cts|tsx|jsx|py|go|rb|java|kt|scala|rs|cs|php|swift|c|cc|cpp|h|hpp)$/;

export const PAIRS_DIR = '.exhibit/condition-pairs';

// The name of the recorder in the code that gets the calls. The long name keeps it apart from the
// project's own names.
const RECORDER = '__exhibitPairs';
const FRAME = '__exhibitFrame';

// Adds the recording calls to `text`, the code of the file `path`, for the conditions that start
// on one of the `lines` ([first, last] ranges, as changedLines gives them) and are inside a
// function. Gives back { text, conditions }: the new code, and each condition as { id, file,
// line, column, code }. The code of a condition is cut to 80 characters, with each run of white
// space as one space. With no such condition, `text` comes back as it was.
//
// Each condition `c` becomes `__exhibitPairs.d(__exhibitFrame, ID, (c))`, which gives back the
// value of `c` as it was, so && and || still give the same value. Each function with a condition
// gets a frame at its start, a new one for each call. Throws when the file does not parse.
export function addRecorder(text, path, lines) {
  const ast = parse(text, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, allowHashBang: true, errorRecovery: false, plugins: ['jsx'] });
  const changed = (line) => lines.some(([first, last]) => line >= first && line <= last);
  const conditions = [];
  const functions = new Map();
  const walk = (node, fn, statement) => {
    if (!node || typeof node.type !== 'string') return;
    const inner = FUNCTIONS.has(node.type) ? node : fn;
    const within = STATEMENT.test(node.type) ? node : statement;
    const key = TESTED[node.type];
    if (key && node[key]) {
      for (const part of parts(node[key])) {
        // A condition in a default value of a parameter runs before the body makes the frame.
        if (!inner || !changed(part.loc.start.line) || part.start < inner.body.start) continue;
        conditions.push({ node: part, fn: inner, statement: within });
        functions.set(inner, true);
      }
    }
    for (const [name, value] of Object.entries(node)) {
      if (name === 'loc' || name === 'extra' || name === 'leadingComments' || name === 'trailingComments' || name === 'innerComments') continue;
      if (Array.isArray(value)) for (const child of value) walk(child, inner, within);
      else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, inner, within);
    }
  };
  walk(ast.program, null, null);
  if (conditions.length === 0) return { text, conditions: [] };

  conditions.sort((a, b) => a.node.start - b.node.start);
  const edits = [];
  const found = conditions.map(({ node, statement }, index) => {
    const id = `${path}#${index + 1}`;
    const start = node.extra?.parenthesized ? node.extra.parenStart : node.start;
    const end = node.extra?.parenthesized ? closingParen(text, node.end) : node.end;
    edits.push({ at: start, text: `${RECORDER}.d(${FRAME}, ${JSON.stringify(id)}, (`, span: end - start, open: true });
    edits.push({ at: end, text: '))', span: end - start, open: false });
    return { id, file: path, line: node.loc.start.line, column: node.loc.start.column + 1, code: oneLine(text.slice(node.start, node.end)), at: node.start, statement: [statement.start, statement.end] };
  });
  for (const fn of functions.keys()) {
    const enter = `const ${FRAME} = ${RECORDER}.enter();`;
    if (fn.body.type === 'BlockStatement') {
      const directives = fn.body.directives ?? [];
      const at = directives.length > 0 ? directives.at(-1).end : fn.body.start + 1;
      edits.push({ at, text: ` ${enter} `, span: Infinity, open: true });
    } else {
      // An arrow with an expression body, such as `(x) => x ? 1 : 2`, gets a block body. The
      // body can be in parentheses, as in `() => ({ a })`, and the arrow then ends after them.
      const start = fn.body.extra?.parenthesized ? fn.body.extra.parenStart : fn.body.start;
      edits.push({ at: start, text: `{ ${enter} return (`, span: Infinity, open: true });
      edits.push({ at: fn.end, text: '); }', span: Infinity, open: false });
    }
  }
  edits.push({ at: preludeAt(text, ast), text: prelude(), span: Infinity, open: true });
  return { text: applyEdits(text, edits), conditions: found };
}

// The parts of a test: the test itself, or each part that && or || joins, all the way down.
function parts(node) {
  if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||')) return [...parts(node.left), ...parts(node.right)];
  return [node];
}

// The place after the `)` that closes a node in parentheses: the first `)` after the node's end,
// past white space and comments.
function closingParen(text, from) {
  let at = from;
  while (at < text.length) {
    if (/\s/.test(text[at])) at += 1;
    else if (text.startsWith('//', at)) at = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
    else if (text.startsWith('/*', at)) at = text.indexOf('*/', at) + 2;
    else if (text[at] === ')') return at + 1;
    else return from;
  }
  return from;
}

// The recorder goes after the directives, such as 'use strict', which must stay first, or at the
// start of the line after the `#!` line, or at the start. It adds no line, so line numbers stay.
function preludeAt(text, ast) {
  const directives = ast.program.directives ?? [];
  if (directives.length > 0) return directives.at(-1).end;
  if (!ast.program.interpreter) return 0;
  const newline = text.indexOf('\n', ast.program.interpreter.end);
  return newline === -1 ? text.length : newline + 1;
}

// Inserts each edit's text at its place. At one place, an opening text of a wider span goes first,
// and a closing text of a narrower span goes first, so nested wraps stay nested.
function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.at - a.at || order(a, b));
  let result = text;
  for (const edit of sorted) result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  return result;
}

// The edits are applied from the end, so at one place the edit applied first ends up last.
function order(a, b) {
  if (a.open !== b.open) return a.open ? -1 : 1;
  return a.open ? a.span - b.span : b.span - a.span;
}

// The recorder, as code that goes at the top of each file with recording calls. All such files in
// one process share one recorder on globalThis. At exit it adds one JSON line to the file that
// EXHIBIT_PAIRS_OUT names: each condition and each pair that the process saw. A pair
// "A=true>B=false" means that, in one call of a function, B was false after A was last true.
// The prelude must not change line numbers, so it is one line.
function prelude() {
  return `var ${RECORDER} = globalThis.${RECORDER} ??= (() => { const seen = new Set(); const out = globalThis.process?.env?.EXHIBIT_PAIRS_OUT; if (out) { const fs = globalThis.process.getBuiltinModule ? globalThis.process.getBuiltinModule('node:fs') : (typeof require === 'function' ? require('node:fs') : null); if (!fs) throw new Error('Exhibit condition-pairs: this Node has no process.getBuiltinModule, so the recorder cannot write ' + out + '. Use Node 20.16 or later.'); globalThis.process.on('exit', () => { if (seen.size > 0) fs.appendFileSync(out, JSON.stringify([...seen]) + '\\n'); }); } return { enter: () => new Map(), d: (frame, id, value) => { const v = Boolean(value); seen.add(id + '=' + v); for (const [other, was] of frame) if (other !== id) seen.add(other + '=' + was + '>' + id + '=' + v); frame.set(id, v); return value; } }; })();`.replace(/\n/g, ' ');
}

// Reads the lines that the recorder wrote, one JSON list for each process, into one Set.
export function readSeen(text) {
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    for (const entry of JSON.parse(line)) seen.add(entry);
  }
  return seen;
}

// The cases that no test tried, from the `conditions` and the `seen` entries. A case is a pair:
// under `first` with `first_value`, the condition `condition` went only one way, `value`. Each
// test that reached `condition` with `first` last `first_value` in the same call saw the same
// result. Gives back a list of { first, first_value, condition, value }.
//
// Three rules keep out pairs that are not cases a test could try:
//
// - `condition` must be inside the statement of `first`, as in `(i < 0 ? a : b) + (after ? 1 : 0)`
//   or `if (a) { if (b) ... }`. Two statements one after the other often test the same value two
//   ways, as `x > 5` and then `x > 3`. And `condition` must come after `first` in the code. In a
//   loop, a condition before `first`, such as the `if` in `do { if (k % 2 === 0) ... } while (k < n)`,
//   runs after `first` only on the next turn, so its pair with `first` mixes two turns.
// - `condition` must not repeat the code of an earlier condition whose statement holds it, as
//   `v && v.posted ? ...` written twice, or `if (missing || await found()) log(missing ? ...)`.
//   Its value comes from the earlier one: in the second, `missing` is always false when
//   `found()` ran. So it makes no new case.
// - `condition` must go both ways in some test. A condition that went one way in every test, or
//   that no test reached, is a case for mutation, which makes a mutant there (spec 9.5).
export function untried(conditions, seen) {
  const byId = new Map(conditions.map((condition) => [condition.id, condition]));
  const bothWays = (condition) => seen.has(`${condition.id}=true`) && seen.has(`${condition.id}=false`);
  const holds = (outer, inner) => inner.at >= outer.statement[0] && inner.at < outer.statement[1];
  const repeats = new Set(conditions.filter((later) => conditions.some((earlier) => earlier.file === later.file && earlier.at < later.at && earlier.code === later.code && holds(earlier, later))).map((condition) => condition.id));
  const under = new Map();
  for (const entry of seen) {
    const match = /^(.*)=(true|false)>(.*)=(true|false)$/.exec(entry);
    if (!match || !byId.has(match[1]) || !byId.has(match[3])) continue;
    const first = byId.get(match[1]), second = byId.get(match[3]);
    if (repeats.has(second.id) || !bothWays(second) || !holds(first, second) || second.at <= first.at) continue;
    const key = `${match[1]}=${match[2]}>${match[3]}`;
    if (!under.has(key)) under.set(key, { first, firstValue: match[2] === 'true', second, values: new Set() });
    under.get(key).values.add(match[4] === 'true');
  }
  return [...under.values()]
    .filter((pair) => pair.values.size === 1)
    .map((pair) => ({ first: pair.first, first_value: pair.firstValue, condition: pair.second, value: [...pair.values][0] }))
    .sort((a, b) => place(a.first) - place(b.first) || Number(a.first_value) - Number(b.first_value) || place(a.condition) - place(b.condition));
}

function place(condition) {
  return condition.line * 100000 + condition.column;
}

// One case in words, such as "relay/a.js:40 `after` is always true when `i < 0` is true. No test
// tries `after` false with `i < 0` true.".
export function describeCase(item) {
  const code = `\`${item.condition.code}\``;
  const first = `\`${item.first.code}\``;
  const firstAt = item.first.line === item.condition.line ? '' : ` (line ${item.first.line})`;
  return `${item.condition.file}:${item.condition.line} ${code} is always ${item.value} when ${first}${firstAt} is ${item.first_value}. No test tries ${code} ${!item.value} with ${first} ${item.first_value}.`;
}

function oneLine(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > CUT ? `${flat.slice(0, CUT - 3)}...` : flat;
}

// The condition-pairs collector (spec 9.14). One run serves every condition-pairs requirement
// of a check, because they have no fields that change the result.
export function conditionPairsCollector({ runTestFile = runTestFileProcess } = {}) {
  const runs = new WeakMap();
  return async (requirement, context) => {
    if (!runs.has(context)) runs.set(context, pairsRun(context, runTestFile));
    return runs.get(context);
  };
}

// 1. The changed lines are the lines that mutation uses (spec 9.5). Test files are left out, as
//    for mutation. Changed code in another language than JavaScript makes the requirement
//    skipped. No changed line of JavaScript makes it met.
// 2. In a clean worktree of the head, it runs settings.mutation_setup, and adds the recorder to
//    each changed JavaScript file (addRecorder).
// 3. It runs each test file of settings.mutation_test_files that reaches a changed file, or
//    every test file when none does, as `node FILE`, as Stryker does, half as many at once as
//    the machine has cores. A test file that fails runs once more, alone, after the others. One
//    that fails twice makes the requirement missing: its cases may not all be recorded.
// 4. untried gives the cases that no test tried. None: met. Any: missing, so a person checks.
async function pairsRun({ cwd, base, head, settings, env }, runTestFile) {
  const testGlobs = settings.mutation_test_files ?? [];
  const isTest = (path) => isTestPath(path) || testGlobs.some((glob) => matchesGlob(path, glob));
  const recorded = [];
  const other = [];
  for (const [path, lines] of await changedLines(cwd, base, head)) {
    if (isTest(path)) continue;
    if (PAIRS_FILE.test(path)) recorded.push({ path, lines });
    else if (OTHER_CODE.test(path)) other.push(path);
  }
  if (other.length > 0) {
    return result('skipped', { reason: `Exhibit can record conditions only in JavaScript files (.js, .mjs and .cjs), and this change has code in ${other.join(', ')}.`, other_code: other },
      `Exhibit cannot record the conditions in ${other.join(', ')}: it can do that only in JavaScript files (.js, .mjs and .cjs). A person must judge whether the tests try each case of the changed conditions.`);
  }
  if (recorded.length === 0) return result('met', { reason: 'The change has no added or changed lines of JavaScript outside the tests, so there is no condition to record.', conditions: [] });
  if (testGlobs.length === 0) {
    return result('missing', { reason: 'The policy has no settings.mutation_test_files.' },
      'The policy needs condition-pairs evidence, but evidence.yml does not say where the tests are. Set settings.mutation_test_files to globs of the test files, such as ["test/**/*.test.js"], and settings.mutation_setup to the command that installs what they need, such as "npm ci".');
  }

  const outDir = join(cwd, PAIRS_DIR);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const worktree = worktreeOnDemand(cwd, head);
  try {
    const root = await worktree.fresh();
    const timeoutSeconds = settings.probe_timeout_seconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;
    if (settings.mutation_setup) {
      const setup = await runInGroup(settings.mutation_setup, { cwd: root, env, logFile: join(outDir, 'setup.log'), timeoutMs: timeoutSeconds * 1000 });
      if (setup.timedOut || setup.code !== 0) {
        const why = setup.timedOut ? `ran past the time limit of ${timeoutSeconds} seconds (settings.probe_timeout_seconds)` : setup.code === null ? `was stopped by the signal ${setup.signal}` : `exited with code ${setup.code}`;
        return result('error', { reason: `settings.mutation_setup ${why}.`, setup_log: `${PAIRS_DIR}/setup.log` },
          `Exhibit ran settings.mutation_setup ("${settings.mutation_setup}") in the head worktree, and it ${why}, so the tests could not run. Read ${PAIRS_DIR}/setup.log, fix the command or the change, and run exhibit check again.`);
      }
    }

    const conditions = [];
    for (const { path, lines } of recorded) {
      const full = join(root, path);
      let added;
      try {
        added = addRecorder(await readFile(full, 'utf8'), path, lines);
      } catch (error) {
        return result('error', { reason: `Exhibit could not read the code of ${path}: ${error.message}` },
          `Exhibit could not read the code of ${path} to find its conditions (${error.message}). If the file is valid JavaScript, report it as an Exhibit issue.`);
      }
      if (added.conditions.length === 0) continue;
      await writeFile(full, added.text);
      conditions.push(...added.conditions);
    }
    if (conditions.length === 0) return result('met', { reason: 'No condition starts on a changed line inside a function, so there is no case to try.', conditions: [] });

    const allTests = (await gitFiles(root)).filter((path) => PAIRS_FILE.test(path) && testGlobs.some((glob) => matchesGlob(path, glob))).sort();
    if (allTests.length === 0) {
      return result('missing', { reason: 'No JavaScript file in the head matches settings.mutation_test_files.', conditions: plainConditions(conditions) },
        `No JavaScript file in the head commit matches settings.mutation_test_files (${testGlobs.join(', ')}), so no test can try the changed conditions. Fix the globs in evidence.yml, or add tests.`);
    }
    const reaching = await testsThatReach(root, allTests, [...new Set(conditions.map((condition) => condition.file))]);
    const testFiles = reaching.length > 0 ? reaching : allTests;
    const seenFile = join(outDir, 'seen.jsonl');
    await rm(seenFile, { force: true });
    const runEnv = { ...env, EXHIBIT_PAIRS_OUT: seenFile };
    const flaky = [];
    const failed = [];
    const firstFailed = [];
    await eachAtOnce(testFiles, Math.max(1, Math.floor(availableParallelism() / 2)), async (test, index) => {
      const first = await runTestFile({ root, test, env: runEnv, logFile: join(cwd, `${PAIRS_DIR}/test-${index + 1}.log`), timeoutSeconds });
      if (!first.passed) firstFailed.push({ test, index });
    });
    // A test that waits on a timer can fail when many test files run at once. So a failed test
    // file runs again alone, after the others are done.
    for (const { test, index } of firstFailed.sort((a, b) => a.index - b.index)) {
      const log = `${PAIRS_DIR}/test-${index + 1}-again.log`;
      const again = await runTestFile({ root, test, env: runEnv, logFile: join(cwd, log), timeoutSeconds });
      if (again.passed) flaky.push(test);
      else failed.push({ test, log, why: again.why });
    }
    const shared = { conditions: plainConditions(conditions), test_files: testFiles, test_selection: reaching.length > 0 ? 'reach' : 'all', seen: `${PAIRS_DIR}/seen.jsonl` };
    let text = '';
    try {
      text = await readFile(seenFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const cases = untried(conditions, readSeen(text));
    const listed = cases.slice(0, LISTED).map(describeCase).join(' ');
    const more = cases.length > LISTED ? ` And ${cases.length - LISTED} more, in evidence.json.` : '';
    const found = cases.length === 0 ? '' : ` No test tries ${cases.length === 1 ? 'this case' : `these ${cases.length} cases`} of the changed conditions: ${listed}${more}`;
    const details = { ...shared, untried: cases.map(plainCase) };
    // A test file that fails twice on the head is no failure of Exhibit, as a base that gives no
    // results is not (spec 9.4). But a case that it tries may be missing from the record, so a
    // person must check. The cases that the other runs left untried are still named.
    if (failed.length > 0) {
      failed.sort((a, b) => a.test.localeCompare(b.test));
      const named = failed.map((failure) => `${failure.test} (${failure.why}, ${failure.log})`).join(', ');
      return result('missing', { ...details, reason: `A test file failed twice with the recorder in the code: ${named}.`, failed: failed.map(({ test, log }) => ({ test, log })) },
        `These test files failed twice when Exhibit ran them on the head with its recorder in the changed files: ${named}. A case that they try may not be recorded, so Exhibit cannot show that the tests try every case, and a person must check.${found} Read the logs, fix the test or the code, and run exhibit check again. If the tests pass on the head without the recorder, report it as an Exhibit issue.`,
        flaky);
    }
    if (cases.length === 0) return result('met', details, undefined, flaky);
    return result('missing', details,
      `${found.trim()} Add a test for each case, or, when a case cannot happen, say why in the PR, so a person can check it.`,
      flaky);
  } finally {
    await worktree.remove();
  }
}

function result(status, details, howToFix, flaky = []) {
  return { status, details, ...(howToFix === undefined ? {} : { how_to_fix: howToFix }), flaky_tests: flaky };
}

// A case as plain data for evidence.json: the condition's file, line, column, code and the value
// it always had, and `under`, the earlier condition with its value.
function plainCase(item) {
  const where = ({ file, line, column, code }) => ({ file, line, column, code });
  return { ...where(item.condition), value: item.value, under: { ...where(item.first), value: item.first_value } };
}

// The conditions as plain data for evidence.json, without the places in the text.
function plainConditions(conditions) {
  return conditions.map(({ id, file, line, column, code }) => ({ id, file, line, column, code }));
}

// Runs `work` on each item, at most `limit` at a time.
async function eachAtOnce(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Runs one test file with `node FILE` in `root`, as Stryker's tap runner does. Gives back
// { passed, why }.
export async function runTestFileProcess({ root, test, env, logFile, timeoutSeconds }) {
  const outcome = await runInGroup(process.execPath, { cwd: root, env, logFile, timeoutMs: timeoutSeconds * 1000, args: [test] });
  if (outcome.timedOut) return { passed: false, why: `ran past the time limit of ${timeoutSeconds} seconds` };
  if (outcome.code === null) return { passed: false, why: `was stopped by the signal ${outcome.signal}` };
  return outcome.code === 0 ? { passed: true } : { passed: false, why: `exited with code ${outcome.code}` };
}

async function gitFiles(root) {
  const { stdout } = await run('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\0').filter(Boolean);
}

// The words for the condition-pairs line in summary.md.
export function describeConditionPairs(details) {
  if (typeof details.reason === 'string' && !Array.isArray(details.untried)) return ` ${details.reason}`;
  const cases = details.untried ?? [];
  const count = (details.conditions ?? []).length;
  // A test file that failed twice means that a case may be missing from the record, so the line
  // says so, also when the other runs left no case untried.
  const failed = Array.isArray(details.failed) && details.failed.length > 0
    ? ` These test files failed twice, so a case may not be recorded: ${details.failed.map((failure) => failure.test).join(', ')}.`
    : '';
  if (cases.length === 0) return failed === '' ? ` No pair of the ${count} changed conditions leaves a case that no test tries.` : `${failed}`;
  return ` ${cases.length} ${cases.length === 1 ? 'case' : 'cases'} of the ${count} changed conditions that no test tries.${failed}`;
}

export const conditionPairs = conditionPairsCollector();
