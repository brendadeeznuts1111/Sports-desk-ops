# dsh-plugin-sportsdesk-ops

A **read-only** DeepSeek Harness (DSH) plugin for this repository. It exposes the
desk's operator surfaces as native tools the agent calls directly, instead of
shelling out and scraping stdout.

```
sportsdesk_status    the local desk stack: checkout state, webview service health AND build age
sportsdesk_data      what the desk has on disk: dataset inventory, record counts, ages
sportsdesk_downline  questions over the downline snapshot: summary, one agent, top agents
sportsdesk_customer  customer-book questions with every count DERIVED at call time
sportsdesk_markets   staged combo/CLV reports: identity gates, wallet attribution, 4-week counterfactual
sportsdesk_ticker    the bet ticker and pending report, derived from the capture files
sportsdesk_dev       the repo's verification gates, reported not_run until executed
```

`sportsdesk_markets` is the staged-report surface: `combo-uniqueness.json` (identity gates,
dedupe, unresolved legs), `cross-domain-bridge.json` (customer↔wallet attribution, ranked
leads, quarantined count) and `backtest-4wk-cfb-nba.json` (4-week counterfactual with combo
families, guard attribution, CLV). Every answer carries the artifact's `generatedAtIso` and
file age, because a staged report is not a live number.

Every count in the answers is DERIVED at call time, never checked in: `sportsdesk_customer`
computes the customer count, sample-ticket count, totals and rankings from
`enriched_customers_full.json`, and the verifiers parse the same files to derive the
counts they assert (so a changed book changes the expectations, not a hand-edited
number). Rankings take a window: `lifetime` (default) or `7d` for net/volume; clv, sharp
and churn exist only in the lifetime rollup and are refused on 7d. `sharp` returns the
DERIVED sharp audit (sharp_score cutoff or positive CLV), never a scripted playbook list.

Customer intelligence is derived, not scripted. `profile` returns one customer's cohort
percentile ranks (volume, net, CLV, sharp, churn, hold, wager limit, delay), the sampled-
ticket behavior (risk distribution, ROI, win rate, leagues, markets, channels, UTC hour
histogram, days since the last sampled ticket), agent-peer position, shared-`ip_subnet`
peers and the flags that follow from those — with the cohort p90 cutoffs and the flag
definitions returned in the same answer. `signals` ranks cohort-wide derived signals
(sharp money, high churn, whales, book-profitable, dormant, multi-account networks), each
stating the cutoff its rule used. `compare` places 2–5 `customerIds` side by side using
the same profile. Every cutoff is recomputed from the book at call time; a field with no
finite value reports `null` rather than `0`, and the book is a curated cohort, not the
platform-wide customer base.

That caveat is also measured, not assumed. `integrity` audits the book's provenance —
RFC 5737 documentation IP ranges, sequential third-octet subnets, placeholder selections
(`Selection #N`/`Game Matchup N`), generated id families, coarse `placed_at` grids,
uniform sample sizes and duplicate rollups — and returns a `character` verdict derived
from how many features matched. `profile`, `signals` and `compare` carry the same compact
`bookIntegrity` block, and `signals.multiAccountNetworks` states whether its clusters are
subnet-fixture construction rather than observed multi-accounting. The point is that a
whale ranking computed over a synthetic fixture must not read as an observation of real
customers.

Live capture has one entry point now: `bun run capture:all --agent <id> --customer <id>` runs
every read-only operation in `PROBE_OPS` (plus `getBetTicker`, which the probe suite does not
carry), rebuilds `data/live-bets.json` from `Report/Pending` and `data/live-wagers.json` from
`getBetTicker`, writes raw bodies to the gitignored `scratch/f402-captures/`, and records one
PII-free run per source in `data/capture-health.json`. A failed or empty response never replaces
a good artifact; the run is reported as failed and the old file is left in place.
`sportsdesk_data` report `"capture"` reads that journal and each artifact's own provenance stamp
(`capturedAt` / `observedAt` / `extractedAt` / `generatedAt`), compares it against the freshness
budget, and reports an absent journal as MISSING rather than as zero sources.
`sportsdesk_dev` also offers `ci-all` (`bun run ci:local --keep-going`) for a full failure
inventory in one call.

It lives in the repo it operates on (unlike `dsh-plugin-fourc-odds`, its sibling in
`~/4c-odds-intergration/dsh-plugin`), so the commands it shells and the files it
reads version together with it.

## Why read-only

Deploying (`./bin/dx deploy`, `ship`), capturing feeds, dispatching Telegram
reports, syncing R2 and the Fantasy402 `wire` mutations all **change state**. Letting
a model trigger those as a side effect of answering a question is the wrong default,
so they stay shell commands where a human is in the loop.

`sportsdesk_dev` is the one tool that **executes** something, and the boundary is
deliberate rather than incidental: it runs the repository's own verification gates
over a **closed set**, and refuses any other name — the same refusal
`sportsdesk_downline` applies to an unknown subcommand. Those gates read artifacts
and check invariants; they never deploy, capture or mutate. A caller-supplied name is
looked up with `Object.hasOwn` on a null-prototype table, so `toString`, `constructor`
and `__proto__` are refused instead of resolving through the prototype chain.

## What it deliberately does not expose

`cli/sportsdesk_cli.ts` answers `winners`, `losers` and `leaderboard` with
**hard-coded demo rows** — verified 2026-11-02 by reading `printWinners` and the
leaderboard printer, which build literal arrays rather than querying a dataset.
Exposing them as tools would feed a model fabricated numbers with a real-looking
shape. `sportsdesk_downline` instead reads `sportsdesk_downline_data.json` itself and
always reports the file's path, mtime and age, because a checked-in snapshot is not a
live F402 feed.

## Honesty rules baked into the tools

| Rule                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing is `exists:false` / `available:false`, never `0` | "No file" and "empty dataset" are different problems; this repo's most repeated bug is a plausible metric computed from evidence nobody gathered.                                                                                                                                                                                                                                                                    |
| Gates default to `not_run`                               | "I did not look" is not "it passed". `ok` is `null` when nothing was executed.                                                                                                                                                                                                                                                                                                                                       |
| A reachable `/health` is not "current"                   | The service answers `/health` on every revision. The tool also probes `/api/status`, a route the current source defines, and checks the `/health` body for the current build's `ingress` field. A 404, or a missing `ingress`, means the running process predates the checkout. Measured on 2026-11-02: the live process on `:4020` was ~5 days old, 404'd every `/api/*` route, and its `/health` had no `ingress`. |
| Staleness is flagged, not hidden                         | `sportsdesk_data` reports `ageMinutes` for every file and one `stale` boolean derived from `staleAfterMinutes` (a stated heuristic, not a verdict).                                                                                                                                                                                                                                                                  |
| Both sides of a diverged branch                          | `ahead` alone hides commits the push has to reconcile.                                                                                                                                                                                                                                                                                                                                                               |

Nothing here reimplements a repo behaviour. Whatever runs is the existing command
(`bun run …`, `git …`); whatever is read is the same file, route or checkout an
operator would read. There is one implementation of each behaviour and no drift
between the plugin and the desk's own tooling.

## Two runtimes, and the trap that shapes this plugin

|                  | Runtime             | `typeof Bun` | Does                       |
| ---------------- | ------------------- | ------------ | -------------------------- |
| Repo commands    | **Bun 1.4.4**       | `object`     | the CLI, gates and tests   |
| Host plugin shim | **Electron's Node** | `undefined`  | runs `apply()`, spawns Bun |

`Bun` is a global injected by the Bun runtime, not a library you can import. DSH is an
Electron app, so its main process is Node, where `Bun` does not exist. The reference
plugin's first version used `Bun.spawn`; it loaded fine and all its Bun-run tests
passed, then the first real tool call failed with `"Bun is not defined"`.

This plugin therefore:

- spawns **Bun** through `node:child_process`;
- is plain **JavaScript**, not TypeScript: Node cannot import a `.ts` entry, so the stage-2
  host-runtime test could not import the real module;
- is **dependency-free**: it imports only `node:` builtins and builds raw `ToolDefinition`
  objects itself. This is not minimalism for its own sake — a directory-installed bundle is
  a _link_, and Node resolves a linked module's imports from its realpath (this checkout),
  not from the profile. Importing `@deepseek-ai/dsh-tools` there was measured to fail with
  `ERR_MODULE_NOT_FOUND` unless the bundle carries hand-made peer symlinks. Zero dependencies
  is what the documented "a Host-only bundle needs no dependencies" contract means, and it is
  also why the bundle declares no `Config` schema: a Schemastery schema would reintroduce the
  peer import, so `apply` normalizes the row config itself (bad values fall back to defaults);
- resolves the bun binary as: explicit absolute `bunPath` → the running binary when we
  already are Bun → `~/.bun/bin/bun`, `/opt/homebrew/bin/bun`, `/usr/local/bin/bun` →
  bare `bun` so a spawn failure is reported as "could not start", never as an empty
  result.

The trade-off of raw registration: `defineTool` wraps `execute` with argument validation,
and raw `register` does not. Every tool therefore validates its own arguments and returns a
structured `{ available: false, reason, message }` refusal instead of throwing.

## Config

`cordis.patch.yml` ships working defaults. The bundle declares no `Config` schema (see
above), so the loader passes the row config through unvalidated and `apply` keeps only
values of the right shape, falling back to the defaults in `DEFAULT_CONFIG`:

| Key                 | Default                               | Meaning                                                               |
| ------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `repoPath`          | `/Users/nolarose/code/sportsdesk-ops` | Checkout the tools read and shell.                                    |
| `bunPath`           | `bun`                                 | Bun executable; set an absolute path when the Host's PATH has no bun. |
| `serviceUrl`        | `http://127.0.0.1:4020`               | Base URL of `bun run serve`.                                          |
| `timeoutMs`         | `60000`                               | Cheap reads and checks.                                               |
| `gateTimeoutMs`     | `900000`                              | `unit` and `ci` gate executions.                                      |
| `staleAfterMinutes` | `1440`                                | Dataset age threshold for the reported `stale` flag.                  |

## Install

Bundles are installed into the current Harness profile; every session in that profile
gets the tools, and the change survives restart.

```
plugin_manager({ action: "install_bundle",
                 target: "/Users/nolarose/code/sportsdesk-ops/dsh-plugin" })
```

Read the result's `application` field: `applied` means the rows are live, `restart-required`
means this session still runs the old module graph. Then confirm with the
approval-free inspect provider:

```
cordis_inspect_query({ platform: "host", provider: "Tool", method: "listTools" })
```

Do not hand-edit the profile's `package.json` or `cordis.patch.yml`; `install_bundle`
owns those writes.

## Verify

Two stages, because they prove different things.

**Stage 1 — load + refusals (Bun, ~2s):**

```sh
bun dsh-plugin/verify-load.mjs
```

Imports the module with a fake `ctx`, asserts the zero-dependency contract and the seven
tool declarations, and exercises every closed set with unknown names — including
`toString`, `__proto__` and `constructor` — plus the report form (`sportsdesk_dev` with no
`run`) leaving every gate `not_run` and `ok:null`.

**Stage 2 — execution in the host runtime (Electron Node, ~5s):**

```sh
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  dsh-plugin/verify-runtime.mjs
```

Imports the **actual module** and calls every tool against this checkout: git spawn,
`node:fs` reads, snapshot parsing, and a real `secrets` gate that spawns Bun. A crash
here is a production crash.

No setup step is required: the bundle imports only `node:` builtins, so both scripts run
from a clean checkout. The `secrets` gate they execute does spawn Bun, which is why stage 2
is the one that proves the runtime.

## Repo gates

The plugin is plain JavaScript with no build step and no dependencies of its own, so it
stays out of the workspace (`packages/*`), out of `tsconfig.json`'s `**/*.ts` include,
and out of the frozen lockfile. Stage 1 asserts that `index.js` imports no peer package,
so the zero-dependency contract cannot regress silently.

Two Node APIs are required by the runtime split above:
`node:child_process` (spawn Bun) and `node:fs`'s `readFileSync` (read the datasets).
Each site carries an `// ast-grep-ignore: <rule-id>` comment with the reason, which is
the platform policy's sanctioned per-instance exception — not a baseline edit. The
files are also formatted and linted like the rest of the repo.

### Two repo checks that are deliberately not exposed

Measured on 2026-11-02 on this checkout:

- `env:audit` **hangs**: `.env` is a FIFO (`prw-------`), and the audit's
  `Bun.file(".env").text()` blocks forever. A tool that hangs mid-turn is worse than one
  that is absent.
- `gen:tokens:gate` **rewrites three tracked files** (`design/domain-branded-types.ts`,
  `static/customer-churn-dashboard.html`, `static/telegram-miniapp-dashboard.html`) and runs
  `bun fmt` even on exit 0. That is a write, and this plugin is read-only.

Both stay shell commands where a human is in the loop.

## Layout

| File                 | Role                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `index.js`           | The Host plugin: raw tool definitions, config normalization, seven tools. |
| `cordis.patch.yml`   | Bundle layer that inserts the plugin row and its config.                  |
| `package.json`       | Manifest: `dsh.bundle.patch`, exports (entry, patch, locale, icon).       |
| `locale/en.json`     | Plugin Manager title and description.                                     |
| `icon.svg`           | Original icon for the plugin row.                                         |
| `verify-load.mjs`    | Stage 1: Bun load + refusal test.                                         |
| `verify-runtime.mjs` | Stage 2: host-runtime execution test.                                     |
