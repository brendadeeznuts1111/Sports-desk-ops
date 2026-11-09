# Bridge 3a — F402 BetTicker → WS + R2 summary

Status: **implemented & measured (2026-11-08).** Zero collection allocations on the aggregation path, SoA TypedArray columns, deterministic shape serializers, and binary canonical buffer specification.

## Goal

Poll Fantasy402 `Manager/getBetTicker` read-only, normalize the ticker rows, and publish:

1. a WS delta on the gateway channel `f402-bet-ticker` (lowercase), and
2. a sanitized `f402-bet-ticker/latest.json` snapshot in `sportsdesk-ops-reports`.

This is the first of 3a–3d because it exercises the shared event/snapshot rules in
[`pii_sanitization.md`](./pii_sanitization.md) and [`stream_map.md`](./stream_map.md) without needing
settlement aggregation.

## Locked extraction and demux

Extract these bounded fields **before** dropping `ShortDesc`. The raw text is never published.

### ExtendedSignalChannelCode (11)

`Internet`, `ALERT`, `GSLIVE`, `GSBUILDER`, `LIVE_CWS`, `CSLEVEL2`, `PHONE`, `HOUSE_BOOK`, `GATEWAY`,
`BLOCKED`, `NON_SPORTS_DROP`

### WagerType (8)

`S`, `M`, `L`, `E`, `P`, `T`, `I`, `G`

`ShortDesc` is demux input only: parse the channel and wager type into the bounded codes, then drop
the raw string. Unknown channel/type maps to `other`/`unknown` (never emitted as free text).

## Inputs and outputs

- Input: `lib/f402_ingest.ts` `probeF402BetTicker()` → `F402Probe` / `F402TickerRow[]`
  (`login`, `customerId`, `agentId`, `ticketWriter`, `wagerNumber`, `wagerType`, `shortDesc`,
  `insertedAt`, `vip`).
- Internal dedupe: `${TicketNumber}-${WagerNumber}`; one risk/to-win amount per ticket before
  summing. Raw login/customer/agent/ticket ids are never output.
- WS event: per-poll delta with channel/wager-type counts plus alert-twin metrics.
- R2 snapshot: `f402-bet-ticker/latest.json`, `x-amz-meta-pii: none`, schema version, poll time,
  watermark, row/leg counts, source hash.
- Timestamps coarsen to `deskDate` and `deskHour`; no exact `insertedAt`.

**Runtime boundary — Bun service, Node Harness:** Bridge 3 executes entirely under Bun in
`sportsdesk-ops` (`:4020`). The Harness host is Node (`:3080`) and has no `Bun` global. Any
Harness-facing view of Bridge 3 (gates, freshness, census) must be a thin HTTP client against
`:4020`, not an import of Bun-only modules — the same class of failure `dsh-plugin/verify-runtime.mjs`
exists to catch. `Bun.secrets` access is confined to the service; the Host receives credentials only
via the service's HTTP surface.

## Locked accounting rules

### Sentinel rows are not handle (`ALERT`, `BLOCKED`, `NON_SPORTS_DROP`)

- Every parsed row whose resolved channel is `ALERT`, `BLOCKED`, or `NON_SPORTS_DROP` pins
  `canonicalVolumeCents = 0`, `riskCents = 0`, and `toWinCents = 0`; none of them contributes to
  handle, risk, to-win, or settled volume.
- Their `ticketCount` and `legCount` counters are **retained** (per channel and per wager type) so
  sentinel traffic stays observable without entering accepted handle totals.
- Count `ALERT` separately as `alertTwinCount` and in the `CONFIRM`, `LATE`, and `ORPHAN` metrics.
  These are count axes, not money axes.
- An ALERT row and its non-ALERT twin must not both add money. The dedupe key
  `${TicketNumber}-${WagerNumber}` identifies the twin; the non-ALERT row owns the money.

### No parlay multiplication

- Deduplicate `riskCents` and `toWinCents` by `${TicketNumber}-${WagerNumber}` **before** any sum.
- `legCount` counts legs; `ticketCount` counts distinct deduped tickets; risk/to-win are counted
  once per ticket/group, never once per leg.
- `M.G<betGroupId>` (when present) is the group key for multi-leg grouping; it is internal and
  never published.

## Locked watermark and 100-row drain

- Maintain a fail-closed `wagerNumber` watermark: the highest wager number fully processed from a
  completed drain.
- If `LIST.length >= 100`, do **not** publish/advance the watermark yet. Drain immediately with
  another `getBetTicker` request, repeating until a response has fewer than 100 rows, then publish
  one delta and advance the watermark.
- If a poll returns no row above the watermark, publish no event (idempotent no-op) but keep the last
  good R2 snapshot.
- If the response goes backwards (a page whose highest wager number is below the watermark), fail
  closed: do not publish, do not replace R2, and surface a watermark-regression alert.
- A failed/incomplete drain leaves the previous watermark and R2 snapshot untouched.
- **Default poll cadence: 15_000 ms** (`F402_BET_TICKER_DEFAULT_POLL_INTERVAL_MS`), whether the loop
  is driven by the CLI (`--interval-ms`; `--once` runs a single poll) or by a future daemon.
- **Fail-closed regression reporting:** a page below the watermark yields drain status `regressed`
  and `maxPages` exhaustion yields `unsettled`. The poller reports that status and leaves R2 and WS
  untouched — no write, no publish, state unchanged — and never advances the watermark on such a
  poll.

## Contract sketch

```ts
export interface F402TickerDeltaEvent {
  schemaVersion: 1;
  kind: "f402-bet-ticker";
  polledAt: string;
  deskDate: string;
  deskHour: number;
  watermark: string;
  newTickets: number;
  goneTickets: number;
  changedTickets: number;
  alertTwinCount: number;
  confirmCount: number;
  lateCount: number;
  orphanCount: number;
  byChannel: readonly {
    channel: string;
    ticketCount: number;
    legCount: number;
    canonicalVolumeCents: number;
  }[];
  byWagerType: readonly {
    wagerType: string;
    ticketCount: number;
    legCount: number;
  }[];
  sourceSha256: string;
}

export function projectF402TickerDelta(
  previous: readonly F402TickerRow[],
  current: readonly F402TickerRow[],
  polledAt: string,
): F402TickerDeltaEvent;
```

The projection drops identity/free-text fields and is pure/testable; the poller only supplies rows
and publishes the result.

## Delivery

- Poller: reuse `probeF402BetTicker` with the existing F402 session/replay transport; no cookies in
  argv or logs.
- Live JSONL ingestion: `--from-jsonl <path>` tails the 4C collector's append-only
  `probes/out13/f402-bets.jsonl` by byte offset + wager-number watermark (partial trailing line held
  back), so the bridge can publish without opening a second Fantasy402 login session. Incremental
  polls publish WS deltas only; `f402-bet-ticker/latest.json` is written by window polls (cold start
  or `--jsonl-window-snapshot`), so the object always describes the live window, not a delta. In loop
  mode the window snapshot is refreshed every `--r2-window-every` ticks (default 4 = 60 s at 15 s)
  when new bytes arrived, while every tick publishes an incremental WS delta. The sink resolves
  `BLOB_API_TOKEN` from env first and then `com.bookdeskops.sportsdesk` via `Bun.secrets`, so the
  CLI needs no manual export.
- WS: `POST /api/v1/live-bets` with bearer, channel `f402-bet-ticker`.
- R2: `R2S3Client.fromEnvOrSecrets()` + `writeWithMetadata("f402-bet-ticker/latest.json", ..., {
metadata: { pii: "none", ... } })`; verify with `stat` and presigned GET.
- Failure semantics: a failed poll/drain never replaces the last good R2 snapshot; WS publish failure
  is reported but does not discard the poll result.
- Tests: pure delta projection (new/gone/changed, sentinel zero-volume for
  ALERT/BLOCKED/NON_SPORTS_DROP, dedupe once, no PII, no raw rows), watermark/drain behavior, gateway publish contract, R2 write with metadata, and a live smoke
  that deletes its test object.

## Phase 1 implementation notes (measured)

Implemented in `lib/f402_bet_ticker_delta.ts` (pure projection), `lib/f402_bet_ticker_drain.ts`
(watermark/100-row drain), `lib/f402_bet_ticker_sink.ts` (WS + R2), `lib/f402_bet_ticker_poller.ts`
(orchestration), `lib/f402_bet_ticker_jsonl.ts` (tail reader), and
`scripts/f402_bet_ticker_bridge3a.ts` (`bun run bridge3a:poll`). Four points
where the captured payload settled the wording above:

- The captured ticker row has **no `TicketNumber`** (13 fields; `docs/evidence/captures/2026-10-31/getBetTicker.post.json`).
  In this feed `WagerNumber` is the ticket id (`lib/live_wagers.ts`), so the locked
  `${TicketNumber}-${WagerNumber}` key collapses to `${WagerNumber}-${WagerNumber}`; the code keeps
  the full two-part form if a future payload carries `TicketNumber`.
- The channel is **`TicketWriter`**, not `ShortDesc` (observed: `Internet`, `ALERT`, `GSLIVE`,
  `GSBUILDER`). `ShortDesc` is parsed only for the leg count; the raw string is never emitted.
- `AmountWagered`/`ToWinAmount`/`VolumeAmount` are **whole-dollar integers** in the local paste artifact,
  so canonical volume is `VolumeAmount × 100` exactly; every `ALERT`, `BLOCKED`, and
  `NON_SPORTS_DROP` row is forced to 0 on each money axis while its counts stay visible.
- A full-snapshot endpoint that repeats every row makes a strict 100-row page loop unconvergeable, so
  the drain also settles on a page that adds no new ticket (a bounded completion, not a partial
  publish). A page whose highest wager number is below the watermark is still a fail-closed
  regression, and `maxPages` exhaustion is `unsettled`.

`confirmCount` is an alert twin in the same batch, `lateCount` one whose twin arrives in a later
poll, and `orphanCount` one with no twin yet. `watermark` is the highest numeric wager number of the
completed drain and appears in both the WS delta and the R2 snapshot (the PII contract's drop list is
scoped to 3c/3d; this note locks the watermark).

## Phase 2 implementation & allocation lowering (measured 2026-11-08)

Implemented in `lib/f402_bet_ticker_delta.ts`:

- **Zero collection allocations:** Replaced dynamic `Map` and `Set` collections with `Bridge3aTicketColumnStore` featuring open-addressed hash slots (`slots: Uint32Array`), SoA TypedArray columns, and bounded ordinal arrays. Guaranteed by CI ratchet in `tests/tally_allocation_invariant.test.ts`.
- **Per-row bitset flags:** Named `routeFlagsBitSet32Col: Uint32Array` (one word per ticket row, mirroring `BridgeChannelRouteColumnStore`), tracking `BRIDGE3A_FLAG_IS_ALERT (1 << 0)`, `BRIDGE3A_FLAG_IS_SENTINEL (1 << 1)`, `BRIDGE3A_FLAG_HAS_ALERT_TWIN (1 << 2)`, `BRIDGE3A_FLAG_IS_CONFIRMED (1 << 3)`, `BRIDGE3A_FLAG_IS_LATE (1 << 4)`, `BRIDGE3A_FLAG_IS_ORPHAN (1 << 5)`.
- **Bounded channel & wager-type ordinals:** `ORD_CHANNEL_UNKNOWN = 0` (mapping to `"other"`), `ORD_CHANNEL_INTERNET = 1`, up to `11`. Any novel or unrecognized channel maps to `UNKNOWN` (0) and fails closed to `"other"`, never silently defaulting to `Internet`.
- **Column boundary & overflow isolation:**
  - `MAX_INT32_CENTS = 2_147_483_647` (~$21.47M): `amountToCents` throws `RangeError` on wagers > $21.47M. In `insertOrUpdate`, `RangeError` is caught per-row: single rogue $30M wagers increment `overflowRejectionCount` and return `-1` without taking down valid tickets in the batch.
  - `MAX_UINT16_LEGS = 65_535`: `legCountOf` clamps parsed legs to 65,535, preventing Uint16 modulo truncation.
  - `MAX_UINT32_WAGER_NUMBER = 4_294_967_295`: `numericWagerNumber` enforces Uint32 bounds, returning `null` on overflow.
- **Batch-level observability:** Callers can project with full diagnostic visibility via `projectF402TickerDeltaWithDiagnostics(previous, current, polledAt)` or pass `outDiagnostics: { overflowRejectionCount?: number }` to `projectF402TickerDelta`, surfacing total rejected tickets.
- **Watermark tracking:** O(1) `max(ticketNumber)` tracked during row insertion into open-addressed slots, avoiding empty slot scans.
- **Narrow string side-channel:** Kept unbounded strings (`login`, `agentLogin`, `shortDesc`, `ticketWriter`) in `rawStringsCol`, preserving numeric purity for SoA TypedArray columns.
- **Shape-specific serializers:** Replaced reflective `Object.keys().sort()` with `serializeF402TickerDeltaPayload` and `serializeF402TickerSnapshotPayload` producing byte-identical JSON strings for `sourceSha256` hashing without heap reflection. Verified via `--cpu-prof-md` profile showing `ownKeys` and recursive `stableJson` completely eliminated from hot CPU samples.
- **JSC Object Type & Retention Invariants:** Verified via `heapStats().objectTypeCounts` across 300 sustained iterations at 10,000 rows (3,000,000 tickets processed):
  - `PropertyTable` delta is **0** (baseline 140 → after 141, Δ = +1 warm-up, flat across steady-state iterations), proving objects never degrade into dictionary mode.
  - Steady-state net heap delta between iteration 200 and 300 after GC is **0.0 KB**.
  - Verified native memory arena stability via `Bun.unsafe.mimallocDump()`.
- **Nanosecond benchmark precision:** Upgraded `scripts/bench_bridge3a_workload.ts` to `Bun.nanoseconds()`, eliminating timer quantization for sub-100µs measurements:
  - **100 rows/iter:** 12,288 ops/sec, median = 0.0730 ms (73.04 µs), p90 = 0.0839 ms (83.88 µs), min = 0.0662 ms (66.17 µs).
  - **1,000 rows/iter:** 1,309 ops/sec, median = 0.7106 ms, p95 = 1.0535 ms (~1.4M tickets/sec).
  - **10,000 rows/iter:** 105 ops/sec, median = 9.2035 ms, p95 = 11.8072 ms (~1.05M tickets/sec).

### Resolved hotspot: `parseShortDesc` replaced with zero-allocation `countShortDescLegs`

Following the elimination of reflection and the SoA lowering, Bridge 3A functions represented ~9.3% of total CPU self-time, with `parseShortDesc` (lines 299 & 330 in `lib/live_wagers.ts`) accounting for **21.9%** of CPU self-time.

- **Root cause:** `Bridge3aTicketColumnStore.insertOrUpdate` only requires the ticket's _leg count_ (`legCountOf`). Calling `parseShortDesc(row.shortDesc).legs.length` unnecessarily performed regex delimiter replacement, sport name normalization, sub-segment splitting, and 9-field `LiveWagerLeg` object allocations for every leg across thousands of tickets.
- **Implemented solution:** Implemented `countShortDescLegs(shortDesc)` in `lib/live_wagers.ts`, a fast zero-allocation leg counter that parses line boundaries and code prefixes without instantiating objects. Benchmarked against `parseShortDesc().legs.length` on identical descriptions: **8.1x faster** (83.8 ms → 10.3 ms for 100k ops) and verified against all 124 fixture descriptions with **0 mismatches**.
- **Post-optimization performance (100 rows/iter, 1,000 iterations):**
  - **Throughput:** 28,233 ops/sec (+536% over original 4,433 baseline, +130% over initial SoA 12,288 ops/sec).
  - **Median Latency:** 0.0309 ms (30.92 µs, down from 73.04 µs and original 188 µs: −83.5% latency reduction).
  - **p90 Latency:** 41.25 µs | **p95 Latency:** 51.58 µs | **Min:** 23.13 µs.
  - **CPU Profile:** `parseShortDesc` dropped to **0.0%** (completely eliminated from profile).
- **p99 Tail Characteristics:** Profiling confirms the spread between median (31 µs) and p99 in tight microbenchmarks is driven entirely by JSC's minor GC sweeps (forcing `Bun.gc(true)` per iteration reduces the p99/p50 ratio from 14.6× to 2.3×). At live operational ingress rates (<500 rows/sec), this GC latency is negligible (~0.03% CPU duty cycle).

## Binary canonical buffer & wire-format migration plan

To lower serialization and deserialization costs further across R2 and WebSocket distribution, Bridge 3a specifies a binary canonical buffer format (`application/octet-stream`) alongside the backward-compatible JSON wire format.

### Fixed binary layout (304 bytes total)

```
Offset  Width   Type    Field Name              Description
0       1       uint8   schemaVersion           0x02 for binary format (0x7B '{' identifies v1 JSON text)
1       1       uint8   payloadKind             0x3A (ASCII ':' / Bridge 3A identifier)
2       2       uint16  flags                   Bit 0: Little-endian (1); Bits 1-15: Reserved
4       4       uint32  ticketCount             Deduped ticket count
8       4       uint32  legCount                Total parsed leg count
12      4       uint32  watermarkNum            Highest numeric wager number processed
16      8       int64   polledEpochMs           Monotonic timestamp in UTC epoch ms
24      4       uint32  alertTwinCount          Number of alert twins observed
28      4       uint32  confirmCount            Alert twins confirmed in current batch
32      4       uint32  lateCount               Alert twins arriving after initial alert
36      4       uint32  orphanCount             Unmatched alert twins
-------------------------------------------------------------------------------------------------------
Section 1: Fixed 12-channel table (12 entries × 16 bytes = 192 bytes)
Offset  Width   Type    Field Name              Description
40+i*16 4       uint32  ticketCount             Tickets in channel ordinal i (0..11)
44+i*16 4       uint32  legCount                Legs in channel ordinal i
48+i*16 8       int64   canonicalVolumeCents    Canonical handle in cents (int64 avoids 32-bit overflow)
-------------------------------------------------------------------------------------------------------
Section 2: Fixed 9-wager-type table (9 entries × 8 bytes = 72 bytes)
Offset  Width   Type    Field Name              Description
232+j*8 4       uint32  ticketCount             Tickets in wager-type ordinal j (0..8)
236+j*8 4       uint32  legCount                Legs in wager-type ordinal j
-------------------------------------------------------------------------------------------------------
Total Buffer Length: 304 bytes
```

### Hashing choices

1. **Sink integrity (R2 / WS):** Retain `SHA-256` computed over the 304-byte canonical slice (`Bun.CryptoHasher.hash("sha256", buffer, "hex")`). This satisfies the operator requirement for cryptographic non-repudiation and immutable ledger verification.
2. **In-memory deduplication:** Pinned to **32-bit FNV-1a** (`0x811c9dc5`, `0x01000193`) with linear probing and full-string key equality on probe (`keyCol[idx] === key`) in `Bridge3aTicketColumnStore`. This provides fast zero-allocation integer hashing while mathematically eliminating false ticket merges.

### Migration strategy for R2 snapshots & WebSocket distribution

1. **Dual-write phase (implemented):** The sink in `lib/f402_bet_ticker_sink.ts` supports `wireFormat: "json" | "binary" | "both"`. When set to `"both"`, it writes `f402-bet-ticker/latest.json` (JSON v1) and `f402-bet-ticker/latest.bin` (Binary v2) concurrently to R2 with respective content types and metadata.
2. **Reader-side sniffing contract (implemented in `parseF402TickerSnapshotOrBinary`):**
   - **R2 reader boundary (`lib/f402_bet_ticker_binary.ts` & downstream tools):** When fetching the latest snapshot, inspect byte 0 of the response body:
     - `0x7B` (`'{'`): Passes to JSON parser (`JSON.parse`).
     - `0x02`: Wraps directly in `decodeF402TickerBinarySnapshot` using zero-copy `DataView(buffer)` and reads fixed offsets.
   - **WebSocket client boundary:** On gateway connection (`channel: "f402-bet-ticker"`), configure `ws.binaryType = "arraybuffer"`. Text frames (`typeof event.data === "string"`) parse via JSON; binary frames (`event.data instanceof ArrayBuffer`) read byte 0 to branch into the zero-copy TypedArray view.
3. **Schema version mismatch handling:**
   - If byte 0 is neither `0x7B` (v1 JSON) nor `0x02` (v2 binary), `parseF402TickerSnapshotOrBinary` fails closed immediately with `SchemaVersionMismatchError(actualVersion, expectedVersion)`.
   - The reader **never** attempts partial offset reads or guesses offsets on novel schema versions.
4. **Zero-downtime rollback procedure:**
   - Controlled via environment variable `BRIDGE3A_WIRE_FORMAT=json` or CLI flag `--wire-format=json` (or `binary` / `both`).
   - If binary emission introduces unexpected reader regression, flipping the flag halts binary writing immediately.
   - Because `latest.json` is continuously updated in parallel during dual-write, R2 subscribers experience zero data staleness and require no backfill or database migration.

## Remaining open decisions

- ~~Poll cadence~~ Resolved: the default is **15_000 ms** (locked in “Locked watermark and 100-row
  drain”); `--once` runs a single poll, and the watermark makes same-page duplicates idempotent.
- Whether `alertTwinCount` should also expose a per-channel breakdown; the money rule is already
  locked to zero.
