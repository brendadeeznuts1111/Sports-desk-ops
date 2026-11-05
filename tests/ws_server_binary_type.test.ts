import { describe, expect, test } from "bun:test";

/**
 * Server-side `binaryType` follows the client: "blob" delivers Blob, and "arraybuffer" now
 * delivers ArrayBuffer (previously Uint8Array). The client connects via `app.localhost`, which
 * also exercises Bun's loopback resolution for WebSocket.
 */
async function receivedKind(mode: "blob" | "arraybuffer"): Promise<string> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, srv) =>
      srv.upgrade(request) ? undefined : new Response("no", { status: 426 }),
    websocket: {
      open(ws) {
        ws.binaryType = mode;
      },
      message(ws, data) {
        const payload: unknown = data;
        const kind =
          payload instanceof Blob
            ? "blob"
            : payload instanceof ArrayBuffer
              ? "arraybuffer"
              : typeof payload;
        ws.send(kind);
      },
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("server has no port");
  const socket = new WebSocket(`ws://app.localhost:${port}/`);
  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket binaryType timeout")),
        5_000,
      );
      socket.addEventListener("open", () => {
        socket.send(new Uint8Array([1, 2, 3]));
      });
      socket.addEventListener("message", (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket error"));
      });
    });
  } finally {
    socket.close();
    server.stop(true);
  }
}

describe("server WebSocket binaryType", () => {
  test("blob delivers a Blob", async () => {
    expect(await receivedKind("blob")).toBe("blob");
  });

  test("arraybuffer delivers an ArrayBuffer", async () => {
    expect(await receivedKind("arraybuffer")).toBe("arraybuffer");
  });
});
