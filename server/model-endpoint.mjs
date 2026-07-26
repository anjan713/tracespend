// The one place in this codebase that talks to a model.
//
// A model endpoint is a configured target — a base URL, a key, and a model name,
// together — that answers chat-completion requests in the OpenAI wire format:
// POST {base}/chat/completions with `Authorization: Bearer`, a `messages` array,
// and the reply in `choices[0].message.content`.
//
// Which company serves it is a property of the configuration, never a branch in
// the code. OpenAI, a gateway such as OpenRouter or Groq, Anthropic's
// OpenAI-compatible endpoint, and a local server all take the same path through
// here. See docs/adr/0001-openai-wire-format-for-model-calls.md.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-nano';

// Every call asks for temperature 0. Neither thing we ask a model to do wants
// creativity: choosing a Query is a classification, and rewording must not drift
// from a sentence whose numbers are already correct. Fixed here rather than passed
// per call, so no future call site can quietly reintroduce variation.
//
// Some models accept only their own default and refuse this — see CONCESSIONS. That
// costs reproducibility of WHICH query is chosen and of the phrasing; it can never
// affect a figure, because the query worker computes every number.
const TEMPERATURE = 0;

/** Read once per call, so configuration can change without a restart. */
export function modelConfig() {
  return {
    baseUrl: (process.env.MODEL_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: process.env.MODEL_API_KEY || '',
    model: process.env.MODEL_NAME || DEFAULT_MODEL,
  };
}

/** Answering needs a configured endpoint; the chart never does. */
export const modelEndpointConfigured = () => !!modelConfig().apiKey;

// "Speaks OpenAI chat-completions" does not mean one exact request shape. Real
// divergences seen so far:
//   - the output cap is `max_completion_tokens` on newer OpenAI models, which
//     reject `max_tokens`; Anthropic's compatible endpoint and Ollama accept only
//     `max_tokens`.
//   - some models (gpt-5-nano among them) refuse any temperature but their default.
// Rather than make each of these a setting the operator has to get right — and only
// discover wrong when answering breaks — send the preferred shape, and when an
// endpoint names a parameter it will not accept, drop back to a shape without it.
// Each concession is deliberate and listed here; nothing is dropped blindly.
const CONCESSIONS = {
  max_completion_tokens: ({ max_completion_tokens: cap, ...rest }) => ({ ...rest, max_tokens: cap }),
  temperature: ({ temperature: _dropped, ...rest }) => rest, // fall back to the endpoint's default
};

/** The parameter an endpoint refused, when that is what it refused. */
function refusedParameter(status, body) {
  if (status !== 400) return null;
  let param = null;
  try {
    param = JSON.parse(body)?.error?.param ?? null;
  } catch {
    /* not JSON — fall back to scanning the text below */
  }
  if (param && param in CONCESSIONS) return param;
  if (!/unsupported|unrecognized|unknown|not supported/i.test(body)) return null;
  return Object.keys(CONCESSIONS).find((field) => body.includes(field)) ?? null;
}

/**
 * One chat-completion round trip. Temperature 0 where the endpoint allows it.
 * @param {{system:string,user:string,maxTokens:number}} req
 * @returns {Promise<string>} the assistant message, trimmed
 * @throws {Error} `no_api_key` when unconfigured, `model_endpoint_<status>` upstream
 */
export async function callModel({ system, user, maxTokens }) {
  const { baseUrl, apiKey, model } = modelConfig();
  if (!apiKey) throw new Error('no_api_key');

  let body = {
    model,
    max_completion_tokens: maxTokens,
    temperature: TEMPERATURE,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  let r;
  // At most one concession per known parameter, so this always terminates.
  for (let attempt = 0; attempt <= Object.keys(CONCESSIONS).length; attempt++) {
    r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (r.ok) break;

    const text = await r.text().catch(() => '');
    const refused = refusedParameter(r.status, text);
    const concede = refused && refused in body ? CONCESSIONS[refused] : null;
    if (!concede) throw new Error(`model_endpoint_${r.status}: ${text.slice(0, 200)}`);
    body = concede(body);
  }

  const json = await r.json();
  const content = json?.choices?.[0]?.message?.content;
  // A 200 with no assistant message is a broken endpoint, not an empty answer —
  // say so, rather than passing '' downstream as if the model had replied.
  if (typeof content !== 'string') throw new Error('model_endpoint_malformed_response');
  return content.trim();
}
