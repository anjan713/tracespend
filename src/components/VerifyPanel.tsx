import { ArrowDownRight, ArrowUpRight, FileSearch, Receipt } from 'lucide-react';
import type { FYMode, SpendData, SpendNode } from '../types';
import { fyChange, valueOf } from '../lib/data';
import { fiscalMonth, money, moneyExact, pct, signedPct } from '../lib/format';
import CountUp from './CountUp';

interface Props {
  node: SpendNode;
  data: SpendData;
  fyMode: FYMode;
  minAmount: number;
  reduceMotion: boolean;
  onDrill: (id: string) => void;
}

const LEVEL_LABEL: Record<string, string> = {
  root: 'Overview',
  category: 'Category',
  agency: 'Agency',
  vendor: 'Vendor',
  other: 'Grouped',
};

export default function VerifyPanel({ node, data, fyMode, minAmount, reduceMotion, onDrill }: Props) {
  const grand = data.meta.grandTotal;
  const value = valueOf(node, fyMode);
  const change = fyChange(node);
  const children = [...(node.children ?? [])].sort((a, b) => valueOf(b, fyMode) - valueOf(a, fyMode));
  const maxChild = children.length ? valueOf(children[0], fyMode) : 0;

  const evidence = (data.evidence[node.id] ?? [])
    .filter((t) => (fyMode === 'all' ? true : fyMode === 'fy2022' ? t.fy === 2022 : t.fy === 2023))
    .filter((t) => t.amount >= minAmount)
    .slice(0, 25);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <p className="panel-sub">Verification</p>
        <h2 className="mt-0.5 text-lg font-semibold text-cream">Details &amp; evidence</h2>
      </div>

      {/* Subject */}
      <div>
        <p className="panel-sub">{LEVEL_LABEL[node.level] ?? 'Selection'}</p>
        <h3 className="text-xl font-bold leading-tight text-cream">{node.name.trim()}</h3>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-2.5">
        <Stat label={fyMode === 'all' ? 'Total (both FY)' : `Total (${fyMode.toUpperCase()})`}>
          <CountUp value={value} format={money} reduceMotion={reduceMotion} className="text-lg font-bold text-gold-200" />
        </Stat>
        <Stat label="Share of total">
          <span className="text-lg font-bold text-cream">{pct(node.total, grand)}</span>
        </Stat>
        <Stat label="FY change">
          {change == null ? (
            <span className="text-lg font-bold text-mute">n/a</span>
          ) : (
            <span className={`flex items-center gap-1 text-lg font-bold ${change >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {change >= 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
              {signedPct(change)}
            </span>
          )}
        </Stat>
        <Stat label={node.level === 'root' ? 'Payments' : isLeafSubject(node) ? 'Evidence lines' : childNoun(node)}>
          <span className="text-lg font-bold text-cream">
            {node.level === 'root'
              ? data.meta.rowCount.toLocaleString()
              : isLeafSubject(node)
              ? evidence.length.toLocaleString()
              : children.length.toLocaleString()}
          </span>
        </Stat>
      </div>

      {/* FY split */}
      <div className="rounded-lg border border-white/5 bg-ink-900/50 px-3 py-2 text-sm">
        <div className="flex items-center justify-between py-0.5">
          <span className="text-mute">FY2022</span>
          <span className="font-mono text-cream">{moneyExact(node.fy2022)}</span>
        </div>
        <div className="flex items-center justify-between py-0.5">
          <span className="text-mute">FY2023</span>
          <span className="font-mono text-cream">{moneyExact(node.fy2023)}</span>
        </div>
      </div>

      {/* Top contributors */}
      {children.length > 0 && (
        <div>
          <p className="panel-sub mb-2 flex items-center gap-1.5">
            <Receipt size={13} /> Top contributors
          </p>
          <ul className="flex flex-col gap-1.5">
            {children.slice(0, 8).map((c) => {
              const v = valueOf(c, fyMode);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onDrill(c.id)}
                    className="group w-full rounded-md px-1 py-1 text-left transition hover:bg-white/5"
                    disabled={!c.children?.length}
                  >
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-cream group-hover:text-gold-100">{c.name.trim()}</span>
                      <span className="shrink-0 font-mono text-mute">{money(v)}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-gold-400 to-gold-200 transition-all duration-700"
                        style={{ width: `${maxChild ? (v / maxChild) * 100 : 0}%` }}
                      />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Evidence */}
      <div className="min-h-0">
        <p className="panel-sub mb-2 flex items-center gap-1.5">
          <FileSearch size={13} /> Evidence · {evidence.length} {evidence.length === 1 ? 'payment' : 'payments'}
        </p>
        {evidence.length === 0 ? (
          <p className="rounded-md border border-white/5 bg-ink-900/50 px-3 py-3 text-xs text-mute">
            No individual payments indexed for this selection under the current filters.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/5">
            <table className="w-full text-left text-xs">
              <thead className="bg-ink-900/70 text-mute">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Vendor</th>
                  <th className="px-2.5 py-1.5 font-medium">Date</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((t, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                    <td className="max-w-[150px] truncate px-2.5 py-1.5 text-cream" title={`${t.vendor.trim()} · ${t.agency.trim()}`}>
                      {t.vendor.trim()}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-mute">{fiscalMonth(t.month, t.fy)}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-right font-mono text-gold-100">{moneyExact(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-mute/70">
          Figures are precomputed exactly from {data.meta.rowCount.toLocaleString()} source payment lines and reconcile to the
          {' '}{money(grand)} grand total. Evidence shows the largest individual payments behind this selection.
        </p>
      </div>
    </div>
  );
}

// A "leaf subject" has no breakdown to show, so we surface its evidence count.
// A vendor, or a terminal "Other" tail (an aggregate with no children), qualifies.
function isLeafSubject(node: SpendNode): boolean {
  return node.level === 'vendor' || (node.level === 'other' && !node.children?.length);
}

function childNoun(node: SpendNode): string {
  const kids = node.children ?? [];
  const n = kids.length;
  if (node.level === 'category') return `${n} agencies`;
  if (node.level === 'agency') return `${n} vendors`;
  if (node.level === 'other') {
    // Container "Other": name the tier it reveals (agencies vs vendors).
    const inner = kids.find((c) => c.level !== 'other')?.level ?? kids[0]?.level;
    if (inner === 'agency') return `${n} agencies`;
    if (inner === 'vendor') return `${n} vendors`;
  }
  return `${n} items`;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/5 bg-ink-900/50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-mute">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
