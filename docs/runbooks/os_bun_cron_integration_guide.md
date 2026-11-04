# SportsDesk & Fantasy402 OS Cron & Native Bun Cron Integration Guide

This guide details the integration of automated scheduled reporting and risk surveillance across **Linux OS Cron (`/etc/cron.d/sportsdesk-ops` / `crontab`)**, **OS-level Bun Cron (`Bun.cron(path, schedule, title)`)**, and the **In-Process Native Bun Cron Engine (`Bun.cron(schedule, callback)`)**.

---

## 1. Operational Scheduling Cadences (America/New_York)

| Job ID                          | Cadence                | Cron Syntax (NYC) | Cron Syntax (UTC) | Output Format | Target Action / Script                                  | Operational Objective                                                                      |
| :------------------------------ | :--------------------- | :---------------- | :---------------- | :------------ | :------------------------------------------------------ | :----------------------------------------------------------------------------------------- |
| **`hourly_snipers`**            | Hourly (:00)           | `0 * * * *`       | `0 * * * *`       | JSON          | `sportsdesk_cli.ts winners -p 24h`                      | Intra-day sniper surveillance; flags sharp accounts hitting max limits on opening numbers. |
| **`morning_audit_bundle`**      | Daily 08:00 EDT        | `0 8 * * *`       | `0 12 * * *`      | Table         | `./run_reports.sh --format table`                       | Morning briefing generating the complete 7-report auditable surveillance bundle.           |
| **`midday_steam_pulse`**        | Daily 13:00 EDT        | `0 13 * * *`      | `0 17 * * *`      | JSON          | `sportsdesk_cli.ts winners -p 7d --league NBA -m total` | Midday pulse detecting line moves, steam originations, and in-play velocity.               |
| **`evening_settlement_recap`**  | Daily 23:00 EDT        | `0 23 * * *`      | `0 3 * * *`       | Table         | `./run_reports.sh --format table`                       | Daily settlement figures, net house hold deficit/profit, and 50% agent liability balances. |
| **`weekly_settlement_rollup`**  | Monday 00:05 EDT       | `5 0 * * 1`       | `5 4 * * 1`       | CSV           | `./run_reports.sh --format csv`                         | Weekly 7-day settlement week rollup exported into timestamped CSV sheets.                  |
| **`monthly_leaderboard_sweep`** | 1st of month 00:10 EDT | `10 0 1 * *`      | `10 4 1 * *`      | CSV           | `sportsdesk_cli.ts leaderboard -p month --limit 50`     | 30-day dual-sided leaderboard review and lifetime house hold pillar rankings.              |

---

## 2. Scheduling Engine Architectures: Three Operational Tiers

SportsDesk categorizes automated workloads across three distinct scheduling paradigms depending on runtime persistence, resource isolation, and memory state sharing:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: Linux OS Cron (/etc/cron.d/sportsdesk-ops)                                               │
│ • System-level daemon persistence across machine reboots.                                         │
│ • Dispatches independent CLI processes (./run_reports.sh, sportsdesk_cli.ts).                    │
│ • Uses OS local timezone (America/New_York). Maximum isolation, zero memory sharing.             │
└──────────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼───────────────────────────────────────────────────────────────┐
│ TIER 2: OS-Level Bun Cron (Bun.cron(path, schedule, title))                                      │
│ • Registers persistent crontab / launchd / Task Scheduler entries via Bun CLI.                   │
│ • Invokes standalone script files on disk with dedicated subprocess lifecycles.                  │
│ • Uses OS local timezone. Lightweight registration, persistent system execution.                 │
└──────────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼───────────────────────────────────────────────────────────────┐
│ TIER 3: In-Process Bun Cron (Bun.cron(schedule, async () => { ... }))                            │
│ • Native in-process scheduler executing directly inside the long-running daemon / server.        │
│ • Shares in-memory state: SQLite connection pools, active WebSockets, telemetry caches.          │
│ • LOCAL-TIME SCHEDULED BY DEFAULT (pass { tz } to pin a zone). Strictly zero-overlap.           │
│ • Disposable via `using job = Bun.cron(...)`. Safe under `--hot` module reloading.               │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Architectural Comparison Matrix

| Property                    | Linux OS Cron (`/etc/cron.d`)     | OS-Level `Bun.cron(path, ...)`     | In-Process `Bun.cron(schedule, fn)`             |
| :-------------------------- | :-------------------------------- | :--------------------------------- | :---------------------------------------------- |
| **Execution Context**       | Standalone OS Subprocess          | Standalone OS Subprocess           | In-Process Event Loop Callback                  |
| **State Sharing**           | None (Disk / SQLite IPC)          | None (Disk / SQLite IPC)           | **Full In-Memory Object Sharing**               |
| **Timezone Reference**      | System Local (`America/New_York`) | System Local (`America/New_York`)  | **Local by default; pass `{ tz }` to pin**      |
| **Concurrent Overlap**      | Possible (Requires `flock(1)`)    | Possible (Requires external locks) | **Guaranteed Zero-Overlap** (waits for Promise) |
| **Hot Reloading (`--hot`)** | Unaffected                        | Unaffected                         | **Hot-Safe** (cleared & re-bound on save)       |
| **Resource Disposal**       | `crontab -r` / File deletion      | `Bun.cron.remove(title)`           | **Explicit Resource Management (`using`)**      |
| **Process Control**         | External init (`systemd`)         | External init (`launchd`/`cron`)   | **`.ref()` and `.unref()` controls**            |

### 2.2 Repo helper surface (`lib/bun_cron.ts`)

Fleet scripts should not call raw `Bun.cron` except inside this module. Wrappers mirror the three Bun entry points:

| Helper                                             | Maps to                                                                          |
| :------------------------------------------------- | :------------------------------------------------------------------------------- |
| `startInProcessCron(schedule, handler, { tz? })`   | In-process `Bun.cron(schedule, fn, { tz })`                                      |
| `wireInProcessCronLifecycle(job, { onShutdown? })` | `job.ref()` + SIGINT/SIGTERM → `job.stop()`                                      |
| `previewCronSchedule` / `formatCronScheduleLine`   | `Bun.cron.parse` for operator logs (`nextFire`)                                  |
| `parseCronSchedule` / `parseCronScheduleOrNull`    | Strict vs nullable next-fire                                                     |
| `installOsCronJob` / `removeOsCronJob`             | OS path + title; **install refuses `{ tz }`** (launchd/crontab have no IANA pin) |
| `isBunOsCronInvocation` / `osCronWorkerPath`       | Detect `--cron-title=` argv; absolute worker path                                |
| `CronScheduledWorker`                              | `export default { scheduled(controller) }` for Tier 2 workers                    |

Canonical consumers: `scripts/artifacts_cron.ts`, `scripts/f402_portal_drift_cron.ts`, `scripts/graph_feed_poller_daemon.ts`, `scripts/audit_docs_webview_cron.ts`, `services/reporting_scheduler_service.ts`.

### 2.3 OS-level registration & `scheduled()` worker (Bun docs)

```ts
// Register an OS-level cron job
await Bun.cron("./worker.ts", "30 2 * * MON", "weekly-report");

// Parse → next matching Date (local wall clock by default; { tz: "UTC" } to pin)
// parse() rejects `from` outside the ECMAScript Date range (#35122 #29282)
const next = Bun.cron.parse("*/15 * * * *");

// worker.ts
export default {
  async scheduled(controller) {
    // controller.cron === "30 2 * * 1"
    // controller.scheduledTime === 1737340200000
    await doWork();
  },
};
```

Repo install/remove: `bun run artifacts:cron --install-os --schedule "0 6 * * *"` (uses `installOsCronJob` + absolute worker path). Reference worker: `scripts/artifacts_cron.ts` `export default { scheduled(controller) }`.

**Bun v1.4 ship note:** in-process schedules and `parse()` default to **local time**; pass `{ tz }` on in-process `Bun.cron(schedule, handler, { tz })` or `Bun.cron.parse(expr, from, { tz })`. Constants: `BUN_CRON_V14_BLOG_LOCAL_TZ_URL` / `BUN_CRON_V14_BLOG_LOCAL_TZ_SHIP_NOTE` in `lib/bun_cron.ts`.

---

## 3. In-Process `Bun.cron()` Engine (v1.4+ Callback Overload)

The in-process callback overload of `Bun.cron` provides lightweight, shared-memory job scheduling for long-running surveillance daemons and web servers.

**CronJob handle (Bun docs):**

```ts
using job = Bun.cron("*/5 * * * *", async () => {
  await cleanupTempFiles();
});
job.cron; // "*/5 * * * *"
job.unref(); // allow process exit
job.stop(); // cancel (or let `using` dispose)
```

Repo code uses `startInProcessCron(...)` (same handle). Long-running CLIs call `wireInProcessCronLifecycle(job)` (`ref` + signals). Optional `startInProcessCron(..., { keepAlive: false })` calls `unref()` for hosts that should not pin the event loop.

### 3.1 Core Invariants & Runtime Mechanics

1. **Guaranteed Zero-Overlap Execution**:
   - The next execution timestamp is scheduled **only after** the previous handler (and its returned `Promise`) completely settles.
   - If an async surveillance sweep encounters slow upstream network responses or heavy database write locks, subsequent runs wait without piling up concurrent executions or exhausting connection pools.

2. **Timezone Semantics (Bun 1.4+)**:
   - In-process schedules evaluate in the **system local time** by default (Bun 1.3.12 evaluated strictly in UTC).
   - Pass `{ tz: "America/New_York" }` as the third argument to pin a zone; `reporting_scheduler_service.ts` does this.
   - For example, with `{ tz: "UTC" }`, `0 12 * * *` fires at 12:00 UTC; without it, the same expression follows the machine's local clock and DST.

3. **Fault-Tolerant Error Handling**:
   - Error semantics mirror `setTimeout`: synchronous throws emit `uncaughtException`, and rejected promises emit `unhandledRejection`.
   - Registering a standard error handler ensures the job automatically reschedules itself for its next scheduled window without crashing the parent process:

   ```typescript
   process.on("unhandledRejection", (err) => {
     console.error("[Cron Error] In-process task rejected:", err);
   });
   ```

4. **Hot-Reload Safety (`--hot`)**:
   - All in-process cron jobs registered via `Bun.cron()` are automatically unregistered and cleared before the Bun module graph re-evaluates.
   - Developers can modify scheduling cadences, update SQL queries, or edit alert thresholds without restarting the daemon or leaking orphaned timer handles.

5. **Deterministic Scope Disposal (`Disposable`)**:
   - `Bun.cron` implements `[Symbol.dispose]()`. When wrapped with TypeScript / ECMAScript `using`, the job automatically stops when the enclosing block exits:

   ```typescript
   {
     using sweepJob = Bun.cron("*/5 * * * *", async () => {
       await syncRiskCache();
     });
     // sweepJob automatically stopped if the scope exits or unmounts
   }
   ```

6. **Event Loop Steering (`.ref()` vs `.unref()`)**:
   - By default, `.ref()` keeps the Bun event loop active while scheduled jobs exist.
   - Calling `.unref()` allows short-lived CLI tasks or background daemons to execute scheduled maintenance while exiting cleanly once interactive CLI operations finish.

---

## 4. SportsDesk Production Implementation Patterns

### 4.1 Continuous In-Process Sniper Surveillance Daemon

```typescript
import { Database } from "bun:sqlite";

// Shared in-memory database and state
const db = new Database("data/sportsdesk.sqlite");
const activeAlerts = new Set<string>();

// Handle unhandled rejections to preserve recurring schedules
process.on("unhandledRejection", (err) => {
  console.error("[Cron Error] Sniper surveillance sweep failed:", err);
});

// Hourly sniper surveillance (runs on the hour in UTC: 0 * * * *)
// Implements Explicit Resource Management via Disposable
export function startSurveillanceDaemon(): Disposable {
  const job = Bun.cron("0 * * * *", async () => {
    console.log(
      `[Surveillance] Starting intra-day sniper audit at ${new Date().toISOString()}...`,
    );

    // In-memory query sharing connection pool with web server
    const query = db.query(`
      SELECT account_id, agent_id, SUM(risk_amount) as total_volume
      FROM pending_tickets
      WHERE created_at >= datetime('now', '-1 hour')
      GROUP BY account_id
      HAVING total_volume > 10000
    `);

    const snipers = query.all();
    for (const sniper of snipers) {
      console.warn(
        `[High Sizing Anomaly] Account ${sniper.account_id} placed $${sniper.total_volume} in last 60m`,
      );
    }
  });

  return job;
}
```

### 4.2 Rolling Syndicate Exposure & R2 Cloudflare Sync

```typescript
// Midday steam pulse (17:00 UTC = 13:00 EDT)
// Uses .unref() so script can exit if invoked as a batch worker
const steamJob = Bun.cron("0 17 * * *", async () => {
  console.log(
    "[Midday Pulse] Calculating steam originations and line moves...",
  );
  const proc = Bun.spawn(
    ["./run_reports.sh", "--format", "json", "--sync-r2"],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  await proc.exited;
});

// Set .ref() for dedicated service or .unref() for transient daemons
steamJob.ref();
```

### 4.3 Automated Documentation Error Audit Daemon (`Bun.cron` + `Bun.WebView` + `Bun.FetchSession`)

The documentation error finding daemon (`scripts/audit_docs_webview_cron.ts`) combines an in-process `Bun.cron` schedule (default `0 * * * *` in **local time**; pass `{ tz }` via `lib/bun_cron.ts` when you need an explicit IANA zone) with native `Bun.WebView` DOM navigation and `Bun.FetchSession` connection pooling to continuously audit the live documentation portal (`https://fantasy402-docs-4ay.pages.dev`):

```typescript
import {
  startDocsAuditCronDaemon,
  runDocumentationWebviewAudit,
} from "./scripts/audit_docs_webview_cron.ts";

// Launch continuous hourly in-process documentation auditor (0 * * * * UTC)
// Uses Explicit Resource Management to unregister cleanly on teardown
{
  using docsAuditDaemon = Bun.cron("0 * * * *", async () => {
    console.log(
      `[Doc Auditor] Starting scheduled audit sweep at ${new Date().toISOString()}...`,
    );
    const summary = await runDocumentationWebviewAudit();
    if (summary.status === "FAIL") {
      console.warn(
        `[Doc Auditor] Flagged ${summary.issuesFound} documentation issues!`,
      );
    }
  });

  docsAuditDaemon.ref();
}
```

#### Key Capabilities & Verification Vectors

1. **Console error interception**:
   - Captures page-side `console.*` calls through the WebView `console` callback and flags lines matching `CONSOLE_ERROR_PATTERN` (`error`, `uncaught`, `exception`, `refused`, `failed to load`, `typeerror`, `syntaxerror`). It does **not** install `window.onerror` or subscribe to `Runtime.exceptionThrown`, so an exception that never reaches `console` is invisible.
2. **Rendered-contract crawl**:
   - Waits for the Scalar shell to hydrate (`webview-content-settled`), then asserts the deployed body renders the documented operation markers (`getWebLog`, `getBetTicker`, `inferred`), the title pattern (`Wire API Reference|Scalar`), and the OpenAPI path contract (`EXPECTED_OPENAPI_PATH_COUNT = 71`). It does not issue search queries.
3. **Visual proof on every live pass**:
   - Captures a JPEG screenshot unconditionally for each completed live pass — not only on exceptions — to `reports/doc_audit_proofs/audit_<timestamp>.jpg`. A failed capture is recorded as a `MEDIUM` `SCREENSHOT` issue rather than aborting the pass.
4. **Structured JSON Diagnostics**:
   - Emits structured machine-readable error scorecards to `reports/docs_error_audit.json` with timestamped severity levels (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`).

---

## 5. Quick Commands & CLI Operations

```bash
# Run all 7 reports immediately with table output
./run_reports.sh --format table

# Run and automatically upload to Cloudflare R2
./run_reports.sh --format table --sync-r2

# Run weekly CSV settlement export
./run_reports.sh --format csv

# Launch the interactive SportsDesk CLI cron runner
bun sportsdesk_cli.ts cron --cadence hourly

# Execute single-pass automated docs error finding & schema audit
bun sportsdesk_cli.ts docs --audit
# or: bun run docs:audit

# Launch continuous in-process docs error audit surveillance daemon (hourly UTC)
bun sportsdesk_cli.ts docs --watch
# or: bun run docs:watch
```

---

## 6. Bridge rollup schedules (in-process `Bun.cron` in the webview daemon)

The four bridge rollups run from the long-lived webview daemon (`startBridgeSchedules()` in
`services/sportsdesk_webview_server.ts`), not from the Telegram bot daemon: the bot daemon starts
its schedules with `BRIDGE_SCHEDULE_IDS` excluded, so running both processes cannot publish twice
or send duplicate digests.

| Schedule                     | Cron           | Timezone          | Jobs                                                 |
| ---------------------------- | -------------- | ----------------- | ---------------------------------------------------- |
| `sched_bridge_rollup_15m`    | `*/15 * * * *` | `America/Chicago` | bridge3a `--once`, bridge3b, bridge3c `--fetch-open` |
| `sched_bridge_weblog_hourly` | `7 * * * *`    | `America/Chicago` | the WebLog corpus rollup                             |

The cycle is sequential (a tick cannot overlap itself; `startInProcessCron` skips an overlapping
fire), and the Telegram digest fires only when a gate, flag or job status **changed**. The first
tick establishes the baseline. The dashboard's Review Queue shows the current OK/FAIL state even
when no alert fired, and its "Dispatch digest" button sends the last recorded state — it does not
run the CLIs inside the request.

### Process flags

Every bridge child runs as `bun --no-orphans --no-env-file run <cli>`:

- `--no-orphans` — if the daemon dies mid-rollup, descendant fetches are SIGKILLed instead of
  surviving and racing the next tick to advance `latest.json`.
- `--no-env-file` — a stray repo `.env` cannot shadow the explicit child environment or the
  keychain. The daemon itself is launched with the same flag; `.env` is inert in production.
- The flag belongs on the production/cron entrypoints, **not** in `bunfig.toml` (a developer
  shell still wants `.env`). `--no-env-file` only suppresses _automatic_ loading; explicit
  `Bun.env.FOO` reads are unaffected.
- The same placement applies to every `bun run <script>`, not only `bun test`: verified on
  Bun 1.4.4 with a script printing `process.env.BUN_CHROME_PATH` (present by default, `null`
  under `bun --no-env-file run <script>`). Cron/daemon entrypoints that do not need `.env` must
  pass it; `--from-keychain` always runs with `--no-env-file` because it reads the Keychain, and
  the FIFO has to be inert so the credential source is unambiguous.
- **`--from-keychain` opt-in**: `F402_LIVE_LOGIN=1` must be in the invoking shell env or the
  launchd plist, never in `.env`. `--no-env-file` makes `.env` inert, so a `.env`-sourced opt-in
  is not seen and the command reports "not opted in" even though `--from-keychain` is correct.
- Production `.env`-style delivery should prefer a one-shot `--env-file=<(op read "op://…")`
  over the persistent 1Password FIFO: it is fetched fresh at process start, cannot go stale, and
  leaves exactly one credential mechanism in play (1Password at fetch time, macOS Keychain only
  at `Bun.secrets` time).

### Credentials

The daemon is a fresh process with no shell environment, so the gate reads the OS keychain:

- **Canonical service first, legacy second**: `com.bookdeskops.sportsdesk`, then
  `sportsdesk-ops` (`lib/secrets.ts`, mirroring `resolveSecretBackedEnv`). A bare read of the
  legacy service is the bug that makes a missing credential look like a wrong one.
- **bridge3c**: `resolveManagerSession()` is keychain-first, so a stored `GSID` satisfies it with
  no environment variable.
- **bridge3b**: the CLI sends `Authorization: Bearer`, so the gate requires `F402_BEARER_TOKEN`
  or a non-empty `F402_TOKEN_FILE`. The stored agent id/password are deliberately **not** enough:
  the cookie session is not accepted by that fetch.
- **bearer mint (3b)**: `POST /cloud/api/System/authenticateCustomer` was captured live on
  2026-11-04 and returns an HS256 agent JWT (1200 s expiry). Mint it over HTTP without a WebView:
  `F402_LIVE_LOGIN=1 bun run session:login --from-keychain --mint-bearer`; the token lands in
  `F402_TOKEN_FILE` (0600, default `$XDG_CONFIG_HOME/sportsdesk/f402-token`) and is read by
  `fetchF402Pending`. The token is accepted by `/cloud/api/System/*` and
  `/cloud/api/Report/Pending` (customer-scoped) — **not** by `/cloud/api/Manager/getPending`,
  which returns 500 for every tested shape. 3b therefore reads `Report/Pending`, per customer.
  It requires an explicit list: `--customers id,id`, `--customers-file <path>`, or
  `F402_PENDING_CUSTOMERS` (the daemon env is handed to the bridge child). A bearer fetch without
  a list exits 2 **before any network I/O**; `--allow-legacy-manager` keeps the dead
  Manager/getPending request for historical reproduction only. `--allow-partial` downgrades a
  per-customer failure to a warning; the default fails closed. There is **no**
  agent-wide/wildcard scope on Report/Pending (empty, `0`, `*`, `ALL`, agent login and
  `accountInfo.customerID` all returned 400 `Invalid CustomerID` on 2026-11-04).
- **list provisioning + long batches**: normalize the operator's complete customer export with
  `bun run customers:export --from <approved-export.json|csv> --out <list>` (0600, ids never
  printed), then point `F402_PENDING_CUSTOMERS_FILE` at it. The curated
  `enriched_customers_full.json` cohort is a test fixture, not a book — the exporter warns when it
  is used. A minted JWT lasts 1200 s: 3b refreshes it via `renewToken` when under 2 minutes remain
  (and retries once on a 401), backs off with jitter on 429/5xx/network failures
  (`--max-retries`, default 2), and bounds load with `--max-concurrency` (default 6, cap 16).
- **bridge3a**: needs an agent id (env `F402_AGENT_ID` or the keychain) **and** a readable
  session file. Only `F402_AGENT_ID` is injected into the child environment; the password is
  never passed on.

### 3b staging and production runs

Staging slice (the curated cohort is a test fixture; expect stale IDs):

```sh
# 1. slice — the source is at the repo root, not under Scratch/
bun run customers:export --from ./enriched_customers_full.json \
  --out ./Scratch/customers-staging.txt --limit 10

# 2. mint the bearer — a customer list is not a fetch trigger by itself
F402_LIVE_LOGIN=1 F402_TOKEN_FILE=Scratch/f402-token \
  bun --no-env-file run scripts/session_login.ts --from-keychain --mint-bearer

# 3. dry run (fail-closed by default)
F402_TOKEN_FILE=Scratch/f402-token \
F402_PENDING_CUSTOMERS_FILE=Scratch/customers-staging.txt \
  bun --no-env-file run scripts/f402_pending_bridge3b.ts --dry-run --no-r2 --no-ws

# 4. remove the temporary bearer
rm -f Scratch/f402-token
```

> **`HTTP 400 Invalid CustomerID` is data, not a bug.** It means the sampled cohort contains
> historical or closed accounts. Default is fail-closed: the run aborts rather than publishing a
> rollup missing part of the book. Re-export from the live book for production; use
> `--allow-partial` for staging only (it warns loudly and the rollup is incomplete).

Observed 2026-11-04 with the curated cohort: **2 of 10 IDs were live**, 8 returned HTTP 400; the
default run exited 1, and `--allow-partial` produced a 1-leg rollup with the sole cell suppressed
(`k=5`). That is the intended behaviour.

Production: normalize the operator's **complete, fresh** export, run the same command with
`--dry-run` first and **without** `--allow-partial`; only then drop `--dry-run --no-r2 --no-ws` to
publish. If the upstream rate-limits (`429`/`5xx`), lower `--max-concurrency`.

> **`deskDate` comes from the rows, not the wall clock.** It is derived from the maximum row
> timestamp; if the upstream serves stale data, the rollup date reflects that staleness. The
> 2026-11-04 staging run produced `deskDate=2026-09-14` from a 2026-10-29 capture — correct
> behaviour, but a signal to check upstream freshness before publishing.

Prerequisite: the keychain entry must allow `bun` without prompting. A prompt hangs the tick, and
a hanging tick blocks the next one — worse than a failure.

### Verification status

- Manual, credential-less cycle run: passed — all three credential jobs recorded as
  `missing credentials` without spawning, second tick silent, state + history written.
- Scheduled run: **not yet attempted.** It needs an agent-session host command that does not
  expose secrets; that path (`session:login --from-keychain`) and a real tick remain unverified.

### Session/token hygiene

`readF402Session()` validates shape (JSON object, non-empty cookie header, `Bearer` authorization
when present) before returning, and returns `null` on a malformed file instead of throwing. The
token reader rejects shell text and malformed JWT-shaped values. On 2026-11-04 two corrupted
credential files were removed after the keychain reads were confirmed: `~/.config/sportsdesk/`
`gslive-session` (73 B) and `f402-token` (90 B), both beginning with `umask`.
