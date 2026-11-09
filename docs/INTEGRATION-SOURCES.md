# Integration sources — upstreams behind local artifacts

Companion to [`Sources.txt`](./Sources.txt): **Sources.txt** is which files the desk reads and how to refresh them; **this doc** is where those files come from, what credentials each path needs, and what breaks when an upstream dies.

Last R2 HEAD probe (2026-11-09 UTC): see [§ Public R2 bucket](#public-r2-bucket-sportsdesk-ops-reports).

---

## Sources.txt → integration map

| Artifact (Sources.txt) | Upstream | Auth | Job / entrypoint | Failure mode if upstream dies |
|------------------------|----------|------|------------------|-------------------------------|
| `data/live-wagers.json` | F402 `POST /cloud/api/Manager/getBetTicker` | F402 session / bearer (`com.bookdeskops.sportsdesk`) | `positions:cron`, `bridge3a`, `serve` cron | Ticker KPI null or stale; `live:` provenance ages |
| `data/live-bets.json` | F402 `POST /cloud/api/Report/Pending` | Same | `positions:cron`, `bridge3b`, `serve` cron | Pending KPI stale; desk shows age not zero |
| `data/agent-tree.json` | F402 downline tree build | `F402_BEARER_TOKEN` / agent id | `build:agent-tree`, hourly cron in `serve` | Agents block stale; scratch path → fixture chip |
| `data/customer-profiles.json` | `enriched_customers_full.json` rollup | None (local fixture) | `customers:profiles` | Fixture book; always `basis: fixture` |
| `docs/graph-live-feed.json` | Polymarket gamma, Kalshi, GS liveboard, local merges | Venue-specific keys for *live* reads | `graph_feed_poller_daemon`, `graph:watch` | Market feed stale; `wssIngestion: not_ingested` until real WSS |
| R2 `f402-bet-ticker/latest.json` | Same as ticker artifact | Publish: R2 S3 credentials | `bridge3a` rollup | Public mirror stale; CI alerter (`r2_staleness`) |
| R2 `gslive-tally/latest.json` | GSLive Partner 118 bet report | `GSID` in keychain | `bridge3c:rollup` | tally mirror stale |
| R2 `f402-weblog/latest.json` | F402 weblog rollup | F402 token + local jsonl corpus | hourly weblog rollup (`:07`) | Weblog pointer stale |
| R2 `wagers-by-state/latest.json` | Wager histogram rollup | bridge pipeline | bridge jobs | Liability histogram stale |

F402 REST inventory (wire paths, forensic modes): `lib/hostname_surface_audit.ts`.

---

## Public R2 bucket (`sportsdesk-ops-reports`)

Base: `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev` (`R2_PUBLIC_BASE` in `lib/r2_staleness.ts`).

| Key prefix | Contents | Typical SLA (alerter v1) |
|------------|----------|---------------------------|
| `f402-bet-ticker/` | Streamed bet ticker rollup | 60m |
| `gslive-tally/` | Partner 118 in-play tick tallies | 60m |
| `f402-weblog/` | Ingested IP session audit rollups | 90m |
| `wagers-by-state/` | Geographic liability aggregation | 60m |

**Exposure note:** `pub-*.r2.dev` is unauthenticated **read**. Ticker/tally mirrors are intentional public ops feeds. **`f402-weblog`** and **`wagers-by-state`** carry audit/liability fields — confirm with ops that public read is deliberate (WAF, bucket policy, or “public is OK for desk graph only”). Do not assume parity with ticker exposure.

**Diagnostic snapshot (2026-11-09):**

| Key | HTTP | Last-Modified (GMT) | Interpretation |
|-----|------|---------------------|----------------|
| `f402-bet-ticker/latest.json` | 200 | 2026-11-09 03:45 | Publishing recently |
| `gslive-tally/latest.json` | 200 | 2026-11-04 04:37 | Stale — bridge3c not refreshing or post-publish failure |
| `f402-weblog/latest.json` | 200 | 2026-11-04 05:59 | Stale — weblog rollup not refreshing |
| `wagers-by-state/latest.json` | 200 | 2026-11-04 03:21 | Stale |

---

## Cloudflare Access surfaces (BookDeskOps)

| Host | Role | Local `fetch` in repo? |
|------|------|-------------------------|
| `desk.bookdeskops.com` | Hosted Sports Operations UI (F402 deep links) | **Links only** (`lib/canonical_osc8_links.ts`) — no server `fetch` |
| `app.bookdeskops.com` | CF Access app surface | **No** direct `fetch` in `lib/`, `scripts/`, `services/*.ts` |
| `ops.bookdeskops.com` | CF Access ops surface | **No** direct `fetch` |

Without `CF-Access-Client-Id` / `Secret` or a service token, `fetch()` to these hosts returns an HTML login page (often after a 302). Code expecting JSON must not call them bare — same failure class as “silent wrong JSON”.

Desk F402 traffic uses the **portal host** (`fantasy402.com` / configured replay base), not the CF Access desk subdomains, unless explicitly wired with tokens.

---

## External market APIs (graph / execution — not Book KPI `basis`)

These power graph feeds, quotes, and paper execution — **not** `/api/kpis` `KpiBasis`:

| Family | Base URL | Auth | Used from |
|--------|----------|------|-----------|
| Polymarket gamma | `https://gamma-api.polymarket.com` | Public read for many routes | `lib/polymarket_*`, bridge router |
| Kalshi trade API | `https://api.elections.kalshi.com/trade-api/v2` | API key + PEM in keychain | `lib/kalshi_client.ts`, autobet |
| GSLive | `live.sportswidgets.pro` (see hostname audit) | GSID session | GSLive rollup, weblog |

Graph dashboard static bundle intentionally **does not** embed live Kalshi/Polymarket host strings in shipped JS (fixtures only in tests).

---

## URL family → Book KPI `basis` classification

`KpiBasis` is only `capture` | `paste` | `fixture` (`lib/desk_kpis.ts`). There is no `basis: "live"` on Book KPIs — live portal reads are stamped `capture` with `live:…` or `capture:…` sources.

| Source pattern | Expected `basis` | Classifier | Tested in |
|----------------|------------------|------------|-----------|
| `live:/cloud/api/Manager/getBetTicker@…` | `capture` | `kpiBasisFromSource` | `tests/desk_kpis.test.ts`, `tests/kpi_basis_from_source.test.ts` |
| `live:/cloud/api/Report/Pending@…` | `capture` | same | same |
| `capture:/cloud/api/…@…` | `capture` | same | same |
| `paste:…` | `paste` | same | same |
| `https://pub-….r2.dev/…/latest.json` | `capture` | `kpiBasisFromSource` (R2 mirror) | `tests/kpi_basis_from_source.test.ts` |
| `data/agent-tree.json` | `capture` | `kpiBasisFromSource` + agent graph rule | `desk_kpis` / agent tree tests |
| `scratch/agent-graph.json` | `fixture` | `isFixtureAgentTreeGraphSource` | `desk_kpis.test.ts` |
| `./enriched_customers_full.json` | `fixture` | fixed in `deriveDeskKpis` | `desk_kpis.test.ts` |
| `https://gamma-api.polymarket.com/…` | *N/A Book KPI* | — | fixtures / execution only |
| `https://api.elections.kalshi.com/…` | *N/A Book KPI* | — | fixtures / execution only |
| `https://desk.bookdeskops.com/…` | *N/A Book KPI* | — | OSC-8 links only |

If a non-prefixed HTTPS URL ever appears on a Book artifact without going through `live:`/`capture:`, treat it as a classifier bug — the #74 class.

---

## Related code

- Classifier: `kpiBasisFromSource()` — `lib/desk_kpis.ts`
- UI chip: `lib/sidebar_fixture_provenance.ts`, `dsh-plugin-sidebar/client.js`
- R2 freshness: `lib/r2_staleness.ts`, `scripts/r2_staleness_alerter.ts`
- Bridge schedules: `services/reporting_scheduler_service.ts`
