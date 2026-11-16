import { describe, expect, test } from "bun:test";
import {
  createDashboardWebSocketHandler,
  publishDashboardTopicEvent,
  type WsLike,
} from "../packages/api/src/ws.ts";

describe("dashboard WebSocket limits", () => {
  test("the handler declares the measured limits", () => {
    const { websocket } = createDashboardWebSocketHandler(new Set<WsLike>());
    expect((websocket as Record<string, unknown>).maxPayloadLength).toBe(
      16 * 1024,
    );
    expect((websocket as Record<string, unknown>).backpressureLimit).toBe(
      256 * 1024,
    );
    expect(
      (websocket as Record<string, unknown>).closeOnBackpressureLimit,
    ).toBe(true);
  });

  test("an oversized frame closes 1009 and a normal subscribe still replies", async () => {
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
    try {
      const open = async () => {
        const ws = new WebSocket(base);
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => reject(new Error("ws error")), {
            once: true,
          });
        });
        return ws;
      };

      const normal = await open();
      const reply = new Promise<string>((resolve) =>
        normal.addEventListener(
          "message",
          (event) => resolve(String(event.data)),
          { once: true },
        ),
      );
      normal.send(JSON.stringify({ action: "subscribe", topic: "dashboard" }));
      expect(
        await Promise.race([reply, Bun.sleep(2000).then(() => "TIMEOUT")]),
      ).toContain('"type":"subscribed"');
      normal.close();

      const big = await open();
      const closed = new Promise<number>((resolve) =>
        big.addEventListener("close", (event) => resolve(event.code), {
          once: true,
        }),
      );
      big.send("x".repeat(32 * 1024));
      expect(await Promise.race([closed, Bun.sleep(3000).then(() => -1)])).toBe(
        1009,
      );
    } finally {
      server.stop(true);
    }
  });

  test("the publish path stops at the first dropped frame", () => {
    const closed: number[] = [];
    const slow = {
      subscriptions: ["dashboard"],
      subscribe() {},
      unsubscribe() {},
      send: () => -1,
      close: (code?: number) => closed.push(code ?? 0),
    };
    const delivered = publishDashboardTopicEvent(
      [slow],
      "dashboard",
      '{"x":1}',
    );
    expect(delivered).toBe(0);
    expect(closed).toEqual([1011]);
  });
});
