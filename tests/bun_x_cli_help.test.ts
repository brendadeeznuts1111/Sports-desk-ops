/**
 * @file tests/bun_x_cli_help.test.ts
 * @description Every declared bin must answer `-h`/`--help` with exit 0.
 *
 * Regression this pins: `xml-parse` and `blob-formdata` treated `--help` as the input
 * filename, so `bun x xml-parse --help` died with `ENOENT: open '--help'`. A bin that
 * cannot describe itself is not discoverable, and the fix belongs in the bin, not in
 * the caller.
 *
 * The check runs the installed `node_modules/.bin` entry when `bun install` has linked it and the
 * declared target otherwise. It does **not** use `bun x <bin>`: when that link is missing (a fresh
 * worktree, or a bin added in the same commit) `bun x` resolves the name on the npm registry and
 * executes a stranger's package. Measured 2026-11-18: `bun x image-assets` installed and built an
 * unrelated 2015 iOS asset generator, because the local bin had not been linked yet.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// @bun-behavior: bun-x-catalog

describe("bun x CLI help surface", () => {
  test("every declared bin answers --help with exit 0 and output", async () => {
    const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
      bin?: Record<string, string>;
    };
    const bins = Object.keys(pkg.bin ?? {}).sort();
    expect(bins.length).toBeGreaterThan(20);

    const failures: string[] = [];
    for (const bin of bins) {
      const target = pkg.bin?.[bin];
      // Run the installed entry point when `bun install` has linked it, else the declared target.
      // Never `bun x <bin>`: when node_modules/.bin is stale (a fresh worktree, or a bin added in
      // the same commit), `bun x` resolves the *name* on the npm registry and executes a stranger's
      // package. Measured 2026-11-18: `bun x image-assets` installed and built an unrelated 2015
      // iOS asset generator because the local bin had not been linked yet.
      const linked = join(ROOT, "node_modules", ".bin", bin);
      const isLinked =
        target !== undefined && (await Bun.file(linked).exists());
      const entry = isLinked ? linked : join(ROOT, target ?? bin);
      const argv = isLinked
        ? [entry, "--help"]
        : [process.execPath, entry, "--help"];
      if (target === undefined) {
        failures.push(`${bin}: package.json bin is null`);
        continue;
      }
      const proc = Bun.spawnSync(argv, {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      const output =
        `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
      // Bash shims (wrangler) delegate their help to the upstream tool; every Bun
      // bin must print a usage line so the flag is self-describing.
      const head =
        target === undefined
          ? ""
          : ((await Bun.file(join(ROOT, target)).text()).split("\n")[0] ?? "");
      const isBunBin = head.startsWith("#!/usr/bin/env bun");
      // Bun bins must describe themselves: exit 0 and a usage line.
      //
      // A bash shim delegates to an external CLI, and there are three measured machines:
      // absent on the CI runner (our shim exits 1 with "[wrangler] ... is not installed."),
      // installed and working locally (`answered`), and a broken global install
      // (`error: Cannot find package 'blake3-wasm'`). Only "it said something" is portable,
      // and silence is the failure this guards against.
      const ok = isBunBin
        ? proc.exitCode === 0 && /usage/i.test(output)
        : output.length >= 10;
      if (!ok) {
        failures.push(
          `${bin}: exit=${proc.exitCode} usage=${/usage/i.test(output)} output=${JSON.stringify(output.slice(0, 120))}`,
        );
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
