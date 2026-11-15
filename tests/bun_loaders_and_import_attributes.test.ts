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
 *
 * Also pins the two documented edges of import attributes:
 *  - an explicit attribute overrides the file extension at runtime
 *  - on TypeScript < 7.1 the STATIC type still comes from the extension, so a
 *    type-mismatched import compiles; the assertions in "static typing follows the
 *    extension" are the ratchet that flips when the repo moves to TS 7.1+
 */

import { describe, expect, it, onTestFinished } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";

// 1. Static loader imports
import bunfigStatic from "../bunfig.toml" with { type: "toml" };
import betFlagsStatic from "../config/bet-flags.yml" with { type: "yaml" };
import xmlRssStatic from "./fixtures/bun-xml-golden-ast/rss-channel-title-fragment.xml" with { type: "xml" };
import tomlFromTxt from "./fixtures/attribute-override/config.toml.txt" with { type: "toml" };
import textFromJson from "./fixtures/attribute-override/data.json" with { type: "text" };

describe("Bun Native Loaders & Import Attributes", () => {
  describe("Explicit type attributes override the extension", () => {
    it("parses TOML from a .txt file at runtime", () => {
      expect(typeof tomlFromTxt).toBe("object");
      const parsed = tomlFromTxt as unknown as {
        answer: number;
        label: string;
      };
      expect(parsed.answer).toBe(42);
      expect(parsed.label).toContain("TOML");
    });

    it("loads a .json file as text at runtime", () => {
      // The static type here is the parsed object (extension .json), so the string
      // operations need the runtime truth cast in — this test is the reason the
      // typing assertion below exists.
      const runtimeText = textFromJson as unknown as string;
      expect(typeof runtimeText).toBe("string");
      expect(runtimeText).toContain('"answer": 42');
    });

    it("static typing follows the extension, not the attribute (TS 5.9.3)", () => {
      // Bun docs: TypeScript 7.1+ types these imports from the type attribute;
      // older versions type them from the extension alone. The repo pins TS
      // 5.9.3, so both directions are mismatched right now: the runtime object
      // from config.toml.txt is typed string, and the runtime string from
      // data.json is typed as the parsed object. The assignments below are the
      // ratchet: they compile only while that mismatch holds, so a TypeScript
      // upgrade to 7.1+ fails typecheck here and the casts above can be dropped.
      // Measured 2026-11-14 with @types/bun 1.4.4:
      //   TS 5.9.3      toml-from-.txt -> string   text-from-.json -> { answer: number }
      //   TS 7.0.2      identical (extension still wins)
      //   TS 7.1.0-beta toml-from-.txt -> any      text-from-.json -> string
      // so the switch lands at 7.1, and the toml side becomes "any" rather than
      // the parsed object. The IsAny guard keeps that from passing silently.
      type Assignable<From, To> = From extends To ? true : false;
      type IsAny<T> = 0 extends 1 & T ? true : false;
      const tomlIsString: Assignable<typeof tomlFromTxt, string> = true;
      const tomlIsNotAny: IsAny<typeof tomlFromTxt> = false;
      const jsonIsObject: Assignable<typeof textFromJson, { answer: number }> =
        true;
      expect([tomlIsString, tomlIsNotAny, jsonIsObject]).toEqual([
        true,
        false,
        true,
      ]);
    });
  });

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

    it("follows YAML 1.2 parsing rules (yes/no/on/off parse as strings)", () => {
      const parsed = Bun.YAML.parse("yes: on\nno: off") as {
        yes?: unknown;
        no?: unknown;
      };
      expect(typeof parsed.yes).toBe("string");
      expect(parsed.yes).toBe("on");
      expect(typeof parsed.no).toBe("string");
      expect(parsed.no).toBe("off");
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
