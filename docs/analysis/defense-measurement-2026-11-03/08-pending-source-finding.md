# Pending-source verification — artifact finding

**Status: PARTIAL / PATH B.** The three named artifacts do not exist on disk, so the row-by-row
ledger check cannot be performed. The available proxy artifacts still answer where pending state
lives and whether an aggregate count endpoint exists. No count is produced.

This verifies/updates `08-pending-customer-count-feasibility.md`; it is input to item 3 and item 2.

## Artifact availability

| Claimed artifact                          | On disk? | Evidence                                                                                                               |
| ----------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Scratch/f402-transactions-BB55103.json`  | **no**   | `find`/`grep` returned no file; the document numbers from the observed ledger (e.g. `1068258269`) appear in no capture |
| `Scratch/f402-getInfoPlayer-BB55103.json` | **no**   | no file; the only `getInfoPlayer` artifact is for a different customer, BILLY666                                       |
| `Scratch/f402-network-log.txt`            | **no**   | no such file; no equivalent request log under `Scratch/`                                                               |

Available proxies:

- `Scratch/f402-probes/2026-11-01T04-43-50-859Z/getInfoPlayer.json` — probe metadata plus a
  **2,000-byte preview** of a 54,577-byte response for BILLY666; the preview contains
  `PendingWagerCount: 0`, `PendingWagerBalance: 0`, `PendingCredit: 0`, `CurrentBalance: 0`,
  `CreditLimit: 0`.
- `Scratch/f402-customer-admin/list.redacted.json` — **2 rows**, fields `CurrentBalance`,
  `PendingWagerBalance`, `AvailableBalance`; no `PendingWagerCount`/`PendingCredit`/`CreditLimit`.
- `Scratch/f402-customer-admin/summary.json` — local summary over those 2 rows:
  `rowCount: 2`, `rowsWithPending: 2`, `totalPendingWagerBalance: 4411500`.
- `Scratch/f402-probes/*/Pending.json` — per-wager `getPending` probes; one 200 with a Pending array
  for customer H1716, one 500 for a templated `{customerID}` body.

## 1. Ledger invariant — NOT VERIFIED

The required 33-row ledger is absent, so none of these can be checked:

| Check                                                                   | Required evidence                                  | Result                                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `Balance[n] = Balance[n-1] + signed(Amount)`                            | 33-row ledger with `TranCode`, `Amount`, `Balance` | **NOT VERIFIED — artifact absent**                                              |
| final `Balance` = `getInfoPlayer.CurrentBalance`                        | BB55103 ledger + INFO response                     | **NOT VERIFIED — both absent**                                                  |
| `AvailableBalance = CurrentBalance - PendingWagerBalance + CreditLimit` | INFO fields incl. credit limit                     | **NOT VERIFIED — no BB55103 INFO; proxy INFO is preview-only and for BILLY666** |
| `PendingWagerBalance` absent from transaction rows                      | BB55103 ledger                                     | **NOT VERIFIED — ledger absent**                                                |

The `customer-admin` proxies cannot substitute: they carry `PendingWagerBalance` but not
`CreditLimit`, so the available-balance formula is underdetermined; the two rows have different
implied credit amounts. The `getInfoPlayer` proxy is a truncated preview for a different customer
and cannot verify BB55103's ending balance.

**This is not the first verified customer-level invariant.** The invariant remains unproven.

## 2. Lifecycle model — incomplete without the ledger

The absent ledger means there is no complete `TranCode`/`TranType` table for BB55103. What the
available artifacts show:

| Observation                                                                                        | Evidence                                              | Meaning                                                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| pending wagers are returned by `getPending`, not the transaction list                              | `Pending.json`: Pending array with `WagerStatus: "P"` | pending state is a **per-wager snapshot endpoint**         |
| `getInfoPlayer` exposes per-customer `PendingWagerCount` / `PendingWagerBalance` / `PendingCredit` | probe preview                                         | per-customer aggregate fields exist                        |
| `customer-admin` list exposes `PendingWagerBalance` per row, no count                              | 2-row redacted list                                   | a multi-row display list, not an aggregate count           |
| available deleted-transactions sample has `TranCode`/`TranType` (`C`/`E`) and no `Balance`         | 11-row envelope                                       | ledger vocabulary exists, but it is not the BB55103 ledger |

**Does any TranType represent pending?** The available artifacts cannot answer for the absent
BB55103 ledger. `getPending` is a separate endpoint, so pending is represented as a **response
state**, not as a transaction row in the observed sample. The finding is: **pending is not visible in
the transaction ledger artifact available on disk; that artifact is missing.** A complete TranType
table requires the ledger.

## 3. Where pending state lives

| Artifact/module                  | Field                                                                       | Granularity                     | Called when                                |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------ |
| `getInfoPlayer` probe (BILLY666) | `PendingWagerCount`, `PendingWagerBalance`, `PendingCredit`                 | **per customer**                | player-info panel / `getInfoPlayer`        |
| `getPending` probes              | Pending array rows with `WagerStatus: "P"`                                  | **per wager**                   | pending report / `getPending` per customer |
| `customer-admin` list            | `PendingWagerBalance` only                                                  | **per customer row**            | customer-admin table (multi-row display)   |
| `customer-admin` summary         | `rowsWithPending`, `totalPendingWagerBalance`                               | **local aggregate over 2 rows** | derived artifact, not a server endpoint    |
| pinned modules                   | `getPending`, `getInfoPlayer`, `getCustomerAdmin`, `getTotalActiveCustomer` | per-customer/per-wager/list     | existing client calls                      |

No artifact contains a **count of all customers with pending wagers**. The closest is
`PendingWagerCount` per customer (requires one call per customer) and the 2-row local summary.

## 4. Aggregate endpoint — no

Searching the pinned controller/modules and probes for `Pending|Count|Summary|Aggregate|Stats`
operations found:

- `getPending` — per-customer wager rows.
- `getInfoPlayer` — per-customer INFO.
- `getCustomerAdmin` — multi-row customer list with `PendingWagerBalance`, **not a count**, and the
  observed artifact is only 2 rows.
- `getTotalActiveCustomer` / `getPlayerCount` / `getAgentAccountingDetailedPlayerCount` — counts of
  active/players, not pending customers.
- `getConfigWebReportsPending` — display configuration, not data.

**Answer: no aggregate pending-customer-count endpoint is present in the available code or probes.**
There is also no network log to prove that no such endpoint exists server-side; the finding is
“none found in the available evidence,” not “the server has none.”

## Path B finding

The count cannot be computed from artifacts on disk. The specific missing sources are:

1. **The BB55103 ledger and network log themselves** — the named files are absent, so even the
   one-customer invariant is unverified.
2. **A population source / aggregate endpoint** — pending state is per-customer (`getInfoPlayer`) or
   per-wager (`getPending`); no aggregate endpoint exists in the available code, and a 57,763-customer
   crawl through customer-admin would be a display crawl, not a settlement source.
3. **Settlement reconciliation and definitions** — the lifecycle/state definition and the
   transaction-log join remain the domain of item 3 and the settlement/compliance owners.

To unblock: provide the named artifacts (or a redacted equivalent), the authoritative transaction
log/replica, an aggregate endpoint or documented reconciliation, and the settlement/compliance
definitions. Link: item 3 (`03-financial-controls.md`), item 2 (Bearer verdict) as upstream blockers.

## What this does not answer

- The actual count.
- The settlement team's definition of "pending" / end-of-day.
- The compliance definition of "active customer" / "open position."
- Whether the server has an uncalled aggregate endpoint (no network log).

## Re-verify

```sh
find Scratch scratch -name 'f402-transactions-BB55103.json' -o -name 'f402-getInfoPlayer-BB55103.json' -o -name 'f402-network-log.txt'
grep -rl '1068258269\|PendingWagerCount' Scratch scratch
```
