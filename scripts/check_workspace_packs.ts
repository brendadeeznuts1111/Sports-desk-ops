#!/usr/bin/env bun
/**
 * @file scripts/check_workspace_packs.ts
 * @description Verifies pack boundaries (`bun pm pack --dry-run`), explicit `files`
 * allowlists, `exports` target existence, and browser/contract dependency isolation
 * across `@sportsdesk-ops/{contracts,ui,backend,api}`.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { inspectWorkspaces } from "../lib/pm_policy.ts";

export const WORKSPACE_PACK_DIRS = [
  "packages/contracts",
  "packages/ui",
  "packages/backend",
  "packages/api",
] as const;

const SERVER_ONLY_DEPS = new Set<string>([
  "@ganchrowsci/gs-sdk",
  "@modelcontextprotocol/sdk",
  "pele",
]);

const FORBIDDEN_PACK_RE =
  /(?:^|\/)(?:\.env(?:\.|$)|data\/live-|scratch\/|node_modules\/)|\.test\.(?:ts|tsx|js|mjs)$/;

export interface WorkspacePackCheckEntry {
  readonly dir: string;
  readonly name: string;
  readonly packedFiles: readonly string[];
  readonly issues: readonly string[];
}

export interface WorkspacePackReport {
  readonly ok: boolean;
  readonly entries: readonly WorkspacePackCheckEntry[];
}

interface RawWorkspaceManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly files?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/** Parse file paths emitted by `bun --no-env-file pm pack --dry-run`. */
export function parseBunPackDryRunFiles(output: string): string[] {
  const files: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^packed\s+\S+\s+(.+)$/.exec(line);
    if (match?.[1]) {
      files.push(match[1].trim());
    }
  }
  return files;
}

function collectExportTargets(exportsField: unknown): string[] {
  if (typeof exportsField === "string") return [exportsField];
  if (typeof exportsField !== "object" || exportsField === null) return [];
  const targets: string[] = [];
  for (const value of Object.values(exportsField)) {
    targets.push(...collectExportTargets(value));
  }
  return targets;
}

function listWorkspaceNodeModulesEntries(wsAbs: string): string[] {
  const nm = path.join(wsAbs, "node_modules");
  if (!existsSync(nm)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      const scopeDir = path.join(nm, entry);
      for (const scoped of readdirSync(scopeDir)) {
        names.push(`${entry}/${scoped}`);
      }
      continue;
    }
    names.push(entry);
  }
  return names.sort();
}

export async function checkWorkspacePacks(
  root: string,
): Promise<WorkspacePackReport> {
  const inspection = await inspectWorkspaces(root);
  const pkgByName = new Map(
    inspection.packages
      .filter((p) => p.dir !== "")
      .map((p) => [p.name, p] as const),
  );

  const entries: WorkspacePackCheckEntry[] = [];

  for (const relDir of WORKSPACE_PACK_DIRS) {
    const absDir = path.join(root, relDir);
    const manifestPath = path.join(absDir, "package.json");
    const issues: string[] = [];
    let name: string = relDir;
    let packedFiles: string[] = [];

    if (!existsSync(manifestPath)) {
      entries.push({
        dir: relDir,
        name,
        packedFiles,
        issues: [`${relDir}: missing package.json`],
      });
      continue;
    }

    const manifest = (await Bun.file(
      manifestPath,
    ).json()) as RawWorkspaceManifest;
    name = manifest.name ?? relDir;

    if (manifest.private !== true) {
      issues.push(`${relDir}: expected "private": true`);
    }

    const filesAllowlist = Array.isArray(manifest.files)
      ? manifest.files.filter((f): f is string => typeof f === "string")
      : [];
    if (filesAllowlist.length === 0) {
      issues.push(`${relDir}: expected explicit non-empty "files" allowlist`);
    }

    const exportTargets = collectExportTargets(manifest.exports);
    if (exportTargets.length === 0) {
      issues.push(`${relDir}: expected explicit "exports" map`);
    }
    for (const target of exportTargets) {
      const resolved = path.resolve(absDir, target);
      if (!existsSync(resolved)) {
        issues.push(`${relDir}: export target does not exist: ${target}`);
      }
    }

    const packEnv: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR"] as const) {
      const val = Bun.env[key];
      if (val !== undefined) packEnv[key] = val;
    }

    const packProc = Bun.spawnSync(
      [process.execPath, "--no-env-file", "pm", "pack", "--dry-run"],
      {
        cwd: absDir,
        env: packEnv,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const packOut = new TextDecoder().decode(packProc.stdout);
    const packErr = new TextDecoder().decode(packProc.stderr);
    if (packProc.exitCode !== 0) {
      issues.push(
        `${relDir}: bun pm pack --dry-run exited ${packProc.exitCode}: ${packErr.trim() || packOut.trim()}`,
      );
    } else {
      packedFiles = parseBunPackDryRunFiles(packOut);
      if (packedFiles.length === 0) {
        issues.push(
          `${relDir}: bun pm pack --dry-run reported 0 packed files (stdout=${JSON.stringify(packOut.slice(0, 200))}, stderr=${JSON.stringify(packErr.slice(0, 200))})`,
        );
      }
      for (const file of packedFiles) {
        if (FORBIDDEN_PACK_RE.test(file)) {
          issues.push(`${relDir}: forbidden file matched pack output: ${file}`);
        }
        const allowed =
          file === "package.json" ||
          file.startsWith("src/") ||
          file.startsWith("dist/");
        if (!allowed) {
          issues.push(`${relDir}: unexpected file outside allowlist: ${file}`);
        }
      }
    }

    // Browser/contract boundary: contracts and ui must never declare or link server-only packages
    if (relDir === "packages/contracts" || relDir === "packages/ui") {
      const visited = new Set<string>();
      const queue: string[] = [name];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const info = pkgByName.get(current);
        if (!info) continue;
        const depMaps = [
          info.dependencies,
          info.devDependencies,
          info.peerDependencies,
          info.optionalDependencies,
        ];
        for (const map of depMaps) {
          for (const [dep, spec] of Object.entries(map)) {
            if (SERVER_ONLY_DEPS.has(dep)) {
              issues.push(
                `${relDir}: forbidden server-only dependency "${dep}" reachable via ${current}`,
              );
            }
            if (spec.startsWith("workspace:")) {
              queue.push(dep);
            }
          }
        }
      }

      for (const linkedPkg of listWorkspaceNodeModulesEntries(absDir)) {
        if (SERVER_ONLY_DEPS.has(linkedPkg)) {
          issues.push(
            `${relDir}: forbidden server-only link in ${relDir}/node_modules: ${linkedPkg}`,
          );
        }
      }
    }

    entries.push({ dir: relDir, name, packedFiles, issues });
  }

  return {
    ok: entries.every((e) => e.issues.length === 0),
    entries,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const root = path.resolve(import.meta.dir, "..");
  const report = await checkWorkspacePacks(root);

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const entry of report.entries) {
      const badge = entry.issues.length === 0 ? "OK" : "FAIL";
      console.log(
        `[${badge}] ${entry.name} (${entry.dir}): ${entry.packedFiles.length} packed file(s)`,
      );
      for (const issue of entry.issues) {
        console.error(`  - ${issue}`);
      }
    }
  }

  process.exit(report.ok ? 0 : 1);
}
