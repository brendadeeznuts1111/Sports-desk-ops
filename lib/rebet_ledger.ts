/**
 * @file rebet_ledger.ts
 * @description Append-only paper ledger for re-bet opportunities and simulated fills.
 *
 * Path: `Scratch/rebet/ledger.jsonl`. One row per opportunity and one per simulated fill; the
 * `dedupeKey` prevents the watch loop from re-recording the same bet/venue/style on every tick.
 * Nothing here talks to a venue; live placement stays in the gated execution path.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RebetOpportunity, RebetStyle } from "./rebet_engine.ts";

export const REBET_LEDGER_RELATIVE = "Scratch/rebet/ledger.jsonl";

export type RebetDecisionAction = "approve" | "reject";

export interface RebetLedgerRow {
  readonly schemaVersion: 1;
  readonly kind: "opportunity" | "paper_fill" | "decision";
  readonly atIso: string;
  readonly dedupeKey: string;
  readonly status: "pending" | "simulated" | "approved" | "rejected";
  /** Present on opportunity and paper_fill rows. */
  readonly opportunity?: RebetOpportunity;
  /** Present on decision rows. */
  readonly opportunityId?: string;
  readonly action?: RebetDecisionAction;
  readonly actor?: string;
  readonly reason?: string | null;
}

export interface RebetOpportunityState {
  readonly opportunity: RebetOpportunity;
  readonly status: "pending" | "approved" | "rejected";
  readonly decidedBy?: string;
  readonly reason?: string | null;
}

export function resolveRebetLedgerPath(root: string): string {
  return join(root, REBET_LEDGER_RELATIVE);
}

export function rebetDedupeKey(opportunity: {
  betKey: string;
  venue: string;
  style: RebetStyle;
}): string {
  return `${opportunity.betKey}|${opportunity.venue}|${opportunity.style}`;
}

export async function readRebetLedger(root: string): Promise<{
  rows: RebetLedgerRow[];
  dedupeKeys: Set<string>;
  opportunities: Map<string, RebetOpportunityState>;
}> {
  let text: string;
  try {
    text = await readFile(resolveRebetLedgerPath(root), "utf8");
  } catch {
    return { rows: [], dedupeKeys: new Set(), opportunities: new Map() };
  }
  const rows: RebetLedgerRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as RebetLedgerRow;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        parsed.schemaVersion === 1 &&
        typeof parsed.dedupeKey === "string" &&
        ((parsed.kind !== "decision" &&
          parsed.opportunity !== null &&
          typeof parsed.opportunity === "object") ||
          (parsed.kind === "decision" &&
            typeof parsed.opportunityId === "string" &&
            (parsed.action === "approve" || parsed.action === "reject")))
      ) {
        rows.push(parsed);
      }
    } catch {
      // Malformed lines are skipped; the valid rows remain usable.
    }
  }
  const opportunities = new Map<string, RebetOpportunityState>();
  for (const row of rows) {
    if (row.kind === "opportunity" && row.opportunity !== undefined) {
      // Decisions are addressed by the opportunity id (`bet:venue:style`), while dedupe uses
      // the ledger key (`bet|venue|style`); index under the id a caller can see in `--list`.
      opportunities.set(row.opportunity.id, {
        opportunity: row.opportunity,
        status: "pending",
      });
    } else if (
      row.kind === "decision" &&
      row.action !== undefined &&
      row.opportunityId !== undefined
    ) {
      const existing = opportunities.get(row.opportunityId);
      if (existing !== undefined) {
        opportunities.set(row.opportunityId, {
          opportunity: existing.opportunity,
          status: row.action === "approve" ? "approved" : "rejected",
          ...(row.actor === undefined ? {} : { decidedBy: row.actor }),
          ...(row.reason === undefined || row.reason === null
            ? {}
            : { reason: row.reason }),
        });
      }
    }
  }
  return {
    rows,
    dedupeKeys: new Set(rows.map((row) => row.dedupeKey)),
    opportunities,
  };
}

export interface AppendRebetResult {
  readonly written: number;
  readonly skipped: number;
}

/**
 * Record new opportunities as `pending`. No fill is written until an operator approves the
 * opportunity. Already-recorded dedupe keys are skipped, so a watch loop is idempotent.
 */
export async function appendRebetOpportunities(
  root: string,
  opportunities: readonly RebetOpportunity[],
  options: { readonly now?: Date } = {},
): Promise<AppendRebetResult> {
  const { dedupeKeys } = await readRebetLedger(root);
  const atIso = (options.now ?? new Date()).toISOString();
  const rows: RebetLedgerRow[] = [];
  let skipped = 0;
  for (const opportunity of opportunities) {
    const dedupeKey = rebetDedupeKey(opportunity);
    if (dedupeKeys.has(dedupeKey)) {
      skipped += 1;
      continue;
    }
    dedupeKeys.add(dedupeKey);
    rows.push({
      schemaVersion: 1,
      kind: "opportunity",
      atIso,
      dedupeKey,
      status: "pending",
      opportunity,
    });
  }
  if (rows.length === 0) return { written: 0, skipped };
  await mkdir(join(root, "Scratch/rebet"), { recursive: true });
  await appendFile(
    resolveRebetLedgerPath(root),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return { written: rows.length, skipped };
}

export interface DecideRebetInput {
  readonly opportunityId: string;
  readonly action: RebetDecisionAction;
  readonly actor: string;
  readonly reason?: string | null;
  readonly atIso?: string;
}

export interface DecideRebetResult {
  readonly decision: RebetLedgerRow;
  /** Present when the decision is an approval: the simulated paper fill row. */
  readonly fill: RebetLedgerRow | null;
}

/**
 * Approve or reject one pending opportunity. Approval appends a simulated paper fill (the re-bet
 * is exercised at the opportunity's price); rejection requires a reason and appends no fill. A
 * second decision on the same opportunity is refused so the ledger stays unambiguous.
 */
export async function decideRebetOpportunity(
  root: string,
  input: DecideRebetInput,
): Promise<DecideRebetResult> {
  const actor = input.actor.trim();
  if (actor === "") throw new Error("actor is required");
  const opportunityId = input.opportunityId.trim();
  if (opportunityId === "") throw new Error("opportunityId is required");
  if (input.action === "reject" && (input.reason ?? "").trim() === "") {
    throw new Error("a rejection requires a reason");
  }
  const { opportunities } = await readRebetLedger(root);
  const existing = opportunities.get(opportunityId);
  if (existing === undefined) {
    throw new Error(`unknown opportunity: ${opportunityId}`);
  }
  if (existing.status !== "pending") {
    throw new Error(`opportunity already ${existing.status}: ${opportunityId}`);
  }
  const atIso = input.atIso ?? new Date().toISOString();
  const decision: RebetLedgerRow = {
    schemaVersion: 1,
    kind: "decision",
    atIso,
    dedupeKey: `${opportunityId}|decision`,
    status: input.action === "approve" ? "approved" : "rejected",
    opportunityId,
    action: input.action,
    actor,
    reason: (input.reason ?? "").trim() === "" ? null : input.reason!.trim(),
  };
  const rows: RebetLedgerRow[] = [decision];
  let fill: RebetLedgerRow | null = null;
  if (input.action === "approve") {
    fill = {
      schemaVersion: 1,
      kind: "paper_fill",
      atIso,
      dedupeKey: `${opportunityId}|fill`,
      status: "simulated",
      opportunity: existing.opportunity,
    };
    rows.push(fill);
  }
  await mkdir(join(root, "Scratch/rebet"), { recursive: true });
  await appendFile(
    resolveRebetLedgerPath(root),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return { decision, fill };
}
