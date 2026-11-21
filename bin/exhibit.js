#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { backtestCommand } from '../src/commands/backtest.js';
import { check } from '../src/commands/check.js';
import { history } from '../src/commands/history.js';
import { label } from '../src/commands/label.js';
import { publish } from '../src/commands/publish.js';
import { describeError, ToolError } from '../src/tool-error.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [command, ...rest] = process.argv.slice(2);

try {
  if (command === '--version' || command === '-v') {
    console.log(pkg.version);
  } else if (command === 'history') {
    await history(rest, { env: process.env, cwd: process.cwd(), fetch: globalThis.fetch, stdout: process.stdout, stderr: process.stderr });
  } else if (command === 'backtest') {
    await backtestCommand(rest, { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (command === 'label') {
    await label(rest, { cwd: process.cwd(), env: process.env, fetch: globalThis.fetch, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  } else if (command === 'check') {
    process.exitCode = await check(rest, { env: process.env, cwd: process.cwd(), fetch: globalThis.fetch, stdout: process.stdout, stderr: process.stderr });
  } else if (command === 'publish') {
    process.exitCode = await publish(rest, { cwd: process.cwd(), env: process.env, fetch: globalThis.fetch, stdout: process.stdout });
  } else {
    throw new ToolError(`unknown command ${command === undefined ? '(none)' : command}. The commands are history, label, backtest, check, publish and --version.`);
  }
} catch (error) {
  // Any failure exits 2. Node's own exit code for a throw is 1, which for exhibit check means
  // needs_person, so a bug must not reach Node.
  console.error(`exhibit: ${describeError(error)}`);
  if (command === 'check') console.error('exhibit: verdict: error');
  process.exitCode = 2;
}
