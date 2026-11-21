import { parse } from '@babel/parser';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInGroup } from './probe.js';

// Twin values (spec 9.5). Stryker has no mutator that puts one name in place of another. So when
// a change reads the wrong name, and each test picks inputs where the wrong name and the right
// value are equal, every mutant still dies, and the catch rate is met. Canary 5 of ticket 258
// did this: `daysLeft` counted from the window's first day, `from`, where it meant today, and
// each test asked on a first day, where `from[2]` and `date.d` are equal.
//
// So Exhibit runs the test files that reach the changed files once more, with
// src/twin-capture.cjs, which records the values in scope each time a test runs a changed line.
// Two values are twins on a line when the line names one of them and not the other, both took the
// same value each time the tests ran the line, and that value changed at least once. No test can
// then tell the two apart there: a mutant that put one name in place of the other would survive.
//
// Code often copies a value under a new name, and then the two are equal on purpose. So the
// value that the line does not name must come from an input: a parameter of a function around
// the line, or a field of one. And the name that the line reads must not be set straight from
// that input, as in `const ms = Number(w.inMs)` (inputsAndCopies).

const CAPTURE = fileURLToPath(new URL('./twin-capture.cjs', import.meta.url));
// The files the capture reads: JavaScript that node runs as it is. TypeScript and JSX are
// changed by a build step, so their lines do not match the file.
export const TWIN_FILE = /\.(js|mjs|cjs)$/;
// The pauses on one line in one test file that are recorded, at most.
const MAX_HITS = 200;
// The twins that one line gives, at most, and the values shown for each.
const SHOWN_VALUES = 3;

// The paths that the text of a line names: each name, and each name with its first field, as
// `a`, `a.b` or `a[2]`. A name after a dot is a field of something else, so it is not a name on
// its own. Names in strings and comments count too, so a line names more than it uses: that only
// leaves twins out.
export function namedPaths(text) {
  const paths = new Set();
  const pattern = /(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)|\s*\[\s*(\d+)\s*\])?/g;
  for (const match of text.matchAll(pattern)) {
    paths.add(match[1]);
    if (match[2] !== undefined) paths.add(`${match[1]}.${match[2]}`);
    if (match[3] !== undefined) paths.add(`${match[1]}[${match[3]}]`);
  }
  return paths;
}

// The last name of a path: `b` for `a.b` and for `b`, and null for `a[2]`.
function lastName(path) {
  if (path.endsWith(']')) return null;
  return path.slice(path.lastIndexOf('.') + 1);
}

// The twins of one line, from its `samples` (one { path: value } for each time a test ran it) and
// its `text`. Gives [{ used, twins, values }]: a path that the line names, the paths it was equal
// to each time without the line naming them, and up to SHOWN_VALUES of the values it took.
//
// A pair is left out when both paths end in the same name, as `count` and `opts.count`, or `y`
// in `t.y` and `date.y`: code often copies a value to a name of the same meaning, so the two are
// equal on purpose.
export function lineTwins(samples, text) {
  if (samples.length < 2) return [];
  const named = namedPaths(text);
  const common = Object.keys(samples[0]).filter((path) => samples.every((sample) => Object.hasOwn(sample, path)));
  const found = [];
  for (const used of common.filter((path) => named.has(path)).sort()) {
    const values = [...new Set(samples.map((sample) => sample[used]))];
    if (values.length < 2) continue;
    const twins = common.filter((other) => other !== used && !named.has(other) && (lastName(other) === null || lastName(other) !== lastName(used))
      && samples.every((sample) => sample[other] === sample[used])).sort();
    if (twins.length > 0) found.push({ used, twins, values: values.slice(0, SHOWN_VALUES) });
  }
  return found;
}

// The names of each path's first part: `a` for `a`, `a.b` and `a[2]`.
function baseName(path) {
  return /^[^.[]+/.exec(path)[0];
}

// What the code around `line` of a file says about twins: `inputs`, the parameters of each
// function around the line, and `copies`, a Map from each name that a declaration or an
// assignment in the file sets to the names its value names. Gives null when the file does not
// parse, so no twin is left out.
export function inputsAndCopies(text, line) {
  let ast;
  try {
    ast = parse(text, { sourceType: 'unambiguous', plugins: ['jsx'], errorRecovery: true, allowReturnOutsideFunction: true });
  } catch {
    return null;
  }
  const inputs = new Set();
  const copies = new Map();
  const copy = (target, value) => {
    const named = namesIn(value);
    for (const name of patternNames(target)) {
      if (!copies.has(name)) copies.set(name, new Set());
      for (const other of named) copies.get(name).add(other);
    }
  };
  walk(ast.program, (node) => {
    if (FUNCTIONS.has(node.type) && node.loc.start.line <= line && line <= node.loc.end.line) {
      for (const param of node.params) for (const name of patternNames(param)) inputs.add(name);
    }
    if (node.type === 'VariableDeclarator' && node.init) copy(node.id, node.init);
    if (node.type === 'AssignmentExpression') copy(node.left, node.right);
    if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.left.type === 'VariableDeclaration') {
      for (const declarator of node.left.declarations) copy(declarator.id, node.right);
    }
  });
  return { inputs, copies };
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

// The names that a parameter or a declaration's target binds, as `a`, `b` and `c` in
// `{ a, b: [b], ...c }`.
function patternNames(node) {
  if (!node) return [];
  switch (node.type) {
    case 'Identifier': return [node.name];
    case 'AssignmentPattern': return patternNames(node.left);
    case 'RestElement': return patternNames(node.argument);
    case 'ArrayPattern': return node.elements.flatMap(patternNames);
    case 'ObjectPattern': return node.properties.flatMap((property) => patternNames(property.type === 'RestElement' ? property : property.value));
    default: return [];
  }
}

// The names that an expression reads. A field name after a dot is not a name.
function namesIn(node) {
  const names = new Set();
  walk(node, (inner) => {
    if (inner.type === 'Identifier') names.add(inner.name);
  });
  walk(node, (inner) => {
    if ((inner.type === 'MemberExpression' || inner.type === 'OptionalMemberExpression') && !inner.computed && inner.property.type === 'Identifier' && !(inner.object.type === 'Identifier' && inner.object.name === inner.property.name)) names.delete(inner.property.name);
  });
  return names;
}

// Keeps the twins that the code around the line allows (inputsAndCopies): a twin must come from
// an input, and the name that the line reads must not be set straight from it.
export function keepTwins(found, code) {
  if (!code) return found;
  return found.flatMap((twin) => {
    const copied = code.copies.get(baseName(twin.used)) ?? new Set();
    const twins = twin.twins.filter((other) => code.inputs.has(baseName(other)) && !copied.has(baseName(other)));
    return twins.length > 0 ? [{ ...twin, twins }] : [];
  });
}

// The twin values of a run, from what the capture recorded (`recorded`, a list of each test
// file's records) and the changed lines: `files` is [{ path, lines: [[first, last]] }], with the
// text of each file in `texts`, and `urlToPath` gives a file's repo path from a debugger URL.
// Gives [{ file, line, line_text, used, twins, values }], sorted.
export function twinValues(recorded, files, texts, urlToPath) {
  const changed = new Map(files.map(({ path, lines }) => [path, lines]));
  const byLine = new Map();
  for (const record of recorded.flat()) {
    const file = urlToPath(record.url);
    const ranges = changed.get(file);
    if (!ranges || !ranges.some(([first, last]) => record.line >= first && record.line <= last)) continue;
    const key = `${file}\n${record.line}`;
    if (!byLine.has(key)) byLine.set(key, { file, line: record.line, samples: [] });
    byLine.get(key).samples.push(...record.samples);
  }
  const found = [];
  for (const { file, line, samples } of byLine.values()) {
    const text = texts.get(file)?.[line - 1] ?? '';
    const code = inputsAndCopies((texts.get(file) ?? []).join('\n'), line);
    for (const twin of keepTwins(lineTwins(samples, text), code)) found.push({ file, line, line_text: text.replace(/\s+/g, ' ').trim().slice(0, 120), ...twin });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.used.localeCompare(b.used));
}

// Runs each of `testFiles` with the capture, in `root`, and gives the twin values of the changed
// JavaScript lines in `files` ([{ path, lines }]). Each test file runs as `node FILE`, as
// Stryker's tap runner runs it, with half the cores at once. Its output goes to a log in
// `logDir`. The whole pass stops when `budgetMs` runs out: a test file still running then is
// killed, and one not started does not start. A test file that fails still gives what it
// recorded. One that is killed gives nothing, so it can only hide twins.
export async function runTwinsProcess({ root, files, testFiles, env, budgetMs, logDir }) {
  const deadline = Date.now() + budgetMs;
  const jsFiles = files.filter((file) => TWIN_FILE.test(file.path));
  if (jsFiles.length === 0 || testFiles.length === 0) return [];
  const roots = [...new Set([root, await realpath(root)])];
  await rm(logDir, { recursive: true, force: true });
  await mkdir(logDir, { recursive: true });
  const plans = jsFiles.map(({ path, lines }) => ({
    urls: roots.flatMap((top) => [join(top, path), pathToFileURL(join(top, path)).href]),
    lines: lines.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i))
  }));
  const recorded = [];
  const queue = testFiles.map((test, i) => ({ test, i }));
  const worker = async () => {
    for (let next = queue.shift(); next && Date.now() < deadline; next = queue.shift()) {
      const name = next.test.replaceAll('/', '-');
      const out = join(logDir, `${name}.json`);
      const planFile = join(logDir, `${name}.plan.json`);
      await writeFile(planFile, JSON.stringify({ files: plans, out, maxHits: MAX_HITS }));
      await runInGroup(process.execPath, { args: ['--require', CAPTURE, next.test], cwd: root, env: { ...env, EXHIBIT_TWIN_PLAN: planFile }, logFile: join(logDir, `${name}.log`), timeoutMs: Math.max(1, deadline - Date.now()) });
      recorded[next.i] = await readFile(out, 'utf8').then(JSON.parse, () => []);
      await rm(planFile, { force: true });
      await rm(out, { force: true });
    }
  };
  const slots = Math.max(1, Math.floor(cpus().length / 2));
  await Promise.all(Array.from({ length: Math.min(slots, testFiles.length) }, worker));
  const texts = new Map();
  for (const { path } of jsFiles) texts.set(path, await readFile(join(root, path), 'utf8').then((text) => text.split('\n'), () => []));
  const urlToPath = (url) => {
    const full = url.startsWith('file:') ? fileURLToPath(url) : url;
    for (const top of roots) if (full.startsWith(`${top}/`)) return full.slice(top.length + 1);
    return full;
  };
  return twinValues(recorded.filter(Boolean), jsFiles, texts, urlToPath);
}
