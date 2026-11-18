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

  test("the lockfile is present", () => {
    expect(existsSync(join(root, "bun.lock"))).toBe(true);
  });
});
