import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight, Download, Loader2, RotateCcw } from 'lucide-react';
import Header from './components/Header';
import AskPanel from './components/AskPanel';
import VerifyPanel from './components/VerifyPanel';
import Sundial, { type SundialHandle, type SizeMode } from './components/Sundial';
import CountUp from './components/CountUp';
import { loadData, indexTree, pathTo, valueOf } from './lib/data';
import { money, pct } from './lib/format';
import { logActivity, downloadActivity, subscribeActivity } from './lib/activityLog';
import { ask, type AskChartHint, type AskResponse } from './lib/ask';
import type { AgentAction, FYMode, SpendData, SpendNode } from './types';

// The data's columns / hierarchy tiers, shown as a level indicator so the user
// always knows whether they're viewing a category, an agency, or a vendor.
const TIER_LABELS = ['All Spending', 'Category', 'Agency', 'Vendor'] as const;

// Resizable side panels. The center graph is protected by MIN_CENTER (so the
// panels can never squeeze it) and by per-side caps (so it's never disturbed on
// wide screens). Defaults match the original fixed layout.
const DEFAULT_LEFT = 320;
const DEFAULT_RIGHT = 360;
const MIN_LEFT = 260;
const MAX_LEFT = 520;
const MIN_RIGHT = 300;
const MAX_RIGHT = 560;
const MIN_CENTER = 340; // graph never gets narrower than this
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function App() {
  const [data, setData] = useState<SpendData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [fyMode, setFyMode] = useState<FYMode>('all');
  const [sizeMode, setSizeMode] = useState<SizeMode>('equal');
  const [minAmount, setMinAmount] = useState(0);
  const [vendorQuery, setVendorQuery] = useState('');
  const [selected, setSelected] = useState<SpendNode | null>(null);
  const [hovered, setHovered] = useState<SpendNode | null>(null);
  const [logCount, setLogCount] = useState(0);

  const sundialRef = useRef<SundialHandle | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>();
  const [pendingChart, setPendingChart] = useState<{ action: AgentAction; nonce: number } | null>(null);

  // ---- draggable side panels ----
  const mainRef = useRef<HTMLElement | null>(null);
  const [leftW, setLeftW] = useState(DEFAULT_LEFT);
  const [rightW, setRightW] = useState(DEFAULT_RIGHT);
  const [isWide, setIsWide] = useState(false);
  const [dragSide, setDragSide] = useState<null | 'left' | 'right'>(null);

  const reduceMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    []
  );

  useEffect(() => {
    logActivity('app_load', { userAgent: navigator.userAgent });
    loadData()
      .then((d) => {
        setData(d);
        setSelected(d.tree);
        logActivity('data_loaded', {
          rows: d.meta.rowCount,
          grandTotal: d.meta.grandTotal,
          categories: d.meta.categoryCount,
        });
      })
      .catch((e) => {
        setError(String(e?.message ?? e));
        logActivity('data_loaded', { error: String(e?.message ?? e) });
      });
  }, []);

  const treeIndex = useMemo(() => (data ? indexTree(data.tree) : null), [data]);

  const breadcrumb = useMemo(() => {
    if (!data || !treeIndex || !selected) return [];
    return pathTo(selected.id, treeIndex.byId, treeIndex.parentOf);
  }, [data, treeIndex, selected]);

  // Map the current selection path onto the fixed column tiers. Real nodes use
  // their level; a grouped "Other" sits one tier below its nearest real ancestor
  // (an agency-tier Other groups agencies, a vendor-tier Other groups vendors).
  const levelNav = useMemo(() => {
    const BASE: Record<string, number> = { root: 0, category: 1, agency: 2, vendor: 3 };
    const tierNode = new Map<number, SpendNode>();
    let lastReal = 0;
    let current = 0;
    for (const n of breadcrumb) {
      let t: number;
      if (n.level === 'other') {
        t = lastReal + 1;
      } else {
        t = BASE[n.level] ?? lastReal;
        lastReal = t;
      }
      tierNode.set(t, n);
      current = t;
    }
    return { tierNode, current };
  }, [breadcrumb]);

  const vendorMatches = useMemo(() => {
    if (!data || !vendorQuery.trim()) return [];
    const q = vendorQuery.trim().toLowerCase();
    return data.vendorIndex.filter((v) => v.n.toLowerCase().includes(q)).slice(0, 12);
  }, [data, vendorQuery]);

  const applyAction = useCallback((a: AgentAction) => {
    if (a.fyMode) setFyMode(a.fyMode);
    if (a.minAmount !== undefined) setMinAmount(a.minAmount);
    if (a.vendorQuery !== undefined) setVendorQuery(a.vendorQuery);
    logActivity('ai_action', {
      focusId: a.focusId,
      fyMode: a.fyMode,
      minAmount: a.minAmount,
      vendorQuery: a.vendorQuery,
      reset: a.reset,
      highlights: a.highlightIds?.length ?? 0,
    });
    // Defer chart control to an effect so it runs AFTER any FY-driven rebuild.
    setPendingChart({ action: a, nonce: Date.now() });
  }, []);

  // Apply chart actions after render (and after the Sundial rebuilds on FY change,
  // since child effects run before parent effects).
  useEffect(() => {
    if (!pendingChart) return;
    const a = pendingChart.action;
    clearTimeout(highlightTimer.current);
    if (a.reset) sundialRef.current?.reset();
    else if (a.focusId) sundialRef.current?.focus(a.focusId);

    if (a.highlightIds && a.highlightIds.length) {
      const delay = reduceMotion ? 0 : a.reset || a.focusId ? 900 : 60;
      highlightTimer.current = setTimeout(() => {
        sundialRef.current?.highlight(a.highlightIds!);
      }, delay);
    }
  }, [pendingChart, reduceMotion]);

  // Translate the server's chart hint (canonical names) into a concrete chart
  // action with sundial node ids, using the in-memory tree.
  const mapHint = useCallback(
    (hint: AskChartHint | null): AgentAction => {
      if (!hint || !data) return {};
      const action: AgentAction = { fyMode: hint.fyMode };
      if (hint.reset) action.reset = true;
      if (hint.vendorQuery) action.vendorQuery = hint.vendorQuery;

      const categoryId = (name: string) => data.tree.children?.find((c) => c.name === name)?.id;
      const agencyId = (name: string) => {
        let best: SpendNode | undefined;
        data.tree.children?.forEach((cat) =>
          cat.children?.forEach((ag) => {
            if (ag.level === 'agency' && ag.name === name && (!best || ag.total > best.total)) best = ag;
          })
        );
        return best?.id;
      };
      const idOf = (level: string, name: string) =>
        level === 'category' ? categoryId(name) : level === 'agency' ? agencyId(name) : undefined;

      if (hint.focus) action.focusId = idOf(hint.focus.level, hint.focus.name);
      if (hint.highlight?.length) {
        action.highlightIds = hint.highlight
          .map((h) => idOf(h.level, h.name))
          .filter((x): x is string => !!x);
      }
      return action;
    },
    [data]
  );

  const handleAsk = useCallback(
    async (q: string): Promise<AskResponse> => {
      logActivity('ai_query', { q });
      const r = await ask(q);
      applyAction(mapHint(r.action));
      return r;
    },
    [applyAction, mapHint]
  );

  const onDrill = useCallback((id: string) => {
    sundialRef.current?.highlight([]);
    sundialRef.current?.focus(id);
  }, []);

  // ---- runtime activity logging (see src/lib/activityLog.ts) ----
  useEffect(() => subscribeActivity(setLogCount), []);
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debouncedLog = useCallback(
    (key: string, type: Parameters<typeof logActivity>[0], detail: Record<string, unknown>, ms = 500) => {
      clearTimeout(debounceRef.current[key]);
      debounceRef.current[key] = setTimeout(() => logActivity(type, detail), ms);
    },
    []
  );
  const handleFyMode = useCallback((m: FYMode) => { setFyMode(m); logActivity('fy_mode', { mode: m }); }, []);
  const handleSizeMode = useCallback((m: SizeMode) => { setSizeMode(m); logActivity('size_mode', { mode: m }); }, []);
  const handleSelect = useCallback((node: SpendNode) => {
    setSelected(node);
    logActivity(node.level === 'other' ? 'expand_other' : 'navigate', {
      id: node.id,
      name: node.name,
      level: node.level,
    });
  }, []);
  const lastHoverRef = useRef<string | null>(null);
  const handleHover = useCallback(
    (node: SpendNode | null) => {
      setHovered(node);
      if (node && node.id !== lastHoverRef.current) {
        lastHoverRef.current = node.id;
        debouncedLog('hover', 'hover', { id: node.id, name: node.name, level: node.level }, 450);
      }
    },
    [debouncedLog]
  );

  // Only resize on lg+ (below that the panels are hidden and the graph is full-width).
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Restore saved widths.
  useEffect(() => {
    try {
      const l = Number(localStorage.getItem('tracer.leftW'));
      const r = Number(localStorage.getItem('tracer.rightW'));
      if (l) setLeftW(clamp(l, MIN_LEFT, MAX_LEFT));
      if (r) setRightW(clamp(r, MIN_RIGHT, MAX_RIGHT));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem('tracer.leftW', String(Math.round(leftW))); } catch { /* ignore */ } }, [leftW]);
  useEffect(() => { try { localStorage.setItem('tracer.rightW', String(Math.round(rightW))); } catch { /* ignore */ } }, [rightW]);

  // Live drag: clamp so the center graph keeps at least MIN_CENTER px.
  useEffect(() => {
    if (!dragSide) return;
    const onMove = (e: globalThis.PointerEvent) => {
      const main = mainRef.current;
      if (!main) return;
      const rect = main.getBoundingClientRect();
      if (dragSide === 'left') {
        const hi = Math.max(MIN_LEFT, Math.min(MAX_LEFT, rect.width - rightW - MIN_CENTER));
        setLeftW(clamp(e.clientX - rect.left, MIN_LEFT, hi));
      } else {
        const hi = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, rect.width - leftW - MIN_CENTER));
        setRightW(clamp(rect.right - e.clientX, MIN_RIGHT, hi));
      }
    };
    const stop = () => setDragSide(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragSide, leftW, rightW]);

  // Keep widths valid when the window resizes so the graph stays usable.
  useEffect(() => {
    const reclamp = () => {
      const main = mainRef.current;
      if (!main) return;
      const w = main.getBoundingClientRect().width;
      setLeftW((l) => clamp(l, MIN_LEFT, Math.max(MIN_LEFT, Math.min(MAX_LEFT, w - rightW - MIN_CENTER))));
      setRightW((r) => clamp(r, MIN_RIGHT, Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, w - leftW - MIN_CENTER))));
    };
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [leftW, rightW]);

  const startDrag = (side: 'left' | 'right') => (e: ReactPointerEvent) => {
    e.preventDefault();
    setDragSide(side);
  };

  if (error) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold text-rose-300">Couldn’t load spending data</h1>
          <p className="mt-2 text-sm text-mute">{error}</p>
          <p className="mt-4 rounded-lg border border-white/10 bg-ink-800 px-4 py-3 text-left font-mono text-xs text-cream">
            npm run build:data
          </p>
          <p className="mt-2 text-xs text-mute">Run the command above to generate the artifact, then reload.</p>
        </div>
      </div>
    );
  }

  if (!data || !selected) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex items-center gap-3 text-mute">
          <Loader2 className="animate-spin text-gold-300" />
          Loading spending data…
        </div>
      </div>
    );
  }

  // Center hub reflects the focused/selected node (stays put while hovering arcs).
  const hub = selected;
  const hubValue = valueOf(hub, fyMode);

  return (
    <div className="flex h-full flex-col">
      <Header
        meta={data.meta}
        fyMode={fyMode}
        onFyMode={handleFyMode}
      />

      <main
        ref={mainRef}
        className={`relative grid min-h-0 flex-1 grid-cols-1${dragSide ? ' cursor-col-resize select-none' : ''}`}
        style={isWide ? { gridTemplateColumns: `${leftW}px 1fr ${rightW}px` } : undefined}
      >
        {/* Ask */}
        <section className="hidden min-h-0 border-r border-white/5 bg-ink-900/40 lg:block">
          <AskPanel onAsk={handleAsk} />
        </section>

        {/* Explore */}
        <section className="relative flex min-h-0 flex-col items-center px-4 py-3">
          <div className="flex w-full items-center justify-between">
            <div>
              <p className="panel-sub">Exploration</p>
              <h2 className="text-lg font-semibold text-cream">Spending explorer</h2>
            </div>
            <div className="flex items-center gap-2">
              {/* Slice-size layout toggle */}
              <div className="flex items-center rounded-lg border border-white/10 bg-ink-800/80 p-0.5" title="How slice size is determined">
                <button onClick={() => handleSizeMode('amount')} className={`seg ${sizeMode === 'amount' ? 'seg-active' : 'hover:text-cream'}`}>
                  By amount
                </button>
                <button onClick={() => handleSizeMode('equal')} className={`seg ${sizeMode === 'equal' ? 'seg-active' : 'hover:text-cream'}`}>
                  Equal
                </button>
              </div>
              <button onClick={() => { sundialRef.current?.highlight([]); sundialRef.current?.reset(); logActivity('reset'); }} className="btn-ghost text-xs">
                <RotateCcw size={13} /> Reset
              </button>
              <button onClick={downloadActivity} className="btn-ghost text-xs" title="Download the runtime activity log for this session">
                <Download size={13} /> Log{logCount ? ` (${logCount})` : ''}
              </button>
            </div>
          </div>

          {/* Level / column indicator — shows which tier of the data you're in */}
          <div className="mt-2 flex w-full flex-wrap items-center gap-1 text-[11px]">
            <span className="mr-1 uppercase tracking-wide text-mute/60">Level</span>
            {TIER_LABELS.map((label, i) => {
              const node = levelNav.tierNode.get(i);
              const isActive = i === levelNav.current;
              const clickable = !isActive && !!node;
              return (
                <span key={label} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={11} className="opacity-40" />}
                  <button
                    disabled={!clickable}
                    onClick={
                      clickable
                        ? () => { sundialRef.current?.highlight([]); sundialRef.current?.focus(node!.id); }
                        : undefined
                    }
                    className={`rounded-full px-2 py-0.5 transition ${
                      isActive
                        ? 'bg-gold-500/15 font-semibold text-gold-200 ring-1 ring-gold-500/30'
                        : clickable
                        ? 'text-mute hover:bg-white/5 hover:text-gold-100'
                        : 'cursor-default text-mute/40'
                    }`}
                  >
                    {label}
                  </button>
                </span>
              );
            })}
            {selected.level === 'other' && (
              <span className="ml-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-mute">grouped</span>
            )}
          </div>

          {/* Breadcrumb */}
          <nav className="mt-2 flex w-full flex-wrap items-center gap-1 text-xs text-mute">
            {breadcrumb.map((n, i) => (
              <span key={n.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="opacity-50" />}
                <button
                  onClick={() => { sundialRef.current?.highlight([]); sundialRef.current?.focus(n.id); }}
                  className={`rounded px-1.5 py-0.5 transition hover:bg-white/5 hover:text-gold-100 ${i === breadcrumb.length - 1 ? 'font-semibold text-cream' : ''}`}
                >
                  {n.level === 'root' ? 'All Spending' : n.name.trim()}
                </button>
              </span>
            ))}
          </nav>

          {/* Sundial + center hub */}
          <div className="relative mt-1 flex w-full min-h-0 flex-1 items-center justify-center overflow-hidden">
            <div className="relative aspect-square h-full max-h-[560px] max-w-full">
              <Sundial
                ref={sundialRef}
                root={data.tree}
                fyMode={fyMode}
                minAmount={minAmount}
                sizeMode={sizeMode}
                reduceMotion={!!reduceMotion}
                onSelect={handleSelect}
                onHover={handleHover}
              />
              {/* center hub overlay (pointer-events-none → clicks reach zoom-out circle) */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <p className="max-w-[150px] truncate text-[11px] uppercase tracking-wide text-mute">
                  {hub.level === 'root' ? 'Total spending' : hub.name.trim()}
                </p>
                <CountUp
                  value={hubValue}
                  format={money}
                  reduceMotion={!!reduceMotion}
                  className="text-3xl font-bold text-gold-200"
                />
                <p className="text-[11px] text-mute">
                  {hub.level === 'root' ? 'FY2022–FY2023' : `${pct(hub.total, data.meta.grandTotal)} of total`}
                </p>
              </div>
            </div>
          </div>

          <p className="mt-1 text-center text-[11px] transition-colors">
            {hovered?.level === 'other' ? (
              <span className="text-gold-200">
                “{hovered.name.trim()}” groups the smaller items — click to reveal them
              </span>
            ) : (
              <span className="text-mute/70">
                Click a slice to drill in · click the center to zoom out · hover for exact figures
              </span>
            )}
          </p>
        </section>

        {/* Verify */}
        <section className="hidden min-h-0 border-l border-white/5 bg-ink-900/40 lg:block">
          {vendorMatches.length > 0 && (
            <div className="border-b border-white/5 px-4 py-3">
              <p className="panel-sub mb-1.5">Vendor search · “{vendorQuery}”</p>
              <ul className="max-h-44 space-y-1 overflow-y-auto">
                {vendorMatches.map((v) => (
                  <li key={v.n} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-white/5">
                    <span className="truncate text-cream" title={v.n.trim()}>{v.n.trim()}</span>
                    <span className="shrink-0 font-mono text-gold-100">{money(v.t)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <VerifyPanel
            node={selected}
            data={data}
            fyMode={fyMode}
            minAmount={minAmount}
            reduceMotion={!!reduceMotion}
            onDrill={onDrill}
          />
        </section>

        {/* Draggable dividers (lg only). Double-click resets to the default width. */}
        {isWide && (
          <>
            <div
              onPointerDown={startDrag('left')}
              onDoubleClick={() => setLeftW(DEFAULT_LEFT)}
              style={{ left: leftW }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the Ask panel"
              title="Drag to resize · double-click to reset"
              className="group absolute inset-y-0 z-30 -ml-1 w-2 cursor-col-resize"
            >
              <div className={`mx-auto h-full transition-all ${dragSide === 'left' ? 'w-0.5 bg-gold-400' : 'w-px bg-white/10 group-hover:w-0.5 group-hover:bg-gold-400/70'}`} />
            </div>
            <div
              onPointerDown={startDrag('right')}
              onDoubleClick={() => setRightW(DEFAULT_RIGHT)}
              style={{ right: rightW }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the Verify panel"
              title="Drag to resize · double-click to reset"
              className="group absolute inset-y-0 z-30 -mr-1 w-2 cursor-col-resize"
            >
              <div className={`mx-auto h-full transition-all ${dragSide === 'right' ? 'w-0.5 bg-gold-400' : 'w-px bg-white/10 group-hover:w-0.5 group-hover:bg-gold-400/70'}`} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
