import { describe, expect, test } from "bun:test";

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
});
