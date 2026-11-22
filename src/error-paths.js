import { parse } from '@babel/parser';

// Lost error paths (spec 9.5). Mutation changes only code that is on the head, so code that a
// change removed makes no mutant. When a change takes a call out of a `try` that has a `catch`,
// the error path for that call is gone, and no mutant can stand for it: the head's tests can pass,
// and the catch rate can be met, while the call now throws where it once gave a handled result.
// Canary 3 of ticket 258 did this (docs/field/canaries.md).
//
// lostErrorPaths compares one file on the merge base and on the head. A call is "covered" when it
// is in the block of a `try` that has a `catch`, in the same function: a function written inside
// the block runs later, so the try does not cover its calls. A call is known by the names of the
// functions it is in and its code, with each run of white space as one space, so a call keeps its
// key when the change moves it or changes its indent. When the head has fewer covered calls of a
// key than the base, and has the call outside every try, each such place on the head is a lost
// error path, up to the number of covers lost. A lost call inside another lost call, such as
// `git(...)` in `Number(git(...))`, is not named apart.
//
// Gives [{ file, line, function, call }], sorted by line. A file that does not parse on the base
// or the head gives [].
export function lostErrorPaths(file, baseText, headText) {
  const base = calls(file, baseText);
  const head = calls(file, headText);
  if (!base || !head) return [];
  const coveredOnBase = tally(base.filter((call) => call.covered));
  const coveredOnHead = tally(head.filter((call) => call.covered));
  const lost = [];
  const taken = new Map();
  for (const call of head) {
    if (call.covered) continue;
    const short = (coveredOnBase.get(call.key) ?? 0) - (coveredOnHead.get(call.key) ?? 0);
    if ((taken.get(call.key) ?? 0) >= short) continue;
    taken.set(call.key, (taken.get(call.key) ?? 0) + 1);
    lost.push(call);
  }
  return lost
    .filter((call) => !lost.some((outer) => outer !== call && outer.start <= call.start && call.end <= outer.end))
    .sort((a, b) => a.start - b.start)
    .map((call) => ({ file, line: call.line, function: call.fn, call: call.code }));
}

function tally(list) {
  const counts = new Map();
  for (const { key } of list) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const CALLS = new Set(['CallExpression', 'NewExpression', 'OptionalCallExpression']);
const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'errors', 'tokens', 'comments']);

// Every call in the file, as { key, code, fn, line, start, end, covered }, or null when the file
// does not parse.
function calls(file, text) {
  let ast;
  try {
    ast = parse(text, { sourceType: 'unambiguous', plugins: plugins(file), allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true, errorRecovery: true });
  } catch {
    return null;
  }
  if (ast.errors?.length > 0) return null;
  const found = [];
  const visit = (node, names, covered, nameHere) => {
    if (!node || typeof node.type !== 'string') return;
    if (FUNCTIONS.has(node.type)) {
      const name = functionName(node) ?? nameHere;
      const inner = name ? [...names, name] : names;
      for (const key of Object.keys(node)) if (!SKIP.has(key) && key !== 'id' && key !== 'key') walk(node[key], inner, false);
      return;
    }
    if (CALLS.has(node.type)) {
      const code = text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
      const fn = names.length > 0 ? names.join('.') : '(top level)';
      found.push({ key: `${fn}\0${code}`, code: code.length > 120 ? `${code.slice(0, 117)}...` : code, fn, line: node.loc.start.line, start: node.start, end: node.end, covered });
    }
    if (node.type === 'TryStatement') {
      walk(node.block, names, covered || node.handler !== null);
      walk(node.handler, names, covered);
      walk(node.finalizer, names, covered);
      return;
    }
    // `const name = () => ...` and `name: function () {}` give the function its name.
    const named = node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' ? node.id.name
      : (node.type === 'ObjectProperty' || node.type === 'ClassProperty') && node.key?.type === 'Identifier' ? node.key.name
        : node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' ? node.left.name : null;
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const value = node[key];
      if (named && (key === 'init' || key === 'value' || key === 'right') && FUNCTIONS.has(value?.type)) visit(value, names, covered, named);
      else walk(value, names, covered);
    }
  };
  const walk = (value, names, covered) => {
    if (Array.isArray(value)) for (const item of value) visit(item, names, covered);
    else if (value && typeof value === 'object') visit(value, names, covered);
  };
  visit(ast.program, [], false);
  return found;
}

function functionName(node) {
  if (node.id?.type === 'Identifier') return node.id.name;
  if (node.key?.type === 'Identifier') return node.key.name;
  if (node.key?.type === 'PrivateName') return `#${node.key.id.name}`;
  return null;
}

function plugins(file) {
  if (/\.tsx$/.test(file)) return ['typescript', 'jsx'];
  if (/\.[mc]?ts$/.test(file)) return ['typescript'];
  return ['jsx'];
}
