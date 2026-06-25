// Tracespend server. Single-shot Q&A orchestration:
//   POST /api/ask  -> parse (AI) -> normalize/resolve -> runQuery (code) ->
//                     compose (code) -> reword (AI) -> chart hint
// The AI never produces a number; the query worker owns every figure. Also hosts
// the legacy /api/prose reword endpoint and the /api/log runtime activity sink.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { loadDataset } from './query-worker/dataset.mjs';
import { normalizeQuery } from './query-worker/normalize.mjs';
import { runQuery } from './query-worker/query.mjs';
import { composeSummary } from './query-worker/compose.mjs';
import { parseQuestion, summarize, logAiInput, logToolEvent, llmEnabled } from './ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const ACTIVITY_LOG = path.join(LOG_DIR, 'activity.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '512kb' }));

const PORT = process.env.PROSE_PORT || process.env.PORT || 8787;
const ASK_TIMEOUT_MS = 12000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

// ---- boot: load the encoded dataset once ----
let ds = null;
try {
  ds = loadDataset();
  console.log(
    `[server] dataset: ${ds.rows.toLocaleString()} rows · ${ds.dims.agencies.length} agencies · ` +
      `${ds.dims.vendors.length.toLocaleString()} vendors · LLM ${llmEnabled() ? 'ENABLED' : 'DISABLED'}`
  );
} catch (e) {
  console.error('[server] ' + e.message);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// Best-effort hint for the client to move the sundial. The client resolves these
// {level,name} pairs to node ids against its in-memory tree.
function chartHint(q, result) {
  const fyMode = q.filter.fyIdx == null ? undefined : ds.fiscalYears[q.filter.fyIdx] === 2022 ? 'fy2022' : 'fy2023';
  if (q.resolved.vendor) return { vendorQuery: q.resolved.vendor, fyMode };
  if (q.resolved.agency && q.groupBy !== 'agency') return { focus: { level: 'agency', name: q.resolved.agency }, fyMode };
  if (q.resolved.category && q.groupBy !== 'category') return { focus: { level: 'category', name: q.resolved.category }, fyMode };
  const ranked = ['category', 'agency', 'vendor'].includes(q.groupBy);
  if (ranked && result.groups[0] && result.groups[0].key != null) {
    const top = result.groups[0].label;
    if (q.groupBy === 'vendor') return { vendorQuery: top, fyMode };
    return { focus: { level: q.groupBy, name: top }, highlight: [{ level: q.groupBy, name: top }], fyMode };
  }
  if (q.groupBy === 'none' && !q.resolved.agency && !q.resolved.category && !q.resolved.vendor) {
    return { reset: true, fyMode };
  }
  return { fyMode };
}

function trimResult(r) {
  if (!r) return null;
  const slim = (g) => ({ label: g.label, value: g.value, sumDollars: g.sumDollars, count: g.count, share: g.share });
  return {
    metric: r.metric, groupBy: r.groupBy, grandTotal: r.grandTotal, matchedRows: r.matchedRows,
    groups: r.groups.map(slim), others: r.others ? slim(r.others) : null,
    concentration: r.concentration, empty: r.empty,
  };
}

async function answer(question) {
  const raw = await parseQuestion(question, ds.dims.categories); // 1. AI -> Query
  const norm = normalizeQuery(raw, ds); // 2-3. validate + resolve names
  if (!norm.ok) {
    return { answer: norm.message, prose: null, facts: [], query: raw, result: null, action: null, error: norm.error };
  }
  const q = norm.query;
  const result = runQuery(ds, q); // 4. code-only numbers
  logToolEvent(question, q, result);
  const { answer: sentence, facts } = composeSummary(q, result); // 5. code owns numbers
  const prose = await summarize(question, sentence); // 6. AI reword (cannot change numbers)
  const action = chartHint(q, result); // 7. optional chart move
  return { answer: sentence, prose, facts, query: q, result: trimResult(result), action };
}

// ---- routes ----
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, llmEnabled: llmEnabled(), model: llmEnabled() ? MODEL : null, datasetRows: ds ? ds.rows : 0 });
});

app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'missing_question' });
  if (!ds) return res.status(503).json({ error: 'dataset_unavailable', message: 'Run `npm run build:worker` first.' });

  try {
    const payload = await withTimeout(answer(question), ASK_TIMEOUT_MS);
    res.json(payload);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === 'timeout') return res.status(504).json({ error: 'timeout', message: 'That took too long — please retry.' });
    if (msg.startsWith('no_api_key')) {
      return res.status(503).json({ error: 'ai_unavailable', message: 'AI is not configured (missing ANTHROPIC_API_KEY).' });
    }
    console.error('[ask] failed:', msg);
    res.status(503).json({ error: 'ai_unavailable', message: 'The AI is unavailable right now — please retry.' });
  }
});

// Legacy reword-only endpoint (kept for backward compatibility).
app.post('/api/prose', async (req, res) => {
  const { question, answer: grounded } = req.body ?? {};
  if (!grounded) return res.status(400).json({ error: 'missing answer' });
  if (!API_KEY) return res.json({ prose: null, reason: 'no_api_key' });
  logAiInput('prose', question ?? '', grounded);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: MODEL, max_tokens: 120, temperature: 0.3,
        system:
          'You rewrite budget answers for a non-technical city councilmember. One friendly sentence; copy every number EXACTLY; no preamble.',
        messages: [{ role: 'user', content: `Question: ${question}\nGrounded answer: ${grounded}\nRewrite as one friendly sentence, keeping every number identical.` }],
      }),
    });
    if (!r.ok) return res.json({ prose: null, reason: 'upstream_error' });
    const json = await r.json();
    res.json({ prose: json?.content?.[0]?.text?.trim() ?? null });
  } catch {
    res.json({ prose: null, reason: 'exception' });
  }
});

// Runtime activity sink (newline-delimited JSON).
app.post('/api/log', (req, res) => {
  const body = req.body ?? {};
  const list = Array.isArray(body) ? body : [body];
  const lines = list.map((e) => JSON.stringify({ recvAt: new Date().toISOString(), ip: req.ip, ...e })).join('\n') + '\n';
  fs.appendFile(ACTIVITY_LOG, lines, (err) => {
    if (err) console.error('[log] append failed', err);
  });
  res.json({ ok: true });
});

// ---- serve the built frontend (single-service deploy) ----
// In production one Render web service hosts BOTH the app and the /api routes on
// the same origin, matching the client's relative fetch('/api/...'). This is a
// no-op in dev, where Vite serves the app and proxies /api to this server.
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback for any non-API GET route.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log('[server] serving built frontend from dist/');
} else {
  console.log('[server] no dist/ build found — API only (run `npm run build` for single-service serving)');
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${llmEnabled() ? 'ENABLED · ' + MODEL : 'DISABLED → templated fallback'})`);
});
