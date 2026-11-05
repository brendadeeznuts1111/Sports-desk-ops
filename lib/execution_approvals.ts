/**
 * @file execution_approvals.ts
 * @description Human-in-the-loop approval ledger for execution decisions.
 *
 * A signal is only actionable for a run when an operator has explicitly approved it (and has not
 * rejected it later). Approvals are append-only JSONL at `Scratch/execution/approvals.jsonl`, one
 * row per decision, carrying the actor, the preferred order style and an optional reason. This is
 * the human decision layer; it never places an order and never mutates a plan by itself.
 *
 * Read model: the latest row per signal id wins, so a later reject overrides an earlier approve.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ExecutionApprovalAction = "approve" | "reject";
export type ExecutionApprovalStyle = "auto" | "taker" | "maker";

export interface ExecutionApproval {
  readonly schemaVersion: 1;
  readonly signalId: string;
  readonly action: ExecutionApprovalAction;
  readonly actor: string;
  readonly style: ExecutionApprovalStyle;
  readonly reason: string | null;
  readonly atIso: string;
}

export const EXECUTION_APPROVALS_RELATIVE = "Scratch/execution/approvals.jsonl";

export function resolveExecutionApprovalsPath(root: string): string {
  return join(root, EXECUTION_APPROVALS_RELATIVE);
}

export interface ExecutionApprovalsState {
  /** All rows in append order; empty when the ledger does not exist (not an error). */
  readonly rows: readonly ExecutionApproval[];
  /** Latest decision per signal id. */
  readonly latest: ReadonlyMap<string, ExecutionApproval>;
}

function isApproval(value: unknown): value is ExecutionApproval {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row["schemaVersion"] === 1 &&
    typeof row["signalId"] === "string" &&
    (row["action"] === "approve" || row["action"] === "reject") &&
    typeof row["actor"] === "string" &&
    (row["style"] === "auto" ||
      row["style"] === "taker" ||
      row["style"] === "maker") &&
    (row["reason"] === null || typeof row["reason"] === "string") &&
    typeof row["atIso"] === "string"
  );
}

export async function readExecutionApprovals(
  root: string,
): Promise<ExecutionApprovalsState> {
  let text: string;
  try {
    text = await readFile(resolveExecutionApprovalsPath(root), "utf8");
  } catch {
    return { rows: [], latest: new Map() };
  }
  const rows: ExecutionApproval[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isApproval(parsed)) rows.push(parsed);
    } catch {
      // A malformed line is skipped; the caller still sees the valid rows and can report it.
    }
  }
  const latest = new Map<string, ExecutionApproval>();
  for (const row of rows) latest.set(row.signalId, row);
  return { rows, latest };
}

export interface RecordApprovalInput {
  readonly signalId: string;
  readonly action: ExecutionApprovalAction;
  readonly actor: string;
  readonly style?: ExecutionApprovalStyle;
  readonly reason?: string | null;
  readonly atIso?: string;
}

/** Append one operator decision. Returns the row that was written. */
export async function appendExecutionApproval(
  root: string,
  input: RecordApprovalInput,
): Promise<ExecutionApproval> {
  const signalId = input.signalId.trim();
  const actor = input.actor.trim();
  if (signalId === "") throw new Error("signalId is required");
  if (actor === "") throw new Error("actor is required");
  if (input.action === "reject" && (input.reason ?? "").trim() === "") {
    throw new Error("a rejection requires a reason");
  }
  const row: ExecutionApproval = {
    schemaVersion: 1,
    signalId,
    action: input.action,
    actor,
    style: input.style ?? "auto",
    reason: (input.reason ?? "").trim() === "" ? null : input.reason!.trim(),
    atIso: input.atIso ?? new Date().toISOString(),
  };
  await mkdir(join(root, "Scratch/execution"), { recursive: true });
  await appendFile(
    resolveExecutionApprovalsPath(root),
    `${JSON.stringify(row)}\n`,
  );
  return row;
}

/** Latest approve-only signal ids, for a run that requires human approval. */
export function approvedSignalIds(
  state: ExecutionApprovalsState,
): readonly string[] {
  return [...state.latest.values()]
    .filter((approval) => approval.action === "approve")
    .map((approval) => approval.signalId);
}
