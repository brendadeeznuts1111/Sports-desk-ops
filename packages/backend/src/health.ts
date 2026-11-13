/**
 * @file packages/backend/src/health.ts
 * @description Throttled O(1) `/health` probe state machine for the dashboard server.
 */

export interface AlertHealthSnapshot {
  readonly status: string;
}

export interface DashboardHealthTrackerDeps<
  TAlertMetrics extends AlertHealthSnapshot = AlertHealthSnapshot,
> {
  readonly dbProbeMs?: number | undefined;
  readonly sweepMs?: number | undefined;
  readonly alertProbeMs?: number | undefined;
  readonly isDbConfigured: () => boolean;
  readonly probeDb: () => Promise<void>;
  readonly cleanupSessions: () => Promise<number>;
  readonly getAlertMetrics: () => TAlertMetrics;
  readonly getPort: () => number;
  readonly now?: (() => number) | undefined;
}

export interface DashboardHealthPayload<
  TAlertMetrics extends AlertHealthSnapshot = AlertHealthSnapshot,
> {
  readonly status: "ok" | "warning" | "degraded";
  readonly service: "sportsdesk-dev-dashboard";
  readonly port: number;
  readonly bunVersion: string;
  readonly uptimeSeconds: number;
  readonly db: string;
  readonly purgedSessions: number;
  readonly alerts: TAlertMetrics;
  readonly timestamp: string;
}

/** Throttles DB connectivity checks, session cleanup, and alert queue metrics for `/health`. */
export class DashboardHealthTracker<
  TAlertMetrics extends AlertHealthSnapshot = AlertHealthSnapshot,
> {
  private readonly dbProbeMs: number;
  private readonly sweepMs: number;
  private readonly alertProbeMs: number;
  private readonly deps: DashboardHealthTrackerDeps<TAlertMetrics>;
  private readonly nowFn: () => number;

  private lastDbProbe = 0;
  private lastSweep = 0;
  private lastAlertProbe = 0;
  private cachedDbStatus = "unconfigured";
  private cachedAlertMetrics: TAlertMetrics;

  constructor(deps: DashboardHealthTrackerDeps<TAlertMetrics>) {
    this.dbProbeMs = deps.dbProbeMs ?? 5_000;
    this.sweepMs = deps.sweepMs ?? 5 * 60_000;
    this.alertProbeMs = deps.alertProbeMs ?? 15_000;
    this.deps = deps;
    this.nowFn = deps.now ?? Date.now;
    this.cachedAlertMetrics = deps.getAlertMetrics();
  }

  async sample(): Promise<DashboardHealthPayload<TAlertMetrics>> {
    const now = this.nowFn();
    let purgedSessions = 0;

    if (this.deps.isDbConfigured()) {
      if (this.lastDbProbe === 0 || now - this.lastDbProbe > this.dbProbeMs) {
        this.lastDbProbe = now;
        try {
          await this.deps.probeDb();
          this.cachedDbStatus = "connected";
        } catch (err) {
          this.cachedDbStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
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
    }

    if (
      this.lastAlertProbe === 0 ||
      now - this.lastAlertProbe > this.alertProbeMs
    ) {
      this.lastAlertProbe = now;
      this.cachedAlertMetrics = this.deps.getAlertMetrics();
    }

    const overallStatus: "ok" | "warning" | "degraded" =
      this.cachedAlertMetrics.status === "degraded"
        ? "degraded"
        : this.cachedAlertMetrics.status === "warning"
          ? "warning"
          : "ok";

    return {
      status: overallStatus,
      service: "sportsdesk-dev-dashboard",
      port: this.deps.getPort(),
      bunVersion: Bun.version,
      uptimeSeconds: Math.floor(process.uptime()),
      db: this.cachedDbStatus,
      purgedSessions,
      alerts: this.cachedAlertMetrics,
      timestamp: new Date(now).toISOString(),
    };
  }
}
