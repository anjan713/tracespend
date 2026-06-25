// Normalize/validation tests — defaults, clamps, enum rejection, name resolution,
// and the trend-vs-single-year guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuery } from '../server/query-worker/normalize.mjs';

const ds = {
  fiscalYears: [2022, 2023],
  dims: {
    categories: ['Goods and Services', 'Capital Outlays', 'Interagency Reimbursements'],
    agencies: ['Health Care Authority', 'Department of Transportation'],
    vendors: ['ACME INC', 'GLOBEX CORP'],
    subcategories: ['Office Supplies'],
  },
};

test('defaults are applied', () => {
  const r = normalizeQuery({}, ds);
  assert.equal(r.ok, true);
  assert.equal(r.query.metric, 'sum');
  assert.equal(r.query.groupBy, 'none');
  assert.equal(r.query.sort, 'desc');
  assert.equal(r.query.limit, 10);
  assert.equal(r.query.filter.excludeReimbursements, false);
});

test('limit clamps to 1..50', () => {
  assert.equal(normalizeQuery({ limit: 999 }, ds).query.limit, 50);
  assert.equal(normalizeQuery({ limit: 0 }, ds).query.limit, 1);
  assert.equal(normalizeQuery({ limit: -5 }, ds).query.limit, 1);
});

test('groupBy aliases normalize', () => {
  assert.equal(normalizeQuery({ groupBy: 'agencies' }, ds).query.groupBy, 'agency');
  assert.equal(normalizeQuery({ groupBy: 'monthly' }, ds).query.groupBy, 'fiscalMonth');
  assert.equal(normalizeQuery({ groupBy: 'fy' }, ds).query.groupBy, 'fiscalYear');
});

test('bad enums are rejected, not crashed on', () => {
  assert.equal(normalizeQuery({ metric: 'median' }, ds).error, 'bad_metric');
  assert.equal(normalizeQuery({ groupBy: 'planet' }, ds).error, 'bad_groupby');
  assert.equal(normalizeQuery({ filters: { year: 2025 } }, ds).error, 'bad_year');
});

test('name filters resolve or fail explicitly', () => {
  const okR = normalizeQuery({ filters: { agency: 'health care' } }, ds);
  assert.equal(okR.ok, true);
  assert.equal(okR.query.resolved.agency, 'Health Care Authority');

  const bad = normalizeQuery({ filters: { agency: 'nasa moon base' } }, ds);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unresolved_agency');
});

test('fiscalYear group-by drops a single-year filter (trend guard)', () => {
  const r = normalizeQuery({ groupBy: 'fiscalYear', filters: { year: 2023 } }, ds);
  assert.equal(r.ok, true);
  assert.equal(r.query.filter.fyIdx, null);
  assert.equal(r.query.resolved.year, undefined);
});
