// The AI boundary. Two narrow jobs, nothing else:
//   parseQuestion() — turn a question into a strict JSON Query (no numbers).
//   summarize()     — reword an already-correct sentence (cannot change numbers).
// Both go through the single model endpoint; neither knows which provider answers.

import { callModel, modelEndpointConfigured } from './model-endpoint.mjs';
import { logAiInput, logAiReply } from './ai-input-log.mjs';

const PARSE_RETRIES = 2; // => up to 3 attempts

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

/** Model -> strict JSON Query. Retries, then throws (route returns 503). */
export async function parseQuestion(question, categories) {
  const system = parseSystemPrompt(categories);
  logAiInput('parse', question, question);
  let lastErr;
  for (let attempt = 0; attempt <= PARSE_RETRIES; attempt++) {
    try {
      const text = await callModel({ system, user: question, maxTokens: 320 });
      logAiReply('parse', text);
      return extractJson(text);
    } catch (e) {
      lastErr = e;
      if (String(e.message).startsWith('no_api_key')) break; // no point retrying
    }
  }
  throw lastErr ?? new Error('parse_failed');
}

/** The model rewrites the factual sentence; on ANY failure return it unchanged. */
export async function summarize(question, factualSentence) {
  if (!modelEndpointConfigured()) return factualSentence;
  const system =
    'You rewrite a budget answer for a non-technical city councilmember. ' +
    'Rules: (1) Output ONE friendly, plain-English sentence. ' +
    '(2) Do NOT change, add, remove, or round any number, dollar figure, or percentage — copy them EXACTLY. ' +
    '(3) Do not invent facts not present in the sentence. (4) No preamble.';
  const user = `Question: ${question}\nGrounded answer: ${factualSentence}\nRewrite it as one friendly sentence, keeping every number identical.`;
  logAiInput('reword', question, factualSentence);
  try {
    const text = await callModel({ system, user, maxTokens: 160 });
    logAiReply('reword', text);
    return text || factualSentence;
  } catch {
    return factualSentence;
  }
}
