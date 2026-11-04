# Bridge 3 workstream map — moved to shared design docs

The shared sanitization and latest-pointer contract lives in
[`docs/design/pii_sanitization.md`](../design/pii_sanitization.md). Full stream topology lives in
[`docs/design/stream_map.md`](../design/stream_map.md).

The four 3x workstreams are kept separate:

| Workstream | Stream                                                                        | WS                | R2                                                             |
| ---------- | ----------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| **3a**     | Fantasy402 BetTicker (`Manager/getBetTicker`, XML ticker)                     | `f402-bet-ticker` | `f402-bet-ticker/latest.json`                                  |
| **3b**     | Fantasy402 Pending Bets (`Manager/getPending` / `Report/Pending`)             | `f402-pending`    | `f402-pending/latest.json`                                     |
| **3c**     | GSLive Bet Report / Tally (Partner 118 `getBetReport` / markets-report)       | none              | `gslive-tally/<date>/rollup.json` + `gslive-tally/latest.json` |
| **3d**     | Fantasy402 Graded / Settled (`Report/getGrading`, `f402_graded_wager_row.ts`) | none              | `f402-graded/<date>/rollup.json` + `f402-graded/latest.json`   |

3c and 3d are batch rollups sharing the PII contract; they are not WS streams and must not be merged
into one object family. No implementation code is present in this note; 3a is the first open
workstream.
