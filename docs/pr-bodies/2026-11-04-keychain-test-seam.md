## Keychain test seam (not the contract-module rewrite)

One guarded boundary for OS-keychain access, so a test process can never touch the operator's
keychain. This is the **test seam** the audit's §7 recommended, done at the boundary layer rather
than per-callsite.

### Root cause

- `tests/support/capabilities.ts` ran a real `Bun.secrets.set/get/delete` round-trip **at module
  import** (top-level `await`), inherited by 8 test files — the recurring macOS keychain prompt.
- Three tests passed `secrets: null`, making `lib/f402_credentials_policy.ts` spawn the real
  `security find-generic-password`.
- Every reader's default parameter was raw `Bun.secrets` (`lib/secrets.ts`, `lib/r2_s3_client.ts`,
  `lib/f402_credentials_policy.ts`, `scripts/capture/f402_login.ts`, `scripts/live_positions_cron.ts`,
  `services/supervisor.ts`). The "injectable seam" was convention, never enforcement.

### What changed

- `lib/keychain_access.ts`: single boundary. Denies when `NODE_ENV=test` (set by `bun test`), when
  `Bun.main` is a `.test.ts`/`tests/` entrypoint (still denies if a `.env` overwrites `NODE_ENV`), or
  when `SPORTSDESK_KEYCHAIN_ACCESS=deny`. Denied reads → `null`; denied writes →
  `KeychainAccessDeniedError`. `guardedSecrets` is the default everywhere; the two `security`
  spawns call `platformKeychainAllowed()` first.
- **Production is explicitly allowed**: tests pin production/staging/unset/unknown `NODE_ENV` and an
  empty `Bun.main` as allowed — deny happens only on a provable test signal.
- `tests/support/capabilities.ts`: probe is opt-in only (`SPORTSDESK_KEYCHAIN_PROBE=1` +
  `SPORTSDESK_KEYCHAIN_ACCESS=allow`); no import-time I/O.
- `tests/keychain_boundary.test.ts`: behaviour + static reachability gate — dot/bracket/destructured/
  bare `Bun.secrets` refs, `import { secrets } from "bun"`, dynamic-import/require bindings, namespace
  aliases, unguarded `security` spawns. Scans tracked + untracked live-tree
  `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`; `node_modules/`, `.worktrees/`, `.agents/` are excluded
  from pass/fail and stale copies are counted/reported (40 files at review time).
- `SPORTSDESK_KEYCHAIN_TRACE=1` logs `[keychain] allowed|denied …` with call site; CI fails the suite
  on any `denied` line.
- CI adds two steps: trace-instrumented suite (fails on keychain access) and
  `bun --no-env-file test tests/` (proves the 1Password-mounted `.env` FIFO is inert for tests).
- `bin/check-format.ts`: fixes pre-existing gate coupling — `bun fmt --check` walked **untracked**
  files, so one contributor's scratch file turned `format:check` red for everyone. The gate now
  checks `git ls-files` (index) with `--ignore-unknown`; `tests/format_gate_scope.test.ts` pins it.
- `e559dbc`: the `.env`-off CI run exposed that `Bun.s3`'s singleton member surface depends on
  whether S3/R2 credentials were present at startup. `s3` is now in `VOLATILE_SHAPES` (nine members
  are pinned directly by `tests/bun_s3client_contract.test.ts`); the class `S3Client` surface remains
  snapshotted. The shape catalogue already kept `S3Client` (class) and `s3` (singleton) as separate
  entries — the credentials dependence was only in the singleton member snapshot.
- Lint debt cleared: all 11 pre-existing warnings fixed (`lint:check` now green).

### Branch and commit scope

All commits are on `feat/secrets-keychain-hardening` (none on `main`): the boundary commits
(`3a917c4`, `e559dbc`, `4266e6b`, `fc4be7a`), the env/test-isolation commits (`fb9e958`,
`e1731f9`, `6eaff06`, `a3aad6b`), and the runbook docs (`cacac31`, plus the env-failure-mode doc
commit). `origin/main` is 2 commits ahead (`9611ba2`, `4b11eb5` — both docs/chore), so the branch
needs a merge/rebase from `main` before it is merged, not a split PR.

### Verification

- Full suite in a clean worktree at `4266e6b` (data snapshots symlinked):
  `SPORTSDESK_KEYCHAIN_TRACE=1 bun test` → **2,809 tests, 2,760 pass, 49 skip, 0 fail,
  0 `[keychain] denied`**
- Format-gate commit `fc4be7a` re-validated in a clean worktree: `bun run format:check` ✅ and
  `tests/format_gate_scope.test.ts` + `tests/keychain_boundary.test.ts` → 17 pass, 0 fail
- `bun --no-env-file test tests/ --parallel` → 2,121 tests, 0 fail
- `format:check` ✅ · `typecheck` (804 files) ✅ · `lint:check` (0 warnings) ✅ · `check:secrets` ✅
- `test:docs` ✅ · `verify:docs` 9/9 PASS
- In the live tree during review, 3 unrelated `/api/csrf` failures came from another session's
  uncommitted route-table edit; those tests pass 43/43 at this HEAD.

### Explicit scope: this is NOT "audit §7 done"

| Audit §7 item | Status in this PR |
|---|---|
| Single contract module | **Done earlier (`7f0353f`, verified)**: `lib/secrets.ts` owns services/entries/reads/writes/deletes; this PR consumes it |
| Break `lib → scripts` imports | **Not done** — still present (e.g. `lib/blob_ingest.ts:28`, `lib/gslive_session.ts:20`) |
| GSID legacy contract | **Done earlier (`7f0353f`, verified)**: one `GSID_SERVICES` walk; audit §12 Finding 1 |
| One bounded writer | **Partial** — `secretSetOptions` bounds + `persist: "local"`; partial-pair write is still possible (Finding 10) |
| Entry guards | **Done earlier (`f7f1673`, verified)**: `import.meta.main` on all four CLIs, pinned by `tests/secrets_cli_import_guards.test.ts` |
| Test seam | **Done — this PR** |
| Child env (`buildMinimalSpawnEnv`) | **Not done** — Finding 7 |
| Docs | **Partial** — AGENTS, Bun reference, audit updated; runbooks and `lib/onepassword_session_bridge.ts` header still stale (Finding 8) |

### Note on `data/STALE.md`

`data/STALE.md` is another process's untracked snapshot document, not part of this PR. A previous
turn formatted it to appease the old untracked-walking gate — the wrong fix; original bytes are not
recoverable because the file is untracked with no baseline. The tracked-only gate added here no
longer reads it, and it remains untracked/uncommitted. The owner should regenerate or rewrite it if
the original matters.

### Next (in reordered order)

1. **`authenticateCustomer` capture** (P3). Blocked in this repo's sanctioned path:
   `scripts/capture/allowlist.ts:108` deliberately refuses auth-exchange (`AllowlistError("auth-exchange")`)
   and there is no generic live runner for it. Needs a purpose-built, redacted one-off probe plus one
   live credential use — the smallest empirical step and it decides whether a bearer path exists at
   all.
2. **F402 player-credential reader decision** — name the workstream explicitly: add a writer for
   `f402-player-*` or delete the env-only player read path. (Canonical-first agent credentials already
   landed in `d24b866`.)
3. **`--from-keychain` (session-cookie only)** — scope claim is "3c + `gslive:audit-bet`", not
   3a/3b/3d, until the capture says otherwise.
