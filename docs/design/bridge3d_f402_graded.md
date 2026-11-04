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

**Streaming census execution (Phase 1):** the graded HTML fixtures were parsed row-by-row through
the production parser in memory; rows were immediately folded into counters. No output file, row
sample, or raw field value was printed. The executable four-harness was run read-only:
`ALL 4 DOMAIN HARNESSES … PASSED`.

**Census additions:**

| Metric                                                                | 3d value                                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `B_max` raw grading buckets (wagerType×status×placedOn×league×market) | **6**                                                                                                                                    |
| `C_max` distinct ticket                                               | **6**                                                                                                                                    |
| Status classes                                                        | Win 3; Won 1; Lost 1; Loss 1; Canceled 1                                                                                                 |
| WagerType cardinality                                                 | **5** (`S 2, E 1, G 2, M 1, T 1`)                                                                                                        |
| PlacedOn cardinality                                                  | **3** (Internet 5, Mobile 1, Desktop 1)                                                                                                  |
| Null fields                                                           | team1/team2/line/price/league/market/score/scheduled = 2 each (`G` rows)                                                                 |
| 4-harness oracle                                                      | `parse_cents_strict("-12,037.64")=-1_203_764`; `"+$4,719.695"=471_970`; overflow raises; CRC32 byte-flip; fixed 16-state predicate table |

**Census record and failure policy:** the aggregate census is committed at
[`census/2026-11-04.json`](./census/2026-11-04.json); the Phase 1 runner emits stdout only and this
JSON is the transcribed aggregate record (no rows/identifiers). Missing fixture, non-zero harness, or
an unparseable row aborts the census with no partial design numbers.

**Header/control observations:** the committed `getGrading.post.json` skeleton exposes only
`LIST` as a string; `getDailyFiguresByCustomer.post.json` exposes `INFO` as a boolean; the graded
workbook export is metadata only. No vendor summary header is present in the committed captures;
`getDailyFiguresByCustomer` / `getAgentPerformance` / the four-harness oracle header remain the
named live external arbiters for GATE-03.

**Runtime boundary — Bun service, Node Harness:** Bridge 3 executes entirely under Bun in
`sportsdesk-ops` (`:4020`). The Harness host is Node (`:3080`) and has no `Bun` global. Any
Harness-facing view of Bridge 3 (gates, freshness, census) must be a thin HTTP client against
`:4020`, not an import of Bun-only modules — the same class of failure `dsh-plugin/verify-runtime.mjs`
exists to catch. `Bun.secrets` access is confined to the service; the Host receives credentials only
via the service's HTTP surface.

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
  **Status (measured 2026-11-04):** the shipped aggregation path in `lib/gslive_tally_rollup.ts` allocates `new Map` in `groups` (line 414), `labelKey` (527) and `siblingGroups` (638), plus `new Set` in `suppressedIndices` (633). This invariant is a target design (fixed TypedArray arenas), **not** a property of the current code. Verification: `bun --heap-prof-md --heap-prof-dir=profiles/ scripts/gslive_tally_bridge3c.ts <fixture> --dry-run --no-r2` gives a retained-object snapshot (it does NOT attribute allocations per call path, so it cannot by itself prove "zero"); the enforceable check is the ratchet in `tests/tally_allocation_invariant.test.ts`, which fails if the collection-allocation count in the projection module increases. Note: in this design revision GATE-02 is `UnsignedHandleAndKeyIntegrity`, not the allocation invariant, so the heap profile is recorded as allocation-invariant evidence, not as a GATE-02 artifact.
- **InlineCapacityList<LegSlot, 8>**: observed P100 actual legs =1, so 8 slots are ample. If a
  future graded ticket exceeds 8 legs, use the bounded 64-slot overflow slab and count
  `overflowTicketCount`; exhausting it fails GATE-05, never drops a leg.

**Per-stream key: `PackedGradedKey32`.** 3d's natural dimensions are
`(channelCode, sport, period, wagerType, settlementState)` with census-derived widths
`channel:6 | sport:6 | period:6 | wagerType:6 | settlementState:6 = 30` (2 spare). Graded HTML
supplies `wagerType`/status but channel/sport/period come from the reviewed settlement join. If a
joined field exceeds 64 values, escalate to `PackedGradedKey64: BigUint64Array` with explicit
widths; never silently widen one field. `packingRoundTripFailed=true` on
`pack(encode(decode(x))) !== x`.

**Collision budget:** the `TicketPackedKey64` identity is numeric (ticket/wager/suffix) and exact;
a hashed fallback uses FNV-1a-64 with accepted collision probability ≤`10⁻⁷` per period and a
secondary disambiguation/128-bit widening on an observed collision. Any login-derived value in the
join is hashed only as a byte span and never persisted.

**BigInt CLV and banker's rounding:** use only
`NULL_CLV_SENTINEL_BIGINT = -2147483648n` in `BigInt64Array`; no number sentinel.
`computeSettledRoiBasisPoints(netCents, settledStakedCents)` uses round-half-to-even; signed
`roundingResidualCents: bigint` is carried in `suppressed` and added algebraically to the GATE-03
identity. Integer cents only; zero IEEE-754 on the aggregation path.

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

**Idempotency and restartability (launchd restart is the normal case):** `:4020` runs under Bun as a
child of the Harness host, so a launchd `KeepAlive` cycle or a job kill can land mid-rollup.
Re-running one `(stream=3d, desk-date)` must reproduce byte-identical artifacts: deterministic
cell/row ordering, including the `roundingResidualCents` carry and the `TicketPackedKey64` dedupe
tie-break (latest `validTime`, then ticket/wager), and any `generatedAt` records the **capture**
time, never the run time. The sink never publishes a partial artifact — `writeWithMetadata` either
completes or aborts — and `latest.json` advances only after the full artifact and its metadata
commit. This is the same never-discard, fail-closed rule as Bridge 1, stated per stream because
restart is the normal case here rather than the exception.

## Section 4 — Complete GATE-01..08 catalog

**Scope:** GATE-01..08 are design obligations that the eventual 3b/3c/3d implementations must
satisfy. This PR specifies them; it does not implement or run them. SHIP=1 in this PR covers the
docs only.

**Execution order:** GATE-01..03 sequentially (fail-fast) pre-serialization; GATE-04/05 paired
post-serialization before key-table teardown; GATE-06..08 sequentially. GATE-07 is a hard
merge-blocker for 3d until Finance/Accounting signs the policy memo.

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

**GATE-03/GATE-06/GATE-07 division:** GATE-03 is the external vendor tie-out and SDC sign-off;
GATE-06 enforces arithmetic mechanics (BigInt sentinel, banker's rounding, integer-cent
conservation); GATE-07 enforces accounting policy and blocks merge until the one-page Finance memo
explicitly decides FreePlayFlag="Y" WIN/LOSS treatment in `settledNetCents`, `settledStakedCents`,
and the `holdBps` denominator.

**FreePlay GATE-07 matrix (locked pending sign-off):**

| Flag  | WIN                               | LOSS                                      | PUSH                      |
| ----- | --------------------------------- | ----------------------------------------- | ------------------------- |
| **Y** | net payout; principal debit 0     | principal debit 0; `settledNetCents=0`    | net 0; no principal debit |
| **N** | normal win net; principal debit 0 | principal debit riskCents; net -riskCents | net 0; no principal debit |

**Artifact ceiling derivation (GATE-05):** `ROLLUP_MAX_ARTIFACT_BYTES = min(256 KiB,
max(64 KiB, ceil(B_max × 512 bytes × 1.25) + 12 KiB header))`. The 1.25 safety factor is reviewed
dimension-label headroom; with B_max=2/118/6 for 3b/3c/3d the defaults are 64 KiB, 86 KiB, and
64 KiB; the 256 KiB hard cap remains. `stripUtf8Bom()` and
`x-amz-meta-pii: none` are applied before the size check.

**GATE-04 lifetime detail:** `assertNoPersistedHandleKeys()` runs before the radix/key TypedArrays
are torn down, walking the serialized artifact key-by-key against the live dedupe structure. If
lifetime forces early release, it falls back to a streaming scan of input row keys against the
artifact and records that fallback in the gate result.

**Extended `DodGateFailureError`:**

```ts
new DodGateFailureError({
  gate: 1..8, gateName: string, streamId: "3d-f402-graded",
  cells: Array<number | bigint>,
  cellsUnpacked: Array<Record<string, string>> | null, // keys: channel,sport,period,wagerType,settlementState
  packingRoundTripFailed?: boolean,
  varianceCents: bigint, rowCountDelta: number, controlSource: string,
});
```

## Section 5 — Risk, reversal, and falsification matrix

| Trigger                              | Structural change                                                                        | Fail-closed behavior                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P100 legs >8                         | overflow slab; **P100 >32 ⇒ wire-anomaly investigation before arena resize**             | GATE-05 abort                                                 |
| Public R2 boundary                   | bucket-internal writes allowed pre-SDC; `pub-d061…` public domain blocked until sign-off | no public object before GATE-03                               |
| Hashed-identity collision            | accepted ≤`10⁻⁷`/period; secondary pass/128-bit widening on observed collision           | GATE-04 count mismatch                                        |
| C_max >1,024                         | next `2^k ≥4×C_max`                                                                      | GATE-02 load abort                                            |
| FreePlayFlag unavailable in raw HTML | requires settlement join; no inference                                                   | GATE-07 blocks money effects                                  |
| GATE-03 external totals fail         | no write; variance report                                                                | `writeWithMetadata` aborted; existing `latest.json` untouched |
| Free-play policy unsigned            | 3d code cannot merge; counts-only artifacts                                              | merge-blocked                                                 |
| Sign-off checklist                   | Engineering/CI GATE-01..08; Finance GATE-07; Compliance/SDC GATE-03                      | required before public R2                                     |

**`B_max` is per-fixture; the artifact bound is deploy-time:** `B_max` in Section 1 is the
**per-fixture** measured cardinality. `ROLLUP_MAX_ARTIFACT_BYTES` is a **deploy-time** bound derived
from `B_max_production`, measured from the first real capture of each stream, not from the census
fixture. The census-derived default (64 KiB for 3b/3d, 86 KiB for 3c) is a floor; it must be raised
at deploy time if the first real capture exceeds it. GATE-05 failure on a correct rollup is a signal
to measure, not to widen the bound.

**Gaming-audit scope:** GATE-03 is a tie-out to an external vendor report, not independent
validation. Third-source validation (GL entries, bank settlement, or customer-level statements) is
out of scope for Bridge 3 and must be performed by Finance/Compliance at the period level before
these rollups are used for financial reporting.
