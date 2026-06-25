import type { EvidenceMap, FYMode, SpendData, SpendNode } from '../types';

/** Load the precomputed artifact (tree + indexes, no evidence). */
export async function loadData(): Promise<SpendData> {
  const res = await fetch('/artifacts/spending.json');
  if (!res.ok) throw new Error(`Failed to load spending data (${res.status})`);
  return (await res.json()) as SpendData;
}

// Evidence is the largest section of the dataset and is only needed by the
// Verify panel. It lives in a separate file and is fetched lazily, then memoized
// so it loads at most once per session.
let evidencePromise: Promise<EvidenceMap> | null = null;
export function loadEvidence(): Promise<EvidenceMap> {
  if (!evidencePromise) {
    evidencePromise = fetch('/artifacts/evidence.json')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load evidence (${res.status})`);
        return res.json() as Promise<EvidenceMap>;
      })
      .catch((e) => {
        // Reset so a transient failure can be retried on the next call.
        evidencePromise = null;
        throw e;
      });
  }
  return evidencePromise;
}

/** Value of a node under the active fiscal-year lens. */
export function valueOf(n: SpendNode, fy: FYMode): number {
  if (fy === 'fy2022') return n.fy2022;
  if (fy === 'fy2023') return n.fy2023;
  return n.total;
}

/** FY2022 -> FY2023 percent change for a node. */
export function fyChange(n: { fy2022: number; fy2023: number }): number | null {
  if (!n.fy2022) return null;
  return ((n.fy2023 - n.fy2022) / n.fy2022) * 100;
}

/** Build a fast id -> node map and id -> parentId map for the whole tree. */
export function indexTree(root: SpendNode) {
  const byId = new Map<string, SpendNode>();
  const parentOf = new Map<string, string | null>();
  const walk = (n: SpendNode, parent: string | null) => {
    byId.set(n.id, n);
    parentOf.set(n.id, parent);
    n.children?.forEach((c) => walk(c, n.id));
  };
  walk(root, null);
  return { byId, parentOf };
}

/** Ancestors from root -> node (inclusive) for breadcrumb. */
export function pathTo(
  id: string,
  byId: Map<string, SpendNode>,
  parentOf: Map<string, string | null>
): SpendNode[] {
  const out: SpendNode[] = [];
  let cur: string | null | undefined = id;
  while (cur) {
    const node = byId.get(cur);
    if (node) out.unshift(node);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
}

/** Find a category node by fuzzy name match. */
export function findCategory(root: SpendNode, term: string): SpendNode | undefined {
  const t = term.toLowerCase();
  return root.children?.find(
    (c) => c.name.toLowerCase().includes(t) || t.includes(c.name.toLowerCase().split(',')[0])
  );
}

/** Find any agency node (across categories) by fuzzy name match; returns best by total. */
export function findAgency(root: SpendNode, term: string): SpendNode | undefined {
  const t = term.toLowerCase();
  let best: SpendNode | undefined;
  root.children?.forEach((cat) =>
    cat.children?.forEach((ag) => {
      if (ag.level === 'agency' && ag.name.toLowerCase().includes(t)) {
        if (!best || ag.total > best.total) best = ag;
      }
    })
  );
  return best;
}

/** Top-N children of a node by the active lens. */
export function topChildren(n: SpendNode, fy: FYMode, limit = 8): SpendNode[] {
  return [...(n.children ?? [])]
    .sort((a, b) => valueOf(b, fy) - valueOf(a, fy))
    .slice(0, limit);
}
