import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, DraftError, createDrafter } from '../src/claude.js';
import { replayFetch } from '../test-support/replay-fetch.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/anthropic/${name}.json`, import.meta.url));

// What exhibit label gives the drafter for one defect: what the person reads.
const defect = {
  id: 'D-012',
  title: 'Fix discount math',
  body: 'The discount took 10 off, not 10%.',
  text: 'Fix PR 12: Fix discount math\nIntroducing PR 1: Add cart subtotal, confidence 50%\n  src/cart.js:4  return total - discount;\n',
  categories: ['state', 'arithmetic']
};

// A drafter that reads recorded replies, and the request bodies it sent.
function recorded(name, options = {}) {
  const fetch = replayFetch(fixture(name));
  const bodies = [];
  const spy = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return fetch(url, init);
  };
  return { draft: createDrafter({ apiKey: 'test-key', fetch: spy, maxRetries: 0, ...options }), bodies };
}

test('a draft gives a code and a category, with the model that wrote it', async () => {
  const { draft } = recorded('draft');
  assert.deepEqual(await draft(defect), { code: 'Count ignored the quantity', category: 'arithmetic', model: DEFAULT_MODEL });
});

test('Claude reads the PR title and body, the defect text and the categories used so far', async () => {
  const { draft, bodies } = recorded('draft');
  await draft(defect);
  const [body] = bodies;
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.output_config.format.type, 'json_schema');
  const prompt = body.messages[0].content;
  for (const part of [defect.title, defect.body, defect.text, '- state', '- arithmetic']) assert.ok(prompt.includes(part), part);
});

test('the request tells Claude the length limits of the labels schema', async () => {
  const { draft, bodies } = recorded('draft');
  await draft(defect);
  const { properties } = bodies[0].output_config.format.schema;
  assert.match(properties.code.description, /at most 200 characters/);
  assert.match(properties.category.description, /at most 60 characters/);
});

test('the model is a setting', async () => {
  const { draft, bodies } = recorded('draft', { model: 'claude-sonnet-5-5' });
  assert.equal((await draft(defect)).model, 'claude-sonnet-5-5');
  assert.equal(bodies[0].model, 'claude-sonnet-5-5');
});

test('an API error is a DraftError with a plain message', async () => {
  const { draft } = recorded('server-error');
  await assert.rejects(draft(defect), (error) => {
    assert.ok(error instanceof DraftError);
    assert.match(error.message, /^the Anthropic API answered 529/);
    return true;
  });
});

test('a bad key or a wrong model is a DraftError that stops drafting, and says what to fix', async () => {
  await assert.rejects(recorded('bad-key').draft(defect), (error) => error instanceof DraftError && /^the Anthropic API answered 401: invalid x-api-key$/.test(error.message) && /ANTHROPIC_API_KEY/.test(error.stopsDrafting));
  await assert.rejects(recorded('no-permission').draft(defect), (error) => error instanceof DraftError && /answered 403/.test(error.message) && /ANTHROPIC_API_KEY/.test(error.stopsDrafting));
  await assert.rejects(recorded('bad-model').draft(defect), (error) => error instanceof DraftError && /answered 404/.test(error.message) && /EXHIBIT_CLAUDE_MODEL/.test(error.stopsDrafting));
  // An overloaded API can work on the next defect, so it does not stop drafting.
  await assert.rejects(recorded('server-error').draft(defect), (error) => error instanceof DraftError && error.stopsDrafting === null);
});

test('a refusal is a DraftError', async () => {
  await assert.rejects(recorded('refusal').draft(defect), (error) => error instanceof DraftError && /declined/.test(error.message));
});

test('a draft that does not fit the labels schema is a DraftError, so a person never confirms a line that cannot be written', async () => {
  await assert.rejects(recorded('too-long').draft(defect), (error) => error instanceof DraftError && /code/.test(error.message));
});

test('a draft category of only digits is a DraftError, because the category question reads digits as a pick from the list', async () => {
  await assert.rejects(recorded('digits-category').draft(defect), (error) => {
    assert.ok(error instanceof DraftError);
    assert.equal(error.message, 'Claude\'s draft category "5" is only digits, and a category cannot be only digits');
    assert.equal(error.stopsDrafting, null);
    return true;
  });
});
