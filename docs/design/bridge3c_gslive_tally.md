# Bridge 3c — GSLive Bet Report / Tally (design, no implementation)

Status: **design only.** Batch snapshot `gslive-tally/<YYYY-MM-DD>/rollup.json` plus
`gslive-tally/latest.json` pointer. Source: GSLive Partner 118 `getBetReport` / markets-report.
Shared contracts: [`pii_sanitization.md`](./pii_sanitization.md), [`stream_map.md`](./stream_map.md),
[`lib/bun_shapes.ts`](../../lib/bun_shapes.ts).

## Section 1 — Data-Oriented Design grounding and empirical census

Data-Oriented Design means transforming actual measured layouts and cardinalities, with
cache-contiguous SoA columns: Richard Fabian, [Data-Oriented Design (2018)](https://www.dataorienteddesign.com/dodbook/);
Mike Acton, [CppCon 2014](https://www.youtube.com/watch?v=rX0ItVEVjHc).

**Census source:** `Scratch/betReport-all.json` (`{r:{bets:[…]}}`), read-only in memory.

| Census metric                            | 3c observation                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Rows / fields                            | **24,778** rows / **69** fields                                                                                                         |
| `C_max` distinct ticket / betGroupId     | **22,611 / 22,611**                                                                                                                     |
| betGroupId numeric range / bit width     | **318,925,653..320,016,367**, **29 bits**                                                                                               |
| TicketNumber range / bit width           | **1,071,239,781..1,074,461,814**, **31 bits**                                                                                           |
| WagerNumber field                        | **absent** from this capture (0/24,778)                                                                                                 |
| Multi-leg fanout                         | P50=1, P95=2, P99=3, P99.9=6, **P100=8**                                                                                                |
| Fanout distribution                      | 1:21,261; 2:810; 3:360; 4:119; 5:38; 6:12; 7:9; 8:2                                                                                     |
| `type` populations                       | `0`:21,261 (1-leg GSLIVE straight); `1`:3,517 (GSBUILDER multi-leg SGP)                                                                 |
| State codes                              | `2` lose 24,544; `3` push 158; `1` win 76                                                                                               |
| Period populations                       | `m` 19,950; `h1` 2,042; `s1` 964; `s2` 859; `s3` 501; `h2` 224; `s4` 83; `s5` 64; `s6` 21; `s7` 21; `s8` 16; `s9` 13; `s11` 11; `s12` 9 |
| Sport IDs                                | 14 distinct; top 3/2/8 cover 16,806 rows                                                                                                |
| MarketType                               | Main Lines 23,508; Game Props 593; Player Props 387; Score Props 253; Outrights 37                                                      |
| FreePlayFlag / `isFreePlay`              | non-null/1 in **231** rows, all state `2` (lose)                                                                                        |
| `ifBet` / `reversedCredit`               | `ifBet` non-null **0**; `reversedCredit` non-null **733**                                                                               |
| CLV fields                               | `betDetails.f` present **24,778/24,778**; `betDetails.fc` present **0/24,778**; `fc_zero` 0; malformed `betDetails` 0                   |
| Identifier alphabets (bitmask/max bytes) | `agent` **85**/10 (`A-Z`, `0-9`, `.`, `-`); `userID` **4**/7 (digits); `partnerUserID` **29**/10; `playerId` **4**/1; non-ASCII 0       |
| Null rates                               | `state/type/period/sID/ticketNumber/betGroupId` 0%; `ifBet` 100%; `isFreePlay` 99.07%; `reversedCredit` 97.04%; `fVal/fVal_new` 0%      |

Field set (69): `accept, acceptTime, adminUser, agent, balanceId, balanceName, bet, betDetails,
betGroupFinalOdds, betGroupId, betGroupPremiumAwarded, betGroupResult, betGroupToWin, calcTime,
currency, delay, disclaimer, displayExchangeRate, displaySportId, eID, ev, evRisk, eventResult,
eventStartTime, exchangeRate, fVal, fVal_new, featuredBetDetails, finalUncorrelatedOdds,
fixedParlayDetails, fixedParlayName, freeBetDetails, gradeTime, id, ifBet, ipAddress, isFreePlay,
isSuspectedBot, isWin, lID, logTime, manualLogExists, marketTypeCategory, openParlay, openSpots,
partnerID, partnerUserID, period, pitcher1, pitcher2, playerId, premium, profile, result,
resultTime, reversedCredit, reversedCreditTime, rrSizeMap, sID, sequenceNumber, state,
supplementalConfirmation, team1, team2, teaserName, ticketNumber, type, userGroupId, userID`.

Alphabet bitmask: bit0 `A-Z`, bit1 `a-z`, bit2 `0-9`, bit3 `_`, bit4 `.`, bit5 `@`, bit6 `-`,
bit7 non-ASCII, bit8 other printable.

**Streaming census execution (Phase 1):** the `betReport-all.json` pass was a chunked
`JSONDecoder.raw_decode` over `r.bets`; each row was folded into counters and discarded. No output
file, no row sample, and no raw field value was printed. The executable four-harness ran read-only:
`ALL 4 DOMAIN HARNESSES … PASSED`.

**Census additions:**

| Metric                                                              | 3c value                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `B_max` distinct bounded buckets (type×sID×period×state×marketType) | **167** (118 without marketType)                                                                                                                   |
| Enum cardinalities                                                  | channel/type **2**, sport **14**, period **14**, marketType **5**, settlementState **3**                                                           |
| Dedup ticket counts by state                                        | win 72; lose 22,384; push 158                                                                                                                      |
| Dedup ticket counts by type                                         | `0` 21,261; `1` 1,350 (multi-leg groups)                                                                                                           |
| Dedup ticket counts by top sport                                    | 3:9,301; 2:4,682; 8:3,042; 5:2,847                                                                                                                 |
| Dedup ticket counts by period                                       | `m` 18,146; `h1` 1,924; `s1` 954; `h2` 222                                                                                                         |
| 4-harness oracle                                                    | `parse_cents_strict("-12,037.64") = -1_203_764`; `"+$4,719.695" = 471_970`; overflow raises; CRC32 byte-flip check; fixed 16-state predicate table |

**Header/control observations:** the committed `Pending.post.json` skeleton exposes only the
`Pending` array; `getGrading.post.json` exposes `LIST` as a string;
`getDailyFiguresByCustomer.post.json` exposes `INFO` as a boolean. No `markets-report` /
`users-report` capture exists in `docs/evidence/captures/2026-11-01/`, so their live header totals
remain named external arbiters rather than committed fixtures. GATE-03 for 3c requires a live
`markets-report` stake-sum tie and a `users-report` distinct-login cardinality tie against the
in-process `CustomerPackedKey64` structure.

## Section 2 — Census-derived SoA layout, allocation boundary, overflow

- **C_max=22,611** ⇒ `4×C_max=90,444` ⇒ radix **2^17 = 131,072**; load factor 0.172 ≤ 0.25.
- **Identifier hashing:** raw UTF-8 byte-span FNV-1a-64, trimming ASCII `0x20` without allocating
  `.trim()` substrings. Base-40 was evaluated against the observed alphabets (max bitmask 85) but
  rejected: byte-span hashing avoids decode/allocation and covers future punctuation without a
  radix alphabet dependency.
- **SoA columns:**
  ```text
  packedCellKeyCol: Uint32Array          // M.G<betGroupId> / cell key
  ticketCountCol: Uint32Array
  legCountCol: Uint32Array
  riskCentsCol: BigInt64Array
  settledNetCentsCol: BigInt64Array
  definedLiabilityCentsCol: BigInt64Array
  clvSumLineHundredthsCol: BigInt64Array
  clvEligibleLegCountCol: Uint32Array
  cellFlagsBitSet: Uint32Array           // GSLIVE/GSBUILDER, ifBet, over/under, null-CLV
  ```
- **Zero collection-heap allocations on the aggregation path**: no `Map`, `Set`, `boolean[]`, or
  dynamic `T[]` resizing. Table/arena capacities are fixed from C_max.
- **InlineCapacityList<LegSlot, 8>**: census P100=8 exactly. Tickets >8 use the bounded 64-slot
  overflow slab, increment `overflowTicketCount`; exhausting it fails GATE-05, never drops a leg.
- **Radix probe hit re-checks the full 64-bit key**; keys are packed unsigned, never signed.

**32→64-bit key escalation:** `PackedRollupKey32` uses 6 bits / 64 values per bounded field. The
census maximum is 14 (sport/period), 5 (marketType), 3 (state), 2 (channel), so the 32-bit key
remains valid; `B_max=167` fits a UInt32 key. If any field exceeds 64 values, escalate the entire
key to `PackedRollupKey64: BigUint64Array` with explicit widths, never borrowing bits from another
field. A failed pack/decode round-trip sets `packingRoundTripFailed=true`.

**BigInt CLV and banker's rounding:** `NULL_CLV_SENTINEL_BIGINT = -2147483648n` is the only missing
sentinel (no dead-code number variant). `computeSettledRoiBasisPoints(netCents,
settledStakedCents)` uses round-half-to-even in BigInt; its signed
`roundingResidualCents: bigint` is stored in `suppressed` and added algebraically to GATE-03. The
cent identity is
`sum(visibleCells.metric) + suppressedResidual.metric + (metric==roiBps?roundingResidualCents:0) === rawDeduplicatedTotal.metric`;
for ticketCount/legCount/riskCents/settledNetCents/clvEligibleLegCount the residual is zero.

## Section 3 — Fixed-point accounting, channels, CLV, reconciliation

Branded types only: `Cents`, `SettledCents`, `BasisPoints`, `LineHundredths`,
`RotationNumber`, `ClvLineHundredths`; no IEEE-754.

- **Dedupe `M.G<betGroupId>`:** one `riskCents`/`settledNetCents` per group. A 2× ifBet/thenBet
  action-reverse pair is one liability; set `cellFlagsBitSet` ifBet flag and increment
  `ifBetPairs` (0 in this capture; synthetic fixture required).
- **Strict channels:** `GSLIVE` = `type=0`, one-leg straight; `GSBUILDER` = `type=1` multi-leg
  SGP (2–8 rows). Never mix the buckets or multiply parlay risk.
- **Integer cents:** `riskCents`, `settledNetCents`, `netResultCents` from fixed-point string
  parsing; no floats.
- **CLV:** `clvLineHundredths = f - fc`, with `NULL_CLV_SENTINEL = -2147483648` when `fc` is
  missing or zero. `clvEligibleLegCount` is the denominator; this capture has f=24,778, fc=0, so
  `clvSumLineHundredths = 0`, `clvEligibleLegCount = 0`, and CLV is null — **never treat missing
  closes as zero CLV**.
- **Settled-only ROI:** `computeSettledRoiBasisPoints(netCents, settledStakedCents)`; pending
  stake is excluded from the denominator. `holdBps = round(10000*(riskCents-settledNetCents)/riskCents)`,
  null for zero risk.
- **Conservation:** visible cells + suppressed residual ≡ raw deduped totals for ticketCount,
  legCount, riskCents, settledNetCents, clvEligibleLegCount.
- **Cross-system identity:** for each desk date,
  `3c.settledNetCents ≈ 3d.settledNetCents[GSLIVE+GSBUILDER]` and
  `3c.openExposureCents ≈ 3b.definedLiabilityCents[GSLIVE+GSBUILDER]`, with exactly three
  divergence buckets: UTC-vs-desk-date cutoff, widget-rejected/cancelled bets, unsettled
  cross-window carry. Residual beyond tolerance fails GATE-08.

## Section 4 — Complete GATE-01..08 catalog

**Scope:** GATE-01..08 are design obligations that the eventual 3b/3c/3d implementations must
satisfy. This PR specifies them; it does not implement or run them. SHIP=1 in this PR covers the
docs only.

**Execution order:** GATE-01..03 sequentially (fail-fast) pre-serialization; GATE-04/05 paired
post-serialization before key-table teardown; GATE-06..08 sequentially. GATE-03's SDC sign-off is
required before public R2 writes.

| Gate                                               | Requirement                                                                                                    | 3c external arbiter                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| GATE-01 RotationAndDomainBounds                    | rotations 0..1,048,575, no 16-bit masking; full 64-bit key check                                               | rotation census + raw rows                                  |
| GATE-02 UnsignedHandleAndKeyIntegrity              | Uint32/BigUint64 handles; radix load ≤0.25                                                                     | `assertNoSignedHandleArrays()`                              |
| GATE-03 ExternalControlTotalAndSdcConservation     | visible+suppressed ≡ external control; deduped tickets ≡ vendor count; k=5 + sibling suppression; SDC sign-off | GSLive `kind=markets-report` / `users-report` header totals |
| GATE-04 InProcessKeyContainment                    | no PackedKey64, M.G, TicketNumber/WagerNumber/Login-derived value in output at any depth                       | `assertNoPersistedHandleKeys()`                             |
| GATE-05 WireAndArtifactSchemaBounds                | <256 KiB, BOM stripped, `x-amz-meta-pii: none`, no PII/IP/login regex, overflow bounded                        | `assertSanitizedRollupArtifact()`                           |
| GATE-06 FixedPointAndSentinelAlgebra               | zero floats, NULL_CLV_SENTINEL, settled-only ROI denominator                                                   | serializer                                                  |
| GATE-07 FreePlayPolicySigned                       | FreePlay 2×2 policy signed before enabling free-play money effects                                             | Finance/Accounting memo                                     |
| GATE-08 TemporalCutoffAndCrossSystemReconciliation | 3c↔3b/3d identity; fail-closed pointer preservation                                                            | reconciliation report                                       |

**DodGateFailureError payload (all gates):**

```ts
new DodGateFailureError({
  gate: 1..8, gateName: string, streamId: "gslive-tally",
  cells: number[], varianceCents: bigint, rowCountDelta: number,
  controlSource: string,
});
```

**GATE-03 external control details:** the external control is owned by Partner 118 Manager
Reporting, not recomputed from the projection loop. `markets-report` supplies the market-level
count/stake total; `users-report` supplies a per-login distinct count and stake sum. Because 3c
rolls up by `betGroupId`, reconcile both `Σ stake` and `distinct login count` against the in-process
`CustomerPackedKey64` dedupe set before teardown; never persist a login. The intra-endpoint
`Report/Pending` header is only a secondary tie-out. The complementary suppression algorithm
(k=5 + sibling suppression) is named and requires Compliance/SDC Reviewer sign-off before public
writes.

**Artifact ceiling derivation (GATE-05):** `ROLLUP_MAX_ARTIFACT_BYTES = min(256 KiB,
max(64 KiB, B_max × 512 bytes + 12 KiB header))`. With B_max=2/167/6 for 3b/3c/3d, the defaults
are 64 KiB, 95 KiB, and 64 KiB respectively; the 256 KiB hard cap remains. `stripUtf8Bom()` and
`x-amz-meta-pii: none` are applied before the size check.

**GATE-04 lifetime detail:** `assertNoPersistedHandleKeys()` runs before the radix/key TypedArrays
are torn down, walking the serialized artifact key-by-key against the live dedupe structure. If
lifetime forces early release, it falls back to a streaming scan of input row keys against the
artifact and records that fallback in the gate result.

**Extended `DodGateFailureError`:**

```ts
new DodGateFailureError({
  gate: 1..8, gateName: string, streamId: "3c-gslive-tally",
  cells: Array<number | bigint>,
  cellsUnpacked: Array<{channel:string,sport:string,period:string,wagerType:string,settlementState:string}> | null,
  packingRoundTripFailed?: boolean,
  varianceCents: bigint, rowCountDelta: number, controlSource: string,
});
```

`cellsUnpacked` is populated only after GATE-04 proves the values are not persisted; otherwise
`null`.

## Section 5 — Risk, reversal, and falsification matrix

| Trigger                      | Structural change                                                            | Fail-closed behavior             |
| ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| P100 >8 legs                 | overflow slab; >64 ⇒ reviewed N/arena increase                               | GATE-05 abort                    |
| C_max >32,768                | next `2^k ≥ 4×C_max` (2^18+)                                                 | GATE-02 load-factor abort        |
| `fc` becomes populated       | CLV denominator/eligibility recalculated; null sentinel retained for missing | GATE-06 checks                   |
| GATE-03 external totals fail | no write; variance report                                                    | existing `latest.json` untouched |
| GATE-07 unsigned             | free-play money effects disabled; counts only                                | merge-blocked                    |
| Sign-off                     | Engineering/CI GATE-01..08; Finance GATE-07; Compliance/SDC GATE-03          | required before public R2        |

**Gaming-audit scope:** GATE-03 is a tie-out to an external vendor report, not independent
validation. Third-source validation (GL entries, bank settlement, or customer-level statements) is
out of scope for Bridge 3 and must be performed by Finance/Compliance at the period level before
these rollups are used for financial reporting.
