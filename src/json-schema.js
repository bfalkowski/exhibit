// A small JSON Schema checker for the keywords Exhibit's schemas use. A schema that uses any other
// keyword makes it throw, so a rule is never skipped without anyone knowing.
const NOTES = new Set(['$schema', '$id', 'title', 'description']);
const RULES = new Set([
  'type', 'enum', 'required', 'properties', 'additionalProperties', 'minProperties', 'maxProperties',
  'items', 'minItems', 'minimum', 'maximum', 'minLength', 'pattern', 'if', 'then', 'else'
]);

// Returns a list of problems, each as "<where>: <what>". An empty list means the value passes.
export function checkSchema(schema, value, where = '/') {
  const start = where === '/' ? [] : where.split('/').slice(1);
  return schemaProblems(schema, value, start).map(({ path, what }) => `${path.length === 0 ? '/' : `/${path.join('/')}`}: ${what}`);
}

// Returns a list of problems, each as { path, what }. `path` is the list of keys and list places
// from the top of the value down to the bad part, such as ['kinds', 'relay-core', 'risk'].
// An empty list means the value passes.
export function schemaProblems(schema, value, path = []) {
  for (const key of Object.keys(schema)) {
    if (!NOTES.has(key) && !RULES.has(key)) throw new Error(`json-schema: the keyword ${key} is not supported`);
  }
  const problems = [];
  const add = (what) => problems.push({ path, what });

  if (schema.if !== undefined) {
    const branch = schemaProblems(schema.if, value, path).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) problems.push(...schemaProblems(branch, value, path));
  }
  if (schema.type !== undefined) {
    const allowed = [schema.type].flat();
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) return [...problems, { path, what: `must be ${allowed.join(' or ')}, not ${actual}` }];
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => item === value)) {
    add(`must be ${words(schema.enum)}, not ${shown(value)}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    add(`must be at least ${schema.minimum}`);
  }
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
    add(`must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    add(`must have at least ${schema.minLength} ${schema.minLength === 1 ? 'character' : 'characters'}`);
  }
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    add(`does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.minItems !== undefined && value.length < schema.minItems) {
    add(`must have at least ${schema.minItems} ${schema.minItems === 1 ? 'item' : 'items'}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...schemaProblems(schema.items, item, [...path, i])));
  }
  if (typeOf(value) === 'object') {
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) add(`must have at least ${schema.minProperties} ${schema.minProperties === 1 ? 'field' : 'fields'}`);
    if (schema.maxProperties !== undefined && count > schema.maxProperties) add(`must have at most ${schema.maxProperties} ${schema.maxProperties === 1 ? 'field' : 'fields'}, not ${count}`);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) add(`misses the field ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) problems.push(...schemaProblems(properties[key], item, [...path, key]));
      else if (schema.additionalProperties === false) add(`has a field the schema does not allow: ${key}`);
      else if (typeOf(schema.additionalProperties) === 'object') problems.push(...schemaProblems(schema.additionalProperties, item, [...path, key]));
    }
  }
  return problems;
}

// JSON.stringify turns NaN and infinity into null, so name them here.
function shown(value) {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
}

// ['low', 'medium', 'high'] → "low, medium or high". A null in the list is left out: it stands
// for a key with nothing after it, which a person does not need to be told about.
function words(list) {
  const shown = list.filter((item) => item !== null).map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} or ${shown.at(-1)}`;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  // YAML can give NaN (.nan) and infinity (.inf). Compares with NaN are always false, so a range
  // check would let it through. Neither is a number a schema means.
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity || value === -Infinity) return 'infinity';
  return typeof value;
}
