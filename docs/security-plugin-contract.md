# SportsDesk security/fraud plugin v1 — frozen contract (rev 3)

Owner: Lead. Freeze for `fraud-core` (lib + CLI + tests) and `fraud-ui` (Client half).
Bundle: `dsh-plugin-security/` (package `dsh-plugin-sportsdesk-security`). Host half is Lead-owned.
Tool namespace: `fraud_*` (the name `sportsdesk_security` is ALREADY TAKEN by the existing
secrets/captures/identifiers scanner in `dsh-plugin/index.js:6137` — do not collide).

## Why

The desk has two real log corpora (GSLive `getBetReport` rows incl. IP addresses; F402 live
ticket captures), repo modules for GSLive bet-event parsing/weblog activity/surveillance
predicates, but nothing that joins them into one security surface or learns from them. This
plugin is the read-only security console: normalizes the log artifacts, runs named sportsbook
fraud/surveillance detectors, and fits a transparent weak-label risk model whose limits are
reported, not hidden. No live betting, no order path, no credentials outside the declared
`networked_commands` exception (rev 3), no artifact mutation.

## Measured data reality (recon 2026-11-04T19:49Z; measured, not assumed)

| Source id                | Artifact                                                                                                                                         | Provenance                                                                     | State now                                                                                                            |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| `gslive_bet_report`      | `Scratch/security/corpus/gslive-betreport-all-2026-11-03.json` (backup, sha256 `8afe7684…52acb`, 55,600,957 B) then `Scratch/betReport-all.json` | live GSLive export, **untracked/unmanifested/ephemeral**                       | present: 24,778 rows, 69 fields, window 2026-10-28T05:00Z→2026-11-04T05:59:59Z; 2,586 userIDs, 448 agents, 5,614 IPs |
| `gslive_wagers_by_state` | `Scratch/gslive-wagers-by-state.summary.json` + `.csv`                                                                                           | GSLive export, derived summary                                                 | present: 18,086 CSV rows, no IP                                                                                      |
| `f402_live_bets`         | `data/live-bets.json`                                                                                                                            | live-api snapshot (Pending)                                                    | present/fresh at measure; 250 games                                                                                  |
| `f402_live_wagers`       | `data/live-wagers.json`                                                                                                                          | live-api snapshot (getBetTicker)                                               | present/fresh; 300 rows, `partial:true`                                                                              |
| `f402_weblog_rollup`     | `Scratch/weblog/rollup-YYYY-MM-DD.json`                                                                                                          | api-log-rollup over 523,632 rows → zero-PII aggregate                          | 2 files present; **corpus behind it MISSING**                                                                        |
| `gslive_weblogs`         | `Scratch/gslive-weblogs/latest.json` (reader `lib/gslive_weblog_activity.ts:28-29,662`)                                                          | api-log-rollup of sampled getBetLog/getEventLog                                | **MISSING**; session expired (HTTP 401), operator re-auth needed                                                     |
| `gslive_suspect_audit`   | `reports/gslive-suspect-all-states-audit.json`                                                                                                   | derived                                                                        | present; `targetAccount:"--help"` arg defect — say so, do not present its account numbers as observations            |
| `f402_weblog_capture`    | `docs/evidence/captures/2026-10-31/getWebLog.post.json`                                                                                          | shape sample                                                                   | `responseBytes: 21`, empty `LIST`: **raw rows MISSING (not zero rows)**                                              |
| `customer_book`          | `enriched_customers_full.json`                                                                                                                   | **generated fixture** (6 provenance features, `sportsdesk_customer` integrity) | present, 220 customers; gitignored                                                                                   |
| `agent_index`            | `data/agent-index.json`, `data/agent-tree.json`                                                                                                  | derived from downline capture                                                  | present                                                                                                              |
| `ip_tracker_clusters`    | `lib/bet_ticker_ip_tracker_bridge.ts`                                                                                                            | **hardcoded fixture**                                                          | present                                                                                                              |
| `weblog_fixture`         | `tests/fixtures/captures/getWebLog.mock.json`                                                                                                    | shape sample                                                                   | present                                                                                                              |

Rules from this table:

- Every answer carries per-source `exists`, age, `stale`, `provenance`, `sha256` when known and a
  `note`. MISSING ≠ 0; fixture ≠ observation; an ephemeral unmanifested corpus is flagged
  `ephemeral: true` in its note.
- `customer_book`, `ip_tracker_clusters` are NEVER used to fit the model. They may be shown as
  context with `provenance: "fixture"` and an explicit note.
- **PII posture: no raw IP address is ever printed.** IPs are masked (`47.223.36.100` →
  `47.223.***.***`) with a stable short sha256 tag and a /24 prefix for clustering; an account is
  referenced by the desk's own id (numeric GSLive userID or F402 login) because the operator needs
  it to open a dossier — it is never emitted paired with a raw IP. No cookies/tokens at all.
- `gslive_bet_report` rows contain `fVal`/`fVal_new` (odds drift), `delay`, `accept`, `state`,
  `ipAddress`, `isSuspectedBot`, `reversedCredit`, `manualLogExists`, `logTime`, `bet`, `toWin`,
  `line`, `period`, `eID`/`lID`/`sID`, `result`. Weak labels available: `isSuspectedBot` ≠ 0 (70
  rows), `reversedCredit` set (733), `manualLogExists` ≠ 0 (153); `fVal≠fVal_new` 4,339.
- Corpuses too large to load naively must be stream-parsed (55 MB JSON; reuse the bounded-read
  patterns of `lib/gslive_tally_rollup.ts` where practical). One CLI call may parse it once.

## Module boundaries (new files only; never edit existing modules)

| File                                             | Owner      | Responsibility                                                                                                                                           |
| :----------------------------------------------- | :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/fraud_logs.ts`                              | fraud-core | Source discovery, provenance/sha256/freshness, stream-parse of the bet-report corpus, normalization into canonical bet/ticket/IP records, weblog posture |
| `lib/fraud_patterns.ts`                          | fraud-core | Named detectors → `FraudFinding[]` (severity, evidence, masked identifiers)                                                                              |
| `lib/fraud_model.ts`                             | fraud-core | Feature extraction (leakage-safe), weak-label logistic fit, scoring, validation, artifact read/write                                                     |
| `config/fraud-model.json`                        | fraud-core | Frozen feature registry, corpus paths/globs, detector defaults, model hyperparameters (committed; no fitted weights)                                     |
| `config/fraud-research.json`                     | Lead       | Prior-art/terminology/threshold-provenance catalog (from research briefs)                                                                                |
| `cli/sportsdesk_fraud_cli.ts`                    | fraud-core | The one implementation; `--json` always exactly one object                                                                                               |
| `dsh-plugin-security/index.js` etc.              | Lead       | Host tools + Host GET routes, shells the CLI                                                                                                             |
| `dsh-plugin-security/client.js`, `locale/*.json` | fraud-ui   | Operator page                                                                                                                                            |

## Canonical records (freeze names/fields)

```ts
type Provenance =
  "live-api" | "api-log-rollup" | "derived" | "fixture" | "missing";
interface FraudSourceState {
  id:
    | "gslive_bet_report"
    | "gslive_wagers_by_state"
    | "f402_live_bets"
    | "f402_live_wagers"
    | "f402_weblog_rollup"
    | "gslive_weblogs"
    | "gslive_suspect_audit"
    | "f402_weblog_capture"
    | "customer_book"
    | "agent_index"
    | "ip_tracker_clusters";
  label: string;
  path: string;
  exists: boolean;
  bytes: number | null;
  mtimeIso: string | null;
  ageSeconds: number | null;
  stale: boolean;
  provenance: Provenance;
  records: number | null;
  sha256: string | null;
  state: "ok" | "stale" | "missing" | "session_expired" | "unreadable";
  note: string;
  reason: string | null;
}

interface BetRecord {
  // one getBetReport row, normalized
  betId: string;
  userId: string;
  agentId: string | null;
  placedAtMs: number | null;
  acceptedAtMs: number | null;
  delaySec: number | null;
  acceptSec: number | null;
  stateCode: number | null;
  oddsPlaced: number | null;
  oddsAccepted: number | null;
  oddsDrift: number | null;
  stakeCents: number | null;
  toWinCents: number | null;
  lineHundredths: number | null;
  sportId: string | null;
  eventId: string | null;
  period: number | null;
  resultCode: string | null;
  ipMasked: string | null;
  ipTag: string | null;
  ipPrefix24: string | null;
  suspectedBot: boolean;
  reversedCredit: boolean;
  manualLog: boolean;
  adminUser: string | null;
}

interface TicketEvent {
  /* F402 live tickets — same as watchlist vocabulary */
}
interface WeblogPosture {
  /* f402 rollup: rows/sessions/join/flags/ipClasses/gates */
}
interface IpCluster {
  key: string; // "ip:<hash8>" | "prefix24:<a.b.c>" | "prefix64:<v6prefix>"
  masked: string;
  accounts: number;
  bets: number;
  sampleAccounts: string[]; // first N logins/userIds
  sharedIp: boolean;
  botRingRange: boolean;
  datacenterClass: string | null;
}

interface FraudFinding {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    | "courtsiding"
    | "multi_accounting"
    | "line_shopping"
    | "match_integrity"
    | "agent_scheme"
    | "ticket_anomaly"
    | "ip_network"
    | "data_quality";
  subject: { kind: "account" | "agent" | "book" | "source"; id: string };
  observed: Record<string, number | string | boolean | null>;
  threshold: Record<string, number | string> | null;
  evidence: { source: string; path: string; pointer: string }[];
  provenance: Provenance[];
  explanation: string;
  insufficientData: boolean;
}
```

## CLI contract (`cli/sportsdesk_fraud_cli.ts`)

- one command per invocation from the surface declared below: the offline `roster` plus the
  declared `networked_commands` exception (rev 3).
- global flags anywhere: `--root/-r`, `--json/-j`, `--now/-n <iso>`, `--help/-h`; closed flag
  specs (unknown flag = exit 2); mirror `cli/watchlist_autobet_cli.ts` argument parsing.
- `--json` stdout is exactly one object; diagnostics on stderr. For `roster` commands: 0 ok,
  2 usage, 3 refusal (`insufficient_corpus`, `model_missing`, `unknown_subject`, `source_missing`),
  else 1. A `networked_commands` entry uses the exit classes in its block (65 data/reconciliation,
  70 integrity, 74 CAS/I/O, 77 token isolation, 78 config); those classes are derived from the
  implementation and must not be renumbered without a rev bump.
- success envelope `{ success: true, schemaVersion: 1, command, generatedAt, ...payload }`;
  failure `{ success: false, schemaVersion: 1, command, error: { code, message, details? } }`.
  This applies to every command, including `networked_commands`; a command that omits `success` or
  `generatedAt` is non-conformant.
- commands:
  - `status` → `{ sources: FraudSourceState[], sourceMatrix: CompactSourceState[], corpus: { rows, accounts, agents, window, sha256 } | null, model: ModelState, nextStep }`
    - `sources[]` is the full evidence row per log source, canonical order (`FRAUD_SOURCE_IDS`).
    - `sourceMatrix[]` is the same roster compacted to one row per source: `{ id, label, exists,
state, provenance, ageSeconds, stale, records, note, reason }` (no path/bytes/mtime/sha256).
      A source that was not counted keeps `records: null`; a missing source carries `reason` and
      `provenance: "missing"`. The plugin's `fraud_status` returns the CLI payload unchanged, so
      the matrix reaches the tool answer without a wrapper field.
    - without `--json`, `status` prints a human report whose table has one aligned row per source
      (ID / STATE / PROVENANCE / RECORDS / AGE / NOTE-OR-REASON), then corpus/model/integrity/
      settlement/next step. `--json` stays the single-object machine contract.
  - `bets` → `{ filters, aggregate: { rows, accounts, agents, states, suspectedBot, reversedCredit, manualLog, oddsDrift, delayHistogram }, sample: BetRecord[] (masked, capped), sources }`
    flags: `--agent`, `--account`, `--state <code>`, `--since <iso>`, `--limit <1-200>` (default 25),
    `--include-bots <bool>` (default true); never returns all 24,778 rows.
  - `ip-graph` → `{ clusters: IpCluster[], summary: { distinctIps, sharedIps, accountsMultiIp, maxAccountsPerIp }, sources }`
    flags: `--min-accounts <n>` (default 2), `--limit <1-100>`, `--prefix24 <a.b.c>`.
  - `weblog` → `{ posture: WeblogPosture | null, flags: [...], gates, insufficientReason, sources }`
  - `patterns` → `{ findings: FraudFinding[], counts: { bySeverity, byCategory }, insufficient: string[], sources }`
    flags `--min-severity low|medium|high|critical` (default info), `--category`, `--agent`, `--limit`.
  - `model` subcommands: `report` (default) | `fit` | `score <accountId>`
    - `report` → `{ present, path, fittedAt, spec, features: [{id,label,kind,weight,stats}], metrics, validation, limits, corpusProvenance, sources }`
    - `fit` → dry-run prints candidate artifact + metrics; writes only with `--write` (atomic tmp+rename
      to `reports/security/fraud-model.json`, mkdir -p, 0600). Refuses `insufficient_corpus`
      (<500 rows or <20 accounts with the proxy label) with measured counts.
      flags `--write`, `--split <0.5-0.9>` (default 0.7 temporal), `--l2 <0-1>` (default 0.01),
      `--epochs <100-5000>` (default 4000; converges at 1250 on the 2026-11-04 corpus), `--proxy desk_flag|suspected_bot|reversed_credit` (default desk_flag)
    - `score <accountId>` → per-account features, score 0-100, band `low|medium|high|critical`,
      top contributions, findings, provenance; refusal `unknown_subject`.
  - `dossier <accountId|agentId>` → hierarchy (agent-index), bet aggregates, findings, model score,
    masked IP clusters, evidence pointers, source freshness; refusal `unknown_subject`.
  - `research` → `{ catalog: config/fraud-research.json, modelLimits: [...] }`
- no command outside `networked_commands` reads secrets/network/keychain, prints cookies/tokens,
  mutates captured artifacts, or emits a raw IP/userID pair. A declared networked command may read
  exactly its declared `env`, `network.destination` and `reads`; it must not write, and it must
  still never print tokens or emit a raw IP/userID pair. `fit --write` is the only write and only
  under `reports/security/`.
- every command prints source states in its envelope (the UI's honesty floor).

### Command surface (machine-readable, rev 3)

This block is the contract for the CLI surface. A conformance test parses it and fails when the
command table, a secret/network use, or the envelope disagrees with it.

```yaml
command_surface:
  roster:
    - status
    - bets
    - queue
    - ip-graph
    - weblog
    - patterns
    - explore
    - model
    - dossier
    - research
  networked_commands:
    cross-ref:
      summary: "Live R2-backed columnar pairwise customer wager cross-reference"
      # Source path (not the packages/sportsdesk-ops/bin shim) — the gate scans this file.
      implementation: packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts
      aliases: [pairwise-cross-ref]
      env:
        required: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]
        optional:
          - R2_BUCKET_NAME
          - R2_ENDPOINT
          - CLOUDFLARE_ACCOUNT_ID
          # Read only by the token-bleed preflight; both set → exit 77.
          - CLOUDFLARE_R2_API_TOKEN
          - CLOUDFLARE_API_TOKEN
      reads_secrets: true
      network:
        transport: "Bun.S3Client"
        destination: "r2:sportsdesk-ops-reports"
      reads:
        - manifests/wagers-by-state/latest
        - manifests/syndicate-rings/latest
        - "chunks/<merkle_root_sha256>.bin"
      writes: []
      envelope:
        success: true
        # Stays 1: success/generatedAt are additive, no consumer pins exact keys, and the
        # shared failure envelope remains 1. Bump to 2 only on a breaking shape change.
        schemaVersion: 1
        generatedAt: true
      # Derived from the implementation; do not renumber without a rev bump.
      # 65: ERR_CF_R2_CREDENTIALS_MISSING, ERR_OPS_RECONCILIATION_GAP,
      #     ERR_R2_SINK_BACKPRESSURE, ERR_SOA_BINARY_*
      # 70: ERR_BRIDGE_CHANNEL_CONTAMINATION
      # 74: ERR_R2_MANIFEST_CAS_REJECTED, ERR_R2_CHUNK_*
      # 77: ERR_CF_TOKEN_BLEED_10000 (registered in
      #     src/telemetry/skill-error-frame.ts PREFLIGHT_ERROR_SPECS)
      # 78: ERR_DOD_LEGACY_FALLBACK_REMOVED, ERR_OPS_LOCAL_JSON_FORBIDDEN (config, not storage)
      exit_codes:
        usage: 2
        refusal: 3
        data_or_reconciliation: 65
        integrity: 70
        cas_or_io: 74
        permission: 77
        config: 78
```

Conformance gate (required in `verify-changed`):

- `HELP_COMMANDS ⊆ roster ∪ networked_commands`.
- A command outside `networked_commands` that constructs `Bun.S3Client`/`R2S3Client`, reads a
  declared secret env name, or imports `R2S3Client` fails.
- Every `networked_commands` entry declares `env`, `reads_secrets`, `network`, `reads`, `writes`,
  `envelope` and `exit_codes`; a missing field fails.
- The command must emit the declared envelope fields.
- `networked_commands` are CLI-only in v1: no Host tool and no UI surface may invoke them.
- Declared but not enforced by this gate (v2): the Host tool/UI restriction. The gate covers the
  CLI surface and source files only.

## Detector catalog v1 (ids are API)

From `gslive_bet_report` (row count is whatever the loaded corpus carries; the status output reports it):
`SUSPECTED_BOT_BET`, `REVERSED_CREDIT_BET`, `MANUAL_LOG_BET`, `ODDS_DRIFT_BET`,
`DELAY_MISMATCH_BET` (reuse `classifyDelayElapsedSec`), `STATE_MIX_ANOMALY`,
`SHARED_IP_CLUSTER`, `ACCOUNT_IP_FANOUT`, `BOT_RING_IP_RANGE` (140.248.0.0/16),
`DATACENTER_IP_CLASS`, `AGENT_FLAG_CONCENTRATION`, `SYNC_CO_PLACEMENT` (account pairs
co-placing within 10 s on >= 3 independent events; the finding reports its own `pairCounts`
histogram for the corpus it ran on, so the single-event base rate is derived, never recorded here).
From `f402_weblog_rollup`: `EXECUTION_SNIPERS`, `SNIPER_TWINS`, `LINE_SHOPPERS`,
`BOT_RING_ACCOUNTS`, `CROSS_OFFICE_BEARDS`, `IP_CLASS_ANOMALY`, `WEBLOG_GATE_FAIL`
(counts only — account attribution is unavailable from a rollup; `insufficientData` where needed).
From GSLive weblog activity (when present): `STEAM_15S_5S`, `CLINCH_AT_PLACEMENT`,
`CONFIRM_BYPASS`, `DONOR_SHIELD`, `TROJAN_HORSE`, `MANUAL_ADMIN_INTERVENTION` — map the repo
predicates/constants, do not re-derive thresholds.
From F402 live tickets: `ROUND_STAKE_LADDER`, `LONGSHOT_CONCENTRATION`,
`WRITER_AGENT_MISMATCH`, `TICKET_BURST`, `AGENT_CONCENTRATION`, `VIP_STAKE_OUTLIER`.
Data quality: `SOURCE_STALE`, `SOURCE_EPHEMERAL` (unmanifested corpus), `SUSPECT_AUDIT_DEFECT`
(the `--help` target defect), `EVIDENCE_ROWS_MISSING` (empty getWebLog capture).

## Model spec v1 (honest by construction)

- **What it is**: a transparent weak-label logistic risk ranker over GSLive bet rows plus an
  account-level robust anomaly score. It predicts a _desk flag proxy_, not fraud. The output must
  never say "probability of fraud".
- Proxy label `desk_flag` (default) = `isSuspectedBot≠0 OR reversedCredit set OR manualLogExists≠0`.
  `--proxy suspected_bot` / `reversed_credit` fit narrower proxies. Report label support counts.
- Leakage rule: every "prior/history" feature for row i is computed only from rows with
  `logTime < logTime_i` (streaming prefix); tests must assert a later row cannot change an
  earlier row's features.
- Features (frozen ids in `config/fraud-model.json`): bet-level `delay_sec`, `accept_sec`,
  `odds_drift`, `implied_prob`, `stake_usd`, `to_win_usd`, `line_hundredths`, `period`,
  `state_code`, `hour_of_day`, `day_of_week`, `result_code`, account history
  `acct_prior_bets`, `acct_prior_stake_mean`, `acct_prior_drift_rate`, `acct_prior_reversal_rate`,
  `acct_prior_bot_rate`, IP features `ip_prior_accounts`, `ip_prior_bets`, `ip_prefix24_accounts`,
  `acct_prior_ip_count`, `ip_bot_ring_range`, `ip_datacenter`, agent history
  `agent_prior_bets`, `agent_prior_drift_rate`, `agent_prior_bot_rate`.
- Fit: standardization from train split; L2 logistic regression, class weights to balance,
  full-batch gradient descent with fixed seed/initialisation (deterministic), temporal split by
  `logTime` (default 0.7/0.3). Never shuffle across the split boundary.
- Metrics (reported every time): AUC-ROC, average precision (PR-AUC), precision@1%@5%,
  Brier score, calibration bins, label support, train window, holdout window.
- Validation: temporal holdout metrics; stability = first/second half of holdout AUC; drift =
  per-feature train-vs-holdout standardized mean shift; `limits` list must include "proxy label,
  not observed fraud", "live snapshot, not longitudinal", "fixture sources excluded",
  "no account↔login bridge (betReport userID ≠ ticker Login)".
- Score mapping: train-CDF percentile → 0-100; bands from `config/fraud-model.json`
  (low <50, medium 50-74, high 75-89, critical ≥90, configurable).
- Artifact: `reports/security/fraud-model.json` (gitignored) with `schemaVersion`,
  `fittedAt`, `corpusSha256`, `corpusRows`, `split`, `features[].stats`, `weights`,
  `intercept`, `metrics`, `validation`, `provenance`. `report` without artifact → `model_missing`
  refusal with the exact `model fit --write` command.

## Host half (Lead)

Tools (all shell `bun run cli/sportsdesk_fraud_cli.ts … --json --root <repoPath>`):
`fraud_status`, `fraud_bets`, `fraud_queue`, `fraud_ip_graph`, `fraud_weblog`, `fraud_patterns`,
`fraud_explore`, `fraud_model` (actions report/fit/score; `fit` requires exactly `confirm: true`),
`fraud_dossier`, `fraud_research`. Read tools return the CLI payload unchanged on success;
failure → `{ available: false, reason: <CLI code>, message, command, cli }`. `fraud_status`'s
description names every source id in canonical order and states the `sources[]` + `sourceMatrix`
one-row-per-source contract (a missing source reports its reason; a null record count is not
counted, never 0).

No Host tool invokes a `networked_commands` entry; `cross-ref` is CLI-only in v1 (declared, not
gate-enforced — see the conformance gate note).

Host GET routes (GET only, same-origin, `no-store`, 4 s CLI timeout):
`/api/security/status`, `/api/security/bets`, `/api/security/ip-graph`,
`/api/security/weblog`, `/api/security/patterns`, `/api/security/model`,
`/api/security/dossier?id=`, `/api/security/research`.
200 body = `{ ok: true, ...cliBody }`; CLI failure → 502 `{ ok: false, reason, message }`.

## Client half (fraud-ui)

- Sidebar entry id `sportsdesk-security`, main key `sportsdesk-security`, locale title/description.
- Tabs: **Overview** (Sources table: exactly one row per log source — Source / State /
  Provenance / Records / Age / Note; a non-ok source renders its reason visibly, `records: null`
  renders "not counted", never 0; corpus summary, weblog posture flags, model summary + limits),
  **IP graph** (clusters, masked ids),
  **Findings** (severity/category filters, evidence, insufficient-data chips),
  **Model** (features, metrics incl. AUC/AP, validation, limits, why-no-fit states),
  **Dossier** (id input → score/band, contributions, bet aggregates, findings).
- Honesty: missing source = "missing" + reason, never 0; fixture = fixture chip; model copy says
  "proxy label — not fraud probability"; synthetic numbers only if labelled; failed fetch shows
  reason + Retry and keeps the last payload labelled stale; no fake zeros.
- Styling: theme tokens only (`--dsw-alias-*`), classes prefixed `sec-`, locale through the
  locale service in BOTH en.json + zh.json identical keys, no `@deepseek-ai` imports, no
  innerHTML/dangerouslySetInnerHTML, no window.confirm/alert/prompt, no document.body writes.
- Read-only: no mutation buttons. `fit` is not offered in the UI v1.

## Write scopes

- fraud-core: `lib/fraud_logs.ts`, `lib/fraud_patterns.ts`, `lib/fraud_model.ts`,
  `cli/sportsdesk_fraud_cli.ts`, `config/fraud-model.json`, `tests/fraud_*.test.ts`,
  `tests/fixtures/fraud/`.
- fraud-ui: `dsh-plugin-security/client.js`, `dsh-plugin-security/locale/en.json`,
  `dsh-plugin-security/locale/zh.json`.
- Lead: `dsh-plugin-security/index.js`, `package.json`, `cordis.patch.yml`, `icon.svg`,
  `README.md`, `verify-load.mjs`, `config/fraud-research.json`, corpus backup, install/verify/commit.
- Do not edit existing lib/cli/plugin files, `docs/`, `data/`, or another owner's files.

## Verification

fraud-core:

```sh
bun run typecheck
bun test tests/fraud_logs.test.ts tests/fraud_patterns.test.ts tests/fraud_model.test.ts \
  tests/fraud_cli.test.ts
bun fmt --check lib/fraud_logs.ts lib/fraud_patterns.ts lib/fraud_model.ts \
  cli/sportsdesk_fraud_cli.ts config/fraud-model.json
bun --bun run oxlint --deny-warnings lib/fraud_logs.ts lib/fraud_patterns.ts \
  lib/fraud_model.ts cli/sportsdesk_fraud_cli.ts
bun run cli/sportsdesk_fraud_cli.ts status --json
bun run cli/sportsdesk_fraud_cli.ts patterns --json
bun run cli/sportsdesk_fraud_cli.ts model fit --json   # dry-run; do not --write without Lead
```

fraud-ui:

```sh
node --check dsh-plugin-security/client.js
bun fmt --check dsh-plugin-security/client.js dsh-plugin-security/locale/*.json
bun --bun run oxlint --deny-warnings dsh-plugin-security/client.js
```

Acceptance: all commands exit 0 (or documented refusal), every answer carries source states and
masked identifiers, tests prove leakage-safety and determinism, model output states its limits.

## Revision history

- **rev 3 (2026-11-17)** — declared `cross-ref` in `networked_commands` (R2 env/secrets, manifest
  and chunk reads, exit classes 65/70/74/77/78, uniform envelope); scoped the no-network/no-secrets
  rule to non-networked commands; added the conformance gate; completed the roster with `queue` and
  `explore` (already shipped in the CLI and Host tools); kept `cross-ref` `schemaVersion` at 1
  because the two envelope fields are additive and the failure envelope is unchanged; moved the
  contract from the gitignored `Scratch/security/` path to `docs/security-plugin-contract.md`.
- **rev 2 (2026-11-08)** — frozen for `fraud-core` and `fraud-ui`.
