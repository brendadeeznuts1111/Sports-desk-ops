/**
 * @file src/config/wagerTiers.ts
 * @description Wager tier configuration loader — resolves @token:* and env:*, validates monotonicity.
 */

import raw from "../../config/wager_tiers.toml";
import tokensRaw from "../../design/tokens.toml";
import type { Tier, WagerTiersConfig } from "./wagerTiers.types.ts";

export type { Tier, WagerTiersConfig } from "./wagerTiers.types.ts";

// ---------------------------------------------------------------------------
// 1. Token resolution — every "@token:*" is looked up in design/tokens.toml.
//    The token value itself may be an "env:*" reference (env-overridable tokens).
// ---------------------------------------------------------------------------
export function resolveTokens<T>(node: T, tokens: Record<string, string>): T {
  if (typeof node === "string" && node.startsWith("@token:")) {
    const name = node.slice("@token:".length);
    const value = tokens[name];
    if (value === undefined) {
      throw new Error(`[wager-tiers] unresolved token "@token:${name}"`);
    }
    return value as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((n) => resolveTokens(n, tokens)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const k of Object.keys(record)) {
      record[k] = resolveTokens(record[k], tokens);
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// 2. Env resolution — "@token:*" already collapsed; now resolve "env:*".
// ---------------------------------------------------------------------------
export function resolveEnv<T>(node: T): T {
  if (typeof node === "string" && node.startsWith("env:")) {
    return (process.env[node.slice(4)] ?? node) as unknown as T;
  }
  if (Array.isArray(node)) return node.map(resolveEnv) as unknown as T;
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const k of Object.keys(record)) {
      record[k] = resolveEnv(record[k]);
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// 3. Validation — tier coverage, valid actions, known channels, token drift.
// ---------------------------------------------------------------------------
export function validate(cfg: WagerTiersConfig): WagerTiersConfig {
  const allowedActions = new Set([
    "ALERT_OPERATOR",
    "MONITOR_FLOW",
    "THROTTLE_INPLAY",
    "STANDARD_ROUTING",
  ]);
  const knownChannels = new Set(
    cfg.notifications
      ? Object.keys(cfg.notifications)
      : ["telegram", "pagerduty", "webhook"],
  );

  const distinctTiers = Object.values(cfg.tiers).filter(
    (t, idx, arr) => arr.findIndex((x) => x.minScore === t.minScore) === idx,
  );

  for (const t of distinctTiers) {
    if (!allowedActions.has(t.action)) {
      throw new Error(
        `[wager-tiers] tier "${t.label}" has invalid action "${t.action}"`,
      );
    }
    if (t.channels) {
      for (const c of t.channels) {
        if (!knownChannels.has(c)) {
          throw new Error(
            `[wager-tiers] tier "${t.label}" references unknown channel "${c}"`,
          );
        }
      }
    }
    // Backward compatibility property
    t.alertTelegram =
      t.alertTelegram ??
      Boolean(
        t.channels?.includes("telegram") || t.aggregateChannel === "telegram",
      );
  }

  if (cfg.meta?.validation?.enforceMonotonicScores) {
    const sortedAsc = [...distinctTiers].sort(
      (a, b) => a.minScore - b.minScore,
    );
    for (let i = 1; i < sortedAsc.length; i++) {
      const prev = sortedAsc[i - 1]!;
      const curr = sortedAsc[i]!;
      if (prev.maxScore !== undefined && prev.maxScore !== curr.minScore) {
        throw new Error(
          `[wager-tiers] gap/overlap between "${prev.label}" (max ${prev.maxScore}) ` +
            `and "${curr.label}" (min ${curr.minScore})`,
        );
      }
    }
  }
  return cfg;
}

export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as unknown as T;
  if (
    "epochNanoseconds" in obj &&
    typeof (obj as { toString?: () => string }).toString === "function"
  ) {
    return (obj as { toString: () => string }).toString() as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(deepClone) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    copy[k] = deepClone(v);
  }
  return copy as T;
}

// ---------------------------------------------------------------------------
// 4. Load, resolve tokens + env, validate.
// ---------------------------------------------------------------------------
const tokens = ((tokensRaw as unknown as Record<string, unknown>).tokens ??
  {}) as Record<string, string>;
const resolved = resolveEnv(resolveTokens(deepClone(raw), tokens));

export const config: WagerTiersConfig = validate(
  resolved as unknown as WagerTiersConfig,
);

// Backward compatibility aliasing for deprecated keys
const deprecated = config.meta?.deprecatedKeys;

if (deprecated) {
  for (const [oldKey, newKey] of Object.entries(deprecated)) {
    if (config.tiers[newKey] && !config.tiers[oldKey]) {
      config.tiers[oldKey] = config.tiers[newKey];
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Tier lookup with deprecated-key aliasing (v2 → v3 migration path).
// ---------------------------------------------------------------------------

/** Pick the tier responsible for a given risk score. */
export function resolveTier(score: number): Tier {
  const sorted = Object.values(config.tiers)
    .filter(
      (t, idx, arr) => arr.findIndex((x) => x.minScore === t.minScore) === idx,
    )
    .sort((a, b) => b.minScore - a.minScore);
  for (const t of sorted) {
    if (
      score >= t.minScore &&
      (t.maxScore === undefined || score < t.maxScore)
    ) {
      return t;
    }
  }
  return sorted[sorted.length - 1]!;
}

/** Look up a tier by canonical name or deprecated alias (logs a warning). */
export function getTier(nameOrAlias: string): Tier {
  const canonical = deprecated?.[nameOrAlias] ?? nameOrAlias;
  if (canonical !== nameOrAlias) {
    console.warn(
      `[wager-tiers] "${nameOrAlias}" is deprecated; use "${canonical}"`,
    );
  }
  const tier = config.tiers[canonical];
  if (!tier) {
    throw new Error(`[wager-tiers] unknown tier "${nameOrAlias}"`);
  }
  return tier;
}
