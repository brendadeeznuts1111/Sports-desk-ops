# Agent graph layout scoring — contract and operator reference

This document is the **sole specification** for how SportsDesk turns laid-out agent graphs into
comparable readability numbers. It states **what** is measured, **why**, and **how operators reproduce
and gate** those numbers. Internal algorithms may change; the contract below is what must stay stable
across runs (enforced by unit tests, layout fixtures, and strict verify).

Related narrative evidence (whole-tree benchmarks, budget sweep outcomes, vision-judge rounds) lives in
[agent-graph-readability.md](agent-graph-readability.md). That doc interprets results; **this doc defines
the ruler.**

---

## Purpose

Fantasy402 agent hierarchies are drawn with several layout engines (Cytoscape, ELK, Graphviz, custom
level rows) and, in production, as **budgeted small-multiple views** rather than one 2,277-node canvas.
Operators need to:

1. **Compare engines fairly** on the same graph — crossings, overlaps, direction, and label size after
   fit-to-raster — without rewarding one engine’s spline aesthetics.
2. **Choose view budgets and rank direction** from measured trade-offs (view count vs worst-case label
   size vs zero tangled edges).
3. **Gate shipped artifacts** so stale or illegible view sets fail CI-style verify before the portal
   serves them.

Scoring is **not** a user-experience study of PNGs (that is a separate judge workflow). It is a
deterministic geometric rubric on layout coordinates.

---

## Scope: what scoring includes and excludes

| In scope | Out of scope |
| -------- | ------------ |
| Axis-aligned node boxes (center, width, height) in **layout space** (y increases downward) | Curved/spline edge routes from any engine |
| Straight **center-to-center** segments for hierarchy edges | Text legibility of individual logins (kerning, anti-aliasing) |
| Pairwise **proper** segment crossings | Whether a human can answer upline questions (see judge workflow in readability doc) |
| Box **overlap** when both centers are closer than half-widths/heights allow | Legend, title bar, or margin ink outside Graphviz node boxes |
| **Flow** alignment for declared `down` or `right` layouts | Radial layouts: flow share is intentionally not scored (`null`) |
| **Uniform scale** fit of the bounding box into a declared raster (`width` × `height`) | Per-view WebP resize policy (see [Shipped views vs raw scoreLayout](#shipped-views-vs-raw-scorelayout)) |

Edges come from the **same parent→child relation** as the graph export being laid out:

- **Structural edges** — envelope tree nesting (`buildAgentTreeFromGeneral` → Cytoscape export). Used
  for whole-tree engine benchmarks.
- **Portal edges** — parent links from the shipped `scratch/agent-graph.json` (portal parser). Used
  only to score **legacy shipped** grid/level-row artifacts in the readability baseline.

Those two edge sets differ for **319 agents** (14% of edges): portal SQLite/parser parents disagree
with envelope nesting. Crossings on structural vs portal graphs are **not comparable** as a single
number; always note which edge source a table used.

---

## Pipeline overview

```text
  Envelope GENERAL rows ──► structural tree ──► Cytoscape export ──► layout engine ──► coordinates
  Portal graph JSON      ──► (same engines)     ──► portal edges

  Coordinates + wire edges (agent id strings)
        │
        ▼  normalize once at layout boundary (resolve ids → node rows; drop missing endpoints)
  LaidOutGraph
        │
        ▼  scoreLayout(graph, raster)
  ReadabilityMetrics
        │
        ├── graph:agent:readability  → scratch/agent-graph-readability.json (+ stdout tables)
        ├── graph:agent:views        → per-view metrics + manifest aggregates
        ├── verify:agent-graph:strict → thresholds on manifest readability
        └── bench:score-layout       → timing + optional JSON metric diff
```

**Prerequisites for full reproduction** (measured baseline in readability doc):

- Envelope at `scratch/raw-f402-list-agents.json` (or path from `resolveDefaultAgentGraphEnvelope`).
- For portal baseline rows: `scratch/agent-graph.json` from `bun run graph:agent`.
- Graphviz `dot` on `PATH` for Graphviz engines and all view builds.
- Bun **1.4.4** (repo pin); ELK layouts spawn a worker that must terminate cleanly.

Commands:

```sh
bun run graph:agent                      # envelope → SQLite / JSON / manifest
bun run graph:agent:readability          # baseline + engine table + budget sweep → scratch JSON
bun run graph:agent:readability -- --skip-engines   # sweep only (faster)
bun run graph:agent:views                # ship small multiples; writes manifest readability
bun run verify:agent-graph:strict        # includes readability thresholds when views are fresh
bun run bench:score-layout               # time scoreLayout on real layouts (see script --help)
bun run bench:score-layout -- --save-fixtures /tmp/layouts.json
bun run bench:score-layout -- --fixtures /tmp/layouts.json --json
```

Readability JSON is keyed by **envelope SHA-256** so two machines can diff reports only when the
envelope file matches.

---

## The scored graph (`LaidOutGraph`)

Before scoring, every layout adapter produces the same shape:

- **Nodes** — `id`, center `(x, y)`, box `w` × `h`, all in layout units.
- **Edges** — endpoints as **indices** into the node list (`sourceIndex`, `targetIndex`), not strings.
- **fontSize** — label size in layout units (engine-specific constant per adapter).
- **flow** (optional) — intended parent→child direction: `down` (TB), `right` (LR), or `radial`
  (twopi / overview radial).

**Wire edges** (`source` / `target` agent id strings) exist only at export boundaries (Cytoscape,
Graphviz DOT, view graphs). They are resolved to indices **once** when building `LaidOutGraph`. Edges
whose source or target id is **missing from the laid-out node list** are **omitted** from scoring (they
do not count toward `edges` or crossings). That matches “score what was actually placed,” not the
full abstract graph.

Public helpers (stable API for tests and adapters):

- `indexLaidOutEdges(nodes, wire)` — attach wire edges to a node list.
- `laidOutGraph(nodes, wire, fontSize, flow?)` — normalize engine output for `scoreLayout`.

**Hard limit:** layouts with **≥ 65,536 nodes** throw at score time (outside current desk scale).

Implementation module: `lib/f402_agent_graph_metrics.ts`. Layout adapters:
`lib/f402_agent_graph_layouts.ts`, Graphviz coordinate import: `lib/f402_agent_graph_dot.ts`.

---

## Layout engines (benchmark set)

`runLayoutEngine(name, cytoscapeExport)` returns `LaidOutGraph`. Names in
`LAYOUT_ENGINES` (`lib/f402_agent_graph_layouts.ts`):

| Engine | Typical flow | Notes |
| ------ | ------------ | ----- |
| `level-rows` | `down` | Deterministic row/column from level index |
| `cytoscape-grid` | `down` | Grid in 1920×1080 bounding box; node order affects crossings |
| `cytoscape-breadthfirst` | `down` | Directed BFS from roots (nodes with no incoming edge in export) |
| `elk-mrtree` | `down` | ELK Mr. Tree, down |
| `elk-layered` | `down` | ELK layered |
| `graphviz-dot` | `down` | DOT TB via `renderViewDot` + `graphvizLayout` |
| `graphviz-dot-lr` | `right` | DOT LR |
| `graphviz-twopi` | `radial` | Twopi; flow share not scored |

Whole-tree benchmarks in `graph:agent:readability` score each engine on the **structural** export at
**FULL_RASTER** (below). Baseline rows additionally score **portal** exports for `cytoscape-grid` and
`level-rows` against shipped artifacts.

---

## Raster sizes

Scoring always takes an explicit `RasterFit` `{ width, height }` — “if this layout’s bounding box were
scaled uniformly to fit inside this rectangle, how large would labels become?”

| Name | Default size | Used by |
| ---- | ------------- | ------- |
| **FULL_RASTER** | 1920 × 1080 | Whole-tree engine benchmark, `bench:score-layout`, shipped capture viewport |
| **VIEW_RASTER** | 2400 × 4800 | Each small-multiple view in readability sweep and `graph:agent:views` |

Override full raster via environment (read by `scripts/agent_graph_readability.ts`):

- `F402_GRAPH_VIEWPORT_W` (default `1920`)
- `F402_GRAPH_VIEWPORT_H` (default `1080`)

View raster defaults for sweep: `F402_GRAPH_VIEW_RASTER_W` / `F402_GRAPH_VIEW_RASTER_H` (2400 / 4800).

`build_agent_graph_views.ts` hardcodes `VIEW_RASTER` 2400×4800 for scoring during view build.

---

## `scoreLayout(graph, raster)` — algorithm contract

Given a normalized graph and raster, scoring:

1. Builds axis-aligned boxes from node centers and sizes.
2. Computes axis-aligned **bounds** of all boxes (min/max x/y).
3. For each indexed edge, draws a segment between **centers** of source and target nodes.
4. Counts **proper crossings** between segment pairs (see below).
5. Counts **overlapping** box pairs (see below).
6. Computes **against-flow share** from center deltas vs declared `flow` (unless `radial`).
7. Computes **fitScale** = min(`raster.width / boundsWidth`, `raster.height / boundsHeight`).
8. Sets **effectiveFontPx** = `graph.fontSize * fitScale`.

No engine-specific code runs inside this function.

---

## Metric reference (`ReadabilityMetrics`)

Every field returned by `scoreLayout`:

| Field | Meaning |
| ----- | ------- |
| `nodes` | Count of laid-out nodes |
| `edges` | Count of scored segments (after dropping wire edges with missing endpoints) |
| `crossings` | Proper segment crossings among scored edges |
| `overlaps` | Unordered pairs of nodes whose boxes overlap |
| `boundsWidth`, `boundsHeight` | Rounded size of the layout bounding box (layout units) |
| `aspectRatio` | `boundsWidth / boundsHeight`, two decimal places |
| `widestRow` | Maximum count of nodes sharing the same **rounded** y coordinate (horizontal “row” density) |
| `meanEdgeLength` | Mean Euclidean center-to-center length over scored edges (rounded) |
| `againstFlowEdgeShare` | Fraction of edges where the child center is not sufficiently **downstream** in the declared direction; `null` when `flow === "radial"` |
| `fitScale` | Uniform scale if the bounds box were fit inside the raster (3 significant figures) |
| `effectiveFontPx` | `fontSize * fitScale` (two decimal places) — primary **label size proxy** for whole-layout fit |

### Crossings

- Segments are straight lines between **box centers**.
- A crossing counts only if segments **properly intersect** (transversal X), using standard orientation
  tests with a small epsilon (`1e-9`).
- **Shared endpoints** do not count (edges meeting at a node are not “tangled”).
- **Collinear overlaps** (parallel segments on the same line) do not count.
- Pairs that share a node id on one segment but not as endpoints are still eligible if geometry crosses
  properly (rare on trees; common on grid layouts).

Crossing detection must remain **exact** (not sampled). It uses a **sweep-and-prune** strategy on the
axis where segment spans are tighter, so tree-like drawings stay sub-quadratic; grid layouts may still
visit many pairs.

Unit tests: fixed K₂,₂ layout → exactly one crossing; randomized layouts compared to all-pairs
`segmentsCross` reference; mutation checks on sweep ordering.

### Overlaps

Two nodes overlap when, on both axes, center separation is strictly less than half the sum of widths
(heights), with a tiny tolerance (`1e-6`) so touching boxes do not count.

Overlap counting uses **uniform grid bucketing** over the bounds box; cell size scales with average node
size and drawing extent. Result is exact (each unordered pair counted once).

### Flow (`againstFlowEdgeShare`)

For `flow === "down"` (TB): child center must be **below** parent (`Δy > 1e-6`). For `flow === "right"`
(LR): child must be to the right (`Δx > 1e-6`). Edges failing that test increment `nonDown`; the share
is `nonDown / edges` (three decimal places). Horizontal ties and upward/back edges count as against flow.

For `flow === "radial"`, the field is **`null`** — twopi and similar layouts do not assert a global
down/right direction.

### Fit and effective font

Scoring assumes the **entire** layout bounds scale uniformly to fit the raster (letterboxing logic is
not modeled; only the limiting scale factor matters). `effectiveFontPx` is the layout’s declared
`fontSize` multiplied by that scale — a **lower bound proxy** for label height after fit, not a measured
render of Graphviz font metrics.

View builds use DOT `fontsize=12` (`VIEW_FONT_SIZE` in `lib/f402_agent_graph_dot.ts`) unless an engine
adapter sets a different `fontSize` on `LaidOutGraph`.

---

## Readability report (`graph:agent:readability`)

Writes `scratch/agent-graph-readability.json` containing:

- `envelopeSha256`, `generatedAt`, `fullRaster`, `viewRaster`, tree `stats`
- `baseline[]` — portal-edge rows for shipped grid + level-rows
- `engines[]` — structural-edge rows for each layout engine (includes layout wall time `ms`)
- `sweep[]` — budget × rankdir combinations

### View budget sweep rows

For each `(budget, rankdir)` in `{40,60,90,140} × {TB,LR}`:

- Builds a view set (`buildViewSet`) with `leafBundleMin: 3`.
- Lays out **each view** with Graphviz `dot`, wire edges from the view graph, flow `down` or `right`.
- Scores with **VIEW_RASTER**.
- Aggregates:
  - `views`, `coverage`, `reconciled` (every view passes `viewReconciles`)
  - `worstFontPx` — minimum per-view effective font, capped at `VIEW_FONT_SIZE * 2` per view in sweep
    (readability script only; see shipped views note below)
  - `medianFontPx`, `viewsUnder8px`
  - `totalCrossings`, `totalOverlaps` — **sum** over views (gate expects sum ≤ 0)

**Budget semantics** (`ViewBuildOptions.budget`): visual weight per view — each agent box costs 1; each
leaf table costs `1 + ⌊n/12⌋`. Higher budget → fewer, denser views.

Default shipped configuration (from sweep): **budget 140, rankdir LR** — fewest views with no view under
8 px effective font in the sweep table; see readability doc for measured WebP worst case after label fixes.

---

## Shipped views vs raw `scoreLayout`

`graph:agent:views` scores each view with the same `scoreLayout` + VIEW_RASTER as the sweep, but the
**manifest gate** uses a slightly different worst-font figure:

- After Graphviz renders PNG at 96 DPI, WebP may be **downscaled** to fit inside VIEW_RASTER (`fit:
  inside`).
- Manifest `worstFontPx` uses `VIEW_FONT_SIZE * pxPerPt` from the **actual WebP** dimensions vs source
  PNG (`build_agent_graph_views.ts`), stored per view in `index.json` entries as `metrics.effectiveFontPx`
  (overriding the pure fit-box estimate when they differ).

Strict verify compares manifest `readability.worstFontPx` to thresholds — that is the **shipped** font
proxy including rasterization, not the abstract layout-only number.

Crossings/overlaps in the manifest are still **sums** of per-view `scoreLayout` metrics on Graphviz
layout coordinates (legend disabled in layout DOT for scoring).

---

## Gate thresholds (strict verify)

Defined in `AGENT_GRAPH_READABILITY_THRESHOLDS` (`lib/f402_agent_graph_artifacts.ts`):

| Threshold | Default | Manifest field |
| --------- | ------- | -------------- |
| Minimum worst view font | **9 px** | `readability.worstFontPx` |
| Maximum total crossings | **0** | `readability.totalCrossings` |
| Maximum total overlaps | **0** | `readability.totalOverlaps` |

These defaults are **provisional**, set from the measured baseline documented in
[agent-graph-readability.md](agent-graph-readability.md). Changing them requires updating the constant
and the evidence doc together.

When views are fresh (`viewsEnvelopeSha256` matches), `verify:agent-graph:strict` also checks:

- Coverage equals ingested agent count
- Every view reconciles (shown agents + `+N` badges = subtree)
- Overflow markers sum to `skippedOverflowCount`
- Parent divergence count is informational (portal vs envelope)

Readability checks are **skipped** if views are stale — run `graph:agent:views` first.

---

## Regression and performance

| Mechanism | Role |
| --------- | ---- |
| `lib/f402_agent_graph_metrics.test.ts` | Crossing, overlap grid, flow, fit, randomized crossing parity |
| `lib/f402_agent_graph_dot.test.ts` | Graphviz tree layout → 0 crossings / overlaps on fixture view |
| `bench:score-layout --json` | Compare `{ layout: ReadabilityMetrics }` across git revisions |
| Saved fixtures | `--save-fixtures` / `--fixtures`; **re-save after** `LaidOutGraph` edge shape changes |

Layout JSON fixtures store indexed edges; older fixtures with string `{ source, target }` edges must be
regenerated.

Performance of scoring itself is benchmarked on ~2,277-node real graphs via `bench:score-layout`; layout
engine wall time is separate (`ms` in readability JSON).

---

## Interpreting benchmark tables (readability doc)

When reading [agent-graph-readability.md](agent-graph-readability.md) tables:

- **Whole-tree 1920×1080** — one layout, FULL_RASTER; explains why a single raster fails (effective font
  ≪ 1 px for tree engines) even at 0 crossings.
- **High crossing counts on grid** — center-line segments over a grid placement, not necessarily what
  the WebView spline drawing shows; still valid for **comparing** grid vs tree engines on equal terms.
- **Portal vs structural** — portal baseline rows (166k / 125k crossings) use **portal** edges; engine
  rows use **structural** edges; do not merge them into one ranking without relabeling.
- **Twopi** — nonzero crossings, `againstFlow` n/a; radial overview is decorative, not flow-gated.

---

## Caveats (read before trusting a number)

1. **Straight segments** — Scoring ignores spline routing; a layout can look clean in SVG but score many
   crossings on center lines (especially grids).
2. **Missing endpoints** — Graphviz may omit nodes from json0 output; their edges disappear from the scored
   edge count rather than failing the run.
3. **Node order** — Cytoscape grid crossing counts depend on element order; structural pre-order vs shuffled
   order can change crossings materially (documented for portal grid).
4. **Ids vs logins** — Edges use **AgentID** strings; drawings may show logins. Scoring follows export ids.
5. **Not a substitute for judges** — Thresholds gate geometry on built views; human or vision-model
   question answering is documented separately.
6. **Implementation may evolve** — Sweep/bucketing internals may change; **metric definitions** in this
   document and parity tests are the contract.

---

## Code map (entry points only)

| File | Responsibility |
| ---- | ---------------- |
| `lib/f402_agent_graph_metrics.ts` | `scoreLayout`, `ReadabilityMetrics`, graph normalization |
| `lib/f402_agent_graph_layouts.ts` | Engine adapters → `LaidOutGraph` |
| `lib/f402_agent_graph_dot.ts` | DOT emission, Graphviz run, `graphvizLayout` |
| `lib/f402_agent_graph_views.ts` | Budgeted views, reconciliation, coverage |
| `scripts/agent_graph_readability.ts` | Report JSON + stdout tables |
| `scripts/build_agent_graph_views.ts` | Ship views + manifest readability |
| `scripts/bench_score_layout.ts` | Timing and fixture diff |
| `scripts/verify_agent_graph_pipeline.ts` | Strict readability gate |
| `lib/f402_agent_graph_artifacts.ts` | Threshold constants, manifest fields |

---

## Document maintenance

Update this file when:

- Any metric definition, raster default, or threshold changes
- A new layout engine is added to `LAYOUT_ENGINES`
- Manifest readability fields change shape
- Edge source semantics (portal vs structural) change

Evidence labels in commits should state **what was measured** (envelope SHA, command, date), per
`AGENTS.md`.
