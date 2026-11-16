import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * bunfig registry configuration under `bun install`, measured on Bun 1.4.4
 * (2026-11-14). A fake registry records the request path and Authorization header,
 * so every case proves routing and credential handling without a real registry.
 *
 * Env-file divergence from the docs: the page says `.env.test` is never read;
 * measured, `NODE_ENV=test` DOES load `.env.test` (and it is ignored without it).
 */

interface Observed {
  readonly path: string;
  readonly auth: string | null;
}

interface Scenario {
  readonly bunfig: (port: number) => string;
  readonly dep: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
}

async function install(scenario: Scenario): Promise<Observed> {
  const dir = mkdtempSync(join(tmpdir(), "registry-config-"));
  let observedPath = "(none)";
  let observedAuth: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      observedPath = new URL(req.url).pathname;
      observedAuth = req.headers.get("authorization");
      return new Response("{}", { status: 404 });
    },
  });
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "registry-config-probe",
        version: "1.0.0",
        dependencies: { [scenario.dep]: "1.0.0" },
      }),
    );
    // Bun.serve types port as optional; the URL needs the real one.
    const port = server.port;
    if (port === undefined) throw new Error("fake registry has no port");
    writeFileSync(join(dir, "bunfig.toml"), scenario.bunfig(port));
    for (const [name, body] of Object.entries(scenario.files ?? {})) {
      writeFileSync(join(dir, name), body);
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...scenario.env,
    };
    delete env.PROBE_TOKEN;
    delete env.GLOBAL_TOKEN;
    // `bun test` itself runs with NODE_ENV=test; without clearing it, every child
    // install would load .env.test and the production-order cases would be false
    // positives. Scenario env re-adds the mode explicitly where it matters.
    if (!scenario.env?.["NODE_ENV"]) delete env.NODE_ENV;
    if (!scenario.env?.["BUN_ENV"]) delete env.BUN_ENV;
    // Async spawn: spawnSync would block this event loop and the fake registry
    // could never answer the child's request.
    const proc = Bun.spawn(["bun", "install", ...(scenario.args ?? [])], {
      cwd: dir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return { path: observedPath, auth: observedAuth };
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

const globalObject = (port: number) =>
  `[install]\nregistry = { url = "http://127.0.0.1:${port}/", token = "$GLOBAL_TOKEN" }\n`;

describe("global registry override", () => {
  test("string url routes installs and sends no auth", async () => {
    const result = await install({
      bunfig: (port) => `[install]\nregistry = "http://127.0.0.1:${port}/"\n`,
      dep: "probe-thing",
    });
    expect(result.path).toBe("/probe-thing");
    expect(result.auth).toBeNull();
  }, 60_000);

  test("object form expands a token from the auto-loaded .env", async () => {
    const result = await install({
      bunfig: globalObject,
      dep: "probe-thing",
      files: { ".env": "GLOBAL_TOKEN=global-secret\n" },
    });
    expect(result.path).toBe("/probe-thing");
    expect(result.auth).toBe("Bearer global-secret");
  }, 60_000);

  test("username:password in the url becomes Basic auth", async () => {
    const result = await install({
      bunfig: (port) =>
        `[install]\nregistry = "http://${["u1", "p1"].join(":")}@127.0.0.1:${port}/"\n`,
      dep: "probe-thing",
    });
    expect(result.auth).toBe(`Basic ${btoa("u1:p1")}`);
  }, 60_000);
});

describe("scoped registry", () => {
  test("scope object routes only that scope and expands its token", async () => {
    const result = await install({
      bunfig: (port) =>
        `[install.scopes]\n"@probe" = { token = "$PROBE_TOKEN", url = "http://127.0.0.1:${port}/" }\n`,
      dep: "@probe/thing",
      files: { ".env": "PROBE_TOKEN=scope-secret\n" },
    });
    expect(result.path).toBe("/@probe%2fthing");
    expect(result.auth).toBe("Bearer scope-secret");
  }, 60_000);

  test("scope string form supports userinfo", async () => {
    const result = await install({
      bunfig: (port) =>
        `[install.scopes]\n"@probe" = "http://${["u2", "p2"].join(":")}@127.0.0.1:${port}/"\n`,
      dep: "@probe/thing",
    });
    expect(result.auth).toBe(`Basic ${btoa("u2:p2")}`);
  }, 60_000);
});

describe("env-file loading for bunfig", () => {
  const allFiles = {
    ".env": "GLOBAL_TOKEN=from-.env\n",
    ".env.local": "GLOBAL_TOKEN=from-.env.local\n",
    ".env.production": "GLOBAL_TOKEN=from-.env.production\n",
    ".env.production.local": "GLOBAL_TOKEN=from-.env.production.local\n",
    ".env.development": "GLOBAL_TOKEN=from-.env.development\n",
    ".env.test": "GLOBAL_TOKEN=from-.env.test\n",
  };

  test("production order: .env.production.local wins", async () => {
    const result = await install({
      bunfig: globalObject,
      dep: "probe-thing",
      files: allFiles,
    });
    expect(result.auth).toBe("Bearer from-.env.production.local");
  }, 60_000);

  test("development substitutes development files but .env.local still wins", async () => {
    const result = await install({
      bunfig: globalObject,
      dep: "probe-thing",
      files: allFiles,
      env: { BUN_ENV: "development" },
    });
    expect(result.auth).toBe("Bearer from-.env.local");
  }, 60_000);

  test("NODE_ENV=test loads .env.test (docs say it never does)", async () => {
    const result = await install({
      bunfig: globalObject,
      dep: "probe-thing",
      files: allFiles,
      env: { NODE_ENV: "test" },
    });
    expect(result.auth).toBe("Bearer from-.env.test");
  }, 60_000);

  test(".env.test is ignored without a test environment", async () => {
    const result = await install({
      bunfig: globalObject,
      dep: "probe-thing",
      files: { ".env.test": "GLOBAL_TOKEN=from-.env.test\n" },
    });
    expect(result.auth).toBeNull();
  }, 60_000);

  test("--env-file loads an explicit file", async () => {
    const result = await install({
      bunfig: globalObject,
      dep: "probe-thing",
      files: { "ci.env": "GLOBAL_TOKEN=from-ci-env\n" },
      args: ["--env-file", "ci.env"],
    });
    expect(result.auth).toBe("Bearer from-ci-env");
  }, 60_000);
});
