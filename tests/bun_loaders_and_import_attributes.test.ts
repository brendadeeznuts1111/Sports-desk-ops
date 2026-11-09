/**
 * @file tests/bun_loaders_and_import_attributes.test.ts
 * @description Contract verification for native Bun loaders and import attributes (with { type: ... }).
 *
 * Verifies native loader capabilities across:
 *  - TOML (.toml or with { type: "toml" })
 *  - YAML (.yaml, .yml or with { type: "yaml" })
 *  - XML (.xml or with { type: "xml" })
 *  - JSONC (json with comments, tsconfig.json)
 *  - Text (with { type: "text" })
 *  - SQLite (with { type: "sqlite" } returning Database instance)
 */

import { describe, expect, it, onTestFinished } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";

// 1. Static loader imports
import bunfigStatic from "../bunfig.toml" with { type: "toml" };
import betFlagsStatic from "../config/bet-flags.yml" with { type: "yaml" };
import xmlRssStatic from "./fixtures/bun-xml-golden-ast/rss-channel-title-fragment.xml" with { type: "xml" };

describe("Bun Native Loaders & Import Attributes", () => {
  describe("TOML Loader", () => {
    it("statically imports TOML configuration as parsed JavaScript object", () => {
      expect(bunfigStatic).toBeDefined();
      expect(bunfigStatic.fmt?.printWidth).toBe(80);
      expect(bunfigStatic.fmt?.semi).toBe(true);
      expect(Array.isArray(bunfigStatic.fmt?.ignorePatterns)).toBe(true);
    });

    it("dynamically imports TOML using import attribute { with: { type: 'toml' } }", async () => {
      const { default: captureConfig } = (await import(
        "../config/wagers-capture.toml",
        { with: { type: "toml" } }
      )) as {
        default: {
          capture?: { retries?: number; timeoutMs?: number };
          publish?: { channel?: string };
        };
      };

      expect(captureConfig).toBeDefined();
      expect(captureConfig.capture?.retries).toBe(2);
      expect(captureConfig.publish?.channel).toBe("gslive-wagers");
    });
  });

  describe("YAML Loader", () => {
    it("statically imports YAML configuration with native parser", () => {
      expect(betFlagsStatic).toBeDefined();
      const flags = betFlagsStatic as {
        schemaVersion?: number;
        rules?: Array<{ id: string; enabled: boolean }>;
      };
      expect(flags.schemaVersion).toBe(1);
      expect(Array.isArray(flags.rules)).toBe(true);
      expect(flags.rules!.length).toBeGreaterThanOrEqual(6);
    });

    it("dynamically imports YAML using import attribute { with: { type: 'yaml' } }", async () => {
      const { default: flags } = (await import("../config/bet-flags.yml", {
        with: { type: "yaml" },
      })) as {
        default: {
          schemaVersion?: number;
          rules?: Array<{ id: string }>;
        };
      };

      expect(flags.schemaVersion).toBe(1);
      expect(flags.rules?.some((r) => r.id === "stake_over_10k")).toBe(true);
    });
  });

  describe("XML Loader", () => {
    it("statically imports XML directly into Bun.XML compact AST Document", () => {
      expect(xmlRssStatic).toBeDefined();
      const rssDoc = xmlRssStatic as {
        rss?: { channel?: { title?: string } };
      };
      expect(rssDoc.rss?.channel?.title).toBe("Bun");
    });

    it("dynamically imports XML using import attribute { with: { type: 'xml' } }", async () => {
      const { default: doc } = (await import(
        "./fixtures/bun-xml-golden-ast/plane1-link-id-feed.xml",
        { with: { type: "xml" } }
      )) as {
        default: {
          feed?: { id?: string; title?: string };
        };
      };

      expect(doc).toBeDefined();
      expect(doc.feed).toBeDefined();
    });
  });

  describe("JSONC Loader", () => {
    it("imports JSON with comments stripping comments and trailing commas", async () => {
      const { default: tsconfig } = (await import("../tsconfig.json")) as {
        default: {
          compilerOptions?: { strict?: boolean; target?: string };
          include?: string[];
        };
      };

      expect(tsconfig).toBeDefined();
      expect(tsconfig.compilerOptions?.strict).toBe(true);
      expect(Array.isArray(tsconfig.include)).toBe(true);
    });
  });

  describe("Text Loader", () => {
    it("imports raw file contents as string using { with: { type: 'text' } }", async () => {
      const readmePath = resolve(import.meta.dir, "../README.md");
      const { default: rawContent } = (await import(readmePath, {
        with: { type: "text" },
      })) as { default: string };

      expect(typeof rawContent).toBe("string");
      expect(rawContent).toContain("sportsdesk-ops");
    });
  });

  describe("SQLite Loader", () => {
    it("dynamically imports .sqlite file into a live Database connection", async () => {
      const tempDbPath = resolve(
        import.meta.dir,
        "scratch_import_attribute_test.sqlite",
      );

      // Create fixture DB with sample schema
      const initDb = new Database(tempDbPath);
      initDb.run(
        "CREATE TABLE test_scores (cohort TEXT PRIMARY KEY, score REAL)",
      );
      initDb.run(
        "INSERT INTO test_scores (cohort, score) VALUES ('CFB_1H', 98.5)",
      );
      initDb.close();

      onTestFinished(() => {
        try {
          unlinkSync(tempDbPath);
        } catch {
          // Cleanup if needed
        }
      });

      // Load DB dynamically via import attribute
      const { default: db } = (await import(tempDbPath, {
        with: { type: "sqlite" },
      })) as { default: Database };

      expect(db).toBeInstanceOf(Database);
      const row = db
        .query<{ cohort: string; score: number }, []>(
          "SELECT cohort, score FROM test_scores WHERE cohort = 'CFB_1H'",
        )
        .get();

      expect(row).toBeDefined();
      expect(row?.cohort).toBe("CFB_1H");
      expect(row?.score).toBe(98.5);

      db.close();
    });
  });
});
