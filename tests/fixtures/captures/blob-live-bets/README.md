# Blob/live-bets loopback trace (fixture, not evidence)

`loopback-trace.json` is a sanitized HTTP + WebSocket trace produced by
`bun run scripts/capture_blob_live_bets_trace.ts` against an **ephemeral loopback** server
(`PORT=0`). It is a fixture for handler-contract tests, not wire evidence:

- `docs/evidence/captures/` is live-only; a loopback record cannot upgrade a ledger tier.
- Bodies are reduced to shapes/statuses, bearer tokens are `<redacted>`, and the presigned URL
  is replaced with `<presigned-url-redacted>`.
- `surface.blob-live-bets` therefore stays Tier D (handler-verified, no live capture).

Regenerate with `bun run scripts/capture_blob_live_bets_trace.ts`.
