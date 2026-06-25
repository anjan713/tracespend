export type NodeLevel = 'root' | 'category' | 'agency' | 'vendor' | 'other';

export interface SpendNode {
  id: string;
  name: string;
  level: NodeLevel;
  fy2022: number;
  fy2023: number;
  total: number;
  children?: SpendNode[];
}

export interface VendorRow {
  /** name */ n: string;
  /** total */ t: number;
  /** fy2022 */ a: number;
  /** fy2023 */ b: number;
  /** agency count */ ag: number;
}

export interface AgencyRow {
  /** name */ n: string;
  /** total */ t: number;
  /** fy2022 */ a: number;
  /** fy2023 */ b: number;
}

export interface EvidenceTx {
  vendor: string;
  agency: string;
  category: string;
  fy: number;
  month: string;
  amount: number;
}

export interface SpendMeta {
  title: string;
  tagline: string;
  source: string;
  fiscalYears: number[];
  generatedAt: string;
  grandTotal: number;
  grandTotalByFY: { fy2022: number; fy2023: number };
  rowCount: number;
  skippedRows: number;
  categoryCount: number;
  agencyCount: number;
  vendorCount: number;
  searchableVendors: number;
  limits: { agenciesPerCategory: number; vendorsPerAgency: number };
  reconciliation: { ok: boolean; error: number };
}

export interface SpendData {
  meta: SpendMeta;
  tree: SpendNode;
  vendorIndex: VendorRow[];
  agencyIndex: AgencyRow[];
  evidence: Record<string, EvidenceTx[]>;
}

/** Which fiscal-year lens is active. */
export type FYMode = 'all' | 'fy2022' | 'fy2023';

/** A resolved action the AI/intent layer issues to the chart + panels. */
export interface AgentAction {
  /** node id to focus/drill the sundial into */
  focusId?: string;
  /** node ids to highlight (glow) */
  highlightIds?: string[];
  /** switch fiscal-year lens */
  fyMode?: FYMode;
  /** set minimum amount filter */
  minAmount?: number;
  /** vendor search term to run */
  vendorQuery?: string;
  /** reset view to root */
  reset?: boolean;
}

/** The grounded result the agent produces for a question. */
export interface AgentResult {
  /** deterministic, always-correct answer text (templated) */
  answer: string;
  /** structured facts shown as chips (label + exact value) */
  facts: { label: string; value: string }[];
  /** chart/panel action to apply */
  action: AgentAction;
  /** the matched intent name (for transparency/debugging) */
  intent: string;
}
