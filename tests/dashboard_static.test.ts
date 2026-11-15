import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetDashboardStaticCache,
  serveDashboardAsset,
} from "../lib/dashboard_static.ts";

const root = mkdtempSync(join(tmpdir(), "dashboard-static-"));
mkdirSync(join(root, "nested"));
writeFileSync(join(root, "index.html"), "<div id=app></div>");
writeFileSync(join(root, "chunk-abc123.js"), "export const x = 1;");
writeFileSync(join(root, "logo.svg"), "<svg/>");
writeFileSync(join(root, "nested", "deep.css"), "a{color:red}");

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  // The index is memoized per root; one root here, reset for isolation between cases.
  resetDashboardStaticCache();
});

describe("serveDashboardAsset", () => {
  test("serves the app root as the no-cache index", async () => {
    const res = await serveDashboardAsset("/", { root });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("no-cache");
    expect(await res?.text()).toContain("id=app");
  });

  test("gives hashed assets an immutable cache policy", async () => {
    const res = await serveDashboardAsset("/chunk-abc123.js", { root });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toContain("immutable");
    expect(res?.headers.get("content-type")).toContain("javascript");
  });

  test("non-hashed assets get an hour, not a year", async () => {
    const res = await serveDashboardAsset("/logo.svg", { root });
    expect(res?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("serves nested assets", async () => {
    const res = await serveDashboardAsset("/nested/deep.css", { root });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/css");
  });

  test("falls back to the index for extension-less routes", async () => {
    const res = await serveDashboardAsset("/surveillance/agent/123", { root });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("no-cache");
  });

  test("does not fall back for a dotted miss", async () => {
    expect(await serveDashboardAsset("/missing.js", { root })).toBeNull();
  });

  test("refuses traversal instead of resolving outside the build", async () => {
    expect(await serveDashboardAsset("/../package.json", { root })).toBeNull();
    expect(
      await serveDashboardAsset("/..%2fpackage.json", { root }),
    ).toBeNull();
  });

  test("merges caller headers without dropping the cache policy", async () => {
    const res = await serveDashboardAsset("/chunk-abc123.js", {
      root,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("cache-control")).toContain("immutable");
  });
});
