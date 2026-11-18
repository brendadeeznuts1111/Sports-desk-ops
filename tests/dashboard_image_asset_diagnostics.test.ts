/**
 * @file tests/dashboard_image_asset_diagnostics.test.ts
 * @description The dashboard serves its own Bun.Image asset attributes: `/docs/assets` is scanned
 * shallowly, `Bun.Image.Metadata` reads headers only, every source is masked to a workspace-relative
 * path because the route is pinned to `RISK_MANAGER`, and repeat reads revalidate with an ETag.
 */
import { afterAll, expect, test } from "bun:test";

import { startDashboardServer } from "../scripts/dev_dashboard.ts";

const handle = startDashboardServer({
  port: 0,
  watchFiles: false,
  development: false,
});

afterAll(() => {
  handle.stop(true);
});

interface ImageAssetPayload {
  readonly type: string;
  readonly source: string;
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
  readonly code?: string;
}

interface ImageAssetsResponse {
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly root: string;
  readonly visibility: string;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly count: number;
  readonly cached: boolean;
  readonly etag: string;
  readonly assets: readonly ImageAssetPayload[];
}

function assetsUrl(limit: number): URL {
  const url = new URL("/api/diagnostics/image-assets", handle.url);
  url.searchParams.set("limit", String(limit));
  return url;
}

test("/api/diagnostics/image-assets lists masked Bun.Image attributes", async () => {
  const response = await fetch(assetsUrl(5));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  const etag = response.headers.get("etag");
  expect(etag).toBeString();
  if (etag === null)
    throw new Error("image-assets response is missing an ETag");

  const body = (await response.json()) as ImageAssetsResponse;
  expect(body.ok).toBe(true);
  expect(body.root).toBe("docs/assets");
  expect(body.visibility).toBe("RISK_MANAGER");
  expect(body.generatedAt).not.toBe("");
  expect(body.limit).toBe(5);
  expect(body.count).toBe(body.assets.length);
  expect(body.count).toBeGreaterThan(0);
  expect(body.count).toBeLessThanOrEqual(5);
  expect(body.total).toBeGreaterThanOrEqual(body.count);
  expect(body.truncated).toBe(body.total > body.count);
  expect(body.cached).toBe(false);
  expect(body.etag).toBe(etag);

  for (const asset of body.assets) {
    // No entry may carry the absolute host path, a temp directory or a home directory.
    expect(asset.source).toStartWith("docs/assets/");
    expect(asset.source).not.toContain(process.cwd());
    expect(asset.source).not.toContain("[REDACTED_DIR]");
  }

  const readable = body.assets.find(
    (asset) => asset.type === "BunImageAssetDiagnostic",
  );
  expect(readable).toBeDefined();
  if (readable !== undefined) {
    expect(readable.format).not.toBe("");
    expect(readable.width).toBeGreaterThan(0);
    expect(readable.height).toBeGreaterThan(0);
  }
});

test("repeat reads hit the TTL cache and revalidate with the ETag", async () => {
  const first = await fetch(assetsUrl(5));
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as ImageAssetsResponse;
  const etag = firstBody.etag;

  const second = await fetch(assetsUrl(5));
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as ImageAssetsResponse;
  expect(secondBody.cached).toBe(true);
  expect(secondBody.generatedAt).toBe(firstBody.generatedAt);
  expect(secondBody.etag).toBe(etag);
  expect(secondBody.count).toBe(firstBody.count);

  const revalidated = await fetch(assetsUrl(5), {
    headers: { "if-none-match": etag },
  });
  expect(revalidated.status).toBe(304);
  expect(await revalidated.text()).toBe("");
  expect(revalidated.headers.get("etag")).toBe(etag);
});

test("limit is clamped, honest about truncation and independent per cache key", async () => {
  const response = await fetch(assetsUrl(1));
  expect(response.status).toBe(200);
  const body = (await response.json()) as ImageAssetsResponse;
  expect(body.limit).toBe(1);
  expect(body.count).toBe(1);
  expect(body.assets.length).toBe(1);
  expect(body.total).toBeGreaterThan(1);
  expect(body.truncated).toBe(true);
  expect(body.cached).toBe(false);

  const clamped = await fetch(assetsUrl(0));
  expect(clamped.status).toBe(200);
  const clampedBody = (await clamped.json()) as ImageAssetsResponse;
  expect(clampedBody.limit).toBe(1);
  expect(clampedBody.cached).toBe(true);
});
