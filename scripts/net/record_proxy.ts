#!/usr/bin/env bun
/**
 * @file scripts/net/record_proxy.ts
 * @description HTTP recording proxy for Bun's own clients, unified around `Blob` (`lib/blob_ingest.ts`).
 *
 *   bun run proxy:record --allow 127.0.0.1
 *   fetch("http://127.0.0.1:8081/path", { proxy: "http://127.0.0.1:8080" })
 *
 * Records method, URL, headers (redacted), request bytes + SHA-256, status, response headers,
 * response bytes + SHA-256 + MIME type, and duration via `inspectBlobSource()`. When `--promote-dir <dir>`
 * is passed, 2xx read-only `/cloud/api/` responses are also promoted into `CaptureStore` via
 * `buildCaptureRecordFromBlob()`.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildCaptureRecordFromBlob,
  inspectBlobSource,
} from "../../lib/blob_ingest.ts";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import { CaptureStore } from "../capture/recorder.ts";
import { redactHeaders } from "../capture/redact.ts";
import type { HttpMethod } from "../capture/types.ts";

const HELP = `
proxy:record — HTTP recording proxy

Options:
  --port <n>            Listen port (default: 8080)
  --allow <hosts>       Comma-separated allowlist (default: 127.0.0.1,localhost)
  --out <dir>           Journal directory (default: scratch/proxy)
  --promote-dir <dir>   Optional CaptureStore directory for 2xx /cloud/api/ GET/POST captures
  --quiet               Do not print per-request lines
  -h, --help            This text

Examples:
  bun run proxy:record --allow 127.0.0.1
  bun run proxy:record --port 9090 --allow api.example.com --promote-dir docs/evidence/captures

Use it with Bun's fetch: fetch(url, { proxy: "http://127.0.0.1:8080" }). Plain HTTP only, and Bun
bypasses the proxy for loopback targets, so test against a non-loopback host.
`.trim();

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function forwardableHeaders(headers: Headers): Headers {
  const clean = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    // A proxy must not relay the client's Host: fetch derives it from the target URL. Before
    // Bun 1.4.1 a relayed Host also selected TLS verification, which made this injectable.
    if (lower === "host" || HOP_BY_HOP.has(lower)) continue;
    clean.set(name, value);
  }
  return clean;
}

export interface ProxyHandlerOptions {
  readonly allow: ReadonlySet<string>;
  readonly journalPath?: string;
  readonly promoteStore?: CaptureStore | null;
  readonly quiet?: boolean;
  readonly fetcher?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface ProxyJournalRecord {
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly requestBytes: number;
  readonly requestBodySha256: string | null;
  readonly responseBytes: number;
  readonly responseBodySha256: string;
  readonly responseMimeType: string;
  readonly durationMs: number;
  readonly requestHeaders: Record<string, string>;
  readonly responseHeaders: Record<string, string>;
  readonly promotedCaptureHash: string | null;
}

/**
 * Handles a single proxied `Request` using unified `Blob` inspection (`inspectBlobSource`)
 * and optional `CaptureStore` promotion (`buildCaptureRecordFromBlob`).
 */
export async function handleProxyRequest(
  request: Request,
  options: ProxyHandlerOptions,
): Promise<{ response: Response; journalRecord: ProxyJournalRecord | null }> {
  const url = new URL(request.url);
  if (!options.allow.has(url.hostname.toLowerCase())) {
    return {
      response: new Response(
        `proxy: host ${url.hostname} is not in the allowlist`,
        { status: 403 },
      ),
      journalRecord: null,
    };
  }

  const started = performance.now();
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const reqContentType =
    request.headers.get("content-type") ?? "application/octet-stream";
  const reqInspected = hasBody
    ? await inspectBlobSource(await request.blob(), reqContentType)
    : null;
  const requestHeaders = forwardableHeaders(request.headers);

  const fetcher = options.fetcher ?? fetch;
  const upstream = await fetcher(url, {
    method: request.method,
    headers: requestHeaders,
    body: reqInspected?.blob,
    redirect: "manual",
    // Keep the body encoded so the forwarded content-encoding header stays truthful.
    decompress: false,
  } as RequestInit);

  const resContentType =
    upstream.headers.get("content-type") ?? "application/octet-stream";
  const resInspected = await inspectBlobSource(upstream, resContentType);
  const durationMs = Math.round(performance.now() - started);

  const rawRequestHeaderMap = Object.fromEntries(
    [...request.headers].map(([name, value]) => [name, value]),
  );
  const redaction = redactHeaders(rawRequestHeaderMap);
  const capturedAt = new Date().toISOString();

  let promotedCaptureHash: string | null = null;
  const methodUpper = request.method.toUpperCase();
  if (
    options.promoteStore &&
    upstream.status >= 200 &&
    upstream.status <= 299 &&
    url.pathname.includes("/cloud/api/") &&
    (methodUpper === "GET" || methodUpper === "POST") &&
    !url.pathname.endsWith("/PendingDelete")
  ) {
    const reqBodyText =
      reqInspected !== null ? await reqInspected.blob.text() : null;
    const captureRecord = await buildCaptureRecordFromBlob({
      mode: "live",
      capturedAt,
      operation: {
        path: url.pathname,
        method: methodUpper as HttpMethod,
      },
      request: {
        url: url.href,
        method: methodUpper as HttpMethod,
        headers: rawRequestHeaderMap,
        contentType: reqContentType,
        body: reqBodyText,
      },
      response: {
        source: resInspected.blob,
        status: upstream.status,
        headers: Object.fromEntries(upstream.headers),
        contentType: resInspected.mimeType,
        wireBytes: resInspected.size,
      },
      provenance: {
        portalHost: url.host,
        proxy: "env",
        auth:
          rawRequestHeaderMap["cookie"] || rawRequestHeaderMap["authorization"]
            ? "cookie"
            : "none",
        bunVersion: Bun.version,
      },
      samples: 1,
    });
    const written = await options.promoteStore.write(captureRecord);
    await options.promoteStore.finalize();
    promotedCaptureHash = written.captureHash;
  }

  const journalRecord: ProxyJournalRecord = {
    at: capturedAt,
    method: request.method,
    url: url.href,
    status: upstream.status,
    requestBytes: reqInspected?.size ?? 0,
    requestBodySha256: reqInspected?.sha256 ?? null,
    responseBytes: resInspected.size,
    responseBodySha256: resInspected.sha256,
    responseMimeType: resInspected.mimeType,
    durationMs,
    requestHeaders: redaction.clean,
    responseHeaders: Object.fromEntries(upstream.headers),
    promotedCaptureHash,
  };

  if (options.journalPath) {
    await appendFile(
      options.journalPath,
      `${JSON.stringify(journalRecord)}\n`,
      "utf8",
    );
  }
  if (!options.quiet) {
    console.log(
      `${journalRecord.method.padEnd(6)} ${String(journalRecord.status).padEnd(4)} ${journalRecord.durationMs} ms  ${url.pathname}  ${journalRecord.requestBytes}→${journalRecord.responseBytes} B`,
    );
  }

  // `Response` rejects a body on null-body statuses (1xx, 204, 304); relay those without one.
  const response =
    upstream.status === 204 || upstream.status === 304
      ? new Response(null, {
          status: upstream.status,
          headers: forwardableHeaders(upstream.headers),
        })
      : new Response(resInspected.blob, {
          status: upstream.status,
          headers: forwardableHeaders(upstream.headers),
        });

  return {
    response,
    journalRecord,
  };
}

if (import.meta.main) {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ["--port", "--allow", "--out", "--promote-dir"],
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    process.exit(0);
  }

  const port = Number(flagValue(parsed, "--port", "8080")) || 8080;
  const allow = new Set(
    flagValue(parsed, "--allow", "127.0.0.1,localhost")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== ""),
  );
  const outRoot = flagValue(parsed, "--out", "scratch/proxy");
  const promoteDir = flagValue(parsed, "--promote-dir", "");
  const quiet = hasFlag(parsed, "--quiet");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const journal = join(outRoot, `${stamp}.jsonl`);
  await mkdir(dirname(journal), { recursive: true });

  const promoteStore =
    promoteDir !== "" ? new CaptureStore({ root: promoteDir }) : null;

  const server = Bun.serve({
    port,
    async fetch(request) {
      const { response } = await handleProxyRequest(request, {
        allow,
        journalPath: journal,
        promoteStore,
        quiet,
      });
      return response;
    },
  });

  console.error(
    `proxy:record: http://127.0.0.1:${server.port} · allow ${[...allow].join(",")} · journal ${journal}${promoteDir ? ` · promote ${promoteDir}` : ""}`,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.stop(true);
      process.exit(0);
    });
  }
}
