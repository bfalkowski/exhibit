// Records the values in scope each time a test runs a changed line (spec 9.5, twin values).
//
// Exhibit starts a test file as `node --require src/twin-capture.cjs FILE`. This file reads its
// plan from the file that EXHIBIT_TWIN_PLAN names: { files: [{ urls, lines }], out, maxHits }.
// It opens an inspector session in the test's own thread, and sets a breakpoint on each changed
// line. When the test reaches one, the debugger pauses, and this file reads every name in the
// scopes of the paused function, apart from the global one. It keeps each number and each
// string, and one level into each object or array, as `name.field` or `name[2]`. Then it lets
// the test go on. When the process exits, it writes what it saw to `out` as JSON:
// [{ url, line, samples: [{ path: value }] }].
//
// A session in the same thread gets its replies at once, inside the pause, so the values are the
// ones of that moment. A line stops being recorded after maxHits pauses, so a hot loop does not
// make the test slow.
'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const inspector = require('node:inspector');
const process = require('node:process');

const plan = JSON.parse(readFileSync(process.env.EXHIBIT_TWIN_PLAN, 'utf8'));
// Keeps a long string out of the record: it says little, and makes the file big.
const LONGEST = 200;
// The fields of one object or array that are read, at most.
const FIELDS = 50;

const session = new inspector.Session();
session.connect();
function post(method, params) {
  let failure = null;
  let reply = null;
  session.post(method, params, (error, result) => {
    failure = error;
    reply = result;
  });
  if (failure) throw failure;
  return reply;
}

function plain(value) {
  if (!value) return undefined;
  if (value.type === 'number' && typeof value.value === 'number') return value.value;
  if (value.type === 'string' && value.value.length <= LONGEST) return value.value;
  return undefined;
}

function record(frame) {
  const values = {};
  for (const scope of frame.scopeChain) {
    if (scope.type === 'global') continue;
    for (const property of post('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true }).result) {
      const { name, value } = property;
      // An inner scope hides a name of an outer one.
      if (Object.hasOwn(values, name) || Object.hasOwn(values, `\0${name}`)) continue;
      values[`\0${name}`] = true;
      const own = plain(value);
      if (own !== undefined) values[name] = own;
      else if (value?.type === 'object' && value.objectId && value.subtype !== 'null') {
        const fields = post('Runtime.getProperties', { objectId: value.objectId, ownProperties: true }).result;
        for (const field of fields.slice(0, FIELDS)) {
          const inner = plain(field.value);
          if (inner === undefined || field.name === 'length') continue;
          values[/^\d+$/.test(field.name) ? `${name}[${field.name}]` : `${name}.${field.name}`] = inner;
        }
      }
    }
  }
  for (const key of Object.keys(values)) if (key.startsWith('\0')) delete values[key];
  return values;
}

// The URL of each script, by its id: a paused frame names its script only by the id.
const urls = new Map();
session.on('Debugger.scriptParsed', ({ params }) => urls.set(params.scriptId, params.url));
const seen = new Map();
const hits = new Map();
session.on('Debugger.paused', ({ params }) => {
  try {
    const frame = params.callFrames[0];
    const line = frame.location.lineNumber + 1;
    const url = urls.get(frame.location.scriptId) ?? '';
    const key = `${url}\n${line}`;
    if (!seen.has(key)) seen.set(key, { url, line, samples: [] });
    seen.get(key).samples.push(record(frame));
    for (const id of params.hitBreakpoints ?? []) {
      const count = (hits.get(id) ?? 0) + 1;
      hits.set(id, count);
      if (count >= plan.maxHits) post('Debugger.removeBreakpoint', { breakpointId: id });
    }
  } catch {
    // A value that cannot be read is left out. The test must go on whatever happens here.
  } finally {
    post('Debugger.resume');
  }
});

post('Debugger.enable');
for (const { urls, lines } of plan.files) {
  for (const url of urls) {
    for (const line of lines) {
      try {
        post('Debugger.setBreakpointByUrl', { url, lineNumber: line - 1 });
      } catch {
        // Two lines can resolve to one place. The first breakpoint there is enough.
      }
    }
  }
}

process.on('exit', () => {
  writeFileSync(plan.out, JSON.stringify([...seen.values()]));
});
