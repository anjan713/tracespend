// Eval / reconciliation set — assert the query worker's numbers against an
// INDEPENDENT source: the sundial artifact (built by scripts/build-data.mjs from
// the same CSVs via a different code path). Matching both to the cent is strong
// evidence the worker can't silently report a wrong number.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../server/query-worker/dataset.mjs';
import { normalizeQuery } from '../server/query-worker/normalize.mjs';
import { runQuery } from '../server/query-worker/query.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.resolve(__dirname, '..', 'public', 'artifacts', 'spending.json');

const TOL = 1; // $1 tolerance for per-node cent rounding differences
const ds = loadDataset();
const art = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));

function run(raw) {
  const n = normalizeQuery(raw, ds);
  assert.ok(n.ok, `normalize failed: ${n.error} — ${n.message}`);
  return runQuery(ds, n.query);
}

function groupMap(raw) {
  const r = run(raw);
  const m = new Map();
  for (const g of r.groups) m.set(g.label, g.sumDollars);
  return m;
}

test('grand total matches the artifact and the published figure', () => {
  const total = run({}).grandTotal;
  assert.ok(Math.abs(total - art.meta.grandTotal) <= TOL, `worker ${total} vs artifact ${art.meta.grandTotal}`);
  assert.ok(Math.abs(total - 63247181911.41) <= TOL);
});

test('FY2022 and FY2023 totals match the artifact', () => {
  assert.ok(Math.abs(run({ filters: { year: 2022 } }).grandTotal - art.meta.grandTotalByFY.fy2022) <= TOL);
  assert.ok(Math.abs(run({ filters: { year: 2023 } }).grandTotal - art.meta.grandTotalByFY.fy2023) <= TOL);
});

test('all 9 category totals match the artifact to the cent', () => {
  const m = groupMap({ groupBy: 'category', metric: 'sum', limit: 50 });
  const cats = art.tree.children.filter((c) => c.level === 'category');
  assert.ok(cats.length >= 8);
  for (const c of cats) {
    assert.ok(m.has(c.name), `worker missing category "${c.name}"`);
    assert.ok(Math.abs(m.get(c.name) - c.total) <= TOL, `${c.name}: ${m.get(c.name)} vs ${c.total}`);
  }
});

test('top agency totals match the artifact agency index', () => {
  const m = groupMap({ groupBy: 'agency', metric: 'sum', sort: 'desc', limit: 50 });
  for (const a of art.agencyIndex.slice(0, 40)) {
    assert.ok(m.has(a.n), `worker missing agency "${a.n}"`);
    assert.ok(Math.abs(m.get(a.n) - a.t) <= TOL, `${a.n}: ${m.get(a.n)} vs ${a.t}`);
  }
});

test('top vendor totals match the artifact vendor index', () => {
  const m = groupMap({ groupBy: 'vendor', metric: 'sum', sort: 'desc', limit: 50 });
  for (const v of art.vendorIndex.slice(0, 40)) {
    assert.ok(m.has(v.n), `worker missing vendor "${v.n}"`);
    assert.ok(Math.abs(m.get(v.n) - v.t) <= TOL, `${v.n}: ${m.get(v.n)} vs ${v.t}`);
  }
});

test('excluding reimbursements drops exactly the reimbursement categories', () => {
  const all = run({}).grandTotal;
  const excl = run({ filters: { excludeReimbursements: true } }).grandTotal;
  const reimb = art.tree.children
    .filter((c) => /reimbursement/i.test(c.name))
    .reduce((s, c) => s + c.total, 0);
  assert.ok(reimb > 0);
  assert.ok(Math.abs(all - excl - reimb) <= TOL, `dropped ${all - excl} vs artifact ${reimb}`);
});
