/**
 * Import-safety guards for the secrets CLIs (audit Finding 5).
 *
 * `Bun.secrets` members are read-only, so the keychain cannot be spied on directly.
 * Instead each module is imported in a child Bun process with a script-shaped argv:
 * an unguarded module dispatches its CLI on import (unknown command → exit 2, or
 * `status` → keychain reads and stdout), so any output or non-zero exit fails here.
 * The child runs `--no-env-file` so the mounted `.env` FIFO cannot block it.
 *
 * `f402_manager_boot_har.ts` is not imported: unguarded it launches Chrome. Its guard
 * is pinned statically instead.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

const IMPORT_SAFE = [
  "scripts/secrets_f402.ts",
  "scripts/secrets_gslive.ts",
  "scripts/secrets_r2.ts",
] as const;

const GUARDED = [
  ...IMPORT_SAFE,
  "scripts/capture/f402_manager_boot_har.ts",
] as const;

describe("secrets CLI modules are import-safe", () => {
  for (const path of GUARDED) {
    test(`${path} keeps an import.meta.main guard`, () => {
      const source = readFileSync(join(REPO, path), "utf8");
      expect(source).toMatch(/^async function main\(\): Promise<void> \{/m);
      expect(source).toMatch(/^if \(import\.meta\.main\) await main\(\);$/m);
    });
  }

  for (const path of IMPORT_SAFE) {
    test(`${path} does not run its CLI on import`, () => {
      const proc = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--no-env-file",
          "-e",
          `await import(${JSON.stringify(join(REPO, path))})`,
        ],
        cwd: REPO,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({
        code: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      }).toEqual({ code: 0, stdout: "", stderr: "" });
    });
  }
});
