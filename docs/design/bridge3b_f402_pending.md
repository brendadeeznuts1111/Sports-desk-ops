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

**Streaming census execution (Phase 1):** the 3c `betReport-all.json` pass used a chunked
`JSONDecoder.raw_decode` over `r.bets`, discarding each row after its aggregates were updated; no
output file, no row sample, no field value was printed. The 3b/3d census used the committed
pending skeleton/sample/panel and the graded parser fixtures in memory. The executable four-harness
was run read-only and reported `ALL 4 DOMAIN HARNESSES … PASSED`.

**B_max and enum cardinalities (3b snapshot):** the 3b **natural dimension set** is
`(rotation, sport, period)`; on the 2-game snapshot `B_max=2`. Observed enums: WagerType 1;
WagerStatus 1; period 2; sport 2; sub-sport 2; FreePlayFlag 1; all from the 2-game snapshot, not a
full 73-field row capture. `B_max` is always tied to this dimension set, never a generic count.

**Census record and failure policy:** the aggregate census is committed at
[`census/2026-11-04.json`](./census/2026-11-04.json). The Phase 1 runner emits stdout only; this JSON
is the transcribed aggregate record, containing no rows or identifiers. Missing fixture, non-zero
harness, or an unparseable row aborts the census — no partial design numbers. Missing optional live
headers are recorded as gaps, not silently substituted.

**Four-harness oracle extracted from `verification/run_four_harness_verification.py`:**

| Oracle equation / check             | Exact assertion observed in source/run                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `parse_cents_strict("-12,037.64")`  | `-1_203_764`                                                                   |
| `parse_cents_strict("+$4,719.695")` | `471_970` (half-up on the third decimal)                                       |
| Overflow                            | `parse_cents_strict("99999999999999999999.99")` raises `OverflowError`         |
| CRC envelope                        | `zlib.crc32(bytearray(b"DOD6" + b"\x00"*60))` changes when byte 17 is flipped  |
| Predicate truth table               | `evaluate_event_log_predicates(...)` asserted against the fixed 16-state table |
| Redaction                           | `scrub_all_secret_encodings` no-secret-leak assertion                          |

The harness contains **no external vendor control total**; GATE-03's named external source for 3b
must come from `Report/Pending` summary / Mode 9. The committed `Pending.post.json` skeleton exposes
only the `Pending` array (73 fields) and no summary header field; the secondary intra-endpoint
header is therefore a **live-capture gap** to close before implementation.

**Upstream header/field observations:** `Pending.post.json` response keys are
`bodySha256, bodySkeleton, bytes, contentType, status`; the only skeleton field is `Pending` (array).
`getGrading.post.json` exposes `LIST` as a string; `getDailyFiguresByCustomer.post.json` exposes
`INFO` as a boolean. No `markets-report`/`users-report` capture exists in
`docs/evidence/captures/2026-11-01/`; those live headers remain external arbiters, not committed
fixtures.

**Runtime boundary — Bun service, Node Harness:** Bridge 3 executes entirely under Bun in
`sportsdesk-ops` (`:4020`). The Harness host is Node (`:3080`) and has no `Bun` global. Any
Harness-facing view of Bridge 3 (gates, freshness, census) must be a thin HTTP client against
`:4020`, not an import of Bun-only modules — the same class of failure `dsh-plugin/verify-runtime.mjs`
exists to catch. `Bun.secrets` access is confined to the service; the Host receives credentials only
via the service's HTTP surface.

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

**Per-stream key: `PackedPendingKey32`.** 3b has exactly three natural dimensions:
`(rotation, sport, period)` with census-derived widths `rotation:20 | sport:6 | period:6 = 32`.
There is no `wagerType` or `settlementState` in the 3b bucket (Pending is open by definition); they
are **not zero-filled placeholders in a five-field superset**. If any field exceeds 64 values or
the rotation exceeds 20 bits, escalate to `PackedPendingKey64: BigUint64Array` with explicit widths
derived from the new census; never widen one field by borrowing another's bits. The
`pack(encode(decode(x))) !== x` round-trip check sets `packingRoundTripFailed=true` on
`DodGateFailureError`.

**Collision budget:** FNV-1a-64 at `C_max ≈ 64K` has expected collisions ≤ `6×10⁻⁸` per period;
that is accepted (≤`10⁻⁷`). The deduped ticket identity additionally keeps a full secondary key
(`TicketNumber/WagerNumber`) and a second pass disambiguates any observed collision before
GATE-03 counts are published. Count-only identity structures use 128-bit keys if a second
collision is observed.

**Allocation boundary:** streamed identifier bytes are hashed directly (FNV-1a-64), and the
identifier alphabet mask (bitmask 5) confirms no allocation-heavy decoding is needed. No
`Map`/`Set`/`boolean[]` or dynamic arrays on the aggregation path; only the fixed radix table and
SoA arena.

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

**BigInt sentinel and banker's rounding:** CLV is stored/compared only as BigInt:
`NULL_CLV_SENTINEL_BIGINT = -2147483648n`; no dead-code number variant. 3c's
`computeSettledRoiBasisPoints(netCents, settledStakedCents)` uses round-half-to-even in BigInt; the
signed `roundingResidualCents: bigint` is accumulated in `suppressed` and added algebraically to
the GATE-03 identity so arbitrary bucket counts still tie to the exact cent. 3b's `definedLiability`
and stake math also use BigInt64 columns only.

**3b GATE-03 roll-forward (principal-only):**
`OpeningPending_{t-1}^{vendor} + BetTickerInflow_t - GradedSettledPrincipal_t -
VoidedCancelledPrincipal_t` is the **left-hand external triangulated control**, compared with
**`ClosingPending_t = totalStakeCents`** from 3b. The identity is stated in **principal (stake)
cents**: `definedLiabilityCents` and `potentialPayoutCents` are **not** terms in this roll-forward.
Opening pending comes from the prior period's signed vendor report, never from 3b's prior output.
Voided/cancelled principal is deducted unless getGrading already includes voids at principal stake
with `netCents=0`. All terms use the same temporal cutoff (UTC; desk-date terms converted
explicitly). The intra-endpoint `Report/Pending` summary header is a secondary wire tie-out only.

**Separate liability bound (not the roll-forward):**
`definedLiabilityCents <= min(potentialPayoutCents, capCents × distinctTicketCount)`; a capped
ticket example ($1,000 risk / $10,000 toWin / $5,000 cap) must satisfy
`100000 <= min(1000000, 500000)` without perturbing the principal roll-forward.

**3d external control:** `sum(visibleCells)+suppressedResidual+roundingResidualCents ≡
ExternalReportControlTotal` and `sum(dedupedParentTicketsRead) ≡ VendorReportTicketCount` against
`getDailyFiguresByCustomer` / `getAgentPerformance` / the four-harness oracle header.

**Idempotency and restartability (launchd restart is the normal case):** `:4020` runs under Bun as a
child of the Harness host, so a launchd `KeepAlive` cycle or a job kill can land mid-rollup.
Re-running one `(stream=3b, desk-date)` must reproduce byte-identical artifacts: deterministic
cell/row ordering, including the `roundingResidualCents` carry, and any `generatedAt` records the
**capture** time, never the run time. The sink never publishes a partial artifact —
`writeWithMetadata` either completes or aborts — and `latest.json` advances only after the full
artifact and its metadata commit. This is the same never-discard, fail-closed rule as Bridge 1,
stated per stream because restart is the normal case here rather than the exception.

## Section 4 — Complete GATE-01..08 catalog

**Scope:** GATE-01..08 are design obligations that the eventual 3b/3c/3d implementations must
satisfy. This PR specifies them; it does not implement or run them. SHIP=1 in this PR covers the
docs only.

**Execution order:** GATE-01..03 run sequentially (fail-fast) pre-serialization; GATE-04/05 run as
a paired post-serialization block before in-process key-table teardown; GATE-06..08 run
sequentially. GATE-07 is a merge-blocker on 3d until Finance signs the FreePlay policy.

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

**Artifact ceiling derivation (GATE-05):** `ROLLUP_MAX_ARTIFACT_BYTES =
min(256 KiB, max(64 KiB, ceil(B_max × 512 bytes × 1.25) + 12 KiB header))`. The 1.25 safety factor
is the reviewed headroom for dimension-label growth between censuses; with B_max=2/118/6 for
3b/3c/3d the defaults are 64 KiB, 86 KiB, and 64 KiB. `stripUtf8Bom()` and `x-amz-meta-pii: none`
are applied before the size check.

**GATE-04 lifetime detail:** `assertNoPersistedHandleKeys()` runs before the radix/key TypedArrays
are torn down, walking the serialized artifact key-by-key against the live dedupe structure. If
lifetime forces early release, it falls back to a streaming scan of input row keys against the
artifact and records that fallback in the gate result.

**Extended `DodGateFailureError` payload (all gates):** `cellsUnpacked: null` unless 3c/3b can
expose de-identified cell tuples; `packingRoundTripFailed: true` only when GATE-02's
`pack(encode(decode(x))) !== x`. `cells` may contain bigint handles only until GATE-04 proves they
are not in the serialized artifact.

```ts
new DodGateFailureError({
  gate: 1..8,
  gateName: string,
  streamId: "3b-f402-pending",
  cells: Array<number | bigint>,
  cellsUnpacked: Array<Record<string, string>> | null, // stream-specific keys: rotation,sport,period
  packingRoundTripFailed?: boolean,
  varianceCents: bigint,
  rowCountDelta: number,
  controlSource: string,
});
```

## Section 5 — Risk, reversal, and falsification matrix

| Trigger                                     | Structural change                                                                           | Fail-closed behavior                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P100 > 8 legs                               | overflow slab used; **P100 > 32 is a wire-anomaly investigation**, not an arena resize      | GATE-05 abort, no R2 write                                    |
| Public R2 boundary                          | bucket-internal R2 writes allowed pre-SDC; `pub-d061…` public domain blocked until sign-off | no public object before GATE-03 sign-off                      |
| C_max > 4,096                               | resize radix to next `2^k ≥ 4×C_max`                                                        | GATE-02 load-factor abort before write                        |
| Identifier alphabet gains `_ . @`/non-ASCII | hashing remains byte-span FNV-1a-64; revisit only if >2,048-byte values                     | GATE-05 value bound                                           |
| GATE-03 external totals fail                | report variance, do not write                                                               | `writeWithMetadata` aborted; existing `latest.json` untouched |
| Gate-07 unsigned                            | 3d blocked; 3b may publish counts only                                                      | merge-blocked                                                 |
| Sign-off checklist                          | Engineering/CI GATE-01..08; Finance GATE-07; Compliance/SDC GATE-03                         | required before public R2 enable                              |

**`B_max` is per-fixture; the artifact bound is deploy-time:** `B_max` in Section 1 is the
**per-fixture** measured cardinality. `ROLLUP_MAX_ARTIFACT_BYTES` is a **deploy-time** bound derived
from `B_max_production`, measured from the first real capture of each stream, not from the census
fixture. The census-derived default (64 KiB for 3b/3d, 86 KiB for 3c) is a floor; it must be raised
at deploy time if the first real capture exceeds it. GATE-05 failure on a correct rollup is a signal
to measure, not to widen the bound.

Tests must use raw fixtures only through aggregate assertions; no stdout rows or PII values.

**Gaming-audit scope:** GATE-03 is a tie-out to an external vendor report, not independent
validation. Third-source validation (GL entries, bank settlement, or customer-level statements) is
out of scope for Bridge 3 and must be performed by Finance/Compliance at the period level before
these rollups are used for financial reporting.
