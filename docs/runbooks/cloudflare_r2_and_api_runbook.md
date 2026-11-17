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

### 3.4. Canonical R2 CAS Manifest Lineage & Verification (`STAGE_4_LEDGER_PUBLISH`)

Canonical `sportsdesk-ops-reports` sinks promote immutable chunk/generation blobs (`chunks/<sha256>.bin`, `generations/<sink_id>/gen-<u32>-<merkle16>`) followed by strict `If-None-Match: *` (on `generation_u32 === 1`) or `If-Match: "<prevETag>"` Compare-And-Swap (`0` rebases on HTTP `412` -> `ERR_R2_MANIFEST_CAS_REJECTED`, exit `74`). Transient chunk write and Merkle integrity faults (`ERR_R2_CHUNK_PUT_RETRY`, `ERR_R2_CHUNK_MERKLE_MISMATCH`) likewise exit `74` (`EX_IOERR`), while reconciliation drift (`BigInt(unresolved_gap_cents) !== 0n`) aborts pre-promotion with `ERR_OPS_RECONCILIATION_GAP` (exit `65`).

Execute live promotion and dual-clock verification in a clean subshell with `CLOUDFLARE_API_TOKEN` unset (preventing `ERR_CF_TOKEN_BLEED_10000`, exit `77`):

```bash
(
  set -euo pipefail
  unset CLOUDFLARE_API_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
  # source /path/to/r2.env
  SPORTSDESK_LIVE_INGEST=1 bun x sportsdesk r2 --sync --json
  bun x sportsdesk r2 --verify --json
  bun x sportsdesk stale --json
  bun x sportsdesk stale --json --include-bridges
  bun x sportsdesk-fraud cross-ref <customerA> <customerB> --json
)
```

Recorded `STAGE_4_LEDGER_PUBLISH` baseline (`sportsdesk-ops-reports`, observed `2026-11-17T21:11:06Z`, `circuit_state: "CLOSED"`, `unresolved_gap_cents: "0"`; `DOC-13` preserved untouched):

| Ledger Target                          | Canonical Manifest Key             | Gen | Strong ETag                          | Merkle Root SHA-256                                                |
| :------------------------------------- | :--------------------------------- | :-: | :----------------------------------- | :----------------------------------------------------------------- |
| `DOC-14` (`LIVE-01`) / `LIVE-KEEP-HUD` | `manifests/wagers-by-state/latest` | `2` | `"85d8da3a296d25ac823034cb7cf880de"` | `762d82a5191e06e2437b456e5fe6282434319fbe0e442ebdf49cc4e5a08de392` |
| `DOC-14` (`LIVE-01`) / `LIVE-KEEP-HUD` | `manifests/syndicate-rings/latest` | `1` | `"bccc9736b9e8b17d3f321f09f3b0699d"` | `b1128b66f0c6d8155b428b7112802f506f02783f78c75dca0ac2b6962f46da2d` |
| `DOC-16` (`LIVE-02`) / `LIVE-KEEP-HUD` | `manifests/ops-supervisor/latest`  | `1` | `"20725e1d57a7ee8212bdccbd5572dc6b"` | `ab2fba43fb87506793b448b0986170cd21420826c5698da456e9312ec1e2ded6` |
| `DOC-16` (`LIVE-02`) / `LIVE-KEEP-HUD` | `manifests/edge-topology/latest`   | `1` | `"9896acf3f47030389ffa5ef540e7e6ff"` | `0a64e1e196dfddb6c79c73774c043aa15bb5ba6283ae615bb70f6132f0ac216e` |
| Bridge (optional `--include-bridges`)  | `manifests/xml-ingest/latest`      |  —  | _on-demand_                          | —                                                                  |
| Bridge (optional `--include-bridges`)  | `manifests/f402-weblog/latest`     |  —  | _live hourly pointer_                | —                                                                  |
