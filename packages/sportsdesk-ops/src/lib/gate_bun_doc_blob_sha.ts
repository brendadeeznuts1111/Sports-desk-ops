/**
 * @file packages/sportsdesk-ops/src/lib/gate_bun_doc_blob_sha.ts
 * @description GATE-BUN-DOC-BLOB-SHA-01 — pinned `oven-sh/bun` blob URLs and banned floats.
 */

import { relative, resolve } from "node:path";
import ts from "typescript";
import {
  collectDtsClosureFiles,
  deriveAmbientDtsKindNumbers,
  resolveBunTypesRootDir,
  resolveInstalledBunTypesEntry,
  searchRootsFromModuleDir,
} from "./bun_surface_dts_inventory.ts";

export type CitationViolationCode =
  | "ERR_SPEC_UNPINNED_BUN_URL"
  | "E_DOC_BUN_VERSION_DRIFT"
  | "ERR_CAT_UNPINNED_BUN_URL";

export interface CitationViolation {
  readonly file: string;
  readonly line: number;
  readonly url: string;
  readonly code: CitationViolationCode;
  readonly detail: string;
}

export interface GateBunDocBlobPass {
  readonly ok: true;
  readonly domain: "[Bun Runtime]";
  readonly gate: "GATE-BUN-DOC-BLOB-SHA-01";
  readonly status: "PASS";
  readonly audited_bun_commit: string;
  readonly scanned_files: number;
  readonly validated_citations: number;
  readonly ast_symbol_locations_verified: number;
}

export interface GateBunDocBlobFail {
  readonly ok: false;
  readonly domain: "[Bun Runtime]";
  readonly gate: "GATE-BUN-DOC-BLOB-SHA-01";
  readonly status: "FAIL";
  readonly audited_bun_commit: string;
  readonly violation_count: number;
  readonly violations: readonly CitationViolation[];
}

export type GateBunDocBlobResult = GateBunDocBlobPass | GateBunDocBlobFail;

export const BANNED_BUN_URL_RE =
  /https?:\/\/(?:bun\.(?:sh|com)\/[^\s)>"'`]+|github\.com\/oven-sh\/bun\/(?:tree\/|blob\/main\/)[^\s)>"'`]+|raw\.githubusercontent\.com\/oven-sh\/bun\/main\/[^\s)>"'`]+|[^\s)>"'`]*#:~:text=[^\s)>"'`]*)/g;

export const PINNED_BLOB_URL_RE =
  /https:\/\/github\.com\/oven-sh\/bun\/blob\/([0-9a-f]{40})\/([^\s)#>"'`]+)(?:#L(\d+)(?:-L(\d+))?)?/g;

/** Paths skipped by the markdown sweep (generated runbooks still cite bun.com). */
export const DEFAULT_SCAN_SKIP_PREFIXES = [
  "node_modules/",
  ".git/",
  ".worktrees/",
  "docs/runbooks/",
  "Scratch/",
  "out/",
  "verification/",
  /** External Bun Docs MCP transport; not bun-types blob citations. */
  "docs/bun-mcp.md",
  "tests/code_mode/README.md",
] as const;

export function resolveRepoRoot(cwd: string = process.cwd()): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error("ERR_OPS_GIT_TOPLEVEL_UNRESOLVED");
  }
  return proc.stdout.toString().trim();
}

export async function resolveAuditedBunCommit(
  env: Record<string, string | undefined>,
): Promise<string> {
  if (env.CLOUDFLARE_R2_API_TOKEN && env.CLOUDFLARE_API_TOKEN) {
    throw new Error("ERR_CF_TOKEN_BLEED_10000");
  }
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
      ) as { audited_bun_commit?: string };
      if (
        manifest.audited_bun_commit &&
        /^[0-9a-f]{40}$/.test(manifest.audited_bun_commit)
      ) {
        return manifest.audited_bun_commit;
      }
    } catch {
      // Missing catalog falls back to Bun.revision.
    }
  }
  return Bun.revision;
}

export function buildValidLeafMaxLines(
  dtsFiles: readonly string[],
  typesRootDir: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const absPath of dtsFiles) {
    const rel = relative(typesRootDir, absPath).replaceAll("\\", "/");
    if (rel.startsWith("..") || rel.length === 0) continue;
    const leafPath = `packages/bun-types/${rel}`;
    const content = ts.sys.readFile(absPath) ?? "";
    map.set(leafPath, content.split("\n").length);
  }
  return map;
}

export function assertAstSymbolLocationsInBounds(
  symbolLocations: readonly {
    readonly leafPath: string;
    readonly line: number;
    readonly blobUrl: string;
  }[],
  validLeafMaxLines: ReadonlyMap<string, number>,
): void {
  for (const loc of symbolLocations) {
    const maxLines = validLeafMaxLines.get(loc.leafPath);
    if (maxLines === undefined || loc.line < 1 || loc.line > maxLines) {
      throw new Error(
        `ERR_CAT_UNPINNED_BUN_URL: AST leaf out of bounds (${loc.blobUrl})`,
      );
    }
  }
}

export function scanMarkdownTextForViolations(
  relFile: string,
  text: string,
  auditedBunCommit: string,
  validLeafMaxLines: ReadonlyMap<string, number>,
): { violations: CitationViolation[]; validatedCitations: number } {
  const violations: CitationViolation[] = [];
  let validatedCitations = 0;
  const lines = text.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex]!;
    const lineNum = lineIndex + 1;

    BANNED_BUN_URL_RE.lastIndex = 0;
    let bannedMatch: RegExpExecArray | null;
    while ((bannedMatch = BANNED_BUN_URL_RE.exec(lineText)) !== null) {
      violations.push({
        file: relFile,
        line: lineNum,
        url: bannedMatch[0],
        code: "ERR_SPEC_UNPINNED_BUN_URL",
        detail:
          "Banned unpinned Bun URL (/tree/, main, #:~:text=, or bun.sh/bun.com)",
      });
    }

    PINNED_BLOB_URL_RE.lastIndex = 0;
    let pinnedMatch: RegExpExecArray | null;
    while ((pinnedMatch = PINNED_BLOB_URL_RE.exec(lineText)) !== null) {
      const [fullUrl, sha, leafPath, startLineStr, endLineStr] = pinnedMatch;
      validatedCitations++;

      if (sha !== auditedBunCommit) {
        violations.push({
          file: relFile,
          line: lineNum,
          url: fullUrl,
          code: "E_DOC_BUN_VERSION_DRIFT",
          detail: `SHA ${sha} drifts from audited_bun_commit ${auditedBunCommit}`,
        });
        continue;
      }

      if (leafPath!.startsWith("packages/bun-types/")) {
        const maxLines = validLeafMaxLines.get(leafPath!);
        if (maxLines === undefined) {
          violations.push({
            file: relFile,
            line: lineNum,
            url: fullUrl,
            code: "ERR_CAT_UNPINNED_BUN_URL",
            detail: `Leaf file does not exist in @types/bun closure: ${leafPath}`,
          });
          continue;
        }

        if (startLineStr) {
          const startLine = Number(startLineStr);
          const endLine = endLineStr ? Number(endLineStr) : startLine;
          if (startLine < 1 || endLine < startLine || endLine > maxLines) {
            violations.push({
              file: relFile,
              line: lineNum,
              url: fullUrl,
              code: "ERR_CAT_UNPINNED_BUN_URL",
              detail: `Line anchor #L${startLine}${endLineStr ? `-L${endLine}` : ""} exceeds ${leafPath} (${maxLines} lines)`,
            });
          }
        }
      }
    }
  }

  return { violations, validatedCitations };
}

export interface RunGateBunDocBlobShaOptions {
  readonly repoRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly moduleDir?: string;
  readonly skipPrefixes?: readonly string[];
  readonly globPatterns?: readonly string[];
}

async function scanMarkdownFiles(
  repoRoot: string,
  patterns: readonly string[],
  skipPrefixes: readonly string[],
  auditedBunCommit: string,
  validLeafMaxLines: ReadonlyMap<string, number>,
): Promise<{
  violations: CitationViolation[];
  scannedFiles: number;
  validatedCitations: number;
}> {
  const violations: CitationViolation[] = [];
  const seenFiles = new Set<string>();
  let scannedFiles = 0;
  let validatedCitations = 0;

  for (const pattern of patterns) {
    const scanGlob = new Bun.Glob(pattern);
    for await (const relFile of scanGlob.scan({
      cwd: repoRoot,
      onlyFiles: true,
    })) {
      if (seenFiles.has(relFile)) continue;
      if (
        skipPrefixes.some(
          (prefix) =>
            relFile.startsWith(prefix) || relFile.includes("/node_modules/"),
        )
      ) {
        continue;
      }
      seenFiles.add(relFile);
      scannedFiles++;
      const absFile = resolve(repoRoot, relFile);
      const text = await Bun.file(absFile).text();
      const scanned = scanMarkdownTextForViolations(
        relFile,
        text,
        auditedBunCommit,
        validLeafMaxLines,
      );
      violations.push(...scanned.violations);
      validatedCitations += scanned.validatedCitations;
    }
  }

  return { violations, scannedFiles, validatedCitations };
}

export async function runGateBunDocBlobSha(
  options: RunGateBunDocBlobShaOptions,
): Promise<GateBunDocBlobResult> {
  const env = options.env ?? Bun.env;
  const moduleDir =
    options.moduleDir ??
    resolve(options.repoRoot, "packages/sportsdesk-ops/src/lib");
  const skipPrefixes = options.skipPrefixes ?? DEFAULT_SCAN_SKIP_PREFIXES;
  const globPatterns = options.globPatterns ?? [
    "AGENTS.md",
    "**/*.md",
    "**/*.mdx",
  ];

  const auditedBunCommit = await resolveAuditedBunCommit(env);
  const searchRoots = searchRootsFromModuleDir(moduleDir);
  const entryPath = resolveInstalledBunTypesEntry(searchRoots);
  const dtsFiles = collectDtsClosureFiles(entryPath, searchRoots);
  const typesRootDir = resolveBunTypesRootDir(dtsFiles);

  const { symbolLocations } = deriveAmbientDtsKindNumbers(
    dtsFiles,
    typesRootDir,
    auditedBunCommit,
  );

  const validLeafMaxLines = buildValidLeafMaxLines(dtsFiles, typesRootDir);
  assertAstSymbolLocationsInBounds(symbolLocations, validLeafMaxLines);

  const { violations, scannedFiles, validatedCitations } =
    await scanMarkdownFiles(
      options.repoRoot,
      globPatterns,
      skipPrefixes,
      auditedBunCommit,
      validLeafMaxLines,
    );

  if (violations.length > 0) {
    return {
      ok: false,
      domain: "[Bun Runtime]",
      gate: "GATE-BUN-DOC-BLOB-SHA-01",
      status: "FAIL",
      audited_bun_commit: auditedBunCommit,
      violation_count: violations.length,
      violations,
    };
  }

  return {
    ok: true,
    domain: "[Bun Runtime]",
    gate: "GATE-BUN-DOC-BLOB-SHA-01",
    status: "PASS",
    audited_bun_commit: auditedBunCommit,
    scanned_files: scannedFiles,
    validated_citations: validatedCitations,
    ast_symbol_locations_verified: symbolLocations.length,
  };
}
