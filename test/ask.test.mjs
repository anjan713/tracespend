// Answering, end to end, at the app seam. The model endpoint is replaced by a
// stubbed fetch returning canned chat-completions responses, so these run with no
// key, no network, and no cost. Nothing here asserts on prompts, on the shape of
// the request sent to the endpoint, or on which internal function ran — only on
// what a caller of POST /api/ask gets back.

import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../server/index.mjs';
import { loadDataset } from '../server/query-worker/dataset.mjs';
import { inject } from './helpers/inject.mjs';
import { completion, stubModelEndpoint, restoreFetch } from './helpers/model-stub.mjs';

const ds = loadDataset();

const ask = (question) => inject(app, { method: 'POST', url: '/api/ask', body: { question } });

test.beforeEach(() => {
  process.env.MODEL_API_KEY = 'test-key';
  delete process.env.ASK_TIMEOUT_MS;
});

test.afterEach(restoreFetch);

test('a question is answered with figures computed from the dataset', async () => {
  stubModelEndpoint(completion('{"groupBy":"none","metric":"sum"}'), completion('Reworded.'));

  const res = await ask('how much was spent in total?');

  assert.equal(res.status, 200);
  // Independent source of truth: the total recorded in the dataset snapshot,
  // never a figure the model or the compose step produced.
  assert.equal(res.json.result.grandTotal, ds.meta.grandTotalCents / 100);
  assert.match(res.json.answer, /Total spending/);
  assert.ok(res.json.answer.includes((ds.meta.grandTotalCents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })));
});

test('the reworded sentence is returned when the model rewords successfully', async () => {
  stubModelEndpoint(completion('{"groupBy":"agency","limit":3}'), completion('Here is a friendlier sentence.'));

  const res = await ask('which agencies spent the most?');

  assert.equal(res.status, 200);
  assert.equal(res.json.prose, 'Here is a friendlier sentence.');
});

test('a failure while rewording returns the grounded sentence unchanged', async () => {
  stubModelEndpoint(completion('{"groupBy":"agency","limit":3}'), new Error('endpoint exploded'));

  const res = await ask('which agencies spent the most?');

  assert.equal(res.status, 200);
  assert.equal(res.json.prose, res.json.answer);
  assert.ok(res.json.facts.length > 0, 'grounded facts are still returned');
});

test('with no key configured, asking returns a clean unavailable response', async () => {
  delete process.env.MODEL_API_KEY;
  stubModelEndpoint(completion('should never be called'));

  const res = await ask('how much was spent in total?');

  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'ai_unavailable');
  assert.match(res.json.message, /not configured/i);
});

test('unparseable model output returns an unavailable response after retrying', async () => {
  const calls = stubModelEndpoint(completion('I am afraid I cannot do that.'));

  const res = await ask('how much was spent in total?');

  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'ai_unavailable');
  assert.ok(calls.count > 1, `expected a retry, got ${calls.count} attempt(s)`);
});

// Endpoints that all claim to speak OpenAI chat-completions still disagree about
// individual parameters. Newer OpenAI models reject `max_tokens` (requiring
// `max_completion_tokens`) and refuse any temperature but the default; Anthropic's
// compatible endpoint and a local Ollama know only `max_tokens`. A question must be
// answered on all of them, with nothing for the operator to configure.
function stubEndpointRefusing(unsupportedFields, reply) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const offender = unsupportedFields.find((f) => f in body);
    if (!offender) return reply;
    return {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            message: `Unsupported parameter: '${offender}' is not supported with this model.`,
            type: 'invalid_request_error',
            param: offender,
          },
        }),
    };
  };
}

const REFUSED_BY = {
  'the legacy token cap (newer OpenAI models)': ['max_tokens'],
  'the modern token cap (Anthropic-compatible, Ollama)': ['max_completion_tokens'],
  'any non-default temperature': ['temperature'],
  'the legacy token cap and any non-default temperature (gpt-5-nano)': ['max_tokens', 'temperature'],
};

for (const [description, unsupportedFields] of Object.entries(REFUSED_BY)) {
  test(`a question is answered by an endpoint that refuses ${description}`, async () => {
    stubEndpointRefusing(unsupportedFields, completion('{"groupBy":"none","metric":"sum"}'));

    const res = await ask('how much was spent in total?');

    assert.equal(res.status, 200);
    assert.equal(res.json.result.grandTotal, ds.meta.grandTotalCents / 100);
  });
}

test('a refusal that is not about a parameter is not retried away', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } }),
  });

  const res = await ask('how much was spent in total?');

  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'ai_unavailable');
});

test('a request that takes too long returns a timeout response', async () => {
  process.env.ASK_TIMEOUT_MS = '40';
  globalThis.fetch = () =>
    new Promise((resolve) => setTimeout(() => resolve(completion('{}')), 200).unref());

  const res = await ask('how much was spent in total?');

  assert.equal(res.status, 504);
  assert.equal(res.json.error, 'timeout');
});
