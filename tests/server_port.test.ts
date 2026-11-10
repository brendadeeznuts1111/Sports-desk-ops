import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startServer } from "../services/sportsdesk_webview_server.ts";
import { stripPtyCapture } from "../lib/bun_terminal.ts";

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

  test("BUN_PORT beats PORT beats NODE_PORT, and an explicit port wins", async () => {
    const serve = (options: string): string =>
      `const s = Bun.serve({ ${options} fetch: () => new Response("ok") }); console.log(s.port); s.stop(true);`;

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
      expect({ code: await proc.exited, stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      const lines = stripPtyCapture(stdout).trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";
      return Number(lastLine);
    };

    expect(
      await resolvePort("", {
        BUN_PORT: "47151",
        PORT: "47152",
        NODE_PORT: "47153",
      }),
    ).toBe(47151);
    expect(await resolvePort("", { PORT: "47152", NODE_PORT: "47153" })).toBe(
      47152,
    );
    expect(await resolvePort("", { NODE_PORT: "47153" })).toBe(47153);
    expect(
      await resolvePort("port: 47154,", {
        BUN_PORT: "47151",
        PORT: "47152",
        NODE_PORT: "47153",
      }),
    ).toBe(47154);

    // The docs list --port first, but measured on 1.4.4 an env var wins over the flag.
    expect(await resolvePort("", {}, ["--port=47155"])).toBe(47155);
    expect(await resolvePort("", { BUN_PORT: "47151" }, ["--port=47155"])).toBe(
      47151,
    );
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
