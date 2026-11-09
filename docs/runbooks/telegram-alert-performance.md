# Telegram alert audit and alert-performance runbook

How to answer "what did the desk Telegram send, and how did the alerted bets settle?" without
inventing anything. The audit ledger records deliveries; the settlement store records results; the
performance join is the only place they meet.

## What is tracked

| Ledger       | Path                                              | Written by                                                                          | Contents                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alert audit  | `Scratch/watchlist-autobet/telegram-alerts.jsonl` | every flag-alert delivery (`lib/telegram_alert_sender.ts` → `appendAlertAuditRows`) | `schemaVersion`, `atIso`, `source` (`flag-alert`/`telegram-activity`), `chatId`, `chatLabel`, `status`, `ruleId`, `severity`, `dedupeKey`, `customerId`, `betKey`, `ticketNumber`, `wagerNumber`, `sport`, `subSport`, `period`, `wagerType`, `marketType`, `line`, `side`, `stakeUsd`, `messageId`, `messageChars`, `messageSha256`, `detail` |
| Bot activity | `reports/telegram-activity.jsonl`                 | the bot service (non-flag messages)                                                 | `at`, `direction`, `chatId`, `summary`, `outcome`, `detail`; only `direction: "out"` rows are read                                                                                                                                                                                                                                             |

- Statuses: `sent`, `simulated`, `failed`, `deduped`, `rate_limited`.
- The audit never stores message text: it keeps a SHA-256 of the rendered message plus its
  character count (`messageDigest`), so a row can be correlated without storing the body.
- `--include-activity` merges the activity log for _reading_; `--backfill` imports its outbound
  rows into the audit ledger with a stable dedupe key, so re-running imports nothing twice.

## Commands

### Alert audit

```sh
bun run cli/sportsdesk_bet_flags_cli.ts alert-log --summary
bun run cli/sportsdesk_bet_flags_cli.ts alert-log --backfill --summary
bun run cli/sportsdesk_bet_flags_cli.ts alert-log --chat deskbotops --csv > /tmp/alerts.csv
bun run cli/sportsdesk_bet_flags_cli.ts alert-log --performance --outcomes Scratch/settlement/outcomes.jsonl
```

- `--since <iso>`, `--status <list>`, `--chat <id|label>`, `--limit N` (1–500, default 50).
- `--summary` adds daily/chat/rule/severity rollups; the text view prints the day and rule tables,
  `--json` carries all four.
- `--include-activity` merges `reports/telegram-activity.jsonl` (no rule identity, no chat label).
- `--backfill` imports outbound activity rows into the audit ledger (idempotent).
- `--csv` exports rows and cannot be combined with `--json`.
- `--outcomes <path>` and `--include-simulated` only matter with `--performance`; they are ignored
  otherwise. `TELEGRAM_CHAT_LABEL` (e.g. `deskbotops`) is recorded as `chatLabel` on new rows.
- `--json` carries the `performance` report alongside the rows and summary. A report built from an
  outcome source includes its `metadata` provenance block (alert window, outcome sources, coverage,
  alerts without a wager key, alerts without a customer key); the no-source / missing-source stub
  reports do not carry `metadata`.

### Settlement outcomes export

```sh
bun run settlement outcomes --db ./lifecycle.sqlite --out Scratch/settlement/outcomes.jsonl
```

- Rows are `{customerId, wagerNumber, outcome: win|loss|push|void, netUsd, source}`.
- The append-only settlement store is reduced to the latest observation per ticket; tickets with
  no decisive outcome are skipped and counted (`skipped`).
- A missing database is reported as `db_missing` (exit 1) — an empty outcome file is never written.
- `--json` prints `{ok, dbPath, tickets, rows, skipped, out, wroteFile}`; `wroteFile` is false when
  zero rows mean no file is written.
- Legacy/migrated stores are adapted: observation time falls back to `valid_time`, a store with only
  a `result` column (WIN/LOSS) is accepted, and a store with neither `outcome` nor `result` is
  `schema_missing` instead of an empty success. The latest observation is chosen by parsed
  observation instant (mixed UTC offsets included), not by text order or game time.

### Pipeline order

1. `bun run settlement ingest --db ./lifecycle.sqlite --fixture <fixture.json>` (fixture) or
   `bun run settlement poll --db ./lifecycle.sqlite` (live; requires `SPORTSDESK_PORTAL_HTTP_BASE`).
2. `bun run settlement outcomes --db ./lifecycle.sqlite --out Scratch/settlement/outcomes.jsonl`.
3. `bun run cli/sportsdesk_bet_flags_cli.ts alert-log --performance --outcomes Scratch/settlement/outcomes.jsonl`.

Run the steps in that order: the export reads the settlement store, and the performance join reads
the exported JSONL. Skipping step 2 leaves `--performance` with no source, which the CLI reports as
`unavailable: no outcomes source: pass --outcomes ...` (exit 0 — do not read that as zero performance).

## Source honesty rules

- **Missing is not zero.** A missing settlement DB or outcomes file is reported as missing with a
  reason (`db_missing`, `outcome source missing: ...`); a missing audit ledger reads as no rows plus
  the CLI's "no alert audit rows yet" hint. None of these is an empty measured result.
- **The customer-book sample is a generated fixture**, not real settlement history: it holds roughly
  five sampled tickets per customer, is opt-in with `--use-customer-book-sample`, and the report
  emits a warning labelling it a sample. Never quote its rankings as full-history evidence.
- **Unmatched alerts are counted, never guessed.** A join requires `(customerId, wagerNumber)`;
  alerts without a wager key or without a matching result stay `unmatched`, and delivered alerts
  with no customer id are counted as unmatched too (`metadata.alertsWithoutCustomerKey`) rather
  than vanishing. The report exposes coverage (`matched`/`unmatched`, alerts without a wager key)
  so a small numerator is visible.
- **Duplicate sends are counted once.** The join keeps one row per `(customer, wager)` (falling
  back to a namespaced `betKey`/`dedupeKey` when the wager key is absent), preferring
  `sent` over `failed`/`simulated`/`deduped`/`rate_limited`, then the newest timestamp. Separately,
  the sender's 7-day dedupe state (`Scratch/watchlist-autobet/alert-state.json`) marks repeat
  sends `deduped`.
- `available: false` plus a `reason` means no alert row joined to an outcome; it is not a verdict
  that the alerts lost.

## Data handling

- Customer IDs live in gitignored `Scratch/watchlist-autobet/` ledgers, and the exported outcomes
  JSONL carries `customerId` + `wagerNumber`. Treat all three as sensitive: do not commit, paste
  into tickets, or forward them. The enriched customer book is an untracked generated artifact.
- Retention is capped, so history can disappear: the audit trims at 5 MB / keeps 5,000 lines; the
  activity log trims at 512 KB / keeps 1,000 lines. Export before rotating if history matters.
- No message text is stored, and rows carry no IP addresses. Do not add either to alerts or ledgers.

## Known limits

- `settlement poll` needs a live portal session; without it only fixture `ingest` works, and
  outcomes are only as fresh as the last poll.
- Historical alerts written before the audit enrichment predate the join keys and stay unmatched.
- Dimensions are dirty at the source and are canonicalized where possible: `subSport` is a picker
  label and `PREGAME` is a phase sentinel, so values map through `classifyMarketLabel` to the
  registry kind or `unknown`; `wagerType` codes group by their readable `"<code> <name>"` label via
  `wagerTypeMeta`; `sport`/`period` are trimmed with an `unknown` fallback, and the raw labels each
  canonical bucket absorbed are retained for audit. A clean canonical bucket does not mean the
  upstream dimension was clean.
- Backfilled activity rows carry `source: "telegram-activity"`, no `ruleId`/`severity`/`chatLabel`;
  do not compare them like-for-like with flag-alert rows.

## Verification

```sh
bun test tests/telegram_alert_audit.test.ts tests/alert_performance.test.ts tests/settlement_outcomes.test.ts
bun test tests/sportsdesk_bet_flags_cli.test.ts -t "alert-log"
bun fmt --check docs/runbooks/telegram-alert-performance.md
wc -l -w docs/runbooks/telegram-alert-performance.md
```

The three library suites cover audit appends/rollups/backfill idempotency, the performance join
(unmatched handling, duplicate dedupe, delivered-only filtering, missing-source reason) and the
outcomes export (latest-per-ticket, MISSING db). The filtered CLI tests cover `alert-log` reads,
activity merge and `--performance` against an outcomes file. An operator can also re-run step 2
with a nonexistent `--db` and confirm it prints `db_missing` instead of writing an empty file.

## Live endpoint status

The read-only Manager Tools wire now has a first-class status probe, so an expired cookie,
a permission gap, and a transport failure are no longer the same error:

```sh
./bin/dx fetch-live-data                 # public sports/leagues/countries catalog → live-data.json
./bin/dx fetch-report-status             # status matrix for live-data + report kinds
./bin/dx fetch-report-status --from 1793509200 --to 1794203999 --json --out report-status.json
```

Status classes: `ok`, `not_permitted`, `session_expired`, `challenge`, `forbidden`, `throttled`,
`server_error`, `unreachable`, `invalid_json`, `shape_error`. The probe mints the per-run
`x-gs-session` from the GSID cookie; it never prints either value (only cookie names and the
`sessionGate` state). A permission gap (`bettor-report` → `403 Not permitted`) is reported but
does not make the command exit non-zero; session/transport/shape failures do.

Measured 2026-11-08: `live-data`, `periods`, `users-report`, `events-report`, `summary-report` →
`200 ok`; `bettor-report` → `403 not_permitted`. The reports endpoint answers with a JSON body
under `content-type: text/html`, so the classifier parses the body before treating HTML as a login
trap.

`open-bet-report` is wired too, but a wide window (8 days) currently returns **504 Gateway Timeout**
from Manager Tools; the probe reports it as a blocking `server_error`/timeout. Use a narrow window
or retry after the gateway recovers. A missing `x-gs-session` handshake makes the report probes
time out rather than return the login HTML; the matrix shows `x-gs-session unavailable` when that
happens.

`periods` and `fetch-report-periods`:

```sh
./bin/dx fetch-report-periods            # period labels → report-periods.json
```

The endpoint returns a JSON array of label strings; `fetch-report-status` prints the label count it
actually measured. The labels are display vocabulary (Game, Half, Period, Extra Time, 1st 3
Innings, Match Play …), not a code→label map for the corpus period codes.
