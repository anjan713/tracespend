// App-seam smoke tests. Importing the server must hand back an application that
// can be driven directly — no listener, no port, no network. Everything the
// deployment does rests on this, so it is asserted on its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import app from '../server/index.mjs';
import { inject } from './helpers/inject.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('the imported application answers a request that needs no model', async () => {
  const res = await inject(app, { url: '/api/health' });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.datasetRows > 0, 'expected the dataset to be loaded');
});

test('the retired reword route is gone', async () => {
  const res = await inject(app, {
    method: 'POST',
    url: '/api/prose',
    body: { question: 'anything', answer: 'a grounded sentence' },
  });

  assert.equal(res.status, 404);
});

const bootReadOnly = (env) =>
  promisify(execFile)(process.execPath, [path.join(__dirname, 'helpers', 'readonly-boot.mjs')], {
    env: { ...process.env, DATABASE_URL: '', AI_INPUT_LOG: '', ...env },
  });

test('the application starts and serves on a read-only filesystem', async () => {
  const { stdout, stderr } = await bootReadOnly({ NODE_ENV: 'production' });

  assert.doesNotMatch(stderr, /EROFS/, `something tried to write during boot:\n${stderr}`);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()), { health: 200, healthy: true, logged: 200 });
});

test('importing the application writes nothing, even where the log file is enabled', async () => {
  // Locally the activity log DOES write a file — but only when something is
  // logged. Merely importing the app must still touch nothing.
  const { stdout, stderr } = await bootReadOnly({ NODE_ENV: 'development' });

  assert.doesNotMatch(stderr, /EROFS/, `something tried to write during boot:\n${stderr}`);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()), { health: 200, healthy: true, logged: null });
});
