// Validate + normalize the AI-produced Query, and resolve every name filter to a
// canonical dimension index. Bad enum values are rejected (not crashed on); an
// unresolved name returns a structured error so the caller can say "couldn't find
// an exact match for X" instead of confidently reporting $0.

import { resolveAgency, resolveCategory, resolveVendor, resolveSubcategory } from './resolve.mjs';

export const METRICS = ['sum', 'count', 'avg'];
export const GROUP_BYS = ['none', 'vendor', 'agency', 'category', 'subcategory', 'fiscalYear', 'fiscalMonth'];
export const SORTS = ['desc', 'asc'];

const GROUP_ALIASES = {
  vendor: 'vendor', vendors: 'vendor',
  agency: 'agency', agencies: 'agency', department: 'agency',
  category: 'category', categories: 'category',
  subcategory: 'subcategory', subcategories: 'subcategory', subcat: 'subcategory',
  fiscalyear: 'fiscalYear', fy: 'fiscalYear', year: 'fiscalYear',
  fiscalmonth: 'fiscalMonth', month: 'fiscalMonth', monthly: 'fiscalMonth',
  none: 'none', total: 'none', overall: 'none',
};

const ok = (query) => ({ ok: true, query });
const fail = (error, message) => ({ ok: false, error, message });

function clampLimit(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 10;
  return Math.min(50, Math.max(1, v));
}

/**
 * @param {object} raw  the AI Query
 * @param {import('./dataset.mjs').Dataset} ds
 */
export function normalizeQuery(raw, ds) {
  if (!raw || typeof raw !== 'object') return fail('bad_query', 'Query was empty or not an object.');

  const metric = String(raw.metric ?? 'sum').toLowerCase();
  if (!METRICS.includes(metric)) return fail('bad_metric', `Unknown metric "${raw.metric}".`);

  const gbRaw = String(raw.groupBy ?? 'none').toLowerCase();
  const groupBy = GROUP_ALIASES[gbRaw];
  if (!groupBy) return fail('bad_groupby', `Unknown groupBy "${raw.groupBy}".`);

  const sort = SORTS.includes(String(raw.sort).toLowerCase()) ? String(raw.sort).toLowerCase() : 'desc';
  const limit = clampLimit(raw.limit ?? 10);
  const compareYears =
    raw.compareYears === true || String(raw.compareYears ?? '').toLowerCase() === 'true';

  const f = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  const filter = {
    fyIdx: null,
    agencyIdx: null,
    categoryIdx: null,
    vendorIdx: null,
    subcatIdx: null,
    excludeReimbursements: f.excludeReimbursements === true,
  };
  const resolved = {};

  // Year
  if (f.year != null && f.year !== '') {
    const yr = parseInt(f.year, 10);
    const i = ds.fiscalYears.indexOf(yr);
    if (i < 0) return fail('bad_year', `No data for fiscal year ${f.year}.`);
    filter.fyIdx = i;
    resolved.year = yr;
  }

  // Name filters — unresolved names are an explicit, friendly failure.
  if (f.category) {
    const m = resolveCategory(f.category, ds.dims.categories);
    if (!m) return fail('unresolved_category', `Couldn't find a category matching "${f.category}".`);
    filter.categoryIdx = m.index;
    resolved.category = m.name;
  }
  if (f.agency) {
    const m = resolveAgency(f.agency, ds.dims.agencies);
    if (!m) return fail('unresolved_agency', `Couldn't find an agency matching "${f.agency}".`);
    filter.agencyIdx = m.index;
    resolved.agency = m.name;
  }
  if (f.vendor) {
    const m = resolveVendor(f.vendor, ds.dims.vendors);
    if (!m) return fail('unresolved_vendor', `Couldn't find a vendor matching "${f.vendor}".`);
    filter.vendorIdx = m.index;
    resolved.vendor = m.name;
  }
  if (f.subcategory) {
    const m = resolveSubcategory(f.subcategory, ds.dims.subcategories);
    if (!m) return fail('unresolved_subcategory', `Couldn't find a subcategory matching "${f.subcategory}".`);
    filter.subcatIdx = m.index;
    resolved.subcategory = m.name;
  }

  // Guard: a trend (monthly/yearly) group-by must not be pinned to a single year
  // unless the user grouped by month within that year (allowed). For fiscalYear
  // group-by, drop any year filter so the trend isn't collapsed to one bar.
  if (groupBy === 'fiscalYear' && filter.fyIdx != null) {
    filter.fyIdx = null;
    delete resolved.year;
  }

  // Year-over-year "what changed" mode: compare FY2022 vs FY2023 PER GROUP. It
  // needs a ranked dimension and BOTH years, so coerce sensibly: force metric
  // "sum", default a missing/time dimension to "category", and drop any single
  // year filter. (For just the overall total change, groupBy "fiscalYear" is used
  // instead and compareYears stays false.)
  let effGroupBy = groupBy;
  let effMetric = metric;
  if (compareYears) {
    effMetric = 'sum';
    if (!['vendor', 'agency', 'category', 'subcategory'].includes(effGroupBy)) effGroupBy = 'category';
    filter.fyIdx = null;
    delete resolved.year;
  }

  return ok({ metric: effMetric, groupBy: effGroupBy, sort, limit, filter, resolved, compareYears });
}
