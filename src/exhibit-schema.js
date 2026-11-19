import { readFileSync } from 'node:fs';
import { checkSchema } from './json-schema.js';

const schema = JSON.parse(readFileSync(new URL('../schema/exhibit.schema.json', import.meta.url), 'utf8'));

// Returns the problems with an exhibit, the content of evidence.json (spec 8.2), or an empty list
// when it passes the schema.
export function checkExhibit(exhibit) {
  return checkSchema(schema, exhibit);
}
