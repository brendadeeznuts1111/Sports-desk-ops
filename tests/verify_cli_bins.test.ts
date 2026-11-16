import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  REQUIRED_CLI_BINS,
  verifyWorkspaceCliBins,
} from "../scripts/verify_cli_bins.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("verify_cli_bins", () => {
  test("REQUIRED_CLI_BINS matches root package.json bin count", async () => {
    const rootPkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
      bin?: Record<string, string>;
    };
    const binKeys = Object.keys(rootPkg.bin ?? {}).sort();
    expect(REQUIRED_CLI_BINS.length as number).toBe(binKeys.length);
    expect([...(REQUIRED_CLI_BINS as readonly string[])].sort()).toEqual(
      binKeys,
    );
  });

  test("verifyWorkspaceCliBins resolves all shims via Bun.which", async () => {
    const result = await verifyWorkspaceCliBins({ repoRoot: ROOT });
    expect(result.status).toBe("PASS");
    expect(result.verified_count).toBe(23);
    expect(result.xml_parse_entry?.bin).toBe("xml-parse");
    expect(result.xml_parse_entry?.resolvedPath.length).toBeGreaterThan(0);
  });
});
