import { readFileSync } from 'node:fs';
import { checkSchema } from './json-schema.js';

const schema = JSON.parse(readFileSync(new URL('../schema/history-line.schema.json', import.meta.url), 'utf8'));

// Returns the problems with one history line, or an empty list when it passes the schema.
export function checkHistoryLine(line) {
  return checkSchema(schema, line);
}
