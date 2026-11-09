# Surface inventory — D/E ledger rows

Companion to [ledger.json](./ledger.json). Two kinds of surface are recorded outside the published
operation list:

- **D — real surface.** The surface exists in code, fixtures or an external deliverable. Most of its
  routes are now published as operations in `docs/openapi.json` (94 paths / 96 operations); the rows
  below say which members still have no spec path of their own.
- **E — documented, not implemented.** The spec publishes an operation that no code in this repo serves.

Every `id` below is the same string as the `surfaces[].id` in the ledger, so the ledger, this inventory and
`docs/EVIDENCE.md` stay in sync.

---

## D-1. `surface.fantasy402-sport-catalog`

Fantasy402 desk navigation catalog: sub-sport lanes plus per-sport period menus. Not in the spec at all.

| Fact                    | Value                                                                                                                                                                                                                                                                                                        | Source                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Sports                  | 19                                                                                                                                                                                                                                                                                                           | `fixture:tests/fixtures/fantasy402-sport-catalog-2026-10-21.json:2-8`    |
| Sub-sports              | 230                                                                                                                                                                                                                                                                                                          | same fixture                                                             |
| Period menus            | 42                                                                                                                                                                                                                                                                                                           | same fixture (`sportPeriodCount`)                                        |
| Desk-link collision ids | 2 — `Arena` → Football + Horse Racing; `NCAA Extra` → Basketball + Hockey                                                                                                                                                                                                                                    | same fixture `collisions`; `catalog/fantasy402_sport_catalog.ts:229-245` |
| Provenance digests      | 4 — `subSportTreeSha256Hex`, `periodMenusSha256Hex`, `collisionRegistrySha256Hex`, `expectedEmptyPathsSha256Hex`. **Contradicted, re-read 2026-11-02:** `CatalogDigestSet`'s fourth digest is `observedCollisionSetSha256Hex`; `expectedEmptyPathsSha256Hex` is computed under `metrics`, not the digest set | `catalog/fantasy402_sport_catalog.ts:133-140,627-676`                    |
| `capturedAt`            | `2026-10-21T16:38:53.513Z`                                                                                                                                                                                                                                                                                   | fixture                                                                  |
| `periodsCapturedAt`     | `2026-10-30T04:59:14.572Z`                                                                                                                                                                                                                                                                                   | fixture                                                                  |
| Structural empties      | stable: Football/Coll Ext, Hockey/NCAA Extra, Horse Racing/Arena, Soccer/France Ligue; volatile: LIVE/MMA Live, LIVE/WNCAA Live                                                                                                                                                                              | `catalog/fantasy402_sport_catalog.ts:57-66`                              |

Why it matters: these are the `link_id` keys scoped ingestion uses. Two codes (`Arena`, `NCAA Extra`) are
shared across sports, which is why `makeDeskLinkId` rewrites them to `<Sport>|<code>` — a collision that
silently breaks ingestion if it is not represented.

**Caveat:** the fixture is the committed SSOT sample, not a raw wire capture. `capturedAt` is
fixture-declared. Validation is real (`validateFantasy402SportCatalog`, `catalog/fantasy402_sport_catalog.ts:448-625`):
declared counts must match computed counts, codes must be unique per sport, periods must number `0..n-1`
with period `0` named `Game`, and the two timestamps must not invert.

**Resolution:** add a catalog section/schema to the docs, citing the fixture (not a capture) and the digest
set.

---

## D-2. `surface.manager-getHistory`

The only upstream Fantasy402 route in this repo with an actual fetch client, and it is missing from the spec.

- Endpoint: `POST {SPORTSDESK_PORTAL_HTTP_BASE}/cloud/api/Manager/getHistory`
  (`lib/fantasy402_settlement_ingest.ts:547-557`).
- Poll semantics: `fetch(url, { method: "POST", proxy: false, signal: AbortSignal.timeout(60_000) })`, **no
  request body**; response must be an array or `{ data: [] }` or the poll throws
  (`lib/fantasy402_settlement_ingest.ts:559-587`).
- Role: settlement-history slice (`lib/fantasy402_wager_universe_scope.ts:22-31`, `ingestionStatus: "wired"`).
- Shape fixture: `tests/fixtures/fantasy402-history-poll.json` — `Login`, `WagerNumber`, `WagerStatus`
  (`S`/`C`), `AcceptedDateTime`, `GameDateTime`, `SettlementDateTime`, `Amount`, `Risk`, `ToWin`.

**Caveat:** the fixture rows are placeholders (`CUST001`, `CUST002`), so it is a shape sample, not a
capture. The request contract (agent scope, date window, auth) is unknown because the poll sends no body —
the spec cannot document this route accurately until a capture exists.

---

## D-3. `surface.manager-getGrading`

Declared "wired" but not implemented at the transport layer.

- Declared: `Manager/getGrading`, slice `settlement_history`, `ingestionStatus: "wired"`
  (`lib/fantasy402_wager_universe_scope.ts:32-38`); `SettlementFeed = "getHistory" | "getGrading"`
  (`lib/fantasy402_settlement_ingest.ts:18`).
- Row type: `RawGradingLegRow` — `CustomerID`, `WagerNumber`, `LegNumber`, `Amount` (cents, customer
  perspective: win > 0, loss < 0, void = 0), `SettlementDateTime`, `Result` (`WIN|LOSS|VOID|PUSH`),
  `Description` (`services/simulate_bettor_churn_suite.ts:94-102`).
- **No fetch exists:** repo-wide the only settlement poll is `pollManagerGetHistory`, which targets
  `getHistory`. `getGrading` is a declared feed with no client.

**Resolution:** either implement the poll and capture it, or stop calling it wired. It is absent from the
spec and should stay out until the transport is real.

---

## D-4. `surface.daemon-dashboard`

- `GET /` and `GET /dashboard` both serve `customer-churn-simulation-dashboard.html` as `text/html`
  (`sportsdesk_webview_server.ts`, the `/` and `/dashboard` arm).
- Every headline figure is derived from a `data/` artifact by `GET /api/kpis` (`lib/desk_kpis.ts`), and
  each card carries its source, observation time, age and stale flag. The retired literals (668 agents,
  9,435 accounts, $2.79M handle, $10.49M hold) traced to no capture.
- The agent-tree dropdown reads `GET /agent-graph.webp`, which serves `scratch/agent-graph.webp` behind
  the same `pii` guard as `/graph`: the raster is a rendering of the same graph, so its node labels are
  logins. Missing → 404 with `bun run graph:agent:image`; older than the graph → 503. The page fetches
  it through `authed()` because an `<img src>` cannot carry the admin token, and the deploy script does
  not copy `scratch/`, so a VPS shows the 404 message rather than a broken image.
- No spec row; the spec documents only `/health`, `/api/watchlist` and the Telegram routes for the daemon.
- These are the operator-facing dashboards; the Scalar docs portal is a separate artifact (`docs/index.html`
  loading `docs/openapi.json`).

## D-5. `surface.daemon-miniapp`

- `GET /miniapp` and `GET /miniapp/` serve `telegram-miniapp-dashboard.html`
  (`sportsdesk_webview_server.ts`, the `/miniapp` arm).
- Served with Telegram-specific CSP `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:`
  and no `X-Frame-Options` (the `baseHeaders` block).
- Absent from the spec.

## D-6. `surface.daemon-telegram-admin-routes`

Real routes, no spec rows:

| Route                               | Behaviour                                             | Source                                            |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `POST /telegram/webhook`            | Validates `x-telegram-bot-api-secret-token`, else 401 | `services/sportsdesk_webview_server.ts:3287-3306` |
| `GET /api/telegram/status`          | Status + schedules + `REPORT_TYPES`                   | `services/sportsdesk_webview_server.ts:3322-3334` |
| `GET /api/telegram/activity?limit=` | Activity log, limit clamped 1–200                     | `services/sportsdesk_webview_server.ts:3349-3360` |
| `POST /api/telegram/webhook`        | `{action:"set"\|"delete"}` webhook management         | `services/sportsdesk_webview_server.ts:3362-3384` |
| `OPTIONS *`                         | 204 preflight with CORS headers                       | `services/sportsdesk_webview_server.ts:1153-1155` |
| `GET /api/test/error`               | Synthetic throw for the error boundary                | `services/sportsdesk_webview_server.ts:1146-1150` |

All `/api/telegram/*` and `/api/watchlist` calls pass through `adminRejection`
(`services/sportsdesk_webview_server.ts:252-271`): constant-time comparison against `SPORTSDESK_ADMIN_TOKEN`,
503 when the token is unset, 401 otherwise.

---

## D-7. `surface.gs-manager-cli`

The GS Buckeye 2 Partner 118 deliverable, extracted at
`/Users/nolarose/code/sportsdesk-ops/scratch/docs-audit/gs-manager-cli/`. It has **6 report kinds** and a
real CLI, but every upstream report contract is `blocked_contract`.

**6 report kinds** (`zip:templates/endpoint-registry.json:8,39,95,151,210,272`;
`zip:contracts/report-surfaces.md:9-16`):

| Report id   | Visible name    | UI route (browser, **not** an HTTP endpoint) | Contract                                                     |
| ----------- | --------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `summary`   | Summary report  | `/manager-tools/#/reports/summary`           | HTTP transport unknown                                       |
| `event`     | Event report    | `/manager-tools/#/reports/events`            | transport unknown                                            |
| `player`    | Player report   | `/manager-tools/#/reports/users`             | transport unknown                                            |
| `open-bet`  | Open bet report | `/manager-tools/#/reports/open-bets`         | transport unknown                                            |
| `bettor`    | Bettor report   | `/manager-tools/#/reports/bettor`            | transport unknown                                            |
| `last-bets` | Last Bets       | `/manager-tools/#/events/bet-history`        | action `getBetReport` observed; transport + response unknown |

**9 `jobs` subcommands** — `add`, `list`, `run`, `logs`, `enable`, `disable`, `remove`, `tick`, `unlock`
(`zip:src/cli.js:13-17`; `zip:templates/endpoint-registry.json:301-320` lists the command surfaces and
marks `notUpstreamEndpoints: true`).

**Other CLI surfaces:** `capabilities`, `report <kind>`, `serve`, `docs`, `cron print`
(`zip:src/cli.js:7-19`).

**Blocked-contract evidence:**

- `zip:README.md:3` — live acquisition intentionally blocked; no GS endpoint/authentication/response contract is verified.
- `zip:templates/contract-verification.md:3` — only Last Bets has an observed action; no transport URL, method, response shape or auth mechanism exists for any report.
- `zip:templates/endpoint-registry.json:281-288` — `url`, `method`, `contentType`, `responseSchema`, `authentication` all `null` for last-bets.
- `zip:contracts/gs-manager.ts:29-30` — no response capture exists; invented response properties prohibited.
- `zip:contracts/api-security-spec.md:29` — keep live acquisition blocked until contract and authorization controls are verified.

The CLI itself is real and tested (6 Node tests: DST bounds, invalid inputs, schedule dedup, blocked live
behaviour, lock exclusion, cron quoting) — the orchestration is implemented, the GS API is not.

---

## E-1. `surface.desk-api-unimplemented`

**9 spec paths / 10 operations** under `/api/desk/*` have no implementation anywhere in the repository:

| #   | Operation                        | Claimed behaviour                                                                    | Implementation |
| --- | -------------------------------- | ------------------------------------------------------------------------------------ | -------------- |
| 1   | `POST /api/desk/auth/session`    | Mint `desk_session_id` cookie (UUIDv7, 8h shift, SameSite=Strict)                    | none           |
| 2   | `DELETE /api/desk/auth/session`  | Revoke session                                                                       | none           |
| 3   | `GET /api/desk/auth/me`          | Inspect operator session                                                             | none           |
| 4   | `POST /api/desk/hitl/approve`    | HMAC-SHA256 `DESK-*` token, constant-time compare, dispatch `Manager/updateByColumn` | none           |
| 5   | `GET /api/desk/hitl/queue`       | List pending tier-2 limit adjustments                                                | none           |
| 6   | `POST /api/desk/hitl/reject`     | Reject queued limit raise                                                            | none           |
| 7   | `POST /api/desk/forensics/audit` | Run modes A/B/C/I, compute MFCS 0–100                                                | none           |
| 8   | `GET /api/desk/forensics/scores` | Empirical Bayes sharp scores (`tau*=0.68`, `N_min=8`)                                | none           |
| 9   | `POST /api/desk/rfq/quote`       | Polymarket/Kalshi RFQ joint-probability quote                                        | none           |
| 10  | `POST /api/desk/rfq/hedge`       | Execute layoff hedge                                                                 | none           |

Why "9 paths / 10 operations": `/api/desk/auth/session` carries both `POST` and `DELETE`.

Evidence of absence:

- `services/sportsdesk_webview_server.ts:1137-3145` is the complete daemon router: `/health`, `/`, `/dashboard`,
  `/miniapp`, `/telegram/webhook`, `/api/telegram/*`, `/api/watchlist`, `/api/telegram/alert|report`, then a
  404 JSON fallback at `services/sportsdesk_webview_server.ts:3480-3488`. No `/api/desk` prefix is matched.
- A repo-wide grep for `/api/desk` in code finds only documentation tests
  (`tests/capture_apply.test.ts:84,96`; re-measured 2026-11-02 — `tests/api_reference.test.ts`, cited here before, no longer mentions `/api/desk`) and the generator that wrote the spec
  (`scripts/enhance_docs.mjs:115,237,249,269,289,301,321`).
- There is no HMAC verifier, no `DESK-*` token codec, no `CookieMap` session store and no HITL queue store
  in either tree.

**Resolution:** implement and capture, or remove from the published contract / mark unimplemented. Do not
present these as callable routes in the docs release.

## D-8. `surface.daemon-live-bets`

- `GET /api/live-bets` and `GET /api/live-bets/summary` derive a scoreboard payload from captured
  `Report/Pending` rows (`services/sportsdesk_webview_server.ts:1356-1460`).
- Amounts stay in integer cents; `Password`, `NameFirst` and `Login` are stripped by name, and
  `buildArtifact()` refuses to write when any survive (`lib/live_bets.ts`).
- Both paths call the same loader and `summarizeGames()` in one request, so the summary cannot
  disagree with the game list.
- `GET /api/f402/get-pending` used to answer the same dataset in a second shape; it now returns
  **410** pointing here.

## D-9. `surface.daemon-agent-tree`

- `GET /api/agent-tree` serves `data/agent-tree.json` joined with per-agent exposure
  (`services/sportsdesk_webview_server.ts:3182-3247`).
- The forest is built from the portal's own `baseHeriarchy` parent pointers
  (`scripts/build_agent_tree.ts`), keyed by canonical `agentLoginKey`.
- A key owned by more than one `AgentID` keeps its node but is flagged `a: true` and never given a
  level; the real capture has one (`BRANDON`, two agents at levels 6 and 10).
- Non-loopback peers must present `SPORTSDESK_ADMIN_TOKEN` (`piiRejection`).
- **`roots` means "no parent in the capture", not "top of the hierarchy".** The portal's sidebar
  renders one root — the account you are logged in as — with four children at `data-level="1"`
  (`tests/fixtures/portal-agent-tree-sidebar-2026-11-01.html`). `listAgenstByAgent` returns a
  _downline_, so the master row does not exist in the response and cannot be a node here: the page
  injects it from the session. Every report call carries it as `agentID`/`agentOwner` while the tree
  does not contain it, and that is correct rather than a lost node.
- The rendered rows confirm the levels and types: `BILLY667`/`RTEST5` are `A` and
  `NOLAWOLF`/`SAINTS2009` are `M` in both the DOM and `data/agent-tree.json`.
- Collapsed nodes ship an empty `<ul class="master-ul hide">`, so the tree is loaded lazily; the
  sidebar is agents-only (`data-players="false"`).

### `l` is the portal's level, not a depth

`?view=hierarchy` folds the parent edges into depth and keeps `l` verbatim as `level`, because the
two do not agree. Measured on the committed 2,276-node tree (2026-11-02):

| edges (parent → child)     | count | reading                                                       |
| -------------------------- | ----- | ------------------------------------------------------------- |
| `l(child) − l(parent) = 1` | 1,951 | level tracks the chain                                        |
| `= 2`                      | 208   | the capture is missing the intermediate level for that branch |
| `= 0`, both at 12          | 110   | the field **saturates** at 12                                 |
| `l` null on one end        | 3     | `BRANDON`, the collision node (documented above)              |

- No node reports `l > 12`, and the 176 nodes at 12 span chain depths 10 to 24 — so the cap is hard
  and everything deeper inherits it (the YASKYY chain is 25 long and reports 12 from `BELLO3`
  onward).
- The `= 2` edges are not a deleted level: 255 nodes report `l = 5` with an `l = 4` parent. They are
  branches whose intermediate agent was not captured, so the child was attached higher up.
- Mismatch is therefore _accumulated_, not wholesale: 14% of edges are anomalous, and error
  compounds along a chain, which leaves 1,753 nodes above `depth + 1`, 62 below and 460 equal. A
  count of "99% stale" describes the accumulation, not the field.
- Depth therefore comes from the edges (`depth`, `rollup.depth`); `l` stays in the payload as
  `level` so the divergence remains visible. Any consumer that indents by `level` renders a flat
  slab wherever the cap bites.

The two mechanisms push in opposite directions, and the composition of a chain decides which wins:

- a **capture skip** (a `+2` edge — an intermediate agent missing from our tree) puts the level
  ahead: `l > depth + 1`;
- **saturation** (a `0` edge at the cap) puts the depth ahead: `depth + 1 > l`.

The arithmetic is exact — `l − (depth + 1) = (#+2 edges) − (#0-at-12 edges)` — for **2,274 of
2,276 nodes**. The two exceptions are `C-BRANDON` and `GRISBY`, whose parent is the collision node
`BRANDON` with no level, so their chain's delta cannot be counted. That is why the split is 1,753
above / 62 below / 460 equal: three regimes of one field, not three defects. `YASKYY` is the
62-regime in the extreme — one skip and fourteen saturations along a 25-node chain, so `l = 12`
against `depth = 24`.

**Consumer rule:** use `depth` for structural display, `level` for portal-level annotation, show
both where they diverge, and treat any count derived from the edges as a **lower bound** — a `+2`
edge means at least one intermediate agent is absent from the capture.

### A second store, because `agents` cannot hold this tree

`lib/f402_sqlite_agents_ingest.ts` already stores a hierarchy in SQLite — an `agents` table keyed by
`agent_id`, fed by the portal envelope, with a recursive depth CTE. `data/agent-tree.json` does not
fit it, measured 2026-11-02:

- `flattenNormalizedHierarchyTree(tree)` returns **0 rows** for this file: the crawler expects nested
  `AgentID`/`Level` rows, the tree is `nodes[login] = { p, l, t }`.
- `agents.level` is `NOT NULL`, and the collision node `BRANDON` deliberately has no level — the
  insert is rejected (`NOT NULL constraint failed: agents.level`).
- The keys differ: `agents` is keyed by portal `AgentID`, the tree by canonical login, and the
  collision is exactly where one login maps to two AgentIDs.

So `lib/hierarchy_store.ts` keeps a parallel `hierarchy_nodes` table keyed by login, with a nullable
`portal_level` and a `level_delta` column that makes the `+1` / `+2` / `0`-at-cap defect queryable
rather than recomputed per reader. `bun run hierarchy:load` builds it from the JSON (idempotent:
2,276 rows, 196 KB) and prints the delta distribution; `subtreeCounts` is the rollup the tree UI
asks for. The descendants CTE uses `UNION`, not `UNION ALL`: the `agents` CTE has no cycle guard and
assumes every root is `level = 1`, which a crawl that re-parents a node could violate.

`lib/f402_manager_hierarchy_ingest.ts` also encodes the cap independently —
`PORTAL_HIERARCHY_PARSER_MAX_LEVEL = 12`, "levels 1–12 only", with level ≥ 13 rows returned in
`skippedOverflow` — so the envelope path _drops_ the nodes the tree file shows at `l = 12`. The two
stores therefore have different membership, and neither is a superset of the other.

**Enrichment: office and store.** The tree cannot say which office or store a node belongs to; the
account-info response can (`Office`, `Store`, `AgentType`, `AgentID`, `SKIN`, `AgentMenuStyle`).
`bun run hierarchy:enrich <dir-or-file>` parses those responses, writes office/store/skin onto the
matching rows, and groups everything by (Office, Store) — the grouping that would explain the four
isolated roots: two roots reporting the same office are siblings above the level the tree models.
It reports unmatched responses instead of inserting them, because a response for an agent the tree
does not know is evidence of a missing node. The only response observed so far is `BILLY666`
(`Office: NOLAROSE`, `Store: PPHINSIDER`, `AgentType: M`, `AgentID: null`), and `BILLY666` is not
in the tree — so the grouping is implemented and **untested against real roots**; four calls, one
per root, would answer it.

**Two independent witnesses say the tree is missing agents.** The customer book's 220 profiles name
29 distinct `agent_id` values; **12 of them are absent from the tree** (`APEX99`, `BIGDAD`,
`CUB22A`, `DAN318`, `KOBE24`, `LAKERS`, `METRO1`, `SHARP66`, `SOUTHSHORE`, `TITAN`, `VEGAS88`,
`VIP777`), and `CUB22A` is also absent from the ticker page — the same node, from two unrelated
sources. That is 41% of the book's agents against the tree's own 9.2% skip rate, so the tree is
demonstrably partial rather than merely gapped at the edges; `bun run customers:profiles` prints the
list, and `bun run ticker:coverage <page>` prints the other.

**Provenance is not recorded, and it matters.** The tree's `source` is `scratch/agent-graph.json` —
a file path, not a session. Its roots are `BILLY667` / `NOLAWOLF` / `RTEST5` / `SAINTS2009`, while
the account behind the 2026-11-02 request captures is `BILLY666` (office `NOLAROSE`), which is not
in the tree at all; `NOLAROSE` is absent too. So the artifact cannot say which login produced it,
and any join against it describes a different downline than those captures. A future refresh should
carry the capturing account — the trimmed `customerID`, never the `AgentID`, which is `null` on a
master account — in `source` or a sibling field.

## D-10. `surface.daemon-scoreboard`

- `GET /api/scoreboard` serves `data/scoreboard.json` (`services/sportsdesk_webview_server.ts:3073-3085`):
  22 games (NFL 12, NHL 5, NBA 4, NCAA 1) transcribed from the manager page.
- The payload carries `source` and `observedAt`. These games are **transcribed, not captured**; the
  pasted logo column was offset by one game, so logos are resolved by team name and verified against
  the CDN, and Utah Mammoth uses `NHL.png` as a marked placeholder.
- `lib/scoreboard.ts` joins wagers to these rows by nickname plus league, order-independently.

## D-11. `surface.daemon-sports-taxonomy`

- `GET /api/sports` returns the portal's 18 categories with counts for the loaded wagers and the
  scoreboard (`services/sportsdesk_webview_server.ts:3045-3070`).
- `All Sports` is the absence of a filter and `LIVE` is a state, so neither is modelled as a category;
  unmapped sports surface as `Other` (`lib/sport_taxonomy.ts`).

## D-12. `surface.daemon-game-admin`

- `GET /api/game-admin` returns exposure per fixture split by position (`Straight`/`Parlay`/`Teaser`),
  the report the portal manual v1.0.280 describes in F.A.Q. #4 (`services/sportsdesk_webview_server.ts:3027-3042`).
- `preGame` is computed from `gameDateTime` against the request clock and is a fact about the fixture,
  **not** a claim about the operator's delete permission (manual F.A.Q. #3).

## D-13. `surface.daemon-graph-data-plane`

The generated graph page fetches its data relative to the document, so serving only `/graph` and
`/graph.js` left it dead. These paths now serve it (`services/sportsdesk_webview_server.ts:1796-2474,3073-3085`):

| Route                           | Serves                                         |
| ------------------------------- | ---------------------------------------------- |
| `GET /graph-live-feed.json`     | `docs/graph-live-feed.json`, `no-store`        |
| `GET /api/graph-feed`           | the same feed at the path `graph.js` documents |
| `GET /combo-uniqueness.json`    | `docs/combo-uniqueness.json`                   |
| `GET /cross-domain-bridge.json` | `docs/cross-domain-bridge.json`                |
| `GET /assets/*`                 | `docs/assets/*` with real content types        |

Asset names are validated (separators, control characters, `..`) and traversal is rejected.

## D-14. `surface.daemon-analysis`

- `GET /api/analysis/filters` returns the report kinds (CP/CPS/CPV/G), 14 activity codes, 2 group
  modes and 4 week windows, with provenance (`services/sportsdesk_webview_server.ts:2912-2927`).
- `GET /api/analysis/reports` lists transcribed results with the selection each was run under
  (`services/sportsdesk_webview_server.ts:2556-2598`).
- `GET /api/analysis` answers **200** only when a stored report matches the selection, and **501**
  with the required capture otherwise. A 200 carries the rows, the published totals, a recomputed
  copy and a `discrepancies` array.
- One result is transcribed: Customer Performance, Baseball, agent BILLY666, 2026-11-01 — 8 rows
  (one a flagged duplicate), net $26,994.99, hold −58.33%.
- **The report is `POST /cloud/api/Manager/getAgentPerformance`.** Observed 2026-11-01, which
  corrects the repo's earlier inference of a `Report/` prefix. The ledger row moved to that path and
  to tier B: the request is fully observed, the response never was.
- **The wire filter names are not the dropdown names.** The observed bodies carry
  `sport`/`subsport`/`period`/`wagerType`/`betType` plus `start`/`end` and `type`; this API's
  parameters are `report`/`activity`/`group`/`week`/`agent`. A future live adapter therefore has to
  translate, and `week` is not the same field as the wire's `period` (nor the same as `-1` meaning
  "today" in the week list versus "all periods" in the observed body).
- **`tipo` is not a constant**: `0` for CP, `-1` for CPS. And `sport=LIVE` is valid — the captured
  catalog lists LIVE as a sport with one period (`0` = Game) and 11 sub-sport codes including
  `NCAAF Live`, which is why the CPS body can send `period=0`.
- **The screen's own options confirm four things** (`tests/fixtures/portal-agent-performance-filterbar-2026-11-01.html`,
  pasted 2026-11-01): sports option values are padded to 20 characters in the DOM, not just on the
  wire, so `padSportField` mirrors the control; the static period menu is Football's (and says
  "1st Qtr" where the catalog says "1st Quarter"); retired activity codes 6 and 9 exist only inside
  HTML comments, which is why the vocabulary ships 14; and `-1` means **Today** in the week select
  while the adjacent period select uses `-1` for **All Periods**.
- **Two wager-type selects, two shapes.** The report's own `wagers` list repeats the code `I`
  (If-Bets and Action Reverses), so a code is not a unique label. The grading panel's `wager-type`
  select sends a comma-separated value — `Straight` is `S,M,L,E,C` — so a consumer that assumes one
  code per selection is wrong. `betType` on this screen labels `M` as Money Line, which does **not**
  document the bet ticker's `WagerType=M`.
- **Graded Wagers is its own panel**, with its own search action (`search-grading`), its own date
  fields (`startG`/`endG`) and a working Excel export (`data-export="excel-action"`, un-hidden only
  after a search). The Analysis panel carries the same export icon with `hide`, so its export never
  appears. That is why an export of the graded report can exist while the analysis grid cannot be
  exported at all.
- **`getGrading` sends ISO dates and echoes its own path.** The observed body is
  `path=/cloud/api/Report/getGrading&customerID=&agent=…&start=2026-11-01&end=2026-11-01&type=&operation=getGrading&RRO=1&agentID=…&agentOwner=…`
  — ten fields, ISO `YYYY-MM-DD`, and a `path` field repeating the URL. `getAgentPerformance` sends
  M/D/YYYY and no such field, so the same screen family uses two date formats and two body shapes.
  The committed capture for `getGrading` records a three-field body (`customerID`, `operation`,
  `token`); both shapes are real, and the skeleton is not the whole contract.
- **A graded export is wager-level, not the grid.** `data/graded-wagers-export-2026-11-01.json`
  records the shape of the workbook the export produced (Customer, Ticket Number, Accepted,
  Description, Amount; 9,387 rows), while the Analysis grid renders seven aggregate columns per
  agent. The workbook itself is not committed: every row carries a login and a ticket number.
- **Two header actions sit beside the filters**: `show-config` (Configuration, L-1027) and
  `show-vip` (Vip List, L-1028). Neither is a report search — they open panels. `show-config` still
  has no observed call; it plausibly reaches the web-report config (`getConfigWebReports`, present in
  the pinned bundle), which is an inference and labelled one.
- **`show-vip`'s save is observed, and it is a write — three requests, two encodings.** The portal
  sends `POST /cloud/api/Manager/vipListInsert` (JSON, `{"list":[{"agentID":…,"player":…}]}` — a list
  array even for one entry), then `POST /cloud/api/Log/writeDetail` (form-encoded, the same list as
  urlencoded JSON in `data`, `ticket=0`, `info` = `" [SITE : fantasy402.com v1.0.280] "`), then
  `POST /cloud/api/Log/write` (JSON, `description` = `"Save Action / Vip List [ v1.0.280 |
fantasy402.com ]"`). A client that assumes one content type for the portal's writes breaks on the
  middle call. The sequence is pinned in `tests/f402_observed_requests.test.ts`, including a
  byte-for-byte rebuild of the `writeDetail` body from two independent pastes (encoded and decoded).
- **Those three are recorded, never replayed.** Correcting an earlier overstatement: `Log/write` does
  have a registered probe (`lib/f402_probe.ts`, `readOnly: false`), gated behind
  `--include-unconfirmed` plus `--i-understand-mutations`; it synthesizes its own body rather than
  replaying a recorded request. `vipListInsert`, `Log/writeDetail` and `updateBetTickerConfig` have no
  call site at all. Production stays read-only unless a task is explicitly a deploy, and a VIP entry
  is live customer state. Every identifier in these calls is also the bare 7-character login, which
  contradicts the runbook's note that `Log/write` pads its `customerID` to 10 characters.
- **The write acknowledgement is `{"INFO":""}` — an empty _string_.** Not `true`, not `{}`. So an
  `INFO` envelope in this API is either an object (the ticker config) or an empty string (a write
  ack), and a parser assuming the object form reads the ack as an empty config. `parseTickerConfig`
  returns null for it, which was a real bug until the shape was seen: `{"INFO":""}` used to parse
  into six disabled buckets and an empty agent. An empty `INFO` is **not** evidence that the write
  succeeded — this portal also acknowledges without inspecting results (`updateBasicSettings` assigns
  local state from the values it sent) — so it is recorded as "no payload" and nothing more. Which of
  the three calls it answered was not identified in the paste, so all three remain candidates.
- **The rendered report names itself.** The table container carries
  `class="TYPE-REPORT-Customer-Volume"`, i.e. the report kind's label with spaces hyphenated. That is
  the DOM's own statement of which report is loaded, alongside the `#btnPerformance` label and the
  `data-value` selection — three places that must agree before a screen is read as a given report.
- **The grid's column headers are known; the response keys are not.** The rendered table names
  All Players and Agents · Won · Lost · # of Bets · Risk · Net · Hold %age. That is markup, not a
  response, so no JSON schema follows from it, and the fixture asserts that distinction.
- The observed values also check out against the captured catalog: `subsport=NFL` is one of
  Football's 28 sub-sport codes, and `period=1` under Football is `1st Half` — not "first period".
- A browser stack trace from the same session places the sub-sport fetch on
  `app/manager/module/agent-performance.js?bust=1.0.280` (`getSubsport()` → jQuery `$.ajax`). The
  module name is the strongest evidence yet that the CP grid is the `getAgentPerformance` screen, but
  it is a trace of the _sub-sport_ call, not of the report call — since 2026-11-01 the report's URL
  _is_ observed (`Manager/getAgentPerformance`); what remains unproven is its response.
- The padding is confirmed by three observations, not inferred from one: `Football`, `Auto Racing` and
  `Tennis` all pad to the same 20 characters, so the width is a property of the field, not of a name.
- `lib/f402_agent_performance_request.ts` builds the observed body from a typed selection and is pinned
  byte-for-byte to both recorded calls. It pads `sport` to 20 characters, validates `subsport` and
  `period` against the captured catalog, always emits the three filter fields (empty when unfiltered)
  and passes `wagerType`/`betType` through untranslated. It describes no response, because none has
  been observed.

## D-15. `surface.daemon-agent-search`

- `GET /api/agents/search?q=` searches `data/agent-tree.json`, prefix hits first
  (`services/sportsdesk_webview_server.ts:3119-3179`).
- Requires two characters, clamps `limit` to 1–100, and is loopback-gated because agent names are
  identity data.

## D-16. `surface.daemon-game-admin-board`

- `GET /api/game-admin/board` serves the Admin module — spread, moneyline, total and team totals
  with the money on each side (`services/sportsdesk_webview_server.ts:2765-2831`).
- Window values are the portal's: `48` yesterday, `24` today, `-1` current board. A single-day
  board answers Yesterday with no games rather than repeating today.
- Abbreviated amounts (`120k`) carry `amountExact: null` and are excluded from every sum.

## D-17. `surface.daemon-sport-catalog`

- `GET /api/sports/catalog` exposes 19 sports, 230 sub-sports and 42 period entries from
  `tests/fixtures/fantasy402-sport-catalog-2026-10-21.json`
  (`services/sportsdesk_webview_server.ts:2834-2908`).
- Period numbers are sport-specific; `periodTypes` reports every name a number carries and flags the
  ambiguous ones. Sub-sport codes claimed by two sports are marked.

## D-18. `surface.daemon-contests`

- `GET /api/contests` serves 227 futures extracted from the sports nav by
  `scripts/extract_contests.ts` (`services/sportsdesk_webview_server.ts:2723-2762`).
- Rows are keyed by the portal's numeric `contestNum`; sport, market and subject are parsed from the
  padded type string. `?group` and `?q` filter server-side.

## D-19. `surface.daemon-live-wagers`

- `GET /api/live-wagers` serves the `{LIST: [...]}` ticker feed
  (`services/sportsdesk_webview_server.ts:2601-2701`), which is **not** the Pending shape:
  `WagerNumber` is the ticket id and `ShortDesc` carries one line per leg.
- Both `ShortDesc` grammars are parsed; a leg with no `/ Period / Market / Pick` segments is flagged
  `compact` and its sport is matched against the known sport names.
- `VolumeAmount` differing from `AmountWagered` is reported (`volumeDiffers`), not reconciled.
- `data/live-wagers.json` holds 17 rows salvaged from a partial clipboard paste and records that
  provenance in `captureNote`.
- **The ticker's configuration names its buckets two different ways.** The write
  (`POST /cloud/api/Manager/updateBetTickerConfig`, form-encoded, a mutation this repo never sends)
  uses upper bounds — `play499`, `color499` — while the read's `INFO` object uses ranges —
  `play1-499`, `color1-499`. Six buckets span 1-499, 500-999, 1000-1999, 2000-4999, 5000-9999 and
  10000-100000, contiguous; a round-trip has to translate between the two namings
  (`tests/fixtures/f402-bet-ticker-config-2026-11-01.json`).
- **The values are padded asymmetrically.** An enabled bucket reads `"on "` — trailing space — and a
  disabled one reads `"off"` with none. So `value === "on"` is false for every enabled bucket while
  `value === "off"` is true, which makes a naive parser look half-right and report the whole ticker
  as disabled. Trim before comparing; the tests state the bug and its fix.
- **`AgentID` changes width between the two calls**: unpadded in the request, padded to 50
  characters in the response. Same field, two widths.
- **The config pair now has code, not only a fixture.** `lib/f402_bet_ticker_config.ts` holds both
  halves: `parseTickerConfig` reads the `INFO` object and `buildTickerConfigWrite` emits the write
  body, reproducing the observed request field for field and in its order — plays descending
  (100000 → 499), the five `show*` flags, colours ascending, then `operation` and `agentOwner` —
  with `body` re-parsing to the same fields
  (`lib/f402_bet_ticker_config.test.ts`, `tests/f402_bet_ticker_config.test.ts`, both against
  `tests/fixtures/f402-bet-ticker-config-2026-11-01.json`).
- **A builder, not a client.** One test reads the module source and fails on `fetch(` or
  `Bun.connect`, and no production module imports it: `/api/live-wagers` still serves the saved list
  only, and there is no `updateBetTickerConfig` call site in the repo.
- **The trim rule is written once**, in `lib/f402_flag_values.ts` (`trimFlag`,
  `normalizeOnOffFlag`, `isFlagOn`), shared with the web-reports grid
  (`lib/f402_config_web_reports_customer_admin.ts`). A flag that is neither on nor off is not
  treated as on — `"yes"` parses to disabled, because an unrecognised value is a contract change,
  not consent.
- **The widths live in one place with their evidence status** (`lib/f402_field_widths.ts`):
  `SPORT_FIELD_WIDTH` 20 and `TICKER_AGENT_ID_WIDTH` 50 are measured (the latter is this response's
  padding); `CUSTOMER_ID_CANONICAL_WIDTH` 11 (spec claim) and `LOG_WRITE_CUSTOMER_ID_WIDTH` 10
  (runbook claim, contradicted 2026-11-01) are marked unconfirmed and kept as separate constants so
  one being wrong cannot move the other. `padField` pads and never truncates.
- **The parser refuses every envelope that is not this config** (`lib/f402_bet_ticker_config.test.ts`):
  `{"INFO": ""}` — the write acknowledgement observed 2026-11-01 — parses to `null`, where reading it
  as an `INFO` object yielded six disabled buckets, an empty agent and no error; `INFO: false` parses
  to `null` rather than "six disabled buckets, no agent"; and `{}`, `{ unrelated: true }`, `null` and
  a bare string all return `null`, so an empty object is not "everything off" — a bare object must
  carry at least one field the parser models before it is trusted.
- **It reports what it does not understand instead of guessing.** An unrecognised key lands in
  `unknownKeys` (`color99999` in the test) rather than being dropped, so a widened contract is
  visible; a colour that is not `#rrggbb` becomes `null` without taking the bucket down with it —
  `color1-499: "red"` leaves that bucket `enabled: true` with `color: null`.
- The pasted read is the healthy `INFO` object. The `INFO:false` shape the capture request asks for
  was not observed, so the two must not be conflated — and `parseTickerConfig` returns `null` for it
  rather than reading it as an empty ticker.
- Every response carries that provenance back: `provenance.source` (`paste:clipboard-ticker`),
  `observedAt` (null — the paste carries no timestamp), `captureNote` verbatim and `partial: true`.
  The dashboard renders the list as `17 WAGERS · PARTIAL` and shows the file's own note, so a count
  of 17 cannot be mistaken for the whole ticker. An explicit `partial` flag in the file wins over
  inferring it from the note.

## D-20. `surface.daemon-logo-proxy`

- `GET /api/logo/{name}` fetches `https://cdn.fastassets.io/images/team-logos/{name}` and returns the
  bytes with an immutable day-long cache (`services/sportsdesk_webview_server.ts:1470-1566`).
- The name is validated by rejecting separators, control characters and `..` rather than by
  allowlisting the characters the feed happens to use — the feed sends names with spaces
  (`Arsenal FC.png`), so an allowlist would have to grow with the feed.
- A malformed percent-escape is **400**, not 500: `decodeURIComponent` used to throw straight into
  the error boundary (measured `/api/logo/%E0%A4%A`).
- An upstream response that is not `image/*` is **502**; a non-2xx upstream status is passed through.
  **Partly contradicted, re-read 2026-11-02:** no content-type check exists. `fetchLogo`
  (`services/sportsdesk_webview_server.ts:697-746`) decodes the bytes, and the route answers 502 when
  they do not decode or exceed 4 MiB; the status passthrough holds.
  The fetch is bounded by an 8s `AbortSignal.timeout`.
- Public by design: fixed host, image bytes only, no customer data.

---

## Summary

| Tier                               | Count                               | Ids                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D — real surface missing from spec | 20                                  | `surface.fantasy402-sport-catalog`, `surface.manager-getHistory`, `surface.manager-getGrading`, `surface.daemon-dashboard`, `surface.daemon-miniapp`, `surface.daemon-telegram-admin-routes`, `surface.gs-manager-cli`, `surface.daemon-live-bets`, `surface.daemon-agent-tree`, `surface.daemon-scoreboard`, `surface.daemon-sports-taxonomy`, `surface.daemon-game-admin`, `surface.daemon-graph-data-plane`, `surface.daemon-logo-proxy` |
| E — documented, not implemented    | 1 surface (9 paths / 10 operations) | `surface.desk-api-unimplemented`                                                                                                                                                                                                                                                                                                                                                                                                            |

The D rows should be added to the docs (or explicitly scoped out with a one-line rationale). The E surface
should be removed from the published contract until code exists, or clearly badged as unimplemented.
