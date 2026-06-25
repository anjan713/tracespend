import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import * as d3 from 'd3';
import type { FYMode, SpendNode } from '../types';
import { money, pct } from '../lib/format';
import { arcVisible as arcVisibleFn, assignEqualAngles, zoomTarget } from '../lib/sunburst';

export interface SundialHandle {
  focus: (id: string) => void;
  highlight: (ids: string[]) => void;
  reset: () => void;
  /** id of the node currently at the center */
  currentId: () => string;
}

export type SizeMode = 'amount' | 'equal';

interface Props {
  root: SpendNode;
  fyMode: FYMode;
  minAmount: number;
  sizeMode: SizeMode;
  reduceMotion: boolean;
  onSelect: (node: SpendNode) => void;
  onHover: (node: SpendNode | null) => void;
}

type HNode = d3.HierarchyRectangularNode<SpendNode> & {
  current: { x0: number; x1: number; y0: number; y1: number };
  target?: { x0: number; x1: number; y0: number; y1: number };
};

const RADIUS_UNIT = 118; // px per ring
const SIZE = RADIUS_UNIT * 6; // svg viewBox size (3 rings each side)

// Gold-anchored palette, one hue per top-level category.
const GOLD_PALETTE = [
  '#F2C879', '#E5B25D', '#D49A3E', '#CE9A55', '#B87E29',
  '#C98C3A', '#A86E22', '#8C5E1C', '#E0A94E', '#9A6320',
];

function valueAccessor(fy: FYMode) {
  return (d: SpendNode) =>
    fy === 'fy2022' ? d.fy2022 : fy === 'fy2023' ? d.fy2023 : d.total;
}

const Sundial = forwardRef<SundialHandle, Props>(function Sundial(
  { root, fyMode, minAmount, sizeMode, reduceMotion, onSelect, onHover },
  ref
) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<HNode | null>(null);
  const highlightRef = useRef<Set<string>>(new Set());
  const minAmountRef = useRef(minAmount);
  minAmountRef.current = minAmount;
  const apiRef = useRef<{
    zoomTo: (n: HNode) => void;
    nodeById: Map<string, HNode>;
    refreshAppearance: () => void;
    clearGlow: () => void;
  } | null>(null);

  // Build the d3 hierarchy. Two layouts:
  //  - 'amount': arc angle ∝ dollars (area = money — the default, most truthful).
  //  - 'equal' : every sibling gets equal angle (max readability for small slices).
  // Either way the numbers shown (labels/tooltip/verify) are exact.
  const hierarchy = useMemo(() => {
    const val = valueAccessor(fyMode);
    const r = d3
      .hierarchy<SpendNode>(root)
      .sum((d) => (d.children && d.children.length ? 0 : Math.max(0, val(d))))
      .sort((a, b) => (b.data.total ?? 0) - (a.data.total ?? 0));

    if (sizeMode === 'equal') {
      // Divide each node's angular span equally among its children (pure, tested).
      assignEqualAngles(r as unknown as Parameters<typeof assignEqualAngles>[0]);
      return r as HNode;
    }

    return d3.partition<SpendNode>().size([2 * Math.PI, r.height + 1])(r) as HNode;
  }, [root, fyMode, sizeMode]);

  // Color scale keyed by top-level category name.
  const colorOf = useMemo(() => {
    const cats = (root.children ?? []).map((c) => c.name);
    const scale = d3.scaleOrdinal<string, string>().domain(cats).range(GOLD_PALETTE);
    return (d: HNode) => {
      let node: HNode = d;
      while (node.depth > 1 && node.parent) node = node.parent as HNode;
      return scale(node.data.name);
    };
  }, [root]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const valFn = valueAccessor(fyMode);

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    const MARGIN = 26; // breathing room so the hover lift + glow aren't clipped
    svg
      .attr('viewBox', `${-(SIZE / 2 + MARGIN)} ${-(SIZE / 2 + MARGIN)} ${SIZE + 2 * MARGIN} ${SIZE + 2 * MARGIN}`)
      .style('width', '100%')
      .style('height', '100%')
      .style('max-width', '100%')
      .style('overflow', 'visible')
      .style('font', '10px Inter, sans-serif');

    // Soft gold glow filter for highlighted arcs.
    const defs = svg.append('defs');
    const glow = defs.append('filter').attr('id', 'arc-glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glow.append('feDropShadow').attr('dx', 0).attr('dy', 0).attr('stdDeviation', 6).attr('flood-color', '#F2C879').attr('flood-opacity', 0.9);

    const g = svg.append('g');

    const root0 = hierarchy;
    root0.each((d) => {
      (d as HNode).current = { x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 };
    });
    focusRef.current = root0;

    const nodeById = new Map<string, HNode>();
    root0.each((d) => nodeById.set((d as HNode).data.id, d as HNode));

    const arc = d3
      .arc<{ x0: number; x1: number; y0: number; y1: number }>()
      .startAngle((d) => d.x0)
      .endAngle((d) => d.x1)
      .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.004))
      .padRadius(RADIUS_UNIT * 1.5)
      .innerRadius((d) => d.y0 * RADIUS_UNIT)
      .outerRadius((d) => Math.max(d.y0 * RADIUS_UNIT, d.y1 * RADIUS_UNIT - 1.5));

    // Gap-free arc used only for the invisible pointer hit layer: no padAngle and
    // no inner/outer shrink, so adjacent slices and rings abut with zero seams.
    const arcHit = d3
      .arc<{ x0: number; x1: number; y0: number; y1: number }>()
      .startAngle((d) => d.x0)
      .endAngle((d) => d.x1)
      .innerRadius((d) => d.y0 * RADIUS_UNIT)
      .outerRadius((d) => d.y1 * RADIUS_UNIT);

    const descendants = root0.descendants().slice(1) as HNode[];

    type Box = { x0: number; x1: number; y0: number; y1: number };
    const arcVisible = arcVisibleFn;

    // Font size per ring: inner categories largest, outer vendors smallest.
    const labelFont = (d: Box) => (d.y0 <= 1 ? 13 : d.y0 <= 2 ? 11 : 10);
    // Radial room available for the (radially-oriented) label text.
    const radialLen = (d: Box) => (d.y1 - d.y0) * RADIUS_UNIT - 18;
    // Tangential thickness of the slice (limits how tall the text band can be).
    const angularThickness = (d: Box) => (d.x1 - d.x0) * (((d.y0 + d.y1) / 2) * RADIUS_UNIT);
    // Show a label only if it comfortably fits inside its own slice.
    const labelVisible = (d: Box) =>
      arcVisible(d) && angularThickness(d) >= labelFont(d) + 5 && radialLen(d) >= 26;
    const maxChars = (d: Box) => Math.max(2, Math.floor(radialLen(d) / (labelFont(d) * 0.58)));
    const labelTransform = (d: Box) => {
      const x = (((d.x0 + d.x1) / 2) * 180) / Math.PI;
      const y = ((d.y0 + d.y1) / 2) * RADIUS_UNIT;
      return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
    };
    // Allow a second line only when the slice is tangentially thick enough.
    const maxLinesFor = (d: Box) => (angularThickness(d) >= labelFont(d) * 2 + 6 ? 2 : 1);
    // Render a label as 1–2 radial <tspan> lines, vertically centered on the anchor.
    const setLabelLines = (
      sel: d3.Selection<SVGTextElement, HNode, any, any>,
      boxOf: (d: HNode) => Box
    ) =>
      sel.each(function (d) {
        const box = boxOf(d);
        const lines = wrapLabel(d.data.name, maxChars(box), maxLinesFor(box));
        const text = d3.select(this);
        text.text(null);
        const n = lines.length;
        lines.forEach((ln, i) => {
          text
            .append('tspan')
            .attr('x', 0)
            .attr('dy', i === 0 ? `${(0.35 - (n - 1) * 0.55).toFixed(2)}em` : '1.1em')
            .text(ln);
        });
      });
    const belowMin = (d: HNode) => minAmountRef.current > 0 && valFn(d.data) < minAmountRef.current;
    const baseOpacity = (d: HNode) =>
      arcVisible(d.current) ? (belowMin(d) ? 0.12 : d.data.level === 'other' ? 0.45 : 0.86) : 0;

    // ---- arcs ----
    // Arcs + labels share one "reveal" layer so the first-load animation can bloom
    // the entire wheel with a single transform/opacity transition (cheap + smooth)
    // instead of tweening every arc's path. The hit layer and center hub are
    // appended OUTSIDE this layer so pointer detection and the hub never scale.
    const revealLayer = g.append('g');
    const path = revealLayer
      .append('g')
      .selectAll<SVGPathElement, HNode>('path')
      .data(descendants)
      .join('path')
      .attr('fill', (d) => colorOf(d))
      .attr('fill-opacity', baseOpacity)
      .attr('stroke', '#0E0F12')
      .attr('stroke-width', 0.75)
      .attr('pointer-events', 'none')
      .attr('d', (d) => arc(d.current));

    // ---- labels (declared before hover handlers that reference them) ----
    const label = revealLayer
      .append('g')
      .attr('pointer-events', 'none')
      .attr('text-anchor', 'middle')
      .style('user-select', 'none')
      .selectAll<SVGTextElement, HNode>('text')
      .data(descendants)
      .join('text')
      .attr('fill', '#1A1408')
      .attr('font-weight', 600)
      .attr('font-size', (d) => `${labelFont(d.current)}px`)
      .attr('fill-opacity', (d) => +labelVisible(d.current))
      .attr('transform', (d) => labelTransform(d.current));
    setLabelLines(label, (d) => d.current);

    // ---- pointer hit layer ----
    // A transparent, gap-free copy of the arcs sits on top and captures ALL
    // pointer events. Because it never moves (unlike the visible arc, which
    // lifts on hover) and has no padAngle / inner gap, the cursor can't fall
    // into a seam or lose the arc it just lifted — which removes hover flicker.
    const hit = g
      .append('g')
      .attr('fill', 'transparent')
      .attr('stroke', 'none')
      .selectAll<SVGPathElement, HNode>('path')
      .data(descendants)
      .join('path')
      .attr('d', (d) => arcHit(d.current))
      .attr('pointer-events', (d) => (arcVisible(d.current) ? 'all' : 'none'))
      .style('cursor', (d) => (d.children ? 'pointer' : 'default'));

    const HOVER_DUR = reduceMotion ? 0 : 150;
    const LIFT = 12; // px the hovered arc pops outward

    const tip = d3.select(tooltipRef.current);

    function moveTip(event: MouseEvent) {
      const container = containerRef.current;
      const el = tooltipRef.current;
      if (!container || !el) return;
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const tw = el.offsetWidth;
      const th = el.offsetHeight;
      let left = x + 16;
      let top = y + 16;
      if (left + tw > rect.width) left = x - tw - 16;
      if (top + th > rect.height) top = y - th - 16;
      el.style.left = `${Math.max(4, left)}px`;
      el.style.top = `${Math.max(4, top)}px`;
    }

    function showTip(d: HNode) {
      const drillableOther = d.data.level === 'other' && !!d.children;
      const el = tooltipRef.current;
      if (el) {
        el.style.display = 'block';
        if (!reduceMotion) {
          // Restart the entrance animation so the tooltip softly pops on each
          // new slice instead of snapping in instantly.
          el.style.animation = 'none';
          el.getBoundingClientRect(); // force reflow to replay the animation
          el.style.animation = '';
        }
      }
      tip.select('.tip-name').text(d.data.name.replace(/\s+/g, ' ').trim());
      tip.select('.tip-amount').text(money(valFn(d.data)));
      tip
        .select('.tip-meta')
        .text(drillableOther ? '· click to reveal these' : `· ${pct(d.data.total, root.total)} of all spending`);
    }
    function hideTip() {
      tip.style('display', 'none');
    }

    hit
      .on('mouseenter', function (event: MouseEvent, d) {
        // Tile lift: pop the hovered arc outward + glow, dim everything else.
        // 'dim' (opacity) and 'lift' (transform) use distinct transition names so
        // they run concurrently instead of cancelling each other.
        path.interrupt('dim');
        path
          .transition('dim')
          .duration(HOVER_DUR)
          .ease(d3.easeCubicOut)
          .attr('fill-opacity', (o) =>
            !arcVisible(o.current) ? 0 : o === d ? 1 : baseOpacity(o) * 0.22
          );

        const mid = (d.current.x0 + d.current.x1) / 2;
        const [dx, dy] = d3.pointRadial(mid, LIFT);
        // Lift only the VISIBLE arc; the hit arc stays put so hover is stable.
        path
          .filter((o) => o === d)
          .raise()
          .attr('filter', 'url(#arc-glow)')
          .interrupt('lift')
          .transition('lift')
          .duration(HOVER_DUR)
          .ease(d3.easeCubicOut)
          .attr('transform', `translate(${dx},${dy})`);

        label
          .filter((o) => o === d)
          .raise()
          .interrupt('lift')
          .transition('lift')
          .duration(HOVER_DUR)
          .attr('transform', `translate(${dx},${dy}) ${labelTransform(d.current)}`);

        showTip(d);
        moveTip(event);
        onHover(d.data);
      })
      .on('mousemove', function (event: MouseEvent) {
        moveTip(event);
      })
      .on('mouseleave', function () {
        const set = highlightRef.current;
        const active = set.size > 0;
        path.interrupt('dim').interrupt('lift');
        path
          .transition('dim')
          .duration(HOVER_DUR)
          .ease(d3.easeCubicOut)
          .attr('fill-opacity', (o) =>
            !arcVisible(o.current) ? 0 : active ? (set.has(o.data.id) ? 1 : baseOpacity(o) * 0.4) : baseOpacity(o)
          );
        path.transition('lift').duration(HOVER_DUR).ease(d3.easeCubicOut).attr('transform', null);
        // restore glow only on AI-highlighted arcs
        path.attr('filter', (o) => (set.has(o.data.id) && arcVisible(o.current) ? 'url(#arc-glow)' : null));
        label.interrupt('lift').transition('lift').duration(HOVER_DUR).attr('transform', (o) => labelTransform(o.current));
        hideTip();
        onHover(null);
      })
      .on('click', (_e, d) => {
        // Cancel any in-flight hover animations so they don't fight the zoom.
        path.interrupt('dim').interrupt('lift').attr('transform', null);
        label.interrupt('lift');
        clearGlow();
        hideTip();
        onSelect(d.data);
        if (d.children) zoomTo(d);
      });

    function clearGlow() {
      highlightRef.current = new Set();
      path.attr('filter', null).classed('arc-glow-pulse', false);
    }

    // ---- center hub (click to zoom out) ----
    const parentCircle = g
      .append('circle')
      .datum(root0)
      .attr('r', RADIUS_UNIT)
      .attr('fill', '#11131A')
      .attr('stroke', 'rgba(229,178,93,0.25)')
      .attr('stroke-width', 1)
      .attr('pointer-events', 'all')
      .style('cursor', 'pointer')
      .on('click', (_e, d) => {
        const p = (d as HNode).parent as HNode | null;
        if (p) {
          clearGlow();
          onSelect(p.data);
          zoomTo(p);
        }
      });

    // ---- shared "dashboard sweep" reveal (first load + drill-in) ----
    // A glowing gold needle turns one full clockwise revolution (12 → 12) while every
    // arc/label "lights up" exactly as the needle passes its angle (its delay is keyed
    // to the slice's mid-angle). Pure opacity staggering — no per-frame path rebuilds —
    // so it's cheap over thousands of slices and layers on top of the drill's geometry
    // tween: it runs under the NAMED 'reveal' transition, so it never cancels the
    // unnamed geometry/zoom transition sharing the same elements.
    const litOpacity = (d: HNode, box: Box) =>
      !arcVisible(box) ? 0 : belowMin(d) ? 0.12 : d.data.level === 'other' ? 0.45 : 0.86;

    function spawnNeedle(duration: number) {
      const outerR = 3 * RADIUS_UNIT;
      g.selectAll('.sweep-needle').interrupt().remove();
      const needle = g.append('g').attr('class', 'sweep-needle').attr('pointer-events', 'none');
      needle
        .append('line')
        .attr('x1', 0)
        .attr('y1', 0)
        .attr('x2', 0)
        .attr('y2', -(outerR + 16))
        .attr('stroke', '#F4D08A')
        .attr('stroke-width', 2.5)
        .attr('stroke-linecap', 'round')
        .attr('filter', 'url(#arc-glow)');
      parentCircle.raise(); // keep the center hub above the needle's pivot
      needle
        .attr('transform', 'rotate(0)')
        .transition()
        .duration(duration)
        .ease(d3.easeLinear)
        .attrTween('transform', () => {
          const i = d3.interpolate(0, 360);
          return (tt) => `rotate(${i(tt)})`;
        })
        .transition()
        .duration(260)
        .ease(d3.easeCubicOut)
        .style('opacity', 0)
        .remove();
    }

    function sweepReveal(boxOf: (d: HNode) => Box, duration: number) {
      const sweepDelay = (b: Box) =>
        ((Math.max(0, (b.x0 + b.x1) / 2) % (2 * Math.PI)) / (2 * Math.PI)) * duration;
      path
        .filter((d) => arcVisible(boxOf(d)))
        .interrupt('reveal')
        .attr('fill-opacity', 0)
        .transition('reveal')
        .delay((d) => sweepDelay(boxOf(d)))
        .duration(260)
        .ease(d3.easeCubicOut)
        .attr('fill-opacity', (d) => litOpacity(d, boxOf(d)));
      label
        .filter((d) => labelVisible(boxOf(d)))
        .interrupt('reveal')
        .attr('fill-opacity', 0)
        .transition('reveal')
        .delay((d) => sweepDelay(boxOf(d)) + 110)
        .duration(240)
        .ease(d3.easeCubicOut)
        .attr('fill-opacity', (d) => +labelVisible(boxOf(d)));
      spawnNeedle(duration);
    }

    // ---- zoom / drill transition ----
    function zoomTo(p: HNode) {
      // Drilling DEEPER (into a slice) replays the dashboard sweep on the freshly
      // revealed children; zooming back out stays a plain geometry tween.
      const goingDeeper = !reduceMotion && p.depth > (focusRef.current?.depth ?? 0);
      focusRef.current = p;
      parentCircle.datum(p);

      // Cancel any reveal sweep still running from a previous load/drill.
      path.interrupt('reveal');
      label.interrupt('reveal');
      g.selectAll('.sweep-needle').interrupt().remove();

      root0.each((d) => {
        (d as HNode).target = zoomTarget(d, p);
      });

      const dur = reduceMotion ? 0 : 820;
      const t = svg.transition().duration(dur).ease(d3.easeCubicInOut);

      // Per-frame smoothness: the cost of a drill is dominated by regenerating
      // SVG arc paths every tick, so we tween ONLY the arcs that visibly move and
      // snap everything else into place.
      const MIN_ANIM_PX = 0.75; // approx on-screen arc width worth animating
      const arcPx = (b: Box) => (b.x1 - b.x0) * (((b.y0 + b.y1) / 2) * RADIUS_UNIT);
      const finalOpacity = (d: HNode) =>
        belowMin(d) ? 0.12 : d.data.level === 'other' ? 0.45 : 0.86;

      // 1) Arcs outside the destination view: snap to their collapsed target with
      //    zero opacity — instead of fading out over the full duration. Fading
      //    them left a lingering "fan" of thin slivers when drilling in.
      path
        .filter((d) => !arcVisible(d.target!))
        .interrupt()
        .each((d) => {
          d.current = d.target!;
        })
        .attr('fill-opacity', 0)
        .attr('d', (d) => arc(d.current)!);

      // 2) Destination arcs that stay sub-pixel-thin from start to finish: snap
      //    straight to final geometry. They're imperceptible in motion yet each
      //    one costs a full arc rebuild every frame, so tweening them is pure jank.
      const tiny = path
        .filter(
          (d) =>
            arcVisible(d.target!) &&
            arcPx(d.current) < MIN_ANIM_PX &&
            arcPx(d.target!) < MIN_ANIM_PX
        )
        .interrupt()
        .each((d) => {
          d.current = d.target!;
        })
        .attr('d', (d) => arc(d.current)!);
      if (!goingDeeper) tiny.attr('fill-opacity', finalOpacity);

      // 3) The arcs you actually see move: tween geometry (+ opacity, unless the
      //    drill-in reveal sweep below owns opacity to light them up clockwise).
      const moving = path
        .filter(
          (d) =>
            arcVisible(d.target!) &&
            (arcPx(d.current) >= MIN_ANIM_PX || arcPx(d.target!) >= MIN_ANIM_PX)
        )
        .interrupt()
        .transition(t as any)
        .tween('data', (d) => {
          const i = d3.interpolate(d.current, d.target!);
          return (tt) => (d.current = i(tt));
        })
        .attrTween('d', (d) => () => arc(d.current)!);
      if (!goingDeeper) moving.attr('fill-opacity', finalOpacity);

      // Labels: hide non-destination labels instantly, animate the rest. Text
      // (1–2 wrapped lines) is rebuilt to the destination immediately; only
      // opacity / transform / font-size animate.
      const hidden = label.filter((d) => !labelVisible(d.target!));
      hidden
        .interrupt()
        .attr('fill-opacity', 0)
        .attr('transform', (d) => labelTransform(d.target!))
        .attr('font-size', (d) => `${labelFont(d.target!)}px`);
      setLabelLines(hidden, (d) => d.target!);

      const shown = label.filter((d) => labelVisible(d.target!));
      setLabelLines(shown, (d) => d.target!);
      const shownT = shown
        .interrupt()
        .transition(t as any)
        .attr('font-size', (d) => `${labelFont(d.target!)}px`)
        .attrTween('transform', (d) => () => labelTransform(d.current));
      if (!goingDeeper) shownT.attr('fill-opacity', 1);

      // The hit layer is invisible, so there's no reason to tween it — snapping it
      // straight to the destination geometry removes a SECOND full arc-path
      // rebuild per frame (the single biggest drag on drill smoothness). Pointer
      // detection settles to the final layout, which is all that matters post-drill.
      hit
        .interrupt()
        .attr('d', (d) => arcHit(d.target!))
        .attr('pointer-events', (d) => (arcVisible(d.target!) ? 'all' : 'none'))
        .style('cursor', (d) => (d.children ? 'pointer' : 'default'));

      // Drill-in "ignition" sweep: the geometry tween above runs under the unnamed
      // transition while this lights each freshly revealed slice (keyed to its target
      // mid-angle) in lock-step with the needle.
      if (goingDeeper) sweepReveal((d) => d.target!, dur);
    }

    // Single source of truth for arc appearance: visibility, min-amount dimming,
    // and AI highlight glow. Safe to call any time (no rebuild).
    function refreshAppearance() {
      const set = highlightRef.current;
      const active = set.size > 0;
      path
        .attr('filter', (d) => (set.has(d.data.id) && arcVisible(d.current) ? 'url(#arc-glow)' : null))
        .classed('arc-glow-pulse', (d) => set.has(d.data.id) && arcVisible(d.current))
        .attr('fill-opacity', (d) => {
          if (!arcVisible(d.current)) return 0;
          const base = baseOpacity(d);
          if (!active) return base;
          return set.has(d.data.id) ? 1 : base * 0.4;
        });
      hit.attr('pointer-events', (d) => (arcVisible(d.current) ? 'all' : 'none'));
    }

    apiRef.current = { zoomTo, nodeById, refreshAppearance, clearGlow };

    // ---- first-load reveal (dashboard sweep) ----
    // Car gauge self-test on ignition: the needle turns a full clockwise revolution
    // (12 → 12) and the whole wheel lights up in lock-step behind it. The very same
    // routine is replayed on drill-in (see zoomTo), so individual slices get the
    // effect too.
    if (!reduceMotion) sweepReveal((d) => d.current, 1250);

    return () => {
      svg.selectAll('*').interrupt();
    };
  }, [hierarchy, fyMode, reduceMotion, colorOf, onHover, onSelect]);

  // Min-amount changes update appearance in place (no rebuild / no re-reveal).
  useEffect(() => {
    apiRef.current?.refreshAppearance();
  }, [minAmount]);

  useImperativeHandle(ref, () => ({
    focus(id: string) {
      const api = apiRef.current;
      if (!api) return;
      const node = api.nodeById.get(id);
      if (node) {
        // focus the node if it has children, else focus its parent so it's visible
        const target = node.children ? node : ((node.parent as HNode) ?? node);
        api.zoomTo(target);
        onSelect(node.data);
      }
    },
    highlight(ids: string[]) {
      highlightRef.current = new Set(ids);
      apiRef.current?.refreshAppearance();
    },
    reset() {
      const api = apiRef.current;
      if (!api) return;
      const r = api.nodeById.get('root');
      if (r) {
        api.zoomTo(r);
        onSelect(r.data);
      }
      // zoomTo already restores arc opacity + the hit layer to the root view;
      // only the AI highlight glow needs clearing. Calling the full
      // refreshAppearance here would read mid-zoom (stale) geometry and stomp
      // the just-set pointer-events / opacities — the Reset glitch.
      api.clearGlow();
    },
    currentId() {
      return focusRef.current?.data.id ?? 'root';
    },
  }), [onSelect]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <svg ref={svgRef} role="img" aria-label="Spending sundial chart" />
      <div
        ref={tooltipRef}
        style={{ display: 'none' }}
        className="sundial-tip pointer-events-none absolute z-20 max-w-[280px] rounded-xl border border-white/10 bg-ink-800/95 px-4 py-3 shadow-glow backdrop-blur"
      >
        <div className="tip-name text-lg font-bold leading-snug text-cream break-words" />
        <div className="mt-1 flex items-baseline gap-1.5 text-sm">
          <span className="tip-amount font-mono font-semibold text-gold-200" />
          <span className="tip-meta text-mute" />
        </div>
      </div>
    </div>
  );
});

function fit(name: string, max: number): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : clean;
}

// Word-wrap a label into up to `maxLines` lines of at most `maxChars` each.
// The final line is ellipsised if the name still overflows.
function wrapLabel(raw: string, maxChars: number, maxLines: number): string[] {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (maxLines <= 1 || name.length <= maxChars) return [fit(name, maxChars)];
  const words = name.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length <= maxChars) {
      cur = cand;
    } else if (!cur) {
      cur = w; // single word longer than a line; fit() trims it later
    } else {
      lines.push(cur);
      if (lines.length === maxLines - 1) {
        return [...lines, fit(words.slice(i).join(' '), maxChars)];
      }
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines).map((l) => fit(l, maxChars));
}

export default Sundial;
