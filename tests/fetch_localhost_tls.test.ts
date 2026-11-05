import { describe, expect, test } from "bun:test";

import { createTlsFixture } from "./support/tls_fixture.ts";

/**
 * Bun resolves `localhost` and any `*.localhost` to loopback without the system resolver, and
 * fetch verifies TLS against the URL host rather than a caller-supplied Host header. The latter
 * was an insecure default; `tls.servername` remains the explicit way to verify an IP against
 * another name.
 */
describe("localhost resolution and TLS identity", () => {
  test("localhost and a *.localhost name reach a loopback server", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("loopback"),
    });
    const port = server.port;
    if (port === undefined) throw new Error("server has no port");
    try {
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe(
        "loopback",
      );
      expect(await (await fetch(`http://app.localhost:${port}/`)).text()).toBe(
        "loopback",
      );
    } finally {
      server.stop(true);
    }
  });

  test("TLS checks the URL host, not the Host header", async () => {
    const fixture = await createTlsFixture("a.localhost");
    if (fixture === null) return;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        key: await Bun.file(fixture.keyPath).text(),
        cert: await Bun.file(fixture.certPath).text(),
      },
      fetch: () => new Response("tls-host"),
    });
    const port = server.port;
    if (port === undefined) throw new Error("server has no port");
    try {
      const ca = await Bun.file(fixture.caPath).text();
      const viaHostHeader = await fetch(`https://a.localhost:${port}/`, {
        headers: { Host: "b.localhost" },
        tls: { ca },
      });
      expect(viaHostHeader.status).toBe(200);
      expect(await viaHostHeader.text()).toBe("tls-host");

      const viaServername = await fetch(`https://127.0.0.1:${port}/`, {
        tls: { ca, servername: "a.localhost" },
      });
      expect(viaServername.status).toBe(200);
      expect(await viaServername.text()).toBe("tls-host");

      // Without the override the certificate has no matching IP SAN, so verification fails.
      await expect(
        fetch(`https://127.0.0.1:${port}/`, { tls: { ca } }),
      ).rejects.toThrow();
    } finally {
      server.stop(true);
      fixture.cleanup();
    }
  });
});
