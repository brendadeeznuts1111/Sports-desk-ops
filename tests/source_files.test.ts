import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSourceFiles } from "../lib/source_files.ts";

const roots: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "source-files-"));
  roots.push(root);
  for (const [file, body] of Object.entries(files)) {
    await Bun.write(path.join(root, file), body);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("listSourceFiles", () => {
  test("in a git work tree, gitignored files are not listed", async () => {
    const root = await fixture({
      ".gitignore": "Scratch/\ndist/\n",
      "lib/a.ts": "",
      "lib/untracked.ts": "",
      "Scratch/x.ts": "",
      "dist/y.js": "",
    });
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", root, "add", "lib/a.ts"]).exitCode).toBe(
      0,
    );

    expect(await listSourceFiles(root, ["ts", "js"])).toEqual([
      "lib/a.ts",
      "lib/untracked.ts",
    ]);
  });

  test("a tracked file deleted from disk is not listed", async () => {
    const root = await fixture({ "lib/a.ts": "", "lib/gone.ts": "" });
    Bun.spawnSync(["git", "init", "-q", root]);
    Bun.spawnSync(["git", "-C", root, "add", "."]);
    await rm(path.join(root, "lib/gone.ts"));

    expect(await listSourceFiles(root, ["ts"])).toEqual(["lib/a.ts"]);
  });

  test("outside a git work tree, every matching file is listed", async () => {
    const root = await fixture({
      "lib/a.ts": "",
      "Scratch/x.ts": "",
      "notes.md": "",
    });
    expect(await listSourceFiles(root, ["ts"])).toEqual([
      "Scratch/x.ts",
      "lib/a.ts",
    ]);
  });

  test("byte-pinned oracle bundles and node_modules are always skipped", async () => {
    const root = await fixture({
      "lib/a.js": "",
      "verification/manager-boot-oracle/pinned/security.js": "",
      "node_modules/dep/index.js": "",
    });
    expect(await listSourceFiles(root, ["js"])).toEqual(["lib/a.js"]);
  });
});
