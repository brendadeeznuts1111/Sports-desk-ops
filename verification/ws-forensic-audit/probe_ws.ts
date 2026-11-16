#!/usr/bin/env bun
/** Probe: dashboard WS limits — payload cap, backpressure eviction, malformed JSON, subscribe. */
import { createConnection } from "node:net";
import {
  createDashboardWebSocketHandler,
  publishDashboardTopicEvent,
  type WsLike,
} from "../../packages/api/src/ws.ts";

const clients = new Set<WsLike>();
const { websocket } = createDashboardWebSocketHandler(clients);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") {
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("ok");
  },
  websocket: websocket as never,
});
const base = `ws://127.0.0.1:${server.port}/ws`;

async function openClient(): Promise<WebSocket> {
  const ws = new WebSocket(base);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), {
      once: true,
    });
  });
  return ws;
}

const results: Record<string, unknown> = {
  config: {
    maxPayloadLength: (websocket as Record<string, unknown>).maxPayloadLength,
    backpressureLimit: (websocket as Record<string, unknown>).backpressureLimit,
    closeOnBackpressureLimit: (websocket as Record<string, unknown>)
      .closeOnBackpressureLimit,
    idleTimeout: (websocket as Record<string, unknown>).idleTimeout,
  },
};

try {
  // 1. Normal subscribe still replies.
  {
    const ws = await openClient();
    const reply = new Promise<string>((resolve) =>
      ws.addEventListener("message", (event) => resolve(String(event.data)), {
        once: true,
      }),
    );
    ws.send(JSON.stringify({ action: "subscribe", topic: "dashboard" }));
    results.subscribe = {
      reply: await Promise.race([reply, Bun.sleep(2000).then(() => "TIMEOUT")]),
    };
    ws.close();
  }

  // 2. Malformed JSON is ignored and the connection stays usable.
  {
    const ws = await openClient();
    ws.send("not-json");
    ws.send("{broken");
    const reply = new Promise<string>((resolve) =>
      ws.addEventListener("message", (event) => resolve(String(event.data)), {
        once: true,
      }),
    );
    ws.send(JSON.stringify({ action: "subscribe", topic: "live-bets" }));
    results.malformed = {
      stillOpen: ws.readyState === WebSocket.OPEN,
      reply: await Promise.race([reply, Bun.sleep(2000).then(() => "TIMEOUT")]),
    };
    ws.close();
  }

  // 3. Oversized frame closes 1009.
  {
    const ws = await openClient();
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    ws.send("x".repeat(32 * 1024));
    results.oversize = {
      closeCode: await Promise.race([closed, Bun.sleep(3000).then(() => -1)]),
    };
  }

  // 4. Stalled consumer: raw TCP upgrade, then stop reading; the server must evict at the cap.
  {
    const port = server.port;
    if (port === undefined)
      throw new Error("Bun.serve did not report a bound port");
    const raw = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", () => resolve());
      raw.once("error", reject);
    });
    const key = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16)),
    ).toString("base64");
    let handshake = "";
    raw.on("data", (chunk) => {
      handshake += chunk.toString("utf8");
      if (handshake.includes("101 Switching Protocols")) {
        raw.pause();
      }
    });
    raw.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    for (let i = 0; i < 100 && !handshake.includes("101"); i += 1)
      await Bun.sleep(20);
    results.handshake = handshake.slice(0, 40);
    for (let i = 0; i < 100 && clients.size === 0; i += 1) await Bun.sleep(20);
    const target = [...clients][0] as
      { send: (data: string) => number } | undefined;
    let deliveries = 0;
    let droppedFrames = 0;
    let droppedAt = -1;
    if (target !== undefined) {
      for (let i = 0; i < 2000; i += 1) {
        // Exercise the real publish path: it must close on the first frame that does not go out.
        const delivered = publishDashboardTopicEvent(
          clients,
          "dashboard",
          "y".repeat(4096),
        );
        if (delivered === 0) {
          droppedFrames += 1;
          if (droppedAt === -1) droppedAt = i;
        } else {
          deliveries += delivered;
        }
        if (i % 50 === 0) await Bun.sleep(5);
        if (clients.size === 0) break;
      }
      await Bun.sleep(400);
    }
    results.backpressure = {
      clientsBefore: target === undefined ? 0 : 1,
      publishAttempts: deliveries + droppedFrames,
      deliveredFrames: deliveries,
      droppedFrames,
      firstDropAt: droppedAt,
      clientsAfter: clients.size,
      evicted: clients.size === 0,
      silentGap: droppedFrames > 1,
    };
    try {
      raw.end();
    } catch {
      /* closed */
    }
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  server.stop(true);
}
