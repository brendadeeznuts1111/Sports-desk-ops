import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_API,
  DASHBOARD_DEFAULT_TAB,
  DASHBOARD_FRESHNESS,
  DASHBOARD_LEAGUES,
  DASHBOARD_META,
  DASHBOARD_PANELS,
  DASHBOARD_THRESHOLDS,
  dashboardApiUrl,
} from "../packages/ui/src/config/dashboard.ts";
import {
  DASHBOARD_TAB_IDS,
  DASHBOARD_TAB_SPECS,
  isDashboardTabId,
  isWagerSortField,
  resolveDashboardTabId,
} from "../packages/ui/src/types.ts";
import { buildEnhancedDashboard } from "../scripts/build_dashboard.ts";
import {
  clvEdgeTone,
  WAGER_ALERT_TIERS,
  WAGER_SPORT_FILTERS,
  WAGERS_DEFAULTS,
  WAGERS_META,
  WAGERS_TABLE,
  WAGERS_THRESHOLDS,
} from "../packages/ui/src/config/wagers.ts";
import {
  checkSchema,
  checkWagersSchema,
  findTemporal,
  hasKeyDeep,
  temporalType,
  validateDashboardConfig,
} from "../scripts/validate_dashboard_config.ts";

describe("dashboard.toml SSOT & Temporal-free contract", () => {
  test("committed packages/ui/src/config/dashboard.toml passes Temporal and schema checks", async () => {
    const text = await Bun.file(
      resolve(process.cwd(), "packages/ui/src/config/dashboard.toml"),
    ).text();
    const parsed = Bun.TOML.parse(text);
    expect(findTemporal(parsed)).toEqual([]);
    expect(checkSchema(parsed, "dashboard.toml")).toEqual([]);

    expect(DASHBOARD_META.schema).toBe("sportsdesk-dashboard/v2");
    expect(DASHBOARD_META.auto_execute).toBe(false);
    expect(DASHBOARD_THRESHOLDS.sharp).toBe(70);
    expect(DASHBOARD_THRESHOLDS.elite_sharp_score).toBeGreaterThan(
      DASHBOARD_THRESHOLDS.sharp_score,
    );
    expect(DASHBOARD_LEAGUES.names).toContain("NFL");
    expect(DASHBOARD_LEAGUES.primary.length).toBeGreaterThan(0);
    expect(DASHBOARD_FRESHNESS.critical_after_minutes).toBeGreaterThan(
      DASHBOARD_FRESHNESS.stale_after_minutes,
    );
    expect(DASHBOARD_PANELS.dns_cache_capacity).toBe(256);
    expect(DASHBOARD_PANELS.dns_warm_hit_rate_pct).toBeGreaterThan(
      DASHBOARD_PANELS.dns_active_hit_rate_pct,
    );
  });

  test("recognises Temporal datetimes and rejects unquoted TOML dates", () => {
    const instantDoc = Bun.TOML.parse("d = 2026-11-14T00:00:00Z") as {
      d: unknown;
    };
    expect(temporalType(instantDoc.d)).toBe("Instant");

    const plainDateDoc = Bun.TOML.parse("d = 2026-11-14") as { d: unknown };
    expect(temporalType(plainDateDoc.d)).toBe("PlainDate");
    expect(temporalType("2026-11-14T00:00:00Z")).toBeNull();

    const nested = Bun.TOML.parse("[meta]\ngenerated_at = 2026-11-14");
    const found = findTemporal(nested);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("$.meta.generated_at");
  });

  test("hasKeyDeep locates keys across nested tables and arrays", () => {
    expect(hasKeyDeep({ a: [{ sharp: 70 }] }, "sharp")).toBe(true);
    expect(hasKeyDeep({ a: [{ sharp: 70 }] }, "churn")).toBe(false);
  });

  test("checkSchema enforces meta.auto_execute, origin-only api.base, freshness ordering, and panel bounds", () => {
    expect(
      checkSchema({ meta: { auto_execute: true } }, "d.toml").some((i) =>
        i.message.includes("auto_execute"),
      ),
    ).toBe(true);

    expect(
      checkSchema({ api: { base: "http://x.test/api" } }, "d.toml").some((i) =>
        i.message.includes("origin"),
      ),
    ).toBe(true);

    expect(
      checkSchema({ api: { tiers: "api/config/tiers" } }, "d.toml").some((i) =>
        i.message.includes("api.tiers"),
      ),
    ).toBe(true);

    expect(
      checkSchema(
        {
          freshness: {
            stale_after_minutes: 60,
            critical_after_minutes: 30,
          },
        },
        "d.toml",
      ).some((i) => i.message.includes("critical_after_minutes")),
    ).toBe(true);

    expect(
      checkSchema(
        {
          panels: {
            dns_warm_hit_rate_pct: 40,
            dns_active_hit_rate_pct: 60,
          },
        },
        "d.toml",
      ).some((i) => i.message.includes("dns_warm_hit_rate_pct")),
    ).toBe(true);

    expect(
      checkSchema({ panels: { default_tab: "nonexistent" } }, "d.toml").some(
        (i) => i.message.includes("panels.default_tab"),
      ),
    ).toBe(true);
  });

  test("dashboardApiUrl resolves same-origin paths and loopback ?apiBase overrides safely", () => {
    expect(DASHBOARD_API.base).toBe("");
    expect(dashboardApiUrl("/api/wagers", "")).toBe("/api/wagers");
    expect(dashboardApiUrl("/api/wagers", "http://127.0.0.1:4021")).toBe(
      "http://127.0.0.1:4021/api/wagers",
    );

    (globalThis as { location?: unknown }).location = {
      search: "?apiBase=http://127.0.0.1:9999",
    };
    try {
      expect(dashboardApiUrl("/api/wagers")).toBe(
        "http://127.0.0.1:9999/api/wagers",
      );
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }

    (globalThis as { location?: unknown }).location = {
      search: "?apiBase=https://evil.example",
    };
    try {
      expect(dashboardApiUrl("/api/wagers")).toBe("/api/wagers");
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });

  test("tree-shakes unimported [churn] table while inlining thresholds.sharp in bundled JS", async () => {
    const outdir = mkdtempSync(join(tmpdir(), "sd-dash-toml-validate-"));
    try {
      await buildEnhancedDashboard({
        target: "prod",
        outdir,
        minify: true,
      });
      await validateDashboardConfig(outdir);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});

describe("wagers.toml — Live Wagers tab policy SSOT", () => {
  test("committed wagers.toml is Temporal-free and passes its own schema", async () => {
    const text = await Bun.file(
      resolve(process.cwd(), "packages/ui/src/config/wagers.toml"),
    ).text();
    const parsed = Bun.TOML.parse(text);
    expect(findTemporal(parsed)).toEqual([]);
    expect(checkWagersSchema(parsed, "wagers.toml")).toEqual([]);
    expect(hasKeyDeep(parsed, "dead_marker")).toBe(true);

    expect(WAGERS_META.schema).toBe("sportsdesk-wagers-tab/v1");
    expect(WAGERS_META.auto_execute).toBe(false);
    expect(WAGERS_THRESHOLDS.clv_hot_cents).toBeGreaterThan(
      WAGERS_THRESHOLDS.clv_warm_cents,
    );
    expect(WAGERS_TABLE.max_rows).toBeGreaterThan(0);
    expect(WAGERS_DEFAULTS.sort_field).toBe("alertTier");
    expect(WAGERS_DEFAULTS.sort_dir).toBe("desc");
    expect(WAGER_SPORT_FILTERS[0]?.id).toBe("ALL");
    expect(WAGER_ALERT_TIERS.map((t) => t.id)).toEqual([
      "CRITICAL",
      "STEAM",
      "LATENCY",
      "RECREATIONAL",
    ]);
  });

  test("checkWagersSchema rejects a drifting CLV ramp, bad bounds and duplicate filter ids", () => {
    const base = {
      meta: {
        auto_execute: false,
        generated_at: "2026-11-14T00:00:00Z",
      },
      thresholds: {
        clv_hot_cents: 10,
        clv_warm_cents: 3,
        slice_leader_limit: 4,
      },
      table: {
        max_rows: 100,
        policy_tag: "wagers-policy/v1",
        default_sort_field: "alertTier",
        default_sort_dir: "desc",
      },
      alert_tiers: [
        { id: "CRITICAL", label: "Critical", severity: 2 },
        { id: "STEAM", label: "Steam", severity: 1 },
      ],
      sport_filters: [{ id: "ALL", label: "All Sports" }],
      bet_type_filters: [{ id: "ALL", label: "All Bet Types" }],
      period_filters: [{ id: "", label: "All Periods" }],
    };
    expect(checkWagersSchema(base, "w.toml")).toEqual([]);

    expect(
      checkWagersSchema(
        { ...base, thresholds: { ...base.thresholds, clv_hot_cents: 3 } },
        "w.toml",
      ).some((i) => i.message.includes("clv_hot_cents")),
    ).toBe(true);

    expect(
      checkWagersSchema(
        { ...base, thresholds: { ...base.thresholds, slice_leader_limit: 0 } },
        "w.toml",
      ).some((i) => i.message.includes("slice_leader_limit")),
    ).toBe(true);

    expect(
      checkWagersSchema(
        { ...base, table: { ...base.table, max_rows: 0 } },
        "w.toml",
      ).some((i) => i.message.includes("max_rows")),
    ).toBe(true);

    expect(
      checkWagersSchema(
        { ...base, table: { ...base.table, default_sort_field: "volume" } },
        "w.toml",
      ).some((i) => i.message.includes("default_sort_field")),
    ).toBe(true);

    expect(
      checkWagersSchema(
        {
          ...base,
          sport_filters: [
            { id: "ALL", label: "All" },
            { id: "ALL", label: "Again" },
          ],
        },
        "w.toml",
      ).some((i) => i.message.includes("duplicated")),
    ).toBe(true);

    expect(
      checkWagersSchema(
        {
          ...base,
          alert_tiers: [
            { id: "STEAM", label: "Steam", severity: 1 },
            { id: "CRITICAL", label: "Critical", severity: 2 },
          ],
        },
        "w.toml",
      ).some((i) => i.message.includes("strictly descend")),
    ).toBe(true);

    expect(checkWagersSchema({}, "w.toml")).toHaveLength(7);
  });

  test("CLV ramp thresholds drive the tone helper used by the table and inspector", () => {
    const { clv_hot_cents, clv_warm_cents } = WAGERS_THRESHOLDS;
    expect(clvEdgeTone(clv_hot_cents)).toBe("#ef4444");
    expect(clvEdgeTone(clv_hot_cents - 1)).toBe("#f59e0b");
    expect(clvEdgeTone(clv_warm_cents - 1)).toBe("#f59e0b");
    expect(clvEdgeTone(0)).toBe("#4ade80");
    expect(clvEdgeTone(-2)).toBe("#4ade80");
  });
});

describe("DashboardTabId registry & sort guards", () => {
  test("DASHBOARD_TAB_SPECS covers every canonical DashboardTabId with disjoint aliases", () => {
    expect(Object.keys(DASHBOARD_TAB_SPECS).sort()).toEqual(
      [...DASHBOARD_TAB_IDS].sort(),
    );

    const seenAliases = new Set<string>();
    for (const id of DASHBOARD_TAB_IDS) {
      expect(isDashboardTabId(id)).toBe(true);
      const spec = DASHBOARD_TAB_SPECS[id];
      expect(spec.id).toBe(id);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.shortcut).toMatch(/^Ctrl\+\d$/);
      for (const alias of spec.aliases) {
        expect(isDashboardTabId(alias)).toBe(false);
        expect(seenAliases.has(alias)).toBe(false);
        seenAliases.add(alias);
      }
    }
    expect(isDashboardTabId("nonexistent")).toBe(false);
    expect(isDashboardTabId(null)).toBe(false);
  });

  test("resolveDashboardTabId normalizes canonical IDs, #hash slugs, legacy aliases, and fallbacks", () => {
    expect(resolveDashboardTabId("wagers")).toBe("wagers");
    expect(resolveDashboardTabId("  #SHADOW  ")).toBe("shadow");
    expect(resolveDashboardTabId("#/bet-ticker")).toBe("bet-ticker");
    expect(resolveDashboardTabId("profiles")).toBe("customers");
    expect(resolveDashboardTabId("#shadow-pricing")).toBe("shadow");
    expect(resolveDashboardTabId("telemetry")).toBe("surveillance");
    expect(resolveDashboardTabId("unknown-tab", "r2")).toBe("r2");
    expect(resolveDashboardTabId("", "alerts")).toBe("alerts");
    expect(resolveDashboardTabId(undefined)).toBe("customers");
    expect(DASHBOARD_DEFAULT_TAB).toBe(
      resolveDashboardTabId(DASHBOARD_PANELS.default_tab),
    );
    expect(isWagerSortField("alertTier")).toBe(true);
    expect(isWagerSortField("volume")).toBe(false);
  });
});
