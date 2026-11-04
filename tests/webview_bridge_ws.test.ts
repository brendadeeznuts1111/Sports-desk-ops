/**
 * The dashboard's live bridge upgrades the already-guarded `/api/live-bets` route, so the daemon
 * grows no new route and unauthenticated peers still meet `piiRejection`. A browser cannot set
 * headers on a WebSocket handshake, so the admin token rides in the `bearer-<token>` subprotocol
 * and the server turns it back into `authorization` for the guard.
 *
 * This file covers the three layers separately: the pure handshake pieces, the guard reuse against
 * a non-loopback address, and a real end-to-end relay (stub blob gateway -> daemon hub -> browser).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  BRIDGE_WS_PROTOCOL,
  BRIDGE_WS_TOPICS,
  bridgeProtocols,
  bridgeUpgradeRejection,
  bridgeUpgradeRequest,
  isBridgeUpgrade,
  startServer,
  stopBridgeHub,
} from "../services/sportsdesk_webview_server.ts";

const ADMIN_TOKEN = "bridge-test-admin-token";
const BLOB_TOKEN = "bridge-test-blob-token";
const STUB_TICKET = "bridge-test-ticket";

const REMOTE_PEER = "203.0.113.9";

/**
 * These keys are declared `readonly` on Bun's augmented `Env`, so a test writes them through
 * `Reflect` (same object as `Bun.env`) instead of casting the global type away.
 */
function setEnv(name: string, value: string | undefined): void {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) Reflect.deleteProperty(env, name);
  else Reflect.set(env, name, value);
}
const DIRECT_INGRESS = { proxied: false, trustProxy: false } as const;

function upgradeRequest(
  path = "/api/live-bets",
  protocols?: readonly string[],
): Request {
  const headers = new Headers({ upgrade: "websocket" });
  if (protocols !== undefined) {
    headers.set("sec-websocket-protocol", protocols.join(", "));
  }
  return new Request(`http://127.0.0.1:1${path}`, { headers });
}

describe("bridge handshake pieces", () => {
  test("only an upgrade on the reused guarded route is intercepted", () => {
    expect(isBridgeUpgrade(upgradeRequest())).toBe(true);
    expect(isBridgeUpgrade(upgradeRequest("/api/live-bets/summary"))).toBe(
      false,
    );
    expect(
      isBridgeUpgrade(
        new Request("http://127.0.0.1:1/api/live-bets", {
          headers: { upgrade: "h2c" },
        }),
      ),
    ).toBe(false);
    expect(
      isBridgeUpgrade(new Request("http://127.0.0.1:1/api/live-bets")),
    ).toBe(false);
  });

  test("the bearer token comes from the subprotocol list, never a URL", () => {
    const offered = bridgeProtocols(
      upgradeRequest("/api/live-bets", [
        BRIDGE_WS_PROTOCOL,
        `bearer-${ADMIN_TOKEN}`,
      ]),
    );
    expect(offered.token).toBe(ADMIN_TOKEN);
    expect(offered.echo).toBe(BRIDGE_WS_PROTOCOL);
    expect(
      bridgeProtocols(upgradeRequest("/api/live-bets", [BRIDGE_WS_PROTOCOL]))
        .token,
    ).toBeNull();
  });

  test("the synthetic request turns the token into a bearer header", () => {
    const synthetic = bridgeUpgradeRequest(
      upgradeRequest("/api/live-bets", [
        BRIDGE_WS_PROTOCOL,
        `bearer-${ADMIN_TOKEN}`,
      ]),
    );
    expect(synthetic.headers.get("authorization")).toBe(
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(synthetic.headers.get("sec-websocket-protocol")).toBeNull();
    expect(
      bridgeUpgradeRequest(upgradeRequest("/api/live-bets")).headers.get(
        "authorization",
      ),
    ).toBeNull();
  });
});

describe("the route's own guard decides the upgrade", () => {
  const saved = process.env.SPORTSDESK_ADMIN_TOKEN;

  beforeAll(() => {
    setEnv("SPORTSDESK_ADMIN_TOKEN", ADMIN_TOKEN);
  });

  afterAll(() => {
    setEnv("SPORTSDESK_ADMIN_TOKEN", saved);
  });

  test("a remote peer with no token is refused with 401", () => {
    const rejection = bridgeUpgradeRejection(
      upgradeRequest(),
      REMOTE_PEER,
      DIRECT_INGRESS,
    );
    expect(rejection?.status).toBe(401);
  });

  test("a remote peer with a wrong token is refused with 401", () => {
    const rejection = bridgeUpgradeRejection(
      upgradeRequest("/api/live-bets", [
        BRIDGE_WS_PROTOCOL,
        "bearer-not-the-admin-token",
      ]),
      REMOTE_PEER,
      DIRECT_INGRESS,
    );
    expect(rejection?.status).toBe(401);
  });

  test("a remote peer offering the right token is allowed", () => {
    const rejection = bridgeUpgradeRejection(
      upgradeRequest("/api/live-bets", [
        BRIDGE_WS_PROTOCOL,
        `bearer-${ADMIN_TOKEN}`,
      ]),
      REMOTE_PEER,
      DIRECT_INGRESS,
    );
    expect(rejection).toBeNull();
  });

  test("loopback stays trusted, exactly like the HTTP route", () => {
    expect(
      bridgeUpgradeRejection(upgradeRequest(), "127.0.0.1", DIRECT_INGRESS),
    ).toBeNull();
  });
});

type Frame = { type?: string; kind?: string; [key: string]: unknown };

function openSocket(
  url: string,
  protocols?: readonly string[],
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      protocols === undefined
        ? new WebSocket(url)
        : new WebSocket(url, [...protocols]);
    const timer = setTimeout(
      () => reject(new Error("socket open timeout")),
      5_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("socket open failed"));
    });
  });
}

/** Collect every frame, so a test can await the one it needs without racing. */
function frameQueue(socket: WebSocket) {
  const frames: Frame[] = [];
  const waiters: ((frame: Frame) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  });
  return {
    next(predicate: (frame: Frame) => boolean): Promise<Frame> {
      const found = frames.findIndex(predicate);
      if (found >= 0) return Promise.resolve(frames.splice(found, 1)[0]!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("frame timeout")),
          8_000,
        );
        const settled = (frame: Frame) => {
          if (predicate(frame)) {
            clearTimeout(timer);
            resolve(frame);
          } else {
            frames.push(frame);
            waiters.push(settled);
          }
        };
        waiters.push(settled);
      });
    },
  };
}

describe("daemon hub relays the blob gateway's bridge frames", () => {
  let hub: Bun.Server<undefined>;
  let gateway: Bun.Server<undefined>;
  let gatewayUrl: string;
  let browser: WebSocket | undefined;
  let relayReady: Promise<void>;
  const saved = {
    admin: process.env.SPORTSDESK_ADMIN_TOKEN,
    blobToken: process.env.BLOB_API_TOKEN,
    gatewayUrl: process.env.BLOB_GATEWAY_URL,
  };

  beforeAll(() => {
    let resolveRelayReady: () => void = () => {};
    relayReady = new Promise<void>((resolve) => {
      resolveRelayReady = resolve;
    });
    let subscribed = 0;
    gateway = Bun.serve<undefined>({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/api/v1/ws-tickets": {
          POST: (req: Request) => {
            const authorization = req.headers.get("authorization");
            if (authorization !== `Bearer ${BLOB_TOKEN}`) {
              return Response.json({ error: "unauthorized" }, { status: 401 });
            }
            return Response.json({ ticket: STUB_TICKET });
          },
        },
        "/ws/live-bets": (req: Request, server: Bun.Server<undefined>) => {
          if (new URL(req.url).searchParams.get("ticket") !== STUB_TICKET) {
            return new Response("bad ticket", { status: 401 });
          }
          const upgraded = server.upgrade(req, { data: undefined });
          return upgraded ? undefined : new Response("no", { status: 426 });
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
      websocket: {
        // Mirror the real gateway: a SUBSCRIBE is what makes publish() deliver here.
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as {
            type?: string;
            channel?: string;
          };
          if (frame.type !== "SUBSCRIBE" || frame.channel === undefined) return;
          ws.subscribe(frame.channel);
          subscribed += 1;
          if (subscribed >= BRIDGE_WS_TOPICS.length) resolveRelayReady();
        },
      },
    });
    gatewayUrl = `http://127.0.0.1:${gateway.port}`;

    setEnv("SPORTSDESK_ADMIN_TOKEN", ADMIN_TOKEN);
    setEnv("BLOB_API_TOKEN", BLOB_TOKEN);
    setEnv("BLOB_GATEWAY_URL", gatewayUrl);

    hub = startServer({ port: 0, hostname: "127.0.0.1" });
  });

  afterAll(() => {
    browser?.close();
    stopBridgeHub();
    hub?.stop(true);
    gateway?.stop(true);
    setEnv("SPORTSDESK_ADMIN_TOKEN", saved.admin);
    setEnv("BLOB_API_TOKEN", saved.blobToken);
    setEnv("BLOB_GATEWAY_URL", saved.gatewayUrl);
  });

  test("browser SUBSCRIBE acks, then a published rollup reaches the page", async () => {
    browser = await openSocket(`ws://127.0.0.1:${hub.port}/api/live-bets`, [
      BRIDGE_WS_PROTOCOL,
      `bearer-${ADMIN_TOKEN}`,
    ]);
    const frames = frameQueue(browser);

    for (const topic of BRIDGE_WS_TOPICS) {
      browser.send(JSON.stringify({ type: "SUBSCRIBE", channel: topic }));
    }
    const ack = await frames.next(
      (frame) => frame.type === "SUBSCRIBED" && frame.channel === "f402-weblog",
    );
    expect(ack.subscriptions).toContain("f402-weblog");

    // The relay connects lazily on the first socket; wait until the gateway saw its 5 topics.
    await relayReady;

    const rollup = {
      kind: "f402-weblog",
      rows: { total: 523632 },
      gates: [{ gate: "GATE-WL-01", status: "pass" }],
    };
    const delivered = frames.next(
      (frame) => frame.kind === "f402-weblog" && frame.rows !== undefined,
    );
    gateway.publish("f402-weblog", JSON.stringify(rollup));
    const frame = await delivered;
    expect(frame).toEqual(rollup as unknown as Frame);
  }, 20_000);
});
