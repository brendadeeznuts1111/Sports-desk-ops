import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * The wire, not the helper — and not Bun's fetch, which adds its own `Accept-Encoding` and
 * decompresses the body before the test sees it. These requests are written by hand so the header
 * under test is the only one sent and the response is read as bytes.
 */

const savedToken = Bun.env["SPORTSDESK_ADMIN_TOKEN"];
Reflect.deleteProperty(Bun.env, "SPORTSDESK_ADMIN_TOKEN");

const server = startServer({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
});
const port = server.port ?? 0;

afterAll(() => {
  server.stop(true);
  if (savedToken === undefined) {
    Reflect.deleteProperty(Bun.env, "SPORTSDESK_ADMIN_TOKEN");
  } else {
    Reflect.set(Bun.env, "SPORTSDESK_ADMIN_TOKEN", savedToken);
  }
});

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

function rawGet(
  path: string,
  extra: Record<string, string> = {},
): Promise<RawResponse> {
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: close",
    ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`),
    "",
    "",
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${path}`)),
      10_000,
    );
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(request);
        },
        data(_socket, data) {
          chunks.push(new Uint8Array(data));
        },
        close() {
          clearTimeout(timer);
          const total = chunks.reduce((n, c) => n + c.byteLength, 0);
          const all = new Uint8Array(total);
          let at = 0;
          for (const chunk of chunks) {
            all.set(chunk, at);
            at += chunk.byteLength;
          }
          const split = all.indexOf(0x0d); // first CR of the header terminator
          const headerEnd = (() => {
            for (let i = 0; i < all.byteLength - 3; i++) {
              if (
                all[i] === 0x0d &&
                all[i + 1] === 0x0a &&
                all[i + 2] === 0x0d &&
                all[i + 3] === 0x0a
              ) {
                return i;
              }
            }
            return split;
          })();
          const head = new TextDecoder().decode(all.slice(0, headerEnd));
          const [statusLine = "", ...lines] = head.split("\r\n");
          const headers: Record<string, string> = {};
          for (const line of lines) {
            const colon = line.indexOf(":");
            if (colon < 0) continue;
            headers[line.slice(0, colon).trim().toLowerCase()] = line
              .slice(colon + 1)
              .trim();
          }
          resolve({
            status: Number(statusLine.split(" ")[1] ?? 0),
            headers,
            body: all.slice(headerEnd + 4),
          });
        },
        error(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch(reject);
  });
}

describe("compressible responses", () => {
  for (const path of ["/graph", "/", "/api/graph-feed", "/api/agent-tree"]) {
    test(`${path} is compressed when gzip is the only encoding offered`, async () => {
      const plain = await rawGet(path);
      const gz = await rawGet(path, { "Accept-Encoding": "gzip" });
      expect(gz.status).toBe(200);
      expect(gz.headers["content-encoding"]).toBe("gzip");
      expect(gz.headers["vary"]).toContain("Accept-Encoding");
      expect(gz.headers["content-length"]).toBe(String(gz.body.byteLength));
      const decoded = new Uint8Array(Bun.gunzipSync(new Uint8Array(gz.body)));
      expect(decoded.byteLength).toBe(plain.body.byteLength);
      expect(gz.body.byteLength).toBeLessThan(plain.body.byteLength);
      expect(new TextDecoder().decode(decoded.slice(0, 40))).toMatch(
        /^(<!doctype|\{|\[)/i,
      );
    });
  }

  test("zstd is preferred when the client accepts both", async () => {
    const gz = await rawGet("/graph", { "Accept-Encoding": "gzip" });
    const zstd = await rawGet("/graph", { "Accept-Encoding": "gzip, zstd" });
    expect(zstd.headers["content-encoding"]).toBe("zstd");
    const decoded = new Uint8Array(
      Bun.zstdDecompressSync(new Uint8Array(zstd.body)),
    );
    expect(decoded.byteLength).toBe(
      new Uint8Array(Bun.gunzipSync(new Uint8Array(gz.body))).byteLength,
    );
    expect(zstd.body.byteLength).toBeLessThan(gz.body.byteLength);
  });
});

describe("identity clients", () => {
  test("a page without accept-encoding is plain", async () => {
    const response = await rawGet("/graph");
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(response.body.slice(0, 15))).toMatch(
      /^<!doctype/i,
    );
  });

  test("a small response is not worth framing", async () => {
    const response = await rawGet("/api/v1/live-bets?source=auto", {
      "Accept-Encoding": "gzip",
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
  });

  test("compressed responses decline ranges instead of lying about them", async () => {
    const response = await rawGet("/graph", {
      "Accept-Encoding": "gzip",
      Range: "bytes=0-99",
    });
    expect(response.headers["accept-ranges"]).toBe("none");
  });
});
