// Durable store for the runtime interaction log. Two backends, chosen at boot:
//
//   - Postgres  (DATABASE_URL set): rows in an `activity` table that survive
//     restarts/redeploys — the source of truth in production (e.g. Render).
//   - File      (no DATABASE_URL): appends newline-delimited JSON to
//     logs/activity.log exactly as before, so local dev needs no database.
//
// Writes are best-effort and must never throw to the caller — the client's
// logging is fire-and-forget and can never be allowed to affect the UX.

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS activity (
    id      BIGSERIAL PRIMARY KEY,
    recv_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    t       TIMESTAMPTZ,
    session TEXT,
    type    TEXT,
    detail  JSONB,
    ip      TEXT
  );
  CREATE TABLE IF NOT EXISTS activity_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

/**
 * @param {{ databaseUrl?: string, logFile: string }} opts
 */
export function createActivityStore({ databaseUrl, logFile }) {
  let pool = null;
  let mode = 'file'; // until init() upgrades us to 'postgres'
  // ISO timestamp of the last admin wipe (or null). Surfaced to clients so each
  // browser can wipe its OWN localStorage activity log once the server is cleared.
  let clearedAt = null;
  const metaFile = `${logFile}.meta.json`;

  // Render (and most hosted PG) require TLS; a local Postgres does not.
  const needsSsl = (url) => !/(localhost|127\.0\.0\.1|::1)/.test(url);

  // ---- clear-epoch persistence (survives restarts in both backends) ----
  async function loadClearedAt() {
    if (mode === 'postgres' && pool) {
      try {
        const { rows } = await pool.query("SELECT value FROM activity_meta WHERE key = 'cleared_at'");
        return rows[0]?.value ?? null;
      } catch {
        return null;
      }
    }
    try {
      const raw = await fs.promises.readFile(metaFile, 'utf8');
      return JSON.parse(raw)?.clearedAt ?? null;
    } catch {
      return null;
    }
  }

  async function saveClearedAt(iso) {
    if (mode === 'postgres' && pool) {
      await pool.query(
        `INSERT INTO activity_meta (key, value) VALUES ('cleared_at', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [iso]
      );
      return;
    }
    await fs.promises.writeFile(metaFile, JSON.stringify({ clearedAt: iso }));
  }

  async function init() {
    if (databaseUrl) {
      try {
        const { default: pg } = await import('pg');
        pool = new pg.Pool({
          connectionString: databaseUrl,
          ssl: needsSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
          max: 3, // free PG has a small connection cap; our write volume is tiny
          idleTimeoutMillis: 30_000,
        });
        await pool.query(SCHEMA);
        mode = 'postgres';
      } catch (err) {
        // Fall back to the file sink so logging keeps working even if the DB is
        // misconfigured or unreachable at boot.
        console.error('[activity-store] Postgres init failed, using file sink:', err.message);
        pool = null;
        mode = 'file';
      }
    }
    if (mode === 'file') fs.mkdirSync(path.dirname(logFile), { recursive: true });
    clearedAt = await loadClearedAt();
    return mode;
  }

  /** Append raw client entries ({t,session,type,detail}); stamps recvAt + ip. */
  async function append(entries, meta = {}) {
    const list = Array.isArray(entries) ? entries : [entries];
    if (!list.length) return;

    if (mode === 'postgres' && pool) {
      const rows = [];
      const values = [];
      list.forEach((e, i) => {
        const b = i * 5;
        rows.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5})`);
        values.push(
          e?.t ?? null,
          e?.session ?? null,
          e?.type ?? null,
          e?.detail != null ? JSON.stringify(e.detail) : null,
          meta.ip ?? null
        );
      });
      await pool.query(`INSERT INTO activity (t, session, type, detail, ip) VALUES ${rows.join(',')}`, values);
      return;
    }

    const lines =
      list.map((e) => JSON.stringify({ recvAt: new Date().toISOString(), ip: meta.ip, ...e })).join('\n') + '\n';
    await fs.promises.appendFile(logFile, lines);
  }

  /** Wipe the log back to zero. Returns how many entries were removed. */
  async function clear() {
    let n = 0;
    if (mode === 'postgres' && pool) {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM activity');
      n = rows[0]?.n ?? 0;
      await pool.query('TRUNCATE activity RESTART IDENTITY');
    } else {
      try {
        const raw = await fs.promises.readFile(logFile, 'utf8');
        n = raw.split('\n').filter((l) => l.trim()).length;
      } catch {
        /* no file yet — nothing to clear */
      }
      await fs.promises.writeFile(logFile, '');
    }
    // Stamp the wipe so connected browsers can drop their own local copy.
    clearedAt = new Date().toISOString();
    await saveClearedAt(clearedAt);
    return n;
  }

  /** The full log as newline-delimited JSON, oldest first. */
  async function exportNdjson() {
    if (mode === 'postgres' && pool) {
      const { rows } = await pool.query(
        'SELECT recv_at AS "recvAt", t, session, type, detail, ip FROM activity ORDER BY id ASC'
      );
      const body = rows.map((r) => JSON.stringify(r)).join('\n');
      return { count: rows.length, body: rows.length ? body + '\n' : '' };
    }
    try {
      const raw = await fs.promises.readFile(logFile, 'utf8');
      return { count: raw.split('\n').filter((l) => l.trim()).length, body: raw };
    } catch {
      return { count: 0, body: '' };
    }
  }

  return { init, append, clear, exportNdjson, getMode: () => mode, getClearedAt: () => clearedAt };
}
