# Operator Quickstart, Data Cleaning Pipeline & 10-Mode Action Runbook

> **Live 6-Tab Surveillance, ROT Bet-Ticker & 10-Mode Forensic Portal:**
> [`https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/graph.html`](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/graph.html)
> **Live JSON Feeds:** [`graph-live-feed.json`](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/graph-live-feed.json) • [`backtest-4wk-cfb-nba.json`](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/backtest-4wk-cfb-nba.json) • [`openapi.json`](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/openapi.json)

---

## 1. Day-1 Operator Onboarding: What to Run in Your First 60 Seconds

When you open `/Users/nolarose/code/sportsdesk-ops`, **always start with `./bin/dx`**. It automatically configures your shell environment, silences macOS sandbox/Git `EPERM` warnings, loads Cloudflare R2 credentials, and runs its tooling through Bun (`v1.4.4`).

| Step                                      | Command                                                                                       | What It Checks / Executes                                                                                                                                                                                                                                                                                                                | When to Run                                                      |
| :---------------------------------------- | :-------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| **1. Environment & Edge Health**          | `./bin/dx status`                                                                             | Verifies `$HOME/.gitconfig`, Dotfiles link, staged `dist/` assets, and live Cloudflare R2 gateway (`HTTP 200`).                                                                                                                                                                                                                          | Start of shift / after cloning                                   |
| **2. 10-Mode Diagnostic Matrix**          | `./bin/dx modes` _(or `./bin/dx modes 1..10`)_                                                | Runs all **10 Modes** across **Risk & Exposure (1, 8, 9)**, **Identity & Network (2–6)**, **Cross-Market (7)**, and **Data Integrity (10)**.                                                                                                                                                                                             | Every shift / when investigating an account, IP, or P/L gap      |
| **3. Per-Office & Cross-Office IP Audit** | `./bin/dx iptracker`                                                                          | Audits all **13 Office & Cross-Office IP Clusters** (`getWebLog` Mode `B` `customerID=<OfficeAgentID>` vs `customerID="0"`) joined with Mode `A` dwell and MFCS scores.                                                                                                                                                                  | Whenever a sharp cluster hits the Bet-Ticker                     |
| **4. 4-Week CFB & NBA Parlay Backtest**   | `./bin/dx backtest`                                                                           | Runs the 4-week full-customer (`9,435` accounts) CFB & NBA parlay/combo backtest (`+$1,171,420` net hold swing).                                                                                                                                                                                                                         | Weekly risk review / teaser & alt-spread tuning                  |
| **5. Live Poll & R2 Edge Publish**        | `./bin/dx poll --live` _(or `./bin/dx deploy` / `./bin/dx watch`)_                            | Fetches real Polymarket positions for the 39 configured wallets (23 currently valid), regenerates `graph-live-feed.json` with per-wallet `dataSource` + provenance, and publishes to Cloudflare R2 via SigV4. Add `--live-f402` for a session-backed `getBetTicker` probe; `pendingBets` stay fixture until the row mapping is captured. | After config changes or continuous 60s daemon (`./bin/dx watch`) |
| **6. Verification Gate**                  | `bun test tests/forensic_diagnostic_modes.test.ts tests/bet_ticker_ip_tracker_bridge.test.ts` | Executes the deterministic unit tests covering Modes 1–10 and the Bet-Ticker ↔ IP-Tracker wire bridge.                                                                                                                                                                                                                                   | Before committing any code or rule change                        |

---

## 2. How the 4 Upstream Modules Clean, Normalize & Map Information

Raw payloads from Fantasy402 (`customer/report/report.js`, `manager/report/help-report.js`, `manager/module/bet-ticker.js`, `manager/module/ip-tracker.js`), GSLive Manager (`plive.sportswidgets.pro/manager-tools/`), and Polymarket (`Gamma`, `CLOB REST/WSS`, `Data API`) contain legacy quirks that cause false alerts or corrupted liability math if ingested naively. Our canonicalization pipeline (`lib/forensic_diagnostic_modes.ts` & `lib/bet_ticker_ip_tracker_bridge.ts`) cleans six critical layers before feeding the 10 Modes:

1. **Parent Ticket Deduplication (`TicketNumber + "-" + WagerNumber`)**:
   - _Upstream Quirk (`report.js` / `help-report.js`)_: `api/Report/Pending` and `api/Report/getGrading` return **one JSON row per leg**, repeating the parent ticket's `AmountWagered` and `ToWinAmount` on every leg row.
   - _Cleaning Rule (Mode 9 & Mode 7)_: Group rows by composite key `${TicketNumber}-${WagerNumber}` before summing stakes or hashing combo legs so parlay/teaser risk is counted **once per ticket**, never multiplied by leg count.
2. **Channel Noise & Twin Deduplication (`TicketWriter` Filter)**:
   - _Upstream Quirk (`bet-ticker.js`)_: `Manager/getBetTicker` emits `BLOCKED` sentinel rows and `ALERT` syndicate mirror slips alongside the primary `Internet` / `GSLIVE` / `GSBUILDER` ticket within `<= 6s`.
   - _Cleaning Rule (Mode 9)_: Drop `BLOCKED` rows before parent grouping and zero out `ALERT` mirror volume (`canonicalVolumeCents = 0`) so exposure is never double-counted.
3. **Free-Play Asymmetry & Sign Convention (`FreePlayFlag === "Y"`)**:
   - _Upstream Quirk (`help-report.js`)_: When a Free-Play (`FreePlayFlag: "Y"`) loses (`WagerStatus: "L"`), the customer's cash balance is **not** debited (`$0` principal loss); when it wins (`"W"`), only `ToWinAmount` is credited (stake is not returned).
   - _Cleaning Rule (Modes 8, 9 & 10)_:
     - **Mode 9 (Pending)**: Sets `stakeCents = 0`, `definedLiabilityCents = ToWinAmount`, `potentialPayoutCents = stakeCents + definedLiabilityCents`.
     - **Mode 8 (Settled)** & **Mode 10 (Reconciliation)**: Tracks `freePlayLostPrincipalSavedCents` separately and enforces `CUSTOMER_PERSPECTIVE_POSITIVE_IS_PLAYER_WIN` (`bookNetHoldCents = -settledSportsNetCents`).
4. **Effective Line & DGS Alternate Spread Normalization (`getLineGame` & `GameNum + 5000`)**:
   - _Upstream Quirk (`report.js`)_: Teaser legs store the base spread/total in `AdjSpread` / `AdjTotalPoints` and the teaser movement in `TeaserPoints`. Alternate spreads book under child rotation numbers `GameNum + 5000` (e.g., `ROT 5501` for parent `ROT 501` LAL/BOS).
   - _Cleaning Rule (Mode 7)_:
     - **Spread Teaser**: `effectiveLine = AdjSpread + TeaserPoints`.
     - **Total Teaser**: Over **subtracts** `TeaserPoints` (`AdjTotalPoints - TeaserPoints`); Under **adds** `TeaserPoints` (`AdjTotalPoints + TeaserPoints`).
     - **Integer Precision**: Convert all lines to `LineHundredths` (`Math.round(effectiveLine * 100)`, e.g. `-7.5 -> -750`) and normalize `rot >= 5000` to `parentRot = rot - 5000`.
5. **IP-Tracker Mode `B` Scope & Mode `C` Date Inversion (`ip-tracker.js`)**:
   - _Upstream Quirk (`ip-tracker.js` lines 76–89)_:
     - In Mode `B` (`GLOBAL_IP_MATCHER`), passing `customerID: "0"` scans all 668 offices (**Cross-Office Global Match**), whereas passing `customerID: "<OfficeAgentID>"` (e.g., `"MJ2026"`, `"BIGDAD"`, `"CUB22HR"`, `"ATEAM"`) scans collisions strictly inside that single office (**Per-Office Match**).
     - Modes `A`, `B`, and `I` require `MM/DD/YYYY` dates, but Mode `C` (`PLAYER_IP_MATCHER`) rewrites `start` and `end` to **`YYYY-MM-DD`**.
   - _Cleaning Rule (Modes 2, 3, 4, 5, 6)_: `formatWebLogDateForMode()` and `buildPerOfficeIpMatcherPayload()` automatically format dates and `customerID` per mode, and `normalizeWebLogLoginId()` strips leading/trailing dots and whitespace.
6. **Dual-Identity Cross-Surface Linking (`LoginID` + `AgentLogin` + `player_[login]` + `0x` Wallet)**:
   - Every watchlist record links four surfaces simultaneously:
     1. **Fantasy402 Customer & Office**: `https://fantasy402.com/manager.html?customer=<LoginID>&agent=<OfficeAgentID>`
     2. **GSLive Partner 118 Profile**: `https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=<desk-day start ISO>&partnerId=118&searchBy=player&text=player_<LoginID>&to=<desk-day end ISO>` (the `player_` token belongs to this report surface only; `#/events/bet-history` uses the raw login, e.g. `partnerUserId=AF12`). Generate with `./bin/dx gslive <LoginID>`.
     3. **Polymarket On-Chain Profile**: `https://polymarket.com/profile/<0xProxyWallet>`
     4. **Write Mutation Identity (`PaddedCustomerId`)**: Right-space-padded to exactly 11 characters (`padEnd(11, " ")`) with direct owning `agentID` (never `BILLY666`) on `POST /cloud/api/Manager/updateByColumn`.

---

## 3. End-to-End Module Interaction & 10-Mode Operator Action Playbook

| Domain                 | Mode                        | Upstream Inputs                                                                       | Cleaned Signal Produced                                                                                                                                                    | Operator / Automated Action to Take                                                                                                                                                                          |
| :--------------------- | :-------------------------- | :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Risk & Exposure**    | **1 · Customer overview**   | `getDailyFiguresByCustomer` + `Pending` + `getWebLog (A)`                             | Validated net P/L, pending liability, access freshness (`s`), and missing-data warnings (`WEBLOG_MODE_A_COLLECTION_GAP`, `STALE_ACCESS_TELEMETRY`).                        | Use as your **first stop on any account**. If `missingDataWarnings` is non-empty, run Mode 4 & Mode 10 before modifying credit or settling balances.                                                         |
| **Identity & Network** | **2 · Access logs**         | `getWebLog (type="A")` (`LoginID`, `Operation`, `Data`, `AccessDateTime`)             | Chronological access timeline distinguishing `SELF_PLAYER` vs `OFFICE_AGENT` / `MASTER_MANAGER` overrides and login-to-wager dwell (`s`).                                  | If `nextWagerDwellSeconds <= 6s` (`SNIPER_TWIN`), trigger **6s Dynamic Delay Gate** (`wire mutate -c <ID> -a <OFFICE> --col Delay --val 6`). Audit `OFFICE_AGENT` rows for unauthorized limit raises.        |
| **Identity & Network** | **3 · Shared-IP overview**  | `getWebLog (type="B")` Per-Office (`customerID=<Office>`) & Global (`customerID="0"`) | Account groups sharing a normalized IPv4 / `/24` subnet within the same date window, tagged `PER_OFFICE` vs `CROSS_OFFICE_GLOBAL`.                                         | When `distinctCustomerCount >= 2` and `mfcsCompositeScore >= 80`, clamp the entire office ring (`MaxBet=1000`, `Delay=6`, `Allow1H2HQtr=0`) instead of a single account.                                     |
| **Identity & Network** | **4 · Customer IP history** | `getWebLog (type="C", YYYY-MM-DD)` + Mode `A`                                         | Single customer's IP/ASN transition timeline and `>24h` collection gap flags.                                                                                              | If an account switches from residential ISP to `Cloudflare WARP` / `Linode` (`BOT_SHARED_ASN`) right before a steam burst, clamp to **FG-Only (`Allow1H2HQtr=0`)**.                                          |
| **Identity & Network** | **5 · Accounts by IP**      | `getWebLog (type="I", customerID="0", ip=<IP>)`                                       | Complete list of accounts observed on a target IP with first/last timestamps and operation counts.                                                                         | Run immediately when a new unlisted account (`MJ103`, `EJ8835`) appears on a known syndicate IP (`104.28.34.12`) to catch **Bet #1 in `<320ms`**.                                                            |
| **Identity & Network** | **6 · Activity overlap**    | `getWebLog (A/I)` × `getBetTicker (InsertDateTime)`                                   | Overlap duration (`s`) and strict distinction between **`CONFIRMED_CONCURRENT_SESSION_OVERLAP`** (bounded sessions) and **`NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP`**. | Only execute **Cross-Office Beard-Ring Freeze** when `CONFIRMED_CONCURRENT_SESSION_OVERLAP` (`>0s` bounded session intersection) or synchronized same-ROT execution (`<=15s`) is confirmed.                  |
| **Cross-Market**       | **7 · Wager comparison**    | `api/Report/Pending` (`getLineGame`) ↔ Polymarket `/positions?user=<0x>`              | Event (`ROT`), period, side, `LineHundredths` delta (`Δ`), timestamp delta (`Δt`), `matchReasons`, and `uncertaintyFlags`.                                                 | • If `Δ > 0` across Key `3/7` (`SHARP_STILL_BETTER`): **Step F402 board line** (`-125/-125` Vig Curtain).<br/>• If DGS `ROT+5000` Alt+ML same-game parlay (`Probit ρ >= 0.65`): **Block correlated subset**. |
| **Risk & Exposure**    | **8 · Settled net**         | `getGradedWagerByCustomer` + `getGrading` + `getTransactions`                         | Customer P/L by period (`24H/7D/4WK`) and currency (`USD`/`USDC`) with Free-Play zero-loss principal & ledger adjustments separated.                                       | Identify high-CLV extractors (`+$42.8K` on `MJ102`, `+$89.4K` on `BGD101`) and apply **`+15c` Spread / `+20c` Derivative Vig Shading** (`bun sportsdesk_cli.ts wire vig`).                                   |
| **Risk & Exposure**    | **9 · Pending exposure**    | `api/Report/Pending` + `getPendingByTicket`                                           | Unique parent tickets (`TicketNumber-WagerNumber`), reporting **Stake**, **Potential Payout**, and **Defined Liability** separately.                                       | Size your **CLOB TWAP / Wintermute RFQ hedge** strictly against **Defined Liability** (after `ALERT` twin removal and Free-Play zero-stake adjustment), never raw leg row sums.                              |
| **Data Integrity**     | **10 · Reconciliation**     | `getDailyFiguresByCustomer` vs `getGradedWagerByCustomer` vs `getTransactions`        | `matchedTotalsCents`, itemized `explainedDifferences` (`MANUAL_LEDGER_ADJUSTMENT`, `FREE_PLAY_PRINCIPAL_EXCLUSION`), and `unresolvedGapCents`.                             | Verify `unresolvedGapCents === 0` before weekly agent settlement. Any non-zero `unresolvedGapCents` raises `UNRESOLVED_GAP_ALERT` and halts automated payout export.                                         |

---

## 4. Direct Operator CLI Cheat Sheet

```bash
# 1. Run full 10-Mode Forensic, Risk, Cross-Market & Reconciliation Matrix
./bin/dx modes

# 2. Drill into a single Mode (e.g. Mode 6 Activity Overlap, Mode 9 Pending Exposure, Mode 10 Reconciliation)
./bin/dx modes 6
./bin/dx modes 9
./bin/dx modes 10

# 3. Export full 10-Mode structured JSON for downstream automation
bun sportsdesk_cli.ts modes --json

# 4. Run Per-Office & Cross-Office IP-Tracker Cluster Report (13 offices)
./bin/dx iptracker

# 5. Execute Ban-Hammer Profile Clamp (11-char padded customerID + direct office agentOwner)
bun sportsdesk_cli.ts wire mutate -c MJ102 -a MJ2026 --col MaxBet --val 1000
bun sportsdesk_cli.ts wire mutate -c MJ102 -a MJ2026 --col Delay --val 6
bun sportsdesk_cli.ts wire mutate -c MJ102 -a MJ2026 --col Allow1H2HQtr --val 0

# 6. Apply +15c Spread / +20c Derivative Vig Shading (20-char padded sportType)
bun sportsdesk_cli.ts wire vig -c ABC700 -s Basketball --spread 15 --derivative 20

# 7. Poll live feeds and publish updated 6-Tab Portal & rich-metadata images to Cloudflare R2
./bin/dx deploy

# 8. Bun.WebView screenshots (default output: scratch/shots/)
./bin/dx shot https://fantasy402-docs-4ay.pages.dev/graph.html --out scratch/shots/portal.png
F402_LIVE_LOGIN=1 ./bin/dx shot --f402-login --f402-page /manager.html --out scratch/shots/f402.png

# 9. Polymarket profiles and CFB combos (public APIs)
./bin/dx profile 0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612
./bin/dx combo legs --limit 10
./bin/dx combo price --prices 0.38,0.80 --stake 10 --quoted 0.32
./bin/dx combo uniqueness --seed-trades --max-seed-markets 20
./bin/dx combo uniqueness --all-legs-cfb
./bin/dx combo verify-subset --chain --wallet-file scratch/seed.txt
./bin/dx combo backtest --wallets 0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612 --days 30

# 10. Cross-domain value: our customer book ↔ Polymarket wallets
./bin/dx bridge coverage
./bin/dx bridge value --live --customer BGD101 --customer MJ102
./bin/dx bridge match --seed --db scratch/cross-domain.sqlite
```

---

## 5. Rich-Metadata Visual Pipeline Artifacts (Public Cloudflare R2 & Repository Catalog)

Every visual reference diagram is generated deterministically by [`scripts/generate_pipeline_reference_images.ts`](../scripts/generate_pipeline_reference_images.ts) from its SVG source via `rsvg-convert` (with `qlmanage` as a fallback and a hard ink/color gate — a blank raster fails the build). The SVG and PNG carry the metadata layers (W3C RDF / Dublin Core `<dc:*>`, Adobe XMP `XML:com.adobe.xmp`, Schema.org `ImageObject` JSON-LD, RFC-2083 PNG `tEXt` & `iTXt` chunks with CRC-32 verification); the WebP sibling is a lighter raster with no metadata:

| Artifact ID                                | Pipeline Reference Diagram                                                                  | Public Cloudflare R2 Edge URLs (`HTTP 200`)                                                                                                                                                                                                                                                                                                                                                              | Local Repository Paths                                                 | Embedded Metadata Standards                                                             |
| :----------------------------------------- | :------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| **`SD-ARTIFACT-01-10MODE-PIPELINE`**       | **End-to-End 10-Mode Engine & Operator Action Pipeline**                                    | • [SVG (`22,337 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-10-mode-architecture.svg)<br/>• [PNG (`512,513 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-10-mode-architecture.png)<br/>• [WebP (`186,198 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-10-mode-architecture.webp)                                     | `docs/assets/pipeline-10-mode-architecture.{svg,png,webp}`             | SVG: RDF/Dublin Core + JSON-LD · PNG: XMP + JSON-LD + `iTXt`/`tEXt` · WebP: raster only |
| **`SD-ARTIFACT-02-6LAYER-CLEANING`**       | **Rosetta Stone 6-Layer Data Cleaning & Field Mapping Pipeline**                            | • [SVG (`17,368 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-6-layer-data-cleaning.svg)<br/>• [PNG (`398,783 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-6-layer-data-cleaning.png)<br/>• [WebP (`161,124 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-6-layer-data-cleaning.webp)                                  | `docs/assets/pipeline-6-layer-data-cleaning.{svg,png,webp}`            | SVG: RDF/Dublin Core + JSON-LD · PNG: XMP + JSON-LD + `iTXt`/`tEXt` · WebP: raster only |
| **`SD-ARTIFACT-03-IP-AND-RECONCILIATION`** | **Per-Office IP-Tracker (`Modes 2–6`) & Scope-Locked Reconciliation (`Modes 1, 8, 9, 10`)** | • [SVG (`16,943 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-per-office-ip-and-reconciliation.svg)<br/>• [PNG (`516,794 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-per-office-ip-and-reconciliation.png)<br/>• [WebP (`193,760 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-per-office-ip-and-reconciliation.webp) | `docs/assets/pipeline-per-office-ip-and-reconciliation.{svg,png,webp}` | SVG: RDF/Dublin Core + JSON-LD · PNG: XMP + JSON-LD + `iTXt`/`tEXt` · WebP: raster only |
| **`SD-ARTIFACT-04-DUAL-SURFACE-GSLIVE`**   | **Dual-Surface GSLive Model — Account Report vs Live Bet-History Sidecar**                  | • [SVG (`18,640 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-dual-surface-gslive-model.svg)<br/>• [PNG (`472,546 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-dual-surface-gslive-model.png)<br/>• [WebP (`172,134 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-dual-surface-gslive-model.webp)                      | `docs/assets/pipeline-dual-surface-gslive-model.{svg,png,webp}`        | SVG: RDF/Dublin Core + JSON-LD · PNG: XMP + JSON-LD + `iTXt`/`tEXt` · WebP: raster only |
| **`MANIFEST-JSON`**                        | **Machine-Readable Artifact & SHA-256 Metadata Catalog**                                    | • [Catalog JSON (`9,253 B`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/pipeline-artifacts-metadata.json)                                                                                                                                                                                                                                                                                | `docs/assets/pipeline-artifacts-metadata.json`                         | Full SHA-256 digests, upstream module map, and CLI command bindings                     |

---

## 6. Stale-Line / Post-Move Cohort (Rooting Out Bots)

A stale line is a price the desk left on the board after the reference market moved. The operator
note on the ticket (“Stale lines / Lines should have been down…”) is the ground truth; the detector
below uses that note (or a graded-then-cancelled reversal) as a seed and then finds everyone else
who hit the same market in the same window.

### 6.1 In the GSLive console

- `#/events/bet-history` with `dateFilterBy=calcTime` shows the **settlement/cancellation audit**
  (the stale-line note and the cancel). Use `dateFilterBy=betTime` to see **placement** history and
  placement tempo.
- The player filter is the **raw login**: `partnerUserId=AF12`, not `player_AF12`. The `player_`
  prefix belongs to `#/reports/users?text=`.
- To see who else was on the event, load the placement view for that desk day and add
  `eventId=<ROT or event id>` (supported by `./bin/dx gslive`, unverified in the SPA). If the grid
  ignores it, scan the day grid around the flagged placement time.

```
# desk day of the placement, placement order, event-scoped
https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793250000&to=1793250000&toTime=86399&dateFilterBy=betTime&t=<fresh epoch ms>&eventId=ROT-451
```

`1793250000` = 2026-10-29 00:00 CDT. Generate exact values with `./bin/dx gslive <LOGIN>`.

### 6.2 With a bet-log export

Export the bet log (CSV/JSON/JSONL) with these columns — names are case/punctuation insensitive:

| Column                              | Required       | Notes                                   |
| :---------------------------------- | :------------- | :-------------------------------------- |
| `customer`                          | yes            | Raw login, e.g. `AF12`                  |
| `placedAt`                          | yes            | ISO-8601 or epoch (seconds or ms)       |
| `eventId`                           | for clustering | Rotation or event id                    |
| `market`, `period`, `side`          | recommended    | Clustering key                          |
| `priceAmerican`, `stakeUsd`         | recommended    | Same-price and same-stake fingerprints  |
| `settledAt`, `canceledAt`, `status` | recommended    | Detects graded-then-cancelled reversals |
| `staleNote`, `notedBy`              | recommended    | Operator label / reviewer               |
| `agent`, `ip`                       | recommended    | Linkage hints                           |

```bash
# Human-readable cohort report (default ±10m window)
./bin/dx stale -i bets.csv --window-min 10

# Full JSON for automation
./bin/dx stale -i bets.json --json

# Pipe from another tool
cat bets.jsonl | ./bin/dx stale -i -
```

The report prints, per seeded event: the seed ticket, every other customer at the same
market/period/side within the window, their price/stake/status, and a GSLive follow-up URL for that
desk day. It also ranks customers by seed count and stale rate, with cancelled / graded-then-cancelled
counts, stake fingerprints, and `/24` IP hints.

### 6.3 What it does and does not prove

- Seeds are **operator-labelled** (or graded-then-cancelled). The tool does not infer “stale” from a
  price comparison, because no reference line series is ingested yet.
- A same-event cluster is a **lead**, not a verdict: the other tickets may be legitimate. Escalate
  with Mode 6 (activity overlap), Modes 3–5 (shared IP/subnet), and the CLV triangulation in
  `operational_guardrails_runbook.md`.
- To upgrade to a quantitative detector, add a sharp reference price series per event and compute
  `edge_bps` at placement and `lag_s` since the last reference move.
