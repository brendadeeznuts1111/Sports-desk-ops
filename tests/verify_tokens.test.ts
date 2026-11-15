/**
 * @file tests/verify_tokens.test.ts
 * @description Formal Specification & Invariant Verification Suite for Qwen3.5-4B Tokens (v1.3.0).
 */

import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  INGESTION_CHANNELS,
  ROUTE_CIRCUITS,
  TELEMETRY_SURFACES,
  ALL_QWEN_TOKENS,
  UI_TOKENS,
  SLA_STATES,
  SLA_CSS_TOKENS,
  TOKEN_GATES,
  SOURCE_BRIDGE_IDS,
  BET_LEG_BIT_POSITIONS,
  BET_LEG_BITMASKS,
  UI_STATE_BIT_POSITIONS,
  UI_STATE_BITMASKS,
  OPERATOR_KEYMAP,
  CHANNEL_META_PACKED32_COL,
  KEYMAP_SLOTS,
  packChannelHandle32 as packGeneratedChannelHandle32,
  parseAsColorHexInt,
  parseAsCents,
  parseAsBasisPoints,
  type BitSet32,
} from "../design/domain-branded-types.ts";
import {
  packChannelHandle32,
  unpackChannelHandle32,
} from "../lib/nsh_frame_schema.ts";
import {
  assertUniqueTokenColors,
  evaluatePerceptualDistances,
  evaluateWcagContrast,
  hexToRgb,
  rgbToLab,
  calculateDeltaE00,
  calculateContrastRatio,
  type TokenEntry,
} from "../lib/validation/token_validator.ts";

const rootDir = resolve(import.meta.dir, "..");

interface KeymapEntry {
  slot_index: number;
  bit_mask: number;
  key_code: string;
  keycap: string;
  forensic_mode: number;
}

export function assertBijectiveKeymapAndNoFloats(
  doc: Record<string, unknown>,
): void {
  // 1. Reject unbranded IEEE-754 floats anywhere in routes/gates/ingestion
  const scanNoFloats = (node: unknown, path: string): void => {
    if (typeof node === "number" && !Number.isInteger(node)) {
      throw new Error(`ERR_SPEC_FLOAT_THRESHOLD_FORBIDDEN: ${path}=${node}`);
    }
    if (node !== null && typeof node === "object") {
      for (const [key, val] of Object.entries(
        node as Record<string, unknown>,
      )) {
        scanNoFloats(val, `${path}.${key}`);
      }
    }
  };
  scanNoFloats(doc.gates, "gates");
  scanNoFloats(doc.ingestion, "ingestion");
  scanNoFloats(doc.routes, "routes");

  // 2. Assert 10-key bijection and unsigned 32-bit single-bit exclusivity
  const keymap = Object.values(doc.keymap as Record<string, KeymapEntry>);
  expect(keymap.length).toBe(10);

  let unionMask32 = 0;
  const seenKeys = new Uint8Array(256);
  const seenModes = new Uint16Array(16);

  for (let entryIndex = 0; entryIndex < keymap.length; entryIndex++) {
    const slot = keymap[entryIndex]!;
    const expectedMask = (1 << slot.slot_index) >>> 0;
    if (
      slot.slot_index < 0 ||
      slot.slot_index > 9 ||
      slot.bit_mask !== expectedMask
    ) {
      throw new Error("ERR_A11Y_FOCUS_TRAP_LOOP");
    }
    if ((unionMask32 & expectedMask) !== 0) {
      throw new Error("ERR_A11Y_FOCUS_TRAP_LOOP");
    }
    unionMask32 = (unionMask32 | expectedMask) >>> 0;

    const charCode = slot.keycap.charCodeAt(0);
    if (seenKeys[charCode] !== 0 || seenModes[slot.forensic_mode] !== 0) {
      throw new Error("ERR_SPEC_KEYMAP_COLLISION");
    }
    seenKeys[charCode] = 1;
    seenModes[slot.forensic_mode] = 1;
  }
  expect(unionMask32).toBe(0x03ff); // all 10 slots [0..9] populated with zero gaps
}

describe("1. Single Source of Truth & Zero-Drift Regeneration", () => {
  it("test_assert_tokens_toml_is_valid_and_complete", async () => {
    const tomlPath = resolve(rootDir, "design/tokens.toml");
    const tomlText = await Bun.file(tomlPath).text();
    const { parseTokensToml } =
      await import("../lib/gen_tokens/tokens_ssot.ts");
    const ssot = parseTokensToml(tomlText);

    expect(ssot.meta.version).toBe("1.3.0");
    expect(ssot.meta.schema).toBe("sportsdesk-tokens/v1");

    const surfaces = ssot.surfaces;
    const ingestion = ssot.ingestion;
    const routes = ssot.routes;

    expect(surfaces.length).toBe(TELEMETRY_SURFACES.length);
    expect(ingestion.length).toBe(INGESTION_CHANNELS.length);
    expect(routes.length).toBe(ROUTE_CIRCUITS.length);
    expect(surfaces.length + ingestion.length + routes.length).toBe(
      ALL_QWEN_TOKENS.length,
    );
    expect(ssot.ui.length).toBe(UI_TOKENS.length);
    expect(ssot.sla.length).toBe(SLA_STATES.length);
    expect(ssot.keymap.length).toBe(OPERATOR_KEYMAP.length);
  });

  it("test_assert_bijective_keymap_and_no_floats_contract", async () => {
    const tomlPath = resolve(rootDir, "design/tokens.toml");
    const tomlText = await Bun.file(tomlPath).text();
    const rawDoc = Bun.TOML.parse(tomlText) as Record<string, unknown>;

    assertBijectiveKeymapAndNoFloats(rawDoc);

    // Negative test 1: IEEE-754 float in routes/gates/ingestion throws
    const floatDoc = structuredClone(rawDoc);
    (
      floatDoc.routes as Record<string, Record<string, unknown>>
    ).L26_N3104!.tau_star = 0.68;
    expect(() => assertBijectiveKeymapAndNoFloats(floatDoc)).toThrow(
      /ERR_SPEC_FLOAT_THRESHOLD_FORBIDDEN/,
    );

    // Negative test 2: bit_mask mismatch or out-of-range slot_index throws ERR_A11Y_FOCUS_TRAP_LOOP
    const badMaskDoc = structuredClone(rawDoc);
    (badMaskDoc.keymap as Record<string, KeymapEntry>).M02!.bit_mask = 99;
    expect(() => assertBijectiveKeymapAndNoFloats(badMaskDoc)).toThrow(
      /ERR_A11Y_FOCUS_TRAP_LOOP/,
    );

    // Negative test 3: duplicate keycap or forensic_mode throws ERR_SPEC_KEYMAP_COLLISION
    const dupKeyDoc = structuredClone(rawDoc);
    (dupKeyDoc.keymap as Record<string, KeymapEntry>).M02!.keycap = "1";
    expect(() => assertBijectiveKeymapAndNoFloats(dupKeyDoc)).toThrow(
      /ERR_SPEC_KEYMAP_COLLISION/,
    );
  });

  it("test_assert_zero_drift_between_tokens_toml_and_source_code", async () => {
    const tomlPath = resolve(rootDir, "design/tokens.toml");
    const tomlText = await Bun.file(tomlPath).text();
    const { parseTokensToml } =
      await import("../lib/gen_tokens/tokens_ssot.ts");
    const ssot = parseTokensToml(tomlText);

    const ingestionList = ssot.ingestion;
    const routeList = ssot.routes;
    const surfaceList = ssot.surfaces;

    // Verify all 11 ingestion channels match tokens.toml byte-for-byte
    for (const item of ingestionList) {
      const match = INGESTION_CHANNELS.find((c) => c.layerId === item.layer_id);
      expect(match).toBeDefined();
      expect(match!.channelId).toBe(item.channel_id);
      expect<number>(match!.sourceBridgeId).toBe(item.source_bridge_id);
      expect(match!.canonicalProvenance).toBe(item.canonical_provenance);
      expect(match!.hex).toBe(item.hex);
      expect(match!.tokenName).toBe(item.token_name);
      expect<string | undefined>(match!.legacyTokenName).toBe(
        item.legacy_token_name,
      );
      expect(match!.legacyWireHex).toBe(item.legacy_wire_hex);
      expect(match!.slaTensOfMs).toBe(item.sla_tens_of_ms);
      expect(match!.wireAliases).toEqual(item.wire_aliases);
      expect(String(match!.channelCode)).toBe(item.channel_code);
      if (item.sla_kind === "latency") {
        expect(match!.sla.kind).toBe("latency");
        if (match!.sla.kind === "latency" && item.sla_kind === "latency") {
          expect(match!.sla.latencySlaMs).toBe(item.sla_ms);
        }
      } else {
        expect(match!.sla.kind).toBe("sentinel_drop");
      }
    }

    // Verify all 4 routes match tokens.toml
    for (const item of routeList) {
      const match = ROUTE_CIRCUITS.find((r) => r.layerId === item.layer_id);
      expect(match).toBeDefined();
      expect(match!.routeId).toBe(item.route_id);
      expect(match!.hex).toBe(item.hex);
      expect(match!.tokenName).toBe(item.token_name);
      expect(String(match!.moveFlag)).toBe(item.move_flag);
      expect(String(match!.triggerKind)).toBe(item.trigger_kind);
      expect(String(match!.threshold.kind)).toBe(item.threshold_kind);
      expect(String(match!.mitigationKind)).toBe(item.mitigation_kind);
    }

    // Verify all 2 surfaces match tokens.toml
    for (const item of surfaceList) {
      const match = TELEMETRY_SURFACES.find((s) => s.layerId === item.layer_id);
      expect(match).toBeDefined();
      expect(match!.hex).toBe(item.hex);
      expect(match!.tokenName).toBe(item.token_name);
      expect(match!.targetViewport).toBe(item.viewport);
      expect(match!.colorDepth).toBe(item.color_depth);
    }

    // Verify cross-section [tokens] parity + legacy aliases
    expect(ssot.tokens["sd-surface-card"]).toBe("#0b1120");
    expect(ssot.tokens["sd-surface-panel"]).toBe(
      ssot.tokens["sd-surface-card"],
    );
    expect(ssot.tokens["sd-surface-border"]).toBe("#243247");
    expect(ssot.tokens["sd-border-default"]).toBe(
      ssot.tokens["sd-surface-border"],
    );
    expect(ssot.tokens["sd-theme-emerald"]).toBe("#22d39a");

    for (const u of ssot.ui) {
      const bare = u.token_name.replace(/^--/, "");
      expect(ssot.tokens[bare]).toBe(u.hex);
    }
    for (const s of ssot.surfaces) {
      const bare = s.token_name.replace(/^--/, "");
      expect(ssot.tokens[bare]).toBe(s.hex);
    }
  });
});

describe("2. Color Uniqueness & CIEDE2000 Perceptual Evaluation", () => {
  const tokenEntries: TokenEntry[] = ALL_QWEN_TOKENS.map((t) => ({
    layerId: t.layerId,
    tokenName: t.tokenName,
    hex: t.hex,
  }));

  it("test_assert_zero_color_collisions_across_all_tokens", () => {
    expect(() => assertUniqueTokenColors(tokenEntries)).not.toThrow();

    const uniqueHexInts = new Set(
      tokenEntries.map((t) => parseAsColorHexInt(t.hex)),
    );
    expect(uniqueHexInts.size).toBe(tokenEntries.length);
  });

  it("test_perceptual_distance_ciede2000_pairwise_evaluation", () => {
    const { pairwiseComparisons, violations } = evaluatePerceptualDistances(
      tokenEntries,
      7.0,
    );

    // No un-justified perceptual collisions allowed
    expect(violations).toEqual([]);

    // Audit documented intentional continuum pairs
    const pairMap = new Map(
      pairwiseComparisons.map((p) => [`${p.tokenA}:${p.tokenB}`, p.deltaE]),
    );

    function getDistance(a: string, b: string): number {
      const k1 = `${a}:${b}`;
      const k2 = `${b}:${a}`;
      return (pairMap.get(k1) ?? pairMap.get(k2))!;
    }

    // 1. Alert (#ff7878) vs Manager (#ff758f)
    const alertManagerDE = getDistance("--sd-tier-alert", "--sd-route-manager");
    expect(alertManagerDE).toBeGreaterThanOrEqual(7.0);
    expect(alertManagerDE).toBeCloseTo(7.4, 1);

    // 2. Steam (#f59e0b) vs Pending Breaker (#fb923c)
    const steamPendingDE = getDistance("--sd-tier-steam", "--sd-route-pending");
    expect(steamPendingDE).toBeGreaterThanOrEqual(7.0);
    expect(steamPendingDE).toBeCloseTo(9.43, 1);

    // 3. Rec Bias (#7dd3fc) vs Devig (#22d3ee)
    const recDevigDE = getDistance("--sd-tier-rec-bias", "--sd-route-devig");
    expect(recDevigDE).toBeGreaterThanOrEqual(7.0);
    expect(recDevigDE).toBeCloseTo(9.11, 1);

    // 4. Gateway (#22d39a) vs Whale (#4ade80)
    const gatewayWhaleDE = getDistance("--sd-tier-gateway", "--sd-tier-whale");
    expect(gatewayWhaleDE).toBeGreaterThanOrEqual(7.0);
    expect(gatewayWhaleDE).toBeCloseTo(7.78, 1);

    // 5. Blocked Sentinel (#8fa3bf) vs Stage 1 Drop (#94a3b8)
    const blockedDropDE = getDistance("--sd-tier-blocked", "--sd-tier-drop");
    expect(blockedDropDE).toBeCloseTo(2.45, 1);

    // 6. Live CWS In-Play (#67e8f9) vs Devig Consensus (#22d3ee)
    const liveCwsDevigDE = getDistance(
      "--sd-tier-live-cws",
      "--sd-route-devig",
    );
    expect(liveCwsDevigDE).toBeCloseTo(6.05, 1);
  });
});

describe("3. WCAG 2.1 Contrast & Cross-State Perceptual Gates Against All Surfaces", () => {
  const tokenEntries: TokenEntry[] = ALL_QWEN_TOKENS.map((t) => ({
    layerId: t.layerId,
    tokenName: t.tokenName,
    hex: t.hex,
  }));

  const surfaceEntries: TokenEntry[] = TELEMETRY_SURFACES.map((s) => ({
    layerId: s.layerId,
    tokenName: s.tokenName,
    hex: s.hex,
  }));

  const allDashboardSurfaces = [
    ...TELEMETRY_SURFACES.map((s) => ({ tokenName: s.tokenName, hex: s.hex })),
    ...UI_TOKENS.filter((t) => t.role === "surface").map((t) => ({
      tokenName: t.tokenName,
      hex: t.hex,
    })),
  ];

  it("test_assert_all_ui_tokens_satisfy_wcag_ui_contrast_ratio_3_to_1", () => {
    const { contrastScores, violations } = evaluateWcagContrast(
      tokenEntries,
      surfaceEntries,
    );

    expect(violations).toEqual([]);

    for (const score of contrastScores) {
      // Every token against surface-bg and surface-cli must exceed 3.0:1
      expect(score.passesWcagUiComponent).toBe(true);
      expect(score.contrastRatio).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("test_assert_high_contrast_text_readability", () => {
    const bgRgb = hexToRgb("#070b14");

    // Standard primary text must achieve AAA contrast (> 15:1)
    const primaryTextRgb = hexToRgb("#f1f5f9");
    const primaryRatio = calculateContrastRatio(primaryTextRgb, bgRgb);
    expect(primaryRatio).toBeGreaterThan(15.0);

    // Muted text must achieve AAA (> 7.0:1) on primary shell
    const mutedTextRgb = hexToRgb("#94a3b8");
    const mutedRatio = calculateContrastRatio(mutedTextRgb, bgRgb);
    expect(mutedRatio).toBeGreaterThan(7.0);

    // Upgraded Retail Cyan (#29b6f6) on dark background achieves AA text contrast (> 4.5:1)
    const retailRgb = hexToRgb("#29b6f6");
    const retailRatio = calculateContrastRatio(retailRgb, bgRgb);
    expect(retailRatio).toBeGreaterThanOrEqual(4.5);
  });

  it("test_assert_all_ingestion_and_route_channels_meet_aa_across_all_surfaces", () => {
    const minBodyContrast = TOKEN_GATES.minBodyContrastRatioMilli / 1000;
    const channelAndRouteTokens = [...INGESTION_CHANNELS, ...ROUTE_CIRCUITS];
    const failures: string[] = [];

    for (const surface of allDashboardSurfaces) {
      const bg = hexToRgb(surface.hex);
      for (const tok of channelAndRouteTokens) {
        const ratio = calculateContrastRatio(hexToRgb(tok.hex), bg);
        if (ratio < minBodyContrast) {
          failures.push(
            `${tok.tokenName} (${tok.hex}) on ${surface.tokenName} (${surface.hex}) = ${ratio.toFixed(2)}:1 < ${minBodyContrast}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("test_assert_muted_slate_aaa_and_interactive_non_text_contrast", () => {
    const minAaa = TOKEN_GATES.minAaaSlateContrastMilli / 1000;
    const minBody = TOKEN_GATES.minBodyContrastRatioMilli / 1000;
    const minUi = TOKEN_GATES.minUiComponentContrastMilli / 1000;

    const surfaceCard = UI_TOKENS.find(
      (u) => u.tokenName === "--sd-surface-card",
    )!;
    const textMuted = UI_TOKENS.find((u) => u.tokenName === "--sd-text-muted")!;
    const borderStrong = UI_TOKENS.find(
      (u) => u.tokenName === "--sd-border-strong",
    )!;
    const focusRing = UI_TOKENS.find((u) => u.tokenName === "--sd-focus-ring")!;

    expect(
      calculateContrastRatio(
        hexToRgb(textMuted.hex),
        hexToRgb(surfaceCard.hex),
      ),
    ).toBeGreaterThanOrEqual(minAaa);

    for (const surface of allDashboardSurfaces) {
      const bg = hexToRgb(surface.hex);
      expect(
        calculateContrastRatio(hexToRgb(textMuted.hex), bg),
      ).toBeGreaterThanOrEqual(minBody);
      expect(
        calculateContrastRatio(hexToRgb(borderStrong.hex), bg),
      ).toBeGreaterThanOrEqual(minUi);
      expect(
        calculateContrastRatio(hexToRgb(focusRing.hex), bg),
      ).toBeGreaterThanOrEqual(minUi);
    }
  });

  it("test_assert_cross_state_surface_and_dual_clock_sla_separation", () => {
    const minCrossState = TOKEN_GATES.minCrossStateDeltaE00Milli / 1000;
    const minFreshStale = TOKEN_GATES.minFreshVsStaleDeltaE00Milli / 1000;
    const minBody = TOKEN_GATES.minBodyContrastRatioMilli / 1000;
    const minUi = TOKEN_GATES.minUiComponentContrastMilli / 1000;

    const card = UI_TOKENS.find((u) => u.tokenName === "--sd-surface-card")!;
    const hover = UI_TOKENS.find((u) => u.tokenName === "--sd-surface-hover")!;
    const selected = UI_TOKENS.find(
      (u) => u.tokenName === "--sd-surface-selected",
    )!;

    expect(
      calculateDeltaE00(
        rgbToLab(hexToRgb(card.hex)),
        rgbToLab(hexToRgb(hover.hex)),
      ),
    ).toBeGreaterThanOrEqual(minCrossState);

    expect(
      calculateDeltaE00(
        rgbToLab(hexToRgb(hover.hex)),
        rgbToLab(hexToRgb(selected.hex)),
      ),
    ).toBeGreaterThanOrEqual(minCrossState);

    expect(SLA_STATES).toHaveLength(4);
    const fresh = SLA_STATES.find((s) => s.stateId === "SLA_FRESH")!;
    const stale = SLA_STATES.find((s) => s.stateId === "SLA_STALE")!;

    expect(
      calculateDeltaE00(
        rgbToLab(hexToRgb(fresh.borderHex)),
        rgbToLab(hexToRgb(stale.borderHex)),
      ),
    ).toBeGreaterThanOrEqual(minFreshStale);

    for (const state of SLA_STATES) {
      expect(
        calculateContrastRatio(hexToRgb(state.fgHex), hexToRgb(state.bgHex)),
      ).toBeGreaterThanOrEqual(minBody);
      for (const surface of allDashboardSurfaces) {
        expect(
          calculateContrastRatio(
            hexToRgb(state.borderHex),
            hexToRgb(surface.hex),
          ),
        ).toBeGreaterThanOrEqual(minUi);
      }
    }
  });
});

describe("4. Discriminated Union Type Guardrails & Router Packing Alignment", () => {
  it("test_assert_blocked_and_drop_sentinels_use_sentinel_drop_kind_not_zero_ms", () => {
    for (const layerId of ["L17.N0000", "L19.N0518"]) {
      const sentinel = INGESTION_CHANNELS.find((c) => c.layerId === layerId)!;
      expect(sentinel).toBeDefined();
      expect(sentinel.sla.kind).toBe("sentinel_drop");
      expect(sentinel.slaTensOfMs).toBe(0);
      expect(sentinel.sla).not.toHaveProperty("latencySlaMs");
    }
  });

  it("test_assert_latency_channels_use_latency_kind_with_positive_ms", () => {
    const latencyChannels = INGESTION_CHANNELS.filter(
      (c) => c.sla.kind === "latency",
    );
    expect(latencyChannels.length).toBe(9);

    for (const c of latencyChannels) {
      if (c.sla.kind === "latency") {
        expect(typeof c.sla.latencySlaMs).toBe("number");
        expect(Number.isInteger(c.sla.latencySlaMs)).toBe(true);
        expect(c.sla.latencySlaMs).toBeGreaterThan(0);
        expect(c.sla.latencySlaMs).toBe(c.slaTensOfMs * 10);
      }
    }
  });

  it("test_assert_axis_2_routes_use_discriminated_threshold_and_typed_predicates", () => {
    const r25 = ROUTE_CIRCUITS.find((r) => r.layerId === "L25.N1882")!;
    expect(r25.routeId).toBe(0);
    expect(r25.threshold.kind).toBe("consensus_lag");
    if (r25.threshold.kind === "consensus_lag") {
      expect(r25.threshold.maxLagMs).toBe(5000);
    }
    expect(r25.triggerKind).toBe("ADVERSE_SELECTION");
    expect(r25.mitigationKind).toBe("DYNAMIC_REPRICE");

    const r26 = ROUTE_CIRCUITS.find((r) => r.layerId === "L26.N3104")!;
    expect(r26.routeId).toBe(1);
    expect(r26.threshold.kind).toBe("bayes_shrinkage");
    if (r26.threshold.kind === "bayes_shrinkage") {
      expect(r26.threshold.tauStarBasisPoints).toBe(
        parseAsBasisPoints(6800, true),
      );
      expect("tauStar" in r26.threshold).toBe(false);
      expect(r26.threshold.minTickets).toBe(8);
    }
    expect(r26.triggerKind).toBe("CLV_MARGIN_DECAY");
    expect(r26.mitigationKind).toBe("SHRINKAGE_RECALIBRATE");

    const r27 = ROUTE_CIRCUITS.find((r) => r.layerId === "L27.N0912")!;
    expect(r27.routeId).toBe(2);
    expect(r27.threshold.kind).toBe("liquidity_depth");
    if (r27.threshold.kind === "liquidity_depth") {
      expect(r27.threshold.minDepthCents).toBe(parseAsCents(100000));
    }
    expect(r27.triggerKind).toBe("ORDER_BOOK_EXHAUSTION");
    expect(r27.mitigationKind).toBe("CIRCUIT_BREAKER_HALT");

    const r28 = ROUTE_CIRCUITS.find((r) => r.layerId === "L28.N2501")!;
    expect(r28.routeId).toBe(3);
    expect(r28.threshold.kind).toBe("composite_risk_gate");
    if (r28.threshold.kind === "composite_risk_gate") {
      expect(r28.threshold.minToxicityScore).toBe(80);
      expect(r28.threshold.maxHoldRateBasisPoints).toBe(
        parseAsBasisPoints(-5000, true),
      );
      expect(r28.threshold.maxDeficitCents).toBe(parseAsCents(10000000));
    }
    expect(r28.triggerKind).toBe("TERMINAL_DEFICIT_ESCALATION");
    expect(r28.mitigationKind).toBe("MANAGER_LIMIT_CLAMP");
  });

  it("test_assert_axis_3_surfaces_specify_coherent_viewports_and_protocols", () => {
    const dom = TELEMETRY_SURFACES.find((s) => s.layerId === "SURFACE.DOM")!;
    expect(dom.protocol).toContain("DOM");
    expect(dom.colorDepth).toBe("24-bit TrueColor RGB");

    const cli = TELEMETRY_SURFACES.find((s) => s.layerId === "SURFACE.CLI")!;
    expect(cli.targetViewport).toContain("DirectColor VT");
    expect(cli.protocol).toContain("ANSI 24-bit TrueColor");
    expect(cli.colorDepth).toBe("24-bit TrueColor RGB");
  });

  it("test_assert_router_packing_and_bitset32_contracts", () => {
    const validBridgeIds = new Set<number>(Object.values(SOURCE_BRIDGE_IDS));
    const sampleRowIndex = 0x12345;

    for (const channel of INGESTION_CHANNELS) {
      expect(validBridgeIds.has(channel.sourceBridgeId)).toBe(true);
      const packed = packChannelHandle32(
        channel.channelId,
        channel.slaTensOfMs,
        sampleRowIndex,
      );
      const unpacked = unpackChannelHandle32(packed);
      expect(unpacked.channelId).toBe(channel.channelId);
      expect(unpacked.slaDivide10Ms).toBe(channel.slaTensOfMs);
      expect(unpacked.rowIndex).toBe(sampleRowIndex);
    }

    for (const [k, bit] of Object.entries(BET_LEG_BIT_POSITIONS)) {
      expect(Number.isInteger(bit)).toBe(true);
      expect(bit).toBeGreaterThanOrEqual(0);
      expect(bit).toBeLessThanOrEqual(30);
      expect(BET_LEG_BITMASKS[k as keyof typeof BET_LEG_BITMASKS]).toBe(
        ((1 << bit) >>> 0) as BitSet32,
      );
    }

    for (const [k, bit] of Object.entries(UI_STATE_BIT_POSITIONS)) {
      expect(Number.isInteger(bit)).toBe(true);
      expect(bit).toBeGreaterThanOrEqual(0);
      expect(bit).toBeLessThanOrEqual(30);
      expect(UI_STATE_BITMASKS[k as keyof typeof UI_STATE_BITMASKS]).toBe(
        ((1 << bit) >>> 0) as BitSet32,
      );
    }

    expect(UI_STATE_BITMASKS.STALE_SNAPSHOT_POISON_BIT).toBe(
      0x40000000 as BitSet32,
    );
    expect(OPERATOR_KEYMAP).toHaveLength(10);
  });
});

const DASHBOARD_FILES = [
  "static/customer-churn-simulation-dashboard.html",
  "static/telegram-miniapp-dashboard.html",
] as const;

const DASHBOARD_TOKENS = [...ALL_QWEN_TOKENS, ...UI_TOKENS, ...SLA_CSS_TOKENS];

interface DashboardCustomProperties {
  readonly file: string;
  readonly initialValues: ReadonlyMap<string, string>;
  readonly rootValues: ReadonlyMap<string, string>;
}

async function readDashboardCustomProperties(
  file: string,
): Promise<DashboardCustomProperties> {
  const html = await Bun.file(resolve(rootDir, file)).text();

  const initialValues = new Map<string, string>();
  for (const m of html.matchAll(
    /@property\s+(--sd-[\w-]+)\s*\{[^}]*?initial-value:\s*([^;]+);[^}]*\}/g,
  )) {
    initialValues.set(m[1]!, m[2]!.trim());
  }

  const rootValues = new Map<string, string>();
  for (const block of html.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const m of block[1]!.matchAll(/(--sd-[\w-]+)\s*:\s*([^;]+);/g)) {
      rootValues.set(m[1]!, m[2]!.trim());
    }
  }

  return { file, initialValues, rootValues };
}

function colorNumber(value: string | undefined): number | null {
  return value === undefined ? null : Bun.color(value, "number");
}

describe("5. Dead-Token & Bi-Directional Reference Consistency", () => {
  it("test_assert_every_qwen_token_is_registered_and_declared_in_root_with_matching_color", async () => {
    for (const file of DASHBOARD_FILES) {
      const { initialValues, rootValues } =
        await readDashboardCustomProperties(file);

      const actual = DASHBOARD_TOKENS.map((token) => ({
        file,
        token: token.tokenName,
        initial: colorNumber(initialValues.get(token.tokenName)),
        root: colorNumber(rootValues.get(token.tokenName)),
      }));
      const expected = DASHBOARD_TOKENS.map((token) => {
        const hex = colorNumber(token.hex);
        expect(hex).not.toBeNull();
        return { file, token: token.tokenName, initial: hex, root: hex };
      });

      expect(actual).toEqual(expected);
    }
  });

  it("test_assert_every_registered_sd_property_initial_value_equals_root_value", async () => {
    for (const file of DASHBOARD_FILES) {
      const { initialValues, rootValues } =
        await readDashboardCustomProperties(file);
      expect(initialValues.size).toBeGreaterThanOrEqual(
        DASHBOARD_TOKENS.length,
      );

      const actual = [...initialValues].map(([name, initial]) => ({
        file,
        name,
        initial: colorNumber(initial),
        root: colorNumber(rootValues.get(name)),
      }));
      const unparseable = actual.filter((p) => p.initial === null);
      expect(unparseable).toEqual([]);
      expect(actual).toEqual(actual.map((p) => ({ ...p, root: p.initial })));
    }
  });

  it("test_assert_non_token_root_properties_are_aliases_of_tokens", async () => {
    const tokenNames = new Set(DASHBOARD_TOKENS.map((t) => t.tokenName));
    for (const file of DASHBOARD_FILES) {
      const { initialValues, rootValues } =
        await readDashboardCustomProperties(file);
      expect([...initialValues.keys()].sort()).toEqual([...tokenNames].sort());

      const nonAliases = [...rootValues]
        .filter(([name]) => !tokenNames.has(name))
        .filter(([, value]) => {
          const ref = value.match(/^var\((--sd-[\w-]+)\)$/)?.[1];
          return ref === undefined || !tokenNames.has(ref);
        })
        .map(([name, value]) => `${file}: ${name}: ${value}`);
      expect(nonAliases).toEqual([]);
    }
  });

  it("test_assert_every_referenced_sd_property_is_defined", async () => {
    for (const file of DASHBOARD_FILES) {
      const html = await Bun.file(resolve(rootDir, file)).text();
      const { initialValues, rootValues } =
        await readDashboardCustomProperties(file);
      const undefinedRefs = [
        ...new Set(
          [...html.matchAll(/var\(\s*(--sd-[\w-]+)/g)].map((m) => m[1]!),
        ),
      ].filter((name) => !rootValues.has(name) && !initialValues.has(name));
      expect({ file, undefinedRefs }).toEqual({ file, undefinedRefs: [] });
    }
  });

  it("test_assert_no_raw_color_literals_outside_token_blocks", async () => {
    for (const file of DASHBOARD_FILES) {
      const html = await Bun.file(resolve(rootDir, file)).text();
      const css = [
        ...[...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!),
        ...[...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]!),
      ]
        .join("\n")
        .replace(/@property\s+--sd-[\w-]+\s*\{[^}]*\}/g, "")
        .replace(/:root\s*\{[^}]*\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const literals = [
        ...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d/g),
      ].map((m) => m[0]);
      expect({ file, literals }).toEqual({ file, literals: [] });
    }
  });

  it("test_assert_text_tokens_meet_wcag_aa_on_every_surface", () => {
    const surfaces = [
      ...TELEMETRY_SURFACES.map((s) => s.hex),
      ...UI_TOKENS.filter((t) => t.role === "surface").map((t) => t.hex),
    ];
    const failures = UI_TOKENS.filter((t) => t.role === "text").flatMap((t) =>
      surfaces
        .map((bg) => ({
          pair: `${t.tokenName} on ${bg}`,
          ratio: calculateContrastRatio(hexToRgb(t.hex), hexToRgb(bg)),
        }))
        .filter((r) => r.ratio < 4.5),
    );
    expect(failures).toEqual([]);
  });
});

describe("6. Generative Property-Based Invariant Tests", () => {
  it("test_property_ciede2000_metric_axioms", () => {
    // Generate pseudo-random RGB triplets and assert mathematical metric space axioms:
    // 1. Identity of indiscernibles: d(x, x) == 0
    // 2. Non-negativity: d(x, y) >= 0
    // 3. Symmetry: d(x, y) == d(y, x)
    for (let seed = 1; seed <= 50; seed++) {
      const r1 = (seed * 37) % 256;
      const g1 = (seed * 73) % 256;
      const b1 = (seed * 111) % 256;

      const r2 = (seed * 53) % 256;
      const g2 = (seed * 89) % 256;
      const b2 = (seed * 127) % 256;

      const lab1 = rgbToLab({ r: r1, g: g1, b: b1 });
      const lab2 = rgbToLab({ r: r2, g: g2, b: b2 });

      // Axiom 1: Identity
      const dSelf = calculateDeltaE00(lab1, lab1);
      expect(dSelf).toBeCloseTo(0.0, 5);

      // Axiom 2: Non-negativity
      const d12 = calculateDeltaE00(lab1, lab2);
      expect(d12).toBeGreaterThanOrEqual(0.0);

      // Axiom 3: Symmetry
      const d21 = calculateDeltaE00(lab2, lab1);
      expect(d12).toBeCloseTo(d21, 5);
    }
  });

  it("test_property_wcag_contrast_ratio_bounds", () => {
    // Contrast ratio mathematically bounded in [1.0, 21.0] and strictly symmetric
    for (let seed = 1; seed <= 50; seed++) {
      const r1 = (seed * 41) % 256;
      const g1 = (seed * 67) % 256;
      const b1 = (seed * 97) % 256;

      const r2 = (seed * 31) % 256;
      const g2 = (seed * 83) % 256;
      const b2 = (seed * 113) % 256;

      const c1 = { r: r1, g: g1, b: b1 };
      const c2 = { r: r2, g: g2, b: b2 };

      const ratio12 = calculateContrastRatio(c1, c2);
      const ratio21 = calculateContrastRatio(c2, c1);

      // Bounded in [1.0, 21.0]
      expect(ratio12).toBeGreaterThanOrEqual(1.0);
      expect(ratio12).toBeLessThanOrEqual(21.0);

      // Symmetry
      expect(ratio12).toBeCloseTo(ratio21, 5);

      // Identity is exactly 1.0
      expect(calculateContrastRatio(c1, c1)).toBeCloseTo(1.0, 5);
    }
  });
});

describe("7. Generated channel & keymap columns", () => {
  it("CHANNEL_META_PACKED32_COL encodes channelId + slaTensOfMs with rowIndex 0", () => {
    expect(CHANNEL_META_PACKED32_COL.length).toBe(INGESTION_CHANNELS.length);
    INGESTION_CHANNELS.forEach((channel, index) => {
      const word = CHANNEL_META_PACKED32_COL[index]!;
      const unpacked = unpackChannelHandle32(word);
      expect(unpacked.channelId4).toBe(channel.channelId);
      expect(unpacked.slaDivide10Ms8).toBe(channel.slaTensOfMs);
      expect(unpacked.rowIndex20).toBe(0);
      expect(word).toBe(
        packGeneratedChannelHandle32(channel.channelId, channel.slaTensOfMs, 0),
      );
    });
  });

  it("KEYMAP_SLOTS is the 10-slot bijection (1 << slotIndex, union 0x03ff)", () => {
    expect([...KEYMAP_SLOTS]).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
    expect([...KEYMAP_SLOTS].reduce((acc, mask) => acc | mask, 0)).toBe(0x03ff);
  });

  it("packChannelHandle32 rejects out-of-range fields", () => {
    expect(() => packGeneratedChannelHandle32(16, 0, 0)).toThrow(RangeError);
    expect(() => packGeneratedChannelHandle32(0, 256, 0)).toThrow(RangeError);
    expect(() => packGeneratedChannelHandle32(0, 0, 0x100000)).toThrow(
      RangeError,
    );
  });
});
