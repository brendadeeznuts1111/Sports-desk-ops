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
});
