#!/usr/bin/env node
// Finds links in the docs that point to a file that is not there. evidence.yml runs it as the
// probe for the docs kind: node scripts/check-links.js README.md CLAUDE.md docs
// Each argument is a file, or a folder whose .md and .html files it reads. It checks only links
// to files in the repo. It does not check web links or anchors.
// It exits 0 when every link works, and 1 with one line for each broken link.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\b(?:href|src)="([^"]+)"/g;
const WEB = /^[a-z][a-z0-9+.-]*:/i;

// The targets of the links in a text, without the part after # or ?. Web links, mailto links
// and links to an anchor in the same page are left out.
export function linksIn(text) {
  const links = [];
  for (const match of text.matchAll(LINK)) {
    const target = (match[1] ?? match[2]).replace(/[#?].*$/, '');
    if (target !== '' && !WEB.test(target)) links.push(target);
  }
  return links;
}

function docFiles(root, paths) {
  const files = [];
  for (const path of paths) {
    const full = join(root, path);
    if (!statSync(full).isDirectory()) files.push(full);
    else for (const name of readdirSync(full, { recursive: true })) if (/\.(md|html)$/.test(name)) files.push(join(full, name));
  }
  return files.sort();
}

// One line for each link whose target is not there. A link is read from the folder of its file.
export function brokenLinks(root, paths) {
  return checkDocs(root, paths).broken;
}

function checkDocs(root, paths) {
  const files = docFiles(root, paths);
  const broken = [];
  let count = 0;
  for (const file of files) {
    for (const target of linksIn(readFileSync(file, 'utf8'))) {
      count += 1;
      if (!existsSync(join(dirname(file), target))) broken.push(`${relative(root, file)} links to ${target}, which is not there.`);
    }
  }
  return { files: files.length, links: count, broken };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, links, broken } = checkDocs(process.cwd(), process.argv.slice(2));
  if (broken.length > 0) {
    process.stderr.write(broken.map((line) => `${line}\n`).join(''));
    process.exit(1);
  }
  process.stdout.write(`Every link works: ${links} link${links === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}.\n`);
}
