# Telegram Seeding Runbook

Seed the five Telegram variables the SportsDesk bot reads so `/api/telegram/status` reports
`seeding: keychain` for every row and the dashboard's Telegram card loses its yellow "MISSING"
banner.

## What is in the group

[lib/secret_manifest.ts](../../lib/secret_manifest.ts) places all five variables in the `telegram`
group (`inject: true`, canonical service `com.bookdeskops.sportsdesk`):

| Variable                  | What it is                                                                                       |
| :------------------------ | :----------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | Bot API token (Telegram fixes the name).                                                         |
| `TELEGRAM_WEBHOOK_SECRET` | Secret Telegram must echo in `X-Telegram-Bot-Api-Secret-Token`. `setWebhook` refuses without it. |
| `TELEGRAM_CHAT_ID`        | Default destination chat the bot sends to.                                                       |
| `TELEGRAM_WEBHOOK_URL`    | Public https URL Telegram POSTs updates to.                                                      |
| `TELEGRAM_MINIAPP_URL`    | Public https URL of the `/miniapp` page (also the deep-link base for `web_app` buttons).         |

## Store (values on stdin, never argv)

```sh
printf %s "$BOT_TOKEN"       | bun run secrets:env set TELEGRAM_BOT_TOKEN
printf %s "$WEBHOOK_SECRET"  | bun run secrets:env set TELEGRAM_WEBHOOK_SECRET
printf %s "$CHAT_ID"         | bun run secrets:env set TELEGRAM_CHAT_ID
printf %s "$WEBHOOK_URL"     | bun run secrets:env set TELEGRAM_WEBHOOK_URL
printf %s "$MINIAPP_URL"     | bun run secrets:env set TELEGRAM_MINIAPP_URL
```

`secrets:env set` reads from stdin only — a typed value would land in the shell history and the
screen. The read-back check prints `stored in com.bookdeskops.sportsdesk (read back ok, N bytes)`.

## Confirm

```sh
bun run secrets:env status --with telegram
# TELEGRAM_BOT_TOKEN       keychain
# TELEGRAM_CHAT_ID         keychain
# TELEGRAM_MINIAPP_URL     keychain
# TELEGRAM_WEBHOOK_SECRET  keychain
# TELEGRAM_WEBHOOK_URL     keychain
```

Any row that prints `missing` is not stored. A row that prints `env` is set in the shell and would
win over the keychain on precedence; that is intentional for CI, but on the operator machine it
means you have not stored the value.

## Launch the daemon with the group injected

```sh
bun run secrets:env exec --with telegram -- bun run serve
```

`secrets:env exec` reads only the names in `--with telegram`, puts them in the child's environment
and spawns `bun run serve`. The parent shell never has them; the audit log never has values.

## Check the status endpoint

```sh
curl -s http://127.0.0.1:4020/api/telegram/status \
    -H "Authorization: Bearer $(cat admin.token)" \
  | jq '.seeding'
```

The response includes a `seeding` array:

```json
[
  { "name": "TELEGRAM_BOT_TOKEN", "source": "keychain", "kind": "keychain" },
  { "name": "TELEGRAM_CHAT_ID", "source": "keychain", "kind": "keychain" },
  { "name": "TELEGRAM_MINIAPP_URL", "source": "keychain", "kind": "keychain" },
  {
    "name": "TELEGRAM_WEBHOOK_SECRET",
    "source": "keychain",
    "kind": "keychain"
  },
  { "name": "TELEGRAM_WEBHOOK_URL", "source": "keychain", "kind": "keychain" }
]
```

Values are never returned. The executive dashboard's Telegram card consumes this field and names
any variable that is still `missing`.

## Register the webhook

Once the server is reachable from Telegram's side (public TLS host matching `TELEGRAM_WEBHOOK_URL`):

```sh
curl -s -X POST http://127.0.0.1:4020/api/telegram/webhook \
    -H "Authorization: Bearer $(cat admin.token)" \
    -H "Content-Type: application/json" \
    -d '{"action":"set"}'
# {"success":true,"ok":true}
```

Delete with `{"action":"delete"}`. `setWebhook` refuses without `TELEGRAM_WEBHOOK_SECRET`, so the
webhook endpoint is never exposed unauthenticated.

If you cannot expose a public URL, delete the webhook and run the long-polling daemon instead:

```sh
bun run secrets:env exec --with telegram -- bun run scripts/live_positions_cron.ts
```

## Mini App server-side HMAC

Launches from the Mini App carry a signed `initData` payload. Verify it server-side with
[`lib/telegram_initdata.ts`](../../lib/telegram_initdata.ts):

```ts
import { verifyTelegramInitData } from "./lib/telegram_initdata.ts";

const result = verifyTelegramInitData(
  req.headers.get("x-telegram-init-data") ?? "",
  await readBotToken(), // from secret_env.resolveSecretEnv(["TELEGRAM_BOT_TOKEN"])
  { maxAgeSeconds: 300 },
);
if (!result.ok) return new Response(null, { status: 401 });
const { user, chatId } = result.data;
```

The verifier runs `HMAC_SHA256(key=SHA256(bot_token), data=sorted_data_check_string)`, compares
with `crypto.timingSafeEqual`, and rejects with `reason: "malformed" | "hash" | "stale"`. It takes
no I/O, performs no logging, and never echoes the token or the raw payload.

## Making the KPI strip live

Seeding Telegram alone will not move the KPI cards at `/`; the daemon needs F402 and GSLive
credentials so the in-process bridge cron can rewrite the four source artifacts:

| Card          | Artifact                      | Rebuilder                                                                                                         |
| :------------ | :---------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| agents        | `data/agent-tree.json`        | `sched_agent_tree_hourly` (`bun run build:agent-tree` at `:11`; gated on `F402_BEARER_TOKEN`)                     |
| pending       | `data/live-bets.json`         | `sched_bridge_rollup_15m` (`bridge3b`, needs F402 token)                                                          |
| ticker        | `data/bet-ticker.json`        | `sched_bridge_rollup_15m` (`bridge3a`, needs `F402_AGENT_ID`)                                                     |
| customer book | `data/customer-profiles.json` | `sched_customer_profiles_6h` (`bun run customers:profiles` at `:27 */6`; gated on `enriched_customers_full.json`) |

Watch the mtimes to confirm:

```sh
stat -f '%Sm %N' data/agent-tree.json data/live-bets.json data/bet-ticker.json data/customer-profiles.json
```

Each capture is credential-gated: a missing requirement logs
`[Shell Capture] bun run build:agent-tree: skipped (missing F402_BEARER_TOKEN)` without spawning
the CLI, so cron cannot hammer a tool that would exit 2. Values are never printed.

The engine badge on `http://127.0.0.1:4020/` reads `/api/kpis` every 60 seconds and flips from
`DATA UNAVAILABLE` to `MIXED DATA` to `LIVE DATA` as the four artifacts come up to date.
