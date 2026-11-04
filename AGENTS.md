# AGENTS.md — sportsdesk-ops

Operator tooling for the Fantasy402 sports desk: ingestion, settlement, combo/CLV analytics, the R2
portal and the VPS service. 397 TypeScript files, 89 scripts, 139 tests. Bun **1.4.4**.

## Entrypoint and the gate chain

`./bin/dx` is the operator entrypoint (`README.md:11-15`); `scripts/deploy/deploy_to_vps.sh` / `./bin/dx deploy`
ship to the VPS. CI (`.github/workflows/ci.yml`, job `verify`) runs these steps in order and stops
at the first failure — reproduce them locally before claiming a change works:

```sh
bun run verify:manager-oracle-slices
bash scripts/ci/run-manager-oracle-gates.sh
bun test lib/f402_har_redaction_proof_verify.test.ts
bun run format:check
bun run typecheck
bun run lint:check
bun run test:docs
bun run verify:docs
bun run check:route-surface
bun run check:secrets
bun run bun:docs-mcp surfaces --check tests/bun_docs_surface_baseline.json
bun run audit:ops
bun run artifacts:lock
bun run tasks:render --no-color --columns 0 >/dev/null && bun run docs:render
bun run gen:tokens:gate
bun bin/check-fetch-init.ts --verbose
bun bin/check-innerhtml.ts --verbose
CI=true bun run schema:gate
bun run census:3d:check
bun test tests/
SPORTSDESK_KEYCHAIN_TRACE=1 bun test tests/     # CI: fails on any "[keychain] denied" line
bun --no-env-file test tests/                   # CI: proves the mounted .env is inert for tests
bun test                                        # not in CI: also runs the colocated tests
```

There is **no single `check` script**, so a local run has to be assembled. Actions do run on this
repo (2026-11-02: PR #10's `verify` job ran and failed at `format:check`); because the job stops at
the first failing step, a red early step hides every later one.

## Layout

`lib/` (ingestion, settlement, combo identity, venue stores) · `bin/` (dx, linters) ·
`tests/` (84 files) plus **colocated tests in `lib/` and `scripts/`** (~55 more — CI only runs
`tests/`, so run `bun test` before pushing) · `packages/` · `design/` · `schema/` · `infra/` ·
`docs/` · root runbooks (runtime shapes, guardrails, token architecture, R2/API, VPS domain).

## Hard rules

### ⚠️ SECURITY WARNING (Fantasy402 session)

Never paste **Bearer JWTs**, live cookies, or portal passwords into chat, commits, or scripts.
Revoke any token that was exposed. Live manager API calls must use **`createF402ReplayTransport()`**
(WebView profile / session file / replay proxy) — see `lib/f402_agent_policy.ts` and
`docs/evidence/agent-graph-operator.md`. Agent graph CLI: **`bun run graph:agent`** (no `--token` flags).

- **Production is read-only unless the task is explicitly a deploy.** Probe with `./bin/dx`, never
  mutate live data to make a number look right.
- **Evidence labelling:** any claim in docs or commits states what was measured and when. The docs
  gates exist because fabricated contracts shipped before.
- **Token/secret work** goes through the documented SSOT path; `.1password/environments.toml` is
  wired by `code-project sync-environments --apply` (2026-11-02: it carries an environment id and
  `.env` is a 1Password-mounted pipe on the operator machine). Do not hand-write secrets into the
  repo.
- **Keychain boundary:** `lib/keychain_access.ts` is the only module allowed to call
  `Bun.secrets.*`. The two `security find-generic-password` spawns (`lib/f402_credentials_policy.ts`,
  `scripts/secrets_r2.ts`) must call its `platformKeychainAllowed()` first. Never read the OS
  keychain from a test or an import side effect — tests inject a fake reader; the boundary denies
  test processes via `NODE_ENV=test` and `Bun.main`. `SPORTSDESK_KEYCHAIN_TRACE=1 bun test` must
  print no `[keychain] denied` line at all (the gate silences its own trace), and
  `tests/keychain_boundary.test.ts` fails on a direct call outside the boundary.
- `gs-manager-cli.zip` (31 KB) is untracked junk — do not commit it.
- `~/platform` is an external policy checkout (pinned SHA in `.github/workflows/ci.yml`); without
  it `policy`-based scripts fail. Say so instead of disabling them.

## Doc ownership

`README.md` = orientation + the runbook tree · the seven root runbooks = operational procedure ·
`docs/` = long-form. Move procedure into `docs/` rather than growing the root.
