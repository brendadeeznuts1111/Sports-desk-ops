/**
 * @file tests/ppm_socket_feed.test.ts
 * @description The handshake state machine and the gzip frame decoder, tested
 * against a captured frame and a fake socket — no network in the suite.
 */
import { describe, expect, test } from "bun:test";
import {
  PPM_COEFFICIENTS_TOPIC_PREFIX,
  PPM_FEED_URL,
  PPM_HERITAGE_TOPIC,
  PpmFeedError,
  coefficientTopic,
  connectPpmFeed,
  decodeCoefficientFrame,
  decodePpmFrame,
  type PpmFrame,
  type PpmSocketLike,
} from "../lib/ppm_socket_feed.ts";

const FIXTURE = new URL("./fixtures/ppm/eventdata.crop.gz", import.meta.url);
const FRAME_BYTES = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());

describe("decodePpmFrame", () => {
  test("decodes the captured frame", () => {
    const frame = decodePpmFrame(FRAME_BYTES);
    expect(frame.isDiff).toBe(false);
    const sports = frame.payload!.s as Record<string, unknown>;
    expect(Object.keys(sports)).toEqual(["1", "102"]);
  });

  test("refuses a payload that is not gzip", () => {
    expect(() => decodePpmFrame(new Uint8Array([1, 2, 3]))).toThrow(
      PpmFeedError,
    );
    expect(() => decodePpmFrame(new Uint8Array([0x1f, 0x8b]))).toThrow(
      /gunzip failed/,
    );
  });

  test("refuses gzip that is not a frame", () => {
    const notJson = Bun.gzipSync(new TextEncoder().encode("not json"));
    expect(() => decodePpmFrame(notJson)).toThrow(/not JSON/);

    const noFlag = Bun.gzipSync(new TextEncoder().encode('{"payload":{}}'));
    expect(() => decodePpmFrame(noFlag)).toThrow(/isDiff/);

    // A notification frame is valid traffic, not a decode failure.
    const noPayload = Bun.gzipSync(new TextEncoder().encode('{"isDiff":true}'));
    expect(decodePpmFrame(noPayload)).toEqual({
      isDiff: true,
      payload: null,
      ti: null,
    });
  });
});

class FakeSocket implements PpmSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private handlers = new Map<
    string,
    Array<(event: { data?: unknown }) => void>
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(
    type: string,
    handler: (event: { data?: unknown }) => void,
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

describe("connectPpmFeed", () => {
  function connect(): {
    socket: FakeSocket;
    frames: PpmFrame[];
    ready: () => boolean;
  } {
    const socket = new FakeSocket();
    const frames: PpmFrame[] = [];
    let ready = false;
    connectPpmFeed({
      socketFactory: () => socket,
      onFrame: (frame) => frames.push(frame),
      onReady: () => {
        ready = true;
      },
    });
    return { socket, frames, ready: () => ready };
  }

  test("walks the handshake in order", () => {
    const { socket, ready } = connect();
    expect(socket.sent).toEqual([]);

    socket.emit("message", { data: '0{"sid":"abc","pingInterval":25000}' });
    expect(socket.sent.at(-1)).toBe("40");

    socket.emit("message", { data: '40{"sid":"def"}' });
    expect(JSON.parse(socket.sent.at(-1)!.slice(2))).toEqual([
      "setSocketMetadata",
      { partnerId: "118", flavor: "prematch" },
    ]);

    socket.emit("message", {
      data: '42["setSocketMetadata",{"event":"socketMetadataSet","data":{}}]',
    });
    expect(JSON.parse(socket.sent.at(-1)!.slice(2))).toEqual([
      "subscribe",
      [PPM_HERITAGE_TOPIC],
    ]);

    expect(ready()).toBe(false);
    socket.emit("message", {
      data: `42["subscribed",["${PPM_HERITAGE_TOPIC}"]]`,
    });
    expect(ready()).toBe(true);
  });

  test("decodes binary attachments and keeps going after a bad one", () => {
    const socket = new FakeSocket();
    const frames: PpmFrame[] = [];
    const errors: Error[] = [];
    connectPpmFeed({
      socketFactory: () => socket,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
    });

    socket.emit("message", { data: "0{}" });
    socket.emit("message", { data: "40{}" });
    socket.emit("message", {
      data: '42["setSocketMetadata",{"event":"socketMetadataSet"}]',
    });

    socket.emit("message", { data: FRAME_BYTES.buffer });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.isDiff).toBe(false);

    socket.emit("message", { data: new Uint8Array([9, 9, 9]).buffer });
    expect(errors).toHaveLength(1);

    socket.emit("message", { data: FRAME_BYTES.buffer });
    expect(frames).toHaveLength(2);
  });

  test("defaults match the measured endpoint and topic", () => {
    expect(PPM_FEED_URL).toContain("spandora.ganchrow.com/socket.io/");
    expect(PPM_HERITAGE_TOPIC).toBe("prematch.main.U0VWU1NWUkJSMFU9.eventData");
  });

  test("close() closes the underlying socket", () => {
    const { socket } = connect();
    const handle = connectPpmFeed({
      socketFactory: () => socket,
      onFrame: () => {},
    });
    handle.close();
    expect(socket.closed).toBe(true);
  });
});

const DESCRIPTOR = new Uint8Array(
  await Bun.file(
    new URL("./fixtures/ppm/coefficients.descriptor.gz", import.meta.url),
  ).arrayBuffer(),
);

describe("coefficient frames", () => {
  test("builds the per-event topic", () => {
    expect(coefficientTopic(51808859)).toBe(
      "prematch.main.U0VWU1NWUkJSMFU9.eventCoefficients.51808859",
    );
    expect(PPM_COEFFICIENTS_TOPIC_PREFIX).toBe(
      "prematch.main.U0VWU1NWUkJSMFU9.eventCoefficients",
    );
  });

  test("decodes the market-group descriptor", () => {
    const payload = decodeCoefficientFrame(DESCRIPTOR);
    expect(payload.eventId).toBe("51808859");
    expect(payload.coefficients).toEqual([]);
    expect(payload.group).not.toBeNull();
    expect(payload.group!.marketIds).toEqual([1, 2]);
    expect(payload.group!.selections).toEqual([
      [1, 0],
      [0, 2],
    ]);
    expect(payload.group!.updatedAtMs).toBe(1794583115000);
  });

  test("keeps an empty vector empty rather than inventing prices", () => {
    expect(decodeCoefficientFrame(DESCRIPTOR).coefficients).toHaveLength(0);
  });
});
