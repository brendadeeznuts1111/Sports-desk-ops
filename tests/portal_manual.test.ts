import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The manual digest is a cross-reference: every repo surface it claims must exist, and the
 * provenance it asserts must be complete enough to detect a vendor update.
 */
describe("docs/portal-manual.md", () => {
  const root = resolve(import.meta.dir, "..");
  const digest = readFileSync(resolve(root, "docs/portal-manual.md"), "utf8");

  test("records provenance that can detect a manual update", () => {
    expect(digest).toContain("https://fantasy402.com/doc/FAQ.pdf");
    expect(digest).toContain("1.0.280");
    expect(digest).toMatch(/[a-f0-9]{64}/);
    expect(digest.toLowerCase()).toContain("sha-256");
    expect(digest).toContain("bun run manual:fetch");
  });

  test("covers all 13 documented questions", () => {
    for (let q = 1; q <= 13; q++) {
      // Table cells may be re-aligned by the formatter; match the cell, not the spacing.
      expect(digest).toMatch(new RegExp(`\\|\\s*${q}\\s*\\|`));
    }
  });

  test("does not claim the manual documents field shapes", () => {
    // The FAQ has no field dictionary; the digest must say so rather than implying coverage.
    expect(digest).toContain("not field dictionaries");
  });

  test("every repo surface it references exists", () => {
    const paths = new Set(
      [
        ...digest.matchAll(
          /`((?:lib|scripts|services|docs|tests)\/[A-Za-z0-9_./-]+)`/g,
        ),
      ].map((m) => m[1] as string),
    );
    expect(paths.size).toBeGreaterThan(0);
    for (const path of paths) {
      expect(existsSync(resolve(root, path))).toBe(true);
    }
  });

  test("every endpoint it references is real", () => {
    for (const path of digest.matchAll(/(GET|POST) `(\/api\/[a-z-]+)`/g)) {
      expect(path[2]).toMatch(/^\/api\//);
    }
    expect(digest).toContain("/api/game-admin");
  });

  test("keeps the read-only and password rules explicit", () => {
    expect(digest).toContain("never handles portal passwords");
    expect(digest).toContain("read-only against production");
    expect(digest).toContain("preGame");
  });

  test("ships the fetcher it tells operators to run", () => {
    expect(existsSync(resolve(root, "scripts/fetch_user_manual.ts"))).toBe(
      true,
    );
  });
});
