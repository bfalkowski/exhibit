#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { check } from '../src/commands/check.js';
import { history } from '../src/commands/history.js';
import { label } from '../src/commands/label.js';
import { ToolError } from '../src/tool-error.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [command, ...rest] = process.argv.slice(2);

try {
  if (command === '--version' || command === '-v') {
    console.log(pkg.version);
  } else if (command === 'history') {
    await history(rest, { env: process.env, cwd: process.cwd(), fetch: globalThis.fetch, stdout: process.stdout, stderr: process.stderr });
  } else if (command === 'label') {
    await label(rest, { cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  } else if (command === 'check') {
    process.exitCode = await check(rest, { env: process.env, cwd: process.cwd(), fetch: globalThis.fetch, stdout: process.stdout });
  } else {
    throw new ToolError(`unknown command ${command === undefined ? '(none)' : command}. The commands are history, label, check and --version.`);
  }
} catch (error) {
  // Any failure exits 2. Node's own exit code for a throw is 1, which for exhibit check means
  // needs_person, so a bug must not reach Node.
  if (error instanceof ToolError) {
    console.error(`exhibit: ${error.message}`);
  } else {
    console.error(`exhibit: an unexpected error, which is a bug in Exhibit:\n${error?.stack ?? error}`);
  }
  if (command === 'check') console.error('exhibit: verdict: error');
  process.exitCode = 2;
}
