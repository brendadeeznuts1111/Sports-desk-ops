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
 *   /api/sportsdesk-desk/health    -> http://127.0.0.1:{apiPort}/health
 *   /api/sportsdesk-desk/status    -> http://127.0.0.1:4020/api/status
 *   /api/sportsdesk-desk/graph     -> http://127.0.0.1:4020/api/graph/summary
 *   /api/sportsdesk-desk/kpis      -> http://127.0.0.1:4020/api/kpis
 *   /api/sportsdesk-desk/execution -> http://127.0.0.1:4020/api/execution/plan
 *   /api/sportsdesk-desk/stream    -> http://127.0.0.1:4020/api/graph/stream
 *   /api/sportsdesk-desk/ws        -> ws://127.0.0.1:4020/api/live-bets
 *
 * The WebSocket entry is not a fetch route: it is an HTTP upgrade tunnel that
 * performs both RFC 6455 handshakes and pipes the raw sockets, so the panel's
 * Live bridge reaches the desk's pub/sub hub from a remotely served UI.
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

import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

const PROXY_PREFIX = "/api/sportsdesk-desk";
const DEFAULT_DESK_PORT = 4020;

/**
 * Cordis row `config.apiPort` → Host proxy upstream origin (loopback only).
 * @param {unknown} config
 */
export function resolveDeskOrigin(config) {
  const raw = config?.apiPort;
  let port = DEFAULT_DESK_PORT;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    port = Math.trunc(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) port = Number(trimmed);
  }
  if (port < 1 || port > 65_535) port = DEFAULT_DESK_PORT;
  return `http://127.0.0.1:${port}`;
}
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

/**
 * The desk's WebSocket bridge. The browser cannot reach the desk's loopback
 * port when the Harness UI is served remotely, and a WebSocket handshake
 * cannot be proxied by a normal fetch handler: this route tunnels the raw
 * upgraded socket to the desk's `/api/live-bets` bridge after performing both
 * RFC 6455 handshakes. Only the fixed path and subprotocol are forwarded.
 */
const WS_ROUTE = Object.freeze({
  path: `${PROXY_PREFIX}/ws`,
  target: "/api/live-bets",
  protocol: "sportsdesk.bridge.v1",
});
/** Bound connect + upstream handshake; the bridge answers immediately when up. */
const WS_HANDSHAKE_TIMEOUT_MS = 4_000;
/** Largest upstream handshake head accepted before refusing. */
const MAX_WS_HEAD_BYTES = 8 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** RFC 6455 accept key for a client's `Sec-WebSocket-Key`. */
export function websocketAcceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** A client key is base64 of exactly 16 random bytes. */
export function isValidWebSocketKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").length === 16;
}

/** The upstream opening handshake for the desk bridge (fixed path/protocol). */
export function buildBridgeHandshake(port, key) {
  return [
    `GET ${WS_ROUTE.target} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Protocol: ${WS_ROUTE.protocol}`,
    "",
    "",
  ].join("\r\n");
}

/** Parse one HTTP response head (status + lowercased headers). */
export function parseUpgradeHead(head) {
  const lines = String(head).split("\r\n");
  const status = Number((lines[0] ?? "").split(" ")[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line
      .slice(index + 1)
      .trim();
  }
  return { status: Number.isFinite(status) ? status : 0, headers };
}

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

/** Refuse an upgrade before any 101 has been written. */
function rejectUpgrade(socket, status, error) {
  const text =
    status === 400
      ? "Bad Request"
      : status === 403
        ? "Forbidden"
        : status === 504
          ? "Gateway Timeout"
          : "Bad Gateway";
  const body = JSON.stringify({ error });
  try {
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\n` +
        "content-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        "connection: close\r\n\r\n" +
        body,
    );
  } catch {
    // The client may already be gone.
  }
}

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx, config) {
  // Headless compositions have no browser carrier; the panel does not exist
  // there. The guard also keeps the dependency-free loader harness working.
  if (typeof ctx.inject !== "function") return;
  const deskOrigin = resolveDeskOrigin(config);
  const routeDisposers = [];
  /**
   * In-flight upstream streams, so disposal aborts them instead of leaving a
   * detached read running against the desk after the bundle is gone.
   */
  const activeStreams = new Set();
  /** Open WebSocket tunnels, so disposal closes both ends. */
  const activeUpgrades = new Set();
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
        const upstream = await fetch(`${deskOrigin}${target}`, {
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
        const upstream = await fetch(`${deskOrigin}${target}`, {
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

    /**
     * Tunnel one browser WebSocket to the desk's bridge. Node hands over the
     * socket before any 101 response, so this performs both RFC 6455
     * handshakes: upstream first (validating its accept key and echoed
     * subprotocol), then the browser one. Only the fixed path and subprotocol
     * cross; no client header or cookie is forwarded upstream.
     */
    const handleUpgrade = (req, socket, head) => {
      if (req.method !== "GET" || !sameOrigin(req)) {
        rejectUpgrade(socket, 403, "origin_refused");
        return;
      }
      const offered = String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");
      if (!offered.includes(WS_ROUTE.protocol)) {
        rejectUpgrade(socket, 400, "protocol_required");
        return;
      }
      const clientKey = req.headers["sec-websocket-key"];
      if (!isValidWebSocketKey(clientKey)) {
        rejectUpgrade(socket, 400, "invalid_key");
        return;
      }
      const url = new URL(deskOrigin);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const upstreamKey = randomBytes(16).toString("base64");
      const upstream =
        url.protocol === "https:"
          ? tls.connect({ host: url.hostname, port, servername: url.hostname })
          : net.connect({ host: url.hostname, port });
      const record = { client: socket, upstream };
      activeUpgrades.add(record);
      let settled = false;
      let responseHead = "";
      let timer = null;
      const finish = () => {
        activeUpgrades.delete(record);
        if (timer !== null) clearTimeout(timer);
        timer = null;
        try {
          upstream.destroy();
        } catch {
          // Already closed.
        }
        try {
          socket.destroy();
        } catch {
          // Already closed.
        }
      };
      const fail = (status, error) => {
        if (settled) return;
        settled = true;
        activeUpgrades.delete(record);
        if (timer !== null) clearTimeout(timer);
        timer = null;
        try {
          upstream.destroy();
        } catch {
          // Already closed.
        }
        rejectUpgrade(socket, status, error);
      };
      timer = setTimeout(
        () => fail(504, "upstream_handshake_timeout"),
        WS_HANDSHAKE_TIMEOUT_MS,
      );
      upstream.setNoDelay?.(true);
      upstream.once("error", () => fail(502, "upstream_unreachable"));
      upstream.once("connect", () => {
        upstream.write(buildBridgeHandshake(port, upstreamKey));
      });
      const onUpstreamData = (chunk) => {
        if (settled) return;
        responseHead += chunk.toString("latin1");
        const boundary = responseHead.indexOf("\r\n\r\n");
        if (boundary < 0) {
          if (responseHead.length > MAX_WS_HEAD_BYTES) {
            fail(502, "upstream_head_too_large");
          }
          return;
        }
        upstream.off("data", onUpstreamData);
        const parsed = parseUpgradeHead(responseHead.slice(0, boundary + 4));
        if (parsed.status !== 101) {
          fail(502, `upstream_${parsed.status || "handshake"}`);
          return;
        }
        if (
          parsed.headers["sec-websocket-accept"] !==
          websocketAcceptKey(upstreamKey)
        ) {
          fail(502, "upstream_accept_mismatch");
          return;
        }
        if (parsed.headers["sec-websocket-protocol"] !== WS_ROUTE.protocol) {
          fail(502, "upstream_protocol_mismatch");
          return;
        }
        settled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${websocketAcceptKey(clientKey)}`,
            `Sec-WebSocket-Protocol: ${WS_ROUTE.protocol}`,
            `x-sportsdesk-desk-ws: ${WS_ROUTE.target}`,
            "",
            "",
          ].join("\r\n"),
        );
        // Bytes the upstream sent after its handshake belong to the stream.
        const rest = Buffer.from(responseHead.slice(boundary + 4), "latin1");
        if (rest.length > 0) socket.write(rest);
        if (head !== undefined && head !== null && head.length > 0) {
          upstream.write(head);
        }
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.on("error", finish);
        upstream.on("error", finish);
        socket.on("close", finish);
        upstream.on("close", finish);
      };
      upstream.on("data", onUpstreamData);
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
    if (typeof webServer.registerUpgrade === "function") {
      disposers.push(
        webServer.registerUpgrade({
          path: WS_ROUTE.path,
          handler: (req, socket, head) => handleUpgrade(req, socket, head),
        }),
      );
    }
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
    for (const upgrade of activeUpgrades) {
      try {
        upgrade.upstream.destroy();
      } catch {
        // Already closed.
      }
      try {
        upgrade.client.destroy();
      } catch {
        // Already closed.
      }
    }
    activeUpgrades.clear();
  };
}
