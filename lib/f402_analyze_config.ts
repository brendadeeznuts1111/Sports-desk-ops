/**
 * Per-signal weight, threshold and list overrides for analyze. Unknown keys
 * fail loudly; omitted keys keep the stock defaults so existing tests stay put.
 */

import { F402AnalyzeError } from "./f402_analyze_ingest.ts";

export const LINK_EVIDENCE_TYPES = [
  "shared_ip",
  "same_device_timing",
  "transfer",
  "same_entered_by",
  "matching_deposit_withdrawal",
  "shared_parlay_legs",
  "stake_fingerprint",
  "steam_chase",
  "sport_market_mix",
  "clv_beat",
  "middling_arb",
  "login_then_bet",
] as const;

export type LinkEvidenceTypeName = (typeof LINK_EVIDENCE_TYPES)[number];

export const PREDICT_SIGNAL_NAMES = [
  "balance_trend",
  "activity_cadence",
  "activity_gaps",
  "deposit_withdrawal_rhythm",
  "credit_limit_drawdown",
  "agent_moves",
] as const;

export type ConfigPredictSignalName = (typeof PREDICT_SIGNAL_NAMES)[number];

export const DEFAULT_LINK_THRESHOLDS = {
  minEdgeScore: 0.2,
  ringMinEdgeScore: 0.2,
  sharedIpWindowMs: 2 * 60 * 60_000,
  deviceWindowMs: 15 * 60_000,
  transferWindowMs: 2 * 60 * 60_000,
  cashMatchWindowMs: 24 * 60 * 60_000,
  parlayWindowMs: 60 * 60_000,
  steamWindowMs: 5 * 60_000,
  parlayJaccardMin: 0.8,
  middleWindowMs: 24 * 60 * 60_000,
  loginBetWindowMs: 2 * 60 * 60_000,
  loginBetMinPairs: 3,
  clvMinSharedEvents: 2,
} as const;

export type LinkThresholdName = keyof typeof DEFAULT_LINK_THRESHOLDS;

/**
 * `genericEnteredBy`: ledger `EnteredBy` values (trimmed, lower-cased) that
 * name a channel or the system, not a person, so they are never
 * `same_entered_by` evidence. `sharedInfraClasses`: IP classes from
 * `classifyWeblogIpExtended` that many unrelated customers share, so a
 * `shared_ip` match there is down-weighted. A configured list replaces the
 * default; it does not extend it.
 */
export const DEFAULT_LINK_LISTS = {
  genericEnteredBy: ["", "system", "internet", "ggl-livedealer"],
  sharedInfraClasses: [
    "CGNAT",
    "T_MOBILE",
    "VERIZON_192",
    "VERIZON_208",
    "ICLOUD_RELAY",
    "BOT_RING_140_248",
    "IPV6_CARRIER:T_MOBILE",
    "IPV6_CARRIER:VERIZON",
    "IPV6_CARRIER:ATT",
    "IPV6_CARRIER:ICLOUD",
  ],
} as const satisfies Record<string, readonly string[]>;

export type LinkListName = keyof typeof DEFAULT_LINK_LISTS;

export interface ResolvedLinkLists {
  readonly genericEnteredBy: ReadonlySet<string>;
  readonly sharedInfraClasses: ReadonlySet<string>;
}

export interface AnalyzeConfig {
  readonly weights: {
    readonly link: Readonly<Partial<Record<LinkEvidenceTypeName, number>>>;
    readonly predict: Readonly<
      Partial<Record<ConfigPredictSignalName, number>>
    >;
  };
  readonly thresholds: Readonly<Partial<Record<LinkThresholdName, number>>>;
  readonly lists?: Readonly<Partial<Record<LinkListName, readonly string[]>>>;
}

export const EMPTY_ANALYZE_CONFIG: AnalyzeConfig = {
  weights: { link: {}, predict: {} },
  thresholds: {},
  lists: {},
};

const PREDICT_NAMES = new Set<string>(PREDICT_SIGNAL_NAMES);
const LINK_NAMES = new Set<string>(LINK_EVIDENCE_TYPES);
const THRESHOLD_NAMES = new Set<string>(Object.keys(DEFAULT_LINK_THRESHOLDS));
const LIST_NAMES = new Set<string>(Object.keys(DEFAULT_LINK_LISTS));
const ROOT_KEYS = new Set(["weights", "thresholds", "lists"]);
const WEIGHT_ROOT_KEYS = new Set(["link", "predict"]);

function fail(message: string): never {
  throw new F402AnalyzeError("config", "config", message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
  return value;
}

function parseWeightMap<K extends string>(
  raw: unknown,
  path: string,
  allowed: ReadonlySet<string>,
): Partial<Record<K, number>> {
  if (raw === undefined) return {};
  const obj = asObject(raw, path);
  const out: Partial<Record<K, number>> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!allowed.has(key)) fail(`unknown weight ${path}.${key}`);
    const n = asFiniteNumber(value, `${path}.${key}`);
    if (n < 0 || n > 1) fail(`${path}.${key} must be between 0 and 1`);
    out[key as K] = n;
  }
  return out;
}

function parseLinkList(name: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) fail(`lists.${name} must be an array of strings`);
  const out: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string") {
      fail(`lists.${name}[${index}] must be a string`);
    }
    const value =
      name === "genericEnteredBy" ? item.trim().toLowerCase() : item.trim();
    if (value === "" && name !== "genericEnteredBy") {
      fail(`lists.${name}[${index}] must not be empty`);
    }
    out.push(value);
  }
  return out;
}

/** Validate and normalize a config object (already parsed JSON). */
export function parseAnalyzeConfig(raw: unknown): AnalyzeConfig {
  const obj = asObject(raw, "config");
  for (const key of Object.keys(obj)) {
    if (!ROOT_KEYS.has(key)) fail(`unknown config key "${key}"`);
  }
  const weightsRaw = obj.weights;
  let link: Partial<Record<LinkEvidenceTypeName, number>> = {};
  let predict: Partial<Record<ConfigPredictSignalName, number>> = {};
  if (weightsRaw !== undefined) {
    const weights = asObject(weightsRaw, "weights");
    for (const key of Object.keys(weights)) {
      if (!WEIGHT_ROOT_KEYS.has(key)) fail(`unknown weights key "${key}"`);
    }
    link = parseWeightMap(weights.link, "weights.link", LINK_NAMES);
    predict = parseWeightMap(weights.predict, "weights.predict", PREDICT_NAMES);
  }
  const thresholds: Partial<Record<LinkThresholdName, number>> = {};
  if (obj.thresholds !== undefined) {
    const rawThresholds = asObject(obj.thresholds, "thresholds");
    for (const [key, value] of Object.entries(rawThresholds)) {
      if (!THRESHOLD_NAMES.has(key)) fail(`unknown threshold "${key}"`);
      const n = asFiniteNumber(value, `thresholds.${key}`);
      if (n < 0) fail(`thresholds.${key} must be >= 0`);
      thresholds[key as LinkThresholdName] = n;
    }
  }
  const lists: Partial<Record<LinkListName, readonly string[]>> = {};
  if (obj.lists !== undefined) {
    const rawLists = asObject(obj.lists, "lists");
    for (const [key, value] of Object.entries(rawLists)) {
      if (!LIST_NAMES.has(key)) fail(`unknown list "${key}"`);
      lists[key as LinkListName] = parseLinkList(key, value);
    }
  }
  return { weights: { link, predict }, thresholds, lists };
}

export async function loadAnalyzeConfig(path: string): Promise<AnalyzeConfig> {
  const trimmed = path.trim();
  if (trimmed === "") fail("missing --config path");
  let text: string;
  try {
    text = await Bun.file(trimmed).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot read --config ${trimmed}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`--config is not valid JSON: ${message}`);
  }
  return parseAnalyzeConfig(parsed);
}

export function resolvedLinkThresholds(config: AnalyzeConfig | undefined): {
  readonly [K in LinkThresholdName]: number;
} {
  return { ...DEFAULT_LINK_THRESHOLDS, ...config?.thresholds };
}

export function resolvedLinkLists(
  config: AnalyzeConfig | undefined,
): ResolvedLinkLists {
  return {
    genericEnteredBy: new Set(
      config?.lists?.genericEnteredBy ?? DEFAULT_LINK_LISTS.genericEnteredBy,
    ),
    sharedInfraClasses: new Set(
      config?.lists?.sharedInfraClasses ??
        DEFAULT_LINK_LISTS.sharedInfraClasses,
    ),
  };
}
