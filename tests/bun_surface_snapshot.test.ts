import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildBunSurfaceSnapshot,
  collectDtsClosureFiles,
  deriveAmbientDtsKindNumbers,
  resolveBunTypesRootDir,
  resolveInstalledBunTypesEntry,
} from "../packages/sportsdesk-ops/src/bin/bun-surface.ts";
import { searchRootsFromModuleDir } from "../packages/sportsdesk-ops/src/lib/bun_surface_dts_inventory.ts";

const PACKAGE_SRC = resolve(
  import.meta.dir,
  "../packages/sportsdesk-ops/src/bin",
);
const searchRoots = searchRootsFromModuleDir(PACKAGE_SRC);

describe("bun-surface DOD snapshot", () => {
  test("collectDtsClosureFiles follows bun-types from @types/bun", () => {
    const entry = resolveInstalledBunTypesEntry(searchRoots);
    const files = collectDtsClosureFiles(entry, searchRoots);
    expect(files.some((path) => path.includes("bun-types"))).toBe(true);
    expect(files.some((path) => path.endsWith("bun.d.ts"))).toBe(true);
    expect(files.length).toBeGreaterThan(10);
  });

  test("deriveAmbientDtsKindNumbers counts non-zero categories from AST", () => {
    const entry = resolveInstalledBunTypesEntry(searchRoots);
    const files = collectDtsClosureFiles(entry, searchRoots);
    const typesRoot = resolveBunTypesRootDir(files);
    const commit = "a".repeat(40);
    const { counts, mergedFnNamespaces, astDtsSha256 } =
      deriveAmbientDtsKindNumbers(files, typesRoot, commit);
    expect(astDtsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(counts.functions).toBeGreaterThan(40);
    expect(counts.classes).toBeGreaterThan(20);
    expect(counts.interfaces).toBeGreaterThan(100);
    expect(counts.types).toBeGreaterThan(50);
    expect(counts.variables).toBeGreaterThan(15);
    expect(counts.namespaces).toBeGreaterThan(15);
    expect(mergedFnNamespaces).toContain("inspect");
    expect(mergedFnNamespaces).toContain("$");
    expect(counts.namespaces).toBeGreaterThanOrEqual(
      ["XML", "JSON5", "JSONL", "TOML", "YAML"].length,
    );
  });

  test("buildBunSurfaceSnapshot matches runtime version and domain tag", async () => {
    const snap = await buildBunSurfaceSnapshot({
      ...Bun.env,
      CLOUDFLARE_R2_API_TOKEN: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
    });
    expect(snap.domain).toBe("[Bun Runtime]");
    expect(snap.bun_version).toBe(Bun.version);
    expect(snap.bun_revision).toBe(Bun.revision);
    expect(snap.resolved_types_entry).toContain("@types/bun");
    expect(snap.audited_bun_commit).toMatch(/^[0-9a-f]+$/);
  });

  test("the closure includes every *.d.ts leaf in the bun-types root", () => {
    const entry = resolveInstalledBunTypesEntry(searchRoots);
    const files = collectDtsClosureFiles(entry, searchRoots);
    const typesRoot = resolveBunTypesRootDir(files);
    const leaves = readdirSync(typesRoot).filter(
      (name) => typeof name === "string" && name.endsWith(".d.ts"),
    );
    const closureNames = new Set(
      files
        .filter((file) => file.startsWith(`${typesRoot}/`))
        .map((file) => file.slice(typesRoot.length + 1)),
    );
    expect(leaves.filter((leaf) => !closureNames.has(leaf))).toEqual([]);
    // Optional entry points that index.d.ts never references.
    expect(leaves).toContain("jsx.d.ts");
    expect(leaves).toContain("test-globals.d.ts");
  });

  test("every cited line actually carries the symbol declaration", () => {
    const entry = resolveInstalledBunTypesEntry(searchRoots);
    const files = collectDtsClosureFiles(entry, searchRoots);
    const typesRoot = resolveBunTypesRootDir(files);
    const { symbolLocations } = deriveAmbientDtsKindNumbers(
      files,
      typesRoot,
      "a".repeat(40),
    );
    const samples = ["XML", "S3Client", "CryptoHasher"].flatMap((symbol) =>
      symbolLocations.filter((row) => row.symbol === symbol).slice(0, 2),
    );
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const row of samples) {
      const relative = row.leafPath.replace(/^packages\/bun-types\//, "");
      const line = readFileSync(resolve(typesRoot, relative), "utf8").split(
        "\n",
      )[row.line - 1];
      expect(line?.includes(row.symbol)).toBe(true);
    }
    const inspect = symbolLocations.filter((row) => row.symbol === "inspect");
    expect(new Set(inspect.map((row) => row.kind))).toEqual(
      new Set(["Function", "Namespace"]),
    );
  });

  test("ERR_CF_TOKEN_BLEED_10000 when both Cloudflare tokens set", async () => {
    await expect(
      buildBunSurfaceSnapshot({
        CLOUDFLARE_R2_API_TOKEN: "r2",
        CLOUDFLARE_API_TOKEN: "cf",
      }),
    ).rejects.toThrow("ERR_CF_TOKEN_BLEED_10000");
  });

  test("--filter XML emits leaf paths and GATE blob URLs", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(
          import.meta.dir,
          "../packages/sportsdesk-ops/bin/bun-surface.ts",
        ),
        "--filter",
        "XML",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([
      child.exited,
      child.stdout.text(),
    ]);
    expect(code).toBe(0);
    const snap = JSON.parse(stdout) as {
      audited_bun_commit: string;
      symbols: {
        symbol: string;
        kind: string;
        leafPath: string;
        line: number;
        blobUrl: string;
      }[];
    };
    expect(snap.symbols.length).toBeGreaterThan(0);
    expect(snap.symbols.every((row) => row.symbol === "XML")).toBe(true);
    expect(snap.symbols.some((row) => row.kind === "Namespace")).toBe(true);
    for (const row of snap.symbols) {
      expect(row.leafPath).toMatch(/^packages\/bun-types\/.+\.d\.ts$/);
      expect(row.line).toBeGreaterThan(0);
      expect(row.blobUrl).toBe(
        `https://github.com/oven-sh/bun/blob/${snap.audited_bun_commit}/${row.leafPath}#L${row.line}`,
      );
    }
  });
});

describe("bun-surface CLI", () => {
  test("--json emits leaf citations for every symbol by default", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(
          import.meta.dir,
          "../packages/sportsdesk-ops/bin/bun-surface.ts",
        ),
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([
      child.exited,
      child.stdout.text(),
    ]);
    expect(code).toBe(0);
    const snap = JSON.parse(stdout) as {
      audited_bun_commit: string;
      symbols?: Array<{
        symbol: string;
        leafPath: string;
        line: number;
        blobUrl: string;
      }>;
    };
    expect(snap.symbols?.length ?? 0).toBeGreaterThan(100);
    for (const row of snap.symbols ?? []) {
      expect(row.leafPath).toMatch(/^packages\/bun-types\/.+\.d\.ts$/);
      expect(row.line).toBeGreaterThan(0);
      expect(row.blobUrl).toBe(
        `https://github.com/oven-sh/bun/blob/${snap.audited_bun_commit}/${row.leafPath}#L${row.line}`,
      );
    }
    expect(snap.symbols?.some((row) => row.symbol === "XML")).toBe(true);
  });

  test("--no-symbols omits the citation payload", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(
          import.meta.dir,
          "../packages/sportsdesk-ops/bin/bun-surface.ts",
        ),
        "--json",
        "--no-symbols",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([
      child.exited,
      child.stdout.text(),
    ]);
    expect(code).toBe(0);
    const snap = JSON.parse(stdout) as Record<string, unknown>;
    expect("symbols" in snap).toBe(false);
  });

  test("--help exits 0", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(
          import.meta.dir,
          "../packages/sportsdesk-ops/bin/bun-surface.ts",
        ),
        "--help",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([
      child.exited,
      child.stdout.text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("DOD-DEHARDCODE-02");
  });
});
