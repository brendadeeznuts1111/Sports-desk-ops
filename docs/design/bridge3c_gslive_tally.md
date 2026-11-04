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

## Section 5 — Risk, reversal, and falsification matrix

| Trigger                      | Structural change                                                            | Fail-closed behavior             |
| ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| P100 >8 legs                 | overflow slab; >64 ⇒ reviewed N/arena increase                               | GATE-05 abort                    |
| C_max >32,768                | next `2^k ≥ 4×C_max` (2^18+)                                                 | GATE-02 load-factor abort        |
| `fc` becomes populated       | CLV denominator/eligibility recalculated; null sentinel retained for missing | GATE-06 checks                   |
| GATE-03 external totals fail | no write; variance report                                                    | existing `latest.json` untouched |
| GATE-07 unsigned             | free-play money effects disabled; counts only                                | merge-blocked                    |
| Sign-off                     | Engineering/CI GATE-01..08; Finance GATE-07; Compliance/SDC GATE-03          | required before public R2        |
