import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertGatedSymbolsExist,
  checkProfileCodeModeHostAllowlist,
  findMissingExports,
  violationsForFile,
} from "./profile_code_mode_host_allowlist.ts";

const repoRoot = join(import.meta.dir, "../..");

describe("profile_code_mode_host allowlist checker", () => {
  test("negative fixtures emit one violation kind each", async () => {
    const { violations } = await checkProfileCodeModeHostAllowlist({
      onlyRoots: ["tests/fixtures/profile_code_mode_host_allowlist"],
    });

    expect(
      violationsForFile(
        violations,
        "violation_registrar_import.ts",
        "registrar-import",
      ),
    ).toHaveLength(1);
    expect(
      violationsForFile(
        violations,
        "violation_factory_import.ts",
        "factory-import",
      ),
    ).toHaveLength(1);
    expect(
      violationsForFile(violations, "violation_reexport.ts", "re-export"),
    ).toHaveLength(1);
    expect(
      violationsForFile(
        violations,
        "violation_helper_transitive.ts",
        "helper-import",
      ),
    ).toHaveLength(1);
  });

  test("findMissingExports flags absent gated symbols (stale allowlist)", () => {
    // Fictional allowlist names — not tied to #227 sunset symbols.
    const missing = findMissingExports("export function stillPresent() {}", [
      "stillPresent",
      "removedFromAllowlistOnly",
    ]);
    expect(missing).toEqual(["removedFromAllowlistOnly"]);
  });

  test("assertGatedSymbolsExist passes on committed profile_code_mode_host.ts", () => {
    expect(assertGatedSymbolsExist(repoRoot)).toEqual([]);
  });

  test("passes on the repository (fixtures excluded)", async () => {
    const { violations } = await checkProfileCodeModeHostAllowlist();
    expect(violations).toEqual([]);
  });

  test("local worktree and scratch copies are outside the allowlist path space", async () => {
    const root = mkdtempSync(join(tmpdir(), "allowlist-skip-"));
    try {
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(
        join(root, "lib", "profile_code_mode_host.ts"),
        [
          "export function createProfileQueryHostRunner(): void {}",
          "export function registerProfileCodeModeHostTools(): void {}",
          "export function registerProfileQueryCodeModeTools(): void {}",
        ].join("\n"),
      );
      const violation =
        'import { createProfileQueryHostRunner } from "./profile_code_mode_host.ts";\n' +
        "export const host = createProfileQueryHostRunner;\n";
      for (const copy of [
        "Scratch/wt-old",
        "scratch/wt-old",
        ".worktrees/branch",
      ]) {
        mkdirSync(join(root, copy, "lib"), { recursive: true });
        writeFileSync(
          join(root, copy, "lib", "code_mode_profile.ts"),
          violation,
        );
      }
      // The control file is NOT under a skipped segment, so it must still be flagged.
      writeFileSync(join(root, "lib", "real_violation.ts"), violation);

      const { violations, scanned } = await checkProfileCodeModeHostAllowlist({
        root,
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("lib/real_violation.ts");
      expect(scanned).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
