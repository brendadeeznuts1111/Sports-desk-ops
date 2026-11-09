/**
 * @file lib/portal_period_taxonomy.ts
 * @description Canonical Fantasy402 portal period taxonomy and multi-family date mapping.
 *
 * The portal UI dropdown under `[data-list="period"]` (inside the collapsible `btnFilters` panel)
 * exposes an explicit 0–6 numeric enum for periods:
 *
 *   <option value="-1" selected>All Periods</option>
 *   <option value="0">Game</option>
 *   <option value="1">1st Half</option>
 *   <option value="2">2nd Half</option>
 *   <option value="3">1st Qtr</option>
 *   <option value="4">2nd Qtr</option>
 *   <option value="5">3rd Qtr</option>
 *   <option value="6">4th Qtr</option>
 *
 * Crucial Data-Loss Mechanism:
 * - Three period values present in backend / JSONL feeds (`incl_ot`, `set1..set3`, and `""`)
 *   do not exist in the dropdown.
 * - `incl_ot` silently folds into `0 Game`.
 * - `set1..set3` and unmapped `""` rows cannot be filtered by specific period values (0..6).
 *   Any export filtered by period=1 (1H) or period=2 (2H) guarantees their exclusion.
 *
 * Three Date-Field Families:
 * - Aggregate (CP / CPS): `start` / `end` (preset window, disabled)
 * - Customer Volume (CPV): `startReportVolumen` / `endReportVolumen` (preset window, disabled + `period` dropdown)
 * - Grading (G): `startG` / `endG` (user-driven, enabled)
 */

import type { Database } from "bun:sqlite";
import type {
  Cents,
  CustomerIdentifier,
  AgentIdentifier,
  Dollars,
} from "../design/domain-branded-types.ts";
import { parseBetMarket } from "./bet_market_parse.ts";

export type PortalPeriodCode = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const PORTAL_PERIOD_LABELS: Readonly<Record<PortalPeriodCode, string>> =
  {
    [-1]: "All Periods",
    [0]: "Game",
    [1]: "1st Half",
    [2]: "2nd Half",
    [3]: "1st Qtr",
    [4]: "2nd Qtr",
    [5]: "3rd Qtr",
    [6]: "4th Qtr",
  };

export type ReportMode = "CP" | "CPS" | "CPV" | "G";
export type DateFamily = "Aggregate" | "Customer Volume" | "Grading";
export type NormalizedEngine = "native" | "gansrow";
export type NormalizedHalf =
  "1H" | "2H" | "FG" | "1H_QTR" | "2H_QTR" | "OUT_OF_PORTAL";

export interface DateFamilyMapping {
  readonly family: DateFamily;
  readonly startField: string;
  readonly endField: string;
  readonly defaultState: "disabled" | "enabled";
  readonly hasPeriodFilter: boolean;
}

export const DATE_FAMILIES: Readonly<Record<ReportMode, DateFamilyMapping>> = {
  CP: {
    family: "Aggregate",
    startField: "start",
    endField: "end",
    defaultState: "disabled",
    hasPeriodFilter: false,
  },
  CPS: {
    family: "Aggregate",
    startField: "start",
    endField: "end",
    defaultState: "disabled",
    hasPeriodFilter: false,
  },
  CPV: {
    family: "Customer Volume",
    startField: "startReportVolumen",
    endField: "endReportVolumen",
    defaultState: "disabled",
    hasPeriodFilter: true,
  },
  G: {
    family: "Grading",
    startField: "startG",
    endField: "endG",
    defaultState: "enabled",
    hasPeriodFilter: false,
  },
};

export interface RawWagerInput {
  readonly WagerNumber?: number | string;
  readonly wagerNumber?: number | string;
  readonly WagerType?: string;
  readonly wagerType?: string;
  readonly Period?: string;
  readonly period?: string;
  readonly ShortDesc?: string | null;
  readonly shortDesc?: string | null;
  readonly Description?: string | null;
  readonly description?: string | null;
  readonly AmountWagered?: number | string;
  readonly Risk?: number | string;
  readonly risk?: number | string;
  readonly Login?: string;
  readonly CustomerID?: string;
  readonly customer?: string;
  readonly AgentLogin?: string;
  readonly AgentID?: string;
  readonly agent?: string;
  readonly TicketWriter?: string;
  readonly ticketWriter?: string;
  readonly Sport?: string;
  readonly sport?: string;
  readonly InsertDateTime?: string;
  readonly PlacedDate?: string;
  readonly GradedDate?: string;
  [key: string]: unknown;
}

export interface ClassifiedPeriod {
  /** Canonical 0..6 enum, or null if out-of-scope for portal (e.g. set1..3) */
  readonly portalPeriod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | null;
  readonly portalLabel: string;
  readonly half: NormalizedHalf;
  readonly rawPeriod: string;
  readonly isOrphanOutOfPortal: boolean;
}

// ============================================================================
// Canonical Taxonomy Domain Aliases & Type Specifications
// ============================================================================

export type NormalizedWager = NormalizedWagerRecord;
export type PortalPeriodClassifier = typeof classifyPortalPeriod;

export interface NormalizedWagerRecord {
  readonly wagerNumber: number | string;
  readonly engine: NormalizedEngine;
  readonly wagerType: string;
  readonly portalPeriod: 0 | 1 | 2 | 3 | 4 | 5 | 6 | null;
  readonly half: NormalizedHalf;
  readonly market: string;
  readonly customer: string;
  readonly customerId: CustomerIdentifier;
  readonly agent: string;
  readonly agentId: AgentIdentifier;
  readonly sport: string;
  readonly subSport: string;
  readonly risk: number;
  readonly riskDollars: Dollars;
  readonly riskCents: Cents;
  readonly ticketWriter: string;
  readonly insertedAt: string;
}

export interface ProvenanceSidecar {
  readonly capturedAt: string;
  readonly reportMode: ReportMode;
  readonly wagerType: string;
  readonly filtersExpanded: boolean;
  readonly period: string;
  readonly portalPeriod: PortalPeriodCode;
  readonly portalPeriodLabel: string;
  readonly engineFilter: "native" | "full";
  readonly dateFamily: DateFamily;
  readonly dateFields: {
    readonly start: string | null;
    readonly end: string | null;
    readonly startG: string | null;
    readonly endG: string | null;
    readonly startReportVolumen: string | null;
    readonly endReportVolumen: string | null;
  };
  readonly stats: {
    readonly totalProcessed: number;
    readonly matchedRows: number;
    readonly totalRisk: number;
    readonly avgRisk: number;
    readonly periodBreakdown: Record<string, { count: number; risk: number }>;
    readonly durationMs?: number | undefined;
    readonly throughputRowsPerSec?: number | undefined;
    readonly detailedBreakdown?: Record<
      string,
      {
        engine: string;
        code: string;
        label: string;
        market: string;
        count: number;
        risk: number;
      }
    >;
  };
}

/**
 * Determines whether a wager row belongs to Native ASI desk or Gansrow feed.
 */
export function detectEngine(w: RawWagerInput): NormalizedEngine {
  const wagerType = String(w.WagerType ?? w.wagerType ?? "").trim();
  const desc = String(
    w.ShortDesc ?? w.shortDesc ?? w.Description ?? w.description ?? "",
  );
  const writer = String(w.TicketWriter ?? w.ticketWriter ?? "")
    .trim()
    .toUpperCase();

  if (wagerType === "E" || /^E[.:]/i.test(desc)) {
    return "native";
  }
  if (
    writer.startsWith("GS") ||
    wagerType === "M" ||
    wagerType === "P" ||
    /^[MP][.:]/i.test(desc) ||
    /derivative|individual\s*points|team[_\s]*total/i.test(desc)
  ) {
    return "gansrow";
  }
  return "native";
}

/**
 * Checks whether a row is an Individual Points Total / Derivative Points Line across both engines.
 */
export function isDerivativePointsLineWager(w: RawWagerInput): boolean {
  const wagerType = String(w.WagerType ?? w.wagerType ?? "").trim();
  const desc = String(
    w.ShortDesc ?? w.shortDesc ?? w.Description ?? w.description ?? "",
  );
  return (
    wagerType === "E" ||
    /derivative|individual\s*points|team[_\s]*total/i.test(desc)
  );
}

/**
 * Updated canonical portal period classifier.
 *
 * Returns portal enum 0..6, or null for values the portal cannot express (set1..3).
 * Fold rules:
 * - "game", "full_game", "incl_ot", and "" (when assumed game) -> 0 Game
 * - "1st half", "1h" -> 1 1st Half
 * - "2nd half", "2h" -> 2 2nd Half
 * - "1st quarter", "q1" -> 3 1st Qtr
 * - "2nd quarter", "q2" -> 4 2nd Qtr
 * - "3rd quarter", "q3" -> 5 3rd Qtr
 * - "4th quarter", "q4" -> 6 4th Qtr
 * - startsWith("set") -> null (out-of-portal scope)
 */
export function classifyPortalPeriod(w: RawWagerInput): ClassifiedPeriod {
  const engine = detectEngine(w);
  const desc = String(
    w.ShortDesc ?? w.shortDesc ?? w.Description ?? w.description ?? "",
  );
  const periodField = String(w.Period ?? w.period ?? "").trim();

  let raw = "";

  if (engine === "native") {
    // Check "- For <Period>" suffix first
    const m = desc.match(/-\s*For\s+([^-]+)$/i);
    if (m && m[1]) {
      raw = m[1].trim().toLowerCase();
    } else if (periodField) {
      raw = periodField.toLowerCase();
    } else {
      // Fallback check for "For Game" or inline period
      const mGame = desc.match(
        /For\s+(Game|1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter)/i,
      );
      raw = mGame && mGame[1] ? mGame[1].trim().toLowerCase() : "";
    }
  } else {
    // Gansrow inline markers
    if (/\b(1st|first)\s+half\b/i.test(desc)) raw = "1st half";
    else if (/\b(2nd|second)\s+half\b/i.test(desc)) raw = "2nd half";
    else if (/\b(1st|first)\s+(quarter|qtr|period)\b/i.test(desc))
      raw = "1st quarter";
    else if (/\b(2nd|second)\s+(quarter|qtr|period)\b/i.test(desc))
      raw = "2nd quarter";
    else if (/\b(3rd|third)\s+(quarter|qtr|period)\b/i.test(desc))
      raw = "3rd quarter";
    else if (/\b(4th|fourth)\s+(quarter|qtr|period)\b/i.test(desc))
      raw = "4th quarter";
    else if (/set\s*\d/i.test(desc)) raw = "set";
    else raw = periodField ? periodField.toLowerCase() : "game";
  }

  // Canonical mapping
  const map: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
    game: 0,
    full_game: 0,
    incl_ot: 0,
    "": 0, // Assume Game when empty
    "1st half": 1,
    "1h": 1,
    "2nd half": 2,
    "2h": 2,
    "1st quarter": 3,
    q1: 3,
    "2nd quarter": 4,
    q2: 4,
    "3rd quarter": 5,
    q3: 5,
    "4th quarter": 6,
    q4: 6,
  };

  if (raw.startsWith("set")) {
    return {
      portalPeriod: null,
      portalLabel: "∅ Out-of-Portal (Set)",
      half: "OUT_OF_PORTAL",
      rawPeriod: raw,
      isOrphanOutOfPortal: true,
    };
  }

  const mapped = map[raw] ?? null;
  if (mapped === null) {
    return {
      portalPeriod: null,
      portalLabel: `∅ Out-of-Portal (${raw || "Unknown"})`,
      half: "OUT_OF_PORTAL",
      rawPeriod: raw,
      isOrphanOutOfPortal: true,
    };
  }

  let half: NormalizedHalf = "FG";
  if (mapped === 1) half = "1H";
  else if (mapped === 2) half = "2H";
  else if (mapped === 3 || mapped === 4) half = "1H_QTR";
  else if (mapped === 5 || mapped === 6) half = "2H_QTR";
  else half = "FG";

  return {
    portalPeriod: mapped,
    portalLabel: PORTAL_PERIOD_LABELS[mapped],
    half,
    rawPeriod: raw,
    isOrphanOutOfPortal: false,
  };
}

/**
 * Normalizes risk to dollar units.
 * In Fantasy402 feeds, `AmountWagered` is in cents if it has no decimal points,
 * whereas `Risk` is in dollars.
 */
export function extractRiskDollars(w: RawWagerInput): number {
  if (w.Risk !== undefined && w.Risk !== null && w.Risk !== "") {
    const val = Number(w.Risk);
    if (!Number.isNaN(val)) return val;
  }
  if (w.risk !== undefined && w.risk !== null && w.risk !== "") {
    const val = Number(w.risk);
    if (!Number.isNaN(val)) return val;
  }
  if (
    w.AmountWagered !== undefined &&
    w.AmountWagered !== null &&
    w.AmountWagered !== ""
  ) {
    const raw = Number(w.AmountWagered);
    if (!Number.isNaN(raw)) {
      // In f402-bets.jsonl, AmountWagered is integer cents
      return raw / 100;
    }
  }
  return 0;
}

/**
 * Extracts the canonical sport category.
 */
export function extractSport(w: RawWagerInput): string {
  if (w.Sport && typeof w.Sport === "string") return w.Sport.trim();
  if (w.sport && typeof w.sport === "string") return w.sport.trim();
  const desc = String(
    w.ShortDesc ?? w.shortDesc ?? w.Description ?? w.description ?? "",
  );
  const parsed = parseBetMarket(desc);
  return parsed.sport || "Unknown";
}

/**
 * Extracts canonical sub-sport code or league from rotation numbers / text.
 */
export function extractSubSport(w: RawWagerInput): string {
  if (w.SubSport && typeof w.SubSport === "string") return w.SubSport.trim();
  if (w.subSport && typeof w.subSport === "string") return w.subSport.trim();

  const desc = String(
    w.ShortDesc ?? w.shortDesc ?? w.Description ?? w.description ?? "",
  );
  const parsed = parseBetMarket(desc);
  const sport = parsed.sport || extractSport(w);
  const rot = parsed.rotationNumber;

  if (sport === "Football") {
    if (rot) {
      if (rot >= 100 && rot < 250) return "CFB";
      if (rot >= 250 && rot < 300) return "NFL";
      if (rot >= 300 && rot < 400) return "CollExt";
      if (rot >= 400 && rot < 500) return "AltLine/Prop";
    }
    if (/nfl/i.test(desc)) return "NFL";
    if (
      /college|ncaaf/i.test(desc) ||
      /alabama|georgia|notre dame|michigan/i.test(desc)
    )
      return "CFB";
    return "Football";
  }
  if (sport === "Basketball") {
    if (rot) {
      if (rot >= 500 && rot < 600) return "NBA";
      if (rot >= 600 && rot < 900) return "CBB";
    }
    if (/nba/i.test(desc)) return "NBA";
    if (/wnba|valkyries|wings/i.test(desc)) return "WNBA";
    return "Basketball";
  }
  if (sport === "Baseball") return "MLB";
  if (sport === "Hockey") return "NHL";
  if (sport === "Soccer") return "Soccer";
  if (sport === "Tennis") return "Tennis";
  return sport || "Unknown";
}

/**
 * Extracts a descriptive market string indicating the wagering product.
 */
export function extractMarketDescriptor(w: RawWagerInput): string {
  const engine = detectEngine(w);
  const wagerType = String(w.WagerType ?? w.wagerType ?? "").trim();
  const periodInfo = classifyPortalPeriod(w);

  if (engine === "native") {
    if (wagerType === "E")
      return `Native Desk Derivative Points Line (${periodInfo.portalLabel})`;
    return `Native Desk Wager (${periodInfo.portalLabel})`;
  }

  // Gansrow
  if (wagerType === "M") {
    return `Gansrow In-Play Single (${periodInfo.portalLabel})`;
  }
  if (wagerType === "P") {
    return `Gansrow Builder Parlay (${periodInfo.portalLabel})`;
  }
  return `Gansrow Feed (${periodInfo.portalLabel})`;
}

/**
 * Full normalizer row transform.
 */
export function normalizeWager(w: RawWagerInput): NormalizedWagerRecord {
  const engine = detectEngine(w);
  const periodInfo = classifyPortalPeriod(w);
  const wagerNumber = w.WagerNumber ?? w.wagerNumber ?? "";
  const wagerType = String(w.WagerType ?? w.wagerType ?? "").trim();
  const market = extractMarketDescriptor(w);
  const custStr = String(w.Login ?? w.CustomerID ?? w.customer ?? "")
    .trim()
    .toUpperCase();
  const customerId = (
    custStr.length >= 2 ? custStr : "UNKNOWN"
  ) as CustomerIdentifier;
  const agtStr = String(w.AgentLogin ?? w.AgentID ?? w.agent ?? "")
    .trim()
    .replace(/\.$/, "")
    .toUpperCase();
  const agentId = (agtStr.length >= 2 ? agtStr : "DIRECT") as AgentIdentifier;
  const sport = extractSport(w);
  const subSport = extractSubSport(w);
  const rawRisk = extractRiskDollars(w);
  const roundedRisk = Math.round(rawRisk * 100) / 100;
  const riskDollars = roundedRisk as Dollars;
  const riskCents = Math.round(roundedRisk * 100) as Cents;
  const ticketWriter = String(w.TicketWriter ?? w.ticketWriter ?? "").trim();
  const insertedAt = String(
    w.InsertDateTime ?? w.PlacedDate ?? w.GradedDate ?? "",
  );

  return {
    wagerNumber,
    engine,
    wagerType,
    portalPeriod: periodInfo.portalPeriod,
    half: periodInfo.half,
    market,
    customer: custStr,
    customerId,
    agent: agtStr,
    agentId,
    sport,
    subSport,
    risk: roundedRisk,
    riskDollars,
    riskCents,
    ticketWriter,
    insertedAt,
  };
}

// ============================================================================
// Canonical Function Aliases & Bun.inspect Inspection Tooling
// ============================================================================

export const normalizeWagerRecord = normalizeWager;

export function formatNormalizedWagerInspect(
  w: NormalizedWagerRecord,
  options: { colors?: boolean } = {},
): string {
  const colors = options.colors === true;
  const bold = (s: string) => (colors ? `\u001b[1m${s}\u001b[22m` : s);
  const cyan = (s: string) => (colors ? `\u001b[36m${s}\u001b[39m` : s);
  const yellow = (s: string) => (colors ? `\u001b[33m${s}\u001b[39m` : s);

  const riskStr = `$${(w.riskCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  const periodTag =
    w.portalPeriod !== null
      ? `Period:${w.portalPeriod} (${PORTAL_PERIOD_LABELS[w.portalPeriod]})`
      : yellow("Period:∅ (Out-of-Portal)");

  return [
    `#${bold(String(w.wagerNumber))}`,
    `[${cyan(w.customerId)}]`,
    `Engine:${w.engine}`,
    periodTag,
    `${bold(w.sport)}/${w.subSport}`,
    `Risk:${bold(riskStr)}`,
    `Writer:${w.ticketWriter || "N/A"}`,
  ].join(" ");
}

export class PeriodTaxonomyInspection {
  readonly provenance: ProvenanceSidecar;
  readonly sample: readonly NormalizedWagerRecord[];

  constructor(
    provenance: ProvenanceSidecar,
    sample: readonly NormalizedWagerRecord[] = [],
  ) {
    this.provenance = provenance;
    this.sample = sample;
  }

  [Bun.inspect.custom](
    _depth: number,
    options: Parameters<typeof Bun.inspect>[1] = {},
  ): string {
    const colors = options?.colors === true;
    const bold = (s: string) => (colors ? `\u001b[1m${s}\u001b[22m` : s);
    const cyan = (s: string) => (colors ? `\u001b[36m${s}\u001b[39m` : s);

    const p = this.provenance;
    const totalRiskStr = p.stats.totalRisk.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const avgRiskStr = p.stats.avgRisk.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const header = [
      bold("=== Portal Period Taxonomy Inspection Report ==="),
      `Report Mode       : ${bold(p.reportMode)} (${p.dateFamily} Family)`,
      `Period Filter     : [${p.period}] ${bold(p.portalPeriodLabel)}`,
      `Engine Scope      : ${p.engineFilter}`,
      `Total Processed   : ${bold(p.stats.totalProcessed.toLocaleString())} wagers`,
      `Matched Rows      : ${cyan(p.stats.matchedRows.toLocaleString())} wagers`,
      `Total Risk Volume : $${bold(totalRiskStr)}`,
      `Average Risk      : $${avgRiskStr}`,
      ...(p.stats.throughputRowsPerSec !== undefined
        ? [
            `Throughput        : ${cyan(p.stats.throughputRowsPerSec.toLocaleString())} wagers/sec (${p.stats.durationMs?.toFixed(1) ?? "0"}ms total)`,
          ]
        : []),
    ].join("\n");

    const breakdownEntries = Object.entries(p.stats.detailedBreakdown ?? {});
    let breakdownBlock = "";
    if (breakdownEntries.length > 0) {
      const rows = breakdownEntries.map(([, v]) => ({
        engine: v.engine,
        code: v.code,
        label: v.label,
        market: v.market,
        count: v.count,
        risk: `$${v.risk.toFixed(2)}`,
      }));
      const inspectTable = (
        Bun.inspect as unknown as {
          table?: (data: unknown, opts?: unknown) => string;
        }
      ).table;
      if (typeof Bun !== "undefined" && typeof inspectTable === "function") {
        breakdownBlock = `\n${bold("Taxonomy Breakdown:")}\n${inspectTable(rows, { colors })}`;
      }
    }

    const sampleBlock =
      this.sample.length > 0
        ? [
            `\n${bold(`Sample Normalized Records (${this.sample.length}):`)}`,
            ...this.sample.map(
              (w, idx) =>
                `  ${idx + 1}. ${formatNormalizedWagerInspect(w, options)}`,
            ),
          ].join("\n")
        : "";

    return `${header}${breakdownBlock}${sampleBlock}`;
  }

  toJSON() {
    return {
      provenance: this.provenance,
      sample: this.sample,
    };
  }
}

/**
 * Creates a high-throughput direct ReadableStream emitting normalized wager records as JSONL.
 * Utilizes Bun's native `type: "direct"` DirectController to bypass JavaScript
 * stream queues and stream UTF-8 lines directly to native consumer sinks.
 *
 * Implements native backpressure: `await controller.write()` pauses execution
 * when the downstream consumer / socket buffer fills up.
 */
export function createNormalizedWagersDirectStream(
  records:
    Iterable<NormalizedWagerRecord> | AsyncIterable<NormalizedWagerRecord>,
): ReadableStream {
  const source = {
    type: "direct" as const,
    async pull(controller: ReadableStreamDirectController) {
      for await (const record of records) {
        await controller.write(JSON.stringify(record) + "\n");
      }
      controller.close();
    },
  };
  return new ReadableStream(
    source as unknown as ConstructorParameters<typeof ReadableStream>[0],
  );
}

/**
 * Registers canonical portal period taxonomy and market classifiers as user-defined
 * functions in a `bun:sqlite` Database instance.
 *
 * Scalar UDFs:
 * - `portal_period_label(code)`: Translates canonical period code (-1..6) to portal label.
 * - `is_derivative_points_line(shortDesc)`: Returns 1 if description matches derivative points flow, else 0.
 *
 * Aggregate UDFs:
 * - `sum_risk_cents(dollars)`: Accumulates risk dollars into strict integer Cents (Math.round(val * 100)).
 * - `count_derivative_points(shortDesc)`: Counts wagers matching derivative points flow across rows.
 */
export function registerPortalPeriodSqliteFunctions(db: Database): void {
  if (!db || typeof db.function !== "function") return;

  db.function("portal_period_label", (code: unknown) => {
    const num = typeof code === "number" ? code : Number(code);
    return (
      PORTAL_PERIOD_LABELS[num as keyof typeof PORTAL_PERIOD_LABELS] ??
      "Unknown"
    );
  });

  db.function("is_derivative_points_line", (shortDesc: unknown) => {
    return isDerivativePointsLineWager({ ShortDesc: String(shortDesc || "") })
      ? 1
      : 0;
  });

  if (typeof db.aggregate === "function") {
    db.aggregate("sum_risk_cents", {
      start: 0,
      step: (totalCents: number, dollars: unknown) => {
        const d = typeof dollars === "number" ? dollars : Number(dollars || 0);
        return totalCents + Math.round(d * 100);
      },
    });

    db.aggregate("count_derivative_points", {
      start: 0,
      step: (count: number, shortDesc: unknown) => {
        return (
          count +
          (isDerivativePointsLineWager({ ShortDesc: String(shortDesc || "") })
            ? 1
            : 0)
        );
      },
    });
  }
}

/**
 * Ingests a collection or stream of normalized wager records into a SQLite database
 * within a single atomic transaction.
 *
 * Utilizes `db.transaction()` to compile the prepared transaction loop in native C++,
 * achieving high-throughput batch ingestion without SQL re-parsing overhead.
 */
export function insertNormalizedWagers(
  db: Database,
  records: Iterable<NormalizedWagerRecord>,
): { insertedCount: number } {
  db.run(`
    CREATE TABLE IF NOT EXISTS normalized_wagers (
      wager_number TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      portal_period INTEGER NOT NULL,
      half TEXT NOT NULL,
      market TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      sub_sport TEXT NOT NULL,
      risk REAL NOT NULL,
      risk_cents INTEGER NOT NULL,
      ticket_writer TEXT NOT NULL,
      inserted_at TEXT NOT NULL
    )
  `);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO normalized_wagers (
      wager_number, engine, portal_period, half, market,
      customer_id, agent_id, sport, sub_sport, risk, risk_cents,
      ticket_writer, inserted_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
  `);

  const runBatch = db.transaction((recs: Iterable<NormalizedWagerRecord>) => {
    let count = 0;
    for (const r of recs) {
      insertStmt.run(
        String(r.wagerNumber),
        r.engine,
        r.portalPeriod,
        r.half,
        r.market,
        String(r.customerId),
        String(r.agentId),
        r.sport,
        r.subSport,
        r.risk,
        Number(r.riskCents),
        r.ticketWriter,
        r.insertedAt,
      );
      count++;
    }
    return count;
  });

  const insertedCount = runBatch(records);
  return { insertedCount };
}
