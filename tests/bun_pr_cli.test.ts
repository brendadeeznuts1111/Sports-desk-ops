/**
 * @file tests/bun_pr_cli.test.ts
 * @description Unit tests for the dx pr / bun_pr_cli operator interface.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const CLI_PATH = new URL("../bin/bun_pr_cli.ts", import.meta.url).pathname;

describe("dx pr / bun_pr_cli", () => {
  test("displays help message when called with --help", () => {
    const res = spawnSync(process.execPath, [CLI_PATH, "--help"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(
      "dx pr — download, test, and manage upstream Bun PR builds",
    );
    expect(res.stdout).toContain("--verify");
    expect(res.stdout).toContain("--list");
    expect(res.stdout).toContain("--clean");
  });

  test("displays installed binaries when called with --list", () => {
    const res = spawnSync(process.execPath, [CLI_PATH, "--list"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(
      /(Installed upstream Bun PR binaries|No upstream Bun PR binaries installed)/,
    );
  });

  test("fails fast with exit code 1 when target is missing", () => {
    const res = spawnSync(process.execPath, [CLI_PATH, "--verify"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Error: PR number, branch, or URL required.");
  });
});
