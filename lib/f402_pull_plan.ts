/**
 * Puller option parsing and a dry-run planner. Planned calls are allowlisted
 * reads only; a dry-run never opens a session or writes raw files.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeAgentTreeGeneralRows,
  normalizeAgentTreePlayerRows,
  parseListAgentsByAgentEnvelope,
} from "./f402_list_agents_by_agent.ts";
import {
  F402_PULL_DEFAULT_INTERVAL_MS,
  F402PullerError,
  eachUtcDateInclusive,
  formatGradedDate,
  loadCheckpoint,
  type F402PullPhase,
} from "./f402_readonly_puller.ts";
import type { PullReadOnlyOp } from "../scripts/capture/allowlist.ts";

export interface PullCliOptions {
  readonly resume: boolean;
  readonly dryRun: boolean;
  readonly intervalMs: number;
  readonly ratePerSec: number;
  readonly concurrency: number;
  readonly since: string | null;
  readonly agents: readonly string[];
  readonly accounts: readonly string[];
  readonly recurseDownline: boolean;
}

export interface PlannedCall {
  readonly operation: PullReadOnlyOp;
  readonly controller: "Manager" | "Report";
  readonly fields: Readonly<Record<string, string>>;
  readonly reason: string;
}

export interface PullPlan {
  readonly phase: F402PullPhase;
  readonly dryRun: true;
  readonly resume: boolean;
  readonly ratePerSec: number;
  readonly intervalMs: number;
  readonly concurrency: number;
  readonly since: string | null;
  readonly agents: readonly string[];
  readonly accounts: readonly string[];
  readonly recurseDownline: boolean;
  readonly from: string | null;
  readonly to: string | null;
  readonly calls: readonly PlannedCall[];
  readonly skipped: readonly {
    readonly reason: string;
    readonly key?: string;
  }[];
  readonly notes: readonly string[];
}

/** Comma-separated ids; empty tokens fail loudly. */
export function parseIdList(raw: string, flag: string): string[] {
  const parts = raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) {
    throw new F402PullerError(
      "config",
      "options",
      `${flag} needs at least one id`,
    );
  }
  return [...new Set(parts)];
}

export function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new F402PullerError(
      "config",
      "options",
      "--concurrency must be an integer >= 1 (default 1)",
    );
  }
  return n;
}

/** --rate N means N requests per second; default remains ~1 req/s. */
export function parseRateAndInterval(
  rateRaw: string | undefined,
  intervalRaw: string | undefined,
): { readonly ratePerSec: number; readonly intervalMs: number } {
  const defaultMs = F402_PULL_DEFAULT_INTERVAL_MS;
  if (rateRaw !== undefined && intervalRaw !== undefined) {
    const rate = Number(rateRaw);
    const intervalMs = Number(intervalRaw);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new F402PullerError("config", "options", "invalid --rate");
    }
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new F402PullerError("config", "options", "invalid --interval-ms");
    }
    const expected = rate === 0 ? defaultMs : 1000 / rate;
    if (Math.abs(expected - intervalMs) > 1) {
      throw new F402PullerError(
        "config",
        "options",
        "--rate and --interval-ms disagree; pass only one",
      );
    }
    return { ratePerSec: rate, intervalMs };
  }
  if (rateRaw !== undefined) {
    const rate = Number(rateRaw);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new F402PullerError(
        "config",
        "options",
        "--rate must be a positive number (requests per second)",
      );
    }
    return { ratePerSec: rate, intervalMs: 1000 / rate };
  }
  const intervalMs =
    intervalRaw === undefined ? defaultMs : Number(intervalRaw);
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new F402PullerError("config", "options", "invalid --interval-ms");
  }
  const ratePerSec =
    intervalMs === 0 ? Number.POSITIVE_INFINITY : 1000 / intervalMs;
  return { ratePerSec, intervalMs };
}

export function parseIsoDate(raw: string, flag: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
    !Number.isFinite(Date.parse(`${raw}T00:00:00Z`))
  ) {
    throw new F402PullerError(
      "config",
      "options",
      `${flag} must be YYYY-MM-DD`,
    );
  }
  return raw;
}

/** Inclusive start is the later of --since and --from. */
export function applySinceToRange(
  from: string | undefined,
  to: string | undefined,
  since: string | null,
  phase: F402PullPhase,
): { readonly from: string; readonly to: string } {
  if (from === undefined && since === null) {
    throw new F402PullerError("config", phase, "missing --from or --since");
  }
  if (to === undefined) {
    throw new F402PullerError("config", phase, "missing --to");
  }
  const start = [from, since].filter(
    (v): v is string => v !== undefined && v !== null,
  );
  const chosen = start.sort()[start.length - 1]!;
  const days = eachUtcDateInclusive(chosen, to);
  if (days.length === 0) {
    throw new F402PullerError("config", phase, `empty range ${chosen}..${to}`);
  }
  return { from: chosen, to };
}

export function resolveResume(
  resumeFlag: boolean,
  noResumeFlag: boolean,
): boolean {
  if (resumeFlag && noResumeFlag) {
    throw new F402PullerError(
      "config",
      "options",
      "pass only one of --resume or --no-resume",
    );
  }
  if (noResumeFlag) return false;
  return true;
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new F402PullerError(
      "config",
      "options",
      "--concurrency must be an integer >= 1",
    );
  }
  const out: R[] = Array.from({ length: items.length });
  if (concurrency === 1 || items.length <= 1) {
    for (let i = 0; i < items.length; i += 1) {
      out[i] = await fn(items[i]!, i);
    }
    return out;
  }
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        out[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export function filterCustomerIds(
  customerIds: readonly string[],
  accounts: readonly string[],
): string[] {
  if (accounts.length === 0) return [...customerIds];
  const allow = new Set(accounts.map((id) => id.toLowerCase()));
  return customerIds.filter((id) => allow.has(id.toLowerCase()));
}

export function downlineAgentIds(
  general: readonly { readonly agentId: string; readonly level: number }[],
  rootAgentId: string,
): string[] {
  const root = rootAgentId.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of general) {
    const id = row.agentId.trim();
    if (id === "" || id.toLowerCase() === root) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

function readCensusPlayers(outDir: string): {
  readonly customerIds: string[];
  readonly agentByCustomer: Map<string, string>;
  readonly generalAgentIds: string[];
} {
  const path = join(outDir, "raw/census/getListAgenstByAgent.json");
  if (!existsSync(path)) {
    return { customerIds: [], agentByCustomer: new Map(), generalAgentIds: [] };
  }
  const envelope = parseListAgentsByAgentEnvelope(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
  const players = normalizeAgentTreePlayerRows(envelope.PLAYERS);
  const agentByCustomer = new Map<string, string>();
  const customerIds: string[] = [];
  for (const player of players) {
    if (player.customerId === "") continue;
    customerIds.push(player.customerId);
    agentByCustomer.set(player.customerId, player.agent);
  }
  const general = normalizeAgentTreeGeneralRows(envelope.GENERAL);
  return {
    customerIds,
    agentByCustomer,
    generalAgentIds: general
      .map((row) => row.agentId)
      .filter((id) => id !== ""),
  };
}

export function customersForAgents(
  customerIds: readonly string[],
  agentByCustomer: ReadonlyMap<string, string>,
  agents: readonly string[],
): string[] {
  if (agents.length === 0) return [...customerIds];
  const allow = new Set(agents.map((id) => id.toLowerCase()));
  return customerIds.filter((id) => {
    const agent = agentByCustomer.get(id) ?? "";
    return allow.has(id.toLowerCase()) || allow.has(agent.toLowerCase());
  });
}

export interface PlanPullArgs {
  readonly phase: F402PullPhase;
  readonly outDir: string;
  readonly agentId: string;
  readonly agentOwner: string;
  readonly agentType: string;
  readonly options: PullCliOptions;
  readonly from?: string;
  readonly to?: string;
  readonly start?: string;
  readonly customer?: string;
  readonly mode?: string;
  readonly includeFigureDate?: boolean;
}

export function planPull(args: PlanPullArgs): PullPlan {
  const { phase, options, agentId } = args;
  const notes: string[] = [
    "Dry-run prints planned allowlisted reads only; it does not mint a session or write raw files.",
    "Default pacing stays ~1 req/s unless --rate or --interval-ms is set.",
    "--concurrency defaults to 1 so checkpoint writes stay ordered.",
  ];
  const calls: PlannedCall[] = [];
  const skipped: { reason: string; key?: string }[] = [];
  const census = readCensusPlayers(args.outDir);
  const checkpoint = loadCheckpoint(args.outDir);
  const customerIds = filterCustomerIds(
    customersForAgents(
      checkpoint?.customerIds ?? census.customerIds,
      census.agentByCustomer,
      options.agents,
    ),
    options.accounts,
  );

  const common: Record<string, string> = {
    ...(agentId ? { agentID: agentId } : {}),
    ...(args.agentOwner ? { agentOwner: args.agentOwner } : {}),
  };

  if (phase === "census") {
    calls.push({
      operation: "getHeriarchy",
      controller: "Manager",
      fields: { agentID: agentId },
      reason: "root hierarchy",
    });
    calls.push({
      operation: "getListAgenstByAgent",
      controller: "Manager",
      fields: {
        agentID: agentId,
        agentType: args.agentType || "M",
        ...(args.agentOwner ? { agentOwner: args.agentOwner } : {}),
      },
      reason: "root downline players",
    });
    if (options.recurseDownline) {
      const known = census.generalAgentIds.length
        ? downlineAgentIds(
            census.generalAgentIds.map((id) => ({ agentId: id, level: 1 })),
            agentId,
          )
        : options.agents;
      const targets =
        options.agents.length > 0
          ? known.filter((id) =>
              options.agents.some((a) => a.toLowerCase() === id.toLowerCase()),
            )
          : known;
      if (targets.length === 0) {
        notes.push(
          "--recurse-downline will add one getListAgenstByAgent call per GENERAL agent after the root list is fetched.",
        );
      }
      for (const id of targets) {
        calls.push({
          operation: "getListAgenstByAgent",
          controller: "Manager",
          fields: {
            agentID: id,
            agentType: "A",
            ...(args.agentOwner ? { agentOwner: args.agentOwner } : {}),
          },
          reason: `downline agent ${id}`,
        });
      }
    }
  } else if (phase === "contract") {
    const customer = args.customer ?? options.accounts[0];
    if (customer === undefined) {
      throw new F402PullerError("config", "contract", "missing --customer");
    }
    const start = args.start ?? "";
    calls.push({
      operation: "getTransactionList",
      controller: "Manager",
      fields: { ...common, acc: customer, start },
      reason: "dated contract start",
    });
    calls.push({
      operation: "getTransactionList",
      controller: "Manager",
      fields: { ...common, acc: customer, start: "" },
      reason: "empty-start contract",
    });
    calls.push({
      operation: "getDeletedTransactionHistory",
      controller: "Manager",
      fields: { customerID: customer },
      reason: "deleted history",
    });
  } else if (phase === "transactions") {
    if (customerIds.length === 0) {
      notes.push(
        "no customer ids in the checkpoint — run census first (or pass --accounts).",
      );
    }
    const done = new Set(
      options.resume ? (checkpoint?.completedCustomers ?? []) : [],
    );
    const start = args.start ?? options.since ?? "";
    for (const customerId of customerIds) {
      if (done.has(customerId)) {
        skipped.push({
          reason: "already completed in checkpoint",
          key: customerId,
        });
        continue;
      }
      calls.push({
        operation: "getTransactionList",
        controller: "Manager",
        fields: { ...common, acc: customerId, start },
        reason: `ledger ${customerId}`,
      });
      calls.push({
        operation: "getDeletedTransactionHistory",
        controller: "Manager",
        fields: { customerID: customerId },
        reason: `deleted ${customerId}`,
      });
    }
  } else if (phase === "weblog" || phase === "wagers") {
    const range = applySinceToRange(args.from, args.to, options.since, phase);
    const dates = eachUtcDateInclusive(range.from, range.to);
    if (phase === "weblog") {
      const done = new Set(
        options.resume ? (checkpoint?.completedWeblogDates ?? []) : [],
      );
      for (const date of dates) {
        if (done.has(date)) {
          skipped.push({
            reason: "already completed in checkpoint",
            key: date,
          });
          continue;
        }
        calls.push({
          operation: "getWebLog",
          controller: "Manager",
          fields: {
            ...common,
            date,
            type: args.mode ?? "I",
          },
          reason: `weblog ${date}`,
        });
      }
    } else {
      if (!(options.resume && checkpoint?.wagersPendingDone)) {
        calls.push({
          operation: "getPending",
          controller: "Manager",
          fields: { ...common, customerID: "0", date: range.to },
          reason: "open tickets",
        });
      } else {
        skipped.push({ reason: "pending already completed" });
      }
      if (!(options.resume && checkpoint?.wagersTickerDone)) {
        calls.push({
          operation: "getBetTicker",
          controller: "Manager",
          fields: { ...common, wagerNumber: "0" },
          reason: "live ticker window",
        });
      } else {
        skipped.push({ reason: "ticker already completed" });
      }
      const gradedDone = new Set(
        options.resume ? (checkpoint?.completedGradedDates ?? []) : [],
      );
      for (const date of dates) {
        if (gradedDone.has(date)) {
          skipped.push({ reason: "graded day already completed", key: date });
          continue;
        }
        const day = formatGradedDate(date);
        calls.push({
          operation: "getGraded",
          controller: "Manager",
          fields: { ...common, startDate: day, endDate: day },
          reason: `graded ${date} (MM-DD-YYYY)`,
        });
      }
      if (args.includeFigureDate !== false) {
        if (customerIds.length === 0) {
          notes.push(
            "figure-date is per customer; run census first or pass --accounts.",
          );
        }
        const figureDone = new Set(
          options.resume ? (checkpoint?.completedFigureDateKeys ?? []) : [],
        );
        for (const customerId of customerIds) {
          for (const date of dates) {
            const key = `${customerId}|${date}`;
            if (figureDone.has(key)) {
              skipped.push({ reason: "figure-date already completed", key });
              continue;
            }
            calls.push({
              operation: "getWagersByFigureDate",
              controller: "Report",
              fields: {
                ...common,
                customerID: customerId,
                figureDate: date,
                date,
              },
              reason: `figure-date ${customerId} ${date}`,
            });
          }
        }
      }
    }
  }

  const fromTo =
    phase === "weblog" || phase === "wagers"
      ? applySinceToRange(args.from, args.to, options.since, phase)
      : { from: args.from ?? null, to: args.to ?? null };

  return {
    phase,
    dryRun: true,
    resume: options.resume,
    ratePerSec: options.ratePerSec,
    intervalMs: options.intervalMs,
    concurrency: options.concurrency,
    since: options.since,
    agents: options.agents,
    accounts: options.accounts,
    recurseDownline: options.recurseDownline,
    from: typeof fromTo.from === "string" ? fromTo.from : null,
    to: typeof fromTo.to === "string" ? fromTo.to : null,
    calls,
    skipped,
    notes,
  };
}
