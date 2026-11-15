/**
 * Derive the v1 R2 staleness runbook table from BRIDGE_STALENESS_TARGETS.
 * The runbook may restate the contract, but a drifted key, SLA, or source
 * fails with a named error instead of leaving operators on a stale table.
 */

import { BRIDGE_STALENESS_TARGETS, formatAge } from "./r2_staleness.ts";

export const R2_SLA_RUNBOOK_PATH = "docs/runbooks/r2_staleness_alert.md";

export const R2_SLA_DOC_CODES = {
  missingTable: "E_R2_SLA_DOC_MISSING_TABLE",
  missingKey: "E_R2_SLA_DOC_MISSING_KEY",
  extraKey: "E_R2_SLA_DOC_EXTRA_KEY",
  slaDrift: "E_R2_SLA_DOC_SLA_DRIFT",
  sourceDrift: "E_R2_SLA_DOC_SOURCE_DRIFT",
} as const;

export class R2SlaDocError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "R2SlaDocError";
    this.code = code;
  }
}

export interface RunbookSlaRow {
  readonly key: string;
  readonly sla: string;
  readonly source: string;
  readonly line: number;
}

const ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*(\S+)\s*\|\s*(.*?)\s*\|\s*$/;

export function parseRunbookSlaTable(text: string): RunbookSlaRow[] {
  const rows: RunbookSlaRow[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = ROW_RE.exec(line);
    if (match === null) continue;
    const key = match[1] ?? "";
    if (!key.endsWith("/latest.json")) continue;
    rows.push({
      key,
      sla: match[2] ?? "",
      source: (match[3] ?? "").trim(),
      line: index + 1,
    });
  }
  return rows;
}

export function checkR2SlaRunbook(text: string): void {
  const rows = parseRunbookSlaTable(text);
  if (rows.length === 0) {
    throw new R2SlaDocError(
      R2_SLA_DOC_CODES.missingTable,
      `E_R2_SLA_DOC_MISSING_TABLE: ${R2_SLA_RUNBOOK_PATH} has no v1 SLA table rows`,
    );
  }

  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const target of BRIDGE_STALENESS_TARGETS) {
    const row = byKey.get(target.key);
    const expectedSla = formatAge(target.slaMs);
    const expectedSource = target.description ?? target.label;
    if (row === undefined) {
      throw new R2SlaDocError(
        R2_SLA_DOC_CODES.missingKey,
        `E_R2_SLA_DOC_MISSING_KEY: ${R2_SLA_RUNBOOK_PATH} is missing ${target.key} (SLA ${expectedSla})`,
      );
    }
    if (row.sla !== expectedSla) {
      throw new R2SlaDocError(
        R2_SLA_DOC_CODES.slaDrift,
        `E_R2_SLA_DOC_SLA_DRIFT: ${R2_SLA_RUNBOOK_PATH}:${row.line} lists SLA ${row.sla} for ${target.key}, but BRIDGE_STALENESS_TARGETS derives ${expectedSla}`,
      );
    }
    if (row.source !== expectedSource) {
      throw new R2SlaDocError(
        R2_SLA_DOC_CODES.sourceDrift,
        `E_R2_SLA_DOC_SOURCE_DRIFT: ${R2_SLA_RUNBOOK_PATH}:${row.line} lists source ${JSON.stringify(row.source)} for ${target.key}, but BRIDGE_STALENESS_TARGETS describes ${JSON.stringify(expectedSource)}`,
      );
    }
  }

  for (const row of rows) {
    if (!BRIDGE_STALENESS_TARGETS.some((target) => target.key === row.key)) {
      throw new R2SlaDocError(
        R2_SLA_DOC_CODES.extraKey,
        `E_R2_SLA_DOC_EXTRA_KEY: ${R2_SLA_RUNBOOK_PATH}:${row.line} lists ${row.key}, which is not in BRIDGE_STALENESS_TARGETS`,
      );
    }
  }
}
