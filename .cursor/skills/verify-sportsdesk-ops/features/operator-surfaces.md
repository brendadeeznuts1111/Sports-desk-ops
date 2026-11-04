# Feature: operator surfaces (GSLive, docs, stale cohort, live ingest)

**Surface.** Bun CLI commands plus the static portal artifacts they generate. No long-lived server
is required for the fixture path; `--live` and `--live-f402` make outbound reads.

**Map.** This file is the operator-facing companion to the token-gate features. Data mappings live in
[`docs/REAL_INGESTION.md`](../../../../docs/REAL_INGESTION.md#31-wire--feed-mapping) §3.1; GSLive
surface rules in [`docs/report-surfaces.md`](../../../../docs/report-surfaces.md).

## Preconditions

- Bun 1.4.4, repo root, `bun install --frozen-lockfile`.
- `./bin/dx doctor` equivalents: run `../../bin/doctor.sh` before the first drive.
- Live drives are opt-in: `SPORTSDESK_LIVE_INGEST=1`, `SPORTSDESK_LIVE_F402=1`, `F402_LIVE_LOGIN=1`.
  Fixture drives never touch the network.

## Drives

| Feature id           | Command                                                                                                          | Pass signal                                                                                                      |
| :------------------- | :--------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `dx-help`            | `./bin/dx help`                                                                                                  | exit 0; lists `gslive`, `docs`, `stale`, `poll`, `watch`                                                         |
| `gslive-links`       | `./bin/dx gslive AF12`                                                                                           | report URL has `text=player_AF12`; bet-history has `partnerUserId=AF12` and both `dateFilterBy` values           |
| `gslive-docs`        | `./bin/dx docs --json`                                                                                           | JSON has `provider: "GSLive Manager (Partner 118)"` and 3 surfaces                                               |
| `stale-cohort`       | `./bin/dx stale -i <export.csv> --window-min 10`                                                                 | seeded event cluster lists the seed `★` and other customers                                                      |
| `webview-shot`       | `./bin/dx shot <url> --out scratch/shots/page.png`                                                               | piped or `--json`: JSON with `screenshot`, `bytes`, `sha256`, `backend`; a TTY gets a table; non-zero on failure |
| `dx-session`         | `./bin/dx session` (`--json` for machine output)                                                                 | `Bun.inspect` report with `sessionPath`, `transport`; exit 1 without a session file or proxy                     |
| `polymarket-profile` | `./bin/dx profile <0x\|username>`                                                                                | PnL, win rate, positions, categories, strategy                                                                   |
| `cfb-combos`         | `./bin/dx combo legs` / `price --prices …` / `uniqueness`                                                        | legs listed; fair price product; per-game unique counts                                                          |
| `poll-fixture`       | `./bin/dx poll --once`                                                                                           | feed `dataMode: "FIXTURE"`, 39 profiles                                                                          |
| `poll-live`          | `./bin/dx poll --once --live`                                                                                    | feed `dataMode: "PARTIAL"`, `provenance.polymarket.walletsOk` 20–23, `walletsInvalid` 16                         |
| `poll-f402-off`      | `./bin/dx poll --once --live-f402` without `F402_LIVE_LOGIN=1`                                                   | warns `F402 live login disabled`; exit 0; `provenance.f402.source: "fixture"`                                    |
| `portal-contract`    | `bun test tests/gslive_portal_links.test.ts tests/cli_terminal_automation.test.ts tests/pipeline_assets.test.ts` | pass                                                                                                             |

### WebView screenshots

```bash
# public page (webkit on macOS, chrome elsewhere)
./bin/dx shot https://fantasy402-docs-4ay.pages.dev/graph.html --out scratch/shots/portal.png

# F402 manager after one login (opt-in; never prints credentials)
F402_LIVE_LOGIN=1 ./bin/dx shot --f402-login --f402-page /manager.html --out scratch/shots/f402.png

# is a saved profile still signed in? (signedOutMarkers [] = no signed-out page seen)
./bin/dx shot --profile scratch/webview-profile --f402-page /manager.html --out scratch/shots/profile.png

# webp works on both backends: WebKit captures PNG and the CLI re-encodes it with Bun.Image
./bin/dx shot <url> --format webp --quality 82 --out scratch/shots/page.webp
```

`Bun.WebView` is experimental; a failed launch or navigation exits non-zero and prints a redacted
error. Screenshots land under `scratch/` and are not committed.

## Mapping checks

- Money: F402 wire `Risk`/`ToWin` are **cents**; the feed publishes **USD**. Never compare directly.
- Time: wire `InsertDateTime` is UTC-5; feed timestamps are UTC ISO; desk-day bounds are
  `America/Chicago` (`computeDeskDayStartEpochSeconds`, DST-aware `toTime`).
- Identity: `text=player_<LOGIN>` only on `#/reports/users`; `partnerUserId=<LOGIN>` (raw) only on
  `#/events/bet-history`.
- Provenance: per wallet `dataSource` is `LIVE | STALE | FIXTURE`; `walletAddressValid: false` marks
  the 16 placeholder rows and their numbers must be 0.
- `pendingBets` is fixture until a `getPending` response is captured and mapped; `dataMode` cannot
  reach `LIVE` before that.

## Evidence

Store `log.txt`, `status.txt`, and the generated `docs/graph-live-feed.json` under
`$SPORTSDESK_VERIFY_EVIDENCE/operator-surfaces/<run-id>/`. Do not commit live feed output from a
drive; the committed feed is refreshed by `./bin/dx poll --live`.

## Known limits

- 16 configured wallet addresses are truncated/synthetic; live totals cover 23 wallets.
- F402 is a `getBetTicker` probe only: rows are counted, not mapped (`mapped: false`).
- CLOB WSS is not ingested; `wssIngestion` is `"not_ingested"` and the 345 ms figure is a fixture
  sample.
