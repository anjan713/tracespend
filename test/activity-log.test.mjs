// The activity log must not require a database OR a writable filesystem to be
// deployed. This file runs the application in production mode with no database
// configured — the deployed configuration — and checks the store's local-file mode
// separately, through its own interface.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityStore } from '../server/activity-store.mjs';
import { inject } from './helpers/inject.mjs';

const ADMIN_TOKEN = 'token-for-this-test-run';

// The application reads its store configuration once, as it is imported — so the
// deployed configuration has to be in place before that happens.
process.env.NODE_ENV = 'production';
process.env.LOG_CLEAR_TOKEN = ADMIN_TOKEN;
delete process.env.DATABASE_URL;
const { default: app } = await import('../server/index.mjs');

const TEMP_DIR = path.join(os.tmpdir(), `tracespend-activity-${process.pid}`);
const entry = { t: new Date().toISOString(), session: 's1', type: 'click', detail: { node: 'Travel' } };

test.after(() => fs.rmSync(TEMP_DIR, { recursive: true, force: true }));

// ---- deployed configuration: no database, nothing persisted ----

test('logging succeeds and persists nothing when no database is configured', async () => {
  const res = await inject(app, { method: 'POST', url: '/api/log', body: entry });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  const exported = await inject(app, { url: `/api/log/export?token=${ADMIN_TOKEN}` });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers['x-activity-count'], '0', 'the entry was accepted but never stored');
  assert.equal(exported.text, '');
});

test('the log-state endpoint responds with an empty clear epoch', async () => {
  const res = await inject(app, { url: '/api/log/state' });

  assert.equal(res.status, 200);
  assert.equal(res.json.clearedAt, null);
});

test('a malformed logging request still cannot affect the caller', async () => {
  const res = await inject(app, { method: 'POST', url: '/api/log', body: { detail: { bad: undefined } } });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('the admin endpoints stay invisible without the token', async () => {
  const cleared = await inject(app, { method: 'POST', url: '/api/log/clear' });
  const exported = await inject(app, { url: '/api/log/export' });

  assert.equal(cleared.status, 404);
  assert.equal(exported.status, 404);
});

// ---- local development: no database, but a file is still written ----

test('running locally without a database still writes the log to a file', async () => {
  const logFile = path.join(TEMP_DIR, 'local', 'activity.log');
  const store = createActivityStore({ logFile, fileFallback: true });

  assert.equal(await store.init(), 'file');
  await store.append([entry], { ip: '127.0.0.1' });

  const { count, body } = await store.exportNdjson();
  assert.equal(count, 1);
  assert.match(body, /"type":"click"/);
});

test('with no database and no file fallback the store records nothing, quietly', async () => {
  const logFile = path.join(TEMP_DIR, 'off', 'activity.log');
  const store = createActivityStore({ logFile, fileFallback: false });

  assert.equal(await store.init(), 'off');
  await store.append([entry], { ip: '127.0.0.1' });

  assert.deepEqual(await store.exportNdjson(), { count: 0, body: '' });
  assert.equal(await store.clear(), 0);
  assert.equal(store.getClearedAt(), null, 'nothing was stored, so there is no wipe to broadcast');
  assert.equal(fs.existsSync(path.dirname(logFile)), false, 'no directory should be created');
});
