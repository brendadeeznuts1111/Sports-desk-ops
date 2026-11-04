# F402 session auto-refresh — operator runbook

## Why this exists

The default F402 session TTL in `lib/f402_session.ts` is 30 minutes (`DEFAULT_TTL_MINUTES = 30`).
An operator who runs `session:login` and walks away gets a silent bridge outage half an hour
later; `scripts/bridge3a:poll` reads the session file, finds it expired or absent, and the
whole bridge rollup cron starts returning `ok:false`. On 2026-11-04 this cost 14+ hours of
stale R2 bridge keys — the credential rotation at 06:03 UTC minted a session that expired at
06:33, and nothing caught it until the external R2 staleness alerter was shipped at 20:22 UTC.

This feature closes the loop: a LaunchAgent fires every 5 min, checks whether the current
session is about to expire, and re-mints it before it does. The decision is pure (no I/O) and
unit-tested; the runner is thin and never logs a cookie, password, or stderr.

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
  │             F402_LIVE_LOGIN=1, stdio=ignore)
  │
  └── append JSONL to scratch/f402-session-refresh.jsonl
```

Re-mint uses `--ttl-min 1440` (24 h) so the refresher at 5-min cadence has 288 tries before
expiry. If spawning fails for a non-credential reason (e.g. headless Chrome backend not
available), the JSONL carries `{"ok":false,"error":"exit-nonzero"}` and the runner exits 2;
the next tick retries.

## Install

```sh
scripts/install_session_refresh_agent.sh install
# -> installed: ~/Library/LaunchAgents/com.bookdeskops.sportsdesk.session-refresh.plist
# -> next: tail -f scratch/f402-session-refresh.jsonl
```

The installer substitutes `__OPERATOR_HOME__`, `__REPO_PATH__`, and `__BUN_BIN__` in the
template at `infra/launchd/com.bookdeskops.sportsdesk.session-refresh.plist`, writes the
result to `~/Library/LaunchAgents/`, and `launchctl load -w`s it.

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
#    Expected: -rw------- (mode 0600) and recent mtime (< 25 h).

# 4. Live dry-run to confirm the decision path without spawning:
bun run scripts/f402_session_refresh.ts --dry-run
#    Expected: "dry-run: would refresh (<reason>)" OR silent (exit 0 fresh).

# 5. Full tests:
bun test tests/f402_session_refresh.test.ts
#    Expected: 15 pass / 0 fail.
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
  "error": "exit-nonzero|post-read-missing|post-read-stale|spawn-error"
}
```

`error` is a stable classifier string, never a message from the child. Nothing in this journal
is a cookie, password, or session value.

## Interaction with the R2 staleness alerter

The staleness alerter (`.github/workflows/r2-staleness-alert.yml`) is the _external_ monitor:
it runs on GitHub Actions, HEADs the public R2 URLs, and pages Telegram if any bridge key is
stale. The session refresh is the _internal_ fix that keeps those R2 keys fresh in the first
place. They are complementary, not redundant: the refresh keeps the system healthy; the alerter
notices when the refresh fails anyway (e.g., GSLive credentials are rotated server-side and
the keychain is stale).

## Known limitations

- **macOS only.** The LaunchAgent is a plist; Linux hosts would use systemd user units with
  `OnCalendar` instead. The pure library (`lib/f402_session_refresh.ts`) is cross-platform;
  only the supervision wrapper is Mac-specific.
- **Headless backend must be present.** `session:login --from-keychain` launches a WebView to
  go through the portal; the Playwright headless shell satisfies this on `agent:doctor`. Stock
  Chrome is blocked by the sandbox.
- **Does not refresh the GSLive GSID.** That is a separate credential surface; it has its own
  minting path in `lib/gslive_auto_session.ts` and will get its own refresh in a follow-up.
