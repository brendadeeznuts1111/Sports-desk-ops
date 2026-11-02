/**
 * Agent-tree invariants mirroring portal `baseHeriarchy` (trim + uppercase keys).
 */

import type { ListAgentsByAgentGeneralWireRow } from "./f402_list_agents_by_agent.ts";
import { trimPaddedField } from "./f402_list_agents_by_agent.ts";

export interface AgentLoginCollision {
  readonly key: string;
  readonly agentIds: readonly string[];
  readonly seqNumbers: readonly number[];
}

export function agentLoginKey(row: ListAgentsByAgentGeneralWireRow): string {
  const login = trimPaddedField(row.Login);
  const agentId = trimPaddedField(row.AgentID);
  return (login || agentId).toUpperCase();
}

export function detectAgentLoginCollisions(
  general: readonly ListAgentsByAgentGeneralWireRow[],
): AgentLoginCollision[] {
  const seen = new Map<string, { agentId: string; seqNumber: number | null }>();
  const collisions = new Map<
    string,
    { agentIds: string[]; seqNumbers: number[] }
  >();

  for (const row of general) {
    const key = agentLoginKey(row);
    if (key === "") continue;
    const agentId = trimPaddedField(row.AgentID) || trimPaddedField(row.Login);
    const seqRaw = row.SeqNumber;
    const seqNumber =
      typeof seqRaw === "number" && Number.isFinite(seqRaw) ? seqRaw : null;
    const prev = seen.get(key);
    if (prev !== undefined && prev.agentId !== agentId) {
      const existing = collisions.get(key);
      if (existing) {
        existing.agentIds.push(agentId);
        if (seqNumber !== null) existing.seqNumbers.push(seqNumber);
      } else {
        collisions.set(key, {
          agentIds: [prev.agentId, agentId],
          seqNumbers: [
            ...(prev.seqNumber !== null ? [prev.seqNumber] : []),
            ...(seqNumber !== null ? [seqNumber] : []),
          ],
        });
      }
    } else if (prev === undefined) {
      seen.set(key, { agentId, seqNumber });
    }
  }
  return [...collisions].map(([key, { agentIds, seqNumbers }]) => ({
    key,
    agentIds,
    seqNumbers,
  }));
}

export function assertNoAgentLoginCollisions(
  general: readonly ListAgentsByAgentGeneralWireRow[],
): void {
  const collisions = detectAgentLoginCollisions(general);
  if (collisions.length === 0) return;
  throw new Error(
    `trim/uppercase agent login collisions: ${JSON.stringify(collisions)}`,
  );
}

export function maxGeneralLevel(
  general: readonly ListAgentsByAgentGeneralWireRow[],
): number | null {
  let max: number | null = null;
  for (const row of general) {
    const level = row.Level;
    if (typeof level !== "number" || !Number.isFinite(level)) continue;
    max = max === null ? level : Math.max(max, level);
  }
  return max;
}

export function generalRowsAboveLevel(
  general: readonly ListAgentsByAgentGeneralWireRow[],
  level: number,
): ListAgentsByAgentGeneralWireRow[] {
  return general.filter(
    (row) => typeof row.Level === "number" && row.Level > level,
  );
}
