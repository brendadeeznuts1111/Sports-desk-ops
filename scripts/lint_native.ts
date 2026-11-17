#!/usr/bin/env bun
/**
 * @file scripts/lint_native.ts
 * @description Resolve and invoke a native `bun lint` binary (`Bun canary` or `1.5+`),
 * falling back cleanly with exit 2 when only `1.4.4` stable is installed.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function hasNativeBunLint(bin: string, probeDir = "/tmp"): boolean {
  try {
    const res = Bun.spawnSync([bin, "lint", "--help"], {
      cwd: probeDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) return false;
    const out = new TextDecoder().decode(res.stdout);
    return out.includes("Usage: bun lint");
  } catch {
    return false;
  }
}

export function candidateBunLintBins(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string[] {
  const candidates: string[] = [];
  const explicit = env.BUN_LINT_BIN?.trim();
  if (explicit) candidates.push(explicit);

  candidates.push(process.execPath);

  const whichCanary = Bun.which("bun-canary", { PATH: env.PATH ?? "" });
  if (whichCanary) candidates.push(whichCanary);

  const home = env.HOME?.trim();
  if (home) {
    const binDir = join(home, ".bun", "bin");
    if (existsSync(binDir)) {
      try {
        const entries = readdirSync(binDir)
          .filter((name) => name.startsWith("bun-canary"))
          .sort()
          .reverse();
        for (const entry of entries) {
          candidates.push(join(binDir, entry));
        }
      } catch {
        // Ignore unreadable home bin dir in restricted environments
      }
    }
  }

  return [...new Set(candidates)];
}

export function resolveNativeBunLintBin(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string | null {
  for (const bin of candidateBunLintBins(env)) {
    if (hasNativeBunLint(bin)) return bin;
  }
  return null;
}

if (import.meta.main) {
  const bin = resolveNativeBunLintBin();
  if (bin === null) {
    console.error(
      `lint:native unavailable on Bun ${Bun.version} (no native \`bun lint\` binary found; set BUN_LINT_BIN or use \`bun run lint:check\`).`,
    );
    process.exit(2);
  }

  const child = Bun.spawnSync(
    [bin, "lint", "--no-script", ...Bun.argv.slice(2)],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(child.exitCode);
}
