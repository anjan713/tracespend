// The deployed function entry. The platform rewrites /api/* onto a single
// function and does not preserve the path, so the entry point rebuilds it before
// Express routes the request. If that is wrong, every route works locally and
// 404s on the deployed site — which is what these tests exist to prevent.
//
// Everything is asserted by driving the function the way the platform does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inject } from './helpers/inject.mjs';

const ADMIN_TOKEN = 'token-for-this-test-run';
process.env.LOG_CLEAR_TOKEN = ADMIN_TOKEN;
const { default: handler } = await import('../api/index.mjs');

test('a rewritten request reaches the route the browser asked for', async () => {
  const res = await inject(handler, { url: `/api?apiPath=health` });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('a rewritten request reaches a nested route', async () => {
  const res = await inject(handler, { url: `/api?apiPath=log/state` });

  assert.equal(res.status, 200);
  assert.ok('clearedAt' in res.json);
});

test('other query parameters survive the rewrite', async () => {
  const res = await inject(handler, { url: `/api?apiPath=log/export&token=${ADMIN_TOKEN}` });

  assert.equal(res.status, 200, 'the token must still reach the route that gates on it');
});

test('a request whose path the platform preserved is served unchanged', async () => {
  const res = await inject(handler, { url: '/api/health' });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('a sub-path that is not a plain route is refused rather than routed', async () => {
  const res = await inject(handler, { url: '/api?apiPath=../secret' });

  assert.equal(res.status, 404);
});
