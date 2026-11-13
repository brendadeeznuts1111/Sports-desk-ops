import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

/**
 * `Bun.FetchSession` owns a connection pool and a bound `fetch`; the Telegram bot uses exactly
 * this shape (TLS verification on, keep-alive pool). A local HTTP server keeps the test offline.
 */
describe("Bun.FetchSession", () => {
  test("reuses its pool and keeps fetch bound", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        hits += 1;
        return new Response("ok");
      },
    });
    const session = new Bun.FetchSession({
      tls: { rejectUnauthorized: true },
      keepAlive: { idleTimeout: 1, maxIdleSockets: 2 },
    });
    try {
      const bound = session.fetch;
      const first = await bound(server.url);
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("ok");

      const second = await session.fetch(new URL("/again", server.url));
      expect(await second.text()).toBe("ok");
      expect(hits).toBe(2);
    } finally {
      session.close();
      server.stop(true);
    }
  });

  test("exposes close and Symbol.dispose and omits preconnect", () => {
    using session = new Bun.FetchSession({
      keepAlive: { idleTimeout: 1, maxIdleSockets: 1 },
    });
    expect(typeof session.close).toBe("function");
    expect(typeof session[Symbol.dispose]).toBe("function");
    expect("preconnect" in session).toBe(false);
    expect("preconnect" in Bun.FetchSession.prototype).toBe(false);
  });

  test("supports FetchSessionInit unix domain socket connections", async () => {
    const sockPath = `/tmp/sd-fs-${process.pid}-${Date.now()}.sock`;
    const server = Bun.serve({
      unix: sockPath,
      fetch: () => new Response("unix-ok"),
    });
    try {
      const init: Bun.FetchSessionInit = { unix: sockPath };
      using session = new Bun.FetchSession(init);
      const res = await session.fetch("http://localhost/ping");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("unix-ok");
    } finally {
      server.stop(true);
      await rm(sockPath, { force: true });
    }
  });
});
