# AGENTS.md — sportsdesk-ops

Operator tooling for the Fantasy402 sports desk: ingestion, settlement, combo/CLV analytics, the R2
portal and the VPS service. 790 tracked TypeScript files (318 test files), 186 files under
`scripts/`. Bun **1.4.4**.

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
bun run audit:secrets
bun run bun:docs-mcp surfaces --check tests/bun_docs_surface_baseline.json
bun run audit:ops
bun run artifacts:lock
bun run tasks:render --no-color --columns 0 >/dev/null && bun run docs:render
bun run gen:tokens:gate
bun bin/check-fetch-init.ts --verbose
bun bin/check-innerhtml.ts --verbose
CI=true bun run schema:gate
bun test tests/
bun test                                        # not in CI: also runs the colocated tests
```

`bun run ci:local` replays that chain in order (`--list`, `--keep-going`, `--install`); prefer it
over assembling the steps by hand. Actions do run on this repo (2026-11-02: PR #10's `verify` job
ran and failed at `format:check`); because the job stops at the first failing step, a red early
step hides every later one.

Before a long gate run, `bun run agent:doctor` reports the gaps that otherwise surface one failed
call at a time: worktree `node_modules`, the gitignored `enriched_customers_full.json`, feed
provenance, dist staging, graphviz, a headless browser, the `:4020` daemon, sandbox write access
and the Pages deploy token. The agent tool-call audit lives in
[`docs/runbooks/agent_tool_friction.md`](docs/runbooks/agent_tool_friction.md) and is reproducible
with `bun run audit:tool-calls`.

## Agent friction quick reference

- **Read immediately before `edit`.** `bun fmt`, `docs:stage`, `artifacts:value` and the feed
  poller rewrite tracked files; a read taken before them is stale (`FS_STALE_VERSION`). Re-read
  after any formatter/generator.
- **`write` for new files, `edit` for existing ones.** `FS_NOT_OBSERVED` means this session has
  not read the file: read it, then retry (one extra call, not a workaround).
- **Writes outside the workspace are denied** (for example `~/.dsh`). The pre-push gate still
  runs; only its log/proof-cache writes fail. Do not retry them.
- **Stock Chrome does not start under the sandbox.** Verify pages with
  `./bin/dx shot <url> --out scratch/shots/x.png` (WebKit) or the Playwright headless shell with
  `--no-sandbox`; `agent:doctor` prints the available binary.
- **Citations pin line numbers.** Insert code below cited ranges or re-point anchors in
  `docs/evidence/ledger.json` plus the citing docs; `bun run check:spec-citations` names the
  corrected range when an anchor drifts.
- **Feed-only refresh:** `graph_feed_poller_daemon.ts --once --live --no-backtest-artifact`
  (under `scripts/`) so a live refresh does not rewrite the committed 4-week backtest artifact.
- **Deploy credentials** come from `./cloudflare.env` or `$XDG_CONFIG_HOME/cloudflare/pages.env`;
  never source `.env` (1Password FIFO plus R2/F402 secrets that shadow the Pages token).

## Layout

`lib/` (ingestion, settlement, combo identity, venue stores) · `bin/` (dx, linters) ·
`tests/` (237 `*.test.ts` suites plus fixtures) plus **81 colocated tests in `lib/` and
`scripts/`** (CI only runs `tests/`, so run `bun test` before pushing) · `packages/` · `design/` · `schema/` · `infra/` ·
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
- **Tests never read the real keychain.** `./bin/dx exec --with <group|NAME>` reads it for any name
  missing from the environment, and no source scan sees a shell wrapper. A test may call it only
  with every requested name already set in the spawned environment (see `tests/dx_cli.test.ts`);
  otherwise inject through a fake provider (`lib/secret_env.ts` takes `read`).
- **Never set `BUN_CONFIG_VERBOSE_FETCH` while the process holds a bearer token, session cookie or
  keychain-injected secret.** Bun's docs say it logs request headers verbatim (`Authorization`,
  `Cookie`), and a cron or daemon sends them on to its log files. Use `--dry-run` output or the
  capture fixtures; `scripts/wagers_by_state_capture.ts` already limits it to loopback.
- **A new secret-like environment variable goes in `lib/secret_manifest.ts`.** Names ending in
  `_TOKEN`, `_SECRET`, `_PASSWORD`, `_COOKIE`, `_SESSION` or `_API_KEY` must be registered; `_KEY`,
  `_KEY_ID` and `_ID` must be registered or listed in `NON_SECRET_ALLOWLIST` with a reason. Run
  `bun run audit:secrets` (`--explain NAME`, `--report-only`); `bun run secrets:env status --all`
  lists every entry and where its value would come from.
- **Token/secret work** goes through the documented SSOT path; `.1password/environments.toml` is
  wired by `code-project sync-environments --apply` (2026-11-02: it carries an environment id and
  `.env` is a 1Password-mounted pipe on the operator machine). Do not hand-write secrets into the
  repo.
- `gs-manager-cli.zip` (31 KB) is untracked junk — do not commit it.
- `~/platform` is an external policy checkout (pinned SHA in `.github/workflows/ci.yml`); without
  it `policy`-based scripts fail. Say so instead of disabling them.

## Doc ownership

`README.md` = orientation + the runbook tree · the seven root runbooks = operational procedure ·
`docs/` = long-form. Move procedure into `docs/` rather than growing the root.
