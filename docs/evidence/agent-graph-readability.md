# Agent graph readability — measured, judged, hierarchical

Every number below comes from the envelope `scratch/raw-f402-list-agents.json`,
SHA-256 `abeccc656c9ea6a248af7fba62d001495b276a01303d889fc5138cd2ae7b7dfd` (2,466 GENERAL rows;
2,277 agents at levels 1–12; 189 overflow agents at levels 13–19). Reproduce with:

```sh
bun run graph:agent                 # envelope → SQLite / JSON / manifest
bun run graph:agent:views           # structural tree → 24 Graphviz views (SVG + WebP)
bun run graph:agent:image           # WebView → Bun.Image capture of the overview (after views)
bun run graph:agent:readability     # baseline + engine benchmark + budget sweep
bun run verify:agent-graph:strict   # 31 checks incl. readability thresholds (viewer on :9876)
```

`graph:agent:views` must run before `graph:agent:image`; the capture uses the budgeted overview
only when the manifest says views match the envelope.

## Findings nobody had stated

1. **The shipped graph mis-parents 319 of 2,273 edges (14%).** GENERAL is a clean pre-order list
   (0 level jumps, 0 duplicate ids), so each agent's parent is the nearest preceding row one level up.
   The pinned portal parser (`f402_portal_hierarchy_parser.ts`, a port of manager.js `baseHeriarchy`)
   disagrees in two places:
   - **Level 6 → level 4 (209 agents).** Its level-6 branch sets `Master: i` (the level-4 agent)
     instead of `s` (level 5). Example: `L6-A` is nested under `L5-A` (L5) in the envelope
     but parented to `L4-A` (L4).
   - **Level 12 → previous level-12 sibling (110 agents).** After a level-12 row it assigns `u = A`,
     so every later sibling chains off the previous one. Example: `L12-A` is nested under
     `L11-A` (L11) but parented to `L12-B` (L12).

   SQLite `agents.parent_id` (used by the CLI and manager boot) inherits both quirks. The new views
   use the envelope nesting and every `/agent/<id>` page flags the disagreement. Per-root totals are
   unaffected (a recursive CTE over SQLite gives the same root sizes as the envelope tree), which is
   why the existing count checks never caught it.
2. **One root is the whole business.** `L1-A` holds 2,274 of 2,277 agents; `L1-B`,
   `L1-C` and `L1-D` have no descendants. Level-2 `L2-A` alone holds 1,621 (71%),
   `L2-B` 646. "One view per root" and "color by root" carry no information, so color is by
   level-2 branch, and even that is mostly one color — size and `+N` badges do the real work.
3. **81% of agents are leaves (1,835) and fan-out is extreme.** Median 2 children, p90 9, max 250
   (`L7-A`, L7). Drawing leaves as boxes is what made every whole-tree layout illegible; the
   views fold each parent's leaves into one multi-column name table.
4. **Overflow is concentrated.** All 189 level 13–19 agents sit under 32 level-12 owners;
   `L12-C` owns 62 and `L12-D` 36 (52% between them). By level: 13→91, 14→30, 15→36, 16→12,
   17→9, 18→7, 19→4.
5. **A single whole-tree raster cannot be readable, whatever the engine.** Every tree layout reaches
   0 crossings, yet fitting 2,277 agents into the 1920×1080 capture gives at most a 0.62 px label.
   Small multiples are required, not a nicety.
6. **AgentID is not the login.** 84 agents have an `AgentID` that differs from their `Login`:
   some IDs add a trailing dot (`X.` for login `X`), others are a different name entirely. One login
   is shared by two agents (L6 and L10) whose IDs differ only in trailing dots. Drawings show
   logins; SQLite, URLs and edges use IDs. `/agent/<login>` redirects to the ID page, and a shared
   login lists both agents.
7. **A long single-child spine.** `L2-A → L3-A → L4-B` hold 1,621 / 1,612 / 1,611
   agents: three levels that add depth but almost no branching (a candidate for chain compression).

## Baseline vs benchmark (whole tree, fit to 1920×1080)

Edges scored as straight center-to-center segments so every engine is compared on equal terms.
`againstFlow` is the share of parent→child edges not pointing in the layout's direction.

| layout | edges | crossings | overlaps | bounds (layout units) | widest row | againstFlow | label px |
|---|---|---|---|---|---|---|---|
| **shipped grid WebP** | portal | **166,098** | 0 | 3572×2004 | 64 | 0.067 | 5.91 |
| **shipped level-row SVG** | portal | **125,938** | 0 | 56712×1048 | 394 | 0.048 | **0.37** |
| level-rows | structural | 108,034 | 0 | 56712×1048 | 394 | 0 | 0.37 |
| cytoscape grid | structural | 13,739 | 0 | 3572×2004 | 64 | 0.666 | 5.91 |
| cytoscape breadthfirst | structural | 0 | 0 | 33860×974 | 394 | 0 | 0.62 |
| ELK mrtree | structural | 0 | 0 | 98422×460 | 394 | 0 | 0.21 |
| ELK layered | structural | 0 | 0 | 101701×3574 | 394 | 0 | 0.21 |
| Graphviz dot (TB) | structural | 0 | 0 | 118103×654 | 394 | 0 | 0.20 |
| Graphviz dot (LR) | structural | 0 | 0 | 1968×34859 | 6 | 0 | 0.37 |
| Graphviz twopi | structural | 34,243 | 0 | 7708×4574 | 6 | n/a | 2.83 |

Hypothesis check (from the plan): "grid crossings in the thousands, min font under 4 px".
**Crossings were far worse (166k); font was 5.9 px for the grid and 0.37 px for the SVG.** The
grid's crossing count also depends on element order: with the envelope's pre-order it drops to
13.7k, so even node ordering was costing readability.

## View budget sweep (Graphviz dot, 2400×4800 raster per view)

Budget = visual weight per view (agent box 1, leaf table 1 + ⌊n/12⌋). Every row: coverage
2,277/2,277, every view reconciles, 0 crossings, 0 overlaps.

| budget | dir | views | worst label px | views < 8 px |
|---|---|---|---|---|
| 40 | TB | 96 | 3.45 | 2 |
| 40 | LR | 96 | 14.88 | 0 |
| 60 | TB | 79 | 3.45 | 2 |
| 60 | LR | 79 | 12.44 | 0 |
| 90 | TB | 45 | 4.30 | 3 |
| 90 | LR | 45 | 11.02 | 0 |
| 140 | TB | 24 | 3.90 | 4 |
| 140 | LR | **24** | **11.14** | **0** |

**Chosen default: budget 140, left-to-right** — fewest views with no view under 8 px. Left-to-right
wins at every budget because siblings stack vertically, so a 250-child fan-out becomes a tall
column instead of a 250-wide row. Measured on the rendered WebPs (legend and title included) the
worst view is **12.49 px** (after the judge-driven label changes below).

## What ships

- `lib/f402_agent_tree.ts` — envelope-structural tree, subtree sizes, overflow owners, divergence.
- `lib/f402_agent_graph_metrics.ts` — crossings, overlaps, widest row, flow, effective label px.
- `lib/f402_agent_graph_layouts.ts` — adapters for every engine in the table above.
- `lib/f402_agent_graph_dot.ts` — DOT emitter (Okabe–Ito branch palette, log-size boxes,
  `+N below` double border, orange overflow border, leaf tables, legend) and the Graphviz runner.
- `lib/f402_agent_graph_views.ts` — best-first budgeted views; every agent drawn in at least one view.
- Viewer routes: `/views` (index), `/views/<file>` (cached SVG/WebP), `/agent/<id>` (upline chain,
  children with subtree sizes, overflow, portal-parent disagreement, the view that draws it),
  `/interactive` (ELK mrtree, click-through to agent pages). All return 503 + `no-store` when the
  manifest says views do not match the envelope. Nothing renders per request.
- `/graph.webp` — still WebView → `Bun.Image`, now ELK on the budgeted overview (72,882 bytes,
  byte-identical across rebuilds) instead of a 2,277-node grid.

## Gate (strict verify)

Thresholds live in `AGENT_GRAPH_READABILITY_THRESHOLDS` (`lib/f402_agent_graph_artifacts.ts`):
worst label ≥ **9 px**, crossings ≤ **0**, overlaps ≤ **0** — provisional, set from this baseline.
Strict verify also requires full coverage, reconciliation (shown + `+N` badges = subtree, per view),
overflow markers = `skippedOverflowCount`, every view WebP on disk, the index envelope SHA matching
the manifest, and the SQLite recursive CTE agreeing with the envelope tree on per-root sizes.

Proven cycle: `graph:agent --force` → `/views`, `/agent/*`, `/graph.webp` all 503 `no-store`,
strict verify 15/20 → `graph:agent:views` + `graph:agent:image` → **31/31**.

## Outside judges

Questions and ground truth: `bun run graph:agent:judge -- --questions`; score any answer set with
`--score answers.json`. Ground truth is computed from the envelope tree, not from the drawings.

| q | question | ground truth |
|---|---|---|
| q1 | Level-2 agent with the largest downline | L2-A |
| q2 | Direct upline of L5-B | L4-B |
| q3 | Agent owning the most overflow agents | L12-C |
| q4 | Agents in L8-A's subtree (incl. self) | 225 |
| q5 | Upline chain of L6-B | L1-A > L2-A > L3-A > L4-B > L5-C |

### Blind vision-model judge

A separate model (GPT-5.6 Sol), allowed to open only the PNGs in one folder — no code, data, or
shell — answered the five questions and was told to say `UNREADABLE` rather than guess.

| round | images | score | wrong answers |
|---|---|---|---|
| before | shipped grid raster (1 image) | **0/5** | all `UNREADABLE`: "labels and relationships were not legible" |
| after, round 1 | overview + 23 views + capture (25) | **2/5** | q2 the right login with its last character dropped, q4 `228`, q5 a wrong chain through another level-2 branch |
| after, round 2 | same views after the two fixes below (25) | **5/5** | none |

The round-1 misses were drawing defects, not judge noise. All three answers existed only in the
dense overview: a detail view started at its focus agent with no upline, and the `L8 · 225` line
did not say what 225 counted. The fixes: every detail view's title now carries
`upline: L1-A > … > <focus>`, and boxes read `L8 · 225 agents` (legend: "subtree incl.
itself"). Worst label after the fix: 12.49 px; crossings and overlaps still 0.

Caveats: round 2 used the same five questions that motivated the fix, and its prompt described
the new `N agents` label; a held-out question set would be a stronger test. Answers live in
`/tmp/agv/judge/answers/` (scratch); rescore with `graph:agent:judge -- --score <file>`.

### Portal spot-check (pending: operator with manager UI)

Compare level and upline in the manager UI with `/agent/<id>`. The two divergent agents are the
decisive cases: the UI settles which parent is right.

| agent | level | envelope upline | portal-parser upline | UI says | match |
|---|---|---|---|---|---|
| L6-C | 6 | L5-D (L5) | L4-C (L4) | | |
| L12-A | 12 | L11-A (L11) | L12-B (L12) | | |
| L5-B | 5 | L4-B (L4) | L4-B (L4) | | |
| L6-B | 6 | L5-C (L5) | L4-B (L4) | | |
| L12-C | 12 | L11-B (L11) | L12-E (L12) | | |

Four of five disagree, so this sample is decisive either way. The earlier spot-check sheet read
parents from SQLite: its level-6 rows (L6-C → L4-C, and L6-D → a level-4 agent whose ID differs
from its login; envelope says L5-D and L5-E) showed portal-parser parents, while its level-12 rows
(L12-F, L12-G) happen to agree. The sheet above names agents by login, which is what the manager
UI shows.

Agent names in this document are pseudonyms of the form `L<level>-<letter>`. The key to real
logins is `scratch/agent-graph-readability.pseudonyms.json`, which is gitignored.

### Operator timed task test (pending: operator)

Same five questions. Round 1: only the old grid raster. Round 2: `/views` and `/agent/<id>`.
Record answers plus `"seconds"` per round as JSON and score each with `graph:agent:judge --score`.

## Decisions left open

- Thresholds (9 px / 0 / 0 are provisional), portal sample, operator identity, judge model.
- Whether SQLite `parent_id` should switch to envelope nesting (it would change CLI and manager-boot
  output for 319 agents), or stay portal-faithful with the divergence surfaced as it is now.
- Whether to compress single-child spines (`L2-A → L3-A → L4-B`).
- Commit boundary: this doc and the code are repo material; `scratch/` artifacts stay ignored.
