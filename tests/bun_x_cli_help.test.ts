/**
 * @file tests/bun_x_cli_help.test.ts
 * @description Every `bun x <bin>` entry must answer `-h`/`--help` with exit 0.
 *
 * Regression this pins: `xml-parse` and `blob-formdata` treated `--help` as the input
 * filename, so `bun x xml-parse --help` died with `ENOENT: open '--help'`. A bin that
 * cannot describe itself is not discoverable, and the fix belongs in the bin, not in
 * the caller.
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
      const proc = Bun.spawnSync([process.execPath, "x", bin, "--help"], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      const output =
        `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
      // Bash shims (wrangler) delegate their help to the upstream tool; every Bun
      // bin must print a usage line so the flag is self-describing.
      const target = pkg.bin?.[bin];
      const head =
        target === undefined
          ? ""
          : ((await Bun.file(join(ROOT, target)).text()).split("\n")[0] ?? "");
      const requiresUsage = head.startsWith("#!/usr/bin/env bun");
      if (
        proc.exitCode !== 0 ||
        output.length < 10 ||
        (requiresUsage && !/usage/i.test(output))
      ) {
        failures.push(
          `${bin}: exit=${proc.exitCode} usage=${/usage/i.test(output)} output=${JSON.stringify(output.slice(0, 120))}`,
        );
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
