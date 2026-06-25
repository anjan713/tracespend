# Tracespend — *Where did the money go?*

An animated **sundial** explorer that lets a non-technical person (think: a city
councilmember) understand **$63B of state vendor payments** in seconds — and
**trust every number** they repeat in public.

Ask a plain-English question; an AI agent answers *and* drives the chart, while a
verification panel shows the exact figures and the real transactions behind them.

> Portfolio proof-of-concept. Theme is *gold-on-dark* (visual inspiration only).

---

## Why this design

A first-time budget viewer doesn't want a spreadsheet — they want to **follow the
money** and **trust the number**. Three linked panels do exactly that:

| Panel | Role |
|------|------|
| **Ask** (left) | Natural-language questions + one-click starter prompts. |
| **Explore** (center) | Animated sundial drilling `Category → Agency → Vendor`. |
| **Verify** (right) | Exact totals, FY-over-FY change, top contributors, and **evidence** (the actual payments). |

On wide screens the **Ask** and **Verify** panels are **drag-resizable** (double-click
a divider to reset; widths persist in `localStorage`) — the center sundial is always
protected from being squeezed below a usable width.

**Hierarchy:** `Category → Agency → Vendor` (SubCategory dropped — *Agency* is the
intuitive "who"). Each ring is deliberately sparse: all **9 categories**, then the
**top 5 agencies** per category and **top 6 vendors** per agency, with the long tail
folded into one clickable **"Other"** arc. Clicking "Other" drills into the next
page — up to **15 agencies** / **12 vendors** — after which the remaining tail folds
into a single flat leaf. Nothing is hidden — totals always reconcile and the top
**5,000** vendors stay searchable by name.

---

## Reliability (the most important part)

For a councilmember, the numbers must be exact, traceable, and reproducible.

- **Precompute, never compute live.** `scripts/build-data.mjs` emits the sundial
  artifact (`public/artifacts/spending.json`); `scripts/build-query-worker.mjs` emits a
  compact encoded snapshot of all ~935k rows (`server/artifacts/dataset.json`, integer
  cents). Nothing parses CSVs at request time.
- **The AI never does math.** For Q&A, Anthropic only turns a question into a
  validated `Query` (intent + args) — *never a number*. A server-side, code-only
  **query worker** (`server/query-worker/`) computes the exact figures, code
  composes the factual sentence, and Anthropic only *rewords* it, copying every
  number verbatim. The verified sentence + fact chips are always shown.
- **Totals reconcile — twice.** "Other" rollups carry the full remainder and the
  build **asserts** `sum(parts) === grandTotal`. `npm test` re-checks the artifact
  *and* reconciles the query worker's numbers back to it to the cent (grand total,
  FY splits, every category, top agencies/vendors).
- **Validated + capped + logged.** Names resolve to canonical (no silent $0); bad
  enums are rejected; ≤1 parse + ≤1 reword call per question with a request
  timeout; every model input is recorded at one choke-point (`logs/ai-inputs.log`).
- **Graceful degradation.** The sundial works fully offline. Answering is
  Anthropic-only (your choice): no key/server → a clear "AI unavailable — retry".

Verified at build time:

```
grand total : $63,247,181,911   (FY2022 $29.5B + FY2023 $33.7B)
rows         : 935,853          reconciled: OK (diff $0.00)
```

---

## The "wow factor" — animations

All transitions are eased, interruptible, and honor `prefers-reduced-motion`.

- **First-load reveal** — rings unfurl from the center; the hub total counts up.
- **AI camera moves** — answering a question zooms/rotates to the relevant slice,
  dims the rest, and pulses a gold glow on the focus arc.
- **Drill-in / drill-out** — buttery D3 arc-tween with an animated breadcrumb.
- **Live data motion** — FY lens changes re-animate; hover lift; number roll-ups.

---

## Run it

```bash
npm install
npm run build:data     # sundial artifact -> public/artifacts/spending.json (~40s, one-time)
npm run build:worker   # encoded dataset  -> server/artifacts/dataset.json  (~16s, one-time)
npm run dev            # http://localhost:5173  (the sundial works offline)
```

Ask-the-data Q&A (Anthropic-only, retry-then-error — needs a key + the server):

```bash
cp .env.example .env   # set ANTHROPIC_API_KEY=...  (Claude)
npm run server         # http://localhost:8787 (vite proxies /api to it)
```

Uses Anthropic's Messages API (set `ANTHROPIC_MODEL` to one your key can access;
default `claude-haiku-4-5-20251001`). The LLM
only chooses the `Query` and rewords the final sentence — it never computes or
alters a number. Without a key, the chart still works; answering returns a clear
"AI unavailable — retry".

Verify and build:

```bash
npm test               # reliability assertions on the artifact
npm run build          # type-check + production bundle
```

### Deploy (Render — one service)
In production the Express server doubles as the static host, so a **single Render
Web Service** serves the app **and** the `/api` routes on the same origin (matching
the client's relative `fetch('/api/...')`). A `render.yaml` blueprint is included:

- **Build:** `npm install --include=dev && npm run build`
- **Start:** `node server/index.mjs` (serves `dist/` + `/api/*`; health at `/api/health`)
- **Env:** set **`ANTHROPIC_API_KEY`** (without it the chart works but Ask returns a
  clean 503); `NODE_VERSION` is pinned to 20.

Push the repo to GitHub, then in Render pick **New → Blueprint** and select it.

### Try asking
- *Where did the money go?*
- *Which agencies spend the most?*
- *Show me Grants & Client Services*
- *What grew the most in FY2023?*
- *Show vendors for Health Care Authority*
- *Show FY2023 only*

---

## How it works

```
data/*.csv ──build:data────> public/artifacts/spending.json  (sundial tree + indexes)
           └─build:worker──> server/artifacts/dataset.json    (encoded ~935k rows)

Ask ─POST /api/ask─> server/index.mjs
  1 parseQuestion   Anthropic → strict JSON Query (no numbers)   [retry ×2, else 503]
  2 normalize       defaults, clamps, reject bad enums
  3 resolveNames    "Dept of Fish & Wildlife" → canonical (or a friendly "no match")
  4 runQuery        code-only query worker → exact numbers
  5 composeSummary  code owns the sentence + every figure
  6 summarize       Anthropic rewords only — numbers copied verbatim (else fallback)
  → { answer, prose, facts, action }  → React moves the D3 sundial
```

### Project layout
| Path | Purpose |
|------|---------|
| `scripts/build-data.mjs` | Two-pass CSV → sundial artifact + reconciliation assertion. |
| `scripts/build-query-worker.mjs` | Encode raw CSVs → `server/artifacts/dataset.json` (dictionary + integer cents). |
| `server/query-worker/` | Code-only worker: `dataset` · `query` (runQuery) · `resolve` · `normalize` · `compose`. |
| `server/ai.mjs` | AI boundary: `parseQuestion` + `summarize` + single logging choke-point. |
| `server/index.mjs` | Server: `/api/ask` pipeline + legacy `/api/prose` + `/api/log`. |
| `src/lib/ask.ts` | Client wrapper for `/api/ask` (async, error/retry). |
| `src/lib/intent.ts` | Starter prompts + small name helpers (retired from the AI path). |
| `src/components/Sundial.tsx` | Custom D3 zoomable sunburst + animation API. |
| `src/components/AskPanel.tsx` | Async chat UI: Thinking… / answer + verified figures / retry. |
| `test/reconcile.test.mjs` · `test/eval.test.mjs` | Artifact reliability + query-worker↔artifact reconciliation. |

### Data note
The raw source CSVs + media (`data/`, ~217MB) and `logs/` are git-ignored
(build-time/runtime only). The two small generated artifacts
(`public/artifacts/spending.json`, `server/artifacts/dataset.json`) **are committed**
so the app runs without the CSVs; regenerate them any time with
`npm run build:data` and `npm run build:worker`.

### Data cleaning
The source is a fixed-width-style government export, so both build scripts apply
the **same** deterministic cleaning pass (and reconcile to the cent afterwards):

- **Whitespace / BOM / CRLF / quoted commas** — every field is trimmed; the parser
  strips the byte-order mark and tolerates Windows line endings and embedded commas.
- **Types validated, never coerced silently** — `FY`→int, `Amount`→float; a row is
  dropped only if the fiscal year isn't 2022/2023, a category/agency/vendor is empty,
  or the amount isn't finite. On this dataset **0 of 935,853 rows are dropped**.
- **Money in integer cents** — sums are exact (no float drift).
- **Negatives and zeros are kept, never filtered** — the data includes **1,083
  negative rows** (refunds / reversals / accounting corrections, largest ≈ −$1.67M)
  and **54 zero-dollar rows**. They remain in every total so agency/vendor figures
  are **net, not overstated** — the only spend-reducing toggle is the opt-in,
  category-based `excludeReimbursements` (off by default).
- **Fiscal months normalized across the biennium** — the 2021–23 export numbers
  months continuously (FY2022 = 1–12, FY2023 = 13–24); the worker maps the second
  year back to 1–12 so per-year monthly trends are correct.
- **Vendor de-duplication (conservative)** — vendor names are canonicalized
  (case, `&`/`AND`, punctuation, whitespace, and legal-suffix synonyms like
  `INCORPORATED`→`INC`) so obvious printed-name variants merge while the original
  display name is preserved. This is a *safe, deterministic* pass, **not** fuzzy
  entity resolution — true cross-spelling matching (e.g. different punctuation of
  the same firm, or shared subsidiaries) is a **documented production gap**, since a
  wrong merge would silently misattribute money.

---

## Submission write-up

### 1. The problem I set out to solve — and why this direction

**The user pain.** A newly seated **city councilmember** has to vote on, defend,
and explain a budget made of hundreds of thousands of vendor payments. The data
*exists* — open-data portals, CSV exports, PDF appropriations — but it assumes you
already know what to ask and how to query. The real pain isn't access; it's
**orientation and trust**: *where did the money actually go,* and *can I repeat a
number in a public meeting without being wrong?*

**Why this direction over the alternatives I considered.** I deliberately did
**not** build:

- **Another dashboard / searchable table** — that's the spreadsheet they're already
  drowning in; it answers "filter rows," not "help me understand."
- **A bar/treemap report** — proportions are honest but drilling is clumsy and the
  small-but-politically-charged line items disappear.
- **A pure chatbot over the data** — fluent, but you cannot trust an LLM with
  dollar figures, and it offers no way to *see* the shape of spending.

Instead I built a **guided "follow the money" experience** around the two jobs the
councilmember actually has: an **animated sundial** to *explore* spending outward
(`Category → Agency → Vendor`), a **Verify panel** that turns every selection into
exact figures plus the **real underlying payments**, and an **AI agent that
navigates and narrates but never computes**. Exploration *and* trust, in one view.

### 2. The tech & architectural choices

**What I built.** A React + TypeScript + Vite + Tailwind front end with a custom
**D3 zoomable sunburst** (`src/components/Sundial.tsx`); a two-stage **precompute**
(`scripts/build-data.mjs` → the sundial artifact; `scripts/build-query-worker.mjs`
→ an encoded, integer-cent snapshot of all ~935k rows); and an Express server
(`server/index.mjs`) with a strict **AI boundary** (`server/ai.mjs`) wrapped around
a **code-only query worker** (`server/query-worker/`).

**How it works.** A question flows: Anthropic turns it into a *validated `Query`*
(intent + args, **no numbers**) → normalize/clamp/reject-bad-enums → resolve names
to canonical → the **code-only worker computes every figure** over the full dataset
→ code composes the factual sentence → Anthropic **rewords only**, copying numbers
verbatim → React moves the sundial. The chart works **fully offline**; answering is
Anthropic-only with an explicit "AI unavailable — retry."

**The decisions that define it** (trade-offs stated plainly):

- **The AI never produces a number** — correctness/auditability over open-ended
  chat. The model emits a query and rewords; code owns all math.
- **Precompute, never compute live** — instant + deterministic, at the cost of
  data freshness (new data = a rebuild, not a live query).
- **Equal-angle slices by default** — small line items stay clickable/readable for
  a newcomer; a "By amount" toggle preserves true proportions for power users.
- **Totals reconcile twice** — a build-time assertion (`sum(parts) === grandTotal`)
  *and* a test that reconciles the worker back to the artifact **to the cent**.

**What I explicitly deferred** (prototype, on purpose): a real datastore (the
snapshot is in memory), auth, rate limiting, prompt-injection hardening, caching,
observability, an accessibility pass for the SVG, multi-year / multi-jurisdiction
config (the FY range and category set track this dataset), and live data freshness.

**What I'd change for production:** move the data to a **columnar warehouse**
(DuckDB / BigQuery) with **incremental ingestion** instead of full rebuilds; put
the API behind **auth, rate limits, caching, and monitoring**; harden the AI
boundary against prompt injection and confirm **no PII ever reaches the model**;
broaden the query worker's supported intents (or formalize them as a validated
tool schema); and make the sundial keyboard- and screen-reader-accessible.

### 3. AI usage log

Three significant interactions — *what I asked, what it gave, what I kept / changed
/ rejected.*

- **Wiring up the "ask the data" agent.** *Asked:* let users ask budget questions
  in plain English and get answers. *Gave:* a flow where the **model answered
  directly** and produced the totals itself. *Kept:* the conversational UX and
  having the answer drive the chart. **Rejected:** the model computing figures — I
  caught it rounding and occasionally inventing numbers. **Changed:** re-architected
  so the model only emits a validated query and rewords a code-authored sentence,
  with a query worker doing the math and tests reconciling every number to source.
- **The drill-in animation glitch.** *Asked* (with a screen recording): fix the
  lingering "fan" of thin arcs when drilling into a sparse node. *Gave:* a fix that
  faded outgoing arcs across the whole transition — which was *itself* the cause.
  **Rejected** that approach; **changed** it to snap outgoing arcs away instantly
  and animate only the destination; **kept** the eased arc-tween, then had it
  **extract the geometry into a tested module** with regression tests so it can't
  regress.
- **Readability of small slices + the "Other" model.** *Asked:* small slices are
  unreadable and we can't see much. *Gave:* shrink the labels and keep
  area-proportional sizing. **Rejected** shrinking labels; **changed** the default
  to **equal-angle** slices and rebuilt the long tail into **paged, drillable
  "Other"** rings (chose *"expand into a new ring"* over a flat cutoff); **kept** an
  optional "By amount" toggle for honest proportions.

### Mandatory AI question — one redirection moment (script for the video)

> *Walk me through one moment where you redirected what the AI gave you.*

The clearest one was the **agent's architecture**. When I first asked the AI to
build the "ask the data" feature, it wired the model up to **answer questions
directly** — i.e., to produce the dollar figures itself. That didn't meet the bar:
a budget tool's entire value is trust, and I watched the model **round figures and,
once, invent a total** that wasn't in the data. So I redirected the whole design:
the model is now **forbidden from emitting a number** — it only turns the question
into a *validated query* and **rewords** a sentence my code has already written,
while a deterministic, code-only worker computes every figure over the full dataset.
I then added tests that **reconcile each answer back to the source to the cent.**
That single redirection — distrusting the AI's strength (fluency) and architecting
around its weakness (arithmetic) — is the reason the UI can show a "Reconciled"
badge and the chip "numbers verified by the query worker."

### Video walkthrough (submission)

**Format:** record as **`.mp4`, `.mov`, or `.webm`** and upload directly on the
**Provn** platform. A full teleprompter script lives in
[`DEMO_SCRIPT.md`](./DEMO_SCRIPT.md).

**Structure (target ~8–11 min):**

- **Summary (~60s)** — the problem I chose and why.
- **Code walkthrough (3–4 min)** — what I built, what I decided, what I left out.
- **Product & production walkthrough (3–4 min)** — the user experience and why it's
  designed this way; what would need to change before production.
- **Mandatory AI question (1–2 min)** — the redirection moment above.
- **Reflection (30–60s)** — what I'd build next and do differently with more time.

> Communication is assessed on **clarity and logical structure**, not verbal polish
> — speak naturally.
