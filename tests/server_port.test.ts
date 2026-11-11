import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startServer } from "../services/sportsdesk_webview_server.ts";
import { stripPtyCapture } from "../lib/bun_terminal.ts";

/**
 * Reserves `count` distinct ephemeral loopback ports simultaneously via OS `port: 0`
 * allocation, then releases them immediately before child subprocess probing.
 * Holding all reservations open together guarantees the `count` ports are pairwise distinct
 * without colliding against fixed hardcoded port numbers under `bun test --parallel`.
 */
function reserveDistinctEphemeralPorts(count: number): number[] {
  const servers = Array.from({ length: count }, () =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    }),
  );
  try {
    return servers.map((s) => {
      if (typeof s.port !== "number" || s.port <= 0) {
        throw new Error(`Expected ephemeral TCP port, got ${String(s.port)}`);
      }
      return s.port;
    });
  } finally {
    for (const s of servers) {
      s.stop(true);
    }
  }
}

async function withPortRaceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // One retry with fresh ephemeral ports if a parallel worker grabbed a released port in the sub-ms window.
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("EADDRINUSE") ||
      message.includes("address already in use") ||
      message.includes("port")
    ) {
      return await fn();
    }
    throw err;
  }
}

describe("Server Port Cascade Resolution", () => {
  test("test_assert_bun_port_resolution_without_port_in_code", async () => {
    const projectRoot = resolve(import.meta.dir, "..");

    await withPortRaceRetry(async () => {
      const [targetPort] = reserveDistinctEphemeralPorts(1);

      // Spawn Bun process with BUN_PORT=<ephemeral> and no explicit port in code options
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `
          import { startServer } from "./services/sportsdesk_webview_server.ts";
          const server = startServer();
          console.log(JSON.stringify({ port: server.port, hostname: server.hostname }));
          server.stop(true);
          `,
        ],
        cwd: projectRoot,
        env: {
          ...Bun.env,
          BUN_PORT: String(targetPort),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = await proc.stdout.text();
      const stderr = await proc.stderr.text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error(`Subprocess exited ${exitCode}: ${stderr}`);
      }

      const result = JSON.parse(stdout.trim());
      expect(result.port).toBe(targetPort);
    });
  });

  test("BUN_PORT beats PORT beats NODE_PORT, and an explicit port wins", async () => {
    const serve = (options: string): string =>
      `const s = Bun.serve({ hostname: "127.0.0.1", ${options} fetch: () => new Response("ok") }); console.log(s.port); s.stop(true);`;

    const resolvePort = async (
      options: string,
      env: Record<string, string>,
      argv: readonly string[] = [],
    ): Promise<number> => {
      const ambient = Object.fromEntries(
        Object.entries(Bun.env).filter(
          ([name]) =>
            name !== "BUN_PORT" && name !== "PORT" && name !== "NODE_PORT",
        ),
      );
      const proc = Bun.spawn({
        cmd: [process.execPath, ...argv, "-e", serve(options)],
        env: { ...ambient, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await proc.stdout.text();
      const stderr = await proc.stderr.text();
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`Subprocess exited ${code}: ${stderr}`);
      }
      expect(stderr).toBe("");
      const lines = stripPtyCapture(stdout).trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";
      return Number(lastLine);
    };

    await withPortRaceRetry(async () => {
      const [pBun, pPort, pNode, pExplicit, pFlag] =
        reserveDistinctEphemeralPorts(5);

      expect(
        await resolvePort("", {
          BUN_PORT: String(pBun),
          PORT: String(pPort),
          NODE_PORT: String(pNode),
        }),
      ).toBe(pBun!);
      expect(
        await resolvePort("", {
          PORT: String(pPort),
          NODE_PORT: String(pNode),
        }),
      ).toBe(pPort!);
      expect(await resolvePort("", { NODE_PORT: String(pNode) })).toBe(pNode!);
      expect(
        await resolvePort(`port: ${pExplicit},`, {
          BUN_PORT: String(pBun),
          PORT: String(pPort),
          NODE_PORT: String(pNode),
        }),
      ).toBe(pExplicit!);

      // The docs list --port first, but measured on 1.4.4 an env var wins over the flag.
      expect(await resolvePort("", {}, [`--port=${pFlag}`])).toBe(pFlag!);
      expect(
        await resolvePort("", { BUN_PORT: String(pBun) }, [`--port=${pFlag}`]),
      ).toBe(pBun!);
    });
  });

  test("Bun.serve return value exposes protocol (http: without tls)", () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    try {
      expect(server.protocol).toBe("http");
      expect(server.url?.protocol).toBe("http:");
    } finally {
      server.stop(true);
    }
  });

  test("development accepts the HMR-off object without breaking the daemon", async () => {
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: { hmr: false },
    });
    try {
      const res = await fetch(`${server.url}health`);
      expect([200, 503]).toContain(res.status);
    } finally {
      server.stop(true);
    }
  });
});
