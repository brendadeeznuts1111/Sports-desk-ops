# AGENTS.md — sportsdesk-ops

Operator tooling for the Fantasy402 sports desk: ingestion, settlement, combo/CLV analytics, the R2
portal and the VPS service. Bun **1.4.4** (`package.json` `engines.bun` / `.bun-version`).

The notes below were measured on the `1.4.4-canary.1` build this checkout runs. Where a claim is
scoped to a version, re-check it before relying on it for the stable tag.

## Verification loop

### Inner loop — during development

Pull requests run **`verify-changed`** (`bun run test:changed` + `test:changed-plugins`), not the
full `main`-branch ratchet. Never run the whole suite (`bun test` / `bun test tests/`) on iterative
edits; use **`bun run verify:fast`**:

```sh
bun run verify:fast          # auto-format changed files + typecheck (.ts+.tsx) + scoped oxlint +
                             # path-triggered gates + test:changed, in parallel (~1–2s)
bun run test:changed         # parallel changed-only tests
bun run test:shard           # parallel head shard (1/8) when root configs are dirty
```

### Full `main`-branch chain — pre-merge or scheduled only

`./bin/dx` is the operator entrypoint (`README.md` §"Day-1 Operator Onboarding");
`scripts/deploy/deploy_to_vps.sh` / `./bin/dx deploy` ship to the VPS. CI job **`verify`** runs the
chain in order on `main` pushes and scheduled cadences and stops at the first failure. Job
**`market-index`** is the required check on `main` for catalog edits.

`bun run ci:local` replays the sequence below (`--list`, `--keep-going`, `--install`); prefer it to
assembling the steps by hand. This block is the canonical order:

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
bun bin/check-signal-honesty.ts --verbose
CI=true bun run schema:gate
bun run test:market-index                       # CI: Validate market index (REQUIRE_MARKET_INDEX=1)
bun test tests/ --path-ignore-patterns='**/market_index.test.ts'
bun test                                        # not in CI: also runs the colocated tests
```

Actions do run on this repo (2026-11-02: PR #10's `verify` job ran and failed at `format:check`);
because the job stops at the first failure, an early red step hides every later one.

When you change `market/**`, the `@deepseek-ai/dsh-plugin-market-index` devDep, or the market steps
in `.github/workflows/ci.yml`, run **`bun run test:market-index`** first. Discover contract:
[market/README.md](market/README.md). Upstream format:
[DSH plugin market index Agent Note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md).

### Before a long run

`bun run agent:doctor` reports the gaps that otherwise surface one failed call at a time: worktree
`node_modules`, blocked dependency lifecycle scripts (`bun pm untrusted` exits 0 either way, so a
skipped native build is otherwise silent), the gitignored `enriched_customers_full.json`, feed
provenance, dist staging, graphviz, a headless browser, the `:4020` daemon, sandbox write access and
the Pages deploy token. The tool-call audit lives in
[`docs/runbooks/agent_tool_friction.md`](docs/runbooks/agent_tool_friction.md) and is reproducible
with `bun run audit:tool-calls`.

## Agent friction quick reference

**Workspace and edits**

- **Anchor to the checkout root (`git rev-parse --show-toplevel`).** Write repository code, tests
  and config inside the worktree — never into an isolated agent `$HOME` directory.
- **Read immediately before `edit`.** `bun fmt`, `docs:stage`, `artifacts:value` and the feed
  poller rewrite tracked files; a read taken before them is stale (`FS_STALE_VERSION`). Re-read
  after any formatter or generator.
- **`write` for new files, `edit` for existing ones.** `FS_NOT_OBSERVED` means this session has not
  read the file: read it, then retry — one extra call, not a workaround.
- **Writes outside the workspace are denied** (for example `~/.dsh`). The pre-push gate still runs;
  only its log and proof-cache writes fail. Do not retry them.
- **Derive counts, never hardcode them.** File, test, rule and plugin counts drift on every commit.
  State the behavioural contract and let `bun test`, `Bun.Glob` or the committed baselines
  (`tests/bun_docs_surface_baseline.json`, `docs/artifacts.lock.json`) enforce exactness. Prefer
  generating an inventory from its source over writing one down.

**Evidence and citations**

- **Citations pin line numbers.** Insert code below cited ranges, or re-point anchors in
  `docs/evidence/ledger.json` plus the citing docs. `bun run check:spec-citations` names the
  corrected range when an anchor drifts; `--sync-anchors` applies the unambiguous moves (anchor
  occurs exactly once in the file, span preserved). Ambiguous or vanished anchors still fail —
  they do not identify one site.
- **Evidence labelling:** any claim in docs or commits states what was measured and when. The docs
  gates exist because fabricated contracts shipped before.

**Bun toolchain**

- **Linting is `oxlint` today; native `bun lint` exists.** `bun run lint:check` runs oxlint twice —
  `.oxlintrc.json`, then `.oxlintrc.type-aware.json` passed explicitly as
  `-c .oxlintrc.type-aware.json` (it is not auto-discovered). On this build `bun lint` is a real
  subcommand, but the repo's `"lint"` script shadows it: `bun lint` runs that script, so reach the
  built-in with `bun lint --no-script <flags>`. `--doctor` reports which configured rules run
  natively and which packages are removable; this checkout's answer is that `oxlint-tsgolint` can
  go, while `oxlint` stays because the script runs it — keep `oxlint` in `devDependencies` for
  editor LSP (`oxlint --lsp`). The older note that `"lint": "bun lint"` recurses does **not**
  reproduce on this build — re-check before trusting either claim on the stable tag.
- **`bun:bundle` AST constraint:** `feature()` from `"bun:bundle"` can only appear directly inside
  an `if` condition or ternary (`feature("FLAG") ? true : false`). Passing it to functions like
  `expect()` or `expectTypeOf()` fails at parse time. Testing `--feature=FLAG` requires subprocess spawning
  (`Bun.spawnSync`); flags cannot be toggled mid-process.
- **`Bun.semver` vs npm `semver`:** `Bun.semver.satisfies` takes only `(version, range)` and does
  NOT support `{ includePrerelease: true }`. The npm `semver` package in `devDependencies` is required by
  `tests/market_index.test.ts` to match upstream Harness install behaviour. Do not swap it out.

**Environment and tooling**

- **Stock Chrome does not start under the sandbox.** Verify pages with
  `./bin/dx shot <url> --out scratch/shots/x.png` (WebKit) or the Playwright headless shell with
  `--no-sandbox`; `agent:doctor` prints the available binary.
- **Deploy credentials** come from `./cloudflare.env` or `$XDG_CONFIG_HOME/cloudflare/pages.env`.
  Never source `.env` — it is a 1Password FIFO carrying R2/F402 secrets that shadow the Pages token.
- **Feed-only refresh:** `graph_feed_poller_daemon.ts --once --live --no-backtest-artifact` (under
  `scripts/`) so a live refresh does not rewrite the committed 4-week backtest artifact.

**Git**

- **Squash-merge branch audit:** commit SHAs diverge from `main`. Do not rely on `git cherry` or
  `git branch --merged` alone; cross-reference PR titles via `gh pr list --state all` or merge-base
  file diffs. Before deleting a branch checked out in an auxiliary worktree, detach HEAD or prune
  the worktree without touching dirty files.

## DSH Discover (plugin market index)

The `dsh-plugin*` bundles are listed in **`market/index.json`** for the Harness **Discover** tab —
not for the `web` ops host by default (see `$CODE_ROOT/dsh-ops/notes/PROFILES.md`).

- Enable **Custom plugin indexes** in Harness **Plugins → Experimental** before adding an index URL.
- The catalog's publisher field is **`author`** (`Sportsdesk Ops` on every row).
- Install reproducibility is **`versions[].source.commit`**, not the index URL; keep `market-pin-*`
  tags when a pin is branch-only until it merges to `main`.
- Operator URL policy and cache behaviour: **`market/README.md`** · cross-host notes:
  **`$CODE_ROOT/dsh-ops/notes/SPORTSDESK-MARKET.md`**.

## Signal honesty

Architecture and review standard: [docs/architecture/signal-honesty.md](docs/architecture/signal-honesty.md).
PRs complete the **Signal Honesty Checklist** in
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).

### Nov 2026 — the "lies by omission" contracts (institutional memory)

Do not delete these as redundant without reading the ADR:

1. **#69 / #85** — Fixture isolation; `jobFailure()` must not swallow child stdout.
2. **#73 / #74** — KPI provenance: pending vs fixture vs live.
3. **#75** — Replay transport 401 retry.
4. **#87** — `--fetch-mode` wired; session/bearer fallback for getWebLog.
5. **#88** — `resolveF402BetsJsonlPath` (env → operator default).
6. **#89** — Reject weblog Mode B/I (shared-IP ≠ activity stream).
7. **#90 / #92** — Weblog cron `--from` + three-tier corpus; publish data-window log line.
8. **#84 / GSID** — Multi-sink R2 recovery; canonical `GSLIVE_SESSION_ID`; wagers two-step
   (`--live` + `wagers:publish-snapshot`).
9. **#91** — Weblog corpus: manual portal export + `weblog:sentinel` (08:00 Telegram if today's
   JSONL is missing); not headless Mode A fetch.
10. **#93** — Wire wagers capture + `publish-snapshot` into cron (`sched_bridge_rollup_15m` in
    `services/reporting_scheduler_service.ts`).
11. **#94** — `bridge3c` `--timeout` for large `getBetReport`
    (`scripts/gslive_tally_bridge3c.ts`).
12. **#78** — KPI data-age vs R2 `Last-Modified` (`lib/r2_pipeline_kpis.ts` /
    `lib/desk_enhanced_health.ts`).
13. **Desk Host `apiPort`** — Cordis `config.apiPort` wired in `dsh-plugin-sidebar/index.js`
    (`resolveDeskOrigin`); default 4020.

## Layout

`lib/` (ingestion, settlement, combo identity, venue stores) · `bin/` (dx, linters) ·
`market/` (format-1 index for Discover) · `tests/` (`*.test.ts` suites plus fixtures) ·
**colocated `*.test.ts` suites in `lib/` and `scripts/`** (CI runs only `tests/`, so run `bun test`
before pushing) · `packages/` · `design/` · `schema/` · `infra/` · `docs/` · root runbooks
(runtime shapes, guardrails, token architecture, R2/API, VPS domain).

## Hard rules

### ⚠️ SECURITY WARNING (Fantasy402 session)

Never paste **Bearer JWTs**, live cookies or portal passwords into chat, commits or scripts. Revoke
any token that was exposed. Live manager API calls must use **`createF402ReplayTransport()`**
(WebView profile / session file / replay proxy) — see `lib/f402_agent_policy.ts` and
`docs/evidence/agent-graph-operator.md`. Agent graph CLI: **`bun run graph:agent`** (no `--token`
flags).

- **Production is read-only unless the task is explicitly a deploy.** Probe with `./bin/dx`; never
  mutate live data to make a number look right.
- **Tests never read the real keychain.** `./bin/dx exec --with <group|NAME>` reads it for any name
  missing from the environment, and no source scan sees a shell wrapper. A test may call it only
  with every requested name already set in the spawned environment (see `tests/dx_cli.test.ts`);
  otherwise inject through a fake provider (`lib/secret_env.ts` takes `read`).
- **Never set `BUN_CONFIG_VERBOSE_FETCH` while the process holds a bearer token, session cookie or
  keychain-injected secret.** Bun logs request headers verbatim (`Authorization`, `Cookie`), and a
  cron or daemon sends them on to its logs. Use `--dry-run` output or the capture fixtures;
  `scripts/wagers_by_state_capture.ts` already limits it to loopback.
- **A new secret-like environment variable goes in `lib/secret_manifest.ts`.** Names ending in
  `_TOKEN`, `_SECRET`, `_PASSWORD`, `_COOKIE`, `_SESSION` or `_API_KEY` must be registered; `_KEY`,
  `_KEY_ID` and `_ID` must be registered or listed in `NON_SECRET_ALLOWLIST` with a reason. Run
  `bun run audit:secrets` (`--explain NAME`, `--report-only`); `bun run secrets:env status --all`
  lists every entry and where its value would come from.
- **Token/secret work goes through the documented SSOT path.** `.1password/environments.toml` is
  wired by `code-project sync-environments --apply` (2026-11-02: it carries an environment id, and
  `.env` is a 1Password-mounted pipe on the operator machine). Do not hand-write secrets into the
  repo.
- **Bun-native policy ratchet removed 2026-11-09 (operator decision).** The `policy:check` ratchet,
  the `~/platform` checkout it required, the pinned `PLATFORM_SHA` and the `PLATFORM_DEPLOY_KEY` CI
  secret are gone. The rules it enforced (`zod-not-guard-calls`, `bun-env`,
  `node-fs-read-write-file` and the rest) are now a review convention, **not a gate** — nothing
  fails when they are violated. It was reporting 239 matches over the frozen baseline across 91
  files (137 of them `zod-not-guard-calls`). Reintroducing it means restoring the copy, the
  baseline and a decision about that debt, not just re-adding a step.

### Data-handling budgets

- Live captures `data/live-bets.json` and `data/live-wagers.json` stay **untracked**; `positions:cron`
  rewrites them with customer logins. Tests use `tests/fixtures/fraud/live-*.json` or
  `tests/fixtures/live-wagers.partial.json`. `tests/data_artifacts_tracking.test.ts` fails if either
  path is tracked again.
- Hot aggregation over roughly 10k+ rows uses fixed-capacity TypedArray arenas: no `Map`, `Set`,
  `boolean[]` or growing `T[]` on the aggregation path. Reference: `lib/gslive_tally_rollup.ts`;
  ratchet: `tests/tally_allocation_invariant.test.ts` (0 collection allocations).
- Dense flags are `Uint32Array` bitsets. Do not add `boolean[]` to runtime aggregation.
- DOD6 reader: `lookupInto(login, target)` in per-row loops; `lookup()` allocates a result and a
  handle union per call. Handles are opaque; use `rowOfHandle`, never sort by handle.
- Large fixtures (for example the 12 MB `tests/fixtures/f402-general-oracle-production.json`) must
  not be read whole in a request path; stream them or crop a test slice.
- Run `bun run audit:data-handling` before adding a collection or a >1 MB artifact to a hot path.
  The audit is advisory; the tests above are the contracts.

## Doc ownership

`README.md` = orientation + the runbook tree · the root runbooks = operational procedure ·
`docs/` = long-form. Move procedure into `docs/` rather than growing the root.
