/**
 * @file packages/backend/src/health.ts
 * @description Throttled O(1) `/health` probe state machine for the dashboard server.
 */

export type HealthStatus = "ok" | "degraded" | "down";
export type DbDependencyStatus = "ok" | "unconfigured" | "error";
export type R2DependencyStatus = "ok" | "degraded" | "error";

export function deriveOverallStatus(
  dbStatus: DbDependencyStatus,
  r2Status: R2DependencyStatus,
  deadAlerts: number,
): HealthStatus {
  if (dbStatus === "error" || r2Status === "error") return "down";
  if (
    dbStatus === "unconfigured" ||
    r2Status === "degraded" ||
    deadAlerts > 0
  ) {
    return "degraded";
  }
  return "ok";
}

export interface AlertHealthSnapshot {
  readonly status: string;
  readonly queued?: number | undefined;
  readonly delivered?: number | undefined;
  readonly dead?: number | undefined;
  readonly backlog?: number | undefined;
  readonly acknowledged?: number | undefined;
  readonly oldestQueuedAgeMs?: number | undefined;
  readonly lastDeliveryAt?: string | null | undefined;
}

export interface NormalizedAlertMetrics {
  readonly status: HealthStatus;
  readonly queued: number;
  readonly delivered: number;
  readonly dead: number;
  readonly backlog: number;
  readonly acknowledged: number;
  readonly oldestQueuedAgeMs: number;
  readonly lastDeliveryAt: string | null;
}

export interface CompanionDaemonDegradedReason {
  readonly message: string;
  readonly kind?: string | undefined;
  readonly severity?: string | undefined;
  readonly action?: string | null | undefined;
}

export interface CompanionDaemonHealthSnapshot {
  readonly online: boolean;
  readonly origin: string;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly status: string;
  readonly operationalStatus: string | null;
  readonly dataStatus: string | null;
  readonly runtime?: string | undefined;
  readonly uptimeSeconds?: number | undefined;
  readonly nodeEnv?: string | undefined;
  readonly version?:
    | {
        readonly gitSha?: string | undefined;
        readonly buildTime?: string | undefined;
        readonly nodeEnv?: string | undefined;
      }
    | undefined;
  readonly ingress?:
    | {
        readonly proxied?: boolean | undefined;
        readonly trustProxy?: boolean | undefined;
      }
    | undefined;
  readonly checks?: Record<string, unknown> | null | undefined;
  readonly degradedReasons: readonly CompanionDaemonDegradedReason[];
  readonly error?: string | null | undefined;
  readonly sampledAt: string;
}

export interface BuildHealthState {
  readonly startedAtNs: number;
  readonly dbStatus: DbDependencyStatus;
  readonly r2Status: R2DependencyStatus;
  readonly lastSnapshotAgeMs: number | null;
  readonly activeSessions: number;
  readonly purgedSessions: number;
  readonly wsBackpressureBytes: number;
  readonly alerts: NormalizedAlertMetrics;
}

export interface StructuredHealthPayload {
  readonly schemaVersion: 1;
  readonly status: HealthStatus;
  readonly service: "sportsdesk-dev-dashboard";
  readonly timestamp: string;
  readonly build: {
    readonly bunVersion: string;
    readonly expectedBunVersion: string;
    readonly bunVersionDrift: boolean;
  };
  readonly runtime: {
    readonly uptimeSeconds: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
  };
  readonly server: {
    readonly port: number | undefined;
    readonly pendingRequests: number;
    readonly pendingWebSockets: number;
    readonly wsBackpressureBytes: number;
  };
  readonly dependencies: {
    readonly db: { readonly status: DbDependencyStatus };
    readonly r2: {
      readonly status: R2DependencyStatus;
      readonly lastSnapshotAgeMs: number | null;
    };
  };
  readonly sessions: {
    readonly active: number;
    readonly purged: number;
  };
  readonly alerts: NormalizedAlertMetrics;
}

export function buildHealthPayload(
  server: {
    readonly port: number | undefined;
    readonly pendingRequests: number;
    readonly pendingWebSockets: number;
  },
  expectedBunVersion: string,
  state: BuildHealthState,
): StructuredHealthPayload {
  const mem = process.memoryUsage();
  const status = deriveOverallStatus(
    state.dbStatus,
    state.r2Status,
    state.alerts.dead,
  );

  return {
    schemaVersion: 1,
    status,
    service: "sportsdesk-dev-dashboard",
    timestamp: new Date().toISOString(),
    build: {
      bunVersion: Bun.version,
      expectedBunVersion,
      bunVersionDrift: Bun.version !== expectedBunVersion,
    },
    runtime: {
      uptimeSeconds: Math.max(
        0,
        Math.floor((Bun.nanoseconds() - state.startedAtNs) / 1e9),
      ),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
    },
    server: {
      port: server.port,
      pendingRequests: server.pendingRequests,
      pendingWebSockets: server.pendingWebSockets,
      wsBackpressureBytes: state.wsBackpressureBytes,
    },
    dependencies: {
      db: { status: state.dbStatus },
      r2: {
        status: state.r2Status,
        lastSnapshotAgeMs: state.lastSnapshotAgeMs,
      },
    },
    sessions: {
      active: state.activeSessions,
      purged: state.purgedSessions,
    },
    alerts: state.alerts,
  };
}

export interface DashboardHealthTrackerDeps<
  TAlertMetrics extends AlertHealthSnapshot = AlertHealthSnapshot,
> {
  readonly dbProbeMs?: number | undefined;
  readonly sweepMs?: number | undefined;
  readonly alertProbeMs?: number | undefined;
  readonly daemonProbeMs?: number | undefined;
  readonly expectedBunVersion?: string | undefined;
  readonly startedAtNs?: number | undefined;
  readonly isDbConfigured: () => boolean;
  readonly probeDb: () => Promise<void>;
  readonly cleanupSessions: () => Promise<number>;
  readonly countActiveSessions?: (() => Promise<number>) | undefined;
  readonly getAlertMetrics: () => TAlertMetrics;
  readonly getPort: () => number;
  readonly getServerCounters?:
    | (() => {
        readonly pendingRequests: number;
        readonly pendingWebSockets: number;
        readonly wsBackpressureBytes: number;
      })
    | undefined;
  readonly getR2Health?:
    | (() => {
        readonly status: R2DependencyStatus;
        readonly lastSnapshotAgeMs: number | null;
      })
    | undefined;
  readonly probeDaemon4020?:
    (() => Promise<CompanionDaemonHealthSnapshot>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface DashboardHealthPayload extends StructuredHealthPayload {
  /** Legacy flat fields preserved for backwards compatibility with older callers. */
  readonly port: number;
  readonly bunVersion: string;
  readonly uptimeSeconds: number;
  readonly db: string;
  readonly purgedSessions: number;
  readonly daemon4020?: CompanionDaemonHealthSnapshot | undefined;
}

function normalizeAlertHealthMetrics(
  metrics: AlertHealthSnapshot,
): NormalizedAlertMetrics {
  const status: HealthStatus =
    metrics.status === "down"
      ? "down"
      : metrics.status === "degraded" || metrics.status === "warning"
        ? "degraded"
        : "ok";
  return {
    status,
    queued: metrics.queued ?? 0,
    delivered: metrics.delivered ?? 0,
    dead: metrics.dead ?? 0,
    backlog: metrics.backlog ?? 0,
    acknowledged: metrics.acknowledged ?? 0,
    oldestQueuedAgeMs: metrics.oldestQueuedAgeMs ?? 0,
    lastDeliveryAt: metrics.lastDeliveryAt ?? null,
  };
}

function deriveR2FromDaemonSnapshot(daemon: CompanionDaemonHealthSnapshot): {
  readonly status: R2DependencyStatus;
  readonly lastSnapshotAgeMs: number | null;
} {
  const checks = daemon.checks;
  const pipelines =
    checks && typeof checks === "object" && checks.pipelines !== null
      ? (checks.pipelines as Record<string, unknown>)
      : null;
  if (!daemon.online || !pipelines) {
    return { status: "degraded", lastSnapshotAgeMs: null };
  }
  const fresh = Number(pipelines.r2Fresh ?? 0);
  const total = Number(pipelines.r2Total ?? 0);
  const r2StaleKeys = Array.isArray(pipelines.r2StaleKeys)
    ? pipelines.r2StaleKeys
    : [];
  const dataStaleKeys = Array.isArray(pipelines.dataStaleKeys)
    ? pipelines.dataStaleKeys
    : [];
  if (total > 0 && fresh === 0) {
    return { status: "error", lastSnapshotAgeMs: null };
  }
  if (fresh < total || r2StaleKeys.length > 0 || dataStaleKeys.length > 0) {
    return { status: "degraded", lastSnapshotAgeMs: null };
  }
  return { status: "ok", lastSnapshotAgeMs: null };
}

/** Throttles DB connectivity checks, session cleanup, companion daemon health, and alert queue metrics for `/health`. */
export class DashboardHealthTracker<
  TAlertMetrics extends AlertHealthSnapshot = AlertHealthSnapshot,
> {
  private readonly dbProbeMs: number;
  private readonly sweepMs: number;
  private readonly alertProbeMs: number;
  private readonly daemonProbeMs: number;
  private readonly expectedBunVersion: string;
  private readonly startedAtNs: number;
  private readonly deps: DashboardHealthTrackerDeps<TAlertMetrics>;
  private readonly nowFn: () => number;

  private lastDbProbe = 0;
  private lastSweep = 0;
  private lastAlertProbe = 0;
  private lastDaemonProbe = 0;
  private cachedDbStatus = "unconfigured";
  private cachedDbDepStatus: DbDependencyStatus = "unconfigured";
  private cachedActiveSessions = 0;
  private cachedAlertMetrics: TAlertMetrics;
  private cachedDaemon4020: CompanionDaemonHealthSnapshot | undefined =
    undefined;
  private inflightDaemonProbe: Promise<CompanionDaemonHealthSnapshot> | null =
    null;

  constructor(deps: DashboardHealthTrackerDeps<TAlertMetrics>) {
    this.dbProbeMs = deps.dbProbeMs ?? 5_000;
    this.sweepMs = deps.sweepMs ?? 5 * 60_000;
    this.alertProbeMs = deps.alertProbeMs ?? 15_000;
    this.daemonProbeMs = deps.daemonProbeMs ?? 5_000;
    this.expectedBunVersion = deps.expectedBunVersion ?? Bun.version;
    this.startedAtNs = deps.startedAtNs ?? Bun.nanoseconds();
    this.deps = deps;
    this.nowFn = deps.now ?? Date.now;
    this.cachedAlertMetrics = deps.getAlertMetrics();
  }

  private async refreshDaemonSnapshot(
    probe: () => Promise<CompanionDaemonHealthSnapshot>,
    sampledAtIso: string,
  ): Promise<CompanionDaemonHealthSnapshot> {
    if (this.inflightDaemonProbe !== null) {
      return this.inflightDaemonProbe;
    }
    const run = probe()
      .catch((err): CompanionDaemonHealthSnapshot => {
        // signal-honesty: intentional-companion-health-probe-fallback
        return {
          online: false,
          origin: "unknown",
          httpStatus: null,
          latencyMs: null,
          status: "offline",
          operationalStatus: "down",
          dataStatus: null,
          checks: null,
          degradedReasons: [],
          error: err instanceof Error ? err.message : String(err),
          sampledAt: sampledAtIso,
        };
      })
      .then((snap) => {
        this.cachedDaemon4020 = snap;
        this.lastDaemonProbe = this.nowFn();
        return snap;
      })
      .finally(() => {
        this.inflightDaemonProbe = null;
      });
    this.inflightDaemonProbe = run;
    return run;
  }

  async sample(): Promise<DashboardHealthPayload> {
    const now = this.nowFn();
    let purgedSessions = 0;

    if (this.deps.isDbConfigured()) {
      if (this.lastDbProbe === 0 || now - this.lastDbProbe > this.dbProbeMs) {
        this.lastDbProbe = now;
        try {
          await this.deps.probeDb();
          this.cachedDbStatus = "connected";
          this.cachedDbDepStatus = "ok";
          if (this.deps.countActiveSessions !== undefined) {
            try {
              this.cachedActiveSessions = await this.deps.countActiveSessions();
            } catch {
              // signal-honesty: intentional-session-count-fallback
              this.cachedActiveSessions = 0;
            }
          }
        } catch (err) {
          this.cachedDbStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
          this.cachedDbDepStatus = "error";
        }
      }

      if (this.lastSweep === 0 || now - this.lastSweep > this.sweepMs) {
        this.lastSweep = now;
        try {
          purgedSessions = await this.deps.cleanupSessions();
        } catch {
          // signal-honesty: intentional-fire-and-forget-session-cleanup
        }
      }
    } else {
      this.cachedDbStatus = "unconfigured";
      this.cachedDbDepStatus = "unconfigured";
      this.cachedActiveSessions = 0;
    }

    if (
      this.lastAlertProbe === 0 ||
      now - this.lastAlertProbe > this.alertProbeMs
    ) {
      this.lastAlertProbe = now;
      this.cachedAlertMetrics = this.deps.getAlertMetrics();
    }

    if (
      this.deps.probeDaemon4020 !== undefined &&
      (this.lastDaemonProbe === 0 ||
        now - this.lastDaemonProbe > this.daemonProbeMs)
    ) {
      await this.refreshDaemonSnapshot(
        this.deps.probeDaemon4020,
        new Date(now).toISOString(),
      );
    }

    const r2Health =
      this.deps.getR2Health !== undefined
        ? this.deps.getR2Health()
        : this.cachedDaemon4020 !== undefined
          ? deriveR2FromDaemonSnapshot(this.cachedDaemon4020)
          : { status: "ok" as const, lastSnapshotAgeMs: null };

    const port = this.deps.getPort();
    const counters = this.deps.getServerCounters?.() ?? {
      pendingRequests: 0,
      pendingWebSockets: 0,
      wsBackpressureBytes: 0,
    };
    const alerts = normalizeAlertHealthMetrics(this.cachedAlertMetrics);

    const payload = buildHealthPayload(
      {
        port,
        pendingRequests: counters.pendingRequests,
        pendingWebSockets: counters.pendingWebSockets,
      },
      this.expectedBunVersion,
      {
        startedAtNs: this.startedAtNs,
        dbStatus: this.cachedDbDepStatus,
        r2Status: r2Health.status,
        lastSnapshotAgeMs: r2Health.lastSnapshotAgeMs,
        activeSessions: this.cachedActiveSessions,
        purgedSessions,
        wsBackpressureBytes: counters.wsBackpressureBytes,
        alerts,
      },
    );

    const timestamp =
      this.deps.now !== undefined
        ? new Date(now).toISOString()
        : payload.timestamp;

    return {
      ...payload,
      timestamp,
      port,
      bunVersion: payload.build.bunVersion,
      uptimeSeconds: payload.runtime.uptimeSeconds,
      db: this.cachedDbStatus,
      purgedSessions,
      ...(this.cachedDaemon4020 !== undefined
        ? { daemon4020: this.cachedDaemon4020 }
        : {}),
    };
  }
}
