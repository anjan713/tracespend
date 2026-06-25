// The AI boundary. Two narrow jobs, nothing else:
//   parseQuestion() — turn a question into a strict JSON Query (no numbers).
//   summarize()     — reword an already-correct sentence (cannot change numbers).
// Plus logAiInput()/logToolEvent() — the single choke-point that records exactly
// what is sent to the model and what the worker computed, before every call.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const AI_LOG = path.join(LOG_DIR, 'ai-inputs.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
const PARSE_RETRIES = 2; // => up to 3 attempts

export const llmEnabled = () => !!API_KEY;

function appendLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), model: MODEL, ...entry });
  fs.appendFile(AI_LOG, line + '\n', () => {});
  console.log(`[ai] ${entry.stage}`, entry.question ? `· q="${entry.question}"` : '');
}

/** The single choke-point: log EXACTLY what we are about to send to the model. */
export function logAiInput(stage, question, inputSentToModel) {
  appendLog({ kind: 'ai_input', stage, question, inputSentToModel });
}

/** Log a worker tool call + a tiny, number-only result summary (never raw rows). */
export function logToolEvent(question, query, result) {
  appendLog({
    kind: 'tool_call',
    stage: 'runQuery',
    question,
    query,
    result: result && {
      grandTotal: result.grandTotal,
      matchedRows: result.matchedRows,
      top: result.groups?.[0]?.label ?? null,
    },
  });
}

async function callAnthropic({ system, user, maxTokens, temperature }) {
  if (!API_KEY) throw new Error('no_api_key');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`anthropic_${r.status}: ${text.slice(0, 200)}`);
  }
  const json = await r.json();
  return json?.content?.[0]?.text?.trim() ?? '';
}

function extractJson(text) {
  // tolerate ```json fences or stray prose around the object
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no_json');
  return JSON.parse(body.slice(start, end + 1));
}

function parseSystemPrompt(categories) {
  return [
    'You convert a question about state vendor-payment spending into a single JSON Query object.',
    'Output ONLY the JSON object — no prose, no code fences, no explanation.',
    '',
    'Schema:',
    '{',
    '  "metric": "sum" | "count" | "avg",            // default "sum"',
    '  "groupBy": "none" | "vendor" | "agency" | "category" | "subcategory" | "fiscalYear" | "fiscalMonth",',
    '  "sort": "desc" | "asc",                        // default "desc"',
    '  "limit": number,                               // 1..50, default 10',
    '  "compareYears": boolean,                        // default false; true to compare FY2022 vs FY2023 BY a dimension',
    '  "filters": {',
    '    "year": 2022 | 2023 | null,',
    '    "category": string | null,                   // must be one of the categories below',
    '    "agency": string | null,',
    '    "vendor": string | null,',
    '    "subcategory": string | null,',
    '    "excludeReimbursements": boolean             // default false (reimbursements are INCLUDED)',
    '  }',
    '}',
    '',
    `Valid categories: ${categories.map((c) => `"${c}"`).join(', ')}.`,
    '',
    'Rules:',
    '- Choose groupBy to match the question: "which agencies/vendors/categories" => that dimension; "how much/total" => "none"; "how many" => metric "count"; "average" => metric "avg".',
    '- For a TREND or year-over-year TOTAL question, set groupBy "fiscalYear" and DO NOT set filters.year (never pin a single year for a trend). Use "fiscalMonth" only for monthly questions.',
    '- For "WHAT CHANGED / what grew or shrank / what drove the change" between FY2022 and FY2023 broken down by a dimension, set "compareYears": true, set groupBy to that dimension (default "category"), and DO NOT set filters.year.',
    '- Only set filters.year when the user explicitly limits to one fiscal year.',
    '- Never invent numbers. You only choose the Query; our code computes the figures.',
  ].join('\n');
}

/** Anthropic -> strict JSON Query. Retries, then throws (route returns 503). */
export async function parseQuestion(question, categories) {
  const system = parseSystemPrompt(categories);
  logAiInput('parse', question, question);
  let lastErr;
  for (let attempt = 0; attempt <= PARSE_RETRIES; attempt++) {
    try {
      const text = await callAnthropic({ system, user: question, maxTokens: 320, temperature: 0 });
      return extractJson(text);
    } catch (e) {
      lastErr = e;
      if (String(e.message).startsWith('no_api_key')) break; // no point retrying
    }
  }
  throw lastErr ?? new Error('parse_failed');
}

/** Anthropic rewrites the factual sentence; on ANY failure return it unchanged. */
export async function summarize(question, factualSentence) {
  if (!API_KEY) return factualSentence;
  const system =
    'You rewrite a budget answer for a non-technical city councilmember. ' +
    'Rules: (1) Output ONE friendly, plain-English sentence. ' +
    '(2) Do NOT change, add, remove, or round any number, dollar figure, or percentage — copy them EXACTLY. ' +
    '(3) Do not invent facts not present in the sentence. (4) No preamble.';
  const user = `Question: ${question}\nGrounded answer: ${factualSentence}\nRewrite it as one friendly sentence, keeping every number identical.`;
  logAiInput('reword', question, factualSentence);
  try {
    const text = await callAnthropic({ system, user, maxTokens: 160, temperature: 0.3 });
    return text || factualSentence;
  } catch {
    return factualSentence;
  }
}
