/**
 * @file lib/ppm_socket_feed.ts
 * @description Client for the PPM push feed (`wss://spandora.ganchrow.com`).
 *
 * The protocol is socket.io over engine.io v4, and it is small enough to speak
 * without the socket.io client:
 *
 *   server → `0{...}`            engine.io open
 *   client → `40`                connect the default namespace
 *   server → `40{"sid":...}`
 *   client → `42["setSocketMetadata",{partnerId,flavor}]`
 *   server → `42["setSocketMetadata",{event:"socketMetadataSet",...}]`
 *   client → `42["subscribe",["<flavor>.<distro>.<lineSet>.eventData"]]`
 *   server → `42["subscribed",[...]]`, then `451-[topic,{...}]` + a binary frame
 *
 * Binary frames are **gzip-compressed JSON** (`1f 8b 08`): a full snapshot with
 * `isDiff: false`, then deltas with `isDiff: true`.
 *
 * The socket is injected (`socketFactory`) so the state machine is testable
 * without the network; `decodePpmFrame` is pure and tested against a captured
 * frame.
 */

export interface PpmFrame {
  readonly isDiff: boolean;
  /**
   * `null` for a notification frame — the feed emits gzip JSON with only
   * `isDiff` (and sometimes `ti`), carrying no data. That is legal traffic,
   * not a decode failure, so callers skip it rather than log an error.
   */
  readonly payload: Record<string, unknown> | null;
  /** Feed timestamp marker, passed through untouched. */
  readonly ti: unknown;
}

export class PpmFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PpmFeedError";
  }
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Decodes one binary attachment from the feed. */
export function decodePpmFrame(bytes: Uint8Array<ArrayBuffer>): PpmFrame {
  if (
    bytes.byteLength < 2 ||
    bytes[0] !== GZIP_MAGIC_0 ||
    bytes[1] !== GZIP_MAGIC_1
  ) {
    throw new PpmFeedError(
      `frame is not gzip (head ${Array.from(bytes.slice(0, 2))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")})`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder().decode(Bun.gunzipSync(bytes));
  } catch (error) {
    throw new PpmFeedError(`gunzip failed: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PpmFeedError(`frame is not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || typeof parsed.isDiff !== "boolean") {
    throw new PpmFeedError("frame is missing the isDiff flag");
  }
  const payload = isRecord(parsed.payload) ? parsed.payload : null;
  return { isDiff: parsed.isDiff, payload, ti: parsed.ti ?? null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The slice of WebSocket this client needs; `WebSocket` satisfies it. */
export interface PpmSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    handler: (event: { data?: unknown }) => void,
  ): void;
}

export interface PpmSocketFeedOptions {
  /** Default: partner 118 on the prematch flavor, HERITAGE line set. */
  readonly partnerId?: string;
  readonly flavor?: string;
  readonly topics?: readonly string[];
  readonly url?: string;
  readonly onFrame: (frame: PpmFrame) => void;
  readonly onError?: (error: Error) => void;
  readonly onReady?: () => void;
  /** Injection point for tests. */
  readonly socketFactory?: (url: string) => PpmSocketLike;
}

export const PPM_FEED_URL =
  "wss://spandora.ganchrow.com/socket.io/?EIO=4&transport=websocket";
export const PPM_HERITAGE_TOPIC = "prematch.main.U0VWU1NWUkJSMFU9.eventData";

/** Prefix for the per-event coefficient topic: `<prefix>.<eventId>`. */
export const PPM_COEFFICIENTS_TOPIC_PREFIX =
  "prematch.main.U0VWU1NWUkJSMFU9.eventCoefficients";

/** The per-event line topic. Subscribing to the prefix alone yields nothing. */
export function coefficientTopic(eventId: string | number): string {
  return `${PPM_COEFFICIENTS_TOPIC_PREFIX}.${eventId}`;
}

/** Market-group descriptor carried alongside the coefficient vector. */
export interface PpmMarketGroup {
  readonly gp: number;
  readonly marketIds: readonly number[];
  readonly selections: readonly (readonly number[])[];
  readonly updatedAtMs: number | null;
}

export interface PpmCoefficientPayload {
  readonly eventId: string;
  /** Empty until the event has tradeable prices on this session. */
  readonly coefficients: readonly number[];
  readonly group: PpmMarketGroup | null;
}

/**
 * Decodes a coefficient frame.
 *
 * Corrected 2026-11-13: this topic ships the market-group descriptor on
 * subscribe, and its coefficient vector is empty for events with no open
 * market — not because of a session gate. The full price table comes from the
 * HTTP bootstrap (`getUpdates?groupId=…`), which is not part of this branch.
 * Empty stays empty; it is never turned into a price.
 */
export function decodeCoefficientFrame(
  bytes: Uint8Array<ArrayBuffer>,
): PpmCoefficientPayload {
  const frame = decodePpmFrame(bytes);
  const payload = frame.payload;
  if (!payload || typeof payload.id !== "string") {
    throw new PpmFeedError("coefficient frame is missing its event id");
  }
  const coefficients = Array.isArray(payload.c)
    ? payload.c.filter((value): value is number => typeof value === "number")
    : [];
  const rawGroup = payload.m;
  let group: PpmMarketGroup | null = null;
  if (isRecord(rawGroup)) {
    group = {
      gp: typeof rawGroup.gp === "number" ? rawGroup.gp : 0,
      marketIds: Array.isArray(rawGroup.m)
        ? rawGroup.m.filter(
            (value): value is number => typeof value === "number",
          )
        : [],
      selections: Array.isArray(rawGroup.s)
        ? rawGroup.s.filter(Array.isArray).map((row) => row as number[])
        : [],
      updatedAtMs: typeof rawGroup.tu === "number" ? rawGroup.tu : null,
    };
  }
  return { eventId: payload.id, coefficients, group };
}

/**
 * Connects, performs the handshake, and forwards decoded frames. Returns a
 * handle with `close()`. Incoming events are processed in order; a frame that
 * fails to decode is reported through `onError` and does not stop the feed.
 */
export function connectPpmFeed(options: PpmSocketFeedOptions): {
  close: () => void;
} {
  const partnerId = options.partnerId ?? "118";
  const flavor = options.flavor ?? "prematch";
  const topics = options.topics ?? [PPM_HERITAGE_TOPIC];
  const url = options.url ?? PPM_FEED_URL;
  const factory =
    options.socketFactory ??
    ((target: string) => new WebSocket(target) as PpmSocketLike);
  const report = (error: Error): void => options.onError?.(error);

  let socket: PpmSocketLike;
  try {
    socket = factory(url);
  } catch (error) {
    report(new PpmFeedError(`connect failed: ${(error as Error).message}`));
    return { close: () => {} };
  }

  const send = (data: string): void => {
    try {
      socket.send(data);
    } catch (error) {
      report(new PpmFeedError(`send failed: ${(error as Error).message}`));
    }
  };

  socket.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") {
      if (data.startsWith("0")) {
        send("40");
      } else if (data.startsWith("40{")) {
        send(
          `42["setSocketMetadata",${JSON.stringify({ partnerId, flavor })}]`,
        );
      } else if (data.includes("socketMetadataSet")) {
        send(`42["subscribe",${JSON.stringify([...topics])}]`);
      } else if (data.startsWith('42["subscribed"')) {
        options.onReady?.();
      }
      return;
    }
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      try {
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        options.onFrame(decodePpmFrame(bytes));
      } catch (error) {
        report(error as Error);
      }
    }
  });

  socket.addEventListener("error", () =>
    report(new PpmFeedError("socket error")),
  );

  return {
    close: () => {
      try {
        socket.close();
      } catch {
        // closing an already-closed socket is not an error worth reporting
      }
    },
  };
}
