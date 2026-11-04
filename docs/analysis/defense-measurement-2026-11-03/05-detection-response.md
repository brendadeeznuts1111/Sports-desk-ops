# 5. Detection and response design

For every current prevention control: what would tell us it fired, what we would do, and whether that
exists. `[CODE]` = primitive verified in repo/pinned client; `[OBSERVED]` = recorded in evidence;
`missing` = no implementation found. The honest entries matter as much as the present ones.

| Prevention control                           | Detection that exists                                                                                                                                                                                                                                                       | Response playbook that exists                                                                                                                                                           | Verdict                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **SRI / CDN pin gate**                       | `[CODE]` `pin:cdn` drift; `guard_anchor_missing`; daily schedule + `portal:drift:cron`; probe/report on mismatch. Asset bytes are compared to the manifest, so a swap is visible even when the page still works                                                             | `[CODE]` `docs/runbooks/cdn-pin-update.md`: review against vendor release notes, refuse same-version updates, rollback by reverting the manifest                                        | **Detected + playbook.** The strongest pair in the current set |
| **External-view guard**                      | `[CODE]` rejected module ids go to `window.__F402_REJECTS__` and flush to `POST /cloud/api/Log/write` via `system/log`; probe reports `rejectCount`/`unflushedRejects`; flag-on + uninstalled wrapper is a structural probe failure                                         | **Partial:** an operator seeing the probe failure would investigate/disable the flag; no documented server-side playbook for "a reject log arrived", no alert consumer, no session-kill | **Detected, response undefined**                               |
| **Seam escaper (once sinks migrate)**        | **Missing for XSS attempts.** A rendered payload is only visible if it reaches a log or a probe; there is no CSP report-URI, no DOM-integrity check, no alert on `escHtml` being bypassed. Module rejections are logged (above), but sink rendering is not                  | None                                                                                                                                                                                    | **Neither** — the control is silent by design                  |
| **`data-pass` / plaintext password removal** | **Missing** — it is a server response property; this repo has no telemetry on the PLAYERS envelope                                                                                                                                                                          | Upstream removal only                                                                                                                                                                   | **Neither here**                                               |
| **Token TTL / refresh**                      | `[CODE]` client refreshes every 5 min (`security.js` `timeRefresh: 3e5`); a 401 triggers `sessionDestroy()` + redirect. There is **no central session inventory, no rejection-rate metric, and no observed revocation endpoint**. Absolute token lifetime is `[UNVERIFIED]` | On 401 the client logs out; nothing else                                                                                                                                                | **Partial prevention, no detection**                           |
| **Central revocation / session-kill**        | **Missing.** No API, no admin console action, no inventory evidenced                                                                                                                                                                                                        | None documented                                                                                                                                                                         | **Missing**                                                    |
| **Reject-rate alerting**                     | **Missing.** `Log/write` lines are written but nothing consumes them for alerting; the seam's local buffer dies with the tab                                                                                                                                                | —                                                                                                                                                                                       | **Missing**                                                    |
| **Agent-tree canary**                        | **Missing.** The repo builds hierarchy snapshots/agent trees (`lib/f402_agent_tree.ts`, graph artifacts) but nothing planted as a canary or alerted on unexpected change                                                                                                    | —                                                                                                                                                                                       | **Missing** (design below)                                     |
| **Server authz on Bearer claims**            | **Missing/unknown.** No server log access, no tamper telemetry. Item 2's matrix would provide the first detector                                                                                                                                                            | —                                                                                                                                                                                       | **Missing**                                                    |
| **Financial bounds / ledger reconciliation** | **Missing.** The only audit is client-issued `Log/write` after `updateDistribution` success; it is forgeable/omittable and not reconciled (item 3). No alert on distribution/balance/delete anomalies                                                                       | None                                                                                                                                                                                    | **Missing — highest-risk gap**                                 |
| **Login / ATO controls**                     | **Missing/unknown** — no MFA, velocity, geo, or lockout evidence in repo                                                                                                                                                                                                    | —                                                                                                                                                                                       | **Missing**                                                    |

## What a minimal detection layer would be (not proposed as client work)

1. **Reject events → alert.** Consume `Log/write` (or a proper audit stream) and alert on
   `external-view module rejected`, with a threshold per agent/session. Today it is a log line with
   no reader.
2. **Session lifecycle.** Absolute token TTL, server-side issued-session inventory, one revocation
   path (logout-all / kill by session id), and a metric for refresh failures. The client's 5-minute
   refresh is not revocation.
3. **Financial invariant checks.** Server-side ledger entry per mutation (atomic with it), plus a
   periodic reconciliation (F1–F6 in item 3) and an alert on breach. This is the control that would
   have caught an inside or tampered distribution change.
4. **Agent-tree canary.** Plant a synthetic agent/player at a known position with a known
   distribution; alert if it appears in another downline, moves, or its distribution changes without
   a corresponding ledger entry.
5. **XSS observation.** A CSP `report-uri` on `manager.html` once the header exists, plus a scan of
   PLAYERS/NameFirst for HTML metacharacters at ingest; today an injected payload has no observation
   point that is not the exploit itself.

## Response playbooks that should exist and do not

- **Credential exposure (Bearer seen in a log/HAR/chat):** revoke that session centrally; rotate the
  password; check the financial actions performed in the window. Today: no revocation path is
  evidenced, so the only step available is "log out and hope".
- **Reject burst:** identify the agent/session, inspect `module` values, disable the guard flag if
  the guard is misfiring, rotate the session if it looks like probing.
- **Invariant breach:** freeze the affected agent, reconcile against the wager feed, preserve the
  audit trail. Requires a ledger (item 3).

## Ordering consequence

Detection does not exist for the two highest-impact actor classes (2 and 6). The only
detection-with-playbook pair in production is the **asset pin gate**; everything else is either
prevention-only, local-only, or absent. Item 6 must not describe the client controls as
detective.
