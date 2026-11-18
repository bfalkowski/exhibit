#!/usr/bin/env node
// Finds keys and passwords in every line of every tracked file (git ls-files), as they are in this
// checkout. It skips binary files. CI's Secret scan job runs it with --all.
// It never prints the value it found, so the secret does not end up in a terminal or a log.
// A false alarm: put "secret-check: allow" on that line.
// Ported from Building58's .githooks/check-secrets.js.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RULES = [
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['an Anthropic or OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['a Slack token', /\bxox[abeprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe key', /\b[sr]k_live_[0-9A-Za-z]{16,}/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"$<{]{3,}@[^\s/]/i]
];
// NAME = "value" or NAME=value. The value is judged by looksReal, since most of these in code are not secrets.
const ASSIGNED = /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret)[\w-]*["']?\s*(?:=|:)\s*(["'`]?)([^\s"'`,;)]+)\1/gi;
const PLACEHOLDER = /^(pick-a-|your[-_]|my[-_]|test|fake|dummy|example|sample|changeme|change-me|placeholder|none|null|undefined|true|false|xxx|\*\*\*|<|\$|\{|%)/i;
const FILES = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|\.envrc(\.(?!example$|sample$|template$)[^/]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|p12|pfx|key|keystore)|\.npmrc|\.netrc|credentials\.json)$/i;

function looksReal(quote, value) {
  if (value.length < 8 || PLACEHOLDER.test(value)) return false;
  // Unquoted, it is usually code: process.env.X, crypto.randomBytes(16), a variable name.
  if (!quote && (/[.()[\]]/.test(value) || /^[a-z_$][\w$]*$/i.test(value))) return false;
  return true;
}

export function checkLine(line) {
  if (line.includes('secret-check: allow')) return null;
  for (const [what, re] of RULES) if (re.test(line)) return what;
  for (const m of line.matchAll(ASSIGNED)) if (looksReal(m[1], m[2])) return 'a password or key being assigned';
  return null;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Every tracked file, every line. Binary files (a NUL byte in the first 8000, as git judges) are skipped,
// and so are symlinks and submodules.
export function tracked() {
  const top = git('rev-parse', '--show-toplevel').trim();
  const found = [];
  for (const file of git('-C', top, 'ls-files', '-z').split('\0').filter(Boolean)) {
    if (FILES.test(file)) { found.push(file + ': a file that holds secrets'); continue; }
    const full = join(top, file);
    let st;
    // Deleted here, not yet committed: gone (ENOENT), or a file now stands where its folder was (ENOTDIR).
    try { st = lstatSync(full); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
    if (!st.isFile()) continue;
    const buf = readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      const what = checkLine(line);
      if (what) found.push(file + ':' + (i + 1) + ': ' + what);
    });
  }
  return found;
}

function main() {
  if (!process.argv.includes('--all')) {
    console.error('Usage: check-secrets.js --all');
    process.exit(2);
  }
  let found;
  try {
    found = tracked();
  } catch (e) {
    // Fail closed: a scan that could not read the files has not passed.
    console.error('Secret scan: could not read the tracked files. ' + String(e.stderr || e.message).trim());
    process.exit(1);
  }
  if (found.length) {
    console.error('These tracked files look like they hold a secret:\n');
    for (const f of found) console.error('  ' + f);
    console.error('\nTake it out and read it from the environment instead. It is in the history, so replace the key as well.');
    console.error('A false alarm? Add "secret-check: allow" to that line.');
    process.exit(1);
  }
  console.log('Secret scan: no secrets in the tracked files.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
