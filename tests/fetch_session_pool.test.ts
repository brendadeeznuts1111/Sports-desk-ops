import { describe, expect, test } from "bun:test";
import { HttpSession } from "../scripts/capture/session.ts";

/**
 * Connection-pool behaviour of `HttpSession`, measured against real sockets.
 *
 * The unit tests in `capture_session.test.ts` inject a fake transport, so they
 * cannot see pooling. These do: a `Bun.listen` proxy counts accepted sockets and
 * forwarded requests, which is the only way to tell a shared pool from a fresh
 * connection per call.
 */

interface ProxyStats {
  sockets: number;
  requests: number;
}

function startProxy(): {
  stats: ProxyStats;
  url: string;
  stop: () => void;
} {
  const stats: ProxyStats = { sockets: 0, requests: 0 };
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        stats.sockets += 1;
      },
      data(socket) {
        stats.requests += 1;
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nproxied");
      },
    },
  });
  return {
    stats,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

let directHits = 0;
const target = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => {
    directHits += 1;
    return new Response("direct");
  },
});

const targetUrl = `http://127.0.0.1:${target.port}/probe`;

/** Run `fn` with the proxy environment variables replaced, then restore them. */
async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "no_proxy",
  ];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const request = { url: targetUrl, method: "GET" as const };

describe("HttpSession proxy pools", () => {
  test("one session reuses one connection for both requests", async () => {
    const proxy = startProxy();
    const session = new HttpSession({
      proxy: { url: proxy.url, respectNoProxy: false },
    });
    try {
      const first = await session.fetch(request);
      const second = await session.fetch(request);
      expect(new TextDecoder().decode(first.bytes)).toBe("proxied");
      expect(new TextDecoder().decode(second.bytes)).toBe("proxied");
      expect(proxy.stats.requests).toBe(2);
      expect(proxy.stats.sockets).toBe(1);
    } finally {
      await session.close();
      proxy.stop();
    }
  });

  test("two sessions never share a connection", async () => {
    const proxy = startProxy();
    const a = new HttpSession({
      proxy: { url: proxy.url, respectNoProxy: false },
    });
    const b = new HttpSession({
      proxy: { url: proxy.url, respectNoProxy: false },
    });
    try {
      await a.fetch(request);
      await b.fetch(request);
      expect(proxy.stats.requests).toBe(2);
      expect(proxy.stats.sockets).toBe(2);
    } finally {
      await a.close();
      await b.close();
      proxy.stop();
    }
  });

  test("proxy:false beats HTTP_PROXY", async () => {
    const before = directHits;
    await withEnv({ HTTP_PROXY: "http://127.0.0.1:59999" }, async () => {
      const session = new HttpSession({ proxy: false });
      try {
        const response = await session.fetch(request);
        expect(new TextDecoder().decode(response.bytes)).toBe("direct");
      } finally {
        await session.close();
      }
    });
    expect(directHits - before).toBe(1);
  });

  test("respectNoProxy decides whether loopback bypasses the proxy", async () => {
    const proxy = startProxy();
    try {
      await withEnv(
        { NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
        async () => {
          const bypassing = new HttpSession({ proxy: proxy.url });
          try {
            const response = await bypassing.fetch(request);
            expect(new TextDecoder().decode(response.bytes)).toBe("direct");
          } finally {
            await bypassing.close();
          }
          expect(proxy.stats.requests).toBe(0);

          const forced = new HttpSession({
            proxy: { url: proxy.url, respectNoProxy: false },
          });
          try {
            const response = await forced.fetch(request);
            expect(new TextDecoder().decode(response.bytes)).toBe("proxied");
          } finally {
            await forced.close();
          }
          expect(proxy.stats.requests).toBe(1);
        },
      );
    } finally {
      proxy.stop();
    }
  });
});
