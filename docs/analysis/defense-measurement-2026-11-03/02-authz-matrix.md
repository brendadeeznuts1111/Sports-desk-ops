# 2. Black-box authz matrix — design, not results

**Status: NOT EXECUTED — BLOCKED.** No authenticated test was run: this environment has no
low-privilege test account, no written authorization to send tampered authenticated requests to the
vendor, and no server-team answer. The only live observations included are the unauthenticated,
read-only probes already recorded in
`docs/evidence/manager-portal-client-exposure-2026-11-03.md`.

**The deliverable is one paragraph:** _does the server authorize on the Bearer's claims, or on
client-supplied `customerID`/`agentID`/`agentOwner`/`MASTER_ID`/`RRO`?_ The matrix and tamper log
below are the evidence that produces that answer — not the product. The full matrix is optional
until the answer is known.

## The question that reorders the roadmap

> **Does the server authorize on the Bearer's claims, or on client-supplied identity fields?**

Three outcomes, each with a different consequence:

| Outcome           | Meaning                                                                                                                          | Roadmap consequence                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Claim-derived** | Server re-derives the caller and permitted targets from the Bearer/session; body `agentID`/`agentOwner` are ignored or validated | Subordinate tampering confirmed blocked; client XSS remains the main path to authority              |
| **Body-trusting** | Server uses `agentID`/`agentOwner`/`customerID` from the body as the target/caller identity                                      | Any subordinate agent can act as a peer/superior; this outranks every client-side control in flight |
| **Hybrid**        | Some endpoints validate, others do not                                                                                           | The matrix is the deliverable; per-endpoint allowlists required                                     |

## Minimum viable test — the actual ask is five requests, not a full matrix

One low-privilege subordinate-agent session and a proxy are enough to answer the question with
**four read-only requests**, plus one mutation only if the test tenant and authorization explicitly
allow disposable money data:

| #   | Request                        | Tamper                                      | Answer signal                                                                                           |
| --- | ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `Manager/getMasterSheet`       | `agentID = peer`                            | peer's accounting rows returned → body-trusting                                                         |
| 2   | `Manager/getListAgenstByAgent` | `MASTER_ID` in sessionStorage → peer master | peer's downline returned → body/`MASTER_ID`-trusting                                                    |
| 3   | `Manager/searchCustomerAdmin`  | `agentID`/`customerID` = peer's player      | player's PII returned → body-trusting                                                                   |
| 4   | `Manager/getTransactions`      | `customerID` = peer's customer              | peer's transactions returned → body-trusting                                                            |
| 5   | `Manager/updateDistribution`   | `agentID = peer`, value below parent        | **only with explicit mutation authorization**: 200 + no ledger artifact → financial gap plus body-trust |

If any read returns another principal's rows, the verdict is **client-supplied identity**; if all
four return 403/empty, the verdict is **claim-derived**. The full matrix refines per-endpoint gaps
afterwards. Server-team ask: roughly **two hours** with a test account, not a multi-day matrix.

## What the client sends (measured from pinned code and captures)

`[CODE]` `security.js` `$.ajaxPrefilter` (installed from `verifySession`) does three things on
`/cloud/api*` requests:

1. Adds `Authorization: Bearer <sessionStorage.credentials.code>` when the caller did not set one.
2. For `agentType ∈ {M, A}` and `MASTER_ID !== ""`, sets **`agentID := MASTER_ID`**, and
   **`agentOwner := MASTER_ID`** unless the body carries a different `agentOwner` _and_ an
   `agentID` (in which case `agentOwner` survives and `agentID` is replaced with `MASTER_ID`).
3. It **never** writes `customerID`, `RRO` or `operation`; those are caller-controlled on every
   endpoint. `RRO` is the constant `util.RRO = 1` `[CODE]`.

Consequences for the test:

- A subordinate agent's **own** requests are rewritten to target its `MASTER_ID`; the interesting
  tamper is a body that carries both fields so `agentOwner` survives.
- `customerID`, `RRO`, `operation`, `module`, `date`, `week`, `ticketNumber` are **all** caller-owned,
  so each is a tamper axis.
- `sessionStorage.AgentType` decides whether the prefilter injects identity fields; a player session
  sends the Bearer with no body identity `[CODE]`.

## Matrix template

Roles: `M` master, `A` subordinate agent, `P` player, `U` unauthenticated.
Targets: **self**, **subordinate** (own downline), **peer** (same master, not downline), **superior**,
**other tenant**.

For every operation in the ledger's Manager/Report sets (28 Manager operations are listed in
`docs/evidence/ledger.json`; the financial subset is in
[03-financial-controls.md](./03-financial-controls.md)):

| Operation     | Role | Target | Request mutation      | Status    | Rows/fields returned | Caller identity echoed? | Verdict   |
| ------------- | ---- | ------ | --------------------- | --------- | -------------------- | ----------------------- | --------- |
| `<operation>` | A    | peer   | body `agentID=<peer>` | _pending_ | _pending_            | _pending_               | _pending_ |

Record for each cell: HTTP status, response size, whether the response contains the target's rows
(not just a 200), and any echoed identity (`x-auth-userid`, `customerID`, `AgentID`).

## Tamper log template

| #   | Field                        | Baseline     | Tampered                       | Endpoint                            | Server response | Trusted? |
| --- | ---------------------------- | ------------ | ------------------------------ | ----------------------------------- | --------------- | -------- |
| T1  | `agentID`                    | own id       | peer id                        | `getMasterSheet`                    |                 |          |
| T2  | `agentOwner`                 | own master   | peer master (send both fields) | `getMasterSheet`                    |                 |          |
| T3  | `MASTER_ID` (sessionStorage) | own master   | "" / "0" / other               | `getBilling`                        |                 |          |
| T4  | `customerID`                 | own downline | peer customer                  | `getTransactions`                   |                 |          |
| T5  | `RRO`                        | 1            | 0 / 2 / arbitrary              | several                             |                 |          |
| T6  | `module`                     | `bet-ticker` | `../../evil`                   | `manager.html?external-view=active` |                 |          |
| T7  | `operation`                  | declared     | another operation name         | one endpoint                        |                 |          |
| T8  | `week`/`date`                | current      | future/negative                | `getWeeklyFigureByAgentLite`        |                 |          |

T6 is the only tamper that the client seam can influence (today it blocks locally when the guard is
on). Every other row is a **server-side** question; no client control changes the answer.

## Protocol (required before running)

1. **Authorization:** written vendor/operator approval naming the test tenant, the operations, and
   the tamper values; production writes are out of scope.
2. **Account:** a provisioned test master and at least two subordinate agents, plus a test player.
3. **Transport:** proxy with the test session; one request at a time; rate-limit to avoid bot
   defence; never mutate production data.
4. **Redaction:** record statuses, row counts, key names and identity echoes; never store Bearer,
   cookie, password or customer PII. Reuse `docs/evidence/capture-requests.md` rules.
5. **Stop condition:** any 2xx on a mutation, any cross-tenant row, or any response containing
   another agent's PII ends the run and becomes the finding.
6. **Evidence output:** JSON matrix + tamper log + the one-paragraph verdict, committed with the
   redaction proof.

## Unexecuted observations that are already evidence

| Probe (unauthenticated, 2026-11-03)              | Result                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /qubic/api/Manager/getAuthorizations`      | 404 openresty (bundle path is client-side only)                                                                         |
| `POST /cloud/api/Manager/getAuthorizations`      | 401 Authorization Required, openresty                                                                                   |
| same with `Origin: https://attacker.example`     | 401, no `Access-Control-Allow-Origin`                                                                                   |
| recorded authenticated boot request (2026-11-01) | 200; only `cf_clearance` + `__cf_bm` cookies; credential is the `Authorization` header; no `Set-Cookie`, no CSRF header |

These establish the transport and the absence of a cookie CSRF surface. They say **nothing** about
whether a valid Bearer's body fields are trusted.

## Verdict (template — fill after execution)

> _Pending._ If T1–T4 return another principal's rows, the server is body-trusting and actor 2 in
> [01](./01-adversary-model.md) escalates from "bounded subordinate" to "acting master"; item 6 must
> then raise server authz above every client control. If they return 403/empty, the Bearer verdict is
> claim-derived and the client XSS path remains the primary authority-theft route.

Acceptance requires the server team to confirm this verdict **by test**, not by assertion.
