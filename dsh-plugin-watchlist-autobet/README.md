# dsh-plugin-watchlist-autobet

A **paper-only** DeepSeek Harness Host bundle for the sportsdesk-ops watchlist autobet
pipeline. It exposes the repo's `cli/watchlist_autobet_cli.ts` as nine native DSH tools: five
read-only, four that append to the local paper ledger and therefore require `confirm: true`.

The plugin holds no engine logic, no credentials and no network client. Every tool shells the
one CLI and parses its JSON, so the gates, ledger, paper fill math and P&L have exactly one
implementation.

## The boundary (read this first)

- **No live order path.** `autobet_execute` paper-fills approved intents through the CLI's
  paper adapter only. Any other venue is refused by the CLI with `live_disabled`. There is no
  live adapter in v1, no live-order tool here, and no configuration value that turns one on:
  the CLI rejects any mode other than `paper` at config load time.
- **Live betting is not implemented.** The paper ledger is a local append-only JSONL file
  (`Scratch/watchlist-autobet/ledger.jsonl`, gitignored). No money moves.
- **Approval is a human decision.** `autobet_enqueue` only appends intents _awaiting_
  approval. `autobet_decide` records the approve/reject decision it is given; it does not make
  it. `autobet_execute` is a separate confirm-gated step.
- **Signals are advice, not orders.** Fixture-sourced, stale and no-price signals are shown by
  `autobet_signals` (with `includeRejected`) but are always ineligible.
- The plugin never writes the ledger itself and never reads a credential. Missing files are
  reported as missing (`exists: false`), never as zero.

## Tools

All nine tools return **one JSON object**. Read tools are concurrency-safe; the four writing
tools are not (they are serialized by the Host). Writing tools without `confirm: true` return
`{ "available": false, "reason": "confirmation_required", "message": "…re-run with confirm: true…" }`
and execute nothing.

| Tool              | Kind  | Arguments                                                                                                         | CLI command          |
| :---------------- | :---- | :---------------------------------------------------------------------------------------------------------------- | :------------------- |
| `autobet_status`  | read  | —                                                                                                                 | `status`             |
| `autobet_signals` | read  | `limit?` (1-200), `minConfidence?` (0-100), `includeRejected?`                                                    | `signals`            |
| `autobet_plan`    | read  | —                                                                                                                 | `plan`               |
| `autobet_queue`   | read  | `status?` (`queued`/`approved`/`filled`/`settled`/`rejected`/`expired`), `limit?` (1-500)                         | `list`               |
| `autobet_journal` | read  | `limit?` (1-500)                                                                                                  | `journal`            |
| `autobet_enqueue` | write | `actor?` (default `dsh-agent`), **`confirm: true`**                                                               | `enqueue`            |
| `autobet_decide`  | write | `intentId`, `decision` (`approve`/`reject`), `actor?`, `note?` (approve), `reason?` (reject), **`confirm: true`** | `approve` / `reject` |
| `autobet_execute` | write | `intentId`, `venue?` (default `paper`), **`confirm: true`**                                                       | `execute`            |
| `autobet_settle`  | write | `intentId`, `result` (`won`/`lost`/`void`), **`confirm: true`**                                                   | `settle`             |

`confirm` must be exactly boolean `true`. The strings `"true"` and the number `1` are refused.
`autobet_signals` also returns the advisory `candidates` array — capture accounts the watchlist
does not cover (see [New-account discovery](#new-account-discovery)) — alongside `counts.candidates`.

## The operator control plane (Web UI)

The bundle also ships a Client half: a **Watchlist autobet** icon in the left sidebar opens a
control-plane page in the main column. It never bypasses the engine — the page reads a
same-origin board composed from four read-only CLI calls (`status`, `list`, `journal`, `plan`)
and a signals inspector composed from `signals`, then posts a closed action set through the
same CLI.

What the page manages for the operator:

- **Signals inspector** — a second tab over the watchlist itself: every signal with its market
  label, confidence vs required, distinct-account count, one-sided share, fair probability,
  reference price, risk and provenance age. Refused signals are shown with their failed gate
  reasons, and expanding one lists every check's actual/required/detail, so "nothing is
  eligible" is explainable in the UI instead of only via the agent. An eligible set carries one
  confirm-gated "Enqueue eligible signals" action; the view never approves or executes.
- **New-account discovery** — below the signal list, a "Not on the watchlist" section ranks the
  accounts the captures saw but the watchlist registry does not cover (login, agent, summed risk,
  last bet time and source), with an `Unwatched N` summary chip. It is advisory only: the engine
  still ignores those logins, and a payload without the list reads "unknown", never "none".
- **Human-in-the-loop queue** — queued, approved and filled intents as cards with market label,
  stake, confidence/distinct accounts, fair probability, risk, age and expiry countdown; inline
  action forms for Approve (+ optional note), Reject (+ required reason), Execute paper and
  Settle won/lost/void. Every action needs an explicit confirm click, and the operator name typed
  in the header is recorded as the ledger `actor`.
- **Decision tracking** — a per-intent decision trail and a global recent-decisions feed built
  from the ledger's `intent_approved`, `intent_rejected`, `intent_filled`, `intent_settled` and
  `intent_expired` events (actor, time, note/reason, stake, status). The ledger remains the audit
  trail; the page is a view of it.
- **Operator context** — the selected intent's accounts (login/agent/archetype/risk), the closed
  gate checks that admitted it, provenance freshness/fixture/sources, paper fill and settlement
  math, plus the current `plan`: what would queue now, why the rest are skipped, and cap usage.
- **Attention banner** — stale signal sources (signals will be refused until captures refresh),
  approvals expiring soon, approved intents not yet executed, filled intents not settled, and
  eligible signals waiting to be queued.
- **Paper-only, always** — the safety badge reads the server's `safety.liveExecution`, execute is
  hard-coded to the paper venue server-side, and no route accepts a live venue.

Routes (same origin as the GUI, registered by the Host half when the browser carrier exists):

| Route                            | Method | Purpose                                                                                                                                                                     |
| :------------------------------- | :----- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/watchlist-autobet/board`   | GET    | Board: safety, config, sources, ledger counts, intents with UI derivations, paper summary, plan, decision feed, CSRF token.                                                 |
| `/api/watchlist-autobet/signals` | GET    | Signals inspector: the CLI `signals` payload (`includeRejected`, `limit`, `minConfidence` bounded server-side): sources, counts, per-signal gate verdicts and the advisory candidate list. |
| `/api/watchlist-autobet/action`  | POST   | Closed action set (`enqueue`/`approve`/`reject`/`execute`/`settle`); requires `confirm: true`, the same Origin and the per-activation CSRF token, then returns CLI + board. |

The routes are **local GUI plumbing, not an authentication boundary**: the carrier's own page
asks for DSH web auth, but these paths do not, so any process able to reach the loopback
listener can read the board and the signals (watchlist/risk/config data) and — with a fetched
CSRF token and a forged Origin — drive paper mutations. Keep `dsh web` loopback-bound while this
bundle is installed, or gate these routes with the carrier's session auth (or a separate bearer
token) before exposing the GUI beyond loopback. They are guarded against cross-site pages
(mutations require the exact same Origin, the per-activation CSRF token from the board, JSON
content type and a 32 KiB body bound); the whole surface is paper-only. Every malformed request
is 400 `invalid_body` (including a wrong content-type and an oversized body).
The board is cached server-side for 4 s and each signals query for 4 s; every action answer
carries a force-refreshed board. After installing or updating the bundle, reload the GUI page
once so the Client module and sidebar entry load.

## The paper lifecycle

1. `autobet_status` — is the pipeline configured, is the ledger present, is live execution
   still off (`safety.liveExecution: false`)?
2. `autobet_signals` — watchlist signals with their gate results. `includeRejected: true`
   shows ineligible ones and their failed checks (`fixture_provenance`, `freshness`, …).
3. `autobet_plan` — dry run: what `enqueue` _would_ queue and which caps would bind. Writes
   nothing.
4. `autobet_enqueue` with `confirm: true` — appends paper intents for eligible, non-duplicate
   signals, bounded by the desk-day stake caps. Re-running is idempotent.
5. `autobet_queue` — inspect derived statuses. Expiry is computed at read time, so a past-due
   approval reads as `expired` and cannot be approved or executed.
6. `autobet_decide` with `confirm: true` — the operator's decision. `approve` is legal only
   from `queued`; `reject` requires a reason and releases the reserved stake.
7. `autobet_execute` with `confirm: true` — paper fill of an approved, unexpired intent with
   the configured slippage; recorded P&L is paper P&L.
8. `autobet_settle` with `confirm: true` — record `won`/`lost`/`void` and fold it into the
   ledger summary.
9. `autobet_journal` — the raw append-only audit trail plus the folded summary.

Every illegal transition is a refusal from the CLI (`invalid_transition`, `intent_expired`,
`live_disabled`), never a silent no-op.

Every ledger-writing command (`enqueue`, `approve`, `reject`, `execute`, `settle`, and each
`watch` cycle) takes a cross-process lock file next to the ledger (`<ledger>.lock`, `O_EXCL`), so
an operator command and a cron/`watch` loop cannot interleave a read→append pair and poison the
append-only log. A lock held past the wait timeout is refused with `ledger_locked` (exit 1) and
nothing is written; a lock left by a crashed process is only broken after 30 s. Read commands
need no lock because one appended JSONL line becomes visible atomically.

## New-account discovery

The signal engine deliberately ignores logins that are not on the watchlist rather than
attributing them to someone else. That is correct for derivation and blind for discovery: a
genuinely new account can bet in the desk's own captures and leave no trace in the inspector.

`autobet candidates` (and the Signals inspector's "Not on the watchlist" section) closes that
gap. It re-parses the same three artifacts and returns every login the registry does not cover,
ranked by summed capture risk, with `agentId`, `wagers`, `sources`, `leagues`, `lastBetAt`,
`ageSeconds` and up to three `sampleMarkets`. It is advisory: no gate consumes it, nothing is
queued or written, and promoting an account stays a deliberate operator act (add it to
`lib/gslive_manager_watchlist.ts`, then re-derive).

```sh
bun run autobet candidates --json                       # all unwatched accounts, ranked
bun run autobet candidates --min-risk-usd 100 -l 20     # risk-ranked shortlist
```

An unparseable market still surfaces its account: the market sample is omitted, the login and
risk are kept. Logins are normalised (upper-case, trailing punctuation stripped) before ranking.

**Two clocks.** `docs/graph-live-feed.json` rows age from the feed's generation time, but the
two capture artifacts age from the bet's own timestamp (`Report/Pending` `acceptedAt`,
`getBetTicker` `InsertDateTime`) with the capture time only as a fallback. A frozen portal that
keeps answering with the same old tickets therefore reads as stale activity even though the
artifact was written seconds ago — "fresh capture" is no longer mistaken for "fresh betting".
The portal wall-clock carries no zone; measured 2026-11-04, live-captured rows sit 3.7 minutes
before the measurement instant only when read as **America/New_York** (UTC is ~5 h early, the
desk's Central clock ~56 min in the future), so the engine reads it in the portal's Eastern zone.
A timestamp that still lands in the future (> 120 s) is treated as a broken clock and refused as
stale, never as freshness.

## Configuration

`cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: watchlist-autobet
      name: dsh-plugin-watchlist-autobet
      config:
        repoPath: /Users/nolarose/code/sportsdesk-ops
        bunPath: bun
        configPath: config/watchlist-autobet.json
        timeoutMs: 60000
```

| Key          | Meaning                                                                                                          |
| :----------- | :--------------------------------------------------------------------------------------------------------------- |
| `repoPath`   | The sportsdesk-ops checkout; also the spawn `cwd`.                                                               |
| `bunPath`    | `bun` (resolved from PATH/known installs) or an absolute path.                                                   |
| `configPath` | Repo-relative paper config, passed as `--config`. The CLI requires `mode: "paper"`, `allowLiveExecution: false`. |
| `timeoutMs`  | Per-command timeout (default 60 000). A timeout is reported as `cli_timeout`, never as a pass.                   |

The bundle declares no dependencies and no `Config` schema (a linked directory install cannot
resolve peer packages from the profile), so the config is normalized defensively in `index.js`
and a malformed value falls back to its default.

## CLI mapping

Every invocation is:

```sh
bun run cli/watchlist_autobet_cli.ts <command> [validated flags] \
  --json --root <repoPath> --config <configPath>
```

with `cwd: repoPath`. Arguments are built as an **argv array** from a closed command set plus
validated values; no shell string is ever assembled, so user text cannot become a shell word.
`limit`/`minConfidence` are range-checked, `status`/`result`/`decision` are closed sets,
`intentId` is pattern-checked, and free text is length/control-character checked.

The CLI documents itself, so the plugin never re-implements help:

```sh
bun run autobet --help              # command table, global flags, exit codes, examples
bun run autobet <command> --help    # arguments, long + short flags, defaults, examples
```

Global flags are accepted before or after the command, long or short: `-h/--help`, `-j/--json`,
`-r/--root <path>`, `-c/--config <path>`, `-n/--now <iso>`.

| Command   | Short flags      | Effect                                                               |
| :-------- | :--------------- | :------------------------------------------------------------------- |
| `status`  | –                | config, ledger and source freshness                                  |
| `signals` | `-l`, `-m`, `-i` | gate verdicts; `-i` includes rejected, `-m` pre-filters confidence   |
| `candidates` | `-l`          | accounts the captures saw that the watchlist does not cover; read-only |
| `plan`    | –                | dry run of `enqueue`; writes nothing                                 |
| `enqueue` | `-a`             | idempotent queue of eligible intents; never approves or executes     |
| `list`    | `-s`, `-l`       | intents by derived status (expiry computed at read time)             |
| `approve` | `-a`, `-o`       | human decision: queued -> approved                                   |
| `reject`  | `-a`, `-R`       | queued/approved -> rejected; reason required, releases stake         |
| `execute` | `-v`             | paper fill of an approved intent; any other venue -> `live_disabled` |
| `settle`  | `-e`             | won/lost/void for a filled intent, folds paper P&L                   |
| `journal` | `-l`             | append-only event tail plus the folded paper summary                 |
| `watch`   | `-i`             | enqueue loop (interval ≥ 30 s); queues only, never executes          |

## Failure shape

A CLI success payload is returned unchanged (`success: true`, `schemaVersion: 1`,
`command`, `generatedAt`, command payload). A CLI failure is preserved and wrapped:

```json
{
  "available": false,
  "reason": "live_disabled",
  "message": "live venue refused: paper mode only",
  "command": "execute",
  "exitCode": 3,
  "details": { "venue": "live" },
  "cli": {
    "success": false,
    "schemaVersion": 1,
    "command": "execute",
    "error": { "code": "live_disabled", "message": "…" }
  }
}
```

`reason` is the CLI's own error code (`config_missing`, `config_invalid`, `ledger_corrupt`,
`ledger_locked`, `intent_not_found`, `invalid_transition`, `intent_expired`, `live_disabled`,
`usage_error`, `internal_error`) when the CLI answered, or a wrapper code when it could not:
`confirmation_required`, `invalid_arguments`, `cli_missing`, `cli_timeout`, `cli_failed`. The
wrapper never throws out of `execute`.

## Verification

```sh
node --check dsh-plugin-watchlist-autobet/index.js
node --check dsh-plugin-watchlist-autobet/verify-load.mjs
node dsh-plugin-watchlist-autobet/verify-load.mjs
```

`verify-load.mjs` is dependency-free and runs under plain Node. It registers the plugin
against a fake context, asserts the nine fixed names and each raw ToolDefinition, asserts read
tools are concurrency-safe and writing tools are not, asserts every writing tool refuses
without `confirm: true` (and that the refusal is reached before validation / before the CLI),
asserts malformed arguments are refused, asserts a missing CLI yields a structured answer
rather than an exception, and asserts the disposer releases all nine registrations. It points
`repoPath` at a non-existent temp directory, so it needs neither the CLI nor a real ledger.

The CLI surface is covered by `bun test tests/watchlist_autobet.test.ts` (64 tests): paper
lifecycle, gate/config/ledger corruption, concurrency safety, the read-only `candidates`
discovery pass, and the CLI help contract —
root command table, every command's `--help` (usage, arguments, long and short flags, examples),
short-flag parsing (`-j -r -c -n` globals plus `-l -m -i -a -o -s -R -v -e -i` command flags),
and actionable unknown-flag/unknown-command errors.

The operator control plane adds these checks:

```sh
node --check dsh-plugin-watchlist-autobet/client.js
node Scratch/watchlist-autobet/http-harness.mjs      # Lead harness (Scratch is gitignored)
```

The Client half passes `node --check`, `bun fmt --check`, oxlint and the repo's fetch/innerHTML
scanners, plus a fake-loader/render harness covering both slot registrations, en/zh dictionary
agreement, the Queue/Signals tabs, the operator-name gate (approve and signals-enqueue refuse
without sending any mutation), the POST wire format (`confirm: true` + the CSRF header), CLI
refusals preserved inline, and unmount aborting in-flight reads while clearing every
timer/listener. The Host routes are exercised by the Lead harness against the real CLI (44
checks: board shape/honesty; signals query validation, keyed cache, include-rejected gate
verdicts and payload honesty; foreign-origin/CSRF/confirm refusals; operator-required approvals;
structured missing-intent refusals; malformed-body status alignment) and were also run live
against the running Harness carrier (15 checks). Visual rendering and the live Client boot
remain unverified without browser control: **reload the GUI page once after installing or
upgrading** so the Client module and sidebar entry load.

## Installing

Installation is an operator action, not a tool: install the bundle directory with
`plugin_manager` `install_bundle` (current profile), confirm the nine tools are listed and the
operator page appears in the sidebar (reload the GUI page once after install/upgrade). Installing
does not enable live execution — that path does not exist.

### Multiple browser sessions (web profile)

The desktop app is a single authenticated carrier: its auth is not shareable with an external
browser, so a plain desktop-port tab answers 401. Multiple simultaneous clients use the **web
profile**: `dsh web` (or `dsh --profile web`) prints a `dsh web:` URL carrying the process launch
token; each browser/tab opens it once, receives its own signed cookie (30 days), and afterwards
the clean URL keeps working. The same web Host serves the control plane when the bundle is in that
profile:

```sh
dsh plugin --profile web add /Users/nolarose/code/sportsdesk-ops/dsh-plugin-watchlist-autobet
# profile manager adds the dependency; ensure "dsh-plugin-watchlist-autobet" is in
# ~/.dsh/profiles/web/package.json -> dsh.profile.bundles, then restart/refresh the web GUI
```

On this machine both entries are in the `web` profile (backup:
`~/.dsh/profiles/web/package.json.bak-controlplane`) and the running multi-client web Host serves
the control-plane board (`GET /api/watchlist-autobet/board` → 200, paper-only, same repo ledger).
Every authenticated browser client sees the same root-scoped page/queue; each browser sets its own
operator name, decisions are actor-attributed, and the cross-process ledger lock serializes
concurrent actions across the desktop and web Hosts. Keep `dsh web` loopback-bound or behind its
trusted proxy/Cloudflare Access: the control-plane routes intentionally bypass the carrier cookie
auth (paper-only, local plumbing).

## Not implemented in v1

Live execution, a live adapter, automatic approval (approval is human), and a `watch`
tool (the CLI's `watch` loop is documented there and remains a shell command). There is no
tool that records a live order because there is no code that places one.
