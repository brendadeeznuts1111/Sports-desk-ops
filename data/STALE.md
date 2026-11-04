# data/ — snapshot status

**As of 2026-11-04 every artifact in this directory is a stale snapshot, not live state.**
The live paths are the R2 gateway (`https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev`), the
`/api/live-bets` gateway API, and the webview daemon's bridge rollups. Anything in here whose
freshness matters should be re-pulled from R2 instead of read from this tree.

`[STALE]` labels below mean the snapshot predates the current R2 state by the listed margin.
Ages are computed against the R2 pointer timestamps observed 2026-11-04 ~06:00 UTC.

## Superseded by R2 (read these instead)

| Local artifact                                                     | Source / snapshot date                                                              | R2 pointer (fresh)                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/graded-wagers-export-2026-11-01.json`                        | xlsx export, `observedAt` 2026-11-01T17:24                                          | `gslive-tally/2026-11-03/rollup.json` (generatedAt 2026-11-03T18:29Z; 22,611 tickets, 24,778 legs, 10,097 bps hold) and `wagers-by-state/latest.json` (generatedAt 2026-11-04T03:21Z; span 162h ending 2026-11-03T16:28Z) |
| `data/live-wagers.json`                                            | `paste:clipboard-ticker`, `partial: true`, **0 rows** (Nov 3 18:17)                 | `f402-bet-ticker/latest.json` (deskDate 2026-11-03, generatedAt 2026-11-04T03:01Z; 4,185 rows / 3,196 tickets / 737 alert twins)                                                                                          |
| `data/live-bets.json`                                              | capture `Report/Pending` @2026-11-01T02:22Z                                         | no public pointer — `f402-pending/latest.json` is **404 as of 2026-11-04**; live liability today is the 3b bridge output (state at `scratch/bridge-rollup-state.json` / WS hub), regenerable via the pending poller       |
| `data/contests.json`                                               | `markup:stdin` @2026-11-01T22:45Z                                                   | no R2 equivalent — re-extract from the manager's Contests module                                                                                                                                                          |
| `data/scoreboard.json` / `data/game-admin-board.json`              | operator paste, Nov 1                                                               | no R2 equivalent — manual snapshots, re-paste to refresh                                                                                                                                                                  |
| `data/agent-index.json` / `data/agent-tree.json`                   | extracts of `Scratch/raw-f402-list-agents.json` / `Scratch/agent-graph.json`, Nov 1 | no R2 equivalent — historical hierarchy snapshot                                                                                                                                                                          |
| `data/analysis-cp-baseball-2026-11-01.json`                        | Analysis paste (customer performance), Nov 1                                        | no R2 equivalent — re-capture                                                                                                                                                                                             |
| `data/customer-profiles.json` _(untracked)_                        | derived from `enriched_customers_full.json` + `data/agent-tree.json`, Nov 2         | sits atop the Nov 1 book — treat as a derived snapshot of a stale snapshot                                                                                                                                                |
| `data/sportsdesk_unified_baseline_v54.dodbin` _(untracked, 88 MB)_ | Nov 3 01:30                                                                         | no R2 equivalent — MLB grade baseline, snapshot only                                                                                                                                                                      |
| `enriched_customers_full.json` _(untracked, `.gitignore`)_         | Nov 1                                                                               | 220 customers / 1,032 ticket rows; the sharp-vs-recreational work should read the R2 corpus, not this book                                                                                                                |
| `sportsdesk_downline_data.json` _(untracked, Oct 28)_              | ~1 week old                                                                         | 668 sub-agents; toxicity/hold/sharp counts from Oct 28 — treat as a floor, not current                                                                                                                                    |

## What is actually fresh (as of 2026-11-04 ~06:00 UTC)

- `f402-bet-ticker/latest.json` — deskDate 2026-11-03, `generatedAt` 2026-11-04T03:01Z, `watermark` 767375141
- `f402-weblog/latest.json` → `f402-weblog/2026-11-02/rollup.json` — 523,632 rows, window through 2026-11-02, `generatedAt` 2026-11-04T05:59Z, gates WL-01..04 all pass
- `gslive-tally/2026-11-03/rollup.json` — `generatedAt` 2026-11-03T18:29Z
- `wagers-by-state/latest.json` — schemaVersion 2, `sourceKind: bet-report-json`, `generatedAt` 2026-11-04T03:21Z (the graded aggregate is built from an offline bet-report CSV, so its lineage is worth noting, not just its timestamp)

## Known gaps / things not verified

- `f402-pending/latest.json` returned 404 on 2026-11-04 — either the key changed or the pending rollup is not published publicly; do not assume `f402-pending/latest.json` exists.
- The tracked JSONs are also **historical evidence**: tests pin shapes against some of them. Do not rewrite their contents to "un-stale" them — update this file or `regenerate` the artifact instead.
- Untracked files are listed for completeness; they are not in git and won't appear in a fresh checkout.

_Verified 2026-11-04. R2 pointer timestamps are the source of truth over file mtimes or git commit dates._
