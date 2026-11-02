import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";

describe("Fetch Security & URL Credentials Audit", () => {
  const repoRoot = resolve(import.meta.dir, "..");

  function getAllSourceFiles(dir: string, fileList: string[] = []): string[] {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (
        entry === ".git" ||
        entry === "node_modules" ||
        entry === ".DS_Store" ||
        // Local audit artifacts / detached worktrees are gitignored evidence,
        // not shipped source. `.gitignore` lists `scratch/`, and the working tree can spell
        // it `Scratch` (case-insensitive macOS volumes), so compare case-insensitively —
        // otherwise the walk enters a live WebView profile and follows dangling symlinks.
        entry.toLowerCase() === "scratch" ||
        entry === "reports" ||
        entry === "dist" ||
        entry === ".worktrees"
      ) {
        continue;
      }
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        getAllSourceFiles(fullPath, fileList);
      } else {
        const ext = extname(entry);
        if (
          [".ts", ".sh", ".json", ".md", ".html", ".toml"].includes(ext) ||
          entry.startsWith(".env")
        ) {
          fileList.push(fullPath);
        }
      }
    }
    return fileList;
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
