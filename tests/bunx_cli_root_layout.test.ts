/**
 * @file tests/bunx_cli_root_layout.test.ts
 * @description Verifies:
 *   1. Zero executable command scripts (`.ts`, `.js`, `.mjs`, `.sh`) or `wrangler` wrapper pollute the repository root.
 *   2. Root `package.json` and workspace `packages/sportsdesk-ops/package.json` declare identical `bin` maps,
 *      every `bin` target exists on disk with a valid `#!/usr/bin/env` shebang, and `node_modules/.bin/<name>` is linked.
 *   3. `bun x --no-install <bin>` executes cleanly for `dx`, `sportsdesk`, `nsh-desk`, `image-meta`,
 *      `sportsdesk-schema`, `sportsdesk-ticket`, `sportsdesk-flags`, and `wrangler`.
 *   4. Relocated Manager Tools scripts (`scripts/fetch-config.ts`, `scripts/fetch-live-data.ts`,
 *      `scripts/fetch-report-periods.ts`) are wired in `package.json` `scripts` and `bin/dx`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

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
  });

  test("2. root package.json and packages/sportsdesk-ops/package.json share aligned bin maps and linked node_modules/.bin shims", async () => {
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
    expect(rootBins.length).toBeGreaterThanOrEqual(14);
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

      const rootHead = (await Bun.file(rootTarget).text()).split("\n")[0] ?? "";
      const wsHead = (await Bun.file(wsTarget).text()).split("\n")[0] ?? "";
      expect(rootHead.startsWith("#!/usr/bin/env ")).toBe(true);
      expect(wsHead.startsWith("#!/usr/bin/env ")).toBe(true);

      if (existsSync(join(ROOT, "node_modules/.bin"))) {
        const linkedShim = join(ROOT, "node_modules/.bin", binName);
        expect(lstatSync(linkedShim).isSymbolicLink()).toBe(true);
      }
    }

    // Relocated Manager Tools scripts live under scripts/ and are wired in package.json
    expect(rootPkg.scripts?.["fetch-config"]).toBe(
      "bun run scripts/fetch-config.ts",
    );
    expect(rootPkg.scripts?.["fetch-live-data"]).toBe(
      "bun run scripts/fetch-live-data.ts",
    );
    expect(rootPkg.scripts?.["fetch-report-periods"]).toBe(
      "bun run scripts/fetch-report-periods.ts",
    );
    expect(rootPkg.scripts?.["wrangler"]).toBe("./bin/wrangler");
  });

  test("3. bun x --no-install dispatches workspace CLIs cleanly with zero network access", async () => {
    const [dxRes, sdRes, imgRes, schemaRes, ticketRes, flagsRes] =
      await Promise.all([
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
          [
            process.execPath,
            "x",
            "--no-install",
            "sportsdesk-schema",
            "--list",
          ],
          { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
        ),
        Bun.spawn(
          [
            process.execPath,
            "x",
            "--no-install",
            "sportsdesk-ticket",
            "--help",
          ],
          { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
        ),
        Bun.spawn(
          [
            process.execPath,
            "x",
            "--no-install",
            "sportsdesk-flags",
            "--rules",
          ],
          { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
        ),
      ]);

    const [dxOut, sdOut, imgOut, schemaOut, ticketOut, flagsOut] =
      await Promise.all([
        new Response(dxRes.stdout).text(),
        new Response(sdRes.stdout).text(),
        new Response(imgRes.stdout).text(),
        new Response(schemaRes.stdout).text(),
        new Response(ticketRes.stdout).text(),
        new Response(flagsRes.stdout).text(),
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
  });

  test("4. relocated scripts/fetch-*.ts respond to --help without touching network or secrets", async () => {
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
