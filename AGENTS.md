# AGENTS.md — sportsdesk-ops

Operator tooling for the Fantasy402 sports desk: ingestion, settlement, combo/CLV analytics, the R2
portal and the VPS service. Bun **1.4.4** (`package.json` `engines.bun` / `.bun-version`).

## Entrypoint and the gate chain

`./bin/dx` is the operator entrypoint (`README.md:11-15`); `scripts/deploy/deploy_to_vps.sh` / `./bin/dx deploy`
ship to the VPS. CI job **`verify`** runs the steps below in order and stops at the first failure.
Job **`market-index`** is the required check on `main` for catalog edits (`bun run test:market-index`).
Reproduce them locally before claiming a change works:

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
bun run test:market-index                       # CI: Validate market index (REQUIRE_MARKET_INDEX=1)
bun test tests/ --path-ignore-patterns='**/market_index.test.ts'
bun test                                        # not in CI: also runs the colocated tests
```

When you change `market/**`, `package.json` devDeps for `@deepseek-ai/dsh-plugin-market-index`, or
`.github/workflows/ci.yml` market steps, run **`bun run test:market-index`** first. Discover
contract: [market/README.md](market/README.md). Upstream format:
[DSH plugin market index Agent Note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md).

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

- **Anchor to the checkout root (`git rev-parse --show-toplevel`).** Always write repository code,
  tests, and config inside the repository worktree — never into an isolated agent `$HOME` directory.
- **Derive counts, never hardcode them in prose or code.** File, test, rule, and plugin counts drift
  on every commit; state behavioral contracts instead and let `bun test`, `Bun.Glob`, or the
  committed baseline files (`tests/bun_docs_surface_baseline.json`, `docs/artifacts.lock.json`)
  enforce exactness.
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
- **`bun:bundle` AST constraint:** `feature()` from `"bun:bundle"` can only appear directly
  inside an `if` condition or ternary (`feature("FLAG") ? true : false`). Passing it directly to
  functions (like `expect()` or `expectTypeOf()`) fails at parse time. Testing `--feature=FLAG`
  requires subprocess spawning (`Bun.spawnSync`), as flags cannot be toggled mid-process.

## DSH Discover (plugin market index)

Five Cordis bundles under `dsh-plugin*` are listed in **`market/index.json`** for the Harness
**Discover** tab (not for the `web` ops host by default — see `dsh-ops/notes/PROFILES.md`).

- Enable **Custom plugin indexes** in Harness **Plugins → Experimental** before adding an index URL.
- Catalog field for “publisher” is **`author`** (`Sportsdesk Ops` on every row).
- Install reproducibility is **`versions[].source.commit`**, not the index URL; keep `market-pin-*`
  tags when pins are branch-only until merged to `main`.
- Operator URL policy and cache behavior: **`market/README.md`** · cross-host notes:
  **`$CODE_ROOT/dsh-ops/notes/SPORTSDESK-MARKET.md`**.

## Signal honesty

Architecture and review standard: [docs/architecture/signal-honesty.md](docs/architecture/signal-honesty.md).
PRs should complete the **Signal Honesty Checklist** in
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).

### Nov 2026 — nine “lies by omission” fixes (institutional memory)

Do not delete these contracts as redundant without reading the ADR:

1. **#69 / #85** — Fixture isolation; `jobFailure()` must not swallow child stdout.
2. **#73 / #74** — KPI provenance: pending vs fixture vs live.
3. **#75** — Replay transport 401 retry.
4. **#87** — `--fetch-mode` wired; session/bearer fallback for getWebLog.
5. **#88** — `resolveF402BetsJsonlPath` (env → operator default).
6. **#89** — Reject weblog Mode B/I (shared-IP ≠ activity stream).
7. **#90 / #92** — Weblog cron `--from` + three-tier corpus; publish data-window log line.
8. **#84 / GSID** — Multi-sink R2 recovery; canonical `GSLIVE_SESSION_ID`; wagers two-step (`--live` + `wagers:publish-snapshot`).
9. **#91** — Weblog corpus: manual portal export + `weblog:sentinel` (08:00 Telegram if today's JSONL missing); not headless Mode A fetch.
10. **#93** — Wire wagers capture + `publish-snapshot` into cron (open).
11. **#94** — `bridge3c` `--timeout` for large `getBetReport` (open).
12. **#78** — KPI data-age vs R2 `Last-Modified` (open).
13. **Desk Host `apiPort`** — Cordis `config.apiPort` wired in `dsh-plugin-sidebar/index.js` (`resolveDeskOrigin`); default 4020.

## Layout

`lib/` (ingestion, settlement, combo identity, venue stores) · `bin/` (dx, linters) ·
`market/` (format-1 index for Discover) ·
`tests/` (`*.test.ts` suites plus fixtures) plus **colocated `*.test.ts` suites in `lib/` and
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
- **Bun-native policy ratchet removed 2026-11-09 (operator decision).** `bun run policy:check`,
  the `~/platform` checkout it required, the pinned `PLATFORM_SHA` and the `PLATFORM_DEPLOY_KEY`
  CI secret are gone. The rules it enforced (`zod-not-guard-calls`, `bun-env`, `node-fs-read-write-file`
  and the rest) are now a review convention, **not a gate**: nothing fails when they are violated.
  When the ratchet was removed it was reporting 239 matches over the frozen baseline across 91
  files (137 of them `zod-not-guard-calls`). Reintroducing it means restoring the copy, the
  baseline and a decision about that debt — not just re-adding a step.

### Data-handling budgets

- Live captures `data/live-bets.json` and `data/live-wagers.json` stay **untracked**; `positions:cron` rewrites them with customer logins. Tests use `tests/fixtures/fraud/live-*.json` or `tests/fixtures/live-wagers.partial.json`. `tests/data_artifacts_tracking.test.ts` fails if either path is tracked again.
- Hot aggregation over roughly 10k+ rows uses fixed-capacity TypedArray arenas: no `Map`, `Set`, `boolean[]`, or growing `T[]` on the aggregation path. Reference: `lib/gslive_tally_rollup.ts`; ratchet: `tests/tally_allocation_invariant.test.ts` (0 collection allocations).
- Dense flags are `Uint32Array` bitsets. Do not add `boolean[]` to runtime aggregation; `lib/fraud_model.ts` is the remaining known exception and is marked for replacement in the audit.
- DOD6 reader: `lookupInto(login, target)` in per-row loops; `lookup()` allocates a result and handle union per call. Handles are opaque; use `rowOfHandle`, never sort by handle.
- Large fixtures (for example the 12 MB `tests/fixtures/f402-general-oracle-production.json`) must not be read whole in a request path; stream them or crop a test slice.
- Run `bun run audit:data-handling` before adding a collection or a >1 MB artifact to a hot path. The audit is advisory; the tests above are the contracts.

## Doc ownership

`README.md` = orientation + the runbook tree · the root runbooks = operational procedure ·
`docs/` = long-form. Move procedure into `docs/` rather than growing the root.
