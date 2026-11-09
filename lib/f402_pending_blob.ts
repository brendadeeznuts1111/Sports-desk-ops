/**
 * Parse Fantasy402 `getPending` prop-builder (`WagerType: G`) and contest/futures (`WagerType: C`) rows.
 * Structured rotation/team columns are empty; the contract lives in `Description`.
 */

import { sportCategoryFor } from "./sport_taxonomy.ts";
import type { BunInspectOptions } from "./cli_inspect.ts";

export interface PendingBlobLeg {
  readonly catalogId: string;
  readonly sport: string;
  readonly subSport?: string;
  readonly matchup: string;
  readonly period: string;
  readonly market: string;
  readonly selection: string;
}

export interface ParsedPendingBlob {
  readonly catalogId: string;
  readonly wagerType?: string;
  readonly sport: string;
  readonly subSport?: string;
  readonly matchup: string;
  readonly period: string;
  readonly market: string;
  readonly selection: string;
  readonly desc?: string;
  readonly legCount: number;
  readonly legs: readonly PendingBlobLeg[];
  readonly channel: "GSBUILDER" | "GSLIVE" | "CONTEST" | "OTHER";
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString?: () => string;
}

/** Reserved 20-bit rotation band for builder/prop keys (GATE-01 safe). */
export const PENDING_BLOB_ROTATION_BASE = 900_000;
export const PENDING_BLOB_ROTATION_TOP = 1_048_575;

const text = (value: unknown): string => String(value ?? "").trim();

function normalizeTitleSport(rawSport: string, rawSubSport?: string): string {
  const mapped = sportCategoryFor({
    sportType: rawSport,
    sportSubType: rawSubSport,
  });
  if (mapped !== "Other") return mapped;
  return rawSport.trim();
}

/**
 * Parses `WagerType: "C"` Contest / Futures descriptions:
 * `FOOTBALL - #NFL Futures - #To win Super Bowl - #Odds to win 2026-27 Super Bowl - Chicago Bears +1100 for  Game`
 */
function parseContestSegment(segment: string): PendingBlobLeg | null {
  const trimmed = segment.trim();
  if (!trimmed.includes(" - #")) return null;
  const parts = trimmed.split(/\s+-\s+/);
  if (parts.length < 4) return null;
  const rawSport = (parts[0] ?? "").trim();
  const rawSub = (parts[1] ?? "").trim();
  if (!rawSub.startsWith("#")) return null;
  const subSport = rawSub.slice(1).trim();

  const headerTokens: string[] = [];
  let idx = 2;
  while (idx < parts.length - 1 && (parts[idx] ?? "").trim().startsWith("#")) {
    headerTokens.push((parts[idx] ?? "").trim().slice(1).trim());
    idx++;
  }
  if (headerTokens.length === 0) return null;

  const tail = parts.slice(idx).join(" - ").trim();
  const forMatch = /^(.+?)\s+for\s+([A-Za-z0-9\s()]+)$/i.exec(tail);
  const selection = (forMatch ? (forMatch[1] ?? "") : tail).trim();
  const period = (forMatch ? (forMatch[2] ?? "Game") : "Game")
    .replace(/\s+/g, " ")
    .trim();
  const sport = normalizeTitleSport(rawSport, subSport);
  const contestHeader = headerTokens[0] ?? subSport;
  const market = headerTokens.join(" - ");

  return {
    catalogId: subSport,
    sport,
    subSport,
    matchup: contestHeader,
    period: period || "Game",
    market,
    selection,
  };
}

export function isPendingBlobRow(row: Record<string, unknown>): boolean {
  const wt = text(row.WagerType).toUpperCase();
  if (wt === "G") return true;
  if (wt === "C" && text(row.SportType) === "") {
    const desc = sanitizePendingBlobText(row.Description ?? row.ShortDesc);
    return parseContestSegment(desc.split("\n")[0] ?? "") !== null;
  }
  return false;
}

/** Normalize HTML entities and stray CR/LF from the wire blob. */
export function sanitizePendingBlobText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/&#x0D;/gi, "")
    .replace(/&#189;/g, "½")
    .replace(/&frac12;/gi, "½")
    .replace(/^(G\d+)\s*\n+/m, "$1 ")
    .trim();
}

function parseBlobSegment(segment: string): PendingBlobLeg | null {
  const cleaned = segment.trim();
  if (cleaned === "") return null;
  const contestLeg = parseContestSegment(cleaned);
  if (contestLeg !== null) return contestLeg;

  const m = cleaned.match(/^G(\d+)\s+(.+)$/s);
  if (m === null) {
    const dash = cleaned.indexOf(" - ");
    if (dash < 0) return null;
    const sport = cleaned.slice(0, dash).trim();
    const tail = cleaned.slice(dash + 3);
    const parts = tail.split(" / ").map((p) => p.trim());
    if (parts.length < 2) return null;
    return {
      catalogId: "",
      sport,
      matchup: parts[0] ?? "",
      period: parts[1] ?? "",
      market: parts[2] ?? "",
      selection: parts.slice(3).join(" / "),
    };
  }
  const rest = (m[2] ?? "").trim();
  const dash = rest.indexOf(" - ");
  if (dash < 0) return null;
  const sport = rest.slice(0, dash).trim();
  const tail = rest.slice(dash + 3);
  const parts = tail.split(" / ").map((p) => p.trim());
  return {
    catalogId: m[1] ?? "",
    sport,
    matchup: parts[0] ?? "",
    period: parts[1] ?? "",
    market: parts[2] ?? "",
    selection: parts.slice(3).join(" / "),
  };
}

/** Split a multi-leg builder blob on new lines that start a new sport segment. */
export function splitPendingBlobSegments(raw: string): string[] {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const segments: string[] = [];
  let current = "";
  for (const line of lines) {
    const startsNew =
      /^G\d+\s/.test(line) ||
      /^(Football|Basketball|Tennis|Hockey|Baseball|Cricket|Soccer|Martial Arts|Golf|Boxing|Auto Racing)\s-\s/i.test(
        line,
      );
    if (startsNew && current !== "") {
      segments.push(current);
      current = line;
    } else {
      current = current === "" ? line : `${current}\n${line}`;
    }
  }
  if (current !== "") segments.push(current);
  return segments.length > 0 ? segments : [raw];
}

export function formatParsedPendingBlob(
  blob: {
    readonly wagerType?: string;
    readonly channel?: string;
    readonly sport?: string;
    readonly subSport?: string;
    readonly market?: string;
    readonly period?: string;
    readonly desc?: string;
    readonly selection?: string;
  },
  options: BunInspectOptions = {},
): string {
  const colors = options?.colors === true;
  const dim = (s: string) => (colors ? `\x1b[2m${s}\x1b[0m` : s);
  const wt = blob.wagerType ?? (blob.channel === "CONTEST" ? "C" : "G");
  const kind = wt === "G" ? "BUILDER" : wt === "C" ? "FUTURE" : wt;
  const status = blob.sport && blob.sport !== "other" ? "✓" : "✗";
  const sub = blob.subSport ?? blob.market ?? "?";
  const per = blob.period ?? "?";
  const descText = blob.desc ?? blob.selection ?? "";
  return `${status} ${kind} ${blob.sport ?? "?"} | ${sub} | ${per} | ${dim(descText)}`;
}

export function parsePendingBlobDescription(
  raw: unknown,
  wagerType?: string,
): ParsedPendingBlob | null {
  const textBody = sanitizePendingBlobText(raw);
  if (textBody === "") return null;
  const segments = splitPendingBlobSegments(textBody);
  const legs = segments
    .map((segment) => parseBlobSegment(segment))
    .filter((leg): leg is PendingBlobLeg => leg !== null);
  if (legs.length === 0) return null;
  const primary = legs[0];
  if (primary === undefined) return null;
  const catalogId =
    primary.catalogId !== ""
      ? primary.catalogId
      : (textBody.match(/^G(\d+)/)?.[1] ?? "0");
  const isContest = primary.subSport !== undefined;
  const resolvedWagerType =
    wagerType?.trim().toUpperCase() || (isContest ? "C" : "G");
  const parsed: ParsedPendingBlob = {
    catalogId,
    wagerType: resolvedWagerType,
    sport: primary.sport,
    ...(primary.subSport !== undefined ? { subSport: primary.subSport } : {}),
    matchup: primary.matchup,
    period: primary.period,
    market: primary.market,
    selection: primary.selection,
    desc: primary.selection || textBody,
    legCount: legs.length,
    legs,
    channel: isContest ? "CONTEST" : "OTHER",
    [Bun.inspect.custom](
      _depth: number,
      options: BunInspectOptions = {},
    ): string {
      return formatParsedPendingBlob(this, options);
    },
    toString(): string {
      return formatParsedPendingBlob(this, { colors: false });
    },
  };
  return parsed;
}

export function pendingBlobChannel(
  row: Record<string, unknown>,
): ParsedPendingBlob["channel"] {
  if (text(row.WagerType).toUpperCase() === "C") return "CONTEST";
  const writer = text(row.PlacedOn) || text(row.TicketWriter);
  if (writer === "GSBUILDER") return "GSBUILDER";
  if (writer === "GSLIVE") return "GSLIVE";
  return "OTHER";
}

/** Stable 20-bit rotation in the builder band from catalog / prop identity. */
export function catalogIdToBlobRotation(seed: string): number {
  const normalized = seed.trim();
  if (normalized === "") {
    return PENDING_BLOB_ROTATION_BASE;
  }
  let hash = 2_166_136_261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  const span = PENDING_BLOB_ROTATION_TOP - PENDING_BLOB_ROTATION_BASE;
  return PENDING_BLOB_ROTATION_BASE + ((hash >>> 0) % span);
}

export interface PendingRollupDimensions {
  readonly rotation: number;
  readonly sport: string;
  readonly period: string;
  readonly blob: boolean;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v);
  return null;
};

/** Aggregation dimensions for one pending row (builder blob, contest/futures blob, prop OOB, or structured). */
export function resolvePendingRollupDimensions(
  row: Record<string, unknown>,
): PendingRollupDimensions {
  if (isPendingBlobRow(row)) {
    const parsed = parsePendingBlobDescription(
      row.Description ?? row.ShortDesc,
      text(row.WagerType),
    );
    const channel = pendingBlobChannel(row);
    const seed = parsed
      ? `${parsed.catalogId}|${parsed.sport}|${parsed.market}`
      : sanitizePendingBlobText(row.Description ?? row.ShortDesc).slice(0, 64);
    const sport = parsed?.sport || "builder";
    const period =
      parsed?.period ||
      (channel === "OTHER" ? "builder" : channel.toLowerCase());
    return {
      rotation: catalogIdToBlobRotation(seed),
      sport,
      period,
      blob: true,
    };
  }

  const chosen = text(row.ChosenTeamID);
  const useTeam2 = chosen !== "" && chosen === text(row.Team2ID);
  const rawRot = useTeam2 ? row.Team2RotNum : row.Team1RotNum;
  const rotNum = num(rawRot);
  if (
    rotNum === null ||
    !Number.isInteger(rotNum) ||
    rotNum < 0 ||
    rotNum > PENDING_BLOB_ROTATION_TOP
  ) {
    const seed = `${rawRot}|${chosen}|${text(row.SportSubType)}|${text(row.Team1ID)}`;
    const resolvedCategory = sportCategoryFor({
      sportType: row.SportType,
      sportSubType: row.SportSubType,
    });
    const sport =
      resolvedCategory !== "Other"
        ? resolvedCategory
        : text(row.SportSubType) || text(row.SportType) || "prop";
    return {
      rotation: catalogIdToBlobRotation(seed),
      sport,
      period: text(row.PeriodDescription) || "other",
      blob: true,
    };
  }

  const rotation = rotNum >= 5_000 && rotNum <= 5_999 ? rotNum - 5_000 : rotNum;

  const resolvedSport = sportCategoryFor({
    sportType: row.SportType,
    sportSubType: row.SportSubType,
  });

  return {
    rotation,
    sport:
      text(row.SportType) ||
      (resolvedSport !== "Other" ? resolvedSport : "other"),
    period: text(row.PeriodDescription) || "other",
    blob: false,
  };
}
