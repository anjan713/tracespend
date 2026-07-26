// Boots the application with every filesystem WRITE made to fail, the way a
// serverless host behaves outside its temporary directory, and drives two
// requests through it. Run as a child process by test/app.test.mjs.
//
// Prints one line of JSON on success. Any write attempted at import — a log
// directory, a log file — surfaces as a thrown EROFS here or on stderr, which is
// exactly the failure this guards against.

import fs from 'node:fs';
import { inject } from './inject.mjs';

const fail = (name) => () => {
  throw new Error(`EROFS: fs.${name} attempted on a read-only filesystem`);
};

// Write operations only — reads must keep working, and openSync/open back
// readFileSync/readFile as well as writes.
for (const name of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'createWriteStream']) {
  fs[name] = fail(name);
}
for (const name of ['mkdir', 'writeFile', 'appendFile']) {
  fs.promises[name] = async () => fail(name)();
}

const { default: app } = await import('../../server/index.mjs');

const health = await inject(app, { url: '/api/health' });

// Logging is only expected to survive a read-only filesystem where the store is
// inert. Where it is meant to write a file, a read-only disk failing is correct.
const storeIsInert = process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL;
const logged = storeIsInert
  ? await inject(app, { method: 'POST', url: '/api/log', body: { type: 'boot-check' } })
  : { status: null };

// Store initialisation is deliberately fire-and-forget; give it a moment to
// finish so any write it attempts lands on stderr before we report.
await new Promise((resolve) => setTimeout(resolve, 250));

console.log(JSON.stringify({ health: health.status, healthy: health.json.ok, logged: logged.status }));
