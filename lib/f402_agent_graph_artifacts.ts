/**
 * Idempotent agent-graph artifact reconciliation (envelope fingerprint → derived files).
 */

import { rename } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256Hex } from "./f402_hierarchy_hash.ts";

export const AGENT_GRAPH_MANIFEST_VERSION = 1 as const;

export interface AgentGraphBuildManifest {
  readonly version: typeof AGENT_GRAPH_MANIFEST_VERSION;
  readonly envelopePath: string;
  readonly envelopeSha256: string;
  readonly envelopeGeneralRows: number;
  readonly ingestedRowCount: number;
  readonly skippedOverflowCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly builtAt: string;
  /** Set when graph:agent:image succeeds for this envelope generation. */
  readonly webpEnvelopeSha256?: string;
  readonly webpBuiltAt?: string;
  /** Set when graph:agent:views succeeds for this envelope generation. */
  readonly viewsEnvelopeSha256?: string;
  readonly readability?: AgentGraphReadabilitySummary;
}

export interface AgentGraphReadabilitySummary {
  readonly viewCount: number;
  readonly coverage: number;
  readonly reconciled: boolean;
  readonly overflowDrawn: number;
  readonly worstFontPx: number;
  readonly totalCrossings: number;
  readonly totalOverlaps: number;
  readonly parentDivergence: number;
  readonly budget: number;
  readonly rankdir: "TB" | "LR";
}

/** Readability gate defaults; set from the measured baseline (see agent-graph-readability.md). */
export const AGENT_GRAPH_READABILITY_THRESHOLDS = {
  minFontPx: 9,
  maxCrossings: 0,
  maxOverlaps: 0,
} as const;

export interface AgentGraphArtifactPaths {
  readonly graphJson: string;
  readonly graphSvg: string;
  readonly graphCaptureHtml: string;
  readonly graphWebp: string;
  readonly manifest: string;
}

export function agentGraphArtifactPathsFromJsonOut(
  graphJsonPath: string,
): AgentGraphArtifactPaths {
  const base = graphJsonPath.replace(/\.json$/i, "");
  return {
    graphJson: graphJsonPath,
    graphSvg: `${base}.svg`,
    graphCaptureHtml: `${base}-capture.html`,
    graphWebp: `${base}.webp`,
    manifest: `${base}.manifest.json`,
  };
}

export function resolveDefaultAgentGraphEnvelope(
  repoRoot: string,
  explicit?: string,
): string {
  const scratch = join(repoRoot, "scratch");
  return resolve(
    explicit?.trim() ||
      Bun.env.F402_RAW_ENVELOPE?.trim() ||
      join(scratch, "raw-f402-list-agents.json"),
  );
}

export async function sha256HexFile(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return sha256Hex(bytes);
}

export async function atomicWrite(
  path: string,
  data: string | Uint8Array | Blob,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Bun.nanoseconds()}`;
  await Bun.write(tmp, data);
  await rename(tmp, path);
}

export async function readAgentGraphManifest(
  manifestPath: string,
): Promise<AgentGraphBuildManifest | null> {
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) return null;
  try {
    const parsed = JSON.parse(await file.text()) as AgentGraphBuildManifest;
    if (parsed.version !== AGENT_GRAPH_MANIFEST_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function allExist(paths: readonly string[]): Promise<boolean> {
  for (const p of paths) {
    if (!(await Bun.file(p).exists())) return false;
  }
  return true;
}

/** True when envelope unchanged and graph JSON/SVG/capture HTML already reflect it. */
export async function isAgentGraphBuildFresh(options: {
  readonly manifestPath: string;
  readonly artifactPaths: AgentGraphArtifactPaths;
  readonly envelopeSha256: string;
}): Promise<boolean> {
  const manifest = await readAgentGraphManifest(options.manifestPath);
  if (manifest === null) return false;
  if (manifest.envelopeSha256 !== options.envelopeSha256) return false;
  return allExist([
    options.artifactPaths.graphJson,
    options.artifactPaths.graphSvg,
    options.artifactPaths.graphCaptureHtml,
  ]);
}

/** True when WebP was built for the current manifest envelope generation. */
export async function isAgentGraphWebpFreshForManifest(
  manifestPath: string,
  webpPath: string,
): Promise<boolean> {
  const manifest = await readAgentGraphManifest(manifestPath);
  if (manifest === null) return false;
  if (manifest.webpEnvelopeSha256 !== manifest.envelopeSha256) return false;
  if (!(await Bun.file(webpPath).exists())) return false;
  const webp = Bun.file(webpPath);
  const jsonPath = webpPath.replace(/\.webp$/i, ".json");
  const json = Bun.file(jsonPath);
  if (await json.exists()) {
    return webp.lastModified >= json.lastModified;
  }
  return true;
}

export async function writeAgentGraphBuildManifest(
  manifestPath: string,
  manifest: AgentGraphBuildManifest,
): Promise<void> {
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function markAgentGraphViewsBuilt(
  manifestPath: string,
  readability: AgentGraphReadabilitySummary,
): Promise<void> {
  const manifest = await readAgentGraphManifest(manifestPath);
  if (manifest === null) {
    throw new Error(`Missing manifest ${manifestPath} — run graph:agent first`);
  }
  await writeAgentGraphBuildManifest(manifestPath, {
    ...manifest,
    viewsEnvelopeSha256: manifest.envelopeSha256,
    readability,
  });
}

export async function isAgentGraphViewsFresh(
  manifestPath: string,
): Promise<boolean> {
  const manifest = await readAgentGraphManifest(manifestPath);
  return (
    manifest !== null &&
    manifest.viewsEnvelopeSha256 === manifest.envelopeSha256 &&
    manifest.readability !== undefined
  );
}

export async function markAgentGraphWebpBuilt(
  manifestPath: string,
): Promise<void> {
  const manifest = await readAgentGraphManifest(manifestPath);
  if (manifest === null) {
    throw new Error(`Missing manifest ${manifestPath} — run graph:agent first`);
  }
  const updated: AgentGraphBuildManifest = {
    ...manifest,
    webpEnvelopeSha256: manifest.envelopeSha256,
    webpBuiltAt: new Date().toISOString(),
  };
  await writeAgentGraphBuildManifest(manifestPath, updated);
}
