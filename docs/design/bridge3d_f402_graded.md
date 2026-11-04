# Bridge 3d — Fantasy402 Graded / Settled (design, no implementation)

Status: **design only.** Batch snapshot `f402-graded/<YYYY-MM-DD>/rollup.json` plus
`f402-graded/latest.json` pointer. Source: Fantasy402 `Report/getGrading` through
`lib/f402_graded_wager_row.ts`. Shared contracts: [`pii_sanitization.md`](./pii_sanitization.md),
[`stream_map.md`](./stream_map.md), [`lib/bun_shapes.ts`](../../lib/bun_shapes.ts).

## Section 1 — Data-Oriented Design grounding and empirical census

Data-Oriented Design transforms the actual graded-row layout, not a speculative class tree:
Richard Fabian, [Data-Oriented Design (2018)](https://www.dataorienteddesign.com/dodbook/); Mike
Acton, [CppCon 2014](https://www.youtube.com/watch?v=rX0ItVEVjHc).

**Census source:** four `tests/fixtures/f402-graded-wager-row*.html` files parsed by the production
parser, plus `data/graded-wagers-export-2026-11-01.json` (metadata only).

| Census metric                  | 3d observation                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixture files / rows           | 4 files / **7 rows**                                                                                                                             |
| Parsed fields                  | **22**                                                                                                                                           |
| Nullable fields                | `team1`, `team2`, `line`, `price`, `league`, `market`, `score`, `scheduled` (2 nulls each; `G` rows only)                                        |
| `C_max` distinct ticket        | **6** across the four files (7 rows, one ticket duplicated across fixtures)                                                                      |
| TicketNumber range / bit width | **1,072,619,695..1,074,340,989**, **31 bits**                                                                                                    |
| Wager suffix range / bit width | **1..1**, **1 bit**                                                                                                                              |
| Multi-leg fanout               | P50=1, P95=1, P99=1, P99.9=1, **P100=2** (fixture overlap, not a multi-leg ticket); actual max legs **1**                                        |
| Status classes                 | Win 3, Won 1, Lost 1, Loss 1, Canceled 1                                                                                                         |
| WagerType populations          | S 2, E 1, G 2, M 1, T 1                                                                                                                          |
| PlacedOn                       | Internet 5, Mobile 1, Desktop 1                                                                                                                  |
| `riskCents` / `winCents` zero  | 0 / 0                                                                                                                                            |
| Identifier alphabet            | **no Login field** in graded HTML; join identity is absent from the raw fixture                                                                  |
| FreePlayFlag                   | **absent from every graded HTML fixture**; present only in the pending wire sample                                                               |
| Export shape                   | 9,387 rows / 5 displayed columns (`Customer, Ticket Number, Accepted, Description, Amount`); workbook not committed because rows are identifying |

Fields parsed: `ticketNumber, wagerNumber, wagerType, selection, selectedTeam, team1, team2, line,
price, riskCents, winCents, status, score, game, league, live, gameNumber, market, scheduled,
accepted, placedOn, gradedAmount`.

Alphabet bitmask: bit0 `A-Z`, bit1 `a-z`, bit2 `0-9`, bit3 `_`, bit4 `.`, bit5 `@`, bit6 `-`,
bit7 non-ASCII, bit8 other printable. Because no raw Login exists here, 3d records
`identifier_fields_present: false` and hashes only after the settlement join.

## Section 2 — Census-derived SoA layout, allocation boundary, overflow

- **C_max=6** ⇒ `4×C_max=24` ⇒ with a fixed table floor, radix **2^12 = 4,096** probes; load
  factor 0.0015. A future C_max >1,024 moves to `2^k ≥4×C_max`.
- **Identifier hashing:** raw UTF-8 byte-span FNV-1a-64 over the joined
  `${Login.trim()}|${WagerNumber}|${TicketNumber}` key; trim ASCII `0x20` by span, never allocate a
  `.trim()` string. The packed unsigned key is `TicketPackedKey64` (ticket 31 bits + wager suffix +
  leg bits, zero sign bits).
- **SoA columns:**
  ```text
  packedCellKeyCol: Uint32Array
  ticketCountCol: Uint32Array
  legCountCol: Uint32Array
  riskCentsCol: BigInt64Array
  settledNetCentsCol: BigInt64Array
  principalDebitCentsCol: BigInt64Array
  clvSumLineHundredthsCol: BigInt64Array
  clvEligibleLegCountCol: Uint32Array
  cellFlagsBitSet: Uint32Array           // free-play, WIN/LOSS/PUSH, over/under
  ```
- **Zero collection-heap allocations on the aggregation path**: no `Map`, `Set`, `boolean[]`, or
  dynamic `T[]` resizing; fixed capacity from C_max and radix table.
- **InlineCapacityList<LegSlot, 8>**: observed P100 actual legs =1, so 8 slots are ample. If a
  future graded ticket exceeds 8 legs, use the bounded 64-slot overflow slab and count
  `overflowTicketCount`; exhausting it fails GATE-05, never drops a leg.

## Section 3 — Fixed-point accounting, dedupe, FreePlay matrix, reconciliation

Branded types only (`Cents`, `SettledCents`, `BasisPoints`, `LineHundredths`,
`ClvLineHundredths`); zero floats.

- **Dedupe by `TicketPackedKey64`** from `${Login.trim()}|${WagerNumber}|${TicketNumber}`; latest
  `validTime` wins, deterministic tie-break by ticket/wager; count `ticketsDeduped`.
- **FreePlayFlag 2×2 matrix (GATE-07, merge-blocked):**

| Flag  | WIN                                                                 | LOSS                                          | PUSH                                      |
| ----- | ------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| **Y** | net payout credited; `settledNetCents` = net win; principal debit 0 | **principal debit 0**, `settledNetCents` = 0  | `settledNetCents` = 0; no principal debit |
| **N** | normal win net; principal debit 0                                   | principal debit = riskCents; net = -riskCents | net = 0; principal debit 0                |

Free-play wins vs. gross-less-principal and how free-play stake enters
`settledStakedCents`/`holdBps` require the signed Finance memo (GATE-07). Until signed, **3d is
merge-blocked**; the artifact may carry counts (`freePlayLossRows`, `freePlayUnknownRows`) but no
free-play money effect. Missing flag ⇒ `freePlayUnknownRows`, treated as normal N for accounting,
flagged for review.

- **Alignment with `verification/run_four_harness_verification.py`:** use
  `parse_cents_strict`-equivalent fixed-point parsing (no floats/overflow silently), deterministic
  duplicate ordering/bitset predicates, exact artifact hash/read-back, and redaction of row values in
  errors. Reconciliation report: parsed → joined → deduped → counted; raw vs visible+suppressed cents.
- **Conservation:** `sum(visible.metric)+suppressedResidual.metric === rawDedup.metric` for
  ticketCount, legCount, riskCents, settledNetCents, principalDebitCents.
- **Cross-system identity:** `3c.settledNetCents ≈ 3d.settledNetCents[GSLIVE+GSBUILDER]` with the
  three divergence buckets (desk-date/UTC, widget-rejected/cancelled, unsettled carry); residual
  beyond tolerance fails GATE-08.

## Section 4 — Complete GATE-01..08 catalog

| Gate                                               | Requirement                                                                                                  | 3d external arbiter                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| GATE-01 RotationAndDomainBounds                    | rotations 0..1,048,575, no 16-bit masking; full 64-bit key                                                   | graded row census                                                                |
| GATE-02 UnsignedHandleAndKeyIntegrity              | Uint32/BigUint64 handles; load ≤0.25                                                                         | `assertNoSignedHandleArrays()`                                                   |
| GATE-03 ExternalControlTotalAndSdcConservation     | visible+suppressed ≡ external control; deduped tickets ≡ vendor count; k=5+sibling suppression; SDC sign-off | `getDailyFiguresByCustomer` / `getAgentPerformance` / four-harness oracle header |
| GATE-04 InProcessKeyContainment                    | no PackedKey64, ticket/wager/Login-derived value at any depth                                                | `assertNoPersistedHandleKeys()`                                                  |
| GATE-05 WireAndArtifactSchemaBounds                | <256 KiB, BOM stripped, `x-amz-meta-pii: none`, no PII/IP/login regex                                        | `assertSanitizedRollupArtifact()`                                                |
| GATE-06 FixedPointAndSentinelAlgebra               | zero floats, NULL_CLV_SENTINEL, settled-only ROI                                                             | serializer                                                                       |
| GATE-07 FreePlayPolicySigned                       | **merge-blocker**: full 2×2 FreePlay matrix signed by Finance/Accounting before 3d code merges               | signed Finance memo linked here                                                  |
| GATE-08 TemporalCutoffAndCrossSystemReconciliation | 3c↔3d identity + fail-closed pointer                                                                         | reconciliation report                                                            |

**DodGateFailureError payload (all gates):**

```ts
new DodGateFailureError({
  gate: 1..8, gateName: string, streamId: "f402-graded",
  cells: number[], varianceCents: bigint, rowCountDelta: number,
  controlSource: string,
});
```

## Section 5 — Risk, reversal, and falsification matrix

| Trigger                              | Structural change                                                   | Fail-closed behavior                                          |
| ------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| P100 legs >8                         | overflow slab; >64 ⇒ reviewed N/arena                               | GATE-05 abort                                                 |
| C_max >1,024                         | next `2^k ≥4×C_max`                                                 | GATE-02 load abort                                            |
| FreePlayFlag unavailable in raw HTML | requires settlement join; no inference                              | GATE-07 blocks money effects                                  |
| GATE-03 external totals fail         | no write; variance report                                           | `writeWithMetadata` aborted; existing `latest.json` untouched |
| Free-play policy unsigned            | 3d code cannot merge; counts-only artifacts                         | merge-blocked                                                 |
| Sign-off checklist                   | Engineering/CI GATE-01..08; Finance GATE-07; Compliance/SDC GATE-03 | required before public R2                                     |
