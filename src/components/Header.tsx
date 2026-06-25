import { Activity, ShieldCheck } from 'lucide-react';
import type { FYMode, SpendMeta } from '../types';

interface Props {
  meta: SpendMeta;
  fyMode: FYMode;
  onFyMode: (m: FYMode) => void;
}

const FY_OPTIONS: { id: FYMode; label: string }[] = [
  { id: 'all', label: 'All FY' },
  { id: 'fy2022', label: 'FY2022' },
  { id: 'fy2023', label: 'FY2023' },
];

export default function Header({ meta, fyMode, onFyMode }: Props) {
  return (
    <header className="flex flex-col gap-3 border-b border-white/5 bg-ink-900/70 px-5 py-3 backdrop-blur md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-gold-200 to-gold-500 text-ink-900 shadow-glow">
          <Activity size={18} strokeWidth={2.5} />
        </div>
        <div>
          <h1 className="text-[17px] font-bold leading-none">
            <span className="gold-text">Trace</span>
            <span className="text-cream">spend</span>
          </h1>
          <p className="mt-0.5 text-[11px] text-mute">
            Where did the money go? · {meta.source}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* FY lens */}
        <div className="flex items-center rounded-lg border border-white/10 bg-ink-800/80 p-0.5">
          {FY_OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => onFyMode(o.id)}
              className={`seg ${fyMode === o.id ? 'seg-active' : 'hover:text-cream'}`}
              aria-pressed={fyMode === o.id}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div
          className="flex items-center gap-1.5 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-2.5 py-1.5 text-xs text-emerald-300"
          title={`Reconciled: every figure ties to the $${meta.grandTotal.toLocaleString()} source total (diff $${meta.reconciliation.error}).`}
        >
          <ShieldCheck size={14} />
          <span className="hidden sm:inline">Reconciled</span>
        </div>
      </div>
    </header>
  );
}
