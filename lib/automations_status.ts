/**
 * @file lib/automations_status.ts
 * @description Read-only snapshot of scheduled automations, gate readiness, bridge rollup
 * job outcomes, and the latest sanitized GSLive ticket verification receipt.
 */

import { existsSync, readFileSync } from "node:fs";
import type {
  AutomationScheduleSummary,
  AutomationsSnapshot,
  BridgeJobStatusSummary,
  TicketVerificationSummary,
} from "@sportsdesk-ops/contracts";
import {
  parseBridgeRollupState,
  resolveBridgeRollupStatePath,
} from "./bridge_rollup_cron.ts";
import {
  BRIDGE_SCHEDULE_IDS,
  checkShellJobRequirements,
  ReportingSchedulerService,
  type ScheduleDefinition,
} from "../services/reporting_scheduler_service.ts";
import { readGsliveTicketVerifyArtifact } from "../scripts/verify-gslive-tickets.ts";

export interface BuildAutomationsSnapshotOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bridgeStatePath?: string;
  readonly ticketVerifyPath?: string;
  readonly schedules?: readonly ScheduleDefinition[];
  readonly now?: () => Date;
}

function readBridgeSnapshot(statePath: string): {
  readonly updatedAt: string | null;
  readonly jobs: readonly BridgeJobStatusSummary[];
} {
  if (!existsSync(statePath)) {
    return { updatedAt: null, jobs: [] };
  }
  try {
    const parsed = parseBridgeRollupState(
      JSON.parse(readFileSync(statePath, "utf8")) as unknown,
    );
    if (parsed === null) {
      return { updatedAt: null, jobs: [] };
    }
    return {
      updatedAt: parsed.updatedAt,
      jobs: parsed.jobs.map((job) => ({
        id: job.id,
        label: job.label,
        ok: job.ok,
        durationMs: job.durationMs,
        ...(job.error === undefined ? {} : { error: job.error }),
      })),
    };
  } catch {
    return { updatedAt: null, jobs: [] };
  }
}

export function buildAutomationsSnapshot(
  options: BuildAutomationsSnapshotOptions = {},
): AutomationsSnapshot {
  const env = options.env ?? Bun.env;
  const nowDate = (options.now ?? (() => new Date()))();
  const bridgeOwnerSet = new Set<string>(BRIDGE_SCHEDULE_IDS);
  const rawSchedules =
    options.schedules ?? ReportingSchedulerService.defaultSchedules();

  const bridge = readBridgeSnapshot(
    options.bridgeStatePath ?? resolveBridgeRollupStatePath(),
  );
  const ticketVerification: TicketVerificationSummary | null =
    readGsliveTicketVerifyArtifact(options.ticketVerifyPath);

  const schedules: AutomationScheduleSummary[] = rawSchedules.map((s) => {
    const missing = checkShellJobRequirements(s.shellJob?.requires, env);
    const derivedLastRun =
      s.lastTriggeredAt ??
      (s.id === "sched_gslive_tickets_verify_30m"
        ? (ticketVerification?.verifiedAt ?? null)
        : s.reportType === "BRIDGE_ROLLUP_DIGEST"
          ? bridge.updatedAt
          : null);
    return {
      id: s.id,
      name: s.name,
      scheduleTime: s.scheduleTime,
      tz: s.tz ?? "America/New_York",
      reportType: s.reportType,
      owner: bridgeOwnerSet.has(s.id) ? "daemon" : "bot",
      enabled: s.enabled,
      gateReady: missing.length === 0,
      missingRequirements: missing,
      lastTriggeredAt: derivedLastRun,
    };
  });

  return {
    observedAt: nowDate.toISOString(),
    bridgeRollupUpdatedAt: bridge.updatedAt,
    bridgeJobs: bridge.jobs,
    schedules,
    ticketVerification,
  };
}
