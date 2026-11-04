# Bridge 3b — Fantasy402 Pending Bets (design, no implementation)

Status: **design only.** Stream: `f402-pending` WS delta + `f402-pending/latest.json` snapshot.
Source: Fantasy402 `Manager/getPending` / `Report/Pending` open liability (`fantasy402.com`).

## 1. Empirical inventory (no PII values reproduced)

| Evidence                                                     | Observed                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/evidence/captures/2026-11-01/Pending.post.json`        | `response.bodySkeleton.fields.Pending.items` has **73 fields**, `truncated: true`; **21 nullable**, **52 non-null**                                            |
| Same capture                                                 | `samples` count only; no full 73-field row bodies committed                                                                                                    |
| `tests/f402-pending-wager-sample.json`                       | 46 fields (subset), 1 sample row                                                                                                                               |
| `tests/fixtures/pending-panel-datatables-2026-11-03.html`    | 8 display columns (`Agent, Customer, Name, Accepted (CST), Scheduled, Description, Risk, To Win`), 8 data rows — a panel projection, not the 73-field wire row |
| `data/live-bets.json`                                        | `pendingCount: 2`, 2 games; game shape has 19 fields (`ticketNumber`, `wagerNumber`, `picks`, `wagered`, `toWin`, `status`, `sport`, `subSport`, `period`, …)  |
| DGS rotation sample (`tests/f402-pending-wager-sample.json`) | `Team1RotNum=243`, `Team2RotNum=244`; no 5000-range row observed in this sample                                                                                |

**Field map (all 73 wire names observed):**

```text
ARBirdcageLink, ARLink, AcceptedDateTime, AdjSpread, AdjTotalPoints,
AdjustableOddsFlag, AmountLost, AmountRefunded, AmountWagered, AmountWon,
BoxLink, BuyPoints, ChosenTeamID, Comments, ContinueOnPushFlag,
CreditAcctFlag, Description, FinalDecimal, FinalMoney, FreePlayFlag,
GameDateTime, ItemNumber, LegAmountWagered, LegToWinAmount, LegWagerType,
ListedPitcher1, ListedPitcher2, Login, LogoTeam1, LogoTeam2, NameFirst,
OrigSpread, OrigTotalPoints, Outcome, ParlayName, Password,
PeriodDescription, PeriodNumber, Pitcher1ReqFlag, Pitcher2ReqFlag,
PlacedOn, PlayNumber, RifBackwardTicketNumber, RifBackwardWagerNumber,
RifForwardAmountWagered, RifForwardTicketNumber, RifForwardWagerNumber,
RifForwardWinOnlyFlag, RifNoActionFlag, RifWinOnlyFlag, RoundRobinLink,
ShortName1, ShortName2, SportSubType, SportType, Team1FinalScore, Team1ID,
Team1RotNum, Team2FinalScore, Team2ID, Team2RotNum, TeaserName, TeaserPoints,
TicketNumber, Ties, ToWinAmount, TotalPointsOU, WagerCount, WagerNumber,
WagerStatus, WagerType, customerID, totalPicks
```

Nullable in the skeleton: `ARBirdcageLink`, `ARLink`, `AmountLost`, `AmountRefunded`, `AmountWon`,
`BoxLink`, `ContinueOnPushFlag`, `FinalDecimal`, `ListedPitcher1`, `ListedPitcher2`,
`RifBackwardTicketNumber`, `RifBackwardWagerNumber`, `RifForwardAmountWagered`,
`RifForwardTicketNumber`, `RifForwardWagerNumber`, `RifForwardWinOnlyFlag`, `RifNoActionFlag`,
`RifWinOnlyFlag`, `RoundRobinLink`, `TeaserName`, `TotalPointsOU`.

## 2. Pure projection contract

```ts
export interface PendingRollupInput {
  readonly rows: readonly RawPendingWireRow[];
  readonly deskDate: string;
  readonly generatedAt: string;
  readonly minCellSize?: number; // default 5
}

export interface PendingRollupArtifact {
  schemaVersion: 1;
  kind: "sanitized-f402-pending";
  deskDate: string;
  generatedAt: string;
  source: {
    policy: "getPending";
    rowsAccepted: number;
    rowsDropped: number;
    ticketsDeduped: number;
  };
  totals: PendingMetrics;
  dimensions: readonly PendingDimensionRow[];
  suppressedResidual: PendingMetrics;
  watermark: { wagerNumber: string; highestTicketNumber: string } | null;
}

export function projectSanitizedPendingRollup(
  input: PendingRollupInput,
): PendingRollupArtifact;
```

No I/O, network, clock, or filesystem. The publisher serializes and calls
`assertSanitizedSettlementRollup` from the shared PII contract.

## 3. Dedupe, rotations, and fixed-point lines

- **Parent-ticket dedupe key:** `${Login.trim()}|${WagerNumber}|${TicketNumber}`.
  A parlay parent is counted once; its leg rows are counted as `legCount` only.
- Secondary key `${TicketNumber}-${WagerNumber}-${totalPicks}`: **first occurrence wins**; later
  rows with the same parent/leg count are dropped and `ticketsDeduped` increments.
- **DGS rotations:** if a rotation is in `[5000..5999]`, normalize `rot -= 5000`; strip
  `Period`/`Live` prefixes from the rotation/period fields before comparing. Store
  `rotationHundredths` as an integer (not a float).
- **Effective lines (integer `LineHundredths`):**
  - parse `AdjSpread`, `AdjTotalPoints`, `OrigSpread`, `OrigTotalPoints`, `TeaserPoints` and
    `BuyPoints` with fixed-point string parsing (`* 100`, round once; reject non-finite/NaN);
  - choose side from `ChosenTeamID` (`team1` vs `team2`);
  - spread: `effectiveSpreadHundredths = adjSpreadHundredths + teaserPointsHundredths * sideSign`;
  - total: `effectiveTotalHundredths = adjTotalHundredths ± teaserPointsHundredths`, with the sign
    flipped for Over vs Under; store `totalSide: "over" | "under"`;
  - `sideSign = +1` for `team1`, `-1` for `team2`; the chosen side is a bounded enum, never a name.
- `totalStakeCents` = parent `AmountWagered` once; `potentialPayoutCents` = parent `ToWinAmount`
  once; **`definedLiabilityCents = potentialPayoutCents`** (gross worst-case payout, never summed
  per leg). `netExposureCents = max(potentialPayoutCents - totalStakeCents, 0)` is diagnostic only.
- `FreePlayFlag === "Y"` is carried only as a bounded boolean; free-play stake does not increase
  `totalStakeCents` twice.

## 4. Dimensions, metrics, suppression, cent conservation

Dimensions: `sportSubType × period × wagerType × openStatus × rotationClass` (bounded labels;
unknown → `other`). Metrics: `ticketCount`, `legCount`, `totalStakeCents`, `potentialPayoutCents`,
`definedLiabilityCents`, `wagerNumber` watermark (aggregate string only).

**Complementary suppression (k=5):** fold every cell with `ticketCount < 5` into
`suppressedResidual`. If `0 < suppressedResidual.ticketCount < 5`, suppress the next-smallest
sibling cell (deterministic label tie-break), repeat until the residual is either 0 or at least 5.
Never publish a residual in `(0,5)` that could be differenced against totals to isolate one VIP
ticket.

**Cent-conservation identity enforced by tests:**

```text
sum(visibleCells.metric) + suppressedResidual.metric
  === rawDeduplicatedTotal.metric
for metric in {ticketCount, legCount, totalStakeCents, potentialPayoutCents,
               definedLiabilityCents}
```

## 5. R2 snapshot

- `f402-pending/latest.json`, content type `application/json`.
- Metadata: `x-amz-meta-pii: none`, `schema-version=1`, `desk-date`, `generated-at`,
  `watermark`, `sha256`.
- Idempotent by `(deskDate, watermark, sha256)`; newer watermark replaces, identical content is a
  no-op. Serialized artifact ceiling **< 256 KiB**.
- Fail closed: malformed/null-key rows are dropped and counted; a failed drain never replaces the
  last good snapshot.

## 6. Test matrix

1. 73-field synthetic row map (field names/nullability) with sentinel PII → no PII in JSON.
2. Parent-ticket dedupe: multi-leg parlay → `ticketCount=1`, `legCount=N`, stake/payout once.
3. DGS rotation 5000-range + Period/Live prefix normalization; spread/total teaser sign flip;
   integer hundredths (no floating-point drift).
4. Complementary suppression: residual never in `(0,5)`; cent conservation for all metrics.
5. Malformed/null fields, duplicate rows, watermark regression → fail closed/no R2 replace.
