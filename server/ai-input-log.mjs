// The choke-point that records both sides of every model call — exactly what was
// sent, exactly what came back — plus what the query worker computed. Its whole
// purpose is to make the claim "the model never receives or invents a number"
// checkable, and to make a bad reply visible instead of a bare `no_json`.
//
// Both directions always print to the terminal. Writing them to a FILE is a local
// development extra: it happens only when AI_INPUT_LOG names one, and touches the
// filesystem only at that moment — never at import. That is what lets the
// application start where everything outside /tmp is read-only.

import fs from 'node:fs';
import path from 'node:path';
import { modelConfig } from './model-endpoint.mjs';

/** The configured log file, or '' when file logging is off. Read per call. */
const logFile = () => process.env.AI_INPUT_LOG || '';

const MAX_TERMINAL_CHARS = 800;

/** Keep a terminal readable without hiding the thing you are trying to see. */
function forTerminal(value) {
  if (value === '') return '(empty)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return String(value);
  const oneLine = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return oneLine.length > MAX_TERMINAL_CHARS
    ? `${oneLine.slice(0, MAX_TERMINAL_CHARS)}… (${oneLine.length} chars)`
    : oneLine;
}

function appendLog(entry, terminalLine) {
  console.log(terminalLine);

  const file = logFile();
  if (!file) return;

  const line = JSON.stringify({ ts: new Date().toISOString(), model: modelConfig().model, ...entry }) + '\n';
  try {
    // Synchronous on purpose: entries stay in call order, and this only ever runs
    // on a developer's machine with the log explicitly switched on.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch (err) {
    // A development aid must never take answering down with it.
    console.error('[ai] input log unavailable:', err.message);
  }
}

/** Log EXACTLY what we are about to send to the model. */
export function logAiInput(stage, question, inputSentToModel) {
  appendLog(
    { kind: 'ai_input', stage, question, inputSentToModel },
    `[ai] ${stage} → sent: ${forTerminal(inputSentToModel)}`
  );
}

/**
 * Log EXACTLY what the model sent back, before anything tries to interpret it.
 * This is what turns an opaque parse failure into a visible cause.
 */
export function logAiReply(stage, replyFromModel) {
  appendLog(
    { kind: 'ai_reply', stage, replyFromModel },
    `[ai] ${stage} ← reply: ${forTerminal(replyFromModel)}`
  );
}

/** Log a worker tool call + a tiny, number-only result summary (never raw rows). */
export function logToolEvent(question, query, result) {
  const summary = result && {
    grandTotal: result.grandTotal,
    matchedRows: result.matchedRows,
    top: result.groups?.[0]?.label ?? null,
  };
  appendLog(
    { kind: 'tool_call', stage: 'runQuery', question, query, result: summary },
    `[ai] runQuery · query: ${forTerminal(query)}\n[ai] runQuery · computed: ${forTerminal(summary)}`
  );
}
