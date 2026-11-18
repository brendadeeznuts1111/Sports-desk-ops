/**
 * @file tests/bun_lint_wrapper.test.ts
 * @description `lint:bun` must run native `bun lint --no-script --type-aware` read-only and never `--fix`.
 */
import { describe, expect, test } from "bun:test";

import { nativeLintCommands } from "../scripts/bun_lint.ts";

describe("lint:bun command selection", () => {
  test("native command passes --no-script --type-aware and never --fix", () => {
    const commands = nativeLintCommands("/opt/bun-canary", ["lib/a.ts"]);
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.bin).toBe("/opt/bun-canary");
    expect(command.native).toBe(true);
    expect(command.argv.slice(0, 4)).toEqual([
      "lint",
      "--no-script",
      "--type-aware",
      "--deny-warnings",
    ]);
    expect(command.argv).not.toContain("--fix");
    expect(command.argv.at(-1)).toBe("lib/a.ts");
  });
});
