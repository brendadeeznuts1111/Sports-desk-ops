import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("Server Port Cascade Resolution", () => {
  test("test_assert_bun_port_resolution_without_port_in_code", async () => {
    const projectRoot = resolve(import.meta.dir, "..");

    // Spawn Bun process with BUN_PORT=4100 and no explicit port in code options
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
        BUN_PORT: "4100",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await proc.stdout.text();
    const stderr = await proc.stderr.text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Subprocess stderr:", stderr);
    }

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.port).toBe(4100);
  });

  test("development accepts the HMR-off object without breaking the daemon", async () => {
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: { hmr: false },
    });
    try {
      const res = await fetch(`${server.url}health`);
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});
