/**
 * 3b live fetch must not silently fall back to the dead Manager/getPending endpoint. A bearer fetch
 * without an explicit customer list is a configuration error; `--allow-legacy-manager` is the
 * narrow historical escape hatch.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/f402_pending_bridge3b.ts");
const dir = mkdtempSync(join(tmpdir(), "bridge3b-cli-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--no-env-file", "run", script, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...env,
    },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("bridge3b bearer-fetch guard", () => {
  test("no customer list is a configuration error before any network I/O", () => {
    const result = run([], {
      F402_TOKEN_FILE: join(dir, "absent-token"),
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("explicit customer list");
    expect(result.err).toContain("Manager/getPending is dead");
    expect(result.err).toContain("--allow-legacy-manager");
  });

  test("--allow-legacy-manager bypasses the guard (then fails on the missing token file)", () => {
    const result = run(["--allow-legacy-manager"], {
      F402_TOKEN_FILE: join(dir, "absent-token"),
    });
    // The guard is bypassed; token resolution fails closed before any request.
    expect(result.code).not.toBe(2);
    expect(result.err).not.toContain("explicit customer list");
  });

  test("help advertises both the list and the escape hatch", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("--customers");
    expect(result.out).toContain("--allow-legacy-manager");
  });
});
