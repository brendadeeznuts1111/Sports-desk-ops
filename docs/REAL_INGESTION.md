# Real Ingestion — Polymarket + Fantasy402 (Phase 4)

Status: **partially implemented**. Polymarket positions are live over **Data API v2** (`--live`),
F402 has a session cache and a read-only `getBetTicker` probe (`--live-f402`), and pending-bet row
mapping is still fixture. This page states exactly what is verified.

## 1. Why

`docs/graph-live-feed.json` starts as a deterministic fixture: 39 configured wallet rows, 14
synthetic pending bets and a static $702,700 figure. With `--live`, the 23 valid wallet rows are
replaced by observed Polymarket positions; the 16 placeholder addresses are quarantined and
`pendingBets` stays fixture until its mapping is captured. Operators read the feed as telemetry, so
provenance is per wallet and a failure never silently looks live.

## 2. Sources and evidence level

| Source               | Endpoint                                                                                         | Auth                 | Evidence                                                                                                                                            |
| :------------------- | :----------------------------------------------------------------------------------------------- | :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| Polymarket positions | `GET https://data-api.polymarket.com/v2/positions?user=<0x>&limit=500` (then `&cursor=<cursor>`) | none                 | **Live-verified** 2026-11-04: HTTP 200, `{data,pagination}` envelope, 223 rows in one page for `0x26cf…c612`, 72 `OPEN` / 151 `REDEEMABLE`, ~0.45 s |
| Polymarket CLOB WSS  | `wss://ws-subscriptions-clob.polymarket.com/ws/...`                                              | none                 | Not implemented here; see the shadow-stream runbooks                                                                                                |
| F402 `getPending`    | `POST /cloud/api/Manager/getPending`                                                             | session cookie / JWT | **Tier C** — request and response uncaptured; content type disputed                                                                                 |
| F402 `getBetTicker`  | `POST /cloud/api/Manager/getBetTicker`                                                           | session cookie / JWT | **Tier A** capture exists (2026-10-31)                                                                                                              |

F402 auth is not a password grant. `scripts/evidence_capture.ts` logs in through a headless
`Bun.WebView`, reads HttpOnly cookies via CDP, and replays them in-process. A 60 s daemon cannot
launch a WebView per tick, so real F402 ingestion requires a **session cache** (below) and is not
shipped yet.

### 2.1 Data API v1 is retired (observed 2026-11-04)

`GET https://data-api.polymarket.com/positions?user=<0x>&limit=3` now answers **HTTP 410** with:

```json
{
  "error": "Data API v1 has been retired",
  "migration": "https://data-api.polymarket.com/v2/",
  "docs": "https://docs.polymarket.com/api-reference/data-api/overview"
}
```

Measured 2026-11-04T11:16:35Z from this checkout. `lib/polymarket_ingest.ts` therefore requests
only `/v2/positions` and rejects a bare-array body (`unexpected body (…)`): there is **no v1
fallback** anywhere in the poll path. The machine contract is
`https://data-api.polymarket.com/v2/openapi.json` (`PositionsPage`/`Position` schemas, fetched
2026-11-04).

## 3. Feed contract changes

Top-level:

```jsonc
{
  "dataMode": "LIVE" | "PARTIAL" | "FIXTURE",
  "provenance": {
    "polymarket": {
      "source": "https://data-api.polymarket.com/v2/positions",
      "walletsRequested": 39, "walletsOk": 23, "walletsFailed": 16,
      "walletsStale": 0, "walletsInvalid": 16,
      "fetchedAtIso": "…", "durationMs": 1513,
      "truncatedWallets": []
    },
    "f402": { "source": "fixture", "reason": "no session cache" }
  }
}
```

Per wallet, additive fields (existing keys stay):

```jsonc
{
  "dataSource": "LIVE" | "STALE" | "FIXTURE",
  "positionsValueUsd": 3235.12,
  "openPnlUsd": -5348.77,
  "fetchedAtIso": "…",
  "staleSinceIso": "…",      // only when dataSource = STALE
  "openVolumeUsd": 8629,     // cost basis: sum entry_cost_usdc over OPEN rows (rounded)
  "openLegsCount": 72,       // rows whose own status is exactly OPEN
  "openBetsSummary": "…"     // top 3 OPEN rows by current_value
}
```

`dataMode` is `PARTIAL` whenever any plane is live but pending bets are still fixture. `LIVE` is
reserved for the point where every wallet is fresh **and** F402 pending rows are mapped; that is not
reachable yet. `FIXTURE` means live ingest is off.

**Open-leg definition (v2 choice).** The v2 `status` query defaults to `OPEN`, which is the
**superset** arm: it also returns settled-but-unredeemed winners whose own row `status` echo is
`REDEEMABLE`. The feed keeps its historical definition — `openLegsCount` counts rows with
`status === "OPEN"` only — so a settled winner is not an open leg. `openPositionsCount` stays the
total row count. `openVolumeUsd` is the **fee-exclusive** cost basis (sum `entry_cost_usdc`; v2 also
serves gross `total_cost_usdc`, which the feed does not use), `positionsValueUsd` is the current mark
(sum `current_value`), and `openPnlUsd` is sum `total_pnl` (`realized_pnl + unrealized_pnl`), rounded
to cents per wallet. `totalOpenExposureUsd` is the sum of current position value, **not** defined
liability. `wssIngestion: "not_ingested"` and `wsStreamSlaMsFixture: 345` make the unmeasured WSS
claim explicit; `activeSyndicateWalletsCount` is the live-wallet count and
`configuredWalletsCount` stays 39.

## 3.1 Wire → feed mapping

| Source shape                                    | Canonical mapper                                                                                                                                               | Feed / UI output                                                                            | Status                                                    |
| :---------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ | :-------------------------------------------------------- |
| F402 `RawPendingLegRow` (cents, UTC-5, per-leg) | `reconstructParentPendingTickets` (`simulate_bettor_churn_suite.ts`) → `ReconstructedTicket` (`ticketId`, `riskCents`, `winCents`, padded id, `is_live_wager`) | `pendingBets[].ticketId/riskUsd/toWinUsd`                                                   | **Gap** — no adapter; feed rows are hand-authored         |
| F402 report leg (`AdjSpread`/`AdjTotalPoints`)  | `mapF402ReportLeg` + `computeEffectiveLineHundredths` (`combo_identity.ts`)                                                                                    | Mode 7 `lineHundredths`                                                                     | Implemented                                               |
| F402 `RawBetTickerTick` (cents, UTC-5)          | `parseF402TickerRow` (`lib/f402_ingest.ts`)                                                                                                                    | `liveTicks[]` identity/timing preview (no money)                                            | Implemented preview; full money mapping needs units proof |
| Polymarket position (v2 snake_case)             | `parsePolymarketPosition` → `aggregatePositions` (`lib/polymarket_ingest.ts`)                                                                                  | `walletProfiles[].openVolumeUsd/openLegsCount/positionsValueUsd/openPnlUsd/openBetsSummary` | Implemented                                               |
| GSLive account                                  | `formatGsLivePlayerToken` / `formatGsLivePartnerUserId`                                                                                                        | report `text=player_<LOGIN>`; bet-history `partnerUserId=<LOGIN>`                           | Implemented, documented in `report-surfaces.md`           |
| 4-part identity                                 | `gslive_manager_watchlist.ts` tuple                                                                                                                            | `customerLogin + agentId + gsLivePlayerId + proxyWallet`                                    | Implemented, runbook §2.6                                 |

v2 row fields consumed (all `*_usdc` values are USD; bare `current_size`/`total_size` are outcome
shares):

| v2 wire field                                 | `PolymarketPosition`                     | Feed meaning                                       |
| :-------------------------------------------- | :--------------------------------------- | :------------------------------------------------- |
| `token_id`                                    | `asset`                                  | outcome token id                                   |
| `condition_id`                                | `conditionId`                            | on-chain condition id                              |
| `current_size`                                | `size`                                   | current holding, shares                            |
| `avg_price`                                   | `avgPrice`                               | weighted-average entry price per share             |
| `entry_cost_usdc`                             | `initialValue`                           | fee-exclusive basis → `openVolumeUsd` sum          |
| `current_value`                               | `currentValue`                           | mark → `positionsValueUsd` sum                     |
| `total_pnl` (`realized_pnl`+`unrealized_pnl`) | `cashPnl` / `totalPnlUsd`                | → `openPnlUsd` sum                                 |
| `unrealized_pnl`                              | `unrealizedPnlUsd`                       | additive `openUnrealizedPnlUsd`                    |
| `realized_pnl`                                | `realizedPnlUsd`                         | disclosure                                         |
| `current_price`                               | `curPrice`                               | live mark per share                                |
| `entry_fees_usdc`                             | `entryFeesUsdc`                          | disclosure only                                    |
| `total_cost_usdc`                             | `totalCostUsdc`                          | gross basis (`entry_cost_usdc + entry_fees_usdc`)  |
| `status`                                      | `status`                                 | `OPEN` eligibility; `redeemable` = `REDEEMABLE`    |
| `redeemable`                                  | `redeemable`                             | agrees with `status === "REDEEMABLE"` on live rows |
| `title` / `slug` / `outcome` / `end_date`     | `title` / `slug` / `outcome` / `endDate` | summary, links                                     |
| `event_id`                                    | `eventId`                                | Gamma event id                                     |

`redeemable` is true when the row's `status` is `REDEEMABLE` or the wire's own `redeemable` boolean
says so; the two agreed on all 151 live `REDEEMABLE` rows (2026-11-04). `current_size` is the
**current** holding; v2's `total_size` is lifetime bought shares and is not used. A missing/null
numeric maps to `0` for the sums, is listed in that row's `missingFields`, and rows that had one are
counted in `openRowsWithMissingNumerics` — a zero is never silently presented as a measured value.
`end_date: "1970-01-01"` is the contract's "no date" sentinel; the feed keeps it as a string rather
than inventing a null.

Timestamps: wire rows are UTC-5 (`InsertDateTime`), the feed uses UTC ISO, and desk-day windows use
`America/Chicago` via `resolveDeskDateYmd` / `computeDeskDayStartEpochSeconds`. Money: wire `Risk` /
`ToWin` are **cents**, the feed publishes **USD**; never mix them in one calculation.

## 4. Poll behavior

- 39 wallets, concurrency **6**, per-request timeout **10 s**, one retry on `429`/`5xx` after
  `Retry-After` when the header parses, else 250 ms; every retry wait is clamped to **5 s**
  (`maxRetryAfterMs`) so a large header cannot stall the tick.
- Pagination is **cursor-only** (v2): the first request sends `limit=500`; each following request
  sends `cursor=<next_cursor>` with the **same** `user` anchor and no `limit`/`offset` (the route
  rejects `offset` with a 400; `limit` applies to the first page only). `has_more` is exact and
  `next_cursor` is `null` on the last page; the walk stops on either signal.
- The walk is bounded by `maxPages` (default **3**, so ≤1500 rows). If another page still exists
  when the bound is hit, the wallet is reported in `truncatedWallets` rather than silently
  under-counted.
- State cache: `scratch/graph-feed-state.json` (gitignored). On failure, the last good positions are
  reused and marked `dataSource: "STALE"` with `staleSinceIso`; the feed never downgrades to synthetic
  numbers for a wallet that was previously live.
- Cache writes are temp-file + rename; no secrets, only public positions.

## 5. Failure semantics

| Condition                                    | Feed result                                                       |
| :------------------------------------------- | :---------------------------------------------------------------- |
| HTTP 200, valid `{data,pagination}` envelope | `dataSource: "LIVE"`                                              |
| HTTP 200, `data: null` / `data: []`          | `LIVE` with 0 legs (documented miss, never an error)              |
| Timeout / network / 5xx after retry          | cached row → `STALE`; no cache → `FIXTURE` + `lastError`          |
| 429                                          | retry once after `Retry-After` (≤5 s), then same as above         |
| 400 / 410                                    | failure surfaces `HTTP <status>: <body error>`; no v1 fallback    |
| Bare array or missing `pagination`           | failure; `lastError` is `unexpected body (…)` (retired v1 shape)  |
| Malformed position rows                      | row skipped and counted in `rejectedRows`; wallet counts the rest |

The poller exits 0 on partial failure (a single wallet outage must not stop the feed) but logs a
one-line summary: `ok=23 failed=16 stale=0 truncated=0`.

## 6. Security

- No credentials in the feed, logs, or cache. The F402 cookie, when added, lives in a 0600 file and is
  never echoed; only `cookieNames` may be logged.
- Polymarket requests are public and carry no identity.
- The live path is opt-in: `--live` or `SPORTSDESK_LIVE_INGEST=1`. CI and tests run fixtures only.

## 7. Rollout

1. **4a (shipped):** `--live` fetches Polymarket positions over Data API v2; wallet aggregates and
   summaries become observed; pending bets and F402 remain fixture and are labelled.
2. **4b (shipped as a preview):** F402 session cache — one WebView login (`F402_LIVE_LOGIN=1`),
   cookie file `0600` at `~/.cache/sportsdesk/f402-session.json` (override `F402_SESSION_FILE`),
   TTL 30 min (`F402_SESSION_TTL_MIN`), refresh once on 401. `getBetTicker` (tier A) rows are
   normalized into `liveTicks[]` (login, agent, writer, wager number, description, raw timestamp)
   and shown in the portal's Pending Bets tab. Money columns are withheld until their units are
   captured; `pendingBets` remains fixture and `mapped: false` is explicit. `getPending` stays out
   until a response is captured (tier C today).
3. **4c:** CLOB WSS stream replaces the 60 s positions poll for latency-sensitive rows.
4. Canary: run `--live` for one poll, diff wallet counts against the fixture, confirm no `NaN`/`null`
   leaks, then enable `SPORTSDESK_LIVE_INGEST=1` in the daemon.

### F402 command surface

```bash
# read-only probe with a cached session (login only if the cache is missing/expired)
F402_LIVE_LOGIN=1 ./bin/dx poll --live-f402

# both planes in one poll
./bin/dx poll --live --live-f402

# continuous daemon
SPORTSDESK_LIVE_INGEST=1 SPORTSDESK_LIVE_F402=1 ./bin/dx watch
```

`F402_OFFLINE_ONLY=1` disables the probe. The cache is refused when group/world-readable, expired,
or malformed; logs list cookie names only.

### Observed: Data API v2 probe (2026-11-04T11:16:36Z)

Direct `GET /v2/positions?user=0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612&limit=500`: HTTP 200,
one page (`has_more: false`, `next_cursor: null`), **223 rows** in ~0.45 s: **72 `OPEN`** and
**151 `REDEEMABLE`**; all 151 carried `redeemable: true`. Over the 72 `OPEN` rows: current value
**$3,236.22**, fee-exclusive basis **$8,628.69** (gross `total_cost_usdc` $8,662.43), total PnL
**−$5,347.66** (realized +$44.81, unrealized −$5,392.47). The same book was worth $3,235.12 with
−$5,348.77 PnL in the poll below, five minutes later; that ~$1 move is live re-pricing, not a
mapping change.

### Observed: first v2 live poll (2026-11-04T11:21:27Z)

`bun scripts/graph_feed_poller_daemon.ts --once --live`: **39 requested, 23 ok, 16 failed, 0 stale,
0 truncated** in **1513 ms**. All 16 failures are `invalid address` — the fixture wallet table
contains short/placeholder addresses such as `0x9cD44e12A8b7F30192c44d8E11a08B3e7` (truncated) and
`0x3af8…0000…1cfa` (synthetic). Result: `dataMode: "PARTIAL"`, 23 wallet rows `LIVE` and 16
`FIXTURE`; **94 open legs**, **$64,479** current value, **$69,564** cost basis and **−$5,040.45**
open PnL across the 23 live wallets; `docs/graph-live-feed.json` (and the gitignored
`dist/graph-live-feed.json`) was **181,630 bytes at that run**. Replace or remove the placeholders
before treating the totals as complete.

### Observed: feed refresh with the local backtest inputs (2026-11-04T11:44:39Z)

`bun scripts/graph_feed_poller_daemon.ts --once --live --no-backtest-artifact` run from the main
checkout, which carries the gitignored `enriched_customers_full.json` and
`sportsdesk_downline_data.json`. Same live shape as the 11:21 poll — **39 requested, 23 ok, 16
invalid, 0 stale, 0 truncated** in 1,015 ms, `dataMode: "PARTIAL"`, 23 `LIVE` + 16 `FIXTURE` wallet
rows, **94 open legs**, **$64,139.40** current value, **$69,613** cost basis and **−$5,429.24** open
PnL across the live wallets; feed **217,518 bytes**.

The difference from 11:21 is the backtest section: that refresh ran where the two inputs were
absent, so `backtest4Wk.dataBasis` fell back to `{snapshot, sampledTickets: 0}`. Regenerated here it
is `{downline-meta, sampledTickets: 1100, sampledWindowIso:
["2026-10-26T10:30:00Z","2026-10-27T21:15:00Z"]}` with 49 leaderboard rows — content-identical to
`docs/backtest-4wk-cfb-nba.json` apart from `generatedAt*`, which the flag deliberately leaves
untouched. Do not regenerate the feed outside the main checkout: the fallback silently drops the
sampled evidence.

### Observed: fixture mode still works (2026-11-04T11:21:21Z)

`bun scripts/graph_feed_poller_daemon.ts --once` without `--live`: `dataMode: "FIXTURE"`, 39
`FIXTURE` wallet rows, 222 legs / $702,700, feed 182,071 bytes. No network request is made.

### Historical: first v1 live run (2026-10-31, endpoint since retired)

`--live` fetched 39 addresses in 1.24 s: **23 live, 16 failed**. All 16 failures were
`invalid address`. At that moment the 23 live wallets held 91 open legs and $205,332 current value.
That run used Data API v1 (`GET /positions`, flat array, offset pagination), which now answers
HTTP 410 — it is kept only as history.

## 8. Non-goals

- No mutation calls (`updateByColumn`, `vigSetupInsert`) from the poller.
- No scraping of the GSLive SPA; only the public positions API is ingested.
- No automatic account enforcement based on live values.
