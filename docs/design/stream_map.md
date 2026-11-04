# Stream map — five GSLive/F402 topics

One table so a new design note cannot re-conflate WebSocket frames with R2 snapshots. WS is
ephemeral delta/event transport; R2 is the replayable snapshot. A WS channel never implies an R2
object and an R2 object never updates per event.

| #   | Stream                              | Producer                                | WS transport (delta)                                                                          | R2 object (snapshot)                                           | Semantics                                                                            |
| --- | ----------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | GSLive wagers by state              | `wagers:capture` / `wagers:watch`       | `POST /api/v1/live-bets`, channel `gslive-wagers`; one aggregate event per successful capture | `wagers-by-state/latest.json`                                  | Delta event + latest summary; sanitized aggregate only                               |
| 2   | F402 BetTicker (Bridge 3a)          | read-only `Manager/getBetTicker` poller | channel `f402-bet-ticker`; normalized ticker delta per poll                                   | `f402-bet-ticker/latest.json`                                  | Per-poll delta + latest sanitized summary; no raw login/customer/ticket ids          |
| 3   | Settlement/tally rollup (Bridge 3c) | settlement ingest + pure projection     | none (batch)                                                                                  | `tally/<YYYY-MM-DD>/rollup.json` + `tally/latest.json` pointer | Daily snapshot; idempotent overwrite, pointer flips after hash verification          |
| 4   | Evidence blobs (Bridge 2)           | `dx shot --upload-blob` → gateway       | none                                                                                          | `blobs/<key>.webp`                                             | Immutable object; WebP ≤1280px, placeholder returned in upload response; no delta    |
| 5   | Graph live feed                     | `graph_feed_poller_daemon`              | none                                                                                          | `graph-live-feed.json`                                         | Poller snapshot of topology/feed; `gsliveWagers` block sourced from stream 1 sidecar |

## Rules the table encodes

- **WS = delta/event, R2 = snapshot.** A subscriber that needs history must fetch the R2 snapshot;
  an R2 reader must not assume the object is current to the last WS frame.
- Stream 1 and stream 2 share the `gslive-wagers`/`f402-bet-ticker` lowercase channel convention and
  the gateway's `SUBSCRIBE` protocol.
- Stream 3's `latest.json` is a **pointer**, not a second copy; daily object writes are verified
  before the pointer moves.
- Stream 4 objects are immutable evidence; deleting them is an explicit cleanup, not a freshness
  signal.
- Stream 5 is a single-writer snapshot; it may embed a sanitized summary from stream 1, but never
  carries raw rows or per-ticket identifiers.
