#!/usr/bin/env bun
/**
 * @file bin/desk-provenance.ts
 * @description Self-contained desk provenance CLI: inspects the active Bun binary (`Bun.version`,
 * `Bun.revision`, `Bun.version_with_sha`), verifies the pinned Manager Boot Oracle runtime
 * manifest, and snapshots spine repository HEAD SHAs, branch names, and optional DSH worktrees.
 *
 * Usage:
 *   bun x desk-provenance [--table] [--json] [--yaml] [--worktrees] [--check] [--strict-exec] [--no-oracle] [--out=<path>]
 *   bun run desk:provenance
 *   ./bin/dx provenance
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deskProvenanceSnapshot } from "../lib/bun_runtime.ts";

const HELP = `desk-provenance — Bun runtime oracle pin + spine repo & worktree SHA provenance

Usage:
  bun x desk-provenance [options]
  bun run desk:provenance
  ./bin/dx provenance [options]

Options:
  --table            Render human-readable table via Bun.inspect.table
  --json             Emit JSON snapshot (default when --table and --yaml are omitted)
  --yaml             Emit YAML snapshot via Bun.YAML.stringify
  --worktrees        Include deepseek-harness worktree identities
  --check            Exit 1 when the oracle runtime pin check reports mismatches
  --strict-exec      Also compare bunExecutablePath against the oracle manifest
  --no-oracle        Skip the Manager Boot Oracle manifest pin comparison
  --code-root=<dir>  Override workspace root (default: $CODE_ROOT or ~/code)
  --out=<file>       Write JSON snapshot to <file>
  --out-only         Suppress stdout when --out=<file> is supplied
  -h, --help         Show this help
`;

const KNOWN_FLAGS = new Set([
  "--table",
  "--json",
  "--yaml",
  "--worktrees",
  "--check",
  "--strict-exec",
  "--no-oracle",
  "--out-only",
  "-h",
  "--help",
]);

export async function runDeskProvenanceCli(
  argv: readonly string[] = Bun.argv.slice(2),
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP.trimEnd());
    return 0;
  }

  let outPath: string | undefined;
  let codeRoot: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length).trim();
      if (!outPath) {
        console.error("desk-provenance: --out requires a non-empty file path");
        return 2;
      }
      continue;
    }
    if (arg === "--out") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("desk-provenance: --out requires a file path");
        return 2;
      }
      outPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--code-root=")) {
      codeRoot = arg.slice("--code-root=".length).trim();
      if (!codeRoot) {
        console.error(
          "desk-provenance: --code-root requires a non-empty directory",
        );
        return 2;
      }
      continue;
    }
    if (arg === "--code-root") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("desk-provenance: --code-root requires a directory");
        return 2;
      }
      codeRoot = next;
      i += 1;
      continue;
    }
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`desk-provenance: unknown argument '${arg}' (try --help)`);
      return 2;
    }
  }

  const table = argv.includes("--table");
  const yaml = argv.includes("--yaml");
  const json = argv.includes("--json");
  if ((table && yaml) || (table && json) || (json && yaml)) {
    console.error(
      "desk-provenance: choose at most one output format (--table, --json, or --yaml)",
    );
    return 2;
  }

  const snap = deskProvenanceSnapshot({
    codeRoot,
    includeWorktrees: argv.includes("--worktrees"),
    oracleManifestPath: argv.includes("--no-oracle") ? false : undefined,
    strictExecPath: argv.includes("--strict-exec"),
  });

  if (outPath) {
    const abs = resolve(outPath);
    mkdirSync(dirname(abs), { recursive: true });
    await Bun.write(abs, `${JSON.stringify(snap, null, 2)}\n`);
  }

  const suppressStdout = Boolean(outPath) && argv.includes("--out-only");
  if (!suppressStdout) {
    if (table) {
      console.log(
        `Bun ${snap.bun.versionWithSha} (${snap.bun.revisionComposite})`,
      );
      if (snap.oracle) {
        console.log(
          `Oracle ${snap.oracle.ok ? "OK" : "FAIL"} · ${snap.oracle.manifestPath}`,
        );
        for (const mismatch of snap.oracle.mismatches) {
          console.log(`  - ${mismatch}`);
        }
      }
      console.log(`CODE_ROOT ${snap.codeRoot}`);
      const rows = [
        ...snap.repos.map((r) => ({
          kind: "repo",
          name: r.name,
          branch: r.branch ?? "—",
          head: r.headShort ?? "—",
          state:
            r.head === undefined
              ? "missing"
              : r.dirty
                ? `dirty(${r.dirtyCount ?? 0})`
                : "clean",
        })),
        ...(snap.worktrees ?? []).map((w) => ({
          kind: "worktree",
          name: w.name,
          branch: w.branch ?? "—",
          head: w.headShort ?? "—",
          state: w.dirty ? `dirty(${w.dirtyCount ?? 0})` : "clean",
        })),
      ];
      console.log(
        Bun.inspect.table(rows, ["kind", "name", "branch", "head", "state"], {
          colors: Boolean(process.stdout.isTTY) && !Bun.env.NO_COLOR,
        }),
      );
    } else if (yaml) {
      process.stdout.write(Bun.YAML.stringify(snap, null, 2));
    } else {
      console.log(JSON.stringify(snap, null, 2));
    }
  }

  if (argv.includes("--check") && snap.oracle && !snap.oracle.ok) {
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runDeskProvenanceCli();
}
