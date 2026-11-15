#!/usr/bin/env bun
/**
 * Serve `dist/dashboard` for local review, proxying `/api/*` and `/health` to the desk daemon.
 *
 *   bun run desk:preview                     # http://127.0.0.1:4174
 *   PORT=4180 bun run desk:preview
 *   DASH_PREVIEW_TLS_KEY=… DASH_PREVIEW_TLS_CERT=… bun run desk:preview
 *
 * Static serving (asset index, cache policy, SPA fallback, 404 for dotted misses) lives in
 * `lib/dashboard_static.ts`, shared with the daemon's `/app` route. This script only adds the API
 * proxy and the TLS opt-in.
 */
import { pickApiTarget } from "../lib/dashboard_preview_routing.ts";
import { serveDashboardAsset } from "../lib/dashboard_static.ts";

const PORT = Number(process.env.PORT ?? 4174);
const API = process.env.DESK_API ?? "http://127.0.0.1:4020";
const FEEDS_API = process.env.DASH_API_FEEDS ?? "";
const ROOT = process.env.DASHBOARD_ROOT ?? "dist/dashboard";
const TLS_KEY = process.env.DASH_PREVIEW_TLS_KEY;
const TLS_CERT = process.env.DASH_PREVIEW_TLS_CERT;
const tls =
  TLS_KEY && TLS_CERT
    ? { key: Bun.file(TLS_KEY), cert: Bun.file(TLS_CERT) }
    : undefined;

const server = Bun.serve({
  port: PORT,
  ...(tls ? { tls } : {}),
  error(err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return new Response("not found", { status: 404 });
    }
    console.error("preview error:", err);
    return new Response("server error", { status: 500 });
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && srv.upgrade(req)) {
      return undefined;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      const target = pickApiTarget(url.pathname, {
        api: API,
        feedsApi: FEEDS_API,
      });
      // Identity upstream: Bun's fetch decompresses the body, so forwarding a compressed
      // upstream's content-encoding/content-length makes the browser gunzip plain bytes
      // ("Load failed"). Ask for identity and drop the stale framing headers.
      const headers = new Headers(req.headers);
      headers.set("accept-encoding", "identity");
      const upstream = await fetch(target + url.pathname + url.search, {
        method: req.method,
        headers,
        body:
          req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      });
      const outHeaders = new Headers(upstream.headers);
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-length");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    }
    const served = await serveDashboardAsset(url.pathname, { root: ROOT });
    return served ?? new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "ack", topics: ["preview"] }));
    },
    message(ws, message) {
      try {
        const parsed =
          typeof message === "string"
            ? (JSON.parse(message) as { action?: unknown; topics?: unknown })
            : null;
        if (parsed?.action === "subscribe") {
          ws.send(
            JSON.stringify({
              type: "ack",
              topics: Array.isArray(parsed.topics) ? parsed.topics : [],
            }),
          );
        }
      } catch {
        // Ignore malformed preview client frames.
      }
    },
  },
});

console.log(
  `preview → ${server.url.href}  (api → ${API}${FEEDS_API ? `, feeds → ${FEEDS_API}` : ""}, tls=${tls ? "on" : "off"}, root=${ROOT})`,
);
