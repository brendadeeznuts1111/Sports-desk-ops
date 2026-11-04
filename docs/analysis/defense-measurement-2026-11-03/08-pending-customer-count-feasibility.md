# Pending-customer count — feasibility finding

**Status: PATH B — BLOCKED. No count is produced.** The question is "how many customers have pending
bets." This document establishes that the count cannot be computed meaningfully from anything in this
repository/environment, and names the missing sources. It is input to item 3 (financial reconciliation),
not a replacement for it.

`[CODE]` = read from repo code; `[OBSERVED]` = recorded evidence; `[UNVERIFIED]` = not confirmed
against the server or the owning teams; `[BLOCKED]` = input unavailable here.

## 1. Decision definition — no consumer found

`[CODE]` The desk KPI reports **wager/ticket** counts and amounts, not customer-level counts:
`lib/desk_kpis.ts` exposes `pending.wagers`, `pending.tickets`, `pending.wageredCents`,
`pending.toWinCents`, and marks a pending capture stale after 3,600 s. `lib/live_bets.ts` exposes
`pendingCount` (rows), `totalPending`, and per-agent/sport buckets — still not "customers with
pending bets."

No code, doc, or runbook in this repo consumes a customer-level pending count. `[OBSERVED]` The
portal's "Pending 2,400" figure matched a pending row's `AmountWagered = 240000` cents — **$2,400,
not 2,400 customers**. The displayed number is an amount, so it cannot answer the customer-count
question at all.

Under the task's own rule, if no decision changes when the operator learns the number, **the count is
theater**. The
decision owner must answer:

> What action changes if the count is 1,200 vs 1,800? (risk review, staffing, exposure limit,
> compliance report, or nothing)

Until that is answered, the count is not actionable even if computed. `[UNVERIFIED]` There may be an
operator/compliance decision outside this repo; it is not documented here.

## 2. Lifecycle model — client vocabulary, server states unconfirmed

`[CODE]` The settlement ingest deliberately models **two axes**:

- outcome: `W` win, `L` loss, `P` push, `V` void
- lifecycle: `P` pending, `S` settled, `C` cancelled

Wire aliases recognized by `normalizeOutcome`/`normalizeLifecycle` (`lib/fantasy402_settlement_ingest.ts`):
`W/WIN/WON/WINNER`, `L/LOSS/LOST/LOSER`, `PUSH`, `VOID/V/NOACTION`; `P/PENDING/OPEN/UNRESOLVED`,
`S/SETTLED/GRADED/CLOSED`, `C/CANCELLED/CANCELED/VOIDED`. Bare `P` means **pending** on the lifecycle
axis and is only read as push when spelled `PUSH` — the vocabulary collision is explicit in the code.

| Candidate state | Evidence in repo                                                 | Pending?          | Unknown                                                 |
| --------------- | ---------------------------------------------------------------- | ----------------- | ------------------------------------------------------- |
| placed          | `InsertDateTime`, `PlacedOn`, `TicketWriter` `[CODE]`            | no                | server write order/timestamp semantics                  |
| accepted        | `AcceptedDateTime` `[CODE]`                                      | no                | whether acceptance is required before pending           |
| live            | no distinct field in pending/history rows `[CODE]`               | no separate state | server live state                                       |
| pending         | lifecycle `P`; `getPending` rows have `WagerStatus` `P` `[CODE]` | **candidate yes** | whether "pending" includes unsettled live/future wagers |
| settled         | lifecycle `S`, outcome `W/L/P` `[CODE]`                          | no                | paid vs settled distinction                             |
| graded          | `getGrading` rows, normalized as settled `[CODE]`                | no                | graded vs paid                                          |
| paid            | no field in ingest schema `[CODE]`                               | no                | whether payout is a separate state                      |
| voided          | lifecycle `C` or outcome `V`; `AmountRefunded` `[CODE]`          | no                | void vs cancel vs reversal vocabulary                   |
| reversed        | no explicit state `[CODE]`                                       | no                | server reversal transition                              |

**Candidate pending definition for discussion, not signed:** lifecycle `P` at the observation time,
with no settlement timestamp, and the row still present in `getPending`. The server's actual state
list and the settlement team's definition are `[BLOCKED]` (no settlement team access).

## 3. Lineage trace — failed; four key namespaces

A one-customer transaction-list response and one pending row were observed (values redacted here).
They cannot be joined. This is the work-item result: **the trace fails at the join**, so there is no
"three wager" trace to complete.

| Namespace                   | Source                              | Key                          | What it carries                                                                                                                     | Gap                                                                                                                                                         |
| --------------------------- | ----------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pending snapshot            | `Manager/getPending`                | `TicketNumber-WagerNumber`   | `WagerStatus P`, `AmountWagered`, `ToWinAmount`, `AcceptedDateTime`, `GameDateTime`, `PlacedOn`, customer/agent scope               | no `DocumentNumber`/`GradeNum`; future-game rows are pending; no settlement timestamp                                                                       |
| settlement observation      | `Manager/getHistory` / `getGrading` | `LOGIN                       | WAGERNUMBER` (`fantasy402TicketId`)                                                                                                 | `WagerStatus`, `Result`, `SettlementDateTime`, `Amount/Risk/ToWin/AmountRefunded`                                                                           | no `TicketNumber`, `DocumentNumber`, or `GradeNum`; a bare `P` is lifecycle pending, not push |
| customer transaction ledger | `Manager/getTransactionList`        | `DocumentNumber`, `GradeNum` | `TranCode/TranType`, `Amount`, `Description`, `TranDateTime`, `Balance`; wager wins/losses **and** deposits/withdrawals in one list | **no `TicketNumber`, `WagerNumber`, or per-row `CustomerID`**; customer is scoped by the request `acc`; `GradeNum` is not modelled by the settlement ingest |
| display filter              | portal transaction UI               | none                         | `All Transactions` / `Deposit/Withdrawal` / `Betting Adjustments` / `Wagers Only` / `Deleted/Changed`                               | non-wager rows are mixed in; a naive count includes deposits/withdrawals                                                                                    |

`[CODE]` The repo's deleted-transaction parsers recognize `DocumentNumber`, `TranCode`, `TranType`,
`GradeNum` (`lib/f402_deleted_transaction_history.ts`, `lib/f402_deleted_wager_list.ts`), confirming
the ledger vocabulary — but the settlement ingest has no column for any of them.

`[OBSERVED]` The observed ledger contains rows such as `Wager Won` / `Wager Loss` with a `GradeNum`
and running `Balance`, but no wager/ticket identifier. The observed pending row has
`TicketNumber`/`WagerNumber` and status `P`, but no `DocumentNumber`/`GradeNum`. There is no field in
common across all three.

**Work-item 3 result: FAILED.** A real end-to-end trace requires the server's authoritative
wager/transaction log with a documented join key, not a display ledger. That source is missing.

## 4. Invariant specification — must be sourced, not invented

The task supplies candidate examples; **none is signed by the settlement or compliance team**, and
the repo has no reconciliation invariant (`03-financial-controls.md`). Required from the teams:

1. Definition of "active customer" and "open position" used in regulatory/reporting contexts.
2. Definition of "pending" (state set, whether live/future/unsettled-push counts, time boundary).
3. Whether every pending wager must have an accepted timestamp and a placement timestamp.
4. Whether `sum(pending risk) = placed - settled - voided` is expected, over which window.
5. Whether a customer with pending wagers must have balance ≥ pending risk, and what happens when
   not (credit/negative balance semantics).
6. Which clock/date the count is "as of" (capture time, settlement day, operator timezone).

These are `[BLOCKED]` questions, not assumptions. The task's examples remain hypotheses until the
teams replace them.

## 5. Wrong-answer detector — defined now

Before any count is quoted, each case must fail or be explained:

| #   | Negative case                                               | Expected detector behavior                        |
| --- | ----------------------------------------------------------- | ------------------------------------------------- |
| N1  | Negative balance or negative pending risk                   | reject/flag; never silently clamp                 |
| N2  | `sum(pending) != placed - settled - voided` on a known date | fail reconciliation; do not quote                 |
| N3  | Customer ID in the log not present in the customer book     | unresolved count; do not drop silently            |
| N4  | Frozen/closed/deleted agent in the pending set              | flag; exclude only with a recorded rule           |
| N5  | Settlement timestamp in the future, or before placement     | reject row; do not count                          |
| N6  | Wager with no placement timestamp                           | cannot classify; count unknown, not zero          |
| N7  | Bare `P` row where outcome=PUSH is possible                 | must disambiguate by feed; otherwise reject       |
| N8  | Duplicate ticket key / leg duplication                      | dedupe by canonical key and record it             |
| N9  | Canceled/voided row still in pending                        | fail; stale snapshot                              |
| N10 | Pending capture older than one hour                         | do not quote; `desk_kpis` already treats it stale |
| N11 | Count computed from JSON capture/HAR display values         | invalid by definition; source must be the log     |
| N12 | Ledger row has no ticket/wager key                          | cannot attribute to a wager; do not count it      |
| N13 | Non-wager deposit/withdrawal/adjustment included            | exclude by signed definition, not by guessing     |
| N14 | Two ledger rows with the same timestamp/amount              | duplicate vs legitimate; dedupe by documented key |

## 6. Sample-based acceptance — protocol, blocked

Required before Path A:

1. Pick 20 customers spanning master/sub-agent/player, pending/settled/voided, zero-pending.
2. Re-derive each pending count by hand from the raw wager transaction log, with event timestamps.
3. Compare to the automated query; any disagreement on 20 means the query is not quotable for 57,763.
4. Settlement team confirms the count matches its end-of-day on a named date.
5. Compliance confirms the definition matches regulatory reporting.

`[BLOCKED]` No raw log, no named date, no team access, no test environment with known pending wagers.

## 7. Raw inputs required

| Input                                                      | Owner                        | Status                                          |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| Server wager transaction log / read replica                | server team + settlement     | `[BLOCKED]`                                     |
| Daily settlement report for one named date                 | settlement team              | `[BLOCKED]`                                     |
| "Active customer" / "open position" definitions            | compliance                   | `[BLOCKED]`                                     |
| Reconciliation ledger, or written confirmation none exists | settlement + business owner  | `[BLOCKED]` (repo finding: none in client repo) |
| Test environment with known pending wagers                 | business owner + server team | `[BLOCKED]`                                     |
| Settlement team lead ~1 hour                               | settlement                   | `[BLOCKED]`                                     |
| Compliance lead ~1 hour                                    | compliance                   | `[BLOCKED]`                                     |
| Test account + authorization                               | business owner/compliance    | `[BLOCKED]` (requested in issue #23)            |

## 8. Acceptance — Path B

- [x] Written finding names the specific missing source: **authoritative wager transaction log /
      settlement reconciliation**, plus the **definitions** and **test environment**.
- [x] Linked from `03-financial-controls.md` (item 3) as input to reconciliation work.
- [x] Test account and authorization requested as part of the unblock (issue #23).
- [ ] Count produced — not met; no raw source, no signed definitions, no 20-customer sample.

**What would move this to Path A:** access to the transaction log/replica, the settlement report for
a named date, written compliance definitions, a test environment with known pending wagers, and the
two one-hour team sessions. Until then, any number is a display snapshot, not a count.

## 9. Open questions for the owners

1. What decision consumes the customer-level count? If none, stop.
2. Which server states are "pending," and which are "open position"?
3. Is the transaction log the settlement feed, or a separate ledger? Can it be read?
4. What is the authoritative join key between display `TicketNumber-WagerNumber` and settlement
   `Login|WagerNumber`?
5. Is `updateDistribution`/financial audit part of this reconciliation, or separate (item 3)?
