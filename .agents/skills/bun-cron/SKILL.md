---
name: bun-cron
description: "Author, configure, verify, and debug native Bun cron workflows across all three execution models: expression parsing (Bun.cron.parse), in-process event-loop timers (using job = Bun.cron()), and persistent OS-level scheduled daemons (await Bun.cron(path, expr, title)). Covers scheduling semantics, timezone/DST handling, zero-overlap invariants, launchd/crontab/Task Scheduler lifecycle, and the scheduler vs. supervisor boundary."
---

# Native Bun Cron (`Bun.cron`)

Bun provides a native cron subsystem built into the runtime across three distinct invocation forms, backed by five exported TypeScript symbols.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                       Bun.cron                                         │
├──────────────────────────┬───────────────────────────────┬─────────────────────────────┤
│ 1. Expression Parser     │ 2. In-Process Event Loop      │ 3. Persistent OS-Level Job   │
│ Bun.cron.parse()         │ using job = Bun.cron()        │ await Bun.cron(path, ...)   │
├──────────────────────────┼───────────────────────────────┼─────────────────────────────┤
│ • Pure schedule math     │ • Event-loop background timer │ • System scheduler daemon   │
│ • Returns Date | null    │ • Returns CronJob handle      │ • Returns Promise<void>     │
│ • Zero background tasks  │ • Lifetime bound to process   │ • Survives reboots / exits  │
│ • No OS registration     │ • Shared in-memory state      │ • Spawns fresh subprocess   │
└──────────────────────────┴───────────────────────────────┴─────────────────────────────┘
```

---

## 1. Symbol & Interface Surface

The globals index exposes **five core symbols**:

| Symbol                     | Kind                           | Contract / Role                                                                                                                               |
| :------------------------- | :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Bun.cron`**             | `const` (callable + namespace) | The central callable implementing all three call overloads, plus `.parse()` and `.remove()`.                                                  |
| **`CronJob`**              | `interface`                    | Handle returned by in-process `Bun.cron(schedule, handler)`: exposes `.cron`, `.ref()`, `.unref()`, `.stop()`, and `[Symbol.dispose]()`.      |
| **`CronController`**       | `interface`                    | Context passed to an OS worker's `scheduled(controller)`: exposes `.cron` (string), `.type` (`"scheduled"`), and `.scheduledTime` (epoch ms). |
| **`CronOptions`**          | `interface`                    | Configuration object `{ tz?: string }`, accepted by in-process `Bun.cron()` and `Bun.cron.parse()`.                                           |
| **`CronWithAutocomplete`** | `type` (alias)                 | String literal union covering standard 5-field cron syntax (`"*/15 * * * *"`) and named presets (`"@hourly"`, `"@daily"`, `"@weekly"`).       |

> [!WARNING]
> **Documentation Signature Bug:** The Bun globals reference page renders the OS-level overload as `cron(path, title)` with the schedule omitted. That signature is garbled/truncated. The authoritative signature is the 3-argument form: **`await Bun.cron(path, schedule, title)`**.

---

## 2. The Three Operational Forms

### Form 1: Expression Parsing (`Bun.cron.parse`)

Pure schedule arithmetic. Computes the next occurrence timestamp without registering any timers or background jobs:

```ts
// Evaluates against system local time by default
const nextLocal = Bun.cron.parse("*/15 * * * *");

// Pin timezone explicitly via CronOptions
const nextUtc = Bun.cron.parse("0 8 * * *", new Date(), { tz: "UTC" });

// Invalid dates return null (e.g. Feb 30th)
const impossible = Bun.cron.parse("0 0 30 2 *"); // null
```

_(Note: Older docs mention an 8-year search horizon for `null` returns; on modern Bun 1.4+, distant leap years like 2036 evaluate without throwing)._

---

### Form 2: In-Process Event Loop Timer (`Bun.cron(schedule, handler, options)`)

An active timer running on Bun's JavaScript event loop inside a long-running process (e.g. API server, WebSocket hub, worker daemon):

```ts
// Disposable via `using` (ES2023 Explicit Resource Management)
{
  using job = Bun.cron(
    "*/5 * * * *",
    async () => {
      await syncMemoryCacheToDb();
    },
    { tz: "America/New_York" },
  );

  job.cron; // "*/5 * * * *"
  job.unref(); // Allow host process to exit if no other work remains
  job.ref(); // Keep process alive for this job
  job.stop(); // Explicit cancellation
} // Automatically stopped if scope exits
```

- **In-process memory sharing:** Directly accesses shared database pools, open WebSockets, and in-memory caches.
- **Lifetime:** Dies immediately when the parent process exits or terminates.

---

### Form 3: OS-Level Persistent Job (`await Bun.cron(path, schedule, title)`)

Registers an autonomous job with the host operating system's scheduler:

- **macOS:** `launchd` (`~/Library/LaunchAgents/bun.cron.<title>.plist`)
- **Linux:** User `crontab`
- **Windows:** Task Scheduler

#### Minimal Worker Skeleton (`worker.ts`)

```ts
// worker.ts — MUST export default { scheduled }
export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    console.log(
      `Fired ${controller.cron} (${controller.type}) at ${controller.scheduledTime}`,
    );
    await performMaintenanceTask();
  },
};
```

#### Registration and Removal

```ts
// Register (overwrites existing job with the same title in place)
await Bun.cron(
  import.meta.resolve("./worker.ts"),
  "0 8 * * *",
  "daily-maintenance",
);

// Clean uninstall (on macOS: launchctl bootout AND deletes the plist file)
await Bun.cron.remove("daily-maintenance");
```

---

## 3. The Scheduler vs. Supervisor Boundary

> [!IMPORTANT]
> **`Bun.cron` is a scheduler, NOT a process supervisor.**
> OS-level `Bun.cron` spawns a fresh subprocess on each tick that **exits as soon as `scheduled()` resolves**. It cannot keep a long-running daemon (such as an HTTP server listening on `:4020`) alive between fires.

| Requirement                                          | Correct Architecture                                                             | Why                                                                                          |
| :--------------------------------------------------- | :------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| **Long-running daemon / HTTP server** (e.g. `:4020`) | Dedicated OS service (`launchd` plist with `KeepAlive=true` / `systemd.service`) | Holds open socket listeners continuously across reboots and automatically restarts on crash. |
| **Periodic isolated task** (e.g. 08:00 report)       | OS-level `await Bun.cron(path, schedule, title)`                                 | Zero idle memory footprint; OS invokes worker on schedule and reaps it on completion.        |
| **Internal daemon sweep** (e.g. 15m cache sweep)     | In-process `Bun.cron(schedule, handler)`                                         | Shares existing database connections, closures, and active server state.                     |

---

## 4. Repo-Specific Invariants & Gotchas

### 1. The Port Resolution Mismatch (`:4020` vs `:3000`)

- **Precedence in `lib/bun_serve_port.ts`:**
  `resolveSportsdeskDaemonPort` follows: `BUN_PORT → PORT → NODE_PORT → 4020`.
- **Server fallback:** `services/sportsdesk_webview_server.ts` uses Bun's native port cascade, which defaults to **`:3000`** if `PORT` is unset in the environment.
- **The footgun:** The health watcher defaults to probing `http://127.0.0.1:4020/health`, while a bare `bun run services/sportsdesk_webview_server.ts` listens on `:3000`. Always run the server with explicit **`PORT=4020`**.

### 2. The Plist Regeneration Trap

- `bun.cron.<title>.plist` is generated by `Bun.cron(path, schedule, title)`.
- Re-registering with the same `title` **overwrites the plist file in place**. Any hand-edited keys (such as `<key>EnvironmentVariables</key>` with `DESK_HEALTH_URL`) will be **silently wiped** on the next `bun run health:watcher --install-os`.
- **Remedy:** Read configuration from a committed config file in `lib/health_watcher.ts`, or register a custom non-`bun.cron` launchd agent (`com.bookdeskops.sportsdesk.*.plist`).

### 3. Testing Invariant: `--dry-run` Has Side Effects

- Passing `--dry-run` to `health_watcher.ts` suppresses the external Telegram notification, **but `saveHealthWatcherState` still writes to disk** (`scratch/health-watcher-state.json`).
- Always test with an explicit temp state path to prevent dirtying working tree state:
  ```sh
  HEALTH_WATCHER_STATE_PATH=/tmp/hw-test.json bun run workers/health_watcher.ts --once --dry-run
  ```

---

## 5. Runtime & Platform Invariants

### Timezone & Daylight Saving Time (DST)

1. **Local time default:** Since Bun 1.4.0, all expressions default to the **system local timezone** (not UTC).
2. **OS registration timezone gotcha:** OS-level `Bun.cron(path, schedule, title)` accepts **no `{ tz }` option**. The OS scheduler executes in the host local timezone. To target UTC or an external timezone, pre-shift the cron expression or pin `TZ` in the execution environment.
3. **DST Spring-Forward:** If a scheduled time falls into the skipped hour, Bun shifts execution forward by the gap.
4. **DST Fall-Back:** Fixed times run once; wildcard (`*`) hours or minutes execute across both occurrences.

### Scheduling & Execution Invariants

- **Day fields use OR:** Standard cron semantics apply. `0 0 15 * FRI` runs on the 15th day of the month **OR** every Friday.
- **Strictly zero-overlap:** The next execution is calculated only **after** the previous handler promise settles. A slow task skips intermediate tick boundaries rather than stacking concurrent executions.
- **Error resilience:** If `scheduled()` or an in-process handler throws:
  - An `unhandledRejection` or `uncaughtException` is emitted.
  - Without an error listener, the immediate process exits with code `1`.
  - **The schedule survives:** The next scheduled execution will still fire on time.

### Platform Constraints

- **macOS (`launchd`):**
  - Plists are written to `~/Library/LaunchAgents/bun.cron.<title>.plist`.
  - Stdout/stderr are hardcoded by Bun to `/tmp/bun.cron.<title>.{stdout,stderr}.log`. Because `/tmp` is wiped on reboot, unattended jobs must write audit logs to `~/Library/Logs/<app>/` inside their handler.
  - Same `title` overwrites in place (no duplicate plists).
  - Clean uninstall via `await Bun.cron.remove(title)` executes `launchctl bootout` and removes the plist file.
- **Windows (Task Scheduler):**
  - Enforces a hard limit of **48 triggers per task**. Expressions with high-frequency intervals that cannot map cleanly (e.g. `*/7 * * * *`) throw an error.
  - Windows Docker containers do not support `Bun.cron` because Task Scheduler is disabled in container images.
- **Linux (`crontab`):**
  - Manipulates the current user's crontab directly.
