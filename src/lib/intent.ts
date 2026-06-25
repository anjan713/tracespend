// Deterministic intent parser — the reliable core of the "AI agent".
// It maps a natural-language question to (a) an exact, templated answer built
// only from precomputed numbers, and (b) a chart/panel action. It NEVER does
// free-form math: every figure comes straight from the artifact.

import type { AgentResult, FYMode, SpendData, SpendNode } from '../types';
import { findCategory, valueOf } from './data';
import { money, pct, signedPct } from './format';

const STOP = new Set([
  'department', 'departments', 'dept', 'office', 'of', 'and', 'the', 'state',
  'commission', 'board', 'authority', 'for', 'div', 'division', 'agency',
  'services', 'service', 'wa', 'washington',
]);

const CATEGORY_SYNONYMS: Record<string, string[]> = {
  'Grants, Benefits & Client Services': ['grant', 'grants', 'benefit', 'benefits', 'client', 'welfare', 'medicaid', 'assistance'],
  'Goods and Services': ['goods', 'supplies', 'equipment', 'operating'],
  'Capital Outlays': ['capital', 'construction', 'building', 'buildings', 'infrastructure', 'outlay', 'outlays'],
  'Personal Service Contracts': ['contract', 'contracts', 'consultant', 'consultants', 'personal service'],
  Travel: ['travel', 'flights', 'lodging', 'mileage'],
  'Debt Service': ['debt', 'bond', 'bonds', 'interest'],
  'Cost Of Goods Sold': ['cost of goods', 'cogs', 'resale'],
  'Interagency Reimbursements': ['interagency', 'inter-agency'],
  'Intra-Agency Reimbursements': ['intra-agency', 'intra agency', 'intraagency'],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9$%.\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function keywords(name: string): string[] {
  return norm(name)
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

/** Match a category from the query (synonyms + name tokens). */
function matchCategory(q: string, data: SpendData): SpendNode | undefined {
  for (const [name, syns] of Object.entries(CATEGORY_SYNONYMS)) {
    if (syns.some((s) => q.includes(s))) {
      const node = data.tree.children?.find((c) => c.name === name);
      if (node) return node;
    }
  }
  // fall back to fuzzy name match
  const direct = findCategory(data.tree, q);
  return direct;
}

/** Score-match an agency name against the query. */
function matchAgency(q: string, data: SpendData): string | undefined {
  let best: { name: string; score: number; total: number } | undefined;
  for (const a of data.agencyIndex) {
    const kws = keywords(a.n);
    if (!kws.length) continue;
    let score = 0;
    for (const k of kws) if (q.includes(k)) score += 1;
    // require at least one strong keyword hit
    if (score > 0) {
      const ratio = score / kws.length;
      const eff = ratio + score * 0.01;
      if (!best || eff > best.score || (eff === best.score && a.t > best.total)) {
        best = { name: a.n, score: eff, total: a.t };
      }
    }
  }
  return best && best.score >= 0.5 ? best.name : best && best.score >= 0.34 ? best.name : undefined;
}

/** Find an agency NODE (for focusing the sundial) by name — biggest occurrence. */
function findAgencyNode(name: string, data: SpendData): SpendNode | undefined {
  let best: SpendNode | undefined;
  data.tree.children?.forEach((cat) =>
    cat.children?.forEach((ag) => {
      if (ag.level === 'agency' && ag.name === name) {
        if (!best || ag.total > best.total) best = ag;
      }
    })
  );
  return best;
}

/** Match a vendor from the searchable index. */
function matchVendor(q: string, data: SpendData): string | undefined {
  // try explicit "to X" / quoted phrases first
  const quoted = q.match(/"([^"]+)"/);
  const probe = quoted ? quoted[1] : q;
  let best: { name: string; len: number } | undefined;
  for (const v of data.vendorIndex.slice(0, 1500)) {
    const vn = norm(v.n);
    const first = vn.split(' ').slice(0, 2).join(' ');
    if (first.length >= 4 && probe.includes(first)) {
      if (!best || first.length > best.len) best = { name: v.n, len: first.length };
    }
  }
  return best?.name;
}

function parseAmount(q: string): number | undefined {
  const m = q.match(/(?:over|above|more than|at least|minimum|min|>)\s*\$?\s*([\d,.]+)\s*(k|thousand|m|million|b|billion)?/);
  if (!m) return undefined;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const unit = m[2];
  if (unit) {
    if (/^k|thousand/.test(unit)) n *= 1e3;
    else if (/^m|million/.test(unit)) n *= 1e6;
    else if (/^b|billion/.test(unit)) n *= 1e9;
  }
  return Number.isFinite(n) ? n : undefined;
}

function detectFY(q: string): FYMode | undefined {
  if (/\b(fy\s*2023|2023 only|fiscal 2023|in 2023|for 2023)\b/.test(q)) return 'fy2023';
  if (/\b(fy\s*2022|2022 only|fiscal 2022|in 2022|for 2022)\b/.test(q)) return 'fy2022';
  if (/\b(all years|both years|all fy|combined|total)\b/.test(q)) return 'all';
  return undefined;
}

// ---------- main ----------
export function parseQuery(raw: string, data: SpendData): AgentResult {
  const q = norm(raw);
  const root = data.tree;
  const grand = data.meta.grandTotal;
  const minAmount = parseAmount(q);
  const fyOverride = detectFY(q);

  const isGrowth = /(grew|grow|growth|increase|increas|rising|rose|jump|surge|up the most|biggest change|year over year|yoy|year-over-year)/.test(q);
  const isReset = /(reset|start over|overview|clear|go home|whole budget|all spending|the big picture|top level)/.test(q);
  const wantsAgencies = /(agenc|department|dept|who spends|which agenc)/.test(q);
  const wantsVendors = /(vendor|vendors|paid to|payments to|recipient|recipients|received|contractor|companies|company|firms)/.test(q);
  const wantsCategories = /(categor|where.*(money|spend)|breakdown|types of spending|what.*spent on|biggest area)/.test(q);

  const cat = matchCategory(q, data);
  const agencyName = matchAgency(q, data);
  const vendorName = !agencyName ? matchVendor(q, data) : undefined;

  const fyFacts = (n: { fy2022: number; fy2023: number }) => [
    { label: 'FY2022', value: money(n.fy2022) },
    { label: 'FY2023', value: money(n.fy2023) },
    { label: 'Change', value: n.fy2022 ? signedPct(((n.fy2023 - n.fy2022) / n.fy2022) * 100) : 'n/a' },
  ];

  // 1) Reset / overview
  if (isReset && !cat && !agencyName && !vendorName) {
    const top = [...(root.children ?? [])].sort((a, b) => b.total - a.total).slice(0, 3);
    return {
      intent: 'overview',
      answer: `Across FY2022–FY2023, total spending was ${money(grand)} over ${data.meta.rowCount.toLocaleString()} payments. The largest area is ${top[0].name} at ${money(top[0].total)} (${pct(top[0].total, grand)}).`,
      facts: [
        { label: 'Total', value: money(grand) },
        { label: '#1', value: `${top[0].name} · ${money(top[0].total)}` },
        ...fyFacts(data.meta.grandTotalByFY),
      ],
      action: { reset: true, fyMode: fyOverride ?? 'all', minAmount },
    };
  }

  // 2) Growth / change
  if (isGrowth) {
    if (cat) {
      const ags = [...(cat.children ?? [])]
        .filter((c) => c.level === 'agency' && c.fy2022 > 0)
        .map((c) => ({ c, chg: (c.fy2023 - c.fy2022) / c.fy2022 }))
        .sort((a, b) => b.c.fy2023 - b.c.fy2022 - (a.c.fy2023 - a.c.fy2022));
      const top = ags[0];
      return {
        intent: 'growth-in-category',
        answer: top
          ? `Within ${cat.name}, ${top.c.name} had the largest dollar increase: ${money(top.c.fy2022)} → ${money(top.c.fy2023)} (${signedPct(top.chg * 100)}).`
          : `${cat.name} changed ${signedPct(((cat.fy2023 - cat.fy2022) / cat.fy2022) * 100)} from FY2022 to FY2023.`,
        facts: fyFacts(cat),
        action: { focusId: cat.id, highlightIds: top ? [top.c.id] : [], fyMode: 'all' },
      };
    }
    const cats = [...(root.children ?? [])]
      .map((c) => ({ c, delta: c.fy2023 - c.fy2022 }))
      .sort((a, b) => b.delta - a.delta);
    const top = cats[0];
    return {
      intent: 'growth-overall',
      answer: `The biggest increase from FY2022 to FY2023 was in ${top.c.name}: ${money(top.c.fy2022)} → ${money(top.c.fy2023)} (${signedPct(((top.c.fy2023 - top.c.fy2022) / top.c.fy2022) * 100)}). Overall spending rose ${signedPct(((data.meta.grandTotalByFY.fy2023 - data.meta.grandTotalByFY.fy2022) / data.meta.grandTotalByFY.fy2022) * 100)}.`,
      facts: [
        { label: 'Top grower', value: top.c.name },
        { label: 'FY2022', value: money(top.c.fy2022) },
        { label: 'FY2023', value: money(top.c.fy2023) },
      ],
      action: { focusId: 'root', highlightIds: cats.slice(0, 1).map((x) => x.c.id), fyMode: 'all' },
    };
  }

  // 3) Vendor lookup
  if (vendorName || (wantsVendors && !agencyName && !cat)) {
    const v = (vendorName && data.vendorIndex.find((x) => x.n === vendorName)) || undefined;
    if (v) {
      return {
        intent: 'vendor-lookup',
        answer: `${v.n.trim()} received ${money(v.t)} across FY2022–FY2023 (${pct(v.t, grand)} of all spending), spanning ${v.ag} ${v.ag === 1 ? 'agency' : 'agencies'}.`,
        facts: [{ label: 'Total', value: money(v.t) }, ...fyFacts({ fy2022: v.a, fy2023: v.b })],
        action: { vendorQuery: v.n.trim(), fyMode: fyOverride, minAmount },
      };
    }
    // generic "show vendors" with no resolvable name -> open search
    return {
      intent: 'vendor-search',
      answer: `Search across the top ${data.meta.searchableVendors.toLocaleString()} vendors by name in the evidence panel, or name an agency to see its vendors.`,
      facts: [{ label: 'Vendors', value: data.meta.vendorCount.toLocaleString() }],
      action: { vendorQuery: raw.replace(/.*(vendor|payments to|paid to)\s*/i, '').trim() || '', minAmount },
    };
  }

  // 4) Agency-scoped vendors ("vendors for X", or just an agency name)
  if (agencyName && (wantsVendors || (!wantsAgencies && !wantsCategories))) {
    const node = findAgencyNode(agencyName, data);
    const agg = data.agencyIndex.find((a) => a.n === agencyName)!;
    if (node) {
      const vendors = [...(node.children ?? [])].filter((c) => c.level === 'vendor').sort((a, b) => b.total - a.total);
      const tv = vendors[0];
      const catLabel = node.id.startsWith('cat:') ? node.id.slice(4).split('|')[0] : 'its top category';
      return {
        intent: 'agency-vendors',
        answer: `${agencyName.trim()} spent ${money(agg.t)} in total (${pct(agg.t, grand)}).${tv ? ` Its largest vendor under ${catLabel} is ${tv.name.trim()} at ${money(tv.total)}.` : ''}`,
        facts: [{ label: 'Agency total', value: money(agg.t) }, ...fyFacts({ fy2022: agg.a, fy2023: agg.b })],
        action: { focusId: node.id, fyMode: fyOverride, minAmount },
      };
    }
  }

  // 5) Top agencies (optionally within a category)
  if (wantsAgencies) {
    if (cat) {
      const ags = [...(cat.children ?? [])].filter((c) => c.level === 'agency').sort((a, b) => valueOf(b, fyOverride ?? 'all') - valueOf(a, fyOverride ?? 'all'));
      const t = ags[0];
      return {
        intent: 'agencies-in-category',
        answer: t
          ? `In ${cat.name}, the top agency is ${t.name} at ${money(t.total)} (${pct(t.total, cat.total)} of the category).`
          : `${cat.name} totals ${money(cat.total)}.`,
        facts: ags.slice(0, 3).map((a) => ({ label: a.name.split(' ').slice(0, 2).join(' '), value: money(a.total) })),
        action: { focusId: cat.id, highlightIds: t ? [t.id] : [], fyMode: fyOverride, minAmount },
      };
    }
    const top = data.agencyIndex.slice(0, 3);
    const node = findAgencyNode(top[0].n, data);
    return {
      intent: 'top-agencies',
      answer: `The biggest-spending agency is ${top[0].n.trim()} at ${money(top[0].t)} (${pct(top[0].t, grand)} of all spending). Next are ${top[1].n.trim()} (${money(top[1].t)}) and ${top[2].n.trim()} (${money(top[2].t)}).`,
      facts: top.map((a) => ({ label: a.n.split(' ').slice(0, 2).join(' '), value: money(a.t) })),
      action: { focusId: node?.id, highlightIds: node ? [node.id] : [], fyMode: fyOverride, minAmount },
    };
  }

  // 6) Category focus
  if (cat) {
    const ags = [...(cat.children ?? [])].filter((c) => c.level === 'agency').sort((a, b) => b.total - a.total);
    return {
      intent: 'category-focus',
      answer: `${cat.name} accounts for ${money(cat.total)} (${pct(cat.total, grand)} of all spending).${ags[0] ? ` Its largest agency is ${ags[0].name} at ${money(ags[0].total)}.` : ''}`,
      facts: [{ label: 'Share', value: pct(cat.total, grand) }, ...fyFacts(cat)],
      action: { focusId: cat.id, fyMode: fyOverride, minAmount },
    };
  }

  // 7) FY lens change only
  if (fyOverride && !wantsCategories) {
    const byFy = fyOverride === 'fy2022' ? data.meta.grandTotalByFY.fy2022 : fyOverride === 'fy2023' ? data.meta.grandTotalByFY.fy2023 : grand;
    return {
      intent: 'fy-lens',
      answer: `Showing ${fyOverride === 'all' ? 'all years combined' : fyOverride.toUpperCase()}: ${money(byFy)} in total. The sundial now reflects this lens.`,
      facts: [{ label: 'Lens', value: fyOverride === 'all' ? 'All FY' : fyOverride.toUpperCase() }, { label: 'Total', value: money(byFy) }],
      action: { fyMode: fyOverride, minAmount },
    };
  }

  // 8) Categories ranking / default
  const top = [...(root.children ?? [])].sort((a, b) => valueOf(b, fyOverride ?? 'all') - valueOf(a, fyOverride ?? 'all'));
  return {
    intent: wantsCategories ? 'top-categories' : 'default',
    answer: `The biggest spending categories are ${top[0].name} (${money(top[0].total)}, ${pct(top[0].total, grand)}), ${top[1].name} (${money(top[1].total)}), and ${top[2].name} (${money(top[2].total)}). Total spending is ${money(grand)}.`,
    facts: top.slice(0, 3).map((c) => ({ label: c.name.split(' ').slice(0, 2).join(' '), value: money(c.total) })),
    action: { reset: true, highlightIds: [top[0].id], fyMode: fyOverride ?? 'all', minAmount },
  };
}

/** Starter prompts shown in the Ask panel. */
export const STARTER_PROMPTS = [
  'Where did the money go?',
  'Which agencies spend the most?',
  'Show me Grants & Client Services',
  'What grew the most in FY2023?',
  'Show vendors for Health Care Authority',
  'Show FY2023 only',
];
