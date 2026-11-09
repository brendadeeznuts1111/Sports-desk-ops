/**
 * @file lib/artifacts_lock.ts
 * @description Record and verify the inputs behind the committed value artifacts.
 *
 * Regenerating `docs/combo-uniqueness.json` and `docs/cross-domain-bridge.json` needs live data, so
 * CI cannot rebuild them. What CI can do is notice that the generator or its libraries changed after
 * the artifacts were last written — which is the case that actually produces a stale artifact.
 *
 * Limitation, stated plainly: this proves nothing changed *since the lock was taken*. It cannot prove
 * the locked artifacts were produced by the locked inputs, because that would require a regeneration
 * with live data. Run `artifacts:value` and then `artifacts:lock --update` together, always.
 */

export interface LockedFile {
  readonly sha256: string;
  readonly bytes: number;
}

export interface ArtifactsLock {
  readonly version: 1;
  readonly artifacts: Readonly<Record<string, LockedFile>>;
  readonly inputs: Readonly<Record<string, string>>;
}

export const ARTIFACT_PATHS = [
  "docs/combo-uniqueness.json",
  "docs/cross-domain-bridge.json",
] as const;

/** Source files (including transitive modules) whose changes can alter either artifact. */
export const INPUT_PATHS = [
  "lib/cfb_events.ts",
  "lib/combo_identity.ts",
  "lib/combo_legs.ts",
  "lib/venue_market_kinds.ts",
  "lib/combo_uniqueness.ts",
  "lib/combo_wallets.ts",
  "lib/json_fetch.ts",
  "lib/leg_taxonomy.ts",
  "lib/customer_poly_bridge.ts",
  "lib/layoff_risk_engine.ts",
  "lib/parlay_combo_backtest_engine.ts",
  "lib/polymarket_combo.ts",
  "lib/polymarket_profile.ts",
  "scripts/generate_value_artifacts.ts",
] as const;

export async function hashFile(path: string): Promise<LockedFile> {
  const buffer = await Bun.file(path).arrayBuffer();
  return {
    sha256: new Bun.CryptoHasher("sha256")
      .update(new Uint8Array(buffer))
      .digest("hex"),
    bytes: buffer.byteLength,
  };
}

export async function buildLock(): Promise<ArtifactsLock> {
  const artifacts: Record<string, LockedFile> = {};
  for (const path of [...ARTIFACT_PATHS].sort())
    artifacts[path] = await hashFile(path);
  const inputs: Record<string, string> = {};
  for (const path of [...INPUT_PATHS].sort())
    inputs[path] = (await hashFile(path)).sha256;
  return { version: 1, artifacts, inputs };
}

/**
 * Compare a recorded lock with the current tree.
 *
 * Three distinct failures, reported separately because the fix differs: an artifact changed by hand,
 * an input changed without regeneration, or the lock describing files that no longer exist.
 */
export function verifyLock(
  recorded: ArtifactsLock,
  current: ArtifactsLock,
): string[] {
  const errors: string[] = [];

  for (const [path, currentFile] of Object.entries(current.artifacts)) {
    const locked = recorded.artifacts[path];
    if (!locked) {
      errors.push(
        `${path} is not in the lock; run --update after regenerating`,
      );
      continue;
    }
    if (locked.sha256 !== currentFile.sha256) {
      errors.push(
        `${path} changed since it was locked; regenerate and run --update`,
      );
    }
  }
  for (const path of Object.keys(recorded.artifacts)) {
    if (!(path in current.artifacts))
      errors.push(`${path} is locked but missing from the tree`);
  }

  for (const [path, currentHash] of Object.entries(current.inputs)) {
    const lockedHash = recorded.inputs[path];
    if (lockedHash === undefined) {
      errors.push(`${path} is not in the lock; run --update`);
    } else if (lockedHash !== currentHash) {
      errors.push(
        `${path} changed since the artifacts were generated; rerun artifacts:value`,
      );
    }
  }

  return errors;
}

export function parseLock(raw: unknown): ArtifactsLock {
  if (typeof raw !== "object" || raw === null)
    throw new Error("lock is not an object");
  const candidate = raw as Record<string, unknown>;
  if (candidate["version"] !== 1)
    throw new Error(`unsupported lock version ${String(candidate["version"])}`);
  const artifacts = candidate["artifacts"];
  const inputs = candidate["inputs"];
  if (typeof artifacts !== "object" || artifacts === null)
    throw new Error("lock is missing artifacts");
  if (typeof inputs !== "object" || inputs === null)
    throw new Error("lock is missing inputs");

  const parsedArtifacts: Record<string, LockedFile> = {};
  for (const [path, value] of Object.entries(
    artifacts as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null)
      throw new Error(`lock entry ${path} is not an object`);
    const entry = value as Record<string, unknown>;
    const sha256 = entry["sha256"];
    const bytes = entry["bytes"];
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`lock entry ${path} has no sha256`);
    }
    if (typeof bytes !== "number" || !Number.isInteger(bytes)) {
      throw new Error(`lock entry ${path} has no bytes`);
    }
    parsedArtifacts[path] = { sha256, bytes };
  }

  const parsedInputs: Record<string, string> = {};
  for (const [path, value] of Object.entries(
    inputs as Record<string, unknown>,
  )) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`lock input ${path} has no sha256`);
    }
    parsedInputs[path] = value;
  }

  return { version: 1, artifacts: parsedArtifacts, inputs: parsedInputs };
}
