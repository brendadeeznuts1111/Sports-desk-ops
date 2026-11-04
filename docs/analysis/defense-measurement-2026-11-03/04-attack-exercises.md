# 4. End-to-end attack exercises — plan, not execution

**Status: 0 of 3 chains executed.** Every chain needs a provisioned test tenant and written
authorization to replay tampered authenticated requests; neither exists in this environment. This
document is the measurement protocol, with the control matrix that makes each chain a before/after
test rather than an anecdote.

## Authorization gate (must be satisfied before any chain)

- [ ] Written vendor/operator authorization naming: test tenant, accounts, operations, tamper
      values, time window, and a stop contact.
- [ ] Disposable test data only; no production wager, balance, distribution or customer mutation.
- [ ] Proxy + test sessions for: a test master (M), two subordinates (A1/A2), one player (P).
- [ ] Redaction plan per `docs/evidence/capture-requests.md`; no Bearer/cookie/password/PII stored.
- [ ] Stop condition: any 2xx mutation, any cross-tenant row, or any PII of another principal —
      stop, preserve evidence, report.

Without this gate, the chains are not run. "Tested" in the final report would otherwise be a lie.

## Chain A — player → XSS → Bearer → impersonation

| Step | Test action                                                                                                                   | Observation                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A1   | Set a test player's `NameFirst` to `<img src=x onerror="…">` via the player-facing profile path                               | Does the server accept/store markup? (Unverified write path — this is the first measurement.) |
| A2   | As test agent, open the hierarchy search and search that player's login                                                       | Does the row render? Does `onerror` fire?                                                     |
| A3   | If script fires, read `sessionStorage.credentials.code` and `sessionStorage.customerID`; exfiltrate to a controlled test host | What is readable? Is the plaintext password present?                                          |
| A4   | Replay `getTransactions` with the stolen Bearer from outside the browser                                                      | Does the API accept it? Does the server bind to UA/IP?                                        |

**Controls to toggle and measure (marginal reduction):**

| Control state                                                                | Expected effect                                           | What to record                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Baseline (no seam escaper on `searchComponent`, no CSP, `data-pass` present) | Script executes; token readable; replay succeeds          | Time-to-execution; data exposed; API status          |
| Seam `escHtml` applied to the search render only                             | Markup renders as text; no script                         | Same observations; confirm no request                |
| Plus `data-pass`/`Password` removed upstream                                 | Credential not in DOM; token still readable if XSS exists | What remains reachable                               |
| Plus `manager.html` CSP (`script-src` without unsafe-inline)                 | Inline payload blocked; report-URI event                  | Whether the injection is prevented, not just escaped |

The seam currently ships `escHtml` but **has not migrated `searchComponent`**; this chain measures
whether that migration would actually have reduced authority, which is the only reason to do it.

## Chain B — subordinate → request tamper → master data

| Step | Test action                                                                                 | Observation                                 |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| B1   | As A1, capture a baseline `getMasterSheet`, `getBilling`, `getTransactions`                 | Status, row counts, identity echoes         |
| B2   | Replay with `agentID = A2` (peer)                                                           | 200/403? Rows belong to A2?                 |
| B3   | Replay with `agentOwner` set to the master (send both fields so the prefilter preserves it) | Does the response expose the master's book? |
| B4   | Replay with `customerID` of a peer's player                                                 | Cross-downline rows?                        |
| B5   | Replay with `MASTER_ID`/`RRO`/`operation` tampered                                          | Which fields change server behavior?        |

**This chain is the same measurement as item 2**, expressed as an attack. Its result decides whether
actor 2 is bounded. Client controls cannot stop it; the only control under test is server authz.

## Chain C — compromised session → financial action → detection

| Step | Test action                                                                                   | Observation                                                                          |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| C1   | With a test master Bearer, call `updateDistribution` with a normal value                      | 200; does `POST /cloud/api/Log/write` appear?                                        |
| C2   | Repeat with an out-of-range value (0, negative, >100×)                                        | Does the server reject/bound? Does the client-side modal bound matter when bypassed? |
| C3   | Call `deleteWager` on a test wager; call `adjustBalance`                                      | Any captured/audited response?                                                       |
| C4   | Search for a corresponding ledger/reconciliation artifact                                     | Is the mutation attributable? Does any invariant break?                              |
| C5   | Measure detection latency with whatever telemetry exists (`Log/write`, reports, owner review) | Seconds/minutes/never                                                                |

**Controls to measure:** server bounds (unknown), server audit/ledger (unknown), client `Log/write`
(present but forgeable/omittable), reconciliation (none found — item 3). Expected outcome from
current evidence: the action succeeds and no artifact in this repo would contradict it; the exercise
must confirm or refute that on the vendor side.

## Measuring the existing controls

For each chain, run the same scenario across these states and record **marginal reduction**:

| Control                           | On/off mechanism                          | What it can change                                                 |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Seam escaper on `searchComponent` | not yet wired; would be an overlay change | chain A step A2                                                    |
| `external-view` guard             | `?external-view-guard=1`, `?no-seam`      | only the external-view module-load path; not chains A–C as written |
| SRI/pin gate                      | asset swap simulation in a test browser   | supply-chain path, not these chains                                |
| `data-pass` removal               | upstream only                             | chain A credential exposure, not token reachability                |
| CSP                               | upstream only                             | chain A execution                                                  |
| Server authz/bounds/ledger        | vendor only                               | chains B and C                                                     |

## Reporting template

| Chain | Baseline outcome | Control state | Outcome | Marginal reduction | Evidence |
| ----- | ---------------- | ------------- | ------- | ------------------ | -------- |
| A     |                  |               |         |                    |          |
| B     |                  |               |         |                    |          |
| C     |                  |               |         |                    |          |

Acceptance: an independent attacker given this table and item 1 finds no chain the document missed.
That review has not happened; it requires the executed results.
