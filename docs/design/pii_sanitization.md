# PII sanitization contract (shared by Bridge 3c and 3d)

All sanitized rollups and summaries published to R2 use this contract. **Never write raw rows.**
The 55 MB `betReport-all.json` (with `ipAddress`, customer ids, tickets and free text) must never
be uploaded, staged for R2, or embedded in an event.

## Buckets

| Bucket        | Fields                                                                                                                                                                                                                                                                                                                      | Rule                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drop**      | `ipAddress`, `ip`, `remoteAddr`, `userID`, `customerID`, `customerId`, `login`, `agentID`, `agent`, `ticketNumber`, `wagerNumber`, `betGroupId`, `ticketId`, raw `betDetails`, `raw`, selections/team names/`game`/`score`, free-text status, exact `Bet Time`/`Scheduled`/`Accepted`/`InsertDateTime`, row `payloadSha256` | Never serialized, never hashed                                                                                                                    |
| **Hash**      | `sourceSha256` only                                                                                                                                                                                                                                                                                                         | SHA-256 of the canonical **sanitized artifact** (with the hash field blank); integrity/idempotency, not a hash of raw rows. No identifier hashes. |
| **Coarsen**   | timestamps, labels                                                                                                                                                                                                                                                                                                          | `deskDate` (`America/Chicago`) + `deskHour`; sport/period/wagerType/state mapped to bounded allowlists, unknown → `other`                         |
| **Aggregate** | money/counts                                                                                                                                                                                                                                                                                                                | Integer cents, once-per-ticket/group risk, `ticketCount`, `legCount`, settled net, `holdBps`; no per-ticket rows                                  |

Money is never rounded in a way that hides a discrepancy. `holdBps` is
`round(10000 * (riskCents - settledNetCents) / riskCents)`, null when risk is zero.

## k-anonymity table

| Dimension / assertion                             | Rule                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `sourceKind`                                      | `settlement-observation` or `graded-page`                                  |
| `channel`                                         | `gslive-straight`, `gsbuilder-parlay`, `other`                             |
| `sport`, `period`, `wagerType`, `settlementState` | Bounded labels from allowlists                                             |
| Cell key                                          | `sourceKind × channel × sport × period × wagerType × settlementState`      |
| Minimum cell size                                 | `k = 5` tickets; cells below k are omitted                                 |
| Suppressed residual                               | Their counts/cents go only into `suppressed.*`; totals reconcile exactly   |
| Identifiers                                       | Zero customer/agent/ticket identifiers, hashed or otherwise                |
| Small-cell leak guard                             | Emitted cells carry no exact amount, no timestamp below hour, no free text |

Parlay risk is deduplicated before aggregation by the internal
`${ticketNumber}-${wagerNumber}` / `M.G<betGroupId>` key: keep risk once per ticket/group,
count legs separately. Latest `validTime` wins; `getHistory` wins a tie over `getGrading`.

## R2 latest pointer

Daily rollups are immutable-by-key snapshots:

- `tally/<YYYY-MM-DD>/rollup.json` — the full artifact (or the 3d daily summary).
- `tally/latest.json` — **pointer only**, not a duplicate copy:

```json
{
  "schemaVersion": 1,
  "deskDate": "2026-11-03",
  "key": "tally/2026-11-03/rollup.json",
  "sha256": "<artifact sha256>",
  "generatedAt": "2026-11-04T01:00:00.000Z"
}
```

Write daily object first, verify its hash, then write the pointer. A stale or failed new daily object
does not replace the pointer. The pointer is the only mutable object.

## Object metadata convention

Every sanitized R2 object carries:

```text
x-amz-meta-pii: none
x-amz-meta-schema-version: 1
x-amz-meta-desk-date: YYYY-MM-DD
x-amz-meta-generated-at: <iso8601>
x-amz-meta-sha256: <artifact sha256>
x-amz-meta-source: <stream id>
Content-Type: application/json
```

The publisher asserts the serialized artifact is under **256 KiB**, contains no denylisted key, and
contains no IPv4/IPv6 regex match before `writeWithMetadata`. Any failure rejects the write; no raw
row, request body, cookie or credential is logged.
