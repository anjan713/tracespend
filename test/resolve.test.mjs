// Resolver tests — name variants map to canonical names; non-matches return
// undefined (never a confident wrong match → no silent $0).

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgency, resolveCategory, resolveVendor } from '../server/query-worker/resolve.mjs';

const AGENCIES = [
  'Health Care Authority',
  'Department of Transportation',
  'Department of Social and Health Services',
  'Department of Fish and Wildlife',
];
const CATEGORIES = [
  'Grants, Benefits & Client Services',
  'Goods and Services',
  'Capital Outlays',
  'Personal Service Contracts',
  'Travel',
  'Interagency Reimbursements',
];
const VENDORS = ['ACME CONSTRUCTION INC', 'GLOBEX CORPORATION', 'BOEING COMPANY'];

test('agency variants resolve to canonical', () => {
  assert.equal(resolveAgency('health care authority', AGENCIES)?.name, 'Health Care Authority');
  assert.equal(resolveAgency('Dept of Transportation', AGENCIES)?.name, 'Department of Transportation');
  assert.equal(resolveAgency('Dept of Fish & Wildlife', AGENCIES)?.name, 'Department of Fish and Wildlife');
});

test('unrelated agency name does not resolve', () => {
  assert.equal(resolveAgency('National Aeronautics Space xyz', AGENCIES), undefined);
  assert.equal(resolveAgency('', AGENCIES), undefined);
});

test('category synonyms resolve', () => {
  assert.equal(resolveCategory('grants', CATEGORIES)?.name, 'Grants, Benefits & Client Services');
  assert.equal(resolveCategory('capital construction', CATEGORIES)?.name, 'Capital Outlays');
  assert.equal(resolveCategory('travel', CATEGORIES)?.name, 'Travel');
});

test('vendor partial names resolve, junk does not', () => {
  assert.equal(resolveVendor('Boeing', VENDORS)?.name, 'BOEING COMPANY');
  assert.equal(resolveVendor('Globex', VENDORS)?.name, 'GLOBEX CORPORATION');
  assert.equal(resolveVendor('zzzzz nonexistent vendor', VENDORS), undefined);
});
