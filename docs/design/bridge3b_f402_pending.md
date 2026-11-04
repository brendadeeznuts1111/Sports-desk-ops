# Bridge 3b — Fantasy402 Pending Bets (design, no implementation)

Status: **design only.** WS `f402-pending`; R2 `f402-pending/latest.json`. Source:
Fantasy402 `Manager/getPending` / `Report/Pending` open liability. Shared contracts:
[`pii_sanitization.md`](./pii_sanitization.md), [`stream_map.md`](./stream_map.md),
[`lib/bun_shapes.ts`](../../lib/bun_shapes.ts).

## Section 1 — Data-Oriented Design grounding and empirical census

Data-Oriented Design starts from measured layouts and transformations, not speculative object
hierarchies: Richard Fabian, [Data-Oriented Design (2018)](https://www.dataorienteddesign.com/dodbook/);
Mike Acton, [CppCon 2014](https://www.youtube.com/watch?v=rX0ItVEVjHc). The target is
cache-contiguous Structure-of-Arrays columns sized from the census below.

**Census source:** `docs/evidence/captures/2026-11-01/Pending.post.json` (body skeleton),
`tests/f402-pending-wager-sample.json` (46-field sample), `tests/fixtures/pending-panel-datatables-2026-11-03.html`
(8 display columns, 8 rows), `data/live-bets.json` (`pendingCount: 2`).

| Census metric                                       | 3b observation                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire fields                                         | **73** (`truncated: true` skeleton); **21 nullable / 52 required**                                                                                                                                                                                                                                                                                                                                             |
| Actual committed full row                           | none; 46-field sample and 8-column panel are the only row-bearing fixtures                                                                                                                                                                                                                                                                                                                                     |
| Nullable wire fields                                | `ARBirdcageLink`, `ARLink`, `AmountLost`, `AmountRefunded`, `AmountWon`, `BoxLink`, `ContinueOnPushFlag`, `FinalDecimal`, `ListedPitcher1`, `ListedPitcher2`, `RifBackwardTicketNumber`, `RifBackwardWagerNumber`, `RifForwardAmountWagered`, `RifForwardTicketNumber`, `RifForwardWagerNumber`, `RifForwardWinOnlyFlag`, `RifNoActionFlag`, `RifWinOnlyFlag`, `RoundRobinLink`, `TeaserName`, `TotalPointsOU` |
| Malformed/empty rates                               | not measurable on the 73-field body (not committed); sample fields present and non-null; panel has 8×8 cells                                                                                                                                                                                                                                                                                                   |
| `C_max` ticket / group                              | **2** observed tickets (`data/live-bets.json`), 2 groups                                                                                                                                                                                                                                                                                                                                                       |
| Leg fanout                                          | P50=1, P95=1, P99=1, P99.9=1, **P100=1**                                                                                                                                                                                                                                                                                                                                                                       |
| Identifier alphabet bitmask (`Login`, `customerID`) | **5** = `A-Z` bit0 + `0-9` bit2; max byte length **5**; no `_ . @ -`, no non-ASCII                                                                                                                                                                                                                                                                                                                             |
| DGS rotations                                       | sample `Team1RotNum=243`, `Team2RotNum=244`; no 5000–5999 rows observed; protocol bound 20 bits, `0..1,048,575`                                                                                                                                                                                                                                                                                                |
| Ticket/Wager numeric widths (sample)                | TicketNumber **30 bits**; WagerNumber **1 bit**; rotations **8 bits**; no 5000-range row                                                                                                                                                                                                                                                                                                                       |
| Adj/teaser fields                                   | `AdjSpread`, `AdjTotalPoints`, `OrigSpread`, `OrigTotalPoints` present numeric; `TeaserPoints` absent in sample; no float-safe guarantee on wire                                                                                                                                                                                                                                                               |
| Enum populations (observed)                         | WagerType `S`; WagerStatus `P`; FreePlayFlag `N`; Outcome `P`; periods `Game`/`2nd Half`; sports Football/Soccer; sub-sports NFL/ENG PREM                                                                                                                                                                                                                                                                      |

Alphabet bitmask convention: bit0 `A-Z`, bit1 `a-z`, bit2 `0-9`, bit3 `_`, bit4 `.`, bit5 `@`,
bit6 `-`, bit7 non-ASCII, bit8 other printable.

## Section 2 — Census-derived SoA layout, allocation boundary, overflow

- **C_max=2**, but the 73-field wire and panel fixtures justify a fixed table floor. Radix size:
  `2^k >= 4 × C_max`; with the floor `2^12`, `k=12` (4,096 probes) for 3b.
- **Identifier hashing:** stream raw UTF-8 byte spans into FNV-1a-64, trimming ASCII `0x20` at the
  edges without allocating a `.trim()` substring. Observed alphabet bitmask 5 fits in raw bytes;
  no Base-40 packing is used (no allocation/decoding benefit for a 5-byte identifier).
- **SoA store (contiguous, fixed capacity):**
  ```text
  packedCellKeyCol: Uint32Array
  ticketCountCol: Uint32Array
  legCountCol: Uint32Array
  riskCentsCol: BigInt64Array
  settledNetCentsCol: BigInt64Array
  definedLiabilityCentsCol: BigInt64Array
  clvSumLineHundredthsCol: BigInt64Array
  clvEligibleLegCountCol: Uint32Array
  cellFlagsBitSet: Uint32Array
  ```
- **Memory invariant:** zero collection-heap allocations on the aggregation path. No `Map`, `Set`,
  `boolean[]`, or dynamic `T[]` resizing. Column capacities are allocated once from `C_max` and the
  radix table; the only growth is the preallocated arena.
- **Inline legs:** `InlineCapacityList<LegSlot, 8>`; census P100=1, so 8 slots have 8× headroom.
  If a ticket exceeds 8 legs, use the bounded overflow slab (64 slots) and increment
  `overflowTicketCount`; if the slab is exhausted, fail closed via GATE-05. Never drop a leg or
  reject a valid ticket silently.
- **Radix table:** 4,096 entries, load factor `C_max / 4096 ≤ 0.25`; a probe hit re-checks the full
  64-bit key (GATE-01/02).

## Section 3 — Fixed-point accounting and cross-system reconciliation

Branded integers only: `Cents`, `SettledCents`, `BasisPoints`, `LineHundredths`,
`RotationNumber`; no IEEE-754 floats.

- **Rotation:** validate 20-bit `0..1,048,575`; if `5000..5999`, `rotation -= 5000` (Alt-Spread);
  never `rot & 0xFFFF`. Strip `Period`/`Live` prefixes before comparison.
- **Effective lines:** parse `AdjSpread`, `AdjTotalPoints`, `TeaserPoints` to `LineHundredths`
  (`×100`, round once, reject non-finite). `sideSign = +1` for team1, `-1` for team2;
  `effectiveSpread = adjSpread ± teaser`; totals flip sign for Over vs Under. Store the bounded
  `over|under` and `home|away` tags in `cellFlagsBitSet`.
- **Dedupe:** `${Login.trim()}|${WagerNumber}|${TicketNumber}`; first occurrence of
  `${TicketNumber}-${WagerNumber}-${totalPicks}` wins. `totalStakeCents` and
  `potentialPayoutCents` once per parent; `definedLiabilityCents = potentialPayoutCents` (gross
  worst-case payout; `netExposureCents = max(payout-stake,0)` diagnostic only).
- **Conservation:** `sum(visible.metric)+suppressedResidual.metric === rawDedup.metric` for
  ticketCount, legCount, stake, payout, liability.
- **Reconciliation (3c ↔ 3b/3d):** `3c.openExposureCents == 3b.definedLiabilityCents` for the
  GSLIVE+GSBUILDER slice, after the three divergence buckets: desk-date/UTC boundary,
  widget-rejected/cancelled, unsettled cross-window carry. Residual beyond tolerance fails GATE-08.

## Section 4 — Complete GATE-01..08 catalog

| Gate                                               | Requirement                                                                                                               | 3b external arbiter / check                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| GATE-01 RotationAndDomainBounds                    | rotations 0..1,048,575, no 16-bit masking; full 64-bit key on radix hit                                                   | pending wire + DGS rotation census             |
| GATE-02 UnsignedHandleAndKeyIntegrity              | keys in Uint32Array/BigUint64Array; load factor ≤0.25                                                                     | `assertNoSignedHandleArrays()`                 |
| GATE-03 ExternalControlTotalAndSdcConservation     | visible+suppressed ≡ **external** control; deduped parents ≡ vendor ticket count; k=5 + sibling suppression; SDC sign-off | `Report/Pending` summary header / Mode 9 total |
| GATE-04 InProcessKeyContainment                    | no PackedKey64, M.G, ticket/wager, Login-derived value in serialized output at any depth                                  | `assertNoPersistedHandleKeys()`                |
| GATE-05 WireAndArtifactSchemaBounds                | <256 KiB, BOM stripped, `x-amz-meta-pii: none`, no PII/IP/login regex, overflow slab bounded                              | `assertSanitizedRollupArtifact()`              |
| GATE-06 FixedPointAndSentinelAlgebra               | zero floats, explicit null sentinels, settled-only ROI denominator                                                        | projection serializer                          |
| GATE-07 FreePlayPolicySigned                       | 2×2 FreePlay matrix signed before enabling stream (3d merge-blocker; 3b only counts flags)                                | Finance/Accounting memo                        |
| GATE-08 TemporalCutoffAndCrossSystemReconciliation | 3c↔3b/3d identity and fail-closed R2 pointer preservation                                                                 | reconciliation report                          |

**DodGateFailureError payload (all gates):**

```ts
new DodGateFailureError({
  gate: 1..8,
  gateName: string,
  streamId: "f402-pending",
  cells: number[],          // cell indices, never values
  varianceCents: bigint,
  rowCountDelta: number,
  controlSource: string,    // named external arbiter
});
```

FreePlay is counted (`freePlayLossRows`, `freePlayUnknownRows`) but its money policy is governed by
GATE-07 and is not enabled here.

## Section 5 — Risk, reversal, and falsification matrix

| Trigger                                     | Structural change                                                       | Fail-closed behavior                                          |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| P100 > 8 legs                               | overflow slab used; if >64, increase N/arena only via reviewed design   | GATE-05 abort, no R2 write                                    |
| C_max > 4,096                               | resize radix to next `2^k ≥ 4×C_max`                                    | GATE-02 load-factor abort before write                        |
| Identifier alphabet gains `_ . @`/non-ASCII | hashing remains byte-span FNV-1a-64; revisit only if >2,048-byte values | GATE-05 value bound                                           |
| GATE-03 external totals fail                | report variance, do not write                                           | `writeWithMetadata` aborted; existing `latest.json` untouched |
| Gate-07 unsigned                            | 3d blocked; 3b may publish counts only                                  | merge-blocked                                                 |
| Sign-off checklist                          | Engineering/CI GATE-01..08; Finance GATE-07; Compliance/SDC GATE-03     | required before public R2 enable                              |

Tests must use raw fixtures only through aggregate assertions; no stdout rows or PII values.
