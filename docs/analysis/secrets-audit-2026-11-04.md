# Secrets / keychain integration — read-only audit (2026-11-04)

**Repo:** `/Users/nolarose/code/sportsdesk-ops` · **branch** `main` · **HEAD** `8522a04`
**Status:** read-only audit. No source file was modified; no secret value was read, printed, or
exfiltrated. Two status probes were run with `--no-env-file` and are recorded in §5 with
present/absent booleans only.

**Why this exists:** the `--from-keychain` / bearer-mint work depends on a keychain contract that is
currently duplicated across at least three modules. This audit inventories every code path that can
reach `Bun.secrets` or the macOS `security` tool, classifies the tests that touch a real keychain,
and records the open questions that block the bearer-mint decision.

---

## 1. Counts (measured at `8522a04`, clean tree)

| Metric                                              |                                              Count | Basis                                                            |
| --------------------------------------------------- | -------------------------------------------------: | ---------------------------------------------------------------- |
| Tracked files                                       |                                          **1,112** | `git ls-files`                                                   |
| TypeScript files                                    |                                            **783** | `git ls-files '*.ts'`                                            |
| Test files (tracked)                                |                                            **314** | 233 `tests/` + 68 `lib/` + 13 `scripts/`                         |
| Test cases in `tests/` (last run)                   |                                          **1,584** | `junit-report.xml`                                               |
| Files matching strict secrets/keychain keyword set  |                                             **80** | 54 `.ts` (incl. 14 tests) + 18 `.md` + 8 config/CI               |
| — non-test code files                               |                                             **41** | 40 `.ts` + 1 `.mjs`                                              |
| — test files (strict / broad secrets handling)      |                                        **14 / 41** | broad set = 459 static cases                                     |
| Production files with a direct `Bun.secrets.*` call |                                             **11** | get/set/delete call expressions                                  |
| Files reaching the keychain transitively            |                                            ~**14** | resolvers, probes, re-exports                                    |
| Files shelling out to `security`                    |                                              **2** | `lib/f402_credentials_policy.ts:123`, `scripts/secrets_r2.ts:37` |
| Core keychain test files / cases                    |                                       **12 / 131** | injected fakes mostly; 4 real-keychain-touching                  |
| `check:secrets` result                              | **ok — 1,093 tracked files, no credential shapes** | executed read-only                                               |
| Live keychain probes (2026-11-04)                   |                          **2 status + 1 presence** | §5; read-only, no values printed                                 |

`AGENTS.md` claims “397 TypeScript files … 139 tests … tests/ (84 files), ~55 colocated”. Measured:
**783 / 1,584 / 233 + 81**. The guidance numbers are stale.

`find` sees 369 test files; 55 are stale copies under `.worktrees/` and are excluded from every
count above.

---

## 2. Method and limits

- Static reading + `git grep` from four parallel read-only workstreams (core lib, CLI/scripts,
  tests, policy/gates/docs), cross-checked by the Lead.
- Live evidence: `bun --no-env-file run secrets:f402 status`, `secrets:gslive status`, and one
  boolean-only per-service presence probe (§5). All three read the real keychain, printed no values,
  and completed without a prompt.
- Commands executed against the repo: those three probes and `bun run check:secrets` (read-only
  scanner). No test suite, no capture, no mutation.
- **Not read:** `.env` (a real FIFO, `prw-------`), `cloudflare.env`, any keychain value.
- **Not run:** `bun test`, `session:status`, `secrets:* set|delete`, `secrets_r2 seed`,
  `capture:*`, `env:audit`.
- `.worktrees/`, `.agents/`, `Scratch/`, `node_modules/`, `dist/` are excluded from the inventory.

---

## 3. Inventory — where secrets actually live

### 3.1 Direct `Bun.secrets` call sites (11 production files)

| File                             | Operation                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `lib/secrets.ts`                 | `get` canonical → legacy; the intended read SSOT (`:39`, `:54`)                                          |
| `lib/f402_credentials_policy.ts` | `get` via injected reader (`:167`), `security` fallback (`:122`), TTY, deprecated env                    |
| `lib/r2_s3_client.ts`            | `get` 8 R2/BLOB names canonical → legacy (`:126`, `:134`); bounds/persist helper (`:172`)                |
| `lib/blob_upload.ts`             | `get` `BLOB_API_TOKEN` **canonical only** (`:58`)                                                        |
| `lib/gslive_auto_session.ts`     | `get` `GSID` / `GSLIVE_USERNAME` / `GSLIVE_PASSWORD`; `set` `GSID` as `never` (`:30`, `:75`, `:124`)     |
| `scripts/secrets_f402.ts`        | `set` ×2 (`:114`, `:120`), `delete` ×4 (`:139`)                                                          |
| `scripts/secrets_gslive.ts`      | `get` status (`:69`), `set` GSID (`:86`), `delete` canonical only (`:95`), undocumented `login` (`:145`) |
| `scripts/secrets_r2.ts`          | `get` (`:50`, `:101`), `set` ×8 (`:94`), `delete` (`:117`), `security` (`:37`)                           |
| `scripts/fetch-bet-tally.ts`     | `get` GSID canonical → `sportsdesk-gslive` (`:305`)                                                      |
| `scripts/capture/f402_login.ts`  | `get` player creds from **legacy-only** service (`:71`)                                                  |
| `scripts/capture/f402_probe.ts`  | `get` agent id from **legacy-only** service (`:240`)                                                     |

### 3.2 Transitive keychain readers

`lib/bridge_rollup_cron.ts:477` · `lib/f402_bet_ticker_sink.ts:91` ·
`lib/f402_pending_sink.ts:43` · `lib/gslive_tally_sink.ts:41` ·
`lib/wagers_live_sink.ts:185` · `services/supervisor.ts:93` ·
`services/blob_and_live_bets_server.ts:806` · `services/reporting_scheduler_service.ts:437` ·
`services/sportsdesk_webview_server.ts:2576` · `scripts/session_login.ts:118` ·
`scripts/evidence_capture.ts:356` · `scripts/wagers_by_state_capture.ts:976` ·
`scripts/f402_weblog_bridge.ts:70` · `scripts/f402_bet_ticker_bridge3a.ts:38` ·
`scripts/publish_r2_graph.mjs:263`

### 3.3 Meta / controls / contracts

`bin/check-secrets.ts` + `lib/secret_scan.ts` (scanner) · `lib/env_audit.ts` +
`scripts/env_audit.ts` (env value audit) · `bin/bun_surface.ts:115` +
`lib/bun_shapes.ts:520` + `scripts/bun_shape_contracts.ts:145` (pinned contract) ·
`scripts/probe_bun.ts` · `types/bun-api.d.ts` · `types/env.d.ts`

### 3.4 Keyword-only mentions (no secret access)

`lib/gslive_bet_event_log.ts` · `lib/wagers_capture_config.ts` · `lib/gslive_session.ts`
(re-export only) · `scripts/probe/client_seams_probe.ts` · `scripts/schema_snapshot.ts` ·
`scripts/capture/reprobe_pending_500s.ts` · `scripts/gslive_all_states_suspect_cron.ts`
(stale doc claim) · `lib/onepassword_session_bridge.ts` (header claims keychain I/O; body has none)

### 3.5 SSOT / config

`.1password/environments.toml` — tracked; environment id + `mount_paths = [".env"]` (id not
reproduced here). `.env` is a FIFO. `cloudflare.env` is sourced with `set -a` by `bin/dx:73-83` and
is **not gitignored**. `package.json:178-179` defines the two write CLIs; `.github/workflows/ci.yml:115`
is the only credential gate.

---

## 4. Access matrix — service × name × op × owner

| Service                                   | Name(s)                                  | Read                                                                | Write                                                | Delete                                  |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| `com.bookdeskops.sportsdesk`              | `f402-agent-id`, `f402-password`         | `lib/secrets.ts:54`, policy, probe (legacy), bridge                 | `scripts/secrets_f402.ts:114`                        | both services (`:133`)                  |
| `com.bookdeskops.sportsdesk`              | `f402-player-id`, `f402-player-password` | **legacy-only** `f402_login.ts:71`                                  | **no writer exists**                                 | none                                    |
| `com.bookdeskops.sportsdesk`              | `GSID`                                   | `fetch-bet-tally.ts:305`, `gslive_auto_session.ts:30`, bridge probe | `secrets_gslive.ts:86`, `gslive_auto_session.ts:124` | canonical only (`secrets_gslive.ts:95`) |
| `com.bookdeskops.sportsdesk`              | 8 × `R2_SECRET_NAMES`, `BLOB_*`          | `r2_s3_client.ts:126`, `blob_upload.ts:58`                          | `secrets_r2.ts:94`                                   | canonical only (`:117`)                 |
| `com.bookdeskops.sportsdesk`              | `GSLIVE_USERNAME`, `GSLIVE_PASSWORD`     | `gslive_auto_session.ts:75`                                         | **no writer**                                        | none                                    |
| `sportsdesk-ops` (legacy)                 | `f402-*`, `GSID`, `R2_*`                 | `lib/secrets.ts:54`, `r2_s3_client.ts:134`, `f402_probe.ts:240`     | never written                                        | F402 deletes; R2 does not               |
| `sportsdesk-gslive` (legacy)              | `GSID`                                   | `fetch-bet-tally.ts:309`, `secrets_gslive.ts:70`                    | never written                                        | **never deleted**                       |
| `bookdeskops.desk`, `4c-odds-integration` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `live_positions_cron.ts:567-595`                                    | **no writer**                                        | none                                    |

**Name collision:** `sportsdesk-ops` is simultaneously the legacy keychain service, the systemd
unit/repo name, and the R2 bucket prefix (`sportsdesk-ops-reports`).

---

## 5. Live keychain probe — 2026-11-04

Run one at a time, `bun --no-env-file run …`, no values printed; each exits 0 without a prompt.

### 5.1 `secrets:f402 status`

```text
agent id: stored in sportsdesk-ops
password: stored in sportsdesk-ops
EXIT=0
```

**Reading:** the F402 pair lives in the **legacy** service. The canonical migration described in
`lib/secrets.ts:4-7` has not happened for F402. Canonical-first readers (`lib/secrets.ts`,
`session:login --from-keychain`, `lib/f402_credentials_policy.ts`) therefore reach the entry only
through the legacy fallback. Legacy-only readers (`f402_probe.resolveAgentId`,
`loadF402PlayerCredentials`) work **today by coincidence**: if `secrets:f402 set` is run (it writes
canonical) and the legacy copy is later deleted, they will silently return empty.

### 5.2 `secrets:gslive status`

```text
service: com.bookdeskops.sportsdesk
name: GSID
session: stored
EXIT=0
```

Boolean-only presence probe per candidate service (no values printed):

```text
GSID @ com.bookdeskops.sportsdesk: present
GSID @ sportsdesk-gslive:             absent
GSID @ sportsdesk-ops:                absent
```

**Reading:** the GSID is genuinely canonical, so today's `fetch-bet-tally.ts` and
`gslive_auto_session.ts` reads agree. The three-way legacy divergence in §7 Finding 1 is therefore
**latent for GSID**, not active. The mislabel in `gsliveSecretStatus` (`:76`) is also latent here —
it would print `com.bookdeskops.sportsdesk` even for a legacy hit, but the live entry happens to be
canonical. That makes the mislabel **safe by accident, not by design**: it will mislead under any
future migration that moves the GSID back to a legacy service.

### 5.3 Net effect

The live keychain is in a **split-brain state**: F402 in legacy, GSID in canonical. That is exactly
the state in which the duplicated service constants are most dangerous, because both legacy-only and
canonical-first readers happen to succeed. Any migration (write canonical, delete legacy) changes
which readers still work.

---

## 6. Stack traces (verified call chains)

**T1 — `bun run supervise` (daemon startup)**

```text
package.json:153
└─ services/supervisor.ts:269 → supervise() :132
   └─ :135 supervisedServicesAsync()
      └─ :97 resolveSecretBackedEnv(env, Bun.secrets)
         lib/r2_s3_client.ts:117
         ├─ :126 Bun.secrets.get({ service:"com.bookdeskops.sportsdesk", name:<8 R2 names> })
         └─ :134 Bun.secrets.get({ service:"sportsdesk-ops", name })
   └─ :157 Bun.spawn(argv, { stdout:"inherit", stderr:"inherit" })   ← NO env option
```

**T2 — `bun run serve:blob-live-bets`**

```text
package.json:152 → services/blob_and_live_bets_server.ts:804
├─ :806 resolveR2CredentialsAsync() → lib/r2_s3_client.ts:187 → :117
│   ├─ :126 Bun.secrets.get(canonical, 8 names)
│   └─ :134 Bun.secrets.get(legacy, 8 names)
├─ :818 resolveSecretBackedEnv()            ← redundant second 8-name scan
├─ :821 throw unless BLOB_API_TOKEN + BLOB_TICKET_SECRET
└─ :204 createHmac("sha256", ticketSecret)  ← BLOB_TICKET_SECRET
```

**T3 — webview daemon bridge cron**

```text
package.json:151 → services/sportsdesk_webview_server.ts:2317 startBridgeSchedules()
└─ services/reporting_scheduler_service.ts:173 → :146 Bun.cron
   └─ :430 bridgeCycleRunner → runBridgeRollupCycle({ credentials: keychainCredentialProbe(...) })
      └─ lib/bridge_rollup_cron.ts:1037 probe.check(job)
         ├─ :508 readSecret("GSID") → lib/secrets.ts:62 → :39 Bun.secrets.get(canonical|sportsdesk-ops)
         └─ :537 readSecret("f402-agent-id") → same
      └─ :1051 childEnv = { ...Bun.env, F402_AGENT_ID }; :618 Bun.spawn(..., { env: childEnv })
```

**T4 — `bun run capture:f402-har --login`**

```text
package.json:45 → scripts/capture/f402_manager_boot_har.ts:125 loginF402()
└─ scripts/capture/f402_login.ts:195 → :209 loadF402LoginIdentity → :54 loadF402Credentials
   └─ lib/f402_credentials_policy.ts:218 loadF402CredentialsSecure(env, Bun.secrets)
      ├─ :167 Bun.secrets.get(canonical then sportsdesk-ops, "f402-agent-id" / "f402-password")
      ├─ if secrets===null → :145 readKeychainViaPlatform
      │   └─ :122 Bun.spawn(["security","find-generic-password","-s",service,"-a",account,"-w"])
      ├─ if TTY → :181 Bun.spawn(["bash","-c","read -rs …"])
      └─ if F402_ALLOW_ENV_CREDENTIALS=1 → F402_AGENT_ID / F402_PASSWORD
```

**T5 — `bun run wagers:capture`**

```text
package.json:24 → scripts/wagers_by_state_capture.ts:976/:1143 resolveManagerSession(env)
└─ scripts/fetch-bet-tally.ts:295
   ├─ GSID_COOKIE → session file → :305 keychain
   │   ├─ :308 Bun.secrets.get({ service:"com.bookdeskops.sportsdesk", name:"GSID" })
   │   └─ :309 Bun.secrets.get({ service:"sportsdesk-gslive", name:"GSID" })
   └─ :323 GSID env fallback
```

**T6 — write: `bun run secrets:f402 set`**

```text
package.json:178 → scripts/secrets_f402.ts:151
├─ :97 refuse TTY; :106 password from stdin only
├─ :114 Bun.secrets.set(canonical, "f402-agent-id", agentId, persist:"local")
└─ :120 Bun.secrets.set(canonical, "f402-password", password, persist:"local")
   ← no try/catch: platform failure leaves a half-written pair
```

**T7 — write: `bun run secrets:gslive login` (undocumented subcommand)**

```text
package.json:179 → scripts/secrets_gslive.ts:145
└─ lib/gslive_auto_session.ts:137 ensureGsid
   ├─ :75/:76 Bun.secrets.get(canonical, "GSLIVE_USERNAME"/"GSLIVE_PASSWORD")
   ├─ :87 POST ajax.php action=login  (password in TLS body)
   ├─ :124 Bun.secrets.set(canonical, "GSID", value, persist:"local") as never
   └─ :23 writeFileSync(GSLIVE_SESSION_FILE, gsid, { mode:0o600 })
```

**T8 — write: `bun scripts/secrets_r2.ts seed` (no package script)**

```text
scripts/secrets_r2.ts:126
├─ :50 Bun.secrets.get(canonical) / :58 (legacy)
├─ :37 Bun.spawn(["security","find-generic-password","-a",name,"-w"])   ← no -s, NO TIMEOUT
├─ :88 CSPRNG token for BLOB_API_TOKEN / BLOB_TICKET_SECRET
└─ :94 Bun.secrets.set(secretSetOptions(canonical, name, value)) → persist:"local"
```

**T9 — test-only real-keychain paths (macOS)**

```text
tests/support/capabilities.ts:220 top-level await probeSecretsWrite()
└─ :151 darwin gate → :160 Bun.secrets.set("dx-probe", uuid, "v") → :171 delete (best-effort)

lib/f402_credentials_policy.test.ts:23 / tests/f402_login.test.ts (2 cases) pass secrets=null
└─ lib/f402_credentials_policy.ts:164 → :145 → :122 Bun.spawn(["security", "find-generic-password", …])
```

---

## 7. Findings (15)

Severity labels: **live** = reproduced against this checkout/keychain; **latent** = code is wrong
but the current environment does not expose it; **confirmed** = static fact.

1. **[latent] Three contradictory GSID fallbacks.** `lib/secrets.ts:16` legacy = `sportsdesk-ops`;
   `scripts/fetch-bet-tally.ts:220` legacy = `sportsdesk-gslive`; `lib/gslive_auto_session.ts:31`
   canonical only. The cron gate (`lib/bridge_rollup_cron.ts:508`) can block on “missing
   credentials” for a GSID the CLI it guards would read. Live probe: GSID is canonical, so this is
   not active today.
2. **[latent, live split] F402 readers diverge from the writer.** `scripts/capture/f402_probe.ts:240`
   and `scripts/capture/f402_login.ts:71` read legacy-only; `scripts/secrets_f402.ts:114` writes
   canonical. Live probe: F402 is still legacy, so readers work today and will break after the
   canonical migration. `f402-player-*` has **no writer at all**.
3. **[live] `evidence_capture` live gate demands plaintext env creds the auth path ignores.**
   `scripts/evidence_capture.ts:331-334` requires `F402_AGENT_ID` + `F402_PASSWORD`;
   `lib/f402_credentials_policy.ts:232` refuses `F402_PASSWORD` unless the deprecated flag is set.
   Keychain-only operators are blocked; passing the gate forces a secret into the environment.
4. **[latent, confirmed by probe] Delete/status asymmetry can leak stale credentials.**
   `scripts/secrets_gslive.ts:76` labels every hit as canonical; `:95` deletes canonical only,
   leaving `sportsdesk-gslive` to resurface. `scripts/secrets_r2.ts:117` also deletes canonical only;
   `scripts/secrets_f402.ts:133` correctly deletes both. Live probe: GSID is canonical, so the
   mislabel does not reproduce today.
5. **[confirmed] Write CLIs execute on import.** `scripts/secrets_gslive.ts` has no
   `import.meta.main` guard and its own test imports it (`scripts/secrets_gslive.test.ts:9`).
   Depending on argv, importing runs `status` against the real keychain or `process.exit(2)`.
   `scripts/secrets_f402.ts`, `scripts/secrets_r2.ts` and `scripts/capture/f402_manager_boot_har.ts`
   are also unguarded.
6. **[live on macOS] Tests touch the real keychain via module import.**
   `tests/support/capabilities.ts:160` writes at import time (top-level await `:220`), transitively
   from 8 test files; cleanup is best-effort. Three null-provider cases spawn the real `security`
   binary.
7. **[confirmed] Child-process env policy is inconsistent.** `services/supervisor.ts:157` and
   `lib/bridge_rollup_cron.ts:1051` pass the full parent env, contradicting `buildMinimalSpawnEnv`
   (`lib/f402_credentials_policy.ts:63`, GATE-SEC-01).
8. **[confirmed] A documented contract that does not exist.** `lib/onepassword_session_bridge.ts:6-18`
   claims keychain-first lookup, 401 eviction, `op read` recovery and `op item edit` mutexes; the
   body has none, and only a test imports it.
9. **[confirmed] Stale header.** `lib/f402_credentials_policy.ts:4` says “Bun 1.4.4 has no
   OS-keychain API” while defaulting its reader to `Bun.secrets` (`:220`). `Bun.secrets.get` exists
   in 1.4.4.
10. **[confirmed] Validation bypassed on some writes.** `lib/gslive_auto_session.ts:124` uses
    `as never`; `scripts/secrets_f402.ts:114` bypasses `secretSetOptions`/2048-byte bound; `set`
    writes agent-id before password (partial pair on failure).
11. **[confirmed] `??` / empty-string semantics hide entries.** Empty canonical value masks a valid
    legacy value in `scripts/fetch-bet-tally.ts:307` and `scripts/secrets_gslive.ts:69`;
    `services/supervisor.ts:78` treats `BLOB_API_TOKEN=""` as provisioned;
    `lib/f402_bet_ticker_sink.ts:85` caches the first token (including `""`) for the process
    lifetime.
12. **[confirmed] Hardcoded service literals, no single constants module.**
    `com.bookdeskops.sportsdesk` in 5 places; `sportsdesk-ops` in 4; `sportsdesk-gslive` in 1 code
    file; Telegram services in a fourth, undocumented list (`scripts/live_positions_cron.ts:567`)
    that excludes the canonical service. The pinning test asserts only names, not services
    (`tests/bridge_rollup_cron_keychain.test.ts:56`).
13. **[confirmed] Gate coverage is narrower than it looks.** `check:secrets` is index-only
    (`git ls-files`), so `.env` (FIFO) and untracked `cloudflare.env` are invisible; `cloudflare.env`
    is not gitignored and is exported wholesale by `bin/dx:73-83`. No GSID/session-cookie rule; HAR
    cookies-array shape unmatched; mask prints the first 4 characters; not in the pre-push gate; CI
    path filters exclude `.1password/**` and generic `*.toml`.
14. **[confirmed] Docs name the legacy service as the live one.**
    `docs/runbooks/wagers_live_capture_runbook.md:132` says `service=sportsdesk-gslive`;
    `docs/runbooks/cloudflare_r2_and_api_runbook.md:20` says fallback service `sportsdesk-ops` and
    lists 5 of 8 names. `docs/bun-upstream-reference.md:323` is correct.
15. **[unverified] Latent type import.** `lib/r2_s3_client.ts:16` and `scripts/secrets_gslive.ts:14`
    import `../types/bun-api.ts`, but only `types/bun-api.d.ts` exists.

---

## 8. Pre-flight questions for `--from-keychain` / bearer mint

### Q1 — `~/.cache/sportsdesk/f402-session.json` shape (static answer)

`lib/f402_session.ts:23-31` defines:

```ts
interface F402Session {
  cookieHeader: string; // raw Cookie header, never logged
  cookieNames: string[]; // names only, safe to log
  authorizationHeader?: string; // optional bearer, never logged
  obtainedAtIso: string;
  expiresAtIso: string;
}
```

Default path: `join(homedir(), ".cache", "sportsdesk", "f402-session.json")` (`:47`). Written 0600,
temp+rename (`:141-166`). `sessionFromAuth` only stores `authorizationHeader` if the caller supplies
it (`:182-184`), and `scripts/session_login.ts:28` says “session-only: no bearer token is minted”.
So the session file is **cookie-first with an optional bearer slot that is currently never filled**.

### Q2 — `lib/f402_pending_fetch.ts` auth mode

**Bearer-only.** `lib/f402_pending_fetch.ts:192` sends `authorization: Bearer ${options.token}`;
there is **no** `credentials: "include"` and no cookie path in pending/weblog fetch. The token comes
from `resolveF402BearerToken` (`:67`): CLI `--bearer-token`, then `F402_BEARER_TOKEN`, then
`F402_TOKEN_FILE` (default `$XDG_CONFIG_HOME/sportsdesk/f402-token`) (`:60-100`). `3b` therefore
needs a real bearer, exactly as `docs/runbooks/os_bun_cron_integration_guide.md:338-343` says.

### Q3 — `authenticateCustomer` token type

**No implementation exists in this repo.** The only references are the captured-op allowlist
(`scripts/capture/allowlist.ts:108`, classified as an `auth-exchange` and refused as non-read-only),
the OpenAPI/generator inventory (`scripts/generate_openapi.ts:223`), and evidence docs.

What the evidence says:

- `docs/runbooks/os_bun_cron_integration_guide.md:340-343`: the endpoint is “confirmed to return an
  _agent_ token”, but “a bearer mint is **held** until … no response was ever captured”.
- `docs/evidence/capture-requests.md:128-140`: “The spec claims a scoped Bearer JWT with a ~20–25
  minute lifetime; the one observed Manager session is cookie-based and sends no `Authorization`
  header. Neither claim is evidenced.”
- `docs/api-reference.md:2145-2157`: evidence tier **C**, “UNVERIFIED — no capture exists”, request
  body `customerID=<agent or bettor ID>&password=…`.

**Verdict:** the endpoint is an _agent-or-customer_ credential exchange with no captured response,
so the token type is an assumption, not a contract. The bearer bridge is not safely buildable until
one redacted `authenticateCustomer` POST + the next Manager call's headers are captured. `--from-keychain`
can still proceed as session-cookie only (the session file already has an optional bearer slot for
when the capture lands).

---

## 9. Proposed fix order (not applied)

1. `import.meta.main` guards on `scripts/secrets_gslive.ts`, `scripts/secrets_f402.ts`,
   `scripts/secrets_r2.ts`, `scripts/capture/f402_manager_boot_har.ts` — unblocks any new importer.
2. Resolve `../types/bun-api.ts` vs `.d.ts` — same PR as (1).
3. Make the GSID legacy contract explicit (pick `sportsdesk-gslive` or drop legacy); remove the
   `lib/secrets.ts` / `fetch-bet-tally.ts` split.
4. Make F402 probe/player canonical-first; add a writer for `f402-player-*` or delete the read path.
5. `--from-keychain` (session-cookie only), then the Q1–Q3 capture work.
6. “Secrets cleanup” batch: single contract module, break `lib → scripts` imports, one bounded
   writer, child env via `buildMinimalSpawnEnv`, test seam (no import-time keychain probe), docs.
7. Phase 1 census / Phase 2 DOD design only after the above.

---

## 10. Open questions

1. Keychain contents beyond presence: not read (no values were requested).
2. Whether importing `scripts/secrets_gslive.ts` under `bun test` runs `status` or exits 2 — needs a
   guarded run.
3. `Bun.secrets` runtime failure shape (`ERR_SECRETS_PLATFORM_ERROR` vs `null`).
4. `security find-generic-password -a <name>` without `-s` may match an unrelated service.
5. `types/bun-api.ts` resolution under `bun check` — not run.
6. `env:audit` against the FIFO `.env` would block; `envTracked` looks dead for the root file.
7. The `.1password` environment id resolving (needs `code-project` + 1Password auth).
8. Whether the external pre-push gate or GitHub Actions is the real enforcement path — repo sources
   disagree, and `check:secrets` is not in the pre-push hook.

---

## 11. Appendix — measured commands

```sh
git ls-files | wc -l                        # 1,112
git ls-files '*.ts' | wc -l                 # 783
git ls-files '*.test.ts' | wc -l            # 314
git grep -lE '<secrets|keychain|SECRETS_SERVICE|GSID_SECRET|readSecret|resolveSecretBackedEnv|...>' \
  -- . ':!Scratch' ':!.agents'               # 80 files
bun run check:secrets                       # ok — 1,093 tracked files, no credential shapes
bun --no-env-file run secrets:f402 status   # legacy-only F402 pair (see §5.1)
bun --no-env-file run secrets:gslive status # canonical GSID (see §5.2)
```

Test classification detail lives in the four workstream reports; the core set is
`tests/r2_s3_client.test.ts`, `tests/supervisor.test.ts`, `tests/session_login_keychain.test.ts`,
`tests/bridge_rollup_cron_keychain.test.ts`, `tests/f402_login.test.ts`,
`lib/f402_credentials_policy.test.ts`, `scripts/fetch-bet-tally.test.ts`,
`scripts/secrets_gslive.test.ts`, `tests/f402_bet_ticker_sink.test.ts`,
`tests/bun_capabilities.test.ts`, `tests/bun_eval_patterns.test.ts`, `tests/cli_help.test.ts`.

---

## 12. Post-audit status (2026-11-04)

This section is intentionally outside the snapshot: the audit body describes `8522a04`, and the
fixes below landed on `feat/secrets-keychain-hardening` afterwards.

| Finding                            | Status                                                                                                                                                                                                                                  | Commit                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 5 — write CLIs execute on import   | **Fixed**: `import.meta.main` guards on `secrets_f402`, `secrets_gslive`, `secrets_r2`, `capture:f402-har`                                                                                                                              | `f7f1673`               |
| 15 — `../types/bun-api.ts`         | **Fixed**: extensionless import resolves to the only file, `bun-api.d.ts`                                                                                                                                                               | `f7f1673`               |
| 2 — F402 readers legacy-only       | **Fixed**: `resolveAgentId` routes through `lib/secrets.readSecretCanonicalThenLegacy`; player-tier credentials now have a writer (`secrets:f402 set-player`, canonical `f402-player-*`) and a canonical-first reader with env fallback | `d24b866` + this branch |
| 4 — GSLive status/delete asymmetry | **Fixed**: status reports the service it actually found; delete removes canonical + `sportsdesk-gslive` + `sportsdesk-ops`                                                                                                              | `97bcfe3`               |
| 1 — three GSID fallbacks           | **Fixed**: one contract owns canonical + `sportsdesk-gslive` + `sportsdesk-ops`, and every GSID reader (`fetch-bet-tally`, `gslive_auto_session`, bridge probe, `secrets:gslive`) walks the same list                                   | `7f0353f`               |
| 9 — stale “no keychain API” header | **Fixed**: the module header now says Bun 1.4.4 exposes `Bun.secrets`                                                                                                                                                                   | `7f0353f`               |
| 10 — validation bypassed on writes | **Partial**: every write now goes through `secretSetOptions` (bounds + `persist: "local"`); `secrets:f402 set` still writes agent-id before password                                                                                    | `7f0353f`               |
| 11 — empty-string semantics        | **Partial**: contract reads treat blank/whitespace as absent; supervisor’s empty BLOB gate and the ticker token cache remain                                                                                                            | `7f0353f`               |
| 12 — hardcoded service literals    | **Partial**: F402/GSID/Telegram names centralized; R2 constants still live in `lib/r2_s3_client.ts` behind the contract re-export                                                                                                       | `7f0353f`               |
| 6 — tests hit the real keychain    | **Fixed**: import-time probe removed (lazy, two-key opt-in); `lib/keychain_access.ts` denies every test process; `security` fallbacks gated; static + dynamic gate (see §13)                                                            | this branch             |
| 3, 7, 8, 13, 14                    | **Open** (see §7)                                                                                                                                                                                                                       | —                       |

Consequence for the runbook: `docs/bun-upstream-reference.md` now says write canonical, verify with
`secrets:f402 status`, then delete legacy — not the other way round.

---

## 13. Keychain boundary (2026-11-04, `feat/secrets-keychain-hardening`)

Finding 6 is fixed by a single boundary module instead of per-test discipline:

- **`lib/keychain_access.ts`** is the only module that calls `Bun.secrets.get/set/delete`.
  `keychainAccessDecision()` denies when `NODE_ENV=test` (set by `bun test`), when `Bun.main` is a
  `.test.ts`/`tests/` entrypoint (this still denies if a `.env` overwrites `NODE_ENV`), or when
  `SPORTSDESK_KEYCHAIN_ACCESS=deny`. `guardedSecrets` is the drop-in default for every
  reader/writer: denied reads return `null`, denied writes throw `KeychainAccessDeniedError`.
  `platformKeychainAllowed()` gates the two `security` CLI spawns
  (`lib/f402_credentials_policy.ts`, `scripts/secrets_r2.ts`).
- **`tests/support/capabilities.ts`** no longer writes at import time. The `Bun.secrets` round trip
  runs only under an explicit two-part opt-in: the module top level checks
  `SPORTSDESK_KEYCHAIN_PROBE=1` before awaiting the probe, and the probe itself requires
  `keychainAccessDecision()` to allow (`SPORTSDESK_KEYCHAIN_ACCESS=allow` in a test process). A
  normal `bun test` (even one importing the file) touches no keychain item.
- **Every default reader/writer** now defaults to `guardedSecrets`, not `Bun.secrets`:
  `lib/secrets.ts`, `lib/r2_s3_client.ts`, `lib/f402_credentials_policy.ts`,
  `scripts/capture/f402_login.ts`, `scripts/live_positions_cron.ts`, `scripts/secrets_r2.ts`,
  `services/supervisor.ts`.
- **`tests/keychain_boundary.test.ts`** pins both halves: runtime decision/behaviour (including that
  production/staging/unset `NODE_ENV` stay **allowed** — deny is only for provable test signals),
  and a static scan that fails if any live-tree non-test `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`
  file calls `Bun.secrets` (dot/bracket/destructured/bare), binds the raw `secrets` export from
  `bun`, or spawns `security` without `platformKeychainAllowed()`. `node_modules/`, `.worktrees/`
  and `.agents/` are excluded from pass/fail; stale copies there are counted and printed.
- **CI enforces the trace**, so the invariant survives the next contributor: one step runs
  `SPORTSDESK_KEYCHAIN_TRACE=1 bun test tests/` and fails on any `[keychain] denied` line whose call
  site is not `tests/keychain_boundary.test.ts`; a second step runs `bun --no-env-file test tests/`
  to prove the 1Password-mounted `.env` FIFO is inert for tests.

Measured 2026-11-04: `SPORTSDESK_KEYCHAIN_TRACE=1 bun test` over the full suite → **0
`[keychain] denied` lines** across **2,817 tests / 320 files (2,768 pass, 49 skip, 0 fail)**. The
boundary gate silences its own trace while asserting the denied path, so the suite-wide invariant
needs no file exclusion. The CI-made `.env`-off run (`bun --no-env-file test tests/ --parallel`)
also passes (2,121 tests, 0 fail), which required marking `Bun.s3` members volatile in
`lib/bun_shapes.ts` — its prototype surface depends on whether S3/R2 credentials were present at
startup. Before this change, importing
`capabilities.ts` ran the `dx-probe` set/get/delete during module init in every worker that loaded
one of the 8 importing test files, which is the keychain pressure Finding 6 recorded (with
`--parallel`, up to one probe per worker; serial, one per run).

The boundary is runtime, not only convention: `NODE_ENV=test` is set by `bun test`, and `Bun.main`
identifies the test entrypoint even if a caller overwrites `NODE_ENV`. `bun run <script>` (no test
context) is still allowed to read the keychain, which is what the CLIs and daemons need.
