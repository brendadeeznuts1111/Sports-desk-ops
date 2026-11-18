# AGENTS.md — sportsdesk-ops

Operator tooling for the Fantasy402 sports desk: ingestion, settlement, combo/CLV analytics, the R2
portal and the VPS service. Bun **1.4.4** (`package.json` `engines.bun` / `.bun-version`).

The pinned runtime is stable `1.4.4+38afee6c8`. Some notes below were first measured on canary
builds (`1.4.4-canary.1`, `1.4.5-canary.1`); where a behaviour exists only on a canary the note says
so. Re-check any version-scoped claim against the pin before relying on it.

## Verification loop

### Inner loop — during development

Pull requests run **`verify-changed`** (`bun fmt --check --changed`, `typecheck`, `lint:check`,
`check:derived-contracts`, `verify:docs`, `test:changed`, `test:pm-contracts`,
`test-changed-plugins`, `test-changed-nsh`, and `check:profile-code-mode-host-seal`), not the
full `main`-branch ratchet. Never run the whole suite (`bun test` / `bun test tests/`) on iterative
edits; use **`bun run verify:fast`**:

```sh
bun run verify:fast          # auto-format (bun fmt) changed files + typecheck (.ts+.tsx) + scoped
                             # oxlint (--deep adds --type-aware) + path-triggered gates +
                             # test:changed, in parallel (~1–2s); --check for read-only fmt check
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
bun run --filter '@sportsdesk-ops/contracts' build
bun run verify:manager-oracle-slices
bash scripts/ci/run-manager-oracle-gates.sh
bun test lib/f402_har_redaction_proof_verify.test.ts
bun run format:check
bun run typecheck
bun run lint:check
bun run check:derived-contracts
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
bash scripts/ci/install-nsh.sh && bun run nsh:doctor && bun run nsh:verify
CI=true bun run schema:gate
bun run test:market-index                       # CI: Validate market index (REQUIRE_MARKET_INDEX=1)
bun test tests/ --path-ignore-patterns='**/market_index.test.ts' --timings=config/test-timings.json
bun run test:db
bun test scripts/capture/webview.test.ts scripts/capture/cookies.test.ts
bun test --timings=config/test-timings.json      # not in CI: also runs all colocated tests
```

`config/test-timings.json` is a committed scheduling hint: with `--timings`, `--parallel` starts the
slowest files first, so the deliberate ~12.6 s SSE keepalive soak
(`tests/sportsdesk_mcp_server_soak.test.ts`) overlaps the rest of the suite instead of extending it
(plain `bun test` serializes it at the end and is ~12 s slower; measured 2026-11-17: 29.5 s vs 18.5 s).
`bun run test` merges it with the gitignored `.bun-test-timings.json`, which `--update-timings` rewrites.
Regenerate the committed baseline after large suite changes:
`bun test --parallel --timings=config/test-timings.json --update-timings`.

When you change `market/**`, the `@deepseek-ai/dsh-plugin-market-index` devDep, or the market steps
in `.github/workflows/ci.yml`, run **`bun run test:market-index`** first. Discover contract:
[market/README.md](market/README.md). Upstream format:
[DSH plugin market index Agent Note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md).

### Before a long run

`bun run agent:doctor` reports the gaps that otherwise surface one failed call at a time: worktree
`node_modules`, installed-package drift from `bun.lock` (the 2026-11-17 red-typecheck cause),
blocked dependency lifecycle scripts (`bun pm untrusted` exits 0 either way, so a
skipped native build is otherwise silent), the gitignored `enriched_customers_full.json`, feed
provenance, dist staging, graphviz, `Bun.WebView` availability, the `:4020` daemon, sandbox write
access and the Pages deploy token. The tool-call audit lives in
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
- **Regenerate derived artifacts from the committed state.** Generators that scan `git ls-files`
  (the shape catalogue, its runbook, the Bun docs baseline) cannot see an untracked file, so
  generating before staging writes an artifact CI rejects. Stage first, regenerate, commit both.

**Evidence and citations**

- **Citations pin line numbers.** Insert code below cited ranges, or re-point anchors in
  `docs/evidence/ledger.json` plus the citing docs. `bun run check:spec-citations` names the
  corrected range when an anchor drifts; `--sync-anchors` applies the unambiguous moves (anchor
  occurs exactly once in the file, span preserved). Ambiguous or vanished anchors still fail —
  they do not identify one site.
- **Evidence labelling:** any claim in docs or commits states what was measured and when. The docs
  gates exist because fabricated contracts shipped before.

**Bun toolchain**

- **Linting is `oxlint`; stable 1.4.4 has no native `bun lint`.** `bun run lint:check` runs oxlint
  twice — `.oxlintrc.json`, then `.oxlintrc.type-aware.json` passed explicitly as
  `-c .oxlintrc.type-aware.json` (it is not auto-discovered). On 1.4.4 a bare `bun lint` is not a
  subcommand: it resolves to the package `"lint"` script (`bun --bun run oxlint --fix`, which
  **rewrites files**), and `--no-script` does not bypass it — the flag is forwarded to oxlint
  (measured 2026-11-15). Outside a package.json it reports `Script not found "lint"`. Never run
  `bun lint` / `bun run lint` as a check; use `bun run lint:check`, or `bun run lint:bun` for a
  read-only wrapper that refuses the mutable path.
- **CI runs the native linter on a canary runtime:** job `lint-native` installs
  `bun-version: canary` and runs `bun run lint:native` / `bun run lint:native:type-aware` (both
  fail on 1.4.4 by design). The pin stays exact — one X.Y.Z across `.bun-version`, `engines.bun`,
  `packageManager` and `@types/bun`; `@types/bun` has no canary version. A native linter
  (`--no-script`, `--doctor`, `--type-aware`, `[lint]` in bunfig) exists only on the 1.4.5 canary
  (measured on `1.4.5-canary.1+ed4363334`); on 1.4.4 the `[lint]` block is inert.
- Keep `oxlint` in `devDependencies`: `lint`, `lint:check` and editors (`oxlint --lsp`) need it.
- **`bun:bundle` AST constraint:** `feature()` from `"bun:bundle"` can only appear directly inside
  an `if` condition or ternary (`feature("FLAG") ? true : false`). Passing it to functions like
  `expect()` or `expectTypeOf()` fails at parse time. Testing `--feature=FLAG` requires subprocess spawning
  (`Bun.spawnSync`); flags cannot be toggled mid-process.
- **`Bun.semver` vs npm `semver`:** `Bun.semver.satisfies` takes only `(version, range)` and does
  NOT support `{ includePrerelease: true }` (the third argument is ignored). A range is also
  **tuple-bound for prereleases**: `satisfies("1.4.5-canary.1", ">=1.4.4-0")` is `false` even
  though that build is newer than the floor. Gate a floor with
  `Bun.semver.order(v, "1.4.4-0") >= 0` — see `lib/manager_fetch.ts`. The npm `semver` package in
  `devDependencies` is required by `tests/market_index.test.ts` to match upstream Harness install
  behaviour. Do not swap it out.
- **`bun run` flag position & profiling flags:**
  - **Runtime & runner flags** (`--watch`, `--hot`, `--smol`, `--check`, `--bun`, `--console-depth=<val>`,
    `--inspect`, `--cpu-prof`, `--heap-prof`, `--no-env-file`) must appear **before** the target script or
    entrypoint (e.g. `bun --check run script.ts`, `bun run --bun vite`, or `bun --console-depth=5 dev`).
    Value flags must use `--flag=<val>` to avoid argument ambiguity.
  - **Always forwarded to `process.argv`:** Any flag placed **after** the target script or entrypoint
    (e.g. `bun run dev --watch` or `bun run clean --bun`) is passed verbatim to the script as arguments,
    bypassing Bun's runtime controls completely.
  - **Profiling flags:** Bun's native profiler flags are `--cpu-prof` (with `--cpu-prof-md` for LLM analysis),
    `--cpu-prof-name`, `--cpu-prof-dir`, and `--heap-prof` — never `--profile-cpu`.

**Environment and tooling**

- **Stock Chrome does not start under the sandbox.** Verify pages with
  `./bin/dx shot <url> --out scratch/shots/x.png` — WebKit through `Bun.WebView`, in-process and
  zero-dependency; `agent:doctor` reports it as `OK Bun.WebView available`. The `chrome` backend
  (Linux/Windows) needs a system Chrome, Chromium, Edge or Brave, not a downloaded browser.
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

`lib/` (ingestion, settlement, R2 CAS manifests, hostname extraction, venue stores) · `src/lib/`
(SoA analytics: `portal_taxonomy_normalizer.ts`, `syndicate_bot_detector.ts`,
`syndicate_adjacency_rollup.ts`, `customer_pairwise_cross_ref.ts`) · `cli/` (`sportsdesk_cli.ts`,
`sportsdesk_fraud_cli.ts`) · `bin/` (dx, linters) · `market/` (format-1 index for Discover) ·
`tests/` (`*.test.ts` suites plus fixtures) · **colocated `*.test.ts` suites in `lib/` and
`scripts/`** (CI runs `tests/` plus `scripts/capture/*.test.ts`, so run `bun test` before pushing) ·
`packages/` · `design/` · `schema/` · `infra/` · `docs/` (including `docs/runbooks/` for runtime
shapes, guardrails, token architecture, R2/API, and VPS domain).

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
  its `~/platform` checkout, `PLATFORM_SHA` and the `PLATFORM_DEPLOY_KEY` CI secret are gone. The
  rules it enforced (`zod-not-guard-calls`, `bun-env`, `node-fs-read-write-file`, …) are now a
  review convention, **not a gate** — nothing fails when they are violated. Reinstating it means
  restoring the copy, the frozen baseline and a decision about that debt.

### PR bodies, commit messages, and closing keywords

GitHub's auto-close parser reads closing keywords **literally** — inside backticks, inside fenced
code, in commit messages — and ignores the negation. `close`/`closes`/`closed`,
`fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved` followed by `#248`, `GH-248` or the issue URL
closes it, so a sentence _explaining that you are not closing an issue_ closes it. That happened
twice on 2026-11-15.

- Reference an issue by number alone. Anything that pairs a keyword with a reference closes it,
  however it is quoted.
- To close deliberately, write it once on its own line with the reference.
- Re-check issue state after merging: a premature close is silent, and reopening loses the thread
  order a reader expects.

### Check the run, not the green tick

Check runs attach to a **commit SHA**, not to a pull request. Retarget, rebase, or move a stacked
base and the PR can keep displaying a passing run against the **previous** head — no longer about
the code being merged (observed 2026-11-15 on a PR recreated against `main`).

- After a retarget, rebase or base change, compare `git rev-parse HEAD` with the run's head SHA,
  then push or update to force a fresh `synchronize` run.
- `strict: true` protection forces that update before merge, but it is a backstop, not a substitute
  for looking. Same class as the closing-keyword rule: what GitHub _displays_ is not necessarily
  what merged.

### Data-handling budgets

- Live captures `data/live-bets.json` and `data/live-wagers.json` stay **untracked**; `positions:cron`
  rewrites them with customer logins. Tests use `tests/fixtures/fraud/live-*.json` or
  `tests/fixtures/live-wagers.partial.json`. `tests/data_artifacts_tracking.test.ts` fails if either
  path is tracked again.
- Hot aggregation over roughly 10k+ rows uses fixed-capacity TypedArray arenas: no `Map`, `Set`,
  `boolean[]` or growing `T[]` on the aggregation path. Reference: `lib/gslive_tally_rollup.ts`,
  `src/lib/customer_pairwise_cross_ref.ts` (`PairwiseWagerColumnStore`,
  `PairwiseOverlapColumnStore`); ratchet: `tests/tally_allocation_invariant.test.ts` (0 collection
  allocations).
- Canonical R2 CAS manifest promotion (`lib/r2_manifest_cas.ts`, `CANONICAL_R2_SINK_SPECS`,
  `BRIDGE_R2_SINK_SPECS`): `If-None-Match: *` (gen 1) / `If-Match` (gen > 1) with zero rebases on
  HTTP `412` (`ERR_R2_MANIFEST_CAS_REJECTED`, exit `74`), zero `unresolved_gap_cents`
  (`ERR_OPS_RECONCILIATION_GAP`, exit `65`), and token-bleed isolation (`ERR_CF_TOKEN_BLEED_10000`,
  exit `77`). `bun x sportsdesk-fraud cross-ref` hydrates R2 SoA chunks directly and fails closed on
  local file inputs (`ERR_OPS_LOCAL_JSON_FORBIDDEN`, exit `78`).
- Dense flags are `Uint32Array` bitsets. Do not add `boolean[]` to runtime aggregation.
- DOD6 reader: `lookupInto(login, target)` in per-row loops; `lookup()` allocates a result and a
  handle union per call. Handles are opaque; use `rowOfHandle`, never sort by handle.
- Large fixtures (for example the 12 MB `tests/fixtures/f402-general-oracle-production.json`) must
  not be read whole in a request path; stream them or crop a test slice.
- Run `bun run audit:data-handling` before adding a collection or a >1 MB artifact to a hot path.
  The audit is advisory; the tests above are the contracts.

## Doc ownership

`README.md` = orientation + the runbook tree · `docs/runbooks/` = operational procedure ·
`docs/` = long-form. Move procedure into `docs/runbooks/` rather than growing the root.
