/**
 * @file tests/daemon_image_asset_route.test.ts
 * @description The daemon serves `GET /api/diagnostics/image-assets`, not only the dev dashboard.
 *
 * The dashboard panel calls the route on its own origin (`BunAssetsTabPanel` -> `fetch`), so on the
 * daemon (:4020) it used to 404 while the same tab worked under `scripts/dev_dashboard.ts`. Both
 * arms now read one shared snapshot source, which is why the assertions below also pin the cache
 * contract: an ETag that revalidates with 304, and a TTL that makes the second read `cached`.
 *
 * Masks are the point of the route: sources are workspace-relative under `RISK_MANAGER`, so no
 * absolute host path may appear in the payload.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import { resetBunImageAssetSnapshots } from "../lib/bun_image_asset_snapshot.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

let server: ReturnType<typeof startServer>;

beforeAll(() => {
  resetBunImageAssetSnapshots();
  server = startServer({ port: 0, hostname: "127.0.0.1", development: false });
});

afterAll(() => {
  server.stop(true);
});

interface Snapshot {
  readonly ok: boolean;
  readonly root: string;
  readonly visibility: string;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly count: number;
  readonly cached: boolean;
  readonly etag: string;
  readonly assets: readonly {
    readonly type: string;
    readonly source: string;
    readonly width?: number;
    readonly height?: number;
    readonly format?: string;
    readonly bytes?: number | null;
  }[];
}

function routeUrl(limit: number): URL {
  const url = new URL("/api/diagnostics/image-assets", server.url);
  url.searchParams.set("limit", String(limit));
  return url;
}

test("the daemon answers the asset snapshot with masked sources", async () => {
  const response = await fetch(routeUrl(8));
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toMatch(/^"img-[0-9a-f]+"$/);

  const snapshot = (await response.json()) as Snapshot;
  expect(snapshot.ok).toBe(true);
  expect(snapshot.root).toBe("docs/assets");
  expect(snapshot.visibility).toBe("RISK_MANAGER");
  expect(snapshot.limit).toBe(8);
  expect(snapshot.count).toBeGreaterThan(0);

  for (const asset of snapshot.assets) {
    // Masked path, not a host path: the payload must never leak where the repo lives.
    expect(asset.source.startsWith("/")).toBe(false);
    expect(asset.source).not.toContain("..");
    expect(asset.source).not.toContain(process.cwd());
  }
});

test("a repeat read revalidates with the ETag and reports the TTL cache", async () => {
  const first = await fetch(routeUrl(4));
  expect(first.status).toBe(200);
  const etag = first.headers.get("etag");
  expect(etag).not.toBeNull();
  const firstBody = (await first.json()) as Snapshot;
  expect(firstBody.cached).toBe(false);

  const cached = await fetch(routeUrl(4));
  expect(((await cached.json()) as Snapshot).cached).toBe(true);

  const revalidated = await fetch(routeUrl(4), {
    headers: { "if-none-match": etag ?? "" },
  });
  expect(revalidated.status).toBe(304);
  expect(await revalidated.text()).toBe("");
});

test("limit is clamped to 1..100 and a non-GET method is refused", async () => {
  const wide = await fetch(routeUrl(1_000));
  expect(((await wide.json()) as Snapshot).limit).toBe(100);

  const narrow = await fetch(routeUrl(0));
  expect(((await narrow.json()) as Snapshot).limit).toBe(1);

  const posted = await fetch(routeUrl(8), { method: "POST" });
  expect(posted.status).toBe(405);
  expect(posted.headers.get("allow")).toBe("GET, HEAD");
});
