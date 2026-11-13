import type React from "react";
import type { BuildMatrixRow } from "../types.ts";

export interface BuildMatrixDrawerProps {
  readonly dceMarker: string;
  readonly loading: boolean;
  readonly rows: readonly BuildMatrixRow[] | null;
}

const TOKEN_SWATCHES: readonly [string, string][] = [
  ["--sd-surface-bg", "Obsidian"],
  ["--sd-surface-card", "Card"],
  ["--sd-tier-alert", "Alert L21"],
  ["--sd-tier-steam", "Steam L22"],
  ["--sd-tier-whale", "Whale L23"],
  ["--sd-tier-rec-bias", "Rec L24"],
  ["--sd-theme-emerald", "Gateway L20"],
  ["--sd-route-sharp", "Sharp R02"],
  ["--sd-route-devig", "Devig R04"],
  ["--sd-route-manager", "Manager R03"],
];

export function BuildMatrixDrawer({
  dceMarker,
  loading,
  rows,
}: BuildMatrixDrawerProps): React.ReactElement {
  return (
    <section
      style={{
        padding: "14px 24px",
        backgroundColor: "var(--sd-surface-cli, #0a1020)",
        borderBottom: "1px solid var(--sd-surface-border, #1e293b)",
      }}
    >
      <div
        style={{
          maxWidth: "1600px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
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
          <strong style={{ fontSize: "13px" }}>
            🧬 Compile-Time <code>bun:bundle</code> DCE Matrix &amp;{" "}
            <code>design/tokens.toml</code> Houdini Palette
          </strong>
          <span
            className="sd-mono"
            style={{
              fontSize: "11px",
              color: "var(--sd-text-muted, #94a3b8)",
            }}
          >
            Active Bundle Sentinel: {dceMarker}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {TOKEN_SWATCHES.map(([token, label]) => (
            <span key={token} className="sd-pill sd-mono">
              <span
                className="sd-token-swatch"
                style={{ backgroundColor: `var(${token})` }}
              />
              {label}: {token}
            </span>
          ))}
        </div>
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
                <th>CSS Tokens + Chrome</th>
                <th>PROD Branch</th>
                <th>DEBUG Branch</th>
                <th>EXPERIMENTAL Branch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.target}>
                  <td className="sd-mono">
                    <strong>{r.target}</strong>
                  </td>
                  <td className="sd-mono">{r.features.join(", ")}</td>
                  <td className="sd-mono">
                    {(r.totalJsBytes / 1024).toFixed(1)} KB
                  </td>
                  <td className="sd-mono">
                    {(r.totalCssBytes / 1024).toFixed(1)} KB
                  </td>
                  <td className="sd-mono">
                    {r.hasProdSentinel ? "✅ Kept" : "✂️ Pruned (DCE)"}
                  </td>
                  <td className="sd-mono">
                    {r.hasDebugSentinel ? "✅ Kept" : "✂️ Pruned (DCE)"}
                  </td>
                  <td className="sd-mono">
                    {r.hasExperimentalSentinel ? "✅ Kept" : "✂️ Pruned (DCE)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
