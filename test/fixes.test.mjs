// Regression tests for the three data fixes:
//   #1 FY2023 fiscal-month normalization (biennium months 13–24 -> 1–12)
//   #2 vendor de-duplication via shared canonicalization
//   #3 year-over-year "what changed" by-dimension capability

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset } from '../server/query-worker/dataset.mjs';
import { normalizeQuery } from '../server/query-worker/normalize.mjs';
import { runQuery } from '../server/query-worker/query.mjs';
import { canonicalVendorKey } from '../scripts/lib/vendor.mjs';

const ds = loadDataset();

function run(raw) {
  const n = normalizeQuery(raw, ds);
  assert.ok(n.ok, `normalize failed: ${n.error} — ${n.message}`);
  return runQuery(ds, n.query);
}

// ---- Fix #1: FY2023 fiscal-month normalization ----
test('FY2023 groups into 12 fiscal months (no "Unknown month")', () => {
  const r = run({ groupBy: 'fiscalMonth', filters: { year: 2023 } });
  const labels = r.groups.map((g) => g.label);
  assert.ok(!labels.includes('Unknown month'), 'FY2023 should have no Unknown month bucket');
  assert.equal(r.groups.length, 12, `expected 12 months, got ${r.groups.length}`);
  // monthly buckets reconcile exactly to the FY2023 total
  const fy2023 = run({ filters: { year: 2023 } }).grandTotalCents;
  assert.equal(r.grandTotalCents, fy2023);
});

test('FY2022 still groups into 12 fiscal months', () => {
  const r = run({ groupBy: 'fiscalMonth', filters: { year: 2022 } });
  assert.equal(r.groups.length, 12);
  assert.ok(!r.groups.some((g) => g.label === 'Unknown month'));
});

// ---- Fix #2: vendor de-duplication ----
test('canonicalVendorKey is idempotent and merges obvious variants', () => {
  const k = canonicalVendorKey('  Acme,  Inc.  ');
  assert.equal(canonicalVendorKey(k), k, 'should be idempotent');
  assert.equal(canonicalVendorKey('ACME INC'), canonicalVendorKey('Acme, Inc.'));
  assert.equal(canonicalVendorKey('ACME INCORPORATED'), canonicalVendorKey('ACME INC'));
  assert.equal(canonicalVendorKey('A & B CO'), canonicalVendorKey('A AND B COMPANY'));
  // genuinely different legal forms stay distinct (conservative, no over-merge)
  assert.notEqual(canonicalVendorKey('ACME INC'), canonicalVendorKey('ACME LLC'));
});

test('worker vendor dimension is canonical-unique (dedup actually applied)', () => {
  const keys = new Set();
  for (const name of ds.dims.vendors) {
    const key = canonicalVendorKey(name);
    assert.ok(!keys.has(key), `duplicate canonical vendor remains: "${name}" -> ${key}`);
    keys.add(key);
  }
});

// ---- Fix #3: year-over-year "what changed" by dimension ----
test('compareYears returns per-group FY deltas that reconcile to the grand delta', () => {
  const r = run({ compareYears: true, groupBy: 'category', limit: 50 });
  assert.equal(r.yoy, true);
  assert.equal(r.groupBy, 'category');

  const fy22 = run({ filters: { year: 2022 } }).grandTotalCents;
  const fy23 = run({ filters: { year: 2023 } }).grandTotalCents;
  assert.equal(r.fy2022Cents, fy22);
  assert.equal(r.fy2023Cents, fy23);
  assert.equal(r.deltaCents, fy23 - fy22);

  // per-group cents sum back to each year's grand total (all 9 categories shown)
  const sum22 = r.groups.reduce((s, g) => s + g.fy2022Cents, 0);
  const sum23 = r.groups.reduce((s, g) => s + g.fy2023Cents, 0);
  assert.equal(sum22, fy22);
  assert.equal(sum23, fy23);

  // extremes are present and ordered
  assert.ok(r.topIncrease && r.topDecrease);
  assert.ok(r.topIncrease.deltaCents >= r.topDecrease.deltaCents);
});

test('compareYears coerces non-dimension groupBy to category and drops the year filter', () => {
  const n = normalizeQuery({ compareYears: true, groupBy: 'none', filters: { year: 2023 } }, ds);
  assert.equal(n.ok, true);
  assert.equal(n.query.groupBy, 'category');
  assert.equal(n.query.compareYears, true);
  assert.equal(n.query.metric, 'sum');
  assert.equal(n.query.filter.fyIdx, null);
});
