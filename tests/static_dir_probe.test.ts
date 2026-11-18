import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  inventoryStaticDirectory,
  probeStaticDirectoryRoute,
} from "../lib/static_dir_probe.ts";

const STATIC_DIR = resolve(import.meta.dir, "../static");

describe("static_dir_probe", () => {
  test("fails closed with contextual error when static directory or wildcard is invalid", async () => {
    await expect(
      inventoryStaticDirectory(join(tmpdir(), `missing-static-${process.pid}`)),
    ).rejects.toThrow("ERR_STATIC_DIR_MISSING");

    await expect(
      inventoryStaticDirectory(STATIC_DIR, "/static"),
    ).rejects.toThrow("ERR_STATIC_DIR_WILDCARD");
  });

  test("inventories repo static/ files and verifies 200/304/206/404 against live Bun.serve { dir }", async () => {
    const inv = await inventoryStaticDirectory(STATIC_DIR);
    expect(inv.wildcardPath).toBe("/static/*");
    expect(inv.totalFiles).toBeGreaterThanOrEqual(4);
    expect(inv.files.some((f) => f.urlPath === "/static/status.html")).toBe(
      true,
    );

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: {
        "/static/*": { dir: STATIC_DIR },
      },
      fetch() {
        return new Response("not-found", { status: 404 });
      },
    });
    try {
      const probe = await probeStaticDirectoryRoute(
        server.url.origin,
        STATIC_DIR,
      );
      expect(probe.liveCheck).not.toBeNull();
      expect(probe.liveCheck?.allPassed).toBe(true);
      expect(probe.liveCheck?.checks.length).toBeGreaterThanOrEqual(4);
      expect(probe.liveCheck?.etag).toMatch(/^W\//);
      expect(probe.liveCheck?.contentRange).toContain("bytes 0-9/");
    } finally {
      server.stop(true);
    }
  });
});
