# Daemon static HTML

Token-compiled dashboards served by `sportsdesk_webview_server.ts`:

- `customer-churn-simulation-dashboard.html` — `GET /` and `GET /dashboard`
- `telegram-miniapp-dashboard.html` — `GET /miniapp`
- `live-bets.html` — `GET /live-bets`
- `status.html` — `GET /status`

Every figure on the dashboard comes from a `data/` artifact through `GET /api/kpis`, not from the
markup (`lib/desk_kpis.ts`). The agent-tree raster is not in this directory: it is
`scratch/agent-graph.webp`, served guarded as `GET /agent-graph.webp`, because it is a rendering of
the graph `/graph` serves.

Regenerate token slices: `bun run gen:tokens` (see `lib/gen_tokens/emission_targets.ts`).
