// Shared, deterministic vendor canonicalization used by BOTH build scripts
// (build-data.mjs and build-query-worker.mjs) so the sundial artifact and the
// query-worker dataset group vendors identically and keep reconciling to the cent.
//
// This is a conservative, "safe" pass — it merges only obvious textual variants
// of the SAME printed name. It deliberately does NOT do fuzzy/probabilistic
// entity resolution (which can silently misattribute money); that remains a
// documented production gap.
//
// What it normalizes for the GROUPING KEY:
//   - case (uppercase)
//   - "&"            -> " AND "
//   - periods        -> removed   ("INC." -> "INC", "L.L.C." -> "LLC")
//   - commas         -> space     ("ORSINI PHARMACEUTICAL SERVICES," -> "...SERVICES")
//   - collapsed whitespace (so "ACME  INC" == "ACME INC")
//   - legal-suffix synonyms merged: INCORPORATED->INC, CORPORATION->CORP,
//     COMPANY->CO, LIMITED->LTD  (note: INC vs LLC stay DISTINCT on purpose)
//
// The DISPLAY name shown to users is the first-seen original (trimmed) for a key,
// preserving real casing/punctuation. Because both scripts stream the same CSVs
// in the same order, "first-seen" is identical across them.

/** Pure, idempotent canonical grouping key for a vendor name. */
export function canonicalVendorKey(raw) {
  let s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s) return '';
  s = s.replace(/&/g, ' AND ');
  s = s.replace(/\./g, ''); // INC. -> INC, L.L.C. -> LLC
  s = s.replace(/,/g, ' '); // trailing/embedded commas -> space
  s = s.replace(/\s+/g, ' ').trim();
  s = s
    .replace(/\bINCORPORATED\b/g, 'INC')
    .replace(/\bCORPORATION\b/g, 'CORP')
    .replace(/\bCOMPANY\b/g, 'CO')
    .replace(/\bLIMITED\b/g, 'LTD');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Stateful canonicalizer that maps raw names -> canonical key while remembering
 * the first-seen original as the human-facing display name for that key.
 */
export function makeVendorCanon() {
  const display = new Map(); // key -> first-seen trimmed original
  return {
    display,
    /** Returns the canonical key and records the display name on first sight. */
    canon(raw) {
      const original = String(raw == null ? '' : raw).trim();
      const key = canonicalVendorKey(original);
      if (key && !display.has(key)) display.set(key, original);
      return key;
    },
    /** Human display name for a canonical key (falls back to the key itself). */
    displayOf(key) {
      return display.get(key) ?? key;
    },
  };
}
