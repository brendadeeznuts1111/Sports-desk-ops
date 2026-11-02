/**
 * Internal consistency of `docs/evidence/ledger.json` against itself and the published spec.
 *
 * The ledger is the SSOT for what is verified, observed or inferred, and the docs gate trusts
 * it. Nothing checked the ledger against *itself*, so three defects sat in it unnoticed:
 *
 * - `schemaDoc.counts` prose said "A+B+C+D+E = total = 48" while `counts.total` and the rows
 *   said 55. Prose is not derived from anything, so it drifted the moment rows were added.
 * - `surface.missingFromSpec` had no stated meaning, so four rows disagreed about it: some read
 *   it as "no member path is published", others as "some member path is not published".
 * - The counts themselves (`counts`, `surfaceCounts`, `countsByTag`) are hand-maintained
 *   duplicates of the row tiers.
 *
 * This module derives all of it and reports what disagrees. It never edits the ledger: a
 * generator that silently rewrites an evidence file is worse than a failing check.
 */

import { existsSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import { join } from "node:path";

export type Issue = {
  readonly code:
    | "COUNTS_STALE"
    | "TAG_COUNTS_STALE"
    | "PROSE_STALE"
    | "SURFACE_FLAG_WRONG"
    | "SURFACE_FLAG_UNDOCUMENTED"
    | "TIER_A_WITHOUT_CAPTURE"
    | "CAPTURE_REF_DANGLING"
    | "CITATION_DANGLING"
    | "CITATION_LINE_RANGE"
    | "SHAPE";
  readonly message: string;
};

type Json = Record<string, unknown>;

const TIERS = ["A", "B", "C", "D", "E"] as const;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip a leading `METHOD ` and a trailing `/*`, so a surface member reduces to a spec path. */
export function memberPath(member: unknown): string | undefined {
  if (typeof member !== "string") return undefined;
  const trimmed = member
    .trim()
    .replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "");
  const path = trimmed.split(/\s+/)[0] ?? "";
  if (!path.startsWith("/")) return undefined;
  return path.replace(/\/\*$/, "");
}

/**
 * Whether a surface is missing from the spec, derived rather than declared.
 *
 * False means: the spec publishes every path this surface lists, and it lists at least one.
 * True means anything else — a surface whose members are field names or CLI commands rather
 * than routes is missing by construction, because the spec models operations, not tooling.
 */
export function deriveMissingFromSpec(
  surface: Json,
  specPaths: ReadonlySet<string>,
): boolean {
  const members = Array.isArray(surface["members"]) ? surface["members"] : [];
  const paths = members
    .map(memberPath)
    .filter((p): p is string => p !== undefined);
  if (paths.length === 0) return true;
  return paths.some((path) => !specPaths.has(path));
}

/** Tier counts over `operations[]`, recomputed from the rows. */
export function countTiers(rows: readonly unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const tier = typeof row["tier"] === "string" ? row["tier"] : "";
    if (tier === "") continue;
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}

/** Per-tag tier counts over `operations[]`, recomputed from the rows. */
export function countByTag(
  rows: readonly unknown[],
): Record<string, Record<string, number>> {
  const byTag: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const tier = typeof row["tier"] === "string" ? row["tier"] : "";
    if (tier === "") continue;
    const tag = typeof row["tag"] === "string" ? row["tag"] : "(none)";
    const bucket = (byTag[tag] ??= {});
    bucket[tier] = (bucket[tier] ?? 0) + 1;
  }
  return byTag;
}

function totalOf(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function specPathsOf(spec: unknown): Set<string> {
  if (!isRecord(spec) || !isRecord(spec["paths"])) return new Set();
  return new Set(Object.keys(spec["paths"]));
}

const SKIP_DIRS = [
  "node_modules/",
  "lib/.tmp",
  "dist/",
  ".git/",
  "Scratch/",
] as const;

/** Where a citation may be looked up, in order. */
const CITATION_ROOTS = [
  "",
  "docs/runbooks",
  "docs/evidence",
  "docs",
  "services",
  "scripts",
  "lib",
  "tests",
  "bin",
  "schema",
  "infra",
] as const;

/** `path/to/file.ext`, optionally with `:line` or `:line-endline`. */
const CITATION =
  /^([\w./-]+\.(?:ts|tsx|js|json|md|yml|yaml|html|sh))(?::(\d+)(?:-(\d+))?)?$/;

export type AuditOptions = {
  /** Repository root for resolving file citations. */
  readonly root?: string;
  /** Capture files that exist in the store, relative POSIX paths (`2026-10-31/x.post.json`). */
  readonly captureFiles?: ReadonlySet<string>;
};

/**
 * Resolve a cited file: exact path, then the known roots, then a unique basename anywhere in
 * the repo. The basename step is what makes a citation survive a directory move — 34 ledger
 * citations pointed at `operational_guardrails_runbook.md` after it moved under `docs/runbooks/`,
 * and none of them had become false.
 */
export function resolveCitation(
  file: string,
  root: string,
  index?: ReadonlyMap<string, string>,
): string | undefined {
  for (const dir of CITATION_ROOTS) {
    const candidate = join(root, dir, file);
    if (existsSync(candidate)) return candidate;
  }
  const base = file.split("/").pop() ?? file;
  const hit = index?.get(base);
  return hit === undefined ? undefined : join(root, hit);
}

/** Basename → repo-relative path, for citations that outlived a directory move. */
export function basenameIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const path of new Glob("**/*").scanSync({ cwd: root, dot: false })) {
    if (SKIP_DIRS.some((dir) => path.startsWith(dir))) continue;
    const base = path.split("/").pop() ?? path;
    // Two files with the same basename make the lookup a guess, so neither is returned.
    if (index.has(base)) ambiguous.add(base);
    else index.set(base, path);
  }
  for (const base of ambiguous) index.delete(base);
  return index;
}

/**
 * Every disagreement between the ledger's declared bookkeeping and its own rows.
 *
 * `spec` may be undefined when the spec is unavailable; the surface-flag checks are then
 * skipped rather than guessed, and the caller sees fewer issues, not false ones.
 */
export function auditLedger(
  ledger: unknown,
  spec?: unknown,
  options: AuditOptions = {},
): Issue[] {
  const issues: Issue[] = [];
  if (!isRecord(ledger)) {
    return [{ code: "SHAPE", message: "ledger is not a JSON object" }];
  }
  const operations = Array.isArray(ledger["operations"])
    ? ledger["operations"]
    : [];
  const surfaces = Array.isArray(ledger["surfaces"]) ? ledger["surfaces"] : [];

  // 1. counts.total must agree with counts.A..E and with the rows.
  const declared = isRecord(ledger["counts"]) ? ledger["counts"] : {};
  const actual = countTiers(operations);
  for (const tier of TIERS) {
    const want = typeof declared[tier] === "number" ? declared[tier] : 0;
    const have = actual[tier] ?? 0;
    if (want !== have) {
      issues.push({
        code: "COUNTS_STALE",
        message: `counts.${tier}=${want} but ${have} operations[] row(s) are tier ${tier}`,
      });
    }
  }
  const declaredTotal =
    typeof declared["total"] === "number" ? declared["total"] : 0;
  if (declaredTotal !== operations.length) {
    issues.push({
      code: "COUNTS_STALE",
      message: `counts.total=${declaredTotal} but operations[] has ${operations.length} row(s)`,
    });
  }

  // 2. surfaceCounts must agree with surfaces[].
  const declaredSurfaces = isRecord(ledger["surfaceCounts"])
    ? ledger["surfaceCounts"]
    : {};
  const actualSurfaces = countTiers(surfaces);
  for (const tier of ["D", "E"] as const) {
    const want =
      typeof declaredSurfaces[tier] === "number" ? declaredSurfaces[tier] : 0;
    const have = actualSurfaces[tier] ?? 0;
    if (want !== have) {
      issues.push({
        code: "COUNTS_STALE",
        message: `surfaceCounts.${tier}=${want} but ${have} surfaces[] row(s) are tier ${tier}`,
      });
    }
  }
  const declaredSurfaceTotal =
    typeof declaredSurfaces["total"] === "number"
      ? declaredSurfaces["total"]
      : 0;
  if (declaredSurfaceTotal !== surfaces.length) {
    issues.push({
      code: "COUNTS_STALE",
      message: `surfaceCounts.total=${declaredSurfaceTotal} but surfaces[] has ${surfaces.length} row(s)`,
    });
  }

  // 2b. countsByTag is a third hand-kept copy: per-tag tier counts. It silently kept
  //     "Downline Accounting: C 5 / B 0" after Manager/getAgentPerformance moved from C to B,
  //     because the per-tag total still added up to the same 5.
  const declaredByTag = isRecord(ledger["countsByTag"])
    ? ledger["countsByTag"]
    : {};
  const actualByTag = countByTag(operations);
  const tags = new Set([
    ...Object.keys(declaredByTag),
    ...Object.keys(actualByTag),
  ]);
  for (const tag of [...tags].sort()) {
    const want = isRecord(declaredByTag[tag]) ? declaredByTag[tag] : {};
    const have = actualByTag[tag] ?? {};
    for (const tier of TIERS) {
      const declaredTier = typeof want[tier] === "number" ? want[tier] : 0;
      const actualTier = have[tier] ?? 0;
      if (declaredTier !== actualTier) {
        issues.push({
          code: "TAG_COUNTS_STALE",
          message: `countsByTag[${JSON.stringify(tag)}].${tier}=${declaredTier} but ${actualTier} operation(s) carry that tag and tier`,
        });
      }
    }
    const declaredTagTotal =
      typeof want["total"] === "number" ? want["total"] : 0;
    const actualTagTotal = totalOf(have);
    if (declaredTagTotal !== actualTagTotal) {
      issues.push({
        code: "TAG_COUNTS_STALE",
        message: `countsByTag[${JSON.stringify(tag)}].total=${declaredTagTotal} but ${actualTagTotal} operation(s) carry that tag`,
      });
    }
  }

  // 3. The schemaDoc prose restates the arithmetic, so it is a copy that can go stale. It said
  //    "total = 48" for 55 rows, which is why this check exists.
  const schemaDoc = isRecord(ledger["schemaDoc"]) ? ledger["schemaDoc"] : {};
  const prose =
    typeof schemaDoc["counts"] === "string" ? schemaDoc["counts"] : "";
  const claimedTotal = /=\s*total\s*=\s*(\d+)/.exec(prose)?.[1];
  if (claimedTotal !== undefined && Number(claimedTotal) !== totalOf(actual)) {
    issues.push({
      code: "PROSE_STALE",
      message: `schemaDoc.counts says "total = ${claimedTotal}" but operations[] holds ${totalOf(actual)}`,
    });
  }

  // 4. The surface flag must mean what the field description says, and be documented at all.
  const surfaceFields = isRecord(schemaDoc["surfaceFields"])
    ? schemaDoc["surfaceFields"]
    : {};
  if (!("missingFromSpec" in surfaceFields)) {
    issues.push({
      code: "SURFACE_FLAG_UNDOCUMENTED",
      message:
        'schemaDoc.surfaceFields has no "missingFromSpec" entry; an undocumented boolean is what let four rows disagree about its meaning',
    });
  }
  if (spec !== undefined) {
    const specPaths = specPathsOf(spec);
    for (const surface of surfaces) {
      if (!isRecord(surface)) continue;
      const declaredFlag = surface["missingFromSpec"];
      if (typeof declaredFlag !== "boolean") continue;
      const derived = deriveMissingFromSpec(surface, specPaths);
      if (declaredFlag !== derived) {
        issues.push({
          code: "SURFACE_FLAG_WRONG",
          message: `${String(surface["id"] ?? surface["name"] ?? "surface")}: missingFromSpec=${declaredFlag} but the spec says ${derived} (${describeMembers(surface, specPaths)})`,
        });
      }
    }
  }

  // 4b. Tier A means "a response was captured", so the row must cite a capture that resolves.
  //     The eight tier-A rows each cited a capture id that named nothing; capturedResponse=true
  //     alone was enough to make that row look proven.
  if (options.captureFiles !== undefined) {
    for (const row of operations) {
      if (!isRecord(row) || row["tier"] !== "A") continue;
      const evidence = Array.isArray(row["evidence"]) ? row["evidence"] : [];
      const citesCapture = evidence.some(
        (entry) =>
          isRecord(entry) &&
          typeof entry["source"] === "string" &&
          entry["source"].startsWith("capture:") &&
          options.captureFiles?.has(
            entry["source"].slice("capture:".length),
          ) === true,
      );
      if (!citesCapture) {
        issues.push({
          code: "TIER_A_WITHOUT_CAPTURE",
          message: `${String(row["method"] ?? "").toUpperCase()} ${String(row["path"] ?? "")}: tier A must cite a capture that resolves in docs/evidence/captures`,
        });
      }
    }
  }

  // 5. Evidence citations must name artifacts that exist. The ledger cited eight capture
  //    hashes that matched nothing in the store, and 34 file paths that had moved — the tier-A
  //    rows were the ones affected, which are the rows everything else rests on.
  issues.push(...auditCitations(operations, options));

  return issues;
}

function auditCitations(
  operations: readonly unknown[],
  options: AuditOptions,
): Issue[] {
  const issues: Issue[] = [];
  const captureFiles = options.captureFiles;
  const root = options.root;

  for (const row of operations) {
    if (!isRecord(row) || !Array.isArray(row["evidence"])) continue;
    const label = `${String(row["method"] ?? "").toUpperCase()} ${String(row["path"] ?? "")}`;
    for (const entry of row["evidence"]) {
      if (!isRecord(entry)) continue;
      const source = typeof entry["source"] === "string" ? entry["source"] : "";

      if (source.startsWith("capture:")) {
        if (captureFiles === undefined) continue;
        // Canonical form matches docs/openapi.json and the generated reference:
        //   capture:<YYYY-MM-DD>/<file>.json
        const target = source.slice("capture:".length);
        if (!captureFiles.has(target)) {
          issues.push({
            code: "CAPTURE_REF_DANGLING",
            message: `${label}: ${source} names no capture in docs/evidence/captures (expected capture:<date>/<file>)`,
          });
        }
        continue;
      }

      if (root === undefined) continue;
      const match = CITATION.exec(source);
      if (match === null) continue;
      const file = match[1] ?? "";
      const resolved = resolveCitation(file, root);
      if (resolved === undefined) {
        issues.push({
          code: "CITATION_DANGLING",
          message: `${label}: cites ${file}, which is not in the repo`,
        });
        continue;
      }
      const start = match[2];
      if (start !== undefined) {
        const last = Number(match[3] ?? start);
        const lines = countLines(resolved);
        if (last > lines) {
          issues.push({
            code: "CITATION_LINE_RANGE",
            message: `${label}: cites ${file}:${match[3] ?? start} but ${file} has ${lines} line(s)`,
          });
        }
      }
    }
  }
  return issues;
}

function countLines(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

function describeMembers(
  surface: Json,
  specPaths: ReadonlySet<string>,
): string {
  const members = Array.isArray(surface["members"]) ? surface["members"] : [];
  const paths = members
    .map(memberPath)
    .filter((p): p is string => p !== undefined);
  if (paths.length === 0) return "no path members";
  const missing = paths.filter((path) => !specPaths.has(path));
  if (missing.length === 0)
    return `all ${paths.length} path member(s) published`;
  return `${missing.length}/${paths.length} path member(s) absent: ${missing.slice(0, 3).join(", ")}`;
}
