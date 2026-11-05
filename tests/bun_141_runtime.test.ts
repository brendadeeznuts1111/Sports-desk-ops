import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bun 1.4.1 runtime surfaces the ops tooling can use without a shim:
 *  - `Bun.write` streams a Response/ReadableStream body instead of stringifying it;
 *  - the client `WebSocket` can pause/resume reads (a Bun extension);
 *  - `node:crypto.argon2` runs on the thread pool and matches the sync tag.
 */

describe("Bun 1.4.1 streaming and backpressure", () => {
  test("Bun.write streams Response and ReadableStream bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-write-stream-"));
    try {
      const responsePath = join(dir, "response.txt");
      await Bun.write(responsePath, new Response("hello"));
      expect(await Bun.file(responsePath).text()).toBe("hello");

      const streamPath = join(dir, "stream.txt");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed"));
          controller.close();
        },
      });
      await Bun.write(streamPath, stream);
      expect(await Bun.file(streamPath).text()).toBe("streamed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("client WebSocket pause/resume stops and restarts delivery", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, srv) =>
        srv.upgrade(request) ? undefined : new Response("no", { status: 426 }),
      websocket: {
        open(ws) {
          let index = 0;
          timer = setInterval(() => {
            try {
              ws.send(`m${index++}`);
            } catch {
              // The client closed between ticks.
            }
          }, 5);
        },
        message() {},
        close() {
          if (timer !== undefined) clearInterval(timer);
        },
      },
    });
    const url = new URL(server.url);
    url.protocol = "ws:";
    const socket = new WebSocket(url);
    try {
      type Result = {
        pausedAt: number;
        afterPause: number;
        final: number;
        paused: boolean;
        resumed: boolean;
        isPaused: boolean;
      };
      const result = await new Promise<Result>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("WebSocket pause/resume timeout")),
          5_000,
        );
        let count = 0;
        let pausedAt = -1;
        socket.addEventListener("message", async () => {
          count += 1;
          if (pausedAt !== -1) return;
          pausedAt = count;
          try {
            const paused = socket.pause();
            await Bun.sleep(200);
            const afterPause = count;
            const resumed = socket.resume();
            await Bun.sleep(150);
            clearTimeout(deadline);
            resolve({
              pausedAt,
              afterPause,
              final: count,
              paused,
              resumed,
              isPaused: socket.isPaused,
            });
          } catch (error) {
            clearTimeout(deadline);
            reject(error);
          }
        });
      });
      expect(result.paused).toBe(true);
      // Messages already decoded before pause() may still arrive; the stream then stops.
      expect(result.afterPause).toBeLessThanOrEqual(result.pausedAt + 1);
      expect(result.resumed).toBe(true);
      expect(result.final).toBeGreaterThan(result.afterPause);
      expect(result.isPaused).toBe(false);
    } finally {
      socket.close();
      server.stop(true);
      if (timer !== undefined) clearInterval(timer);
    }
  });

  test("util.inspect stops at maxArrayLength", async () => {
    const util = await import("node:util");
    // oxlint-disable-next-line unicorn/no-new-array -- a 2M-element fixture is the point of the inspect truncation check.
    const out = util.inspect(new Array(2_000_000).fill(7), {
      maxArrayLength: 3,
    });
    expect(out).toBe("[ 7, 7, 7, ... 1999997 more items ]");
    expect(out.length).toBeLessThan(100);
  });

  test("crypto.argon2 async matches the sync tag", async () => {
    const crypto = (await import("node:crypto")) as unknown as {
      argon2: (
        algorithm: string,
        options: Record<string, unknown>,
        callback: (error: Error | null, key: Buffer) => void,
      ) => void;
      argon2Sync: (
        algorithm: string,
        options: Record<string, unknown>,
      ) => Buffer;
    };
    const options = {
      message: "pw",
      nonce: "saltsalt",
      parallelism: 1,
      tagLength: 32,
      memory: 32,
      passes: 1,
    };
    const sync = crypto.argon2Sync("argon2id", options);
    const asyncTag = await new Promise<Buffer>((resolve, reject) => {
      crypto.argon2("argon2id", options, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
    expect(asyncTag.equals(sync)).toBe(true);
  });
});
