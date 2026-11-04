/**
 * Spec §5 — deterministic GENERAL AgentID / Login placeholders for repo fixtures.
 * Preserves trailing wire padding (oracle L2 map keys use padded Login / AgentID).
 */

import {
  trimPaddedField,
  type ListAgentsByAgentGeneralWireRow,
} from "./f402_list_agents_by_agent.ts";

function levelIndex(row: ListAgentsByAgentGeneralWireRow): number {
  const level = typeof row.Level === "number" ? row.Level : Number(row.Level);
  return Number.isFinite(level) ? level : 0;
}

/** Keep trailing space run from wire; never strip padding (portal tree keys are width-sensitive). */
export function replacePaddedWireLabel(
  token: string,
  previousRaw: string | undefined,
): string {
  const prev = String(previousRaw ?? "");
  if (trimPaddedField(prev) === "") return prev;
  const trailingSpaces = prev.length - prev.trimEnd().length;
  return `${token}${" ".repeat(trailingSpaces)}`;
}

/** @deprecated Use {@link replacePaddedWireLabel}. */
export function fitWireFieldWidth(
  token: string,
  previousRaw: string | undefined,
): string {
  return replacePaddedWireLabel(token, previousRaw);
}

/** One placeholder per row index within each Level (stable for oracle replay). */
export function applyProductionGeneralPlaceholders(
  general: readonly ListAgentsByAgentGeneralWireRow[],
): ListAgentsByAgentGeneralWireRow[] {
  const nextIndexByLevel = new Map<number, number>();
  return general.map((row) => {
    const level = levelIndex(row);
    const index = nextIndexByLevel.get(level) ?? 0;
    nextIndexByLevel.set(level, index + 1);
    const token = `AGENT_L${level}_N${index}`;
    const loginWasBlank = trimPaddedField(row.Login) === "";
    const agentIdWasBlank = trimPaddedField(row.AgentID) === "";
    return {
      ...row,
      ...(loginWasBlank
        ? {}
        : { Login: replacePaddedWireLabel(token, row.Login) }),
      ...(agentIdWasBlank
        ? {}
        : { AgentID: replacePaddedWireLabel(token, row.AgentID) }),
    };
  });
}

export function generalRowsDifferOnlyInAgentLabels(
  original: readonly ListAgentsByAgentGeneralWireRow[],
  placeholder: readonly ListAgentsByAgentGeneralWireRow[],
): boolean {
  if (original.length !== placeholder.length) return false;
  for (let i = 0; i < original.length; i += 1) {
    const a = original[i];
    const b = placeholder[i];
    if (a === undefined || b === undefined) return false;
    const { AgentID: _a1, Login: _a2, ...restA } = a;
    const { AgentID: _b1, Login: _b2, ...restB } = b;
    if (!Bun.deepEquals(restA, restB, true)) return false;
  }
  return true;
}
