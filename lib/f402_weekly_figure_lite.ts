/**
 * `POST /cloud/api/Manager/getWeeklyFigureByAgentLite` — read-only boot KPI (manager.js ~52703).
 */

import { MANAGER_RRO, PROBE_HOST } from "./f402_hierarchy_config.ts";
import type { F402ReplayTransport } from "./f402_replay_transport.ts";
import { trimPaddedField } from "./f402_list_agents_by_agent.ts";

export const WEEKLY_FIGURE_LITE_PATH =
  "/cloud/api/Manager/getWeeklyFigureByAgentLite" as const;

export interface WeeklyFigureLiteRequest {
  readonly agentID: string;
  readonly agentOwner?: string;
  readonly week?: number;
  readonly type?: string;
  readonly layout?: string;
  readonly rro?: number;
}

/**
 * `LIST.ARRAY[0]` as manager.js renders it: `Active` → grand-total-player, `ThisWeek` →
 * grand-total-weekly, `Today` → grand-total-day. `Active === -1` hides all three; a null money
 * field is shown as 0; an empty ARRAY renders nothing.
 */
export type WeeklyFigureLite =
  | {
      readonly kind: "figures";
      readonly activePlayers: number;
      readonly thisWeek: number | null;
      readonly today: number | null;
    }
  | { readonly kind: "withheld" }
  | { readonly kind: "empty" };

export class WeeklyFigureLiteShapeError extends Error {
  override readonly name = "WeeklyFigureLiteShapeError";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function money(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new WeeklyFigureLiteShapeError(
    `LIST.ARRAY[0].${key} must be a finite number or null`,
  );
}

export function parseWeeklyFigureLite(raw: unknown): WeeklyFigureLite {
  const list = isRecord(raw) ? raw["LIST"] : undefined;
  const rows = isRecord(list) ? list["ARRAY"] : undefined;
  if (!Array.isArray(rows)) {
    throw new WeeklyFigureLiteShapeError("expected { LIST: { ARRAY: [...] } }");
  }
  if (rows.length === 0) return { kind: "empty" };
  const row: unknown = rows[0];
  if (!isRecord(row)) {
    throw new WeeklyFigureLiteShapeError("LIST.ARRAY[0] must be an object");
  }
  const active = row["Active"];
  if (typeof active !== "number" || !Number.isInteger(active) || active < -1) {
    throw new WeeklyFigureLiteShapeError(
      "LIST.ARRAY[0].Active must be an integer >= -1",
    );
  }
  if (active === -1) return { kind: "withheld" };
  return {
    kind: "figures",
    activePlayers: active,
    thisWeek: money(row, "ThisWeek"),
    today: money(row, "Today"),
  };
}

/**
 * What a graph export stores: the parsed figure, the agentID it was requested for, and when.
 * That agent is usually the logged-in account (e.g. a master above every GENERAL root), so it
 * need not be a node in the graph.
 */
export interface StoredWeeklyFigureLite {
  readonly agentId: string;
  readonly figure: WeeklyFigureLite;
  readonly fetchedAt: string;
}

/** Read back from a graph export on disk; null when absent or not that shape. */
export function storedWeeklyFigureLite(v: unknown): StoredWeeklyFigureLite | null {
  if (!isRecord(v)) return null;
  const { agentId, fetchedAt } = v;
  if (typeof agentId !== "string" || typeof fetchedAt !== "string") return null;
  const figure = figureFromJson(v["figure"]);
  return figure && { agentId, figure, fetchedAt };
}

function figureFromJson(v: unknown): WeeklyFigureLite | null {
  if (!isRecord(v)) return null;
  if (v["kind"] === "withheld" || v["kind"] === "empty") return { kind: v["kind"] };
  if (v["kind"] !== "figures") return null;
  const { activePlayers, thisWeek, today } = v;
  if (
    typeof activePlayers !== "number" ||
    !Number.isInteger(activePlayers) ||
    activePlayers < 0 ||
    !isMoney(thisWeek) ||
    !isMoney(today)
  ) {
    return null;
  }
  return { kind: "figures", activePlayers, thisWeek, today };
}

function isMoney(m: unknown): m is number | null {
  return m === null || (typeof m === "number" && Number.isFinite(m));
}

export function buildWeeklyFigureLiteFormBody(
  fields: WeeklyFigureLiteRequest,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("agentID", trimPaddedField(fields.agentID));
  params.set("week", String(fields.week ?? 0));
  params.set("type", fields.type ?? "A");
  params.set("layout", fields.layout ?? "byDay");
  params.set("operation", "getWeeklyFigureByAgentLite");
  params.set("RRO", String(fields.rro ?? MANAGER_RRO));
  const owner = fields.agentOwner ?? fields.agentID;
  if (owner !== "") {
    params.set("agentOwner", trimPaddedField(owner));
  }
  return params;
}

export async function fetchWeeklyFigureByAgentLite(
  transport: F402ReplayTransport,
  fields: WeeklyFigureLiteRequest,
  options?: { readonly host?: string },
): Promise<WeeklyFigureLite> {
  const host = (options?.host ?? PROBE_HOST).replace(/\/$/, "");
  const url = `${host}${WEEKLY_FIGURE_LITE_PATH}`;
  const res = await transport.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    body: buildWeeklyFigureLiteFormBody(fields).toString(),
    redirect: "manual",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `getWeeklyFigureByAgentLite HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return parseWeeklyFigureLite(JSON.parse(text) as unknown);
}
