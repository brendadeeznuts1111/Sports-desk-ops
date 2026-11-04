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

The CLI surface is covered by `bun test tests/watchlist_autobet.test.ts` (60 tests): paper
lifecycle, gate/config/ledger corruption, concurrency safety, and the CLI help contract —
root command table, every command's `--help` (usage, arguments, long and short flags, examples),
short-flag parsing (`-j -r -c -n` globals plus `-l -m -i -a -o -s -R -v -e -i` command flags),
and actionable unknown-flag/unknown-command errors.

## Installing

Installation is an operator action, not a tool: install the bundle directory with
`plugin_manager` `install_bundle` and confirm the nine tools are listed afterwards. Installing
does not enable live execution — that path does not exist.

## Not implemented in v1

Live execution, a live adapter, automatic approval (approval is human), and a `watch`
tool (the CLI's `watch` loop is documented there and remains a shell command). There is no
tool that records a live order because there is no code that places one.
