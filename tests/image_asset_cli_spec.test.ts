/**
 * @file tests/image_asset_cli_spec.test.ts
 * @description Keeps the CLI flag table, the parser and the help artifact in sync: every long
 * flag the script accepts appears in `FLAG_SPECS`, and `TOOL_VERSION` is the package version.
 */
import { describe, expect, test } from "bun:test";

import {
  FLAG_SPECS,
  TOOL_VERSION,
  USAGE,
} from "../scripts/image_asset_cli_spec.ts";

const source = await Bun.file("scripts/image_asset_diagnostics.ts").text();
const packageJson = (await Bun.file("package.json").json()) as {
  readonly version: string;
};

function parserLongFlags(text: string): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const match of text.matchAll(/arg === "(--[a-z-]+)"/g)) {
    if (match[1] !== undefined) flags.add(match[1]);
  }
  for (const match of text.matchAll(/arg\.startsWith\("(--[a-z-]+)=?"\)/g)) {
    if (match[1] !== undefined) flags.add(match[1]);
  }
  for (const match of text.matchAll(/argv\.includes\("(--[a-z-]+)"\)/g)) {
    if (match[1] !== undefined) flags.add(match[1]);
  }
  return flags;
}

function documentedLongFlags(): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const spec of FLAG_SPECS) {
    for (const match of spec.flags.matchAll(/--[a-z-]+/g)) {
      flags.add(match[0]);
    }
  }
  return flags;
}

describe("assets:diagnostics flag table", () => {
  test("documents exactly the long flags the parser accepts", () => {
    expect([...parserLongFlags(source)].sort()).toEqual(
      [...documentedLongFlags()].sort(),
    );
  });

  test("help is generated from every spec row", () => {
    for (const spec of FLAG_SPECS) {
      expect(USAGE).toContain(spec.flags);
    }
    expect(USAGE).toStartWith(`image_asset_diagnostics ${TOOL_VERSION}`);
  });

  test("the tool version is the package version", () => {
    expect(TOOL_VERSION).toBe(packageJson.version);
  });
});
