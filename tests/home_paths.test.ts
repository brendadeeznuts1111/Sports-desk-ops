import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOME_PATH_ALLOWLIST,
  HOME_PATH_PLACEHOLDER_USERS,
  findForeignHomePaths,
  findHomePaths,
  homePathNeedles,
  isHomePathAllowlisted,
  scanHomePaths,
} from "../lib/home_paths.ts";

/**
 * The needle is the operator's own `homedir()`, not a `/Users/<name>` pattern: a tracked file that
 * names *this* machine's home leaks the account and cannot resolve elsewhere, while a fixture using
 * `/Users/someone` or `/home/ci` is a deliberate placeholder and stays allowed.
 *
 * The tracked-tree case is the gate: it fails on any file that hardcodes the current home.
 */

const ROOT = join(import.meta.dir, "..");

describe("findHomePaths", () => {
  test("finds the operator home and leaves placeholders alone", () => {
    const hits = findHomePaths(
      "x.md",
      "see /Users/realperson/code and /Users/someone/code",
      "/Users/realperson",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      file: "x.md",
      line: 1,
      match: "/Users/realperson",
    });
  });

  test("reports one hit per line that contains the home", () => {
    const hits = findHomePaths(
      "x.md",
      "a\nb /home/me/x\nc /home/me/y",
      "/home/me",
    );
    expect(hits.map((hit) => hit.line)).toEqual([2, 3]);
  });

  test("matches the Windows spelling of the same home", () => {
    expect(homePathNeedles("C:/Users/realperson")).toContain(
      "C:\\Users\\realperson",
    );
    const hits = findHomePaths(
      "x.md",
      "C:\\Users\\realperson\\code",
      "C:/Users/realperson",
    );
    expect(hits).toHaveLength(1);
  });

  test("an empty home matches nothing rather than everything", () => {
    expect(findHomePaths("x.md", "/Users/x", "")).toEqual([]);
  });
});

describe("scanHomePaths", () => {
  test("splits allowlisted hits from violations and skips unreadable files", () => {
    const contents: Record<string, string | null> = {
      "config/wagers.json": "csvPath: /Users/me/x",
      "src/a.ts": "const p = '/Users/me/y';",
      "image.png": null,
    };
    const result = scanHomePaths(
      ["config/wagers.json", "src/a.ts", "image.png"],
      (file) => contents[file] ?? null,
      "/Users/me",
    );
    expect(result.scannedFiles).toBe(2);
    expect(result.violations.map((hit) => hit.file)).toEqual(["src/a.ts"]);
    expect(result.allowed.map((hit) => hit.file)).toEqual([
      "config/wagers.json",
    ]);
  });
});

describe("the tracked tree", () => {
  test("no tracked file hardcodes this operator's home", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(listed.exitCode).toBe(0);
    const files = listed.stdout
      .toString()
      .split("\0")
      .filter((file) => file.length > 0);

    const result = scanHomePaths(files, (file) => {
      try {
        const bytes = readFileSync(join(ROOT, file));
        if (bytes.length === 0 || bytes.length > 2_000_000) return null;
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    });

    // Guard against a vacuous pass: a broken listing or reader scans nothing.
    expect(result.scannedFiles).toBeGreaterThan(1_000);
    expect(result.violations).toEqual([]);
    // A real person's name in a fixture is a leak even though it resolves on their machine.
    expect(result.foreign).toEqual([]);
  });

  test("every allowlist entry states a reason and names a real file", async () => {
    for (const entry of HOME_PATH_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(await Bun.file(join(ROOT, entry.path)).exists()).toBe(true);
      expect(isHomePathAllowlisted(entry.path)).toBe(true);
    }
  });
});

describe("scripts/check_home_paths.ts", () => {
  const spawnCli = (root: string, home: string) =>
    Bun.spawnSync(
      ["bun", "run", "scripts/check_home_paths.ts", "--root", root],
      {
        cwd: ROOT,
        env: { ...Bun.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

  const tempRepo = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), "home-paths-"));
    const repo = join(dir, "repo");
    await mkdir(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(repo, name), body);
    }
    return { dir, repo };
  };

  test("catches a leak in an untracked file, not just a tracked one", async () => {
    // The tracked-only listing this gate started with is why a scratch line reached a commit once.
    const home = join(tmpdir(), "fake-operator-home");
    const { repo } = await tempRepo({
      "clean.ts": "export const value = 1;\n",
      "untracked.ts": `// ${home}/leak\n`,
    });

    const result = spawnCli(repo, home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("untracked.ts");
  });

  test("passes when no file names the operator home", async () => {
    const home = join(tmpdir(), "fake-operator-home");
    const { repo } = await tempRepo({
      "clean.ts": "export const value = 1;\n",
    });

    const result = spawnCli(repo, home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("ok —");
  });

  test("verify:fast runs the check on every invocation", async () => {
    const verifyFast = await Bun.file(
      join(ROOT, "scripts", "verify_fast.ts"),
    ).text();
    expect(verifyFast).toContain('"check:home-paths"');
    expect(verifyFast).toContain("scripts/check_home_paths.ts");
  });
});

describe("findForeignHomePaths", () => {
  const operator = "/Users/operator";
  // Built at runtime on purpose: a literal foreign name in this file would make the file itself a
  // violation, and the point is to prove the scanner catches one.
  const FOREIGN = ["bren", "da"].join("");

  test("flags another account's home", () => {
    const hits = findForeignHomePaths(
      "x.md",
      `rootDir: /Users/${FOREIGN}/secret-workspace`,
      operator,
    );
    expect(hits).toEqual([{ file: "x.md", line: 1, match: FOREIGN }]);
  });

  test("flags the Windows spelling too", () => {
    const hits = findForeignHomePaths(
      "x.md",
      `C:\\Users\\${FOREIGN}\\x`,
      operator,
    );
    expect(hits.map((hit) => hit.match)).toEqual([FOREIGN]);
  });

  test("allows every documented placeholder", () => {
    for (const name of HOME_PATH_PLACEHOLDER_USERS) {
      expect(
        findForeignHomePaths("x.md", `/Users/${name}/x`, operator),
      ).toEqual([]);
    }
  });

  test("ignores the operator's own home and prose ellipsis", () => {
    expect(findForeignHomePaths("x.md", "/Users/operator/x", operator)).toEqual(
      [],
    );
    expect(findForeignHomePaths("x.md", "/Users/... path", operator)).toEqual(
      [],
    );
  });
});
