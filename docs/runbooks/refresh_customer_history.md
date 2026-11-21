# Refresh retained customer history on the collector schedule

The webview daemon owns `sched_customer_history_15m`, at :12, :27, :42 and :57
America/Chicago. The bot excludes this daemon-owned schedule. It invokes
`scripts/refresh_customer_history.ts` through the existing shell-capture runner;
the optional Fantasy402 capture uses the existing manager replay session.

Configure the daemon process (not a committed environment file):

```sh
SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR=/absolute/dashboard/scripts/project_customer_history.ts
SPORTSDESK_CUSTOMER_HISTORY_SOURCES='["/private/graded-today.json","/private/graded-window.json"]'
SPORTSDESK_CUSTOMER_HISTORY_JSON=/private/dashboard/customer-history.json
SPORTSDESK_GRADED_WAGER_EXPORT=/private/graded-scheduled.json
```

Use the same output path in the dashboard. The projector is owned and versioned
by `Local-Sportsdesk-ops`; this collector does not duplicate its financial arithmetic.
Missing configuration skips the schedule. Restart the daemon after changing its
configuration. To exercise exactly the scheduled command manually, run:

```sh
bun --no-env-file run scripts/refresh_customer_history.ts
```

With `SPORTSDESK_GRADED_WAGER_EXPORT` set, the job requests graded reports for
distinct customer IDs in a live pending snapshot at most one hour old. It uses
`data/live-bets.json` by default and accepts an override through
`SPORTSDESK_GRADED_PENDING_SNAPSHOT`. Each account request uses the Central desk
date and a seven-day inclusive figure-date window. The scope covers only those
accounts observed in the snapshot. The provider request uses Fantasy402 credentials.

A successful batch adds allowlisted observations to the separate scheduled export.
Repeated observations are skipped and differing observations remain available to
the projector's conflict rules. Every selected account must complete before the
export advances. At 100,000 retained observations or the read size limit, archive
the export into a configured historical source and point capture at a new file.
The projector accepts at most 16 sources, including this scheduled export.

The wrapper launches the dashboard projector with the daemon's pinned Bun
executable and an environment containing only PATH and HOME. Leave the capture
path unset to project existing exports only.

The dashboard projector hashes all inputs and its own implementation. Unchanged
inputs/code keep the existing output and original generation time. Invalid or
missing inputs fail without replacing the last good projection. Retained W/L,
financial exclusions, ambiguous identities and provisional-return labels remain
owned by the dashboard contracts; this is never complete account history.

An exclusive `<output>.refresh-lock` prevents concurrent writers. The private
`<output>.status.json` records attempt time, `updated`/`unchanged`/`failed`, projection
time on success, and capture coverage when the upstream batch completes. Coverage
reports the selected and completed accounts, added rows and newest source wall
time. It also explicitly marks whole-book coverage as false. Overlaps are logged as
`overlap-skipped` and do not replace the active writer's receipt. Before removing a
stale lock after a crash, verify no refresh process is running. Configuration errors
are reported by the scheduler/CLI; only attempts with valid configuration and an
acquired lock write a receipt. No raw account records or credentials are logged.

## Live roster coverage

Set SPORTSDESK_GRADED_ROSTER_JSON to the private projected roster file to select
rotating batches of 50 distinct customer IDs. The existing schedule runs each
batch sequentially. A private export cursor advances only after the complete
batch and export write succeed. Changed roster identity hashes restart the sweep.
A completed sweep restarts at the next run. Each account receives the seven-day
report window at the time of its request.

Receipts report rosterAccounts, batchStart, sweepCompletedAccounts,
remainingAccounts and sweepComplete. The cumulative sweep can span multiple
days and does not represent a single synchronized book snapshot. At 58,017
accounts and four batches per hour, one sweep takes about 12 days. Recent
history outside each account's rolling request window remains uncovered.
