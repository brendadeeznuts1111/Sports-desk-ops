# SportsDesk Cloudflare API & R2 Storage Runbook

This guide details the integration of your Cloudflare Account, Scoped API Token, S3-Compatible Object Storage, and **Public R2 Access Subdomain (`r2.dev`)** with the **SportsDesk Operations Suite** (`sportsdesk_r2_sync.ts`, `sportsdesk_cli.ts`, `run_reports.sh`, and `deploy_to_vps.sh`).

## 1. Credentials & Configuration Matrix

| Variable                      | Configured Value                                                    | Operational Purpose                                           |
| :---------------------------- | :------------------------------------------------------------------ | :------------------------------------------------------------ |
| **`CLOUDFLARE_ACCOUNT_ID`**   | `7a470541a704caaf91e71efccc78fd36`                                  | Scopes Cloudflare API requests & R2 namespace                 |
| **`CLOUDFLARE_API_TOKEN`**    | `<CLOUDFLARE_API_TOKEN>` _(configured in `.env`)_                   | Pages deploy, DNS & account API verification                  |
| **`CLOUDFLARE_R2_API_TOKEN`** | `<CLOUDFLARE_R2_API_TOKEN>` _(configured in `.env`)_                | R2-scoped token; kept separate so Wrangler does not shadow it |
| **`R2_ACCESS_KEY_ID`**        | `<R2_ACCESS_KEY_ID>` _(configured in `.env`)_                       | S3-compatible client access key                               |
| **`R2_SECRET_ACCESS_KEY`**    | `<R2_SECRET_ACCESS_KEY>` _(configured in `.env`)_                   | S3-compatible secret signing key (SigV4)                      |
| **`R2_ENDPOINT`**             | `https://7a470541a704caaf91e71efccc78fd36.r2.cloudflarestorage.com` | Global S3 REST endpoint                                       |
| **`R2_BUCKET_NAME`**          | `sportsdesk-ops-reports`                                            | Dedicated bucket for report archives and audit bundles        |
| **`R2_PUBLIC_URL`**           | `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev`               | Public HTTPS gateway for zero-egress report downloads         |

### 1.1. Bun.secrets fallback (unmounted `.env`)

When `.env` is a FIFO/1Password mount that is not attached, `lib/r2_s3_client.ts` checks the
`Bun.secrets` service **`sportsdesk-ops`** after the env precedence (`R2_*` → token SHA-256 →
`S3_*` → `AWS_*`). The lookup names are `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET_NAME`, and `BLOB_API_TOKEN`.

Seed them once from the existing macOS Keychain entries:

```bash
bun scripts/secrets_r2.ts seed      # stores values without printing them
bun scripts/secrets_r2.ts status    # names only: present/missing
```

`bun scripts/publish_r2_graph.mjs` and `./bin/dx deploy` then resolve R2 credentials automatically;
`./bin/dx deploy` probes the same resolver (`--check-credentials`) before choosing the Wrangler
fallback. `BLOB_API_TOKEN` is not derivable from the R2 keys and must be supplied separately when
the gateway sink is used.

### 1.2. `.env` delivery: FIFO for development, explicit `--env-file` for production

The repo `.env` is a 1Password-mounted FIFO (`code-project sync-environments`). Bun reads it once
at process start, which is fine for an interactive shell but wrong for a daemon that restarts or
forks: a `--watch` reload or a `child_process.fork()` child inherits `execArgv` and re-reads the
path, where the pipe is empty and a FIFO waits for a new writer. Production entrypoints should
therefore deliver `.env`-style values explicitly — one fetch at process start, no persistent mount:

- fresh fetch, no stale mount: `bun --env-file=<(op read "op://<vault>/<item>/env") run <script>`
- no `.env` at all (cron, keychain-only): `bun --no-env-file run <script>`
- the flag placement is the same as for tests (`bun --no-env-file test …`): put it before the
  subcommand. Verified on Bun 1.4.4 with a script that prints `process.env.BUN_CHROME_PATH`:
  present by default, `null` under `bun --no-env-file run`, and present again with
  `--env-file=<(printf …)`.

**Failure propagation is a separate guarantee from read-once.** Process substitution is lazy: if
`op read` fails (locked 1Password, expired session, missing item), the FIFO is empty and `bun`
still starts — the script sees an empty environment and fails later as "credentials missing"
instead of failing at startup. Fetch and validate before starting Bun:

```sh
env_vars=$(op read "op://<vault>/<item>/env") || { echo "op read failed" >&2; exit 1; }
[ -n "$env_vars" ] || { echo "op read returned empty" >&2; exit 1; }
printf '%s\n' "$env_vars" | bun --env-file=/dev/stdin run <script>
```

`set -o pipefail` alone is not enough: the script has already run by the time the pipeline status
is checked.

## 2. Token Verification & Cloudflare Edge Services

### 2.1. Instant Verification (Bun, no curl)

Run this from the repo root; it prints the token status without shelling out to `curl`:

```bash
bun -e '
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) { console.error("CLOUDFLARE_API_TOKEN is unset"); process.exit(1); }
const res = await fetch("https://api.cloudflare.com/client/v4/accounts/7a470541a704caaf91e71efccc78fd36/tokens/verify", {
  headers: { authorization: `Bearer ${token}` },
});
console.log(res.status, JSON.stringify(await res.json()));
'
```

_Expected response:_

```json
{
  "result": { "id": "...", "status": "active" },
  "success": true,
  "errors": [],
  "messages": []
}
```

## 3. Cloudflare R2 Object Storage Integration

### 3.1. Public R2 Direct Access Gateway (`r2.dev`)

Your bucket has public bucket access enabled via the `r2.dev` subdomain:

- **Base Public URL:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev`

Any file uploaded to the bucket is instantly accessible via direct HTTPS:

- **Report Bundle Manifest:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/reports/<TIMESTAMP>/MANIFEST.md`
- **Intra-Day Snipers (24h):** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/reports/<TIMESTAMP>/01_winners_24h.txt`
- **Monthly Leaderboard:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/reports/<TIMESTAMP>/05_monthly_leaderboard.txt`

### 3.2. Syncing Reports & Audits via CLI

Manage your cloud backups directly through `sportsdesk_cli.ts` or `sportsdesk_r2_sync.ts`:

```bash
# 1. Check configuration and credentials
bun run sportsdesk_cli.ts r2 --info

# 2. Verify token active status
bun run sportsdesk_cli.ts r2 --verify

# 3. Sync entire reports/ directory to R2 (prints direct public links)
bun run sportsdesk_cli.ts r2 --sync reports/
```

### 3.3. Automated Archiving in Reporting Pipeline (`run_reports.sh`)

Add `--sync-r2` to your daily or weekly report generation:

```bash
# Generates all 7 reports and uploads to R2 with direct public links
./run_reports.sh --format table --sync-r2
```
