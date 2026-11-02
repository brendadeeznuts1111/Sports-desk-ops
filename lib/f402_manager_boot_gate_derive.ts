/**
 * Derive manager-boot gate readiness from repo artifacts (not hand-flipped manifest.status).
 */

import { join } from "node:path";

import { verifyHarRedactionProofFiles } from "./f402_har_redaction_proof_verify.ts";
import { parseProductionOracleFixtureText } from "./f402_production_fixture_redaction.ts";
import {
  oracleSnapshot,
  runPortalHierarchyOracle,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";
import { sha256HexText } from "./f402_portal_version_pin.ts";
import type { PinnedManifestWithExtracted } from "./f402_portal_oracle_slice.ts";

export type DerivedGatePhase = "blocked" | "ready" | "invalid";

export interface DerivedHarRedactionProofGate {
  readonly phase: DerivedGatePhase;
  readonly harPath: string;
  readonly proofPath: string;
  readonly detail?: Record<string, unknown>;
}

export interface DerivedProductionOracleGate {
  readonly phase: DerivedGatePhase;
  readonly generalFixture: string;
  readonly nestedSnapshotSha256: string | null;
  readonly liveSnapshotSha256?: string;
  readonly detail?: Record<string, unknown>;
}

export interface DerivedVarianceGate {
  readonly phase: DerivedGatePhase;
  readonly indexPath: string;
  readonly captureCount: number;
  readonly minimumCaptures: number;
  readonly detail?: Record<string, unknown>;
}

export interface DerivedManagerBootGates {
  readonly harRedactionProof: DerivedHarRedactionProofGate;
  readonly productionOracle: DerivedProductionOracleGate;
  readonly variance: DerivedVarianceGate;
}

export async function deriveHarRedactionProofGate(
  repoRoot: string,
  manifest: PinnedManifestWithExtracted,
): Promise<DerivedHarRedactionProofGate> {
  const gate = manifest.harRedactionProofGate;
  if (gate === undefined) {
    return {
      phase: "invalid",
      harPath: "",
      proofPath: "",
      detail: { reason: "manifest missing harRedactionProofGate" },
    };
  }
  const harPath = join(repoRoot, gate.harPath);
  const proofPath = join(repoRoot, gate.proofPath);
  if (
    !(await Bun.file(harPath).exists()) ||
    !(await Bun.file(proofPath).exists())
  ) {
    return {
      phase: "blocked",
      harPath: gate.harPath,
      proofPath: gate.proofPath,
    };
  }
  const verified = await verifyHarRedactionProofFiles({
    harPath,
    proofPath,
    requireListAgents: true,
  });
  if (verified.kind === "failed") {
    return {
      phase: "invalid",
      harPath: gate.harPath,
      proofPath: gate.proofPath,
      detail: verified.detail,
    };
  }
  return { phase: "ready", harPath: gate.harPath, proofPath: gate.proofPath };
}

export async function deriveProductionOracleGate(
  repoRoot: string,
  manifest: PinnedManifestWithExtracted,
): Promise<DerivedProductionOracleGate> {
  const gate = manifest.productionOracleGate;
  if (gate === undefined) {
    return {
      phase: "invalid",
      generalFixture: "",
      nestedSnapshotSha256: null,
      detail: { reason: "manifest missing productionOracleGate" },
    };
  }
  const fixturePath = join(repoRoot, gate.generalFixture);
  if (!(await Bun.file(fixturePath).exists())) {
    return {
      phase: "blocked",
      generalFixture: gate.generalFixture,
      nestedSnapshotSha256: gate.nestedSnapshotSha256,
    };
  }
  if (
    gate.nestedSnapshotSha256 === null ||
    gate.nestedSnapshotSha256.trim() === ""
  ) {
    return {
      phase: "blocked",
      generalFixture: gate.generalFixture,
      nestedSnapshotSha256: null,
      detail: { reason: "nestedSnapshotSha256 not pinned in manifest" },
    };
  }
  try {
    const fixtureText = await Bun.file(fixturePath).text();
    const fixture = parseProductionOracleFixtureText(fixtureText);
    const result = await runPortalHierarchyOracle(
      fixture.GENERAL as PortalGeneralRow[],
      { runSetComplete: true },
    );
    const liveHash = await sha256HexText(oracleSnapshot(result.nested));
    if (liveHash !== gate.nestedSnapshotSha256) {
      return {
        phase: "invalid",
        generalFixture: gate.generalFixture,
        nestedSnapshotSha256: gate.nestedSnapshotSha256,
        liveSnapshotSha256: liveHash,
        detail: { reason: "oracle nested snapshot hash mismatch" },
      };
    }
    return {
      phase: "ready",
      generalFixture: gate.generalFixture,
      nestedSnapshotSha256: gate.nestedSnapshotSha256,
      liveSnapshotSha256: liveHash,
    };
  } catch (e) {
    return {
      phase: "invalid",
      generalFixture: gate.generalFixture,
      nestedSnapshotSha256: gate.nestedSnapshotSha256,
      detail: { reason: String(e) },
    };
  }
}

export async function deriveVarianceGate(
  repoRoot: string,
  manifest: PinnedManifestWithExtracted,
): Promise<DerivedVarianceGate> {
  const gate = manifest.varianceGate;
  if (gate === undefined) {
    return {
      phase: "invalid",
      indexPath: "",
      captureCount: 0,
      minimumCaptures: 0,
      detail: { reason: "manifest missing varianceGate" },
    };
  }
  const indexPath = join(repoRoot, gate.indexPath);
  if (!(await Bun.file(indexPath).exists())) {
    return {
      phase: "blocked",
      indexPath: gate.indexPath,
      captureCount: 0,
      minimumCaptures: gate.minimumCaptures,
    };
  }
  const index = (await Bun.file(indexPath).json()) as {
    captures?: readonly unknown[];
  };
  const captureCount = index.captures?.length ?? 0;
  if (captureCount < gate.minimumCaptures) {
    return {
      phase: "blocked",
      indexPath: gate.indexPath,
      captureCount,
      minimumCaptures: gate.minimumCaptures,
    };
  }
  return {
    phase: "ready",
    indexPath: gate.indexPath,
    captureCount,
    minimumCaptures: gate.minimumCaptures,
  };
}

export async function deriveManagerBootGates(
  repoRoot: string,
  manifest: PinnedManifestWithExtracted,
): Promise<DerivedManagerBootGates> {
  const harRedactionProof = await deriveHarRedactionProofGate(
    repoRoot,
    manifest,
  );
  const productionOracle = await deriveProductionOracleGate(repoRoot, manifest);
  const variance = await deriveVarianceGate(repoRoot, manifest);
  return { harRedactionProof, productionOracle, variance };
}

export interface ManifestConsistencyMismatch {
  readonly gate:
    "harRedactionProofGate" | "productionOracleGate" | "varianceGate";
  readonly manifestStatus: string;
  readonly derivedPhase: DerivedGatePhase;
  readonly detail?: Record<string, unknown>;
}

function manifestStatusShouldBe(phase: DerivedGatePhase): "blocked" | "ready" {
  return phase === "ready" ? "ready" : "blocked";
}

export function diffManifestGateStatuses(
  manifest: PinnedManifestWithExtracted,
  derived: DerivedManagerBootGates,
): ManifestConsistencyMismatch[] {
  const out: ManifestConsistencyMismatch[] = [];

  const pushIfDrift = (
    gate: ManifestConsistencyMismatch["gate"],
    manifestStatus: string | undefined,
    phase: DerivedGatePhase,
    detail?: Record<string, unknown>,
  ): void => {
    if (manifestStatus === undefined) return;
    const shouldBe = manifestStatusShouldBe(phase);
    if (manifestStatus !== shouldBe) {
      out.push({
        gate,
        manifestStatus,
        derivedPhase: phase,
        ...(detail === undefined ? {} : { detail }),
      });
    }
  };

  pushIfDrift(
    "harRedactionProofGate",
    manifest.harRedactionProofGate?.status,
    derived.harRedactionProof.phase,
    derived.harRedactionProof.detail,
  );
  pushIfDrift(
    "productionOracleGate",
    manifest.productionOracleGate?.status,
    derived.productionOracle.phase,
    derived.productionOracle.detail,
  );
  pushIfDrift(
    "varianceGate",
    manifest.varianceGate?.status,
    derived.variance.phase,
    derived.variance.detail,
  );

  return out;
}
