/**
 * @file tests/dashboard_bun_assets_panel.test.tsx
 * @description The dashboard `Bun Assets` panel renders the masked `/api/diagnostics/image-assets`
 * payload: header-only dimensions, byte counts, backend and per-file failure codes.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BunAssetsTabPanel,
  type BunAssetsPayload,
} from "../packages/ui/src/panels/BunAssetsTabPanel.tsx";

const payload: BunAssetsPayload = {
  ok: true,
  generatedAt: "2026-11-17T22:00:00.000Z",
  root: "docs/assets",
  visibility: "RISK_MANAGER",
  count: 2,
  total: 3,
  truncated: true,
  cached: true,
  assets: [
    {
      type: "BunImageAssetDiagnostic",
      source: "docs/assets/ARCH-Guide.webp",
      format: "webp",
      width: 1024,
      height: 768,
      bytes: 12_288,
      backend: "bun",
    },
    {
      type: "BunImageAssetScanFailure",
      source: "docs/assets/broken.png",
      code: "ERR_IMAGE_UNKNOWN_FORMAT",
    },
  ],
};

describe("BunAssetsTabPanel", () => {
  test("renders dimensions, bytes, backend and failure codes", () => {
    const html = renderToStaticMarkup(
      <BunAssetsTabPanel initialPayload={payload} />,
    );

    expect(html).toContain('data-testid="bun-assets-panel"');
    expect(html).toContain("Bun.Image Assets");
    expect(html).toContain("docs/assets/ARCH-Guide.webp");
    expect(html).toContain("1024×768");
    expect(html).toContain("12.0 KiB");
    expect(html).toContain("webp");
    expect(html).toContain("bun");
    expect(html).toContain("ok");
    expect(html).toContain("ERR_IMAGE_UNKNOWN_FORMAT");
    expect(html).toContain("RISK_MANAGER");
    expect(html).toContain("2026-11-17T22:00:00.000Z");
    expect(html).toContain("2 of 3");
    expect(html).toContain("cached");
    // The panel never widens the masked source back to a host path.
    expect(html).not.toContain(process.cwd());
  });

  test("renders the empty state", () => {
    const empty: BunAssetsPayload = {
      ...payload,
      count: 0,
      assets: [],
    };
    const html = renderToStaticMarkup(
      <BunAssetsTabPanel initialPayload={empty} />,
    );
    expect(html).toContain("No raster assets found under");
    expect(html).toContain("docs/assets");
  });
});
