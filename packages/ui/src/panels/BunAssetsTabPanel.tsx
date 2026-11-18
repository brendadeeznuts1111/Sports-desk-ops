/**
 * @file packages/ui/src/panels/BunAssetsTabPanel.tsx
 * @description Dashboard tab for `GET /api/diagnostics/image-assets`.
 *
 * The endpoint has already masked every source (workspace-relative under `RISK_MANAGER`) and run
 * `Bun.Image.Metadata` over the header, so this panel only renders attributes: it never touches a
 * file path or decodes pixels. Dimensions, bytes and the `Bun.Image` backend come straight from the
 * diagnostic payload; `code` is rendered for files the scanner could not decode.
 */
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { styles } from "../dashboard_styles.ts";
import { formatBytes } from "../format_bytes.ts";

export interface BunImageAssetRow {
  readonly type: "BunImageAssetDiagnostic" | "BunImageAssetScanFailure";
  readonly source: string;
  readonly format?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly bytes?: number | null | undefined;
  readonly backend?: string | null | undefined;
  readonly code?: string | undefined;
}

export interface BunAssetsPayload {
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly root: string;
  readonly visibility: string;
  readonly count: number;
  readonly total?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly cached?: boolean | undefined;
  readonly assets: readonly BunImageAssetRow[];
}

export interface BunAssetsTabPanelProps {
  readonly initialPayload?: BunAssetsPayload | null;
  readonly loadAssets?: () => Promise<BunAssetsPayload>;
}

async function defaultLoadAssets(): Promise<BunAssetsPayload> {
  const response = await fetch("/api/diagnostics/image-assets", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`image-assets HTTP ${response.status}`);
  }
  return (await response.json()) as BunAssetsPayload;
}

export function BunAssetsTabPanel({
  initialPayload = null,
  loadAssets = defaultLoadAssets,
}: BunAssetsTabPanelProps): React.ReactElement {
  const [payload, setPayload] = useState<BunAssetsPayload | null>(
    initialPayload,
  );
  const [loading, setLoading] = useState<boolean>(initialPayload === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setPayload(await loadAssets());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [loadAssets]);

  useEffect(() => {
    if (initialPayload === null) void refresh();
  }, [initialPayload, refresh]);

  const assets = payload?.assets ?? [];
  return (
    <section data-testid="bun-assets-panel" style={styles.tableCard}>
      <div style={styles.tableHeader}>
        <h2 style={styles.tableTitle}>
          🖼️ Bun.Image Assets{" "}
          <span style={{ color: "#64748b", fontWeight: 500 }}>
            ({payload?.count ?? 0}
            {payload?.truncated === true && payload.total !== undefined
              ? ` of ${payload.total}`
              : ""}
            )
          </span>
          {payload?.cached === true ? (
            <span
              style={{
                marginLeft: "8px",
                fontSize: "10px",
                padding: "1px 6px",
                borderRadius: "8px",
                backgroundColor: "#1e293b",
                color: "#94a3b8",
                fontWeight: 600,
              }}
            >
              cached
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            padding: "6px 12px",
            borderRadius: "6px",
            border: "1px solid #1e293b",
            backgroundColor: loading ? "#111a2e" : "#0d1527",
            color: "#cbd5e1",
            fontSize: "12px",
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Scanning…" : "Rescan"}
        </button>
      </div>

      <p style={{ margin: "0 0 12px", color: "#94a3b8", fontSize: "12px" }}>
        root <code>{payload?.root ?? "docs/assets"}</code> · visibility{" "}
        <code>{payload?.visibility ?? "RISK_MANAGER"}</code>
        {payload?.generatedAt ? ` · ${payload.generatedAt}` : ""}
      </p>

      {error !== null ? (
        <p role="alert" style={{ color: "#f87171", fontSize: "12px" }}>
          Asset scan failed: {error}
        </p>
      ) : null}

      <div style={styles.tableScroll}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th scope="col" style={styles.th}>
                Source
              </th>
              <th scope="col" style={styles.th}>
                Format
              </th>
              <th scope="col" style={styles.th}>
                Dimensions
              </th>
              <th scope="col" style={styles.th}>
                Bytes
              </th>
              <th scope="col" style={styles.th}>
                Backend
              </th>
              <th scope="col" style={styles.th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {assets.length === 0 ? (
              <tr>
                <td colSpan={6} style={styles.td}>
                  No raster assets found under {payload?.root ?? "docs/assets"}.
                </td>
              </tr>
            ) : (
              assets.map((asset) => {
                const failed = asset.type === "BunImageAssetScanFailure";
                return (
                  <tr key={asset.source} data-image-asset-row="true">
                    <td style={styles.td}>
                      <code style={{ fontSize: "11px", color: "#cbd5e1" }}>
                        {asset.source}
                      </code>
                    </td>
                    <td style={styles.td}>{asset.format ?? "—"}</td>
                    <td style={styles.td}>
                      {asset.width === undefined || asset.height === undefined
                        ? "—"
                        : `${asset.width}×${asset.height}`}
                    </td>
                    <td style={styles.td}>{formatBytes(asset.bytes)}</td>
                    <td style={styles.td}>{asset.backend ?? "—"}</td>
                    <td style={styles.td}>
                      {failed ? (
                        <span style={{ color: "#f87171" }}>
                          {asset.code ?? "failed"}
                        </span>
                      ) : (
                        <span style={{ color: "#4ade80" }}>ok</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
