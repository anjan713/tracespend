// Reliability tests — assert the precomputed artifact is internally exact.
// Run with: npm test  (after `npm run build:data`)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', 'public', 'artifacts', 'spending.json');

const TOL = 1; // dollar tolerance for cent rounding

function load() {
  assert.ok(fs.existsSync(FILE), 'spending.json missing — run `npm run build:data` first');
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

const data = load();

test('meta reports a clean reconciliation', () => {
  assert.equal(data.meta.reconciliation.ok, true);
  assert.ok(data.meta.reconciliation.error <= TOL);
  assert.ok(data.meta.grandTotal > 1e9);
  assert.ok(data.meta.rowCount > 0);
});

test('category totals sum to the grand total', () => {
  const sum = data.tree.children.reduce((s, c) => s + c.total, 0);
  assert.ok(Math.abs(sum - data.meta.grandTotal) <= TOL, `sum ${sum} vs ${data.meta.grandTotal}`);
});

test('FY split sums to category and grand totals', () => {
  for (const c of data.tree.children) {
    assert.ok(Math.abs(c.fy2022 + c.fy2023 - c.total) <= TOL, `${c.name} FY split mismatch`);
  }
  const g = data.meta.grandTotalByFY;
  assert.ok(Math.abs(g.fy2022 + g.fy2023 - data.meta.grandTotal) <= TOL);
});

test('every node reconciles with its children (Other preserves remainder)', () => {
  let checked = 0;
  const walk = (n) => {
    if (n.children && n.children.length) {
      const sum = n.children.reduce((s, c) => s + c.total, 0);
      assert.ok(Math.abs(sum - n.total) <= TOL, `node "${n.name}" children ${sum} != total ${n.total}`);
      checked++;
      n.children.forEach(walk);
    }
  };
  walk(data.tree);
  assert.ok(checked > 10, 'expected to check many internal nodes');
});

test('selectivity limits respected (top agencies/vendors + at most one Other)', () => {
  const { agenciesPerCategory, vendorsPerAgency } = data.meta.limits;
  for (const cat of data.tree.children) {
    const agencies = cat.children.filter((c) => c.level === 'agency');
    const others = cat.children.filter((c) => c.level === 'other');
    assert.ok(agencies.length <= agenciesPerCategory, `${cat.name} has too many agency arcs`);
    assert.ok(others.length <= 1, `${cat.name} has more than one Other arc`);
    for (const ag of agencies) {
      const vendors = (ag.children ?? []).filter((c) => c.level === 'vendor');
      const vOther = (ag.children ?? []).filter((c) => c.level === 'other');
      assert.ok(vendors.length <= vendorsPerAgency, `${ag.name} has too many vendor arcs`);
      assert.ok(vOther.length <= 1, `${ag.name} has more than one Other arc`);
    }
  }
});

test('indexes are present, sorted desc, and exact', () => {
  assert.ok(Array.isArray(data.agencyIndex) && data.agencyIndex.length > 0);
  assert.ok(Array.isArray(data.vendorIndex) && data.vendorIndex.length > 0);
  const agSum = data.agencyIndex.reduce((s, a) => s + a.t, 0);
  assert.ok(Math.abs(agSum - data.meta.grandTotal) <= TOL, 'agencyIndex must sum to grand total');
  for (let i = 1; i < data.agencyIndex.length; i++) {
    assert.ok(data.agencyIndex[i - 1].t >= data.agencyIndex[i].t, 'agencyIndex not sorted desc');
  }
  for (let i = 1; i < Math.min(50, data.vendorIndex.length); i++) {
    assert.ok(data.vendorIndex[i - 1].t >= data.vendorIndex[i].t, 'vendorIndex not sorted desc');
  }
});

// Parse a node id into the category/agency/vendor it must contain. "Other"
// segments (__other__:p1 / __other__:tail) leave that level unconstrained.
function expectedFromId(id) {
  if (id === 'root') return {};
  let rest = id;
  let vendor = null;
  let agency = null;
  let category = null;
  const vi = rest.indexOf('|ven:');
  if (vi >= 0) {
    vendor = rest.slice(vi + 5);
    rest = rest.slice(0, vi);
  }
  const ai = rest.indexOf('|ag:');
  if (ai >= 0) {
    agency = rest.slice(ai + 4);
    rest = rest.slice(0, ai);
  }
  if (rest.startsWith('cat:')) category = rest.slice(4);
  if (agency && agency.startsWith('__other__')) agency = null;
  if (vendor && vendor.startsWith('__other__')) vendor = null;
  return { category, agency, vendor };
}

// Stronger than a net-total bound (the data contains credit/refund lines, so an
// individual gross payment can exceed a node's NET total): verify every evidence
// transaction is attached to the node it actually belongs to.
test('evidence transactions map to the correct node (category/agency/vendor)', () => {
  for (const [id, txs] of Object.entries(data.evidence)) {
    const exp = expectedFromId(id);
    for (const t of txs) {
      if (exp.category != null) assert.equal(t.category, exp.category, `evidence in ${id} has wrong category`);
      if (exp.agency != null) assert.equal(t.agency, exp.agency, `evidence in ${id} has wrong agency`);
      if (exp.vendor != null) assert.equal(t.vendor, exp.vendor, `evidence in ${id} has wrong vendor`);
      assert.ok(Math.abs(t.amount) <= data.meta.grandTotal, `evidence ${t.amount} is implausibly large`);
    }
  }
});

// Regression for the paginated "Other" feature: every Other is either a
// drillable container (id …:pN, has children) or a terminal tail (id …:tail,
// a leaf), and each revealed page stays within the per-level slice limit.
test('nested Other buckets: containers drill, tails are leaves, pages bounded', () => {
  const { agenciesPerCategory, vendorsPerAgency } = data.meta.limits;
  let containers = 0;
  let tails = 0;
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (c.level === 'other') {
        if (c.id.endsWith(':tail')) {
          tails++;
          assert.ok(!c.children || c.children.length === 0, `tail ${c.id} must be a leaf`);
        } else {
          containers++;
          assert.ok(c.children && c.children.length, `container ${c.id} must have children`);
          const reals = c.children.filter((k) => k.level !== 'other');
          const others = c.children.filter((k) => k.level === 'other');
          const limit = reals[0]?.level === 'agency' ? agenciesPerCategory : vendorsPerAgency;
          assert.ok(reals.length <= limit, `${c.id} reveals too many slices`);
          assert.ok(others.length <= 1, `${c.id} has more than one nested Other`);
        }
      }
      walk(c);
    }
  };
  walk(data.tree);
  assert.ok(containers > 0, 'expected at least one drillable Other container');
  assert.ok(tails > 0, 'expected at least one terminal Other tail');
});
