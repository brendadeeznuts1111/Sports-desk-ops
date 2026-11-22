# Private Cloudflare R2 source-freshness guard

## Ownership and purpose

This directory is the source of truth for the isolated Cloudflare Worker
`sportsdesk-r2-source-freshness-guard`. Its only operational job is to detect
stale **underlying data** in four preexisting `sportsdesk-ops-reports` R2
objects and emit structured Workers Logs. It does **not** ingest Manager data,
repair expired GSLive sessions, publish reports, mutate stored objects, or
replace the operator's Bun cron. The scheduled Worker is independent of
`fantasy402-ingestion` and `bet-ticker-worker`.

Cloudflare was inspected on 2026-11-22: no existing Worker had Cron Triggers;
the two ingestion modes remain `skip` and `external`. The R2 bucket's
`r2.dev` domain is disabled and has no custom domain. **Do not enable public
R2 to make the old HTTP HEAD checker work.**

## Source age, not R2 Last-Modified

| Key | Observation clock | Allowed data age |
| --- | --- | --- |
| `f402-bet-ticker/latest.json` | `data_window_max_epoch_ms` | 60 minutes |
| `gslive-tally/latest.json` | `generatedAt`; verify referenced dated `rollup.json` and rowCount | 60 minutes |
| `f402-weblog/latest.json` | `data_window_max_epoch_ms`; report scoped coverage | 90 minutes |
| `wagers-by-state/latest.json` | `capturedAt`, plus its own `staleness.stale` flag | 60 minutes |

The GSLive pointer is dereferenced only when it matches
`gslive-tally/YYYY-MM-DD/rollup.json`. A valid read with zero rows is
distinguished from a positive tally. Weblog `wholeBookComplete:false` is a
`partial` warning when the source is fresh; this need not mean individual
account reads failed. Missing objects are `missing`, failed R2 reads are
`unverified`, malformed timestamps are `invalid`. The logger never sends
raw object content, accounts, names, IPs, token values, or bet records.

## Deployed configuration

`wrangler.jsonc` declares one R2 binding `REPORTS` to the existing bucket,
`workers_dev:false`, no custom routes, Cron `*/15 * * * *` UTC,
logs at 100% and traces at 1%. The HTTP handler always returns 404.
The code only calls `R2Bucket.get` and never writes. **Important:** Cloudflare
R2 bindings are capabilities that also support write methods; the read-only
behavior here is enforced by this Worker code, not a platform read-only binding.

Installed via the Cloudflare API on 2026-11-22 after the source and test blobs
were pinned. Verified via Cloudflare GET settings, subdomain, schedules and
deployments: binding is correct, workers.dev/previews disabled, scheduled trigger
present, logs/traces enabled. The deployed code has not yet been observed
running on a real Cron event; Cron propagation and execution should be checked
in Cloudflare Workers & Pages → this Worker → Observability / Cron Events.

## Validation and recovery

```sh
node --check workers/r2_freshness_guard/worker.mjs
node --test workers/r2_freshness_guard/worker.test.mjs
```

The source and test files were verified by exact Git blob SHA against those
locally tested under Node 22.16.0 (seven tests passed). No deployment test
with a live scheduled runtime has yet completed; do not call this an end-to-end
repair of the upstream pipelines. The full repo's pinned Bun CI is separate.

If the guard produces incorrect classifications, first disable its Cron by
setting `triggers.crons=[]` in this configuration and deploying that change,
or via the Cloudflare Worker Schedules API with body `[]`. Disabling the
monitor must not affect the external Bun publisher or its R2 objects.

To repair data staleness, fix upstream GSLive session and successful nonempty
Bridge 3c capture, and run the existing Bun pipeline under its normal
idempotency/credential gate. Never reset `capturedAt` or reissue `latest.json`
merely to make age metrics appear healthy.
