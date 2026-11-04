import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Gate Integrity Meta-Test:
 * Verifies that bin/check-fetch-init.ts actually fails when violations are introduced.
 * Plants four deliberate violations:
 * 1. Lowercase HTTP method literal (`method: "post"`)
 * 2. BufferSource body without explicit Content-Type (`body: new Uint8Array([1, 2, 3])`)
 * 3. URL-embedded credentials ("https://" + "admin:secret123@" + "api.sportsdesk.internal/")
 * 4. Plain-object literal body (`body: { unstringified: true }`)
 */

describe("check-fetch-init gate integrity meta-test", () => {
  test("bin/check-fetch-init.ts detects all four violation classes and exits non-zero", async () => {
    // 1. Plant the violations in a non-test, non-doc path of a throwaway root
    const credUrl =
      "https://" + "adminUser:secretPass@" + "api.sportsdesk.internal/status";
    const dirtyContent = `
export async function violateFetchInvariants() {
  // Violation 1: Lowercase method literal
  const r1 = await fetch("https://api.sportsdesk.internal/test", {
    method: "post",
  });

  // Violation 2: BufferSource body without Content-Type
  const r2 = await fetch("https://api.sportsdesk.internal/upload", {
    method: "POST",
    body: new Uint8Array([1, 2, 3]),
  });

  // Violation 3: URL-embedded credentials
  const r3 = await fetch("${credUrl}");

  // Violation 4: Plain object literal without JSON.stringify
  const r4 = await fetch("https://api.sportsdesk.internal/mutate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { unstringified: true },
  });

  return [r1, r2, r3, r4];
}
`;

    const root = await mkdtemp(path.join(tmpdir(), "check-fetch-init-"));
    try {
      await Bun.write(path.join(root, "lib/scratch.ts"), dirtyContent);

      // 2. Execute the repository gate with explicit env and timeout signal
      const proc = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "../bin/check-fetch-init.ts"),
          root,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: Bun.env.PATH ?? "",
            HOME: Bun.env.HOME ?? "",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
        proc.exited,
      ]);

      // 3. Assert the gate FAILED (exit code 1)
      expect(exitCode).toBe(1);

      // 4. Assert all four specific violation classes were reported
      expect(stdout).toContain("Lowercase HTTP method 'post'");
      expect(stdout).toContain(
        "BufferSource body without explicit Content-Type",
      );
      expect(stdout).toContain("URL-embedded credentials found");
      expect(stdout).toContain("Plain object literal passed to body");
      expect(stderr).toContain("4 RequestInit violation(s)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a `body` option spec in a file that builds no request is not a request body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "check-fetch-init-"));
    try {
      await Bun.write(
        path.join(root, "scripts/cli.ts"),
        'import { parseArgs } from "node:util";\nparseArgs({ options: {\n    body: { type: "string" },\n  } });\n',
      );
      const proc = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "../bin/check-fetch-init.ts"),
          root,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const [stdout, exitCode] = await Promise.all([
        proc.stdout.text(),
        proc.exited,
      ]);
      expect(stdout).not.toContain("Plain object literal passed to body");
      expect(exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
