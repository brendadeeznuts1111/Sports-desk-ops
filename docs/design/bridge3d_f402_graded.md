# Bridge 3d — Fantasy402 Graded / Settled (design, no implementation)

Status: **design only.** Stream: batch snapshot
`f402-graded/<YYYY-MM-DD>/rollup.json` + `f402-graded/latest.json` pointer.
Source: Fantasy402 `Report/getGrading` via `lib/f402_graded_wager_row.ts` (`fantasy402.com`).

## 1. Empirical inventory (no row values reproduced)

| Evidence                                                 | Observed                                                                                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/f402-graded-wager-row-1073373500.html`   | 1 parsed row; 21 fields, 0 nulls                                                                                                                                                                                                        |
| `tests/fixtures/f402-graded-wager-row-e-1072619695.html` | 1 parsed row; 21 fields, 0 nulls                                                                                                                                                                                                        |
| `tests/fixtures/f402-graded-wager-rows-g.html`           | 2 rows (`G` type); 21 fields; `team1/team2/line/price/league/market/score/scheduled` null on both                                                                                                                                       |
| `tests/fixtures/f402-graded-wager-rows.html`             | 3 rows; 21 fields, 0 nulls                                                                                                                                                                                                              |
| `data/graded-wagers-export-2026-11-01.json`              | export metadata only: `POST /cloud/api/Report/getGrading`, **9,387 rows**, 5 displayed columns (`Customer, Ticket Number, Accepted, Description, Amount`); workbook not committed because every row carries customer/ticket/description |
| Graded HTML field set                                    | 21 typed fields; multi-leg ticket fanout in these fixtures is 1 (no parlay grouping observed)                                                                                                                                           |
| `FreePlayFlag`                                           | **not present in any graded HTML fixture**; present in the pending wire sample. 3d must source it through the settlement join, not invent it from HTML.                                                                                 |

Fields parsed by `lib/f402_graded_wager_row.ts`:

```text
ticketNumber, wagerNumber, wagerType, selection, selectedTeam, team1, team2,
line, price, riskCents, winCents, status, score, game, league, live, gameNumber,
market, scheduled, accepted, placedOn, gradedAmount
```

`wagerNumber` is `ticketNumber-<n>`; `team1/team2`, `line`, `price`, `league`, `market`,
`score`, `scheduled` are the declared nullable fields (observed null on `G` rows only).

## 2. Pure projection contract

```ts
export interface GradedRollupInput {
  /** Graded rows joined with the settlement identity/free-play flags; no raw HTML. */
  readonly rows: readonly JoinedGradedRow[];
  readonly deskDate: string;
  readonly generatedAt: string;
  readonly minCellSize?: number; // default 5
}

export interface GradedRollupArtifact {
  schemaVersion: 1;
  kind: "sanitized-f402-graded";
  deskDate: string;
  generatedAt: string;
  source: {
    policy: "getGrading";
    rowsAccepted: number;
    rowsDropped: number;
    ticketsDeduped: number;
    freePlayLossRows: number;
    freePlayUnknownRows: number;
  };
  totals: GradedMetrics;
  dimensions: readonly GradedDimensionRow[];
  suppressedResidual: GradedMetrics;
}

export function projectSanitizedGradedRollup(
  input: GradedRollupInput,
): GradedRollupArtifact;
```

`JoinedGradedRow` adds only the fields the HTML parser cannot see: `login` (identity join),
`freePlayFlag: "Y" | "N" | "unknown"`, and the settlement `validTime`. The projector never emits
`login`, ticket ids, selection/team/game/score text.

## 3. Dedupe and free-play principal rule

- **Dedupe key:** `${Login.trim()}|${WagerNumber}|${TicketNumber}`. Keep one row per key; if the
  same ticket appears more than once, latest `validTime` wins (deterministic tie-break by
  `ticketNumber`, `wagerNumber`). Count `ticketsDeduped`.
- **Free play:** `FreePlayFlag === "Y"` and a loss ⇒ `principalDebitCents = 0`,
  `settledNetCents = 0` for the loss; the leg still counts in `legCount` and the row still counts in
  `freePlayLossRows`. Do **not** debit the `riskCents` principal for a free-play loss.
  - `freePlayFlag === "N"` ⇒ normal loss debit (`-riskCents`).
  - `freePlayFlag === "unknown"` (missing from the join/HTML) ⇒ do not assume free play; count
    `freePlayUnknownRows`, apply the normal ledger rule, and expose the count for review.
- **Integer cents:** `riskCents` from `parseFixedPointCents(risk)`; `winCents` from the win/ToWin
  field; `settledNetCents` for win/loss/push/void. No floats; round once at the string boundary.
- `gradedAmount` is display text, not money truth; it may be cross-checked but not summed.
- A row with malformed money/status is dropped (`rowsDropped`), never coerced to zero silently.
- `channel` is `GSLIVE`/`GSBUILDER` from the settlement identity/source join; if unknown, `other` and
  never guessed from free text.

## 4. Reconciliation against `verification/run_four_harness_verification.py`

The four-harness suite is the reference for the integer/error contracts this projection must match:

| Harness invariant                               | 3d application                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `parse_cents_strict` (Harness DOD)              | `parseFixedPointCents` rejects malformed/overflow money; exact integer cents, no float     |
| CRC/envelope persistence                        | artifact hash + read-back verification; no truncated JSON                                  |
| Secret redaction (`scrub_all_secret_encodings`) | failure logs contain no row values, cookies or identifiers                                 |
| Deterministic predicates/bitset truth table     | duplicate/dedupe ordering and cell suppression are deterministic across input permutations |
| Monotonic/tagged-union effects                  | free-play/outcome combinations use explicit tagged states, never sentinel numbers          |

The publisher adds a reconciliation report:
`rowsParsed -> rowsJoined -> rowsDeduped -> rowsCounted` and `rawCents` vs `visible+suppressed`
cents; any unexplained residual fails the build.

## 5. k-anonymity, cent conservation, dimensions

Dimensions: `channel × wagerType × settlementState × sport × period`, bounded labels only.
Metrics: `ticketCount`, `legCount`, `riskCents`, `settledNetCents`, `principalDebitCents`,
`holdBps`, `freePlayLossRows`, `freePlayUnknownRows`.

**Complementary suppression k=5:** fold cells with `ticketCount < 5` into `suppressedResidual`; if
`0 < residual.ticketCount < 5`, suppress the next-smallest sibling (deterministic tie-break) until
the residual is 0 or ≥5. This prevents subtracting totals to isolate a single VIP ticket.

**Cent-conservation identity enforced by tests:**

```text
sum(visibleCells.metric) + suppressedResidual.metric === rawDeduplicatedTotal.metric
for metric in {ticketCount, legCount, riskCents, settledNetCents, principalDebitCents}
```

## 6. R2 contract

- `f402-graded/<YYYY-MM-DD>/rollup.json`, then `f402-graded/latest.json` as a pointer
  (`{schemaVersion,deskDate,key,sha256,generatedAt}`).
- Metadata: `x-amz-meta-pii: none`, schema version, desk date, generated-at, source hash.
- Idempotent per desk date; newer generatedAt replaces; pointer flips only after read-back hash
  verification. Ceiling **< 256 KiB**.
- Never upload raw HTML, raw graded rows, customer/login/ticket ids, selection/team/score text.

## 7. Cross-system reconciliation and test matrix

3c (`gslive-tally`) is the GSLive upstream ledger; 3d is the Fantasy402 DGS graded slice. For the
same desk date:

```text
3c.settledNetCents[date]
  ≈ 3d.settledNetCents[date, channel IN (GSLIVE, GSBUILDER)]
  + deskDateVsUtcWindowCents
  + widgetRejectedOrCancelledCents
  + unsettledCrossWindowCarryCents
```

The three divergence sources are fixed: UTC-vs-desk-date window, widget-rejected/cancelled bets
absent from DGS, and unsettled carry. Residual beyond tolerance is a failure; only cents/counts are
reported, never identifiers.

Tests:

1. Parse all four graded HTML fixtures; 21-field map; nullable `G` rows.
2. Dedupe by `${Login}|${WagerNumber}|${TicketNumber}`; latest valid time wins.
3. FreePlayFlag `Y` loss → `principalDebitCents=0`, `settledNetCents=0`; unknown flag counted, not
   assumed free play; synthetic join fixture because graded HTML lacks the flag.
4. `parse_cents_strict`-equivalent malformed/overflow rejection; no floats.
5. k=5 complementary suppression; cent conservation for all metrics.
6. 3c↔3d reconciliation fixture with all three divergence buckets; residual zero within tolerance.
