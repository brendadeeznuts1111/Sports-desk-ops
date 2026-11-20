/**
 * @file tests/bun_serve_directory_routes.test.ts
 * @description Contract for `Bun.serve({ routes })` directory routes (`{ dir, statCache }`):
 * wildcard requirement, canonical path enforcement, conditional GET/Range/If-Range,
 * case-sensitive routing vs case-insensitive FS, and macOS symlink containment drift vs `containedAssetPath`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedAssetPath } from "../lib/asset_path.ts";
import { sendRawHttpRequest } from "../src/lib/raw_http_tcp.ts";

// @bun-behavior: serve-directory-routes

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface DirectoryFixture {
  readonly root: string;
  readonly pub: string;
  readonly outsidePath: string;
}

function createDirectoryFixture(): DirectoryFixture {
  const root = mkdtempSync(join(tmpdir(), "bun-dir-routes-"));
  tempDirs.push(root);

  const outsidePath = join(root, "outside.txt");
  writeFileSync(outsidePath, "SECRET-OUTSIDE");

  const pub = join(root, "public");
  mkdirSync(join(pub, "sub"), { recursive: true });
  mkdirSync(join(pub, "admin"), { recursive: true });
  mkdirSync(join(pub, "var", "data"), { recursive: true });

  writeFileSync(join(pub, "hello.txt"), "hello-directory-route");
  writeFileSync(join(pub, "my file.txt"), "space-file-ok");
  writeFileSync(join(pub, "inside.txt"), "INSIDE-ROOT-CLAMP");
  writeFileSync(join(pub, "var", "data", "logo.txt"), "IN-ROOT-VAR-DATA");
  writeFileSync(join(pub, "sub", "index.html"), "<h1>sub index</h1>");
  writeFileSync(join(pub, "admin", "secret.txt"), "ADMIN-SECRET");

  symlinkSync("../outside.txt", join(pub, "rel-escape.txt"));
  symlinkSync("../../../inside.txt", join(pub, "rel-clamp.txt"));
  symlinkSync(outsidePath, join(pub, "abs-escape.txt"));
  symlinkSync("/var/data/logo.txt", join(pub, "abs-inroot.txt"));

  return { root, pub, outsidePath };
}

describe("Bun.serve directory routes ({ dir, statCache })", () => {
  test("requires /* suffix and serves MIME, weak ETag, Last-Modified, decoded spaces, 301 redirect, index.html, and 404", async () => {
    const { root, pub } = createDirectoryFixture();
    try {
      let invalidMountErr: unknown;
      try {
        const badServer = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          routes: {
            "/static": { dir: pub },
          } as never,
        });
        badServer.stop(true);
      } catch (err) {
        invalidMountErr = err;
      }
      expect(invalidMountErr).toBeInstanceOf(TypeError);
      expect((invalidMountErr as Error).message).toContain(
        "To mount a directory, make sure the path ends in `/*`",
      );

      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        routes: {
          "/static/*": { dir: pub },
        },
      });

      try {
        const baseUrl = `http://127.0.0.1:${server.port}`;

        const helloRes = await fetch(`${baseUrl}/static/hello.txt`);
        expect(helloRes.status).toBe(200);
        expect(helloRes.headers.get("content-type")).toBe(
          "text/plain;charset=utf-8",
        );
        expect(helloRes.headers.get("etag")).toMatch(
          /^W\/"[0-9a-f]+-[0-9a-f]+"$/,
        );
        expect(helloRes.headers.get("last-modified")?.length).toBeGreaterThan(
          0,
        );
        expect(helloRes.headers.get("accept-ranges")).toBe("bytes");
        expect(await helloRes.text()).toBe("hello-directory-route");

        const spaceRes = await fetch(`${baseUrl}/static/my%20file.txt`);
        expect(spaceRes.status).toBe(200);
        expect(await spaceRes.text()).toBe("space-file-ok");

        const dirNoSlash = await fetch(`${baseUrl}/static/sub`, {
          redirect: "manual",
        });
        expect(dirNoSlash.status).toBe(301);
        expect(dirNoSlash.headers.get("location")).toBe("/static/sub/");

        const dirWithSlash = await fetch(`${baseUrl}/static/sub/`);
        expect(dirWithSlash.status).toBe(200);
        expect(dirWithSlash.headers.get("content-type")).toBe(
          "text/html;charset=utf-8",
        );
        expect(await dirWithSlash.text()).toBe("<h1>sub index</h1>");

        const missingRes = await fetch(`${baseUrl}/static/missing.txt`);
        expect(missingRes.status).toBe(404);
      } finally {
        server.stop(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects non-canonical request paths with 404 on the wire", async () => {
    const { root, pub } = createDirectoryFixture();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/static/*": { dir: pub },
      },
    });

    try {
      const port = server.port!;
      const nonCanonicalPaths = [
        "/static/./hello.txt",
        "/static/../outside.txt",
        "/static//hello.txt",
        "/static/sub%2Findex.html",
        "/static/%68ello.txt",
      ];
      for (const rawPath of nonCanonicalPaths) {
        const res = await sendRawHttpRequest({
          hostname: "127.0.0.1",
          port,
          rawTarget: rawPath,
        });
        expect(res.status, rawPath).toBe(404);
      }
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors 304 conditionals, Range 206/416, Last-Modified If-Range, and statCache: false", async () => {
    const { root, pub } = createDirectoryFixture();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/static/*": { dir: pub },
        "/nocache/*": { dir: pub, statCache: false },
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const helloRes = await fetch(`${baseUrl}/static/hello.txt`);
      const weakEtag = helloRes.headers.get("etag") ?? "";
      const lastModified = helloRes.headers.get("last-modified") ?? "";
      await helloRes.text();

      const inmRes = await fetch(`${baseUrl}/static/hello.txt`, {
        headers: { "If-None-Match": weakEtag },
      });
      expect(inmRes.status).toBe(304);
      expect(await inmRes.text()).toBe("");

      const imsRes = await fetch(`${baseUrl}/static/hello.txt`, {
        headers: { "If-Modified-Since": lastModified },
      });
      expect(imsRes.status).toBe(304);
      expect(await imsRes.text()).toBe("");

      const rangeRes = await fetch(`${baseUrl}/static/hello.txt`, {
        headers: { Range: "bytes=0-4" },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");
      expect(rangeRes.headers.get("content-range")).toBe("bytes 0-4/21");
      expect(await rangeRes.text()).toBe("hello");

      const oobRangeRes = await fetch(`${baseUrl}/static/hello.txt`, {
        headers: { Range: "bytes=999-1000" },
      });
      expect(oobRangeRes.status).toBe(416);
      expect(oobRangeRes.headers.get("content-range")).toBe("bytes */21");

      const ifRangeMatch = await fetch(`${baseUrl}/static/hello.txt`, {
        headers: { Range: "bytes=0-4", "If-Range": lastModified },
      });
      expect(ifRangeMatch.status).toBe(206);
      expect(await ifRangeMatch.text()).toBe("hello");

      const ifRangeStale = await fetch(`${baseUrl}/static/hello.txt`, {
        headers: {
          Range: "bytes=0-4",
          "If-Range": "Thu, 01 Jan 1970 00:00:00 GMT",
        },
      });
      expect(ifRangeStale.status).toBe(200);
      expect(await ifRangeStale.text()).toBe("hello-directory-route");

      const ifRangeWeakEtag = await fetch(`${baseUrl}/static/hello.txt`, {
        headers: { Range: "bytes=0-4", "If-Range": weakEtag },
      });
      expect(ifRangeWeakEtag.status).toBe(200);
      expect(await ifRangeWeakEtag.text()).toBe("hello-directory-route");

      const nocacheBefore = await fetch(`${baseUrl}/nocache/hello.txt`);
      const etagBefore = nocacheBefore.headers.get("etag");
      expect(nocacheBefore.status).toBe(200);
      await nocacheBefore.text();

      writeFileSync(join(pub, "hello.txt"), "updated-body-value");
      const nocacheAfter = await fetch(`${baseUrl}/nocache/hello.txt`);
      expect(nocacheAfter.status).toBe(200);
      expect(nocacheAfter.headers.get("etag")).not.toBe(etagBefore);
      expect(await nocacheAfter.text()).toBe("updated-body-value");
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("case-sensitive routing diverges from case-insensitive filesystems", async () => {
    const { root, pub } = createDirectoryFixture();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/static/admin/*": () => new Response("blocked", { status: 403 }),
        "/static/*": { dir: pub },
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      const exactBlocked = await fetch(`${baseUrl}/static/admin/secret.txt`);
      expect(exactBlocked.status).toBe(403);
      expect(await exactBlocked.text()).toBe("blocked");

      const upperCaseProbe = await fetch(`${baseUrl}/static/Admin/secret.txt`);
      const fsCaseInsensitive = existsSync(join(pub, "Admin", "secret.txt"));
      if (fsCaseInsensitive) {
        expect(upperCaseProbe.status).toBe(200);
        expect(await upperCaseProbe.text()).toBe("ADMIN-SECRET");
      } else {
        expect(upperCaseProbe.status).toBe(404);
      }
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("records platform symlink behavior vs containedAssetPath realpath clamping", async () => {
    const { root, pub } = createDirectoryFixture();
    expect(containedAssetPath(pub, "rel-escape.txt")).toBeNull();
    expect(containedAssetPath(pub, "abs-escape.txt")).toBeNull();

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/static/*": { dir: pub },
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const relEscape = await fetch(`${baseUrl}/static/rel-escape.txt`);
      const absEscape = await fetch(`${baseUrl}/static/abs-escape.txt`);
      const relClamp = await fetch(`${baseUrl}/static/rel-clamp.txt`);
      const absInRoot = await fetch(`${baseUrl}/static/abs-inroot.txt`);

      if (process.platform === "darwin") {
        // Measured drift on darwin: directory routes follow symlinks out of `dir`.
        expect(relEscape.status).toBe(200);
        expect(await relEscape.text()).toBe("SECRET-OUTSIDE");
        expect(absEscape.status).toBe(200);
        expect(await absEscape.text()).toBe("SECRET-OUTSIDE");
        expect(relClamp.status).toBe(404);
        expect(absInRoot.status).toBe(404);
      } else if (process.platform === "linux") {
        expect(relEscape.status).toBe(404);
        expect(absEscape.status).toBe(404);
        expect(relClamp.status).toBe(200);
        expect(await relClamp.text()).toBe("INSIDE-ROOT-CLAMP");
        expect(absInRoot.status).toBe(200);
        expect(await absInRoot.text()).toBe("IN-ROOT-VAR-DATA");
      }
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sendRawHttpRequest decodes live Content-Length GET/POST echo and chunked stream responses", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/ping": new Response("pong-ok", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
        "/echo": {
          POST: async (req) => {
            const payload = await req.text();
            return new Response(`echo:${payload}`, {
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          },
        },
        "/stream": () => {
          const stream = new ReadableStream({
            async start(controller) {
              const enc = new TextEncoder();
              await Bun.sleep(2);
              controller.enqueue(enc.encode("chunk-one-"));
              await Bun.sleep(2);
              controller.enqueue(enc.encode("chunk-two"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        },
      },
    });

    try {
      const port = server.port!;

      const getRes = await sendRawHttpRequest({
        hostname: "127.0.0.1",
        port,
        rawTarget: "/ping",
      });
      expect(getRes.status).toBe(200);
      expect(getRes.framing).toBe("content-length");
      expect(getRes.contentLength).toBe(7);
      expect(getRes.text()).toBe("pong-ok");

      const postRes = await sendRawHttpRequest({
        hostname: "127.0.0.1",
        port,
        rawTarget: "/echo",
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "raw-tcp-payload",
      });
      expect(postRes.status).toBe(200);
      expect(postRes.framing).toBe("content-length");
      expect(postRes.contentLength).toBe("echo:raw-tcp-payload".length);
      expect(postRes.text()).toBe("echo:raw-tcp-payload");

      const streamRes = await sendRawHttpRequest({
        hostname: "127.0.0.1",
        port,
        rawTarget: "/stream",
      });
      expect(streamRes.status).toBe(200);
      expect(streamRes.framing).toBe("chunked");
      expect(streamRes.contentLength).toBeNull();
      expect(streamRes.text()).toBe("chunk-one-chunk-two");
    } finally {
      server.stop(true);
    }
  });
});
