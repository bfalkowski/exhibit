// Claude drafts a code and a category for an escaped defect (spec 9.11). Every request to
// Anthropic's API goes through this module. exhibit label --claude shows the draft to the person,
// who confirms it, edits it, or throws it away. A draft is never a label by itself.
import Anthropic from '@anthropic-ai/sdk';
import { checkSchema } from './json-schema.js';
import { ANSWER_LIMITS, labelsSchema } from './labels-schema.js';

// The model that drafts, when EXHIBIT_CLAUDE_MODEL does not name another one.
export const DEFAULT_MODEL = 'claude-opus-5-5';

// The draft could not be made: the API failed, Claude declined, or the draft did not fit the
// labels schema. The message is plain, so exhibit label can show it and go on by hand.
// `stopsDrafting` is null, or what the person must fix when no later draft can work either: a bad
// key or a wrong model. exhibit label then stops drafting for the rest of the run.
export class DraftError extends Error {
  name = 'DraftError';

  constructor(message, { stopsDrafting = null } = {}) {
    super(message);
    this.stopsDrafting = stopsDrafting;
  }
}

// The API replies that every later request would get too, and what the person must fix for each.
const STOPS_DRAFTING = {
  401: 'Check ANTHROPIC_API_KEY.',
  403: 'Check ANTHROPIC_API_KEY.',
  404: 'Check that EXHIBIT_CLAUDE_MODEL names a model.'
};

// The rules of `code` and `category`, read from schema/labels-line.schema.json, so the limits
// have one copy.
const DRAFT_SCHEMA = {
  type: 'object',
  required: ['code', 'category'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', pattern: labelsSchema.properties.code.pattern },
    category: { type: 'string', pattern: labelsSchema.properties.category.pattern }
  }
};

// The schema Claude's answer must follow. Structured outputs do not take `pattern`, so the
// lengths are said in the descriptions, from the same patterns, and checked with DRAFT_SCHEMA
// afterwards.
const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['code', 'category'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', description: `What went wrong, in a few plain words. One line, at most ${ANSWER_LIMITS.code} characters.` },
    category: { type: 'string', description: `The kind of bug. Reuse a category used so far when one fits. One line, at most ${ANSWER_LIMITS.category} characters.` }
  }
};

const SYSTEM = [
  'You help a person label escaped defects: bugs that a merged pull request let through, which a later fix PR repaired.',
  'For one defect you see the fix PR, and the lines it changed with what git blame says about each one. SZZ linked those lines to the PRs that brought the bug. SZZ can be wrong.',
  'Draft two things. code: what went wrong, in a few plain words, about the bug and not the fix. category: the kind of bug, as a short noun phrase.',
  'Reuse a category from the list of categories used so far when one fits, written exactly as it is in the list. Make a new one only when none fits.',
  'The person reads your draft, then keeps it, edits it, or throws it away.'
].join(' ');

/**
 * Returns `draft({ id, title, body, text, categories })`, which asks Claude for a draft and
 * returns { code, category, model }, or throws a DraftError.
 *
 * `fetch` is passed in, so tests replay recorded replies and never use the network.
 */
export function createDrafter({ apiKey, model = DEFAULT_MODEL, fetch = globalThis.fetch, maxRetries = 2 }) {
  const client = new Anthropic({ apiKey, fetch, maxRetries });
  return async function draft({ id, title, body, text, categories }) {
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 2000,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt({ id, title, body, text, categories }) }]
      });
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionError) throw new DraftError(`could not reach the Anthropic API: ${error.message}`);
      if (error instanceof Anthropic.APIError) throw new DraftError(`the Anthropic API answered ${error.status}: ${apiMessage(error)}`, { stopsDrafting: STOPS_DRAFTING[error.status] ?? null });
      throw error;
    }
    if (response.stop_reason === 'refusal') throw new DraftError('Claude declined to draft this defect');
    if (response.stop_reason === 'max_tokens') throw new DraftError('Claude\'s draft was cut short');
    const answer = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(answer);
    } catch {
      throw new DraftError('Claude\'s draft was not JSON');
    }
    const problems = checkSchema(DRAFT_SCHEMA, parsed);
    if (problems.length > 0) throw new DraftError(`Claude's draft does not fit the labels schema: ${problems[0]}`);
    // exhibit label reads a category answer of only digits as a pick from the list (spec 8.4). So
    // a saved category "5" would show as "1. 5", and typing 5 would not pick it.
    if (/^\d+$/.test(parsed.category)) throw new DraftError(`Claude's draft category "${parsed.category}" is only digits, and a category cannot be only digits`);
    return { code: parsed.code, category: parsed.category, model };
  };
}

function prompt({ id, title, body, text, categories }) {
  const used = categories.length === 0 ? 'None yet.' : categories.map((name) => `- ${name}`).join('\n');
  return [
    `Escaped defect ${id}.`,
    `Fix PR title: ${title}`,
    `Fix PR body:\n${body === null || body.trim() === '' ? '(empty)' : body}`,
    `The defect, as the person sees it:\n${text}`,
    `Categories used so far:\n${used}`
  ].join('\n\n');
}

// The API's own message from an error reply, such as "Overloaded", without the JSON around it.
function apiMessage(error) {
  return error.error?.error?.message ?? error.message;
}
