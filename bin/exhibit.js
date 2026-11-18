#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [arg] = process.argv.slice(2);

if (arg === '--version' || arg === '-v') {
  console.log(pkg.version);
} else {
  console.error(`exhibit: unknown command ${arg === undefined ? '(none)' : arg}. Only --version exists yet.`);
  process.exitCode = 2;
}
