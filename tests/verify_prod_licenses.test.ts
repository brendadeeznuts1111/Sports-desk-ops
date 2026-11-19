import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  ALLOWED_LICENSES,
  auditLicenses,
  normalizeEntries,
  PACKAGE_LICENSE_EXCEPTIONS,
  runCli,
} from "../scripts/verify_prod_licenses.ts";

function makeFullValidProdSnapshot() {
  return [
    { name: "react", version: "18.3.1", license: "MIT" },
    { name: "which", version: "4.0.0", license: "ISC" },
    { name: "long", version: "4.0.0", license: "Apache-2.0" },
    { name: "http-cache-semantics", version: "4.3.0", license: "BSD-2-Clause" },
    { name: "fast-uri", version: "3.1.9", license: "BSD-3-Clause" },
    { name: "elkjs", version: "0.9.3", license: "EPL-2.0" },
    {
      name: "elkjs",
      version: "0.12.1",
      license: "EPL-2.0 OR GPL-3.0-or-later",
    },
    { name: "diffusion", version: "6.4.4", license: "LGPL-3.0+" },
    {
      name: "@ganchrowsci/gs-sdk",
      version: "1.0.27",
      license: "SEE LICENSE IN LICENSE",
    },
  ];
}

describe("normalizeEntries", () => {
  test("parses array of package records", () => {
    const out = normalizeEntries([
      { name: "zod", version: "4.6.7", license: " MIT " },
    ]);
    expect(out).toEqual([{ name: "zod", version: "4.6.7", license: "MIT" }]);
  });

  test("parses { packages: [...] } wrapper shape", () => {
    const out = normalizeEntries({
      packages: [{ name: "hono", version: "4.0.0", license: "MIT" }],
    });
    expect(out).toEqual([{ name: "hono", version: "4.0.0", license: "MIT" }]);
  });

  test("parses Bun 1.4.4 license-grouped object map", () => {
    const out = normalizeEntries({
      MIT: [{ name: "zod", versions: ["4.6.7"], license: "MIT" }],
      "SEE LICENSE IN LICENSE": [
        { name: "@ganchrowsci/gs-sdk", versions: ["1.0.27"] },
      ],
    });
    expect(out).toEqual([
      { name: "zod", version: "4.6.7", license: "MIT" },
      {
        name: "@ganchrowsci/gs-sdk",
        version: "1.0.27",
        license: "SEE LICENSE IN LICENSE",
      },
    ]);
  });

  test("parses keyed object map including scoped packages", () => {
    const out = normalizeEntries({
      "@ganchrowsci/gs-sdk@1.0.27": "SEE LICENSE IN LICENSE",
      "zod@4.6.7": { license: "MIT" },
    });
    expect(out).toEqual([
      {
        name: "@ganchrowsci/gs-sdk",
        version: "1.0.27",
        license: "SEE LICENSE IN LICENSE",
      },
      { name: "zod", version: "4.6.7", license: "MIT" },
    ]);
  });

  test("returns empty array for primitives and null", () => {
    expect(normalizeEntries(null)).toEqual([]);
    expect(normalizeEntries(undefined)).toEqual([]);
    expect(normalizeEntries("MIT")).toEqual([]);
  });
});

describe("auditLicenses — allowed licenses & pinned exceptions", () => {
  test("passes when all packages match ALLOWED_LICENSES or PACKAGE_LICENSE_EXCEPTIONS", () => {
    const result = auditLicenses(makeFullValidProdSnapshot());
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeNull();
    expect(result.totalPackages).toBe(9);
    expect(result.activeExceptionPackages).toBe(
      PACKAGE_LICENSE_EXCEPTIONS.size,
    );
    expect(result.violations).toEqual([]);
    expect(result.staleExceptions).toEqual([]);
  });

  test("fails when a transitive package introduces an unapproved license", () => {
    const snapshot = [
      ...makeFullValidProdSnapshot(),
      { name: "gpl-rogue-dep", version: "1.2.3", license: "AGPL-3.0-only" },
    ];
    const result = auditLicenses(snapshot);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ERR_OPS_LICENSE_DISALLOWED");
    expect(result.violations).toEqual([
      { name: "gpl-rogue-dep", version: "1.2.3", license: "AGPL-3.0-only" },
    ]);
    expect(result.staleExceptions).toEqual([]);
  });

  test("rejects an excepted license when used by a different package", () => {
    const snapshot = [
      ...makeFullValidProdSnapshot(),
      { name: "other-pkg", version: "2.0.0", license: "LGPL-3.0+" },
    ];
    const result = auditLicenses(snapshot);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ERR_OPS_LICENSE_DISALLOWED");
    expect(result.violations).toEqual([
      { name: "other-pkg", version: "2.0.0", license: "LGPL-3.0+" },
    ]);
  });

  test("rejects missing license field as UNKNOWN", () => {
    const result = auditLicenses(
      [{ name: "unlicensed-pkg", version: "0.1.0" }],
      ALLOWED_LICENSES,
      new Map(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ERR_OPS_LICENSE_DISALLOWED");
    expect(result.violations[0]?.license).toBe("UNKNOWN");
  });
});

describe("auditLicenses — stale exception detection", () => {
  test("flags stale exception when an excepted package is removed", () => {
    const snapshot = makeFullValidProdSnapshot().filter(
      (p) => p.name !== "diffusion",
    );
    const result = auditLicenses(snapshot);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ERR_OPS_LICENSE_STALE_EXCEPTION");
    expect(result.violations).toEqual([]);
    expect(result.staleExceptions).toEqual([
      { name: "diffusion", license: "LGPL-3.0+" },
    ]);
  });

  test("flags stale license variant when duplicate elkjs@0.9.3 is collapsed", () => {
    const snapshot = makeFullValidProdSnapshot().filter(
      (p) => !(p.name === "elkjs" && p.version === "0.9.3"),
    );
    const result = auditLicenses(snapshot);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ERR_OPS_LICENSE_STALE_EXCEPTION");
    expect(result.staleExceptions).toEqual([
      { name: "elkjs", license: "EPL-2.0" },
    ]);
  });

  test("reports both violations and stale exceptions in a single pass", () => {
    const snapshot = [
      ...makeFullValidProdSnapshot().filter((p) => p.name !== "diffusion"),
      { name: "rogue-pkg", version: "0.0.1", license: "GPL-3.0-only" },
    ];
    const result = auditLicenses(snapshot);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.staleExceptions).toEqual([
      { name: "diffusion", license: "LGPL-3.0+" },
    ]);
  });
});

describe("fail-closed error paths", () => {
  test("fails closed on empty package list", () => {
    const result = auditLicenses([]);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ERR_OPS_LICENSE_EMPTY_RESULT");
  });

  test("runCli returns 1 when bun pm licenses exits non-zero", () => {
    const fakeSpawn = (() => ({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("lockfile missing"),
    })) as unknown as typeof Bun.spawnSync;

    expect(runCli(fakeSpawn)).toBe(1);
  });

  test("runCli returns 1 on malformed JSON stdout", () => {
    const fakeSpawn = (() => ({
      exitCode: 0,
      stdout: Buffer.from("{not-valid-json"),
      stderr: Buffer.from(""),
    })) as unknown as typeof Bun.spawnSync;

    expect(runCli(fakeSpawn)).toBe(1);
  });

  test("runCli returns 0 on valid snapshot", () => {
    const fakeSpawn = (() => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(makeFullValidProdSnapshot())),
      stderr: Buffer.from(""),
    })) as unknown as typeof Bun.spawnSync;

    expect(runCli(fakeSpawn)).toBe(0);
  });
});

const RUN_LIVE_WORKSPACE_GATE = process.env.VERIFY_LICENSES_LIVE === "1";
const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/verify_prod_licenses.ts");

describe.if(RUN_LIVE_WORKSPACE_GATE)("live workspace integration", () => {
  test("bun run scripts/verify_prod_licenses.ts exits 0 against the real lockfile", () => {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "--no-env-file", "run", SCRIPT_PATH],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = proc.stdout.toString().trim();
    const stderr = proc.stderr.toString().trim();

    expect(stderr).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(stdout).toMatch(
      /^OK: \d+ production package\(s\) verified against license allowlist \(\d+ active package exception\(s\), 0 stale\)\.$/,
    );
  });
});
