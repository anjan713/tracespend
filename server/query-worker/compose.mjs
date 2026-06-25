// composeSummary — turns a query RESULT into a factual, plain-English sentence
// plus structured fact chips. This is CODE, not AI: it owns every number and the
// meaning. The AI reword step may only rephrase the sentence; it can never change
// a figure here, and the chips are always shown verbatim as the source of truth.

export function money(n) {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 100 ? 2 : 0;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(part, whole) {
  if (!whole) return 'n/a';
  return ((part / whole) * 100).toFixed(1) + '%';
}

const NOUN = {
  vendor: 'vendor', agency: 'agency', category: 'category', subcategory: 'subcategory',
};
const NOUN_PLURAL = {
  vendor: 'vendors', agency: 'agencies', category: 'categories', subcategory: 'subcategories',
};

/** Human scope phrase from the resolved filters, e.g. "in FY2023 for Travel". */
function scopePhrase(resolved, excludeReimbursements) {
  const parts = [];
  if (resolved.year) parts.push(`in FY${resolved.year}`);
  else parts.push('across FY2022–FY2023');
  if (resolved.category) parts.push(`in ${resolved.category}`);
  if (resolved.agency) parts.push(`by ${resolved.agency}`);
  if (resolved.vendor) parts.push(`to ${resolved.vendor}`);
  if (resolved.subcategory) parts.push(`in ${resolved.subcategory}`);
  let s = parts.join(' ');
  if (excludeReimbursements) s += ' (excluding reimbursements)';
  return s;
}

const fact = (label, value) => ({ label, value });

/**
 * @param {object} q       normalized query (with .resolved)
 * @param {object} result  runQuery() output
 * @returns {{answer:string, facts:{label:string,value:string}[]}}
 */
export function composeSummary(q, result) {
  const { metric, groupBy, sort } = q;
  const scope = scopePhrase(q.resolved, q.filter.excludeReimbursements);
  const rows = result.matchedRows.toLocaleString();

  if (result.empty) {
    return { answer: `No matching payments found ${scope}.`, facts: [] };
  }

  // ---- year-over-year by dimension ("what changed from FY2022 to FY2023?") ----
  if (result.yoy) return composeYoy(q, result);

  // ---- ungrouped totals ----
  if (groupBy === 'none') {
    const g = result.groups[0];
    if (metric === 'count') {
      return {
        answer: `There were ${rows} payments ${scope}.`,
        facts: [fact('Payments', rows)],
      };
    }
    if (metric === 'avg') {
      return {
        answer: `The average payment ${scope} is ${money(g.value)}, across ${rows} payments.`,
        facts: [fact('Average', money(g.value)), fact('Payments', rows)],
      };
    }
    return {
      answer: `Total spending ${scope} is ${money(result.grandTotal)}, across ${rows} payments.`,
      facts: [fact('Total', money(result.grandTotal)), fact('Payments', rows)],
    };
  }

  // ---- time axes (chronological) ----
  if (groupBy === 'fiscalYear') {
    const by = Object.fromEntries(result.groups.map((g) => [g.label, g]));
    const a = by['FY2022'];
    const b = by['FY2023'];
    if (a && b) {
      const chg = a.sumDollars ? ((b.sumDollars - a.sumDollars) / a.sumDollars) * 100 : null;
      const dir = chg == null ? '' : chg >= 0 ? `up ${chg.toFixed(1)}%` : `down ${Math.abs(chg).toFixed(1)}%`;
      return {
        answer: `Spending ${scope} went from ${money(a.sumDollars)} in FY2022 to ${money(b.sumDollars)} in FY2023${dir ? ` (${dir})` : ''}.`,
        facts: [fact('FY2022', money(a.sumDollars)), fact('FY2023', money(b.sumDollars)), fact('Change', dir || 'n/a')],
      };
    }
  }
  if (groupBy === 'fiscalMonth') {
    const top = [...result.groups].sort((x, y) => y.sumDollars - x.sumDollars)[0];
    return {
      answer: `Spending ${scope} is split across ${result.groups.length} fiscal months; the highest is ${top.label} at ${money(top.sumDollars)}.`,
      facts: result.groups.slice(0, 6).map((g) => fact(g.label, money(g.sumDollars))),
    };
  }

  // ---- ranked group-bys ----
  const noun = NOUN[groupBy] || 'group';
  const plural = NOUN_PLURAL[groupBy] || 'groups';
  const lead = result.groups[0];
  const superlative = sort === 'asc' ? 'lowest' : 'highest';

  if (metric === 'count') {
    const facts = result.groups.slice(0, 3).map((g) => fact(trimLabel(g.label), g.count.toLocaleString()));
    return {
      answer: `By payment count ${scope}, the ${superlative} ${noun} is ${lead.label.trim()} with ${lead.count.toLocaleString()} payments.`,
      facts,
    };
  }
  if (metric === 'avg') {
    const facts = result.groups.slice(0, 3).map((g) => fact(trimLabel(g.label), money(g.value)));
    return {
      answer: `By average payment ${scope}, the ${superlative} ${noun} is ${lead.label.trim()} at ${money(lead.value)}.`,
      facts,
    };
  }

  // metric === 'sum'
  const facts = result.groups.slice(0, 3).map((g) => fact(trimLabel(g.label), money(g.sumDollars)));
  let answer =
    `The ${sort === 'asc' ? 'smallest' : 'largest'} ${noun} ${scope} is ${lead.label.trim()} at ` +
    `${money(lead.sumDollars)} (${pct(lead.sumCents, result.grandTotalCents)} of ${money(result.grandTotal)}).`;
  if (result.groups[1]) {
    answer += ` Next: ${result.groups[1].label.trim()} (${money(result.groups[1].sumDollars)})`;
    if (result.groups[2]) answer += ` and ${result.groups[2].label.trim()} (${money(result.groups[2].sumDollars)})`;
    answer += '.';
  }
  if (sort === 'desc' && result.concentration) {
    facts.push(fact(`Top ${result.groups.length} share`, (result.concentration.topNShare * 100).toFixed(1) + '%'));
  }
  void plural;
  return { answer, facts };
}

function trimLabel(s) {
  const t = String(s).trim();
  return t.length > 28 ? t.slice(0, 27) + '…' : t;
}

function signedPct(p) {
  if (p == null) return 'n/a';
  return (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
}

/** "What changed from FY2022 to FY2023?" — overall delta + the biggest mover(s). */
function composeYoy(q, result) {
  const r = q.resolved;
  const noun = NOUN[result.groupBy] || 'group';
  const parts = [];
  if (r.category) parts.push(`in ${r.category}`);
  if (r.agency) parts.push(`by ${r.agency}`);
  if (r.vendor) parts.push(`to ${r.vendor}`);
  if (r.subcategory) parts.push(`in ${r.subcategory}`);
  if (q.filter.excludeReimbursements) parts.push('(excluding reimbursements)');
  const scope = parts.length ? ' ' + parts.join(' ') : '';
  const overall =
    result.deltaPct == null
      ? ''
      : result.deltaPct >= 0
      ? `up ${result.deltaPct.toFixed(1)}%`
      : `down ${Math.abs(result.deltaPct).toFixed(1)}%`;

  const facts = [
    fact('FY2022', money(result.fy2022)),
    fact('FY2023', money(result.fy2023)),
    fact('Change', overall || 'n/a'),
  ];

  let answer =
    `From FY2022 to FY2023, total spending${scope} went from ${money(result.fy2022)} to ` +
    `${money(result.fy2023)}${overall ? ` (${overall})` : ''}.`;

  const inc = result.topIncrease;
  const dec = result.topDecrease;
  if (inc && inc.deltaCents > 0) {
    answer +=
      ` The biggest increase by ${noun} was ${String(inc.label).trim()}: ` +
      `${money(inc.fy2022)} → ${money(inc.fy2023)} (${signedPct(inc.deltaPct)}).`;
    facts.push(fact('Top increase', `${trimLabel(inc.label)} ${signedPct(inc.deltaPct)}`));
  }
  if (dec && dec.deltaCents < 0 && (!inc || dec.key !== inc.key)) {
    answer +=
      ` The biggest decrease was ${String(dec.label).trim()}: ` +
      `${money(dec.fy2022)} → ${money(dec.fy2023)} (${signedPct(dec.deltaPct)}).`;
    facts.push(fact('Top decrease', `${trimLabel(dec.label)} ${signedPct(dec.deltaPct)}`));
  }
  return { answer, facts };
}
