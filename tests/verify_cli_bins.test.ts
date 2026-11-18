import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { requiredCliBins } from "../lib/cli_catalog.ts";
import { verifyWorkspaceCliBins } from "../scripts/verify_cli_bins.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("verify_cli_bins", () => {
  test("the required bin list is derived from root package.json", async () => {
    const rootPkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
      bin?: Record<string, string>;
    };
    const binKeys = Object.keys(rootPkg.bin ?? {}).sort();
    expect(await requiredCliBins(ROOT)).toEqual(binKeys);
  });

  test("verifyWorkspaceCliBins resolves all shims via Bun.which", async () => {
    const result = await verifyWorkspaceCliBins({ repoRoot: ROOT });
    expect(result.status).toBe("PASS");
    expect(result.verified_count).toBe((await requiredCliBins(ROOT)).length);
    expect(result.xml_parse_entry?.bin).toBe("xml-parse");
    expect(result.xml_parse_entry?.resolvedPath.length).toBeGreaterThan(0);
  });
});
