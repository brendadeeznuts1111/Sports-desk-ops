import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * The Bun built-ins that replace npm packages.
 *
 * Release notes: Bun.JSON5 (json5), Bun.JSONL (ndjson), Bun.JSONC
 * (jsonc-parser), Bun.XML (fast-xml-parser/xml2js), Bun.TOML (@iarna/toml),
 * Bun.Archive (tar), Bun.sliceAnsi / wrapAnsi / stringWidth (slice-ansi,
 * cli-truncate, wrap-ansi, string-width), and URLPattern (path-to-regexp).
 *
 * This repository already uses every one of them. These tests keep the npm
 * replacements out of every workspace manifest, so the migration cannot be
 * undone by adding a dependency that Bun now ships natively.
 */

/** Package names whose functionality Bun provides as a built-in. */
const REPLACED_PACKAGES = [
  "json5",
  "ndjson",
  "jsonc-parser",
  "fast-xml-parser",
  "xml2js",
  "@iarna/toml",
  "tar",
  "slice-ansi",
  "cli-truncate",
  "wrap-ansi",
  "string-width",
  "path-to-regexp",
] as const;

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

async function manifests(): Promise<string[]> {
  const workspaces = [...new Bun.Glob("packages/*/package.json").scanSync(".")];
  return ["package.json", ...workspaces.sort()];
}

describe("Bun built-in replacements", () => {
  test("no workspace manifest depends on a package Bun replaces", async () => {
    const files = await manifests();
    expect(files.length).toBeGreaterThan(1);

    const offenders: string[] = [];
    for (const file of files) {
      const pkg = (await Bun.file(resolve(process.cwd(), file)).json()) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      for (const section of DEPENDENCY_SECTIONS) {
        const declared = pkg[section];
        if (!declared) continue;
        for (const name of REPLACED_PACKAGES) {
          if (name in declared) offenders.push(`${file} ${section} ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the built-in surfaces the repository relies on are present", () => {
    // The shape catalog (lib/bun_shapes.ts) owns the docs surface; this is the
    // runtime half: a Bun downgrade that dropped one fails here first.
    for (const fn of [
      Bun.JSON5.parse,
      Bun.JSON5.stringify,
      Bun.JSONL.parse,
      Bun.JSONL.parseChunk,
      Bun.JSONC.parse,
      Bun.XML.parse,
      Bun.sliceAnsi,
      Bun.wrapAnsi,
      Bun.stringWidth,
    ]) {
      expect(typeof fn).toBe("function");
    }
    expect(typeof Bun.Archive).toBe("function");
    expect(typeof Bun.TOML.stringify).toBe("function");
    expect(typeof URLPattern).toBe("function");
  });
});
