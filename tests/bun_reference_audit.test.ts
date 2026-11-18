/**
 * Offline tests for `lib/bun_reference_audit.ts`: reconcile fixture reference pages against the real
 * pinned runtime (bun/globalThis/node:fs are live, only the fetched payloads are synthetic), derive
 * the contract, and prove the manifest + digest are reproducible and schema-valid.
 */
import { describe, expect, test } from "bun:test";
import { runReferenceAudit } from "../lib/bun_reference_audit.ts";
import { validateContractManifest } from "../lib/bun_reference_contract.ts";
import { fixtureFetch } from "./fixtures/bun_reference_fixture.ts";

const run = () => runReferenceAudit({ fetchJson: fixtureFetch, probe: false });

describe("runReferenceAudit (fixture pages, real runtime)", () => {
  test("reconciles documented symbols against the pinned runtime", async () => {
    const { report } = await run();
    expect(report.modules).toBe(3);
    expect(report.distinctPairs).toBe(4);
    expect(report.distinctNames).toBe(4);
    expect(report.moduleSource.match).toBe(true);
    // `foo` is documented but absent; `Bar` claims types-only and is absent; process/readFileSync exist.
    expect(report.counts["documented-value-missing"]).toBe(1);
    expect(report.counts["ok-types-only"]).toBe(1);
    expect(report.counts.ok).toBe(2);
    expect(report.missing.map((row) => row.name)).toEqual(["foo"]);
    expect(report.kindMatrix.functions?.["documented-value-missing"]).toBe(1);
    expect(report.kindMatrix.classes?.["ok-types-only"]).toBe(1);
    expect(report.moduleGroups.counts).toEqual({
      "Bun modules": 2,
      "Node.js modules": 1,
    });
    expect(report.moduleGroups.mismatches).toEqual([]);
    expect(report.badges).toEqual({ total: 4, matched: 4, unmatched: 0 });
  });

  test("kind colour contract keeps name, alias and colour separate", async () => {
    const { report } = await run();
    expect(report.kindColours.contract).toEqual([
      { name: "classes", alias: "C", colour: "blue", count: 1 },
      { name: "functions", alias: "F", colour: "emerald", count: 3 },
    ]);
    expect(report.kindColours.observed).toEqual([
      { alias: "C", colour: "blue", count: 1 },
      { alias: "F", colour: "emerald", count: 3 },
    ]);
    expect(report.kindColours.conflicts).toEqual([]);
    expect(report.kindColours.colourConflicts).toEqual([]);
    expect(report.kindColours.mismatches).toEqual([]);
    // No packed "F/emerald" strings anywhere in the derived contract.
    expect(JSON.stringify(report.kindColours.contract)).not.toContain(
      "/emerald",
    );
  });

  test("manifest validates and the schema self-test rejects a broken manifest", async () => {
    const { manifest, validation, schemaSelfTest } = await run();
    expect(validation).toEqual({ ok: true, errors: [] });
    expect(schemaSelfTest).toBe(true);
    const revalidated = validateContractManifest(manifest);
    expect(revalidated.ok).toBe(true);
    const broken = validateContractManifest({ ...manifest, modules: -1 });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors.join(" ")).toContain("modules");
  });

  test("source digest is a stable sha256 across runs", async () => {
    const first = await run();
    const second = await run();
    expect(first.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sourceDigest).toBe(first.sourceDigest);
    // generatedAt is the only volatile field, and it is not part of the digest.
    expect(first.manifest.source.digest).toBe(first.sourceDigest);
  });

  test("the compile-time probe can be skipped explicitly", async () => {
    const { report } = await run();
    expect(report.compileTimeProbe).toBeNull();
  });
});
