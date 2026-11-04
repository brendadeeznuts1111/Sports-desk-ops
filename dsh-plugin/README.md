# dsh-plugin-sportsdesk-ops

A **read-only** DeepSeek Harness (DSH) plugin for this repository. It exposes the
desk's operator surfaces as native tools the agent calls directly, instead of
shelling out and scraping stdout.

```
sportsdesk_status    the local desk stack: checkout state, webview service health AND build age
sportsdesk_data      what the desk has on disk: dataset inventory, record counts, ages
sportsdesk_downline  questions over the downline snapshot: summary, one agent, top agents
sportsdesk_customer  customer-book questions with every count DERIVED at call time
sportsdesk_links     canonical GSLive Manager deep links per customer, incl. canceled + Filters values
sportsdesk_markets   staged combo/CLV reports: identity gates, wallet attribution, 4-week counterfactual
sportsdesk_ticker    the bet ticker and pending report, derived from the capture files
sportsdesk_wagers    the snapshot wager-state table: legs vs wagers, deduped wagerRisk, spanning, quality, automation health, capture trends
sportsdesk_endpoints endpoint evidence scan: tiers, captures, probe catalog, spec gaps, route surface
sportsdesk_security  security scan: secrets, capture redaction, classified F402 identifiers, calibration
sportsdesk_sharp     sharp-money scan: p90 cutoff, sensitivity, collinearity, agents, leagues
sportsdesk_weblogs   getWebLog evidence: captures, modes, redaction, whether IP rows exist
sportsdesk_dev       the repo's verification gates, reported not_run until executed
```

The four scan tools answer a different question than the rest: not "what is the
number" but "what does the evidence actually prove". They read
`docs/evidence/ledger.json`, `dist/openapi.json`, the capture manifest and store,
`enriched_customers_full.json`, `lib/forensic_diagnostic_modes.ts` and the
`PROBE_OPS` capture-suite catalog, and they never call the live manager API.
`sportsdesk_endpoints` separates the ledger's `capturedResponse` claim from the
existence of a capture file (they are different claims and are not merged), joins
the probe catalog against the ledger (measured 2026-11-03: 24 of its 36 operations
had no ledger row; the tool reports the current count), reports the evidence trend
read from the capture store's `applied-*.json` journal and, with
`report:"service"`, runs the repo's `check:route-surface` comparison of served
routes, ledger surfaces and the published spec; `sportsdesk_security` runs the
repo's own `check:secrets` and its `lib/identifier_scan.ts` (through Bun, because
the Host runtime cannot import TypeScript), splits hits into known downline agents
and unclassified identifiers, calibrates itself against the labeled-safe fixtures
and returns counts and paths only — never an identifier literal or an IP;
`sportsdesk_sharp` derives its default cutoff from the book's own p90 (not a
checked-in 70), reports a 50/60/70/80/90 sensitivity grid, the plateau a cutoff
sits in, the CLV rule's incremental value and the sharp/CLV correlation, then
recomputes the candidate set, cohort p90 cutoffs and per-agent/per-league split at
call time; and `sportsdesk_weblogs` reports whether the getWebLog capture carries
response rows at all (`provenance.body: "none"` and a 21-byte body, measured
2026-11-03), so a missing row cannot be read as "no shared IPs".

Measured on 2026-11-03, the sharp calibration is the clearest example of the
principle: the book's p90 is 47.22, every cutoff from 50 to 90 selects the same
21 candidates because the OR rule's CLV arm already holds them, the sharp-only
count over that grid falls 21 → 21 → 21 → 14 → 0, the sharp/CLV correlation is
0.8745, and the CLV rule adds 0 candidates. The tool says that in the answer — a
plateau, a sharp-only series, an incremental value and a correlation — instead of
presenting 70 as if the data chose it. That does not make the fixture a market
prior: the same answer carries the `generated-fixture` verdict.

`sportsdesk_markets` is the staged-report surface: `combo-uniqueness.json` (identity gates,
dedupe, unresolved legs), `cross-domain-bridge.json` (customer↔wallet attribution, ranked
leads, quarantined count) and `backtest-4wk-cfb-nba.json` (4-week counterfactual with combo
families, guard attribution, CLV). Every answer carries the artifact's `generatedAtIso` and
file age, because a staged report is not a live number.

`sportsdesk_wagers` reads the v2 wager-state artifact
(`scratch/gslive-wagers-by-state.summary.json`, produced by
`scripts/gslive_wagers_by_state.ts --json`) and returns `identity`, `totals`, per-state rows
and the producer's computed `quality` block. The contract matters: `legs` is one source row
per leg, while `wagers` counts distinct `Ticket`s; `wagerRisk` is deduped/allocated by ticket
spanning and must not be summed from the leg rows, and `legToWin`/`legResult` stay leg-scoped
diagnostics rather than wager P&L. The tool never recomputes those numbers, so it cannot drift
from the artifact; it adds the freshness of the DATA (`window.ageMinutes`, recomputed from
`observedEnd`) next to the age of the FILE (`source.ageMinutes` from its mtime). A missing
artifact is `MISSING` (never zero states), an unparseable file is an explicit error, and any
`schemaVersion` other than 2 is `UNSUPPORTED` instead of a best-effort parse. The artifact
lives in gitignored `scratch/`, so this is a snapshot, not a live feed — the plugin config
field `wagersArtifact` points it at another path when needed.

The same tool answers two automation questions from the files
`scripts/wagers_by_state_capture.ts` writes next to the artifact, per the frozen
`scratch/wagers-automation.schema.v1.json` contract:

| Report       | Answers                                                                                                                                                                                                                                                                                            | Source files (each independently MISSING-able)   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `summary`    | identity, totals, limited state rows and the producer's quality block, with data age and file age.                                                                                                                                                                                                 | `wagersArtifact`                                 |
| `states`     | the per-state rows, optionally filtered by one observed state.                                                                                                                                                                                                                                     | `wagersArtifact`                                 |
| `quality`    | the producer's computed quality block and the flags derived from it.                                                                                                                                                                                                                               | `wagersArtifact`                                 |
| `automation` | artifact age/stale and provenance; journal `lastSuccess`, `lastFailure` and the last 5 runs; current alerts and their severity split. Each file's status is reported separately.                                                                                                                   | `wagersArtifact`, `wagersStatus`, `wagersAlerts` |
| `trends`     | the last `limit` successful captures from the append-only JSONL history: per-capture `capturedAt`, totals and state rows, the latest line's `delta.migrations`/`newTickets`/`goneTickets`, and its alerts. Malformed lines are skipped and counted; rotation is never inferred from JSONL content. | `wagersHistory`                                  |

The honesty rule for these two reports is that they never borrow one file's evidence for
another: a missing journal is `MISSING` and the attempt outcome is unmeasured — never
`"no failures"`, `"no runs"` or a synthesized zero. A missing alerts document is not "zero
alerts"; an empty `alerts: []` in a document that WAS read is a measured zero. The journal
is authoritative for success/failure, alerts are derived from the latest successful
capture, and the artifact is only a snapshot. `history` lines are successful captures
only, so the history is not an attempt log, and it carries no ticket ids by contract —
counts, deltas, timestamps and alert text only. `state` filters each history capture's rows
too, and `limit` (1-100, default 10) selects the newest captures.

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

`sportsdesk_links` is the one surface that returns URLs instead of numbers: it builds the
GSLive Manager (Partner 118) deep links for one customer — the 7-day, 14-day and churn
`#/reports/users` windows plus the `#/events/bet-history` calcTime/betTime sidecars — and the
per-player bet-history link over `windowDays` desk days, filtered by SPA `state` and by the
URL-expressible Filters-panel values (`agent`, `betId`, `betGroupId`, `freeBetId`, `kind`,
`groupName`, `period`, `sportId`, `marketIds`). The vocabulary is the shipped SPA bundle's own
(`assets/index-DB17VVxN.js`, read 2026-11-03): the state select has eleven values (`""` = All),
Group Kind is `player`/`agent`/`custom`/`line-type`, bet ids lose their `b`/`g` prefix and are
space-joined, market ids are comma-joined, and `period` may be a code (`s3`) or a console label
(`3rd Quarter`), resolved per sport against the captured `sportPeriods` payload
(`tests/fixtures/gslive-sport-periods-2026-11-03.json`, 102 periods / 10 abbreviations / 40 period
names, captured 2026-11-03 from the unauthenticated `{"a":"sportPeriods"}` POST documented in
`docs/gs-manager-contracts.md` §2.2) — a label needs `sportId`, and an unknown label is refused
with the sport's codes and labels rather than guessed. The grid's
own "Filters" tool panel is client-side AG Grid state with **no URL representation** — "Bet
price" is a hidden grid column over `fVal_new`, not a query parameter — so no link can filter on
it; the tool refuses it rather than inventing a parameter. `canceled` was captured in the operator
console on 2026-11-03 as
`partnerUserId=ccc107&state=canceled&from=1793163600&to=1793685600&toTime=86399` — 7 desk days
ending 2026-11-03, so the window spans the CDT→CST change and is derived, never hardcoded. The
tool shells `bun cli/sportsdesk_cli.ts gslive … --json`, so the window/DST/filter contract has
one implementation, and it never calls the live manager API. The `getBetReport` payload's
`state` field is left `""` because only the hash-route filter was observed.

Live capture has one entry point now: `bun run capture:all --agent <id> --customer <id>` runs
every read-only operation in `PROBE_OPS` (plus `getBetTicker`, which the probe suite does not
carry), rebuilds `data/live-bets.json` from `Report/Pending` and `data/live-wagers.json` from
`getBetTicker`, writes raw bodies to the gitignored `scratch/f402-captures/`, and records one
PII-free run per source in `data/capture-health.json`. A failed or empty response never replaces
a good artifact; the run is reported as failed and the old file is left in place.
`sportsdesk_data` report `"capture"` reads that journal and each artifact's own provenance stamp
(`capturedAt` / `observedAt` / `extractedAt` / `generatedAt`), compares it against the freshness
budget, and reports an absent journal as MISSING rather than as zero sources.

The same report says how each artifact can be refreshed, which is the distinction that was
missing: `capture:all` can only rebuild what an API operation serves (`live-bets`,
`live-wagers`), while scoreboard, Game Admin, Contests and the stored CP analysis are
**operator pastes** — the portal renders them and no API contract proves them. Those are
installed with `bun run capture:dom --input <dir>`, which validates each paste against that
artifact's own reader, requires it to state `observedAt`, installs the normalized content and
records the input's SHA-256 and mtime. A paste that does not validate is refused and the
previous artifact is left alone. The capture report therefore lists `capturePath` and a
`refresh` command per artifact, plus `stalePasteArtifacts` for the ones only a paste can fix.
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

`sportsdesk_dev` and `sportsdesk_security` are the tools that **execute** something,
and the boundary is deliberate rather than incidental: `sportsdesk_dev` runs the
repository's own verification gates over a **closed set**, and refuses any other
name — the same refusal `sportsdesk_downline` applies to an unknown subcommand;
`sportsdesk_security` runs exactly two repo commands, `bun run check:secrets` and the
`lib/identifier_scan.ts` scanner, and accepts no command from the caller at all.
Those gates and scans read artifacts and check invariants; they never deploy, capture
or mutate. A caller-supplied gate name is looked up with `Object.hasOwn` on a
null-prototype table, so `toString`, `constructor` and `__proto__` are refused instead
of resolving through the prototype chain.

## What it deliberately does not expose

`cli/sportsdesk_cli.ts` answers `winners`, `losers` and `leaderboard` with
**hard-coded demo rows** — verified 2026-11-02 by reading `printWinners` and the
leaderboard printer, which build literal arrays rather than querying a dataset.
Exposing them as tools would feed a model fabricated numbers with a real-looking
shape. `sportsdesk_downline` instead reads `sportsdesk_downline_data.json` itself and
always reports the file's path, mtime and age, because a checked-in snapshot is not a
live F402 feed.

The four scans add one more boundary: **no live manager call**. `sportsdesk_weblogs`
reads the capture store rather than `Manager/getWebLog`, so it can say "the capture
carries no response rows", but it cannot say "these customers share an IP" — IP
matching needs a capture that recorded rows. `sportsdesk_security` reads what is on
disk; it cannot rotate a credential or edit a capture, and it returns identifier
counts and paths rather than the identifiers themselves.

## Honesty rules baked into the tools

| Rule                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Missing is `exists:false` / `available:false`, never `0` | "No file" and "empty dataset" are different problems; this repo's most repeated bug is a plausible metric computed from evidence nobody gathered.                                                                                                                                                                                                                                                                                                                                    |
| Gates default to `not_run`                               | "I did not look" is not "it passed". `ok` is `null` when nothing was executed.                                                                                                                                                                                                                                                                                                                                                                                                       |
| A reachable `/health` is not "current"                   | The service answers `/health` on every revision. The tool also probes `/api/status`, a route the current source defines, and checks the `/health` body for the current build's `ingress` field. A 404, or a missing `ingress`, means the running process predates the checkout. Measured on 2026-11-02: the live process on `:4020` was ~5 days old, 404'd every `/api/*` route, and its `/health` had no `ingress`.                                                                 |
| Staleness is flagged, not hidden                         | `sportsdesk_data` reports `ageMinutes` for every file and one `stale` boolean derived from `staleAfterMinutes` (a stated heuristic, not a verdict).                                                                                                                                                                                                                                                                                                                                  |
| Both sides of a diverged branch                          | `ahead` alone hides commits the push has to reconcile.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A ledger capture is not a capture file                   | `sportsdesk_endpoints` keeps `ledgerCaptured` (`capturedResponse`) and `manifestCaptured` (a redacted file exists) separate, so neither claim can borrow the other's authority.                                                                                                                                                                                                                                                                                                      |
| An unrecorded body is not zero rows                      | `sportsdesk_weblogs` reports `rows:0` and `bodyRecorded:false` for a capture whose `provenance.body` is `"none"`; "no shared IPs" cannot be read out of "no IP rows were recorded".                                                                                                                                                                                                                                                                                                  |
| A security scan must not become the leak                 | `sportsdesk_security` returns counts and paths for identifiers and masked values for secrets, so calling the tool cannot publish the data it reports.                                                                                                                                                                                                                                                                                                                                |
| A cutoff the data cannot identify is flagged             | `sportsdesk_sharp` reports the sensitivity grid and plateau around its cutoff. Measured 2026-11-03: 50, 60 and 70 all select 21 candidates, so `thresholdIdentified` is false for 70 instead of the number reading as chosen by the data.                                                                                                                                                                                                                                            |
| An OR rule must prove its increment                      | The same scan reports `incrementalByClv` and the sharp/CLV correlation; a rule that adds 0 candidates is called out as non-independent instead of being presented as a second signal.                                                                                                                                                                                                                                                                                                |
| A scanner is calibrated before its findings are trusted  | `sportsdesk_security` runs the identifier shape over two labeled-safe fixtures and reports `calibration`; a hit there means the scanner drifted, and the verdict becomes `uncalibrated` rather than `findings`.                                                                                                                                                                                                                                                                      |
| A snapshot is not a trend                                | `sportsdesk_endpoints` reads the `applied-*.json` journal and reports tier growth, upgrades, skips and rejections; the file count and the rejection rate are separate signals, so "more rejected" is not reported as "improved".                                                                                                                                                                                                                                                     |
| No artifact is not an empty table                        | `sportsdesk_wagers` distinguishes MISSING, unparseable and UNSUPPORTED; none of them returns `states: []` or `totals: 0`, because a gitignored `scratch/` artifact is absent in a fresh checkout and "no rows" is the number that would look plausible.                                                                                                                                                                                                                              |
| A missing journal is not "no failures"                   | The `automation`/`trends` reports read the capture journal, history and alerts document per file. An absent journal reports its attempt outcome as unmeasured (`lastSuccess`/`lastFailure` null), never as a clean or failing pipeline; an absent alerts document reports `count: null`, never zero; malformed JSONL lines are counted and skipped, never thrown.                                                                                                                    |
| A join claim is measured, not asserted                   | `sportsdesk_ticker`'s `reconcile` report derives the pending↔ticker ticket-id overlap from the two captures on every call. Measured 2026-11-04 20:00Z: 223 of 250 pending ticket ids appear as ticker `WagerNumber`s, so `scope` is `overlapping` and the note says so; an earlier capture measured 0 and reported `disjoint`. The tool never repeats a hard-coded disjointness claim the files now contradict, and a missing capture reports overlap as unmeasurable rather than 0. |
| A missing description is not a new type                  | `sportsdesk_ticker` splits `parseWarnings` into `parseWarningKinds.emptyShortDesc` (a data gap) and `.unknownWagerType` (a code the ticker dictionary lacks), and the verifier pins the split against the source rather than asserting "0 warnings" on a rotating capture. The `E` code was added to the dictionary only after 5 live rows measured it as an Over/Under total prefix.                                                                                                |

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

| Key                 | Default                                       | Meaning                                                                |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `repoPath`          | `/Users/nolarose/code/sportsdesk-ops`         | Checkout the tools read and shell.                                     |
| `bunPath`           | `bun`                                         | Bun executable; set an absolute path when the Host's PATH has no bun.  |
| `serviceUrl`        | `http://127.0.0.1:4020`                       | Base URL of `bun run serve`.                                           |
| `timeoutMs`         | `60000`                                       | Cheap reads and checks.                                                |
| `gateTimeoutMs`     | `900000`                                      | `unit` and `ci` gate executions.                                       |
| `staleAfterMinutes` | `1440`                                        | Dataset age threshold for the reported `stale` flag.                   |
| `wagersArtifact`    | `scratch/gslive-wagers-by-state.summary.json` | v2 wager-state artifact; relative to `repoPath`, or absolute.          |
| `wagersStatus`      | `scratch/wagers-by-state.status.json`         | Capture journal (attempt success/failure) for the `automation` report. |
| `wagersHistory`     | `scratch/wagers-by-state.history.jsonl`       | Append-only capture history for the `trends` report.                   |
| `wagersAlerts`      | `scratch/wagers-by-state.alerts.json`         | Derived alerts document for the `automation` report.                   |

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

Imports the module with a fake `ctx`, asserts the zero-dependency contract and the thirteen
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
  `static/customer-churn-simulation-dashboard.html`, `static/telegram-miniapp-dashboard.html`) and runs
  `bun fmt` even on exit 0. That is a write, and this plugin is read-only.

Both stay shell commands where a human is in the loop.

## Layout

| File                 | Role                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `index.js`           | The Host plugin: raw tool definitions, config normalization, thirteen tools. |
| `cordis.patch.yml`   | Bundle layer that inserts the plugin row and its config.                     |
| `package.json`       | Manifest: `dsh.bundle.patch`, exports (entry, patch, locale, icon).          |
| `locale/en.json`     | Plugin Manager title and description.                                        |
| `icon.svg`           | Original icon for the plugin row.                                            |
| `verify-load.mjs`    | Stage 1: Bun load + refusal test.                                            |
| `verify-runtime.mjs` | Stage 2: host-runtime execution test.                                        |
