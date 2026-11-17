#!/usr/bin/env bun
/**
 * @file scripts/verify_cli_bins.ts
 * @description DOD-DEHARDCODE-04: verify workspace CLI shims via `Bun.which` only (no package.json read).
 *
 * Trade-off: this list must stay in sync when bins are added; `dx scripts --bins` still catalogs
 * targets from package.json for human inspection.
 */
import { resolve } from "node:path";

/** SSOT for workspace `bin` names (23); must match root `package.json` `bin` keys. */
export const REQUIRED_CLI_BINS = [
  "blob-formdata",
  "bun-surface",
  "desk-provenance",
  "dx",
  "image-meta",
  "nsh-desk",
  "sportsdesk",
  "sportsdesk-autobet",
  "sportsdesk-bet-flags",
  "sportsdesk-candidate",
  "sportsdesk-catalog",
  "sportsdesk-combo",
  "sportsdesk-fraud",
  "sportsdesk-flags",
  "sportsdesk-hierarchy-ingest",
  "sportsdesk-layoff-risk",
  "sportsdesk-replay",
  "sportsdesk-schema",
  "sportsdesk-settlement",
  "sportsdesk-ticket",
  "sql-query",
  "wrangler",
  "xml-parse",
] as const;

export type RequiredCliBin = (typeof REQUIRED_CLI_BINS)[number];

export interface VerifiedCliBin {
  readonly bin: RequiredCliBin;
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

  for (const binName of REQUIRED_CLI_BINS) {
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
