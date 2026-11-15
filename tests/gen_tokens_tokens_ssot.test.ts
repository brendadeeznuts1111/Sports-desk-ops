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
  it("parses production tokens.toml v1.3.0 with discriminated sla, thresholds, bridges, bitmasks, and bijective keymap", async () => {
    const tomlText = await Bun.file(
      resolve(rootDir, "design/tokens.toml"),
    ).text();
    const ssot = parseTokensToml(tomlText);

    expect(ssot.meta.version).toBe("1.3.0");
    expect(ssot.meta.schema).toBe("sportsdesk-tokens/v1");
    expect(ssot.meta.updated_at).toBe("2026-11-14T20:15:00Z");
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
