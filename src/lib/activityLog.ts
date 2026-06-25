// Runtime activity log — records live user interactions (drills, "Other"
// expansions, filter changes, AI queries, etc.) with timestamps.
//
// Three sinks, all best-effort and non-blocking:
//   1. In-memory buffer (capped) for the in-app counter / export.
//   2. localStorage, so a session survives reloads.
//   3. POST /api/log → appends JSON lines to logs/activity.log on disk when the
//      optional server is running (proxied by Vite in dev). Failures are
//      swallowed so logging never affects the UX.
//
// This is intentionally separate from PROJECT_LOG.md, which is the curated
// development/interaction history maintained for assessment.

export type ActivityType =
  | 'app_load'
  | 'data_loaded'
  | 'evidence_load'
  | 'navigate'
  | 'expand_other'
  | 'reset'
  | 'fy_mode'
  | 'size_mode'
  | 'min_amount'
  | 'vendor_search'
  | 'hover'
  | 'ai_query'
  | 'ai_action'
  | 'export_log';

export interface ActivityEntry {
  t: string; // ISO timestamp
  session: string;
  type: ActivityType;
  detail?: Record<string, unknown>;
}

const STORAGE_KEY = 'tracespend.activity.v1';
// Last server clear-epoch this browser has already applied. When the server
// reports a NEWER epoch (an admin ran the token-gated wipe), we drop our own
// localStorage copy so the in-app counter / download reflect the wipe too.
const CLEARED_KEY = 'tracespend.activity.clearedAt';
const MAX_ENTRIES = 5000;

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const SESSION_ID = newId();

function load(): ActivityEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as ActivityEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let entries: ActivityEntry[] = load();
const listeners = new Set<(count: number) => void>();

function persist() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota or disabled — keep in-memory only */
  }
}

function notify() {
  for (const cb of listeners) cb(entries.length);
}

// Drop our local copy when the server reports a clear-epoch newer than the one
// we last applied. Idempotent: re-seeing the same epoch is a no-op, so logging
// resumes normally right after a wipe.
function applyServerClear(serverClearedAt: unknown) {
  if (typeof serverClearedAt !== 'string' || !serverClearedAt) return;
  let last: string | null = null;
  try {
    last = typeof localStorage !== 'undefined' ? localStorage.getItem(CLEARED_KEY) : null;
  } catch {
    /* ignore */
  }
  if (last && serverClearedAt <= last) return; // already applied
  entries = [];
  persist();
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CLEARED_KEY, serverClearedAt);
  } catch {
    /* ignore */
  }
  notify();
}

function postToServer(entry: ActivityEntry) {
  if (typeof fetch === 'undefined') return;
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => applyServerClear(j?.clearedAt))
      .catch(() => {});
  } catch {
    /* server not running — local sinks still hold the entry */
  }
}

// On load, sync the clear-epoch even without an interaction, so a page opened
// after an admin wipe drops its stale local log immediately. Also re-checks
// when the tab regains focus (admin may wipe while the tab sits in background).
function syncClearState() {
  if (typeof fetch === 'undefined') return;
  fetch('/api/log/state')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => applyServerClear(j?.clearedAt))
    .catch(() => {});
}

if (typeof document !== 'undefined') {
  syncClearState();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncClearState();
  });
}

/** Record one interaction. Never throws. */
export function logActivity(type: ActivityType, detail?: Record<string, unknown>) {
  const entry: ActivityEntry = { t: new Date().toISOString(), session: SESSION_ID, type, detail };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  persist();
  notify();
  postToServer(entry);
}

export function getActivity(): ActivityEntry[] {
  return entries.slice();
}

export function activityCount(): number {
  return entries.length;
}

/** Subscribe to count changes (for the in-app badge). Returns an unsubscribe fn. */
export function subscribeActivity(cb: (count: number) => void): () => void {
  listeners.add(cb);
  cb(entries.length);
  return () => listeners.delete(cb);
}

export function clearActivity() {
  entries = [];
  persist();
  notify();
}

/** Download the current session log as a newline-delimited JSON (.log) file. */
export function downloadActivity() {
  if (typeof document === 'undefined') return;
  const header = `# Tracespend runtime activity log\n# session ${SESSION_ID} · exported ${new Date().toISOString()} · ${entries.length} events\n`;
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  const blob = new Blob([header + body + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tracespend-activity-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  logActivity('export_log', { count: entries.length });
}
