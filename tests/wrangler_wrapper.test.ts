/**
 * @file tests/wrangler_wrapper.test.ts
 * @description `bin/wrangler` must never re-invoke itself. package.json registers
 * `bin.wrangler = bin/wrangler`, so `bun x wrangler` resolves back to this wrapper
 * rather than the Cloudflare wrangler npm package.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WRAPPER = join(ROOT, "bin/wrangler");
const SCRATCH = mkdtempSync(join(tmpdir(), "wrangler-wrapper-"));

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

async function runWrapper(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
  limitMs = 3000,
): Promise<Run> {
  const started = Date.now();
  const child = Bun.spawn([WRAPPER, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      HOME: join(SCRATCH, "empty-home"),
      ...env,
    },
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), limitMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    return { code, stdout, stderr, ms: Date.now() - started };
  } finally {
    clearTimeout(killer);
  }
}

describe("bin/wrangler never re-invokes itself", () => {
  test("exits quickly with a named cause when the wrangler package is absent", async () => {
    const result = await runWrapper(["--version"]);
    expect(result.ms).toBeLessThan(3000);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cloudflare wrangler CLI is not installed");
    expect(result.stderr).toContain('package.json bin "wrangler"');
    expect(result.stderr).toContain("bun x wrangler");
    expect(result.stderr).toContain("node_modules/wrangler/bin/wrangler.js");
  });

  test("a recursion-guard env var fails fast and names the cause", async () => {
    const result = await runWrapper(["--version"], {
      SPORTSDESK_WRANGLER_WRAPPER: "1",
    });
    expect(result.ms).toBeLessThan(3000);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refused a recursive invocation");
    expect(result.stderr).toContain('package.json bin "wrangler"');
  });

  test("bun x --no-install wrangler finishes without a fork loop", async () => {
    const started = Date.now();
    const child = Bun.spawn(
      [process.execPath, "x", "--bun", "--no-install", "wrangler", "--version"],
      {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...Bun.env, HOME: join(SCRATCH, "empty-home") },
      },
    );
    const killer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.exited,
      ]);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Cloudflare wrangler CLI is not installed");
    } finally {
      clearTimeout(killer);
    }
  });

  test("resolves a real wrangler executable on PATH that is not this wrapper", async () => {
    const binDir = mkdtempSync(join(SCRATCH, "path-"));
    const fake = join(binDir, "wrangler");
    await Bun.write(fake, "#!/usr/bin/env bash\necho wrangler-fixture 0.0.0\n");
    chmodSync(fake, 0o755);
    const result = await runWrapper(["--version"], {
      PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrangler-fixture 0.0.0");
    expect(result.stderr).toBe("");
  });
});
