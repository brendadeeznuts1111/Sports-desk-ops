# SportsDesk & Fantasy402 Operations Suite

Production intelligence, downline risk surveillance, 10-Mode Forensic/Risk/Cross-Market/Reconciliation engine, Cloudflare R2 edge portal, Qwen3.5-4B neuron token taxonomy, and automated reporting pipeline built on the **Bun runtime (v1.4.4)** for SportsDesk and Fantasy402 books.

Repository: [bw496915-cmyk/Sports-desk-ops](https://github.com/bw496915-cmyk/Sports-desk-ops)

## 🚀 Day-1 Operator Onboarding & 60-Second Triage Guide

If you are opening this repository for the first time or starting a desk shift, read the **[Operator Quickstart, Data Cleaning Pipeline & 10-Mode Action Runbook](docs/OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md)** and open the **[Live 6-Tab Surveillance, ROT Bet-Ticker & 10-Mode Forensic Portal (`graph.html`)](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/graph.html)**.

Always use **`./bin/dx`** as your primary entrypoint—it configures sandbox/host `$HOME/.gitconfig`, links your dotfiles checkout (`$DX_DOTFILES_DIR`, else `~/dotfiles`; never overwriting a real file), loads Cloudflare Pages credentials, and runs its tooling through Bun (`v1.4.4`). Run `./bin/dx help` for every command and `./bin/dx scripts` for the grouped `package.json` scripts:

```bash
# 1. Verify environment, Git config, staged dist/ assets, and live Cloudflare R2 gateway
./bin/dx status

# 2. Run the 10-Mode Forensic, Risk, Cross-Market & Data Integrity Matrix (all 10 modes or a single mode 1..10)
./bin/dx modes
./bin/dx modes 6    # Mode 6: Activity Overlap (Confirmed Session Overlap vs Nearby Point Events)
./bin/dx modes 9    # Mode 9: Pending Exposure (Stake vs Potential Payout vs Defined Liability)
./bin/dx modes 10   # Mode 10: Reconciliation (Report Totals vs Settled Tickets vs Ledger, Gap = $0.00)

# 3. Audit all 13 Per-Office (type="B" customerID=<Office>) & Cross-Office (customerID="0") IP-Tracker Clusters
./bin/dx iptracker

# 4. Run the 4-Week Full-Customer (9,435 accounts) CFB & NBA Parlay/Combo Backtest
./bin/dx backtest

# 5. Poll configured Polymarket wallets (23 valid), stage the 6-Tab Portal and publish to R2
#    Add SPORTSDESK_LIVE_INGEST=1 (Polymarket) and/or SPORTSDESK_LIVE_F402=1 (F402 probe)
SPORTSDESK_LIVE_INGEST=1 ./bin/dx deploy
```

**Operator tools:**

- `./bin/dx status` — measured, not asserted: git, R2 S3 and Pages credentials, and a 3-second HEAD probe of the R2 portal (`DX_STATUS_OFFLINE=1` skips the probe). Each line says what it checked.
- `./bin/dx setup [--replace]` — reports any real file (for example `~/.zshrc`) that `dx` declined to replace with a dotfiles symlink; `--replace` moves it to `<path>.dx-backup-<epoch>` and links.
- `./bin/dx scripts [substring]` — the 200+ `package.json` scripts grouped by prefix; a substring lists the matching commands.
- `./bin/dx gslive <LOGIN>` — GSLive Partner 118 links for one account: the 7-parameter `#/reports/users` deep link (`bot=true`, desk-day ISO window, `text=player_<LOGIN>`) and the `#/events/bet-history` sidecar (`calcTime` / `betTime`, epoch `from`/`to`, raw `partnerUserId`).
- `./bin/dx docs` / `./bin/dx docs gslive` — deployed docs portal URLs, or the GSLive surface section.
- `./bin/dx stale -i <export>` — stale-line cohort over a bet-log export (CSV/JSON/JSONL); seeds on operator stale notes or graded-then-cancelled tickets, then clusters other customers on the same market and window.
- `./bin/dx shot <url>` — Bun.WebView screenshot (webkit on macOS, chrome elsewhere); `--f402-login` captures the manager after an opt-in login. Output goes to `scratch/shots/`.
- `./bin/dx profile <0x|username>` — Polymarket address profile: PnL, win rate, open positions, category mix, activity summary and strategy pattern from public APIs.
- `./bin/dx combo legs|price|wallet|uniqueness` — CFB combo legs, product-of-legs pricing, wallet combo positions and per-game unique combo/wallet counts.
- `./bin/dx combo backtest` — realized combo PnL by day/game from public activity (open combos excluded).
- `./bin/dx bridge coverage|value|match` — cross-domain join between our customer book and Polymarket wallets: attribution health, fee-aware cross-venue PnL, and leg-level mirror/opposite matching.

## Schema registry & prod dump parity

- Operations: [docs/schema-dump-operations.md](docs/schema-dump-operations.md) (`schema:dump-prod`, `schema:sync-prod-dump`, fixture allowlist, `captured_at`)
- Failure modes: [docs/schema-sqlite-failure-mode-matrix.md](docs/schema-sqlite-failure-mode-matrix.md) (parity exit **2** / **3**, `bun:sqlite` strict + safe integers)
- CLI: `bun run schema --help` (sources in `cli/sportsdesk_schema_cli.ts`)
- CI gate: `bun run schema:gate` · lag metric: `bun run schema:dump-lag`
- After registry edits: `bun run schema:sync-prod-dump` then commit `tests/fixtures/prod-schema.json` (see [schema-dump-operations.md](docs/schema-dump-operations.md))
- Index: [docs/README.md](docs/README.md) · diagram: [docs/assets/ARCH-Guide.jpg](docs/assets/ARCH-Guide.jpg)

## Quick Start

```bash
git clone https://github.com/bw496915-cmyk/Sports-desk-ops.git
cd Sports-desk-ops

# Verify Bun 1.4.4, then install the locked dependencies
bun --version
bun install --frozen-lockfile

# 1. Inspect nominal branded types & domain invariants
bun run cli -b

# 2. Inspect Qwen3.5-4B (Layers 18-28) neuron token registry with TrueColor ANSI swatches
bun run cli -N

# 3. Verify design tokens, CIEDE2000 color distance, and WCAG contrast
bun test tests/verify_tokens.test.ts

# 4. Compile tokens across TypeScript, Webview, and TMA dashboards (Zero-Drift SSOT)
bun run gen:tokens

# 5. Run every test: tests/ (what CI runs) plus the suites colocated in lib/ and scripts/ (CI does not)
bun test

# 6. Run 24h sniper surveillance
bun run cli winners -p 24h --limit 25

# 7. Generate all 7 auditable surveillance reports
bun run reports -- --format table

# 8. Run 52-week bettor churn simulation
bun run sim
```

Repository lint uses exact-pinned Oxlint through Bun; stable Bun 1.4.4 does not
enable native `bun lint`. Run `bun run lint:check` for a read-only gate that
fails on warnings or errors, or `bun run lint` to apply safe fixes. CI runs lint
alongside token regeneration, the fetch/innerHTML gates, and the full tests.

Run `bun run format` to format the repository or `bun run format:check` for a
read-only check. `bunfig.toml` preserves the existing 80-column, two-space,
double-quote style with semicolons. Run `bun run typecheck` for Bun's native
strict, no-emit checker; `tsconfig.json` makes the previous inferred compiler
defaults explicit and includes the repository's source, tests, and declarations.
CI runs formatting and type checking before lint. Bun remains pinned to 1.4.4
in CI and declared in `package.json` (`packageManager` and `engines`), with
matching `@types/bun`; no Prettier or oxfmt package is required. These manifest
fields document the required version; CI explicitly selects it. The canonical
local checkout on this machine is `~/code/sportsdesk-ops`; the dotfiles symlink
is only a convenience pointer.

## Pinned Bun compatibility tests

Tests distinguish Fetch-spec requirements from behavior observed on Bun 1.4.4.
The pinned `Request` constructor retains GET/HEAD bodies and accepts spec-forbidden
methods. It also maps mixed-case `Delete` to `GET` and uppercases custom verbs.
These are compatibility differences, not application guarantees: use explicit
uppercase methods. `fetch` rejects nonempty GET/HEAD bodies before transmission.

String request bodies have no inferred Content-Type on this binary, and JSON
Blobs acquire `charset=utf-8`. Wire tests check explicit Content-Type headers
separately so application behavior does not depend on those inferences.

Subprocess fixtures await output writes and exit naturally while the parent
drains stdout and stderr concurrently. They assert complete byte content rather
than assuming unread pipes always deadlock or enforcing machine-speed thresholds.

## Runtime Architecture & Server Policies

### Server Port & Hostname Binding Policy

Server binding in `sportsdesk_webview_server.ts` adheres to Bun's native port resolution cascade:

1. `BUN_PORT`
2. `PORT`
3. `NODE_PORT`
4. Default fallback: `3000`

**SportsDesk Operational Policy**: Rather than overriding Bun's cascade in code, SportsDesk relies directly on native resolution. Production deployments configure `PORT=4020` inside `.env`, which Bun loads automatically at process initialization. When `startServer(options)` is called programmatically, `{ port, hostname, unix, development }` options allow explicit test or proxy overrides; when omitted, Bun resolves port and hostname natively (defaulting hostname to `0.0.0.0`).

### Static File Serving & Zero-Copy Policy

Static HTML surfaces under `static/` (`customer-churn-simulation-dashboard.html` and `telegram-miniapp-dashboard.html`) are served via native `new Response(Bun.file(path))` lazy handles.

- **Zero-Copy Specification & Boundary Conditions**: Official Bun runtime documentation specifies kernel zero-copy transfer (`sendfile(2)` on Linux, `copyfile` on macOS) specifically for outbound client file uploads (`fetch(url, { method: "POST", body: Bun.file(...) })`). This optimization activates exclusively under four strict preconditions:
  1. Payload size strictly exceeds 32 KB (under 32 KB, direct in-memory buffer reads outperform kernel syscall setup).
  2. Unencrypted HTTP transport (no TLS encryption).
  3. Direct TCP connection (no intermediate HTTP/HTTPS proxy).
  4. Uncompressed transmission (no gzip/brotli transfer encoding).
- **Server Response Path Distinction**: On the server response path (`new Response(Bun.file(path))`), Bun constructs a lazy file handle pointer in user space without eagerly reading file bytes into memory buffers. Handle allocation takes ~0.38 µs (compared to 45.9 µs for `readFileSync`). However, whether the subsequent socket transmission leverages `sendfile(2)` or `writev`/`pread` is unproven in Bun's published documentation. SportsDesk avoids conflating upload zero-copy claims with response streaming.
- **Nginx Reverse Proxy & Unix Domain Socket Offloading**: In production, Nginx terminates public TLS 1.3 at port 443 and proxies traffic to Bun over an unencrypted local Unix domain socket (`/run/sportsdesk/webview.sock`) or loopback HTTP (`127.0.0.1:4020`). This topology eliminates TLS encryption overhead and TCP port exposure on the host.

### Outbound Fetch Hardening & Network Isolation

Outbound network operations across Telegram alerts, Cloudflare R2 backup, and Fantasy402 feeds are hardened against proxy hijacking, hanging connections, and transport vulnerabilities:

- **Bounded Execution Windows (`AbortSignal.timeout`)**: All outbound requests enforce strict timeouts via `signal: AbortSignal.timeout(timeoutMs)` (e.g., 5,000 ms for Telegram dispatch, 10,000 ms for R2 verification). Unbounded `fetch` awaits are eliminated.
- **Loopback Proxy Isolation (`NO_PROXY` / `proxy: false`)**: Bun resolves `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` on a per-request basis (`ALL_PROXY` acts as scheme-agnostic fallback). Ambient corporate or CI proxies trap loopback calls unless bypassed. SportsDesk configures `NO_PROXY=127.0.0.1,localhost,::1` across `.env`, `.env.example`, and `deploy_to_vps.sh`. In addition, internal services pass `{ proxy: false }` for guaranteed direct socket connections, explicit proxy objects respect `NO_PROXY` by default (overridable via `respectNoProxy: false`), and tunnel failures reject with `ERR_PROXY_TUNNEL` (verified by `tests/fetch_proxy_isolation.test.ts`).
- **HTTP Connection Pool Bounds (`BUN_CONFIG_MAX_HTTP_REQUESTS`)**: Set to `256` to align Bun's shared connection pool with peak alert burst throughput, preventing resource starvation.
- **Dedicated `Bun.FetchSession` & Pre-Warming**: `SportsDeskTelegramService` initializes a dedicated `Bun.FetchSession` with `tls: { rejectUnauthorized: true }`, isolating session credentials and connection reuse. Outbound connections are pre-warmed at boot via `fetch.preconnect("https://api.telegram.org")` to eliminate initial TLS handshake latency.
- **Zero Embedded Credentials & Insecure TLS Protection**: Validated by `tests/fetch_url_credentials.test.ts`, ensuring 0 plaintext `http(s)://user:pass@` strings in source code and 0 occurrences of `rejectUnauthorized: false`.

### Environment Variable Precedence & Type Merging

Bun automatically loads environment files at startup in strict order of increasing precedence:

1. `.env` (base configuration)
2. `.env.production`, `.env.development`, `.env.test` (evaluated based on `NODE_ENV`)
3. `.env.local` (**Exception**: strictly skipped when `NODE_ENV=test` to ensure deterministic test isolation)
4. `.env.production.local`, `.env.development.local`, `.env.test.local` (mode-specific local overrides)

TypeScript declaration merging in `types/env.d.ts` extends both `Bun.Env` and `NodeJS.ProcessEnv` with strict typing for all SportsDesk credentials (`PORT`, `BUN_SOCKET`, `NO_PROXY`, `BUN_CONFIG_MAX_HTTP_REQUESTS`, `F402_*`, `CLOUDFLARE_*`, `R2_*`, `TELEGRAM_*`), verified via `tests/env_types.test-d.ts`.

### Security Headers & Telegram Mini App Embedding

To ensure seamless embedding inside Telegram Web (`https://web.telegram.org`), Telegram mobile apps, and desktop clients without frame hijacking vulnerabilities:

- `X-Frame-Options` is **strictly absent** from all server response headers (the deprecated `ALLOWALL` directive is never sent).
- Embedding is governed exclusively by modern standards: `Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;`.

## Performance Telemetry & Micro-Benchmarks

Empirical measurements on Bun v1.4.4 (macOS arm64). The first two rows are from `bun scripts/bench_server.ts` (2026-11-02, Apple M4; a single run, so treat the ratios as order-of-magnitude); the rest are from `tests/sendfile_threshold.test.ts`:

| Surface / Operation                                 | Manual Baseline Path                | Native Bun Path            | Measured Latency     | Throughput / Speedup             |
| :-------------------------------------------------- | :---------------------------------- | :------------------------- | :------------------- | :------------------------------- |
| **JSON Serialization** (25 accounts)                | `JSON.stringify` + headers          | `Response.json(data)`      | 1.22 µs vs 1.12 µs   | 1.09x faster                     |
| **Response Handle Construction** (154.1 KB payload) | eager `Bun.file().text()` + headers | `new Response(Bun.file())` | 196.68 µs vs 0.67 µs | 292x faster lazy handle creation |
| **Handle Construction Latency** (16 KB)             | Buffer allocation                   | `new Response(Bun.file())` | 0.49 µs/op           | Sub-microsecond lazy handle      |
| **Handle Construction Latency** (64 KB)             | Buffer allocation                   | `new Response(Bun.file())` | 0.47 µs/op           | Sub-microsecond lazy handle      |
| **Handle Construction Latency** (1 MB)              | Buffer allocation                   | `new Response(Bun.file())` | 0.21 µs/op           | Sub-microsecond lazy handle      |
| **End-to-End Socket Transfer** (16 KB payload)      | `fetch` socket transfer             | `new Response(Bun.file())` | 0.149 ms/req         | Direct loopback socket transfer  |
| **End-to-End Socket Transfer** (64 KB payload)      | `fetch` socket transfer             | `new Response(Bun.file())` | 0.191 ms/req         | Direct loopback socket transfer  |
| **End-to-End Socket Transfer** (1 MB payload)       | `fetch` socket transfer             | `new Response(Bun.file())` | 0.489 ms/req         | Direct loopback socket transfer  |

## Plane 3 — append-only ingestion JSONL replay

Self-healing replay for **`reports/ingestion-audit.jsonl`** (and any ASCII-field JSONL feed): `Bun.JSONL.parseChunk` on a streaming `Uint8Array` buffer, `Bun.XML.parse` for board prices, optional bitemporal `v_t` guard, and pattern flags (`SPIKE_UP`, `DOWN`, …) rendered with registry colors.

```bash
bun run replay -- --path /tmp/e.jsonl --markdown
bun sportsdesk_cli.ts replay --path reports/ingestion-audit.jsonl --json
```

**Bun.XML golden AST (Plane 1 pin / Plane 3 verify):** each row with `xml` may carry `xml_golden_ast_sha256` and `bun_version` (`sha256` of `Bun.JSON5.stringify(Bun.XML.parse(xml.trim(), { compact: false }))`). Replay verifies pins unless `--no-verify-xml-golden`; `--strict-xml-golden` requires a pin on every `xml` row. Exit precedence: corrupt **1** → tx **2** → SLA **3** → golden drift **4**. Backfill pins: `bun run ingestion:enrich-xml-golden -- in.jsonl [out.jsonl]`.

Implementation: `sportsdesk_ingestion_replay.ts`, `lib/bun_xml_golden_ast_replay.ts`, drain mirror `lib/jsonl_stream_replay.ts`, runbook §8.4 in `docs/runbooks/bun_server_runtime_shapes_runbook.md`.

## Qwen3.5-4B (Layers 18–28) Token Architecture & Single Source of Truth

The system uses `design/tokens.toml` as the authoritative **Single Source of Truth (SSOT)** for all 13 neuron tokens, dark surfaces, ingestion channels, and algorithmic routes:

- **Surface Tokens**: `--sd-surface-primary` (`#070b14`), `--sd-surface-card` (`#0b1329`).
- **Channel Ingestion Tokens (Axis 1)**:
  - `L18.N0204` (`#1d84b5`, Internet Retail Baseline, 1,500 ms SLA)
  - `L19.N0518` (`#64748b`, Blocked Sentinel Filter, `{ kind: 'sentinel_drop' }` policy)
  - `L20.N1105` (`#10b981`, Gateway Equilibrium & Vig Gate, 1,000 ms SLA)
  - `L21.N0884` (`#ef4444`, Alert Twin Syndicate Mirror, 250 ms SLA)
  - `L22.N1402` (`#f59e0b`, Builder Steam / Line Chase, 1,000 ms SLA) — _Single-owner Amber-500_
  - `L23.N0412` (`#28a745`, Live In-Play Whale Anomaly, 500 ms SLA)
  - `L24.N2019` (`#38bdf8`, CSLevel2 Recreational Longshot Bias, 2,000 ms SLA)
- **Algorithmic Route Tokens (Axis 2)**:
  - `L25.N1882` (`#06b6d4`, Route 02 Adverse Selection Devig Expansion)
  - `L26.N3104` (`#a855f7`, Route 03 CLV Margin Decay Sharp Shrinkage)
  - `L27.N0912` (`#d97706`, Route 01 Liquidity Exhaustion Breaker) — _Dedicated Amber-600_
  - `L28.N2501` (`#f43f5e`, Route 04 Terminal Risk Mitigation Limit Clamp)

### Decoupled Discriminated Union Typing

All channel transport SLAs and route thresholds are modeled with strict discriminated unions rather than overloaded primitive numbers or polymorphic strings:

```typescript
// Axis 1: Transport SLA Contract
export type TransportSla =
  | { readonly kind: "latency"; readonly latencySlaMs: number }
  | { readonly kind: "sentinel_drop" };

// Axis 2: Algorithmic Route Threshold Contract
export type RouteThreshold =
  | { readonly kind: "consensus_lag"; readonly maxConsensusLagMs: number }
  | { readonly kind: "bayes_shrinkage"; readonly tauStar: number; readonly minTicketCount: number }
  | { readonly kind: "liquidity_depth"; readonly minTopDepthCents: Cents }
  | { readonly kind: "composite_risk_gate"; readonly minToxicityScore: number; readonly maxHoldPercentage: number; readonly maxDeficitCents: Cents };

// Nominal Enum Enforcements
export enum TriggerPredicateKind { ... }
export enum MitigationActionKind { ... }
```

## Verification & CI Quality Gates

All tokens and contracts are verified continuously through `lib/validation/token_validator.ts` and `tests/`:

1. **Zero Drift**: `bun run gen:tokens:gate` (CI step) resets generated outputs, regens from `design/tokens.toml`, and fails on drift for `design/domain-branded-types.ts` and the two dashboards under `static/`.
2. **24-bit Exact Uniqueness**: 13 unique `ColorHexInt` values derived from `Bun.color()`.
3. **CIEDE2000 Perceptual Separation ($\Delta E\_{00} \ge 7.0$)**: Mathematically verified color distance floor across all token pairs, preventing indistinguishable UI swatches.
4. **WCAG 2.1 Contrast Standards**: $\ge 3.0:1$ for graphical UI badges against dark surfaces (`#070b14` / `#0b1329`) and $\ge 4.5:1$ for typography.
5. **Zero Dead Tokens**: Asserts bidirectional reference consistency (all declared tokens used, all used tokens declared).

### Test Suite Classification

The suite is grouped by what it verifies. Assertion counts drift with every edit, so the numbers
here are not pinned; the authoritative counts are what CI's `bun test` reports (last full local run
2026-11-04: 2,763 passed, 49 skipped, 2,812 tests across 320 files).

- **Token verification** (`tests/verify_tokens.test.ts`): zero-drift regeneration from
  `design/tokens.toml`, 24-bit colour uniqueness, CIEDE2000 perceptual separation, WCAG 2.1
  contrast, dead-token/bi-directional reference consistency, discriminated-union guardrails, and
  the generative property tests `test_property_ciede2000_metric_axioms` and
  `test_property_wcag_contrast_ratio_bounds`.
- **Server runtime & network hardening**: `tests/sendfile_threshold.test.ts` (lazy handle
  construction vs end-to-end socket throughput at 16 KB / 64 KB / 1 MB),
  `tests/server_headers.test.ts` (no `X-Frame-Options`; Telegram `frame-ancestors` present),
  `tests/server_error.test.ts` (non-Error throws become structured 500 JSON without stack traces),
  `tests/fetch_proxy_isolation.test.ts` (`NO_PROXY`, `{ proxy: false }`, `respectNoProxy`),
  `tests/fetch_timeout.test.ts` (`AbortSignal.timeout`), `tests/bench_server.test.ts`
  (`Response.json` vs `JSON.stringify` equivalence, lazy `Bun.file` bodies),
  `tests/fetch_url_credentials.test.ts` (no embedded URL credentials, no
  `rejectUnauthorized: false`), `tests/server_port.test.ts` (`BUN_PORT=4100` cascade), and
  `tests/env_types.test.ts` / `tests/env_types.test-d.ts` (Bun.env typing).

## Project Structure

See **[ROOT_LAYOUT.md](ROOT_LAYOUT.md)** for the full map. At a glance:

```
├── cli/              # sportsdesk_* CLIs (bun run cli, schema, replay, …)
├── services/         # webview daemon, Telegram bot, R2, churn engine, ingestion
├── catalog/          # Fantasy402 sport navigation catalog
├── lib/              # shared modules, F402 capture, schema SSOT
├── scripts/          # generators & capture; scripts/deploy/ for VPS/docs/reports
├── static/           # token-compiled daemon HTML
├── docs/             # API evidence portal; docs/runbooks/ for long-form ops guides
├── tests/            # bun test suites
├── bin/dx            # operator entrypoint
├── design/           # tokens.toml + domain-branded-types.ts (gen:tokens)
├── schema/           # migrations, manifest.bin, schema preload
├── infra/            # Cloudflare Pages _headers
└── types/env.d.ts
```

## Documentation Runbooks

See [docs/runbooks/README.md](docs/runbooks/README.md) for the full index. Highlights:

- [Bun Server Runtime Shapes Runbook](docs/runbooks/bun_server_runtime_shapes_runbook.md) — `Server extends Disposable`, `WebSocketHandler<T>`, and `TLSOptions`.
- [Token Architecture & Verification Runbook](docs/runbooks/token_architecture_and_verification_runbook.md) — CIEDE2000, WCAG contrast, and token code generation.
- [Cloudflare R2 & API Runbook](docs/runbooks/cloudflare_r2_and_api_runbook.md) — Cloudflare API & R2 storage guide.
- [Operational Guardrails Runbook](docs/runbooks/operational_guardrails_runbook.md) — Manager wire evidence and capture guardrails.
- [OS Bun Cron Integration Guide](docs/runbooks/os_bun_cron_integration_guide.md) — OS crontab and systemd timer integration.
- [VPS Domain Setup Runbook](docs/runbooks/vps_domain_setup_runbook.md) — Production VPS deployment guide.
- [GSLive report surfaces](docs/report-surfaces.md) — Operator map of the `#/reports/users` deep link and the `#/events/bet-history` sidecar, with an evidence level per surface.
- [Real ingestion](docs/REAL_INGESTION.md) — Phase 4: live Polymarket positions (`--live`), provenance and stale-cache rules, and the F402 session plan.
