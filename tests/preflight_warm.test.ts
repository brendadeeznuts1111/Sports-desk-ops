import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { prefetchDns, warmCaptureNetwork } from "../lib/preflight.ts";

describe("capture network warm-up", () => {
  test("warmCaptureNetwork returns the parsed host/port and prefetches", () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    try {
      const port = server.port;
      if (port === undefined) throw new Error("server has no port");
      const warm = warmCaptureNetwork(server.url.href);
      expect(warm).toEqual({ host: "127.0.0.1", port });
      expect(() => prefetchDns("127.0.0.1", port)).not.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("capture TLS paths never disable certificate verification", async () => {
    for (const path of [
      "lib/preflight.ts",
      "scripts/capture/session.ts",
      "lib/f402_replay_transport.ts",
      "services/sportsdesk_telegram_bot.ts",
    ]) {
      const text = await Bun.file(join(import.meta.dir, "..", path)).text();
      expect(text, path).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
      expect(text, path).not.toMatch(/rejectUnauthorized:\s*false/);
    }
  });
});
