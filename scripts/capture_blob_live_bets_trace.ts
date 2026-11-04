#!/usr/bin/env bun
/**
 * Sanitized loopback trace for the blob/live-bets gateway.
 *
 * This is a FIXTURE, not live wire evidence: docs/evidence/captures/ is live-only and a
 * loopback record must never upgrade a ledger tier. The trace is written under
 * tests/fixtures/captures/ and is used by tests to pin the handler contracts.
 *
 *   bun run scripts/capture_blob_live_bets_trace.ts
 */

import { z } from "zod";

import {
  createBlobLiveBetsServer,
  type BlobStore,
} from "../services/blob_and_live_bets_server.ts";

const API_TOKEN = "trace-api-token-not-a-secret";
const TICKET_SECRET = "trace-ticket-secret-not-a-secret";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const OUT = "tests/fixtures/captures/blob-live-bets/loopback-trace.json";

class MemoryStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.objects.set(key, bytes);
    return { bytesWritten: bytes.byteLength };
  }
  presignGet(key: string, expiresInSec: number): string {
    return `https://r2.example.invalid/blobs/${key}.webp?expires=${expiresInSec}`;
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async stat(key: string): Promise<{ size: number; contentType: string }> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error("blob not found");
    return { size: bytes.byteLength, contentType: "image/webp" };
  }
  async getResponse(key: string): Promise<Response> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error("blob not found");
    return new Response(bytes, {
      headers: { "content-type": "image/webp" },
    });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const stepSchema = z.object({
  name: z.string(),
  request: z.object({
    method: z.string(),
    path: z.string(),
    headers: z.record(z.string(), z.string()),
  }),
  response: z.object({
    status: z.number(),
    contentType: z.string().nullable(),
    body: z.unknown(),
  }),
  websocket: z
    .array(
      z.object({
        direction: z.enum(["send", "receive", "close"]),
        data: z.string(),
      }),
    )
    .optional(),
});

type Step = z.infer<typeof stepSchema>;

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name] = /authorization|cookie|set-cookie/i.test(name)
      ? "<redacted>"
      : value;
  }
  return out;
}

async function httpStep(
  name: string,
  url: string,
  init: RequestInit,
): Promise<Step> {
  const request = new Request(url, init);
  const response = await fetch(request);
  const contentType = response.headers.get("content-type");
  let body: unknown = null;
  if (contentType?.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }
  const path = new URL(url).pathname;
  return {
    name,
    request: {
      method: request.method,
      path,
      headers: redactHeaders(request.headers),
    },
    response: {
      status: response.status,
      contentType,
      body:
        name === "get-presigned-blob"
          ? { location: "<presigned-url-redacted>" }
          : body,
    },
  };
}

function wsStep(name: string, ticket: string, channel: string): Promise<Step> {
  return new Promise((resolve, reject) => {
    const frames: {
      direction: "send" | "receive" | "close";
      data: string;
    }[] = [];
    const ws = new WebSocket(`${WS_URL}/ws/live-bets`, [
      "live-bets.v1",
      `ticket.${ticket}`,
    ]);
    const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
    ws.onopen = () => {
      frames.push({ direction: "send", data: "ping" });
      ws.send(JSON.stringify({ type: "PING" }));
    };
    ws.onmessage = (event) => {
      const text = String(event.data);
      frames.push({ direction: "receive", data: text });
      const parsed = JSON.parse(text) as { type?: string };
      if (parsed.type === "PONG") {
        ws.send(JSON.stringify({ type: "SUBSCRIBE", channel }));
      } else if (parsed.type === "SUBSCRIBED") {
        ws.send(JSON.stringify({ type: "UNSUBSCRIBE", channel }));
      } else if (parsed.type === "UNSUBSCRIBED") {
        clearTimeout(timer);
        frames.push({ direction: "close", data: "101" });
        ws.close();
        resolve({
          name,
          request: {
            method: "GET",
            path: "/ws/live-bets",
            headers: {
              "sec-websocket-protocol": "live-bets.v1, ticket.<redacted>",
            },
          },
          response: {
            status: 101,
            contentType: null,
            body: "switching protocols",
          },
          websocket: frames,
        });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
}

let WS_URL = "";

const store = new MemoryStore();
const { server, close, publish } = createBlobLiveBetsServer({
  blobs: store,
  apiToken: API_TOKEN,
  ticketSecret: TICKET_SECRET,
  port: 0,
  hostname: "127.0.0.1",
});
WS_URL = `ws://127.0.0.1:${server.port}`;
const BASE = `http://127.0.0.1:${server.port}`;
const headers = { authorization: `Bearer ${API_TOKEN}` };
const steps: Step[] = [];

try {
  steps.push(await httpStep("get-health", `${BASE}/health`, { headers }));
  const ticket = await httpStep("post-ws-ticket", `${BASE}/api/v1/ws-tickets`, {
    method: "POST",
    headers,
  });
  steps.push(ticket);
  const ticketValue = (ticket.response.body as { ticket?: string }).ticket;
  if (ticketValue === undefined) throw new Error("no ticket issued");
  steps.push(
    await httpStep("get-presigned-blob", `${BASE}/api/v1/blobs/trace`, {
      headers,
      redirect: "manual",
    }),
  );
  steps.push(
    await httpStep("put-blob", `${BASE}/api/v1/blobs/trace`, {
      method: "PUT",
      headers: { ...headers, "content-type": "image/png" },
      body: Uint8Array.from(Buffer.from(PNG_1X1, "base64")),
    }),
  );
  // Publisher while a subscriber is connected.
  const subscriberStepPromise = wsStep("ws-live-bets", ticketValue, "alerts");
  await Bun.sleep(100);
  const publishStepPromise = httpStep(
    "post-publish",
    `${BASE}/api/v1/live-bets`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ channel: "alerts", event: { ticket: "TRACE-1" } }),
    },
  );
  const [subscriberStep, publishStep] = await Promise.all([
    subscriberStepPromise,
    publishStepPromise,
  ]);
  steps.push(publishStep, subscriberStep);
} finally {
  close(true);
}

const artifact = {
  schemaVersion: 1,
  kind: "loopback-fixture",
  note: "Sanitized loopback HTTP + WebSocket trace. NOT live evidence: docs/evidence/captures is live-only and this fixture cannot upgrade a ledger tier.",
  gateway: "surface.blob-live-bets",
  capturedAt: new Date().toISOString(),
  baseUrl: "http://127.0.0.1:<port>",
  server: {
    bun: Bun.version,
    revision: Bun.revision,
    routes: [
      "GET /health",
      "POST /api/v1/ws-tickets",
      "GET /api/v1/blobs/{key}",
      "PUT /api/v1/blobs/{key}",
      "POST /api/v1/live-bets",
      "GET /ws/live-bets",
    ],
    publishedProgrammatically: typeof publish,
  },
  steps,
};

z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("loopback-fixture"),
  steps: z.array(stepSchema),
}).parse(artifact);

await Bun.write(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`blob-live-bets trace: ${steps.length} step(s) → ${OUT}`);
