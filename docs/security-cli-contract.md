# Security CLI contract — group integrity and settlement verification

This note pins two fields of the `fraud_*` CLI JSON output that operators and the security
plugin depend on. It describes shapes and meanings only; measured values are always derived from
the capture at call time and are never restated here.

## `status` / `bets` — `integrity`

Both `status --json` and the `bets` aggregate carry an `integrity` object produced by
`lib/fraud_integrity.ts`. `status` validates every discoverable capture (primary corpus plus
configured fallbacks) as one cohort; byte-identical capture copies are validated once. `bets`
exposes the loaded corpus's object unchanged. Nothing is recalculated by the CLI.

Fields:

| Field               | Meaning                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`     | Contract version of the integrity object.                                                                                                                                                                  |
| `derivationVersion` | Version of the derivation rules that produced it.                                                                                                                                                          |
| `policyVersion`     | Version of the configured policy (see `config/fraud-model.json#groupIntegrity`).                                                                                                                           |
| `status`            | `verified`, `incomplete`, `invalid`, or `unavailable`.                                                                                                                                                     |
| `counters`          | Ownership, financial-field, coverage and duplicate counters.                                                                                                                                               |
| `observations`      | Leg-level facts that are allowed to vary inside a ticket (mixed leg states, partially graded groups, mixed leg results, pending/cancelled legs, supplemental-confirmation categories, seen/unknown enums). |
| `violationCounts`   | Complete per-code violation counts, even when the sample list below is capped.                                                                                                                             |
| `violations`        | Capped evidence samples (`code`, `betGroupId`, `detail`).                                                                                                                                                  |
| `source`            | Kind, captured row count, and (for a merged cohort) capture identifiers plus hashes.                                                                                                                       |

Status semantics:

- `unavailable` — no capture could be read; validation did not run.
- `invalid` — an invariant or policy breach (multiple owners, conflicting ticket-level fields,
  missing required identifiers, invalid financial value, known-but-disallowed enum).
- `incomplete` — coverage gap or unknown enum value (schema drift); validation ran but is not
  complete.
- `verified` — every inspected row was covered and no invariant or policy breach was found.
  Zero violations is meaningful only with complete coverage.

A malformed `groupIntegrity` block in `config/fraud-model.json` fails explicitly with the
`invalid_config` error code; it never falls back to defaults.

`status` also reports the measurement cost in its timing envelope: `integrityMs` is the cohort
validation duration and `integrityCaptures` is the number of distinct captures validated. They are
observability fields only; they never affect the status value.

## `status` — `settlementVerification`

Settlement correctness is a separate question from ownership and financial-field integrity.
The CLI contract therefore carries a separate top-level field:

```json
"settlementVerification": {
  "status": "unverified",
  "blockedBy": "no_same_book_settlement_ledger",
  "note": "…"
}
```

This field is defined and intentionally constant: it reports `unverified` until a same-book
settlement ledger exists to compare against. It must never be folded into, derived from, or
ranked against the `integrity` status; a corpus can be internally consistent (verified ownership
and financial fields) while settlement correctness remains unknown.

## `bets` — ticket-deduped aggregate

`aggregate` is measured over the filtered corpus. `rows` counts **legs** (one `getBetReport` row
per leg); the ticket-level fields are deduped by `betGroupId`, because `bet`, `betGroupToWin` and
`betGroupResult` repeat verbatim on every leg row of the same ticket:

| Field           | Meaning                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `tickets`       | distinct `betGroupId` values; each ticket is counted once                         |
| `ungroupedRows` | rows with no `betGroupId`; they cannot join a ticket and are never counted as one |
| `wageredCents`  | ticket-deduped sum of non-null `bet` values, integer cents                        |
| `toWinCents`    | ticket-deduped sum of non-null `betGroupToWin` values, integer cents              |
| `resultCents`   | ticket-deduped sum of non-null `betGroupResult` values, integer cents             |

The dedupe uses the first occurrence of each `betGroupId`; null ticket-level values are skipped
rather than coerced to zero. `rows` and `tickets` are different units and must not be compared to
each other without saying which is which. The four vocabulary breakdowns (`bySport`, `bySubSport`,
`byPeriod`, `byWagerType`) remain leg-level and sum to `rows`.

<!-- staleness-ok: field contract only; no measured counts are pinned -->

## `status` — `sameBookControl`

`status` also carries the same-book users-report control, read from
`reports/security/users-report-control.json` (written by `compare:gslive-users-report
--control-out` or `verify:gslive-users-report`). It is a third, separate block:

| Status              | Meaning                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `unavailable`       | no control artifact; capture and compare first                                                           |
| `ok`                | fresh control, report-vs-corpus window matched, and the recorded corpus digest equals the corpus on disk |
| `stale`             | control older than the maximum age                                                                       |
| `scope_mismatch`    | report window differs from the corpus window                                                             |
| `no_join`           | no report column joined to the corpus                                                                    |
| `unverified_corpus` | recorded corpus digest missing or different from disk                                                    |
| `invalid`           | malformed/unsupported artifact                                                                           |

The block is evidence from a second encoding in the same book. It never changes
`settlementVerification`; a control can be `ok` while settlement remains `unverified`.

## Related evidence

- [manager-betreport-field-contract.md](evidence/manager-betreport-field-contract.md) pins the
  observed `getBetReport` enums, the nested confirmation state, and the raw-vs-display currency
  split behind the fields this CLI consumes.

## Compatibility

Existing CLI fields, exit codes and fraud-detector counts are unchanged by these additions.
The security plugin renders these fields read-only and performs no validation of its own.
