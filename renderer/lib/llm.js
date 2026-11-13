/**
 * The one file that talks to a language model.
 *
 * Everything else that uses a model (lib/writer.js) is handed `complete` and
 * knows nothing about who answers it, so the vendor, the model and the request
 * shape can all change here without the writing loop or its tests moving. That
 * is the same shape as the rest of this POC: a thing attaches, and what it
 * attaches to does not learn its name.
 *
 * It is optional, and has to stay that way. With no credential in the
 * environment `available()` is false, `/health` says so, the CCR offers nobody
 * a button, and every beat of the demo runs exactly as it did before this file
 * existed. The five-beat rehearsal must never need a key or a network.
 *
 * The credential is read from the environment by the SDK — `ANTHROPIC_API_KEY`,
 * which `./demo.sh start` loads from a gitignored `renderer/.env` when there is
 * one. It is never sent to, stored in or configured through Drupal.
 */
const Anthropic = require('@anthropic-ai/sdk');

// The request below is written for this model: `effort` and `fallbacks` are not
// accepted by every model, so changing this may mean changing that.
const MODEL = process.env.CCR_AI_MODEL || 'claude-opus-5';

const SETUP =
  'The writing assistant is not set up on this machine. Put ANTHROPIC_API_KEY in renderer/.env ' +
  '(see renderer/.env.example) and restart with ./demo.sh start.';

/** An answer for the editor rather than a stack trace: `message` is shown as is. */
class LlmError extends Error {}

const available = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client;
const anthropic = () => (client ??= new Anthropic());

// One short string back. Structured output rather than "reply with only the
// text", because a model asked for only the text will sometimes lead with
// "Here is a shorter version:", and that sentence would be measured as copy.
const ANSWER = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The rewritten copy, and nothing else.' } },
  required: ['text'],
  additionalProperties: false,
};

/**
 * @param {object} prompt
 * @param {string} prompt.system
 * @param {string} prompt.user
 * @param {object} [prompt.schema]   a JSON schema for the whole answer. Without
 *   one the answer is a single string (`ANSWER`), which is what "Shorten to
 *   fit" asks for; with one it is the parsed object, which is what drafting a
 *   whole slide or page asks for.
 * @param {string} [prompt.effort]   `low` for one line; drafting a whole
 *   channel from source material is worth more thought.
 * @param {number} [prompt.timeoutMs]
 * @returns {Promise<string|object>} the model's text, or the parsed object
 * @throws {LlmError} with a sentence the editor can be shown
 */
async function complete({ system, user, schema, effort = 'low', timeoutMs = 30_000 }) {
  if (!available()) throw new LlmError(SETUP);

  let response;
  try {
    response = await anthropic().beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: user }],
        // Shortening a sentence is a small job and somebody is waiting on a
        // button; `low` keeps the thinking proportionate to it. The caller
        // says so, because drafting a whole slide is not a small job.
        output_config: { effort, format: { type: 'json_schema', schema: schema || ANSWER } },
        // If a safety classifier declines the request, the API re-runs it on the
        // model Anthropic recommends for that case instead of handing the
        // refusal back. Marketing copy should never trip one; a false positive
        // in front of the CEO is the case this is here for.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      // The SDK's default is ten minutes, which is not a wait anyone sits
      // through on a form. The writer asks up to three times, so this bounds
      // one ask, not the whole button.
      { timeout: timeoutMs, maxRetries: 1 }
    );
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new LlmError('The writing assistant\'s API key was not accepted. Check ANTHROPIC_API_KEY in renderer/.env.');
    }
    if (e instanceof Anthropic.RateLimitError) {
      throw new LlmError('The writing assistant is being rate limited. Try again in a moment.');
    }
    if (e instanceof Anthropic.APIConnectionError) {
      // Includes timeouts. This POC runs on a laptop with no promise of a network.
      throw new LlmError('The writing assistant could not be reached. Check the network and try again.');
    }
    if (e instanceof Anthropic.APIError) {
      throw new LlmError(`The writing assistant returned an error (${e.status}): ${e.message}`);
    }
    throw e;
  }

  // A refusal is a 200 with nothing usable in it, so this comes before content.
  if (response.stop_reason === 'refusal') {
    throw new LlmError('The writing assistant declined to rewrite this text.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new LlmError('The writing assistant ran out of room before answering. Try again.');
  }

  const block = response.content.find((b) => b.type === 'text');
  try {
    const parsed = JSON.parse(block.text);
    return schema ? parsed : parsed.text;
  } catch {
    throw new LlmError('The writing assistant answered in a shape this renderer could not read.');
  }
}

module.exports = { complete, available, LlmError, MODEL, SETUP };
