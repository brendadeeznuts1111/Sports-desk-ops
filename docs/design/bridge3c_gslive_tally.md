# Bridge 3c — GSLive Bet Report / Tally (design, no implementation)

Status: **design only.** Stream: batch snapshot
`gslive-tally/<YYYY-MM-DD>/rollup.json` + `gslive-tally/latest.json` pointer.
Source: GSLive Partner 118 `getBetReport` / markets-report (`plive.sportswidgets.pro`).

## 1. Empirical inventory (aggregates only; no row values reproduced)

`Scratch/betReport-all.json` = `{r:{bets:[…]}}`, **24,778 rows**, **69 fields**, **22,611 distinct
tickets**. Every row has `partnerID=118`.

### Ticket / parlay fanout

| Rows per ticket/group | Tickets | Interpretation  |
| --------------------- | ------- | --------------- |
| 1                     | 21,261  | single-leg rows |
| 2                     | 810     | 2-leg tickets   |
| 3                     | 360     | 3-leg tickets   |
| 4                     | 119     | 4-leg tickets   |
| 5                     | 38      | 5-leg tickets   |
| 6                     | 12      | 6-leg tickets   |
| 7                     | 9       | 7-leg tickets   |
| 8                     | 2       | 8-leg tickets   |

`type=0` is 21,261 rows and every ticket is one row → **GSLIVE straight**. `type=1` is 3,517 rows
across 2–8-leg tickets → **GSBUILDER multi-leg SGP parlay**. `ifBet` is null in all 24,778 rows
in this capture; the 2× ifBet/thenBet action-reverse rule must still be implemented for captures
where the field is populated. `reversedCredit` is non-null in 733 rows.

### Status and field observations

- `state` numeric codes: `2` (lose)=24,544; `3` (push)=158; `1` (win)=76. `GSLIVE_NUMERIC_STATE_MAP`
  maps `0 pending, 1 win, 2 lose, 3 push, 4 cancel, 5 cancel-after-confirmation, 6 cashout`.
- `isFreePlay=1` / `freeBetDetails` non-null: 231 rows, all state `2` (lose).
- `period`: `m` (full game)=19,950, plus halves/periods (`h1/h2/s1..s12`).
- `sID`/`displaySportId`: 14 distinct sport ids; `marketTypeCategory`: Main Lines 23,508, Game Props
  593, Player Props 387, Score Props 253, Outrights 37.
- `reversedCredit` non-null 733; `ifBet` non-null 0; `openParlay`/`fixedParlayDetails`/`teaserName`
  null 100%; `finalUncorrelatedOdds` null 100%.
- `betDetails` keys observed: `f` 100%, `k`, `m`, `sk`, `lim` 100%; `alt` 4,665; `d` 510; `lg` 270;
  `ms` 168. `fc` is **absent in all 24,778 rows**. `fVal` and `fVal_new` are non-null strings but do
  not equal `betDetails.f` (observed), so they are not silently substituted for `fc`.

**Observed field names (69):**

```text
accept, acceptTime, adminUser, agent, balanceId, balanceName, bet, betDetails,
betGroupFinalOdds, betGroupId, betGroupPremiumAwarded, betGroupResult, betGroupToWin,
calcTime, currency, delay, disclaimer, displayExchangeRate, displaySportId, eID, ev,
evRisk, eventResult, eventStartTime, exchangeRate, fVal, fVal_new, featuredBetDetails,
finalUncorrelatedOdds, fixedParlayDetails, fixedParlayName, freeBetDetails, gradeTime, id,
ifBet, ipAddress, isFreePlay, isSuspectedBot, isWin, lID, logTime, manualLogExists,
marketTypeCategory, openParlay, openSpots, partnerID, partnerUserID, period, pitcher1,
pitcher2, playerId, premium, profile, result, resultTime, reversedCredit,
reversedCreditTime, rrSizeMap, sID, sequenceNumber, state, supplementalConfirmation,
team1, team2, teaserName, ticketNumber, type, userGroupId, userID
```

## 2. Pure projection contract

```ts
export interface GsliveTallyRollupInput {
  readonly rows: readonly RawBetReportRow[]; // 69-field wire rows
  readonly deskDate: string;
  readonly generatedAt: string;
  readonly minCellSize?: number; // default 5
}

export interface GsliveTallyRollupArtifact {
  schemaVersion: 1;
  kind: "sanitized-gslive-tally";
  deskDate: string;
  generatedAt: string;
  source: {
    policy: "getBetReport";
    rowsAccepted: number;
    rowsDropped: number;
    ticketsDeduped: number;
    ifBetPairs: number;
  };
  totals: GsliveTallyMetrics;
  dimensions: readonly GsliveTallyDimensionRow[];
  suppressedResidual: GsliveTallyMetrics;
}

export function projectSanitizedGsliveTallyRollup(
  input: GsliveTallyRollupInput,
): GsliveTallyRollupArtifact;
```

Pure: no I/O/clock/network; publisher serializes and runs the shared PII assertion.

## 3. Dedupe, channels, integer cents, CLV

- **Group key:** `M.G<betGroupId>` (internal only). Deduplicate risk once per group/ticket; leg rows
  count toward `legCount`, never risk.
- **Action reverse:** an `ifBet` thenBet pair is two actions on one liability. Pair the two rows by
  the action-reverse fields/sequence, keep one `riskCents`/`settledNetCents` (the first action owns
  the money), and increment `ifBetPairs`. The field is absent in this capture, so tests must use a
  synthetic pair fixture.
- **Channel split (strict):**
  - `GSLIVE` = `type=0` and exactly one row per ticket → 1-leg in-play straight.
  - `GSBUILDER` = `type=1` / multi-leg fanout or `M.G<betGroupId>` spanning >1 row → SGP parlay.
  - Never merge these channel buckets; a parlay's risk is counted once.
- **Integer cents:** parse `bet`, `betGroupToWin`, `betGroupResult`, `result`, `reversedCredit` with
  fixed-point string→integer-cents (round once); `riskCents`, `settledNetCents`, and `netResultCents`
  are integers. No floats.
- **CLV:** `clvFixed = f - fc` where `f` is `betDetails.f` parsed to fixed-point integer units and
  `fc` is the closing price in the same units. `fc` missing/zero ⇒ `clvFixed = null`; such legs are
  excluded from `clvEligibleLegCount`. `clvEligibleLegCount` is the denominator for any CLV average;
  this capture has `f` 24,778/24,778 but `fc` 0/24,778, so CLV is **null with a zero denominator**,
  not zero. Never average nulls as zero.
- **holdBps** = `round(10000 * (riskCents - settledNetCents) / riskCents)`, null when risk is 0.

## 4. Dimensions, k-anonymity, cent conservation

Dimensions: `channel × sportId × period × marketTypeCategory × settlementState` with bounded labels
(unknown → `other`). Metrics: `ticketCount`, `legCount`, `riskCents`, `settledNetCents`,
`holdBps`, `clvFixed` (null-aware), `clvEligibleLegCount`.

**Complementary suppression k=5:** cells with `ticketCount < 5` are folded into
`suppressedResidual`; if the residual ticket count is in `(0,5)`, suppress the next-smallest sibling
(deterministic label tie-break) until the residual is 0 or at least 5. Required for differencing
immunity around VIP tickets.

**Cent-conservation identity (tests enforce):**

```text
sum(visibleCells.metric) + suppressedResidual.metric === rawDeduplicatedTotal.metric
for metric in {ticketCount, legCount, riskCents, settledNetCents, clvEligibleLegCount}
```

## 5. R2 contract

- `gslive-tally/<YYYY-MM-DD>/rollup.json`, then `gslive-tally/latest.json` as a **pointer**
  (`{schemaVersion, deskDate, key, sha256, generatedAt}`); the pointer is the only mutable object.
- Metadata: `x-amz-meta-pii: none`, schema version, desk date, generated-at, source hash, row counts.
- Overwrite is idempotent per desk date; newer generatedAt replaces; read-back hash verified before
  pointer flip. Ceiling **< 256 KiB**.
- Never upload raw rows, `ipAddress`, `userID`, login/agent ids, ticket/wager/group ids, or
  `FreePlay` details.

## 6. Cross-system reconciliation (3c ↔ 3b/3d)

For each desk date, compare the GSLive upstream ledger with the GSLIVE + GSBUILDER slice of the
Fantasy402 DGS ledger:

```text
3c.settledNetCents[date]            ≈ 3d.settledNetCents[date, channel IN (GSLIVE, GSBUILDER)]
3c.openExposureCents[date]          ≈ 3b.definedLiabilityCents[date, channel IN (GSLIVE, GSBUILDER)]

residual =
   observed3c - expectedDgs
   - utcDeskDateBoundaryCents
   - widgetRejectedOrCancelledCents
   - unsettledCrossWindowCarryCents
```

The three enumerated legitimate divergences are:

1. **desk-date vs UTC window boundary** — 3c keys by America/Chicago desk date; DGS feeds use UTC
   request windows.
2. **widget-rejected/cancelled bets** — accepted in GSLive but never reach DGS; they appear in the
   widget-rejected bucket, never as handle.
3. **unsettled cross-window carry** — pending bets whose settlement falls outside the desk date;
   carried, not double-counted.

`residual` must be 0 within the declared tolerance for matched windows; any excess is a real
reconciliation failure. The reconciliation report stores only the four bucket cents and counts, no
identifiers.

## 7. Test matrix

1. 24,778-row fixture field projection: no PII key/IP regex; 69 fields mapped, unknown → `other`.
2. Straight/parlay split: type=0 one-row tickets vs type=1 2–8-leg tickets; risk once per group.
3. `M.G<betGroupId>` dedupe; synthetic ifBet/thenBet pair counts once.
4. CLV: `fc` missing/zero → null and `eligible=0`; valid f/fc → `f-fc`; denominator excludes nulls.
5. k=5 complementary suppression; cent conservation for all metrics.
6. 3c↔3b/3d reconciliation fixture with the three divergence buckets; residual zero/tolerance.
