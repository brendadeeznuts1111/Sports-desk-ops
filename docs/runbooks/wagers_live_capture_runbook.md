# Wagers-by-state live capture (ajax.php) runbook

One automation derives the plugin's wager-state table from the Manager Tools `ajax.php`
`getBetReport` response. The offline CSV sorter remains available for retained exports, but the
automation entry point has **no CSV input**: every measured data field (window, identity, totals,
state rows, quality) is response-derived. Provenance fields (`source.*`, the requested
`from`/`to`/`dateFilterBy`) name the live request, and the capture clock supplies ages.

## Commands

```sh
# one capture now (writes the artifact the plugin reads)
GSID=... bun run wagers:capture

# exact operator-supplied body, verbatim
GSID=... bun run wagers:capture --payload Scratch/ajax-getBetReport-body.json

# session bootstrap the SPA itself uses (POST signin {checkSession:true} -> x-gs-session)
GSID=... bun run wagers:capture --bootstrap-session

# initial capture + in-process Bun.cron (no-overlap), every 15 minutes
GSID=... bun run wagers:watch --cron "0,15,30,45 * * * *"

# inspect without network or journal writes
bun run wagers:capture --dry-run --payload Scratch/ajax-getBetReport-body.json
```

`--ajax-url` exists for a local stand-in or proxy and defaults to the public endpoint. `--from`,
`--to`, `--date-filter-by` build a generated body when no `--payload` is given.

## Outputs

| Path                                                               | Meaning                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `Scratch/gslive-wagers-by-state.summary.json`                      | v2 artifact, same contract the `sportsdesk_wagers` plugin tool reads (`source.kind` = `live-ajax.php`) |
| `Scratch/wagers-by-state.status.json`                              | run journal: capped attempts, `lastSuccess`, `lastFailure`, sanitized error text, `alertCodes`         |
| `Scratch/wagers-by-state.{history.jsonl,tickets.json,alerts.json}` | capture history, ticket-state delta join key, derived alerts (see below)                               |

Both writes are atomic (temp file + rename). **A failed read never overwrites the last good
artifact.** A missing `GSID` fails before any request and journals the failure.

## History, ticket deltas, alerts

Every successful capture also updates three files next to the artifact (all atomic, all
`Scratch/`, gitignored):

| Path                                    | Content                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Scratch/wagers-by-state.history.jsonl` | one line per successful capture: totals, per-state rows, delta, quality flags, alerts. Bounded rewrite (`--keep-history`, default 500); never written on failure                              |
| `Scratch/wagers-by-state.tickets.json`  | previous/current `ticketId -> state` map used to compute `newTickets`, `goneTickets` and `migrations` (counts only; no ids leave this file)                                                   |
| `Scratch/wagers-by-state.alerts.json`   | deterministic derived alerts: `capture_stale`, `unknown_state`, `coherence_violation`, `pending_aging`, `state_spike`, `ticket_churn`, `alert_read_error`. Empty array = measured "no alerts" |

Thresholds: `--pending-warn-hours` (default 24), `--spike-pct` (25) with `--spike-min` (20),
`--cadence-minutes` (30, staleness = 2× cadence), churn = >25% of previous wagers with ≥20 previous.
`--fail-on-alert` exits 1 when a warn/critical alert fires; the artifact and automation files are
still written. The journal (`status.json`) gains a compact `alertCodes` list on successful runs.

The plugin surfaces this without recomputing it: `sportsdesk_wagers` with
`report:"automation"` (journal last success/failure, recent runs, alerts, file age/stale; MISSING
per file) and `report:"trends"` (per-capture series, latest migrations/new/gone counts, malformed
JSONL lines skipped and counted).

## OS-level scheduling

```sh
bun run wagers:capture --print-schedule [--cron "*/15 * * * *"]   # next fire + install/uninstall syntax
bun run wagers:capture --install-os  --cron "*/15 * * * *"        # requires a session; registers launchd/crontab job
bun run wagers:capture --uninstall-os
```

The worker entry performs exactly one capture per fire and exits non-zero on failure so the OS job
records it. `--install-os` refuses without a session; nothing is installed in tests.

## Session handling

Resolution order (manual cookies and plaintext env are no longer the preferred default):

1. **WebView profile** — `--webview-profile <dir>` or `GSLIVE_WEBVIEW_PROFILE`. `Bun.WebView`
   opens the profile's Chrome `--user-data-dir`, navigates to Manager Tools, proves the page is
   not a login form, reads the host cookies over CDP, and hands off one `Cookie` header
   (`lib/gslive_session.ts`, reusing the repo's cookie handoff). Nothing is printed or persisted.
2. **OS keychain** — `Bun.secrets` entry `service=sportsdesk-gslive`, `name=GSID`.
3. **Environment** — `GSID` in the SSOT `.env` mount, for CI/operator use.
4. Otherwise fail closed before any request; `--install-os` also refuses without a readable session.

Bootstrap the WebView profile once (no cookie ever enters this repo or chat):

```sh
open -na "Google Chrome" --args --user-data-dir="$HOME/.cache/sportsdesk/gslive-profile" \
  https://plive.sportswidgets.pro/manager-tools/
# sign in, close Chrome, then:
bun run wagers:capture --webview-profile "$HOME/.cache/sportsdesk/gslive-profile" \
  --payload Scratch/ajax-getBetReport-body.json
```

For the OS-level worker (no argv), set `GSLIVE_WEBVIEW_PROFILE` in the mounted environment. A
profile still showing a login form, with no cookies for the host, or without a `GSID` cookie fails
closed with a distinct message. The profile is locked while a session is read, so two captures
cannot share it.

Store a session without echoing it and without argv history (fallback when no profile is used):

```sh
printf '%s' "$GSID" | bun run secrets:gslive set   # stdin only; value never printed
bun run secrets:gslive status                      # "stored" / "absent", never the value
bun run secrets:gslive delete
```

`GS_SESSION` (optional `x-gs-session`) still comes from the environment. A keychain read failure
falls back to the env instead of blocking; a cookie pasted into chat, a commit or a script is a
credential incident: revoke it and re-provision. Nothing in this path prints or journals cookie
material.

## Transient retries

A failed capture is retried up to `--retries` (default 2) with `Bun.sleep(base × attempt)` backoff
(`--retry-backoff-ms`, default 250). Only transient failures retry — HTTP 5xx, timeouts, network
errors; 401/403 and an HTML login page fail immediately because a bad session is not a transient
fault. Each attempt is journaled honestly, and a failed run still writes no artifact/history.

## What is verified

- `bun test scripts/wagers_by_state_capture.test.ts` — a local `Bun.serve` stand-in proves the
  artifact's totals, state rows, identity and quality are all recomputed from the response; the
  supplied body is sent verbatim; a 500 preserves the previous artifact; no session makes zero
  requests; artifacts are written atomically; the plugin's artifact path matches the producer's.
- `bun test scripts/gslive_wagers_by_state.test.ts scripts/fetch-bet-tally.test.ts` — producer and
  wire client contracts.
- Live numbers are **not** available until a session is provisioned; the offline artifact in
  `Scratch/` is labelled `offline-csv` and must not be presented as a live read.

## Integrity sidecar and portable bundle

- Every successful capture writes `Scratch/wagers-by-state.sha256` next to the artifact, atomically
  with it: SHA-256 of the exact artifact bytes via `Bun.CryptoHasher`. `--debug` is not needed to
  consume it; the file is outside the frozen automation contract, so the plugin and verifiers are
  unaffected.
- `--archive <path.tar>` writes a portable bundle with `Bun.Archive`: `artifact.json`,
  `artifact.sha256`, `history.jsonl`, `alerts.json`, `status.json` and a `manifest.json` that names
  the hashes and totals. The ticket-state document (ticket ids) is **deliberately excluded**, and
  no cookie material is ever added. The archive is written temp-then-renamed.
- `--debug` prints the full `Bun.inspect` error chain (cause included, colors disabled) instead of
  the one-line sanitized message — useful for WebView/CDP failures.

## Attaching to the live Chrome (CLI, no cookie copying)

When Manager Tools is already signed in inside the operator's Chrome, the capture can use that
live session instead of a profile/keychain copy:

1. In that Chrome, open `chrome://inspect/#remote-debugging` and enable the toggle (Chrome asks
   for permission per connection).
2. Run `bun run wagers:capture --attach-chrome` (or `--dry-run --attach-chrome` first).

Trace provenance: every `--debug-wire` run writes a **unique** body file
(`Scratch/wagers-wire-response-<uuid>.json`) and logs the full 64-character sha256 plus byte count;
the `in N ms` figure is local trace timing, not endpoint latency. Unknown response fields are
tolerated by the producer (columns are looked up by name) and surface as `unknown [...]`;
`not-present [...]` lists contract columns absent from that response. Neither is fatal — a wire
addition is visible, and a removal shows up as a gap rather than silent data loss.

A successful capture writes six artifacts: `artifact.json`, `status.json`, `history.jsonl`,
`tickets.json`, `alerts.json`, the `wagers-by-state.sha256` sidecar — plus the capture log, the
stand-in/server log, and the per-run wire body when tracing.

`--attach-chrome` launches `Bun.WebView` in the chrome backend _without_ `url: false`, so Bun
auto-connects through `DevToolsActivePort`, opens a temporary Manager Tools tab in the running
browser, reads cookies with `Network.getAllCookies`, closes only that tab, and validates `GSID`
exactly like the profile path. Unattended modes (`--watch`, OS cron) never attach: they still use
the keychain/profile/env path, because a background job cannot depend on an open browser.

For wire-level debugging use `--debug-wire` (one-shot only, refused for `--watch`/`--install-os`):
it prints the complete request/response **shape** — method, URL, every header, the full payload
(validated against `parseBetReportRequest`), response status/headers, nested JSON shape, and the
producer's row-field coverage (`unknown` and `not-present` fields). It masks only the `Cookie`,
`set-cookie`, and `x-gs-session` **values**. The full response body is written to
`Scratch/wagers-wire-response.json` (gitignored) with its sha256, so row values stay out of
terminal/session logs.

Bun's native `BUN_CONFIG_VERBOSE_FETCH` section is available as `--verbose-fetch=<curl|true>`, but
guarded: the endpoint must be loopback (`127.0.0.1`/`localhost`), and the operator must set
`GSLIVE_ALLOW_CREDENTIAL_ECHO=1` because it prints raw `Cookie`/`x-gs-session` values. The live
manager endpoint is refused by the URL check; `--debug-wire` is the masked alternative there.

## Debugging the CLI

`bun run wagers:debug` starts the capture entrypoint under `bun --inspect-wait --dry-run`: execution
waits for a debugger connection, the printed `debug.bun.sh` URL opens Bun's inspector, and the dry
run never reaches the manager endpoint. Use this instead of attaching after the fact — a fast CLI
can finish before a debugger connects.

- Pin the inspector address when you need a reproducible attach URL (a bare port binds localhost):
  `bun --inspect-wait=localhost:4000 scripts/wagers_by_state_capture.ts --dry-run` or
  `bun --inspect-wait=localhost:4000/prefix scripts/wagers_by_state_capture.ts --dry-run`.
  With a path prefix the URL is exactly `ws://localhost:4000/prefix` — no random token — so keep it
  loopback-only; an attached inspector can execute code in the process.
- Break on the first line with `bun --inspect-brk scripts/wagers_by_state_capture.ts --dry-run`;
  never leave a breakpoint in a `--watch`/cron path, because a paused process stops capturing and a
  paused server never finishes a request.
- `BUN_CONFIG_VERBOSE_FETCH` is off by default. When enabled it prints credential header values, so
  this repo exposes it only as `--verbose-fetch` (loopback + `GSLIVE_ALLOW_CREDENTIAL_ECHO=1`) and
  keeps `--debug-wire` as the masked trace.
- Stack traces are V8-formatted; `--debug` prints `Bun.inspect(error)` with source context.
- Compiled executables do not support `--inspect` (`BUN_OPTIONS`/`BUN_INSPECT`); if this pipeline is
  ever compiled, build with `--compile-inspector`. OS scheduling already refuses a standalone
  executable because launchd/crontab needs a source worker path.
- The VS Code debugger is experimental (needs the Bun extension); the inspector URL is the
  dependency-free path.

## Verification matrix (local stand-in)

Pinned by `scripts/wagers_by_state_history.test.ts` (`verification matrix`) and reproduced with
`Scratch/wagers-demo/` fixtures (gitignored):

- One wager with two legs → `legs 7 / wagers 6`; the producer suite also pins legs-vs-wagers and
  spanning-parlay counting, so the distinction is not only fixture-level.
- `pending_aging.summary` carries the count: `1 pending legs older than 24h` → `2 pending legs
older than 24h` when the fixture gains an aged pending leg; the existing test asserts the same
  string shape (`2 pending legs older than 1h` under a lower threshold).
- A third capture of identical input yields `newTickets: 0`, `goneTickets: 0`, `migrations: []`;
  history still appends one line per successful capture (contract), with zero delta.
- 500, malformed envelope, timeout, and truncated-JSONL inputs each exit 1, journal `lastFailure`,
  and leave the existing artifact bytes unchanged; the truncated-history case creates no artifact.
- Scope: this proves **wire → artifact given a session** (env fixture). Cookie acquisition/refresh
  and `--attach-chrome` remain unproven until the live run.

## Verification

- `bun test --check <suites>` type-checks the test graph (test files plus everything they import)
  before running, so a type error cannot hide behind a green runtime pass.
- `bun check --no-script <files>` checks source files without consulting a package `check` script;
  `AGENT=1` (or `CLAUDECODE=1`) switches its error output to tagged blocks.
- Repo-wide `bun run typecheck` still carries two pre-existing errors outside this pipeline
  (`scripts/gslive_all_states_suspect_cron.ts`, `scripts/live_positions_cron.ts`); the scoped
  checks are the gate for these files until those are fixed.

## Configuration (Bun.TOML)

[`config/wagers-capture.toml`](../../config/wagers-capture.toml) is parsed with **`Bun.TOML`** and
validated once with zod (`lib/wagers_capture_config.ts`). Precedence is **CLI flag > TOML file >
built-in defaults**; `--config <path>` selects a file, and a path that does not exist is an error
rather than a silent fallback to defaults. Every section is `strict()`, so a misspelled key fails
validation instead of being ignored.

The file owns the defaults that used to be hard-coded: retries/backoff/timeout, `dateFilterBy`,
lookback, cron, journal/history retention, artifact/status/history/tickets/alerts/archive paths,
alert thresholds (including the churn pair), and the WebView profile path. Secrets are never read
from it. The older report renderer keeps its own `config/wagers.json`.

`Bun.semver` gates the pinned runtime against `package.json` engines in
`bun run verify:bun-cli`, and every capture bundle's `manifest.json` records
`runtime: { bun, revision }` from `Bun.version`/`Bun.revision`.

## Type discipline

- Provenance is a sum type: `OfflineWagerSource` (path+mtime, no request) or `LiveWagerSource`
  (request provenance, no file). "offline with a URL" and "live without a capture time" do not
  compile.
- `ManagerSession` is `{source:"none", cookieHeader:""} | {source:"keychain"|"env"|"webview-profile",
cookieHeader:string}`; `requireManagerSession` returns the non-empty variant. A session cannot be
  "none" while carrying a cookie.
- `LiveCaptureOutcome` is `LiveCaptureSuccess` (report + hash required) or `LiveCaptureFailure`
  (report/hash absent, error required). Consumers narrow on `ok` instead of testing fields.
- No `as` casts remain on product paths: the kept-column set is an explicit literal (a new
  `WAGER_COLUMNS` entry fails compilation), canonical state position is a `Map`, unknown-state
  detection uses set membership, and alert severity counting is exhaustive (`assertNever`).
- Test/JSON boundaries are parsed with zod rather than asserted. Unit suffixes stay in names
  (`EpochSec`, `Ms`); branded unit types are the next step if a mixed-unit bug ever appears.

## Bun CLI surface (pinned runtime 1.4.4)

The runtime's own flags are part of the contract. `--no-orphans` is used for the long-running
watch daemon so it cannot outlive its parent or leave descendants behind:

```sh
bun --no-orphans run scripts/wagers_by_state_capture.ts --watch     # what `bun run wagers:watch` does
bun --env-file=.env.gslive run wagers:capture ...                   # alternate credential env file
bun --no-env-file -p 'Bun.version'                                  # deterministic no-.env probe
bun -e 'import { resolveManagerSession } from "./scripts/fetch-bet-tally.ts";
const s = await resolveManagerSession(); console.log(s.source)'      # zero-file session probe
```

`tests/bun_cli_flags.test.ts` (`bun run verify:bun-cli`) reads `bun --help` and fails if a required
flag disappears or a package script asks Bun to parse a flag the runtime does not declare. It also
records the 1.4.4 gap: `--origin` is **not** a runtime flag here (docs snippets that show it are not
this version), and `-u` is `bun test --update-snapshots`, not a URL flag. The repo pins 1.4.4, so
those forms are not used.

## Rendering and Bun API choices

The human table/footer is rendered with Bun natives, not hand-rolled width math:

- `Bun.stringWidth(text, { ambiguousIsNarrow })` measures display columns for padding, and
  `Bun.wrapAnsi` wraps with the **same** ambiguity rule (explicit, so pad and wrap cannot disagree).
- Prose wraps at word boundaries and hard-breaks words that exceed the column; URLs/paths/ids in
  provenance use the token rule (hard break, no rewording).
- Width comes from `COLUMNS` when set (clamped 40–200), else 100. `COLUMNS=60 bun run wagers:capture`
  gives a narrow-terminal report; piped output stays plain.
- Atomic temp names use `Bun.randomUUIDv7()` (monotonic/sortable), not a Node crypto default.
- The capture history reader uses **`Bun.JSONL.parseChunk`**, not `Bun.JSONL.parse`: `parseChunk`
  reports `done` plus the unparsed tail, so truncation is observable. A torn final line **throws**
  instead of returning a shorter series; a malformed _complete_ line still falls back to
  skip-and-count so one bad line cannot hide the rest. Its input may be a string, a plain
  `ArrayBuffer`, or any view. The reader streams the file and carries only the partial tail between
  chunks — it never concatenates the whole window per iteration, so the zero-copy parse is not
  undone by accumulation.
- The Host plugin never calls Bun APIs itself (it runs in Electron's Node); it shells `bun` for the
  programs that do.
- Session acquisition uses `Bun.WebView` + CDP cookies (`lib/gslive_session.ts`, with the handed-off
  header validated by `Bun.CookieMap`), `Bun.secrets` for keychain fallback, and
  `Bun.secrets`/`Bun.stdin` in `secrets:gslive` so the cookie never lands in argv or shell history.
- Artifact integrity uses `Bun.CryptoHasher` (SHA-256 sidecar); portable capture bundles use
  `Bun.Archive`; `--debug` uses `Bun.inspect`.
- Bun APIs are imported explicitly from the `bun` module (`import { file, write, stringWidth, …
} from "bun"`) rather than reached through the global namespace; the remaining `Bun.` spelling is
  prose in comments and the `Bun.CronController` type. That keeps each runtime dependency visible
  and tree-shakeable.

## Troubleshooting

| Symptom                                    | Meaning                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `No manager session`                       | no keychain entry or env GSID; run `secrets:gslive set` or provision the SSOT path |
| `HTTP 401` / `text/html`                   | session expired; re-provision; do not retry with a pasted cookie                   |
| `HTTP 500`                                 | upstream failure; last artifact untouched, see `lastFailure` in the journal        |
| `no session: refusing to arm the schedule` | watch mode fails closed instead of looping unauthenticated                         |
