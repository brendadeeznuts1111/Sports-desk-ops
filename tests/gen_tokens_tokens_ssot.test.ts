import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  parseTokensToml,
  parseTokensTomlFromParsed,
} from "../lib/gen_tokens/tokens_ssot.ts";

const rootDir = resolve(import.meta.dir, "..");

const VALID_UI_ROLES = new Set([
  "surface",
  "border",
  "border_hairline",
  "border_interactive",
  "focus",
  "text",
]);

function makeValidMinimalDoc(): Record<string, unknown> {
  const keymap: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 10; i++) {
    const mode = i + 1;
    const keycap = mode === 10 ? "0" : String(mode);
    keymap[`M${String(mode).padStart(2, "0")}`] = {
      slot_index: i,
      bit_mask: (1 << i) >>> 0,
      key_code: `Digit${keycap}`,
      keycap,
      forensic_mode: mode,
      label: `Mode ${mode}`,
    };
  }
  return {
    meta: { version: "1.3.0" },
    gates: {
      min_body_contrast_ratio_milli: 4500,
      min_aaa_slate_contrast_milli: 7000,
      min_ui_component_contrast_milli: 3000,
      min_cross_state_delta_e00_milli: 7000,
      min_fresh_vs_stale_delta_e00_milli: 40000,
    },
    surfaces: {},
    ingestion: {},
    routes: {},
    ui: {},
    sla: {},
    bridges: { INGEST_STAGE1_DROP: 0 },
    bitmasks: { bet_legs: { IS_LIVE_LEG: 0 }, ui_state: { MODAL_OPEN_BIT: 0 } },
    keymap,
    tokens: {},
  };
}

describe("parseTokensToml", () => {
  it("parses production tokens.toml v1.4.0 with discriminated sla, thresholds, bridges, bitmasks, aliases, and bijective keymap", async () => {
    const tomlText = await Bun.file(
      resolve(rootDir, "design/tokens.toml"),
    ).text();
    const ssot = parseTokensToml(tomlText);

    expect(ssot.meta.version).toBe("1.4.0");
    expect(ssot.meta.schema).toBe("sportsdesk-tokens/v1");
    expect(ssot.meta.updated_at).toBe("2026-11-16T00:45:00Z");
    expect(ssot.surfaces).toHaveLength(2);
    expect(ssot.ingestion).toHaveLength(11);
    expect(ssot.routes).toHaveLength(4);
    expect(ssot.ui).toHaveLength(12);
    expect(ssot.sla).toHaveLength(4);
    expect(ssot.keymap).toHaveLength(10);
    expect(ssot.ui.map((u) => u.token_name)).toEqual(
      expect.arrayContaining([
        "--sd-surface-card",
        "--sd-surface-elevated",
        "--sd-surface-hover",
        "--sd-surface-raised",
        "--sd-surface-selected",
        "--sd-surface-border",
        "--sd-border-strong",
        "--sd-focus-ring",
        "--sd-focus-ring-offset",
        "--sd-text-primary",
        "--sd-text-secondary",
        "--sd-text-muted",
      ]),
    );

    const blocked = ssot.ingestion.find((c) => c.layer_id === "L19.N0518");
    expect(blocked?.sla_kind).toBe("sentinel_drop");

    const retail = ssot.ingestion.find((c) => c.layer_id === "L18.N0204");
    expect(retail?.sla_kind).toBe("latency");
    if (retail?.sla_kind === "latency") {
      expect(retail.sla_ms).toBe(1500);
      expect(retail.sla_tens_of_ms).toBe(150);
    }

    const r26 = ssot.routes.find((r) => r.layer_id === "L26.N3104");
    expect(r26?.threshold_kind).toBe("bayes_shrinkage");
    if (r26?.threshold_kind === "bayes_shrinkage") {
      expect(r26.tau_star_basis_points).toBe(6800);
      expect(r26.min_tickets).toBe(8);
    }

    expect(ssot.ui.every((t) => VALID_UI_ROLES.has(t.role))).toBe(true);
  });

  it("parses the :root alias layer and keeps every target resolvable", async () => {
    const tomlText = await Bun.file(
      resolve(rootDir, "design/tokens.toml"),
    ).text();
    const ssot = parseTokensToml(tomlText);

    expect(ssot.aliases.legacy).toEqual([
      { alias: "--sd-theme-emerald", target: "--sd-tier-gateway" },
    ]);
    expect(ssot.aliases.dashboard).toHaveLength(24);
    const dashboardAliases = ssot.aliases.dashboard.map((a) => a.alias);
    expect(dashboardAliases).toEqual(
      expect.arrayContaining([
        "--bg",
        "--card",
        "--muted",
        "--sd-state-ok",
        "--sd-state-warn",
        "--sd-state-danger",
        "--sd-state-info",
        "--sd-state-accent",
      ]),
    );

    const canonical = new Set([
      ...ssot.surfaces.map((t) => t.token_name),
      ...ssot.ui.map((t) => t.token_name),
      ...ssot.sla.flatMap((s) => [
        s.token_name,
        `${s.token_name}-bg`,
        `${s.token_name}-border`,
      ]),
      ...ssot.ingestion.map((t) => t.token_name),
      ...ssot.routes.map((t) => t.token_name),
    ]);
    for (const alias of [...ssot.aliases.legacy, ...ssot.aliases.dashboard]) {
      expect(canonical.has(alias.alias)).toBe(false);
      expect(canonical.has(alias.target)).toBe(true);
    }

    // `--sd-state-*` aliases mirror the flat [tokens] semantic accents exactly.
    const hexOf = (tokenName: string): string | undefined =>
      ssot.surfaces.find((s) => s.token_name === tokenName)?.hex ??
      ssot.ui.find((u) => u.token_name === tokenName)?.hex ??
      ssot.sla.find((s) => s.token_name === tokenName)?.fg_hex ??
      ssot.ingestion.find((c) => c.token_name === tokenName)?.hex ??
      ssot.routes.find((r) => r.token_name === tokenName)?.hex;
    const stateAccents: Readonly<Record<string, string>> = {
      "--sd-state-ok": "sd-ok",
      "--sd-state-warn": "sd-warn",
      "--sd-state-danger": "sd-danger",
      "--sd-state-info": "sd-info",
      "--sd-state-accent": "sd-accent",
    };
    for (const [aliasName, accentKey] of Object.entries(stateAccents)) {
      const alias = ssot.aliases.dashboard.find((a) => a.alias === aliasName);
      expect(alias).toBeDefined();
      expect(hexOf(alias!.target)).toBe(ssot.tokens[accentKey]);
    }
  });

  it("rejects aliases that do not resolve, shadow a token, or repeat", () => {
    const withUi = (): Record<string, unknown> => {
      const doc = makeValidMinimalDoc();
      doc.ui = {
        surface_card: {
          token_name: "--sd-surface-card",
          hex: "#0b1120",
          role: "surface",
          description: "cards",
        },
      };
      return doc;
    };

    const unknownTarget = withUi();
    unknownTarget.aliases = {
      dashboard: { "--sd-state-ok": "--sd-tier-does-not-exist" },
    };
    expect(() => parseTokensTomlFromParsed(unknownTarget)).toThrow(
      /ERR_TOKEN_ALIAS_TARGET_UNKNOWN/,
    );

    const shadow = withUi();
    shadow.aliases = {
      dashboard: { "--sd-surface-card": "--sd-surface-card" },
    };
    expect(() => parseTokensTomlFromParsed(shadow)).toThrow(
      /ERR_TOKEN_ALIAS_SHADOWS_TOKEN/,
    );

    const duplicate = withUi();
    duplicate.aliases = {
      legacy: { "--bg": "--sd-surface-card" },
      dashboard: { "--bg": "--sd-surface-card" },
    };
    expect(() => parseTokensTomlFromParsed(duplicate)).toThrow(
      /ERR_TOKEN_ALIAS_DUPLICATE/,
    );
  });

  it("rejects a legacy token name the alias layer does not own", () => {
    const channel = (legacyTokenName: string): Record<string, unknown> => ({
      channel_id: 0,
      source_bridge_id: 0,
      canonical_provenance: "PARTNER_118_GSBUILDER_L22",
      layer_id: "L20.N1105",
      token_name: "--sd-tier-gateway",
      legacy_token_name: legacyTokenName,
      hex: "#22d39a",
      channel_code: "GATEWAY",
      wire_aliases: ["GATEWAY"],
      signal_tier: "SIGNAL_EQUILIBRIUM_GATE",
      transport_uri: "portal://gateway/equilibrium-gate",
      channel_status: "ACTIVE",
      volume_rule: "EQUILIBRIUM_SWEEP",
      operational_role: "Equilibrium Confirm & Vig Gate",
      sla_kind: "latency",
      sla_ms: 1000,
      sla_tens_of_ms: 100,
    });

    const missing = makeValidMinimalDoc();
    missing.ingestion = { L20_N1105: channel("--sd-theme-emerald") };
    expect(() => parseTokensTomlFromParsed(missing)).toThrow(
      /ERR_TOKEN_LEGACY_ALIAS_MISSING/,
    );

    const mismatch = makeValidMinimalDoc();
    mismatch.ingestion = { L20_N1105: channel("--sd-theme-emerald") };
    mismatch.ui = {
      surface_card: {
        token_name: "--sd-surface-card",
        hex: "#0b1120",
        role: "surface",
        description: "cards",
      },
    };
    mismatch.aliases = {
      legacy: { "--sd-theme-emerald": "--sd-surface-card" },
    };
    expect(() => parseTokensTomlFromParsed(mismatch)).toThrow(
      /ERR_TOKEN_LEGACY_ALIAS_MISMATCH/,
    );

    const valid = makeValidMinimalDoc();
    valid.ingestion = { L20_N1105: channel("--sd-theme-emerald") };
    valid.aliases = { legacy: { "--sd-theme-emerald": "--sd-tier-gateway" } };
    expect(() => parseTokensTomlFromParsed(valid)).not.toThrow();
  });

  it("rejects unknown sla_kind", () => {
    expect(() =>
      parseTokensTomlFromParsed({
        meta: { version: "0" },
        surfaces: {},
        ingestion: {
          x: {
            layer_id: "L1.N1",
            token_name: "--t",
            hex: "#000000",
            channel_code: "Internet",
            signal_tier: "S",
            transport_uri: "u",
            channel_status: "ACTIVE",
            volume_rule: "v",
            operational_role: "o",
            sla_kind: "bogus",
          },
        },
        routes: {},
      }),
    ).toThrow(/unknown sla_kind/);
  });

  it("rejects unknown threshold_kind", () => {
    expect(() =>
      parseTokensTomlFromParsed({
        meta: { version: "0" },
        surfaces: {},
        ingestion: {},
        routes: {
          x: {
            layer_id: "L25.N1",
            token_name: "--t",
            hex: "#000000",
            route_name: "r",
            move_flag: "STEAM_CONVERGENCE",
            trigger_kind: "ADVERSE_SELECTION",
            mitigation_kind: "DYNAMIC_REPRICE",
            operational_role: "o",
            threshold_kind: "not_a_kind",
          },
        },
      }),
    ).toThrow(/unknown threshold_kind/);
  });

  it("rejects invalid ui role", () => {
    expect(() =>
      parseTokensTomlFromParsed({
        meta: { version: "0" },
        surfaces: {},
        ingestion: {},
        routes: {},
        ui: {
          x: {
            token_name: "--t",
            hex: "#000000",
            role: "glow",
            description: "d",
          },
        },
      }),
    ).toThrow(/role must be surface/);
  });

  it("rejects unbranded IEEE-754 floats in gates/routes/ingestion", () => {
    const doc = makeValidMinimalDoc();
    (doc.gates as Record<string, unknown>).min_body_contrast_ratio_milli = 4.5;
    expect(() => parseTokensTomlFromParsed(doc)).toThrow(
      /ERR_SPEC_FLOAT_THRESHOLD_FORBIDDEN/,
    );
  });

  it("rejects non-bijective keymap bitmasks and key collisions", () => {
    const badMaskDoc = makeValidMinimalDoc();
    (
      badMaskDoc.keymap as Record<string, Record<string, unknown>>
    ).M01!.bit_mask = 999;
    expect(() => parseTokensTomlFromParsed(badMaskDoc)).toThrow(
      /ERR_A11Y_FOCUS_TRAP_LOOP/,
    );

    const collisionDoc = makeValidMinimalDoc();
    (
      collisionDoc.keymap as Record<string, Record<string, unknown>>
    ).M02!.keycap = "1";
    expect(() => parseTokensTomlFromParsed(collisionDoc)).toThrow(
      /ERR_SPEC_KEYMAP_COLLISION/,
    );
  });
});
