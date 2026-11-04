import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  GEN_TOKEN_EMISSION_PATHS,
  type GenTokenEmissionManifest,
} from "./emission_targets.ts";

export const GEN_TOKENS_GATE_ENV = "GEN_TOKENS_GATE";
export const GEN_TOKENS_GATE_RUN_ID_ENV = "GEN_TOKENS_GATE_RUN_ID";

export function sha256File(absolutePath: string): string {
  const buf = fs.readFileSync(absolutePath);
  return createHash("sha256").update(buf).digest("hex");
}

export function buildManifestFromDisk(
  rootDir: string,
  repoPaths: readonly string[],
  runId: string | undefined,
): GenTokenEmissionManifest {
  const emitted = repoPaths.map((repoPath) => {
    const absolutePath = path.join(rootDir, repoPath);
    return { repoPath, sha256: sha256File(absolutePath) };
  });
  return runId ? { gateRunId: runId, emitted } : { emitted };
}

export function assertStrictGateEmission(
  emittedPaths: readonly string[],
): void {
  if (Bun.env[GEN_TOKENS_GATE_ENV] !== "1") return;

  const expected = new Set(GEN_TOKEN_EMISSION_PATHS);
  const actual = new Set(emittedPaths);
  if (
    actual.size !== expected.size ||
    GEN_TOKEN_EMISSION_PATHS.some((p) => !actual.has(p))
  ) {
    console.error(
      `[gen:tokens] gate mode: expected ${GEN_TOKEN_EMISSION_PATHS.length} emissions, got ${actual.size}`,
    );
    process.exit(1);
  }
}

export function verifyManifestAgainstDisk(
  rootDir: string,
  manifest: GenTokenEmissionManifest,
  expectedRunId: string | undefined,
): string | null {
  if (expectedRunId !== undefined) {
    if (manifest.gateRunId !== expectedRunId) {
      return `manifest gateRunId mismatch (expected this gate run)`;
    }
  }
  const byPath = new Map(manifest.emitted.map((e) => [e.repoPath, e.sha256]));
  for (const repoPath of GEN_TOKEN_EMISSION_PATHS) {
    if (!byPath.has(repoPath)) {
      return `manifest missing ${repoPath}`;
    }
    const absolutePath = path.join(rootDir, repoPath);
    if (!fs.existsSync(absolutePath)) {
      return `missing file ${repoPath}`;
    }
    const sha = sha256File(absolutePath);
    if (byPath.get(repoPath) !== sha) {
      return `sha256 mismatch for ${repoPath} (manifest stale or file edited after gen)`;
    }
  }
  return null;
}
