/**
 * Apply `PLAYERS_MODE` to `getListAgenstByAgent` envelopes (in-process or via `jq` stream).
 */

import type { PlayersMode } from "./f402_hierarchy_config.ts";
import {
  parseListAgentsByAgentEnvelope,
  trimPaddedField,
  type ListAgentsByAgentEnvelope,
  type ListAgentsByAgentPlayerWireRow,
} from "./f402_list_agents_by_agent.ts";

/** jq filter: keep agent tree + metadata; player rows without secrets. */
export const JQ_PLAYERS_PROJECTED = `{GENERAL, EXTRA, PLAYERS: [.PLAYERS[] | {customerID, Login, NameFirst, Agent}]}`;

export const JQ_PLAYERS_OFF = `{GENERAL, EXTRA, PLAYERS: []}`;

const PROJECTED_PLAYER_KEYS = [
  "customerID",
  "Login",
  "NameFirst",
  "Agent",
] as const;

export function projectPlayerRow(
  row: ListAgentsByAgentPlayerWireRow,
): ListAgentsByAgentPlayerWireRow {
  const out: { [K in (typeof PROJECTED_PLAYER_KEYS)[number]]?: string } = {};
  for (const key of PROJECTED_PLAYER_KEYS) {
    const value = row[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function applyPlayersModeToEnvelope(
  envelope: ListAgentsByAgentEnvelope,
  mode: PlayersMode,
): ListAgentsByAgentEnvelope {
  if (mode === "full") return envelope;
  if (mode === "off") {
    return { ...envelope, PLAYERS: [] };
  }
  return {
    ...envelope,
    PLAYERS: envelope.PLAYERS.map((row) => projectPlayerRow(row)),
  };
}

export function applyPlayersModeToParsed(
  raw: unknown,
  mode: PlayersMode,
): ListAgentsByAgentEnvelope {
  return applyPlayersModeToEnvelope(parseListAgentsByAgentEnvelope(raw), mode);
}

export function applyPlayersModeToJsonText(
  bodyText: string,
  mode: PlayersMode,
): string {
  if (mode === "full") return bodyText;
  const trimmed = bodyText.trim();
  if (trimmed === "") return bodyText;
  const parsed = JSON.parse(trimmed) as unknown;
  return `${JSON.stringify(applyPlayersModeToParsed(parsed, mode))}\n`;
}

export async function filterHierarchyJsonStream(
  body: ReadableStream<Uint8Array>,
  mode: PlayersMode,
): Promise<ListAgentsByAgentEnvelope> {
  if (mode === "full") {
    return parseListAgentsByAgentEnvelope(await new Response(body).json());
  }
  const jqFilter = mode === "off" ? JQ_PLAYERS_OFF : JQ_PLAYERS_PROJECTED;
  const jqPath = Bun.which("jq");
  if (jqPath === null) {
    const text = await new Response(body).text();
    return applyPlayersModeToParsed(JSON.parse(text), mode);
  }
  const proc = Bun.spawn({
    cmd: [jqPath, "-c", jqFilter],
    stdin: body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`jq hierarchy filter failed (${exit}): ${err.trim()}`);
  }
  return parseListAgentsByAgentEnvelope(JSON.parse(out.trim()));
}

/** Count players without parsing the full array into normalized rows. */
export function countPlayersInJsonText(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText.trim()) as { PLAYERS?: unknown };
    return Array.isArray(parsed.PLAYERS) ? parsed.PLAYERS.length : null;
  } catch {
    return null;
  }
}

export interface HierarchyRequestFields {
  readonly agentID: string;
  readonly agentType: string;
  readonly agentOwner?: string | undefined;
}

export function buildHierarchyFormBody(
  fields: HierarchyRequestFields,
  rro: number,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("agentID", trimPaddedField(fields.agentID));
  params.set("agentType", trimPaddedField(fields.agentType));
  params.set("operation", "getListAgenstByAgent");
  params.set("RRO", String(rro));
  if (fields.agentOwner !== undefined && fields.agentOwner !== "") {
    params.set("agentOwner", trimPaddedField(fields.agentOwner));
  }
  return params;
}
