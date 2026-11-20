/**
 * @file tests/bun_serve_static_vs_file_routes.test.ts
 * @description Contract for `Bun.serve({ routes })` startup-buffered static routes
 * (`new Response(await Bun.file(path).bytes())`) vs filesystem-backed file routes
 * (`new Response(Bun.file(path))`): headers, MIME inference, strong ETag/304,
 * Range 206/416, HTTP methods, live disk edits, and file deletion behavior.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: serve-static-vs-file-routes

const INITIAL_LOGO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const INITIAL_ZIP_TEXT = "PK-v1-payload-0123456789";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withRouteFixture(
  opts: { readonly withFetchFallback?: boolean },
  run: (ctx: {
    readonly baseUrl: string;
    readonly logoPath: string;
    readonly zipPath: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bun-serve-routes-"));
  tempDirs.push(dir);
  const logoPath = join(dir, "logo.png");
  const zipPath = join(dir, "download.zip");
  writeFileSync(logoPath, INITIAL_LOGO_BYTES);
  writeFileSync(zipPath, new TextEncoder().encode(INITIAL_ZIP_TEXT));

  const routes = {
    "/logo.png": new Response(await Bun.file(logoPath).bytes()),
    "/logo-typed.png": new Response(await Bun.file(logoPath).bytes(), {
      headers: { "Content-Type": "image/png" },
    }),
    "/download.zip": new Response(Bun.file(zipPath)),
  };

  const server = opts.withFetchFallback
    ? Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        routes,
        fetch() {
          return new Response("fallback-404", { status: 404 });
        },
      })
    : Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        routes,
      });

  try {
    await run({
      baseUrl: `http://127.0.0.1:${server.port}`,
      logoPath,
      zipPath,
    });
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Bun.serve static (.bytes()) vs file (Bun.file()) routes", () => {
  test("buffers static route with strong ETag/304 while file route infers MIME and serves HEAD/POST", async () => {
    await withRouteFixture({ withFetchFallback: true }, async ({ baseUrl }) => {
      const logoRes = await fetch(`${baseUrl}/logo.png`);
      const logoBody = new Uint8Array(await logoRes.arrayBuffer());
      const logoEtag = logoRes.headers.get("etag");
      expect(logoRes.status).toBe(200);
      expect(logoRes.headers.get("content-type")).toBeNull();
      expect(logoRes.headers.get("content-length")).toBe("8");
      expect(logoEtag).toMatch(/^"[0-9a-f]+"$/);
      expect(logoBody).toEqual(INITIAL_LOGO_BYTES);

      const notModified = await fetch(`${baseUrl}/logo.png`, {
        headers: { "If-None-Match": logoEtag ?? "" },
      });
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get("content-length")).toBeNull();
      expect((await notModified.arrayBuffer()).byteLength).toBe(0);

      const typedLogoRes = await fetch(`${baseUrl}/logo-typed.png`);
      expect(typedLogoRes.status).toBe(200);
      expect(typedLogoRes.headers.get("content-type")).toBe("image/png");
      expect(typedLogoRes.headers.get("etag")).toBe(logoEtag);
      expect(new Uint8Array(await typedLogoRes.arrayBuffer())).toEqual(
        INITIAL_LOGO_BYTES,
      );

      const zipRes = await fetch(`${baseUrl}/download.zip`);
      expect(zipRes.status).toBe(200);
      expect(zipRes.headers.get("content-type")).toBe("application/zip");
      expect(zipRes.headers.get("etag")).toBeNull();
      expect(zipRes.headers.get("content-length")).toBe("24");
      expect(await zipRes.text()).toBe(INITIAL_ZIP_TEXT);

      const headLogo = await fetch(`${baseUrl}/logo.png`, { method: "HEAD" });
      expect(headLogo.status).toBe(200);
      expect(headLogo.headers.get("content-length")).toBe("8");
      expect((await headLogo.arrayBuffer()).byteLength).toBe(0);

      const headZip = await fetch(`${baseUrl}/download.zip`, {
        method: "HEAD",
      });
      expect(headZip.status).toBe(200);
      expect(headZip.headers.get("content-length")).toBe("24");
      expect((await headZip.arrayBuffer()).byteLength).toBe(0);

      const postLogo = await fetch(`${baseUrl}/logo.png`, { method: "POST" });
      expect(postLogo.status).toBe(200);
      expect(new Uint8Array(await postLogo.arrayBuffer())).toEqual(
        INITIAL_LOGO_BYTES,
      );

      const postZip = await fetch(`${baseUrl}/download.zip`, {
        method: "POST",
      });
      expect(postZip.status).toBe(200);
      expect(await postZip.text()).toBe(INITIAL_ZIP_TEXT);
    });
  });

  test("file routes honor Range 206/416 while static buffered routes return 200", async () => {
    await withRouteFixture({ withFetchFallback: true }, async ({ baseUrl }) => {
      const staticRange = await fetch(`${baseUrl}/logo.png`, {
        headers: { Range: "bytes=0-3" },
      });
      expect(staticRange.status).toBe(200);
      expect(staticRange.headers.get("accept-ranges")).toBeNull();
      expect(staticRange.headers.get("content-range")).toBeNull();
      expect(new Uint8Array(await staticRange.arrayBuffer())).toEqual(
        INITIAL_LOGO_BYTES,
      );

      const fileRange = await fetch(`${baseUrl}/download.zip`, {
        headers: { Range: "bytes=0-3" },
      });
      expect(fileRange.status).toBe(206);
      expect(fileRange.headers.get("accept-ranges")).toBe("bytes");
      expect(fileRange.headers.get("content-range")).toBe("bytes 0-3/24");
      expect(fileRange.headers.get("content-length")).toBe("4");
      expect(await fileRange.text()).toBe("PK-v");

      const fileOobRange = await fetch(`${baseUrl}/download.zip`, {
        headers: { Range: "bytes=999-1000" },
      });
      expect(fileOobRange.status).toBe(416);
      expect(fileOobRange.headers.get("content-range")).toBe("bytes */24");
    });
  });

  test("static routes ignore live edits and deletion while file routes reflect edits and fall back on unlink", async () => {
    await withRouteFixture(
      { withFetchFallback: true },
      async ({ baseUrl, logoPath, zipPath }) => {
        const initialLogo = await fetch(`${baseUrl}/logo.png`);
        const initialEtag = initialLogo.headers.get("etag");
        await initialLogo.arrayBuffer();

        writeFileSync(logoPath, new Uint8Array([9, 9, 9, 9]));
        writeFileSync(
          zipPath,
          new TextEncoder().encode("PK-v2-mutated-abcdef"),
        );

        const editedLogo = await fetch(`${baseUrl}/logo.png`);
        expect(editedLogo.status).toBe(200);
        expect(editedLogo.headers.get("etag")).toBe(initialEtag);
        expect(new Uint8Array(await editedLogo.arrayBuffer())).toEqual(
          INITIAL_LOGO_BYTES,
        );

        const editedZip = await fetch(`${baseUrl}/download.zip`);
        expect(editedZip.status).toBe(200);
        expect(editedZip.headers.get("content-length")).toBe("20");
        expect(await editedZip.text()).toBe("PK-v2-mutated-abcdef");

        const editedZipRange = await fetch(`${baseUrl}/download.zip`, {
          headers: { Range: "bytes=0-4" },
        });
        expect(editedZipRange.status).toBe(206);
        expect(editedZipRange.headers.get("content-range")).toBe(
          "bytes 0-4/20",
        );
        expect(await editedZipRange.text()).toBe("PK-v2");

        unlinkSync(logoPath);
        unlinkSync(zipPath);

        const unlinkedLogo = await fetch(`${baseUrl}/logo.png`);
        expect(unlinkedLogo.status).toBe(200);
        expect(new Uint8Array(await unlinkedLogo.arrayBuffer())).toEqual(
          INITIAL_LOGO_BYTES,
        );

        const unlinkedZip = await fetch(`${baseUrl}/download.zip`);
        expect(unlinkedZip.status).toBe(404);
        expect(await unlinkedZip.text()).toBe("fallback-404");
      },
    );
  });

  test("file route returns 404 after deletion even when no fetch() fallback is configured", async () => {
    await withRouteFixture(
      { withFetchFallback: false },
      async ({ baseUrl, zipPath }) => {
        unlinkSync(zipPath);
        const res = await fetch(`${baseUrl}/download.zip`);
        expect(res.status).toBe(404);
      },
    );
  });
});
