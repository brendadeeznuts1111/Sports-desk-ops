/**
 * @file tests/bun_socket_contracts.test.ts
 * @description Pins the Bun TCP socket behaviours the ops daemons depend on:
 * `write()` on a closed socket, `connectError` alongside the rejected promise,
 * and what `binaryType` actually delivers.
 *
 * Measured on `Bun 1.4.4+38afee6c8` (2026-11-17):
 *
 *   binaryType: "arraybuffer"            -> ArrayBuffer
 *   binaryType: "buffer"  (the default)  -> Buffer
 *   binaryType: "uint8array"             -> Uint8Array, and NOT a Buffer
 *
 * The last distinction is the one that matters: `Buffer` extends `Uint8Array`,
 * so `expect(data).toBeInstanceOf(Uint8Array)` passes for the default mode as
 * well and pins nothing. These assertions use the constructor that actually
 * differs.
 *
 * Delivery is awaited through the handler, never `Bun.sleep`, and every server
 * and client is closed in `finally` so a failed assertion cannot leak a
 * listener and hang the runner.
 */

import { describe, expect, test } from "bun:test";

type Delivered = {
  readonly ctor: string;
  readonly isBuffer: boolean;
  readonly isUint8Array: boolean;
  readonly isArrayBuffer: boolean;
};

function classify(value: unknown): Delivered {
  return {
    ctor:
      (value as { constructor?: { name?: string } })?.constructor?.name ??
      typeof value,
    isBuffer: Buffer.isBuffer(value),
    isUint8Array: value instanceof Uint8Array,
    isArrayBuffer: value instanceof ArrayBuffer,
  };
}

/** Connects, sends three bytes, and returns what the server's handler received. */
async function deliveredFor(
  binaryType: "arraybuffer" | "buffer" | "uint8array" | undefined,
): Promise<Delivered> {
  let received: Delivered | undefined;
  let settle: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    // The handler is generic over binaryType, which a union parameter cannot
    // thread through; the value is narrowed by `classify` instead.
    socket: {
      ...(binaryType === undefined ? {} : { binaryType }),
      data(_socket: unknown, data: unknown) {
        received = classify(data);
        settle?.();
      },
    } as never,
  });

  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data() {} },
  });

  try {
    client.write(new Uint8Array([1, 2, 3]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`no data delivered (binaryType=${String(binaryType)})`),
          ),
        2_000,
      );
    });
    try {
      await Promise.race([arrived, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (received === undefined) {
      throw new Error("handler ran without recording a payload");
    }
    return received;
  } finally {
    client.close();
    server.stop(true);
  }
}

describe("Bun TCP socket contracts", () => {
  test("write() on a closed socket returns -1, and a partial-write loop stops", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, connectError() {} },
    });

    try {
      client.close();
      expect(client.write("x")).toBe(-1);

      // A loop that treats -1 as "keep trying" would spin forever.
      const payload = new TextEncoder().encode("hello");
      let written = 0;
      let iterations = 0;
      while (written < payload.length && iterations < 100) {
        const n = client.write(payload.subarray(written));
        iterations++;
        if (n < 0) break;
        written += n;
      }
      expect(written).toBeLessThan(payload.length);
      expect(iterations).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("connectError fires and the promise still rejects", async () => {
    // A deterministic refusal: bind, learn the port, stop, then connect there.
    // Port 1 is not guaranteed closed on every runner.
    const holder = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const deadPort = holder.port;
    holder.stop(true);

    let called = false;
    await expect(
      Bun.connect({
        hostname: "127.0.0.1",
        port: deadPort,
        socket: {
          data() {},
          connectError(_socket, _error) {
            called = true;
          },
        },
      }),
    ).rejects.toBeDefined();
    expect(called).toBe(true);
  });

  test("binaryType default delivers Buffer, not a bare Uint8Array", async () => {
    const delivered = await deliveredFor(undefined);
    expect(delivered.isBuffer).toBe(true);
    expect(delivered.ctor).toBe("Buffer");
    expect(delivered.isArrayBuffer).toBe(false);
  });

  test("binaryType uint8array delivers a Uint8Array that is not a Buffer", async () => {
    // `toBeInstanceOf(Uint8Array)` alone would pass for the default Buffer mode.
    const delivered = await deliveredFor("uint8array");
    expect(delivered.isUint8Array).toBe(true);
    expect(delivered.isBuffer).toBe(false);
    expect(delivered.ctor).toBe("Uint8Array");
  });

  test("binaryType buffer delivers Buffer", async () => {
    const delivered = await deliveredFor("buffer");
    expect(delivered.isBuffer).toBe(true);
    expect(delivered.ctor).toBe("Buffer");
  });

  test("binaryType arraybuffer delivers an ArrayBuffer", async () => {
    const delivered = await deliveredFor("arraybuffer");
    expect(delivered.isArrayBuffer).toBe(true);
    expect(delivered.isUint8Array).toBe(false);
  });
});
