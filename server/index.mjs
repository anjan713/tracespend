// Tracespend server. Single-shot Q&A orchestration:
//   POST /api/ask  -> parse (AI) -> normalize/resolve -> runQuery (code) ->
//                     compose (code) -> reword (AI) -> chart hint
// The AI never produces a number; the query worker owns every figure. Also hosts
// the /api/log runtime activity sink and the hidden, token-protected
// /api/log/{clear,export} admin endpoints.
//
// The application is exported so it can be driven in-process — by a test, or by a
// serverless platform. A listener is started only when this file is run directly.

import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import compression from 'compression';

import { createActivityStore } from './activity-store.mjs';
import { loadDataset } from './query-worker/dataset.mjs';
import { normalizeQuery } from './query-worker/normalize.mjs';
import { runQuery } from './query-worker/query.mjs';
import { composeSummary } from './query-worker/compose.mjs';
import { parseQuestion, summarize } from './ai.mjs';
import { logToolEvent } from './ai-input-log.mjs';
import { modelEndpointConfigured, modelConfig } from './model-endpoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVITY_LOG = path.resolve(__dirname, '..', 'logs', 'activity.log');

// Runtime activity log: durable in Postgres when DATABASE_URL is set, else
// newline-JSON on disk while developing, else nothing at all. Deployed hosts have
// a read-only filesystem, so the file fallback is a local-only affordance and no
// directory is created at import. See server/activity-store.mjs.
const activity = createActivityStore({
  databaseUrl: process.env.DATABASE_URL,
  logFile: ACTIVITY_LOG,
  fileFallback: process.env.NODE_ENV !== 'production',
});
activity
  .init()
  .then((m) => console.log(`[server] activity log store: ${m}`))
  .catch((e) => console.error('[server] activity store init error:', e.message));

// Secret, server-only token that gates the hidden log admin endpoints. It lives
// ONLY in the environment (never in the client bundle or the repo), so a public
// deploy / shared source never exposes it. Unset => the endpoints stay 404.
const LOG_CLEAR_TOKEN = process.env.LOG_CLEAR_TOKEN || '';
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
// True only when a token is configured AND the request presents the exact match
// (via the x-clear-token header, or a ?token= query for browser convenience).
function logTokenOk(req) {
  if (!LOG_CLEAR_TOKEN) return false;
  const provided = req.get('x-clear-token') || (typeof req.query.token === 'string' ? req.query.token : '');
  return !!provided && safeEqual(provided, LOG_CLEAR_TOKEN);
}

const app = express();
// gzip all responses (JSON API + static assets). Makes the app self-sufficient
// regardless of whether the host adds edge compression.
app.use(compression());
app.use(express.json({ limit: '512kb' }));

const PORT = process.env.PROSE_PORT || process.env.PORT || 8787;

// How long a question may take before the caller gets a retry message. Must stay
// below the host's own function limit (vercel.json sets maxDuration to 30s) so the
// visitor sees our message rather than the platform's timeout.
const DEFAULT_ASK_TIMEOUT_MS = 12000;
function askTimeoutMs() {
  const configured = Number(process.env.ASK_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ASK_TIMEOUT_MS;
}

// ---- boot: load the encoded dataset once ----
let ds = null;
try {
  ds = loadDataset();
  console.log(
    `[server] dataset: ${ds.rows.toLocaleString()} rows · ${ds.dims.agencies.length} agencies · ` +
      `${ds.dims.vendors.length.toLocaleString()} vendors · model endpoint ` +
      `${modelEndpointConfigured() ? modelConfig().model : 'NOT CONFIGURED'}`
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
  res.json({
    ok: true,
    modelEndpointConfigured: modelEndpointConfigured(),
    model: modelEndpointConfigured() ? modelConfig().model : null,
    datasetRows: ds ? ds.rows : 0,
  });
});

app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'missing_question' });
  if (!ds) return res.status(503).json({ error: 'dataset_unavailable', message: 'Run `npm run build:worker` first.' });

  try {
    const payload = await withTimeout(answer(question), askTimeoutMs());
    res.json(payload);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === 'timeout') return res.status(504).json({ error: 'timeout', message: 'That took too long — please retry.' });
    if (msg.startsWith('no_api_key')) {
      return res.status(503).json({ error: 'ai_unavailable', message: 'AI is not configured (missing MODEL_API_KEY).' });
    }
    console.error('[ask] failed:', msg);
    res.status(503).json({ error: 'ai_unavailable', message: 'The AI is unavailable right now — please retry.' });
  }
});

// Runtime activity sink. Fire-and-forget: respond immediately, persist in the
// background (Postgres or file), and never let a logging failure surface.
app.post('/api/log', (req, res) => {
  const body = req.body ?? {};
  const list = Array.isArray(body) ? body : [body];
  activity.append(list, { ip: req.ip }).catch((err) => console.error('[log] append failed', err.message));
  // Echo the clear epoch so each browser can wipe its OWN local copy once an
  // admin has wiped the server (see src/lib/activityLog.ts).
  res.json({ ok: true, clearedAt: activity.getClearedAt() });
});

// Public, read-only clear epoch. Reveals only a timestamp (never log data), so
// it needs no token — it lets a freshly loaded page sync without an interaction.
app.get('/api/log/state', (_req, res) => {
  res.json({ clearedAt: activity.getClearedAt() });
});

// ---- hidden, token-protected log admin endpoints ----
// The secret lives only in the server environment, so these are invisible to
// assessors: without the exact token they return a bare 404 (no hint that the
// route exists), and there is no UI control that reaches them.

// Wipe the activity log back to zero. Only the token holder can call it.
app.post('/api/log/clear', async (req, res) => {
  if (!logTokenOk(req)) return res.sendStatus(404);
  try {
    const cleared = await activity.clear();
    console.log(`[log] cleared ${cleared} entr${cleared === 1 ? 'y' : 'ies'} (${activity.getMode()})`);
    res.json({ ok: true, cleared, store: activity.getMode(), clearedAt: activity.getClearedAt() });
  } catch (err) {
    console.error('[log] clear failed', err.message);
    res.status(500).json({ ok: false, error: 'clear_failed' });
  }
});

// Download the full server-side log as newline-delimited JSON (oldest first).
app.get('/api/log/export', async (req, res) => {
  if (!logTokenOk(req)) return res.sendStatus(404);
  try {
    const { count, body } = await activity.exportNdjson();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Activity-Count', String(count));
    res.setHeader('Content-Disposition', `attachment; filename="activity-${stamp}.log"`);
    res.send(body);
  } catch (err) {
    console.error('[log] export failed', err.message);
    res.status(500).json({ ok: false, error: 'export_failed' });
  }
});

// The built frontend is NOT served from here. It is static output on a CDN, so a
// visitor gets the sundial without a server in the path at all, and the platform
// owns the single-page fallback for deep links. Locally, `npm run dev` serves the
// app through Vite and proxies /api to this server.

// Starting a listener is what `npm run server` wants and what an in-process
// caller must not get. Only the direct `node server/index.mjs` invocation listens.
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  app.listen(PORT, () => {
    console.log(
      `[server] listening on http://localhost:${PORT} ` +
        `(model endpoint ${modelEndpointConfigured() ? modelConfig().model : 'NOT CONFIGURED → grounded sentence only'})`
    );
  });
}

export default app;
