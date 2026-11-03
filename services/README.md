# Long-running services & domain engines

| File                             | Role                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| `sportsdesk_webview_server.ts`   | Bun HTTP daemon (`bun run serve`) — dashboards, graph, Telegram webhook |
| `sportsdesk_telegram_bot.ts`     | Bot API, watch list, scheduled reports                                  |
| `reporting_scheduler_service.ts` | Cron-style report dispatch                                              |
| `sportsdesk_r2_sync.ts`          | Cloudflare R2 SigV4 sync                                                |
| `simulate_bettor_churn_suite.ts` | Churn simulation & consumer wire types (OpenAPI tier-C evidence)        |
| `agent_onepass_plugin.ts`        | Streaming liability accumulator                                         |
| `sportsdesk_ingestion_*.ts`      | Feed pull, provenance, JSONL replay                                     |

Static HTML is served from `../static/`; design SSOT lives in `../design/`.

### `blob_and_live_bets_server.ts`

Hardened gateway: bearer-auth blob routes, bounded uploads, `Bun.Image` decode guard
(`maxPixels`) with deterministic `backend = "bun"`, short-lived HMAC WebSocket tickets, and
message-size/channel validation.

Required env: `BLOB_API_TOKEN`, `BLOB_TICKET_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME`, plus `R2_ENDPOINT` or `CLOUDFLARE_ACCOUNT_ID`. Optional caps:
`BLOB_MAX_UPLOAD_BYTES` (default 5 MiB), `BLOB_MAX_PIXELS` (default 4096²), `PORT` (default 3000).
`bun test tests/blob_and_live_bets_server.test.ts` covers auth, key validation, upload caps, pixel
bombs, presign redirects, WS tickets, PING/PONG, channel validation and message limits.

### `supervisor.ts`

Starts `sportsdesk_webview_server.ts` and, when `BLOB_API_TOKEN` + `BLOB_TICKET_SECRET` are set,
`blob_and_live_bets_server.ts`. It polls each `/health`, restarts a child after three consecutive
failures or an exit (1s → 30s capped backoff), and forwards SIGINT/SIGTERM as SIGTERM to children.
`BLOB_PORT` defaults to 4021; `WEBVIEW_HEALTH_URL`/`BLOB_HEALTH_URL` override the probes.

Hardening notes: uploads are never upscaled (`Bun.Image.metadata()` gates the resize), active
ticket nonces are capped (4096, evicting expires only — issuance returns 429 when full), and
`POST /api/v1/live-bets` (bearer) publishes `{channel, event}` to subscribers via `Server.publish`;
the factory also exposes `publish(channel, event)` for in-process producers.
