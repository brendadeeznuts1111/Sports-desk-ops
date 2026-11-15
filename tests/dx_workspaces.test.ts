import { YAML } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_BUNX_MINIMUM_RELEASE_AGE_SECONDS,
  DEFAULT_PM_ENV_FILE_FLAG,
  normalizePackageManagerArgs,
  PM_FLAG_TRANSLATIONS,
  translatePackageManagerFlag,
} from "../lib/pm_policy.ts";
import { collectWorkspaceScriptCatalog } from "../scripts/dx_scripts.ts";
import {
  buildWorkspaceBunxPlan,
  buildWorkspaceGraphReport,
  buildWorkspaceListReport,
  buildWorkspaceMutationPlan,
  buildWorkspacePublishPlan,
  buildWorkspaceRunPlan,
  buildWorkspaceTypecheckPlan,
  linkWorkspaces,
  planWorkspaceInit,
  renderWorkspaceDot,
  renderWorkspaceMermaid,
  runWorkspaceAudit,
  runWorkspacesCli,
} from "../scripts/dx_workspaces.ts";

const ROOT = path.join(import.meta.dir, "..");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "dx-ws-"));

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("dx workspaces — monorepo workspace dev control", () => {
  test("lists root + packages/* workspaces with topological waves and isolated links", async () => {
    const report = await buildWorkspaceListReport(ROOT);
    expect(report.patterns).toEqual(["packages/*"]);
    expect(report.rows.map((r) => r.dir)).toEqual([
      ".",
      "packages/api",
      "packages/ba-example",
      "packages/backend",
      "packages/contracts",
      "packages/nsh-desk",
      "packages/sportsdesk-ops",
      "packages/ui",
    ]);
    const nshRow = report.rows.find((r) => r.dir === "packages/nsh-desk");
    expect(nshRow?.name).toBe("@sportsdesk-ops/nsh-desk");
    expect(nshRow?.version).toBe("0.2.0");
    expect(nshRow?.private).toBe(true);
    expect(nshRow?.wave).toBe(0);

    const rootRow = report.rows.find((r) => r.dir === ".");
    expect(rootRow?.wave).toBe(3);
    expect(rootRow?.workspaceDeps).toEqual([
      "sportsdesk-ops@workspace:packages/sportsdesk-ops",
      "@sportsdesk-ops/api@workspace:*",
      "@sportsdesk-ops/backend@workspace:*",
      "@sportsdesk-ops/contracts@workspace:*",
      "@sportsdesk-ops/ui@workspace:*",
    ]);
  });

  test("renders workspace dependency graph as Mermaid and Graphviz DOT", async () => {
    const graph = await buildWorkspaceGraphReport(ROOT);
    expect(graph.cycles).toEqual([]);
    const mermaid = renderWorkspaceMermaid(graph);
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain('subgraph wave_0["Wave 0"]');
    expect(mermaid).toContain("@sportsdesk-ops/nsh-desk v0.2.0");
    expect(mermaid).toContain('-->|"workspace:packages/sportsdesk-ops"|');

    const dot = renderWorkspaceDot(graph);
    expect(dot).toContain("digraph workspaces {");
    expect(dot).toContain(
      '"." -> "packages/sportsdesk-ops" [label="workspace:packages/sportsdesk-ops"];',
    );
  });

  test("passes the full workspace audit on the repository", async () => {
    const audit = await runWorkspaceAudit(ROOT);
    expect(audit.ok).toBe(true);
    expect(audit.checks.every((c) => c.status === "ok")).toBe(true);
  });

  test("normalizes sibling workspace names to workspace:* and disambiguates root-named packages", async () => {
    const emptyHome = mkdtempSync(path.join(SCRATCH, "home-"));
    const env = {
      PATH: Bun.env.PATH ?? "",
      HOME: emptyHome,
      XDG_CONFIG_HOME: emptyHome,
      // Hermetic install cache: Bun otherwise writes ~/.bun/install/cache, which the
      // sandbox denies and which makes these tests pollute the operator's real cache.
      BUN_INSTALL_CACHE_DIR: path.join(emptyHome, ".bun-cache"),
      DX_WORKSPACES_DIRECT_BUN: "1",
    };

    const siblingPlan = await buildWorkspaceMutationPlan(
      ROOT,
      "add",
      "ba-example",
      ["@sportsdesk-ops/nsh-desk", "zod@4.6.7"],
      { dev: true, env },
    );
    expect(siblingPlan.workspaceDir).toBe("packages/ba-example");
    expect(siblingPlan.cwd).toBe(path.join(ROOT, "packages/ba-example"));
    expect(siblingPlan.specs.map((s) => s.normalizedArg)).toEqual([
      "@sportsdesk-ops/nsh-desk@workspace:*",
      "zod@4.6.7",
    ]);
    expect(siblingPlan.specs[0]?.isWorkspaceLink).toBe(true);
    expect(siblingPlan.specs[1]?.isWorkspaceLink).toBe(false);

    // Root and packages/sportsdesk-ops share "name": "sportsdesk-ops", so linking to it uses workspace:packages/sportsdesk-ops
    const disambiguated = await buildWorkspaceMutationPlan(
      ROOT,
      "add",
      "ba-example",
      ["packages/sportsdesk-ops"],
      { env },
    );
    expect(disambiguated.specs[0]?.normalizedArg).toBe(
      "sportsdesk-ops@workspace:packages/sportsdesk-ops",
    );

    await expect(
      buildWorkspaceMutationPlan(ROOT, "add", "ba-example", ["ba-example"], {
        env,
      }),
    ).rejects.toThrow(/cannot add itself/);
  });

  test("scaffolds self-contained workspaces via init, links stuff-b -> stuff-a with workspace:*, rejects cycles, and executes topological waves", async () => {
    const mono = mkdtempSync(path.join(SCRATCH, "mono-"));
    const home = mkdtempSync(path.join(SCRATCH, "mono-home-"));
    const prevDirect = Bun.env.DX_WORKSPACES_DIRECT_BUN;
    const prevHome = Bun.env.HOME;
    const prevXdg = Bun.env.XDG_CONFIG_HOME;

    try {
      Bun.env.DX_WORKSPACES_DIRECT_BUN = "1";
      Bun.env.HOME = home;
      Bun.env.XDG_CONFIG_HOME = home;

      writeFileSync(
        path.join(mono, "package.json"),
        `${JSON.stringify(
          {
            name: "my-monorepo",
            private: true,
            workspaces: ["packages/*"],
            engines: { bun: Bun.version },
          },
          null,
          2,
        )}\n`,
      );

      // 1. Scaffold stuff-a and stuff-b using runWorkspacesCli(["init", ...])
      expect(
        await runWorkspacesCli(["init", "stuff-a", "--no-install"], mono),
      ).toBe(0);
      expect(
        await runWorkspacesCli(
          ["init", "stuff-b", "--with-tsconfig", "--no-install"],
          mono,
        ),
      ).toBe(0);

      // Add a build order marker script to prove Wave 0 runs before Wave 1
      const orderLog = path.join(mono, "wave-order.txt");
      const pkgA = (await Bun.file(
        path.join(mono, "packages/stuff-a/package.json"),
      ).json()) as Record<string, unknown>;
      pkgA.scripts = {
        stamp: `bun -e 'import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(orderLog)}, "stuff-a\\n");'`,
      };
      await Bun.write(
        path.join(mono, "packages/stuff-a/package.json"),
        `${JSON.stringify(pkgA, null, 2)}\n`,
      );

      const pkgB = (await Bun.file(
        path.join(mono, "packages/stuff-b/package.json"),
      ).json()) as Record<string, unknown>;
      pkgB.scripts = {
        stamp: `bun -e 'import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(orderLog)}, "stuff-b\\n");'`,
      };
      await Bun.write(
        path.join(mono, "packages/stuff-b/package.json"),
        `${JSON.stringify(pkgB, null, 2)}\n`,
      );

      // 2. Link stuff-b -> stuff-a via workspace:* and install from root
      const linkRes = await linkWorkspaces(mono, "stuff-b", "stuff-a", {
        env: {
          HOME: home,
          XDG_CONFIG_HOME: home,
          BUN_INSTALL_CACHE_DIR: path.join(home, ".bun-cache"),
          DX_WORKSPACES_DIRECT_BUN: "1",
        },
      });
      expect(linkRes.depName).toBe("stuff-a");
      expect(linkRes.specifier).toBe("workspace:*");

      // Write real import from stuff-b -> stuff-a
      mkdirSync(path.join(mono, "packages/stuff-b/src"), { recursive: true });
      writeFileSync(
        path.join(mono, "packages/stuff-b/src/index.ts"),
        'import { WORKSPACE_NAME } from "stuff-a";\nexport const FROM_A = WORKSPACE_NAME;\n',
      );

      // 3. Reject cycle stuff-a -> stuff-b before touching package.json
      await expect(
        linkWorkspaces(mono, "stuff-a", "stuff-b", {
          env: {
            HOME: home,
            XDG_CONFIG_HOME: home,
            BUN_INSTALL_CACHE_DIR: path.join(home, ".bun-cache"),
            DX_WORKSPACES_DIRECT_BUN: "1",
          },
        }),
      ).rejects.toThrow(/dependency cycle/);

      // 4. Verify strict zero-root-dep audit passes 100%
      const strictAudit = await runWorkspaceAudit(mono, { strictRoot: true });
      expect(strictAudit.ok).toBe(true);

      // 5. Verify topological run plan & execute waves in order (stuff-a before stuff-b)
      const topoPlan = await buildWorkspaceRunPlan(mono, "stamp", {
        topological: true,
      });
      expect(topoPlan.waves).toEqual([
        ["packages/stuff-a"],
        ["packages/stuff-b"],
      ]);
      expect(topoPlan.commands.length).toBe(2);

      expect(
        await runWorkspacesCli(["run", "--topological", "stamp"], mono),
      ).toBe(0);
      const stamps = (await Bun.file(orderLog).text()).trim().split("\n");
      expect(stamps).toEqual(["stuff-a", "stuff-b"]);

      // 6. Verify planWorkspaceInit scoped naming
      const scopedInit = await planWorkspaceInit(mono, "ui-tokens", {
        scoped: true,
      });
      expect(scopedInit.name).toBe("@my-monorepo/ui-tokens");
      expect(scopedInit.dir).toBe("packages/ui-tokens");
    } finally {
      if (prevDirect === undefined) delete Bun.env.DX_WORKSPACES_DIRECT_BUN;
      else Bun.env.DX_WORKSPACES_DIRECT_BUN = prevDirect;
      if (prevHome !== undefined) Bun.env.HOME = prevHome;
      if (prevXdg !== undefined) Bun.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  test("run delegates to one bun invocation (no custom scheduler)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dx-ws-plan-"));
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "root",
          private: true,
          workspaces: ["packages/*"],
        }),
      );
      for (const name of ["a", "b"]) {
        mkdirSync(path.join(dir, "packages", name), { recursive: true });
        writeFileSync(
          path.join(dir, "packages", name, "package.json"),
          JSON.stringify({
            name: `@x/${name}`,
            private: true,
            scripts: { stamp: "true" },
            // b depends on a, so topological mode has two waves.
            ...(name === "b"
              ? { dependencies: { "@x/a": "workspace:*" } }
              : {}),
          }),
        );
      }

      // No --topological: the whole run is one `bun run` process.
      const plan = await buildWorkspaceRunPlan(dir, "stamp", {});
      expect(plan.commands).toHaveLength(1);
      const argv = plan.commands[0]!.argv;
      expect(argv.slice(1, 4)).toEqual(["--no-orphans", "run", "--parallel"]);
      expect(argv).toContain("--elide-lines=10");
      expect(argv).toContain("--if-present");
      expect(argv).toContain("--workspaces");
      expect(argv.at(-1)).toBe("stamp");

      // A filter replaces --workspaces with --filter=..., still one process.
      const filtered = await buildWorkspaceRunPlan(dir, "stamp", {
        filters: ["@x/a"],
      });
      expect(filtered.commands).toHaveLength(1);
      expect(filtered.commands[0]!.argv).toContain("--filter=@x/a");
      expect(filtered.commands[0]!.argv).not.toContain("--workspaces");

      // Topological is the only path that emits more than one command.
      const topo = await buildWorkspaceRunPlan(dir, "stamp", {
        topological: true,
      });
      expect(topo.commands.length).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("audit fails when a root catalog pin drifts from bun.lock", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dx-ws-catalog-"));
    const rootManifest = (catalog: Record<string, string>) =>
      JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
        catalog,
      });
    try {
      mkdirSync(path.join(dir, "packages", "a"), { recursive: true });
      writeFileSync(
        path.join(dir, "packages", "a", "package.json"),
        JSON.stringify({
          name: "@x/a",
          private: true,
          dependencies: { react: "catalog:" },
        }),
      );
      writeFileSync(
        path.join(dir, "package.json"),
        rootManifest({ react: "18.3.1" }),
      );
      writeFileSync(
        path.join(dir, "bun.lock"),
        JSON.stringify({
          lockfileVersion: 2,
          workspaces: {},
          catalog: { react: "18.3.1" },
          packages: {},
        }),
      );

      const synced = await runWorkspaceAudit(dir);
      const syncedCheck = synced.checks.find(
        (c) => c.name === "catalog <-> lock sync",
      );
      expect(syncedCheck?.status).toBe("ok");
      expect(syncedCheck?.detail).toContain("1 catalog entr");

      // Edit the pin without running bun install: the lock copy is now stale.
      writeFileSync(
        path.join(dir, "package.json"),
        rootManifest({ react: "19.0.0" }),
      );
      const drifted = await runWorkspaceAudit(dir);
      const driftCheck = drifted.checks.find(
        (c) => c.name === "catalog <-> lock sync",
      );
      expect(driftCheck?.status).toBe("fail");
      expect(driftCheck?.detail).toContain("catalog.react");
      expect(driftCheck?.detail).toContain("19.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every flag the run plan emits is supported by the installed bun", () => {
    const help = Bun.spawnSync(["bun", "run", "--help"], {
      stdout: "pipe",
    }).stdout.toString();
    for (const flag of [
      "--no-orphans",
      "--parallel",
      "--sequential",
      "--no-exit-on-error",
      "--if-present",
      "--workspaces",
      "--filter",
      "--elide-lines",
    ]) {
      expect(help).toContain(flag);
    }
  });

  test("dx scripts --workspaces and ./bin/dx workspaces --yaml emit valid structured catalogs", async () => {
    const wsScripts = await collectWorkspaceScriptCatalog(ROOT, "doctor");
    expect(
      wsScripts.some(
        (r) => r.dir === "packages/nsh-desk" && r.script === "doctor",
      ),
    ).toBe(true);

    const proc = Bun.spawnSync(
      [path.join(ROOT, "bin/dx"), "workspaces", "list", "--yaml"],
      {
        cwd: ROOT,
        env: { ...Bun.env, DX_STATUS_OFFLINE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(0);
    const parsed = YAML.parse(proc.stdout.toString()) as {
      count?: number;
      patterns?: string[];
    };
    expect(parsed.count).toBe(8);
    expect(parsed.patterns).toEqual(["packages/*"]);
  });

  test("enforces --no-env-file default, translates npm/Yarn/pnpm flags, and builds publish & bunx plans", async () => {
    expect(DEFAULT_PM_ENV_FILE_FLAG).toBe("--no-env-file");
    expect(DEFAULT_BUNX_MINIMUM_RELEASE_AGE_SECONDS).toBe(259_200);
    expect(translatePackageManagerFlag("--immutable")).toBe(
      "--frozen-lockfile",
    );
    expect(translatePackageManagerFlag("--package-lock-only")).toBe(
      "--lockfile-only",
    );
    expect(translatePackageManagerFlag("--save-dev")).toBe("--dev");
    expect(translatePackageManagerFlag("--save-exact")).toBe("--exact");
    expect(translatePackageManagerFlag("--save-optional")).toBe("--optional");
    expect(translatePackageManagerFlag("--save-peer")).toBe("--peer");
    expect(translatePackageManagerFlag("--save-catalog")).toBe("--catalog");
    expect(translatePackageManagerFlag("--no-optional")).toBe(
      "--omit=optional",
    );
    expect(translatePackageManagerFlag("--ignore-optional")).toBe(
      "--omit=optional",
    );
    expect(translatePackageManagerFlag("--only=production")).toBe("--omit=dev");
    expect(translatePackageManagerFlag("--location=global")).toBe("--global");
    expect(translatePackageManagerFlag("--shamefully-hoist")).toBe(
      "--linker=hoisted",
    );
    expect(translatePackageManagerFlag("--node-linker=hoisted")).toBe(
      "--linker=hoisted",
    );
    expect(translatePackageManagerFlag("--install-strategy=hoisted")).toBe(
      "--linker=hoisted",
    );
    expect(translatePackageManagerFlag("--node-linker=isolated")).toBe(
      "--linker=isolated",
    );
    expect(translatePackageManagerFlag("--install-strategy=linked")).toBe(
      "--linker=isolated",
    );
    expect(Object.keys(PM_FLAG_TRANSLATIONS).length).toBe(16);

    expect(
      normalizePackageManagerArgs(["--immutable", "--only=production"]),
    ).toEqual(["--no-env-file", "--frozen-lockfile", "--omit=dev"]);
    expect(
      normalizePackageManagerArgs(["--env-file=.env.ci", "--save-dev", "zod"]),
    ).toEqual(["--env-file=.env.ci", "--dev", "zod"]);

    const pubPlan = buildWorkspacePublishPlan(ROOT, {
      bunPath: "/usr/local/bin/bun",
      dryRun: true,
    });
    expect(pubPlan.argv).toEqual([
      "/usr/local/bin/bun",
      "publish",
      "--no-env-file",
      "--recursive",
      "--quiet",
      "--dry-run",
    ]);

    const bunxPlan = await buildWorkspaceBunxPlan(
      ROOT,
      "ui",
      "oxlint",
      ["--version"],
      {
        bunxPath: "/usr/local/bin/bunx",
        trust: true,
      },
    );
    expect(bunxPlan.workspaceDir).toBe("packages/ui");
    expect(bunxPlan.minimumReleaseAgeSeconds).toBe(259_200);
    expect(bunxPlan.trust).toBe(true);
    expect(bunxPlan.argv).toEqual([
      "/usr/local/bin/bunx",
      "--cwd",
      path.join(ROOT, "packages/ui"),
      "--minimum-release-age=259200",
      "--bun",
      "--trust",
      "oxlint",
      "--version",
    ]);

    expect(
      await runWorkspacesCli(
        [
          "add",
          "ba-example",
          "zod",
          "--save-dev",
          "--save-exact",
          "--save-catalog",
          "--dry-run",
        ],
        ROOT,
      ),
    ).toBe(0);
    expect(
      await runWorkspacesCli(["publish", "--dry-run", "--json"], ROOT),
    ).toBe(0);
    expect(
      await runWorkspacesCli(
        ["x", "ui", "oxlint", "--version", "--dry-run"],
        ROOT,
      ),
    ).toBe(0);

    const tcPlan = buildWorkspaceTypecheckPlan(ROOT, {
      bunPath: "/usr/local/bin/bun",
      timing: true,
    });
    expect(tcPlan.argv).toEqual([
      "/usr/local/bin/bun",
      "check",
      "--no-script",
      "-b",
      "-p",
      "tsconfig.workspaces.json",
      "--timing",
    ]);
    expect(await runWorkspacesCli(["typecheck", "--timing"], ROOT)).toBe(0);
  });
});
