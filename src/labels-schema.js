// The labels schema (schema/labels-line.schema.json) and the length limits in its patterns. Both
// src/labels.js and src/claude.js read them from here, so each limit has one copy.
import { readFileSync } from 'node:fs';

export const labelsSchema = JSON.parse(readFileSync(new URL('../schema/labels-line.schema.json', import.meta.url), 'utf8'));

// The most characters that each typed answer can have. They come from the schema's patterns,
// such as ^\S[^\r\n]{0,199}$ for code, so the keyboard can ask again before the schema check.
export const ANSWER_LIMITS = Object.fromEntries(['code', 'category', 'would_have_caught'].map((field) => [field, longest(labelsSchema.properties[field].pattern)]));

// A pattern that ends in {0,n}$ allows one first character and then at most n more: n + 1 in all.
function longest(pattern) {
  const match = /\{0,(\d+)\}\$$/.exec(pattern);
  if (match === null) throw new Error(`the labels schema pattern ${pattern} has no length limit`);
  return Number(match[1]) + 1;
}
