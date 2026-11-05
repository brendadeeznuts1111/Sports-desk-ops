/**
 * Host half of the SportsDesk desk-panel bundle.
 *
 * It registers same-origin **read-only GET proxies** so the Client module can
 * measure the local desk service from a **remotely served** Harness UI. The
 * Harness web app is published through a tunnel (`--public-url`, Cloudflare
 * Access), so the browser's `127.0.0.1` is the *viewer's* machine, not the desk
 * host: a direct loopback fetch from a remote browser answers
 * connection-refused and the panel reads "service down" while the service is
 * healthy. The Harness server is the process on the desk host, so it proxies
 * instead.
 *
 * Routes (GET only, same-origin, allowlisted, one shared handler):
 *
 *   /api/sportsdesk-desk/health    -> http://127.0.0.1:4020/health
 *   /api/sportsdesk-desk/status    -> http://127.0.0.1:4020/api/status
 *   /api/sportsdesk-desk/graph     -> http://127.0.0.1:4020/api/graph/summary
 *   /api/sportsdesk-desk/kpis      -> http://127.0.0.1:4020/api/kpis
 *   /api/sportsdesk-desk/execution -> http://127.0.0.1:4020/api/execution/plan
 *   /api/sportsdesk-desk/stream    -> http://127.0.0.1:4020/api/graph/stream
 *
 * The five JSON routes share one buffered handler: GET only (405 otherwise); a
 * present Origin must equal the carrier origin (a missing Origin is allowed,
 * same-origin fetch omits it); a 4 s upstream abort bound; forward the upstream
 * status, content-type and body; `cache-control: no-store` plus the
 * `x-sportsdesk-desk-proxy` marker on every answer; a forwarded document over
 * 512 KiB becomes 502 `response_too_large` instead of being forwarded; an
 * unreachable/aborted upstream becomes 502 `desk service unreachable`.
 *
 * The stream route deliberately does NOT buffer: it forwards the desk's own
 * Server-Sent Events body chunk by chunk, because buffering an event stream
 * would hold every frame until the connection closed. It bounds only the wait
 * for upstream response headers (4 s), then owns the connection until the desk
 * or the browser ends it, aborting the upstream read when the browser goes
 * away and on bundle disposal.
 *
 * No credentials are read, no mutations are exposed, and no other path is
 * registered: the desk service stays the single implementation, and the bundle
 * stays independent of the `dsh-plugin-sportsdesk-ops` tools bundle and the
 * `dsh-plugin-ui` composer row.
 *
 * @module dsh-plugin-sportsdesk-desk-panel
 */

/** The desk service the operator runs with `bun run serve`. */
const DESK_ORIGIN = "http://127.0.0.1:4020";
const PROXY_PREFIX = "/api/sportsdesk-desk";
/**
 * Marks a response as produced by this proxy. The Client module uses it to
 * tell "the Host half is absent, this 404 is the generic Harness 404" apart
 * from "the desk service itself answered 404 through the proxy" — the second
 * must classify as a missing route, not fall back to a loopback probe the
 * remote browser cannot reach.
 */
const PROXY_HEADER = "x-sportsdesk-desk-proxy";
/** Bound one upstream probe; the service answers in milliseconds when up. */
const PROBE_TIMEOUT_MS = 4_000;
/**
 * Largest upstream document this proxy forwards. Measured 2026-11-04: the
 * largest allowlisted document is `/api/graph/summary` at ~12.7 KB, so this is
 * a runaway-response guard, not a working limit.
 */
const MAX_BODY_BYTES = 512 * 1024;

/** The complete allowlist of buffered JSON routes: proxy path -> upstream path. */
const ROUTES = Object.freeze([
  Object.freeze({ path: `${PROXY_PREFIX}/health`, target: "/health" }),
  Object.freeze({ path: `${PROXY_PREFIX}/status`, target: "/api/status" }),
  Object.freeze({
    path: `${PROXY_PREFIX}/graph`,
    target: "/api/graph/summary",
  }),
  Object.freeze({ path: `${PROXY_PREFIX}/kpis`, target: "/api/kpis" }),
  Object.freeze({
    path: `${PROXY_PREFIX}/execution`,
    target: "/api/execution/plan",
  }),
]);

/**
 * The one streaming route. The desk answers it with Server-Sent Events
 * (`event: summary` frames plus `: heartbeat` comments), so the proxy forwards
 * the body instead of buffering it like the JSON routes above.
 */
const STREAM_ROUTE = Object.freeze({
  path: `${PROXY_PREFIX}/stream`,
  target: "/api/graph/stream",
});
/**
 * The stream stays open for as long as the desk keeps it open, so the 4 s
 * request bound applies only to the wait for upstream response headers.
 */
const STREAM_HEADER_TIMEOUT_MS = 4_000;

/**
 * Answer with a JSON document plus the proxy contract headers: a no-store
 * cache policy and the marker naming the upstream path on every answer,
 * including refusals and upstream failures.
 * @param {import('node:http').ServerResponse} res
 * @param {string} target - upstream path this route allowlists.
 * @param {number} status - HTTP status to send.
 * @param {object} payload - JSON body.
 */
function sendJson(res, target, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    [PROXY_HEADER]: target,
  });
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  // Headless compositions have no browser carrier; the panel does not exist
  // there. The guard also keeps the dependency-free loader harness working.
  if (typeof ctx.inject !== "function") return;
  const routeDisposers = [];
  /**
   * In-flight upstream streams, so disposal aborts them instead of leaving a
   * detached read running against the desk after the bundle is gone.
   */
  const activeStreams = new Set();
  let disposed = false;

  ctx.inject(["webServer"], (serverCtx) => {
    const webServer = serverCtx.webServer;
    let origin = null;
    try {
      origin = webServer.getOrigin();
    } catch {
      origin = null;
    }
    /** GETs may omit Origin (same-origin fetch); a present Origin must match. */
    const sameOrigin = (req) => {
      const requestOrigin =
        typeof req.headers.origin === "string" ? req.headers.origin : null;
      if (origin === null) return requestOrigin === null;
      return requestOrigin === null || requestOrigin === origin;
    };

    /**
     * One shared handler for every allowlisted route: method + origin + fetch +
     * size cap + forwarding. `target` is the route's fixed upstream path, never
     * caller input, so the proxy cannot be pointed at another destination.
     */
    const handle = async (req, res, target) => {
      if (req.method !== "GET") {
        sendJson(res, target, 405, { error: "method_not_allowed" });
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, target, 403, { error: "origin_refused" });
        return;
      }
      try {
        const upstream = await fetch(`${DESK_ORIGIN}${target}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const body = await upstream.text();
        const byteLength = new TextEncoder().encode(body).byteLength;
        if (byteLength > MAX_BODY_BYTES) {
          sendJson(res, target, 502, {
            error: "response_too_large",
            detail: `upstream body ${byteLength} bytes exceeds ${MAX_BODY_BYTES} bytes`,
          });
          return;
        }
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
          [PROXY_HEADER]: target,
        });
        res.end(body);
      } catch (error) {
        // The desk service is down or unreachable from the Harness host. Say so
        // with a status the page classifies as down, never as healthy.
        sendJson(res, target, 502, {
          error: "desk service unreachable",
          detail: String((error && error.message) || error),
        });
      }
    };

    /**
     * Register an upstream stream so disposal can abort it.
     */
    const trackStream = (controller) => {
      activeStreams.add(controller);
      return () => activeStreams.delete(controller);
    };

    /**
     * Streaming handler for `STREAM_ROUTE.target`. It forwards the desk's own
     * Server-Sent Events bytes as they arrive: no `text()`/buffer step, no size
     * cap (a heartbeat is ~24 bytes, a summary frame ~13 KB and only sent when
     * the desk's stat fingerprint changes), and no attempt to synthesize
     * frames. A non-200 upstream is answered as JSON so the client can tell
     * "this build has no stream route" (404) from "the desk is unreachable"
     * (502); once headers are sent, any failure just ends the response and the
     * browser reconnects.
     */
    const handleStream = async (req, res) => {
      const target = STREAM_ROUTE.target;
      if (req.method !== "GET") {
        sendJson(res, target, 405, { error: "method_not_allowed" });
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, target, 403, { error: "origin_refused" });
        return;
      }
      const controller = new AbortController();
      const untrack = trackStream(controller);
      let clientClosed = false;
      let headersSent = false;
      const onClientClose = () => {
        clientClosed = true;
        controller.abort();
        if (headersSent) {
          try {
            res.end();
          } catch {
            // The socket is already gone; nothing left to close.
          }
        }
      };
      if (typeof req.once === "function") req.once("close", onClientClose);
      // Bounds only the wait for upstream headers; a live stream outlives it.
      const headerTimer = setTimeout(
        () => controller.abort(),
        STREAM_HEADER_TIMEOUT_MS,
      );
      try {
        const upstream = await fetch(`${DESK_ORIGIN}${target}`, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        clearTimeout(headerTimer);
        if (upstream.status !== 200) {
          const detail = await upstream.text().catch(() => "");
          if (clientClosed) return;
          sendJson(res, target, upstream.status, {
            error:
              upstream.status === 404
                ? "stream_route_missing"
                : "stream_unavailable",
            detail:
              detail === ""
                ? `upstream answered ${upstream.status}`
                : detail.slice(0, 200),
          });
          return;
        }
        res.writeHead(200, {
          "content-type":
            upstream.headers.get("content-type") ??
            "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          // Tells nginx-style intermediaries not to buffer the event stream;
          // the Cloudflare tunnel in front of the GUI passes it through.
          "x-accel-buffering": "no",
          [PROXY_HEADER]: target,
        });
        headersSent = true;
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        const body = upstream.body;
        if (body === null || typeof body.getReader !== "function") {
          res.end();
          return;
        }
        const reader = body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          const writable = res.write(value);
          if (!writable && typeof res.once === "function") {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
        res.end();
      } catch (error) {
        clearTimeout(headerTimer);
        if (clientClosed) return;
        if (headersSent) {
          // Headers are on the wire; report the end by closing the response so
          // the browser's stream reader reconnects instead of hanging.
          try {
            res.end();
          } catch {
            // The socket is already gone.
          }
          return;
        }
        sendJson(res, target, 502, {
          error: "desk service unreachable",
          detail: String((error && error.message) || error),
        });
      } finally {
        clearTimeout(headerTimer);
        untrack();
        if (typeof req.off === "function") req.off("close", onClientClose);
      }
    };

    const disposers = [
      ...ROUTES.map((route) =>
        webServer.register({
          kind: "exact",
          path: route.path,
          handler: (req, res) => handle(req, res, route.target),
        }),
      ),
      webServer.register({
        kind: "exact",
        path: STREAM_ROUTE.path,
        handler: (req, res) => handleStream(req, res),
      }),
    ];
    if (disposed) {
      for (const dispose of disposers) dispose();
      return;
    }
    routeDisposers.push(...disposers);
  });

  // Unregister every route when the bundle is disposed, including a callback
  // that resolves after disposal (hence the shared `disposed` flag). Streams
  // that are already open are aborted, so no detached read outlives the bundle.
  return () => {
    disposed = true;
    while (routeDisposers.length > 0) {
      const dispose = routeDisposers.pop();
      if (typeof dispose === "function") dispose();
    }
    for (const controller of activeStreams) controller.abort();
    activeStreams.clear();
  };
}
