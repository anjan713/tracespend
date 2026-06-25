// Canonical-name resolution. The AI may hand us a loose name ("Dept of Fish &
// Wildlife"); we map it to the EXACT dimension string the data uses, or return
// undefined when nothing matches cleanly. Returning undefined (instead of a bad
// guess) is what prevents the "confident $0" bug.

const STOP = new Set([
  'department', 'departments', 'dept', 'office', 'of', 'and', 'the', 'state',
  'commission', 'board', 'authority', 'for', 'div', 'division', 'agency',
  'services', 'service', 'wa', 'washington', 'inc', 'llc', 'co', 'corp', 'company',
]);

const CATEGORY_SYNONYMS = {
  grant: ['grant', 'grants', 'benefit', 'benefits', 'client', 'welfare', 'medicaid', 'assistance'],
  goods: ['goods', 'supplies', 'equipment', 'operating'],
  capital: ['capital', 'construction', 'building', 'buildings', 'infrastructure', 'outlay', 'outlays'],
  contract: ['contract', 'contracts', 'consultant', 'consultants'],
  travel: ['travel', 'flights', 'lodging', 'mileage'],
  debt: ['debt', 'bond', 'bonds', 'interest'],
  cogs: ['cost of goods', 'cogs', 'resale'],
  interagency: ['interagency', 'inter-agency'],
  intra: ['intra-agency', 'intra agency', 'intraagency'],
};

export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s, minLen = 3) {
  return norm(s)
    .split(' ')
    .filter((w) => w.length >= minLen && !STOP.has(w));
}

/**
 * Best fuzzy match of `value` against `names`. Returns { name, index, score } or
 * undefined when below threshold.
 */
export function bestMatch(value, names, { threshold = 0.5 } = {}) {
  const v = norm(value);
  if (!v) return undefined;
  const vTokens = new Set(tokens(v));
  let best;

  for (let i = 0; i < names.length; i++) {
    const n = norm(names[i]);
    if (!n) continue;
    let score;
    if (n === v) {
      score = 1;
    } else {
      const nTokens = tokens(n);
      if (!nTokens.length) continue;
      let matched = 0;
      for (const t of nTokens) if (vTokens.has(t)) matched++;
      const coverage = matched / nTokens.length; // how much of the name we cover
      const valueCoverage = vTokens.size ? matched / vTokens.size : 0;
      score = coverage * 0.6 + valueCoverage * 0.4;
      if (n.includes(v) || v.includes(n)) score = Math.max(score, 0.85);
    }
    if (!best || score > best.score) best = { name: names[i], index: i, score };
  }
  return best && best.score >= threshold ? best : undefined;
}

export function resolveAgency(value, agencies) {
  return bestMatch(value, agencies, { threshold: 0.5 });
}

export function resolveVendor(value, vendors) {
  return bestMatch(value, vendors, { threshold: 0.5 });
}

export function resolveSubcategory(value, subcategories) {
  return bestMatch(value, subcategories, { threshold: 0.5 });
}

/** Categories first try keyword synonyms, then fall back to fuzzy name match. */
export function resolveCategory(value, categories) {
  const v = norm(value);
  if (!v) return undefined;
  for (const syns of Object.values(CATEGORY_SYNONYMS)) {
    if (syns.some((s) => v.includes(s))) {
      // map the synonym group to a real category by fuzzy-matching its keywords
      const probe = syns.join(' ');
      const m = bestMatch(probe, categories, { threshold: 0.34 });
      if (m) return m;
    }
  }
  return bestMatch(value, categories, { threshold: 0.45 });
}
