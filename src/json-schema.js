// A small JSON Schema checker for the keywords Exhibit's schemas use. A schema that uses any other
// keyword makes it throw, so a rule is never skipped without anyone knowing.
const NOTES = new Set(['$schema', '$id', 'title', 'description']);
const RULES = new Set(['type', 'required', 'properties', 'additionalProperties', 'items', 'minimum', 'maximum', 'pattern']);

// Returns a list of problems, each as "<where>: <what>". An empty list means the value passes.
export function checkSchema(schema, value, where = '/') {
  for (const key of Object.keys(schema)) {
    if (!NOTES.has(key) && !RULES.has(key)) throw new Error(`json-schema: the keyword ${key} is not supported`);
  }
  const problems = [];
  const at = (part) => (where === '/' ? `/${part}` : `${where}/${part}`);

  if (schema.type !== undefined) {
    const allowed = [schema.type].flat();
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) return [`${where}: must be ${allowed.join(' or ')}, not ${actual}`];
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    problems.push(`${where}: must be at least ${schema.minimum}`);
  }
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
    problems.push(`${where}: must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    problems.push(`${where}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...checkSchema(schema.items, item, at(i))));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${where}: misses the field ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) problems.push(...checkSchema(properties[key], item, at(key)));
      else if (schema.additionalProperties === false) problems.push(`${where}: has a field the schema does not allow: ${key}`);
    }
  }
  return problems;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
