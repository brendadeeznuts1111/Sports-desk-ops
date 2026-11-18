import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

describe("PM state invariants", () => {
  test("the runtime pin is 1.4.4", () => {
    expect(readFileSync(join(root, ".bun-version"), "utf8").trim()).toBe(
      "1.4.4",
    );
  });

  test("predev and test:pm-contracts are wired", () => {
    expect(pkg.scripts?.predev ?? "").toContain("check:pm-state");
    expect(pkg.scripts?.["test:pm-contracts"] ?? "").toContain(
      "bun_pm_behaviors.test.ts",
    );
  });

  test("check:pm-state inspects the tree before anything reconciles it", () => {
    // `bun ci && bun prune --check` could never fail for the reason it exists: the install has
    // just rewritten node_modules to match the lock. The check runs first, or not at all.
    const check = pkg.scripts?.["check:pm-state"] ?? "";
    expect(check).toBe("bun run scripts/check_pm_state.ts");
    expect(check).not.toContain("bun ci");
    expect(check).not.toContain("prune");
  });

  test("predev checks before it installs, then still installs", () => {
    // Order matters: the check is only meaningful against the tree as it was found. The install
    // stays because `prune --check` reports extras, not missing packages.
    const predev = pkg.scripts?.predev ?? "";
    const checkAt = predev.indexOf("check:pm-state");
    const installAt = predev.indexOf("bun ci");
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThan(checkAt);
  });

  test("the lockfile is present", () => {
    expect(existsSync(join(root, "bun.lock"))).toBe(true);
  });
});
