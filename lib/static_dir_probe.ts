/**
 * @file lib/static_dir_probe.ts
 * @description Read-only inventory and live HTTP contract prober for Bun's
 * native `"/static/*": { dir }` wildcard mount on the local dev server.
 */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface StaticDirectoryFileInfo {
  readonly relativePath: string;
  readonly urlPath: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly lastModifiedIso: string | null;
}

export interface StaticDirectoryProbeCheck {
  readonly name: string;
  readonly requestPath: string;
  readonly expectedStatus: number;
  readonly status: number | null;
  readonly ok: boolean;
  readonly detail: string;
}

export interface StaticDirectoryHealthProbe {
  readonly wildcardPath: string;
  readonly dir: string;
  readonly caseInsensitiveHostFs: boolean;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly StaticDirectoryFileInfo[];
  readonly liveCheck: {
    readonly origin: string;
    readonly elapsedMs: number;
    readonly allPassed: boolean;
    readonly etag: string | null;
    readonly contentRange: string | null;
    readonly checks: readonly StaticDirectoryProbeCheck[];
  } | null;
}

function encodeUrlPathSegments(relativePath: string): string {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function assertReadableStaticDir(dir: string): string {
  const resolved = resolve(dir);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch (err) {
    throw new Error(
      `ERR_STATIC_DIR_MISSING: static directory "${resolved}" (from cwd "${process.cwd()}") cannot be opened: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `ERR_STATIC_DIR_NOT_DIRECTORY: "${resolved}" is not a directory`,
    );
  }
  return resolved;
}

/** Inventory all non-dot files served under `dir` for the `/static/*` directory route. */
export async function inventoryStaticDirectory(
  staticDir: string,
  wildcardPath = "/static/*",
): Promise<StaticDirectoryHealthProbe> {
  if (!wildcardPath.startsWith("/") || !wildcardPath.endsWith("/*")) {
    throw new Error(
      `ERR_STATIC_DIR_WILDCARD: expected "/prefix/*", got ${JSON.stringify(wildcardPath)}`,
    );
  }
  const resolvedDir = assertReadableStaticDir(staticDir);
  const prefix = wildcardPath.slice(0, -1);
  const glob = new Bun.Glob("**/*");
  const relPaths: string[] = [];
  for await (const rel of glob.scan({
    cwd: resolvedDir,
    dot: false,
    onlyFiles: true,
  })) {
    relPaths.push(rel.replace(/\\/g, "/"));
  }
  relPaths.sort((a, b) => a.localeCompare(b));

  const files: StaticDirectoryFileInfo[] = [];
  let totalBytes = 0;
  for (const relativePath of relPaths) {
    const file = Bun.file(join(resolvedDir, relativePath));
    const stat = await file.stat();
    totalBytes += stat.size;
    files.push({
      relativePath,
      urlPath: `${prefix}${encodeUrlPathSegments(relativePath)}`,
      bytes: stat.size,
      contentType: file.type || "application/octet-stream",
      lastModifiedIso: Number.isFinite(file.lastModified)
        ? new Date(file.lastModified).toISOString()
        : null,
    });
  }

  return {
    wildcardPath,
    dir: resolvedDir,
    caseInsensitiveHostFs:
      process.platform === "darwin" || process.platform === "win32",
    totalFiles: files.length,
    totalBytes,
    files,
    liveCheck: null,
  };
}

/**
 * Probe the live `/static/*` mount (`200`, `304 If-None-Match`, `206 Range`, and
 * `404` non-canonical `%2e%2e` traversal guard).
 */
export async function probeStaticDirectoryRoute(
  origin: string,
  staticDir: string,
  wildcardPath = "/static/*",
): Promise<StaticDirectoryHealthProbe> {
  const started = performance.now();
  const base = await inventoryStaticDirectory(staticDir, wildcardPath);
  const baseOrigin = origin.replace(/\/$/, "");
  const prefix = wildcardPath.slice(0, -1);
  const target =
    base.files.find((f) => f.relativePath.endsWith(".html")) ??
    base.files.find((f) => f.relativePath.endsWith(".md")) ??
    base.files[0];

  const checks: StaticDirectoryProbeCheck[] = [];
  let observedEtag: string | null = null;
  let observedContentRange: string | null = null;

  if (target !== undefined) {
    try {
      const res = await fetch(`${baseOrigin}${target.urlPath}`, {
        signal: AbortSignal.timeout(1500),
      });
      observedEtag = res.headers.get("etag");
      checks.push({
        name: "GET 200 + ETag + Accept-Ranges",
        requestPath: target.urlPath,
        expectedStatus: 200,
        status: res.status,
        ok: res.status === 200,
        detail: `${res.headers.get("content-type") ?? "—"} · etag ${observedEtag ?? "none"} · ranges ${res.headers.get("accept-ranges") ?? "none"}`,
      });
    } catch (err) {
      checks.push({
        name: "GET 200 + ETag + Accept-Ranges",
        requestPath: target.urlPath,
        expectedStatus: 200,
        status: null,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    if (observedEtag !== null) {
      try {
        const res304 = await fetch(`${baseOrigin}${target.urlPath}`, {
          headers: { "if-none-match": observedEtag },
          signal: AbortSignal.timeout(1500),
        });
        checks.push({
          name: "Conditional GET 304 (If-None-Match)",
          requestPath: target.urlPath,
          expectedStatus: 304,
          status: res304.status,
          ok: res304.status === 304,
          detail: `etag ${observedEtag}`,
        });
      } catch (err) {
        checks.push({
          name: "Conditional GET 304 (If-None-Match)",
          requestPath: target.urlPath,
          expectedStatus: 304,
          status: null,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (target.bytes >= 10) {
      try {
        const res206 = await fetch(`${baseOrigin}${target.urlPath}`, {
          headers: { range: "bytes=0-9" },
          signal: AbortSignal.timeout(1500),
        });
        observedContentRange = res206.headers.get("content-range");
        const bytes = await res206.arrayBuffer();
        checks.push({
          name: "Partial Range GET 206 (bytes=0-9)",
          requestPath: target.urlPath,
          expectedStatus: 206,
          status: res206.status,
          ok: res206.status === 206 && bytes.byteLength === 10,
          detail: `${observedContentRange ?? "no content-range"} · ${bytes.byteLength}B`,
        });
      } catch (err) {
        checks.push({
          name: "Partial Range GET 206 (bytes=0-9)",
          requestPath: target.urlPath,
          expectedStatus: 206,
          status: null,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const traversalPath = `${prefix}%2e%2e/${target?.relativePath ?? "status.html"}`;
  try {
    const res404 = await fetch(`${baseOrigin}${traversalPath}`, {
      signal: AbortSignal.timeout(1500),
    });
    checks.push({
      name: "Non-Canonical Dotdot Guard (404)",
      requestPath: traversalPath,
      expectedStatus: 404,
      status: res404.status,
      ok: res404.status === 404,
      detail: "encoded .. rejected before fallback handler",
    });
  } catch (err) {
    checks.push({
      name: "Non-Canonical Dotdot Guard (404)",
      requestPath: traversalPath,
      expectedStatus: 404,
      status: null,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    ...base,
    liveCheck: {
      origin: baseOrigin,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      allPassed: checks.length > 0 && checks.every((check) => check.ok),
      etag: observedEtag,
      contentRange: observedContentRange,
      checks,
    },
  };
}
