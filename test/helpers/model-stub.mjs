// Replaces the global fetch with a stubbed model endpoint, so tests are
// deterministic, free, and need no key. Nothing here inspects the request — the
// tests care only about what a caller of the API gets back.

const realFetch = globalThis.fetch;

/** A minimal, valid OpenAI chat-completions response carrying `content`. */
export function completion(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  };
}

/**
 * Serve one canned reply per call, in order; the last one repeats. An `Error`
 * in the list is thrown instead of returned, standing in for a dead endpoint.
 * @returns {{count:number}} live call counter
 */
export function stubModelEndpoint(...replies) {
  const calls = { count: 0 };
  globalThis.fetch = async () => {
    const reply = replies[Math.min(calls.count, replies.length - 1)];
    calls.count += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return calls;
}

export function restoreFetch() {
  globalThis.fetch = realFetch;
}
