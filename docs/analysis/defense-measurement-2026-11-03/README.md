# Defense measurement pack — 2026-11-03

Answers the question the roadmap could not: **which client-side controls are load-bearing, and what
do they not defend?** Scope is adversary-centric, not control-centric.

**Start here:** [00-executive-summary.md](./00-executive-summary.md) — the one-page decision surface
for leadership, legal and the server-team lead. The rest of this pack is the evidence behind it.

## Status: what is measured, what is not

| Item                          | Status                               | Basis                                                                                                                          | Blocker                                                                                                                              |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Adversary model             | **Written**                          | `[CODE]` + `[OBSERVED]` evidence in this repo; capability claims marked `[UNVERIFIED]` where they need live testing            | —                                                                                                                                    |
| 2 Black-box authz matrix      | **NOT EXECUTED — BLOCKED**           | Design, matrix template, unauthenticated observations, and exact tamper protocol in [02-authz-matrix.md](./02-authz-matrix.md) | No low-privilege test account; no written authorization to send tampered authenticated requests to the vendor; no server-team answer |
| 3 Financial-controls audit    | **Written; no reconciliation found** | `[CODE]` call sites in the pinned controller/modules; `[OBSERVED]` ledger coverage; `[CODE]` settlement store                  | Reconciliation against real money needs the business owner's ledger; server bounds need item 2                                       |
| 4 End-to-end attack exercises | **NOT EXECUTED — BLOCKED**           | Chain designs + authorization gate in [04-attack-exercises.md](./04-attack-exercises.md)                                       | Same as item 2, plus a disposable test tenant and vendor authorization to attempt financial chains                                   |
| 5 Detection & response design | **Written**                          | `[CODE]` client/runtime primitives; gaps stated as gaps                                                                        | —                                                                                                                                    |
| 6 Re-prioritized roadmap      | **Provisional**                      | Items 1, 3, 5; item 2's Bearer verdict is the missing input                                                                    | Item 2                                                                                                                               |

**Do not read items 2 and 4 as measured.** No authenticated test was run against the vendor in this
task. The only live requests made here remain the unauthenticated, read-only probes already recorded
in `docs/evidence/manager-portal-client-exposure-2026-11-03.md`.

## Raw inputs still required (none available here)

1. A live low-privilege test account, provisioned without keychain dependency.
2. A browser proxy (mitmproxy or equivalent) **and written permission** to replay tampered
   authenticated requests against the vendor's test/production tenant.
3. Server team, for one question: _what does authz check — Bearer claims or client-supplied
   `agentID`/`agentOwner`/`customerID`/`MASTER_ID`?_
4. Business owner, for one question: _what reconciles the ledger — distributions, settled figures,
   wager settlements, adjustments?_
5. Fraud/support threat intel the operator already holds (not in this repo).

Item 2's acceptance criterion explicitly requires the server team to confirm the Bearer verdict by
test. That cannot be satisfied by repository analysis, and this pack does not pretend otherwise.

## Index

- [00-executive-summary.md](./00-executive-summary.md) — finding, pause/cost/owner/expiry, three decisions, both verdict branches.
- [01-adversary-model.md](./01-adversary-model.md) — six actors, goals, capability, budget, detection signature, what the system currently allows, stopping control.
- [02-authz-matrix.md](./02-authz-matrix.md) — matrix template, client-side identity rewriting evidence, tamper protocol, and the Bearer question.
- [03-financial-controls.md](./03-financial-controls.md) — the four operations, bounds, audit path, invariant candidates, and the finding.
- [04-attack-exercises.md](./04-attack-exercises.md) — three chains, before/after measurement protocol, authorization gate.
- [05-detection-response.md](./05-detection-response.md) — per-control detection and response, or an explicit "neither".
- [06-roadmap.md](./06-roadmap.md) — re-prioritized one-pager naming what to pause and what to raise.
- [07-module-sink-census.md](./07-module-sink-census.md) — module-level `.html()` census and remaining audit surface.
- [08-pending-customer-count-feasibility.md](./08-pending-customer-count-feasibility.md) — Path B finding: no decision consumer, no join key, no transaction log/reconciliation.
- [08-pending-source-finding.md](./08-pending-source-finding.md) — artifact verification: named BB55103 files absent, ledger invariant unverified, no aggregate endpoint.

## Headline (provisional until item 2)

1. **The client's financial audit is a claim, not a ledger.** The client repo contains no
   reconciliation invariant, and the only audit path — `Log/write` after AJAX success — is
   non-atomic, forgeable and omittable: a malicious client skips it, a crashed tab loses it, a retry
   double-writes it. Whether the **server** reconciles is unknown; that is the business owner's and
   server team's question sitting beside item 2. What is measured: _the client cannot tell whether
   the server is reconciling, and cannot prove a mutation happened._ That outranks every client XSS
   fix in flight ([03](./03-financial-controls.md)).
2. **The client is not an authorization boundary.** It actively rewrites `agentID`/`agentOwner` from
   `MASTER_ID` and allows callers to survive a second rewrite — but nothing in this repo proves the
   server re-derives identity from Bearer claims. The Bearer verdict is item 2's actual deliverable;
   the matrix is only its evidence ([02](./02-authz-matrix.md)).
3. **What the client controls can claim:** they raise the cost of stored XSS on one Chromium path
   and make asset drift visible. They cannot stop authorization tampering, financial manipulation,
   insider action, or account takeover. The roadmap must not present them as a fix for those.
