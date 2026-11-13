import { YAML } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectWorkspaceScriptCatalog } from "../scripts/dx_scripts.ts";
import {
  buildWorkspaceGraphReport,
  buildWorkspaceListReport,
  buildWorkspaceMutationPlan,
  buildWorkspaceRunPlan,
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

  test("passes full 7-check workspace audit on the repository", async () => {
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
});
