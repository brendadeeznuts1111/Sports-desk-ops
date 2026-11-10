/**
 * @file src/dashboard/ShadowPricingPanel.tsx
 * @description Interactive 4-Axis Hierarchical Taxonomy Cube (Sport -> SubSport -> Period per SubSport -> Market)
 * & Point-Buy Shadow-Pricing / Retail Elasticity Simulator (#135).
 *
 * Uses `import type` exclusively for shared contracts so `bun:sqlite` stays strictly server-only.
 * Styled with specification-grade CSS Houdini tokens from `./tokens.generated.css`.
 */

import React, { useCallback, useEffect, useState } from "react";
import type {
  ElasticityFrontierPoint,
  MarketCode,
  MarketFilter,
  PeriodCode,
  PeriodFilter,
  PointBuyPolicy,
  ShadowPricingDashboardPayload,
  ShadowRepriceMode,
  SportCode,
  SportFilter,
  SubSportCode,
  SubSportFilter,
  TaxonomyRiskStatus,
  TaxonomyRollupRow,
} from "../../types/shadow_pricing.ts";
import { debugDashboardTrace } from "./runtime_flags.ts";

export interface ShadowPricingPanelProps {
  readonly onInspectAccount?: (accountId: string) => void;
  readonly onRunPtyCommand?: (command: string) => void;
}

type CubeTab = "sport" | "subSport" | "period" | "market";

function formatSignedUsd(val: number): string {
  const abs = Math.abs(Math.round(val)).toLocaleString();
  if (val > 0) return `+$${abs}`;
  if (val < 0) return `-$${abs}`;
  return "$0";
}

function formatUsd(val: number): string {
  const abs = Math.abs(Math.round(val)).toLocaleString();
  return val < 0 ? `-$${abs}` : `$${abs}`;
}

function formatCompactLegs(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const SPORT_ICONS: Readonly<Record<SportCode, string>> = {
  Football: "🏈",
  Basketball: "🏀",
  Hockey: "🏒",
  Baseball: "⚾",
  Soccer: "⚽",
  LIVE: "⚡",
  Other: "🎾",
};

const CLIENT_PRESETS = [
  {
    id: "retail_flat",
    label: "Flat Retail Catalog",
    subtitle: "-120 / -120 / -120 baseline",
    ladderKey3: -120,
    ladderKey7: -120,
    ladderKey14_21: -120,
  },
  {
    id: "indifference",
    label: "Indifference Breakeven",
    subtitle: "0.0% EV (-138 / -132 / -123)",
    ladderKey3: -138,
    ladderKey7: -132,
    ladderKey14_21: -123,
  },
  {
    id: "shadow_default",
    label: "Calibrated Shadow",
    subtitle: "dx shadow-price (-140 / -135 / -128)",
    ladderKey3: -140,
    ladderKey7: -135,
    ladderKey14_21: -128,
  },
  {
    id: "house_hold",
    label: "Standard House Hold",
    subtitle: "~4.5% hold (-150 / -142 / -130)",
    ladderKey3: -150,
    ladderKey7: -142,
    ladderKey14_21: -130,
  },
] as const;

const QUICK_SLICE_PRESETS: readonly {
  readonly label: string;
  readonly sport: SportFilter;
  readonly subSport: SubSportFilter;
  readonly period: PeriodFilter;
  readonly market: MarketFilter;
  readonly cubeTab: CubeTab;
}[] = [
  {
    label: "🌐 Full Book",
    sport: "ALL",
    subSport: "ALL",
    period: "ALL",
    market: "ALL",
    cubeTab: "sport",
  },
  {
    label: "🏈 NFL P0 Spread (Key Leak)",
    sport: "Football",
    subSport: "NFL",
    period: "game",
    market: "spread",
    cubeTab: "period",
  },
  {
    label: "🏟️ CFB P0 Spread (Key Leak)",
    sport: "Football",
    subSport: "NCAAF",
    period: "game",
    market: "spread",
    cubeTab: "period",
  },
  {
    label: "🏀 NBA P0 Spread (Desk Edge)",
    sport: "Basketball",
    subSport: "NBA",
    period: "game",
    market: "spread",
    cubeTab: "period",
  },
  {
    label: "🎓 NCAAB (20m Halves Only)",
    sport: "Basketball",
    subSport: "NCAAB",
    period: "ALL",
    market: "ALL",
    cubeTab: "period",
  },
  {
    label: "🏒 NHL (60m / OT / P1–P3)",
    sport: "Hockey",
    subSport: "NHL",
    period: "ALL",
    market: "ALL",
    cubeTab: "period",
  },
  {
    label: "⚾ MLB (9 Inn / F5 / Inning)",
    sport: "Baseball",
    subSport: "MLB",
    period: "ALL",
    market: "ALL",
    cubeTab: "period",
  },
  {
    label: "⚡ LIVE #9000 (In-Play Lockout)",
    sport: "LIVE",
    subSport: "ALL",
    period: "game",
    market: "ALL",
    cubeTab: "subSport",
  },
];

function renderPolicyBadge(policy: PointBuyPolicy): React.ReactElement {
  if (policy === "KEY_LEAK_EXPOSED") {
    return (
      <span className="sd-pill sd-pill-alert">🔴 KEY-NUMBER LEAK EXPOSED</span>
    );
  }
  if (policy === "HOUSE_HOLD_ADVANTAGE") {
    return (
      <span className="sd-pill sd-pill-live">🟢 HOUSE HOLD ADVANTAGE</span>
    );
  }
  return <span className="sd-pill sd-pill-blocked">🔒 POINT BUYS BLOCKED</span>;
}

function renderRiskBadge(status: TaxonomyRiskStatus): React.ReactElement {
  if (status === "CRITICAL_LEAK") {
    return <span className="sd-pill sd-pill-alert">CRITICAL LEAK</span>;
  }
  if (status === "SEVERE_LEAK") {
    return <span className="sd-pill sd-pill-fixture">KEY EXPOSED</span>;
  }
  if (status === "DESK_ADVANTAGE") {
    return <span className="sd-pill sd-pill-live">DESK EDGE (+6.5¢)</span>;
  }
  if (status === "POSITIVE_HOLD") {
    return <span className="sd-pill sd-pill-live">POSITIVE HOLD</span>;
  }
  return <span className="sd-pill sd-pill-blocked">IMMUNE / LOCKED</span>;
}

function renderElasticityChart(
  points: readonly ElasticityFrontierPoint[],
  selectedElasticity: number,
  breakevenPct: number | null,
): React.ReactElement {
  const width = 620;
  const height = 220;
  const padL = 66;
  const padR = 24;
  const padT = 22;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  if (points.length === 0) {
    return <div style={{ color: "var(--sd-text-muted)" }}>No curve data</div>;
  }

  let minY = 0;
  let maxY = 0;
  for (const pt of points) {
    minY = Math.min(
      minY,
      pt.netDeskSavingsUsd,
      pt.sharpSavingsUsd,
      pt.retailNetImpactUsd,
    );
    maxY = Math.max(
      maxY,
      pt.netDeskSavingsUsd,
      pt.sharpSavingsUsd,
      pt.retailNetImpactUsd,
    );
  }
  const span = Math.max(1000, maxY - minY);
  minY -= span * 0.1;
  maxY += span * 0.1;

  const xOf = (elasticity: number) =>
    padL + (Math.min(0.4, Math.max(0, elasticity)) / 0.4) * plotW;
  const yOf = (usd: number) =>
    padT + (1 - (usd - minY) / (maxY - minY)) * plotH;

  const buildPath = (pick: (p: ElasticityFrontierPoint) => number) =>
    points
      .map(
        (p, idx) =>
          `${idx === 0 ? "M" : "L"}${xOf(p.elasticity).toFixed(1)},${yOf(pick(p)).toFixed(1)}`,
      )
      .join(" ");

  const zeroY = yOf(0);
  const markerX = xOf(selectedElasticity);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label="Retail Turnover Elasticity vs Net Desk Savings Frontier"
    >
      <line
        x1={padL}
        y1={zeroY}
        x2={width - padR}
        y2={zeroY}
        stroke="var(--sd-surface-border)"
        strokeWidth="1.5"
        strokeDasharray="4 4"
      />
      <text
        x={padL - 8}
        y={zeroY + 4}
        textAnchor="end"
        fill="var(--sd-text-muted)"
        fontSize="10"
      >
        $0
      </text>
      <text
        x={padL - 8}
        y={padT + 8}
        textAnchor="end"
        fill="var(--sd-text-muted)"
        fontSize="10"
      >
        {formatSignedUsd(maxY)}
      </text>
      <text
        x={padL - 8}
        y={height - padB}
        textAnchor="end"
        fill="var(--sd-text-muted)"
        fontSize="10"
      >
        {formatSignedUsd(minY)}
      </text>

      <path
        d={buildPath((p) => p.sharpSavingsUsd)}
        fill="none"
        stroke="var(--sd-route-sharp)"
        strokeWidth="2"
        strokeDasharray="5 3"
      />

      <path
        d={buildPath((p) => p.retailNetImpactUsd)}
        fill="none"
        stroke="var(--sd-tier-steam)"
        strokeWidth="2"
      />

      <path
        d={buildPath((p) => p.netDeskSavingsUsd)}
        fill="none"
        stroke="var(--sd-tier-rec-bias)"
        strokeWidth="3"
      />

      <line
        x1={markerX}
        y1={padT}
        x2={markerX}
        y2={height - padB}
        stroke="var(--sd-theme-emerald)"
        strokeWidth="1.5"
      />

      {breakevenPct !== null && breakevenPct <= 40 ? (
        <g>
          <circle
            cx={xOf(breakevenPct / 100)}
            cy={zeroY}
            r="4.5"
            fill="var(--sd-tier-alert)"
          />
          <text
            x={xOf(breakevenPct / 100) + 6}
            y={zeroY - 6}
            fill="var(--sd-tier-alert)"
            fontSize="10"
            fontWeight="600"
          >
            Breakeven {breakevenPct}%
          </text>
        </g>
      ) : null}

      {[0, 0.1, 0.2, 0.3, 0.4].map((tick) => (
        <text
          key={tick}
          x={xOf(tick)}
          y={height - 10}
          textAnchor="middle"
          fill="var(--sd-text-muted)"
          fontSize="10"
        >
          {Math.round(tick * 100)}% drop
        </text>
      ))}
    </svg>
  );
}

function readInitialUrlParam(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const val = new URLSearchParams(window.location.search).get(key);
  return val && val.trim() !== "" ? val.trim() : fallback;
}

export function ShadowPricingPanel({
  onInspectAccount,
  onRunPtyCommand,
}: ShadowPricingPanelProps): React.ReactElement {
  // 4-Level Hierarchical Taxonomy Filters
  const [sport, setSport] = useState<SportFilter>(
    () => readInitialUrlParam("sport", "ALL") as SportFilter,
  );
  const [subSport, setSubSport] = useState<SubSportFilter>(
    () => readInitialUrlParam("subSport", "ALL") as SubSportFilter,
  );
  const [period, setPeriod] = useState<PeriodFilter>(
    () => readInitialUrlParam("period", "ALL") as PeriodFilter,
  );
  const [market, setMarket] = useState<MarketFilter>(
    () => readInitialUrlParam("market", "ALL") as MarketFilter,
  );
  const [cubeTab, setCubeTab] = useState<CubeTab>("sport");

  // Shadow-Pricing Counterfactual Parameters
  const [ladderKey3, setLadderKey3] = useState<number>(-140);
  const [ladderKey7, setLadderKey7] = useState<number>(-135);
  const [ladderKey14_21, setLadderKey14_21] = useState<number>(-128);
  const [minVolume, setMinVolume] = useState<number>(15);
  const [retailElasticity, setRetailElasticity] = useState<number>(0.15);
  const [repriceMode, setRepriceMode] = useState<ShadowRepriceMode>("floor");

  const [payload, setPayload] = useState<ShadowPricingDashboardPayload | null>(
    null,
  );
  const [loading, setLoading] = useState<boolean>(true);
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
    if (nextSub !== "ALL" && payload) {
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
  const netDelta = sim?.summary.netDeskSavingsUsd ?? 0;
  const sharpDelta = sim?.sharpCohort.sharpSavingsUsd ?? 0;
  const retailDelta = sim?.retailCohort.retailNetImpactUsd ?? 0;

  const activeCubeRows: readonly TaxonomyRollupRow[] = tax
    ? cubeTab === "sport"
      ? tax.bySport
      : cubeTab === "subSport"
        ? tax.bySubSport
        : cubeTab === "period"
          ? tax.byPeriod
          : tax.byMarket
    : [];

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

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
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

      {/* 4-Axis Hierarchical Selector Card: Sport -> Sub-Sport -> Period (per Sub-Sport) -> Market */}
      <div className="sd-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
            marginBottom: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <strong style={{ fontSize: "13px" }}>
              🧭 4-Axis Taxonomy Slice Selector
            </strong>
            {activeSlice ? (
              <code style={{ fontSize: "11px" }}>{activeSlice.breadcrumb}</code>
            ) : null}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {QUICK_SLICE_PRESETS.map((qp) => {
              const isPresetActive =
                sport === qp.sport &&
                subSport === qp.subSport &&
                period === qp.period &&
                market === qp.market;
              return (
                <button
                  key={qp.label}
                  type="button"
                  className="sd-dim-chip"
                  data-active={isPresetActive ? "true" : "false"}
                  onClick={() => {
                    setSport(qp.sport);
                    setSubSport(qp.subSport);
                    setPeriod(qp.period);
                    setMarket(qp.market);
                    setCubeTab(qp.cubeTab);
                  }}
                >
                  {qp.label}
                </button>
              );
            })}
            {hasAnyDimensionFilter ? (
              <button
                type="button"
                className="sd-dim-chip"
                onClick={() => {
                  setSport("ALL");
                  setSubSport("ALL");
                  setPeriod("ALL");
                  setMarket("ALL");
                  setCubeTab("sport");
                }}
              >
                ↺ Reset Slice
              </button>
            ) : null}
          </div>
        </div>

        {/* Axis 1: Sport */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">1. Sport / Mode</div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={sport === "ALL" ? "true" : "false"}
              onClick={() => handleSelectSport("ALL")}
            >
              All Sports
            </button>
            {(tax?.bySport ?? []).map((spRow) => {
              const code = spRow.code as SportCode;
              const icon = SPORT_ICONS[code] ?? "•";
              return (
                <button
                  key={spRow.code}
                  type="button"
                  className="sd-dim-chip"
                  data-active={sport === spRow.code ? "true" : "false"}
                  onClick={() => handleSelectSport(code)}
                >
                  <span>
                    {icon} {spRow.code}
                  </span>
                  <span className="sd-dim-count sd-mono">
                    {formatCompactLegs(spRow.totalLegs)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Axis 2: Sub-Sport (scoped dynamically to Sport) */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">2. Sub-Sport</div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={subSport === "ALL" ? "true" : "false"}
              onClick={() => {
                setSubSport("ALL");
                setPeriod("ALL");
              }}
            >
              {sport === "ALL" ? "All Sub-Sports" : `All ${sport} Leagues`}
            </button>
            {(tax?.bySubSport ?? []).map((subRow) => {
              const spec = tax?.catalog.find((c) => c.code === subRow.code);
              return (
                <button
                  key={subRow.code}
                  type="button"
                  className="sd-dim-chip"
                  data-active={subSport === subRow.code ? "true" : "false"}
                  onClick={() =>
                    handleSelectSubSport(subRow.code as SubSportCode)
                  }
                  title={subRow.primaryRiskVector}
                >
                  <span>{spec?.shortLabel ?? subRow.label}</span>
                  <span className="sd-dim-count sd-mono">
                    {formatCompactLegs(subRow.totalLegs)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Axis 3: Period per Sub-Sport (dynamically scoped to validPeriods of selected Sub-Sport!) */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">
            3. Period{" "}
            <span style={{ fontWeight: 400, opacity: 0.75 }}>
              ({subSport === "ALL" ? "valid set" : subSport})
            </span>
          </div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={period === "ALL" ? "true" : "false"}
              onClick={() => setPeriod("ALL")}
            >
              All Valid Periods
            </button>
            {(activeSlice?.validPeriodsForSelection ?? []).map((vp) => {
              const pRow = tax?.byPeriod.find((r) => r.code === vp.code);
              return (
                <button
                  key={vp.code}
                  type="button"
                  className="sd-dim-chip"
                  data-active={period === vp.code ? "true" : "false"}
                  onClick={() => setPeriod(vp.code)}
                  title={
                    vp.allowsPointBuys
                      ? `${vp.label} — Portal PeriodNumber ${vp.portalPeriodNumber}: Point purchases permitted on pre-game Football/Basketball`
                      : `${vp.label} — Portal PeriodNumber ${vp.portalPeriodNumber}: Point purchases strictly blocked`
                  }
                >
                  <span>
                    {vp.allowsPointBuys ? "🟢" : "🔒"} {vp.label}
                  </span>
                  {pRow ? (
                    <span className="sd-dim-count sd-mono">
                      {formatCompactLegs(pRow.totalLegs)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Axis 4: Market */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">4. Market Type</div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={market === "ALL" ? "true" : "false"}
              onClick={() => setMarket("ALL")}
            >
              All Markets
            </button>
            {(tax?.byMarket ?? []).map((mktRow) => (
              <button
                key={mktRow.code}
                type="button"
                className="sd-dim-chip"
                data-active={market === mktRow.code ? "true" : "false"}
                onClick={() => setMarket(mktRow.code as MarketCode)}
              >
                <span>{mktRow.label}</span>
                <span className="sd-dim-count sd-mono">
                  {formatCompactLegs(mktRow.totalLegs)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Active Slice Summary Strip (All Legs + Hold % + Point-Buy Share + Risk Vector) */}
      {activeSlice ? (
        <div className="sd-card-cli">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              {renderPolicyBadge(activeSlice.pointBuyPolicy)}
              {renderRiskBadge(activeSlice.riskStatus)}
              <span
                className="sd-mono"
                style={{ fontSize: "12px", color: "var(--sd-text-primary)" }}
              >
                Slice Legs:{" "}
                <strong>{activeSlice.totalLegs.toLocaleString()}</strong> (
                {activeSlice.settledLegs.toLocaleString()} settled ·{" "}
                {activeSlice.winRatePct}% win) · Handle:{" "}
                <strong>{formatUsd(activeSlice.handleUsd)}</strong> · Actual
                Desk P&amp;L:{" "}
                <strong
                  style={{
                    color:
                      activeSlice.actualDeskPnlUsd >= 0
                        ? "var(--sd-theme-emerald)"
                        : "var(--sd-tier-alert)",
                  }}
                >
                  {formatSignedUsd(activeSlice.actualDeskPnlUsd)} (
                  {activeSlice.holdPct}% hold)
                </strong>{" "}
                · Point-Buy Share:{" "}
                <strong>
                  {activeSlice.buyLegs.toLocaleString()} legs (
                  {activeSlice.buyRatePct}%)
                </strong>
              </span>
            </div>
          </div>
          <div style={{ fontSize: "12px", color: "var(--sd-text-muted)" }}>
            <strong>Operational Risk Vector:</strong>{" "}
            {activeSlice.primaryRiskVector}
          </div>
        </div>
      ) : null}

      {/* Interactive 4-Dimension Exposure & Hold Matrix Explorer */}
      {tax ? (
        <div className="sd-card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            <strong style={{ fontSize: "13px" }}>
              📊 Hierarchical Exposure, Hold &amp; Point-Buy Matrix (Click any
              row to drill in)
            </strong>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "sport" ? "true" : "false"}
                onClick={() => setCubeTab("sport")}
              >
                1. By Sport ({tax.bySport.length})
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "subSport" ? "true" : "false"}
                onClick={() => setCubeTab("subSport")}
              >
                2. By Sub-Sport ({tax.bySubSport.length})
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "period" ? "true" : "false"}
                onClick={() => setCubeTab("period")}
              >
                3. Valid Periods ({tax.byPeriod.length})
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "market" ? "true" : "false"}
                onClick={() => setCubeTab("market")}
              >
                4. By Market ({tax.byMarket.length})
              </button>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Point-Buy Policy</th>
                  <th>Total Legs</th>
                  <th>Win %</th>
                  <th>Total Handle</th>
                  <th>Buy Legs (% Share)</th>
                  <th>Actual Desk P&amp;L</th>
                  <th>Hold %</th>
                  <th>Shadow Δ</th>
                  <th>Risk Status</th>
                </tr>
              </thead>
              <tbody>
                {activeCubeRows.map((row) => {
                  const isRowSelected =
                    (row.dimension === "sport" && sport === row.code) ||
                    (row.dimension === "subSport" && subSport === row.code) ||
                    (row.dimension === "period" && period === row.code) ||
                    (row.dimension === "market" && market === row.code);
                  return (
                    <tr
                      key={`${row.dimension}:${row.code}`}
                      className={isRowSelected ? "sd-row-active" : undefined}
                      style={{ cursor: "pointer" }}
                      onClick={() => handleDrillRow(row)}
                      title={row.primaryRiskVector}
                    >
                      <td>
                        <strong>{row.label}</strong>
                        {row.parentCode ? (
                          <span
                            style={{
                              marginLeft: "6px",
                              fontSize: "10px",
                              color: "var(--sd-text-muted)",
                            }}
                          >
                            ({row.parentCode})
                          </span>
                        ) : null}
                      </td>
                      <td>{renderPolicyBadge(row.pointBuyPolicy)}</td>
                      <td className="sd-mono">
                        {row.totalLegs.toLocaleString()}
                      </td>
                      <td className="sd-mono">{row.winRatePct.toFixed(1)}%</td>
                      <td className="sd-mono">{formatUsd(row.handleUsd)}</td>
                      <td className="sd-mono">
                        {row.buyLegs.toLocaleString()} ({row.buyRatePct}%)
                      </td>
                      <td
                        className="sd-mono"
                        style={{
                          color:
                            row.actualDeskPnlUsd >= 0
                              ? "var(--sd-theme-emerald)"
                              : "var(--sd-tier-alert)",
                        }}
                      >
                        {formatSignedUsd(row.actualDeskPnlUsd)}
                      </td>
                      <td className="sd-mono">{row.holdPct.toFixed(2)}%</td>
                      <td
                        className="sd-mono"
                        style={{
                          fontWeight: 700,
                          color:
                            row.netDeltaUsd > 0
                              ? "var(--sd-theme-emerald)"
                              : row.netDeltaUsd < 0
                                ? "var(--sd-tier-alert)"
                                : "var(--sd-text-muted)",
                        }}
                      >
                        {formatSignedUsd(row.netDeltaUsd)}
                      </td>
                      <td>{renderRiskBadge(row.riskStatus)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Conditional Point-Buy Simulator vs Catalog Lockout Notice */}
      {sim && payload && activeSlice ? (
        activeSlice.pointBuyPolicy === "STRICTLY_BLOCKED" &&
        sim.summary.totalAnalyzedLegs === 0 ? (
          <div
            className="sd-card"
            style={{
              borderLeft: "4px solid var(--sd-tier-blocked)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
                marginBottom: "8px",
              }}
            >
              <strong style={{ fontSize: "14px" }}>
                🔒 {payload.policyRecommendation.headline}
              </strong>
              <span className="sd-pill sd-pill-blocked sd-mono">
                {payload.policyRecommendation.directive} · 0 Point-Buy Legs
              </span>
            </div>
            <p
              style={{
                margin: "0 0 12px",
                fontSize: "12.5px",
                color: "var(--sd-text-muted)",
              }}
            >
              {payload.policyRecommendation.rationale}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <button
                type="button"
                className="sd-preset-btn"
                onClick={() => {
                  setSport("Football");
                  setSubSport("NFL");
                  setPeriod("game");
                  setMarket("spread");
                }}
              >
                🏈 Jump to NFL P0 Spread (Key Leak Simulator)
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                onClick={() => {
                  setSport("Football");
                  setSubSport("NCAAF");
                  setPeriod("game");
                  setMarket("spread");
                }}
              >
                🏟️ Jump to College FB P0 Spread
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                onClick={() => {
                  setSport("Basketball");
                  setSubSport("NBA");
                  setPeriod("game");
                  setMarket("spread");
                }}
              >
                🏀 Jump to NBA P0 Spread (House Vig Edge)
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Calibrated Ladder Presets + Interactive Sliders */}
            <div className="sd-card">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: "14px",
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {CLIENT_PRESETS.map((preset) => {
                    const active =
                      ladderKey3 === preset.ladderKey3 &&
                      ladderKey7 === preset.ladderKey7 &&
                      ladderKey14_21 === preset.ladderKey14_21;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className="sd-preset-btn"
                        data-active={active ? "true" : "false"}
                        onClick={() => {
                          setLadderKey3(preset.ladderKey3);
                          setLadderKey7(preset.ladderKey7);
                          setLadderKey14_21(preset.ladderKey14_21);
                        }}
                      >
                        <div>{preset.label}</div>
                        <div
                          style={{
                            fontSize: "10px",
                            opacity: 0.8,
                            fontWeight: 400,
                          }}
                        >
                          {preset.subtitle}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Reprice Mode Toggle */}
                <div
                  style={{ display: "flex", gap: "6px", alignItems: "center" }}
                >
                  <span
                    style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                    title="Price Floor preserves steeper juice (-145/-150) already paid on 1.0–1.5pt buys; Exact Ladder matches ./bin/dx shadow-price verbatim."
                  >
                    Mode:
                  </span>
                  <button
                    type="button"
                    className="sd-preset-btn"
                    data-active={repriceMode === "floor" ? "true" : "false"}
                    onClick={() => setRepriceMode("floor")}
                  >
                    🛡️ Price Floor Clamp
                  </button>
                  <button
                    type="button"
                    className="sd-preset-btn"
                    data-active={repriceMode === "exact" ? "true" : "false"}
                    onClick={() => setRepriceMode("exact")}
                  >
                    🎯 Exact CLI Override
                  </button>
                </div>
              </div>

              {/* 5 Parameter Sliders */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))",
                  gap: "14px",
                }}
              >
                <label className="sd-card-cli" style={{ display: "block" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      marginBottom: "6px",
                    }}
                  >
                    <span>Key 3 Odds (Fair: -138)</span>
                    <strong
                      className="sd-mono"
                      style={{ color: "var(--sd-tier-rec-bias)" }}
                    >
                      {ladderKey3}
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="sd-slider"
                    min={-175}
                    max={-110}
                    step={1}
                    value={ladderKey3}
                    onChange={(e) => setLadderKey3(Number(e.target.value))}
                  />
                </label>

                <label className="sd-card-cli" style={{ display: "block" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      marginBottom: "6px",
                    }}
                  >
                    <span>Key 7 Odds (Fair: -132)</span>
                    <strong
                      className="sd-mono"
                      style={{ color: "var(--sd-tier-rec-bias)" }}
                    >
                      {ladderKey7}
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="sd-slider"
                    min={-165}
                    max={-110}
                    step={1}
                    value={ladderKey7}
                    onChange={(e) => setLadderKey7(Number(e.target.value))}
                  />
                </label>

                <label className="sd-card-cli" style={{ display: "block" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      marginBottom: "6px",
                    }}
                  >
                    <span>Key 10/14/21 (Fair: -123)</span>
                    <strong
                      className="sd-mono"
                      style={{ color: "var(--sd-tier-rec-bias)" }}
                    >
                      {ladderKey14_21}
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="sd-slider"
                    min={-155}
                    max={-110}
                    step={1}
                    value={ladderKey14_21}
                    onChange={(e) => setLadderKey14_21(Number(e.target.value))}
                  />
                </label>

                <label className="sd-card-cli" style={{ display: "block" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      marginBottom: "6px",
                    }}
                  >
                    <span>Retail Elasticity Drop</span>
                    <strong
                      className="sd-mono"
                      style={{ color: "var(--sd-tier-steam)" }}
                    >
                      {Math.round(retailElasticity * 100)}%
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="sd-slider"
                    min={0}
                    max={0.4}
                    step={0.01}
                    value={retailElasticity}
                    onChange={(e) =>
                      setRetailElasticity(Number(e.target.value))
                    }
                  />
                </label>

                <label className="sd-card-cli" style={{ display: "block" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      marginBottom: "6px",
                    }}
                  >
                    <span>Sharp Min Legs</span>
                    <strong
                      className="sd-mono"
                      style={{ color: "var(--sd-route-sharp)" }}
                    >
                      {minVolume} legs
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="sd-slider"
                    min={2}
                    max={50}
                    step={1}
                    value={minVolume}
                    onChange={(e) => setMinVolume(Number(e.target.value))}
                  />
                </label>
              </div>
            </div>

            {/* 4 Headline Point-Buy Cohort KPI Cards */}
            <div className="sd-grid-4">
              <div className="sd-card">
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  SLICE POINT-BUY HANDLE
                </div>
                <div
                  className="sd-mono"
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    margin: "6px 0 4px",
                  }}
                >
                  {formatUsd(sim.summary.totalStakedUsd)}
                </div>
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  {sim.summary.totalAnalyzedLegs.toLocaleString()} buy legs ·{" "}
                  {sim.summary.totalSettledLegs.toLocaleString()} settled ·
                  Actual P&amp;L{" "}
                  <strong style={{ color: "var(--sd-theme-emerald)" }}>
                    {formatSignedUsd(sim.summary.actualDeskPnlUsd)}
                  </strong>
                </div>
              </div>

              <div className="sd-card">
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  SHARP SYNDICATE DELTA ({sim.sharpCohort.bettorCount} ACCTS)
                </div>
                <div
                  className="sd-mono"
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    margin: "6px 0 4px",
                    color:
                      sharpDelta >= 0
                        ? "var(--sd-route-sharp)"
                        : "var(--sd-tier-alert)",
                  }}
                >
                  {formatSignedUsd(sharpDelta)}
                </div>
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  {sim.sharpCohort.legCount.toLocaleString()} legs (
                  {formatUsd(sim.sharpCohort.stakedUsd)}) · Actual{" "}
                  {formatSignedUsd(sim.sharpCohort.actualDeskPnlUsd)}
                </div>
              </div>

              <div className="sd-card">
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  RETAIL ELASTICITY IMPACT (
                  {Math.round(sim.retailCohort.elasticityAssumed * 100)}% DROP)
                </div>
                <div
                  className="sd-mono"
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    margin: "6px 0 4px",
                    color:
                      retailDelta >= 0
                        ? "var(--sd-theme-emerald)"
                        : "var(--sd-tier-steam)",
                  }}
                >
                  {formatSignedUsd(retailDelta)}
                </div>
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  {sim.retailCohort.bettorCount.toLocaleString()} retail bettors
                  · {sim.retailCohort.legCount.toLocaleString()} legs (
                  {formatUsd(sim.retailCohort.stakedUsd)})
                </div>
              </div>

              <div className="sd-card">
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  NET COUNTERFACTUAL DESK DELTA
                </div>
                <div
                  className="sd-mono"
                  style={{
                    fontSize: "22px",
                    fontWeight: 700,
                    margin: "6px 0 4px",
                    color:
                      netDelta >= 0
                        ? "var(--sd-theme-emerald)"
                        : "var(--sd-tier-alert)",
                  }}
                >
                  {formatSignedUsd(netDelta)}
                </div>
                <div
                  style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
                >
                  Shadow P&amp;L:{" "}
                  {formatSignedUsd(sim.summary.shadowDeskPnlUsd)}{" "}
                  {payload.breakevenElasticityPct !== null
                    ? `· Breakeven @ ${payload.breakevenElasticityPct}% drop`
                    : ""}
                </div>
              </div>
            </div>

            {/* Operational Policy Directive Banner */}
            <div
              className="sd-card"
              style={{
                borderLeft: `4px solid ${
                  payload.policyRecommendation.directive ===
                  "TARGETED_LIMITS_AND_ALERTS"
                    ? "var(--sd-tier-steam)"
                    : "var(--sd-theme-emerald)"
                }`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "8px",
                  marginBottom: "4px",
                }}
              >
                <strong style={{ fontSize: "13px" }}>
                  🎯 Desk Policy Recommendation:{" "}
                  {payload.policyRecommendation.headline}
                </strong>
                <span className="sd-pill sd-pill-sharp sd-mono">
                  {payload.policyRecommendation.directive} · Max Key Risk Cap: $
                  {payload.policyRecommendation.recommendedMaxKeyRiskUsd.toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--sd-text-muted)" }}>
                {payload.policyRecommendation.rationale}
              </div>
            </div>

            {/* Two-column: Elasticity Frontier Chart + 4-Policy Comparison */}
            <div className="sd-grid-2">
              <div className="sd-card">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "8px",
                  }}
                >
                  <strong style={{ fontSize: "13px" }}>
                    📉 Retail Turnover Elasticity Frontier (0% → 40% Drop)
                  </strong>
                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      fontSize: "11px",
                      color: "var(--sd-text-muted)",
                    }}
                  >
                    <span style={{ color: "var(--sd-tier-rec-bias)" }}>
                      ━ Net Delta
                    </span>
                    <span style={{ color: "var(--sd-route-sharp)" }}>
                      ┄ Sharp Savings
                    </span>
                    <span style={{ color: "var(--sd-tier-steam)" }}>
                      ━ Retail Attrition
                    </span>
                  </div>
                </div>
                {renderElasticityChart(
                  payload.elasticityFrontier,
                  retailElasticity,
                  payload.breakevenElasticityPct,
                )}
              </div>

              <div className="sd-card">
                <strong
                  style={{
                    display: "block",
                    fontSize: "13px",
                    marginBottom: "8px",
                  }}
                >
                  🏛️ Calibrated Ladder Policy Matrix (at{" "}
                  {Math.round(retailElasticity * 100)}% Elasticity)
                </strong>
                <table>
                  <thead>
                    <tr>
                      <th>Policy Ladder</th>
                      <th>3 / 7 / 14</th>
                      <th>Sharp Δ</th>
                      <th>Retail Δ</th>
                      <th>Net Desk Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.presetComparison.map((row) => (
                      <tr
                        key={row.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => {
                          setLadderKey3(row.ladderKey3);
                          setLadderKey7(row.ladderKey7);
                          setLadderKey14_21(row.ladderKey14_21);
                        }}
                      >
                        <td>
                          <strong>{row.label}</strong>
                        </td>
                        <td className="sd-mono">
                          {row.ladderKey3} / {row.ladderKey7} /{" "}
                          {row.ladderKey14_21}
                        </td>
                        <td
                          className="sd-mono"
                          style={{
                            color:
                              row.sharpSavingsUsd >= 0
                                ? "var(--sd-route-sharp)"
                                : "var(--sd-tier-alert)",
                          }}
                        >
                          {formatSignedUsd(row.sharpSavingsUsd)}
                        </td>
                        <td
                          className="sd-mono"
                          style={{
                            color:
                              row.retailNetImpactUsd >= 0
                                ? "var(--sd-theme-emerald)"
                                : "var(--sd-tier-steam)",
                          }}
                        >
                          {formatSignedUsd(row.retailNetImpactUsd)}
                        </td>
                        <td
                          className="sd-mono"
                          style={{
                            fontWeight: 700,
                            color:
                              row.netDeskSavingsUsd >= 0
                                ? "var(--sd-theme-emerald)"
                                : "var(--sd-tier-alert)",
                          }}
                        >
                          {formatSignedUsd(row.netDeskSavingsUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Key-Number Exposure Breakdown Table */}
            <div className="sd-card">
              <strong
                style={{
                  display: "block",
                  fontSize: "13px",
                  marginBottom: "8px",
                }}
              >
                🏈 Key-Number Margin Clustering &amp; Fair Breakeven Audit
              </strong>
              <table>
                <thead>
                  <tr>
                    <th>Target Margin</th>
                    <th>Fair Breakeven</th>
                    <th>Shadow Odds</th>
                    <th>Analyzed Legs</th>
                    <th>Settled Win %</th>
                    <th>Handle (USD)</th>
                    <th>Actual Desk P&amp;L</th>
                    <th>Shadow Desk P&amp;L</th>
                    <th>Net Desk Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.keyBreakdown.map((kb) => (
                    <tr key={kb.keyLabel}>
                      <td>
                        <strong>{kb.keyLabel}</strong>
                      </td>
                      <td className="sd-mono">{kb.fairBreakevenOdds}</td>
                      <td className="sd-mono">
                        {kb.configuredShadowOdds !== null
                          ? kb.configuredShadowOdds
                          : "Unchanged"}
                      </td>
                      <td className="sd-mono">{kb.legs.toLocaleString()}</td>
                      <td className="sd-mono">{kb.winRatePct.toFixed(1)}%</td>
                      <td className="sd-mono">{formatUsd(kb.stakedUsd)}</td>
                      <td className="sd-mono">
                        {formatSignedUsd(kb.actualDeskPnlUsd)}
                      </td>
                      <td className="sd-mono">
                        {formatSignedUsd(kb.shadowDeskPnlUsd)}
                      </td>
                      <td
                        className="sd-mono"
                        style={{
                          fontWeight: 700,
                          color:
                            kb.netDeltaUsd >= 0
                              ? "var(--sd-theme-emerald)"
                              : "var(--sd-tier-alert)",
                        }}
                      >
                        {formatSignedUsd(kb.netDeltaUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Top Sharp Point-Buyers Leaderboard */}
            {sim.topSharpBuyers.length > 0 ? (
              <div className="sd-card">
                <strong
                  style={{
                    display: "block",
                    fontSize: "13px",
                    marginBottom: "8px",
                  }}
                >
                  🎯 Top Impacted Sharp Key-Number Accounts in Slice (N &gt;={" "}
                  {minVolume} &amp; Key 3/7 Rate &gt;= 40%)
                </strong>
                <table>
                  <thead>
                    <tr>
                      <th>Account ID</th>
                      <th>Buy Legs</th>
                      <th>Key 3/7 Rate</th>
                      <th>Staked (USD)</th>
                      <th>Actual Desk P&amp;L</th>
                      <th>Shadow Desk P&amp;L</th>
                      <th>Desk Improvement Δ</th>
                      <th>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.topSharpBuyers.map((buyer) => (
                      <tr key={buyer.account}>
                        <td>
                          <code>{buyer.account}</code>
                        </td>
                        <td className="sd-mono">{buyer.legs}</td>
                        <td className="sd-mono">{buyer.keyRatePct}</td>
                        <td className="sd-mono">
                          {formatUsd(buyer.stakedUsd)}
                        </td>
                        <td
                          className="sd-mono"
                          style={{
                            color:
                              buyer.actualDeskPnlUsd >= 0
                                ? "var(--sd-theme-emerald)"
                                : "var(--sd-tier-alert)",
                          }}
                        >
                          {formatSignedUsd(buyer.actualDeskPnlUsd)}
                        </td>
                        <td className="sd-mono">
                          {formatSignedUsd(buyer.shadowDeskPnlUsd)}
                        </td>
                        <td
                          className="sd-mono"
                          style={{
                            fontWeight: 700,
                            color:
                              buyer.netDeskImprovementUsd >= 0
                                ? "var(--sd-theme-emerald)"
                                : "var(--sd-tier-steam)",
                          }}
                        >
                          {formatSignedUsd(buyer.netDeskImprovementUsd)}
                        </td>
                        <td>
                          {onInspectAccount ? (
                            <button
                              type="button"
                              className="sd-preset-btn"
                              style={{ padding: "3px 8px", fontSize: "11px" }}
                              onClick={() => onInspectAccount(buyer.account)}
                            >
                              🔍 Profile
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )
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
