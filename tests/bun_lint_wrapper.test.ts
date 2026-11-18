/**
 * @file tests/bun_lint_wrapper.test.ts
 * @description `lint:bun` must never select the rewriting package script on 1.4.4, and must use
 * native `bun lint --no-script` when a canary binary is available.
 */
import { describe, expect, test } from "bun:test";

import { nativeLintCommands, oxlintCommands } from "../scripts/bun_lint.ts";

describe("lint:bun command selection", () => {
  test("1.4.4 fallback runs both read-only oxlint passes", () => {
    const commands = oxlintCommands(["lib/a.ts"]);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.native).toBe(false);
      expect(command.argv).not.toContain("--fix");
      expect(command.argv).toContain("--deny-warnings");
      expect(command.argv.at(-1)).toBe("lib/a.ts");
    }
    expect(commands[0]?.argv).toContain("--bun");
    expect(commands[1]?.argv).toContain("--type-aware");
    expect(commands[1]?.argv).toContain(".oxlintrc.type-aware.json");
  });

  test("native commands pass --no-script and never --fix", () => {
    const commands = nativeLintCommands("/opt/bun-canary", ["lib/a.ts"]);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.bin).toBe("/opt/bun-canary");
      expect(command.native).toBe(true);
      expect(command.argv.slice(0, 2)).toEqual(["lint", "--no-script"]);
      expect(command.argv).toContain("--deny-warnings");
      expect(command.argv).not.toContain("--fix");
      expect(command.argv.at(-1)).toBe("lib/a.ts");
    }
    expect(commands[1]?.argv).toContain("--type-aware");
  });
});
