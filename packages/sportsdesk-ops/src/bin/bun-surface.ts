#!/usr/bin/env bun
/**
 * @file packages/sportsdesk-ops/src/bin/bun-surface.ts
 * @description Bun runtime declaration snapshot (DOD-DEHARDCODE-02 / GATE-BUN-DOC-BLOB-SHA-01).
 *
 *   bun x bun-surface --json
 *   bun x bun-surface --filter XML --json
 *   bun x bun-surface --symbols --json
 */
import { parseArgs } from "node:util";
import {
  collectDtsClosureFiles,
  deriveAmbientDtsKindNumbers,
  resolveBunTypesRootDir,
  resolveInstalledBunTypesEntry,
  searchRootsFromModuleDir,
  type BunNamespaceSurfaceCounts,
  type BunSymbolLocation,
} from "../lib/bun_surface_dts_inventory.ts";

export interface BunSurfaceSnapshot {
  readonly domain: "[Bun Runtime]";
  readonly bun_version: string;
  readonly bun_revision: string;
  readonly audited_bun_commit: string;
  readonly ast_dts_sha256: string;
  readonly resolved_types_entry: string;
  readonly counts: BunNamespaceSurfaceCounts;
  readonly merged_fn_namespaces: readonly string[];
  readonly symbols?: readonly BunSymbolLocation[];
}

export interface BunSurfaceBuildOptions {
  readonly symbols?: boolean;
  readonly filter?: string;
}

export {
  collectDtsClosureFiles,
  deriveAmbientDtsKindNumbers,
  resolveBunTypesRootDir,
  resolveInstalledBunTypesEntry,
  type BunNamespaceSurfaceCounts,
  type BunSymbolKind,
  type BunSymbolLocation,
} from "../lib/bun_surface_dts_inventory.ts";

async function resolveAuditedBunCommit(
  env: Record<string, string | undefined>,
): Promise<string> {
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT) {
    const s3 = new Bun.S3Client({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      endpoint: env.R2_ENDPOINT,
      bucket: "sportsdesk-ops-reports",
    });
    try {
      const manifest = JSON.parse(
        await s3.file("manifests/bun-catalog/latest").text(),
      ) as { audited_bun_commit?: unknown };
      if (
        typeof manifest.audited_bun_commit === "string" &&
        /^[0-9a-f]{40}$/.test(manifest.audited_bun_commit)
      ) {
        return manifest.audited_bun_commit;
      }
    } catch {
      // Missing/invalid catalog falls back to the runtime revision.
    }
  }
  return Bun.revision;
}

export async function buildBunSurfaceSnapshot(
  env: Record<string, string | undefined> = Bun.env,
  options: BunSurfaceBuildOptions = {},
): Promise<BunSurfaceSnapshot> {
  if (env.CLOUDFLARE_R2_API_TOKEN && env.CLOUDFLARE_API_TOKEN) {
    throw new Error("ERR_CF_TOKEN_BLEED_10000");
  }

  const searchRoots = searchRootsFromModuleDir(import.meta.dir);
  const entryPath = resolveInstalledBunTypesEntry(searchRoots);
  const dtsFiles = collectDtsClosureFiles(entryPath, searchRoots);
  const typesRootDir = resolveBunTypesRootDir(dtsFiles);
  const auditedBunCommit = await resolveAuditedBunCommit(env);
  const { counts, mergedFnNamespaces, astDtsSha256, symbolLocations } =
    deriveAmbientDtsKindNumbers(dtsFiles, typesRootDir, auditedBunCommit);

  const includeSymbols =
    options.symbols !== false || options.filter !== undefined;
  const filteredSymbols = options.filter
    ? symbolLocations.filter((entry) => entry.symbol === options.filter)
    : symbolLocations;

  return {
    domain: "[Bun Runtime]",
    bun_version: Bun.version,
    bun_revision: Bun.revision,
    audited_bun_commit: auditedBunCommit,
    ast_dts_sha256: astDtsSha256,
    resolved_types_entry: entryPath,
    counts,
    merged_fn_namespaces: mergedFnNamespaces,
    ...(includeSymbols ? { symbols: filteredSymbols } : {}),
  };
}

const HELP = `
bun-surface — Bun declaration snapshot (DOD-DEHARDCODE-02)

Usage: bun-surface [--json|--no-json] [--symbols|--no-symbols] [--filter <name>]

Options:
  --json               Emit one JSON object on stdout (default)
  --no-json            Human-readable summary
  --symbols            Include every Bun symbol leaf + blob URL (default on)
  --no-symbols         Omit symbol locations for a smaller snapshot
  --filter <name>      Include symbol locations for one name (e.g. XML, which)
  --verify-non-zero    Fail when any category count is zero (default)
  --no-verify-non-zero Skip empty-surface guard
  -h, --help           This text
`.trim();

export async function run(
  argv: readonly string[] = Bun.argv.slice(2),
): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: true },
      symbols: { type: "boolean", default: true },
      "no-symbols": { type: "boolean", default: false },
      filter: { type: "string" },
      "verify-non-zero": { type: "boolean", default: true },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const snapshot = await buildBunSurfaceSnapshot(Bun.env, {
    symbols: values.symbols !== false && values["no-symbols"] !== true,
    ...(values.filter === undefined ? {} : { filter: values.filter }),
  });

  if (
    values["verify-non-zero"] &&
    (snapshot.counts.functions === 0 ||
      snapshot.counts.classes === 0 ||
      snapshot.counts.interfaces === 0 ||
      snapshot.counts.types === 0 ||
      snapshot.counts.variables === 0 ||
      snapshot.counts.namespaces === 0)
  ) {
    throw new Error(
      `ERR_CAT_EMPTY_AST_SURFACE: ${JSON.stringify(snapshot.counts)}`,
    );
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  } else {
    process.stdout.write(
      `${snapshot.domain} Bun ${snapshot.bun_version} (${snapshot.bun_revision.slice(0, 10)}) · audited ${snapshot.audited_bun_commit.slice(0, 10)} · dts ${snapshot.ast_dts_sha256.slice(0, 12)}\n`,
    );
    process.stdout.write(
      `  fn ${snapshot.counts.functions} · class ${snapshot.counts.classes} · iface ${snapshot.counts.interfaces} · type ${snapshot.counts.types} · var ${snapshot.counts.variables} · ns ${snapshot.counts.namespaces}\n`,
    );
    if (snapshot.merged_fn_namespaces.length > 0) {
      process.stdout.write(
        `  merged F+N/V+N: ${snapshot.merged_fn_namespaces.join(", ")}\n`,
      );
    }
    if (snapshot.symbols !== undefined && snapshot.symbols.length > 0) {
      for (const row of snapshot.symbols.slice(0, 20)) {
        process.stdout.write(
          `  ${row.symbol} (${row.kind}) ${row.leafPath}#L${row.line}\n`,
        );
      }
      if (snapshot.symbols.length > 20) {
        process.stdout.write(`  … ${snapshot.symbols.length - 20} more\n`);
      }
    }
  }
}

if (import.meta.main) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(message.includes("ERR_CF_TOKEN_BLEED_10000") ? 77 : 65);
  });
}
