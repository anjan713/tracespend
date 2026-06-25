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
`;

/**
 * @param {{ databaseUrl?: string, logFile: string }} opts
 */
export function createActivityStore({ databaseUrl, logFile }) {
  let pool = null;
  let mode = 'file'; // until init() upgrades us to 'postgres'

  // Render (and most hosted PG) require TLS; a local Postgres does not.
  const needsSsl = (url) => !/(localhost|127\.0\.0\.1|::1)/.test(url);

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
    if (mode === 'postgres' && pool) {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM activity');
      const n = rows[0]?.n ?? 0;
      await pool.query('TRUNCATE activity RESTART IDENTITY');
      return n;
    }
    let n = 0;
    try {
      const raw = await fs.promises.readFile(logFile, 'utf8');
      n = raw.split('\n').filter((l) => l.trim()).length;
    } catch {
      /* no file yet — nothing to clear */
    }
    await fs.promises.writeFile(logFile, '');
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

  return { init, append, clear, exportNdjson, getMode: () => mode };
}
