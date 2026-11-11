/**
 * @file lib/artifact_domain_provenance.ts
 * @description Canonical static JSON artifact provenance registry & boundary parser
 * aligned with `docs/Sources.txt` and `docs/architecture/signal-honesty.md`.
 *
 * Normalizes heterogeneous top-level wire JSON envelopes across `data/*` and `docs/*`
 * (`provenance`, `lastUpdatedIso`, `generatedAtIso`, `capturedAt`, `observedAt`,
 * `generatedAt`, `dataMode`, `dataSource`, `source`, `partial`) into a single
 * unit-explicit branded `ArtifactProvenanceEnvelope` without mutating wire JSON shapes.
 */

import { resolve } from "node:path";
import {
  isIsoDateTimeUtc,
  isoDateTimeUtc,
  parseAsEpochSec,
  sha256HexFromDigest,
  sqlDomain,
  type EpochSec,
  type IsoDateTimeUtc,
  type Sha256Hex,
  type SqlDomain,
} from "../design/domain-branded-types.ts";

export type ArtifactDataDomainId =
  | "market-feed"
  | "book-ticker"
  | "book-pending"
  | "book-agents"
  | "book-customer"
  | "cross-domain-bridge"
  | "combo-uniqueness"
  | "backtest-analytics";

export type ArtifactProvenanceBasis =
  "live" | "capture" | "fixture" | "missing" | "unreported";

export interface ArtifactDomainContract {
  readonly artifactPath: string;
  readonly domainId: ArtifactDataDomainId;
  readonly domain: SqlDomain;
  readonly slaSeconds: number | null;
  readonly timestampKeys: readonly string[];
  readonly basisKeys: readonly string[];
  readonly defaultBasisWhenPresent: "live" | "capture" | "fixture";
  readonly refreshCommand: string;
}

/**
 * Canonical artifact registry aligned 1-to-1 with `docs/Sources.txt`.
 */
export const SOURCES_ARTIFACT_CONTRACTS: readonly ArtifactDomainContract[] = [
  {
    artifactPath: "docs/graph-live-feed.json",
    domainId: "market-feed",
    domain: sqlDomain("syndicate market feed"),
    slaSeconds: 5400,
    timestampKeys: ["lastUpdatedIso", "generatedAtIso", "generatedAt"],
    basisKeys: ["dataMode", "provenance"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "graph_feed_poller_daemon --once --live",
  },
  {
    artifactPath: "data/live-wagers.json",
    domainId: "book-ticker",
    domain: sqlDomain("book live wagers capture"),
    slaSeconds: 3600,
    timestampKeys: ["observedAt", "capturedAt", "generatedAt"],
    basisKeys: ["source", "provenance"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "positions:cron, capture:bet-ticker, bridge3a",
  },
  {
    artifactPath: "data/bet-ticker.json",
    domainId: "book-ticker",
    domain: sqlDomain("book bet ticker capture"),
    slaSeconds: 3600,
    timestampKeys: ["observedAt", "capturedAt", "generatedAt"],
    basisKeys: ["source", "provenance"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "positions:cron, capture:bet-ticker, bridge3a",
  },
  {
    artifactPath: "data/live-bets.json",
    domainId: "book-pending",
    domain: sqlDomain("book pending exposure"),
    slaSeconds: 3600,
    timestampKeys: ["capturedAt", "observedAt", "generatedAt"],
    basisKeys: ["dataSource", "source", "provenance"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "positions:cron, live-bets refresh, bridge3b",
  },
  {
    artifactPath: "data/agent-tree.json",
    domainId: "book-agents",
    domain: sqlDomain("agent hierarchy snapshot"),
    slaSeconds: null,
    timestampKeys: ["capturedAt", "generatedAt", "observedAt"],
    basisKeys: ["source", "provenance"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "build:agent-tree",
  },
  {
    artifactPath: "data/customer-profiles.json",
    domainId: "book-customer",
    domain: sqlDomain("customer book profiles"),
    slaSeconds: null,
    timestampKeys: ["generatedAt", "capturedAt", "observedAt"],
    basisKeys: ["source", "provenance"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "customers:profiles",
  },
  {
    artifactPath: "docs/cross-domain-bridge.json",
    domainId: "cross-domain-bridge",
    domain: sqlDomain("customer polymarket cross-domain bridge"),
    slaSeconds: 86400,
    timestampKeys: ["generatedAtIso", "generatedAt"],
    basisKeys: ["evidence", "provenance"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "generate_value_artifacts",
  },
  {
    artifactPath: "docs/combo-uniqueness.json",
    domainId: "combo-uniqueness",
    domain: sqlDomain("cross-venue canonical combo uniqueness"),
    slaSeconds: 86400,
    timestampKeys: ["generatedAtIso", "generatedAt"],
    basisKeys: ["provenance", "source"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "generate_value_artifacts",
  },
  {
    artifactPath: "docs/backtest-4wk-cfb-nba.json",
    domainId: "backtest-analytics",
    domain: sqlDomain("4wk parlay hold backtest analytics"),
    slaSeconds: null,
    timestampKeys: ["generatedAtIso", "generatedAt", "windowEndIso"],
    basisKeys: ["provenance", "source"],
    defaultBasisWhenPresent: "capture",
    refreshCommand: "parlay backtest rollup",
  },
];

const CONTRACT_BY_PATH = new Map<string, ArtifactDomainContract>(
  SOURCES_ARTIFACT_CONTRACTS.map((c) => [c.artifactPath, c] as const),
);

export interface ArtifactProvenanceEnvelope {
  readonly artifactPath: string;
  readonly domainId: ArtifactDataDomainId | "unregistered";
  readonly domain: SqlDomain;
  readonly exists: boolean;
  readonly schemaVersion: number | null;
  readonly basis: ArtifactProvenanceBasis;
  readonly source: string;
  readonly asOfUtc: IsoDateTimeUtc | null;
  readonly sha256: Sha256Hex | null;
  readonly ageSeconds: EpochSec | null;
  readonly slaSeconds: number | null;
  readonly stale: boolean;
  readonly partial: boolean;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getArtifactDomainContract(
  artifactPath: string,
): ArtifactDomainContract | undefined {
  const normalized = artifactPath.replaceAll("\\", "/").replace(/^\.\//, "");
  return CONTRACT_BY_PATH.get(normalized);
}

/**
 * Classifies an arbitrary wire `basis` / `dataMode` / `dataSource` / `source` token
 * into the canonical Signal Honesty basis (`live | capture | fixture | unreported`).
 */
export function classifyArtifactBasis(
  rawToken: string | null | undefined,
  fallback: ArtifactProvenanceBasis = "unreported",
): ArtifactProvenanceBasis {
  if (typeof rawToken !== "string" || rawToken.trim() === "") {
    return fallback;
  }
  const lower = rawToken.trim().toLowerCase();
  if (
    lower === "live" ||
    lower === "db" ||
    lower.startsWith("live:") ||
    lower.includes("live-poll")
  ) {
    return "live";
  }
  if (
    lower === "fixture" ||
    lower === "sample" ||
    lower.startsWith("fixture:") ||
    lower.includes("fixture") ||
    lower.includes("demo") ||
    lower.includes("seed")
  ) {
    return "fixture";
  }
  if (
    lower === "capture" ||
    lower === "file" ||
    lower === "partial" ||
    lower === "snapshot" ||
    lower.startsWith("file:") ||
    lower.startsWith("capture:") ||
    lower.startsWith("report/") ||
    lower.startsWith("manager/") ||
    lower.includes("capture") ||
    lower.includes("sqlite") ||
    lower.includes("observed")
  ) {
    return "capture";
  }
  return fallback;
}

/**
 * Normalizes any decoded static JSON artifact object (and optional raw bytes) into a
 * validated `ArtifactProvenanceEnvelope`. Never fabricates timestamps or ages when absent.
 */
export function extractArtifactProvenanceEnvelope(
  artifactPath: string,
  raw: unknown,
  options: {
    readonly bytes?: Uint8Array | undefined;
    readonly nowMs?: number | undefined;
  } = {},
): ArtifactProvenanceEnvelope {
  const normalizedPath = artifactPath
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  const contract = CONTRACT_BY_PATH.get(normalizedPath);
  const domain = contract?.domain ?? sqlDomain("unregistered static artifact");
  const domainId = contract?.domainId ?? "unregistered";
  const slaSeconds = contract?.slaSeconds ?? null;

  const sha256 =
    options.bytes !== undefined
      ? sha256HexFromDigest(
          Bun.CryptoHasher.hash("sha256", options.bytes, "hex"),
        )
      : null;

  if (!isObjectRecord(raw)) {
    return {
      artifactPath: normalizedPath,
      domainId,
      domain,
      exists: raw !== undefined,
      schemaVersion: null,
      basis: raw === undefined ? "missing" : "unreported",
      source: "unreported",
      asOfUtc: null,
      sha256,
      ageSeconds: null,
      slaSeconds,
      stale: slaSeconds !== null,
      partial: false,
    };
  }

  const schemaVersion =
    typeof raw["schemaVersion"] === "number" &&
    Number.isFinite(raw["schemaVersion"])
      ? raw["schemaVersion"]
      : typeof raw["format_version"] === "number" &&
          Number.isFinite(raw["format_version"])
        ? raw["format_version"]
        : null;

  const provObj = isObjectRecord(raw["provenance"]) ? raw["provenance"] : null;

  // Resolve timestamp across nested `provenance` + contract `timestampKeys` + standard fallbacks
  const candidateTimestampKeys = [
    ...(contract?.timestampKeys ?? []),
    "asOf",
    "observedAt",
    "capturedAt",
    "generatedAtIso",
    "lastUpdatedIso",
    "generatedAt",
  ];

  let asOfUtc: IsoDateTimeUtc | null = null;
  if (
    provObj &&
    typeof provObj["asOf"] === "string" &&
    isIsoDateTimeUtc(provObj["asOf"])
  ) {
    asOfUtc = isoDateTimeUtc(provObj["asOf"]);
  } else if (
    provObj &&
    typeof provObj["observedAt"] === "string" &&
    isIsoDateTimeUtc(provObj["observedAt"])
  ) {
    asOfUtc = isoDateTimeUtc(provObj["observedAt"]);
  } else {
    for (const key of candidateTimestampKeys) {
      const val = raw[key];
      if (typeof val === "string" && isIsoDateTimeUtc(val)) {
        asOfUtc = isoDateTimeUtc(val);
        break;
      }
    }
  }

  // Resolve `source` string
  const provSources =
    provObj && Array.isArray(provObj["sources"]) ? provObj["sources"] : null;
  const firstProvSource =
    provSources && typeof provSources[0] === "string" ? provSources[0] : null;
  const source =
    (provObj && typeof provObj["source"] === "string"
      ? provObj["source"]
      : null) ??
    firstProvSource ??
    (typeof raw["source"] === "string" ? raw["source"] : null) ??
    (typeof raw["dataSource"] === "string" ? raw["dataSource"] : null) ??
    (typeof raw["operation"] === "string" ? raw["operation"] : null) ??
    normalizedPath;

  // Resolve `basis`
  let basis: ArtifactProvenanceBasis =
    contract?.defaultBasisWhenPresent ?? "unreported";
  if (provObj) {
    if (provObj["fixture"] === true) {
      basis = "fixture";
    } else if (typeof provObj["basis"] === "string") {
      basis = classifyArtifactBasis(provObj["basis"], basis);
    } else if (typeof provObj["dataMode"] === "string") {
      basis = classifyArtifactBasis(provObj["dataMode"], basis);
    }
  } else if (typeof raw["dataMode"] === "string") {
    basis = classifyArtifactBasis(raw["dataMode"], basis);
  } else if (typeof raw["dataSource"] === "string") {
    basis = classifyArtifactBasis(raw["dataSource"], basis);
  } else if (typeof raw["source"] === "string") {
    basis = classifyArtifactBasis(raw["source"], basis);
  }

  const partial =
    raw["partial"] === true ||
    raw["dataMode"] === "PARTIAL" ||
    (provObj !== null &&
      (provObj["partial"] === true || provObj["dataMode"] === "PARTIAL"));

  let ageSeconds: EpochSec | null = null;
  if (asOfUtc !== null) {
    const nowMs = options.nowMs ?? Date.now();
    const parsedMs = Date.parse(asOfUtc);
    if (Number.isFinite(parsedMs)) {
      const deltaSec = Math.max(0, Math.floor((nowMs - parsedMs) / 1000));
      ageSeconds = parseAsEpochSec(deltaSec);
    }
  }

  const stale =
    (provObj !== null && provObj["stale"] === true) ||
    (slaSeconds !== null && (ageSeconds === null || ageSeconds > slaSeconds));

  return {
    artifactPath: normalizedPath,
    domainId,
    domain,
    exists: true,
    schemaVersion,
    basis,
    source,
    asOfUtc,
    sha256,
    ageSeconds,
    slaSeconds,
    stale,
    partial,
  };
}

/**
 * Inspects a single artifact file on disk into an `ArtifactProvenanceEnvelope`,
 * returning `exists: false` and `basis: "missing"` (never fake zero data) when absent.
 */
export async function inspectArtifactFileProvenance(
  repoRoot: string,
  artifactPath: string,
  options: { readonly nowMs?: number | undefined } = {},
): Promise<ArtifactProvenanceEnvelope> {
  const normalizedPath = artifactPath
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  const contract = CONTRACT_BY_PATH.get(normalizedPath);
  const absPath = resolve(repoRoot, normalizedPath);
  const file = Bun.file(absPath);

  if (!(await file.exists())) {
    return {
      artifactPath: normalizedPath,
      domainId: contract?.domainId ?? "unregistered",
      domain: contract?.domain ?? sqlDomain("unregistered static artifact"),
      exists: false,
      schemaVersion: null,
      basis: "missing",
      source: "missing",
      asOfUtc: null,
      sha256: null,
      ageSeconds: null,
      slaSeconds: contract?.slaSeconds ?? null,
      stale: (contract?.slaSeconds ?? null) !== null,
      partial: false,
    };
  }

  const bytes = await file.bytes();
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return extractArtifactProvenanceEnvelope(normalizedPath, parsed, {
    bytes,
    nowMs: options.nowMs,
  });
}

/**
 * Extracts every `.json` artifact path declared in the `docs/Sources.txt` markdown table
 * (excluding `(R2 mirror)` annotations) to verify registry parity in tests.
 */
export function parseSourcesTxtArtifactPaths(sourcesTxt: string): string[] {
  const seen = new Set<string>();
  for (const rawLine of sourcesTxt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || line.startsWith("|---")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const pathCell = cells[2];
    if (
      !pathCell ||
      pathCell === "Artifact path(s)" ||
      pathCell.includes("(R2 mirror)") ||
      pathCell.startsWith("(")
    ) {
      continue;
    }
    for (const part of pathCell.split(",")) {
      const cleaned = part.trim();
      if (cleaned.endsWith(".json")) {
        seen.add(cleaned);
      }
    }
  }
  return [...seen];
}
