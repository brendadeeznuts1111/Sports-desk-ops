/**
 * @file packages/ui/src/ShadowPricingPanel.tsx
 * @description Interactive 4-Axis Hierarchical Taxonomy Cube (Sport -> SubSport -> Period per SubSport -> Market)
 * & Point-Buy Shadow-Pricing / Retail Elasticity Simulator (#135).
 *
 * Uses `import type` exclusively for shared contracts so `bun:sqlite` stays strictly server-only.
 * Styled with specification-grade CSS Houdini tokens from `./tokens.generated.css`.
 */

import React, { useCallback, useEffect, useState } from "react";
import type {
  MarketCode,
  MarketFilter,
  PeriodCode,
  PeriodFilter,
  RouterAuditMode,
  ShadowPricingDashboardPayload,
  ShadowRepriceMode,
  SportCode,
  SportFilter,
  SubSportCode,
  SubSportFilter,
  TaxonomyRollupRow,
} from "@sportsdesk-ops/contracts/shadow-pricing";
import {
  debugDashboardTrace,
  resolveSliceMetricsFeatureDefault,
} from "./runtime_flags.ts";
import {
  type CubeTab,
  type QuickSlicePreset,
  ShadowLadderControlsSection,
  ShadowSimulationTablesSection,
  ShadowTaxonomyCubeSection,
} from "./shadow_pricing/index.tsx";
import { SliceMetricsViews } from "./SliceMetricsViews.tsx";

export interface ShadowPricingPanelProps {
  readonly onInspectAccount?: ((accountId: string) => void) | undefined;
  readonly onRunPtyCommand?: ((command: string) => void) | undefined;
  readonly initialPayload?: ShadowPricingDashboardPayload | null | undefined;
}

function readInitialUrlParam(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const val = new URLSearchParams(window.location.search).get(key);
  return val && val.trim() !== "" ? val.trim() : fallback;
}

export function ShadowPricingPanel({
  onInspectAccount,
  onRunPtyCommand,
  initialPayload,
}: ShadowPricingPanelProps): React.ReactElement {
  // 4-Level Hierarchical Taxonomy Filters
  const [sport, setSport] = useState<SportFilter>(
    () =>
      initialPayload?.taxonomy.activeFilters.sport ??
      (readInitialUrlParam("sport", "ALL") as SportFilter),
  );
  const [subSport, setSubSport] = useState<SubSportFilter>(
    () =>
      initialPayload?.taxonomy.activeFilters.subSport ??
      (readInitialUrlParam("subSport", "ALL") as SubSportFilter),
  );
  const [period, setPeriod] = useState<PeriodFilter>(
    () =>
      initialPayload?.taxonomy.activeFilters.period ??
      (readInitialUrlParam("period", "ALL") as PeriodFilter),
  );
  const [market, setMarket] = useState<MarketFilter>(
    () =>
      initialPayload?.taxonomy.activeFilters.market ??
      (readInitialUrlParam("market", "ALL") as MarketFilter),
  );
  const [cubeTab, setCubeTab] = useState<CubeTab>("sport");

  // Shadow-Pricing Counterfactual Parameters
  const [ladderKey3, setLadderKey3] = useState<number>(-140);
  const [ladderKey7, setLadderKey7] = useState<number>(-135);
  const [ladderKey14_21, setLadderKey14_21] = useState<number>(-128);
  const [minVolume, setMinVolume] = useState<number>(15);
  const [retailElasticity, setRetailElasticity] = useState<number>(0.15);
  const [repriceMode, setRepriceMode] = useState<ShadowRepriceMode>("floor");
  const [routerAuditMode, setRouterAuditMode] =
    useState<RouterAuditMode>("observed_ledger");
  const [sliceMetricsEnabled, setSliceMetricsEnabled] = useState<boolean>(() =>
    resolveSliceMetricsFeatureDefault(),
  );

  const [payload, setPayload] = useState<ShadowPricingDashboardPayload | null>(
    initialPayload ?? null,
  );
  const [loading, setLoading] = useState<boolean>(initialPayload == null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedCli, setCopiedCli] = useState<boolean>(false);

  // Sync active 4-level slice to URL query string for deep-linking
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (sport === "ALL") url.searchParams.delete("sport");
    else url.searchParams.set("sport", sport);

    if (subSport === "ALL") url.searchParams.delete("subSport");
    else url.searchParams.set("subSport", subSport);

    if (period === "ALL") url.searchParams.delete("period");
    else url.searchParams.set("period", period);

    if (market === "ALL") url.searchParams.delete("market");
    else url.searchParams.set("market", market);

    window.history.replaceState({}, "", url.toString());
  }, [sport, subSport, period, market]);

  const fetchSimulation = useCallback(
    async (params: {
      sport: SportFilter;
      subSport: SubSportFilter;
      period: PeriodFilter;
      market: MarketFilter;
      ladderKey3: number;
      ladderKey7: number;
      ladderKey14_21: number;
      minVolume: number;
      retailElasticity: number;
      repriceMode: ShadowRepriceMode;
      routerAuditMode: RouterAuditMode;
    }) => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const qs = new URLSearchParams({
          sport: params.sport,
          subSport: params.subSport,
          period: params.period,
          market: params.market,
          ladder3: String(params.ladderKey3),
          ladder7: String(params.ladderKey7),
          ladderOther: String(params.ladderKey14_21),
          minVolume: String(params.minVolume),
          elasticity: String(params.retailElasticity),
          mode: params.repriceMode,
          routerAudit: params.routerAuditMode,
        });
        const res = await fetch(`/api/shadow-pricing?${qs.toString()}`);
        if (!res.ok) {
          const errJson = (await res
            .json()
            .catch(() => ({ error: res.statusText }))) as { error?: string };
          throw new Error(
            `GET /api/shadow-pricing returned ${res.status}: ${errJson.error ?? res.statusText}`,
          );
        }
        const json = (await res.json()) as ShadowPricingDashboardPayload;
        debugDashboardTrace("shadow-pricing taxonomy slice evaluated", {
          provenance: json.provenance,
          evaluatedInMs: json.evaluatedInMs,
          slice: json.taxonomy.activeSlice.breadcrumb,
        });

        // If server normalized an invalid period for the newly chosen SubSport, sync client state cleanly
        if (
          json.taxonomy.activeFilters.periodNormalizedFromInvalid &&
          params.period !== "ALL"
        ) {
          setPeriod("ALL");
        }
        setPayload(json);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchSimulation({
        sport,
        subSport,
        period,
        market,
        ladderKey3,
        ladderKey7,
        ladderKey14_21,
        minVolume,
        retailElasticity,
        repriceMode,
        routerAuditMode,
      });
    }, 80);
    return () => clearTimeout(timer);
  }, [
    sport,
    subSport,
    period,
    market,
    ladderKey3,
    ladderKey7,
    ladderKey14_21,
    minVolume,
    retailElasticity,
    repriceMode,
    routerAuditMode,
    fetchSimulation,
  ]);

  const handleSelectSport = (nextSport: SportFilter) => {
    setSport(nextSport);
    setSubSport("ALL");
    setPeriod("ALL");
    if (nextSport !== "ALL") {
      setCubeTab("subSport");
    }
  };

  const handleSelectSubSport = (nextSub: SubSportFilter) => {
    setSubSport(nextSub);
    if (nextSub === "ALL") {
      setPeriod("ALL");
      return;
    }
    if (payload) {
      const spec = payload.taxonomy.catalog.find((c) => c.code === nextSub);
      if (spec) {
        setSport(spec.sport);
        if (
          period !== "ALL" &&
          !spec.validPeriods.some((vp) => vp.code === period)
        ) {
          setPeriod("ALL");
        }
      }
      setCubeTab("period");
    }
  };

  const handleDrillRow = (row: TaxonomyRollupRow) => {
    if (row.dimension === "sport") {
      handleSelectSport(row.code as SportCode);
    } else if (row.dimension === "subSport") {
      handleSelectSubSport(row.code as SubSportCode);
    } else if (row.dimension === "period") {
      setPeriod(row.code as PeriodCode);
      setCubeTab("market");
    } else if (row.dimension === "market") {
      setMarket(row.code as MarketCode);
    }
  };

  const applyLadder = (k3: number, k7: number, k14_21: number) => {
    setLadderKey3(k3);
    setLadderKey7(k7);
    setLadderKey14_21(k14_21);
  };

  const applyQuickPreset = (qp: QuickSlicePreset) => {
    setSport(qp.sport);
    setSubSport(qp.subSport);
    setPeriod(qp.period);
    setMarket(qp.market);
    setCubeTab(qp.cubeTab);
  };

  const resetSlice = () => {
    setSport("ALL");
    setSubSport("ALL");
    setPeriod("ALL");
    setMarket("ALL");
    setCubeTab("sport");
  };

  const jumpToSimulatorSlice = (
    nextSport: SportFilter,
    nextSubSport: SubSportFilter,
  ) => {
    setSport(nextSport);
    setSubSport(nextSubSport);
    setPeriod("game");
    setMarket("spread");
  };

  const hasAnyDimensionFilter =
    sport !== "ALL" ||
    subSport !== "ALL" ||
    period !== "ALL" ||
    market !== "ALL";

  const cliCommand = `./bin/dx shadow-price --ladder-3=${ladderKey3} --ladder-7=${ladderKey7} --ladder-other=${ladderKey14_21} --min-volume=${minVolume} --elasticity=${retailElasticity.toFixed(2)}`;

  const copyCli = () => {
    void navigator.clipboard?.writeText(cliCommand);
    setCopiedCli(true);
    setTimeout(() => setCopiedCli(false), 1600);
  };

  const tax = payload?.taxonomy;
  const activeSlice = tax?.activeSlice;
  const sim = payload?.simulation;
  const isBlockedSlice =
    activeSlice?.pointBuyPolicy === "STRICTLY_BLOCKED" &&
    sim?.summary.totalAnalyzedLegs === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Top Signal Honesty & Provenance Header */}
      <div
        className="sd-card"
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "17px" }}>
              ⚖️ Multi-Sport Taxonomy Cube &amp; Shadow-Pricing Engine (#135)
            </h2>
            {payload ? (
              <span
                className={`sd-pill ${payload.provenance === "live_db" ? "sd-pill-live" : "sd-pill-fixture"}`}
              >
                {payload.provenance === "live_db"
                  ? `● LIVE DB (${payload.sourceLabel})`
                  : `◐ FIXTURE CORPUS (${payload.sourceLabel})`}
              </span>
            ) : null}
            {payload ? (
              <span className="sd-pill sd-mono">
                ⚡ Arena eval: {payload.evaluatedInMs}ms
                {loading ? " (updating…)" : ""}
              </span>
            ) : null}
          </div>
          <div
            style={{
              marginTop: "6px",
              fontSize: "12px",
              color: "var(--sd-text-muted)",
            }}
          >
            Slices settled handle, hold %, point-buy eligibility, and
            counterfactual ladders across{" "}
            <strong>Sport ▸ Sub-Sport ▸ Period (per Sub-Sport) ▸ Market</strong>
            .
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="sd-preset-btn sd-mono"
            data-active={sliceMetricsEnabled ? "true" : "false"}
            onClick={() => setSliceMetricsEnabled((prev) => !prev)}
            title="Feature flag gate for Typed SliceMetrics SoA DataTable + Blended Hold SLO + Pre/Post-Trade DiffView"
          >
            {sliceMetricsEnabled
              ? "🧬 SliceMetrics V2: ON"
              : "🧬 SliceMetrics V2: OFF"}
          </button>
          <button
            type="button"
            className="sd-preset-btn sd-mono"
            onClick={copyCli}
            title={cliCommand}
          >
            {copiedCli ? "✅ Copied dx CLI" : "📋 Copy ./bin/dx shadow-price"}
          </button>
          {onRunPtyCommand ? (
            <button
              type="button"
              className="sd-preset-btn"
              onClick={() => onRunPtyCommand("key-numbers")}
            >
              💻 Inspect Key Buyers in PTY
            </button>
          ) : null}
        </div>
      </div>

      {errorMsg ? (
        <div
          className="sd-card"
          style={{
            borderColor: "var(--sd-tier-alert)",
            color: "var(--sd-tier-alert)",
            fontSize: "13px",
          }}
        >
          <strong>Shadow-Pricing API Error:</strong> {errorMsg}
        </div>
      ) : null}

      <ShadowTaxonomyCubeSection
        taxonomy={tax}
        sport={sport}
        subSport={subSport}
        period={period}
        market={market}
        cubeTab={cubeTab}
        hasAnyDimensionFilter={hasAnyDimensionFilter}
        onSelectSport={handleSelectSport}
        onSelectSubSport={handleSelectSubSport}
        onSelectPeriod={setPeriod}
        onSelectMarket={setMarket}
        onSelectCubeTab={setCubeTab}
        onApplyQuickPreset={applyQuickPreset}
        onResetSlice={resetSlice}
        onDrillRow={handleDrillRow}
      />

      {/* Feature-Gated Typed SliceMetrics SoA DataTable + Blended Hold SLO + Pre/Post-Trade DiffView */}
      {sliceMetricsEnabled && payload?.sliceMetrics ? (
        <SliceMetricsViews
          bundle={payload.sliceMetrics}
          routerAuditMode={routerAuditMode}
          onChangeRouterAuditMode={setRouterAuditMode}
        />
      ) : null}

      {/* Conditional Point-Buy Simulator vs Catalog Lockout Notice */}
      {sim && payload && activeSlice ? (
        <>
          <ShadowLadderControlsSection
            payload={payload}
            ladderKey3={ladderKey3}
            ladderKey7={ladderKey7}
            ladderKey14_21={ladderKey14_21}
            minVolume={minVolume}
            retailElasticity={retailElasticity}
            repriceMode={repriceMode}
            onSetLadder={applyLadder}
            onChangeLadderKey3={setLadderKey3}
            onChangeLadderKey7={setLadderKey7}
            onChangeLadderKey14_21={setLadderKey14_21}
            onChangeRetailElasticity={setRetailElasticity}
            onChangeMinVolume={setMinVolume}
            onChangeRepriceMode={setRepriceMode}
            onJumpToSimulatorSlice={jumpToSimulatorSlice}
          />
          {isBlockedSlice ? null : (
            <ShadowSimulationTablesSection
              payload={payload}
              retailElasticity={retailElasticity}
              minVolume={minVolume}
              onApplyPresetLadder={applyLadder}
              onInspectAccount={onInspectAccount}
            />
          )}
        </>
      ) : (
        <div
          className="sd-card"
          style={{ textAlign: "center", padding: "36px" }}
        >
          Loading multi-sport taxonomy cube &amp; point-buy arena…
        </div>
      )}
    </div>
  );
}
