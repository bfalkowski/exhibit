#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
  } else {
    throw new ToolError(`unknown command ${command === undefined ? '(none)' : command}. The commands are history, label and --version.`);
  }
} catch (error) {
  if (!(error instanceof ToolError)) throw error;
  console.error(`exhibit: ${error.message}`);
  process.exitCode = 2;
}
