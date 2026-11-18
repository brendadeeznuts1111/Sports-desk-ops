/**
 * @file alert_audit.ts
 * @description Audit-stream helpers for the Alerts / DLQ tab: a stable JSONL
 * projection of each delivery, a free-text matcher, and status counts.
 *
 * The JSONL projection fixes the field order so two exports of the same stream
 * diff cleanly, and spells missing values as `null` instead of dropping keys.
 */

import type { DashboardAlertRecord } from "./types.ts";

/** One alert as it appears in an exported audit line; key order is the contract. */
export interface AlertAuditLine {
  readonly deliveryId: string;
  readonly status: string;
  readonly tier: string;
  readonly wagerId: string;
  readonly customerId: string;
  readonly amountUsd: number | null;
  readonly clvCents: number | null;
  readonly sport: string | null;
  readonly event: string | null;
  readonly selection: string | null;
  readonly oddsAmerican: string | null;
  readonly directive: string | null;
  readonly attempts: number | null;
  readonly messageId: number | null;
  readonly finalError: string | null;
  readonly retriedFrom: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedNotes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Normalize one delivery record for export. Missing fields become `null`. */
export function toAlertAuditLine(alert: DashboardAlertRecord): AlertAuditLine {
  return {
    deliveryId: alert.deliveryId,
    status: alert.status,
    tier: alert.tier,
    wagerId: alert.wagerId,
    customerId: alert.payload.customerId,
    amountUsd: alert.payload.amountUsd ?? null,
    clvCents: alert.payload.clvCents ?? null,
    sport: alert.payload.sport ?? null,
    event: alert.payload.event ?? null,
    selection: alert.payload.selection ?? null,
    oddsAmerican: alert.payload.oddsAmerican ?? null,
    directive: alert.payload.directive ?? null,
    attempts: alert.attempts ?? null,
    messageId: alert.messageId ?? null,
    finalError: alert.finalError ?? null,
    retriedFrom: alert.retriedFrom ?? null,
    acknowledgedBy: alert.acknowledgedBy ?? null,
    acknowledgedNotes: alert.acknowledgedNotes ?? null,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
  };
}

/** Single-line JSON for one alert (used by the row's copy action). */
export function alertAuditJson(alert: DashboardAlertRecord): string {
  return JSON.stringify(toAlertAuditLine(alert));
}

/**
 * Newline-delimited JSON for the visible audit stream, one record per line and
 * a trailing newline; empty input returns an empty string rather than a blank line.
 */
export function formatAlertAuditJsonl(
  alerts: readonly DashboardAlertRecord[],
): string {
  if (alerts.length === 0) return "";
  return `${alerts.map(alertAuditJson).join("\n")}\n`;
}

/**
 * Case-insensitive match over everything an operator can identify an alert by:
 * delivery id, ticket, customer, tier/status, error, lineage, ack note and the
 * payload's event/selection/odds. An empty query matches everything.
 */
export function alertMatchesQuery(
  alert: DashboardAlertRecord,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return true;
  const line = toAlertAuditLine(alert);
  const haystack = [
    line.deliveryId,
    line.status,
    line.tier,
    line.wagerId,
    line.customerId,
    line.amountUsd === null ? "" : String(line.amountUsd),
    line.clvCents === null ? "" : String(line.clvCents),
    line.sport ?? "",
    line.event ?? "",
    line.selection ?? "",
    line.oddsAmerican ?? "",
    line.directive ?? "",
    line.attempts === null ? "" : String(line.attempts),
    line.messageId === null ? "" : String(line.messageId),
    line.finalError ?? "",
    line.retriedFrom ?? "",
    line.acknowledgedBy ?? "",
    line.acknowledgedNotes ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

export interface AlertAuditCounts {
  readonly total: number;
  readonly dead: number;
  readonly queued: number;
  readonly delivered: number;
  readonly acknowledged: number;
}

/** Status counts for the records currently on screen. */
export function countAlerts(
  alerts: readonly DashboardAlertRecord[],
): AlertAuditCounts {
  let dead = 0;
  let queued = 0;
  let delivered = 0;
  let acknowledged = 0;
  for (const alert of alerts) {
    if (alert.status === "dead") dead += 1;
    else if (alert.status === "queued") queued += 1;
    else if (alert.status === "delivered") delivered += 1;
    else acknowledged += 1;
  }
  return {
    total: alerts.length,
    dead,
    queued,
    delivered,
    acknowledged,
  };
}
