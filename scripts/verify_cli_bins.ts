#!/usr/bin/env bun
/**
 * @file scripts/verify_cli_bins.ts
 * @description Verify every declared workspace CLI shim resolves and has a Bun/shebang head.
 *
 * The bin list is derived from the root `package.json` `bin` map (`requiredCliBins`), so adding a
 * bin does not require editing this file; `bun x <bin> --help` and the generated `cli/README.md`
 * catalog are gated separately.
 */
import { resolve } from "node:path";
import { requiredCliBins } from "../lib/cli_catalog.ts";

export interface VerifiedCliBin {
  readonly bin: string;
  readonly resolvedPath: string;
}

export interface VerifyCliBinsResult {
  readonly domain: "[Ops & Governance]";
  readonly check: "cli:bins";
  readonly status: "PASS";
  readonly verified_count: number;
  readonly xml_parse_entry: VerifiedCliBin | null;
  readonly verified: readonly VerifiedCliBin[];
}

function resolveRepoRootFromGit(): string {
  const repoRootProc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (repoRootProc.exitCode !== 0) {
    throw new Error("ERR_OPS_GIT_TOPLEVEL_UNRESOLVED");
  }
  const repoRoot = repoRootProc.stdout.toString().trim();
  if (repoRoot === "") {
    throw new Error("ERR_OPS_GIT_TOPLEVEL_UNRESOLVED");
  }
  return repoRoot;
}

export async function verifyWorkspaceCliBins(options?: {
  readonly repoRoot?: string | undefined;
}): Promise<VerifyCliBinsResult> {
  const repoRoot = options?.repoRoot ?? resolveRepoRootFromGit();
  const packageRoot = resolve(repoRoot, "packages/sportsdesk-ops");
  const workspaceBinDir = resolve(repoRoot, "node_modules/.bin");

  const verified: VerifiedCliBin[] = [];
  const bins = await requiredCliBins(repoRoot);

  for (const binName of bins) {
    const resolvedShim = Bun.which(binName, {
      cwd: packageRoot,
      PATH: workspaceBinDir,
    });

    if (!resolvedShim) {
      throw new Error(
        `ERR_OPS_BIN_SHIM_UNLINKED: ${binName} (run bun install)`,
      );
    }

    const head = await Bun.file(resolvedShim).slice(0, 96).text();
    const shebang = head.split("\n")[0] ?? "";
    if (!shebang.startsWith("#!/usr/bin/env ")) {
      throw new Error(
        `ERR_OPS_INVALID_BUN_SHEBANG: ${binName} (${resolvedShim})`,
      );
    }

    verified.push({ bin: binName, resolvedPath: resolvedShim });
  }

  return {
    domain: "[Ops & Governance]",
    check: "cli:bins",
    status: "PASS",
    verified_count: verified.length,
    xml_parse_entry:
      verified.find((entry) => entry.bin === "xml-parse") ?? null,
    verified,
  };
}

const asJson = process.argv.includes("--json");

verifyWorkspaceCliBins()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!asJson) {
      console.log(
        `cli:bins verify PASS (${result.verified_count} shims; xml-parse → ${result.xml_parse_entry?.resolvedPath ?? "n/a"})`,
      );
    }
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
