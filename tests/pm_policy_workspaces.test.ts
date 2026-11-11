import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analyzeWorkspaceGraph,
  auditRootWorkspaceHygiene,
  auditWorkspaceSelfContainment,
  inspectWorkspaceInstallLayout,
  inspectWorkspaces,
  lockWorkspaceDependencies,
  lockWorkspaceNames,
  lockWorkspaceVersions,
  resolveWorkspaces,
} from "../lib/pm_policy.ts";

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

  test("a workspace outside the root directory", async () => {
    const root = fixture("outside", ["packages/*", "../outside-shared"], {
      "packages/a/package.json": { name: "a" },
      "../outside-shared/package.json": { name: "shared" },
    });
    const { expected, locked } = await lockWorkspaceNames(root);
    expect(locked).toEqual(expected);
    expect(expected["../outside-shared"]).toBe("shared");
  });

  test("workspace versions, including a workspace without one", async () => {
    const root = fixture("versions", ["packages/*"], {
      "package.json": {
        name: "versions-root",
        version: "9.9.9",
        private: true,
        workspaces: ["packages/*"],
      },
      "packages/a/package.json": { name: "a", version: "1.2.3" },
      "packages/b/package.json": { name: "b" },
    });
    const { expected, locked } = await lockWorkspaceVersions(root);
    expect(locked).toEqual(expected);
    expect(expected["packages/a"]).toBe("1.2.3");
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

  test("pure zero-root-dep monorepo with stuff-a and stuff-b (workspace:*) links cleanly", async () => {
    const root = fixture("pure-monorepo", ["packages/*"], {
      "package.json": {
        name: "my-monorepo",
        private: true,
        workspaces: ["packages/*"],
      },
      "packages/stuff-a/package.json": {
        name: "stuff-a",
        version: "1.0.0",
        private: true,
        main: "./index.ts",
      },
      "packages/stuff-b/package.json": {
        name: "stuff-b",
        version: "1.0.0",
        private: true,
        dependencies: {
          "stuff-a": "workspace:*",
        },
      },
    });
    writeFileSync(
      path.join(root, "packages/stuff-a/index.ts"),
      "export const STUFF_A = 42;\n",
    );
    writeFileSync(
      path.join(root, "packages/stuff-b/index.ts"),
      'import { STUFF_A } from "stuff-a";\nexport const STUFF_B = STUFF_A + 1;\n',
    );

    const hygiene = await auditRootWorkspaceHygiene(root, {
      strictZeroRootDeps: true,
    });
    expect(hygiene.ok).toBe(true);
    expect(hygiene.externalDeps).toEqual([]);
    expect(hygiene.externalDevDeps).toEqual([]);

    const inspection = await inspectWorkspaces(root);
    expect(inspection.unregisteredDirs).toEqual([]);
    const graph = analyzeWorkspaceGraph(inspection);
    expect(graph.issues).toEqual([]);
    expect(graph.waves).toEqual([["packages/stuff-a"], ["packages/stuff-b"]]);

    const depSync = await lockWorkspaceDependencies(root);
    expect(depSync.drift).toEqual([]);

    const containment = await auditWorkspaceSelfContainment(root);
    expect(containment.undeclaredImports).toEqual([]);

    const layout = await inspectWorkspaceInstallLayout(root);
    const stuffBLinks = layout.workspaceLinks.find(
      (w) => w.dir === "packages/stuff-b",
    );
    expect(stuffBLinks?.presentLinks).toEqual(["stuff-a"]);
    expect(stuffBLinks?.missingLinks).toEqual([]);
    expect(stuffBLinks?.brokenLinks).toEqual([]);
  });

  test("workspace graph & self-containment gates catch unregistered dirs, cycles, unlinked local deps, and undeclared imports", async () => {
    const root = path.join(scratch, "negative-cases");
    mkdirSync(path.join(root, "packages/alpha"), { recursive: true });
    mkdirSync(path.join(root, "packages/beta"), { recursive: true });
    mkdirSync(path.join(root, "packages/orphan"), { recursive: true });

    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "bad-monorepo",
        private: false,
        workspaces: ["packages/*"],
        dependencies: { zod: "4.6.7" },
      }),
    );
    writeFileSync(
      path.join(root, "packages/alpha/package.json"),
      JSON.stringify({
        name: "alpha",
        version: "1.0.0",
        dependencies: {
          beta: "workspace:*",
          missing_ws: "workspace:*",
        },
      }),
    );
    writeFileSync(
      path.join(root, "packages/beta/package.json"),
      JSON.stringify({
        name: "beta",
        version: "1.0.0",
        dependencies: {
          alpha: "workspace:*",
        },
      }),
    );
    writeFileSync(
      path.join(root, "packages/beta/index.ts"),
      'import { z } from "zod";\nexport const schema = z.string();\n',
    );
    writeFileSync(
      path.join(root, "packages/orphan/index.ts"),
      "export const ORPHAN = true;\n",
    );

    const hygiene = await auditRootWorkspaceHygiene(root, {
      strictZeroRootDeps: true,
    });
    expect(hygiene.rootPrivate).toBe(false);
    expect(hygiene.ok).toBe(false);

    const inspection = await inspectWorkspaces(root);
    expect(inspection.unregisteredDirs).toEqual(["packages/orphan"]);

    const graph = analyzeWorkspaceGraph(inspection);
    const issueKinds = graph.issues.map((i) => i.kind);
    expect(issueKinds).toContain("missing-target");
    expect(issueKinds).toContain("cycle");
    expect(graph.cycles).toEqual([["packages/alpha", "packages/beta"]]);

    const containment = await auditWorkspaceSelfContainment(root);
    expect(containment.undeclaredImports).toEqual([
      {
        dir: "packages/beta",
        file: "packages/beta/index.ts",
        specifier: "zod",
        packageName: "zod",
      },
    ]);
  });
});
