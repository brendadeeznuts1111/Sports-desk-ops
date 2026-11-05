# 2026-11-04 — Silent F402 bridge outage (14h49m), full recovery shipped

**Status:** closed, with monitoring + auto-refresh in place.
**Duration of impact:** 2026-11-04 06:33 UTC → 20:22 UTC (14h49m), bridge rollups returning `ok:false`.
**Detected by:** external R2 staleness alerter ([PR #43](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/43))
on its first production run.
**Recovered at:** 2026-11-04 20:30:01 UTC when `f402-bet-ticker/latest.json` went fresh after a
manual `F402_LIVE_LOGIN=1 bun run session:login --from-keychain --ttl-min 1440`.

Read this before touching the F402 session code path, the reporting scheduler, or the external
monitoring. The four PRs below ship as a set; removing any one of them re-opens the class of
bug that caused the outage.

## Timeline

|      UTC      | What                                                                                                                                                                                                                        |
| :-----------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     06:03     | Credential rotation mints a new F402 session with the then-default 30-min TTL.                                                                                                                                              |
|     06:33     | Session expires silently. `scripts/bridge3a:poll` starts returning `ok:false`.                                                                                                                                              |
| 06:33 → 20:22 | **14h49m of stale R2 keys.** No internal signal; the only place the failure surfaced was `ok:false` in a log nobody was tailing.                                                                                            |
|     20:22     | [PR #43](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/43) (external R2 staleness alerter) lands and runs; Telegram pages.                                                                                          |
|   20:30:01    | Manual `session:login --from-keychain --ttl-min 1440` re-mints a 24h session; `f402-bet-ticker/latest.json` goes fresh.                                                                                                     |
| 20:40 → 23:00 | PRs [#44](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/44), [#45](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/45), [#46](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/46) ship as the full fix. |

## Root cause (three layers, each independently fatal)

1. **30-min default session TTL** (`DEFAULT_TTL_MINUTES = 30` in `lib/f402_session.ts`).
   Defensible when humans re-minted by hand; a trap once operators walked away. Anyone
   running `session:login` and closing the terminal got a silent outage in ≤30 min.
2. **No internal monitor.** Every bridge rollup wrote `ok:false` to its own log but nothing
   escalated. The scheduler ticked happily for 14h, consuming CPU and writing stale keys.
3. **No automatic re-mint.** Even if TTL had been longer, sooner-or-later the session expires
   and only a human login can restore it. Humans sleep. Bridges should not.

## Fix (four PRs, shipped as a set)

### [PR #43](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/43) — External R2 staleness alerter (GH Actions + Telegram)

Monitor the system **from outside the system**. A scheduled GitHub Actions workflow HEADs the
four public R2 bridge keys (`bet-ticker/latest.json`, `live-bets/latest.json`,
`agent-tree/latest.json`, `customer-profiles/latest.json`), compares `Last-Modified` against a
per-key budget, and posts to Telegram if any key is stale. Runs on GH infrastructure so a dead
operator machine cannot silence it. This is what caught the 2026-11-04 outage.

Lesson: **internal health checks that run in the same process as the thing they're checking
are structurally incapable of detecting the process going silent.** External monitor or bust.

### [PR #44](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/44) — F402 session auto-refresh (launchd LaunchAgent)

Close the 30-min-TTL loop with a LaunchAgent that fires every 5 min, checks whether the
current session is within a 5-min grace window of its expiry, and re-mints it if so. The
decision is a pure function (`decideRefresh` in `lib/f402_session_refresh.ts`), unit-tested
across all five expiry classes (`fresh | missing | unparseable-expiry | expired | expiring-soon`).
The runner never logs cookies, passwords, or child stderr.

See [docs/runbooks/f402_session_refresh.md](../runbooks/f402_session_refresh.md).

### [PR #45](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/45) — subtract(tier1): dead TELEGRAM env, 30-min TTL trap, dead cron ticks

Three subtractions from code paths the outage exposed as either dead or actively harmful:

- **Delete `TELEGRAM_REPORT_SCHEDULE`** from `types/env.d.ts` and `scripts/deploy/deploy_to_vps.sh`.
  Zero TypeScript consumers; operators who set it saw nothing happen.
- **Raise `DEFAULT_TTL_MINUTES` 30 → 1440** in `lib/f402_session.ts`. Now that the refresher
  exists, the 30-min default is a trap that only hurts operators who skip installing the
  LaunchAgent. 24h is a safety net under the refresher's 5-min active guarantee.
- **Don't arm SHELL_CAPTURE schedules whose `requires` are unmet.** Before this PR,
  `sched_agent_tree_hourly` fired 24×/day on operators without `F402_BEARER_TOKEN`, skipped
  every time, logged the skip, did nothing. After this PR the schedule is dropped at startup
  with one log line naming the missing requirement; the per-tick skip stays as defense in depth.

### [PR #46](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/46) — subtract(tier2d): make `resolveChromeBinary` internal, drop its dedicated unit tests

Smaller cleanup surfaced by the audit. Zero external callers of `resolveChromeBinary`; zero
production injections of the `resolveBinary` option on `DiagnoseChromeOptions`. The dedicated
unit-test block was end-to-end covered by the `diagnoseChromeBackend` tests. Measured the
operator machine first: `Bun.which()` returns null for all 7 documented candidates, but
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` exists — so the
`MAC_INSTALL_PATHS` branch is the _only_ path that keeps the Chrome backend working here.
Kept it; deleted only what was genuinely dead.

Lesson: **"design for observed usage" means measure the operator machine before deleting a
fallback.** The originally-planned 80-line delete would have regressed Chrome backend to
`not-found` on the very machine the author was typing from.

## What is now automated

- **Monitoring**: external GitHub Actions workflow HEADs R2 and pages Telegram on staleness.
- **Session minting**: launchd LaunchAgent re-mints every 5 min with 5-min grace, 24h TTL.
- **Credential gating**: SHELL_CAPTURE schedules with missing requires are dropped at startup,
  not armed-then-skipped.
- **Tests**: 2,772 tests cover the four PRs and hold the guarantees (expiry classifier,
  scheduler drop behavior, R2 staleness classification, Chrome diagnosis).

## What still requires operator action (not automatable)

These three things remain manual because they involve credentials that the agent can neither
read, rotate, nor install:

1. **Rotate `GSLIVE_USERNAME` / `GSLIVE_PASSWORD`.** As of the recovery, GSLive returns
   `HTTP 401 {"e":1,"r":[],"d":"Please login to your account"}`. The password is stale. No
   automated mint path exists.
2. **Set `F402_BEARER_TOKEN` for bridge3b** (the F402 pending-bets rollup). bridge3b has no
   automated bearer-mint path; the operator must install the token into the keychain or
   `~/.config/sportsdesk/f402-token`.
3. **Install the LaunchAgent** so [PR #44](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/44)
   actually runs: `scripts/install_session_refresh_agent.sh install`. Until this runs, the
   24h TTL from [PR #45](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/45) is the
   only thing keeping the bridges up.

## Guarantees to preserve

If you're editing any of the following, re-read this doc first:

| File / surface                                             | Guarantee                                                                                                       |
| :--------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `lib/f402_session.ts` `DEFAULT_TTL_MINUTES`                | ≥ 1440. Lowering it without a compensating change re-opens the class of bug.                                    |
| `lib/f402_session_refresh.ts` `decideRefresh`              | Pure, no I/O. Covered by 15 tests across 5 expiry classes.                                                      |
| `.github/workflows/r2-staleness-alert.yml`                 | External, scheduled, uses Telegram secrets from GH environment. Do not move internal.                           |
| `services/reporting_scheduler_service.ts` `start()`        | Must drop SHELL_CAPTURE schedules whose `requires` are unmet, with one log line per drop.                       |
| `lib/webview_backend_diagnostics.ts` `resolveChromeBinary` | Keep `MAC_INSTALL_PATHS` branch. Measured 2026-11-04: it's the only path that works on this operator's machine. |

## References

- [`docs/runbooks/r2_staleness_alert.md`](../runbooks/r2_staleness_alert.md) — external alerter operator guide.
- [`docs/runbooks/f402_session_refresh.md`](../runbooks/f402_session_refresh.md) — LaunchAgent install, verify, uninstall.
- [`docs/runbooks/telegram_seeding.md`](../runbooks/telegram_seeding.md) — SHELL_CAPTURE schedules, requires semantics.
- [`docs/REAL_INGESTION.md`](../REAL_INGESTION.md) §4b — F402 session cache contract.
