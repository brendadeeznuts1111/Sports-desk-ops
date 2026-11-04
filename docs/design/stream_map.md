# Stream map — seven GSLive/F402 topics

One table so a new design note cannot re-conflate WebSocket frames with R2 snapshots. WS is
ephemeral delta/event transport; R2 is the replayable snapshot. A WS channel never implies an R2
object and an R2 object never updates per event.

| #   | Workstream / stream                        | Producer                                               | WS transport (delta)                                                     | R2 object (snapshot)                                                         | Dedupe / grouping key                                             |
| --- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **Bridge 1: GSLive Wagers by State**       | `wagers:capture` / `wagers:watch`                      | `POST /api/v1/live-bets`, channel `gslive-wagers`; aggregate per capture | `wagers-by-state/latest.json`                                                | `M.G<betGroupId>`; one risk per ticket/group                      |
| 2   | **Bridge 3a: Fantasy402 BetTicker**        | read-only `Manager/getBetTicker` poller (XML ticker)   | channel `f402-bet-ticker`; per-poll delta                                | `f402-bet-ticker/latest.json`                                                | `${TicketNumber}-${WagerNumber}`                                  |
| 3   | **Bridge 3b: Fantasy402 Pending Bets**     | `Manager/getPending` / `Report/Pending` open liability | channel `f402-pending`; per-poll delta                                   | `f402-pending/latest.json`                                                   | ticket identity; open liability snapshot                          |
| 4   | **Bridge 3c: GSLive Bet Report / Tally**   | Partner 118 `getBetReport` / markets-report            | none (batch)                                                             | `gslive-tally/<YYYY-MM-DD>/rollup.json` + `gslive-tally/latest.json` pointer | `M.G<betGroupId>`; exactly-once stake/net                         |
| 5   | **Bridge 3d: Fantasy402 Graded / Settled** | `Report/getGrading` via `lib/f402_graded_wager_row.ts` | none (batch)                                                             | `f402-graded/<YYYY-MM-DD>/rollup.json` + `f402-graded/latest.json` pointer   | `${Login}                                                         | ${WagerNumber} | ${TicketNumber}` |
| 6   | **Bridge 2: Evidence blobs**               | `dx shot --upload-blob` → blob gateway                 | none                                                                     | `blobs/<key>.webp`                                                           | key = screenshot identity; immutable object                       |
| 7   | **Graph live feed**                        | `graph_feed_poller_daemon`                             | none                                                                     | `graph-live-feed.json`                                                       | poll sequence; `gsliveWagers` block sourced from stream 1 sidecar |

## Boundary rules the table encodes

- **GSLive vs Fantasy402:** streams 1/4 are GSLive Partner 118 (`plive.sportswidgets.pro`); streams
  2/3/5 are Fantasy402 (`fantasy402.com`). A producer may read both, but an event/object belongs to
  exactly one source family.
- **WS = delta/event, R2 = snapshot.** Only streams 1, 2, 3 have WS channels. Streams 4, 5, 6, 7 are
  batch/object-only. A subscriber that needs history fetches the R2 snapshot; an R2 reader never
  assumes the object matches the last WS frame.
- **Bridge 3a/3b/3c/3d are the four 3x workstreams.** 3a is open first (BetTicker → WS + R2);
  3b is pending-bet liability; 3c is GSLive tally; 3d is Fantasy402 graded/settled. They are
  separate rows on purpose — do not merge 3c and 3d.
- **Snapshots with a pointer:** 3c/3d write an immutable daily rollup and then `latest.json` as a
  pointer (`{deskDate,key,sha256,generatedAt}`); the pointer is the only mutable object. Stream 1/2/3
  use a latest-snapshot object directly (no daily rollup).
- **Dedupe keys are not published:** `${TicketNumber}-${WagerNumber}`, `M.G<betGroupId>`, and
  `${Login}|${WagerNumber}|${TicketNumber}` are internal aggregation keys only; no identifier,
  ticket, wager or group id appears in WS payloads or R2 objects.
- **No raw rows anywhere:** the PII rules in [`pii_sanitization.md`](./pii_sanitization.md) apply to
  every stream; `betReport-all.json` and raw ticker/pending/graded rows are never uploaded.
- **Cron mechanism is per-stream.** 3a/3b run in-process `Bun.cron` inside the `:4020` webview
  daemon (`lib/bun_cron.ts` → `startInProcessCron`, schedule `sched_bridge_rollup_15m`), because
  their WS surface is that daemon. 3c is in the same in-process cycle today. 3d is design-only.
  An OS-level launcher (launchd) remains the requirement for daily 3c/3d rollups that must survive
  daemon restarts; do not describe the in-process tick as OS-level.
- Stream 6 objects are immutable evidence; deleting them is explicit cleanup, not a freshness
  signal. Stream 7 is a single-writer snapshot and never carries raw rows.
