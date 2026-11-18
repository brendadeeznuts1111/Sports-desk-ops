/**
 * @file lib/users_roster.ts
 * @description Project a raw `GENERAL`/`PLAYERS` users report down to structural fields, and load
 * only that projection. Raw player rows carry plaintext passwords and names; the projection drops
 * them, and the loader refuses any file that still has sensitive keys.
 */

import { readFile } from "node:fs/promises";

export interface ProjectedRosterAgent {
  readonly agentId: string;
  readonly login: string | null;
  readonly level: number | null;
  readonly type: string | null;
  readonly seqNumber: number | null;
}

export interface ProjectedRosterPlayer {
  readonly customerId: string;
  readonly login: string | null;
  readonly agent: string | null;
}

export interface ProjectedUsersRoster {
  readonly schemaVersion: 1;
  readonly agents: readonly ProjectedRosterAgent[];
  readonly players: readonly ProjectedRosterPlayer[];
}

export interface UsersRosterIndex {
  readonly source: string;
  readonly agents: number;
  readonly players: number;
  readonly byAgent: ReadonlyMap<string, ProjectedRosterAgent>;
  /** Normalized customerID and login → agent id. */
  readonly playerToAgent: ReadonlyMap<string, string>;
  /** Number of roster players assigned to each agent. */
  readonly playerCountByAgent: ReadonlyMap<string, number>;
}

const SENSITIVE_KEYS = [
  "password",
  "namefirst",
  "namelast",
  "email",
  "phone",
  "address",
  "ssn",
] as const;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Structural projection: only agent/player identity and hierarchy fields survive. */
export function projectUsersRoster(raw: unknown): ProjectedUsersRoster {
  if (raw === null || typeof raw !== "object") {
    throw new Error("users report must be a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.GENERAL) || !Array.isArray(doc.PLAYERS)) {
    throw new Error("users report needs GENERAL and PLAYERS arrays");
  }
  const agents: ProjectedRosterAgent[] = [];
  for (const value of doc.GENERAL) {
    if (value === null || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const agentId = str(row.AgentID);
    if (agentId === null) continue;
    agents.push({
      agentId,
      login: str(row.Login),
      level: num(row.Level),
      type: str(row.AgentType),
      seqNumber: num(row.SeqNumber),
    });
  }
  const players: ProjectedRosterPlayer[] = [];
  for (const value of doc.PLAYERS) {
    if (value === null || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const customerId = str(row.customerID);
    const login = str(row.Login);
    if (customerId === null && login === null) continue;
    players.push({
      customerId: customerId ?? login ?? "",
      login,
      agent: str(row.Agent),
    });
  }
  return { schemaVersion: 1, agents, players };
}

function containsSensitiveKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsSensitiveKey(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if ((SENSITIVE_KEYS as readonly string[]).includes(key.toLowerCase())) {
      return key;
    }
    const hit = containsSensitiveKey(child);
    if (hit !== null) return hit;
  }
  return null;
}

/** Validate a projection; throws on a raw report instead of loading PII. */
export function assertProjectedRoster(value: unknown): ProjectedUsersRoster {
  if (value === null || typeof value !== "object") {
    throw new Error("projected roster must be a JSON object");
  }
  const doc = value as Record<string, unknown>;
  if (
    doc.schemaVersion !== 1 ||
    !Array.isArray(doc.agents) ||
    !Array.isArray(doc.players)
  ) {
    throw new Error(
      "projected roster needs schemaVersion 1, agents and players",
    );
  }
  const sensitive = containsSensitiveKey(doc);
  if (sensitive !== null) {
    throw new Error(
      `projected roster still contains sensitive key ${JSON.stringify(sensitive)}; run the projector first`,
    );
  }
  return doc as unknown as ProjectedUsersRoster;
}

export function normalizeRosterId(value: string): string {
  const id = value.trim().toUpperCase();
  return id.endsWith(".") ? id.replace(/\.+$/, "") : id;
}

const matchKeys = (value: string): string[] => {
  const near = normalizeRosterId(value);
  const keys = new Set<string>([near]);
  const underscore = near.indexOf("_");
  if (underscore > 0) keys.add(near.slice(0, underscore));
  return [...keys];
};

export async function loadProjectedUsersRoster(
  path: string,
): Promise<UsersRosterIndex> {
  const roster = assertProjectedRoster(
    JSON.parse(await readFile(path, "utf8")),
  );
  const byAgent = new Map<string, ProjectedRosterAgent>();
  for (const agent of roster.agents) {
    byAgent.set(normalizeRosterId(agent.agentId), agent);
  }
  const playerToAgent = new Map<string, string>();
  const playerCountByAgent = new Map<string, number>();
  for (const player of roster.players) {
    if (player.agent === null) continue;
    const agentKey = normalizeRosterId(player.agent);
    playerCountByAgent.set(
      agentKey,
      (playerCountByAgent.get(agentKey) ?? 0) + 1,
    );
    for (const key of matchKeys(player.customerId)) {
      playerToAgent.set(key, player.agent);
    }
    if (player.login !== null) {
      for (const key of matchKeys(player.login)) {
        if (!playerToAgent.has(key)) playerToAgent.set(key, player.agent);
      }
    }
  }
  return {
    source: path,
    agents: roster.agents.length,
    players: roster.players.length,
    byAgent,
    playerToAgent,
    playerCountByAgent,
  };
}
