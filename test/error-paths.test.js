import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lostErrorPaths } from '../src/error-paths.js';

// Canary 3 of ticket 258 (docs/field/canaries.md), made small: Building58's unsavedWork before and
// after the change. The change moved `git rev-list` out of the try, so a checkout with no commits
// now throws, where before the catch gave a message. The try and the catch are still there, so a
// count of them would not see it.
const CANARY_BASE = `function unsavedWork(dir) {
  const git = (...args) => run(dir, args);
  try {
    if (git('status', '--porcelain')) return 'its checkout has uncommitted changes';
    const n = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes'));
    return n ? n + ' not pushed' : null;
  } catch (e) { return 'git could not say'; }
}
`;
const CANARY_HEAD = `function unsavedWork(dir) {
  const git = (...args) => run(dir, args);
  // Say which step failed.
  let status;
  try { status = git('status', '--porcelain'); } catch (e) { return 'git status failed'; }
  if (status) return 'its checkout has uncommitted changes';
  const n = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes'));
  return n ? n + ' not pushed' : null;
}
`;

test('a call that a try covered on the base, and that is outside every try on the head, is a lost error path', () => {
  assert.deepEqual(lostErrorPaths('relay/merge-hold.js', CANARY_BASE, CANARY_HEAD), [
    // Only the outer call is named: git(...) inside Number(...) lost its cover with it.
    { file: 'relay/merge-hold.js', line: 7, function: 'unsavedWork', call: "Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes'))" }
  ]);
});

test('a try and catch that the change removes leave each call they covered as a lost error path', () => {
  const base = 'export async function load(path) {\n  try {\n    return JSON.parse(await read(path));\n  } catch {\n    return null;\n  }\n}\n';
  const head = 'export async function load(path) {\n  return JSON.parse(await read(path));\n}\n';
  assert.deepEqual(lostErrorPaths('src/load.js', base, head), [
    { file: 'src/load.js', line: 2, function: 'load', call: 'JSON.parse(await read(path))' }
  ]);
});

test('a change that keeps every call under a try, adds a try, or drops the call is no lost error path', () => {
  const base = 'function a() {\n  try { f(1); } catch (e) { return 0; }\n  g();\n}\n';
  // The try moves and its code changes indent, the call stays covered.
  assert.deepEqual(lostErrorPaths('src/a.js', base, 'function a() {\n  try {\n    f(1);\n  } catch (e) {\n    return 0;\n  }\n  g();\n}\n'), []);
  // A new try around g() covers more, not less.
  assert.deepEqual(lostErrorPaths('src/a.js', base, 'function a() {\n  try { f(1); g(); } catch (e) { return 0; }\n}\n'), []);
  // f(1) is gone from the head, so nothing on the head can throw it.
  assert.deepEqual(lostErrorPaths('src/a.js', base, 'function a() {\n  g();\n}\n'), []);
  // A try with only a finally handles no error, so there was no error path to lose.
  assert.deepEqual(lostErrorPaths('src/a.js', 'function a() {\n  try { f(1); } finally { g(); }\n}\n', 'function a() {\n  f(1);\n  g();\n}\n'), []);
});

test('a call that moves to another function is matched by its function, and a function written inside a try is not covered by it', () => {
  // On the base, f() runs in a callback that the try only defines, so the try never covered it.
  const base = 'function a() {\n  try { later(() => f()); } catch (e) { return 0; }\n}\n';
  assert.deepEqual(lostErrorPaths('src/a.js', base, 'function a() {\n  later(() => f());\n}\n'), [
    { file: 'src/a.js', line: 2, function: 'a', call: 'later(() => f())' }
  ]);
  // The same call text in another function is another call.
  assert.deepEqual(lostErrorPaths('src/a.js', 'function a() {\n  try { f(); } catch (e) { return 0; }\n}\nfunction b() {\n  f();\n}\n', 'function a() {\n  try { f(); } catch (e) { return 0; }\n}\nfunction b() {\n  f();\n}\n'), []);
  // A call that was covered twice and is covered once now: one of its two places lost the cover.
  const twice = 'function a() {\n  try { f(); f(); } catch (e) { return 0; }\n}\n';
  assert.deepEqual(lostErrorPaths('src/a.js', twice, 'function a() {\n  try { f(); } catch (e) { return 0; }\n  f();\n}\n'), [
    { file: 'src/a.js', line: 3, function: 'a', call: 'f()' }
  ]);
});

test('TypeScript and JSX files are read, and a file that does not parse gives no lost error path', () => {
  const base = 'export function a(x: number): number {\n  try { return f<number>(x); } catch (e: unknown) { return 0; }\n}\n';
  const head = 'export function a(x: number): number {\n  return f<number>(x);\n}\n';
  assert.deepEqual(lostErrorPaths('src/a.ts', base, head), [{ file: 'src/a.ts', line: 2, function: 'a', call: 'f<number>(x)' }]);
  const jsxBase = 'export const A = () => {\n  try { return <b>{f()}</b>; } catch { return null; }\n};\n';
  const jsxHead = 'export const A = () => {\n  return <b>{f()}</b>;\n};\n';
  assert.deepEqual(lostErrorPaths('src/a.jsx', jsxBase, jsxHead), [{ file: 'src/a.jsx', line: 2, function: 'A', call: 'f()' }]);
  assert.deepEqual(lostErrorPaths('src/a.js', base, 'function ((( {'), []);
});
