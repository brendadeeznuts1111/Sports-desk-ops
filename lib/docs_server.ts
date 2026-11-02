/**
 * @file lib/docs_server.ts
 * @description Serve rendered docs from the cache manifest, with zstd content negotiation.
 *
 * The manifest is re-read only when its mtime changes, so a rebuild is picked up without a restart
 * and the common request path pays one `stat` rather than a JSON parse. Entries whose cache file is
 * gone return 404 instead of an empty 200: a manifest is a claim, and the file has to back it.
 */

import { join } from "node:path";
import {
  type DocsManifest,
  type ManifestEntry,
  readDocsManifest,
} from "./docs_render_cache.ts";

export interface DocsServerOptions {
  readonly cacheDir: string;
  readonly manifestPath: string;
  readonly port?: number;
  readonly hostname?: string;
}

/**
 * Whether a request accepts `coding`.
 *
 * Parses `q=` rather than substring-matching: `zstd;q=0` means the client explicitly refused it,
 * and `gzip, zstd;q=0.1` still accepts it. A missing header refuses everything.
 */
export function acceptsEncoding(
  header: string | null,
  coding: string,
): boolean {
  if (!header) return false;
  let accepted: number | undefined;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().toLowerCase().split(";");
    if (rawName !== coding.toLowerCase()) continue;
    let quality = 1;
    for (const param of params) {
      const [name, value] = param.trim().split("=");
      if (name === "q" && value !== undefined) {
        const parsed = Number(value);
        quality = Number.isFinite(parsed) ? parsed : 1;
      }
    }
    accepted = quality;
  }
  return accepted !== undefined && accepted > 0;
}

export interface DocsServer {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly url: URL;
  readonly manifest: () => DocsManifest | null;
  /** Load the manifest now (the server otherwise loads it on the first request). */
  readonly ready: () => Promise<DocsManifest | null>;
}

export function createDocsServer(options: DocsServerOptions): DocsServer {
  let current: DocsManifest | null = null;
  let currentMtime = Number.NEGATIVE_INFINITY;

  async function load(): Promise<DocsManifest | null> {
    const stat = await Bun.file(options.manifestPath)
      .stat()
      .catch(() => null);
    if (!stat) {
      current = null;
      currentMtime = Number.NEGATIVE_INFINITY;
      return null;
    }
    if (current !== null && stat.mtimeMs === currentMtime) return current;
    current = await readDocsManifest(options.manifestPath);
    currentMtime = stat.mtimeMs;
    return current;
  }

  const sourceHeader = (entry: ManifestEntry): string =>
    entry.sources.join(", ");

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",

    routes: {
      "/health": async () => {
        const manifest = await load();
        if (!manifest) {
          return Response.json(
            { ok: false, reason: "manifest unavailable" },
            { status: 503 },
          );
        }
        return Response.json({
          ok: true,
          buildId: manifest.buildId,
          entries: Object.keys(manifest.entries).length,
        });
      },

      "/docs": async () => {
        const manifest = await load();
        if (!manifest) {
          return Response.json(
            { ok: false, reason: "manifest unavailable" },
            { status: 503 },
          );
        }
        const rows = Object.entries(manifest.entries).flatMap(([key, entry]) =>
          entry.sources.map((source) => ({
            key,
            source,
            url: `/docs/${key}`,
            htmlBytes: entry.htmlBytes,
            zstBytes: entry.zstdBytes,
          })),
        );
        rows.sort((a, b) => a.source.localeCompare(b.source));
        return Response.json({ buildId: manifest.buildId, docs: rows });
      },

      "/docs/:key": async (request) => {
        const manifest = await load();
        if (!manifest) {
          return new Response("manifest unavailable", { status: 503 });
        }
        const key = request.params.key;
        // `entries[key]` also answers for `__proto__`/`constructor`; only an own key is a page.
        const entry = Object.hasOwn(manifest.entries, key)
          ? manifest.entries[key]
          : undefined;
        if (!entry) return new Response("not found", { status: 404 });

        const etag = `"${key}"`;
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }

        const wantsZstd = acceptsEncoding(
          request.headers.get("accept-encoding"),
          "zstd",
        );
        const htmlPath = join(options.cacheDir, `${key}.html`);
        const zstdPath = join(options.cacheDir, `${key}.html.zst`);

        if (wantsZstd) {
          const file = Bun.file(zstdPath);
          if (!(await file.exists())) {
            return new Response("cached body missing", { status: 404 });
          }
          // Read into memory on purpose: Bun serves Range for File bodies, and a byte range of a
          // zstd stream cannot be decompressed by the client.
          const body = await file.arrayBuffer();
          return new Response(body, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-encoding": "zstd",
              "content-length": String(body.byteLength),
              vary: "accept-encoding",
              "cache-control": "public, max-age=31536000, immutable",
              "accept-ranges": "none",
              etag,
              "x-source": sourceHeader(entry),
            },
          });
        }

        const file = Bun.file(htmlPath);
        if (!(await file.exists())) {
          return new Response("cached body missing", { status: 404 });
        }
        return new Response(file, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            vary: "accept-encoding",
            "cache-control": "public, max-age=31536000, immutable",
            "accept-ranges": "bytes",
            etag,
            "x-source": sourceHeader(entry),
          },
        });
      },
    },

    fetch() {
      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    url: server.url,
    manifest: () => current,
    ready: load,
  };
}
