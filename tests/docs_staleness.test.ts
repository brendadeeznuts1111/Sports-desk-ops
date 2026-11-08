/**
 * Tests for scripts/check_docs_staleness.ts.
 *
 * Includes diff-based regression proofs against the pre-cleanup commits (`b1471fe^`
 * and `e5a2848^`) so the gate is verified against the exact historical regressions
 * in `README.md`, `AGENTS.md`, `ROOT_LAYOUT.md`, and `docs/REMAINING_TASKS.md`, as
 * well as zero-finding verification against the current repository checkout.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODES,
  DEFAULT_TARGETS,
  parseCliArgs,
  reportStalenessOutcomes,
  runStalenessChecks,
  scanMarkdownText,
} from "../scripts/check_docs_staleness.ts";

const MODULE_DIR =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(MODULE_DIR, "..");

function gitShow(revisionAndPath: string): string {
  const res = spawnSync("git", ["show", revisionAndPath], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(
      `git show ${revisionAndPath} failed: ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout;
}

describe("check_docs_staleness — current checkout & historical git-diff proof", () => {
  test("passes with zero findings across all current repository target docs", () => {
    const outcomes = runStalenessChecks({
      root: ROOT,
      warn: false,
      targets: DEFAULT_TARGETS,
    });
    for (const outcome of outcomes) {
      expect(
        outcome.issues,
        `${outcome.target} had unexpected staleness findings: ${JSON.stringify(outcome.issues)}`,
      ).toEqual([]);
      expect(["pass", "skip"]).toContain(outcome.status);
    }
  });

  test("fails on pre-cleanup b1471fe^:README.md at exact historical lines 23, 26, 29, 42, 90", () => {
    const preCleanupReadme = gitShow("b1471fe^:README.md");
    const issues = scanMarkdownText("README.md", preCleanupReadme, {
      expectedBunVersion: "1.4.4",
    });

    const byLine = new Map(issues.map((issue) => [issue.line, issue]));
    expect(byLine.get(23)?.code).toBe(CODES.SNAPSHOT_ENTITY_INVENTORY);
    expect(byLine.get(23)?.match).toContain("13 Per-Office");

    expect(byLine.get(26)?.code).toBe(CODES.SNAPSHOT_ENTITY_INVENTORY);
    expect(byLine.get(26)?.match).toContain("(9,435 accounts)");

    expect(byLine.get(29)?.code).toBe(CODES.SNAPSHOT_ENTITY_INVENTORY);
    expect(byLine.get(29)?.match).toContain("(23 valid)");

    expect(byLine.get(42)?.code).toBe(CODES.SCRIPT_BUNDLE_INVENTORY);
    expect(byLine.get(42)?.match).toContain("200+ package.json scripts");

    expect(byLine.get(90)?.code).toBe(CODES.SCRIPT_BUNDLE_INVENTORY);
    expect(byLine.get(90)?.match).toContain(
      "all 7 auditable surveillance reports",
    );
  });

  test("fails on pre-cleanup e5a2848^ versions of README.md, AGENTS.md, ROOT_LAYOUT.md, and docs/REMAINING_TASKS.md", () => {
    // 1. e5a2848^:README.md additionally had the pinned test/file counts on line 285
    const readmeIssues = scanMarkdownText(
      "README.md",
      gitShow("e5a2848^:README.md"),
      { expectedBunVersion: "1.4.4" },
    );
    expect(
      readmeIssues.some(
        (issue) =>
          issue.line === 285 &&
          issue.code === CODES.TEST_FILE_INVENTORY &&
          issue.match.includes("2,812 tests"),
      ),
    ).toBe(true);

    // 2. e5a2848^:AGENTS.md had hardcoded file/test counts on lines 4 and 72
    const agentsIssues = scanMarkdownText(
      "AGENTS.md",
      gitShow("e5a2848^:AGENTS.md"),
      { expectedBunVersion: "1.4.4" },
    );
    const agentsLines = new Set(agentsIssues.map((issue) => issue.line));
    expect(agentsLines.has(4)).toBe(true);
    expect(agentsLines.has(72)).toBe(true);
    expect(
      agentsIssues.some((issue) =>
        issue.match.includes("790 tracked TypeScript files"),
      ),
    ).toBe(true);
    expect(
      agentsIssues.some((issue) =>
        issue.match.includes("237 *.test.ts suites"),
      ),
    ).toBe(true);

    // 3. e5a2848^:ROOT_LAYOUT.md had "Three removable DeepSeek Harness bundles" on line 25
    const layoutIssues = scanMarkdownText(
      "ROOT_LAYOUT.md",
      gitShow("e5a2848^:ROOT_LAYOUT.md"),
      { expectedBunVersion: "1.4.4" },
    );
    expect(layoutIssues.length).toBeGreaterThan(0);
    expect(layoutIssues[0]?.line).toBe(25);
    expect(layoutIssues[0]?.code).toBe(CODES.SCRIPT_BUNDLE_INVENTORY);
    expect(layoutIssues[0]?.match).toBe(
      "Three removable DeepSeek Harness bundles",
    );

    // 4. e5a2848^:docs/REMAINING_TASKS.md had "Record version: `bun-types` v1.4.3" on line 63
    const tasksIssues = scanMarkdownText(
      "docs/REMAINING_TASKS.md",
      gitShow("e5a2848^:docs/REMAINING_TASKS.md"),
      { expectedBunVersion: "1.4.4" },
    );
    expect(tasksIssues.length).toBe(1);
    expect(tasksIssues[0]?.line).toBe(63);
    expect(tasksIssues[0]?.code).toBe(CODES.BUN_VERSION_DRIFT);
  });
});

describe("check_docs_staleness — pattern accuracy & false-positive guards", () => {
  test("catches prose wallet variants ('23 valid Polymarket wallets' and '23 valid wallets')", () => {
    const doc = [
      "Poll 23 valid Polymarket wallets before staging the portal.",
      "Poll 23 valid wallets and publish to R2.",
      "Poll configured Polymarket wallets (23 valid) on schedule.",
    ].join("\n");
    const issues = scanMarkdownText("README.md", doc);
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3]);
    for (const issue of issues) {
      expect(issue.code).toBe(CODES.SNAPSHOT_ENTITY_INVENTORY);
    }
  });

  test("catches Harness and plugin bundle count variants", () => {
    const doc = [
      "Five removable DeepSeek Harness bundles live at the root.",
      "Three removable Harness bundles are installed.",
      "Runs all 5 dsh-plugin* bundles in CI.",
      "Verifies 5 plugin bundles on every push.",
    ].join("\n");
    const issues = scanMarkdownText("ROOT_LAYOUT.md", doc);
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3, 4]);
    for (const issue of issues) {
      expect(issue.code).toBe(CODES.SCRIPT_BUNDLE_INVENTORY);
    }
  });

  test("does not false-positive on test status counts ('0 test failures', '3 test flakes', '1 test regression', '2 test errors')", () => {
    const doc = [
      "Gate completed with 0 test failures and 0 test errors.",
      "Quarantined 3 test flakes and 1 test regression in the nightly run.",
    ].join("\n");
    const issues = scanMarkdownText("AGENTS.md", doc);
    expect(issues).toEqual([]);
  });

  test("does not false-positive on wire contracts, backticked literals, or non-header code fences", () => {
    const doc = [
      'Audit all Per-Office (`type="B"` `customerID=<Office>`) & Cross-Office (`customerID="0"`) clusters.',
      "Run the 4-Week Full-Customer CFB & NBA Parlay/Combo Backtest (`README.md:11-15`).",
      "| **JSON Serialization** (25 accounts) | `Response.json(data)` | 1.12 µs |",
      "```ts",
      "// 92 test files and 23 valid Polymarket wallets inside a TypeScript code block",
      "const count = 318; // test files",
      "```",
    ].join("\n");
    const issues = scanMarkdownText("README.md", doc);
    expect(issues).toEqual([]);
  });

  test("single-line <!-- staleness-ok: reason --> exempts only that line and not subsequent lines", () => {
    const doc = [
      "Suite has 64 assertions in the frozen spec. <!-- staleness-ok: fixed v5.4 spec table -->",
      "Suite has 92 test files in the directory.",
    ].join("\n");
    const issues = scanMarkdownText("README.md", doc);
    expect(issues.length).toBe(1);
    expect(issues[0]?.line).toBe(2);
    expect(issues[0]?.match).toBe("92 test files");
  });

  test("gracefully skips missing target files and distinguishes --warn (exit 0) from strict mode (exit 1)", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "docs-staleness-test-"));
    try {
      mkdirSync(join(tempRoot, "docs"), { recursive: true });
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ engines: { bun: "1.4.4" } }),
      );
      writeFileSync(
        join(tempRoot, "README.md"),
        "Lists the 200+ `package.json` scripts grouped by prefix.\n",
      );
      writeFileSync(
        join(tempRoot, "AGENTS.md"),
        "Clean operator instructions with derived counts.\n",
      );

      // Warn mode: reports "warn" on README.md, "pass" on AGENTS.md, "skip" on missing files, exit code 0
      const warnOutcomes = runStalenessChecks({
        root: tempRoot,
        warn: true,
        targets: DEFAULT_TARGETS,
      });
      expect(warnOutcomes.find((o) => o.target === "README.md")?.status).toBe(
        "warn",
      );
      expect(warnOutcomes.find((o) => o.target === "AGENTS.md")?.status).toBe(
        "pass",
      );
      expect(
        warnOutcomes.find((o) => o.target === "cli/README.md")?.status,
      ).toBe("skip");
      expect(
        warnOutcomes.find((o) => o.target === "docs/REMAINING_TASKS.md")
          ?.status,
      ).toBe("skip");
      expect(reportStalenessOutcomes(warnOutcomes, { warn: true })).toBe(0);

      // Strict mode: reports "fail" on README.md and returns exit code 1
      const strictOutcomes = runStalenessChecks({
        root: tempRoot,
        warn: false,
        targets: DEFAULT_TARGETS,
      });
      expect(strictOutcomes.find((o) => o.target === "README.md")?.status).toBe(
        "fail",
      );
      expect(reportStalenessOutcomes(strictOutcomes, { warn: false })).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("parseCliArgs parses --warn, --root, and repeatable --target flags", () => {
    const parsed = parseCliArgs([
      "--warn",
      "--root",
      "/tmp/example",
      "--target",
      "README.md",
      "--target",
      "AGENTS.md",
    ]);
    expect(typeof parsed).toBe("object");
    if (typeof parsed !== "string") {
      expect(parsed.warn).toBe(true);
      expect(parsed.root).toBe("/tmp/example");
      expect(parsed.targets).toEqual(["README.md", "AGENTS.md"]);
    }
    expect(typeof parseCliArgs(["--unknown"])).toBe("string");
  });
});
