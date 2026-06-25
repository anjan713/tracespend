// Pure sundial geometry — no D3, no DOM. Shared by the Sundial component and the
// regression tests so the visuals are provably correct without a browser.
//
// A "box" is { x0, x1, y0, y1 } where x is the angle (radians, 0..2π) and y is
// the ring index (0 = center hub). Three rings are drawn (y0 >= 1, y1 <= 3).

export const TWO_PI = 2 * Math.PI;

// Minimum angular width (radians) for an arc to count as on-screen. Anything
// thinner is either a collapsed arc or floating-point dust left by clamping a
// node that sits just outside the focused subtree — drawing it produced the
// "fan" glitch, so we treat sub-epsilon widths as invisible.
const ANGLE_EPS = 1e-9;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * An arc is drawn only when it sits inside the three visible rings AND has
 * meaningful angular width. This single predicate decides what is on screen — it
 * is what prevents collapsed/out-of-view arcs from ever rendering.
 */
export function arcVisible(box) {
  return box.y1 <= 3 && box.y0 >= 1 && box.x1 - box.x0 > ANGLE_EPS;
}

/**
 * Equal-angle layout: every node's angular span is divided equally among its
 * children. Mutates and returns the root. Each node must have `depth` and
 * (optionally) `children`. Processed breadth-first so a parent's span is always
 * set before its children are divided.
 */
export function assignEqualAngles(root) {
  root.x0 = 0;
  root.x1 = TWO_PI;
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    node.y0 = node.depth;
    node.y1 = node.depth + 1;
    const kids = node.children;
    if (kids && kids.length) {
      const w = (node.x1 - node.x0) / kids.length;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        c.x0 = node.x0 + i * w;
        c.x1 = c.x0 + w;
        queue.push(c);
      }
    }
  }
  return root;
}

/**
 * The post-zoom target box for `node` when the view is focused on `focus`.
 * Mirrors d3's zoomable-sunburst transform: the focus subtree expands to fill
 * the full circle and everything outside clamps to a zero-width sliver, so it
 * fails `arcVisible` and is never drawn. This is the core guarantee that
 * drilling into any node cannot leak arcs from elsewhere in the tree.
 */
export function zoomTarget(node, focus) {
  const span = focus.x1 - focus.x0 || 1;
  return {
    x0: clamp01((node.x0 - focus.x0) / span) * TWO_PI,
    x1: clamp01((node.x1 - focus.x0) / span) * TWO_PI,
    y0: Math.max(0, node.y0 - focus.depth),
    y1: Math.max(0, node.y1 - focus.depth),
  };
}
