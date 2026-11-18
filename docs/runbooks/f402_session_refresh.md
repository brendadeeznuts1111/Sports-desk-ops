# F402 session auto-refresh — operator runbook

## Why this exists

On 2026-11-04 a credential rotation at 06:03 UTC minted a session that expired at 06:33 under
the then-default 30-minute TTL; every bridge rollup after that returned `ok:false` for 14+
hours until the external R2 staleness alerter ([PR #43](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/43))
paged us at 20:22 UTC. Two fixes shipped together:

1. **Raise the fallback TTL to 24h** ([PR #45](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/45),
   `DEFAULT_TTL_MINUTES = 1440` in `lib/f402_session.ts`). This is a **fallback cap**, not the
   effective expiry. A session with a portal bearer derives its expiry from the JWT `exp`
   (21 minutes, measured 2026-11-17), so the 24h value only applies to cookie-only sessions and
   to a deliberately shorter caller TTL.
2. **This runbook's feature** ([PR #44](https://github.com/bw496915-cmyk/Sports-desk-ops/pull/44)):
   a LaunchAgent fires every 5 min, checks whether the current session is about to expire, and
   re-mints it before it does. The decision is pure (no I/O) and unit-tested; the runner is thin
   and never logs a cookie, password, or stderr.

The binding clock is the server's bearer `exp`, not the file. `sessionFromAuth` writes
`expiresAtIso = min(now + ttl, exp - 2 min)`, so `decideRefresh()` sees the real window and
fires on the first tick inside the 5-minute grace. Before 2026-11-17 the file claimed 24h, which
made the refresher a no-op after the first mint; the 21-minute JWT then died silently. That was
the 2026-11-17 outage. The `F402_REFRESH_TTL_MIN` stopgap (12/15 min) existed only to work
around the wrong clock and is no longer needed for bearer sessions — unset it.

## How it works

```
~/Library/LaunchAgents/com.bookdeskops.sportsdesk.session-refresh.plist
  │
  │ StartInterval=300 (every 5 min) + RunAtLoad=true
  ▼
bun run scripts/f402_session_refresh.ts
  │
  ├── readF402Session()                             # may be null
  ├── decideRefresh(session, now, graceMs=5min)     # pure function
  │     ├── null            → missing            → refresh
  │     ├── unparseable     → unparseable-expiry → refresh
  │     ├── expiry <= now   → expired            → refresh
  │     ├── <  now + grace  → expiring-soon      → refresh
  │     └── >= now + grace  → fresh              → no-op (exit 0)
  │
  ├── Bun.spawn("bun run session:login --from-keychain --ttl-min 1440",
  │             F402_LIVE_LOGIN=1, stdio=ignore)  # 1440 is a cap; the file gets exp - 2 min
  │
  └── append JSONL to scratch/f402-session-refresh.jsonl
```

The `--ttl-min 1440` is an upper cap. When the login exposes a portal bearer, the minted file's
`expiresAtIso` is the JWT `exp` minus the 2-minute margin (`F402_DERIVED_EXPIRY_MARGIN_MS`), so
the refresher fires roughly every 15–20 minutes with the 5-minute tick and grace — instead of
the ~10 minutes the 12-minute stopgap forced, with no env tuning. If spawning fails for a
non-credential reason (e.g. headless Chrome backend not available), the JSONL carries
`{"ok":false,"error":"exit-nonzero"}` and the runner exits 2; the next tick retries.

### Derived expiry and the 21-minute window

- `sessionFromAuth` (`lib/f402_session.ts`) decodes the bearer's `nbf`/`exp` through
  `lib/f402_jwt.ts` and writes `expiresAtIso = min(now + ttl, exp - 2 min)`.
- Opaque or cookie-only sessions keep `now + ttl`; there is no server clock to read.
- After a mint the runner journals `tokenNbfIso`/`tokenExpIso`/`tokenWindowMin`. A window
  outside 21 ± 2 minutes appends a `f402-token-window-alert` line and prints an alert to
  stderr; it does **not** change the decision, which is driven by `exp`.
- Probe: `tail -1 scratch/f402-session-refresh.jsonl | jq .tokenWindowMin` should print `21`
  after a mint. A different value means the vendor changed the window; update
  `EXPECTED_TOKEN_WINDOW_MINUTES` and this runbook together.
- Vendor dependency: portal 1.0.287's `security.js` refreshes `sessionStorage.token` in-page
  every 5 minutes (`timeRefresh: 3e5`). The current re-login loop does not rely on it (it closes
  the WebView); any future persistent-page harvester must probe it before enabling.

## Install

```sh
scripts/install_session_refresh_agent.sh install
# -> installed: ~/Library/LaunchAgents/com.bookdeskops.sportsdesk.session-refresh.plist
# -> installed: ~/Library/LaunchAgents/com.bookdeskops.sportsdesk.session-watch.plist
# -> next: tail -f scratch/f402-session-refresh.jsonl
# -> watch: tail -f scratch/f402-session-watch.stderr.log
```

The installer substitutes the machine paths and Bun binary into the templates under
`infra/launchd/`, writes them to `~/Library/LaunchAgents/`, and bootstraps them.
`--target session-refresh` installs the **keychain-direct** refresher and the independent
watchdog; it needs no `.env.op`, `op`, or `OP_SERVICE_ACCOUNT_TOKEN`. `--target daemon` (or
`both`) also installs the op-wrapped webview daemon and requires `.env.op` plus
`OP_SERVICE_ACCOUNT_TOKEN` in the calling shell.

## Verify

```sh
# 1. launchd sees it:
scripts/install_session_refresh_agent.sh status
#    Expected: a PID or - (idle), a last-exit code, and the Label.

# 2. The first tick has fired:
tail -1 scratch/f402-session-refresh.jsonl | jq .
#    Expected on a fresh session:
#    { "kind": "f402-session-refresh", "reason": "fresh",
#      "attempted": false, "ok": true, ... }

# 3. The session file exists and is 0600:
ls -la ~/.cache/sportsdesk/f402-session.json
#    Expected: -rw------- (mode 0600) and a recent mtime (minutes on an active refresher).

# 4. Live dry-run to confirm the decision path without spawning:
bun run scripts/f402_session_refresh.ts --dry-run
#    Expected: "dry-run: would refresh (<reason>)" OR silent (exit 0 fresh).

# 5. Full tests:
bun test tests/f402_session_refresh.test.ts tests/f402_session_watch.test.ts
#    Expected: 0 fail.

# 6. Watchdog dry-run (prints the verdict, never calls Telegram):
bun run scripts/f402_session_watch.ts --dry-run
#    Expected: "F402 session refresh is healthy." OR the missing/stale/failing verdict.
```

## Uninstall

```sh
scripts/install_session_refresh_agent.sh uninstall
# -> removed: ~/Library/LaunchAgents/com.bookdeskops.sportsdesk.session-refresh.plist
```

## Journal grammar

Every tick writes exactly one line to `scratch/f402-session-refresh.jsonl`:

```json
{
  "kind": "f402-session-refresh",
  "observedAtMs": 1793824560583,
  "reason": "fresh|missing|unparseable-expiry|expired|expiring-soon",
  "msUntilExpiry": 85883462,
  "attempted": true,
  "ok": true,
  "mintDurationMs": 2100,
  "tokenNbfIso": "2026-11-17T16:35:32.000Z",
  "tokenExpIso": "2026-11-17T16:56:32.000Z",
  "tokenWindowMin": 21,
  "error": "exit-nonzero|post-read-missing|post-read-stale|spawn-error"
}
```

A window outside 21 ± 2 minutes also appends a separate
`{"kind":"f402-token-window-alert", ...}` line. `error` is a stable classifier string, never a
message from the child. Nothing in this journal is a cookie, password, or session value.

## Silence watchdog

`scripts/f402_session_watch.ts` is installed alongside the refresher (same installer,
`--target session-refresh`) and runs on its own 5-minute LaunchAgent. It reads the journal mtime
and its last few ticks, and pages Telegram when:

- the journal is missing (the agent is not installed or has never run),
- the journal mtime is older than 12 minutes (two missed ticks),
- the last tick reports `ok:false`, or
- the last two ticks both report `ok:false`.

It shares no process with the refresher, so a dead agent cannot silence its own alarm. The alert
includes the journal path, age, threshold, and the last tick's classifier fields — never a
cookie or token.

Exit codes: `0` healthy (or `--dry-run`), `1` alert detected and sent, `2` could not alert
(no Telegram credentials or a send failure). In the `2` case the alert is still printed to
stderr, which the plist captures in `scratch/f402-session-watch.stderr.log`.

```sh
bun run scripts/f402_session_watch.ts --dry-run   # print the verdict, no Telegram
bun run scripts/f402_session_watch.ts --json      # machine-readable verdict
```

## Interaction with the R2 staleness alerter

The staleness alerter (`.github/workflows/r2-staleness-alert.yml`) is the _external_ monitor:
it runs on GitHub Actions, HEADs the public R2 URLs, and pages Telegram if any bridge key is
stale. The session refresh is the _internal_ fix that keeps those R2 keys fresh in the first
place. They are complementary, not redundant: the refresh keeps the system healthy; the alerter
notices when the refresh fails anyway (e.g., GSLive credentials are rotated server-side and
the keychain is stale).

## Known limitations

- **The server token lives 21 minutes.** The refresher closes that gap; the file cannot extend
  it. A stopped LaunchAgent means a dead session within ~21 minutes, not 24 hours.
  `scripts/f402_session_watch.ts` (above) detects that case.
- **macOS only.** The LaunchAgent is a plist; Linux hosts would use systemd user units with
  `OnCalendar` instead. The pure library (`lib/f402_session_refresh.ts`) is cross-platform;
  only the supervision wrapper is Mac-specific.
- **Headless backend must be present.** `session:login --from-keychain` launches a WebView to
  go through the portal; `Bun.WebView` supplies the engine on `agent:doctor`
  (`OK Bun.WebView available`). Stock Chrome is blocked by the sandbox.
- **Does not refresh the GSLive GSID.** That is a separate credential surface; it has its own
  minting path in `lib/gslive_auto_session.ts` and will get its own refresh in a follow-up.
