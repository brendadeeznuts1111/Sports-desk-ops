import { DESCRIPTIONS, FEATURES } from "@sportsdesk-ops/contracts";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { BuildMatrixRow } from "../types.ts";

export interface BuildMatrixDrawerProps {
  readonly dceMarker: string;
  readonly loading: boolean;
  readonly rows: readonly BuildMatrixRow[] | null;
  readonly target?: string | undefined;
  readonly enabledFeatures?: readonly string[] | undefined;
  readonly error?: string | null | undefined;
  readonly onRefresh?: (() => void) | undefined;
}

type TokenAxis = "all" | "surfaces" | "ingestion" | "routes";

interface HoudiniTokenSpec {
  readonly token: string;
  readonly label: string;
  readonly hex: string;
  readonly axis: Exclude<TokenAxis, "all">;
  readonly detail: string;
}

/**
 * Canonical CSS Houdini @property registry generated from `design/tokens.toml` (v1.3.0).
 */
export const HOUDINI_TOKENS: readonly HoudiniTokenSpec[] = [
  {
    token: "--sd-surface-bg",
    label: "Obsidian",
    hex: "#070b14",
    axis: "surfaces",
    detail: "SURFACE.DOM · Main DOM canvas",
  },
  {
    token: "--sd-surface-cli",
    label: "CLI",
    hex: "#04070e",
    axis: "surfaces",
    detail: "SURFACE.CLI · Deterministic dark ANSI surface",
  },
  {
    token: "--sd-surface-card",
    label: "Card",
    hex: "#0b1120",
    axis: "surfaces",
    detail: "UI surface · Cards, panels, table headers",
  },
  {
    token: "--sd-surface-elevated",
    label: "Elevated",
    hex: "#121c31",
    axis: "surfaces",
    detail: "UI surface · Elevated drawers, modals & popovers",
  },
  {
    token: "--sd-surface-hover",
    label: "Hover",
    hex: "#19263d",
    axis: "surfaces",
    detail: "UI surface · Hovered rows & cards",
  },
  {
    token: "--sd-surface-raised",
    label: "Raised",
    hex: "#202f4a",
    axis: "surfaces",
    detail: "UI surface · Raised headers & toolbar strips",
  },
  {
    token: "--sd-surface-selected",
    label: "Selected",
    hex: "#0f3a5d",
    axis: "surfaces",
    detail: "UI surface · Active BitSet32 roving tab & selected row",
  },
  {
    token: "--sd-surface-border",
    label: "Border",
    hex: "#243247",
    axis: "surfaces",
    detail: "UI border · Hairlines & dividers",
  },
  {
    token: "--sd-border-strong",
    label: "Strong Border",
    hex: "#7085a1",
    axis: "surfaces",
    detail: "UI border · Emphasized panel borders & keycaps",
  },
  {
    token: "--sd-focus-ring",
    label: "Focus Ring",
    hex: "#38bdf8",
    axis: "surfaces",
    detail: "UI focus · Keyboard roving tabindex ring",
  },
  {
    token: "--sd-focus-ring-offset",
    label: "Focus Offset",
    hex: "#070b14",
    axis: "surfaces",
    detail: "UI focus · 2px inner separation ring",
  },
  {
    token: "--sd-text-primary",
    label: "Text",
    hex: "#f1f5f9",
    axis: "surfaces",
    detail: "UI text · Primary headings & body copy",
  },
  {
    token: "--sd-text-secondary",
    label: "Secondary Text",
    hex: "#cbd5e1",
    axis: "surfaces",
    detail: "UI text · Subheadings & metric values",
  },
  {
    token: "--sd-text-muted",
    label: "Muted",
    hex: "#94a3b8",
    axis: "surfaces",
    detail: "UI text · Secondary labels & headers",
  },
  {
    token: "--sd-tier-drop",
    label: "Drop L17",
    hex: "#94a3b8",
    axis: "ingestion",
    detail: "L17.N0000 · NON_SPORTS · Stage 1 drop",
  },
  {
    token: "--sd-tier-retail",
    label: "Retail L18",
    hex: "#29b6f6",
    axis: "ingestion",
    detail: "L18.N0204 · Internet · SLA ≤1500ms",
  },
  {
    token: "--sd-tier-blocked",
    label: "Blocked L19",
    hex: "#8fa3bf",
    axis: "ingestion",
    detail: "L19.N0518 · BLOCKED · sentinel_drop",
  },
  {
    token: "--sd-tier-gateway",
    label: "Gateway L20",
    hex: "#22d39a",
    axis: "ingestion",
    detail: "L20.N1105 · GATEWAY · SLA ≤1000ms",
  },
  {
    token: "--sd-tier-alert",
    label: "Alert L21",
    hex: "#ff7878",
    axis: "ingestion",
    detail: "L21.N0884 · ALERT · SLA ≤250ms",
  },
  {
    token: "--sd-tier-steam",
    label: "Steam L22",
    hex: "#f59e0b",
    axis: "ingestion",
    detail: "L22.N1402 · GSBUILDER · SLA ≤1000ms",
  },
  {
    token: "--sd-tier-whale",
    label: "Whale L23",
    hex: "#4ade80",
    axis: "ingestion",
    detail: "L23.N0412 · GSLIVE · SLA ≤500ms",
  },
  {
    token: "--sd-tier-rec-bias",
    label: "Rec L24",
    hex: "#7dd3fc",
    axis: "ingestion",
    detail: "L24.N2019 · CSLEVEL2 · SLA ≤2000ms",
  },
  {
    token: "--sd-tier-live-cws",
    label: "Live CWS L24B",
    hex: "#67e8f9",
    axis: "ingestion",
    detail: "L24B.N2110 · LIVEBETTINGCWS · SLA ≤750ms",
  },
  {
    token: "--sd-tier-phone",
    label: "Phone L24C",
    hex: "#a5b4fc",
    axis: "ingestion",
    detail: "L24C.N2204 · PHONE · SLA ≤1500ms",
  },
  {
    token: "--sd-tier-house",
    label: "House L24D",
    hex: "#e2e8f0",
    axis: "ingestion",
    detail: "L24D.N2308 · HOUSE · SLA ≤1500ms",
  },
  {
    token: "--sd-route-pending",
    label: "Pending R01",
    hex: "#fb923c",
    axis: "routes",
    detail: "L27.N0912 · LIQUIDITY_HALT · ≥$1,000 depth",
  },
  {
    token: "--sd-route-sharp",
    label: "Sharp R02",
    hex: "#c892ff",
    axis: "routes",
    detail: "L26.N3104 · SHRINKAGE_SHARP · τ*≥6800 bps, N≥8",
  },
  {
    token: "--sd-route-manager",
    label: "Manager R03",
    hex: "#ff758f",
    axis: "routes",
    detail: "L28.N2501 · TERMINAL_ENFORCE · tox≥80",
  },
  {
    token: "--sd-route-devig",
    label: "Devig R04",
    hex: "#22d3ee",
    axis: "routes",
    detail: "L25.N1882 · STEAM_CONVERGENCE · ≤5000ms lag",
  },
];

function formatBytesDeltaVsBaseline(
  bytes: number,
  baselineBytes: number | null,
): string {
  if (baselineBytes === null || baselineBytes <= 0) return "—";
  const diff = bytes - baselineBytes;
  if (diff === 0) return "baseline";
  const kb = (diff / 1024).toFixed(1);
  const pct = ((diff / baselineBytes) * 100).toFixed(1);
  return `${diff > 0 ? "+" : ""}${kb} KB (${diff > 0 ? "+" : ""}${pct}%)`;
}

function readComputedTokenMap(): Readonly<Record<string, string>> {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof getComputedStyle !== "function"
  ) {
    return {};
  }
  const style = getComputedStyle(document.documentElement);
  const entries: [string, string][] = [];
  for (const spec of HOUDINI_TOKENS) {
    const raw = style.getPropertyValue(spec.token).trim().toLowerCase();
    if (raw) {
      entries.push([spec.token, raw]);
    }
  }
  return Object.fromEntries(entries);
}

export function BuildMatrixDrawer({
  dceMarker,
  loading,
  rows,
  target,
  enabledFeatures,
  error,
  onRefresh,
}: BuildMatrixDrawerProps): React.ReactElement {
  const [axisFilter, setAxisFilter] = useState<TokenAxis>("all");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [computedTokens, setComputedTokens] = useState<
    Readonly<Record<string, string>>
  >(() => ({}));

  useEffect(() => {
    setComputedTokens(readComputedTokenMap());
  }, []);

  const computedCount = useMemo(
    () => HOUDINI_TOKENS.filter((t) => Boolean(computedTokens[t.token])).length,
    [computedTokens],
  );

  const visibleTokens = useMemo(
    () =>
      axisFilter === "all"
        ? HOUDINI_TOKENS
        : HOUDINI_TOKENS.filter((t) => t.axis === axisFilter),
    [axisFilter],
  );

  const devBaselineBytes = useMemo(() => {
    const devRow = rows?.find((r) => r.target === "dev");
    return devRow ? devRow.totalJsBytes : null;
  }, [rows]);

  const activeFeatureSet = useMemo(() => {
    if (enabledFeatures && enabledFeatures.length > 0) {
      return new Set(enabledFeatures);
    }
    // Derive from target or marker prefix without embedding literal DCE sentinel strings
    // outside `runtime_flags.ts` `feature()` branches.
    const set = new Set<string>();
    if (target === "prod" || dceMarker.includes("_PROD_")) set.add("PROD");
    if (target === "dev" || dceMarker.includes("_DEBUG_")) set.add("DEBUG");
    if (target === "test") set.add("TEST");
    if (target === "dev" || dceMarker.includes("_EXPERIMENTAL_")) {
      set.add("EXPERIMENTAL");
    }
    return set;
  }, [enabledFeatures, target, dceMarker]);

  const copyTokenVar = (spec: HoudiniTokenSpec) => {
    const snippet = `var(${spec.token}) /* ${spec.hex} */`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(snippet).catch(() => {});
    }
    setCopiedToken(spec.token);
    setTimeout(() => {
      setCopiedToken((prev) => (prev === spec.token ? null : prev));
    }, 1500);
  };

  return (
    <section
      style={{
        padding: "14px 24px",
        backgroundColor: "var(--sd-surface-cli, #04070e)",
        borderBottom: "1px solid var(--sd-surface-border, #1e293b)",
      }}
    >
      <div
        style={{
          maxWidth: "1600px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            <strong style={{ fontSize: "13px" }}>
              🧬 Compile-Time <code>bun:bundle</code> DCE Matrix &amp;{" "}
              <code>design/tokens.toml</code> Houdini Palette
            </strong>
            {target && (
              <span className="sd-pill sd-pill-live sd-mono">
                Active Target: {target}
              </span>
            )}
            <span className="sd-pill sd-mono">
              @property{" "}
              {computedCount > 0
                ? `${computedCount}/${HOUDINI_TOKENS.length} live`
                : `${HOUDINI_TOKENS.length} registered`}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <span
              className="sd-mono"
              style={{
                fontSize: "11px",
                color: "var(--sd-text-muted, #94a3b8)",
              }}
            >
              Active Bundle Sentinel: {dceMarker}
            </span>
            {onRefresh && (
              <button
                type="button"
                className="sd-pill sd-mono"
                onClick={onRefresh}
                disabled={loading}
                style={{
                  cursor: loading ? "wait" : "pointer",
                  color: "#38bdf8",
                }}
              >
                {loading ? "⏳ Compiling..." : "↻ Re-compile Matrix"}
              </button>
            )}
          </div>
        </div>

        {/* Compile-time bun:bundle Feature Flag Strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
          }}
        >
          <span
            className="sd-mono"
            style={{
              fontSize: "11px",
              color: "var(--sd-text-muted, #94a3b8)",
              marginRight: "4px",
            }}
          >
            Flags:
          </span>
          {FEATURES.map((feat) => {
            const active = activeFeatureSet.has(feat);
            return (
              <span
                key={feat}
                title={DESCRIPTIONS[feat]}
                className={`sd-pill sd-mono ${active ? "sd-pill-live" : ""}`}
                style={active ? undefined : { opacity: 0.72 }}
              >
                {active ? "✅" : "✂️"} {feat}{" "}
                <span style={{ opacity: 0.8 }}>{active ? "ON" : "DCE"}</span>
              </span>
            );
          })}
        </div>

        {/* Axis Filter Tabs + Houdini Swatch Strip */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {(
              [
                ["all", `All Tokens (${HOUDINI_TOKENS.length})`],
                [
                  "surfaces",
                  `Surfaces & Chrome (${HOUDINI_TOKENS.filter((t) => t.axis === "surfaces").length})`,
                ],
                [
                  "ingestion",
                  `Ingestion L17–L24D (${HOUDINI_TOKENS.filter((t) => t.axis === "ingestion").length})`,
                ],
                [
                  "routes",
                  `Risk Routes R01–R04 (${HOUDINI_TOKENS.filter((t) => t.axis === "routes").length})`,
                ],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="sd-preset-btn sd-mono"
                data-active={axisFilter === id ? "true" : "false"}
                onClick={() => setAxisFilter(id)}
                style={{ padding: "3px 9px", fontSize: "11px" }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {visibleTokens.map((spec) => {
              const liveHex = computedTokens[spec.token];
              const isCopied = copiedToken === spec.token;
              return (
                <button
                  key={spec.token}
                  type="button"
                  onClick={() => copyTokenVar(spec)}
                  className="sd-pill sd-mono"
                  title={`${spec.detail} · canonical ${spec.hex}${liveHex ? ` · computed ${liveHex}` : ""} · Click to copy var()`}
                  style={{ cursor: "pointer" }}
                >
                  <span
                    className="sd-token-swatch"
                    style={{
                      backgroundColor: `var(${spec.token}, ${spec.hex})`,
                    }}
                  />
                  <span>
                    {spec.label}: {spec.token}
                  </span>
                  <span
                    style={{
                      color:
                        isCopied || (liveHex && liveHex !== spec.hex)
                          ? "#4ade80"
                          : "var(--sd-text-muted, #94a3b8)",
                      fontSize: "10px",
                    }}
                  >
                    {isCopied ? "Copied!" : spec.hex}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div
            className="sd-mono"
            style={{
              fontSize: "11px",
              color: "#f87171",
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              backgroundColor: "rgba(239, 68, 68, 0.08)",
            }}
          >
            ⚠️ DCE Matrix probe error: {error}
          </div>
        )}

        {loading ? (
          <div
            style={{
              fontSize: "12px",
              color: "var(--sd-text-muted, #94a3b8)",
            }}
          >
            Compiling live <code>prod</code> / <code>dev</code> /{" "}
            <code>test</code> bundles via <code>Bun.build</code>…
          </div>
        ) : rows ? (
          <table style={{ margin: 0 }}>
            <thead>
              <tr>
                <th>Target</th>
                <th>Enabled bun:bundle Flags</th>
                <th>JS Bundle</th>
                <th>JS Delta vs dev</th>
                <th>CSS Tokens + Chrome</th>
                <th>Total</th>
                <th>PROD Branch</th>
                <th>DEBUG Branch</th>
                <th>EXPERIMENTAL Branch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isActiveTarget = target === r.target;
                return (
                  <tr
                    key={r.target}
                    style={
                      isActiveTarget
                        ? { backgroundColor: "rgba(16, 185, 129, 0.08)" }
                        : undefined
                    }
                  >
                    <td className="sd-mono">
                      <strong>{r.target}</strong>{" "}
                      {isActiveTarget && (
                        <span
                          style={{
                            marginLeft: "6px",
                            fontSize: "10px",
                            color: "#10b981",
                            fontWeight: 700,
                          }}
                        >
                          ACTIVE
                        </span>
                      )}
                    </td>
                    <td className="sd-mono">{r.features.join(", ")}</td>
                    <td className="sd-mono">
                      {(r.totalJsBytes / 1024).toFixed(1)} KB
                    </td>
                    <td
                      className="sd-mono"
                      style={{
                        color:
                          devBaselineBytes !== null &&
                          r.totalJsBytes < devBaselineBytes
                            ? "#4ade80"
                            : "var(--sd-text-muted, #94a3b8)",
                      }}
                    >
                      {formatBytesDeltaVsBaseline(
                        r.totalJsBytes,
                        devBaselineBytes,
                      )}
                    </td>
                    <td className="sd-mono">
                      {(r.totalCssBytes / 1024).toFixed(1)} KB
                    </td>
                    <td className="sd-mono">
                      {((r.totalJsBytes + r.totalCssBytes) / 1024).toFixed(1)}{" "}
                      KB
                    </td>
                    <td className="sd-mono">
                      {r.hasProdSentinel ? "✅ Kept" : "✂️ Pruned (DCE)"}
                    </td>
                    <td className="sd-mono">
                      {r.hasDebugSentinel ? "✅ Kept" : "✂️ Pruned (DCE)"}
                    </td>
                    <td className="sd-mono">
                      {r.hasExperimentalSentinel
                        ? "✅ Kept"
                        : "✂️ Pruned (DCE)"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
