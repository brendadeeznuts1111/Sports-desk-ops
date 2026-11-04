import { afterEach, describe, expect, test } from "bun:test";

import {
  sendFrameOrClose,
  WS_BACKPRESSURE_LIMIT_BYTES,
  WS_BACKPRESSURE_OPTIONS,
  WS_CLOSE_BACKPRESSURE,
} from "../lib/ws_backpressure.ts";
import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
} from "../services/blob_and_live_bets_server.ts";
import { bridgeWebsocket } from "../services/sportsdesk_webview_server.ts";

type Closed = { code: number | undefined; reason: string | undefined };

function fakeSocket(status: number): {
  socket: Parameters<typeof sendFrameOrClose>[0];
  closes: Closed[];
} {
  const closes: Closed[] = [];
  return {
    closes,
    socket: {
      send: () => status,
      close: (code, reason) => {
        closes.push({ code, reason });
      },
    },
  };
}

describe("sendFrameOrClose", () => {
  test("a delivered frame (bytes > 0) keeps the socket open", () => {
    const { socket, closes } = fakeSocket(42);
    expect(sendFrameOrClose(socket, '{"type":"PONG"}')).toBe(true);
    expect(closes).toEqual([]);
  });

  test("backpressure (-1) closes with 1011", () => {
    const { socket, closes } = fakeSocket(-1);
    expect(sendFrameOrClose(socket, '{"type":"PONG"}')).toBe(false);
    expect(closes).toEqual([
      { code: WS_CLOSE_BACKPRESSURE, reason: "backpressure" },
    ]);
  });

  test("a dropped frame (0) closes with 1011 instead of leaving a silent gap", () => {
    const { socket, closes } = fakeSocket(0);
    expect(sendFrameOrClose(socket, '{"type":"PONG"}')).toBe(false);
    expect(closes).toEqual([
      { code: WS_CLOSE_BACKPRESSURE, reason: "backpressure" },
    ]);
  });

  test("an empty payload also returns 0 but is a delivery", () => {
    const { socket, closes } = fakeSocket(0);
    expect(sendFrameOrClose(socket, "")).toBe(true);
    expect(closes).toEqual([]);
  });

  test("the options cap the buffer and close at the cap", () => {
    expect(WS_BACKPRESSURE_OPTIONS).toEqual({
      backpressureLimit: WS_BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
    });
  });
});

describe("bridge hub handler", () => {
  test("carries the backpressure options", () => {
    expect(bridgeWebsocket.backpressureLimit).toBe(WS_BACKPRESSURE_LIMIT_BYTES);
    expect(bridgeWebsocket.closeOnBackpressureLimit).toBe(true);
  });

  test("an ack the socket cannot take closes it with 1011", () => {
    const { socket, closes } = fakeSocket(-1);
    bridgeWebsocket.message(
      {
        ...socket,
        subscriptions: [],
        subscribe: () => {},
        unsubscribe: () => {},
      },
      JSON.stringify({ type: "PING" }),
    );
    expect(closes).toEqual([
      { code: WS_CLOSE_BACKPRESSURE, reason: "backpressure" },
    ]);
  });
});

/**
 * A real peer that completes the handshake and then never reads, so the server-side buffer fills
 * for real. Returns a handle to end it.
 */
async function stalledPeer(
  port: number,
  path: string,
): Promise<{ end: () => void }> {
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data() {},
      open(s) {
        s.write(
          `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
        s.pause();
      },
    },
  });
  return { end: () => socket.end() };
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const FRAME = "y".repeat(256 * 1024);

describe("stalled subscriber on a real Bun.serve", () => {
  test("control: without the options Bun drops frames and keeps the socket open", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) =>
        srv.upgrade(req) ? undefined : new Response("no", { status: 426 }),
      websocket: {
        backpressureLimit: WS_BACKPRESSURE_LIMIT_BYTES,
        open(ws) {
          ws.subscribe("t");
        },
        message() {},
      },
    });
    stops.push(() => server.stop(true));
    const peer = await stalledPeer(server.port as number, "/");
    stops.push(peer.end);
    expect(await until(() => server.subscriberCount("t") === 1, 2000)).toBe(
      true,
    );
    const statuses = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const status = server.publish("t", FRAME);
      statuses.add(status > 0 ? 1 : status);
    }
    await Bun.sleep(200);
    expect(statuses.has(0)).toBe(true); // frames were dropped ...
    expect(server.subscriberCount("t")).toBe(1); // ... and nothing told the subscriber
  });

  test("gateway closes a stalled live-bets subscriber instead of dropping its frames", async () => {
    const gateway = createBlobLiveBetsServer({
      blobs: new MemoryBlobStore(),
      apiToken: "t",
      ticketSecret: "s",
      port: 0,
      hostname: "127.0.0.1",
    });
    stops.push(() => gateway.close(true));
    const port = gateway.server.port as number;
    const ticketResponse = await fetch(
      `http://127.0.0.1:${port}/api/v1/ws-tickets`,
      { method: "POST", headers: { authorization: "Bearer t" } },
    );
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const peer = await stalledPeer(port, `/ws/live-bets?ticket=${ticket}`);
    stops.push(peer.end);
    expect(
      await until(
        () => gateway.server.subscriberCount("live-bets") === 1,
        2000,
      ),
    ).toBe(true);

    for (let i = 0; i < 100; i++) gateway.publish("live-bets", { pad: FRAME });

    expect(
      await until(
        () => gateway.server.subscriberCount("live-bets") === 0,
        3000,
      ),
    ).toBe(true);
  });
});
