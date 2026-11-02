import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

describe("Fetch Security & URL Credentials Audit", () => {
  const repoRoot = resolve(import.meta.dir, "..");

  // Tracked files only: the untracked `.env` is a 1Password Environments FIFO, so reading it
  // blocks until 1Password answers and then pulls live secrets into the test output.
  function gitFiles(dir: string, ...flags: string[]): string[] {
    const { stdout } = Bun.spawnSync(["git", "ls-files", "-z", ...flags], {
      cwd: dir,
    });
    return stdout.toString().split("\0");
  }

  // A tracked file deleted in the working tree is still in the index; there is nothing to read.
  function getAllSourceFiles(dir: string): string[] {
    const deleted = new Set(gitFiles(dir, "--deleted"));
    return gitFiles(dir)
      .filter(
        (rel) =>
          !deleted.has(rel) &&
          ([".ts", ".sh", ".json", ".md", ".html", ".toml"].includes(
            extname(rel),
          ) ||
            basename(rel).startsWith(".env")),
      )
      .map((rel) => join(dir, rel));
  }

  test("test_assert_no_embedded_url_credentials_across_codebase", () => {
    const files = getAllSourceFiles(repoRoot).filter(
      (f) => !f.endsWith("fetch_url_credentials.test.ts"),
    );
    expect(files.length).toBeGreaterThan(15);

    // Regex matching http(s)://user:password@host embedded credentials
    const credentialUrlRegex = /https?:\/\/[a-zA-Z0-9_\-.]+:[^@\s/]+@/g;
    const violations: { file: string; line: number; match: string }[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      lines.forEach((lineText, idx) => {
        const matches = lineText.match(credentialUrlRegex);
        if (matches) {
          violations.push({
            file,
            line: idx + 1,
            match: matches[0],
          });
        }
      });
    }

    if (violations.length > 0) {
      console.error("Detected forbidden embedded URL credentials:", violations);
    }
    expect(violations.length).toBe(0);
  });

  test("test_assert_no_insecure_reject_unauthorized_false", () => {
    // Audit executable code files (.ts, .js, .mjs, .sh) and exclude this test file itself
    const files = getAllSourceFiles(repoRoot).filter(
      (f) =>
        !f.endsWith("fetch_url_credentials.test.ts") &&
        [".ts", ".js", ".mjs", ".sh"].includes(extname(f)),
    );
    const forbiddenPattern = new RegExp(
      "reject" + "Unauthorized\\s*:\\s*false",
      "g",
    );
    const violations: { file: string; line: number }[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      lines.forEach((lineText, idx) => {
        if (forbiddenPattern.test(lineText)) {
          violations.push({
            file,
            line: idx + 1,
          });
        }
      });
    }

    if (violations.length > 0) {
      console.error(
        "Detected forbidden rejectUnauthorized: false occurrences:",
        violations,
      );
    }
    expect(violations.length).toBe(0);
  });
});
