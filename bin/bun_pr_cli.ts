#!/usr/bin/env bun
/**
 * @file bin/bun_pr_cli.ts
 * @description Operator interface to upstream Bun PR builds (oven-sh/bun) via bun-pr.
 *
 * Examples:
 *   ./bin/dx pr 16420                  # Download & link bun-16420 to ~/.bun/bin
 *   ./bin/dx pr 16420 --verify         # Download and verify sportsdesk-ops test suite against PR
 *   ./bin/dx pr 16420 -x run verify:fast # Download (if needed) and run script directly
 *   ./bin/dx pr --list                 # List all installed bun-* PR binaries
 *   ./bin/dx pr --clean 16420          # Remove bun-16420 binary and symlinks
 *   ./bin/dx pr --clean all            # Remove all installed PR binaries
 */

import {
  existsSync,
  readdirSync,
  unlinkSync,
  readlinkSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const BUN_BIN_DIR = join(homedir(), ".bun", "bin");
const REPO_ROOT = process.cwd();

const HELP = `
dx pr — download, test, and manage upstream Bun PR builds (oven-sh/bun)

Usage:
  ./bin/dx pr <pr-number|url|branch> [options]
  ./bin/dx pr --list
  ./bin/dx pr --clean [pr-number|all]

Commands & Options:
  <target>             PR number (e.g. 16420), branch, commit SHA, or GitHub PR URL
  --verify             After download, execute repository verification gates using the PR binary
  -x, --run <args...>  Execute the target command directly using the PR binary (passthrough)
  --asan               Download Linux x64 AddressSanitizer release build
  --profile            Download profiling build with symbol maps
  --baseline           Download baseline x86-64 build (no AVX2 instructions)
  --musl               Download musl libc build (Alpine / container)
  --lldb               Launch the downloaded PR binary directly in LLDB
  --gdb                Launch the downloaded PR binary directly in GDB
  --list               List all installed bun-* PR binaries in ~/.bun/bin
  --clean [target|all] Remove one or all downloaded PR binaries from ~/.bun/bin
  -h, --help           Show this help text

Examples:
  ./bin/dx pr 16420
  ./bin/dx pr 16420 --verify
  ./bin/dx pr 16420 -x run test tests/bun_cli_flags.test.ts
  ./bin/dx pr --list
  ./bin/dx pr --clean all
`.trim();

function getInstalledPrBinaries(): Array<{
  name: string;
  path: string;
  isSymlink: boolean;
  target?: string | undefined;
  sizeBytes: number;
}> {
  if (!existsSync(BUN_BIN_DIR)) return [];
  const entries = readdirSync(BUN_BIN_DIR);
  const prBinaries: Array<{
    name: string;
    path: string;
    isSymlink: boolean;
    target?: string | undefined;
    sizeBytes: number;
  }> = [];

  for (const entry of entries) {
    if (
      entry === "bun" ||
      entry === "bunx" ||
      entry === "bun-pr" ||
      entry === "bun-reduce" ||
      entry === "bun-latest"
    ) {
      continue;
    }
    if (entry.startsWith("bun-")) {
      const fullPath = join(BUN_BIN_DIR, entry);
      try {
        const lstat = lstatSync(fullPath);
        const isSymlink = lstat.isSymbolicLink();
        const target = isSymlink ? readlinkSync(fullPath) : undefined;
        const sizeBytes = lstat.size;
        prBinaries.push({
          name: entry,
          path: fullPath,
          isSymlink,
          target,
          sizeBytes,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return prBinaries.sort((a, b) => a.name.localeCompare(b.name));
}

function handleList(): void {
  const binaries = getInstalledPrBinaries();
  if (binaries.length === 0) {
    console.log(`No upstream Bun PR binaries installed in ${BUN_BIN_DIR}`);
    return;
  }

  console.log(`Installed upstream Bun PR binaries in ${BUN_BIN_DIR}:`);
  console.log("");
  for (const b of binaries) {
    const typeLabel = b.isSymlink
      ? `-> ${b.target}`
      : `(${(b.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`;
    console.log(`  ${b.name.padEnd(35)} ${typeLabel}`);
  }
}

function handleClean(target: string | undefined): void {
  const binaries = getInstalledPrBinaries();
  if (binaries.length === 0) {
    console.log(`No PR binaries found to clean in ${BUN_BIN_DIR}`);
    return;
  }

  if (!target || target === "all") {
    let removed = 0;
    for (const b of binaries) {
      try {
        unlinkSync(b.path);
        removed++;
      } catch (err) {
        console.error(`Failed to remove ${b.name}: ${err}`);
      }
    }
    console.log(`Removed ${removed} PR binary artifacts from ${BUN_BIN_DIR}`);
    return;
  }

  const matches = binaries.filter((b) => b.name.includes(target));
  if (matches.length === 0) {
    console.log(`No PR binaries matching "${target}" found in ${BUN_BIN_DIR}`);
    return;
  }

  for (const b of matches) {
    try {
      unlinkSync(b.path);
      console.log(`Removed ${b.name}`);
    } catch (err) {
      console.error(`Failed to remove ${b.name}: ${err}`);
    }
  }
}

function findInstalledBinary(prId: string): string | null {
  const candidateDirect = join(BUN_BIN_DIR, `bun-${prId}`);
  if (existsSync(candidateDirect)) return candidateDirect;

  const binaries = getInstalledPrBinaries();
  const match = binaries.find((b) => b.name.includes(prId));
  return match ? match.path : null;
}

async function runVerifySuite(binaryPath: string): Promise<boolean> {
  console.log("");
  console.log(
    `=== Running SportsDesk Verification Suite using ${binaryPath} ===`,
  );

  // 1. Version check
  const ver = spawnSync(binaryPath, ["--version"], { stdio: "inherit" });
  if (ver.status !== 0) return false;

  // 2. Typecheck
  console.log("\n[1/3] Typecheck (bun check)...");
  const check = spawnSync(
    binaryPath,
    ["check", "--no-script", "-p", "tsconfig.json"],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
    },
  );
  if (check.status !== 0) return false;

  // 3. Spec citations
  console.log("\n[2/3] Spec citations gate...");
  const citations = spawnSync(
    binaryPath,
    ["run", "scripts/run_check_spec_citations.ts"],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
    },
  );
  if (citations.status !== 0) return false;

  // 4. Targeted fast verification
  console.log("\n[3/3] Fast verification (verify:fast)...");
  const fast = spawnSync(binaryPath, ["run", "verify:fast"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
  });
  return fast.status === 0;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }

  if (args.includes("--list")) {
    handleList();
    return;
  }

  const cleanIdx = args.findIndex((a) => a === "--clean");
  if (cleanIdx !== -1) {
    const cleanTarget = args[cleanIdx + 1];
    handleClean(cleanTarget);
    return;
  }

  const verifyIdx = args.findIndex((a) => a === "--verify");
  const shouldVerify = verifyIdx !== -1;
  if (shouldVerify) {
    args.splice(verifyIdx, 1);
  }

  const targetArg = args.find((a) => !a.startsWith("-"));
  if (!targetArg) {
    console.error("Error: PR number, branch, or URL required.");
    console.log(HELP);
    process.exit(1);
  }

  // Resolve bun-pr path
  const globalBunPr = join(BUN_BIN_DIR, "bun-pr");
  const bunPrExec = existsSync(globalBunPr) ? globalBunPr : "bun-pr";

  console.log(`[dx pr] Invoking bun-pr for target: ${targetArg}...`);
  const spawnResult = spawnSync(process.execPath, [bunPrExec, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

  if (spawnResult.status !== 0) {
    process.exit(spawnResult.status ?? 1);
  }

  if (shouldVerify) {
    const prId = targetArg.replace(/[^0-9a-zA-Z_-]/g, "");
    const binary = findInstalledBinary(prId) || join(BUN_BIN_DIR, "bun-latest");
    if (!existsSync(binary)) {
      console.error(`Downloaded binary not found at ${binary}`);
      process.exit(1);
    }

    const success = await runVerifySuite(binary);
    if (!success) {
      console.error("\n❌ Verification suite failed on PR binary.");
      process.exit(1);
    }
    console.log("\n✅ Verification suite passed on PR binary.");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
