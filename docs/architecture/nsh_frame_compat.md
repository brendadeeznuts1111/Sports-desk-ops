# NSH frame compatibility contract

**Scope:** the 64-byte binary ticker-match frame in `lib/nsh_frame_codec.ts` / `lib/nsh_frame_schema.ts`.
**Status:** decided 2026-11-12. Measurements below were taken on this checkout, Bun 1.4.4.

## 1. Inventory

| Direction | Site                                                                    | Kind                                          |
| --------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| Producer  | `NshFrameWriter` / `packNshBinaryFrame` / `packRouteEnvelopeToNshFrame` | library constructors only                     |
| Consumer  | `lib/sportsdesk_mcp_server.ts` — `decode_nsh_frame`                     | hex/base64 → decoded fields + `layoutOffsets` |
| Consumer  | `lib/bridge_and_channel_router.ts:1073`                                 | type-only import                              |
| Consumer  | `tests/nsh_frame_codec.test.ts`, `tests/nsh_frame_evidence.test.ts`     | contract tests                                |

There is **no in-tree publisher**: nothing calls `broadcastFrame`, nothing publishes on `nsh_blotter`, and no service constructs a frame. `services/blob_and_live_bets_server.ts` publishes JSON, not frames.

## 2. Persistence

No frame is written to disk, to R2, or to a replay corpus. Searched: `*.bin` / `*.frame` / `*.pcap` / `*.hex` across the repo (three unrelated `.bin` artifacts: syntax highlighting, schema manifests, a scratch feed), and `nsh` in `lib/r2_*` / `services` (no hits).

**Consequence:** the version byte `0x06` has never been issued. Reusing it is allowed — a version byte is only spent once a writer ships. The rule from here:

> The first commit that ships a frame producer issues `0x06`. After that, any change to the byte layout requires `0x07`, and a v6 reader must keep accepting v6 frames for one release window.

Freeze date for this decision: 2026-11-12. Rollback is `git revert` of one commit; there is no stored data to migrate.

## 3. Layout

Single source of truth: `NSH_FRAME_FIELD_SPEC` in `lib/nsh_frame_schema.ts`. `NSH_FRAME_LAYOUT`, the writer, the reader, the MCP layout map and this table all derive from it, and `buildFrameLayout` fails at import if the fields do not tile `0..63`.

| Offset | Field                 | Type | Decision                                       |
| ------ | --------------------- | ---- | ---------------------------------------------- |
| 0      | `HEADER_MAGIC`        | u8   | carry                                          |
| 1      | `HEADER_VERSION`      | u8   | carry (`0x06`)                                 |
| 2      | `HEADER_MSG_TYPE`     | u8   | carry                                          |
| 3      | `HEADER_RESERVED`     | u8   | carry, must be 0                               |
| 4      | `PACKED_HANDLE_32`    | u32  | carry: channel(4) · sla/10ms(8) · rowIndex(20) |
| 8      | `BET_GROUP_ID_64`     | u64  | carry                                          |
| 16     | `STAKE_USDC`          | f64  | carry — see §5                                 |
| 24     | `BOOK_ODDS`           | f64  | carry                                          |
| 32     | `POLY_AVG_PRICE`      | f64  | carry                                          |
| 40     | `LIABILITY_DELTA`     | f64  | carry                                          |
| 48     | `TIMESTAMP_EPOCH_MS`  | u64  | carry                                          |
| 56     | `ORIGIN_DOMAIN_8`     | u8   | **carry** (replaces RGB R)                     |
| 57     | `WRITER_LANE_8`       | u8   | **carry** (replaces RGB G)                     |
| 58     | `RESERVED_8`          | u8   | **reserved** (replaces RGB B)                  |
| 59     | `FLAGS_BIT_SET_16`    | u16  | carry                                          |
| 61     | `SLIPPAGE_BPS_8`      | u8   | carry                                          |
| 62     | `RESERVED_PADDING_16` | u16  | carry, must be 0                               |

Byte arithmetic: `4 + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 2 + 1 + 2 = 64`. No field was added; the RGB24 provenance colour was retired, spending its three bytes on origin (1), writer lane (1), reserved (1).

## 4. Why origin is carried rather than derived

Measured from `TRANSPORT_BRIDGE_SPECIFICATION_TABLE` × `SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE` (permitted pairs only): **10 bridges, 16 channels, 52 permitted pairs.**

- Origin is a function of the **bridge ordinal**: 0 bridges map to more than one origin.
- Origin is **not** a function of the channel alone: 8 of 16 channels are reachable from two or three origins (4, 5, 6 across F402/Partner 118; 11–15 across Polymarket/Kalshi).
- The packed handle carries the channel but **drops the bridge ordinal**, and has no spare bits.

So a reader holding only the current handle cannot recover origin. Carrying it at byte 56 is the correct minimal fix. Wire ids are `1..6`; `0` (`UNSET`) is rejected on the wire so an unscoped frame cannot decode.

**Open decision, deliberately not taken here:** steal 4 bits of `rowIndex` to carry `bridgeOrdinal4` in the handle, then derive origin and free byte 56. Measured `rowIndex` maxima are 91 rows (ticker) and 169 rows (live bets) — 168 observed, against a 20-bit ceiling of 1,048,575, i.e. ~6,200× headroom. That change re-lays the handle and needs its own version bump; it is not smuggled into this one.

## 5. Money is float64, not fixed point

`STAKE_USDC`, `BOOK_ODDS`, `POLY_AVG_PRICE` and `LIABILITY_DELTA` are IEEE-754 doubles. The repo's convention is integer minor units (`Cents`, `asCents()`), and NAMING-GATE-01 rejects float arrays on `Cents`/`BasisPoints` columns.

Measured over the real corpus (`data/live-wagers.json`, 91 wagers → 182 values):

- `AmountWagered` range 800–50,000 cents ($8.00–$500.00), 33 distinct stake values.
- `round(float64(cents / 100) * 100)` recovers the original cents for **182/182 values, worst error 0**.
- Implied decimal odds 0.2710–73.3453 are exactly representable.

Verdict: **carry for this change, labelled as debt.** The format is exact for the desk's current domain (≤ 2 decimals, ≤ $500) but is a convention violation and would lose precision at micro-USDC scale or beyond 2^53 cents. Converting to `i64` micro-USDC changes 32 bytes and belongs in its own version with its own migration, not in a provenance change.

## 6. N-1 matrix

| Input                                 | Result                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| v5 frame                              | `ERR_FRAME_V5_DEPRECATED`                                                |
| pre-change v6 frame (RGB24 in 56..58) | `invalid_origin_domain` — fails closed, never decodes to a plausible row |
| version 7                             | `invalid_version: unsupported NSH frame version 7`                       |
| 63 bytes                              | `short_frame`                                                            |
| dirty byte 58 or 62..63               | `invalid_reserved`                                                       |

## 7. Evidence index

| Artifact                       | Where                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 3 golden frames + SHA-256 lock | `tests/fixtures/nsh_frames/*.hex`, `golden.lock.json`                                                    |
| Regenerate / verify            | `bun scripts/nsh_frame_golden.ts [--write]`                                                              |
| Independent Python decoder     | `tests/fixtures/nsh_frames/reference_decoder.py`                                                         |
| Differential run               | `bun scripts/nsh_frame_differential.ts 500` → 500 frames, 7,000 comparisons, 0 divergences               |
| Evidence suite                 | `tests/nsh_frame_evidence.test.ts` — 28 tests, 15,144 assertions                                         |
| Reader cost                    | 46.4 ns/frame; heap delta 8,320 B over 200,000 `readNshBinaryFrameInto` decodes (0.04 B/frame, GC noise) |
