# Capture weblog activity for pending accounts

The existing hourly weblog bridge (`sched_bridge_weblog_hourly`, at :07 Central) runs
`weblog:rollup --capture-pending` before publishing. It uses the existing F402 replay transport,
agent ID and session, independently of GSLive sign-in. It adds no timer or Telegram delivery.

```sh
bun run weblog:rollup --capture-pending --no-r2
bun run weblog:rollup --capture-pending
bun run weblog:rollup --from out/f402/weblog/11-20-2026.jsonl --no-r2
```

Capture reads `data/live-bets.json` (override with `--pending-snapshot`). The snapshot must have
live provenance, be at most one hour old, select 1–200
unique identified accounts. Ticket rows without an account identity are excluded and counted as
`unidentifiedTicketRows` out of `snapshotTicketRows`; they do not enter the account denominator. Run `positions:cron` to refresh a stale snapshot. There is no whole-book request:
each account uses Mode A, its customer ID in both `customerID` and `ip`, and today's Central report
date. Capture filenames use the UTC capture date for compatibility with corpus resolution.

Requests run sequentially, with a ten-second request timeout and a two-minute capture budget.
Empty account responses count as completed without activity. Any failed request, malformed
activity, exhausted budget, or entirely empty corpus aborts publication; the job records failure
and does not substitute an old capture. Existing R2 artifacts remain available with their original
data window. Requests are capped at 200 accounts and activity at 50,000 rows; exceeding a limit
fails rather than silently truncating coverage.

Only activity timestamps, actor logins, IPs and operations are retained privately in mode-0600
JSONL files under ignored `out/f402/weblog/`; provider `Data` is discarded. Do not commit captures.
The public rollup, manifest and pointer carry count-only `coverage`: snapshot/capture times,
report date, eligible/requested/completed accounts, accounts with activity, empty/failed accounts,
and activity row count. `wholeBookComplete` is always false. All selected pending accounts
completed is not all book accounts completed. Actor logins returned by a query need not identify
its query account or assigned agent.

Daemon pipeline KPIs expose this as `accountCoverage`. Missing legacy coverage is null, not
complete. Data freshness continues to use the newest parsed event time, separately from capture
and R2 publication time. A new capture cannot make old events fresh, and account coverage does
not establish full historical coverage, continuous sessions or accepted wagers.

The scoped wire behavior was observed on 2026-11-19: a whole-book selector returned no activity,
while 20 pending accounts returned 658 activity rows. That observation established the scoped
capture path; it does not guarantee that every future account has activity.
