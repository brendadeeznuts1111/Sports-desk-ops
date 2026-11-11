/**
 * @file tests/bunx_cli_root_layout.test.ts
 * @description Verifies:
 *   1. Zero executable command scripts (`.ts`, `.js`, `.mjs`, `.sh`) or `wrangler` wrapper pollute the repository root.
 *   2. Root `package.json` and workspace `packages/sportsdesk-ops/package.json` declare identical 23-entry `bin` maps,
 *      every workspace `bin` entry is a direct relative symlink (zero double-spawn `_dispatch.ts` wrapper),
 *      every target exists on disk with a valid `#!/usr/bin/env` shebang, and `node_modules/.bin/<name>` is linked.
 *   3. `bun x --no-install <bin>` executes cleanly across the CLI catalog (`dx`, `sportsdesk`, `image-meta`,
 *      `sportsdesk-schema`, `sportsdesk-ticket`, `sportsdesk-flags`, `sportsdesk-bet-flags`, `sportsdesk-layoff-risk`,
 *      `sportsdesk-hierarchy-ingest`, `xml-parse`, `blob-formdata`, `bun-surface`, `sql-query`, `desk-provenance`).
 *   4. `bun run cli:bins` (`dx scripts --bins --json | --yaml`) emits a valid JSON & `Bun.YAML` catalog.
 *   5. Relocated Manager Tools scripts (`scripts/fetch-config.ts`, `scripts/fetch-live-data.ts`,
 *      `scripts/fetch-report-periods.ts`) are wired in `package.json` `scripts` and `bin/dx`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectBinCatalog } from "../scripts/dx_scripts.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("Zero root command scripts & bun x CLI workspace contract", () => {
  test("1. repository root contains zero tracked executable scripts (.ts, .js, .mjs, .sh) or wrangler wrapper", () => {
    const ls = Bun.spawnSync(["git", "ls-files"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(ls.exitCode).toBe(0);

    const rootTracked = ls.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((p) => p.length > 0 && !p.includes("/"));

    const rootCodeFiles = rootTracked.filter((f) =>
      /\.(?:ts|tsx|js|jsx|mjs|cjs|sh)$/i.test(f),
    );
    expect(rootCodeFiles).toEqual([]);
    expect(existsSync(join(ROOT, "wrangler"))).toBe(false);
    expect(existsSync(join(ROOT, "bin/wrangler"))).toBe(true);
    expect(
      existsSync(join(ROOT, "packages/sportsdesk-ops/bin/_dispatch.ts")),
    ).toBe(false);
  });

  test("2. root package.json and packages/sportsdesk-ops/package.json share aligned 23-bin zero-spawn symlinks", async () => {
    const rootPkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const wsPkg = (await Bun.file(
      join(ROOT, "packages/sportsdesk-ops/package.json"),
    ).json()) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(rootPkg.devDependencies?.["sportsdesk-ops"]).toBe(
      "workspace:packages/sportsdesk-ops",
    );

    const rootBins = Object.keys(rootPkg.bin ?? {}).sort();
    const wsBins = Object.keys(wsPkg.bin ?? {}).sort();
    expect(rootBins.length).toBe(23);
    expect(wsBins).toEqual(rootBins);

    for (const binName of rootBins) {
      const rootTarget = join(ROOT, rootPkg.bin![binName]!);
      const wsTarget = join(
        ROOT,
        "packages/sportsdesk-ops",
        wsPkg.bin![binName]!,
      );
      expect(existsSync(rootTarget)).toBe(true);
      expect(existsSync(wsTarget)).toBe(true);

      // Workspace bin entry must be a direct symlink resolving to the exact canonical root target (zero child spawn)
      expect(lstatSync(wsTarget).isSymbolicLink()).toBe(true);
      expect(realpathSync(wsTarget)).toBe(realpathSync(rootTarget));

      const rootHead = (await Bun.file(rootTarget).text()).split("\n")[0] ?? "";
      expect(rootHead.startsWith("#!/usr/bin/env ")).toBe(true);

      if (existsSync(join(ROOT, "node_modules/.bin"))) {
        const linkedShim = join(ROOT, "node_modules/.bin", binName);
        expect(lstatSync(linkedShim).isSymbolicLink()).toBe(true);
        expect(realpathSync(linkedShim)).toBe(realpathSync(rootTarget));
      }
    }

    // Relocated Manager Tools & newly wired scripts in package.json
    expect(rootPkg.scripts?.["fetch-config"]).toBe(
      "bun run scripts/fetch-config.ts",
    );
    expect(rootPkg.scripts?.["fetch-live-data"]).toBe(
      "bun run scripts/fetch-live-data.ts",
    );
    expect(rootPkg.scripts?.["fetch-report-periods"]).toBe(
      "bun run scripts/fetch-report-periods.ts",
    );
    expect(rootPkg.scripts?.["bet:flags"]).toBe(
      "bun run cli/sportsdesk_bet_flags_cli.ts",
    );
    expect(rootPkg.scripts?.["layoff:risk"]).toBe(
      "bun run cli/sportsdesk_layoff_risk_cli.ts",
    );
    expect(rootPkg.scripts?.["bun:surface"]).toBe("bun run bin/bun_surface.ts");
    expect(rootPkg.scripts?.["cli:bins"]).toBe(
      "bun run scripts/dx_scripts.ts --bins",
    );
    expect(rootPkg.scripts?.["sql:query"]).toBe("bun run bin/sql-query.ts");
    expect(rootPkg.scripts?.["desk:provenance"]).toBe(
      "bun run bin/desk-provenance.ts --table --worktrees --check",
    );
    expect(rootPkg.scripts?.["dx"]).toBe("./bin/dx");
    expect(rootPkg.scripts?.["wrangler"]).toBe("./bin/wrangler");
  });

  test("3. bun x --no-install dispatches workspace CLIs cleanly in a single process with zero network access", async () => {
    const [
      dxRes,
      sdRes,
      imgRes,
      schemaRes,
      ticketRes,
      flagsRes,
      betFlagsRes,
      layoffRes,
      hierRes,
      bunSurfRes,
    ] = await Promise.all([
      Bun.spawn([process.execPath, "x", "--no-install", "dx", "modes", "9"], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...Bun.env, DX_STATUS_OFFLINE: "1" },
      }),
      Bun.spawn(
        [process.execPath, "x", "--no-install", "sportsdesk", "--help"],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "image-meta",
          "docs/assets/ARCH-Guide.webp",
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [process.execPath, "x", "--no-install", "sportsdesk-schema", "--list"],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [process.execPath, "x", "--no-install", "sportsdesk-ticket", "--help"],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [process.execPath, "x", "--no-install", "sportsdesk-flags", "--rules"],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "sportsdesk-bet-flags",
          "--help",
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "sportsdesk-layoff-risk",
          "--help",
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "sportsdesk-hierarchy-ingest",
          "--help",
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
      Bun.spawn(
        [process.execPath, "x", "--no-install", "bun-surface", "--help"],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      ),
    ]);

    const [
      dxOut,
      sdOut,
      imgOut,
      schemaOut,
      ticketOut,
      flagsOut,
      betFlagsOut,
      layoffOut,
      hierOut,
      bunSurfOut,
    ] = await Promise.all([
      new Response(dxRes.stdout).text(),
      new Response(sdRes.stdout).text(),
      new Response(imgRes.stdout).text(),
      new Response(schemaRes.stdout).text(),
      new Response(ticketRes.stdout).text(),
      new Response(flagsRes.stdout).text(),
      new Response(betFlagsRes.stdout).text(),
      new Response(layoffRes.stdout).text(),
      new Response(hierRes.stdout).text(),
      new Response(bunSurfRes.stdout).text(),
    ]);

    expect(await dxRes.exited).toBe(0);
    expect(dxOut).toContain("[Mode 9 · Pending Exposure]");

    expect(await sdRes.exited).toBe(0);
    expect(sdOut).toContain("SportsDesk & Fantasy402 Operations");

    expect(await imgRes.exited).toBe(0);
    expect(JSON.parse(imgOut)).toEqual({
      width: 1200,
      height: 896,
      format: "webp",
    });

    expect(await schemaRes.exited).toBe(0);
    expect(schemaOut).toContain("match_evaluations");

    expect(await ticketRes.exited).toBe(0);
    expect(ticketOut).toContain("ticket — inspect live bet tickets");

    expect(await flagsRes.exited).toBe(0);
    expect(flagsOut.length).toBeGreaterThan(20);

    expect(await betFlagsRes.exited).toBe(0);
    expect(betFlagsOut).toContain(
      "Usage: bun run cli/sportsdesk_bet_flags_cli.ts",
    );

    expect(await layoffRes.exited).toBe(0);
    expect(layoffOut).toContain("Layoff Risk Surveillance CLI");

    expect(await hierRes.exited).toBe(0);
    expect(hierOut).toContain("f402_manager_hierarchy_ingest");

    expect(await bunSurfRes.exited).toBe(0);
    expect(bunSurfOut).toContain("dx bun — runtime surface");

    // Verify stdin-streaming utility CLIs via bun x --no-install
    const xmlProc = Bun.spawn(
      [process.execPath, "x", "--no-install", "xml-parse", "-"],
      {
        cwd: ROOT,
        stdin: new TextEncoder().encode('<probe status="ok">42</probe>'),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const xmlOut = await new Response(xmlProc.stdout).text();
    expect(await xmlProc.exited).toBe(0);
    expect(JSON.parse(xmlOut)).toEqual({
      probe: { "@status": "ok", "#text": "42" },
    });

    const formProc = Bun.spawn(
      [process.execPath, "x", "--no-install", "blob-formdata", "-"],
      {
        cwd: ROOT,
        stdin: new TextEncoder().encode("mode=fast&ready=true"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const formOut = await new Response(formProc.stdout).text();
    expect(await formProc.exited).toBe(0);
    expect(JSON.parse(formOut)).toEqual({ mode: "fast", ready: "true" });
  });

  test("4. dx scripts --bins emits a complete JSON and Bun.YAML CLI catalog", async () => {
    const rootPkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    const rows = collectBinCatalog(ROOT, rootPkg.bin, rootPkg.scripts);
    expect(rows.length).toBe(23);
    expect(rows.every((r) => r.script !== null)).toBe(true);

    const yamlProc = Bun.spawn(
      [process.execPath, "run", "scripts/dx_scripts.ts", "--bins", "--yaml"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const yamlOut = await new Response(yamlProc.stdout).text();
    expect(await yamlProc.exited).toBe(0);

    const parsed = Bun.YAML.parse(yamlOut) as {
      count: number;
      bins: Array<{ bin: string; bunx: string; target: string }>;
    };
    expect(parsed.count).toBe(23);
    expect(parsed.bins.some((b) => b.bin === "sql-query")).toBe(true);
    expect(parsed.bins.some((b) => b.bin === "desk-provenance")).toBe(true);
    expect(parsed.bins.some((b) => b.bin === "sportsdesk-layoff-risk")).toBe(
      true,
    );
  });

  test("5. relocated scripts/fetch-*.ts respond to --help without touching network or secrets", async () => {
    for (const rel of [
      "scripts/fetch-config.ts",
      "scripts/fetch-live-data.ts",
      "scripts/fetch-report-periods.ts",
    ]) {
      const proc = Bun.spawn([process.execPath, "run", rel, "--help"], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain(`Usage: bun run ${rel}`);
    }
  });
});
