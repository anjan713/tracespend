// Regression tests for the sundial geometry (the "drill glitch").
//
// The reported bug: drilling into a node with few children left a lingering
// "fan" of thin arcs from elsewhere in the tree. The root invariant that makes
// that impossible: when focused on node p, EVERY visible arc must belong to p's
// subtree, and p's children must tile the full circle exactly. These tests
// assert that on the real data artifact for many focus nodes, and across both
// the equal-angle and value-weighted layouts.
//
// Run with: npm test  (after `npm run build:data`)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TWO_PI, arcVisible, assignEqualAngles, zoomTarget } from '../src/lib/sunburst.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', 'public', 'artifacts', 'spending.json');
const EPS = 1e-6;

function loadTree() {
  assert.ok(fs.existsSync(FILE), 'spending.json missing — run `npm run build:data` first');
  const root = JSON.parse(fs.readFileSync(FILE, 'utf8')).tree;
  // Annotate depth + parent pointers (mirrors what d3.hierarchy provides).
  const walk = (n, depth, parent) => {
    n.depth = depth;
    n.parent = parent;
    (n.children ?? []).forEach((c) => walk(c, depth + 1, n));
  };
  walk(root, 0, null);
  return root;
}

const allNodes = (root) => {
  const out = [];
  const walk = (n) => {
    out.push(n);
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
};

const isInSubtree = (node, p) => {
  for (let a = node; a; a = a.parent) if (a === p) return true;
  return false;
};

// A value-weighted layout (area ∝ total) used to prove the zoom invariant holds
// regardless of how slices are sized.
function assignValueAngles(root) {
  root.x0 = 0;
  root.x1 = TWO_PI;
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    node.y0 = node.depth;
    node.y1 = node.depth + 1;
    const kids = node.children;
    if (kids && kids.length) {
      const total = kids.reduce((s, c) => s + Math.max(0, c.total || 0), 0) || 1;
      let x = node.x0;
      const span = node.x1 - node.x0;
      for (const c of kids) {
        c.x0 = x;
        x += (Math.max(0, c.total || 0) / total) * span;
        c.x1 = x;
        queue.push(c);
      }
      kids[kids.length - 1].x1 = node.x1; // kill float drift
    }
  }
  return root;
}

const tree = loadTree();
const nodes = allNodes(tree);
const internal = nodes.filter((n) => n.children && n.children.length);

test('equal layout: every parent is tiled exactly by its children', () => {
  assignEqualAngles(tree);
  assert.ok(Math.abs(tree.x0 - 0) < EPS && Math.abs(tree.x1 - TWO_PI) < EPS, 'root spans full circle');
  for (const n of internal) {
    const kids = n.children;
    assert.ok(Math.abs(kids[0].x0 - n.x0) < EPS, `${n.name}: first child starts at parent`);
    assert.ok(Math.abs(kids[kids.length - 1].x1 - n.x1) < EPS, `${n.name}: last child ends at parent`);
    const w = (n.x1 - n.x0) / kids.length;
    for (let i = 0; i < kids.length; i++) {
      assert.ok(Math.abs(kids[i].x1 - kids[i].x0 - w) < EPS, `${n.name}: child ${i} not equal width`);
      if (i > 0) assert.ok(Math.abs(kids[i].x0 - kids[i - 1].x1) < EPS, `${n.name}: child ${i} overlaps/gaps`);
    }
  }
  for (const n of nodes) {
    assert.equal(n.y0, n.depth, `${n.name}: y0 == depth`);
    assert.equal(n.y1, n.depth + 1, `${n.name}: y1 == depth+1`);
  }
});

// The core regression: focusing any node must never show an arc from outside it.
function assertNoLeak(focusNodes, layoutName) {
  for (const p of focusNodes) {
    const visible = nodes.filter((n) => arcVisible(zoomTarget(n, p)));
    for (const v of visible) {
      assert.ok(
        isInSubtree(v, p) && v !== p,
        `[${layoutName}] focusing "${p.name}" leaked arc "${v.name}" from outside its subtree`
      );
    }
    // p's direct children tile the full circle at the inner ring (y0 === 1).
    if (p.children && p.children.length) {
      const ring = p.children
        .map((c) => zoomTarget(c, p))
        .filter((b) => b.x1 > b.x0)
        .sort((a, b) => a.x0 - b.x0);
      assert.ok(Math.abs(ring[0].x0 - 0) < EPS, `[${layoutName}] "${p.name}" inner ring must start at 0`);
      assert.ok(Math.abs(ring[ring.length - 1].x1 - TWO_PI) < EPS, `[${layoutName}] "${p.name}" inner ring must reach 2π`);
      for (let i = 1; i < ring.length; i++) {
        assert.ok(ring[i].x0 - ring[i - 1].x1 > -EPS, `[${layoutName}] "${p.name}" inner ring overlaps`);
      }
      for (const c of p.children) {
        const b = zoomTarget(c, p);
        assert.equal(b.y0, 1, `[${layoutName}] "${p.name}" child not on inner ring`);
        assert.equal(b.y1, 2);
      }
    }
  }
}

// Representative focus nodes: root, every category, a sampling of agencies, and
// crucially the smallest-fan-out agency (the exact reported scenario).
const categories = tree.children ?? [];
const agencies = nodes.filter((n) => n.level === 'agency');
const smallestAgency = agencies.reduce((m, a) =>
  (a.children?.length ?? 0) < (m.children?.length ?? Infinity) ? a : m, agencies[0]);

test('reported case: drilling into the smallest agency shows only its own arcs', () => {
  assignEqualAngles(tree);
  const childCount = smallestAgency.children?.length ?? 0;
  const visible = nodes.filter((n) => arcVisible(zoomTarget(n, smallestAgency)));
  assert.equal(visible.length, childCount, `expected exactly ${childCount} visible arcs, got ${visible.length}`);
  assert.ok(visible.every((v) => isInSubtree(v, smallestAgency) && v !== smallestAgency));
  if (childCount === 1) {
    const b = zoomTarget(smallestAgency.children[0], smallestAgency);
    assert.ok(Math.abs(b.x0) < EPS && Math.abs(b.x1 - TWO_PI) < EPS, 'single child must fill the full ring');
  }
});

test('equal layout: focusing any node never leaks outside arcs', () => {
  assignEqualAngles(tree);
  assertNoLeak([tree, ...categories, ...agencies.slice(0, 40)], 'equal');
});

test('value-weighted layout: focusing any node never leaks outside arcs', () => {
  assignValueAngles(tree);
  assertNoLeak([tree, ...categories, ...agencies.slice(0, 40)], 'weighted');
});

test('ancestors and the focus node itself are never drawn as arcs', () => {
  assignEqualAngles(tree);
  for (const p of [...categories.slice(0, 5), ...agencies.slice(0, 20)]) {
    assert.ok(!arcVisible(zoomTarget(p, p)), `${p.name}: focus node should be the hub, not an arc`);
    for (let a = p.parent; a; a = a.parent) {
      assert.ok(!arcVisible(zoomTarget(a, p)), `${p.name}: ancestor "${a.name}" should not be drawn`);
    }
  }
});

test('arcVisible only accepts the three drawn rings with positive width', () => {
  assert.equal(arcVisible({ x0: 0, x1: 1, y0: 1, y1: 2 }), true);
  assert.equal(arcVisible({ x0: 0, x1: 0, y0: 1, y1: 2 }), false, 'zero width hidden');
  assert.equal(arcVisible({ x0: 0, x1: 1, y0: 0, y1: 1 }), false, 'center ring hidden');
  assert.equal(arcVisible({ x0: 0, x1: 1, y0: 3, y1: 4 }), false, 'beyond outer ring hidden');
});
