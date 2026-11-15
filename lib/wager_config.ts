/**
 * @file lib/wager_config.ts
 * @description Declarative wager tier & surveillance configuration loader (`config/wager_tiers.toml`).
 * Parsed with native Bun.TOML and validated with Zod, with token resolution from `design/tokens.toml`.
 */

import { TOML } from "bun";
import { z } from "zod";
import { auditConfig } from "./audit_log.ts";
import {
  deepClone,
  getTier,
  resolveEnv,
  resolveTier,
  resolveTokens,
  validate,
} from "../src/config/wagerTiers.ts";
import type { Tier, WagerTiersConfig } from "../src/config/wagerTiers.types.ts";

export type { Tier, WagerTiersConfig };
export { getTier, resolveTier };

export const DEFAULT_WAGER_TIERS_CONFIG_PATH = "config/wager_tiers.toml";
export const DEFAULT_TOKENS_CONFIG_PATH = "design/tokens.toml";

export const tierEntrySchema = z.object({
  label: z.string().optional(),
  badge: z.string().min(1),
  priority: z.number().int().optional(),
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  border: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  minScore: z.number().min(0).max(10),
  maxScore: z.number().min(0).max(10).optional(),
  action: z.string().min(1),
  reviewSlaSeconds: z.number().int().nonnegative().default(0),
  cooldownSeconds: z.number().int().nonnegative().default(0),
  maxStakeUsd: z.number().nonnegative().default(500),
  auditLevel: z.string().default("standard"),
  channels: z.array(z.string()).default([]),
  aggregateChannel: z.string().optional(),
  aggregateWindowSeconds: z.number().int().positive().optional(),
  aggregateMinCount: z.number().int().positive().optional(),
  autoActionNotifyThreshold: z.number().int().positive().optional(),
  tags: z.array(z.string()).default([]),
  alertTelegram: z.boolean().optional(),
});

export const DEFAULT_SURFACE = {
  panel: "#0b1120",
  border: "#243247",
  text: "#f1f5f9",
  muted: "#94a3b8",
  accent: "#38bdf8",
};

export const DEFAULT_SURVEILLANCE = {
  clvAlertThresholdCents: 10.0,
  steamTimeWindowSeconds: 120,
  highRiskThresholdUsd: 5000,
  inplayDelaySeconds: 3,
};

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const surfaceProvenanceSchema = z.object({
  liveFg: hexColorSchema,
  liveBg: hexColorSchema,
  liveBorder: hexColorSchema,
  captureFg: hexColorSchema,
  captureBg: hexColorSchema,
  captureBorder: hexColorSchema,
  staleFg: hexColorSchema,
  staleBg: hexColorSchema,
  staleBorder: hexColorSchema,
  fixtureFg: hexColorSchema,
  fixtureBg: hexColorSchema,
  fixtureBorder: hexColorSchema,
});

export const surfaceSchema = z.object({
  bg: hexColorSchema.optional(),
  cli: hexColorSchema.optional(),
  panel: hexColorSchema.default(DEFAULT_SURFACE.panel),
  elevated: hexColorSchema.optional(),
  hover: hexColorSchema.optional(),
  raised: hexColorSchema.optional(),
  border: hexColorSchema.default(DEFAULT_SURFACE.border),
  borderStrong: hexColorSchema.optional(),
  text: hexColorSchema.default(DEFAULT_SURFACE.text),
  textSecondary: hexColorSchema.optional(),
  muted: hexColorSchema.default(DEFAULT_SURFACE.muted),
  accent: hexColorSchema.default(DEFAULT_SURFACE.accent),
  danger: hexColorSchema.optional(),
  warn: hexColorSchema.optional(),
  ok: hexColorSchema.optional(),
  info: hexColorSchema.optional(),
  provenance: surfaceProvenanceSchema.optional(),
  typography: z
    .object({
      fontFamily: z.string(),
      monoFamily: z.string(),
      scale: z.number(),
    })
    .optional(),
});

export const wagerDashboardSchema = z.object({
  defaultTab: z.string().min(1).default("customers"),
  refreshIntervalSeconds: z.number().int().positive().max(3600).default(15),
  staleFeedWarnMinutes: z.number().positive().max(1440).default(30),
  maxLiveTapeRows: z.number().int().positive().max(5000).default(250),
  highlightSharpScoreMin: z.number().min(0).max(10).default(7.5),
  showProvenanceBadges: z.boolean().default(true),
  showInlineClvBps: z.boolean().default(true),
  autoExecute: z.literal(false).default(false),
});

export const surveillanceSchema = z.object({
  clvAlertThresholdCents: z
    .number()
    .default(DEFAULT_SURVEILLANCE.clvAlertThresholdCents),
  steamTimeWindowSeconds: z
    .number()
    .int()
    .default(DEFAULT_SURVEILLANCE.steamTimeWindowSeconds),
  highRiskThresholdUsd: z
    .number()
    .default(DEFAULT_SURVEILLANCE.highRiskThresholdUsd),
  inplayDelaySeconds: z
    .number()
    .int()
    .default(DEFAULT_SURVEILLANCE.inplayDelaySeconds),
  velocityWindowSeconds: z.number().int().optional(),
  velocityBurstCount: z.number().int().optional(),
  maxWagerPerTicketUsd: z.number().optional(),
  maxWagerPerMinuteUsd: z.number().optional(),
  correlationWindowSeconds: z.number().int().optional(),
  staleLineSeconds: z.number().int().optional(),
  minSampleSizeForClv: z.number().int().optional(),
  scoring: z
    .object({
      weightsOriginator: z.number(),
      weightsSteam: z.number(),
      weightsLatency: z.number(),
      weightsHistorical: z.number(),
      decayHalfLifeHours: z.number(),
    })
    .optional(),
});

export const wagerTiersConfigSchema = z.object({
  schema: z.string().optional(),
  version: z.string().optional(),
  environment: z.string().optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
  timezone: z.string().optional(),
  meta: z
    .object({
      schema_version: z.number().int().optional(),
      name: z.string().optional(),
      owner: z.string().optional(),
      channel: z.string().optional(),
      oncall: z.string().optional(),
      validation: z
        .object({
          enforceMonotonicScores: z.boolean().default(true),
          rejectUnknownTiers: z.boolean().default(true),
          failClosedOnInvalid: z.boolean().default(true),
        })
        .optional(),
      taxonomy: z.record(z.string(), z.unknown()).optional(),
      deprecatedKeys: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  surface: surfaceSchema.default(DEFAULT_SURFACE),
  tiers: z.record(z.string(), tierEntrySchema),
  surveillance: surveillanceSchema.default(DEFAULT_SURVEILLANCE),
  notifications: z.record(z.string(), z.unknown()).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  rateLimits: z.record(z.string(), z.unknown()).optional(),
  audit: z.record(z.string(), z.unknown()).optional(),
  dashboard: wagerDashboardSchema.optional(),
});

let lastLoadedConfig: { path: string; config: WagerTiersConfig } | null = null;

export async function loadTokens(
  tokensPath: string = DEFAULT_TOKENS_CONFIG_PATH,
): Promise<Record<string, string>> {
  const file = Bun.file(tokensPath);
  if (!(await file.exists())) return {};
  const text = await file.text();
  const parsed = TOML.parse(text) as Record<string, unknown>;
  return (parsed?.tokens ?? {}) as Record<string, string>;
}

export async function parseAndValidateWagerConfig(
  rawToml: unknown,
  tokens?: Record<string, string>,
): Promise<WagerTiersConfig> {
  const resolvedTokens = tokens ?? (await loadTokens());
  const resolved = resolveEnv(
    resolveTokens(deepClone(rawToml), resolvedTokens),
  );
  const parsed = wagerTiersConfigSchema.parse(
    resolved,
  ) as unknown as WagerTiersConfig;
  const validated = validate(parsed);

  // Backward compatibility aliasing for deprecated keys
  const deprecated = validated.meta?.deprecatedKeys;
  if (deprecated) {
    for (const [oldKey, newKey] of Object.entries(deprecated)) {
      if (validated.tiers[newKey] && !validated.tiers[oldKey]) {
        validated.tiers[oldKey] = validated.tiers[newKey];
      }
    }
  }
  return validated;
}

/**
 * Compares two WagerTiersConfig structures using native Bun.deepEquals in strict mode.
 * Returns true if the configuration has changed, false if strictly identical.
 */
export function hasConfigChanged(
  prev: WagerTiersConfig,
  next: WagerTiersConfig,
): boolean {
  return !Bun.deepEquals(prev, next, true);
}

function getDistinctTiersCount(cfg: WagerTiersConfig): number {
  const deprecated = cfg.meta?.deprecatedKeys ?? {};
  return Object.keys(cfg.tiers).filter((k) => !(k in deprecated)).length;
}

/**
 * Loads and validates declarative wager tier configuration from a TOML file.
 * Uses native Bun.TOML with strict Zod schema validation and @token:* resolution.
 * When options.dedupeAudit is true, suppresses redundant audit log entries if config is unchanged.
 */
export async function loadTomlConfig(
  path: string = DEFAULT_WAGER_TIERS_CONFIG_PATH,
  options?: { dedupeAudit?: boolean },
): Promise<WagerTiersConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  const text = await file.text();
  const raw = TOML.parse(text);
  const parsed = await parseAndValidateWagerConfig(raw);

  const shouldAudit =
    !options?.dedupeAudit ||
    !lastLoadedConfig ||
    lastLoadedConfig.path !== path ||
    hasConfigChanged(lastLoadedConfig.config, parsed);

  if (shouldAudit) {
    auditConfig({
      action: "config_load",
      configPath: path,
      details: {
        tiersCount: getDistinctTiersCount(parsed),
        clvAlertThresholdCents: parsed.surveillance.clvAlertThresholdCents,
      },
    });
    lastLoadedConfig = { path, config: parsed };
  }

  return parsed;
}

/**
 * Reloads configuration and returns whether it changed compared to the last loaded state.
 * Uses native Bun.deepEquals strict comparison. Emits audit log only when changed.
 */
export async function reloadTomlConfigIfChanged(
  path: string = DEFAULT_WAGER_TIERS_CONFIG_PATH,
): Promise<{ config: WagerTiersConfig; changed: boolean }> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  const text = await file.text();
  const raw = TOML.parse(text);
  const next = await parseAndValidateWagerConfig(raw);

  const changed =
    !lastLoadedConfig ||
    lastLoadedConfig.path !== path ||
    hasConfigChanged(lastLoadedConfig.config, next);

  if (changed) {
    auditConfig({
      action: "config_load",
      configPath: path,
      details: {
        tiersCount: getDistinctTiersCount(next),
        clvAlertThresholdCents: next.surveillance.clvAlertThresholdCents,
      },
    });
    lastLoadedConfig = { path, config: next };
  }

  return { config: next, changed };
}

/**
 * Resets the in-memory cached configuration state (useful for test isolation).
 */
export function resetConfigCache(): void {
  lastLoadedConfig = null;
}

export { loadTomlConfig as loadWagerTiersConfig };
