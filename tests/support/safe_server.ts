/**
 * Helper to ensure local test servers bind to verified-free loopback ports,
 * preventing macOS SO_REUSEPORT collisions with active system proxy listeners.
 */
import * as net from "node:net";

export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export async function serveSafe(
  options: Parameters<typeof Bun.serve>[0],
): Promise<ReturnType<typeof Bun.serve>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port =
      options.port !== undefined && options.port !== 0
        ? options.port
        : await getAvailablePort();
    const server = Bun.serve({ ...options, port } as never);
    try {
      const probeRes = await fetch(
        `http://127.0.0.1:${server.port}/__probe_safe_port__`,
        { proxy: false },
      );
      if (probeRes.status === 400) {
        const text = await probeRes.text();
        if (text.includes("explicit proxy server")) {
          server.stop(true);
          continue;
        }
      }
      return server;
    } catch {
      return server;
    }
  }
  return Bun.serve(options);
}
