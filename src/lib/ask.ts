// Client wrapper for the single-shot Q&A endpoint. POSTs the question to the
// server (which parses -> runs the code-only query worker -> composes -> rewords)
// and returns the grounded payload. Throws AskError on failure so the UI can show
// a clear "AI unavailable — retry" state.

import type { FYMode } from '../types';

export interface AskFact {
  label: string;
  value: string;
}

export interface AskChartHint {
  focus?: { level: 'category' | 'agency' | 'vendor'; name: string };
  highlight?: { level: string; name: string }[];
  vendorQuery?: string;
  fyMode?: FYMode;
  reset?: boolean;
}

export interface AskResponse {
  answer: string;
  prose: string | null;
  facts: AskFact[];
  query: unknown;
  result: unknown;
  action: AskChartHint | null;
  error?: string;
}

export class AskError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AskError';
    this.code = code;
  }
}

export async function ask(question: string): Promise<AskResponse> {
  let res: Response;
  try {
    res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
  } catch {
    throw new AskError('Can’t reach the server. Start it with `npm run server`.', 'network');
  }

  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON response */
  }

  if (!res.ok) {
    const message =
      (typeof json.message === 'string' && json.message) ||
      (json.error === 'ai_unavailable'
        ? 'The AI is unavailable right now — please retry.'
        : 'Something went wrong — please retry.');
    throw new AskError(message, typeof json.error === 'string' ? json.error : undefined);
  }

  return json as unknown as AskResponse;
}
