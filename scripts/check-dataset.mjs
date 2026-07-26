// Build guard: the encoded dataset must exist and be readable BEFORE anything is
// deployed. The API reads it by path at runtime, so a missing snapshot is invisible
// until a visitor asks a question and every answer fails. Failing the build turns
// that into a red deploy instead.

import fs from 'node:fs';
import { DATASET_FILE } from '../server/query-worker/dataset.mjs';

function fail(message) {
  console.error(`\n[check-dataset] ${message}\n`);
  console.error('Build the snapshot first:\n  npm run build:data\n  npm run build:worker\n');
  process.exit(1);
}

if (!fs.existsSync(DATASET_FILE)) fail(`Encoded dataset missing at ${DATASET_FILE}.`);

let meta;
try {
  ({ meta } = JSON.parse(fs.readFileSync(DATASET_FILE, 'utf8')));
} catch (err) {
  fail(`Encoded dataset at ${DATASET_FILE} could not be parsed: ${err.message}`);
}

if (!meta?.rowCount) fail(`Encoded dataset at ${DATASET_FILE} contains no rows.`);

console.log(`[check-dataset] ok — ${meta.rowCount.toLocaleString()} rows, built ${meta.generatedAt}`);
