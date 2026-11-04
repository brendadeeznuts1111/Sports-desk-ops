# Pending-source verification — BB55103 artifacts

**Status: PARTIAL / PATH B.** The one-customer ledger invariant is **verified**. The
population-level question — how many customers have pending bets — still cannot be computed from
these artifacts. No count is produced.

Inputs: `Scratch/f402-transactions-BB55103.json` (33 rows), `Scratch/f402-getInfoPlayer-BB55103.json`
(INFO), `Scratch/f402-network-log.txt` (request fields; no credentials).

## 1. Ledger invariant — PASS (one customer, 33/33 rows)

Sign convention: `TranCode C` = +, `D` = −. Row 1 starts from balance 0.

|   # |   Document | Code | Type | Amount (cents) |  Balance | Expected | Result |
| --: | ---------: | ---- | ---- | -------------: | -------: | -------: | ------ |
|   1 | 1068258269 | D    | L    |         200000 |  -200000 |  -200000 | PASS   |
|   2 | 1068991066 | C    | W    |         200000 |        0 |        0 | PASS   |
|   3 | 1069032471 | D    | L    |         220000 |  -220000 |  -220000 | PASS   |
|   4 | 1069311948 | D    | L    |         250000 |  -470000 |  -470000 | PASS   |
|   5 | 1069338166 | C    | W    |         200000 |  -270000 |  -270000 | PASS   |
|   6 | 1069367680 | C    | W    |         200000 |   -70000 |   -70000 | PASS   |
|   7 | 1069427569 | C    | W    |         200000 |   130000 |   130000 | PASS   |
|   8 | 1069497272 | D    | L    |         210000 |   -80000 |   -80000 | PASS   |
|   9 | 1069516878 | C    | W    |         200000 |   120000 |   120000 | PASS   |
|  10 | 1069517701 | D    | L    |         220000 |  -100000 |  -100000 | PASS   |
|  11 | 1069587407 | D    | L    |         220000 |  -320000 |  -320000 | PASS   |
|  12 | 1069677422 | D    | L    |         220000 |  -540000 |  -540000 | PASS   |
|  13 | 1069677436 | D    | L    |         220000 |  -760000 |  -760000 | PASS   |
|  14 | 1069687961 | D    | L    |         220000 |  -980000 |  -980000 | PASS   |
|  15 | 1070132862 | C    | W    |         200000 |  -780000 |  -780000 | PASS   |
|  16 | 1070345181 | D    | L    |         220000 | -1000000 | -1000000 | PASS   |
|  17 | 1070701556 | C    | E    |        1000000 |        0 |        0 | PASS   |
|  18 | 1071959816 | C    | W    |         200000 |   200000 |   200000 | PASS   |
|  19 | 1072061501 | D    | L    |         220000 |   -20000 |   -20000 | PASS   |
|  20 | 1072069295 | D    | L    |         220000 |  -240000 |  -240000 | PASS   |
|  21 | 1072329586 | C    | W    |         200000 |   -40000 |   -40000 | PASS   |
|  22 | 1072380530 | C    | W    |         200000 |   160000 |   160000 | PASS   |
|  23 | 1072453098 | C    | W    |         560000 |   720000 |   720000 | PASS   |
|  24 | 1072761955 | C    | W    |         200000 |   920000 |   920000 | PASS   |
|  25 | 1072769791 | C    | W    |         200000 |  1120000 |  1120000 | PASS   |
|  26 | 1072791683 | C    | W    |          50000 |  1170000 |  1170000 | PASS   |
|  27 | 1072822397 | D    | L    |          50000 |  1120000 |  1120000 | PASS   |
|  28 | 1072824589 | C    | W    |         200000 |  1320000 |  1320000 | PASS   |
|  29 | 1073036085 | C    | W    |          72500 |  1392500 |  1392500 | PASS   |
|  30 | 1073167618 | C    | W    |          50000 |  1442500 |  1442500 | PASS   |
|  31 | 1073384192 | C    | W    |         200000 |  1642500 |  1642500 | PASS   |
|  32 | 1074088789 | D    | I    |        1642500 |        0 |        0 | PASS   |
|  33 | 1074393688 | C    | W    |         200000 |   200000 |   200000 | PASS   |

**Failures: none.** Final ledger balance **200000** = `INFO.data.CurrentBalance`
**200000**. Signed sum = **200000**.

### Available-balance formula — PASS

INFO carries `INFO.balance.AvailableBalance = 4960000`; `INFO.data` carries
`CurrentBalance = 200000`, `PendingWagerBalance = 240000`, `CreditLimit = 5000000`.

```
AvailableBalance = CurrentBalance - PendingWagerBalance + CreditLimit
                 = 200000 - 240000 + 5000000
                 = 4960000
```

Formula matches: **True**. This is the first verified customer-level financial invariant in
the pack.

### Pending is not a transaction row

`INFO.data.PendingWagerCount = 1` and
`PendingWagerBalance = 240000`. No ledger row has a pending description, and no row’s `Amount` equals
the pending balance. Pending is a **separate state/field**, not a cash movement in this ledger.

## 2. Lifecycle model from the 33 rows

| Code / Type | Description         | Rows | GradeNum? | Classification            |
| ----------- | ------------------- | ---: | --------- | ------------------------- |
| `C` / `W`   | Wager Won           |   18 | yes       | settlement credit (wager) |
| `D` / `L`   | Wager Loss          |   13 | yes       | settlement debit (wager)  |
| `C` / `E`   | Customer Deposit    |    1 | no        | cash movement (non-wager) |
| `D` / `I`   | Customer Withdrawal |    1 | no        | cash movement (non-wager) |

**Does any TranType represent a pending wager? No.** There is no pending code/type in the 33 rows.
Pending lives in `getPending` (per-wager) and `getInfoPlayer` (per-customer count/balance), not in
this transaction ledger. A complete server `TranType` vocabulary is still unconfirmed; these are the
four combinations present for this customer.

## 3. Where pending state lives

| Artifact/module                                  | Fields                                                                      | Granularity                 | Called when                       |
| ------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------- | --------------------------------- |
| `Scratch/f402-getInfoPlayer-BB55103.json`        | `PendingWagerCount`, `PendingWagerBalance`, `PendingCredit`                 | **per customer**            | player-info                       |
| `Scratch/f402-probes/*/Pending.json`             | Pending array, `WagerStatus "P"`                                            | **per wager**               | `getPending` per customer         |
| `Scratch/f402-customer-admin/list.redacted.json` | `PendingWagerBalance` only (2 rows)                                         | per customer row            | customer-admin table              |
| `Scratch/f402-customer-admin/summary.json`       | `rowsWithPending: 2`, total balance                                         | local aggregate over 2 rows | derived artifact, not an endpoint |
| pinned modules                                   | `getPending`, `getInfoPlayer`, `getCustomerAdmin`, `getTotalActiveCustomer` | per-customer/per-wager/list | existing client calls             |

No artifact contains a **population count of customers with pending wagers**. The closest is
`PendingWagerCount` per customer, which requires one `getInfoPlayer` call per customer.

## 3b. Deletion lifecycle — probe inconclusive

The deleted-transactions envelope cannot extend the 33-row lifecycle model yet:

- 0 `DocumentNumber` overlap with the BB55103 ledger.
- It is a **different customer**; the BB55103 ledger rows carry no per-row `CustomerID` (the file is
  scoped by account), so the two artifacts cannot be joined.
- No `Balance` column, no `CoverageDocumentNumber`.
- Its rows are **9 `C/E` deposits and 2 `D/I` withdrawals** — not wager deletions/reversals.

Therefore the question “when a deposit or wager is deleted, is the main ledger's running balance
retroactively corrected?” is **untestable from these artifacts**. It needs a same-customer deleted
transaction plus that customer's full ledger, or a server statement of deletion semantics. The
lifecycle model has a deletion gap; it is not evidence that the gap is safe or unsafe.

## 4. Aggregate endpoint — no

The network log contains only `getTransactionList` (account BB55103, start 2026-10-28) and
`getInfoPlayer` (same account); it has no `getPending` call and no aggregate call. The pinned
controller/modules contain no pending-customer aggregate operation. `getCustomerAdmin` returns a
multi-row list with `PendingWagerBalance` but **no count**; `getTotalActiveCustomer`/`getPlayerCount`
count active/players, not pending customers; `getConfigWebReportsPending` is display configuration.

**Answer: no aggregate pending-customer-count endpoint in the available evidence.** There is no
network log of an uncalled one, so “none found,” not “server has none.”

## Sharpened aggregate ask

The one-customer invariant changes the server ask from “build a reconciliation ledger” to “expose a
count over state that already exists”:

```text
input:  { agentID }
output: [{ customerID, hasPending, pendingTotal }]   // or a total count
```

`PendingWagerCount`/`PendingWagerBalance` are already in `getInfoPlayer`; the aggregate is a query
addition over verified per-customer fields, not a new ledger/schema. `hasPending` can be derived as
`PendingWagerCount > 0` or `PendingWagerBalance > 0` once settlement/compliance pick the definition.
The three definitions and the Bearer verdict remain upstream.

## Path B finding

The count cannot be computed from these artifacts. The ledger invariant is verified for **one**
customer, but that does not scale to 57,763, and a client crawl over `getInfoPlayer` would be a
display crawl, not a settlement source. The specific missing source is a **population-level
aggregate of pending customer state** (or the authoritative transaction log/reconciliation plus a
documented lifecycle definition). Settlement/compliance definitions and item 2’s Bearer verdict
remain upstream.

To unblock: provide an aggregate endpoint (customer ID → pending count/balance, or a total), or the
authoritative transaction log/replica with a join key and signed settlement/compliance definitions.
Then run the 20-customer sample acceptance from the task.

## Multi-customer sample — planned, not run

Only **one** customer ledger is on disk (BB55103). The other transaction-shaped artifacts are not
usable for the invariant: the `getTransactions` probes are empty/500, the deleted-transactions
sample has 11 rows but no `Balance`, and the customer-admin list has 2 customer rows but no ledgers.
Therefore the generalization test has not been run.

To run it: place 3–5 redacted ledgers and their INFO responses in `Scratch/` using the same shape as
BB55103. The check is scripted and takes minutes, not an hour:

1. `Balance[n] = Balance[n-1] + signed(Amount)` for every row.
2. Final balance = `INFO.data.CurrentBalance`.
3. `INFO.balance.AvailableBalance = CurrentBalance − PendingWagerBalance + CreditLimit`.
4. `PendingWagerCount`/`PendingWagerBalance` do not appear as ledger rows.
5. `TranType` table remains free of a pending row type.

**Acceptance:** 3/5 or better pass → “ledger model” instead of “one customer.” Any fail → report the
failing row and treat it as the headline finding, not a Path B blocker. Until the ledgers exist, the
invariant is verified for **one** customer only.

## What this does not answer

- The actual count.
- The settlement team’s definition of pending/end-of-day.
- The compliance definition of active customer/open position.
- Whether the server has an uncalled aggregate endpoint (no network log).

## Links

- Item 3 financial reconciliation: `03-financial-controls.md`
- Item 2 Bearer verdict: upstream blocker
- Prior feasibility finding: `08-pending-customer-count-feasibility.md`
