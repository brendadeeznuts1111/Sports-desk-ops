# R2 staleness alert — operator runbook

## What this detects

The `r2-staleness-alert` GitHub Actions workflow runs every 15 min and HEADs the four public
bridge keys under `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/`. If any key's
`Last-Modified` is older than its per-key SLA, it posts one summary message to the Telegram
chat named by `TELEGRAM_CHAT_ID` and exits the job non-zero (so the workflow-failure email is
a second alert channel on top of the Telegram post).

## The v1 target set

| Key                           | SLA   | Source                       |
| ----------------------------- | ----- | ---------------------------- |
| `f402-bet-ticker/latest.json` | 1h    | bridge3a wager ticker rollup |
| `gslive-tally/latest.json`    | 1h    | bridge3c open-bets rollup    |
| `f402-weblog/latest.json`     | 1h30m | weblog pointer (hourly cron) |
| `wagers-by-state/latest.json` | 1h    | wager-state histogram        |

Why only these four: the operator's live branch still predates PR #42, so the newer keys
(`live-wagers/latest.json`, `agent-tree/latest.json`, `customer-profiles/latest.json`, etc.)
currently 404. Adding them to v1 would spam `MISSING` alerts for keys that nothing is yet
publishing. They move into scope once the operator is on main; edit
`BRIDGE_STALENESS_TARGETS` in `lib/r2_staleness.ts` to add them.

## Required repo secrets

Set under **Settings → Secrets and variables → Actions → Repository secrets**:

- `TELEGRAM_BOT_TOKEN` — the bot token (NOT a user-bot token, keep it in the keychain locally,
  never in the repo).
- `TELEGRAM_CHAT_ID` — numeric chat id. Send `/chatid` to the bot in your target chat to get it.

The workflow needs nothing else. No R2 credentials — the probe HEADs the public URL.

## Probe sheet (an independent engineer can run this)

```sh
# 1. Does the library pass tests?
bun test tests/r2_staleness.test.ts
#    Expected: 34 pass / 0 fail

# 2. Does a live dry-run against production R2 work?
bun run scripts/r2_staleness_alerter.ts --dry-run
#    Expected: JSONL report line + a rendered message if anything is stale;
#              exit 0 if all fresh, 2 if degraded.

# 3. Does the workflow file lint?
yamllint .github/workflows/r2-staleness-alert.yml  # or act -l

# 4. One manual run from the GH UI:
#    Actions → "r2-staleness-alert" → Run workflow → dry_run: true
#    Expected: JSONL report + rendered message in the job log, no Telegram post.
```

## When the alert fires

The message names which key is stale and how old it is. Most common root causes, in order of
observed frequency:

1. **F402 session rotation broke the bridge** — the rollup scripts rely on
   `~/.config/sportsdesk/gslive-session` or `F402_BEARER_TOKEN`. Recover with
   `bun run session:login --from-keychain` on the operator Mac. Check
   `scratch/bridge-rollup-cron.jsonl` — the latest entries will have `ok:false` with a
   credential error.
2. **Operator Mac asleep / crashed** — `pgrep -fl 'live_positions_cron'` returns empty.
   Restart the local cron and consider moving supervision to a `launchd` `LaunchAgent` with
   `KeepAlive` + `StartInterval` so a reboot or sleep does not kill it silently.
3. **R2 incident** — `curl -I https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/f402-bet-ticker/latest.json`
   returns 5xx. Check Cloudflare status.

## Limitations (v1)

- **No dedup state.** If an outage lasts 4 hours, you get ~16 alert messages (one every 15 min).
  Preferable to silent rotting; migrate to edge-triggered when the SNR warrants it.
- **GitHub Actions cron is not guaranteed on-time.** 5–10 min skew is normal at peak. Still well
  within budget at 15m cadence against 1h SLAs. Migrate to Cloudflare Workers cron triggers if
  tighter is needed.
- **The workflow needs this repo's `bun.lock`.** Any lockfile drift that breaks `bun install
--frozen-lockfile` silently takes the alerter offline. CI already runs `bun install` on PRs,
  so lockfile drift surfaces on PR open.
