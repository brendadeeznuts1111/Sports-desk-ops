import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lockWorkspaceNames, resolveWorkspaces } from "../lib/pm_policy.ts";

/** The oracle is the bun.lock that `bun install` writes for the fixture, not a hand-kept list. */
const scratch = mkdtempSync(path.join(tmpdir(), "pm-ws-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(
  name: string,
  workspaces: unknown,
  files: Record<string, object>,
): string {
  const root = path.join(scratch, name);
  const all = {
    "package.json": { name: `${name}-root`, private: true, workspaces },
    ...files,
  };
  for (const [rel, json] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), JSON.stringify(json));
  }
  // No global bunfig: the frozen machine policy would refuse to write a lock for a new project.
  const home = path.join(scratch, `${name}-home`);
  mkdirSync(home);
  const install = Bun.spawnSync([process.execPath, "install"], {
    cwd: root,
    env: { PATH: Bun.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(install.exitCode).toBe(0);
  return root;
}

describe("resolveWorkspaces agrees with the bun.lock Bun writes", () => {
  test("globs, ! patterns, nameless manifests and nested node_modules", async () => {
    const root = fixture("globs", ["packages/**", "!packages/**/test/**"], {
      "packages/a/package.json": { name: "a" },
      "packages/group/b/package.json": { name: "b" },
      "packages/group/test/t/package.json": { name: "excluded" },
      "packages/noname/package.json": { type: "module" },
      "packages/a/node_modules/dep/package.json": { name: "dep" },
    });
    const { expected, locked } = await lockWorkspaceNames(root);
    expect(locked).toEqual(expected);
    expect(Object.keys(expected).sort()).toEqual([
      "",
      "packages/a",
      "packages/group/b",
    ]);
    expect((await resolveWorkspaces(root)).nameless).toEqual([
      "packages/noname",
    ]);
  });

  test("a directory listed by its path survives a ! pattern", async () => {
    const root = fixture(
      "literal",
      ["packages/*/test/*", "!packages/**/test/**", "packages/a/test/kept"],
      {
        "packages/a/test/kept/package.json": { name: "kept" },
        "packages/a/test/other/package.json": { name: "other" },
      },
    );
    const { expected, locked } = await lockWorkspaceNames(root);
    expect(locked).toEqual(expected);
    expect(expected["packages/a/test/kept"]).toBe("kept");
    expect(expected["packages/a/test/other"]).toBeUndefined();
  });

  test("the object form of workspaces", async () => {
    const root = fixture(
      "object",
      { packages: ["apps/*", "packages/*"] },
      {
        "apps/web/package.json": { name: "web" },
        "packages/core/package.json": { name: "core" },
      },
    );
    const { expected, locked } = await lockWorkspaceNames(root);
    expect(locked).toEqual(expected);
    expect(Object.keys(expected)).toHaveLength(3);
  });
});
