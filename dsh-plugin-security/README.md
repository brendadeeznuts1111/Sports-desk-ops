# dsh-plugin-sportsdesk-security

Read-only security/fraud console for the Fantasy402 sports desk, as a DSH bundle. It normalizes
the desk's own GSLive and F402 log artifacts into one evidence vocabulary, runs named
sportsbook fraud/surveillance detectors over them, and fits a transparent weak-label risk model —
while reporting the provenance and limits of every number it shows.

Package: `dsh-plugin-sportsdesk-security` · Host banner id `sportsdesk-security` · tools
`fraud_*` · UI entry `sportsdesk-security`.

## The boundary (read this first)

- **No live betting and no order path.** Nothing in this bundle talks to a venue, a manager API
  or the network. There is no execute/settle/wager capability here.
- **Read-only over captured artifacts.** Eight tools only read local files. The ninth
  (`fraud_model` with `action: "fit"`) writes ONE derived artifact under `reports/security/`
  (gitignored) and requires both `confirm: true` and `write: true`; otherwise it is a dry run.
- **No credentials.** The plugin reads no secret, environment secret, cookie or keychain item.
  The CLI it shells reads only local artifacts.
- **No R2 read in the tool path.** The dashboard owns the repo's only network-capable weblog read
  ([lib/f402_weblog_latest.ts](../lib/f402_weblog_latest.ts)); this CLI reads local rollups and
  reports `missing` instead. Keep it that way — an R2 pull belongs in a sync step that lands the
  artifact on disk first.
- **PII posture.** Raw IP addresses are never returned: they are masked (`47.223.***.***`) with a
  stable short hash tag and a `/24` prefix key for clustering. Account/agent ids appear because
  the desk's other operator tools already expose them; no IP↔account raw join is emitted.
- **Honesty posture.** A missing source is a measured state (`missing` / `session_expired`),
  never a zero. A fixture source is labelled `provenance: "fixture"` and is never fitted. The
  model predicts a proxy label built from the desk's own flags — it is **not** a fraud
  probability and says so in every report and in the UI.

## Log sources (measured, not assumed)

| Source id                | Artifact                                                                                     | Provenance                                | Failure mode surfaced                          |
| :----------------------- | :------------------------------------------------------------------------------------------- | :---------------------------------------- | :--------------------------------------------- |
| `gslive_bet_report`      | `Scratch/security/corpus/gslive-betreport-all-*.json`, fallback `Scratch/betReport-all.json` | live GSLive export (ephemeral, untracked) | missing / ephemeral                            |
| `gslive_wagers_by_state` | `Scratch/gslive-wagers-by-state.summary.json` + `.csv`                                       | GSLive export                             | missing                                        |
| `f402_live_bets`         | `data/live-bets.json`                                                                        | live-api snapshot                         | stale / missing                                |
| `f402_live_wagers`       | `data/live-wagers.json`                                                                      | live-api snapshot                         | stale / missing                                |
| `f402_weblog_rollup`     | `Scratch/weblog/rollup-*.json`                                                               | api-log-rollup (zero-PII aggregate)       | missing corpus noted                           |
| `gslive_weblogs`         | `Scratch/gslive-weblogs/latest.json`                                                         | api-log-rollup                            | `session_expired` (HTTP 401)                   |
| `gslive_suspect_audit`   | `reports/gslive-suspect-all-states-audit.json`                                               | derived                                   | known `targetAccount:"--help"` defect surfaced |
| `f402_weblog_capture`    | `docs/evidence/captures/2026-10-31/getWebLog.post.json`                                      | shape sample                              | empty capture: rows MISSING, not zero          |
| `customer_book`          | `enriched_customers_full.json`                                                               | **generated fixture**                     | fixture chip; excluded from fitting            |
| `agent_index`            | `data/agent-index.json`, `agent-tree.json`                                                   | derived                                   | missing                                        |

Every answer carries the source matrix, so a score can never be read without knowing what it was
computed on.

## Tools

| Tool             | What it answers                                                                                                                                                                                                                                                                                                         |
| :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fraud_status`   | every source's state/provenance/sha256/age, corpus summary, fitted-model state, next step. Start here.                                                                                                                                                                                                                  |
| `fraud_bets`     | aggregates over the getBetReport corpus (states, bot/reversal/manual/odds-drift counts, delay histogram) + masked sample rows; filters agent/account/state/since/limit.                                                                                                                                                 |
| `fraud_queue`    | the account triage queue: accounts with a desk-flag row or an account-subject finding, ranked by strong desk-flag rows (bot/reversal/manual), then account findings by severity, then odds-drift rows, then the model's 0-100 proxy score, then bets; each row carries its reasons and counts. No invented point score. |
| `fraud_ip_graph` | account↔IP clusters (shared IP, `/24`, IPv6 `/64`), account IP fan-out, bot-ring range, datacenter classes — masked identifiers only.                                                                                                                                                                                   |
| `fraud_weblog`   | F402 WebLog posture (sessions, join coverage, snipers/twins/shoppers/beards/bot-ring, gates) and GSLive activity flags when present.                                                                                                                                                                                    |
| `fraud_patterns` | the detector catalog as findings: severity, category, subject, observed values, thresholds, evidence pointers, provenance, `insufficientData`.                                                                                                                                                                          |
| `fraud_model`    | `report` / `fit` (dry-run unless `write`+`confirm`) / `score <account>`: features, weights, AUC/AP/precision@k/Brier/calibration, validation, limits.                                                                                                                                                                   |
| `fraud_dossier`  | one account/agent: hierarchy, bet aggregates, IP clusters, findings, model score with contributions, evidence + freshness.                                                                                                                                                                                              |
| `fraud_research` | the research catalog: terminology, prior-art register per detector, threshold provenance, model limits.                                                                                                                                                                                                                 |

## Detectors

Conventional sportsbook terminology, with the id as API. The sourced prior-art brief behind these
detectors (23 external sources: UKGC/MGA/NIST/Fed SR 11-7/Sportradar/ITIA plus peer-reviewed and
preprint work, each labelled by evidence tier) ships as [RESEARCH.md](RESEARCH.md); the machine-
readable catalog with every threshold's repo provenance is `config/fraud-research.json`.

- **Courtsiding / latency arbitrage**: `STEAM_15S_5S`, `CLINCH_AT_PLACEMENT`, `EXECUTION_SNIPERS`,
  `SNIPER_TWINS`, `MANUAL_ADMIN_INTERVENTION`, `DELAY_MISMATCH_BET`.
- **Multi-accounting**: `SHARED_IP_CLUSTER`, `ACCOUNT_IP_FANOUT`, `BOT_RING_IP_RANGE`,
  `CROSS_OFFICE_BEARDS`, `BOT_RING_ACCOUNTS`.
- **Line shopping**: `LINE_SHOPPERS`, `ODDS_DRIFT_BET`, `DATACENTER_IP_CLASS`.
- **Match integrity**: `STATE_MIX_ANOMALY`, `WEBLOG_GATE_FAIL`.
- **Agent schemes**: `TROJAN_HORSE`, `DONOR_SHIELD`, `CONFIRM_BYPASS`, `AGENT_FLAG_CONCENTRATION`.
- **Ticket anomalies (F402)**: `ROUND_STAKE_LADDER`, `LONGSHOT_CONCENTRATION`,
  `WRITER_AGENT_MISMATCH`, `TICKET_BURST`, `AGENT_CONCENTRATION`, `VIP_STAKE_OUTLIER`.
- **Data quality**: `SOURCE_STALE`, `SOURCE_EPHEMERAL`, `SUSPECT_AUDIT_DEFECT`,
  `EVIDENCE_ROWS_MISSING`.

Threshold constants are imported from the repo's own modules where they exist
(`lib/gslive_surveillance_governor.ts`, `lib/gslive_bet_event_log.ts`, `lib/f402_weblog.ts`,
`lib/gslive_steam_index.ts`) rather than re-derived; `fraud_research` reports each provenance.

## The model

A transparent, reproducible **weak-label risk ranker**, not a supervised fraud classifier:

- Proxy labels come from the desk's own GSLive flags (`desk_flag` = suspected-bot OR
  reversed-credit OR manual-log; plus `suspected_bot` and `reversed_credit` variants). They are
  weak labels, not confirmed outcomes, and their support is reported.
- Features are per-bet plus leakage-safe account/IP/agent history (a row's prior features use
  only rows that precede it — enforced and tested). Temporal train/holdout split; deterministic
  L2 logistic regression with class weights; no random shuffle across the split.
- Every report carries AUC-ROC, average precision, precision@1%/@5%, Brier, calibration bins,
  train/holdout windows, stability and drift, corpus sha256, and an explicit limits list:
  proxy label not observed fraud · snapshot not longitudinal · fixture sources excluded ·
  no account↔login bridge between the GSLive export and the F402 ticker.
- Scores map to 0–100 and a band (low/medium/high/critical) via the training CDF. The artifact is
  written only on `model fit --write` after `confirm: true`, to `reports/security/fraud-model.json`.

## Web UI page

Sidebar entry `sportsdesk-security` opens a read-only page with tabs **Overview** (source matrix,
corpus, weblog posture, model summary + limits), **Queue**, **IP graph**, **Findings**, **Model** and
**Dossier**. The page reads nine same-origin GET routes from the Host half:
`/api/security/{status,bets,queue,ip-graph,weblog,patterns,model,dossier?id=,research}`. A route that
does not exist is reported as "update the Host bundle"; a source that is missing is reported as
missing, never as zero; a failed refresh keeps the last payload labelled stale.

## CLI mapping

Every tool and route shells the one implementation:

```sh
bun run cli/sportsdesk_fraud_cli.ts status|bets|queue|ip-graph|weblog|patterns|model|dossier|research --json
bun run cli/sportsdesk_fraud_cli.ts model fit --json          # dry run; prints candidate artifact
bun run cli/sportsdesk_fraud_cli.ts model fit --write --json   # persists reports/security/fraud-model.json
bun run cli/sportsdesk_fraud_cli.ts model score <account> --json
```

Failure JSON is `{ success: false, ..., error: { code, message } }` with exit 2 usage / 3 refusal
(`source_missing`, `insufficient_corpus`, `model_missing`, `unknown_subject`) / 1 other. The Host
tools preserve the CLI code as `reason` and the whole CLI answer under `cli`.

## Config

The bundle row config is `{ repoPath, bunPath, timeoutMs }` (see `cordis.patch.yml`). There is no
`Config` schema on purpose: a directory-installed bundle is a symlink, so peer imports do not
resolve; values are normalized in `index.js` and a malformed value falls back to its default.

## Install

```sh
plugin_manager({ action: "install_bundle", target: "<abs>/dsh-plugin-security" })
```

## Verify

```sh
node dsh-plugin-security/verify-load.mjs
```

Proves: module imports under plain Node; `apply` registers exactly the nine tools and nine GET
routes; every tool has a complete definition; `fraud_model` refuses a write without
`confirm: true`/`write: true` and never spawns on that path; a missing CLI yields a structured
`cli_missing` answer; routes refuse non-GET, foreign Origin and invalid queries; locale files have
identical key sets; the Client module is syntactically valid and contains no literal colors,
`innerHTML`, `window.confirm`/`alert`/`prompt`; disposal releases every registration.

It does **not** prove the CLI answers are correct or that the running Host serves the page —
that needs the CLI's own tests plus a live install check.

## What this bundle does not do

- It does not capture logs (the repo's `capture:*`, `gslive:weblogs:refresh`, `weblog:rollup`
  scripts own capture). When a capture is missing it reports the missing state and the refresh
  command; it never invents rows.
- It does not verify a fraud outcome, ban an account or enforce a limit. Findings are evidence
  for an operator decision, not an action.
- It does not use the fixture customer book or the hardcoded IP-tracker clusters as evidence of
  real behaviour; they are context only, explicitly labelled.
