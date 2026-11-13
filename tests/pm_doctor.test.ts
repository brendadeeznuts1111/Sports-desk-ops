import { describe, expect, test } from "bun:test";
import { evaluateTrustedDependenciesPolicy } from "../lib/pm_policy.ts";

/**
 * `pm_doctor.ts` delegates lifecycle trust to `auditTrustedDependencies` (same predicate).
 * These tests cover detection logic without spawning the full doctor CLI.
 */
describe("pm:doctor trustedDependencies detection", () => {
  test("aligned empty lists pass", () => {
    const r = evaluateTrustedDependenciesPolicy({
      manifestRaw: [],
      lockRaw: [],
    });
    expect(r.ok).toBe(true);
  });

  test("flags manifest/lock drift (manifest [], lock [x])", () => {
    const r = evaluateTrustedDependenciesPolicy({
      manifestRaw: [],
      lockRaw: ["node-sass"],
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("drift");
    expect(r.detail).toContain("node-sass");
  });

  test("omitted manifest field fails (must replace default list explicitly)", () => {
    const r = evaluateTrustedDependenciesPolicy({
      manifestRaw: undefined,
      lockRaw: [],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toContain("manifest must declare");
  });

  test("repo root passes auditTrustedDependencies", async () => {
    const { auditTrustedDependencies } = await import("../lib/pm_policy.ts");
    const audit = await auditTrustedDependencies(".");
    expect(audit.ok).toBe(true);
  });
});
