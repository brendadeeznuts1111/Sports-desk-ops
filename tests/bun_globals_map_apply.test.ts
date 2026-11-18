/**
 * Unit fixtures for `lib/bun_globals_map_apply.ts` — the writer of the committed artifact.
 *
 * These cover the failure modes the CLI can hit without the repository or a network: report mode
 * never writing, idempotent no-op applies, legacy provenance migration, metadata provenance
 * refresh, and rollback when the formatter fails.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySummaryFixes,
  HAND_NOTE,
  mergeGeneratedMeta,
  normalizeRecord,
  preserveHandAnnotations,
} from "../lib/bun_globals_map_apply.ts";
import {
  type BunTypesDeclarations,
  parseTypeScriptBases,
} from "../lib/bun_globals_map_summaries.ts";

type Fixture = {
  readonly dir: string;
  readonly rowsPath: string;
  readonly metaPath: string;
  readonly meta: Record<string, unknown>;
};

const declarationsOf = (source: string): BunTypesDeclarations => ({
  package: "bun-types@test",
  files: ["/tmp/bun-types-test/index.d.ts"],
  relativeFiles: [
    "node_modules/bun-types/index.d.ts",
    "node_modules/bun-types/s3.d.ts",
  ],
  declarations: parseTypeScriptBases(source, { module: "bun" }),
});

const bunModule = (body: string): string =>
  `declare module "bun" {\n${body}\n}\n`;

const MD5_CLAIM = "This class only exists in types";

function fixture(
  rows: readonly unknown[],
  meta: Record<string, unknown>,
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bgma-"));
  const rowsPath = join(dir, "rows.json");
  const metaPath = join(dir, "meta.json");
  writeFileSync(rowsPath, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { dir, rowsPath, metaPath, meta };
}

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as unknown;

const currentMeta = (): Record<string, unknown> => ({
  scrapedAt: "2026-11-04T23:48:54.757Z",
  bunVersion: "1.4.4",
  bunTypes: {
    package: "bun-types@test",
    files: [
      "node_modules/bun-types/index.d.ts",
      "node_modules/bun-types/s3.d.ts",
    ],
  },
  summariesSuppressed: [],
});

describe("applySummaryFixes", () => {
  test("report mode never writes", async () => {
    const rows = [
      { symbol: "globals.bun.MD5", kind: "class", summary: MD5_CLAIM },
    ];
    const f = fixture(rows, currentMeta());
    const before = readFileSync(f.rowsPath, "utf8");
    let formatCalls = 0;
    const result = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations: declarationsOf(bunModule("class MD5 {}")),
      apply: false,
      format: () => {
        formatCalls += 1;
        return true;
      },
    });
    expect(result.wrote).toBe(false);
    expect(result.falsified).toHaveLength(1);
    expect(result.remaining).toBe(1);
    expect(formatCalls).toBe(0);
    expect(readFileSync(f.rowsPath, "utf8")).toBe(before);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("apply with nothing to do writes nothing", async () => {
    const rows = [
      { symbol: "globals.bun.MD5", kind: "class", summary: "" },
      { symbol: "globals.bun.Other", kind: "class", summary: "A summary" },
    ];
    const f = fixture(rows, currentMeta());
    const result = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations: declarationsOf(bunModule("class MD5 {}")),
      apply: true,
      format: () => true,
    });
    expect(result.wrote).toBe(false);
    expect(result.remaining).toBe(0);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("apply clears falsified claims, records provenance, and re-verifies", async () => {
    const rows = [
      { symbol: "globals.bun.MD5", kind: "class", summary: MD5_CLAIM },
    ];
    const f = fixture(rows, currentMeta());
    const result = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations: declarationsOf(bunModule("class MD5 {}")),
      apply: true,
      format: () => true,
    });
    expect(result.wrote).toBe(true);
    expect(result.applied.map((claim) => claim.symbol)).toEqual([
      "globals.bun.MD5",
    ]);
    expect(result.remaining).toBe(0);
    expect((readJson(f.rowsPath) as { summary: string }[])[0]?.summary).toBe(
      "",
    );
    const meta = readJson(f.metaPath) as {
      summariesSuppressed: { symbol: string; reason: string }[];
    };
    expect(meta.summariesSuppressed).toEqual([
      expect.objectContaining({
        symbol: "globals.bun.MD5",
        reason: "types-only-falsified",
      }),
    ]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("legacy provenance migrates even when no new defect is found, and converges", async () => {
    const rows = [{ symbol: "globals.bun.MD5", kind: "class", summary: "" }];
    const f = fixture(rows, {
      ...currentMeta(),
      summariesSuppressed: [
        {
          symbol: "globals.bun.MD5",
          runtimeTypeof: "function",
          upstreamSummary: MD5_CLAIM,
        },
      ],
    });
    const declarations = declarationsOf(bunModule("class MD5 {}"));
    const first = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations,
      apply: true,
      format: () => true,
    });
    expect(first.legacyRecords).toBe(1);
    expect(first.wrote).toBe(true);
    const meta = readJson(f.metaPath) as {
      summariesSuppressed: { reason?: string; detail?: string }[];
    };
    expect(meta.summariesSuppressed[0]?.reason).toBe("types-only-falsified");
    expect(meta.summariesSuppressed[0]?.detail).toBe("function");
    const second = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations,
      apply: true,
      format: () => true,
    });
    expect(second.wrote).toBe(false);
    expect(second.legacyRecords).toBe(0);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("metadata provenance refreshes to a package-relative shape", async () => {
    const rows = [{ symbol: "globals.bun.Other", kind: "class", summary: "x" }];
    const f = fixture(rows, {
      scrapedAt: "2026-11-04T23:48:54.757Z",
      bunTypesDeclaration:
        "/Users/someone/repo/node_modules/bun-types/index.d.ts",
    });
    const result = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations: declarationsOf(bunModule("class Other {}")),
      apply: true,
      format: () => true,
    });
    expect(result.wrote).toBe(true);
    const meta = readJson(f.metaPath) as Record<string, unknown>;
    expect("bunTypesDeclaration" in meta).toBe(false);
    expect(JSON.stringify(meta).includes("/Users/")).toBe(false);
    expect(meta.bunTypes).toEqual({
      package: "bun-types@test",
      files: [
        "node_modules/bun-types/index.d.ts",
        "node_modules/bun-types/s3.d.ts",
      ],
    });
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("a formatter failure rolls the artifact back to its previous bytes", async () => {
    const rows = [
      { symbol: "globals.bun.MD5", kind: "class", summary: MD5_CLAIM },
    ];
    const f = fixture(rows, currentMeta());
    const beforeRows = readFileSync(f.rowsPath, "utf8");
    const beforeMeta = readFileSync(f.metaPath, "utf8");
    const result = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations: declarationsOf(bunModule("class MD5 {}")),
      apply: true,
      format: () => false,
    });
    expect(result.formatted).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.wrote).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.remaining).toBe(1);
    expect(readFileSync(f.rowsPath, "utf8")).toBe(beforeRows);
    expect(readFileSync(f.metaPath, "utf8")).toBe(beforeMeta);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("inherited and falsified defects are cleared together", async () => {
    const rows = [
      { symbol: "globals.bun.MD5", kind: "class", summary: MD5_CLAIM },
      {
        symbol: "globals.bun.Base",
        kind: "interface",
        summary: "A TCP socket.",
      },
      {
        symbol: "globals.bun.Child",
        kind: "interface",
        summary: "A TCP socket.",
      },
    ];
    const f = fixture(rows, currentMeta());
    const declarations = declarationsOf(
      bunModule(
        "class MD5 {}\n/** own */\ninterface Base {}\ninterface Child extends Base {}",
      ),
    );
    const result = await applySummaryFixes({
      rowsPath: f.rowsPath,
      metaPath: f.metaPath,
      declarations,
      apply: true,
      format: () => true,
    });
    expect(
      result.applied.map((claim) => `${claim.symbol}:${claim.reason}`).sort(),
    ).toEqual([
      "globals.bun.Child:inherited-from-base",
      "globals.bun.MD5:types-only-falsified",
    ]);
    expect(result.remaining).toBe(0);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("normalizeRecord keeps an explicit reason and fills legacy detail", () => {
    expect(
      normalizeRecord({
        symbol: "globals.bun.A",
        reason: "inherited-from-base",
        detail: "Base",
        upstreamSummary: "text",
      }),
    ).toEqual({
      symbol: "globals.bun.A",
      reason: "inherited-from-base",
      detail: "Base",
      upstreamSummary: "text",
    });
    expect(
      normalizeRecord({ symbol: "globals.bun.B", runtimeTypeof: "function" }),
    ).toEqual({
      symbol: "globals.bun.B",
      reason: "types-only-falsified",
      detail: "function",
      upstreamSummary: "",
    });
    expect(normalizeRecord({ symbol: "globals.bun.C" })).toEqual({
      symbol: "globals.bun.C",
      reason: "types-only-falsified",
      detail: "unknown",
      upstreamSummary: "",
    });
  });
});

describe("scraper merge helpers", () => {
  const declarations = (): BunTypesDeclarations => ({
    package: "bun-types@test",
    files: ["/tmp/index.d.ts", "/tmp/s3.d.ts"],
    relativeFiles: [
      "node_modules/bun-types/index.d.ts",
      "node_modules/bun-types/s3.d.ts",
    ],
    declarations: new Map(),
  });

  test("hand annotations are carried by kind + symbol, never across rows", () => {
    const note = "[Not in Bun 1.4.4: no declaration in bun-types@1.4.4]";
    expect(HAND_NOTE.test(note)).toBe(true);
    const previous = [
      { kind: "interface", symbol: "globals.bun.TrimOptions", summary: note },
      {
        kind: "class",
        symbol: "globals.bun.CookieMap",
        summary: "hand text without prefix",
      },
    ];
    const rows = [
      {
        kind: "interface",
        symbol: "globals.bun.TrimOptions",
        summary: "upstream text",
      },
      {
        kind: "class",
        symbol: "globals.bun.TrimOptions",
        summary: "upstream text",
      },
      { kind: "class", symbol: "globals.bun.Other", summary: "other" },
    ];
    const merged = preserveHandAnnotations(previous, rows);
    expect(merged[0]?.summary).toBe(note);
    // Same symbol, different kind: the note does not leak across sections.
    expect(merged[1]?.summary).toBe("upstream text");
    expect(merged[2]?.summary).toBe("other");
    // A non-prefixed hand summary is not treated as a note and is replaced by the scrape.
    expect(
      preserveHandAnnotations(previous, [
        { kind: "class", symbol: "globals.bun.CookieMap", summary: "fresh" },
      ])[0]?.summary,
    ).toBe("fresh");
  });

  test("no previous rows means no mapping work and identical rows", () => {
    const rows = [{ kind: "class", symbol: "globals.bun.A", summary: "a" }];
    const merged = preserveHandAnnotations([], rows);
    expect(merged).toEqual(rows);
  });

  test("generated metadata wins, hand keys survive, provenance is relative", () => {
    const suppressed = [
      {
        symbol: "globals.bun.MD5",
        reason: "types-only-falsified" as const,
        detail: "function",
        upstreamSummary: "This class only exists in types",
      },
    ];
    const merged = mergeGeneratedMeta({
      previous: {
        scrapedAt: "2026-11-04T00:00:00.000Z",
        bunVersion: "1.4.3",
        urlShapeMigration: { note: "hand" },
        post144Rows: { symbols: ["globals.bun.AotHeat"] },
        bunTypesDeclaration:
          "/Users/someone/repo/node_modules/bun-types/index.d.ts",
      },
      generated: {
        scrapedAt: "2026-11-18T00:00:00.000Z",
        bunVersion: "1.4.4",
        summariesSuppressed: [],
      },
      declarations: declarations(),
      summariesSuppressed: suppressed,
    });
    expect(merged.scrapedAt).toBe("2026-11-18T00:00:00.000Z");
    expect(merged.bunVersion).toBe("1.4.4");
    expect(merged.urlShapeMigration).toEqual({ note: "hand" });
    expect(merged.post144Rows).toEqual({ symbols: ["globals.bun.AotHeat"] });
    expect(JSON.stringify(merged).includes("/Users/")).toBe(false);
    expect(merged.bunTypes).toEqual({
      package: "bun-types@test",
      files: [
        "node_modules/bun-types/index.d.ts",
        "node_modules/bun-types/s3.d.ts",
      ],
    });
    expect(merged.summariesSuppressed).toEqual(suppressed);
  });
});
