# 3. Financial-controls audit

Scope: `updateDistribution`, `deleteWager`, `getMasterSheet`, `getSettledFigure` (plus the adjacent
`adjustBalance`, `vigSetupInsert`, `updateByColumn`). `[OBSERVED]` = recorded in this repo's
evidence; `[CODE]` = read from the pinned controller/modules or repo code; `[UNVERIFIED]` = needs
the server team / business owner / live test.

## Call sites, bounds and audit

Money tiers: **confirmed money-moving with no client-visible bound** = the code posts a monetary
value and the only client check is an `<input type="number">` `[CODE]`; **confirmed destructive,
payload uncaptured** = a delete/void path exists but its request body was never captured;
**read-only money view** = reads accounting/figures without moving money; **suspected money-moving**
= name/UI evidence only, no code path read; **suspected money-adjacent** = settings that may affect
money but are not money transfers. A grep hit is not a finding until it carries a tier.

| Operation                           | Money tier                                                          | Where the client calls it                                                                                                                                         | Body it controls                                                          | Client-side bound                                                                                    | Ledger evidence                                                                                                                                        | Audit trail                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updateDistribution`                | **Confirmed money-moving with no client-visible bound** `[CODE]`    | `[CODE]` pinned `manager.js` byte 51067/51295 (`updateDistribution:function`), from the change-distribution modal save handler                                    | `agentID`, `distribution = 100 × input`, `login = MASTER_ID`, `operation` | **None** beyond `<input type="number">`; value ×100 and posted; no max/min/step check in pinned code | **Absent from `docs/evidence/ledger.json`** — no row at all                                                                                            | On success only: `r.write({description: "Update Distribution / Accounting \| Agent : … \| Value : …"})` → client-issued `POST /cloud/api/Log/write` `[CODE]`. **Not atomic**; a failed/tampered request or compromised client can omit or forge it |
| `deleteWager`                       | **Confirmed destructive, payload uncaptured** `[CODE]`/`[OBSERVED]` | `[CODE]` `manager/module/delete-wager.js` routes through the shared data module with `deleteWagers: true`; the actual mutation is in the shared report/data layer | Operation-specific (date/agent/customer filters plus wager identifier)    | Unknown; module code only bounds the date filter (Today/7/30/90 days)                                | **`Manager/deleteWager` tier C, `capturedResponse: false`, evidence `generator` only; `Report/delete-wager` tier C, UI observation only** `[OBSERVED]` | No captured request/response; wire body, success shape and server audit unknown                                                                                                                                                                    |
| `getMasterSheet`                    | **Read-only money view** `[CODE]`                                   | `[CODE]` `manager.js` byte 43966 (accounting history) and `manager/module/agent-management-thin.js`                                                               | `agentID`, `date` (weeks-ago), `operation`, `RRO`                         | Read-only; no client bound beyond the date picker                                                    | **No ledger row of its own** — only a mention inside `getWeeklyFigureByAgentLite`'s `requiredCapture` at `ledger.json:552`                             | Read-only; no reconciliation output stored                                                                                                                                                                                                         |
| `getSettledFigure`                  | **Read-only money view; definition unknown** `[OBSERVED]`           | `[CODE]` `POST /cloud/api/Report/getSettledFigure`, from the settled-figure report path                                                                           | Report filters (agent/customer/period)                                    | Read-only                                                                                            | **Tier C, `capturedResponse: false`, evidence `ui-observation` + `spec-claim`** `[OBSERVED]`                                                           | No captured response; the figure's definition and reconciliation are unknown                                                                                                                                                                       |
| `adjustBalance`                     | **Suspected money-moving** `[OBSERVED]`                             | `[CODE]` ledger row `POST /cloud/api/Manager/adjustBalance`; no client module path read (`adjust-balance.js` 404 on the live asset host)                          | Balance adjustment fields                                                 | Unknown                                                                                              | **Tier C, no capture; evidence `ui-declaration`, `crawler-behaviour`, `spec-claim`**                                                                   | No audit path found                                                                                                                                                                                                                                |
| `vigSetupInsert` / `updateByColumn` | **Suspected money-adjacent** `[OBSERVED]`                           | `[CODE]` client modules + ledger rows                                                                                                                             | Vig/column mutation fields                                                | Unknown                                                                                              | **Tier C, no capture**                                                                                                                                 | Unknown                                                                                                                                                                                                                                            |

**`updateDistribution` is missing from the ledger entirely, and `getMasterSheet` has no row of its
own** (only a passing mention in another operation's capture note). That is itself a finding: the
ledger is the repo's evidence contract, and the primary money-mutation operation bypasses it.

## Candidate financial invariants and whether the system enforces them

| #   | Invariant                                                                                 | Status in this repository                                                                                                                                                                                                                                             | Evidence                                                                                        |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| F1  | Sum of child distributions ≤ parent distribution at every level                           | **Unknown / no enforcement found.** `updateDistribution` posts an absolute value per agent; no client or repo-side check compares it to the parent's value or the sibling sum                                                                                         | `[CODE]` manager.js 51067; no distribution table or reconciliation in `lib/`                    |
| F2  | Settled figures reconcile to wager settlements (risk/payout)                              | **No reconciliation exists in this repo.** The settlement store is append-only wager-lifecycle observations (`wager_settlement_observations`) with outcome/lifecycle/amount columns; it has no distribution, adjustment or settled-figure totals to reconcile against | `[CODE]` `lib/fantasy402_settlement_ingest.ts`; `summarizeOutcomeRates()` is the only aggregate |
| F3  | Every financial mutation has an immutable, server-side ledger entry                       | **Not enforced by anything evidenced.** The only audit is the client's `Log/write` call after a successful `updateDistribution`; it is caller-supplied, non-transactional, and absent on failure                                                                      | `[CODE]` manager.js 51295; no server-side audit capture in the repo                             |
| F4  | Wager lifecycle transitions are monotonic and every cancellation/reversal is attributable | **Unknown.** `deleteWager` has no captured request/response; lifecycle normalization stores observations but does not enforce transitions                                                                                                                             | `[CODE]`/`[OBSERVED]` ledger tiers; `[UNVERIFIED]` server behavior                              |
| F5  | Money conservation: settled payout = risk − return, refunds bounded by stake              | **Unknown.** The settlement schema preserves `amount/risk/to_win/amount_refunded`, but nothing checks the arithmetic or rejects anomalies                                                                                                                             | `[CODE]` settlement store; no invariant check                                                   |
| F6  | Financial actions are bounded (per-agent max, per-period max, approval threshold)         | **No client bound for `updateDistribution`; server bounds `[UNVERIFIED]`**                                                                                                                                                                                            | `[CODE]` manager.js 51067                                                                       |

## The reconciliation attempt (and why it cannot close)

Attempted reconciliation from evidence available in this repo:

1. **Ledger → captures:** no captures exist for `updateDistribution`, `deleteWager`,
   `getMasterSheet`, `getSettledFigure`, `adjustBalance` (`capturedResponse: false`); the ledger has
   no `updateDistribution`/`getMasterSheet` rows. **No wire payloads to reconcile** `[OBSERVED]`.
2. **Settlement store → figures:** the store records wager-level observations only; there is no
   distribution, adjustment or settled-figure table, so F2 cannot be checked even in principle from
   this repo `[CODE]`.
3. **Client audit → mutations:** the `Log/write` line is emitted by the client after success and
   carries a human-readable `description`; it is not linked transactionally to a mutation id, and a
   tampered request can skip it. **Not a ledger** `[CODE]`.

**Finding (this is the deliverable, per the task's own rule that it outranks every XSS in flight):**

> The **client repo** contains no reconciliation invariant for `updateDistribution`, `deleteWager`,
> `getSettledFigure` or `adjustBalance`, and no captured wire evidence for the financial mutations.
> Whether the **system/server** reconciles is **unknown** — that is the business owner's and server
> team's question sitting beside item 2. Until they answer, the measured finding is narrower and
> stronger: **the client cannot tell whether the server is reconciling, and the client's own audit
> path is a claim, not a ledger entry.** `Log/write` fires _after_ AJAX success, from the client: a
> malicious client omits it, a crashed tab loses it, and a retry double-writes it. It is
> non-atomic, forgeable and omittable by construction — a property of the pattern, not of this
> repository's coverage.

This does not claim the vendor has no ledger; it claims the repo cannot see one, and the only audit
the client can produce is not evidence of a mutation. Item 3's acceptance is therefore: **the server
team confirms a server-side ledger/invariant exists (with its definition), or produces a written
finding that none does.** That cannot be satisfied by client code.

## Pending-customer count — Path B blocked (2026-11-04)

The question "how many customers have pending bets" is addressed in
[08-pending-customer-count-feasibility.md](./08-pending-customer-count-feasibility.md). Finding: no
decision consumer is documented; the portal's `Pending 2,400` is **$2,400 in wager amount**, not a
customer count; and the three observed namespaces (`getPending` `TicketNumber-WagerNumber`,
`getHistory` `LOGIN|WAGERNUMBER`, `getTransactionList` `DocumentNumber`/`GradeNum`) share no join key.
The count is blocked on the authoritative transaction log/reconciliation plus settlement and
compliance definitions — input to this item, not a replacement for it. Artifact-level verification
is in [08-pending-source-finding.md](./08-pending-source-finding.md): the three named BB55103
artifacts are absent from disk, the ledger invariant is unverified, and no aggregate pending-count
endpoint exists in the available code/probes.

## What the business owner must answer

1. What is the authoritative ledger for distribution changes, balance adjustments, wager
   deletions and settled figures — table, report, or external system?
2. What invariants does it enforce (F1–F6 above), and who checks them, on what cadence?
3. Is every mutation attributable to a server-derived principal, or to fields the caller supplied?
4. What is the detection/response path when an invariant breaks?

Until those are answered, item 6 cannot rank the client XSS controls above the financial gap.
