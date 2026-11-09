/**
 * @file alert_performance.ts
 * @description Join alerts that reached the desk chat to settled outcomes and rank winners/losers
 * by the alert's own dimensions (sport, subSport, period, wagerType).
 *
 * The alert audit carries the bettor and bet dimensions but not the result; outcomes live
 * elsewhere. Two sources are supported:
 *  - `enriched_customers_full.json` recent-ticket SAMPLE (customer_id + wager_number + result +
 *    net_usd) — real desk book data, but only ~5 tickets per customer, so coverage is partial and
 *    the report labels it a sample.
 *  - an explicit normalized outcomes JSONL (`--outcomes`) for a settlement store to plug into.
 *
 * A joined row requires (customerId, wagerNumber). Alerts recorded before the audit enrichment
 * (including the single historical sent alert) have no wager key and stay UNMATCHED — the report
 * counts them as unmatched and never fabricates a result.
 *
 * Dimensions are CANONICALIZED before grouping (`lib/market_type_registry.ts`), because the raw
 * alert fields are not a clean vocabulary:
 *  - `subSport` is a picker label (`Point spread`, `Winner (2 way)`) and can carry the phase
 *    sentinel `PREGAME`, which is not a market; it maps through `classifyMarketLabel` to the
 *    registry kind (`spread`, `moneyline`, …), and PREGAME/empty/unmapped reads `unknown`.
 *  - `wagerType` is an opaque code (`M`, `L`, …) with a documented map in `lib/combo_identity.ts`;
 *    it groups by the readable `"<code> <name>"` label (`"M Moneyline"`), unknown codes `unknown`.
 *  - `sport`/`period` stay as printed but are trimmed; empty reads `unknown`.
 * Each group keeps the raw labels it absorbed in `rawKeys`, so a canonical bucket is auditable.
 * The report also carries a `metadata` provenance block (alert window, outcome sources, coverage).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TelegramAlertAuditRow } from "./telegram_alert_audit.ts";
import { classifyMarketLabel, wagerTypeMeta } from "./market_type_registry.ts";

export type AlertOutcome = "win" | "loss" | "push" | "void" | "unknown";

export interface AlertPerformanceOutcome {
  readonly customerId: string;
  readonly wagerNumber: string;
  readonly outcome: AlertOutcome;
  readonly netUsd: number | null;
  readonly source: string;
}

export interface AlertPerformanceRow {
  readonly alert: TelegramAlertAuditRow;
  readonly outcome: AlertPerformanceOutcome | null;
  readonly status: "win" | "loss" | "push" | "void" | "unknown" | "unmatched";
  readonly netUsd: number | null;
}

export interface CustomerPerformance {
  readonly customerId: string;
  readonly alerts: number;
  readonly matched: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly netUsd: number;
  readonly dimensions: {
    readonly sport: readonly string[];
    readonly subSport: readonly string[];
    readonly period: readonly string[];
    readonly wagerType: readonly string[];
  };
}

export interface DimensionPerformanceGroup {
  readonly dimension: "sport" | "subSport" | "period" | "wagerType";
  /** Canonical group key (`spread`, `M Moneyline`, trimmed sport/period, or `unknown`). */
  readonly key: string;
  /** Raw alert labels that collapsed into this canonical key, sorted (empty when the raw value was empty). */
  readonly rawKeys: readonly string[];
  readonly alerts: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly netUsd: number;
  readonly customers: number;
  /** Highest net customer in the group (null when no outcome joined). */
  readonly topWinner: {
    readonly customerId: string;
    readonly netUsd: number;
    readonly wins: number;
    readonly losses: number;
  } | null;
  readonly topLoser: {
    readonly customerId: string;
    readonly netUsd: number;
    readonly wins: number;
    readonly losses: number;
  } | null;
}

export interface AlertPerformanceReport {
  readonly available: boolean;
  readonly reason: string | null;
  readonly outcomeSource: string;
  readonly alerts: number;
  readonly delivered: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly netUsd: number;
  readonly customers: readonly CustomerPerformance[];
  readonly dimensions: readonly DimensionPerformanceGroup[];
  readonly warnings: readonly string[];
  /**
   * Provenance for the report: alert window, outcome sources and join coverage. Optional because
   * callers may construct an "unavailable" report literal without computing a join (the CLI does);
   * every report returned by {@link buildAlertPerformance} sets it.
   */
  readonly metadata?: AlertPerformanceMetadata;
}

/** Provenance block: what the report was built from, independent of the rankings. */
export interface AlertPerformanceMetadata {
  /** First/last `atIso` among the participating (deduped, delivered-if-filtered) alerts. */
  readonly alertWindow: {
    readonly firstAtIso: string | null;
    readonly lastAtIso: string | null;
  };
  /** Distinct outcome sources supplied, sorted (e.g. `["customer_book_sample"]`). */
  readonly outcomeSources: readonly string[];
  /** Human-readable join coverage, e.g. `"matched 2 of 3 alerts (66.7%)"`. */
  readonly outcomeCoverage: string;
  readonly participatingAlerts: number;
  /** Outcome rows supplied, including ones no alert matched. */
  readonly outcomeRows: number;
  /** Participating alerts with no wager key at all, so a join was impossible. */
  readonly alertsWithoutWagerKey: number;
  /** Delivered alerts skipped from rankings because they carry no customer id at all. */
  readonly alertsWithoutCustomerKey: number;
}

const DIMENSIONS = ["sport", "subSport", "period", "wagerType"] as const;

/** Canonical bucket for an empty/unmapped dimension value: honest, never an invented market. */
const UNKNOWN_DIMENSION = "unknown";

/** `sport`/`period` keep their printed value; only trimming and the empty fallback apply. */
function canonicalTextDimension(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? UNKNOWN_DIMENSION : trimmed;
}

/**
 * `subSport` is a picker label, and `PREGAME` is a phase sentinel rather than a market. Only the
 * registry's canonical kind is a group key; PREGAME/empty/unmapped read `unknown`.
 */
function canonicalSubSport(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || trimmed.toUpperCase() === "PREGAME") {
    return UNKNOWN_DIMENSION;
  }
  return classifyMarketLabel(trimmed) ?? UNKNOWN_DIMENSION;
}

/** `wagerType` codes group by the documented readable label (`"M Moneyline"`), not the raw code. */
function canonicalWagerType(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return UNKNOWN_DIMENSION;
  const meta = wagerTypeMeta(trimmed);
  return meta === null ? UNKNOWN_DIMENSION : `${meta.code} ${meta.name}`;
}

type DimensionName = (typeof DIMENSIONS)[number];

function canonicalDimension(
  dimension: DimensionName,
  value: string | undefined,
): string {
  if (dimension === "subSport") return canonicalSubSport(value);
  if (dimension === "wagerType") return canonicalWagerType(value);
  return canonicalTextDimension(value);
}

/** First/last participating-alert instant; unparseable timestamps are ignored, not guessed. */
function alertWindowOf(rows: readonly AlertPerformanceRow[]): {
  readonly firstAtIso: string | null;
  readonly lastAtIso: string | null;
} {
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  let firstAtIso: string | null = null;
  let lastAtIso: string | null = null;
  for (const row of rows) {
    const ms = Date.parse(row.alert.atIso);
    if (Number.isNaN(ms)) continue;
    if (ms < firstMs) {
      firstMs = ms;
      firstAtIso = row.alert.atIso;
    }
    if (ms > lastMs) {
      lastMs = ms;
      lastAtIso = row.alert.atIso;
    }
  }
  return { firstAtIso, lastAtIso };
}

/** `"matched N of M alerts (X%)"`; 0 participants reads `"matched 0 of 0 alerts (0%)"`. */
function outcomeCoverageOf(matched: number, participating: number): string {
  const percent =
    participating === 0 ? 0 : Math.round((matched / participating) * 1000) / 10;
  return `matched ${matched} of ${participating} alerts (${percent}%)`;
}

function normalizeLogin(value: string | undefined): string {
  return (typeof value === "string" ? value : String(value ?? ""))
    .trim()
    .toUpperCase();
}

function normalizeWager(value: string | number | undefined): string {
  return String(value ?? "").trim();
}

function outcomeOf(raw: string | null | undefined): AlertOutcome | null {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "WIN" || value === "W" || value === "WON") return "win";
  if (value === "LOSS" || value === "L" || value === "LOST") return "loss";
  if (value === "PUSH" || value === "P" || value === "PUSHED") return "push";
  if (
    value === "VOID" ||
    value === "V" ||
    value === "CANCELED" ||
    value === "C"
  ) {
    return "void";
  }
  return null;
}

interface BookCustomer {
  readonly customer_id?: unknown;
  readonly recent_tickets?: readonly {
    readonly wager_number?: unknown;
    readonly result?: unknown;
    readonly net_usd?: unknown;
  }[];
}

/**
 * Outcomes from the enriched customer book's recent-ticket SAMPLE. Only customers whose sampled
 * tickets include a result are usable; the rest are absent (not lost).
 */
export function outcomesFromCustomerBook(
  book: unknown,
): AlertPerformanceOutcome[] {
  if (!Array.isArray(book)) return [];
  const outcomes: AlertPerformanceOutcome[] = [];
  for (const raw of book as readonly BookCustomer[]) {
    const customerId = normalizeLogin(
      typeof raw.customer_id === "string" ? raw.customer_id : undefined,
    );
    if (customerId === "") continue;
    for (const ticket of raw.recent_tickets ?? []) {
      const wagerNumber = normalizeWager(
        typeof ticket.wager_number === "number" ||
          typeof ticket.wager_number === "string"
          ? ticket.wager_number
          : undefined,
      );
      if (wagerNumber === "") continue;
      const outcome = outcomeOf(
        typeof ticket.result === "string" ? ticket.result : null,
      );
      if (outcome === null) continue;
      const netUsd =
        typeof ticket.net_usd === "number" && Number.isFinite(ticket.net_usd)
          ? ticket.net_usd
          : null;
      outcomes.push({
        customerId,
        wagerNumber,
        outcome,
        netUsd,
        source: "customer_book_sample",
      });
    }
  }
  return outcomes;
}

/** Parse a normalized outcomes JSONL/JSON file (`{rows:[...]}` or a bare array). */
export function parseOutcomeRows(value: unknown): AlertPerformanceOutcome[] {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? (((value as Record<string, unknown>)["rows"] as
          unknown[] | undefined) ??
        ((value as Record<string, unknown>)["outcomes"] as
          unknown[] | undefined) ??
        [])
      : [];
  const outcomes: AlertPerformanceOutcome[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const customerId = normalizeLogin(
      typeof row["customerId"] === "string"
        ? row["customerId"]
        : typeof row["login"] === "string"
          ? row["login"]
          : undefined,
    );
    const wagerNumber = normalizeWager(
      typeof row["wagerNumber"] === "string" ||
        typeof row["wagerNumber"] === "number"
        ? row["wagerNumber"]
        : undefined,
    );
    const outcome = outcomeOf(
      typeof row["outcome"] === "string"
        ? row["outcome"]
        : typeof row["result"] === "string"
          ? row["result"]
          : null,
    );
    if (customerId === "" || wagerNumber === "" || outcome === null) continue;
    const netUsd =
      typeof row["netUsd"] === "number" && Number.isFinite(row["netUsd"])
        ? row["netUsd"]
        : null;
    outcomes.push({
      customerId,
      wagerNumber,
      outcome,
      netUsd,
      source:
        typeof row["source"] === "string" ? row["source"] : "outcomes_file",
    });
  }
  return outcomes;
}

/** Load explicit outcomes from disk; a missing file returns null so callers can report MISSING. */
export async function loadOutcomeFile(
  path: string,
): Promise<AlertPerformanceOutcome[] | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  // Accept a JSON array / {rows:[...]} document or one JSON object per line. A parse failure is
  // null (distinguishable from a valid empty file); a valid empty document is [].
  try {
    const parsed: unknown = JSON.parse(text);
    const rows = parseOutcomeRows(parsed);
    if (rows.length > 0) return rows;
    const single = parseOutcomeRows([parsed]);
    if (single.length > 0) return single;
    const isRecognizableDocument =
      Array.isArray(parsed) ||
      (typeof parsed === "object" &&
        parsed !== null &&
        ("rows" in parsed ||
          "outcomes" in parsed ||
          "customerId" in parsed ||
          "login" in parsed));
    return isRecognizableDocument ? [] : null;
  } catch {
    const rows: AlertPerformanceOutcome[] = [];
    let sawContent = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      sawContent = true;
      try {
        rows.push(...parseOutcomeRows([JSON.parse(trimmed)]));
      } catch {
        // Skip malformed lines; the valid ones still load.
      }
    }
    if (!sawContent) return [];
    // Every line malformed (or none was a usable outcome row): a parse failure, not empty data.
    return rows.length > 0 ? rows : null;
  }
}

export interface BuildAlertPerformanceOptions {
  /** Defaults to true: only rows with status "sent" count as alerts that reached the chat. */
  readonly deliveredOnly?: boolean;
  readonly dimensions?: readonly (
    "sport" | "subSport" | "period" | "wagerType"
  )[];
}

export function buildAlertPerformance(
  alerts: readonly TelegramAlertAuditRow[],
  outcomes: readonly AlertPerformanceOutcome[],
  options: BuildAlertPerformanceOptions = {},
): AlertPerformanceReport {
  const deliveredOnly = options.deliveredOnly ?? true;
  const dimensions = options.dimensions ?? DIMENSIONS;
  const outcomeIndex = new Map<string, AlertPerformanceOutcome>();
  for (const outcome of outcomes) {
    outcomeIndex.set(`${outcome.customerId}|${outcome.wagerNumber}`, outcome);
  }

  // One row per (customer, wager): repeated sends/dry-runs of the same bet must not double-count.
  // Prefer a delivered row over a simulated/failed duplicate, then the latest timestamp.
  const priority: Record<string, number> = {
    sent: 4,
    failed: 3,
    simulated: 2,
    deduped: 1,
    rate_limited: 0,
  };
  const deduped = new Map<string, TelegramAlertAuditRow>();
  let alertsWithoutCustomerKey = 0;
  for (const alert of alerts) {
    if (deliveredOnly && alert.status !== "sent") continue;
    if (alert.customerId === undefined || alert.customerId === "") {
      alertsWithoutCustomerKey += 1;
      continue;
    }
    const wagerNumber = normalizeWager(alert.wagerNumber);
    const fallbackKey = alert.betKey ?? alert.dedupeKey;
    const key =
      wagerNumber !== ""
        ? `${normalizeLogin(alert.customerId)}|w:${wagerNumber}`
        : fallbackKey !== undefined
          ? `${normalizeLogin(alert.customerId)}|b:${fallbackKey}`
          : `${normalizeLogin(alert.customerId)}|u:${alert.atIso}|${alert.ruleId ?? ""}|${alert.chatId ?? ""}`;
    const existing = deduped.get(key);
    if (existing === undefined) {
      deduped.set(key, alert);
      continue;
    }
    const newer =
      (priority[alert.status] ?? 0) > (priority[existing.status] ?? 0) ||
      ((priority[alert.status] ?? 0) === (priority[existing.status] ?? 0) &&
        Date.parse(alert.atIso) > Date.parse(existing.atIso));
    if (newer) deduped.set(key, alert);
  }

  const rows: AlertPerformanceRow[] = [];
  for (const alert of deduped.values()) {
    const wagerNumber = normalizeWager(alert.wagerNumber);
    const outcome =
      wagerNumber === ""
        ? undefined
        : outcomeIndex.get(
            `${normalizeLogin(alert.customerId)}|${wagerNumber}`,
          );
    rows.push({
      alert,
      outcome: outcome ?? null,
      status: outcome?.outcome ?? "unmatched",
      netUsd: outcome?.netUsd ?? null,
    });
  }

  const byCustomer = new Map<
    string,
    {
      alerts: number;
      matched: number;
      wins: number;
      losses: number;
      pushes: number;
      netUsd: number;
      dims: Record<string, Set<string>>;
    }
  >();
  for (const row of rows) {
    const customerId = normalizeLogin(row.alert.customerId);
    const bucket = byCustomer.get(customerId) ?? {
      alerts: 0,
      matched: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      netUsd: 0,
      dims: Object.fromEntries(
        dimensions.map((dimension) => [dimension, new Set<string>()]),
      ) as Record<string, Set<string>>,
    };
    bucket.alerts += 1;
    if (row.outcome !== null) {
      bucket.matched += 1;
      bucket.netUsd += row.netUsd ?? 0;
      if (row.status === "win") bucket.wins += 1;
      else if (row.status === "loss") bucket.losses += 1;
      else if (row.status === "push") bucket.pushes += 1;
    }
    for (const dimension of dimensions) {
      bucket.dims[dimension]?.add(
        canonicalDimension(dimension, row.alert[dimension]),
      );
    }
    byCustomer.set(customerId, bucket);
  }

  const customers: CustomerPerformance[] = [...byCustomer.entries()].map(
    ([customerId, bucket]) => ({
      customerId,
      alerts: bucket.alerts,
      matched: bucket.matched,
      wins: bucket.wins,
      losses: bucket.losses,
      pushes: bucket.pushes,
      netUsd: Math.round(bucket.netUsd * 100) / 100,
      dimensions: {
        sport: [...(bucket.dims["sport"] ?? [])],
        subSport: [...(bucket.dims["subSport"] ?? [])],
        period: [...(bucket.dims["period"] ?? [])],
        wagerType: [...(bucket.dims["wagerType"] ?? [])],
      },
    }),
  );

  const dimensionGroups: DimensionPerformanceGroup[] = [];
  for (const dimension of dimensions) {
    const groups = new Map<
      string,
      { rows: AlertPerformanceRow[]; rawKeys: Set<string> }
    >();
    for (const row of rows) {
      const raw = row.alert[dimension];
      const key = canonicalDimension(dimension, raw);
      const bucket = groups.get(key) ?? {
        rows: [],
        rawKeys: new Set<string>(),
      };
      bucket.rows.push(row);
      const trimmed = (raw ?? "").trim();
      if (trimmed !== "") bucket.rawKeys.add(trimmed);
      groups.set(key, bucket);
    }
    for (const [key, bucket] of [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const groupRows = bucket.rows;
      const perCustomer = new Map<
        string,
        { netUsd: number; wins: number; losses: number }
      >();
      for (const row of groupRows) {
        if (row.outcome === null) continue;
        const customerId = normalizeLogin(row.alert.customerId);
        const bucket = perCustomer.get(customerId) ?? {
          netUsd: 0,
          wins: 0,
          losses: 0,
        };
        bucket.netUsd += row.netUsd ?? 0;
        if (row.status === "win") bucket.wins += 1;
        else if (row.status === "loss") bucket.losses += 1;
        perCustomer.set(customerId, bucket);
      }
      const ranked = [...perCustomer.entries()].sort(
        (a, b) => b[1].netUsd - a[1].netUsd,
      );
      const top = ranked[0];
      const bottom = ranked[ranked.length - 1];
      dimensionGroups.push({
        dimension,
        key,
        rawKeys: [...bucket.rawKeys].sort(),
        alerts: groupRows.length,
        matched: groupRows.filter((row) => row.outcome !== null).length,
        unmatched: groupRows.filter((row) => row.outcome === null).length,
        wins: groupRows.filter((row) => row.status === "win").length,
        losses: groupRows.filter((row) => row.status === "loss").length,
        pushes: groupRows.filter((row) => row.status === "push").length,
        netUsd:
          Math.round(
            groupRows.reduce((sum, row) => sum + (row.netUsd ?? 0), 0) * 100,
          ) / 100,
        customers: perCustomer.size,
        topWinner:
          top === undefined
            ? null
            : {
                customerId: top[0],
                netUsd: Math.round(top[1].netUsd * 100) / 100,
                wins: top[1].wins,
                losses: top[1].losses,
              },
        topLoser:
          bottom === undefined || bottom[1].netUsd === top?.[1].netUsd
            ? null
            : {
                customerId: bottom[0],
                netUsd: Math.round(bottom[1].netUsd * 100) / 100,
                wins: bottom[1].wins,
                losses: bottom[1].losses,
              },
      });
    }
  }

  const matched = rows.filter((row) => row.outcome !== null).length;
  const warnings: string[] = [];
  if (outcomes.some((outcome) => outcome.source === "customer_book_sample")) {
    warnings.push(
      "outcomes come from the enriched customer book's ~5-ticket-per-customer SAMPLE (generated fixture book); these rankings are not full-history evidence",
    );
  }
  if (matched === 0) {
    warnings.push(
      "no outcome joined; alerts without a wager key or without a sampled/settled result are unmatched",
    );
  }
  const hasNonSentCustomers = alerts.some(
    (alert) =>
      alert.status !== "sent" &&
      alert.customerId !== undefined &&
      alert.customerId !== "",
  );
  return {
    available: matched > 0,
    reason:
      matched > 0
        ? null
        : deliveredOnly && rows.length === 0 && hasNonSentCustomers
          ? "only non-sent (simulated/failed) alerts matched the filters; pass --include-simulated to evaluate them"
          : alertsWithoutCustomerKey > 0 && rows.length === 0
            ? `no alert row carried a customer id (${alertsWithoutCustomerKey} delivered alert(s) without one)`
            : "no alert row could be joined to an outcome (missing wager key or unsampled result)",
    outcomeSource:
      outcomes.length === 0
        ? "none"
        : [...new Set(outcomes.map((outcome) => outcome.source))].join("+"),
    alerts: rows.length + alertsWithoutCustomerKey,
    delivered: alerts.filter((alert) => alert.status === "sent").length,
    matched,
    unmatched: rows.length - matched + alertsWithoutCustomerKey,
    wins: rows.filter((row) => row.status === "win").length,
    losses: rows.filter((row) => row.status === "loss").length,
    pushes: rows.filter((row) => row.status === "push").length,
    netUsd:
      Math.round(rows.reduce((sum, row) => sum + (row.netUsd ?? 0), 0) * 100) /
      100,
    customers,
    dimensions: dimensionGroups,
    warnings,
    metadata: {
      alertWindow: alertWindowOf(rows),
      outcomeSources: [
        ...new Set(outcomes.map((outcome) => outcome.source)),
      ].sort(),
      outcomeCoverage: outcomeCoverageOf(
        matched,
        rows.length + alertsWithoutCustomerKey,
      ),
      participatingAlerts: rows.length + alertsWithoutCustomerKey,
      outcomeRows: outcomes.length,
      alertsWithoutWagerKey: rows.filter(
        (row) => normalizeWager(row.alert.wagerNumber) === "",
      ).length,
      alertsWithoutCustomerKey,
    },
  };
}

/** Default path of the book used when no explicit outcomes file is supplied. */
export function defaultCustomerBookPath(root: string): string {
  return join(root, "enriched_customers_full.json");
}
