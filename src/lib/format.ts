// Money + number formatting. Kept deterministic and exact for display.

/** Compact money: $63B, $7.4B, $154M, $1.2K, $980. */
export function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${trim(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${trim(a / 1e3)}K`;
  return `${sign}$${Math.round(a).toLocaleString()}`;
}

function trim(x: number): string {
  // 1–2 significant decimals, no trailing zeros (63, 7.4, 1.25)
  if (x >= 100) return Math.round(x).toString();
  if (x >= 10) return (Math.round(x * 10) / 10).toString();
  return (Math.round(x * 100) / 100).toString();
}

/** Exact money with separators: $1,698.61 */
export function moneyExact(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`;
}

export function signedPct(p: number): string {
  const s = p >= 0 ? '+' : '';
  return `${s}${p.toFixed(1)}%`;
}

/** Fiscal-month code (01..12 of the biennium) to a readable label. */
const MONTHS = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
export function fiscalMonth(code: string, fy: number): string {
  const idx = parseInt(code, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx > 11) return `FY${fy}`;
  return `${MONTHS[idx]} ${fy}`;
}
