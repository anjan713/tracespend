// The AI-input log is a local development tool: it records exactly what was sent
// to the model so the claim "the model never receives a number" can be checked by
// reading a file. It writes only when explicitly enabled, and is otherwise inert —
// which is what lets the application start on a read-only filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import app from '../server/index.mjs';
import { inject } from './helpers/inject.mjs';
import { completion, stubModelEndpoint, restoreFetch } from './helpers/model-stub.mjs';

const LOG_FILE = path.join(os.tmpdir(), `tracespend-ai-input-${process.pid}`, 'ai-inputs.log');
const ask = (question) => inject(app, { method: 'POST', url: '/api/ask', body: { question } });

test.beforeEach(() => {
  process.env.MODEL_API_KEY = 'test-key';
  fs.rmSync(path.dirname(LOG_FILE), { recursive: true, force: true });
  stubModelEndpoint(completion('{"groupBy":"none","metric":"sum"}'));
});

test.afterEach(() => {
  restoreFetch();
  delete process.env.AI_INPUT_LOG;
  fs.rmSync(path.dirname(LOG_FILE), { recursive: true, force: true });
});

test('with logging enabled, what was sent to the model is recorded', async () => {
  process.env.AI_INPUT_LOG = LOG_FILE;

  await ask('how much did agencies spend on travel?');

  const written = fs.readFileSync(LOG_FILE, 'utf8');
  assert.match(written, /how much did agencies spend on travel\?/);
});

test('what the model replied is recorded too, before anything interprets it', async () => {
  process.env.AI_INPUT_LOG = LOG_FILE;
  stubModelEndpoint(completion('{"groupBy":"none","metric":"sum"}'));

  await ask('how much was spent in total?');

  const replies = fs
    .readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'ai_reply');

  assert.ok(replies.length > 0, 'the model reply should be recorded');
  assert.match(replies[0].replyFromModel, /"groupBy":"none"/);
});

test('with logging not enabled, nothing is written and nothing fails', async () => {
  const res = await ask('how much did agencies spend on travel?');

  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.dirname(LOG_FILE)), false, 'no log directory should be created');
});

test('answering is identical whether logging is enabled or not', async () => {
  const withoutLog = await ask('how much was spent in total?');
  process.env.AI_INPUT_LOG = LOG_FILE;
  const withLog = await ask('how much was spent in total?');

  assert.deepEqual(withLog.json.answer, withoutLog.json.answer);
  assert.deepEqual(withLog.json.result, withoutLog.json.result);
});
