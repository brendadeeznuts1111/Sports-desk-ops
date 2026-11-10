/**
 * @file tests/wager_tiers_toml.test.ts
 * @description Verification suite for declarative TOML wager tier configuration (schema v3)
 * parsed with native Bun.TOML and validated with Zod, with token and env resolution.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WAGER_TIERS_CONFIG_PATH,
  getTier,
  hasConfigChanged,
  loadTomlConfig,
  reloadTomlConfigIfChanged,
  resetConfigCache,
  resolveTier,
  wagerTiersConfigSchema,
} from "../lib/wager_config.ts";
import {
  resolveEnv,
  resolveTokens,
  validate,
} from "../src/config/wagerTiers.ts";

describe("Declarative Wager Tiers TOML Config (Bun.TOML v3)", () => {
  it("loads config/wager_tiers.toml and validates all tier entries and token resolutions", async () => {
    const config = await loadTomlConfig(DEFAULT_WAGER_TIERS_CONFIG_PATH);

    // Verify Surface with resolved @token:*
    expect(config.surface.panel).toBe("#0d1527");
    expect(config.surface.text).toBe("#f1f5f9"); // Drift fixed from #f8fafc
    expect(config.surface.border).toBe("#1e293b");

    // Verify Canonical Tiers
    expect(config.tiers.ORIGINATOR_HIGH_RISK).toBeDefined();
    expect(config.tiers.ORIGINATOR_HIGH_RISK.badge).toContain("CRITICAL");
    expect(config.tiers.ORIGINATOR_HIGH_RISK.minScore).toBe(9.0);
    expect(config.tiers.ORIGINATOR_HIGH_RISK.action).toBe("ALERT_OPERATOR");
    expect(config.tiers.ORIGINATOR_HIGH_RISK.channels).toContain("telegram");
    expect(config.tiers.ORIGINATOR_HIGH_RISK.fg).toBe("#f87171");

    expect(config.tiers.STEAM_MOVE).toBeDefined();
    expect(config.tiers.STEAM_MOVE.badge).toContain("STEAM");
    expect(config.tiers.STEAM_MOVE.minScore).toBe(8.0);
    expect(config.tiers.STEAM_MOVE.fg).toBe("#f59e0b"); // Drift fixed from #fb923c

    expect(config.tiers.LATENCY_ARB).toBeDefined();
    expect(config.tiers.LATENCY_ARB.badge).toContain("LATENCY");
    expect(config.tiers.LATENCY_ARB.minScore).toBe(7.0);

    expect(config.tiers.BASELINE).toBeDefined();
    expect(config.tiers.BASELINE.minScore).toBe(0.0);

    // Verify Backward Compatibility Aliases (CRITICAL -> ORIGINATOR_HIGH_RISK, etc.)
    expect(config.tiers.CRITICAL).toBeDefined();
    expect(config.tiers.CRITICAL.minScore).toBe(9.0);
    expect(config.tiers.CRITICAL.alertTelegram).toBe(true);

    expect(config.tiers.STEAM).toBeDefined();
    expect(config.tiers.STEAM.minScore).toBe(8.0);

    expect(config.tiers.LATENCY).toBeDefined();
    expect(config.tiers.RECREATIONAL).toBeDefined();

    // Verify Surveillance & Rationales
    expect(config.surveillance.clvAlertThresholdCents).toBe(10.0);
    expect(config.surveillance.steamTimeWindowSeconds).toBe(120);
    expect(config.surveillance.highRiskThresholdUsd).toBe(5000);
    expect(config.surveillance.inplayDelaySeconds).toBe(3);
    expect(config.surveillance.velocityBurstCount).toBe(8);
  });

  it("resolves tier by score using resolveTier", async () => {
    await loadTomlConfig(DEFAULT_WAGER_TIERS_CONFIG_PATH);

    const t1 = resolveTier(9.5);
    expect(t1.label).toContain("Critical");

    const t2 = resolveTier(8.5);
    expect(t2.label).toContain("Steam");

    const t3 = resolveTier(7.5);
    expect(t3.label).toContain("Latency");

    const t4 = resolveTier(4.0);
    expect(t4.label).toContain("Recreational");
  });

  it("looks up tier by canonical key or deprecated alias using getTier", async () => {
    await loadTomlConfig(DEFAULT_WAGER_TIERS_CONFIG_PATH);

    const canonical = getTier("ORIGINATOR_HIGH_RISK");
    expect(canonical.minScore).toBe(9.0);

    const deprecated = getTier("CRITICAL");
    expect(deprecated.minScore).toBe(9.0);
    expect(deprecated.label).toBe(canonical.label);
  });

  it("validates token resolution helper resolveTokens", () => {
    const tokens = {
      "sd-surface-panel": "#0d1527",
      "sd-text-primary": "#f1f5f9",
    };
    const input = {
      surface: {
        panel: "@token:sd-surface-panel",
        text: "@token:sd-text-primary",
      },
    };
    const resolved = resolveTokens(input, tokens);
    expect(resolved.surface.panel).toBe("#0d1527");
    expect(resolved.surface.text).toBe("#f1f5f9");

    expect(() => resolveTokens({ bg: "@token:unknown-token" }, tokens)).toThrow(
      'unresolved token "@token:unknown-token"',
    );
  });

  it("validates env resolution helper resolveEnv", () => {
    process.env.TEST_OPS_WEBHOOK_URL = "https://ops.example.com/hook";
    const input = {
      endpoint: "env:TEST_OPS_WEBHOOK_URL",
      fallback: "env:UNSET_ENV_VAR_12345",
    };
    const resolved = resolveEnv(input);
    expect(resolved.endpoint).toBe("https://ops.example.com/hook");
    expect(resolved.fallback).toBe("env:UNSET_ENV_VAR_12345");
  });

  it("enforces monotonic scores and rejects gaps or overlaps", () => {
    const validConfig = {
      meta: { validation: { enforceMonotonicScores: true } },
      tiers: {
        T1: {
          label: "T1",
          minScore: 8.0,
          maxScore: 10.0,
          action: "ALERT_OPERATOR",
          channels: [],
        },
        T2: {
          label: "T2",
          minScore: 0.0,
          maxScore: 8.0,
          action: "STANDARD_ROUTING",
          channels: [],
        },
      },
    } as unknown as Parameters<typeof validate>[0];
    expect(() => validate(validConfig)).not.toThrow();

    const gapConfig = {
      meta: { validation: { enforceMonotonicScores: true } },
      tiers: {
        T1: {
          label: "T1",
          minScore: 8.0,
          maxScore: 10.0,
          action: "ALERT_OPERATOR",
          channels: [],
        },
        T2: {
          label: "T2",
          minScore: 0.0,
          maxScore: 7.0, // gap: 7.0 to 8.0
          action: "STANDARD_ROUTING",
          channels: [],
        },
      },
    } as unknown as Parameters<typeof validate>[0];
    expect(() => validate(gapConfig)).toThrow("gap/overlap");
  });

  it("throws when config file does not exist", async () => {
    expect(
      loadTomlConfig("config/non_existent_tiers_file.toml"),
    ).rejects.toThrow("Config file not found");
  });

  it("fails schema validation on invalid hex color or out-of-range score", () => {
    const invalidConfig = {
      tiers: {
        CRITICAL: {
          fg: "not-a-hex",
          bg: "#000000",
          border: "#ffffff",
          badge: "Bad",
          minScore: 15.0, // > 10.0
          action: "TEST",
        },
      },
    };

    const res = wagerTiersConfigSchema.safeParse(invalidConfig);
    expect(res.success).toBe(false);
  });

  it("maintains browser bundle safety without pulling fs or bun modules eagerly", async () => {
    const buildResult = await Bun.build({
      entrypoints: ["src/dashboard/index.tsx"],
      target: "browser",
    });
    expect(buildResult.success).toBe(true);
    expect(buildResult.outputs.length).toBeGreaterThan(0);
    const bundleText = await buildResult.outputs[0]!.text();

    // Assert absence of server-only modules and Bun built-ins
    expect(bundleText).not.toContain("Bun.TOML");
    expect(bundleText).not.toContain('from "bun"');
    expect(bundleText).not.toContain('from"bun"');
    expect(bundleText).not.toContain('import("bun")');
    expect(bundleText).not.toContain('require("bun")');
  });

  it("detects configuration changes accurately using Bun.deepEquals (hasConfigChanged)", async () => {
    const config1 = await loadTomlConfig(DEFAULT_WAGER_TIERS_CONFIG_PATH);
    const configClone = JSON.parse(JSON.stringify(config1));

    // Identical structures -> hasConfigChanged is false
    expect(hasConfigChanged(config1, configClone)).toBe(false);

    // Mutate nested surveillance threshold -> hasConfigChanged is true
    const modifiedSurveillance = {
      ...config1,
      surveillance: {
        ...config1.surveillance,
        clvAlertThresholdCents: 15.0,
      },
    };
    expect(hasConfigChanged(config1, modifiedSurveillance)).toBe(true);

    // Mutate tier action -> hasConfigChanged is true
    const modifiedTier = JSON.parse(JSON.stringify(config1));
    modifiedTier.tiers.ORIGINATOR_HIGH_RISK.minScore = 9.5;
    expect(hasConfigChanged(config1, modifiedTier)).toBe(true);
  });

  it("verifies Bun.deepEquals strict vs non-strict mode semantics", () => {
    const base = { a: 1, b: [10, 20] };
    const exact = { a: 1, b: [10, 20] };
    const withUndefined = { a: 1, b: [10, 20], extra: undefined };

    // Standard structural equality
    expect(Bun.deepEquals(base, exact, true)).toBe(true);
    expect(Bun.deepEquals(base, exact, false)).toBe(true);

    // Strict mode distinguishes undefined properties
    expect(Bun.deepEquals(base, withUndefined, true)).toBe(false);
    expect(Bun.deepEquals(base, withUndefined, false)).toBe(true);
  });

  it("reloadTomlConfigIfChanged reloads and suppresses redundant audits when unchanged", async () => {
    resetConfigCache();

    // First load -> changed: true
    const res1 = await reloadTomlConfigIfChanged(
      DEFAULT_WAGER_TIERS_CONFIG_PATH,
    );
    expect(res1.changed).toBe(true);
    expect(res1.config.tiers.CRITICAL).toBeDefined();

    // Immediate second load without file changes -> changed: false
    const res2 = await reloadTomlConfigIfChanged(
      DEFAULT_WAGER_TIERS_CONFIG_PATH,
    );
    expect(res2.changed).toBe(false);
    expect(res2.config.tiers.CRITICAL.badge).toBe(
      res1.config.tiers.CRITICAL.badge,
    );
  });
});
