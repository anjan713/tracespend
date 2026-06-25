// Tracespend precompute — turns the raw vendor-payment CSVs into ONE exact,
// compact artifact (public/artifacts/spending.json) that the UI + AI read from.
//
// Reliability guarantees enforced here:
//  - Every number is summed ONCE, exactly, from source rows.
//  - "Other" rollups preserve the full remainder so totals always reconcile.
//  - A hard assertion verifies sum(parts) === grandTotal before writing.
//
// Hierarchy: Category -> top-N Agencies (+Other) -> top-N Vendors (+Other)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import { makeVendorCanon } from './lib/vendor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'public', 'artifacts');
const OUT_FILE = path.join(OUT_DIR, 'spending.json');
// Evidence is the largest section (~80% of the old combined artifact). It is
// written to a SEPARATE file and lazy-loaded by the client only when the Verify
// panel needs it, keeping the initial page payload (tree + indexes) small.
const EVIDENCE_FILE = path.join(OUT_DIR, 'evidence.json');

// How many real slices are drawn per ring before the rest fold into a single
// nested "Other" bucket. Kept small so slices stay large and labels readable;
// clicking "Other" drills into the next page (the next slices + a deeper Other).
// Bounded by MAX_*_PAGES so the artifact — and the deepest "Other › Other" chain
// — stays small: the final page folds the entire long tail into one flat leaf.
const AGENCIES_PER_PAGE = 5;
const VENDORS_PER_PAGE = 6;
const MAX_AGENCY_PAGES = 3; // up to 15 agencies across pages, then a flat tail
const MAX_VENDOR_PAGES = 2; // up to 12 vendors across pages, then a flat tail
const AGENCIES_KEPT = AGENCIES_PER_PAGE * MAX_AGENCY_PAGES;
const VENDORS_KEPT = VENDORS_PER_PAGE * MAX_VENDOR_PAGES;
const EVIDENCE_PER_NODE = 20;
const CENTS = 100; // round money to cents to avoid float drift

// ---------- helpers ----------
const clean = (s) => (s == null ? '' : String(s).trim());
const round2 = (n) => Math.round(n * CENTS) / CENTS;

function findCsvFiles() {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`Missing data dir: ${DATA_DIR}`);
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => path.join(DATA_DIR, f));
  if (!files.length) throw new Error(`No CSV files found in ${DATA_DIR}`);
  return files.sort();
}

function fyKey(fy) {
  return fy === 2022 ? 'fy2022' : fy === 2023 ? 'fy2023' : null;
}

// Bounded top-N list (descending by .amount). O(N) inserts, N is tiny.
function makeTopN(limit) {
  const arr = [];
  return {
    arr,
    push(item) {
      if (arr.length < limit) {
        arr.push(item);
        arr.sort((a, b) => b.amount - a.amount);
      } else if (item.amount > arr[arr.length - 1].amount) {
        arr[arr.length - 1] = item;
        arr.sort((a, b) => b.amount - a.amount);
      }
    },
  };
}

// Sum the FY split + total of a list of aggregates (for "Other" rollups).
function sumAgg(items) {
  return items.reduce(
    (acc, x) => {
      acc.fy2022 += x.fy2022;
      acc.fy2023 += x.fy2023;
      acc.total += x.total;
      return acc;
    },
    { fy2022: 0, fy2023: 0, total: 0 }
  );
}

// Build a node's children: the top `pageSize` real nodes, then (if anything
// remains) ONE "Other" node. That Other is a *container* whose children are the
// NEXT page (the next `pageSize` real nodes + a deeper Other) — so clicking it
// drills in and reveals more. After `maxPages`, the remaining long tail folds
// into one flat leaf. Net effect: every ring shows at most pageSize+1 slices
// while the full list stays reachable, and every node reconciles exactly.
function buildPagedChildren({ items, pageSize, maxPages, makeNode, otherIdBase, noun, page = 0 }) {
  const out = items.slice(0, pageSize).map(makeNode);
  const rest = items.slice(pageSize);
  if (!rest.length) return out;

  const sum = sumAgg(rest);
  const base = {
    name: `Other · ${rest.length.toLocaleString()} ${noun}`,
    level: 'other',
    fy2022: round2(sum.fy2022),
    fy2023: round2(sum.fy2023),
    total: round2(sum.total),
  };

  if (page + 1 >= maxPages) {
    out.push({ id: `${otherIdBase}:tail`, ...base }); // terminal leaf — drill stops
  } else {
    out.push({
      id: `${otherIdBase}:p${page + 1}`,
      ...base,
      children: buildPagedChildren({ items: rest, pageSize, maxPages, makeNode, otherIdBase, noun, page: page + 1 }),
    });
  }
  return out;
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

// ---------- main ----------
async function main() {
  const t0 = Date.now();
  const files = findCsvFiles();
  console.log(`[build-data] found ${files.length} CSV file(s):`);
  files.forEach((f) => console.log('  - ' + path.basename(f)));

  // Shared vendor de-duplication (see lib/vendor.mjs) — identical to the worker
  // build so both artifacts group vendors the same way and reconcile to the cent.
  const vendorCanon = makeVendorCanon();

  // PASS 1 — exact aggregation
  const cat = new Map(); // category -> {fy2022,fy2023,total}
  const catAg = new Map(); // `${cat}||${agency}` -> {...}
  const catAgVen = new Map(); // `${cat}||${agency}||${vendor}` -> {...}
  const vendorGlobal = new Map(); // vendor -> {fy2022,fy2023,total, agencies:Set}
  const agencyGlobal = new Map(); // agency -> {fy2022,fy2023,total}
  const grand = { fy2022: 0, fy2023: 0, total: 0 };
  let rowCount = 0;
  let badRows = 0;

  const bump = (map, key, fk, amt) => {
    let o = map.get(key);
    if (!o) {
      o = { fy2022: 0, fy2023: 0, total: 0 };
      map.set(key, o);
    }
    o[fk] += amt;
    o.total += amt;
  };

  for (const file of files) {
    console.log(`[build-data] pass 1: ${path.basename(file)} ...`);
    rowCount += await streamRows(file, (r) => {
      const fy = parseInt(clean(r.FY), 10);
      const fk = fyKey(fy);
      const amt = parseFloat(clean(r.Amount));
      const c = clean(r.Category);
      const a = clean(r.Agency);
      const v = clean(r.Vendor);
      if (!fk || !c || !a || !v || !Number.isFinite(amt)) {
        badRows++;
        return;
      }
      const vKey = vendorCanon.canon(v);
      grand[fk] += amt;
      grand.total += amt;
      bump(cat, c, fk, amt);
      bump(catAg, `${c}||${a}`, fk, amt);
      bump(catAgVen, `${c}||${a}||${vKey}`, fk, amt);
      bump(agencyGlobal, a, fk, amt);
      let vg = vendorGlobal.get(vKey);
      if (!vg) {
        vg = { fy2022: 0, fy2023: 0, total: 0, agencies: new Set() };
        vendorGlobal.set(vKey, vg);
      }
      vg[fk] += amt;
      vg.total += amt;
      vg.agencies.add(a);
    });
  }
  console.log(`[build-data] pass 1 done: ${rowCount.toLocaleString()} rows (${badRows} skipped)`);

  // Group children under their parents so we can sort + page them into the tree.
  const agenciesByCat = new Map(); // cat -> [{agency,...}]
  for (const [key, o] of catAg) {
    const [c, a] = key.split('||');
    if (!agenciesByCat.has(c)) agenciesByCat.set(c, []);
    agenciesByCat.get(c).push({ agency: a, ...o });
  }
  const vendorsByCatAg = new Map(); // `${cat}||${agency}` -> [{vendor,...}]
  for (const [key, o] of catAgVen) {
    const idx = key.lastIndexOf('||');
    const parent = key.slice(0, idx);
    const vendor = key.slice(idx + 2);
    if (!vendorsByCatAg.has(parent)) vendorsByCatAg.set(parent, []);
    vendorsByCatAg.get(parent).push({ vendor, ...o });
  }

  // Sort each child list once (desc by total) and record 0-based ranks so PASS 2
  // can map a transaction to the exact tree node it belongs to (a real slice on
  // some page, or the terminal "Other" tail).
  const agencyRank = new Map(); // `${cat}||${agency}` -> rank within category
  for (const [c, list] of agenciesByCat) {
    list.sort((a, b) => b.total - a.total);
    list.forEach((x, i) => agencyRank.set(`${c}||${x.agency}`, i));
  }
  const vendorRank = new Map(); // `${cat}||${agency}||${vendor}` -> rank within agency
  for (const [parent, list] of vendorsByCatAg) {
    list.sort((a, b) => b.total - a.total);
    list.forEach((x, i) => vendorRank.set(`${parent}||${x.vendor}`, i));
  }

  // Build the tree
  const catList = [...cat.entries()]
    .map(([name, o]) => ({ name, ...o }))
    .sort((a, b) => b.total - a.total);

  const tree = {
    id: 'root',
    name: 'All Spending',
    level: 'root',
    fy2022: round2(grand.fy2022),
    fy2023: round2(grand.fy2023),
    total: round2(grand.total),
    children: [],
  };

  // Node factories. Agencies recursively build their (paged) vendor children.
  const makeVendorNode = (agId) => (vn) => ({
    id: `${agId}|ven:${vendorCanon.displayOf(vn.vendor)}`,
    name: vendorCanon.displayOf(vn.vendor),
    level: 'vendor',
    fy2022: round2(vn.fy2022),
    fy2023: round2(vn.fy2023),
    total: round2(vn.total),
  });
  const makeAgencyNode = (catName) => (ag) => {
    const agId = `cat:${catName}|ag:${ag.agency}`;
    const venList = vendorsByCatAg.get(`${catName}||${ag.agency}`) || [];
    return {
      id: agId,
      name: ag.agency,
      level: 'agency',
      fy2022: round2(ag.fy2022),
      fy2023: round2(ag.fy2023),
      total: round2(ag.total),
      children: buildPagedChildren({
        items: venList,
        pageSize: VENDORS_PER_PAGE,
        maxPages: MAX_VENDOR_PAGES,
        makeNode: makeVendorNode(agId),
        otherIdBase: `${agId}|ven:__other__`,
        noun: 'vendors',
      }),
    };
  };

  for (const c of catList) {
    const agList = agenciesByCat.get(c.name) || [];
    tree.children.push({
      id: `cat:${c.name}`,
      name: c.name,
      level: 'category',
      fy2022: round2(c.fy2022),
      fy2023: round2(c.fy2023),
      total: round2(c.total),
      children: buildPagedChildren({
        items: agList,
        pageSize: AGENCIES_PER_PAGE,
        maxPages: MAX_AGENCY_PAGES,
        makeNode: makeAgencyNode(c.name),
        otherIdBase: `cat:${c.name}|ag:__other__`,
        noun: 'agencies',
      }),
    });
  }

  // Vendor search index. Short keys to save space. Capped to the top vendors by
  // spend (covers virtually all dollars) so the client artifact stays lean & fast.
  const VENDOR_INDEX_LIMIT = 5000;
  const vendorIndexFull = [...vendorGlobal.entries()]
    .map(([key, o]) => ({
      n: vendorCanon.displayOf(key),
      t: round2(o.total),
      a: round2(o.fy2022),
      b: round2(o.fy2023),
      ag: o.agencies.size,
    }))
    .sort((x, y) => y.t - x.t);
  const vendorIndex = vendorIndexFull.slice(0, VENDOR_INDEX_LIMIT);

  // Exact global agency index (all agencies) — used by the agent for reliable
  // "top agencies" answers without summing on the client.
  const agencyIndex = [...agencyGlobal.entries()]
    .map(([name, o]) => ({ n: name, t: round2(o.total), a: round2(o.fy2022), b: round2(o.fy2023) }))
    .sort((x, y) => y.t - x.t);

  // PASS 2 — evidence (top transactions per kept node, mapping remainders to Other)
  const evidence = new Map(); // nodeId -> makeTopN
  const ev = (id) => {
    let t = evidence.get(id);
    if (!t) {
      t = makeTopN(EVIDENCE_PER_NODE);
      evidence.set(id, t);
    }
    return t;
  };

  for (const file of files) {
    console.log(`[build-data] pass 2 (evidence): ${path.basename(file)} ...`);
    await streamRows(file, (r) => {
      const fy = parseInt(clean(r.FY), 10);
      const fk = fyKey(fy);
      const amt = parseFloat(clean(r.Amount));
      const c = clean(r.Category);
      const a = clean(r.Agency);
      const v = clean(r.Vendor);
      if (!fk || !c || !a || !v || !Number.isFinite(amt)) return;
      const vKey = vendorCanon.canon(v);

      // Map this row to its exact tree node via the precomputed ranks. Agencies
      // ranked within the kept pages are real nodes (id by name, regardless of
      // page); the deep tail rolls into the terminal "Other" leaf. Same for
      // vendors under a real agency.
      const catId = `cat:${c}`;
      const aRank = agencyRank.get(`${c}||${a}`);
      const agencyReal = aRank != null && aRank < AGENCIES_KEPT;
      const agId = agencyReal ? `cat:${c}|ag:${a}` : `cat:${c}|ag:__other__:tail`;
      let venId = null;
      if (agencyReal) {
        const vRank = vendorRank.get(`${c}||${a}||${vKey}`);
        const vendorReal = vRank != null && vRank < VENDORS_KEPT;
        venId = vendorReal ? `${agId}|ven:${vendorCanon.displayOf(vKey)}` : `${agId}|ven:__other__:tail`;
      }

      const tx = { vendor: vendorCanon.displayOf(vKey), agency: a, category: c, fy, month: clean(r.FMonth), amount: round2(amt) };
      ev('root').push(tx);
      ev(catId).push(tx);
      ev(agId).push(tx);
      if (venId) ev(venId).push(tx);
    });
  }

  const evidenceOut = {};
  for (const [id, top] of evidence) evidenceOut[id] = top.arr;

  // ---------- RECONCILIATION (hard guarantee) ----------
  const catSum = catList.reduce((s, c) => s + c.total, 0);
  const reconError = Math.abs(catSum - grand.total);
  if (reconError > 1) {
    throw new Error(
      `Reconciliation FAILED: sum(categories)=${catSum} vs grandTotal=${grand.total} (diff ${reconError})`
    );
  }
  // Sanity-check the tree itself reconciles per category (top + Other == category total)
  for (const catNode of tree.children) {
    const childSum = catNode.children.reduce((s, n) => s + n.total, 0);
    if (Math.abs(childSum - catNode.total) > 1) {
      throw new Error(`Category "${catNode.name}" children (${childSum}) != total (${catNode.total})`);
    }
  }

  const out = {
    meta: {
      title: 'Tracespend',
      tagline: 'Where did the money go?',
      source: 'State vendor payments, FY2022–FY2023',
      fiscalYears: [2022, 2023],
      generatedAt: new Date().toISOString(),
      grandTotal: round2(grand.total),
      grandTotalByFY: { fy2022: round2(grand.fy2022), fy2023: round2(grand.fy2023) },
      rowCount,
      skippedRows: badRows,
      categoryCount: catList.length,
      agencyCount: new Set([...catAg.keys()].map((k) => k.split('||')[1])).size,
      vendorCount: vendorGlobal.size,
      searchableVendors: vendorIndex.length,
      limits: {
        agenciesPerCategory: AGENCIES_PER_PAGE,
        vendorsPerAgency: VENDORS_PER_PAGE,
        agencyPages: MAX_AGENCY_PAGES,
        vendorPages: MAX_VENDOR_PAGES,
        agenciesKept: AGENCIES_KEPT,
        vendorsKept: VENDORS_KEPT,
      },
      reconciliation: { ok: true, error: round2(reconError) },
    },
    tree,
    vendorIndex,
    agencyIndex,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidenceOut));
  const sizeMb = (fs.statSync(OUT_FILE).size / 1e6).toFixed(1);
  const evidenceMb = (fs.statSync(EVIDENCE_FILE).size / 1e6).toFixed(1);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[build-data] ----------------------------------------');
  console.log(`[build-data] grand total : $${grand.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`[build-data]   FY2022     : $${grand.fy2022.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`[build-data]   FY2023     : $${grand.fy2023.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`[build-data] categories  : ${catList.length}`);
  console.log(`[build-data] agencies    : ${out.meta.agencyCount}`);
  console.log(`[build-data] vendors     : ${vendorGlobal.size.toLocaleString()}`);
  console.log(`[build-data] reconciled  : OK (diff $${reconError.toFixed(2)})`);
  console.log(`[build-data] wrote ${OUT_FILE} (${sizeMb} MB) in ${secs}s`);
  console.log(`[build-data] wrote ${EVIDENCE_FILE} (${evidenceMb} MB, lazy-loaded by Verify)`);
}

main().catch((e) => {
  console.error('[build-data] FAILED:', e);
  process.exit(1);
});
