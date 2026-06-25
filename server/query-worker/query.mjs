// The code-only query worker. ONE pass over the typed-array dataset produces sum
// + count per group; everything else (metric, sort, top-N + "All others", share,
// concentration) is derived from those exact aggregates. Money is summed in
// integer CENTS so results reconcile to the cent. The AI never runs this — it
// only chooses the Query that gets passed in.

const MONTHS_IN_FY = 12;

/** Build a per-row predicate from the normalized filter. */
function makePredicate(ds, filter) {
  const { vendorIdx, agencyIdx, categoryIdx, subcatIdx, fyIdx } = ds.cols;
  const reimb = ds.reimbursementCats;
  return (i) => {
    if (filter.fyIdx != null && fyIdx[i] !== filter.fyIdx) return false;
    if (filter.agencyIdx != null && agencyIdx[i] !== filter.agencyIdx) return false;
    if (filter.categoryIdx != null && categoryIdx[i] !== filter.categoryIdx) return false;
    if (filter.vendorIdx != null && vendorIdx[i] !== filter.vendorIdx) return false;
    if (filter.subcatIdx != null && subcatIdx[i] !== filter.subcatIdx) return false;
    if (filter.excludeReimbursements && reimb.has(categoryIdx[i])) return false;
    return true;
  };
}

/** Returns the key column + label fn for a group-by. null key column => no grouping. */
function groupAccessor(ds, groupBy) {
  switch (groupBy) {
    case 'vendor':
      return { col: ds.cols.vendorIdx, label: (k) => ds.dims.vendors[k], time: false };
    case 'agency':
      return { col: ds.cols.agencyIdx, label: (k) => ds.dims.agencies[k], time: false };
    case 'category':
      return { col: ds.cols.categoryIdx, label: (k) => ds.dims.categories[k], time: false };
    case 'subcategory':
      return { col: ds.cols.subcatIdx, label: (k) => ds.dims.subcategories[k], time: false };
    case 'fiscalYear':
      return { col: ds.cols.fyIdx, label: (k) => `FY${ds.fiscalYears[k]}`, time: true };
    case 'fiscalMonth':
      return { col: ds.cols.fmonth, label: (k) => (k === 0 ? 'Unknown month' : `Fiscal month ${k}`), time: true };
    default:
      return null; // 'none'
  }
}

const toDollars = (cents) => cents / 100;

/**
 * @param {import('./dataset.mjs').Dataset} ds
 * @param {object} q  normalized query from normalizeQuery()
 */
export function runQuery(ds, q) {
  const { metric, groupBy, sort, limit, filter, compareYears } = q;
  const { amountCents } = ds.cols;
  const n = ds.rows;
  const pass = makePredicate(ds, filter);
  const acc = groupAccessor(ds, groupBy);

  let matchedRows = 0;
  let grandCents = 0;

  // ---- single pass ----
  let groups; // Map<number,{cents,count}> or single accumulator
  if (!acc) {
    let cents = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!pass(i)) continue;
      cents += amountCents[i];
      count++;
    }
    matchedRows = count;
    grandCents = cents;
    const value = metric === 'count' ? count : metric === 'avg' ? (count ? toDollars(cents / count) : 0) : toDollars(cents);
    return {
      metric, groupBy, sort, limit,
      grandTotal: toDollars(grandCents), grandTotalCents: grandCents, matchedRows,
      groups: [{ key: null, label: 'Total', value, sumDollars: toDollars(cents), sumCents: cents, count, share: 1 }],
      others: null, concentration: null, empty: matchedRows === 0,
    };
  }

  // ---- year-over-year by dimension ("what changed from FY2022 to FY2023?") ----
  // One pass, splitting each group's cents by fiscal year, then a per-group delta.
  if (compareYears && acc && !acc.time) {
    const { fyIdx } = ds.cols;
    const col = acc.col;
    const yg = new Map(); // key -> { c0, c1, count }
    let grand0 = 0;
    let grand1 = 0;
    for (let i = 0; i < n; i++) {
      if (!pass(i)) continue;
      const k = col[i];
      let g = yg.get(k);
      if (!g) { g = { c0: 0, c1: 0, count: 0 }; yg.set(k, g); }
      if (fyIdx[i] === 0) { g.c0 += amountCents[i]; grand0 += amountCents[i]; }
      else { g.c1 += amountCents[i]; grand1 += amountCents[i]; }
      g.count++;
      matchedRows++;
    }
    const rows = [];
    for (const [key, g] of yg) {
      const deltaCents = g.c1 - g.c0;
      rows.push({
        key,
        label: acc.label(key),
        fy2022Cents: g.c0,
        fy2023Cents: g.c1,
        fy2022: toDollars(g.c0),
        fy2023: toDollars(g.c1),
        deltaCents,
        delta: toDollars(deltaCents),
        deltaPct: g.c0 ? (deltaCents / g.c0) * 100 : null,
        count: g.count,
        // kept for trimResult()/chartHint() compatibility:
        value: toDollars(deltaCents),
        sumDollars: toDollars(g.c1),
        share: null,
      });
    }
    const byDelta = [...rows].sort((a, b) => b.deltaCents - a.deltaCents);
    const topIncrease = byDelta[0] ?? null;
    const topDecrease = byDelta[byDelta.length - 1] ?? null;
    rows.sort((a, b) => (sort === 'asc' ? a.deltaCents - b.deltaCents : b.deltaCents - a.deltaCents));
    const grandCentsBoth = grand0 + grand1;
    return {
      metric: 'sum', groupBy, sort, limit, yoy: true,
      grandTotal: toDollars(grandCentsBoth), grandTotalCents: grandCentsBoth, matchedRows,
      fy2022Cents: grand0, fy2023Cents: grand1,
      fy2022: toDollars(grand0), fy2023: toDollars(grand1),
      deltaCents: grand1 - grand0, delta: toDollars(grand1 - grand0),
      deltaPct: grand0 ? ((grand1 - grand0) / grand0) * 100 : null,
      topIncrease, topDecrease,
      groups: rows.slice(0, limit), others: null, concentration: null, empty: matchedRows === 0,
    };
  }

  groups = new Map();
  const col = acc.col;
  for (let i = 0; i < n; i++) {
    if (!pass(i)) continue;
    const k = col[i];
    let g = groups.get(k);
    if (!g) { g = { cents: 0, count: 0 }; groups.set(k, g); }
    g.cents += amountCents[i];
    g.count++;
    matchedRows++;
    grandCents += amountCents[i];
  }

  // ---- materialize groups ----
  let list = [];
  for (const [key, g] of groups) {
    list.push({
      key,
      label: acc.label(key),
      sumCents: g.cents,
      sumDollars: toDollars(g.cents),
      count: g.count,
      value: metric === 'count' ? g.count : metric === 'avg' ? (g.count ? toDollars(g.cents / g.count) : 0) : toDollars(g.cents),
    });
  }

  const shareDenomCents = grandCents;
  const setShare = (row) => {
    row.share =
      metric === 'count'
        ? (matchedRows ? row.count / matchedRows : null)
        : metric === 'avg'
        ? null
        : shareDenomCents
        ? row.sumCents / shareDenomCents
        : null;
    return row;
  };

  // ---- time axes: chronological, never bucketed ----
  if (acc.time) {
    list.sort((a, b) => a.key - b.key);
    list.forEach(setShare);
    return {
      metric, groupBy, sort, limit,
      grandTotal: toDollars(grandCents), grandTotalCents: grandCents, matchedRows,
      groups: list, others: null, concentration: null, empty: matchedRows === 0,
    };
  }

  // ---- ranked axes: sort, top-N + "All others" ----
  list.sort((a, b) => (sort === 'asc' ? a.value - b.value : b.value - a.value));

  const noOthers = metric === 'avg'; // an averaged "others" bucket is meaningless
  const shown = list.slice(0, limit);
  const rest = list.slice(limit);
  shown.forEach(setShare);

  let others = null;
  if (!noOthers && rest.length) {
    const cents = rest.reduce((s, r) => s + r.sumCents, 0);
    const count = rest.reduce((s, r) => s + r.count, 0);
    others = {
      label: `All others · ${rest.length.toLocaleString()} ${labelNoun(groupBy)}`,
      groupCount: rest.length,
      sumCents: cents,
      sumDollars: toDollars(cents),
      count,
      value: metric === 'count' ? count : toDollars(cents),
      share: metric === 'count' ? (matchedRows ? count / matchedRows : null) : shareDenomCents ? cents / shareDenomCents : null,
    };
  }

  // concentration only makes sense for a descending ranking
  let concentration = null;
  if (sort === 'desc' && shown.length && metric !== 'avg') {
    const top1 = shown[0].share ?? 0;
    const topN = shown.reduce((s, r) => s + (r.share ?? 0), 0);
    concentration = { top1Share: top1, topNShare: topN, topN: shown.length };
  }

  return {
    metric, groupBy, sort, limit,
    grandTotal: toDollars(grandCents), grandTotalCents: grandCents, matchedRows,
    groups: shown, others, concentration, empty: matchedRows === 0,
  };
}

function labelNoun(groupBy) {
  return groupBy === 'vendor' ? 'vendors'
    : groupBy === 'agency' ? 'agencies'
    : groupBy === 'category' ? 'categories'
    : groupBy === 'subcategory' ? 'subcategories'
    : 'groups';
}
