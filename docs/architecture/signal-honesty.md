# ADR: Signal Honesty (No Lies by Omission)

## Status

Accepted (2026-11-09). Institutional follow-up to the Nov 2026 multi-pipeline stale-R2 recovery.

## Context

Historically, subsystems in this repo could fail while upstream signals still looked healthy: cron jobs
exited 1 without naming the API layer, KPI badges read R2 `Last-Modified` instead of data window,
empty corpora passed gates, and CLI flags existed without being wired. Forensics cost days (for example
the Nov 2026 five-day `pipeline.r2` stale window across F402 weblog, GSLive tally, and wagers-by-state).

## Decision

Treat **observability and operator UX as part of the contract**, not polish. Errors, badges, cron
results, and resolvers must name **cause**, **source**, and **absence** explicitly.

## Core rules

### 1. Failures must name their cause

- Bad: `throw new Error("exit 1")`, `job failed`, stderr-only Bun banner with no API detail.
- Good: `getBetReport returned HTTP 401 (text/html); an HTML login page means the session expired`.
- Good: `weblog corpus not found. Tried: $F402_WEBLOG_FROM, {dated}, {operatorDir}/*.jsonl`.

### 2. Missing is never zero

- Bad: `return data.length || 0` when fetch failed or file is absent.
- Good: distinguish `rows: 0` after a successful parse vs `status: "unavailable"` with `reason: "ENOENT"`.
- Good: KPI / fraud-model sources expose fixture vs live vs capture provenance (see `lib/fraud_logs.ts`).

### 3. Declared surfaces must work

- If a CLI flag exists (`--fetch-mode`, `--timeout`, `--from`), it must affect behavior or reject with a named error.
- If a cron job is scheduled, its argv and credential probe must match what the child script requires (`requiredEnv`, corpus present, keychain probe).
- Empty `requiredEnv: []` is allowed only when a **dedicated** probe documents the real prerequisites (for example weblog corpus resolution).
- Cordis / patch **config** keys must be read by the Host or Client that documents them (for example `apiPort` on `dsh-plugin-sportsdesk-desk-panel` → `resolveDeskOrigin()`).

### 4. Unknowns require explicit provenance

- Dashboards and APIs report **basis**: `live` | `capture` | `fixture` (or equivalent `source.kind`).
- R2 freshness must not imply desk-data freshness when only publish time is known (log data window; track KPI data-age in follow-ups).

### 5. Log prefixes

Every subsystem prefixes **stderr** lines with a bracketed identifier: `[weblog]`, `[bridge3c]`, `[kpi]`, etc. Cron `jobFailure()` and operators tailing `bridge-rollup-cron.jsonl` use these tags to attribute failures without parsing full stack traces. Prefer one prefix per CLI; align new lines with the job id in `bridge_rollup_cron.ts` when the script serves a scheduled job. (Legacy `weblog:` without brackets is being phased toward `[weblog]`.)

## Standard patterns

### Resolvers return value and source

Prefer resolvers that return `{ value, source }` (or throw with every tier named):

- `resolveF402BearerTokenDetailed` — bearer + `source`
- `resolveF402BetsJsonlPath` — path with env / operator-default fallbacks named on failure
- `resolveBridgeWeblogCorpusFrom` — env → repo dated → operator probes dir

New resolvers should follow the same shape; do not add silent defaults without logging or error text.

### Subprocess and cron honesty

- `jobFailure()` and bridge cron must surface **stdout and stderr** from child CLIs (not stderr-only tails).
- Publish paths should log **data window age** when KPI still keys off `Last-Modified` (see `weblogPublishDataWindowLogLine`).

### Verbose fetch (redacted)

External fetch CLIs may honor operator verbose flags (for example `F402_FETCH_VERBOSE`) to log URL, status, and a short body prefix **without** secrets (`Authorization`, `Cookie`, GSID).

## Cron `requiredEnv` audit (2026-11-09)

| Job        | `requiredEnv`                  | Notes                                                                                         |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `bridge3a` | `F402_AGENT_ID`                | + keychain probe for bearer                                                                   |
| `bridge3b` | F402 credential env set        | pending bets rollup                                                                           |
| `bridge3c` | `GSLIVE_SESSION_ID`, `GSID`, … | manager session                                                                               |
| `weblog`   | `[]`                           | Corpus via `resolveBridgeWeblogCorpusFrom` + `bridgeWeblogCorpusPresent`; not “needs nothing” |

Only **weblog** uses an empty `requiredEnv` array; credentials are **corpus presence**, not GSID.

## Operator triage matrix

| If you see this…                         | It usually means…                                   | Do this…                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `[not live]` on dashboard                | Fixture or scratch capture, not live ajax           | Check `source` / tooltip; verify cron and auth if live expected                                                                |
| `bridge3c` exit 1                        | Read stderr: `HTTP 401` vs `ECONNRESET` / timeout   | 401 → refresh GSID (`secrets:gslive set` / `login`); timeout/big payload → narrow `--open-from`/`--open-to`, raise `--timeout` |
| `pipeline.r2` sink `stale`               | Local artifact may exist but R2 pointer not updated | Run publish step (`wagers:publish-snapshot`, bridge rollup with R2); check R2 credentials                                      |
| `getBetReport returned HTTP 401`         | GSID expired or wrong keychain name                 | `bun run secrets:gslive status`; store under `GSLIVE_SESSION_ID`                                                               |
| `bearer source=session`                  | No env bearer; using session file                   | OK for dev; set keychain/env bearer for cron                                                                                   |
| Weblog cron “fresh” KPI, old desk window | Republish of stale corpus                           | Tail cron for `weblog: published rollup for data window … (Nd old)`                                                            |

## References

- Incident: `docs/incidents/2026-11-04-bridge-outage-recovery.md`
- Sources contract: `docs/Sources.txt`
- Wagers two-step publish: `docs/runbooks/wagers_live_capture_runbook.md`
- Recovery arc: GitHub #84 (multi-sink R2 stale; closed when sinks honest)
- Closed gaps governed by this ADR: #93 (wagers cron wired in `reporting_scheduler_service`), #94 (bridge3c `--timeout` wired), #78 (KPI data-age vs publish-age separated in `r2_pipeline_kpis`), #96 (generic throws and silent catches banned via `bin/check-signal-honesty.ts`); #91 (weblog producer: `weblog:sentinel` OS cron)
- Enforcement: `bin/check-signal-honesty.ts` gate (generic `throw new Error("failed"|"error"|…)` and silent catches banned)
- Weblog producer (#91): `weblog:sentinel` OS cron reminds at 08:00 when today's JSONL is missing (manual export; no Mode A fetch)
