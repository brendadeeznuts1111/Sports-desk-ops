#!/usr/bin/env bun
/**
 * Hardened blob + live-bet gateway for `feat/blob-and-live-bets`.
 *
 * - Authenticated writes/reads: constant-time bearer check; no anonymous bucket access.
 * - Bounded reads: Content-Length precheck plus a streaming byte cap, so `Bun.Image`'s
 *   `maxPixels` guard is not the only line of defence.
 * - Deterministic image output: `Bun.Image.backend = "bun"` before resize/webp bytes.
 * - WebSocket access by short-lived HMAC ticket (browser-friendly); message size + JSON limits.
 * - Injectable `BlobStore` so the tests never touch R2.
 *
 * Run: BLOB_API_TOKEN=… BLOB_TICKET_SECRET=… R2_* env bun services/blob_and_live_bets_server.ts
 */

import { S3Client } from "bun";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { imageErrorCode } from "../lib/image_errors.ts";

export interface BlobStore {
  put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ readonly bytesWritten: number }>;
  presignGet(key: string, expiresInSec: number): string;
}

export interface BlobLiveBetsOptions {
  readonly blobs: BlobStore;
  /** Bearer token for blob reads/writes and ws-ticket issuance. */
  readonly apiToken: string;
  /** HMAC secret for short-lived WebSocket tickets. */
  readonly ticketSecret: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly maxUploadBytes?: number;
  readonly maxPixels?: number;
  readonly maxWsMessageBytes?: number;
  readonly ticketTtlSec?: number;
  /** Hard cap on consumed-but-unexpired ticket nonces. Default 4096. */
  readonly maxActiveTickets?: number;
  readonly presignTtlSec?: number;
  /** Injectable clock (seconds) for ticket tests. */
  readonly nowSec?: () => number;
}

export interface SocketData {
  readonly clientId: string;
  readonly channels: Set<string>;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const TICKET_TTL_SEC = 60;
const MAX_ACTIVE_TICKETS = 4096;
const PRESIGN_TTL_SEC = 3600;
const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
]);
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_PATTERN = /^[a-z0-9-]{1,32}$/;

const ticketPayloadSchema = z.object({
  exp: z.number().int().positive(),
  nonce: z.string().uuid(),
});
const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PING") }),
  z.object({ type: z.literal("SUBSCRIBE"), channel: z.string() }),
  z.object({ type: z.literal("UNSUBSCRIBE"), channel: z.string() }),
]);

class ImageRejectedError extends Error {
  constructor(
    readonly status: 413 | 415 | 422,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ImageRejectedError";
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function hash(value: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  const a = hash(left);
  const b = hash(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

function authorized(request: Request, apiToken: string): boolean {
  const provided = bearerToken(request);
  return provided !== null && safeEqual(provided, apiToken);
}

function validKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !key.includes("..");
}

function createTicket(
  secret: string,
  nowSec: number,
  ttlSec: number,
): { readonly ticket: string; readonly nonce: string; readonly exp: number } {
  const nonce = randomUUID();
  const exp = nowSec + ttlSec;
  const payload = Buffer.from(JSON.stringify({ exp, nonce })).toString(
    "base64url",
  );
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return { ticket: `${payload}.${mac}`, nonce, exp };
}

function verifyTicket(
  ticket: string,
  secret: string,
  nowSec: number,
  pendingTickets: Map<string, number>,
): boolean {
  const parts = ticket.split(".");
  if (parts.length !== 2) return false;
  const [payload, mac] = parts;
  if (payload === undefined || mac === undefined) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(mac, "base64url");
  } catch {
    return false;
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const result = ticketPayloadSchema.safeParse(parsed);
  if (!result.success || result.data.exp < nowSec) return false;
  pruneTicketNonces(pendingTickets, nowSec);
  // Allowlist: the nonce must have been issued by this process and not yet consumed.
  if (pendingTickets.get(result.data.nonce) !== result.data.exp) return false;
  pendingTickets.delete(result.data.nonce);
  return true;
}

function pruneTicketNonces(
  usedNonces: Map<string, number>,
  nowSec: number,
): void {
  for (const [nonce, expiry] of usedNonces) {
    if (expiry < nowSec) usedNonces.delete(nonce);
  }
}

function ticketFromRequest(request: Request): {
  readonly ticket: string | null;
  readonly echoProtocol: string | null;
} {
  const queryTicket = new URL(request.url).searchParams.get("ticket");
  if (queryTicket !== null && queryTicket !== "") {
    return { ticket: queryTicket, echoProtocol: null };
  }
  const header = request.headers.get("sec-websocket-protocol");
  if (header === null) return { ticket: null, echoProtocol: null };
  const protocols = header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
  const echoProtocol = protocols.includes("live-bets.v1")
    ? "live-bets.v1"
    : null;
  const ticketEntry = protocols.find((protocol) =>
    protocol.startsWith("ticket."),
  );
  return {
    ticket:
      ticketEntry === undefined ? null : ticketEntry.slice("ticket.".length),
    echoProtocol,
  };
}

/** Read at most `maxBytes`, canceling the stream as soon as the cap is crossed. */
async function readBounded(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function transcodeToWebp(
  bytes: Uint8Array,
  maxPixels: number,
): Promise<{
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}> {
  const image = new Bun.Image(bytes, { maxPixels, autoOrient: true });
  try {
    const meta = await image.metadata();
    const pipeline =
      meta.width > 1280 || meta.height > 1280
        ? image.resize(1280, 1280, { fit: "inside" }).webp({ quality: 82 })
        : image.webp({ quality: 82 });
    const webp = await pipeline.bytes();
    return { bytes: webp, width: pipeline.width, height: pipeline.height };
  } catch (error) {
    const code = imageErrorCode(error);
    if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
      throw new ImageRejectedError(413, code, { cause: error });
    }
    if (
      code === "ERR_IMAGE_FORMAT_UNSUPPORTED" ||
      code === "ERR_IMAGE_UNKNOWN_FORMAT"
    ) {
      throw new ImageRejectedError(415, code, { cause: error });
    }
    throw new ImageRejectedError(422, code ?? "ERR_IMAGE_DECODE_FAILED", {
      cause: error,
    });
  }
}

type KeyedRequest = Request & { readonly params: { readonly key: string } };

function numberEnv(name: string, fallback: number, minimum = 1): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}, got "${raw}"`);
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** The gateway's served surface, as data; tests compare it with its OpenAPI fragment. */
export const BLOB_LIVE_BETS_ROUTES = [
  { method: "GET", path: "/health", auth: "none" },
  { method: "POST", path: "/api/v1/ws-tickets", auth: "bearer" },
  { method: "POST", path: "/api/v1/live-bets", auth: "bearer" },
  { method: "GET", path: "/api/v1/blobs/{key}", auth: "bearer" },
  { method: "PUT", path: "/api/v1/blobs/{key}", auth: "bearer" },
  { method: "GET", path: "/ws/live-bets", auth: "bearer" },
] as const;

export function createBlobLiveBetsServer(options: BlobLiveBetsOptions): {
  readonly server: Bun.Server<SocketData>;
  readonly close: (force?: boolean) => void;
  readonly publish: (channel: string, event: unknown) => number;
} {
  const maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const maxPixels = options.maxPixels ?? MAX_PIXELS;
  const maxWsMessageBytes = options.maxWsMessageBytes ?? MAX_WS_MESSAGE_BYTES;
  const ticketTtlSec = options.ticketTtlSec ?? TICKET_TTL_SEC;
  const presignTtlSec = options.presignTtlSec ?? PRESIGN_TTL_SEC;
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const pendingTickets = new Map<string, number>();
  const maxActiveTickets = options.maxActiveTickets ?? MAX_ACTIVE_TICKETS;
  // Resized bytes differ between platforms unless the Bun backend is pinned (AGENTS.md).
  Bun.Image.backend = "bun";

  const server = Bun.serve<SocketData>({
    port: options.port ?? 3000,
    hostname: options.hostname ?? "127.0.0.1",
    routes: {
      "/health": {
        GET: () =>
          Response.json({
            status: "ok",
            bunRevision: Bun.revision,
            uptimeNs: Bun.nanoseconds(),
          }),
      },
      "/api/v1/ws-tickets": {
        POST: (request: Request) => {
          if (!authorized(request, options.apiToken)) {
            return jsonError(401, "unauthorized", "Bearer token required");
          }
          pruneTicketNonces(pendingTickets, nowSec());
          if (pendingTickets.size >= maxActiveTickets) {
            return jsonError(
              429,
              "ticket_store_full",
              "Too many unused tickets; wait for expiry or complete a handshake",
            );
          }
          const issued = createTicket(
            options.ticketSecret,
            nowSec(),
            ticketTtlSec,
          );
          pendingTickets.set(issued.nonce, issued.exp);
          return Response.json({
            ticket: issued.ticket,
            expiresInSec: ticketTtlSec,
          });
        },
      },
      "/api/v1/live-bets": {
        POST: async (request: Request) => {
          if (!authorized(request, options.apiToken)) {
            return jsonError(401, "unauthorized", "Bearer token required");
          }
          const raw = await readBounded(request, maxWsMessageBytes);
          if (raw === null) {
            return jsonError(413, "payload_too_large", "Body too large");
          }
          let body: unknown;
          try {
            body = JSON.parse(new TextDecoder().decode(raw));
          } catch {
            return jsonError(400, "invalid_json", "Body is not JSON");
          }
          const parsed = z
            .object({ channel: z.string(), event: z.unknown() })
            .safeParse(body);
          if (!parsed.success) {
            return jsonError(
              400,
              "invalid_publish",
              "Expected {channel, event}",
            );
          }
          if (!CHANNEL_PATTERN.test(parsed.data.channel)) {
            return jsonError(400, "invalid_channel", "Invalid channel");
          }
          let published: number;
          try {
            published = server.publish(
              parsed.data.channel,
              JSON.stringify(parsed.data.event),
            );
          } catch {
            return jsonError(
              422,
              "publish_failed",
              "Event is not serializable",
            );
          }
          return Response.json({
            channel: parsed.data.channel,
            published,
          });
        },
      },
      "/api/v1/blobs/:key": {
        GET: (request: KeyedRequest) => {
          if (!authorized(request, options.apiToken)) {
            return jsonError(401, "unauthorized", "Bearer token required");
          }
          const key = request.params.key;
          if (!validKey(key)) {
            return jsonError(400, "invalid_key", "Invalid blob key");
          }
          let url: string;
          try {
            url = options.blobs.presignGet(key, presignTtlSec);
          } catch {
            return jsonError(
              502,
              "presign_failed",
              "Could not presign the blob",
            );
          }
          return Response.redirect(url, 302);
        },
        PUT: async (request: KeyedRequest) => {
          if (!authorized(request, options.apiToken)) {
            return jsonError(401, "unauthorized", "Bearer token required");
          }
          const key = request.params.key;
          if (!validKey(key)) {
            return jsonError(400, "invalid_key", "Invalid blob key");
          }
          const contentType =
            request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
          if (!IMAGE_CONTENT_TYPES.has(contentType)) {
            return jsonError(
              415,
              "unsupported_media_type",
              "Expected image/jpeg, image/png, image/webp, image/avif or image/heic",
            );
          }
          const raw = await readBounded(request, maxUploadBytes);
          if (raw === null) {
            return jsonError(
              413,
              "payload_too_large",
              `Upload exceeds ${maxUploadBytes} bytes`,
            );
          }
          let transcoded: {
            readonly bytes: Uint8Array;
            readonly width: number;
            readonly height: number;
          };
          try {
            transcoded = await transcodeToWebp(raw, maxPixels);
          } catch (error) {
            if (error instanceof ImageRejectedError) {
              return jsonError(error.status, error.code, "Image rejected");
            }
            return jsonError(422, "image_rejected", "Image rejected");
          }
          try {
            const { bytesWritten } = await options.blobs.put(
              key,
              transcoded.bytes,
              "image/webp",
            );
            return Response.json({
              key: `blobs/${key}.webp`,
              bytesWritten,
              bytes: transcoded.bytes.byteLength,
              width: transcoded.width,
              height: transcoded.height,
            });
          } catch {
            return jsonError(502, "store_failed", "Could not store the blob");
          }
        },
      },
      "/ws/live-bets": (request: Request, srv: Bun.Server<SocketData>) => {
        const extracted = ticketFromRequest(request);
        if (
          extracted.ticket === null ||
          !verifyTicket(
            extracted.ticket,
            options.ticketSecret,
            nowSec(),
            pendingTickets,
          )
        ) {
          return jsonError(
            401,
            "unauthorized",
            "Valid unused ws-ticket required",
          );
        }
        const upgraded = srv.upgrade(request, {
          data: {
            clientId: randomUUID(),
            channels: new Set<string>(["live-bets"]),
          },
          ...(extracted.echoProtocol === null
            ? {}
            : {
                headers: { "Sec-WebSocket-Protocol": extracted.echoProtocol },
              }),
        });
        if (upgraded) return undefined;
        return jsonError(426, "upgrade_required", "WebSocket upgrade failed");
      },
    },
    fetch: () => jsonError(404, "not_found", "Not Found"),
    websocket: {
      open(ws) {
        for (const channel of ws.data.channels) ws.subscribe(channel);
      },
      message(ws, message) {
        const size =
          typeof message === "string"
            ? Buffer.byteLength(message)
            : message.byteLength;
        if (size > maxWsMessageBytes) {
          ws.close(1009, "message too large");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            typeof message === "string" ? message : message.toString("utf8"),
          );
        } catch {
          ws.send(JSON.stringify({ type: "ERROR", code: "invalid_json" }));
          return;
        }
        const result = clientMessageSchema.safeParse(parsed);
        if (!result.success) {
          ws.send(JSON.stringify({ type: "ERROR", code: "invalid_message" }));
          return;
        }
        const msg = result.data;
        if (msg.type === "PING") {
          ws.send(JSON.stringify({ type: "PONG", ts: Date.now() }));
          return;
        }
        if (!CHANNEL_PATTERN.test(msg.channel)) {
          ws.send(JSON.stringify({ type: "ERROR", code: "invalid_channel" }));
          return;
        }
        if (msg.type === "SUBSCRIBE") {
          ws.subscribe(msg.channel);
          ws.data.channels.add(msg.channel);
          ws.send(JSON.stringify({ type: "SUBSCRIBED", channel: msg.channel }));
          return;
        }
        ws.unsubscribe(msg.channel);
        ws.data.channels.delete(msg.channel);
        ws.send(JSON.stringify({ type: "UNSUBSCRIBED", channel: msg.channel }));
      },
      close(ws) {
        for (const channel of ws.data.channels) ws.unsubscribe(channel);
      },
    },
  });

  return {
    server,
    close: (force = true) => server.stop(force),
    publish(channel: string, event: unknown): number {
      if (!CHANNEL_PATTERN.test(channel)) {
        throw new Error("invalid channel");
      }
      return server.publish(channel, JSON.stringify(event));
    },
  };
}

/** S3/R2 adapter; constructed only by the CLI entrypoint, never in tests. */
export function createS3BlobStore(config: {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly endpoint: string;
}): BlobStore {
  const client = new S3Client(config);
  return {
    async put(key, bytes, contentType) {
      const file = client.file(`blobs/${key}.webp`);
      const written = await file.write(bytes, { type: contentType });
      return {
        bytesWritten: typeof written === "number" ? written : bytes.byteLength,
      };
    },
    presignGet(key, expiresInSec) {
      return client
        .file(`blobs/${key}.webp`)
        .presign({ expiresIn: expiresInSec });
    },
  };
}

if (import.meta.main) {
  try {
    const endpoint =
      Bun.env.R2_ENDPOINT ??
      `https://${requiredEnv("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
    const blobs = createS3BlobStore({
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
      bucket: requiredEnv("R2_BUCKET_NAME"),
      endpoint,
    });
    const { server } = createBlobLiveBetsServer({
      blobs,
      apiToken: requiredEnv("BLOB_API_TOKEN"),
      ticketSecret: requiredEnv("BLOB_TICKET_SECRET"),
      port: numberEnv("BLOB_PORT", 4021, 0),
      maxUploadBytes: numberEnv("BLOB_MAX_UPLOAD_BYTES", MAX_UPLOAD_BYTES),
      maxPixels: numberEnv("BLOB_MAX_PIXELS", MAX_PIXELS),
    });
    console.log(
      JSON.stringify({
        service: "blob-and-live-bets",
        port: server.port,
        hostname: server.hostname,
      }),
    );
  } catch (error) {
    console.error(
      `blob-and-live-bets: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
