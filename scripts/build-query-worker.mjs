// Build the encoded dataset for the code-only QUERY WORKER.
//
// Parses the raw vendor-payment CSVs ONCE and emits a compact, dictionary-encoded
// snapshot (server/artifacts/dataset.json) the server can load in ~1s without ever
// re-parsing 217MB. The worker answers questions over this in-memory dataset;
// it NEVER recomputes from CSV at request time.
//
// Encoding: string dimensions (vendors, agencies, categories, subcategories) +
// parallel numeric column arrays (one entry per kept row). Amounts are stored as
// integer CENTS so sums are exact (no float drift) and reconcile with the sundial
// artifact to the cent.
//
// Run: npm run build:worker   (after the raw CSVs are present in data/)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import { makeVendorCanon } from './lib/vendor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'server', 'artifacts');
const OUT_FILE = path.join(OUT_DIR, 'dataset.json');

const FISCAL_YEARS = [2022, 2023];
const clean = (s) => (s == null ? '' : String(s).trim());

// A category is a "reimbursement" (internal agency-to-agency transfer) when its
// name mentions reimbursement. Included by default; droppable via a query filter.
const isReimbursementName = (name) => /reimbursement/i.test(name);

function findCsvFiles() {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`Missing data dir: ${DATA_DIR}`);
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => path.join(DATA_DIR, f));
  if (!files.length) throw new Error(`No CSV files found in ${DATA_DIR}`);
  return files.sort();
}

// Interns a string into a dictionary, returning its stable index.
function interner() {
  const index = new Map();
  const list = [];
  return {
    list,
    intern(s) {
      let i = index.get(s);
      if (i === undefined) {
        i = list.length;
        list.push(s);
        index.set(s, i);
      }
      return i;
    },
  };
}

function streamRows(file, onRow) {
  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    });
    let n = 0;
    parser.on('readable', () => {
      let rec;
      while ((rec = parser.read()) !== null) {
        n++;
        onRow(rec);
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(n));
    fs.createReadStream(file).pipe(parser);
  });
}

async function main() {
  const t0 = Date.now();
  const files = findCsvFiles();
  console.log(`[build-worker] found ${files.length} CSV file(s):`);
  files.forEach((f) => console.log('  - ' + path.basename(f)));

  // Vendors are de-duplicated via shared canonicalization (see lib/vendor.mjs):
  // the dictionary keys by canonical name, the list stores the first-seen display.
  const vendorCanon = makeVendorCanon();
  const vendorKeyToIdx = new Map();
  const vendorDisplay = [];
  const internVendor = (raw) => {
    const key = vendorCanon.canon(raw);
    let i = vendorKeyToIdx.get(key);
    if (i === undefined) {
      i = vendorDisplay.length;
      vendorKeyToIdx.set(key, i);
      vendorDisplay.push(vendorCanon.displayOf(key));
    }
    return i;
  };
  const agencies = interner();
  const categories = interner();
  const subcategories = interner();

  // Parallel numeric columns (one entry per kept row).
  const vendorIdx = [];
  const agencyIdx = [];
  const categoryIdx = [];
  const subcatIdx = [];
  const fyIdx = []; // 0 -> 2022, 1 -> 2023
  const fmonth = []; // 1..12 (0 if unknown)
  const amountCents = []; // integer cents

  let rowCount = 0;
  let skippedRows = 0;
  let grandTotalCents = 0;

  const NONE_SUB = '(no subcategory)';

  for (const file of files) {
    console.log(`[build-worker] reading ${path.basename(file)} ...`);
    await streamRows(file, (r) => {
      const fy = parseInt(clean(r.FY), 10);
      const fyi = FISCAL_YEARS.indexOf(fy);
      const amt = parseFloat(clean(r.Amount));
      const c = clean(r.Category);
      const a = clean(r.Agency);
      const v = clean(r.Vendor);
      if (fyi < 0 || !c || !a || !v || !Number.isFinite(amt)) {
        skippedRows++;
        return;
      }
      const sub = clean(r.SubCategory) || NONE_SUB;
      // Fiscal months are numbered continuously across the 2021–23 biennium:
      // 1–12 = FY2022, 13–24 = FY2023. Normalize the second year back to 1–12 so
      // per-year monthly grouping/trends work (otherwise all FY2023 rows fall into
      // the "unknown month" bucket).
      const fmRaw = parseInt(clean(r.FMonth), 10);
      const fm = Number.isFinite(fmRaw) && fmRaw > 12 ? fmRaw - 12 : fmRaw;
      const cents = Math.round(amt * 100);

      vendorIdx.push(internVendor(v));
      agencyIdx.push(agencies.intern(a));
      categoryIdx.push(categories.intern(c));
      subcatIdx.push(subcategories.intern(sub));
      fyIdx.push(fyi);
      fmonth.push(Number.isFinite(fm) && fm >= 1 && fm <= 12 ? fm : 0);
      amountCents.push(cents);

      grandTotalCents += cents;
      rowCount++;
    });
  }

  const reimbursementCategories = categories.list.filter(isReimbursementName);

  console.log(
    `[build-worker] kept ${rowCount.toLocaleString()} rows (${skippedRows.toLocaleString()} skipped)`
  );
  console.log(
    `[build-worker] dims: ${vendorDisplay.length.toLocaleString()} vendors · ` +
      `${agencies.list.length.toLocaleString()} agencies · ` +
      `${categories.list.length} categories · ${subcategories.list.length} subcategories`
  );
  console.log(
    `[build-worker] grand total: $${(grandTotalCents / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  );
  if (reimbursementCategories.length) {
    console.log(`[build-worker] reimbursement categories: ${reimbursementCategories.join('; ')}`);
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      rowCount,
      skippedRows,
      grandTotalCents,
      fiscalYears: FISCAL_YEARS,
    },
    dims: {
      vendors: vendorDisplay,
      agencies: agencies.list,
      categories: categories.list,
      subcategories: subcategories.list,
    },
    reimbursementCategories,
    cols: { vendorIdx, agencyIdx, categoryIdx, subcatIdx, fyIdx, fmonth, amountCents },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  const mb = (fs.statSync(OUT_FILE).size / 1e6).toFixed(1);
  console.log(`[build-worker] wrote ${OUT_FILE} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('[build-worker] FAILED:', e);
  process.exit(1);
});
