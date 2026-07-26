// Query-worker unit tests — internal consistency of sum/count/avg, filters,
// top-N + "All others", shares, concentration, and empty results.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset } from '../server/query-worker/dataset.mjs';
import { normalizeQuery } from '../server/query-worker/normalize.mjs';
import { runQuery } from '../server/query-worker/query.mjs';

const ds = loadDataset();

function run(raw) {
  const n = normalizeQuery(raw, ds);
  assert.ok(n.ok, `normalize failed: ${n.error} — ${n.message}`);
  return runQuery(ds, n.query);
}

test('ungrouped sum equals the dataset grand total (exact cents)', () => {
  const r = run({});
  assert.equal(r.grandTotalCents, ds.meta.grandTotalCents);
  assert.equal(r.groups[0].sumCents, ds.meta.grandTotalCents);
});

test('FY split sums to the grand total', () => {
  const a = run({ filters: { year: 2022 } }).grandTotalCents;
  const b = run({ filters: { year: 2023 } }).grandTotalCents;
  assert.equal(a + b, ds.meta.grandTotalCents);
});

test('grouped sum: shown + others reconciles to grand; shares sum to 1', () => {
  const r = run({ groupBy: 'agency', metric: 'sum', limit: 5 });
  assert.equal(r.groups.length, 5);
  assert.ok(r.others, 'expected an All others bucket');
  const shownCents = r.groups.reduce((s, g) => s + g.sumCents, 0);
  assert.equal(shownCents + r.others.sumCents, r.grandTotalCents);
  const shareSum = r.groups.reduce((s, g) => s + g.share, 0) + r.others.share;
  assert.ok(Math.abs(shareSum - 1) < 1e-9, `shares sum to ${shareSum}`);
});

test('count metric: integer values, counts reconcile to matchedRows', () => {
  const r = run({ groupBy: 'category', metric: 'count', limit: 50 });
  for (const g of r.groups) assert.ok(Number.isInteger(g.value));
  const shown = r.groups.reduce((s, g) => s + g.count, 0);
  const others = r.others ? r.others.count : 0;
  assert.equal(shown + others, r.matchedRows);
});

test('avg metric: no others bucket; value equals sum/count', () => {
  const r = run({ groupBy: 'category', metric: 'avg', limit: 50 });
  assert.equal(r.others, null);
  for (const g of r.groups) {
    assert.ok(Math.abs(g.value - g.sumDollars / g.count) < 1e-6);
  }
});

test('top-N + others: others.groupCount = totalGroups - limit', () => {
  const all = run({ groupBy: 'agency', metric: 'sum', limit: 50 });
  const totalGroups = all.groups.length + (all.others ? all.others.groupCount : 0);
  const r = run({ groupBy: 'agency', metric: 'sum', limit: 5 });
  assert.equal(r.others.groupCount, totalGroups - 5);
});

test('concentration present for desc, absent for asc', () => {
  const desc = run({ groupBy: 'agency', metric: 'sum', sort: 'desc', limit: 5 });
  const asc = run({ groupBy: 'agency', metric: 'sum', sort: 'asc', limit: 5 });
  assert.ok(desc.concentration && desc.concentration.top1Share > 0);
  assert.equal(asc.concentration, null);
});

// "Top 1 share: 100%" restates that there is one group; it is not a measurement.
// But a top-1 slice OF MANY groups is a real share, and must survive. The two are
// indistinguishable from the returned rows, so they are asserted on a synthetic
// dataset where the number of groups is chosen rather than discovered.
function syntheticDs(agencyOfRow) {
  const n = agencyOfRow.length;
  return {
    meta: {}, fiscalYears: [2022, 2023], reimbursementCats: new Set(), rows: n,
    dims: { vendors: ['V'], agencies: ['A0', 'A1', 'A2'], categories: ['C'], subcategories: ['S'] },
    cols: {
      vendorIdx: Int32Array.from(agencyOfRow, () => 0),
      agencyIdx: Int32Array.from(agencyOfRow),
      categoryIdx: Uint8Array.from(agencyOfRow, () => 0),
      subcatIdx: Int32Array.from(agencyOfRow, () => 0),
      fyIdx: Uint8Array.from(agencyOfRow, () => 0),
      fmonth: Uint8Array.from(agencyOfRow, () => 1),
      amountCents: Float64Array.from(agencyOfRow, (_, i) => (i + 1) * 100),
    },
  };
}

const rank = (ds_, limit) => runQuery(ds_, {
  metric: 'sum', groupBy: 'agency', sort: 'desc', limit,
  filter: { fyIdx: null, agencyIdx: null, categoryIdx: null, vendorIdx: null, subcatIdx: null, excludeReimbursements: false },
  resolved: {}, compareYears: false,
});

test('concentration is suppressed for a lone group, kept for a top-1 slice', () => {
  const lone = rank(syntheticDs([0, 0, 0]), 10); // one agency in the data
  assert.equal(lone.groups.length, 1);
  assert.equal(lone.concentration, null, 'a lone group is 100% by construction, not a finding');

  const topOfMany = rank(syntheticDs([0, 1, 2]), 1); // three agencies, top-1 shown
  assert.equal(topOfMany.groups.length, 1, 'same row shape as the lone case');
  assert.ok(topOfMany.concentration, 'but a top-1 slice of many IS a real share');
  assert.ok(topOfMany.concentration.topNShare > 0 && topOfMany.concentration.topNShare < 1);
});

test('excludeReimbursements reduces the total by exactly the reimbursement sum', () => {
  const all = run({}).grandTotalCents;
  const excl = run({ filters: { excludeReimbursements: true } }).grandTotalCents;
  // independent reimbursement total straight from the dataset columns
  let reimbCents = 0;
  const { categoryIdx, amountCents } = ds.cols;
  for (let i = 0; i < ds.rows; i++) if (ds.reimbursementCats.has(categoryIdx[i])) reimbCents += amountCents[i];
  assert.ok(reimbCents > 0);
  assert.equal(all - excl, reimbCents);
});

test('empty result is reported, not a confident zero', () => {
  // a reimbursement category filtered AND reimbursements excluded => no rows
  const r = run({ filters: { category: 'Interagency Reimbursements', excludeReimbursements: true } });
  assert.equal(r.empty, true);
  assert.equal(r.matchedRows, 0);
  assert.equal(r.grandTotalCents, 0);
});
