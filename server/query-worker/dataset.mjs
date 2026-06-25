// Loads the encoded dataset (built by scripts/build-query-worker.mjs) into typed
// arrays at boot. This is the ONLY place that touches the snapshot file; the rest
// of the query worker operates purely on the returned in-memory structure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATASET_FILE = path.resolve(__dirname, '..', 'artifacts', 'dataset.json');

/**
 * @typedef {Object} Dataset
 * @property {object} meta
 * @property {{vendors:string[],agencies:string[],categories:string[],subcategories:string[]}} dims
 * @property {number[]} fiscalYears
 * @property {Set<number>} reimbursementCats   category indexes flagged as reimbursements
 * @property {{vendorIdx:Int32Array,agencyIdx:Int32Array,categoryIdx:Uint8Array,subcatIdx:Int32Array,fyIdx:Uint8Array,fmonth:Uint8Array,amountCents:Float64Array}} cols
 * @property {number} rows
 */

/** Load + decode the dataset. Throws a clear error if the snapshot is missing. */
export function loadDataset(file = DATASET_FILE) {
  if (!fs.existsSync(file)) {
    throw new Error(`Encoded dataset missing at ${file} — run \`npm run build:worker\` first.`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { meta, dims, reimbursementCategories = [], cols } = raw;

  const catIndexByName = new Map(dims.categories.map((n, i) => [n, i]));
  const reimbursementCats = new Set(
    reimbursementCategories.map((n) => catIndexByName.get(n)).filter((i) => i !== undefined)
  );

  return {
    meta,
    dims,
    fiscalYears: meta.fiscalYears,
    reimbursementCats,
    rows: cols.amountCents.length,
    cols: {
      vendorIdx: Int32Array.from(cols.vendorIdx),
      agencyIdx: Int32Array.from(cols.agencyIdx),
      categoryIdx: Uint8Array.from(cols.categoryIdx),
      subcatIdx: Int32Array.from(cols.subcatIdx),
      fyIdx: Uint8Array.from(cols.fyIdx),
      fmonth: Uint8Array.from(cols.fmonth),
      amountCents: Float64Array.from(cols.amountCents),
    },
  };
}
