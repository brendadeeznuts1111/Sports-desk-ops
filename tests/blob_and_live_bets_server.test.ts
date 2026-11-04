import { afterEach, describe, expect, test } from "bun:test";

import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
  type BlobLiveBetsOptions,
} from "../services/blob_and_live_bets_server.ts";

const API_TOKEN = "test-api-token";
const TICKET_SECRET = "test-ticket-secret";
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface Harness {
  readonly url: string;
  readonly wsUrl: string;
  readonly store: MemoryBlobStore;
  readonly stop: () => void;
}

const servers: (() => void)[] = [];
afterEach(() => {
  for (const stop of servers.splice(0)) stop();
});

function start(overrides: Partial<BlobLiveBetsOptions> = {}): Harness {
  const store = new MemoryBlobStore();
  const { server, close } = createBlobLiveBetsServer({
    blobs: store,
    apiToken: API_TOKEN,
    ticketSecret: TICKET_SECRET,
    port: 0,
    hostname: "127.0.0.1",
    ...overrides,
  });
  servers.push(() => close(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/ws/live-bets`,
    store,
    stop: () => close(true),
  };
}

function auth(token = API_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function pngBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64"));
}

async function ticket(h: Harness): Promise<string> {
  const response = await fetch(`${h.url}/api/v1/ws-tickets`, {
    method: "POST",
    headers: auth(),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ticket: string };
  return body.ticket;
}

async function openTicketSocket(h: Harness): Promise<WebSocket> {
  const ws = new WebSocket(`${h.wsUrl}?ticket=${await ticket(h)}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 3000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws open failed"));
    };
  });
  return ws;
}

async function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ws message timeout")),
      3000,
    );
    ws.onmessage = (event) => {
      clearTimeout(timer);
      resolve(String(event.data));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
}

describe("blob + live-bets gateway", () => {
  test("health is public and reports runtime provenance", async () => {
    const h = start();
    const response = await fetch(`${h.url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      bunRevision: string;
      uptimeNs: number;
    };
    expect(body.status).toBe("ok");
    expect(body.bunRevision.length).toBeGreaterThan(0);
    expect(body.uptimeNs).toBeGreaterThan(0);
  });

  test("blob reads, writes and tickets require the bearer token", async () => {
    const h = start();
    for (const [method, path] of [
      ["GET", "/api/v1/blobs/k1"],
      ["PUT", "/api/v1/blobs/k1"],
      ["POST", "/api/v1/ws-tickets"],
    ] as const) {
      const response = await fetch(`${h.url}${path}`, { method });
      expect(response.status).toBe(401);
    }
    const wrong = await fetch(`${h.url}/api/v1/blobs/k1`, {
      method: "GET",
      headers: auth("wrong"),
    });
    expect(wrong.status).toBe(401);
  });

  test("key validation rejects traversal and oversized names", async () => {
    const h = start();
    // `..` is normalized away by the URL parser before routing, so it is a 404.
    const normalized = await fetch(`${h.url}/api/v1/blobs/..`, {
      headers: auth(),
    });
    expect(normalized.status).toBe(404);
    for (const key of ["a..b", ".hidden", "a".repeat(65)]) {
      const response = await fetch(`${h.url}/api/v1/blobs/${key}`, {
        headers: auth(),
      });
      expect(response.status).toBe(400);
    }
  });

  test("GET redirects to a presigned URL for a valid key", async () => {
    const h = start();
    const response = await fetch(`${h.url}/api/v1/blobs/photo-1`, {
      headers: auth(),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("photo-1.webp");
    expect(h.store.presigns).toHaveLength(1);
  });

  test("PUT rejects non-images and stores transcoded webp bytes", async () => {
    const h = start();
    const text = await fetch(`${h.url}/api/v1/blobs/note`, {
      method: "PUT",
      headers: { ...auth(), "content-type": "text/plain" },
      body: "hello",
    });
    expect(text.status).toBe(415);

    const response = await fetch(`${h.url}/api/v1/blobs/photo-2`, {
      method: "PUT",
      headers: { ...auth(), "content-type": "image/png" },
      body: pngBytes(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: string;
      bytesWritten: number;
      bytes: number;
      width: number;
      height: number;
    };
    expect(body.key).toBe("blobs/photo-2.webp");
    expect(body.bytesWritten).toBe(body.bytes);
    expect(body.width).toBeGreaterThan(0);
    expect(body.height).toBeGreaterThan(0);
    const stored = h.store.blobs.get("photo-2");
    expect(stored?.contentType).toBe("image/webp");
    expect(new TextDecoder().decode(stored?.bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(stored?.bytes.slice(8, 12))).toBe("WEBP");
  });

  test("upload caps reject declared and streamed oversize bodies", async () => {
    const h = start({ maxUploadBytes: 64 });
    const declared = await fetch(`${h.url}/api/v1/blobs/big`, {
      method: "PUT",
      headers: {
        ...auth(),
        "content-type": "image/png",
        "content-length": "1000",
      },
      body: pngBytes(),
    });
    expect(declared.status).toBe(413);

    const streamed = await fetch(`${h.url}/api/v1/blobs/big2`, {
      method: "PUT",
      headers: { ...auth(), "content-type": "image/png" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(128));
          controller.enqueue(new Uint8Array(128));
          controller.close();
        },
      }),
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
  });

  test("pixel bombs are rejected by maxPixels before encoding", async () => {
    const twoByTwo = await new Bun.Image(pngBytes())
      .resize(2, 2, { fit: "fill" })
      .png()
      .bytes();
    const h = start({ maxPixels: 1 });
    const response = await fetch(`${h.url}/api/v1/blobs/bomb`, {
      method: "PUT",
      headers: { ...auth(), "content-type": "image/png" },
      body: twoByTwo,
    });
    expect(response.status).toBe(413);
    expect(h.store.blobs.size).toBe(0);
  });

  test("websocket requires a valid ticket and answers PING/PONG", async () => {
    const h = start();
    const rejected = new WebSocket(`${h.wsUrl}?ticket=not-a-ticket`);
    await new Promise<void>((resolve) => {
      rejected.onclose = () => resolve();
      rejected.onerror = () => resolve();
    });

    const ws = await openTicketSocket(h);
    try {
      ws.send(JSON.stringify({ type: "PING" }));
      const pong = JSON.parse(await nextMessage(ws)) as {
        type: string;
        ts: number;
      };
      expect(pong.type).toBe("PONG");
      expect(pong.ts).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  test("websocket validates JSON, channels and message size", async () => {
    const h = start({ maxWsMessageBytes: 64 });
    const ws = await openTicketSocket(h);
    try {
      ws.send("not-json");
      expect(JSON.parse(await nextMessage(ws))).toMatchObject({
        type: "ERROR",
        code: "invalid_json",
      });

      ws.send(JSON.stringify({ type: "SUBSCRIBE", channel: "BAD CHANNEL" }));
      expect(JSON.parse(await nextMessage(ws))).toMatchObject({
        type: "ERROR",
        code: "invalid_channel",
      });

      ws.send(JSON.stringify({ type: "SUBSCRIBE", channel: "alerts" }));
      expect(JSON.parse(await nextMessage(ws))).toMatchObject({
        type: "SUBSCRIBED",
        channel: "alerts",
      });

      const oversized = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("close timeout")),
          3000,
        );
        ws.onclose = (event) => {
          clearTimeout(timer);
          resolve(event.code);
        };
        ws.send("x".repeat(200));
      });
      expect(oversized).toBe(1009);
    } finally {
      ws.close();
    }
  });

  test("PUT then DELETE removes a blob; unknown DELETE is 404", async () => {
    const h = start();
    const created = await fetch(`${h.url}/api/v1/blobs/delete-me`, {
      method: "PUT",
      headers: { ...auth(), "content-type": "image/png" },
      body: pngBytes(),
    });
    expect(created.status).toBe(200);

    const unauthorized = await fetch(`${h.url}/api/v1/blobs/delete-me`, {
      method: "DELETE",
    });
    expect(unauthorized.status).toBe(401);

    const deleted = await fetch(`${h.url}/api/v1/blobs/delete-me`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(deleted.status).toBe(204);
    expect(await h.store.exists("delete-me")).toBe(false);

    const missing = await fetch(`${h.url}/api/v1/blobs/missing`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(missing.status).toBe(404);
  });

  test("MemoryBlobStore exposes exists, stat and delete", async () => {
    const store = new MemoryBlobStore();
    expect(await store.exists("x")).toBe(false);
    await store.put("x", new Uint8Array([1, 2, 3]), "image/webp");
    expect(await store.exists("x")).toBe(true);
    expect(await store.stat("x")).toEqual({
      size: 3,
      contentType: "image/webp",
    });
    await store.delete("x");
    expect(await store.exists("x")).toBe(false);
  });

  test("unknown paths return a JSON 404", async () => {
    const h = start();
    const response = await fetch(`${h.url}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("one-time tickets and subprotocol transport", () => {
  test("a ticket is rejected on replay after the first upgrade", async () => {
    const h = start();
    const once = await ticket(h);
    const ws = new WebSocket(`${h.wsUrl}?ticket=${once}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("open timeout")), 3000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("open failed"));
      };
    });
    ws.close();

    const replay = new WebSocket(`${h.wsUrl}?ticket=${once}`);
    await new Promise<void>((resolve) => {
      replay.onopen = () => resolve();
      replay.onclose = () => resolve();
      replay.onerror = () => resolve();
    });
    expect(replay.readyState).not.toBe(WebSocket.OPEN);
  });

  test("Sec-WebSocket-Protocol ticket is accepted and live-bets.v1 is echoed", async () => {
    const h = start();
    const once = await ticket(h);
    const ws = new WebSocket(h.wsUrl, ["live-bets.v1", `ticket.${once}`]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("open timeout")), 3000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("open failed"));
      };
    });
    try {
      expect(ws.protocol).toBe("live-bets.v1");
      ws.send(JSON.stringify({ type: "PING" }));
      const pong = JSON.parse(await nextMessage(ws)) as { type: string };
      expect(pong.type).toBe("PONG");
    } finally {
      ws.close();
    }
  });
});

describe("no upscaling, ticket cap and publish", () => {
  test("small images keep native dimensions; oversized images clamp to 1280", async () => {
    const h = start();
    const small = await fetch(`${h.url}/api/v1/blobs/small`, {
      method: "PUT",
      headers: { ...auth(), "content-type": "image/png" },
      body: pngBytes(),
    });
    const smallBody = (await small.json()) as { width: number; height: number };
    expect(smallBody.width).toBe(1);
    expect(smallBody.height).toBe(1);

    const oversizedBytes = await new Bun.Image(pngBytes())
      .resize(2000, 2000, { fit: "fill" })
      .png()
      .bytes();
    const big = await fetch(`${h.url}/api/v1/blobs/big-image`, {
      method: "PUT",
      headers: { ...auth(), "content-type": "image/png" },
      body: oversizedBytes,
    });
    expect(big.status).toBe(200);
    const bigBody = (await big.json()) as { width: number; height: number };
    expect(bigBody.width).toBeLessThanOrEqual(1280);
    expect(bigBody.height).toBeLessThanOrEqual(1280);
    expect(Math.max(bigBody.width, bigBody.height)).toBe(1280);
  });

  test("in-flight ticket cap blocks issuance and frees the slot on upgrade", async () => {
    const h = start({ maxActiveTickets: 1 });
    const first = await ticket(h);
    const blocked = await fetch(`${h.url}/api/v1/ws-tickets`, {
      method: "POST",
      headers: auth(),
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: { code: "ticket_store_full" },
    });

    const ws = new WebSocket(`${h.wsUrl}?ticket=${first}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("open timeout")), 3000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("open failed"));
      };
    });
    ws.close();

    const freed = await fetch(`${h.url}/api/v1/ws-tickets`, {
      method: "POST",
      headers: auth(),
    });
    expect(freed.status).toBe(200);
  });

  test("a signed ticket not issued by this server is rejected", async () => {
    const issuer = start();
    const receiver = start(); // same TICKET_SECRET, different pendingTickets map
    const foreign = await ticket(issuer);
    const ws = new WebSocket(`${receiver.wsUrl}?ticket=${foreign}`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
      ws.onclose = () => resolve();
      ws.onerror = () => resolve();
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  test("publish delivers to a subscriber; UNSUBSCRIBE stops delivery", async () => {
    const h = start();
    const ws = await openTicketSocket(h);
    try {
      ws.send(JSON.stringify({ type: "SUBSCRIBE", channel: "alerts" }));
      expect(JSON.parse(await nextMessage(ws))).toMatchObject({
        type: "SUBSCRIBED",
        channel: "alerts",
      });

      const delivered = nextMessage(ws);
      const publish = await fetch(`${h.url}/api/v1/live-bets`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ channel: "alerts", event: { ticket: "T1" } }),
      });
      expect(publish.status).toBe(200);
      const published = (await publish.json()) as { published: number };
      expect(published.published).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(await delivered)).toEqual({ ticket: "T1" });

      ws.send(JSON.stringify({ type: "UNSUBSCRIBE", channel: "alerts" }));
      expect(JSON.parse(await nextMessage(ws))).toMatchObject({
        type: "UNSUBSCRIBED",
        channel: "alerts",
      });
      const maybeDelivery = nextMessage(ws).then(() => "delivered");
      await fetch(`${h.url}/api/v1/live-bets`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ channel: "alerts", event: { ticket: "T2" } }),
      });
      const silent = await Promise.race([
        maybeDelivery,
        Bun.sleep(250).then(() => "silent"),
      ]);
      expect(silent).toBe("silent");
    } finally {
      ws.close();
    }
  });

  test("publish route validates auth, JSON, channel and factory method", async () => {
    const h = start();
    const unauth = await fetch(`${h.url}/api/v1/live-bets`, {
      method: "POST",
      body: JSON.stringify({ channel: "alerts", event: {} }),
    });
    expect(unauth.status).toBe(401);

    for (const [body, code] of [
      ["not-json", "invalid_json"],
      [
        JSON.stringify({ channel: "BAD CHANNEL", event: {} }),
        "invalid_channel",
      ],
      [JSON.stringify({ nope: true }), "invalid_publish"],
    ] as const) {
      const response = await fetch(`${h.url}/api/v1/live-bets`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });
});
