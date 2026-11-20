#!/usr/bin/env node
// Checks that a release tag, package.json and exhibit --version name the same version. The release
// workflow (.github/workflows/release.yml) runs it before it makes a release, so a field repo that
// pins v0.1.0 gets an Exhibit that says it is 0.1.0 (docs/spec.md section 10, "Releases").
//
//   node scripts/check-version.js <tag> [<exhibit folder>]
//
// The folder is the Exhibit to check, by default this repo. The release workflow also runs it on
// the copy that it built the way the Action installs it. It exits 0 when all three agree, 1 with
// one line for each version that differs, and 2 without a tag.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+\.\d+\.\d+)$/;

// One line for each version that differs from the tag. A tag that is not v and three numbers,
// such as v0 or v0.1.0-rc.1, is the only problem then, because there is no version to compare.
export function versionProblems({ tag, packageVersion, cliVersion }) {
  const match = TAG.exec(tag);
  if (!match) return [`The tag ${JSON.stringify(tag)} is not a version tag such as v1.2.3.`];
  const version = match[1];
  const problems = [];
  if (packageVersion !== version) {
    problems.push(`package.json has version ${packageVersion}, but the tag is ${tag}. Set "version": "${version}" in package.json, or push the tag v${packageVersion}.`);
  }
  if (cliVersion !== version) {
    const printed = /^\S+$/.test(cliVersion) ? cliVersion : JSON.stringify(cliVersion);
    problems.push(`exhibit --version prints ${printed}, but the tag is ${tag}.`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, folder = fileURLToPath(new URL('..', import.meta.url))] = process.argv.slice(2);
  if (tag === undefined) {
    process.stderr.write('Usage: node scripts/check-version.js <tag> [<exhibit folder>]\n');
    process.exit(2);
  }
  const dir = resolve(folder);
  const packageVersion = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  const cli = spawnSync(process.execPath, [join(dir, 'bin/exhibit.js'), '--version'], { encoding: 'utf8' });
  if (cli.status !== 0) process.stderr.write(cli.stderr);
  const problems = versionProblems({ tag, packageVersion, cliVersion: cli.stdout.trim() });
  if (problems.length > 0) {
    // ::error:: makes GitHub show each line as an error on the run's page.
    process.stderr.write(problems.map((line) => `::error::${line}\n`).join(''));
    process.exit(1);
  }
  process.stdout.write(`The tag ${tag}, package.json and exhibit --version all say ${packageVersion}.\n`);
}
