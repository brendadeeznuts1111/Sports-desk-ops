/**
 * @file lib/alerts.ts
 * @description In-flight surveillance alert queue, dispatch engine, retry backoff,
 * and dead-letter queue (DLQ) backed natively by the append-only audit log.
 */

import {
  auditWager,
  readAuditEntries,
  writeAuditEntry,
  type AuditEntry,
} from "./audit_log.ts";
import { sendTelegramAlert } from "./telegram.ts";
import { loadTomlConfig, type WagerTiersConfig } from "./wager_config.ts";

export type AlertTier = "CRITICAL" | "STEAM" | "LATENCY" | "RECREATIONAL";

export interface AlertPayload {
  customerId: string;
  sport?: string | undefined;
  event?: string | undefined;
  amountUsd?: number | undefined;
  clvCents?: number | undefined;
  directive?: string | undefined;
  oddsAmerican?: string | undefined;
  selection?: string | undefined;
  notes?: string | undefined;
}

export interface QueuedAlert {
  deliveryId: string;
  tier: AlertTier;
  wagerId: string;
  payload: AlertPayload;
  createdAt: string;
}

export interface AlertDeliveryResult {
  ok: boolean;
  messageId?: number | undefined;
  error?: string | undefined;
  retryAfterSec?: number | undefined;
}

export type AlertSender = (alert: QueuedAlert) => Promise<AlertDeliveryResult>;

export const DEFAULT_MAX_ALERT_ATTEMPTS = 5;
export const MAX_ALERT_ATTEMPTS =
  Number.isInteger(Number(Bun.env.SPORTSDESK_ALERT_MAX_ATTEMPTS)) &&
  Number(Bun.env.SPORTSDESK_ALERT_MAX_ATTEMPTS) >= 1
    ? Number(Bun.env.SPORTSDESK_ALERT_MAX_ATTEMPTS)
    : DEFAULT_MAX_ALERT_ATTEMPTS;

export const MAX_RETRY_LIFECYCLE_SEC = MAX_ALERT_ATTEMPTS * 3600; // 5 x 1h cap = 18,000s (5h)
export const RECOVERY_WINDOW_SEC = 48 * 3600; // 48h = 172,800s

// Invariant: recovery scan window must exceed maximum possible retry lifecycle
if (MAX_RETRY_LIFECYCLE_SEC >= RECOVERY_WINDOW_SEC) {
  throw new Error(
    `Recovery window (${RECOVERY_WINDOW_SEC}s) must exceed max retry lifecycle (${MAX_RETRY_LIFECYCLE_SEC}s)`,
  );
}

export const RATE_LIMIT_MS = 1000; // Telegram 1 msg/sec chat rate-limit
export const DEFAULT_SWEEP_INTERVAL_MS = 5000;

export interface EnqueueAlertOptions {
  deduplicate?: boolean | undefined;
  strict?: boolean | undefined;
  retriedFrom?: string | undefined;
}

/**
 * Uses native Bun.deepEquals to test structural equality of two alert payloads.
 * In strict mode, undefined properties are differentiated from omitted properties.
 */
export function isDuplicatePayload(
  a: AlertPayload,
  b: AlertPayload,
  strict = false,
): boolean {
  return Bun.deepEquals(a, b, strict);
}

/**
 * Enqueues a surveillance alert into the durable audit log stream.
 * Automatically generates a delivery UUID and emits an alert_queued event.
 * If deduplicate is enabled (default: true), returns the existing deliveryId
 * when an in-flight alert with an identical payload already exists.
 */
export async function enqueueAlert(
  params: {
    tier: AlertTier;
    wagerId: string;
    payload: AlertPayload;
  },
  options?: EnqueueAlertOptions,
): Promise<string> {
  const shouldDedupe = options?.deduplicate ?? true;
  if (shouldDedupe) {
    const isStrict = options?.strict ?? false;
    const state = recoverAlertState();
    for (const existing of state.queued.values()) {
      if (
        existing.wagerId === params.wagerId &&
        existing.tier === params.tier &&
        Bun.deepEquals(existing.payload, params.payload, isStrict)
      ) {
        return existing.deliveryId;
      }
    }
  }

  const deliveryId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  writeAuditEntry({
    ts: createdAt,
    category: "alert_queued",
    action: "enqueue",
    success: true,
    target: params.wagerId,
    details: {
      deliveryId,
      tier: params.tier,
      wagerId: params.wagerId,
      payload: params.payload,
      createdAt,
      ...(options?.retriedFrom ? { retriedFrom: options.retriedFrom } : {}),
    },
  });

  // Primary hook for wager action auditing
  auditWager({
    action: "alert_enqueued",
    customerId: params.payload.customerId,
    ticketId: params.wagerId,
    amount: params.payload.amountUsd,
    tier: params.tier,
    details: {
      deliveryId,
      directive: params.payload.directive,
    },
  });

  return deliveryId;
}

export interface ReconstructedAlertState {
  delivered: Set<string>;
  dead: Set<string>;
  acknowledged: Set<string>;
  failCounts: Map<string, number>;
  retrySchedules: Map<string, number>;
  queued: Map<string, QueuedAlert>;
  surveilledWagers: Set<string>;
}

/**
 * Replays recent audit log entries to recover in-flight queue state.
 * Survives process restarts without dropping alerts or duplicate-sending delivered alerts.
 */
export function recoverAlertState(now = new Date()): ReconstructedAlertState {
  const delivered = new Set<string>();
  const dead = new Set<string>();
  const acknowledged = new Set<string>();
  const failCounts = new Map<string, number>();
  const retrySchedules = new Map<string, number>();
  const queued = new Map<string, QueuedAlert>();
  const surveilledWagers = new Set<string>();

  const daysToScan = Math.max(2, Math.ceil(RECOVERY_WINDOW_SEC / 86400));
  const dates: Date[] = [];
  for (let i = 0; i < daysToScan; i++) {
    dates.push(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
  }

  const entries: AuditEntry[] = [];
  for (const date of dates) {
    entries.push(...readAuditEntries({ date }));
  }

  // Sort chronological
  entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  for (const entry of entries) {
    const details = entry.details as Record<string, unknown> | undefined;

    // Track surveilled wager tickets across restarts & reconnects
    if (entry.category === "alert_queued" || entry.category === "wager") {
      const ticketId =
        (details?.wagerId as string | undefined) ??
        (details?.ticketId as string | undefined) ??
        entry.target;
      if (ticketId) {
        surveilledWagers.add(ticketId);
      }
    }

    const deliveryId = details?.deliveryId as string | undefined;
    if (!deliveryId) continue;

    if (entry.category === "alert_delivered") {
      delivered.add(deliveryId);
      queued.delete(deliveryId);
    } else if (entry.category === "alert_dead") {
      dead.add(deliveryId);
      queued.delete(deliveryId);
    } else if (entry.category === "alert_acknowledged") {
      acknowledged.add(deliveryId);
      dead.delete(deliveryId);
      queued.delete(deliveryId);
    } else if (entry.category === "alert_delivery_failed") {
      const attemptN = Number(details?.attemptN ?? 1);
      failCounts.set(
        deliveryId,
        Math.max(failCounts.get(deliveryId) ?? 0, attemptN),
      );
      const nextRetryInSec = Number(details?.nextRetryInSec ?? 0);
      if (nextRetryInSec > 0) {
        const nextRetryAt =
          new Date(entry.ts).getTime() + nextRetryInSec * 1000;
        retrySchedules.set(deliveryId, nextRetryAt);
      }
    } else if (entry.category === "alert_queued") {
      if (
        !delivered.has(deliveryId) &&
        !dead.has(deliveryId) &&
        !acknowledged.has(deliveryId)
      ) {
        queued.set(deliveryId, {
          deliveryId,
          tier: (details?.tier as AlertTier) ?? "CRITICAL",
          wagerId: (details?.wagerId as string) ?? "",
          payload: (details?.payload as AlertPayload) ?? {
            customerId: "UNKNOWN",
          },
          createdAt: (details?.createdAt as string) ?? entry.ts,
        });
      }
    }
  }

  return {
    delivered,
    dead,
    acknowledged,
    failCounts,
    retrySchedules,
    queued,
    surveilledWagers,
  };
}

const inMemorySurveilledTickets = new Set<string>();

/**
 * Checks whether a wager ticket has already been processed by the surveillance engine,
 * verifying both the active in-memory set and the durable audit log recovery state.
 */
export function isWagerSurveilled(ticketId: string): boolean {
  if (inMemorySurveilledTickets.has(ticketId)) return true;
  const state = recoverAlertState();
  if (state.surveilledWagers.has(ticketId)) {
    inMemorySurveilledTickets.add(ticketId);
    return true;
  }
  return false;
}

export function recordSurveilledWager(ticketId: string): void {
  inMemorySurveilledTickets.add(ticketId);
}

export function resetSurveilledWagersCache(): void {
  inMemorySurveilledTickets.clear();
}

/**
 * Computes exponential backoff seconds for retries, honoring Telegram retry-after.
 */
export function calculateBackoffSec(
  attemptN: number,
  customRetryAfterSec?: number,
): number {
  if (customRetryAfterSec !== undefined && customRetryAfterSec > 0) {
    return Math.min(3600, customRetryAfterSec);
  }
  // Exponential backoff: 2s, 4s, 8s, 16s, 32s...
  return Math.min(3600, Math.pow(2, attemptN) * 2);
}

export interface AlertDispatcherOptions {
  sender?: AlertSender | undefined;
  maxAttempts?: number | undefined;
  rateLimitMs?: number | undefined;
  sweepIntervalMs?: number | undefined;
  calculateBackoff?:
    ((attemptN: number, customRetryAfterSec?: number) => number) | undefined;
}

/**
 * Surveillance Alert Dispatcher.
 * Periodically drains queued alerts, handles retry backoff on failure,
 * enforces chat rate limits, and dead-letters alerts exceeding max attempts.
 */
export class AlertDispatcher {
  private sender: AlertSender;
  private maxAttempts: number;
  private rateLimitMs: number;
  private sweepIntervalMs: number;
  private backoffFn: (attemptN: number, customRetryAfterSec?: number) => number;
  private timer: Timer | null = null;
  private isSweeping = false;
  private lastSendTime = 0;
  private retrySchedule = new Map<string, number>();

  constructor(opts?: AlertDispatcherOptions) {
    this.sender = opts?.sender ?? sendTelegramAlert;
    this.maxAttempts = opts?.maxAttempts ?? MAX_ALERT_ATTEMPTS;
    this.rateLimitMs = opts?.rateLimitMs ?? RATE_LIMIT_MS;
    this.sweepIntervalMs = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.backoffFn = opts?.calculateBackoff ?? calculateBackoffSec;
  }

  private liveMetrics: AlertHealthMetrics | null = null;
  private lastMetricsSync = 0;
  private readonly METRICS_CACHE_MS = 15_000;

  /**
   * Executes a single drain sweep over all pending alerts.
   * Public for deterministic unit testing and immediate on-demand flushes.
   */
  async sweepOnce(): Promise<{ sent: number; failed: number; dead: number }> {
    if (this.isSweeping) return { sent: 0, failed: 0, dead: 0 };
    this.isSweeping = true;

    let sent = 0;
    let failed = 0;
    let dead = 0;

    try {
      const state = recoverAlertState();
      const now = Date.now();

      // Populate retry schedule from recovered state if not already tracked
      for (const [id, sched] of state.retrySchedules) {
        if (!this.retrySchedule.has(id) && sched > now) {
          this.retrySchedule.set(id, sched);
        }
      }

      for (const [deliveryId, alert] of state.queued) {
        // Check dead-letter limit
        const priorFailures = state.failCounts.get(deliveryId) ?? 0;
        if (priorFailures >= this.maxAttempts) {
          writeAuditEntry({
            ts: new Date().toISOString(),
            category: "alert_dead",
            action: "dead_letter",
            success: false,
            target: alert.wagerId,
            details: {
              deliveryId,
              tier: alert.tier,
              afterAttempts: priorFailures,
              reason: "max_attempts_exceeded",
            },
          });
          this.retrySchedule.delete(deliveryId);
          dead++;
          continue;
        }

        // Check retry backoff window
        const nextRetryAt = this.retrySchedule.get(deliveryId) ?? 0;
        if (now < nextRetryAt) {
          continue;
        }

        // Check chat rate limit (max 1 send per rateLimitMs)
        const timeSinceLast = now - this.lastSendTime;
        if (timeSinceLast < this.rateLimitMs) {
          // Pause sweep and allow subsequent tick to continue
          break;
        }

        // Attempt delivery
        const sendStart = Date.now();
        const outcome = await this.sender(alert);
        this.lastSendTime = Date.now();

        if (outcome.ok) {
          writeAuditEntry({
            ts: new Date().toISOString(),
            category: "alert_delivered",
            action: "delivered",
            success: true,
            target: alert.wagerId,
            details: {
              deliveryId,
              tier: alert.tier,
              messageId: outcome.messageId,
              latencyMs: Date.now() - sendStart,
            },
          });
          this.retrySchedule.delete(deliveryId);
          sent++;
        } else {
          const attemptN = priorFailures + 1;
          if (attemptN >= this.maxAttempts) {
            writeAuditEntry({
              ts: new Date().toISOString(),
              category: "alert_dead",
              action: "dead_letter",
              success: false,
              target: alert.wagerId,
              details: {
                deliveryId,
                tier: alert.tier,
                afterAttempts: attemptN,
                finalError: outcome.error,
              },
            });
            this.retrySchedule.delete(deliveryId);
            dead++;
          } else {
            const backoffSec = this.backoffFn(attemptN, outcome.retryAfterSec);
            this.retrySchedule.set(deliveryId, Date.now() + backoffSec * 1000);
            writeAuditEntry({
              ts: new Date().toISOString(),
              category: "alert_delivery_failed",
              action: "delivery_failed",
              success: false,
              target: alert.wagerId,
              details: {
                deliveryId,
                tier: alert.tier,
                reason: outcome.error,
                attemptN,
                nextRetryInSec: backoffSec,
              },
            });
            failed++;
          }
        }
      }
    } finally {
      this.isSweeping = false;
      this.lastMetricsSync = 0;
    }

    return { sent, failed, dead };
  }

  /**
   * Returns in-memory alert health statistics without re-reading the audit log,
   * cached with 15s TTL to prevent probe-frequency disk and JSON parse amplification.
   */
  getHealthMetrics(forceRefresh = false): AlertHealthMetrics {
    const now = Date.now();
    if (
      this.liveMetrics &&
      !forceRefresh &&
      now - this.lastMetricsSync < this.METRICS_CACHE_MS
    ) {
      return this.liveMetrics;
    }
    const state = recoverAlertState();
    const queued = state.queued.size + state.delivered.size + state.dead.size;
    const delivered = state.delivered.size;
    const dead = state.dead.size;
    const backlog = state.queued.size;
    const acknowledged = state.acknowledged.size;
    const status: "ok" | "warning" | "degraded" =
      dead > 0 ? "degraded" : backlog > 10 ? "warning" : "ok";

    this.liveMetrics = {
      status,
      queued,
      delivered,
      dead,
      backlog,
      acknowledged,
    };
    this.lastMetricsSync = now;
    return this.liveMetrics;
  }

  recordAcknowledgment(): void {
    this.lastMetricsSync = 0;
  }

  /**
   * Starts the background sweep timer with an unref'd handle.
   */
  start(): void {
    if (this.timer) return;
    setActiveDispatcher(this);
    this.timer = setInterval(() => {
      this.sweepOnce().catch((err) => {
        if (Bun.env.DEBUG_TRACE === "1") {
          console.warn("[alert_dispatcher] sweep error:", err);
        }
      });
    }, this.sweepIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Stops the background sweep timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (activeDispatcherInstance === this) {
      setActiveDispatcher(null);
    }
  }
}

let activeDispatcherInstance: AlertDispatcher | null = null;

export function setActiveDispatcher(dispatcher: AlertDispatcher | null): void {
  activeDispatcherInstance = dispatcher;
}

export function getActiveDispatcher(): AlertDispatcher | null {
  return activeDispatcherInstance;
}

export interface AlertHealthMetrics {
  status: "ok" | "warning" | "degraded";
  queued: number;
  delivered: number;
  dead: number;
  backlog: number;
  acknowledged?: number | undefined;
}

/**
 * Computes alert health metrics for operator dashboard /health endpoint.
 * When an active AlertDispatcher is running, delegates to its cached in-memory metrics
 * for O(1) performance and 0 disk I/O.
 */
export function getAlertHealthMetrics(now = new Date()): AlertHealthMetrics {
  if (activeDispatcherInstance) {
    return activeDispatcherInstance.getHealthMetrics();
  }
  const state = recoverAlertState(now);
  const queued = state.queued.size + state.delivered.size + state.dead.size;
  const delivered = state.delivered.size;
  const dead = state.dead.size;
  const backlog = state.queued.size;
  const acknowledged = state.acknowledged.size;

  const status: "ok" | "warning" | "degraded" =
    dead > 0 ? "degraded" : backlog > 10 ? "warning" : "ok";

  return {
    status,
    queued,
    delivered,
    dead,
    backlog,
    acknowledged,
  };
}

/**
 * Acknowledges an alert (e.g. clearing a dead-letter alert) by an operator.
 * Emits alert_acknowledged to durable audit log stream and updates in-memory health metrics.
 */
export async function acknowledgeAlert(params: {
  deliveryId: string;
  operatorId: string;
  notes?: string | undefined;
}): Promise<boolean> {
  const state = recoverAlertState();
  const isDead = state.dead.has(params.deliveryId);
  const isQueued = state.queued.has(params.deliveryId);

  if (!isDead && !isQueued) {
    return false;
  }

  const alert = state.queued.get(params.deliveryId);
  const wagerId = alert?.wagerId ?? params.deliveryId;

  writeAuditEntry({
    ts: new Date().toISOString(),
    category: "alert_acknowledged",
    action: "acknowledge",
    success: true,
    actor: { username: params.operatorId },
    target: wagerId,
    details: {
      deliveryId: params.deliveryId,
      acknowledgedBy: params.operatorId,
      notes: params.notes,
      wasDead: isDead,
    },
  });

  if (activeDispatcherInstance) {
    activeDispatcherInstance.recordAcknowledgment();
  }

  return true;
}

/**
 * Replays a dead-lettered alert from the DLQ by resetting its attempt state and re-enqueuing.
 */
export async function retryAlert(params: {
  deliveryId: string;
  operatorId: string;
}): Promise<string | null> {
  const state = recoverAlertState();
  if (
    !state.dead.has(params.deliveryId) &&
    !state.acknowledged.has(params.deliveryId)
  ) {
    return null;
  }

  const entries = readAuditEntries({ category: "alert_queued" });
  const original = entries.find(
    (e) =>
      (e.details as Record<string, unknown> | undefined)?.deliveryId ===
      params.deliveryId,
  );

  if (!original) {
    return null;
  }

  const details = (original.details ?? {}) as Record<string, unknown>;
  const tier = (details.tier as AlertTier) ?? "CRITICAL";
  const wagerId = (details.wagerId as string) ?? original.target;
  const payload = (details.payload as AlertPayload) ?? {
    customerId: "UNKNOWN",
  };

  writeAuditEntry({
    ts: new Date().toISOString(),
    category: "alert_retried",
    action: "dlq_retry",
    success: true,
    actor: { username: params.operatorId },
    target: wagerId,
    details: {
      priorDeliveryId: params.deliveryId,
      retriedBy: params.operatorId,
    },
  });

  // Re-enqueue as fresh alert with linkage to previous delivery UUID
  const newDeliveryId = await enqueueAlert(
    { tier, wagerId, payload },
    { deduplicate: false, retriedFrom: params.deliveryId },
  );

  await acknowledgeAlert({
    deliveryId: params.deliveryId,
    operatorId: params.operatorId,
    notes: `Replayed from DLQ as ${newDeliveryId}`,
  });

  return newDeliveryId;
}

export interface AlertRecord {
  deliveryId: string;
  wagerId: string;
  tier: AlertTier;
  status: "queued" | "delivered" | "dead" | "acknowledged";
  payload: AlertPayload;
  createdAt: string;
  updatedAt: string;
  attempts?: number | undefined;
  finalError?: string | undefined;
  retriedFrom?: string | undefined;
  acknowledgedBy?: string | undefined;
  acknowledgedNotes?: string | undefined;
  messageId?: number | undefined;
}

/**
 * Lists reconstructed alerts within the durable audit log retention window,
 * optionally filtered by lifecycle status ("dead", "queued", "delivered", "acknowledged", "all").
 * Replays audit entries in chronological order so status transitions (failed -> dead -> acked) are exact.
 */
export function listAlerts(
  statusFilter?:
    "dead" | "queued" | "delivered" | "acknowledged" | "all" | string,
  now = new Date(),
): AlertRecord[] {
  const daysToScan = Math.max(2, Math.ceil(RECOVERY_WINDOW_SEC / 86400));
  const dates: Date[] = [];
  for (let i = 0; i < daysToScan; i++) {
    dates.push(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
  }

  const entries: AuditEntry[] = [];
  for (const date of dates) {
    entries.push(...readAuditEntries({ date }));
  }

  // Sort chronological so updates replay in exact lifecycle order
  entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  const alertMap = new Map<string, AlertRecord>();

  for (const entry of entries) {
    const details = entry.details as Record<string, unknown> | undefined;
    const deliveryId = details?.deliveryId as string | undefined;
    if (!deliveryId) continue;

    if (entry.category === "alert_queued") {
      alertMap.set(deliveryId, {
        deliveryId,
        wagerId: (details?.wagerId as string) ?? entry.target ?? "",
        tier: (details?.tier as AlertTier) ?? "CRITICAL",
        status: "queued",
        payload: (details?.payload as AlertPayload) ?? {
          customerId: "UNKNOWN",
        },
        createdAt: (details?.createdAt as string) ?? entry.ts,
        updatedAt: entry.ts,
        retriedFrom: details?.retriedFrom as string | undefined,
        attempts: 0,
      });
    } else if (entry.category === "alert_delivery_failed") {
      const existing = alertMap.get(deliveryId);
      const record: AlertRecord = existing ?? {
        deliveryId,
        wagerId: entry.target ?? "",
        tier: (details?.tier as AlertTier) ?? "CRITICAL",
        status: "queued",
        payload: { customerId: "UNKNOWN" },
        createdAt: entry.ts,
        updatedAt: entry.ts,
        attempts: 0,
      };
      const attemptN = Number(details?.attemptN ?? (record.attempts ?? 0) + 1);
      record.attempts = attemptN;
      record.finalError = (details?.reason as string) ?? record.finalError;
      record.updatedAt = entry.ts;
      alertMap.set(deliveryId, record);
    } else if (entry.category === "alert_delivered") {
      const existing = alertMap.get(deliveryId);
      const record: AlertRecord = existing ?? {
        deliveryId,
        wagerId: entry.target ?? "",
        tier: (details?.tier as AlertTier) ?? "CRITICAL",
        status: "delivered",
        payload: { customerId: "UNKNOWN" },
        createdAt: entry.ts,
        updatedAt: entry.ts,
      };
      record.status = "delivered";
      record.messageId = details?.messageId as number | undefined;
      record.updatedAt = entry.ts;
      alertMap.set(deliveryId, record);
    } else if (entry.category === "alert_dead") {
      const existing = alertMap.get(deliveryId);
      const record: AlertRecord = existing ?? {
        deliveryId,
        wagerId: entry.target ?? "",
        tier: (details?.tier as AlertTier) ?? "CRITICAL",
        status: "dead",
        payload: { customerId: "UNKNOWN" },
        createdAt: entry.ts,
        updatedAt: entry.ts,
      };
      record.status = "dead";
      record.attempts = Number(details?.afterAttempts ?? record.attempts ?? 1);
      record.finalError = (details?.finalError as string) ?? record.finalError;
      record.updatedAt = entry.ts;
      alertMap.set(deliveryId, record);
    } else if (entry.category === "alert_acknowledged") {
      const existing = alertMap.get(deliveryId);
      const record: AlertRecord = existing ?? {
        deliveryId,
        wagerId: entry.target ?? "",
        tier: "CRITICAL",
        status: "acknowledged",
        payload: { customerId: "UNKNOWN" },
        createdAt: entry.ts,
        updatedAt: entry.ts,
      };
      record.status = "acknowledged";
      record.acknowledgedBy =
        (details?.acknowledgedBy as string) ?? entry.actor?.username;
      record.acknowledgedNotes = details?.notes as string | undefined;
      record.updatedAt = entry.ts;
      alertMap.set(deliveryId, record);
    }
  }

  const allAlerts = Array.from(alertMap.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  if (!statusFilter || statusFilter === "all") {
    return allAlerts;
  }
  return allAlerts.filter((a) => a.status === statusFilter);
}

export interface ShiftSummary {
  date: string;
  operatorId: string;
  totalAlerts: number;
  deliveredAlerts: number;
  failedAttempts: number;
  deadLetterAlerts: number;
  acknowledgedAlerts: number;
  terminalCommandsCount: number;
  loginEventsCount: number;
}

export interface ShiftWindowOptions {
  from?: Date | string | undefined;
  to?: Date | string | undefined;
}

/**
 * Aggregates operator shift activity and surveillance alert metrics for shift handoff.
 * Supports flexible time windows across day/night shift boundaries (e.g. 22:00 -> 06:00).
 */
export function getShiftSummary(
  operatorId: string,
  windowOrDate: Date | ShiftWindowOptions = new Date(),
): ShiftSummary {
  let fromMs: number;
  let toMs: number;

  if (windowOrDate instanceof Date) {
    toMs = windowOrDate.getTime();
    fromMs = toMs - 24 * 60 * 60 * 1000;
  } else {
    toMs = windowOrDate.to ? new Date(windowOrDate.to).getTime() : Date.now();
    if (windowOrDate.from) {
      fromMs = new Date(windowOrDate.from).getTime();
    } else {
      fromMs = toMs - 24 * 60 * 60 * 1000;
    }
  }

  // Scan all UTC days covering [fromMs, toMs] to align with audit-YYYY-MM-DD.jsonl filenames
  const startUtc = new Date(fromMs);
  startUtc.setUTCHours(0, 0, 0, 0);
  const endUtc = new Date(toMs);
  endUtc.setUTCHours(23, 59, 59, 999);

  const dates: Date[] = [];
  const curr = new Date(startUtc);
  while (curr.getTime() <= endUtc.getTime()) {
    dates.push(new Date(curr));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  const entries: AuditEntry[] = [];
  for (const date of dates) {
    entries.push(...readAuditEntries({ date }));
  }

  let totalAlerts = 0;
  let deliveredAlerts = 0;
  let failedAttempts = 0;
  let deadLetterAlerts = 0;
  let acknowledgedAlerts = 0;
  let terminalCommandsCount = 0;
  let loginEventsCount = 0;

  for (const entry of entries) {
    const entryTime = new Date(entry.ts).getTime();
    if (entryTime < fromMs || entryTime > toMs) continue;

    if (entry.category === "alert_queued") totalAlerts++;
    else if (entry.category === "alert_delivered") deliveredAlerts++;
    else if (entry.category === "alert_delivery_failed") failedAttempts++;
    else if (entry.category === "alert_dead") deadLetterAlerts++;
    else if (entry.category === "alert_acknowledged") acknowledgedAlerts++;
    else if (entry.category === "pty") terminalCommandsCount++;
    else if (entry.category === "auth" && entry.action === "login") {
      loginEventsCount++;
    }
  }

  return {
    date: new Date(fromMs).toISOString().split("T")[0]!,
    operatorId,
    totalAlerts,
    deliveredAlerts,
    failedAttempts,
    deadLetterAlerts,
    acknowledgedAlerts,
    terminalCommandsCount,
    loginEventsCount,
  };
}

export interface WagerCandidate {
  ticketId: string;
  customerId: string;
  sport?: string | undefined;
  event?: string | undefined;
  selection?: string | undefined;
  oddsAmerican?: string | undefined;
  riskUsd: number;
  clvCents: number;
  sharpScore?: number | undefined;
  surveilledAt?: string | undefined;
}

/**
 * Classifies an incoming wager against declarative TOML tier policies.
 * If the matched tier mandates Telegram alerts, atomically enqueues an alert
 * and records an auditWager entry. Deduplicates against in-flight alerts via Bun.deepEquals.
 * Producer invariant: Idempotent by stable ticketId to prevent alert storms on reconnect/re-delivery.
 */
export async function processWagerSurveillance(
  wager: WagerCandidate,
  config?: WagerTiersConfig,
  options?: EnqueueAlertOptions,
): Promise<{
  tier: AlertTier;
  enqueued: boolean;
  deliveryId?: string | undefined;
  deduplicated?: boolean | undefined;
}> {
  // Producer invariant guard: idempotent by stable ticket identifier across reconnects and restarts
  if (wager.surveilledAt || isWagerSurveilled(wager.ticketId)) {
    return {
      tier: "RECREATIONAL",
      enqueued: false,
      deduplicated: true,
      deliveryId: undefined,
    };
  }
  wager.surveilledAt = new Date().toISOString();
  recordSurveilledWager(wager.ticketId);

  const cfg = config ?? (await loadTomlConfig());
  const score =
    wager.sharpScore ??
    (wager.clvCents >= 10 ? 9.0 : wager.clvCents >= 7 ? 7.5 : 3.0);

  let tier: AlertTier = "RECREATIONAL";
  const isHighRiskStake =
    wager.riskUsd >= cfg.surveillance.highRiskThresholdUsd &&
    (wager.clvCents > 0 || score >= 7.0);

  if (score >= cfg.tiers.CRITICAL.minScore || isHighRiskStake) {
    tier = "CRITICAL";
  } else if (
    score >= cfg.tiers.STEAM.minScore ||
    wager.clvCents >= cfg.surveillance.clvAlertThresholdCents
  ) {
    tier = "STEAM";
  } else if (score >= cfg.tiers.LATENCY.minScore) {
    tier = "LATENCY";
  }

  const tierConfig = cfg.tiers[tier] ?? cfg.tiers.BASELINE;
  let enqueued = false;
  let deliveryId: string | undefined = undefined;
  let deduplicated = false;

  if (tierConfig.alertTelegram) {
    const payload: AlertPayload = {
      customerId: wager.customerId,
      sport: wager.sport,
      event: wager.event,
      selection: wager.selection,
      oddsAmerican: wager.oddsAmerican,
      amountUsd: wager.riskUsd,
      clvCents: wager.clvCents,
      directive: `${tierConfig.action} (autoExecute: false)`,
    };

    if (options?.deduplicate ?? true) {
      const state = recoverAlertState();
      for (const existing of state.queued.values()) {
        if (
          existing.wagerId === wager.ticketId &&
          existing.tier === tier &&
          Bun.deepEquals(existing.payload, payload, options?.strict ?? false)
        ) {
          deliveryId = existing.deliveryId;
          deduplicated = true;
          enqueued = true;
          break;
        }
      }
    }

    if (!deliveryId) {
      deliveryId = await enqueueAlert(
        {
          tier,
          wagerId: wager.ticketId,
          payload,
        },
        options,
      );
      enqueued = true;
    }
  }

  return { tier, enqueued, deliveryId, deduplicated };
}
